const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fetch = require('node-fetch');
const { scrapePage, scrapePDF, scrapeWord, scrapeWordViaGhost, scrapeWordViaTrawl, scrapeViaGoogleCache, scrapeViaJina, scrapeViaTrawl, scrapeViaDirectFetch, scrapeViaArchive, terminateAllOCR, inspectRemoteDocument } = require('./scraper');
const { getUserContext, markResultsChanged, addMissionLog, saveMissionManifest } = require('./missions');
const { saveData, saveSailorResult, verifySavedPdfArtifact } = require('./storage');
const { generatePdfFromHtml } = require('./pdf');
const { sortLinksByScore, scoredLinksFromHtml, normalizeUrl } = require('./navigator'); // 🧭 Tier 1 Smart Navigator
const { normalizeVisitUrl, isClientSideRouteUrl } = require('./navigator');
const runtimeProfile = require('./runtime-profile');
const { resolveOfficialSource } = require('./official-source-resolver');
const { isUnusableContentError, getUnusableContentIssue } = require('./content-validation');
const { classifyNonDocumentResponse, classifyNonDocumentUrl } = require('./content-quality');
const { getExtractedTextAuditFingerprint, getContentAuditFingerprint, ContentReviewRegistry } = require('./content-dedup');
const { createHostScheduler } = require('./host-scheduler');
const {
    assessExtractedContent,
    getFallbackRoute,
    isSpaRetryCategory,
    isTemplateRecoveryCategory,
    looksLikeOfficeBinaryText
} = require('./extraction-policy');

const FALLBACK_PROVIDERS = Object.freeze({
    'Google Cache': scrapeViaGoogleCache,
    'Jina Reader': scrapeViaJina,
    'Trawl': scrapeViaTrawl,
    'Archive.org': scrapeViaArchive
});

const RESTORE_TEXT_PDF_ENABLED = String(process.env.SCRAPERITO_RESTORE_TEXT_PDF || 'true').toLowerCase() !== 'false';
const RESTORE_TEXT_PDF_MAX_CHARS = Math.max(
    0,
    parseInt(process.env.SCRAPERITO_RESTORED_PDF_MAX_CHARS || '0', 10) || 0
);
const SOCIAL_BLOCKLIST = ['facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 't.co', 'x.com', 'youtube.com', 'pinterest.com', 'tiktok.com'];
const PAGE_OPERATION_TIMEOUT_MS = Math.max(
    15000,
    parseInt(process.env.SCRAPERITO_PAGE_OPERATION_TIMEOUT_MS || '75000', 10) || 75000
);
const LINK_DISCOVERY_TIMEOUT_MS = Math.max(
    5000,
    Math.min(
        PAGE_OPERATION_TIMEOUT_MS,
        parseInt(process.env.SCRAPERITO_LINK_DISCOVERY_TIMEOUT_MS || '15000', 10) || 15000
    )
);

// Filter URLs before reserving a canonical visit key. Otherwise an external URL
// can be recorded as a misleading duplicate when the same navigation link appears twice.
function getPreVisitSkipReason(targetUrl, baseUrl, depth, maxDepth, stayOnDomain) {
    if (depth > maxDepth) {
        return `Depth limit reached (maximum level ${maxDepth}).`;
    }
    const nonDocumentIssue = classifyNonDocumentUrl(targetUrl);
    if (nonDocumentIssue) {
        return nonDocumentIssue.reason;
    }
    if (SOCIAL_BLOCKLIST.some(domain => targetUrl.includes(domain))) {
        return 'Social-media URL skipped before navigation';
    }

    try {
        const normalizeHost = hostname => hostname.replace(/^www\./, '').toLowerCase();
        const currentHost = normalizeHost(new URL(targetUrl).hostname);
        const seedHost = normalizeHost(new URL(baseUrl).hostname);
        if (stayOnDomain && depth > 0 && currentHost !== seedHost) {
            return `Off-domain URL skipped (${currentHost}; seed host: ${seedHost}).`;
        }
    } catch (_) {
        return 'Invalid URL skipped before navigation';
    }

    return null;
}

// Keep duplicate discovery from filling the worker queue. The caller supplies the
// canonical key so viewer URLs can be unwrapped before they are compared.
function enqueueUniqueCrawlItems(queue, scheduledVisitKeys, items, resolveVisitKey, addToFront = false) {
    const accepted = [];
    let duplicates = 0;

    for (const item of items) {
        const visitKey = resolveVisitKey(item.baseUrl, item.url);
        if (scheduledVisitKeys.has(visitKey)) {
            duplicates++;
            continue;
        }
        scheduledVisitKeys.add(visitKey);
        accepted.push({ ...item, queuedAt: item.queuedAt || Date.now() });
    }

    if (accepted.length > 0) {
        if (addToFront) queue.unshift(...accepted);
        else queue.push(...accepted);
    }

    return { added: accepted.length, duplicates };
}

// Preserve every submitted row in the mission manifest. Exact repeated input is
// represented explicitly, while only its first occurrence enters the work queue.
function prepareStartUrls(startUrls = []) {
    const submittedEntries = (Array.isArray(startUrls) ? startUrls : [])
        .map((entry, index) => {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
                return {
                    inputIndex: Number.isInteger(entry.inputIndex) ? entry.inputIndex : index + 1,
                    raw: String(entry.raw ?? entry.url ?? '').trim(),
                    url: String(entry.url || '').trim(),
                    reason: entry.reason || null
                };
            }
            const url = String(entry || '').trim();
            return { inputIndex: index + 1, raw: url, url, reason: null };
        })
        .filter(entry => entry.raw || entry.url);

    // Submitted rows share the same visit identity as queued URLs. In particular,
    // `#/route` and `#!/route` identify distinct SPA screens and must not be
    // collapsed while retaining safe www/non-www equivalence.
    const normalizeUrlForDedup = (urlStr) => {
        try {
            const parsed = new URL(normalizeVisitUrl(urlStr));
            const routeFragment = /^#!?\//.test(parsed.hash) ? parsed.hash : '';
            parsed.hash = '';
            parsed.hostname = parsed.hostname.replace(/^www\./i, '');
            return `${parsed.toString().toLowerCase()}${routeFragment}`;
        } catch (e) {
            return normalizeVisitUrl(urlStr);
        }
    };

    const firstOccurrenceByUrl = new Map();
    const scheduledUrls = [];
    const details = submittedEntries.map((entry, index) => {
        const url = entry.url;
        const inputIndex = entry.inputIndex || index + 1;
        if (!url) {
            const reason = entry.reason || 'Invalid URL syntax; it was not navigated.';
            return {
                url: entry.raw,
                level: 0,
                depth: 0,
                seedUrl: entry.raw,
                inputIndex,
                status: 'skipped',
                reason,
                pdfSaved: false,
                pdfKind: 'none',
                pdfReason: `No PDF saved because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
            };
        }

        // v17.03: Use normalized URL for deduplication to handle www./non-www. equivalence
        const normalizedUrl = normalizeUrlForDedup(url);
        const firstIndex = firstOccurrenceByUrl.get(normalizedUrl);
        if (firstIndex !== undefined) {
            const reason = `Duplicate input URL; identical entry #${firstIndex + 1} was scheduled once.`;
            return {
                url,
                level: 0,
                depth: 0,
                seedUrl: url,
                inputIndex,
                inputDuplicateOf: firstIndex + 1,
                status: 'skipped',
                reason,
                pdfSaved: false,
                pdfKind: 'none',
                pdfReason: `No PDF saved because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`
            };
        }

        firstOccurrenceByUrl.set(normalizedUrl, inputIndex - 1);
        scheduledUrls.push(url);
        return {
            url,
            level: 0,
            depth: 0,
            seedUrl: url,
            inputIndex,
            status: 'pending',
            reason: null
        };
    });

    return {
        submittedUrls: submittedEntries,
        scheduledUrls,
        details,
        duplicateCount: submittedEntries.filter(entry => entry.url).length - scheduledUrls.length,
        invalidCount: submittedEntries.filter(entry => !entry.url).length
    };
}

// page.evaluate() and page.content() have no reliable timeout on every hostile JS page.
// Close only the affected worker page so the existing per-URL fallback chain can continue.
async function withWorkerPageTimeout(page, task, timeoutMs, label = 'page operation') {
    let timer;
    const taskPromise = Promise.resolve().then(task);
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const error = new Error('GLOBAL_PAGE_TIMEOUT');
            error.timeoutMs = timeoutMs;
            error.operation = label;
            Promise.resolve(page?.close?.()).catch(() => {});
            reject(error);
        }, timeoutMs);
    });

    try {
        return await Promise.race([taskPromise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
    }
}

async function retryClientSideRouteExtraction(browser, url, options = {}) {
    const retryPage = await browser.newPage();
    const addMissionLog = options.addMissionLog || null;
    try {
        await retryPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,eot,mp4,webm,ogg,mp3,wav}', route => route.abort());
        const response = await retryPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        if (!response?.ok()) throw new Error(`SPA route retry returned HTTP ${response?.status?.() || 'no response'}`);
        return await withWorkerPageTimeout(
            retryPage,
            () => scrapePage(retryPage, { stayOnDomain: options.stayOnDomain, targetUrl: url, addMissionLog }),
            Math.min(PAGE_OPERATION_TIMEOUT_MS, 45000),
            'client-side route retry'
        );
    } finally {
        await retryPage.close().catch(() => {});
    }
}

function getNavigationResponseInfo(response = null) {
    const status = typeof response?.status === 'function'
        ? response.status()
        : Number(response?.status);
    const headers = typeof response?.headers === 'function' ? response.headers() : {};
    const statusText = typeof response?.statusText === 'function'
        ? response.statusText()
        : String(response?.statusText || '');
    return {
        status: Number.isFinite(status) ? status : null,
        statusText,
        contentType: String(headers?.['content-type'] || '').toLowerCase(),
        crashed: Boolean(response?.crashed),
        error: response?.error ? String(response.message || 'navigation error') : null
    };
}

// A missing or non-success navigation response is not automatically a dead URL.
// Only explicit 404/410 responses are terminal. Other failures can be a WAF,
// transient CDN response, or a non-standard access denial and must use the
// existing fallback chain before being declared unavailable.
function classifyNavigationResponse(response = null) {
    const info = getNavigationResponseInfo(response);
    if (info.crashed || info.error) {
        return { ...info, action: 'recover', strongAccessFailure: true, reason: info.error || 'page crashed' };
    }
    if (info.status === null) {
        return { ...info, action: 'recover', strongAccessFailure: true, reason: 'no navigation response' };
    }
    if (info.status >= 200 && info.status < 300) {
        return { ...info, action: 'extract', strongAccessFailure: false, reason: null };
    }
    if ([404, 410].includes(info.status)) {
        return { ...info, action: 'terminal', strongAccessFailure: false, reason: `HTTP ${info.status}` };
    }

    const strongAccessFailure = [401, 403, 405, 406, 407, 409, 418, 429].includes(info.status) || info.status >= 500;
    return {
        ...info,
        action: 'recover',
        strongAccessFailure,
        reason: `HTTP ${info.status}${info.statusText ? ` ${info.statusText}` : ''}`
    };
}

function getTemplateRecoveryCacheKey(result = {}, issue = {}, url = '') {
    if (!isTemplateRecoveryCategory(issue?.category)) return null;
    let hostname;
    try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) { return null; }
    const fingerprint = getExtractedTextAuditFingerprint({
        plainText: result.plainText || result.allText || ''
    });
    if (!fingerprint) return null;
    return `${hostname}|${issue.category}|${fingerprint.hash}`;
}

chromium.use(stealth);

async function runScraperSession(userId, startUrls, maxDepth, globalMaxPages, stayOnDomain, missionId, delayMs = 0, concurrency = runtimeProfile.swarmDefaultConcurrency, bodyOnly = false, excludeNoise = true, smartNav = true, sailorMode = false, executionHooks = {}) {
    const requestedConcurrency = parseInt(concurrency, 10) || runtimeProfile.swarmDefaultConcurrency;
    concurrency = Math.max(1, Math.min(requestedConcurrency, runtimeProfile.swarmMaxConcurrency));
    if (requestedConcurrency !== concurrency) {
        const profileName = runtimeProfile.isLocalRuntime ? 'Local Stability Max' : 'Railway Stability Max';
        addMissionLog(userId, `⚠️ Concurrency reduced from ${requestedConcurrency} to ${concurrency} (${profileName})`, 'warn');
    }

    // 🛡️ Deduplicate starting URLs to prevent manifest "Pending" ghosts
    const inputPreparation = prepareStartUrls(startUrls);
    startUrls = inputPreparation.scheduledUrls;

    console.log(`\n💎 [SESSION] Starting Mission: ${missionId} (User: ${userId})`);


    const ctx = getUserContext(userId);
    const missionProgress = {
        total: inputPreparation.submittedUrls.length,
        successful: 0,
        deduplicated: 0,
        details: inputPreparation.details,
        timestamp: new Date().toISOString(),
        missionId: missionId
    };
    ctx.linkProgress = missionProgress;
    const emitProgress = (kind = 'snapshot', detail = null) => {
        if (typeof executionHooks.onProgress !== 'function') return;
        try {
            executionHooks.onProgress({
                kind,
                missionId,
                total: missionProgress.total,
                successful: missionProgress.successful,
                deduplicated: missionProgress.deduplicated,
                detail,
                progress: kind === 'snapshot' || kind === 'complete' ? missionProgress : null
            });
        } catch (err) {
            // Live UI reporting is optional and must not weaken a mission.
            console.error(`[SESSION] Progress reporter failed: ${err.message}`);
        }
    };
    emitProgress('snapshot');
    if (inputPreparation.duplicateCount > 0) {
        addMissionLog(
            userId,
            `Input contained ${inputPreparation.duplicateCount} exact repeated URL(s). They remain in the mission and Excel as skipped; only first occurrences enter the scrape queue.`,
            'info'
        );
    }
    if (inputPreparation.invalidCount > 0) {
        addMissionLog(
            userId,
            `Input contained ${inputPreparation.invalidCount} invalid URL candidate(s). They remain in the mission and Excel as skipped; no navigation was attempted.`,
            'warn'
        );
    }

    const sleep = ms => new Promise(res => setTimeout(res, ms));
    const reconcileSuccessfulPdfArtifacts = async () => {
        if (sailorMode) return { verified: 0, demoted: 0 };

        let verified = 0;
        let demoted = 0;
        for (const item of missionProgress.details) {
            if (item.status !== 'success') continue;

            const artifactCheck = await verifySavedPdfArtifact(
                userId,
                item.url,
                item.filesSaved || item.artifacts?.files || {},
                {
                    batchId: missionId,
                    storageDomain: item.artifacts?.storageDomain
                }
            );
            if (artifactCheck.ok) {
                verified++;
                continue;
            }

            const reason = `PDF artifact verification failed: ${artifactCheck.reason}`;
            item.status = 'failed';
            item.reason = reason;
            item.pdfSaved = false;
            item.pdfKind = 'none';
            item.pdfReason = reason;
            item.updatedAt = new Date().toISOString();
            demoted++;
        }

        // The visible mission total must describe the same verified artifacts
        // that Excel and the PDF ZIP export from.
        missionProgress.successful = missionProgress.details.filter(item => item.status === 'success').length;
        return { verified, demoted };
    };
    let browser;
    try {
        addMissionLog(userId, 'Preparing the browser environment...', 'info');
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disk-cache-size=50000000',
                `--js-flags=--max-old-space-size=${runtimeProfile.browserRendererHeapMb}`
            ]
        });
        ctx.browser = browser;

        const visitedTotal = new Set();
        // Content matches are review-only. Each processed URL retains its own
        // artifact because extraction equality cannot prove source equality.
        const contentReviewRegistry = sailorMode ? null : new ContentReviewRegistry();
        // Mission-scoped only: each URL is extracted and validated independently.
        // A successful method may be tried first later, but no fallback is skipped.
        const templateRecoveryCache = new Map();

        const getBaseDomain = (hostname) => {
            const parts = hostname.split('.');
            if (parts.length < 2) return hostname;
            const euTLDs = ['be', 'bg', 'cz', 'dk', 'de', 'ee', 'ie', 'el', 'es', 'fr', 'hr', 'it', 'cy', 'lv', 'lt', 'lu', 'hu', 'mt', 'nl', 'at', 'pl', 'pt', 'ro', 'si', 'sk', 'fi', 'se', 'eu', 'int'];
            const govKeywords = ['gov', 'gob', 'gv', 'guv', 'fed', 'jurivie', 'admin', 'europa', 'europarl', 'ec', 'curia', 'bundes', 'eesti', 'valitsus'];
            const lastPart = parts[parts.length - 1].toLowerCase();
            const secondLast = parts[parts.length - 2].toLowerCase();
            if (euTLDs.includes(lastPart)) {
                if (govKeywords.some(k => secondLast.includes(k) || hostname.includes(k))) return lastPart === 'eu' ? 'eu' : parts.slice(-2).join('.');
                return parts.slice(-2).join('.');
            }
            return parts.slice(-2).join('.');
        };

        const bypassStatsByDomain = new Map();
        const bypassPreferenceThreshold = Math.max(
            2,
            parseInt(process.env.SCRAPERITO_BYPASS_PREFERENCE_THRESHOLD || '2', 10) || 2
        );

        const getBypassDomainKey = (targetUrl) => {
            try {
                return getBaseDomain(new URL(targetUrl).hostname.toLowerCase());
            } catch (_) {
                return 'unknown';
            }
        };

        const getBypassStats = (targetUrl) => {
            const domainKey = getBypassDomainKey(targetUrl);
            if (!bypassStatsByDomain.has(domainKey)) {
                bypassStatsByDomain.set(domainKey, {
                    successes: {},
                    failures: {},
                    preferred: null,
                    loggedPreference: null
                });
            }
            return { domainKey, stats: bypassStatsByDomain.get(domainKey) };
        };

        const recordBypassFailure = (targetUrl, bypassName) => {
            const { stats } = getBypassStats(targetUrl);
            stats.failures[bypassName] = (stats.failures[bypassName] || 0) + 1;
        };

        const recordBypassSuccess = (targetUrl, bypassName, addLog) => {
            const { domainKey, stats } = getBypassStats(targetUrl);
            stats.successes[bypassName] = (stats.successes[bypassName] || 0) + 1;

            const repeatedProxyFailures =
                (stats.failures['Google Cache'] || 0) >= bypassPreferenceThreshold ||
                (stats.failures['Jina Reader'] || 0) >= bypassPreferenceThreshold;

            if (
                bypassName === 'Trawl' &&
                stats.successes[bypassName] >= bypassPreferenceThreshold &&
                repeatedProxyFailures
            ) {
                stats.preferred = 'Trawl';
                if (stats.loggedPreference !== 'Trawl') {
                    stats.loggedPreference = 'Trawl';
                    addLog(`⚡ Domain bypass memory: ${domainKey} now tries Trawl first after repeated proxy failures.`, 'info');
                }
            }
        };

        const buildBypassChain = (targetUrl, baseChain) => {
            const { stats } = getBypassStats(targetUrl);
            if (!stats.preferred) return baseChain;

            const preferred = baseChain.find(bp => bp.name === stats.preferred);
            if (!preferred) return baseChain;

            return [
                preferred,
                ...baseChain.filter(bp => bp.name !== stats.preferred)
            ];
        };

        const unwrapViewerURL = (url) => {
            try {
                let currentUrl = url;
                let iterations = 0;
                while (iterations < 5) {
                    const u = new URL(currentUrl);
                    if (u.hostname.includes('officeapps.live.com') || u.hostname.includes('docs.google.com')) {
                        let src = u.searchParams.get('src') || u.searchParams.get('url');
                        if (src) {
                            let prev = '';
                            let decoded = src;
                            let decodeIter = 0;
                            try {
                                while (decoded !== prev && decodeIter < 5) {
                                    prev = decoded;
                                    decoded = decodeURIComponent(decoded);
                                    decodeIter++;
                                }
                            } catch (e) { decoded = prev; }
                            currentUrl = encodeURI(decoded);
                            iterations++;
                            continue;
                        }
                    }
                    if (u.hostname.includes('viewer.google.com')) {
                        let urlParam = u.searchParams.get('url');
                        if (urlParam) {
                            currentUrl = encodeURI(decodeURIComponent(urlParam));
                            iterations++;
                            continue;
                        }
                    }
                    break;
                }
                return currentUrl;
            } catch (e) { }
            return url;
        };

        const analyzeError = (err, response = null) => {
            if (response && !response.ok()) {
                const status = response.status();
                if (status === 403) return 'Access Denied (Bot Protection/WAF)';
                if (status === 404) return 'Page Not Found (Broken link)';
                if (status === 500) return 'Internal Server Error (Site is down)';
                if (status === 503) return 'Service Unavailable (Overloaded)';
                return `HTTP Error ${status}: ${response.statusText()}`;
            }
            const msg = err.message.toLowerCase();
            if (msg.includes('404') || msg.includes('not found')) return 'Page Not Found (Broken link)';
            if (msg.includes('403') || msg.includes('denied')) return 'Access Denied (Bot Protection/WAF)';
            if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return 'Server Side Error (Site Down)';
            if (msg.includes('timeout')) return 'Timed out (Site too slow or protected)';
            if (msg.includes('net::err_name_not_resolved')) return 'Domain not found (Check URL)';
            if (msg.includes('net::err_connection_refused')) return 'Connection refused (Site offline)';
            if (msg.includes('net::err_connection_reset')) return 'Connection reset (Security firewall)';
            if (msg.includes('net::err_cert')) return 'SSL/Certificate error';
            return err.message;
        };

        const isControlledDownloadFailure = (err) => {
            const msg = String(err?.message || err || '').toLowerCase();
            return (
                msg.includes('download.saveas') ||
                msg.includes('saveas: canceled') ||
                msg.includes('download is starting') ||
                msg.includes('download event failed') ||
                msg.includes('ghost download failed') ||
                msg.includes('no pdf buffer captured') ||
                msg.includes('no buffer captured after navigation/download')
            );
        };

        const linkDepthByUrl = new Map(startUrls.map(u => [
            normalizeVisitUrl(u),
            { level: 0, depth: 0, seedUrl: u }
        ]));

        const updateLinkStatus = (url, status, reason = null, details = {}) => {
            const normalizedGoal = normalizeVisitUrl(url);
            // Keep one status per submitted URL. Normalized matching is only a fallback
            // for URLs discovered while crawling, so fragment-only siblings stay distinct.
            const exactGoal = String(url || '').trim();
            let item = missionProgress.details.find(d => String(d.url || '').trim() === exactGoal);
            if (!item) {
                item = missionProgress.details.find(d => normalizeVisitUrl(d.url) === normalizedGoal);
            }
            if (!item) {
                item = { url, status, reason };
                missionProgress.details.push(item);
                missionProgress.total++;
            } else {
                item.status = status;
                item.reason = reason;
            }
            if (item && details && typeof details === 'object') {
                Object.assign(item, linkDepthByUrl.get(normalizedGoal) || {}, details, { updatedAt: new Date().toISOString() });
            }
            if (item && status !== 'success' && item.pdfSaved === undefined) {
                item.pdfSaved = false;
                item.pdfKind = 'none';
                item.pdfReason = reason || 'URL did not complete successfully, so no PDF was saved.';
            }
            emitProgress('detail', item);
        };

        const queue = [];
        const scheduledVisitKeys = new Set();
        const resolveVisitKey = (baseUrl, targetUrl) => (
            `${normalizeVisitUrl(baseUrl)}|${normalizeVisitUrl(unwrapViewerURL(targetUrl))}`
        );
        const enqueueCrawlItems = (items, addToFront = false) => (
            enqueueUniqueCrawlItems(queue, scheduledVisitKeys, items, resolveVisitKey, addToFront)
        );

        const queueDiscoveredLinks = (result, depth, baseUrl, originalQueueUrl, addLog) => {
            if (depth >= maxDepth || !Array.isArray(result?.discoveredLinks) || result.discoveredLinks.length === 0) return;

            const nextDepth = depth + 1;
            if (smartNav) {
                const ranked = sortLinksByScore(result.discoveredLinks, nextDepth);
                addLog(`Smart Nav: ranked ${ranked.length} links (top: "${(ranked[0].text || ranked[0].href).substring(0, 40)}" score=${ranked[0]._score?.toFixed(1)})`, 'info');
                const queueResult = enqueueCrawlItems(
                    ranked.map(link => ({ url: link.href, depth: nextDepth, baseUrl, originalQueueUrl })),
                    true
                );
                if (queueResult.duplicates > 0) {
                    addLog(`Queue coalesced ${queueResult.duplicates} repeated discovered URL(s).`, 'info');
                }
                return;
            }

            const queueResult = enqueueCrawlItems(
                result.discoveredLinks.map(link => ({ url: link.href, depth: nextDepth, baseUrl, originalQueueUrl }))
            );
            if (queueResult.duplicates > 0) {
                addLog(`Queue coalesced ${queueResult.duplicates} repeated discovered URL(s).`, 'info');
            }
        };
        enqueueCrawlItems(startUrls.map(u => ({ url: u, depth: 0, baseUrl: u, originalQueueUrl: u })));
        let pagesScrapedTotal = 0;
        let controlledDownloadFailures = 0;
        let busyWorkers = 0;
        const basePoliteDelay = Math.max(delayMs, runtimeProfile.politeMinDelayMs);
        const MAX_ADAPTIVE_DELAY = Math.max(
            basePoliteDelay,
            parseInt(process.env.SCRAPERITO_MAX_ADAPTIVE_DELAY_MS || '12000', 10) || 12000
        );

        const hostScheduler = createHostScheduler({
            baseDelayMs: basePoliteDelay,
            maxDelayMs: MAX_ADAPTIVE_DELAY,
            recoverySuccesses: runtimeProfile.adaptiveDelayRecoverySuccesses,
            recoveryStepMs: runtimeProfile.adaptiveDelayRecoveryStepMs,
            hardFailureThreshold: runtimeProfile.hostRecoveryFailureThreshold,
            recoveryJitterMinMs: runtimeProfile.hostRecoveryJitterMinMs,
            recoveryJitterMaxMs: runtimeProfile.hostRecoveryJitterMaxMs,
            recoveryProbeEvery: runtimeProfile.hostRecoveryProbeEvery,
            recoveryPrimarySuccesses: runtimeProfile.hostRecoveryPrimarySuccesses,
            resolveItemUrl: item => unwrapViewerURL(item?.url || ''),
            onTransition: transition => {
                if (transition.type === 'penalty' || transition.type === 'recovery') {
                    const direction = transition.type === 'penalty' ? 'increased' : 'recovered';
                    const reason = transition.reason ? ` after ${transition.reason}` : '';
                    addMissionLog(
                        userId,
                        `Host pacing ${direction} for ${transition.hostKey}: ${transition.previousDelay}ms -> ${transition.delayMs}ms${reason}.`,
                        transition.type === 'penalty' ? 'warn' : 'info'
                    );
                    return;
                }
                if (transition.type === 'reader_recovery_eligible') {
                    addMissionLog(userId, `Host recovery candidate for ${transition.hostKey}: ${transition.failures} confirmed access failures. A validated reader result is required before routing later HTML pages.`, 'warn');
                } else if (transition.type === 'reader_recovery_enabled') {
                    addMissionLog(userId, `Reader recovery active for ${transition.hostKey} after validated ${transition.source}. Later HTML pages will use the reader first with bounded per-host pacing; PDF and Word handling is unchanged.`, 'info');
                } else if (transition.type === 'reader_recovery_disabled') {
                    addMissionLog(userId, `Reader recovery cleared for ${transition.hostKey}: primary browser probes are healthy again.`, 'success');
                } else if (transition.type === 'reader_recovery_failure') {
                    addMissionLog(userId, `Reader recovery did not return usable content for ${transition.hostKey}; this URL is continuing through the normal browser route.`, 'info');
                } else if (transition.type === 'solver_recovery_enabled') {
                    addMissionLog(userId, `Validated Trawl recovery active for ${transition.hostKey}: keeping normal polite pacing after ${transition.failures} confirmed access failures. HTML pages use Trawl first; PDF and Word handling is unchanged.`, 'success');
                } else if (transition.type === 'solver_recovery_disabled') {
                    addMissionLog(userId, `Validated Trawl recovery cleared for ${transition.hostKey}: ${transition.reason}. The normal browser/fallback route remains available.`, 'info');
                } else if (transition.type === 'solver_recovery_failure') {
                    addMissionLog(userId, `Validated Trawl recovery did not return usable source text for ${transition.hostKey}; this URL is continuing through the normal browser route.`, 'info');
                }
            }
        });

        const increaseHostDelay = (targetUrl, minimumDelay, increment, reason) => (
            hostScheduler.penalize(targetUrl, minimumDelay, increment, reason)
        );

        const recordStrongAccessFailure = (targetUrl, navigation, reason) => {
            if (navigation?.strongAccessFailure) {
                hostScheduler.recordHardFailure(targetUrl, reason || navigation.reason || 'strong navigation failure');
            }
        };

        if (runtimeProfile.isLocalRuntime) {
            addMissionLog(
                userId,
                `Local performance profile: ${concurrency} swarm workers, ${basePoliteDelay}ms per-host delay, ${runtimeProfile.ocrDocumentConcurrency} concurrent OCR document slot(s).`,
                'info'
            );
        }

        const finalizePendingLinks = () => {
            const fallbackReason = ctx.stopRequested
                ? 'Mission stopped before this URL was processed.'
                : pagesScrapedTotal >= globalMaxPages
                    ? `Page limit reached (${globalMaxPages}) before this URL was processed.`
                    : 'Mission ended before this URL was processed.';

            let finalized = 0;
            for (const item of missionProgress.details) {
                if (item.status !== 'pending') continue;
                // If an equivalent URL already completed, this is a duplicate rather than
                // an unexplained unfinished URL.
                const normalizedItemUrl = normalizeVisitUrl(item.url);
                const equivalentWasProcessed = missionProgress.details.some(candidate => (
                    candidate !== item &&
                    candidate.status !== 'pending' &&
                    normalizeVisitUrl(candidate.url) === normalizedItemUrl
                ));
                const reason = equivalentWasProcessed
                    ? 'Duplicate URL after normalization; an equivalent URL was already processed.'
                    : fallbackReason;
                item.status = 'skipped';
                item.reason = reason;
                item.pdfSaved = false;
                item.pdfKind = 'none';
                item.pdfReason = `No PDF saved because ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
                item.updatedAt = new Date().toISOString();
                finalized++;
            }
            return { finalized, reason: fallbackReason };
        };

        const swarmWorker = async (workerId) => {
            const addLog = (msg, type) => addMissionLog(userId, `[Elmito ${workerId}] ${msg}`, type);

            let lastHeartbeat = Date.now();
            while (true) {
                if (ctx.stopRequested) break;

                let linkObj = null;
                let schedulerWaitMs = 0;
                // Only take new URLs if under the limit
                if (pagesScrapedTotal < globalMaxPages) {
                    const scheduled = hostScheduler.dequeue(queue);
                    linkObj = scheduled.item;
                    schedulerWaitMs = scheduled.waitMs;
                }
                if (!linkObj) {
                    // 📌 Swarm Heartbeat: Log every 60s if idle
                    if (Date.now() - lastHeartbeat > 60000) {
                        addMissionLog(userId, `📌 [Elmito ${workerId}] Idle — waiting for URLs...`, 'info');
                        lastHeartbeat = Date.now();
                    }

                    // v16.72: Clean termination — exit if idle AND (queue empty OR limit reached)
                    if (busyWorkers === 0 && (queue.length === 0 || pagesScrapedTotal >= globalMaxPages)) {
                        if (pagesScrapedTotal >= globalMaxPages && queue.length > 0) {
                            addMissionLog(userId, `🛑 Page limit reached (${globalMaxPages}). Stopping swarm even with ${queue.length} links pending.`, 'warn');
                        }
                        break;
                    }

                    // When queued hosts are cooling down, wake close to the next
                    // eligible slot. Empty discovery queues keep the original cadence.
                    const idleWaitMs = schedulerWaitMs > 0
                        ? Math.min(1000, Math.max(25, schedulerWaitMs))
                        : 2000;
                    await sleep(idleWaitMs);
                    continue;
                }

                pagesScrapedTotal++;

                const { url, depth, baseUrl, originalQueueUrl } = linkObj;
                const normalizedUrl = unwrapViewerURL(url);
                linkDepthByUrl.set(normalizeVisitUrl(url), { level: depth, depth, seedUrl: baseUrl });
                const preVisitSkipReason = getPreVisitSkipReason(normalizedUrl, baseUrl, depth, maxDepth, stayOnDomain);
                if (preVisitSkipReason) {
                    pagesScrapedTotal--; // Do not consume the page budget for policy-filtered URLs.
                    updateLinkStatus(url, 'skipped', preVisitSkipReason);
                    continue;
                }

                const visitKey = resolveVisitKey(baseUrl, normalizedUrl);
                if (visitedTotal.has(visitKey)) {
                    pagesScrapedTotal--; // v16.69: Don't count skipped URLs
                    updateLinkStatus(
                        url,
                        'skipped',
                        'Duplicate URL after normalization; an equivalent URL was already processed.'
                    );
                    continue;
                }

                // Reserve the canonical visit before the first await. Without this, two
                // swarm workers can both pass the duplicate check and scrape fragments
                // of the same URL concurrently.
                visitedTotal.add(visitKey);

                let workerPage = null; // v16.69 fix: Declared outside try so finally can access it
                // These values are read by finally even when Sailor mode exits early.
                // Initialize them before any possible continue in the worker loop.
                let readerRecoveryProbe = false;
                let solverRecoveryProbe = false;
                let usedPrimaryBrowserResult = false;
                // Result is also inspected by worker bookkeeping in finally.
                let result = null;
                let navigationTrace = null;
                const processingStartedAt = Date.now();
                const linkPerformance = {
                    queueWaitMs: Math.max(0, processingStartedAt - (linkObj.queuedAt || processingStartedAt)),
                    politeWaitMs: 0,
                    effectiveHostDelayMs: hostScheduler.getDelay(normalizedUrl),
                    headPreflightMs: 0,
                    retrievalMs: 0,
                    pdfRenderMs: 0,
                    storageMs: 0,
                    totalMs: 0
                };
                const reservation = hostScheduler.reserve(normalizedUrl);
                linkPerformance.politeWaitMs = reservation.waitMs;
                linkPerformance.effectiveHostDelayMs = reservation.delayMs;
                busyWorkers++;
                try {
                    if (reservation.waitMs > 0) await sleep(reservation.waitMs);
                    workerPage = await browser.newPage();
                    await workerPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,eot,mp4,webm,ogg,mp3,wav}', route => route.abort());

                    addLog(`Flying to: ${normalizedUrl}...`, 'info');

                    const urlNoFragment = url.split('#')[0];
                    const urlPathOnly = urlNoFragment.split('?')[0];
                    // v16.87: Detect PDF suffix either at the end of the path OR at the end of the full URL (handles :PDF in query params)
                    const pdfSuffixRegex = /(?:[:._=]|\/)pdf$/i;
                    const isPdfExtension = pdfSuffixRegex.test(urlPathOnly) || pdfSuffixRegex.test(urlNoFragment);
                    const isWordDocumentExtension = /\.docx?$/i.test(urlPathOnly);

                    let isMaskedPDF = false;
                    let isMaskedWord = false;
                    let unsupportedAttachmentReason = null;
                    if (!isPdfExtension && !isWordDocumentExtension) {
                        const headStartedAt = Date.now();
                        try {
                            const sniff = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
                            const sniffType = (sniff.headers.get('content-type') || '').toLowerCase();
                            const sniffDisposition = (sniff.headers.get('content-disposition') || '').toLowerCase();
                            const hasExplicitDocumentMime = sniffType.includes('application/pdf') ||
                                sniffType.includes('officedocument.wordprocessingml.document') ||
                                sniffType.includes('application/msword');
                            if (sniff.ok && sniffDisposition.includes('attachment') && !hasExplicitDocumentMime) {
                                const inspection = await inspectRemoteDocument(url);
                                if (inspection.kind === 'pdf') {
                                    isMaskedPDF = true;
                                    addLog('Attachment bytes identify a PDF. Bypassing HTML engine...', 'info');
                                } else if (inspection.kind === 'doc' || inspection.kind === 'docx') {
                                    isMaskedWord = true;
                                    addLog(`Attachment bytes identify a ${inspection.kind.toUpperCase()} document. Bypassing HTML engine...`, 'info');
                                } else if (inspection.ok && inspection.kind === 'unknown') {
                                    unsupportedAttachmentReason = `Unsupported attachment type (${inspection.contentType || 'unknown MIME'}); PDF/Word signatures were not found.`;
                                }
                            }
                            if (sniffType.includes('officedocument.wordprocessingml.document') || sniffType.includes('application/msword')) {
                                isMaskedWord = true;
                                addLog('Masked Word document headers detected. Bypassing HTML engine...', 'info');
                            } else if (sniffType.includes('application/pdf')) {
                                isMaskedPDF = true;
                                addLog(`🕵️ Masked PDF headers detected. Bypassing HTML engine...`, 'info');
                            }
                        } catch (e) { }
                        linkPerformance.headPreflightMs += Date.now() - headStartedAt;
                    }

                    // 🏴‍☠️ SAILOR MODE: Lightweight link-only extraction, skip full scrape pipeline
                    if (sailorMode) {
                        try {
                            let sailorResponse = await workerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(err => ({ error: true, message: err.message }));
                            
                            let html = '';
                            let pageTitle = url;
                            let bypassResult = null;
                            let isBlocked = sailorResponse?.error || (sailorResponse && !sailorResponse.ok() && [403, 502, 503, 504].includes(sailorResponse.status()));

                            if (!isBlocked) {
                                html = await workerPage.content().catch(() => '');
                                pageTitle = await workerPage.title().catch(() => url);
                                // 🛡️ Content-level Challenge Detection
                                if (html.length < 5000 && /just a moment|checking your browser|verify you are not a bot|security verification/i.test(html)) {
                                    isBlocked = true;
                                }
                            }

                            if (isBlocked) {
                                addLog(`🛡️ Sailor blocked or navigation failed. Engaging survival bypass chain...`, 'warn');
                                const bypassChain = getFallbackRoute('sailorLinks', FALLBACK_PROVIDERS);
                                for (const bp of buildBypassChain(url, bypassChain)) {
                                    try {
                                        bypassResult = await bp.fn(url, addLog);
                                        if (bypassResult) {
                                            recordBypassSuccess(url, bp.name, addLog);
                                            addLog(`✅ Sailor survival bypass successful via ${bp.name}`, 'success');
                                            break;
                                        }
                                        recordBypassFailure(url, bp.name);
                                    } catch (e) {
                                        recordBypassFailure(url, bp.name);
                                    }
                                }
                            }

                            let scoredLinks = [];
                            if (bypassResult) {
                                pageTitle = (bypassResult.metadata && bypassResult.metadata.title) ? bypassResult.metadata.title : pageTitle;
                                // 🔗 Extract and score links from bypass result
                                if (bypassResult.discoveredLinks && bypassResult.discoveredLinks.length > 0) {
                                    scoredLinks = sortLinksByScore(bypassResult.discoveredLinks, depth);
                                } else {
                                    const source = bypassResult.allText || bypassResult.plainText || '';
                                    scoredLinks = scoredLinksFromHtml(source, url, depth);
                                }
                            } else {
                                scoredLinks = scoredLinksFromHtml(html, url, depth);
                            }

                            const activeLinks = scoredLinks.filter(l => l.status !== 'excluded');
                            addLog(`🏴‍☠️ Sailor: found ${activeLinks.length} active links (filtered ${scoredLinks.length - activeLinks.length} noise) on "${pageTitle.substring(0, 50)}"`, 'info');
                            await saveSailorResult(userId, baseUrl, url, { title: pageTitle, links: scoredLinks }, missionId, startUrls.length);
                            markResultsChanged(userId);
                            missionProgress.successful++;
                            updateLinkStatus(url, 'success');

                            // Queue depth+1 links using the active list (honour smartNav ordering)
                            if (depth < maxDepth && activeLinks.length > 0) {
                                const nextDepth = depth + 1;
                                const queueItems = (smartNav ? activeLinks : [...activeLinks].reverse())
                                    .map(link => ({ url: link.href, depth: nextDepth, baseUrl, originalQueueUrl }));
                                const queueResult = enqueueCrawlItems(queueItems, true);
                                if (queueResult.duplicates > 0) {
                                    addLog(`Queue coalesced ${queueResult.duplicates} repeated discovered URL(s).`, 'info');
                                }
                            }
                        } catch (sailorErr) {
                            addLog(`❌ Sailor link harvest failed: ${sailorErr.message}`, 'error');
                            updateLinkStatus(url, 'failed', sailorErr.message);
                        }
                        continue; // Skip the rest of the worker loop for this URL
                    }

                    const navigationFallbacks = [];
                    if (unsupportedAttachmentReason) {
                        addLog(unsupportedAttachmentReason, 'warn');
                        updateLinkStatus(url, 'failed', unsupportedAttachmentReason, {
                            pdfSaved: false,
                            pdfKind: 'none',
                            pdfReason: 'No PDF saved because the attachment type is not supported.'
                        });
                        continue;
                    }
                    let officialSourceFailureReason = null;
                    let contentValidationFailure = null;
                    const rememberContentValidationFailure = (error) => {
                        const issue = getUnusableContentIssue(error);
                        if (issue) contentValidationFailure = issue;
                    };
                    try {
                        result = await resolveOfficialSource(url, { addMissionLog: addLog });
                    } catch (officialSourceErr) {
                        // Official-source resolvers are opportunistic. A registry outage must
                        // never prevent the normal browser/document pipeline from continuing.
                        officialSourceFailureReason = officialSourceErr.message;
                        addLog(`Official source resolver unavailable: ${officialSourceErr.message}`, 'warn');
                    }
                    try {
                        if (result) {
                            // The official resolver supplied verified source text; do not open
                            // the WAF-protected portal page or route it through generic fallbacks.
                        } else if (isWordDocumentExtension || isMaskedWord) {
                            result = await scrapeWord(url);
                        } else if (isPdfExtension || isMaskedPDF) {
                            try {
                                result = await scrapePDF(url, browser, addLog);
                            } catch (pdfErr) {
                                // v16.83 Safety Polish: If it wasn't a "hard" .pdf extension, it might be an HTML page misclassified by the suffix regex.
                                const isHardPdf = urlNoFragment.toLowerCase().endsWith('.pdf');
                                if (!isHardPdf) {
                                    addLog(`⚠️ Document extraction failed, but URL is not a standard .pdf. Falling back to HTML engine...`, 'info');
                                    // Setting result to null allows the loop to fall through to the standard scrapePage logic below
                                    result = null;
                                } else {
                                    throw pdfErr; // Standard PDF extension failure -> proceed to Archive.org fallback
                                }
                            }
                        }
                    } catch (docErr) {
                        rememberContentValidationFailure(docErr);
                        const isWordDocument = isWordDocumentExtension || isMaskedWord;
                        const isLegacyWordFailure = /LEGACY_WORD_|legacy \.doc/i.test(docErr.message || '');
                        if (isLegacyWordFailure) {
                            addLog(`Legacy .doc extraction failed without entering HTML fallbacks: ${docErr.message}`, 'error');
                            updateLinkStatus(url, 'failed', `Legacy .doc extraction failed: ${docErr.message}`, {
                                pdfSaved: false,
                                pdfKind: 'none',
                                pdfReason: 'No PDF saved because the legacy Word document could not be converted locally.'
                            });
                            continue;
                        }
                        const documentUnavailable = docErr.message === 'BOT_BLOCKED' || isUnusableContentError(docErr);
                        if (documentUnavailable && isWordDocument) {
                            addLog(`DOCX bot block detected. Trying Ghost Word download instead of text fallbacks...`, 'warn');
                            try {
                                result = await scrapeWordViaGhost(url, browser, addLog);
                                if (result) addLog(`Ghost Word download succeeded`, 'success');
                            } catch (ghostWordErr) {
                                addLog(`DOCX Ghost Word failed: ${ghostWordErr.message}. Trying Trawl Word download...`, 'warn');
                                try {
                                    result = await scrapeWordViaTrawl(url, browser, addLog);
                                    if (result) addLog(`Trawl Word download succeeded`, 'success');
                                } catch (flareWordErr) {
                                    addLog(`DOCX Trawl Word failed: ${flareWordErr.message}. Not routing DOCX through Jina/HTML fallbacks.`, 'error');
                                    updateLinkStatus(url, 'failed', `DOCX extraction failed: ${flareWordErr.message}`, {
                                        pdfSaved: false,
                                        pdfKind: 'none',
                                        pdfReason: 'No PDF saved because DOCX extraction failed before text conversion.'
                                    });
                                    continue;
                                }
                            }
                        } else if (documentUnavailable) {
                            addLog(`🛡️ Bot block detected during document extraction. Attempting multi-path bypass...`, 'warn');
                            const docBypass = getFallbackRoute('documentRecovery', FALLBACK_PROVIDERS);
                            for (const bp of docBypass) {
                                try {
                                    result = await bp.fn(url, addLog);
                                    if (result) {
                                        navigationFallbacks.push({ name: bp.name, outcome: 'returned_result' });
                                        recordBypassSuccess(url, bp.name, addLog);
                                        addLog(`✅ Document bypass successful via ${bp.name}`, 'success');
                                        break;
                                    }
                                } catch (e) {
                                    rememberContentValidationFailure(e);
                                    addLog(`${bp.name} document bypass failed: ${e.message}`, 'warn');
                                }
                            }
                        } else {
                            try {
                                if (isWordDocument) {
                                    addLog(`❌ Word fetch failed: ${docErr.message}. Trying Ghost browser download...`, 'warn');
                                    result = await scrapeWordViaGhost(url, browser, addLog);
                                    if (result) addLog(`✅ Ghost Word download succeeded`, 'success');
                                } else {
                                    addLog(`❌ Document extraction failed: ${docErr.message}. Trying Archive.org...`, 'warn');
                                    result = await scrapeViaArchive(url, addLog);
                                }
                            } catch (ghostOrArchiveErr) {
                                if (isWordDocument) {
                                addLog(`DOCX Ghost fallback failed: ${ghostOrArchiveErr.message}. Trying Trawl Word download...`, 'warn');
                                    try {
                                        result = await scrapeWordViaTrawl(url, browser, addLog);
                                        if (result) addLog(`Trawl Word download succeeded`, 'success');
                                    } catch (flareWordErr) {
                                        addLog(`DOCX Trawl Word failed: ${flareWordErr.message}. Not routing DOCX through HTML/Jina fallbacks.`, 'error');
                                        result = null;
                                        updateLinkStatus(url, 'failed', `DOCX extraction failed: ${flareWordErr.message}`, {
                                            pdfSaved: false,
                                            pdfKind: 'none',
                                            pdfReason: 'No PDF saved because DOCX extraction failed before text conversion.'
                                        });
                                        continue;
                                    }
                                }
                                addLog(`❌ Primary fallback failed: ${ghostOrArchiveErr.message}. Trying Archive.org (long-term resort)...`, 'warn');
                                try {
                                    result = await scrapeViaArchive(url, addLog);
                                } catch (archiveErr) {
                                    addLog(`❌ Archive.org fallback failed: ${archiveErr.message}`, 'error');
                                }
                            }
                        }
                    } // end catch(docErr)

                    // A host reaches this path only after repeated strong failures and
                    // a previous Jina result has passed the normal source checks. The
                    // reader is tried first for HTML only; an unusable response falls
                    // through to the existing browser/fallback flow for this same URL.
                    const isHtmlRecoveryCandidate = !isWordDocumentExtension && !isMaskedWord &&
                        !isPdfExtension && !isMaskedPDF;
                    if (!result && isHtmlRecoveryCandidate && hostScheduler.isReaderRecoveryActive(normalizedUrl)) {
                        if (hostScheduler.shouldProbePrimary(normalizedUrl)) {
                            readerRecoveryProbe = true;
                            addLog('Reader recovery canary: testing the primary browser route for this host.', 'info');
                        } else {
                            addLog('Reader recovery active: trying validated reader before browser navigation.', 'info');
                            try {
                                const readerResult = await scrapeViaJina(url, addLog);
                                const readerAssessment = assessExtractedContent(readerResult, { url });
                                if (readerAssessment.ok) {
                                    result = readerResult;
                                    addLog('Reader recovery returned substantive source text.', 'success');
                                } else {
                                    hostScheduler.recordReaderRecoveryFailure(
                                        normalizedUrl,
                                        readerAssessment.issue?.reason || 'reader response failed source checks'
                                    );
                                }
                            } catch (readerErr) {
                                hostScheduler.recordReaderRecoveryFailure(normalizedUrl, readerErr.message);
                            }
                        }
                    }

                    // Promote Trawl only after it has recovered substantive source
                    // text from a repeatedly blocked HTML host. PDF/Word routes and
                    // normal hosts retain their existing browser-first behavior.
                    if (!result && isHtmlRecoveryCandidate && hostScheduler.isSolverRecoveryActive(normalizedUrl)) {
                        hostScheduler.recordSolverRecoveryDispatch(normalizedUrl);
                        if (hostScheduler.shouldProbeSolverPrimary(normalizedUrl)) {
                            solverRecoveryProbe = true;
                            addLog('Validated Trawl recovery canary: testing the primary browser route for this host.', 'info');
                        } else {
                            addLog('Validated Trawl recovery active: trying Trawl before browser navigation.', 'info');
                            try {
                                const solverResult = await scrapeViaTrawl(url, addLog);
                                const solverAssessment = assessExtractedContent(solverResult, { url });
                                if (solverAssessment.ok) {
                                    result = solverResult;
                                    navigationTrace = {
                                        status: null,
                                        statusText: null,
                                        contentType: 'text/html',
                                        action: 'solver_recovery',
                                        strongAccessFailure: true,
                                        reason: 'validated Trawl recovery route'
                                    };
                                    addLog('Validated Trawl recovery returned substantive source text.', 'success');
                                } else {
                                    hostScheduler.recordSolverRecoveryFailure(
                                        normalizedUrl,
                                        solverAssessment.issue?.reason || 'Trawl response failed source checks'
                                    );
                                }
                            } catch (solverErr) {
                                hostScheduler.recordSolverRecoveryFailure(normalizedUrl, solverErr.message);
                            }
                        }
                    }

                    if (!result) {
                        // ... HTML branch continues ...
                        let response = await workerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(err => {
                            if (err.message && err.message.includes('Page crashed')) return { crashed: true };
                            return { error: true, message: err.message };
                        });

                        const navigation = classifyNavigationResponse(response);
                        navigationTrace = {
                            status: navigation.status,
                            statusText: navigation.statusText,
                            contentType: navigation.contentType,
                            action: navigation.action,
                            strongAccessFailure: navigation.strongAccessFailure,
                            reason: navigation.reason
                        };
                        const isDirectDownloadStart = typeof response?.message === 'string' && response.message.includes('Download is starting');

                        if (navigation.action === 'terminal') {
                            const reason = analyzeError(new Error('HTTP Error'), response);
                            addLog(`Terminal navigation response (${navigation.reason}). Skipping fallbacks: ${url}`, 'warn');
                            updateLinkStatus(url, 'failed', reason, {
                                navigation: navigationTrace,
                                pdfSaved: false,
                                pdfKind: 'none',
                                pdfReason: 'No PDF saved because the official source returned a confirmed broken-link response.'
                            });
                            continue;
                        }

                        if (navigation.action === 'recover') {
                            if (isDirectDownloadStart) {
                                try {
                                    const inspection = await inspectRemoteDocument(url);
                                    const sniff = { ok: inspection.ok };
                                    const sniffType = inspection.kind === 'pdf'
                                        ? 'application/pdf'
                                        : (inspection.kind === 'docx'
                                            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                            : (inspection.kind === 'doc' ? 'application/msword' : inspection.contentType.toLowerCase()));
                                    const sniffDisposition = ['pdf', 'doc', 'docx'].includes(inspection.kind)
                                        ? 'attachment'
                                        : '';
                                    if (inspection.ok && inspection.kind === 'unknown') {
                                        const reason = `Unsupported direct-download attachment (${inspection.contentType || 'unknown MIME'}); PDF/Word signatures were not found.`;
                                        addLog(reason, 'warn');
                                        updateLinkStatus(url, 'failed', reason, {
                                            pdfSaved: false,
                                            pdfKind: 'none',
                                            pdfReason: 'No PDF saved because the direct-download attachment type is not supported.'
                                        });
                                        continue;
                                    }

                                    if (sniff.ok && (sniffType.includes('application/pdf') || sniffDisposition.includes('attachment') || sniffType.includes('officedocument.wordprocessingml.document') || sniffType.includes('msword'))) {
                                        addLog(`📄 Direct download detected via navigation error. Routing to document extractor...`, 'info');
                                        if (sniffType.includes('officedocument.wordprocessingml.document') || sniffType.includes('msword')) {
                                            result = await scrapeWord(url);
                                        } else {
                                            result = await scrapePDF(url, browser, addLog);
                                        }
                                    }
                                } catch (downloadSniffErr) {
                                    addLog(`⚠️ Direct download sniff failed: ${downloadSniffErr.message}`, 'warn');
                                }
                            }

                            if (result) {
                                // The URL is a real document download, not a blocked HTML page.
                                // Skip the survival bypass chain once we have extracted it successfully.
                            } else {
                            const failReason = navigation.reason || 'navigation response could not be classified';
                            addLog(`🛡️ Navigation failure detected (${failReason}). Engaging survival bypass chain...`, 'warn');
                            if (navigation.strongAccessFailure) {
                                increaseHostDelay(normalizedUrl, 4000, 2000, 'navigation access failure');
                                recordStrongAccessFailure(normalizedUrl, navigation, 'navigation access failure');
                            } else {
                                addLog(`Ambiguous non-terminal response (${failReason}); trying fallbacks without changing host pacing.`, 'info');
                            }

                            const bypassChain = getFallbackRoute('htmlRecovery', FALLBACK_PROVIDERS);

                            for (const bp of buildBypassChain(url, bypassChain)) {
                                try {
                                    result = await bp.fn(url, addLog);
                                    if (result) {
                                        recordBypassSuccess(url, bp.name, addLog);
                                        addLog(`✅ Survival bypass successful via ${bp.name}`, 'success');
                                        break;
                                    }
                                    navigationFallbacks.push({ name: bp.name, outcome: 'no_result' });
                                    recordBypassFailure(url, bp.name);
                                } catch (bpErr) {
                                    rememberContentValidationFailure(bpErr);
                                    navigationFallbacks.push({ name: bp.name, outcome: 'failed', reason: bpErr.message });
                                    recordBypassFailure(url, bp.name);
                                    addLog(`❌ ${bp.name} bypass failed: ${bpErr.message}`, 'warn');
                                }
                            }
                            }
                        } else {
                            const contentType = navigation.contentType || '';
                            const nonDocumentResponse = classifyNonDocumentResponse(contentType);
                            if (nonDocumentResponse) {
                                addLog(nonDocumentResponse.reason, 'info');
                                updateLinkStatus(url, 'skipped', nonDocumentResponse.reason, {
                                    qualityStatus: 'excluded',
                                    qualityCategory: nonDocumentResponse.category,
                                    pdfSaved: false,
                                    pdfKind: 'none',
                                    pdfReason: 'No PDF saved because the URL is a non-document media resource.'
                                });
                                continue;
                            } else if (contentType.includes('application/pdf')) {
                                result = await scrapePDF(url, browser, addLog);
                            } else {
                                let rawLinks = [];
                                try {
                                    rawLinks = await withWorkerPageTimeout(workerPage, () => workerPage.evaluate(({ bodyOnly, excludeNoise }) => {
                                        const NOISE_REGEXP = /cookie|legal|privacy|notice|terms|conditions|data-protection|imprint|disclaimer|copyright|accessibility|contact-us|newsletter|subscribe|login|signin|signup|register|cart|checkout|aceptar|configurar|politica|aviso|mapa|ayuda|accesibilidad|consentimiento/i;
                                        let container = document.body;
                                        if (bodyOnly) {
                                            const selectors = ['article', 'main', '[role="main"]', '.main-content', '#main-content', '.post-content', '.article-body', '.entry-content', '#content'];
                                            for (const sel of selectors) {
                                                const el = document.querySelector(sel);
                                                if (el && el.innerText.length > 500) { container = el; break; }
                                            }
                                        }
                                        return Array.from(container.querySelectorAll('a[href]')).filter(a => {
                                            const href = a.href.split('#')[0];
                                            if (!href.startsWith('http')) return false;
                                            if (a.closest('nav, header, footer, [role="navigation"], aside')) return false;
                                            let p = a.parentElement; let d = 0;
                                            while (p && d < 5) {
                                                if (/cookie|consent|aviso|legal|menu|header|footer|sticky|banner/i.test(p.id + p.className)) return false;
                                                p = p.parentElement; d++;
                                            }
                                            if (excludeNoise && (NOISE_REGEXP.test(a.textContent) || NOISE_REGEXP.test(href))) return false;
                                            return true;
                                        }).map(a => {
                                            const container = a.closest('main, article, section')?.tagName.toLowerCase() || '';
                                            return { href: a.href.split('#')[0], text: a.textContent.trim(), container };
                                        });
                                    }, { bodyOnly, excludeNoise }), LINK_DISCOVERY_TIMEOUT_MS, 'link discovery');
                                } catch (linksErr) {
                                    if (linksErr.message === 'GLOBAL_PAGE_TIMEOUT') throw linksErr;
                                    if (addLog) addLog(`⚠️ Could not evaluate DOM for links (possible redirect): ${linksErr.message}`, 'warn');
                                }

                                try {
                                    result = await withWorkerPageTimeout(
                                        workerPage,
                                        () => scrapePage(workerPage, { stayOnDomain, targetUrl: url, addMissionLog: addLog }),
                                        PAGE_OPERATION_TIMEOUT_MS,
                                        'content extraction'
                                    );
                                    if (result) {
                                        result.discoveredLinks = rawLinks;
                                        usedPrimaryBrowserResult = true;
                                    }
                                } catch (err) {
                                    rememberContentValidationFailure(err);
                                    if (err.message === 'BOT_BLOCKED' || isUnusableContentError(err) || err.message.includes('crashed') || err.message === 'GLOBAL_PAGE_TIMEOUT') {
                                        const recoveryMessage = err.message === 'GLOBAL_PAGE_TIMEOUT'
                                            ? `⏱️ ${err.operation || 'Page operation'} timed out after ${err.timeoutMs || PAGE_OPERATION_TIMEOUT_MS}ms. Attempting extraction bypass...`
                                            : '🛡️ Bot block detected. Attempting extraction bypass...';
                                        addLog(recoveryMessage, 'warn');
                                        increaseHostDelay(normalizedUrl, 5000, 1000, 'blocked or timed-out extraction');
                                        if (err.message === 'BOT_BLOCKED' || isUnusableContentError(err)) {
                                            hostScheduler.recordHardFailure(normalizedUrl, 'blocked extraction');
                                        }

                                        const blockBypass = getFallbackRoute('htmlRecovery', FALLBACK_PROVIDERS);

                                        for (const bb of buildBypassChain(url, blockBypass)) {
                                            try {
                                                result = await bb.fn(url, addLog);
                                                if (result) {
                                                    recordBypassSuccess(url, bb.name, addLog);
                                                    addLog(`✅ Block bypass successful via ${bb.name}`, 'success');
                                                    break;
                                                }
                                                recordBypassFailure(url, bb.name);
                                            } catch (bbErr) {
                                                rememberContentValidationFailure(bbErr);
                                                recordBypassFailure(url, bb.name);
                                                addLog(`❌ ${bb.name} block bypass failed: ${bbErr.message}`, 'warn');
                                            }
                                        }
                                    } else throw err;
                                }
                            }
                        }
                    }

                    if (!result) {
                        const navigationReason = navigationTrace?.status
                            ? `Primary navigation returned HTTP ${navigationTrace.status}${navigationTrace.statusText ? ` ${navigationTrace.statusText}` : ''}; no configured fallback returned usable document content.`
                            : null;
                        const reason = contentValidationFailure?.reason || navigationReason || (officialSourceFailureReason
                            ? `${officialSourceFailureReason} No fallback returned usable document content.`
                            : 'Official source blocked access and no fallback returned usable document content.');
                        addLog(`URL failed after extraction and fallbacks: ${url}`, 'error');
                        updateLinkStatus(url, 'failed', reason, {
                            navigation: navigationTrace,
                            fallbackAttempts: navigationFallbacks,
                            pdfSaved: false,
                            pdfKind: 'none',
                            pdfReason: 'No PDF saved because the official source and all configured fallbacks were blocked or unavailable.'
                        });
                        continue;
                    }

                    if (result) {
                        if (looksLikeOfficeBinaryText(result.allText) || looksLikeOfficeBinaryText(result.plainText)) {
                            const reason = 'Office document binary was extracted as text. Marking as failed to prevent corrupted MD/TXT/PDF artifacts.';
                            addLog(reason, 'error');
                            updateLinkStatus(url, 'failed', reason, {
                                pdfSaved: false,
                                pdfKind: 'none',
                                pdfReason: 'No PDF saved because the extracted content was binary Office data, not readable text.'
                            });
                            continue;
                        }
                        // 🖨️ PDF Restoration (v16.78): Generate PDF from ANY extraction path (Direct or Fallback)
                        const contentAssessment = assessExtractedContent(result, { url });
                        const contentIssue = contentAssessment.validityIssue;
                        if (contentIssue) {
                            addLog(`Invalid response detected. Marking as failed: ${contentIssue.reason}`, 'warn');
                            updateLinkStatus(url, 'failed', contentIssue.reason, {
                                validationStatus: 'invalid',
                                validationCategory: contentIssue?.category || 'soft_error',
                                pdfSaved: false,
                                pdfKind: 'none',
                                pdfReason: 'No PDF saved because the URL resolved to an invalid response page.'
                            });
                            continue;
                        }

                        let contentQualityIssue = contentAssessment.qualityIssue;
                        if (contentQualityIssue && isClientSideRouteUrl(url) && isSpaRetryCategory(contentQualityIssue.category)) {
                            addLog(`Client-side route returned ${contentQualityIssue.category}. Retrying once in a fresh browser page before remote fallbacks...`, 'warn');
                            try {
                                const retried = await retryClientSideRouteExtraction(browser, url, { stayOnDomain, addMissionLog: addLog });
                                const retryAssessment = assessExtractedContent(retried, { url });
                                if (retryAssessment.ok) {
                                    result = {
                                        ...retried,
                                        discoveredLinks: retried.discoveredLinks?.length ? retried.discoveredLinks : (result.discoveredLinks || [])
                                    };
                                    contentQualityIssue = null;
                                    addLog('Client-side route retry returned substantive source content.', 'success');
                                } else {
                                    addLog('Client-side route retry did not return substantive source content.', 'info');
                                }
                            } catch (spaRetryErr) {
                                addLog(`Client-side route retry failed: ${spaRetryErr.message}`, 'info');
                            }
                        }
                        const templateRecoveryKey = getTemplateRecoveryCacheKey(result, contentQualityIssue, url);
                        const cachedTemplateRecovery = templateRecoveryKey
                            ? templateRecoveryCache.get(templateRecoveryKey)
                            : null;
                        if (contentQualityIssue?.retryable) {
                            addLog(`Low-content extraction detected (${contentQualityIssue.category}). Trying lightweight content recovery...`, 'warn');
                            const discoveredLinks = result.discoveredLinks || [];
                            const configuredRecoveryChain = getFallbackRoute('lowQualityRecovery', {
                                ...FALLBACK_PROVIDERS,
                                'Direct Fetch': () => scrapeViaDirectFetch(url, url, addLog)
                            });
                            const baseRecoveryChain = [
                                configuredRecoveryChain[0],
                                ...buildBypassChain(url, configuredRecoveryChain.slice(1))
                            ];
                            const preferredRecoveryName = cachedTemplateRecovery?.preferredRecoveryName || null;
                            const recoveryChain = preferredRecoveryName
                                ? [
                                    ...baseRecoveryChain.filter(recovery => recovery.name === preferredRecoveryName),
                                    ...baseRecoveryChain.filter(recovery => recovery.name !== preferredRecoveryName)
                                ]
                                : baseRecoveryChain;
                            if (preferredRecoveryName) {
                                addLog(
                                    `Exact shared ${contentQualityIssue.category} template previously recovered via ${preferredRecoveryName}; trying that validated method first without skipping other fallbacks.`,
                                    'info'
                                );
                            }

                            for (const recovery of recoveryChain) {
                                try {
                                    const recovered = await recovery.fn(url, addLog);
                                    if (!recovered) continue;
                                    const recoveredAssessment = assessExtractedContent(recovered, { url });
                                    if (!recoveredAssessment.ok) {
                                        addLog(`${recovery.name} did not return substantive source text.`, 'info');
                                        continue;
                                    }

                                    result = {
                                        ...recovered,
                                        discoveredLinks: recovered.discoveredLinks?.length ? recovered.discoveredLinks : discoveredLinks
                                    };
                                    usedPrimaryBrowserResult = false;
                                    contentQualityIssue = null;
                                    // Direct Fetch is a local extraction retry, not a bypass signal.
                                    // Only external bypasses may influence per-domain fallback ordering.
                                    if (recovery.name !== 'Direct Fetch') {
                                        recordBypassSuccess(url, recovery.name, addLog);
                                    }
                                    if (templateRecoveryKey) {
                                        templateRecoveryCache.set(templateRecoveryKey, {
                                            preferredRecoveryName: recovery.name,
                                            recordedAt: new Date().toISOString()
                                        });
                                    }
                                    addLog(`Content recovery successful via ${recovery.name}.`, 'success');
                                    break;
                                } catch (recoveryErr) {
                                    if (recovery.name !== 'Direct Fetch') {
                                        recordBypassFailure(url, recovery.name);
                                    }
                                    addLog(`${recovery.name} content recovery failed: ${recoveryErr.message}`, 'info');
                                }
                            }

                        }

                        if (contentQualityIssue) {
                            const reason = `Excluded from corpus: ${contentQualityIssue.reason}`;
                            addLog(`${reason} Links, when found, will still be followed.`, 'warn');
                            queueDiscoveredLinks(result, depth, baseUrl, originalQueueUrl, addLog);
                            updateLinkStatus(url, 'skipped', reason, {
                                qualityStatus: 'excluded',
                                qualityCategory: contentQualityIssue.category,
                                qualityMetrics: contentQualityIssue.metrics || null,
                                pdfSaved: false,
                                pdfKind: 'none',
                                pdfReason: 'No PDF saved because the extracted page did not contain substantive source text.'
                            });
                            continue;
                        }

                        // A non-terminal response outside the usual WAF status list is
                        // not sufficient on its own to alter host routing. It becomes
                        // recovery evidence only after Jina passes the same source gates.
                        if (result.jinaFallback && navigationTrace?.action === 'recover' && !navigationTrace?.strongAccessFailure) {
                            hostScheduler.recordHardFailure(
                                normalizedUrl,
                                `validated Jina recovery after ${navigationTrace.reason || 'ambiguous navigation response'}`
                            );
                        }

                        // Only a Jina result that has survived the same validity and
                        // quality gates as a browser result can activate host recovery.
                        // This prevents an HTML shell, challenge page, or unrelated
                        // reader response from changing how later URLs are fetched.
                        if (result.jinaFallback && hostScheduler.isReaderRecoveryEligible(normalizedUrl)) {
                            hostScheduler.enableReaderRecovery(normalizedUrl, 'Jina Reader result');
                        }

                        // Keep fingerprints for audit/review only. No content match,
                        // including identical source bytes, may suppress a URL.
                        const contentFingerprint = getContentAuditFingerprint(result);
                        const textAuditFingerprint = getExtractedTextAuditFingerprint(result);

                        if (contentFingerprint) {
                            // Store the fingerprint with the artifact for forensic checks.
                            result.contentSha256 = contentFingerprint.hash;
                            result.contentFingerprintKind = contentFingerprint.kind;
                            result.contentFingerprintScope = contentFingerprint.scope;
                        }

                        if ((result.allText || result.plainText) && !result.pdfBuffer && result.metadata) {
                            try {
                                const pdfSourceText = result.allText || result.plainText || '';
                                const textLength = String(pdfSourceText).length;
                                if (!RESTORE_TEXT_PDF_ENABLED) {
                                    addLog(`📄 Restored PDF generation disabled. Keeping MD/TXT output only.`, 'info');
                                    result.pdfSkippedReason = 'Restored PDF generation disabled by SCRAPERITO_RESTORE_TEXT_PDF=false.';
                                } else if (RESTORE_TEXT_PDF_MAX_CHARS > 0 && textLength > RESTORE_TEXT_PDF_MAX_CHARS) {
                                    addLog(`⚠️ Restored PDF skipped for large text output (${textLength} chars). Keeping MD/TXT to protect Railway memory.`, 'warn');
                                    result.pdfSkippedReason = `Restored PDF skipped because extracted text was ${textLength} chars, above SCRAPERITO_RESTORED_PDF_MAX_CHARS=${RESTORE_TEXT_PDF_MAX_CHARS}.`;
                                } else {
                                    const pdfRenderStartedAt = Date.now();
                                    const pdfBuffer = await generatePdfFromHtml(
                                        browser,
                                        result.metadata.title || 'Restored Document',
                                        result.metadata.url || url,
                                        pdfSourceText,
                                        true,
                                        { includeTraceability: ctx.pdfMetadataEnabled !== false }
                                    );
                                    if (pdfBuffer) {
                                        result.pdfBuffer = pdfBuffer;
                                        result.restoredPdf = true;
                                        if (result.officialSource) {
                                            result.pdfKind = 'official_text_render';
                                            result.pdfReason = 'PDF rendered from verified official open-data text; it is not an original downloaded PDF.';
                                        }
                                    }
                                    linkPerformance.pdfRenderMs += Date.now() - pdfRenderStartedAt;
                                }
                            } catch (pdfErr) {
                                result.pdfSkippedReason = `Restored PDF generation failed: ${pdfErr.message}`;
                            }
                        }

                        const sizeBytes = (
                            Buffer.byteLength(result.allText || '', 'utf8') +
                            Buffer.byteLength(result.plainText || '', 'utf8') +
                            (result.pdfBuffer ? result.pdfBuffer.length : 0) +
                            (result.rawDump ? Buffer.byteLength(result.rawDump, 'utf8') : 0)
                        );
                        const sizeKb = (sizeBytes / 1024).toFixed(1);

                        const storageStartedAt = Date.now();
                        const artifactReport = await saveData(userId, baseUrl, url, result, missionId, {
                            pdfMetadata: ctx.pdfMetadataEnabled !== false
                        });
                        linkPerformance.storageMs += Date.now() - storageStartedAt;
                        const textDuplicateReview = contentReviewRegistry && textAuditFingerprint
                            ? contentReviewRegistry.claim(textAuditFingerprint, url)
                            : null;
                        const duplicateReviewReason = textDuplicateReview
                            ? `Possible duplicate review: extracted TXT exactly matches ${textDuplicateReview.url}, but primary-source equality was not verified. Both artifacts were retained.`
                            : null;
                        markResultsChanged(userId);
                        missionProgress.successful++;
                        updateLinkStatus(url, 'success', null, {
                            sizeKb,
                            navigation: navigationTrace,
                            fallbackAttempts: navigationFallbacks,
                            artifacts: artifactReport,
                            pdfSaved: artifactReport?.hasPdf === true,
                            pdfKind: artifactReport?.pdfKind || 'none',
                            pdfReason: artifactReport?.pdfReason || null,
                            sourceKind: artifactReport?.sourceKind || null,
                            sourceDetail: artifactReport?.sourceDetail || null,
                            contentFingerprint: contentFingerprint?.hash || null,
                            contentFingerprintKind: contentFingerprint?.kind || null,
                            contentFingerprintScope: contentFingerprint?.scope || null,
                            duplicateReviewStatus: textDuplicateReview ? 'possible_exact_text_duplicate_unverified' : null,
                            duplicateReviewOfUrl: textDuplicateReview?.url || null,
                            duplicateReviewReason,
                            filesSaved: artifactReport?.files || {}
                        });
                        addMissionLog(userId, `✅ [Elmito ${workerId}] Task completed for: ${url} (${sizeKb} KB)`, 'success');

                        if (depth < maxDepth && result.discoveredLinks) {
                            const nextDepth = depth + 1;
                            if (smartNav && result.discoveredLinks.length > 0) {
                                // 🧭 Smart Navigator: score and rank links before queuing.
                                // Best candidates go to the FRONT of the queue so workers
                                // pick them up next (highest relevance first).
                                const ranked = sortLinksByScore(result.discoveredLinks, nextDepth);
                                addLog(`🧭 Smart Nav: ranked ${ranked.length} links (top: "${(ranked[0].text || ranked[0].href).substring(0, 40)}" score=${ranked[0]._score?.toFixed(1)})`, 'info');
                                const queueItems = ranked.map(link => ({ url: link.href, depth: nextDepth, baseUrl, originalQueueUrl }));
                                const queueResult = enqueueCrawlItems(queueItems, true);
                                if (queueResult.duplicates > 0) {
                                    addLog(`Queue coalesced ${queueResult.duplicates} repeated discovered URL(s).`, 'info');
                                }
                            } else {
                                // Standard FIFO — original behavior
                                const queueItems = result.discoveredLinks
                                    .map(link => ({ url: link.href, depth: nextDepth, baseUrl, originalQueueUrl }));
                                const queueResult = enqueueCrawlItems(queueItems);
                                if (queueResult.duplicates > 0) {
                                    addLog(`Queue coalesced ${queueResult.duplicates} repeated discovered URL(s).`, 'info');
                                }
                            }
                        }

                        // Railway heap guard: persisted artifacts are no longer needed in memory.
                        result.pdfBuffer = null;
                        result.docxBuffer = null;
                        result.rawDump = null;
                        result.allText = '';
                        result.plainText = '';
                        result.discoveredLinks = null;
                        result.restoredPdf = false;
                    }
                } catch (err) {
                    if (err.message === 'GLOBAL_PAGE_TIMEOUT') {
                        addLog(`🛑 Stuck ${err.operation || 'page operation'} terminated after ${err.timeoutMs || PAGE_OPERATION_TIMEOUT_MS}ms: ${url}`, 'error');
                        updateLinkStatus(url, 'failed', 'Page Timeout (Resource Leak Prevented)');
                    } else {
                        addLog(`Error scraping ${url}: ${err.message}`, 'error');
                        const controlledDownloadFailure = isControlledDownloadFailure(err);
                        if (controlledDownloadFailure) {
                            controlledDownloadFailures++;
                            addLog(`Controlled download failure recorded (${controlledDownloadFailures}): ${err.message}`, 'warn');
                        }
                        updateLinkStatus(url, 'failed', analyzeError(err), controlledDownloadFailure ? {
                            controlledDownloadFailure: true,
                            controlledDownloadFailureCount: controlledDownloadFailures,
                            pdfSaved: false,
                            pdfKind: 'none',
                            pdfReason: 'No PDF saved because the browser download was cancelled or no document buffer was captured.'
                        } : {});
                    }
                } finally {
                    linkPerformance.totalMs = Date.now() - processingStartedAt;
                    linkPerformance.retrievalMs = Math.max(
                        0,
                        linkPerformance.totalMs -
                        linkPerformance.politeWaitMs -
                        linkPerformance.headPreflightMs -
                        linkPerformance.pdfRenderMs -
                        linkPerformance.storageMs
                    );
                    try {
                        const completedItem = missionProgress.details.find(item => (
                            String(item.url || '').trim() === String(url || '').trim()
                        )) || missionProgress.details.find(item => normalizeVisitUrl(item.url) === normalizeVisitUrl(url));
                        if (completedItem) {
                            completedItem.performance = linkPerformance;
                        }
                        const completedSuccessfully = completedItem?.status === 'success' && (
                            sailorMode || completedItem.pdfSaved === true
                        );
                        if (completedSuccessfully) {
                            if (result?.trawlFallback && navigationTrace?.strongAccessFailure) {
                                hostScheduler.enableSolverRecovery(normalizedUrl, 'Trawl result passed normal source checks');
                            }
                            if (solverRecoveryProbe && usedPrimaryBrowserResult) {
                                hostScheduler.recordSolverRecoveryPrimarySuccess(normalizedUrl);
                            }
                            hostScheduler.recordSuccess(normalizedUrl, {
                                primary: readerRecoveryProbe && usedPrimaryBrowserResult
                            });
                        } else {
                            hostScheduler.recordNonSuccess(normalizedUrl);
                        }
                    } catch (bookkeepingErr) {
                        // Metrics and host pacing must never terminate other workers.
                        addLog(`Worker bookkeeping failed safely: ${bookkeepingErr.message}`, 'error');
                    }
                    if (workerPage) {
                        await workerPage.close().catch(() => { });
                    }
                    if (busyWorkers > 0) busyWorkers--; // v16.69: Guard against negative decrement
                }
            }
        };

        const swarm = [];
        for (let i = 0; i < concurrency; i++) swarm.push(swarmWorker(i + 1));

        await Promise.all(swarm);
        missionProgress.performance = {
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - new Date(missionProgress.timestamp).getTime(),
            hostScheduler: hostScheduler.getSummary()
        };
        const performanceItems = missionProgress.details
            .map(item => item.performance)
            .filter(Boolean);
        if (performanceItems.length > 0) {
            const totalFor = key => performanceItems.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
            missionProgress.performance.urlsMeasured = performanceItems.length;
            missionProgress.performance.averageTotalMs = Math.round(totalFor('totalMs') / performanceItems.length);
            missionProgress.performance.averageQueueWaitMs = Math.round(totalFor('queueWaitMs') / performanceItems.length);
            missionProgress.performance.averageHeadPreflightMs = Math.round(totalFor('headPreflightMs') / performanceItems.length);
            missionProgress.performance.averagePdfRenderMs = Math.round(totalFor('pdfRenderMs') / performanceItems.length);
            missionProgress.performance.averageStorageMs = Math.round(totalFor('storageMs') / performanceItems.length);
        }
        addMissionLog(
            userId,
            `Performance summary: ${missionProgress.performance.urlsMeasured || 0} URL(s) measured, average ${missionProgress.performance.averageTotalMs || 0}ms; host pacing penalties ${missionProgress.performance.hostScheduler.penalties}, recoveries ${missionProgress.performance.hostScheduler.recoveries}.`,
            'info'
        );
        const pendingSweep = finalizePendingLinks();
        if (pendingSweep.finalized > 0) {
            addMissionLog(userId, `Marked ${pendingSweep.finalized} unprocessed URL(s) as skipped: ${pendingSweep.reason}`, 'warn');
        }

    } finally {
        if (browser) {
            console.log(`💎 [SESSION] Closing browser swarm for ${missionId}...`);
            await browser.close().catch(() => { });
        }
        ctx.browser = null;
        ctx.sessionActive = false;

        // v16.69: Free OCR workers to reclaim ~200MB RAM
        try { await terminateAllOCR(); } catch (e) { }

        try {
            const artifactAudit = await reconcileSuccessfulPdfArtifacts();
            if (artifactAudit.demoted > 0) {
                addMissionLog(
                    userId,
                    `Artifact audit marked ${artifactAudit.demoted} URL(s) as failed because their declared PDF could not be verified.`,
                    'error'
                );
            } else if (!sailorMode && artifactAudit.verified > 0) {
                addMissionLog(userId, `Artifact audit verified ${artifactAudit.verified} PDF(s) for this mission.`, 'success');
            }
        } catch (auditErr) {
            console.error(`[SESSION] Artifact audit failed: ${auditErr.message}`);
            addMissionLog(userId, `Artifact audit could not complete: ${auditErr.message}`, 'warn');
        }

        markResultsChanged(userId);
        addMissionLog(userId, 'Mission concluded.', 'concluded');

        await saveMissionManifest(userId, missionId, missionProgress).catch(err => {
            console.error(`[SESSION] Failed to save manifest: ${err.message}`);
        });
        emitProgress('complete');
    }
}

module.exports = { runScraperSession, getPreVisitSkipReason, withWorkerPageTimeout, retryClientSideRouteExtraction, enqueueUniqueCrawlItems, prepareStartUrls, getTemplateRecoveryCacheKey, classifyNavigationResponse, getNavigationResponseInfo };
