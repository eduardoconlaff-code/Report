const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const pdf = require('pdf-parse');
const { createWorker, createScheduler } = require('tesseract.js');
const runtimeProfile = require('./runtime-profile');
const { classifyContentValidity, createUnusableContentError, detectDynamicApplicationShell } = require('./content-validation');
const { looksLikeOfficeBinaryText } = require('./extraction-policy');
const {
    classifyDocumentBuffer,
    inspectRemoteDocument,
    isPdfBuffer,
    isDocxBuffer,
    isLegacyDocBuffer
} = require('./document-type');

chromium.use(stealth);

const loggedJsdomErrors = new Set();

// Third-party pages frequently contain invalid CSS that jsdom reports to the
// process console even though it does not affect DOM text extraction. Silence
// that single noisy warning while retaining other jsdom diagnostics once.
function createExtractionDom(markup, options = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', err => {
        const message = String(err?.message || err || 'Unknown jsdom error');
        if (/could not parse css stylesheet/i.test(message)) return;
        if (loggedJsdomErrors.has(message)) return;
        loggedJsdomErrors.add(message);
        console.warn(`[JSDOM] ${message}`);
    });
    return new JSDOM(markup, { ...options, virtualConsole });
}

// 🚀 Performance Cache: Store heavy OCR assets in memory to avoid repeated disk reads
const OCR_ASSETS = {
    pdfJs: null,
    pdfWorker: null
};
const OCR_MAX_PAGES = Math.max(
    0,
    parseInt(process.env.SCRAPERITO_OCR_MAX_PAGES || '0', 10) || 0
);
const OCR_PAGE_CONCURRENCY = Math.max(
    1,
    Math.min(parseInt(process.env.SCRAPERITO_OCR_PAGE_CONCURRENCY || '2', 10) || 2, 4)
);

// 🌐 EU Sovereign Language Maps (Static Constants)
const EU_LANG_TLD_MAP = {
    'at': 'deu', 'be': 'fra+nld', 'bg': 'bul', 'hr': 'hrv', 'cy': 'ell',
    'cz': 'ces', 'dk': 'dan', 'ee': 'est', 'fi': 'fin+swe', 'fr': 'fra',
    'de': 'deu', 'el': 'ell', 'gr': 'ell', 'hu': 'hun', 'ie': 'gle', 'it': 'ita',
    'lv': 'lav', 'lt': 'lit', 'mt': 'mlt', 'nl': 'nld', 'pl': 'pol',
    'pt': 'por', 'ro': 'ron', 'sk': 'slk', 'si': 'slv', 'se': 'swe',
    'es': 'spa', 'lu': 'fra+deu', 'sl': 'slv'
};

const EU_PATH_PATTERNS = {
    'pol': [/\/pl(?:\/|-|_)/i, /_pl\.pdf/i],
    'fra': [/\/fr(?:\/|-|_)/i, /_fr\.pdf/i],
    'deu': [/\/de(?:\/|-|_)/i, /_de\.pdf/i],
    'ita': [/\/it(?:\/|-|_)/i, /_it\.pdf/i],
    'spa': [/\/es(?:\/|-|_)/i, /_es\.pdf/i],
    'nld': [/\/nl(?:\/|-|_)/i, /_nl\.pdf/i],
    'ell': [/\/el(?:\/|-|_)/i, /\/gr(?:\/|-|_)/i],
    'por': [/\/pt(?:\/|-|_)/i],
};

const EU_HEADER_MAPPING = {
    'pl': 'pol', 'fr': 'fra', 'de': 'deu', 'it': 'ita', 'es': 'spa',
    'nl': 'nld', 'el': 'ell', 'pt': 'por', 'bg': 'bul', 'hr': 'hrv',
    'cs': 'ces', 'da': 'dan', 'et': 'est', 'fi': 'fin', 'hu': 'hun',
    'ga': 'gle', 'lv': 'lav', 'lt': 'lit', 'mt': 'mlt', 'ron': 'ron',
    'sk': 'slk', 'sl': 'slv', 'slv': 'slv', 'sv': 'swe'
};

// 🕵️ Pre-compiled Moji-bake Regex
const MOJIBAKE_REGEX = /[^\w\s\d,.\-;:!?"'()\[\]{}\/\\áéíóúüñ¿¡àèìòùäëïöüÿãõâêîôûçşğæœøąćęłńóśźżα-ωΑ-Ω\u0400-\u04FF]/g;

// Global OCR Cache (v16.44 — Parallel Gear)
let tesseractSchedulers = new Map();
const ocrSchedulerInitializers = new Map();
let activeOcrDocuments = 0;
const ocrDocumentWaiters = [];

async function withOcrDocumentSlot(addMissionLog, task) {
    const limit = runtimeProfile.ocrDocumentConcurrency;
    if (activeOcrDocuments >= limit && addMissionLog) {
        addMissionLog(`OCR queue: waiting for one of ${limit} heavy document slot(s)...`, 'info');
    }

    if (activeOcrDocuments >= limit) {
        await new Promise(resolve => ocrDocumentWaiters.push(resolve));
    }

    activeOcrDocuments++;
    try {
        return await task();
    } finally {
        activeOcrDocuments = Math.max(0, activeOcrDocuments - 1);
        const next = ocrDocumentWaiters.shift();
        if (next) next();
    }
}

// v16.69: Cleanup function to prevent OCR memory leaks
async function terminateAllOCR() {
    for (const [key, scheduler] of tesseractSchedulers) {
        try { await scheduler.terminate(); } catch (e) { }
    }
    tesseractSchedulers.clear();
}

// v16.74 (M1): Shared HTML sanitizer — previously duplicated 3× in different scopes
function hyperNuclearScrub(h) {
    if (!h || typeof h !== 'string') return h;
    return h
        .replace(/border-width/gi, 'x-bw')
        .replace(/inherit/gi, 'x-inh')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/\sstyle\s*=\s*((['"])(?:(?!\2)[\s\S])*?\2)/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<link[^>]*rel=["']stylesheet["'][^>]*>/gi, '');
}

// 🍪 Universal Cookie Terminator (v15 — Full EU Coverage)
// "cookie" is a universal loanword across all EU languages, so we detect it
// combined with consent/action keywords rather than enumerating full phrases.
const COOKIE_WORD = /(?:\bcookies?\b|kola\u010di\u0107(?:i|ima|e)?|kolacici?)/iu;

// Consent/action vocabulary across EU official languages
const CONSENT_ACTIONS = /accept|reject|decline|necessary|essential|preferences|settings|consent|policy|manage|allow|refuse|configure|functioning|statistical|analytics|tracking|aceptar|rechazar|necesari|preferencia|configuraci|consentimiento|pol[ií]tica|t[eé]cnica|accepter|refuser|n[eé]cessaire|param[eè]tr|consentement|fonctionnement|akzeptieren|ablehnen|notwendig|einstellung|einwilligung|zustimmung|accettare|rifiuta|necessari|impostazion|consenso|funzionamento|accepteren|weigeren|noodzakelijk|instelling|toestemming|zaakceptuj|odrzuć|niezbędn|ustawieni|zgoda|aceitar|rejeitar|necess[aá]ri|definiç|consentimento|nödvändig|inställning|nødvendig|indstilling|vajalik|küpsis|evästeitä|välttämätön|slapuk|piškot|süti|бисквит|prihva\u0107am|ne\s+prihva\u0107am|odbijam|nu\u017eni|funkcionalni|statisti\u010dki|postavke/i;

// Specific phrases that don't always contain "cookie" (e.g. standalone consent banners)
const COOKIE_PHRASES = /proper functioning of the website|en savoir plus sur les cookies|cookies op deze website|confirm choices|allow only necessary|obavijest o kola\u010di\u0107ima/i;

// These are vendor-specific consent roots. Do not add generic CMS component
// classes here: for example, Adobe AEM uses `.cmp-container` for page content.
const GLOBAL_BANNER_CLEANUP_SELECTORS = [
    '#onetrust-consent-sdk', '.ot-sdk-container', '.cc-window', '[id*="cookie-banner" i]'
];

/**
 * 🍪 Universal Markdown Sanitizer (v15)
 * Applies Layer 2 Markdown scrubbing to ensure cookie banners are removed
 * regardless of the extraction engine used (Playwright, Jina, Trawl, etc.)
 */
// Legal content safeguard: paragraphs containing these terms are substantive
// legal analysis about cookie regulation, NOT banner text — never filter them.
const LEGAL_SAFEGUARD = /\barticle\s+\d|directive|regulation\s+\(|eprivacy|e-privacy|\bGDPR\b|2002\/58|2016\/679|richtlinie|directiva|direttiva|richtlijn|dyrektywa/i;

function assertNoOfficeBinaryText(res = {}) {
    if (looksLikeOfficeBinaryText(res.allText) || looksLikeOfficeBinaryText(res.plainText)) {
        throw new Error('OFFICE_BINARY_AS_TEXT');
    }
}

const finalize = (res) => {
    if (!res || res.error) return res;
    assertNoOfficeBinaryText(res);
    const scrub = (text) => {
        if (!text) return text;
        return text.split('\n\n')
            .filter(p => {
                const cleanP = p.trim().toLowerCase();
                const isCookieParagraph = (COOKIE_WORD.test(cleanP) && CONSENT_ACTIONS.test(cleanP)) || COOKIE_PHRASES.test(cleanP);
                if (isCookieParagraph) {
                    // Safeguard: never filter paragraphs that reference legal instruments
                    if (LEGAL_SAFEGUARD.test(cleanP)) return true;
                    // Cookie banners are usually short.
                    if (cleanP.length < 400) return false;
                    // If it mentions cookie multiple times, it might be a longer banner
                    const cookieMentions = (cleanP.match(/(?:cookies?|kola\u010di\u0107(?:i|ima|e)?|kolacici?)/giu) || []).length;
                    if (cookieMentions > 2 && cleanP.length < 800) return false;
                }
                return true;
            })
            .join('\n\n');
    };
    if (res.allText) res.allText = scrub(res.allText);
    if (res.plainText) res.plainText = scrub(res.plainText);
    return res;
};

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ALLOW_HISTORICAL_ARCHIVE_FALLBACK = String(process.env.SCRAPERITO_ALLOW_HISTORICAL_ARCHIVE_FALLBACK || 'false').toLowerCase() === 'true';

// A number of WAFs return HTTP 200 with a branded error document. Treat those
// responses as hard blocks before extraction so they can never become artifacts.
function isBlockedResponseContent(content = '') {
    const value = String(content || '').toLowerCase();
    if (!value) return false;

    const titleMatch = value.match(/<title[^>]*>\s*([^<]+?)\s*<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const hardTitles = [
        'unauthorized request blocked', 'access denied', 'just a moment', 'un momento',
        'security verification', 'bot verification', 'security check'
    ];
    if (hardTitles.some(signal => title.includes(signal))) return true;

    const hardMarkers = [
        'unauthorized request blocked', 'performing security verification',
        'challenge-error-text', 'cf-chl-', 'challenges.cloudflare.com'
    ];
    if (hardMarkers.some(signal => value.includes(signal))) return true;

    const challengeMarkers = [
        'just a moment', 'checking your browser', 'verify you are not a bot',
        'security verification', 'access denied'
    ];
    return challengeMarkers.filter(signal => value.includes(signal)).length >= 2;
}

function getTrawlSolverUrl() {
    return String(process.env.TRAWL_URL || 'http://127.0.0.1:8193/v1').trim();
}

function safePageOn(page, eventName, handler, addMissionLog = null, label = eventName) {
    page.on(eventName, (...args) => {
        Promise.resolve(handler(...args)).catch(err => {
            const message = `${label} listener error: ${err.message || err}`;
            if (addMissionLog) addMissionLog(message, 'warn');
            else console.warn(message);
        });
    });
}

const DYNAMIC_APP_CONTENT_WAIT_MS = Math.max(
    1000,
    Math.min(parseInt(process.env.SCRAPERITO_DYNAMIC_APP_WAIT_MS || '8000', 10) || 8000, 20000)
);

// Consent labels must match an action, not an ordinary source title such as
// "EEA Agreement". The same pattern is passed into page.evaluate below.
const EXPLICIT_CONSENT_ACTION_PATTERN = /(?:^|[^\p{L}])(?:accept|agree|allow|reject|decline|refuse|necessary|essentials?|akzeptieren|ablehnen|accepter|refuser|accetta|rifiuta|aceitar|rejeitar|aceptar|rechazar|akkoord|weigeren|prihvaćam|odbijam)(?=$|[^\p{L}])/iu;

function isExplicitConsentAction(value = '') {
    return EXPLICIT_CONSENT_ACTION_PATTERN.test(String(value || '').replace(/\s+/g, ' ').trim());
}

function didAutomatedCleanupChangeSource(beforeUrl = '', afterUrl = '') {
    const withoutFragment = (value = '') => String(value || '').split('#')[0];
    return Boolean(beforeUrl && afterUrl && withoutFragment(beforeUrl) !== withoutFragment(afterUrl));
}

// The fast path is safe only when the visible document is already complete.
// This recognises real content disclosures while excluding menus, form widgets,
// consent UI, and links that would navigate away from the target document.
const CONTENT_EXPANDER_SELECTOR = [
    '[aria-expanded="false"]',
    'details:not([open]) > summary',
    '[data-toggle="collapse"]',
    '[data-bs-toggle="collapse"]',
    '[data-state="closed"]',
    '[aria-controls]',
    '.accordion-toggle',
    '.btn-collapse',
    '.show-more',
    '.js-expand',
    '.collapsible-header',
    '.ui-accordion-header',
    'button',
    '[role="button"]'
].join(', ');

function detectContentExpanders(options = {}) {
    const root = options.root || document;
    const requireVisible = options.requireVisible !== false;
    const selector = options.selector || CONTENT_EXPANDER_SELECTOR;
    const contentSelector = 'main, article, [role="main"], #content, [id*="content" i], .content, .body, .article-content, .main-content, .ecl-container';
    const noiseSelector = 'nav, header, footer, aside, [role="navigation"], .menu, .submenu, .sidebar, .navigation, .breadcrumb, .cookie, .consent, [class*="cookie" i], [class*="consent" i], form';
    const expansionLabel = /expand|collapse|show\s+(?:more|all)|read\s+more|see\s+more|more\s+(?:details|information)|details|mehr|d[ée]tails|voir\s+plus|espandi|scopri|ver\s+m[aá]s|detalles|meer\s+informatie|tonen|plus\s+d[' ]infos|weiterlesen|leggi\s+tutto/i;
    const candidates = [];
    const widgetSignature = /accessib|assistive|virtual[-_ ]?keyboard|on[-_ ]?screen[-_ ]?keyboard|font[-_ ]?size|contrast|toolbar|widget/i;
    // These controls can use the same ARIA attributes as accordions, but their
    // panels are UI chrome rather than source content. Keep this intentionally
    // small and action-oriented so document headings are never filtered by name.
    const nonSourceAction = /(?:^|\b)(?:share|partage[rz]|comparti[lr]|teilen|senden|favori(?:te|s)?|bookmark|print|imprim(?:er|ir)|download)(?:\b|$)/i;

    const resolveControlledTarget = (candidate) => {
        const rawTarget = candidate.getAttribute('aria-controls') ||
            candidate.getAttribute('data-target') ||
            candidate.getAttribute('data-bs-target') ||
            ((candidate.getAttribute('href') || '').startsWith('#') ? candidate.getAttribute('href') : '');
        if (!rawTarget) return null;
        const targetId = rawTarget.trim().replace(/^#/, '');
        if (!targetId || /\s/.test(targetId)) return null;
        return root.getElementById?.(targetId) || null;
    };

    for (const candidate of Array.from(root.querySelectorAll(selector))) {
        if (candidate.dataset?.scraperitoClicked === '1' || candidate.disabled) continue;

        const tag = candidate.tagName.toLowerCase();
        const role = candidate.getAttribute('role');
        if (!['button', 'a', 'summary'].includes(tag) && role !== 'button') continue;
        if (candidate.closest(noiseSelector) || !candidate.closest(contentSelector)) continue;
        const candidateSignature = `${candidate.id || ''} ${candidate.className || ''} ${candidate.getAttribute('aria-label') || ''}`;
        if (widgetSignature.test(candidateSignature)) continue;

        if (requireVisible) {
            const visible = candidate.offsetWidth > 0 || candidate.offsetHeight > 0 || candidate.getClientRects().length > 0;
            if (!visible) continue;
        }

        if (tag === 'a') {
            const href = candidate.getAttribute('href') || '';
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) continue;
        }

        const label = (candidate.getAttribute('aria-label') || candidate.getAttribute('title') || candidate.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
        const controlSignature = `${label} ${candidate.id || ''} ${candidate.className || ''}`;
        if (nonSourceAction.test(controlSignature)) continue;
        const nativeSummary = tag === 'summary' && Boolean(candidate.closest('details'));
        const controlledTarget = resolveControlledTarget(candidate);
        const targetSignature = controlledTarget
            ? `${controlledTarget.id || ''} ${controlledTarget.className || ''} ${controlledTarget.getAttribute('role') || ''}`
            : '';
        const targetText = (controlledTarget?.textContent || '').replace(/\s+/g, ' ').trim();
        const descriptiveControlLabel = (label.match(/[\p{L}\p{N}]/gu) || []).length >= 8;
        const targetIsSafe = Boolean(controlledTarget) &&
            !controlledTarget.closest(noiseSelector) &&
            Boolean(controlledTarget.closest(contentSelector)) &&
            !widgetSignature.test(targetSignature) &&
            (
                (targetText.match(/[\p{L}\p{N}]/gu) || []).length >= 20 ||
                (candidate.getAttribute('aria-expanded') === 'false' && descriptiveControlLabel)
            );
        const structural = nativeSummary || targetIsSafe;
        const labelOnly = !controlledTarget && /\p{L}/u.test(label) &&
            label.length > 0 && label.length <= 100 && expansionLabel.test(label);

        if (structural || labelOnly) {
            candidates.push(label || tag);
        }
    }

    return { count: candidates.length, labels: candidates.slice(0, 5) };
}

// A direct PDF link is not proof that its parent HTML page is a document viewer.
// This deliberately accepts only a download-only shell, preserving short official
// pages that explain a topic and happen to link to one related document.
function findDirectDocumentFallbackUrl(root = document) {
    const doc = root && typeof root.querySelectorAll === 'function' ? root : document;
    const pdfLinks = Array.from(doc.querySelectorAll('a[href]'))
        .filter(anchor => {
            const href = (anchor.href || '').toLowerCase();
            const label = (anchor.textContent || anchor.getAttribute('aria-label') || '').toLowerCase();
            return href.startsWith('http') && (
                href.endsWith('.pdf') ||
                href.includes('format=pdf') ||
                /(?:download|open|view)\s+(?:the\s+)?pdf/.test(label)
            );
        });
    if (pdfLinks.length === 0 || !doc.body) return null;

    const sourceAreas = Array.from(doc.querySelectorAll(
        'main, article, [role="main"], #content, .content, .main-content, .article-content'
    ));
    const hasSubstantiveSource = sourceAreas.some(area => {
        const text = (area.textContent || '').replace(/\s+/g, ' ').trim();
        const hasStructure = Boolean(area.querySelector('h1, h2, p, li, table, dl'));
        return text.length >= 320 && hasStructure;
    });
    if (hasSubstantiveSource) return null;

    const clone = doc.body.cloneNode(true);
    clone.querySelectorAll('a, nav, header, footer, aside, script, style, noscript').forEach(node => node.remove());
    const nonLinkText = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    const actionText = pdfLinks.map(anchor => `${anchor.textContent || ''} ${anchor.getAttribute('aria-label') || ''}`).join(' ');
    const shellSignature = `${doc.title || ''} ${doc.body.id || ''} ${doc.body.className || ''} ${actionText}`;
    const hasDownloadIntent = /(?:pdf|document|download|open|view|attachment|viewer)/i.test(shellSignature);

    if (nonLinkText.length > 260 || !hasDownloadIntent) return null;
    return pdfLinks.length === 1
        ? pdfLinks[0].href
        : pdfLinks.sort((left, right) => (right.textContent || '').length - (left.textContent || '').length)[0].href;
}

function shouldAwaitLateDisclosure({ totalTextLength = 0, visibleTextLength = 0, hasPotentialControls = false } = {}) {
    // A large hidden/visible text gap is characteristic of client-rendered FAQ
    // trees. Ordinary pages do not pay an additional wait; this is a bounded
    // readiness check only for documents that already expose disclosure UI.
    return Boolean(hasPotentialControls) &&
        Number(totalTextLength) >= 4000 &&
        Number(totalTextLength) > Math.max(1200, Number(visibleTextLength) * 4);
}

async function waitForDynamicApplicationContent(page, addMissionLog = null) {
    const snapshot = async () => page.evaluate(() => ({
        html: document.documentElement?.outerHTML || '',
        text: document.body?.innerText || document.body?.textContent || ''
    })).catch(() => ({ html: '', text: '' }));

    const initial = await snapshot();
    if (!detectDynamicApplicationShell(`${initial.html}\n${initial.text}`).isShell) {
        return { waited: false, ready: false };
    }

    if (addMissionLog) addMissionLog(`Dynamic application shell detected. Waiting up to ${Math.round(DYNAMIC_APP_CONTENT_WAIT_MS / 1000)}s for source content...`, 'info');

    try {
        await page.waitForFunction(() => {
            const text = (document.body?.innerText || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
            const stillBootstrapping = /you need to enable javascript to run this app|please enable javascript to continue|javascript is required to run this application|loading application|loading document|henter dokument/i.test(text);
            const semanticChars = (text.match(/[\p{L}\p{N}]/gu) || []).length;
            return !stillBootstrapping && semanticChars >= 600;
        }, { timeout: DYNAMIC_APP_CONTENT_WAIT_MS });
    } catch (_) {
        const finalSnapshot = await snapshot();
        if (detectDynamicApplicationShell(`${finalSnapshot.html}\n${finalSnapshot.text}`).isShell) {
            const issue = {
                category: 'dynamic_application_shell',
                reason: `Application shell did not expose substantive source content within ${Math.round(DYNAMIC_APP_CONTENT_WAIT_MS / 1000)} seconds.`,
                retryable: true
            };
            throw createUnusableContentError(issue);
        }
        return { waited: true, ready: false };
    }

    if (addMissionLog) addMissionLog('Dynamic application source content became available.', 'success');
    return { waited: true, ready: true };
}

async function withTempFile(prefix, ext, fn) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const safePrefix = String(prefix || 'temp').replace(/[^a-z0-9_-]/gi, '_');
    const safeExt = String(ext || 'tmp').replace(/[^a-z0-9]/gi, '');
    const tempPath = path.join(DATA_DIR, `${safePrefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.${safeExt}`);
    try {
        return await fn(tempPath);
    } finally {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch (_) { }
    }
}

let activeLegacyWordConversions = 0;
const legacyWordWaiters = [];

async function withLegacyWordSlot(task) {
    if (activeLegacyWordConversions >= runtimeProfile.legacyWordConcurrency) {
        await new Promise(resolve => legacyWordWaiters.push(resolve));
    }
    activeLegacyWordConversions++;
    try {
        return await task();
    } finally {
        activeLegacyWordConversions = Math.max(0, activeLegacyWordConversions - 1);
        const next = legacyWordWaiters.shift();
        if (next) next();
    }
}

function runProcess(command, args = [], options = {}) {
    const timeoutMs = Math.max(100, options.timeoutMs || runtimeProfile.legacyWordTimeoutMs);
    const maxOutputBytes = Math.max(1024, options.maxOutputBytes || runtimeProfile.legacyWordMaxOutputBytes);
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        const settle = (handler, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            handler(value);
        };
        const failBounded = (message) => {
            try { child.kill(); } catch (_) { }
            settle(reject, new Error(message));
        };
        const capture = (target, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > maxOutputBytes) {
                failBounded(`${path.basename(command)} exceeded the ${maxOutputBytes}-byte output limit`);
                return;
            }
            target.push(chunk);
        };
        const timer = setTimeout(() => {
            failBounded(`${path.basename(command)} timed out after ${timeoutMs}ms`);
        }, timeoutMs);
        timer.unref?.();

        child.stdout.on('data', chunk => capture(stdout, Buffer.from(chunk)));
        child.stderr.on('data', chunk => capture(stderr, Buffer.from(chunk)));
        child.on('error', error => settle(reject, error));
        child.on('close', code => {
            if (settled) return;
            if (code === 0) return settle(resolve, Buffer.concat(stdout).toString('utf8'));
            settle(reject, new Error(`${path.basename(command)} exited with code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        });
    });
}

async function extractLegacyDocText(buffer) {
    const configuredAntiword = String(process.env.SCRAPERITO_ANTIWORD_PATH || '').trim();
    const commands = [...new Set([configuredAntiword, 'antiword'].filter(Boolean))];
    let converterFound = false;
    let lastError = null;

    for (const command of commands) {
        try {
            const text = await withLegacyWordSlot(() => withTempFile('legacy_word', 'doc', async tempPath => {
                fs.writeFileSync(tempPath, buffer);
                return runProcess(command, ['-w', '0', tempPath], {
                    timeoutMs: runtimeProfile.legacyWordTimeoutMs,
                    maxOutputBytes: runtimeProfile.legacyWordMaxOutputBytes
                });
            }));
            converterFound = true;
            const meaningfulChars = (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
            if (meaningfulChars >= 80) return String(text).trim();
            lastError = new Error('converter returned too little readable text');
        } catch (err) {
            if (err?.code !== 'ENOENT') converterFound = true;
            lastError = err;
        }
    }

    if (!converterFound) {
        throw new Error('LEGACY_WORD_CONVERTER_UNAVAILABLE: install Antiword or set SCRAPERITO_ANTIWORD_PATH to convert legacy .doc files locally.');
    }
    throw new Error(`LEGACY_WORD_CONVERSION_FAILED: ${lastError?.message || 'converter returned no readable text'}`);
}

// 🔗 Universal Link Extraction Helpers
function extractLinksFromDom(domOrHtml, baseUrl) {
    // Uses shared hyperNuclearScrub (v16.74)

    let dom;
    try {
        if (typeof domOrHtml === 'string') {
            try {
                dom = createExtractionDom(domOrHtml);
            } catch (e) {
                dom = createExtractionDom(hyperNuclearScrub(domOrHtml));
            }
        } else {
            dom = domOrHtml;
        }

        const domLinks = Array.from(dom.window.document.querySelectorAll('a[href]'))
            .map(a => {
                try {
                    const href = new URL(a.getAttribute('href'), baseUrl).href.split('#')[0];
                    return { href, text: a.textContent.trim() };
                } catch (e) { return null; }
            })
            .filter(l => l && l.href.startsWith('http'));

        // 🛡️ v16.99: Double-check for Markdown links if DOM extraction failed (crucial for bypass engines like Jina)
        if (typeof domOrHtml === 'string' && domLinks.length < 5) {
            const mdLinks = extractLinksFromMarkdown(domOrHtml, baseUrl);
            if (mdLinks.length > 0) {
                // Merge and deduplicate
                const seen = new Set(domLinks.map(l => l.href.toLowerCase()));
                for (const ml of mdLinks) {
                    if (!seen.has(ml.href.toLowerCase())) {
                        domLinks.push(ml);
                        seen.add(ml.href.toLowerCase());
                    }
                }
            }
        }
        return domLinks;
    } catch (e) {
        // Final fallback: if JSDOM is totally dead, use regex for links
        if (typeof domOrHtml === 'string') {
            return extractLinksFromMarkdown(domOrHtml, baseUrl);
        }
        return [];
    }
}

function extractLinksFromMarkdown(markdown, baseUrl) {
    const links = [];
    // Matches [text](url)
    const regex = /\[([^\]]+)\]\(([^)\s]+)\)/g; // 🛡️ v16.99: Catch ALL (url) formats including relative ones
    let match;
    while ((match = regex.exec(markdown)) !== null) {
        try {
            // Clean URL from any surrounding quotes/markdown artifacts
            const rawUrl = match[2].trim().replace(/^'|^"|'$|"$/g, '');
            const href = new URL(rawUrl, baseUrl).href.split('#')[0];
            links.push({ href, text: match[1].trim() });
        } catch (e) { }
    }
    return links;
}

// 🧠 Intelligent Title Resolution
function intelligentlyResolveTitle(url, rawTitle) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');

        let cleanTitle = (rawTitle || '').trim();
        // Strip common " - domain.com" suffixes
        const siteSuffix = new RegExp(`[-|:]?\\s*w{0,3}\\.?${hostname.replace(/\\./g, '\\\\.')}\\s*$`, 'i');
        cleanTitle = cleanTitle.replace(siteSuffix, '').trim();

        if (!cleanTitle || cleanTitle.toLowerCase() === hostname || cleanTitle.toLowerCase() === `www.${hostname}` || cleanTitle === 'Untitled') {
            const ignoreList = ['en', 'fr', 'de', 'es', 'pl', 'it', 'nl', 'pt', 'ru', 'et', 'lv', 'lt'];
            const pathSegments = urlObj.pathname.split('/').filter(s => s.length > 0 && !ignoreList.includes(s.toLowerCase()));
            if (pathSegments.length > 0) {
                let lastSegment = pathSegments[pathSegments.length - 1].split('.')[0].replace(/[-_]/g, ' ');
                if (lastSegment.length > 0) {
                    cleanTitle = lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
                }
            }
        }
        return cleanTitle || rawTitle || urlObj.hostname;
    } catch (e) { return rawTitle || 'Document'; }
}

// ─── Google Web Cache Fallback (100% Free WAF Evasion) ─────────────────────
// Used as the FIRST line of defense when Playwright hits a Data Center IP block.
// Instead of fighting the WAF, we ask Google for its cached copy of the page.
function isGoogleCacheMissHtml(html = '') {
    const source = String(html || '');
    return /<title>\s*cache:/i.test(source) ||
        source.includes('did not match any documents') ||
        source.includes('geen overeenkomstige');
}

async function scrapeViaGoogleCache(url, addMissionLog = null) {
    if (addMissionLog) addMissionLog(`🔍 Checking Google Web Cache to bypass WAF for ${url}`, 'info');

    // Google's webcache URL format
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;

    const response = await fetch(cacheUrl, {
        headers: {
            // Must spoof a real browser so Google doesn't block us
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(15000)
    });

    if (response.status === 404) throw new Error("URL not found in Google Cache");
    if (!response.ok) throw new Error(`Google Cache returned HTTP ${response.status}`);

    let html = await response.text();
    if (!html || html.trim().length < 500) throw new Error('Google Cache returned empty HTML');

    // Google localizes its cache-miss page title and body. A cache-prefixed title is
    // sufficient evidence that this is Google Search, not the requested document.
    const isCacheMiss = isGoogleCacheMissHtml(html);
    if (isCacheMiss) {
        throw new Error('URL not found in Google Cache (404 disguised as 200)');
    }
    const cacheIssue = classifyContentValidity({ metadata: { url }, allText: html }, { url });
    if (cacheIssue) throw createUnusableContentError(cacheIssue);

    // 🧹 Clean Google's injected header box so Readability doesn't get confused
    html = html.replace(/<div id="bWb[^>]*>[\s\S]*?<\/div>\s*<div style="position:relative;">/, '<div style="position:relative;">');

    const result = await smartExtract(html, url, null, { addMissionLog });
    return { ...result, googleCacheFallback: true };
}

// ─── Trawl Fallback (Local WAF Recovery) ───────────────────────────────
async function scrapeViaTrawl(url, addMissionLog = null) {
    if (addMissionLog) addMissionLog(`🛡️ Deploying Trawl recovery for ${url}...`, 'info');
    const solverUrl = getTrawlSolverUrl();

    const sessionResponse = await fetch(solverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cmd: 'request.get',
            url: url,
            maxTimeout: 60000
        }),
        signal: AbortSignal.timeout(70000)
    });

    if (!sessionResponse.ok) throw new Error(`Trawl returned HTTP ${sessionResponse.status}`);
    const result = await sessionResponse.json();

    if (result.status === 'error') throw new Error(`Trawl solver error: ${result.message}`);

    const html = result.solution.response;
    if (!html || html.trim().length < 500) throw new Error('Trawl returned empty HTML');
    if (isBlockedResponseContent(html)) throw new Error('BOT_BLOCKED');
    const trawlIssue = classifyContentValidity({ metadata: { url }, allText: html }, { url });
    if (trawlIssue) throw createUnusableContentError(trawlIssue);

    const extractionResult = await smartExtract(html, url, null, { addMissionLog });
    return { ...extractionResult, trawlFallback: true };
}

// ─── Jina.ai Fallback ────────────────────────────────────────────────────────
// Used when the primary scraper hits a bot wall or gets raw RSC/JSON instead
// of rendered HTML. Jina renders the page server-side and returns clean Markdown.
function extractJinaReaderSource(markdown = '') {
    const raw = String(markdown || '');
    const contentMarker = /^\s*Markdown Content:\s*$/im.exec(raw);
    if (!contentMarker) return raw.trim();

    // Jina's Reader envelope is transport metadata, not source text. Only
    // split it when the preceding section identifies the original URL, so an
    // official document that happens to use this heading remains untouched.
    const header = raw.slice(0, contentMarker.index);
    if (!/^\s*URL Source:\s*\S+/im.test(header)) return raw.trim();

    return raw.slice(contentMarker.index + contentMarker[0].length).trim();
}

async function scrapeViaJina(url, addMissionLog = null) {
    if (addMissionLog) addMissionLog(`🔄 Jina fallback activated for ${url}`, 'info');
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/markdown', 'X-Return-Format': 'markdown' },
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Jina returned HTTP ${response.status}`);
    const markdown = await response.text();

    if (!markdown || markdown.trim().length < 50) throw new Error('Jina returned empty content');

    // 🛡️ Jina Bot-Wall Detection: Sometimes Jina also gets served a challenge page
    const challenges = ['just a moment', 'ray id', 'checking your browser', 'verify you are not a bot', 'security verification', 'vérification de sécurité'];
    if (isBlockedResponseContent(markdown) || challenges.some(c => markdown.toLowerCase().includes(c))) {
        throw new Error('BOT_BLOCKED'); // Pass this up so the main worker can try Archive.org
    }
    const sourceMarkdown = extractJinaReaderSource(markdown);
    if (!sourceMarkdown) {
        throw new Error('Jina returned a metadata envelope without source content');
    }

    const jinaIssue = classifyContentValidity({ metadata: { url }, allText: sourceMarkdown, plainText: sourceMarkdown }, { url });
    if (jinaIssue) throw createUnusableContentError(jinaIssue);

    // Extract title from first # heading if present
    const titleMatch = sourceMarkdown.match(/^#\s+(.+)$/m);
    const title = intelligentlyResolveTitle(url, titleMatch ? titleMatch[1].trim() : '');

    const discoveredLinks = extractLinksFromMarkdown(sourceMarkdown, url);

    const metadata = { title, description: '', author: '', url };
    const allText = `# ${title}\nURL: ${url}\n\n${sourceMarkdown}`;
    return finalize({ metadata, allText, plainText: sourceMarkdown, jinaFallback: true, articleHtml: null, discoveredLinks }); // Jina is markdown-only
}

async function extractDirectPdfBuffer(buffer, originalUrl, addMissionLog = null) {
    if (!isPdfBuffer(buffer)) {
        throw new Error('Direct fetch declared a PDF but returned non-PDF content.');
    }

    if (addMissionLog) addMissionLog('Archive fallback returned a PDF. Preserving original bytes and parsing document text...', 'info');
    const data = await pdf(buffer);
    const text = String(data.text || '');
    const rawTitle = data.info?.Title || originalUrl.split('/').pop() || 'Document';
    const title = intelligentlyResolveTitle(originalUrl, rawTitle);

    return finalize({
        metadata: { title, url: originalUrl },
        allText: text,
        plainText: text,
        pdfBuffer: buffer,
        archiveFallback: true
    });
}

// Direct HTTP fetch + Readability extraction (no browser, no Jina).
// Archive snapshots can also be raw PDFs, so inspect the response before HTML parsing.
async function scrapeViaDirectFetch(fetchUrl, originalUrl, addMissionLog = null) {
    if (addMissionLog) addMissionLog(`📦 Fetching directly: ${fetchUrl}`, 'info');
    const response = await fetch(fetchUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Direct fetch returned HTTP ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());

    if (contentType.includes('application/pdf') || isPdfBuffer(buffer)) {
        return extractDirectPdfBuffer(buffer, originalUrl, addMissionLog);
    }

    const html = buffer.toString('utf8');
    if (!html || html.trim().length < 200) throw new Error('Direct fetch returned empty content');

    // Archive.org fix: Resolve links against the snapshot URL so depth navigation works
    // but pass originalUrl to smartExtract for legal threshold detection.
    const extractionResult = await smartExtract(html, originalUrl, fetchUrl, { addMissionLog });
    return { ...extractionResult, archiveFallback: true };
}

// 🏛️ Archive.org Fallback (The Final Safety Net)
async function scrapeViaArchive(url, addMissionLog = null) {
    if (!ALLOW_HISTORICAL_ARCHIVE_FALLBACK) {
        if (addMissionLog) addMissionLog('Archive.org skipped: historical captures are disabled for current official-content harvesting.', 'info');
        throw new Error('Historical Archive fallback is disabled. It cannot verify the current official document.');
    }
    if (addMissionLog) addMissionLog(`🔍 Checking Archive.org (Wayback Machine) for ${url}`, 'info');

    try {
        let rawUrl = null;

        // Prefer the simple Availability API when it responds reliably.
        const availabilityUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        try {
            const availRes = await fetch(availabilityUrl, { signal: AbortSignal.timeout(10000) });
            if (availRes.ok) {
                const data = await availRes.json();
                const snapshot = data?.archived_snapshots?.closest;
                if (snapshot?.available && snapshot?.url) {
                    rawUrl = snapshot.url.replace(/\/http/, 'id_/http');
                    if (addMissionLog) addMissionLog(`📦 Snapshot found: ${snapshot.timestamp}. Fetching raw content...`, 'success');
                }
            }
        } catch (_) { }

        // Availability occasionally misses existing captures. CDX is the archive index,
        // so use it only as a secondary lookup before declaring Archive unavailable.
        if (!rawUrl) {
            const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,original,statuscode,mimetype&filter=statuscode:200&filter=mimetype:text/html&sort=reverse&limit=1`;
            const cdxRes = await fetch(cdxUrl, { signal: AbortSignal.timeout(15000) });
            if (cdxRes.ok) {
                const rows = await cdxRes.json();
                const snapshot = Array.isArray(rows) && Array.isArray(rows[1]) ? rows[1] : null;
                if (snapshot?.[0]) {
                    rawUrl = `https://web.archive.org/web/${snapshot[0]}id_/${url}`;
                    if (addMissionLog) addMissionLog(`📦 Archive index found snapshot: ${snapshot[0]}. Fetching raw content...`, 'success');
                }
            }
        }

        if (!rawUrl) throw new Error('No available snapshots found on Archive.org');

        const archiveResult = await scrapeViaDirectFetch(rawUrl, url, addMissionLog);
        return { ...archiveResult, archiveFallback: true, archiveSourceUrl: rawUrl };
    } catch (err) {
        throw new Error(`Archive.org Fallback Failed: ${err.message}`);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

async function getOCRParallel(langs = 'eng+spa', addMissionLog = null) {
    const safeLangs = normalizeOcrLangs(langs);
    if (tesseractSchedulers.has(safeLangs)) return tesseractSchedulers.get(safeLangs);

    // Multiple local PDF workers can reach OCR together. Share one initialization
    // promise per language so they use the same scheduler rather than duplicating it.
    if (ocrSchedulerInitializers.has(safeLangs)) {
        return ocrSchedulerInitializers.get(safeLangs);
    }

    const initializer = (async () => {
        // Memory Guard: Cap cached OCR schedulers to 2 to prevent RAM OOM.
        if (tesseractSchedulers.size >= 2) {
            const oldestKey = tesseractSchedulers.keys().next().value;
            const oldestScheduler = tesseractSchedulers.get(oldestKey);
            try { await oldestScheduler.terminate(); } catch (e) { }
            tesseractSchedulers.delete(oldestKey);
        }

        const scheduler = createScheduler();
        const workerCount = 6;
        if (addMissionLog) addMissionLog(`System: Engaging Parallel OCR (${workerCount} workers)...`, 'info');

        try {
            for (let i = 0; i < workerCount; i++) {
                const worker = await createWorker(safeLangs, 1, {
                    cachePath: path.join(DATA_DIR, 'tessdata'),
                    logger: m => { }
                });
                scheduler.addWorker(worker);
            }
        } catch (e) {
            try { await scheduler.terminate(); } catch (_) { }
            throw new Error(`OCR worker initialization failed for ${safeLangs}: ${e.message}`);
        }

        tesseractSchedulers.set(safeLangs, scheduler);
        return scheduler;
    })();

    ocrSchedulerInitializers.set(safeLangs, initializer);
    try {
        return await initializer;
    } finally {
        ocrSchedulerInitializers.delete(safeLangs);
    }
}

async function extractMetadata(page) {
    return await page.evaluate(() => {
        const getMeta = (name) => {
            const element = document.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[name="og:${name}"], meta[property="og:${name}"]`);
            return element ? element.getAttribute('content') : null;
        };
        return {
            title: document.title,
            description: getMeta('description'),
            keywords: getMeta('keywords'),
            author: getMeta('author'),
            url: window.location.href
        };
    });
}

/**
 * 📡 Network Interceptor: Captures PDF URLs from embedded document viewers.
 * Opens the viewer URL in a same-context page while listening for PDF responses.
 * Generic — works with any viewer that fetches a PDF over the network to display it.
 */
async function interceptPdfFromViewer(page, viewerUrl, pageUrl, addMissionLog = null) {
    const browser = page.context().browser();
    const interceptPage = await browser.newPage();

    let resolvePdf;
    const pdfCaptured = new Promise(resolve => { resolvePdf = resolve; });
    let captured = false;

    try {
        interceptPage.on('response', async (response) => {
            if (captured) return;
            try {
                const ct = (response.headers()['content-type'] || '').toLowerCase();
                const resUrl = response.url().toLowerCase();
                // Catch explicit PDF responses, or octet-stream with a PDF-like URL
                if (ct.includes('application/pdf') ||
                    (ct.includes('application/octet-stream') && (resUrl.includes('.pdf') || resUrl.includes('format=pdf')))) {
                    captured = true;
                    resolvePdf(response.url());
                }
            } catch (e) { /* response may have been disposed */ }
        });

        await interceptPage.goto(viewerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });

        // Wait for a PDF response or give up after 15s
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), 15000));
        const capturedPdfUrl = await Promise.race([pdfCaptured, timeout]);

        if (!capturedPdfUrl) return null;

        if (addMissionLog) addMissionLog(`📡 Network Interceptor captured PDF URL: ${capturedPdfUrl.substring(0, 100)}`, 'success');

        // Fail-Fast Sniff: Verify it's actually a PDF before committing to it
        try {
            const sniff = await fetch(capturedPdfUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null);
            if (sniff && sniff.ok) {
                const ct = (sniff.headers.get('content-type') || '').toLowerCase();
                if (!ct.includes('pdf') && !capturedPdfUrl.toLowerCase().endsWith('.pdf')) {
                    if (addMissionLog) addMissionLog(`📡 Network Interceptor discarded non-PDF URL: ${capturedPdfUrl.substring(0, 50)}...`, 'warn');
                    return null;
                }
            }
        } catch (e) { }

        // Delegate to scrapePDF for full download + text extraction
        const result = await scrapePDF(capturedPdfUrl, page.context().browser(), addMissionLog);
        if (result && result.metadata) result.metadata.url = pageUrl;
        return result;
    } catch (err) {
        if (addMissionLog) addMissionLog(`📡 Network Interceptor failed: ${err.message}`, 'warn');
        return null;
    } finally {
        await interceptPage.close().catch(() => { });
    }
}

function isTechnicalFrameUrl(frameUrl = '') {
    const lower = String(frameUrl).toLowerCase();
    return lower.includes('flexpaper')
        || lower.includes('pdf.js')
        || lower.includes('viewer.html')
        || lower.includes('google')
        || lower.includes('doubleclick')
        || lower.includes('facebook')
        || lower.includes('twitter')
        // Media embeds commonly contain player UI, captions, or login prompts.
        // They are never the source document for their parent official page.
        || lower.includes('youtube.com')
        || lower.includes('youtube-nocookie.com')
        || lower.includes('vimeo.com')
        || lower.includes('about:blank');
}

function normalizeOcrLangs(langs = 'eng+spa') {
    const fallback = ['eng', 'spa'];
    const normalized = String(langs || '')
        .split('+')
        .map(part => part.trim().toLowerCase())
        .filter(part => /^[a-z]{3}$/.test(part));

    const finalCodes = [...new Set(normalized)];
    if (finalCodes.length === 0) return fallback.join('+');
    return finalCodes.join('+');
}

function buildOcrLanguagePreference(url, contentLang = '') {
    const codes = ['eng', 'spa'];

    try {
        const parsedUrl = new URL(url);
        const tld = parsedUrl.hostname.split('.').pop().toLowerCase();
        if (EU_LANG_TLD_MAP[tld]) codes.push(...EU_LANG_TLD_MAP[tld].split('+'));

        for (const [code, patterns] of Object.entries(EU_PATH_PATTERNS)) {
            if (patterns.some(p => p.test(parsedUrl.pathname.toLowerCase()))) codes.push(code);
        }
    } catch (_) { }

    const rawLangs = String(contentLang || '')
        .split(/[;,]/)
        .map(part => part.trim().toLowerCase())
        .filter(Boolean);

    for (const rawLang of rawLangs) {
        const base = rawLang.split('-')[0];
        if (EU_HEADER_MAPPING[base]) codes.push(EU_HEADER_MAPPING[base]);
        else if (/^[a-z]{3}$/.test(base)) codes.push(base);
    }

    return normalizeOcrLangs(codes.join('+'));
}

function hasSufficientParsedPdfText(pdfData) {
    const rawText = String(pdfData?.text || '');
    const compact = rawText.replace(/\s+/g, ' ').trim();
    if (compact.length < 1200) return false;

    const safeChars = (compact.match(/[\p{L}\p{N}\s.,;:()\-'"%/[\]]/gu) || []).length;
    const safeRatio = compact.length > 0 ? (safeChars / compact.length) : 0;
    const pageCount = Math.max(1, Math.min(pdfData?.numpages || 1, 100));
    const avgCharsPerPage = compact.length / pageCount;

    return safeRatio >= 0.7 && (avgCharsPerPage >= 150 || compact.length >= 4000);
}

async function inspectMeaningfulSubframes(page, { captureHtml = false } = {}) {
    const framePayload = [];

    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        if (isTechnicalFrameUrl(frame.url())) continue;

        try {
            const frameInfo = await frame.evaluate(({ captureHtml }) => {
                if (!document.body) return null;

                const clone = document.body.cloneNode(true);
                clone.querySelectorAll('script, style, noscript, nav, footer, header').forEach(el => el.remove());

                const textLength = (clone.textContent || '').trim().length;
                if (textLength === 0) return null;

                return {
                    textLength,
                    html: captureHtml ? clone.innerHTML : null
                };
            }, { captureHtml }).catch(() => null);

            if (!frameInfo) continue;

            framePayload.push({
                url: frame.url(),
                textLength: frameInfo.textLength,
                html: frameInfo.html
            });
        } catch (_) { }
    }

    return framePayload;
}

function normalizedSiteHost(url = '') {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

// Preserve a browser-driven canonical route change, but only before Sailor has
// clicked document UI. This avoids recalling a legitimate multi-step redirect
// while keeping the existing protection against an expander navigating away.
function shouldPreserveAutomaticSameSiteRedirect({ targetUrl = '', currentUrl = '', contentInteractionPerformed = false } = {}) {
    if (contentInteractionPerformed || !targetUrl || !currentUrl || currentUrl === targetUrl) return false;
    const targetHost = normalizedSiteHost(targetUrl);
    const currentHost = normalizedSiteHost(currentUrl);
    return Boolean(targetHost && currentHost && targetHost === currentHost);
}

async function scrapePage(page, options = {}) {
    const url = page.url();
    const stayOnDomain = options.stayOnDomain || false;
    const targetUrl = options.targetUrl || url;
    const addMissionLog = options.addMissionLog || null;
    let preExtractBrowserRescueText = '';
    let transientExpansionStyle = null;

    let contentInteractionPerformed = false;
    try {
        preExtractBrowserRescueText = await page.evaluate(() => {
            const riskSelectors = '.cmp-tabs, [role="tabpanel"], .cmp-tabs__tabpanel, .tab-content, .panel-group, .accordion, .ecl-accordion';
            const bodyTextLength = (document.body?.textContent || '').trim().length;
            const mainTextLength = (document.querySelector('main, article, [role="main"], #content, .content, .main')?.textContent || '').trim().length;
            const shouldCapture = Boolean(document.querySelector(riskSelectors)) || (mainTextLength > 300 && mainTextLength < 15000 && bodyTextLength < 100000);
            if (!shouldCapture) return '';

            const clone = document.body ? document.body.cloneNode(true) : null;
            if (!clone) return '';
            clone.querySelectorAll('script, style, noscript, svg, template, nav, header, footer, aside, .cookie, [class*="cookie"], [id*="cookie"], [class*="orejime"], [id*="orejime"]').forEach(el => el.remove());
            clone.querySelectorAll('[aria-hidden="true"], [hidden], .collapse, .collapsed, .hidden').forEach(el => {
                el.removeAttribute('aria-hidden');
                el.removeAttribute('hidden');
                el.classList.remove('collapse', 'collapsed', 'hidden');
            });
            // Browser rescue is a last resort. Keep it structural so a local
            // widget with an article-like class cannot be merged into the source.
            const selectors = 'main, article, [role="main"], #content, .content, .main, .cmp-tabs, [role="tabpanel"], .cmp-tabs__tabpanel, .tab-content, .panel-group, .accordion, .ecl-accordion';
            const noiseLine = /^(ir al contenido|skip to content|accesibilidad|aviso legal|pol[ií]tica de cookies|aceptar todas las cookies|rechazar todas las cookies|ver pol[ií]tica de cookies)$/i;
            const seen = new Set();
            const lines = [];
            const pushText = (text = '') => String(text || '')
                .split(/\r?\n+/)
                .map(line => line.replace(/\s+/g, ' ').trim())
                .filter(line => line.length > 1 && !noiseLine.test(line))
                .forEach(line => {
                    const key = line.toLowerCase();
                    if (seen.has(key)) return;
                    seen.add(key);
                    lines.push(line);
                });
            const candidates = Array.from(clone.querySelectorAll(selectors))
                .filter(el => (el.textContent || '').trim().length > 120)
                .sort((a, b) => (b.textContent || '').trim().length - (a.textContent || '').trim().length)
                .slice(0, 8);
            if (candidates.length > 0) candidates.forEach(el => pushText(el.textContent));
            else pushText(clone.textContent || '');
            return lines.join('\n\n').trim();
        });
    } catch (_) { }

    // 🛡️ Universal Embedded Document Detector (v7)
    // Detect if this HTML page is just a "wrapper" shell around an embedded document viewer
    try {
        const embeddedDocUrl = await page.evaluate(() => {
            const viewers = Array.from(document.querySelectorAll('iframe, embed, object'))
                .filter(el => {
                    const rect = el.getBoundingClientRect();
                    // Must take up significant screen space
                    if (rect.width < 250 || rect.height < 250) return false;

                    const src = el.src || el.data || '';
                    if (!src) return false;

                    const srcLower = src.toLowerCase();
                    return srcLower.includes('.pdf') ||
                        srcLower.includes('viewer.html') ||
                        srcLower.includes('flexpaper') ||
                        srcLower.includes('pdf.js') ||
                        srcLower.includes('document-viewer') ||
                        srcLower.includes('embedded') ||
                        srcLower.includes('split_document');
                });

            if (viewers.length > 0) {
                viewers.sort((a, b) => {
                    const aRect = a.getBoundingClientRect();
                    const bRect = b.getBoundingClientRect();
                    return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                });
                return viewers[0].src || viewers[0].data;
            }

            return null;
        });

        // Only a genuine download-only shell may be promoted to the linked PDF.
        // A normal HTML source page can legitimately be concise and link to one PDF.
        const directDocumentFallbackUrl = embeddedDocUrl
            ? null
            : await page.evaluate(findDirectDocumentFallbackUrl).catch(() => null);
        const resolvedEmbeddedDocUrl = embeddedDocUrl || directDocumentFallbackUrl;

        if (resolvedEmbeddedDocUrl) {
            let directPdfUrl = resolvedEmbeddedDocUrl;

            // 🛡️ Logic for the future: Deep DOM Link Harvest (v16.22)
            // If we are on a viewer page, search the whole page for a "Secret" direct link
            const harvestResults = await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a[href]'))
                    .map(a => a.href)
                    .filter(h => (h.toLowerCase().endsWith('.pdf') || h.toLowerCase().includes('format=pdf')) && h.startsWith('http'));

                const scripts = Array.from(document.querySelectorAll('script'))
                    .map(s => s.textContent)
                    .join(' ');
                const matches = scripts.match(/https?:\/\/[^"'\s]+\.pdf/gi) || [];

                return [...new Set([...links, ...matches])];
            });

            if (harvestResults.length > 0) {
                const bestHarvest = harvestResults[0];
                if (addMissionLog) addMissionLog(`🌾 Deep Harvest found candidate URL: ${bestHarvest.substring(0, 50)}...`, 'info');
                try {
                    const fastResult = await scrapePDF(bestHarvest, page.context().browser(), addMissionLog);
                    if (fastResult && !fastResult.error && fastResult.allText.length > 500) return fastResult;
                } catch (e) { }
            }

            // Universal Parameter Sniffing: recursive scan for PDF markers
            const scanForPdf = (str) => {
                if (!str) return null;
                const pdfMatch = str.match(/https?:\/\/[^"'\s]+\.pdf/i) || str.match(/https?:\/\/[^"'\s]+format=pdf[^"'\s]*/i);
                if (pdfMatch) return pdfMatch[0];
                return null;
            };

            const urlOrigin = new URL(url).origin;
            try {
                const parsedEmbed = new URL(directPdfUrl, urlOrigin);
                for (const [, val] of parsedEmbed.searchParams) {
                    const discovered = scanForPdf(val);
                    if (discovered) {
                        directPdfUrl = discovered;
                        break;
                    }
                    if (val && (val.toLowerCase().endsWith('.pdf') || val.toLowerCase().includes('/pdf') || val.includes('getpdf') || val.includes('download'))) {
                        if (val.startsWith('http')) {
                            directPdfUrl = val;
                        } else if (val.startsWith('/')) {
                            directPdfUrl = new URL(val, urlOrigin).href;
                        }
                        break;
                    }
                }
            } catch (e) { }

            if (addMissionLog) addMissionLog(`🎯 Embedded Document Viewer detected. Attempting extraction: ${directPdfUrl.substring(0, 70)}...`, 'info');

            // Strategy 1: Direct PDF fetch — only if the URL looks like an actual PDF, not a viewer page
            const isLikelyViewerPage = /\.jsp|\.aspx|viewer\.html|flexpaper|document-viewer|split_document/i.test(directPdfUrl);
            if (!isLikelyViewerPage) {
                try {
                    const pdfTextResult = await scrapePDF(directPdfUrl, page.context().browser(), addMissionLog);
                    if (pdfTextResult && !pdfTextResult.error && pdfTextResult.allText.length > 500) {
                        return pdfTextResult;
                    }
                } catch (pdfErr) {
                    if (addMissionLog) addMissionLog(`❌ Direct PDF fetch failed: ${pdfErr.message}`, 'warn');
                }
            }

            // Strategy 2: Network Interceptor — open the viewer in a fresh page, capture the PDF URL from traffic
            if (addMissionLog) addMissionLog(`📡 Deploying Network Interceptor on viewer URL...`, 'info');
            try {
                const resolvedViewerUrl = new URL(embeddedDocUrl, urlOrigin).href;
                const interceptResult = await interceptPdfFromViewer(page, resolvedViewerUrl, url, addMissionLog);
                if (interceptResult && !interceptResult.error && interceptResult.allText && interceptResult.allText.length > 500) {
                    return interceptResult;
                }
            } catch (interceptErr) {
                if (addMissionLog) addMissionLog(`📡 Network Interceptor did not capture a PDF: ${interceptErr.message}`, 'warn');
            }

            // Strategy 3: Physical click on download button inside viewer iframe
            if (addMissionLog) addMissionLog(`Attempting physical button extraction from internal viewer frame...`, 'info');
            try {
                const frames = page.frames();
                let viewerFrame = null;
                for (const frame of frames) {
                    if (frame.url().includes('viewer.html') || frame.url().includes('pdf') || frame.url() === directPdfUrl) {
                        viewerFrame = frame;
                        break;
                    }
                }

                if (viewerFrame) {
                    const btnInfo = await viewerFrame.evaluate(() => {
                        const btn = document.querySelector('#download, [title="Download"], .download, [aria-label="Download"]');
                        return btn ? true : false;
                    });

                    if (btnInfo) {
                        if (addMissionLog) addMissionLog(`👆 Clicking embedded Download button...`, 'info');
                        const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
                        await viewerFrame.click('#download, [title="Download"], .download, [aria-label="Download"]');
                        const download = await downloadPromise;

                        const buffer = await withTempFile('temp_embed', 'pdf', async (tempPath) => {
                            await download.saveAs(tempPath);
                            return fs.readFileSync(tempPath);
                        });

                        if (addMissionLog) addMissionLog(`✅ Physical Embedded Download Succeeded.`, 'success');

                        const pdfParse = require('pdf-parse');
                        const pdfData = await pdfParse(buffer);
                        const rawText = pdfData.text || '';
                        const title = await page.title();

                        return {
                            metadata: { title: title || 'Document', url },
                            allText: `# ${title}\nURL: ${url}\n\n${rawText}`,
                            plainText: rawText,
                            articleLength: rawText.length,
                            pdfBuffer: buffer,
                            error: false
                        };
                    }
                }
            } catch (iframeErr) {
                if (addMissionLog) addMissionLog(`❌ Physical iframe extraction failed: ${iframeErr.message}`, 'warn');
            }

            // If ALL PDF extraction failed or was a viewer wrapper, return a clean wrapper response to prevent Gibberish
            const title = await page.title();
            return {
                metadata: { title, url },
                allText: `# ${title}\nURL: ${url}\n\n[Embedded Document Viewer Detected, but PDF could not be automatically extracted from viewer].`,
                plainText: `Embedded Document Viewer Detected. PDF could not be extracted automatically.`,
                error: false,
                articleHtml: '<div>[Embedded PDF Viewer]</div>'
            };
        }
    } catch (e) {
        // Safely ignore evaluation errors
    }

    // 🛡️ Bot-Wall Detector (Cloudflare/WAF)
    // If we detect a challenge, wait for it to resolve or fail fast to trigger Jina fallback.
    const detector = async () => {
        const currentUrl = page.url();
        const content = await page.content();
        const title = await page.title().catch(() => '');
        const validityIssue = classifyContentValidity({
            metadata: { title, url: currentUrl || targetUrl || '' },
            allText: content
        }, { url: currentUrl || targetUrl || '' });
        if (validityIssue) {
            if (addMissionLog) addMissionLog(`Unusable browser response detected: ${validityIssue.reason}`, 'warn');
            throw createUnusableContentError(validityIssue);
        }

        // 🛡️ v16.98: Browser Error Page Detection (e.g. ERR_CONNECTION_RESET)
        if (currentUrl.startsWith('chrome-error://') || currentUrl.includes('chromewebdata') || 
            content.includes('ERR_CONNECTION_RESET') || content.includes('ERR_CONNECTION_CLOSED') || 
            content.includes('ERR_EMPTY_RESPONSE')) {
            if (addMissionLog) addMissionLog(`🛑 Browser network error detected (${currentUrl}). Triggering survival bypass...`, 'warn');
            throw new Error('BOT_BLOCKED');
        }

        // 🛡️ v16.98: Empty / Minimal Content Block Check
        if (content.length < 600 && (content.toLowerCase().includes('site can\'t be reached') || content.toLowerCase().includes('access denied') || content.toLowerCase().includes('forbidden'))) {
            throw new Error('BOT_BLOCKED');
        }

        const challenges = [
            'just a moment', 'ray id', 'checking your browser',
            'security verification', 'verify you are not a bot',
            'un instant', 'vérification de sécurité', 'enable javascript',
            'browser is not supported', 'access denied'
        ];
        const isDynamicShell = detectDynamicApplicationShell(content).isShell;
        if (isDynamicShell) return false;

        if (challenges.some(c => content.toLowerCase().includes(c))) {
            const hasSubstantialContent = content.length > 5000 && !content.toLowerCase().includes('<title>access denied</title>');
            if (hasSubstantialContent) return false; // Potential noise, but content looks real

            if (addMissionLog) addMissionLog(`🛡️ Bot wall detected. Waiting for transition...`, 'info');
            for (let i = 0; i < 4; i++) {
                await page.waitForTimeout(2000).catch(() => { });
                const newContent = await page.content();
                if (!challenges.some(c => newContent.toLowerCase().includes(c))) return true;
                if (newContent.length > 5000) return true; // Content emerged
            }
            throw new Error('BOT_BLOCKED');
        }
        return false;
    };

    await detector().catch(err => {
        if (err.message === 'BOT_BLOCKED' || err.code === 'UNUSABLE_CONTENT') throw err;
    });

    await waitForDynamicApplicationContent(page, addMissionLog);

    // Start HTML cleanup
    const cleanupLogic = async (target, opts = {}) => {
        const stayOnDomain = opts.stayOnDomain || false;
        const targetHost = opts.targetUrl ? new URL(opts.targetUrl).hostname.replace('www.', '') : null;
        const sourceUrlBeforeCleanup = target.url();

        try {
            const cleanupResult = await target.evaluate(async ({ stayOnDomain, targetHost, consentActionPatternSource }) => {
                const sleep = ms => new Promise(res => setTimeout(res, ms));
                // Never click a cookie-settings link or generic preferences UI.
                // Only explicit accept/reject actions in a cookie-related scope
                // are safe to automate before source extraction.
                const safeConsentAction = new RegExp(consentActionPatternSource, 'iu');

                const interactionRegex = /accept|agree|allow|consent|settings|preferences|akzeptieren|zustimmen|einstellungen|accepter|autoriser|paramètres|accetta|consenti|impostazioni|aceitar|permitir|configurações|aceptar|rechazar|configurar|entendido|akkoord|toestaan|instellingen|prihva\u0107am|odbijam|postavke/i;
                const cookieRegex = /cookie|privacy|gdpr|legal notice|aviso legal|privacidad|mentions légales|datenschutz|informazioni legali|informativa privacy|juridische/i;

                // Watchdog Clicker: Strictly avoid links if stayOnDomain is active
                const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
                    .filter(el => {
                        const t = el.textContent.toLowerCase();
                        if (!(safeConsentAction.test(t) && t.length < 60)) return false;
                        const consentScope = [el, el.parentElement, el.parentElement?.parentElement, el.closest('[role="dialog"], dialog, section, aside, div')]
                            .filter(Boolean)
                            .map(node => node.textContent || '')
                            .join(' ');
                        if (!/(?:cookie|privacy|gdpr|legal notice|aviso legal|privacidad|datenschutz|informativa privacy|juridische)/i.test(consentScope)) return false;
                        if (stayOnDomain && el.tagName === 'A' && el.href && !el.href.includes(targetHost)) return false;
                        return true;
                    });

                let consentAction = null;
                if (buttons.length > 0) {
                    const selectedButton = buttons[0];
                    consentAction = {
                        tag: selectedButton.tagName.toLowerCase(),
                        label: (selectedButton.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
                        href: selectedButton.tagName === 'A' ? selectedButton.href : ''
                    };
                    selectedButton.click();
                    await sleep(600);
                }

                // Global Banner & Noise Removal
                const selectors = [
                    ...GLOBAL_BANNER_CLEANUP_SELECTORS,
                    'footer', 'header', 'nav', '.footer', '.header', '.navigation', '.nav-footer',
                    '#footer', '#header', '.region-footer', '.region-header', '.breadcrumb', '.contextual'
                ];
                selectors.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));

                // Some consent managers use neutral component names instead of
                // "cookie" or "consent". Remove only compact dialog-like blocks
                // whose visible text has both a cookie term and consent controls.
                const consentTermRegex = /(?:\bcookies?\b|kola\u010di\u0107(?:i|ima|e)?|kolacici?)/iu;
                const consentActionRegex = /accept|reject|decline|allow|refuse|settings|preferences|manage|prihva\u0107am|odbijam|postavke/i;
                document.querySelectorAll('div, section, aside, dialog, [role="dialog"]').forEach(el => {
                    const text = (el.textContent || '').trim();
                    const isStructuralContent = el.matches('main, article') || el.querySelector('main, article');
                    if (!isStructuralContent && text.length > 0 && text.length < 15000 && consentTermRegex.test(text) && consentActionRegex.test(text)) {
                        el.remove();
                    }
                });
                return { consentAction };
            }, { stayOnDomain, targetHost, consentActionPatternSource: EXPLICIT_CONSENT_ACTION_PATTERN.source });
            return {
                sourceUrlBeforeCleanup,
                consentAction: cleanupResult?.consentAction || null
            };
        } catch (e) {
            // A navigation can destroy the page context before evaluate returns.
            // The caller still compares URLs, so this must remain observable.
            return {
                sourceUrlBeforeCleanup,
                consentAction: null,
                error: e.message
            };
        }
    };

    const anchorHost = new URL(targetUrl).hostname.replace('www.', '');

    // Initial and Frame cleanup
    const mainCleanup = await cleanupLogic(page, { stayOnDomain, targetUrl });
    for (const frame of page.frames()) {
        if (frame !== page.mainFrame()) await cleanupLogic(frame, { stayOnDomain, targetUrl });
    }

    // Cleanup runs after the source has become available. A URL change here is
    // therefore not an initial canonical redirect: it can only be an automated
    // interaction or an unstable page. Restore the source before fast-path
    // extraction so a navigated page can never become a false success.
    const cleanupObservedUrl = page.url();
    if (didAutomatedCleanupChangeSource(mainCleanup.sourceUrlBeforeCleanup, cleanupObservedUrl)) {
        const actionLabel = mainCleanup.consentAction?.label
            ? ` after automated action "${mainCleanup.consentAction.label}"`
            : ' during automated cleanup';
        if (addMissionLog) addMissionLog(`Automated cleanup changed the source URL${actionLabel}. Restoring ${mainCleanup.sourceUrlBeforeCleanup} before extraction.`, 'warn');

        const restoreResponse = await page.goto(mainCleanup.sourceUrlBeforeCleanup, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        }).catch(() => null);
        if (!restoreResponse || !restoreResponse.ok()) {
            throw createUnusableContentError({
                category: 'automated_navigation_source_mismatch',
                reason: `Automated cleanup navigated away from the requested source and Sailor could not restore ${mainCleanup.sourceUrlBeforeCleanup} with a successful response.`,
                retryable: true
            });
        }

        await waitForDynamicApplicationContent(page, addMissionLog);
        if (didAutomatedCleanupChangeSource(mainCleanup.sourceUrlBeforeCleanup, page.url())) {
            throw createUnusableContentError({
                category: 'automated_navigation_source_mismatch',
                reason: `Automated cleanup navigated away from the requested source; restoring ${mainCleanup.sourceUrlBeforeCleanup} resolved to ${page.url()} instead.`,
                retryable: true
            });
        }
        if (addMissionLog) addMissionLog('Requested source URL restored after automated cleanup navigation.', 'success');
    }

    // 🛡️ Stability-Aware Racing (v16.19)
    // We only trust the "Fast Gear" if the content is both substantial AND stable.
    const getTextSnapshot = async () => {
        return await page.evaluate(() => {
            if (!document.body) return 0;
            const cleanBody = document.body.cloneNode(true);
            cleanBody.querySelectorAll('script, style, noscript, svg, nav, footer, header').forEach(el => el.remove());
            return cleanBody.textContent.trim().length;
        });
    };

    let snap2Len = 0;
    try {
        const snap1Len = await getTextSnapshot();
        await page.waitForTimeout(400).catch(() => { });
        snap2Len = await getTextSnapshot();

        const isSubstantial = snap2Len > 1200;
        const isStable = Math.abs(snap1Len - snap2Len) <= (snap1Len * 0.05);

        const meaningfulFrames = (isSubstantial && isStable)
            ? await inspectMeaningfulSubframes(page)
            : [];
        const dominantFrame = meaningfulFrames
            .filter(frame => frame.textLength > 2000 && frame.textLength > (snap2Len * 1.5))
            .sort((a, b) => b.textLength - a.textLength)[0];

        let contentExpanders = (isSubstantial && isStable && !dominantFrame)
            ? await page.evaluate(detectContentExpanders, { selector: CONTENT_EXPANDER_SELECTOR }).catch(() => ({ count: 0, labels: [] }))
            : { count: 0, labels: [] };

        // Some government FAQ applications mount their disclosure controls just
        // after the first stable text paint. Recheck only when the DOM already
        // shows a large hidden-content gap, never as a blanket delay for pages.
        if (isSubstantial && isStable && !dominantFrame && contentExpanders.count === 0) {
            const lateDisclosureState = await page.evaluate(() => ({
                totalTextLength: (document.body?.textContent || '').trim().length,
                visibleTextLength: (document.body?.innerText || '').trim().length,
                hasPotentialControls: Boolean(document.querySelector(
                    'button, [aria-controls], [data-toggle="collapse"], [data-bs-toggle="collapse"], details, .accordion, .panel-group'
                ))
            })).catch(() => null);
            if (shouldAwaitLateDisclosure(lateDisclosureState || {})) {
                await page.waitForTimeout(1000).catch(() => { });
                contentExpanders = await page.evaluate(detectContentExpanders, { selector: CONTENT_EXPANDER_SELECTOR })
                    .catch(() => ({ count: 0, labels: [] }));
                if (contentExpanders.count > 0 && addMissionLog) {
                    addMissionLog(`Late disclosure controls became available (${contentExpanders.count}); running thorough extraction.`, 'info');
                }
            }
        }

        if (isSubstantial && isStable && !dominantFrame && contentExpanders.count === 0) {
            if (addMissionLog) addMissionLog(`⚡ Stability Sniff passed (${snap2Len} chars, stable). Skipping heavy expansion.`, 'info');
            return await smartExtract([await page.content()], targetUrl, url, { addMissionLog });
        }
        if (contentExpanders.count > 0 && addMissionLog) {
            const labels = contentExpanders.labels.filter(Boolean).join(', ');
            addMissionLog(`Detected ${contentExpanders.count} content expander(s)${labels ? ` (${labels})` : ''}. Running thorough extraction.`, 'info');
        }
        if (dominantFrame && addMissionLog) {
            addMissionLog(`Frame-aware fast path bypassed: detected a substantial sub-frame (${dominantFrame.textLength} chars).`, 'info');
        }
    } catch (sniffErr) {
        if (addMissionLog) addMissionLog(`⚠️ Stability sniff failed (${sniffErr.message}). Falling through to Thorough Gear...`, 'warn');
    }

    // 🏎️ Thorough Gear Transition (Optimistic Racing)
    if (addMissionLog) addMissionLog(`🏎️ Content unstable or insufficient (${snap2Len} chars). Transitioning to Thorough Gear...`, 'info');
    await page.waitForTimeout(2000).catch(() => { });

    // 🕷️ Cumulative Extraction: Capture snapshots for "Single-Open" accordions
    const MAX_CUMULATIVE_SNAPSHOTS = Math.max(2, Math.min(parseInt(process.env.SCRAPERITO_MAX_CUMULATIVE_SNAPSHOTS || '16', 10) || 16, 30));
    const MAX_SNAPSHOT_CHARS = Math.max(100000, Math.min(parseInt(process.env.SCRAPERITO_MAX_SNAPSHOT_CHARS || '1500000', 10) || 1500000, 3000000));
    const MAX_TOTAL_SNAPSHOT_CHARS = Math.max(MAX_SNAPSHOT_CHARS, Math.min(parseInt(process.env.SCRAPERITO_MAX_TOTAL_SNAPSHOT_CHARS || '12000000', 10) || 12000000, 25000000));
    let cumulativeSnapshots = [];
    let cumulativeSnapshotChars = 0;
    let cumulativeSnapshotLimitHit = false;
    const pushCumulativeSnapshot = async (label = 'snapshot') => {
        if (cumulativeSnapshotLimitHit || cumulativeSnapshots.length >= MAX_CUMULATIVE_SNAPSHOTS) {
            cumulativeSnapshotLimitHit = true;
            return false;
        }

        let snapshot = await page.evaluate(() => {
            const title = document.title || '';
            const body = document.body ? document.body.cloneNode(true) : null;
            if (!body) return document.documentElement ? document.documentElement.outerHTML : '';

            body.querySelectorAll([
                'script',
                'style',
                'noscript',
                'svg',
                'canvas',
                'iframe',
                'nav',
                'header',
                'footer',
                '[role="navigation"]',
                '.breadcrumb',
                '.cookie',
                '.consent',
                '.social-sharing',
                '.share'
            ].join(',')).forEach(el => el.remove());

            return `<!doctype html><html><head><title>${title}</title></head><body>${body.innerHTML}</body></html>`;
        }).catch(() => page.content());
        if (snapshot.length > MAX_SNAPSHOT_CHARS) {
            snapshot = snapshot.slice(0, MAX_SNAPSHOT_CHARS);
            if (addMissionLog) addMissionLog(`Snapshot trimmed during ${label} to protect scraper memory; extraction continues with the captured content.`, 'warn');
        }

        if (cumulativeSnapshotChars + snapshot.length > MAX_TOTAL_SNAPSHOT_CHARS) {
            cumulativeSnapshotLimitHit = true;
            if (addMissionLog) addMissionLog(`Accordion snapshot memory limit reached during ${label}; continuing with captured content.`, 'warn');
            return false;
        }

        cumulativeSnapshots.push(snapshot);
        cumulativeSnapshotChars += snapshot.length;
        return true;
    };

    // 🔍 Accordion Ghost Buster (v4): Sequential Snapshotting
    if (addMissionLog) addMissionLog(`🔍 Deploying Accordion Ghost Buster (Cumulative Snapshotting)...`, 'info');

    // 🕵️ v16.54: PDF Viewer Detection (Skip UI interaction if it's a document viewer)
    let isPDF = targetUrl.toLowerCase().includes('.pdf');
    try {
        isPDF = isPDF || (await page.evaluate(() => document.contentType === 'application/pdf')).valueOf();
    } catch (e) {
        if (addMissionLog) addMissionLog(`⚠️ Could not evaluate PDF content type (context unstable). Assuming non-PDF.`, 'warn');
    }

    try {
        if (!isPDF) {
            // ☢️ Pre-emptive Ghost Buster: Strip attributes from already-open content 
            // (Often the first accordion is open on mount, but still has 'hidden' ARIA flags)
            await page.evaluate(() => {
                document.querySelectorAll('[aria-hidden="true"], [hidden], .collapse').forEach(el => {
                    el.removeAttribute('aria-hidden');
                    el.removeAttribute('hidden');
                    el.style.display = 'block';
                    el.style.visibility = 'visible';
                    el.style.opacity = '1';
                    el.style.height = 'auto';
                });
            });
        }
        await pushCumulativeSnapshot('initial accordion pass');

        const expanderSelectors = `${CONTENT_EXPANDER_SELECTOR}, .panel-heading a, .panel-title a, [role="tab"]`;
        let expandersCount = isPDF ? 0 : await page.evaluate((sel) => document.querySelectorAll(sel).length, expanderSelectors);
        expandersCount = Math.min(expandersCount, MAX_CUMULATIVE_SNAPSHOTS);

        for (let i = 0; i < expandersCount; i++) {
            const clickResult = await page.evaluate(async ({ sel, targetUrl }) => {
                const noiseLabels = /menu|navigation|nav|sidebar|footer|header|cookie|consent|social|share|partage[rz]|comparti[lr]|teilen|senden|favori(?:te|s)?|bookmark|print|imprim(?:er|ir)|download|login|signin|cart|checkout/i;
                const nonSourceAction = /(?:^|\b)(?:share|partage[rz]|comparti[lr]|teilen|senden|favori(?:te|s)?|bookmark|print|imprim(?:er|ir)|download)(?:\b|$)/i;
                const interactionRegex = /expand|show more|plus|details|details anzeigen|mehr|détails|voir plus|espandi|scopri|ver más|detalles|meer informatie|tonen|plus d'infos|weiterlesen|leggi tutto/i;
                const el = Array.from(document.querySelectorAll(sel))
                    .find(candidate => {
                        if (candidate.dataset && candidate.dataset.scraperitoClicked === '1') return false;
                        if (!(candidate.offsetWidth > 0 || candidate.offsetHeight > 0 || candidate.getClientRects().length > 0)) return false;
                        if (candidate.getAttribute('aria-expanded') === 'true') return false;

                        // Keep clicks inside the requested document. This mirrors
                        // the fast-path guard and prevents UI actions (downloads,
                        // menus, forms) from invalidating cumulative snapshots.
                        const tag = candidate.tagName.toLowerCase();
                        const role = candidate.getAttribute('role');
                        if (!['button', 'a', 'summary'].includes(tag) && role !== 'button') return false;
                        const contentSelector = 'main, article, [role="main"], #content, [id*="content" i], .content, .body, .article-content, .main-content, .ecl-container';
                        const noiseSelector = 'nav, header, footer, aside, [role="navigation"], .menu, .submenu, .sidebar, .navigation, .breadcrumb, .cookie, .consent, [class*="cookie" i], [class*="consent" i], form';
                        if (candidate.closest(noiseSelector) || !candidate.closest(contentSelector)) return false;
                        const widgetSignature = /accessib|assistive|virtual[-_ ]?keyboard|on[-_ ]?screen[-_ ]?keyboard|font[-_ ]?size|contrast|toolbar|widget/i;
                        const candidateSignature = `${candidate.id || ''} ${candidate.className || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`;
                        if (widgetSignature.test(candidateSignature)) return false;
                        if (tag === 'a') {
                            const href = candidate.getAttribute('href') || '';
                            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return false;
                        }

                        // 🛡️ Semantic Area Filtering: Only expand if inside content containers OR NOT inside noise containers
                        const isInsideContent = candidate.closest('main, article, #content, [id*="content"], .content, .body, .article-content, .ecl-container') !== null;
                        const isInsideNoise = candidate.closest('nav, header, footer, aside, .menu, .sidebar, .navigation, .breadcrumb, .cookie, .consent, .social-sharing') !== null;

                        // If it's inside noise, skip completely
                        if (isInsideNoise) return false;

                        // If it's NOT inside content (e.g. generic layout), check label for noise
                        const t = candidate.textContent.toLowerCase().trim();
                        if (nonSourceAction.test(`${t} ${candidateSignature}`)) return false;
                        if (!isInsideContent && noiseLabels.test(t)) return false;

                        if (candidate.tagName === 'A' && candidate.getAttribute('href')) {
                            const href = candidate.getAttribute('href');
                            if (href.startsWith('#') || href.startsWith('javascript:') || href.includes(targetUrl + '#')) return true;
                            if (href.startsWith('http') || href.startsWith('/') || href.includes('.html')) return false;
                        }

                        const rawTarget = candidate.getAttribute('aria-controls') ||
                            candidate.getAttribute('data-target') ||
                            candidate.getAttribute('data-bs-target') ||
                            ((candidate.getAttribute('href') || '').startsWith('#') ? candidate.getAttribute('href') : '');
                        const targetId = rawTarget.trim().replace(/^#/, '');
                        const controlledTarget = targetId && !/\s/.test(targetId)
                            ? document.getElementById(targetId)
                            : null;
                        const targetSignature = controlledTarget
                            ? `${controlledTarget.id || ''} ${controlledTarget.className || ''} ${controlledTarget.getAttribute('role') || ''}`
                            : '';
                        const targetText = (controlledTarget?.textContent || '').replace(/\s+/g, ' ').trim();
                        const descriptiveControlLabel = (t.match(/[\p{L}\p{N}]/gu) || []).length >= 8;
                        const targetIsSafe = Boolean(controlledTarget) &&
                            !controlledTarget.closest(noiseSelector) &&
                            Boolean(controlledTarget.closest(contentSelector)) &&
                            !widgetSignature.test(targetSignature) &&
                            (
                                (targetText.match(/[\p{L}\p{N}]/gu) || []).length >= 20 ||
                                (candidate.getAttribute('aria-expanded') === 'false' && descriptiveControlLabel)
                            );
                        const nativeSummary = candidate.tagName === 'SUMMARY' && Boolean(candidate.closest('details'));
                        if (!nativeSummary && !targetIsSafe) {
                            return !controlledTarget && /\p{L}/u.test(t) && interactionRegex.test(t) && t.length < 50;
                        }

                        // Process root disclosures before their children. This prevents
                        // a large nested FAQ from spending the bounded interaction budget
                        // on its first branch while other top-level source sections remain closed.
                        const allControls = Array.from(document.querySelectorAll(sel)).slice(0, 250);
                        const controlledTargetFor = (control) => {
                            const raw = control.getAttribute('aria-controls') || control.getAttribute('data-target') ||
                                control.getAttribute('data-bs-target') || ((control.getAttribute('href') || '').startsWith('#') ? control.getAttribute('href') : '');
                            const id = String(raw || '').trim().replace(/^#/, '');
                            return id && !/\s/.test(id) ? document.getElementById(id) : null;
                        };
                        const nestingDepth = (control) => allControls.reduce((depth, parent) => {
                            if (parent === control) return depth;
                            const parentTarget = controlledTargetFor(parent);
                            return parentTarget && parentTarget.contains(control) ? depth + 1 : depth;
                        }, 0);
                        const pendingControls = allControls.filter(control =>
                            !(control.dataset && control.dataset.scraperitoClicked === '1') &&
                            control.getAttribute('aria-expanded') !== 'true' &&
                            (control.offsetWidth > 0 || control.offsetHeight > 0 || control.getClientRects().length > 0)
                        );
                        const shallowestPendingDepth = pendingControls.length > 0
                            ? Math.min(...pendingControls.map(nestingDepth))
                            : 0;
                        return nestingDepth(candidate) === shallowestPendingDepth;
                    });

                if (el) {
                    const elText = el.textContent.trim().substring(0, 30);
                    if (el.dataset) el.dataset.scraperitoClicked = '1';
                    el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    el.click();
                    return { clicked: true, text: elText };
                }
                return null;
            }, { sel: expanderSelectors, targetUrl });

            if (clickResult && clickResult.clicked) {
                contentInteractionPerformed = true;
                if (addMissionLog) addMissionLog(`👆 Clicked toggle: "${clickResult.text}..."`, 'info');
                await page.waitForTimeout(500).catch(() => { });

                // ☢️ JSDOM/Readability physical attribute stripping
                await page.evaluate(() => {
                    document.querySelectorAll('[aria-hidden="true"], [hidden], .collapse').forEach(el => {
                        el.removeAttribute('aria-hidden');
                        el.removeAttribute('hidden');
                        el.style.display = 'block';
                        el.style.visibility = 'visible';
                        el.style.opacity = '1';
                        el.style.height = 'auto';
                    });
                });
                await pushCumulativeSnapshot(`toggle "${clickResult.text}"`);
            } else {
                // If we found no more unexpanded items, we can break early
                break;
            }
        }
    } catch (expandErr) { }

    // 🛡️ URL-Lock Check
    const currentUrlBeforeRecall = page.url();
    // `url` is the canonical page reached before this extractor performed
    // any interaction. Preserve an official HTTP/JS redirect (for example a
    // registry moving to its current public domain), but still recall URLs
    // reached later by an accordion or other page interaction.
    const isInitialCanonicalRedirect = currentUrlBeforeRecall === url && url !== targetUrl;
    const isAutomaticSameSiteRedirect = shouldPreserveAutomaticSameSiteRedirect({
        targetUrl,
        currentUrl: currentUrlBeforeRecall,
        contentInteractionPerformed
    });
    const shouldPreserveCanonicalRedirect = isInitialCanonicalRedirect || isAutomaticSameSiteRedirect;
    if (shouldPreserveCanonicalRedirect && addMissionLog) {
        addMissionLog(`Official redirect resolved to ${currentUrlBeforeRecall}; preserving the canonical source URL.`, 'info');
    }
    if (currentUrlBeforeRecall !== targetUrl && !shouldPreserveCanonicalRedirect) {
        if (addMissionLog) addMissionLog(`Expansion changed the page URL to ${currentUrlBeforeRecall}; restoring ${targetUrl}.`, 'warn');
        if (addMissionLog) addMissionLog(`🔄 Accidental navigation detected. Reverting to target URL...`, 'warn');
        const discardedSnapshots = cumulativeSnapshots.length;
        // Snapshots captured before a navigation may describe a different page.
        // Once we recall the target URL they are unsafe to merge into its corpus text.
        cumulativeSnapshots = [];
        cumulativeSnapshotChars = 0;
        cumulativeSnapshotLimitHit = false;
        if (discardedSnapshots > 0 && addMissionLog) {
            addMissionLog(`Discarded ${discardedSnapshots} pre-recall expansion snapshot(s) to keep the target document isolated.`, 'info');
        }
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
    }

    // ☢️ Nuclear CSS Inversion (Aggressive legal block expansion)
    try {
        if (!isPDF) {
            transientExpansionStyle = await page.addStyleTag({
                content: `
                main .collapse, article .collapse, #content .collapse, 
                main .hidden, article .hidden, #content .hidden,
                main [aria-hidden="true"], article [aria-hidden="true"], #content [aria-hidden="true"] { 
                    display: block !important; 
                    visibility: visible !important; 
                    opacity: 1 !important;
                    height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                }
                .accordion-content, .panel-body, .expandable-content {
                    display: block !important;
                    visibility: visible !important;
                    height: auto !important;
                }
            `
            });

            // ☢️ JSDOM/Readability physical attribute stripping for the final snapshot
            await page.evaluate(() => {
                document.querySelectorAll('[aria-hidden="true"], [hidden], .collapse').forEach(el => {
                    el.removeAttribute('aria-hidden');
                    el.removeAttribute('hidden');
                });
            });

            // Final snapshot after aggressive CSS
            await pushCumulativeSnapshot('final CSS expansion');
        }
    } catch (cssErr) { }

    // 🛡️ Safety Recall Check
    if (stayOnDomain && new URL(page.url()).hostname.replace('www.', '') !== anchorHost) {
        console.log(`[WATCHDOG] Stray detected. Executing Safety Recall...`);
        await page.goBack().catch(() => { });
    }

    // 📜 Infinite Scroll Simulation (Sapiens 10.0)
    // Scrolls down the page in steps to trigger lazy-loaded content before extraction.
    let didScroll = false;
    try {
        didScroll = await page.evaluate(async () => {
            return await new Promise(resolve => {
                let scrolls = 0;
                const distance = 800;
                const maxScrolls = 15;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    scrolls++;
                    const atBottom = (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 100;
                    if (atBottom || scrolls >= maxScrolls) {
                        clearInterval(timer);
                        resolve(scrolls > 1); // true only if we actually scrolled multiple steps
                    }
                }, 150);
            });
        });
        // Only wait if we actually scrolled through multi-step lazy content
        if (didScroll) await page.waitForTimeout(500).catch(() => { });
    } catch (scrollErr) { /* Non-fatal — continue extraction even if scroll fails */ }

    // The expansion stylesheet is a scraper-only visual aid. It must never be
    // serialized into the source HTML or counted as document text.
    if (transientExpansionStyle) {
        await transientExpansionStyle.evaluate(style => style.remove()).catch(() => {});
        transientExpansionStyle = null;
    }

    // 🛡️ Navigation Guard: Handle sites that shift content or redirect during extraction (e.g., ti.ee)
    let html = '';
    let retries = 3;
    while (retries > 0) {
        try {
            html = await page.content();
            break;
        } catch (contentErr) {
            retries--;
            if (contentErr.message.includes('navigating')) {
                console.log(`[ELMO] Navigation detected during extraction. Waiting for stability... (${retries} retries left)`);
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
            } else {
                if (retries === 0) throw contentErr;
            }
        }
    }

    // 🔤 Charset Auto-Fix: Detect non-UTF-8 encoding and re-fetch with correct decoding
    // The browser DOM is always Unicode, so we can't re-decode it. We must re-fetch
    // raw bytes via Node's fetch() and decode them with the correct charset.
    try {
        const charsetMatch = html.match(/<meta[^>]+charset=["']?([^"'\s;>]+)/i)
            || html.match(/charset=([^\s"';>]+)/i);
        if (charsetMatch) {
            const declared = charsetMatch[1].toLowerCase().trim();
            if (declared && !['utf-8', 'utf8'].includes(declared)) {
                console.log(`[CHARSET] Non-UTF-8 encoding detected: ${declared} at ${url}`);
                const rawResponse = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
                    signal: AbortSignal.timeout(15000)
                }).catch(() => null);
                if (rawResponse && rawResponse.ok) {
                    const buffer = await rawResponse.arrayBuffer();
                    try {
                        const decoded = new TextDecoder(declared, { fatal: false }).decode(buffer);
                        if (decoded && decoded.length > 500) {
                            html = decoded;
                            console.log(`[CHARSET] Re-decoded successfully as ${declared}`);
                        }
                    } catch (decodeErr) { /* Unsupported charset label — keep browser-decoded html */ }
                }
            }
        }
    } catch (charsetErr) { /* Non-fatal */ }

    // The settled DOM is always the source of truth. Expansion snapshots can
    // supplement hidden content, but must never replace the target page with a
    // navigation/menu snapshot captured while opening an accordion.
    let combinedHtmlBlocks = [html, ...cumulativeSnapshots];

    // 🕸️ Deep Frame Penetration: Capture full HTML from significant sub-frames
    try {
        // ⏳ Tactical Delay: Government sites often load the law text in an iframe AFTER the main DOM is ready
        // Thorough Gear has already waited for the main DOM. Keep the extra
        // tactical delay only when the page exposes a document-frame structure.
        const hasFrameEvidence = page.frames().length > 1 || await page.evaluate(() => (
            Boolean(document.querySelector('iframe, frame, object[data], embed[src]'))
        )).catch(() => false);
        if (hasFrameEvidence) {
            await page.waitForTimeout(2000).catch(() => {});
        }

        const frames = page.frames();
        if (frames.length > 1) {
            if (addMissionLog) addMissionLog(`🕸️ Penetrating ${frames.length - 1} sub-frames (Auditor v17.13)...`, 'info');
            for (const frame of frames) {
                if (frame === page.mainFrame()) continue;
                try {
                    // Keep the frame-noise policy shared with the fast-path probe.
                    if (isTechnicalFrameUrl(frame.url())) {
                        continue; 
                    }
                    
                    // 🛡️ Strategy: Capture the BODY innerHTML and wrap it.
                    // This forces the extraction engine to treat fragmented law articles (multiple DIVs) as one block.
                    const fBodyHtml = await frame.evaluate(() => {
                        if (!document.body) return '';
                        // Remove script/style inside frame before capturing to save space
                        const clone = document.body.cloneNode(true);
                        clone.querySelectorAll('script, style, noscript, nav, footer, header').forEach(el => el.remove());
                        return clone.innerHTML;
                    }).catch(() => '');

                    if (fBodyHtml && fBodyHtml.length > 500) {
                        combinedHtmlBlocks.push(`<div class="auditor-frame-wrapper" data-source="${frame.url()}">${fBodyHtml}</div>`);
                    }
                } catch (fErr) { }
            }
        }
    } catch (frameErr) { }

    if (!preExtractBrowserRescueText) preExtractBrowserRescueText = await page.evaluate(() => {
        const riskSelectors = '.cmp-tabs, [role="tabpanel"], .cmp-tabs__tabpanel, .tab-content, .panel-group, .accordion, .ecl-accordion';
        const bodyTextLength = (document.body?.textContent || '').trim().length;
        const mainTextLength = (document.querySelector('main, article, [role="main"], #content, .content, .main')?.textContent || '').trim().length;
        const shouldCapture = Boolean(document.querySelector(riskSelectors)) || (mainTextLength > 300 && mainTextLength < 15000 && bodyTextLength < 100000);
        if (!shouldCapture) return '';

        const clone = document.body ? document.body.cloneNode(true) : null;
        if (!clone) return '';
        clone.querySelectorAll('script, style, noscript, svg, template, nav, header, footer, aside, .cookie, [class*="cookie"], [id*="cookie"], [class*="orejime"], [id*="orejime"]').forEach(el => el.remove());
        clone.querySelectorAll('[aria-hidden="true"], [hidden], .collapse, .collapsed, .hidden').forEach(el => {
            el.removeAttribute('aria-hidden');
            el.removeAttribute('hidden');
            el.classList.remove('collapse', 'collapsed', 'hidden');
        });
        // Browser rescue is a last resort. Keep it structural so a local
        // widget with an article-like class cannot be merged into the source.
        const selectors = 'main, article, [role="main"], #content, .content, .main, .cmp-tabs, [role="tabpanel"], .cmp-tabs__tabpanel, .tab-content, .panel-group, .accordion, .ecl-accordion';
        const noiseLine = /^(ir al contenido|skip to content|accesibilidad|aviso legal|pol[ií]tica de cookies|aceptar todas las cookies|rechazar todas las cookies|ver pol[ií]tica de cookies)$/i;
        const seen = new Set();
        const lines = [];
        const pushText = (text = '') => String(text || '')
            .split(/\r?\n+/)
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(line => line.length > 1 && !noiseLine.test(line))
            .forEach(line => {
                const key = line.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                lines.push(line);
            });
        const candidates = Array.from(clone.querySelectorAll(selectors))
            .filter(el => (el.textContent || '').trim().length > 120)
            .sort((a, b) => (b.textContent || '').trim().length - (a.textContent || '').trim().length)
            .slice(0, 8);
        if (candidates.length > 0) candidates.forEach(el => pushText(el.textContent));
        else pushText(clone.textContent || '');
        return lines.join('\n\n').trim();
    }).catch(() => '');

    const extractedResult = await smartExtract(combinedHtmlBlocks, targetUrl, url, { addMissionLog });

    // Player-only frame sets must not influence source selection. Parse the
    // settled parent document independently and retain it when it is the more
    // substantive source. This keeps legitimate document frames untouched.
    const subframes = page.frames().filter(frame => frame !== page.mainFrame());
    const hasOnlyTechnicalSubframes = subframes.length > 0 && subframes.every(frame => isTechnicalFrameUrl(frame.url()));
    if (hasOnlyTechnicalSubframes) {
        const parentOnlyResult = await smartExtract([html], targetUrl, url, { addMissionLog });
        const textLength = (result = {}) => String(result.plainText || result.allText || '')
            .replace(/\s+/g, ' ')
            .trim().length;
        if (textLength(parentOnlyResult) >= 300 && textLength(parentOnlyResult) > textLength(extractedResult)) {
            if (addMissionLog) addMissionLog('Retained settled parent document over technical media-frame content.', 'info');
            return parentOnlyResult;
        }
    }

    // A browser rescue is strictly a recovery path for a genuinely short result.
    // It must never be allowed to replace already-substantive extracted source
    // text with a smaller page fragment (for example, player accessibility text).
    const settledExtractedLength = String(extractedResult?.plainText || extractedResult?.allText || '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_#>`]/g, '')
        .replace(/\s+/g, ' ')
        .trim().length;
    if (settledExtractedLength >= 300) return extractedResult;

    try {
        const normalizeForLength = (value = '') => String(value || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_#>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const extractedLen = normalizeForLength(extractedResult?.plainText || extractedResult?.allText || '').length;
        const rescueLen = normalizeForLength(preExtractBrowserRescueText).length;
        if (preExtractBrowserRescueText && rescueLen > 300 && (extractedLen < 300 || rescueLen > extractedLen * 2.5)) {
            if (addMissionLog) addMissionLog(`🛟 Browser DOM text rescue activated (${extractedLen} -> ${rescueLen} chars).`, 'warn');
            const title = extractedResult?.metadata?.title || intelligentlyResolveTitle(targetUrl, '');
            return finalize({
                ...extractedResult,
                metadata: { ...(extractedResult?.metadata || {}), title, url: targetUrl },
                allText: `# ${title}\nURL: ${targetUrl}\n\n${preExtractBrowserRescueText}`,
                plainText: preExtractBrowserRescueText,
                articleLength: preExtractBrowserRescueText.length
            });
        }
    } catch (_) { }

    if (
        preExtractBrowserRescueText ||
        String(extractedResult?.plainText || extractedResult?.allText || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_#>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim().length >= 300
    ) {
        return extractedResult;
    }

    try {
        const normalizeForLength = (value = '') => String(value || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/[*_#>`]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        const browserRescueText = await page.evaluate(() => {
            const clone = document.body ? document.body.cloneNode(true) : null;
            if (!clone) return '';

            clone.querySelectorAll('script, style, noscript, svg, template, nav, header, footer, aside, .cookie, [class*="cookie"], [id*="cookie"], [class*="orejime"], [id*="orejime"]').forEach(el => el.remove());
            clone.querySelectorAll('[aria-hidden="true"], [hidden], .collapse, .collapsed, .hidden').forEach(el => {
                el.removeAttribute('aria-hidden');
                el.removeAttribute('hidden');
                el.classList.remove('collapse', 'collapsed', 'hidden');
            });

            // Browser rescue is a last resort. Keep it structural so a local
            // widget with an article-like class cannot be merged into the source.
            const selectors = [
                'main', 'article', '[role="main"]', '#content', '.content', '.main',
                '.cmp-tabs', '[role="tabpanel"]', '.cmp-tabs__tabpanel', '.tab-content',
                '.panel-group', '.accordion', '.ecl-accordion'
            ].join(', ');
            const noiseLine = /^(ir al contenido|skip to content|accesibilidad|aviso legal|pol[ií]tica de cookies|aceptar todas las cookies|rechazar todas las cookies|ver pol[ií]tica de cookies)$/i;
            const seen = new Set();
            const lines = [];
            const pushText = (text = '') => {
                String(text || '')
                    .split(/\r?\n+/)
                    .map(line => line.replace(/\s+/g, ' ').trim())
                    .filter(line => line.length > 1 && !noiseLine.test(line))
                    .forEach(line => {
                        const key = line.toLowerCase();
                        if (seen.has(key)) return;
                        seen.add(key);
                        lines.push(line);
                    });
            };

            const candidates = Array.from(clone.querySelectorAll(selectors))
                .filter(el => (el.textContent || '').trim().length > 120)
                .sort((a, b) => (b.textContent || '').trim().length - (a.textContent || '').trim().length)
                .slice(0, 8);

            if (candidates.length > 0) candidates.forEach(el => pushText(el.textContent));
            else pushText(clone.textContent || '');
            return lines.join('\n\n').trim();
        }).catch(() => '');

        const extractedLen = normalizeForLength(extractedResult?.plainText || extractedResult?.allText || '').length;
        const rescueLen = normalizeForLength(browserRescueText).length;
        if (browserRescueText && rescueLen > 300 && (extractedLen < 300 || rescueLen > extractedLen * 2.5)) {
            if (addMissionLog) addMissionLog(`🛟 Browser DOM text rescue activated (${extractedLen} -> ${rescueLen} chars).`, 'warn');
            const title = extractedResult?.metadata?.title || intelligentlyResolveTitle(targetUrl, '');
            return finalize({
                ...extractedResult,
                metadata: { ...(extractedResult?.metadata || {}), title, url: targetUrl },
                allText: `# ${title}\nURL: ${targetUrl}\n\n${browserRescueText}`,
                plainText: browserRescueText,
                articleLength: browserRescueText.length
            });
        }
    } catch (_) { }

    return extractedResult;
} // <-- Ends scrapePage

/**
 * 🧠 Smart Extraction Engine (v16.10 Unified)
 * Unifies Readability, DOM Pruning, Crash-Guards, and Atomic Deduplication
 */
async function smartExtract(htmlContent, url, sourceUrl = null, options = {}) {
    const { addMissionLog } = options;
    const finalUrl = url;
    const linkBaseUrl = sourceUrl || url;
    const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

    let finalMarkdownPieces = [];
    let seenMdParagraphs = new Set();
    let masterTitle = '';

    const blocks = Array.isArray(htmlContent) ? htmlContent : [htmlContent];
    const rawAll = blocks.join(' ').toLowerCase();
    const challengeSignatures = [
        'max challenge attempts exceeded', 'cloudflare', 'enable javascript and cookies',
        'access denied', 'bot detection', 'security verification', 'verify you are not a bot',
        'unauthorized request blocked', 'performing security verification'
    ];

    // Safety Polish: Lowered threshold from 15k to 3k to avoid false positives on legitimate content.
    // Also check page title as a high-confidence signal.
    const hasChallengeText = rawAll.length < 3000 && challengeSignatures.some(sig => rawAll.includes(sig));

    // v16.85 Fix: Check title directly from raw HTML since masterTitle is still empty here
    const titleMatch = rawAll.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const htmlTitle = titleMatch ? titleMatch[1] : '';
    const hasChallengeTitle = /unauthorized request blocked|access denied|cloudflare|just a moment|un momento|bot verification|security check/i.test(htmlTitle);

    if (isBlockedResponseContent(blocks.join(' ')) || hasChallengeText || hasChallengeTitle) {
        throw new Error('BOT_BLOCKED');
    }

    const scoreElement = (el) => {
        const text = el.textContent.trim();
        if (text.length < 100) return 0;
        const pCount = el.querySelectorAll('p').length;
        const liCount = el.querySelectorAll('li').length;
        const tableCount = el.querySelectorAll('table').length;
        const linkCount = el.querySelectorAll('a').length;
        const score = (pCount * 20) + (liCount * 10) + (tableCount * 30) + text.length / 50;
        const linkPenalty = (linkCount * 5);
        return score - linkPenalty;
    };

    const getContainerStats = (el) => {
        const text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
        const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
        const linkCount = el?.querySelectorAll?.('a').length || 0;
        const proseChars = Array.from(el?.querySelectorAll?.('p, blockquote, dd, td, th') || [])
            .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
            .join(' ').length;
        const listItemCount = el?.querySelectorAll?.('li').length || 0;
        return {
            textLength: text.length,
            linkCount,
            listItemCount,
            proseChars,
            linkDensity: linkCount / Math.max(1, words.length / 100)
        };
    };

    const selectPriorityContentContainer = (doc) => {
        const selectors = 'main, article, [role="main"], #content, .content, .main, .panel-group, .accordion, .ecl-accordion, .tab-content, [role="tabpanel"]';
        return Array.from(doc.querySelectorAll(selectors))
            .map((el, index) => {
                const stats = getContainerStats(el);
                const signature = `${el.id || ''} ${el.className || ''}`.toLowerCase();
                const isSemantic = el.matches('main, article, [role="main"]');
                const hasHeading = Boolean(el.querySelector('h1, h2'));
                const isNoise = /(?:modal|dialog|cookie|consent|banner|popup|overlay|menu|navigation|sidebar|footer|header)/i.test(signature)
                    || Boolean(el.closest('[aria-hidden="true"], [hidden], dialog, [role="dialog"], .modal, [class*="modal"], [id*="modal"], .cookie, [class*="cookie"], [class*="consent"]'));
                const isNavigationDominated = stats.linkCount >= 30 && stats.linkDensity >= 8 &&
                    stats.proseChars < Math.min(300, stats.textLength * 0.1);
                if (isNoise || stats.textLength < 120 || (!isSemantic && isNavigationDominated)) return null;

                const hasBodyEvidence = stats.proseChars >= 80 || (isSemantic && hasHeading && stats.listItemCount >= 2);
                const semanticWeight = isSemantic ? 12000 :
                    (el.matches('#content') ? 5000 :
                        (el.matches('.content') ? 3200 : 800));
                const score = semanticWeight + (hasHeading ? 2400 : 0) +
                    Math.min(stats.textLength, 20000) / 20 - (stats.linkDensity * 180) - (index * 0.001);
                return { el, ...stats, isSemantic, hasBodyEvidence, score };
            })
            .filter(Boolean)
            .sort((left, right) => right.score - left.score)[0] || null;
    };

    const normalizePlain = (value = '') => String(value || '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_#>`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const rescueDomTextMarkdown = () => {
        const rescueLines = [];
        const seenLines = new Set();
        let usedVerifiedSourceContainer = false;
        const rescuePrimarySelectors = [
            '.field--name-field-content', '.journal-content-article', '[class*="article-content"]', '[class*="content-article"]', '.article-body', '.entry-content', '[itemprop="articleBody"]', '.container-pages', '#main-content', '[id*="main-content"]'
        ].join(', ');
        const rescueSelectors = [
            rescuePrimarySelectors,
            'main', 'article', '[role="main"]', '#content', '.content', '.main',
            '.cmp-tabs', '[role="tabpanel"]', '.cmp-tabs__tabpanel', '.tab-content',
            '.panel-group', '.accordion', '.ecl-accordion'
        ].join(', ');
        const noiseLine = /^(ir al contenido|skip to content|accesibilidad|aviso legal|pol[ií]tica de cookies|aceptar todas las cookies|rechazar todas las cookies|ver pol[ií]tica de cookies)$/i;

        const pushText = (text = '') => {
            String(text || '')
                .split(/\r?\n+/)
                .map(line => line.replace(/\s+/g, ' ').trim())
                .filter(line => line.length > 1 && !noiseLine.test(line))
                .forEach(line => {
                    const key = line.toLowerCase();
                    if (seenLines.has(key)) return;
                    seenLines.add(key);
                    rescueLines.push(line);
                });
        };

        for (const blockHtml of blocks) {
            if (!blockHtml) continue;
            try {
                const dom = createExtractionDom(blockHtml, { url: finalUrl });
                const doc = dom.window.document;
                doc.querySelectorAll('script, style, noscript, svg, template, nav, header, footer, aside, .cookie, [class*="cookie"], [id*="cookie"], [class*="orejime"], [id*="orejime"]').forEach(el => el.remove());
                doc.querySelectorAll('[aria-hidden="true"], [hidden], .collapse, .collapsed, .hidden').forEach(el => {
                    el.removeAttribute('aria-hidden');
                    el.removeAttribute('hidden');
                    el.classList.remove('collapse', 'collapsed', 'hidden');
                });

                const isNoiseCandidate = (el) => {
                    const signature = `${el.id || ''} ${el.className || ''}`.toLowerCase();
                    return /(?:modal|dialog|cookie|consent|banner|popup|overlay|menu|navigation|sidebar|footer|header)/i.test(signature)
                        || el.closest('[aria-hidden="true"], [hidden], dialog, [role="dialog"], .modal, [class*="modal"], [id*="modal"], .cookie, [class*="cookie"], [class*="consent"]');
                };
                const primaryCandidates = Array.from(doc.querySelectorAll(rescuePrimarySelectors))
                    .filter(el => (el.textContent || '').trim().length > 120 && !isNoiseCandidate(el))
                    .map((el, index) => {
                        const text = (el.textContent || '').trim();
                        const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
                        const linkDensity = el.querySelectorAll('a').length / Math.max(1, words.length / 100);
                        const nestedArticleCount = el.querySelectorAll('.field--name-field-content, .journal-content-article, [class*="article-content"], [class*="content-article"], .article-body, .entry-content, [itemprop="articleBody"]').length;
                        const score =
                            (el.matches('.field--name-field-content, .journal-content-article, [class*="article-content"], [class*="content-article"], .article-body, .entry-content, [itemprop="articleBody"]') ? 9000 : 0) +
                            (el.querySelector('h1, h2') ? 3500 : 0) +
                            (el.matches('#main-content, [id*="main-content"]') ? 2200 : 0) +
                            (Math.min(nestedArticleCount, 4) * 4500) +
                            Math.min(text.length, 20000) / 20 -
                            (linkDensity * 180) -
                            (index * 0.001);
                        return { el, score };
                    })
                    .sort((left, right) => right.score - left.score);
                const priorityCandidate = selectPriorityContentContainer(doc);
                const semanticSourceCandidate = Array.from(doc.querySelectorAll('main, article, [role="main"]'))
                    .map((el, index) => {
                        const stats = getContainerStats(el);
                        const hasHeading = Boolean(el.querySelector('h1, h2'));
                        const hasBodyEvidence = stats.proseChars >= 80 || (hasHeading && stats.listItemCount >= 2);
                        if (isNoiseCandidate(el) || stats.textLength < 120 || !hasBodyEvidence) return null;
                        const semanticWeight = el.matches('article') ? 13000 : 12000;
                        return {
                            el,
                            score: semanticWeight + (hasHeading ? 2400 : 0) + Math.min(stats.textLength, 20000) / 20 - (stats.linkDensity * 180) - (index * 0.001)
                        };
                    })
                    .filter(Boolean)
                    .sort((left, right) => right.score - left.score)[0] || null;
                // A large document can trigger rescue solely because of shared
                // markup. Prefer one semantic source container before merging
                // broad candidates, otherwise a global navigation tree can be
                // appended to every otherwise distinct page.
                const candidates = semanticSourceCandidate
                    ? (() => {
                        usedVerifiedSourceContainer = true;
                        return [semanticSourceCandidate.el];
                    })()
                    : (primaryCandidates.length > 0
                        ? [primaryCandidates[0].el]
                        : (priorityCandidate?.hasBodyEvidence
                        ? (() => {
                            usedVerifiedSourceContainer = true;
                            return [priorityCandidate.el];
                        })()
                        : Array.from(doc.querySelectorAll(rescueSelectors))
                            .filter(el => (el.textContent || '').trim().length > 120)));

                if (candidates.length > 0) {
                    candidates
                        .sort((a, b) => (b.textContent || '').trim().length - (a.textContent || '').trim().length)
                        .slice(0, 8)
                        .forEach(el => pushText(el.textContent));
                } else if (doc.body && (doc.body.textContent || '').trim().length > 120) {
                    pushText(doc.body.textContent);
                }
            } catch (_) { }
        }

        return {
            markdown: rescueLines.join('\n\n').trim(),
            usedVerifiedSourceContainer
        };
    };

    const sanitizeDom = (doc) => {
        ['script', 'style', 'noscript', 'svg', 'template'].forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => el.remove());
        });

        // 🕵️ v16.26 Agnostic Attribute Sniffer (Universal Content Pruning)
        // Targeted at containers that usually hold noise but are often hidden (modals, banners)
        // A hidden IE/legacy-browser notice can sit inside an article-shaped
        // CMS portlet. Remove only hidden compatibility notices, never visible
        // source text that merely discusses browsers.
        const hiddenCompatibilitySelector = '.hide, .hidden, .d-none, .visually-hidden, .sr-only, [hidden], [aria-hidden="true"]';
        const browserCompatibilityNotice = /(?:internet explorer|\bmsie\b|\btrident\b).{0,360}(?:not supported|unsupported|no longer supported|not compatible|nepat\u0159\u00ed.{0,60}podporovan|nen\u00ed.{0,60}podporovan|nicht.{0,60}unterst\u00fctz|non.{0,60}pris en charge|no.{0,60}compatible)/iu;
        doc.querySelectorAll(hiddenCompatibilitySelector).forEach(el => {
            const text = (el.textContent || '').trim();
            if (text.length > 0 && text.length < 1200 && browserCompatibilityNotice.test(text)) el.remove();
        });

        const NOISE_ATTR_REGEXP = /cookie|consent|aviso|legal|modal|banner|sticky|popup|overlay|announcement|newsletter|social|sharing|social-media/i;

        doc.querySelectorAll('div, section, aside, footer, header, nav, dialog').forEach(el => {
            const signature = (el.id + el.className).toLowerCase();
            const textLen = el.textContent.trim().length;

            // Strict Pruning: If it matches a noise signature and isn't massive substantive content
            // v16.26: Increased threshold to 15,000 to handle large cookie descriptions (e.g., Mites.gob.es)
            if (NOISE_ATTR_REGEXP.test(signature) && textLen < 15000) {
                // Ensure we aren't killing a main content block by accident
                const tag = el.tagName.toUpperCase();
                const containsExplicitMainContent = Boolean(el.querySelector('#main-content, [id*="main-content" i], main, [role="main"]'));
                if (tag === 'MAIN' || tag === 'ARTICLE' || containsExplicitMainContent || el.querySelector('article, main')) return;

                el.remove();
            }
        });

        // Fallback HTML can retain a consent overlay without any cookie-shaped
        // class or id. Apply the same content-based, structural-safe removal.
        const consentTermRegex = /(?:\bcookies?\b|kola\u010di\u0107(?:i|ima|e)?|kolacici?)/iu;
        const consentActionRegex = /accept|reject|decline|allow|refuse|settings|preferences|manage|prihva\u0107am|odbijam|postavke/i;
        doc.querySelectorAll('div, section, aside, dialog, [role="dialog"]').forEach(el => {
            const text = (el.textContent || '').trim();
            const isStructuralContent = el.matches('main, article') || el.querySelector('main, article');
            if (!isStructuralContent && text.length > 0 && text.length < 15000 && consentTermRegex.test(text) && consentActionRegex.test(text)) {
                el.remove();
            }
        });

        const boilerplateSelectors = [
            'nav', 'footer', 'aside', 'header', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
            '.navigation', '.menu', '.header', '.footer', '.breadcrumbs', '.breadcrumb', '.skip-link',
            '#cookie-banner', '.cookie-banner', '#cc-window', '[class*="orejime"]', '.orejime-AppContainer',
            '.block-menu', '.region-sidebar-first', '#sidebar-first',
            '#cookies-modal', '.cookie-modal-body', '#avisoUsoCookies'
        ];

        boilerplateSelectors.forEach(selector => {
            doc.querySelectorAll(selector).forEach(el => {
                const tag = el.tagName ? el.tagName.toUpperCase() : '';
                const isStructural = tag === 'MAIN' || tag === 'ARTICLE' || tag === 'BODY' ||
                    el.classList.contains('panel-group') || el.classList.contains('panel') ||
                    el.classList.contains('accordion') || el.classList.contains('ecl-accordion') ||
                    el.classList.contains('ecl-accordion__item');
                if (isStructural) return;

                // 🛡️ v16.26 Noise Immortality Bypass
                // Headings usually trigger "immortality", but NOT if they are inside a known noise block
                const signature = (el.id + el.className + (el.parentElement?.id || '') + (el.parentElement?.className || '')).toLowerCase();
                const isConfirmedNoise = NOISE_ATTR_REGEXP.test(signature) || selector.includes('cookie') || selector.includes('banner');

                if (!isConfirmedNoise && (el.classList.contains('ecl-accordion__title') || el.querySelector('h1, h2, h3, h4'))) return;

                const textLen = el.textContent.trim().length;
                if (textLen === 0) { el.remove(); return; }
                const links = el.querySelectorAll('a');
                const linkDensity = links.length / (textLen / 100);
                const isSemanticBoilerplate = ['NAV', 'FOOTER', 'HEADER', 'ASIDE'].includes(tag) || selector.includes('navigation') || selector.includes('menu');
                const hasLegalTerms = /law|regulation|directive|article|loi|gesetz|legge|lei|wet|statute|decreto|decreet|derecho|limosa|belgium|europa/i.test(el.textContent);

                // 🛡️ v16.11 Specific Widget Kill (Keyword based)
                const widgetSignature = `${el.id || ''} ${el.className || ''}`;
                const isWidget = textLen < 500 && (
                    /accessib(?:ility)?[-_ ]?(?:widget|toolbar|menu)|virtual[-_ ]?keyboard|assistive[-_ ]?toolbar/i.test(widgetSignature) ||
                    /(?:contrast|text size|zoom|font size|keyboard navigation).{0,120}(?:increase|decrease|toggle|open|close|adjust)/i.test(el.textContent)
                );

                if (selector.includes('cookie') || selector.includes('orejime') || isWidget) {
                    el.remove();
                } else if (isSemanticBoilerplate && linkDensity > 4) {
                    el.remove();
                } else if (linkDensity > 18) {
                    el.remove();
                } else if (linkDensity > 5 && textLen < 300 && !hasLegalTerms) {
                    el.remove();
                }
            });
        });
    };

    const findHeadingAnchoredContentContainer = (doc) => {
        const isNoise = (el) => {
            if (!el) return true;
            const signature = `${el.id || ''} ${el.className || ''}`.toLowerCase();
            return /(?:modal|dialog|cookie|consent|banner|popup|overlay|menu|navigation|sidebar|footer|header|widget)/i.test(signature) ||
                Boolean(el.closest('[aria-hidden="true"], [hidden], dialog, [role="dialog"], nav, header, footer, aside, .modal, [class*="modal"], [id*="modal"], .cookie, [class*="cookie"], [class*="consent"]'));
        };

        const candidates = [];
        for (const heading of doc.querySelectorAll('h1, h2')) {
            if (isNoise(heading)) continue;
            const headingWeight = heading.tagName === 'H1' ? 5000 : 2400;
            let container = heading.parentElement;
            for (let distance = 0; container && container !== doc.body && distance < 6; distance++, container = container.parentElement) {
                if (isNoise(container)) continue;
                const text = (container.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.length < 120 || text.length > 60000) continue;
                const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
                const linkDensity = container.querySelectorAll('a').length / Math.max(1, words.length / 100);
                if (linkDensity > 18) continue;
                const bodyNodeCount = container.querySelectorAll('p, li, td, th, dd').length;
                const bodySemanticChars = (Array.from(container.querySelectorAll('p, li, td, th, dd'))
                    .map(el => el.textContent || '')
                    .join(' ')
                    .match(/[\p{L}\p{N}]/gu) || []).length;
                const semanticWeight = container.matches('main, article, [role="main"]') ? 2600 :
                    (container.closest('main, article, [role="main"]') ? 1200 : 0);
                const score = headingWeight + semanticWeight + Math.min(text.length, 18000) / 18 -
                    (linkDensity * 180) - (distance * 260);
                candidates.push({
                    el: container,
                    score,
                    textLength: text.length,
                    hasBodyEvidence: bodyNodeCount > 0 && bodySemanticChars >= 80
                });
            }
        }

        return candidates
            .sort((left, right) => right.score - left.score || left.textLength - right.textLength)[0] || null;
    };

    const findStructuredLinkIndexContainer = (doc) => {
        // Some official portals implement a page-local index as linked cards in
        // #main-content rather than prose. It is still source content, but
        // Readability can prefer a longer shared footer. Limit this recovery to
        // strong structural anchors and card-like links, never generic wrappers.
        const selectors = '#main-content, [id*="main-content" i], main, [role="main"]';
        return Array.from(doc.querySelectorAll(selectors))
            .map((el, index) => {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.length < 120 || text.length > 60000) return null;

                const signature = `${el.id || ''} ${el.className || ''}`.toLowerCase();
                if (/(?:cookie|consent|modal|dialog|banner|footer|header|sidebar)/i.test(signature)) return null;

                const headings = Array.from(el.querySelectorAll('h1, h2, h3, h4'))
                    .map(heading => (heading.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                const links = Array.from(el.querySelectorAll('a[href]'));
                const labelledLinks = links.filter(link => (link.textContent || '').replace(/\s+/g, ' ').trim().length >= 4);
                const cardLinks = links.filter(link => Boolean(link.querySelector('h2, h3, h4, [role="article"]'))).length;
                const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
                const linkDensity = links.length / Math.max(1, words.length / 100);
                const proseChars = Array.from(el.querySelectorAll('p, blockquote, dd, td, th'))
                    .map(node => (node.textContent || '').replace(/\s+/g, ' ').trim())
                    .join(' ').length;

                if (headings.length === 0 || labelledLinks.length < 2 || linkDensity > 28 || proseChars > 360) return null;
                if (cardLinks < 2 && labelledLinks.length < 4) return null;

                return {
                    el,
                    text,
                    linkLabels: labelledLinks.map(link => (link.textContent || '').replace(/\s+/g, ' ').trim()),
                    score: (el.matches('#main-content, [id*="main-content" i]') ? 7000 : 2600) +
                        Math.min(cardLinks, 8) * 700 +
                        Math.min(labelledLinks.length, 24) * 100 +
                        Math.min(text.length, 18000) / 24 -
                        (linkDensity * 80) -
                        (index * 0.001)
                };
            })
            .filter(Boolean)
            .sort((left, right) => right.score - left.score)[0] || null;
    };

    const processBlocks = (blocks) => {
        blocks.forEach(blockHtml => {
            if (!blockHtml) return;

            const processSingleBlock = (blockHtmlInput) => {
                // Uses shared hyperNuclearScrub (v16.74)

                let dom;
                try {
                    dom = createExtractionDom(blockHtmlInput, { url: finalUrl });
                } catch (domErr) {
                    if (addMissionLog) addMissionLog(`[Worker] ☢️ Hyper-Nuclear Scrub (Init) triggered...`, 'warn');
                    dom = createExtractionDom(hyperNuclearScrub(blockHtmlInput), { url: finalUrl });
                }

                const doc = dom.window.document;
                try {
                    doc.querySelectorAll('[aria-hidden="true"], [hidden], .collapse, .collapsed, .hidden').forEach(el => {
                        el.removeAttribute('aria-hidden');
                        el.removeAttribute('hidden');
                        el.classList.remove('collapse', 'collapsed', 'hidden');
                        try {
                            el.style.display = 'block';
                            el.style.visibility = 'visible';
                            el.style.opacity = '1';
                            el.style.height = 'auto';
                        } catch (_) { }
                    });
                } catch (styleErr) {
                    if (addMissionLog) addMissionLog(`[Worker] ☢️ Hyper-Nuclear Scrub (Style) triggered...`, 'warn');
                    return processSingleBlock(hyperNuclearScrub(blockHtmlInput));
                }

                doc.querySelectorAll('.ecl-accordion__title, .panel-title, .accordion-title, .accordion-header').forEach(el => {
                    const cleanText = el.textContent.replace(/\s+/g, ' ').trim();
                    if (cleanText) {
                        const h3 = doc.createElement('h3');
                        h3.textContent = cleanText;
                        el.parentNode.replaceChild(h3, el);
                    }
                });

                sanitizeDom(doc);

                let curArticle = null;
                try {
                    const reader = new Readability(doc.cloneNode(true));
                    curArticle = reader.parse();
                } catch (crashErr) {
                    doc.querySelectorAll('*').forEach(el => { try { el.removeAttribute('style'); } catch (_) { } });
                    const reader = new Readability(doc.cloneNode(true));
                    curArticle = reader.parse();
                }

                let contentToUse = curArticle ? curArticle.content : null;
                // CMS article containers are stronger evidence than Readability's
                // length-based guess. A large shared navigation menu can otherwise
                // outscore a concise, page-specific official notice.
                const primaryContentSelectors = '.field--name-field-content, .journal-content-article, [class*="article-content"], [class*="content-article"], .article-body, .entry-content, [itemprop="articleBody"], .container-pages, #main-content, [id*="main-content"]';
                const primaryArticleSelectors = '.field--name-field-content, .journal-content-article, [class*="article-content"], [class*="content-article"], .article-body, .entry-content, [itemprop="articleBody"]';
                const primaryContentCandidate = Array.from(doc.querySelectorAll(primaryContentSelectors))
                    .map((el, index) => {
                        const text = (el.textContent || '').trim();
                        const signature = `${el.id || ''} ${el.className || ''}`.toLowerCase();
                        const words = text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
                        const linkDensity = el.querySelectorAll('a').length / Math.max(1, words.length / 100);
                        const nestedArticleCount = el.querySelectorAll(primaryArticleSelectors).length;
                        const isNoise = /(?:modal|dialog|cookie|consent|banner|popup|overlay|menu|navigation|sidebar|footer|header)/i.test(signature)
                            || el.closest('[aria-hidden="true"], [hidden], dialog, [role="dialog"], .modal, [class*="modal"], [id*="modal"], .cookie, [class*="cookie"], [class*="consent"]');
                        if (isNoise || text.length < 120) return null;

                        const score =
                            (el.matches(primaryArticleSelectors) ? 9000 : 0) +
                            (el.querySelector('h1, h2') ? 3500 : 0) +
                            (el.matches('#main-content, [id*="main-content"]') ? 2200 : 0) +
                            (Math.min(nestedArticleCount, 4) * 4500) +
                            Math.min(text.length, 20000) / 20 -
                            (linkDensity * 180) -
                            (index * 0.001);
                        return { el, score, textLength: text.length, nestedArticleCount };
                    })
                    .filter(Boolean)
                    .sort((left, right) => right.score - left.score)[0] || null;
                const primaryContentContainer = primaryContentCandidate?.el || null;
                const priorityCandidate = selectPriorityContentContainer(doc);
                const priorityContainer = priorityCandidate?.el || null;
                const headingAnchoredCandidate = findHeadingAnchoredContentContainer(doc);
                const structuredLinkIndexCandidate = findStructuredLinkIndexContainer(doc);
                const currentArticleLength = (curArticle?.textContent || '').trim().length;
                const currentArticleText = (curArticle?.textContent || '').replace(/\s+/g, ' ').trim();
                const currentLooksLikeTemplate = /(?:registered on wpml\.org as a development site|website is developed within (?:the )?project|co-funded by (?:the )?european social fund|accessibility (?:system|widget)|press (?:ctrl|control)[+\- ]?f1[01])/i.test(currentArticleText) && currentArticleLength < 1800;
                let currentArticleStats = null;
                if (curArticle?.content) {
                    try {
                        const articleDom = createExtractionDom(`<body>${curArticle.content}</body>`);
                        currentArticleStats = getContainerStats(articleDom.window.document.body);
                    } catch (_) { }
                }
                const currentLooksNavigationDominated = currentArticleStats && priorityCandidate?.hasBodyEvidence &&
                    currentArticleStats.linkCount >= 30 && currentArticleStats.linkDensity >= 8 && (
                        priorityCandidate.linkDensity < currentArticleStats.linkDensity * 0.55 ||
                        currentArticleStats.textLength > priorityCandidate.textLength * 3
                    );
                const currentLooksLikeSharedChrome = currentArticleStats &&
                    currentArticleStats.linkCount >= 8 &&
                    currentArticleStats.linkDensity >= 6 &&
                    currentArticleStats.proseChars < Math.max(220, currentArticleStats.textLength * 0.22) &&
                    /(?:\u00a9|all rights reserved|facebook|instagram|linkedin|twitter|youtube|call\s+(?:centre|center)|site map|mapa str[aá]nek)/iu.test(currentArticleText);
                const structuredLabelsPresentInArticle = structuredLinkIndexCandidate
                    ? structuredLinkIndexCandidate.linkLabels
                        .slice(0, 12)
                        .filter(label => {
                            const normalizedLabel = normalizePlain(label).toLocaleLowerCase();
                            return normalizedLabel.length >= 8 && currentArticleText.toLocaleLowerCase().includes(normalizedLabel);
                        }).length
                    : 0;
                const structuredIndexMissingFromArticle = structuredLinkIndexCandidate &&
                    structuredLabelsPresentInArticle < Math.min(2, structuredLinkIndexCandidate.linkLabels.length);
                const structuredIndexIsMateriallyCleaner = structuredLinkIndexCandidate &&
                    currentArticleLength > Math.max(900, structuredLinkIndexCandidate.text.length * 1.8);
                const semanticBodyIsMateriallyCleaner = priorityCandidate?.isSemantic && priorityCandidate.hasBodyEvidence &&
                    currentArticleLength >= 10000 && currentArticleLength > priorityCandidate.textLength * 5;

                // Liferay can reuse a legitimate article class for small shared footer
                // portlets. Do not let that chrome outrank a page-local source container.
                // This is intentionally narrow: a candidate must have several social
                // destinations, a footer marker, and virtually no prose body.
                let primaryLooksLikeSharedChrome = false;
                if (primaryContentContainer) {
                    const primaryStats = getContainerStats(primaryContentContainer);
                    const primaryText = (primaryContentContainer.textContent || '').replace(/\s+/g, ' ').trim();
                    const primarySocialDestinations = new Set(
                        Array.from(primaryContentContainer.querySelectorAll('a[href]'))
                            .map(link => link.getAttribute('href') || '')
                            .filter(href => /(?:facebook|instagram|linkedin|twitter|youtube)\.com/i.test(href))
                    ).size;
                    const primaryHasFooterMarker = /(?:©|all rights reserved|call\s+(?:centre|center)|site map|mapa str[aá]nek)/iu.test(primaryText);
                    primaryLooksLikeSharedChrome = primaryText.length <= 2500 &&
                        primaryStats.linkCount >= 8 &&
                        primaryStats.proseChars < Math.max(260, primaryStats.textLength * 0.25) &&
                        primarySocialDestinations >= 2 &&
                        primaryHasFooterMarker;
                }

                const primaryIsDedicatedArticle = primaryContentContainer?.matches(primaryArticleSelectors) && !primaryLooksLikeSharedChrome;
                const primaryCombinesArticles = (primaryContentCandidate?.nestedArticleCount || 0) >= 2;
                const headingCanRepair = headingAnchoredCandidate?.hasBodyEvidence &&
                    (currentArticleLength < 600 || currentLooksLikeTemplate);
                const headingIsMateriallyRicher = headingAnchoredCandidate?.hasBodyEvidence &&
                    headingAnchoredCandidate.textLength > Math.max(900, currentArticleLength * 1.8);

                if (primaryContentContainer && primaryIsDedicatedArticle && primaryContentContainer.textContent.trim().length >= 120) {
                    contentToUse = primaryContentContainer.innerHTML;
                } else if (primaryContentContainer && primaryCombinesArticles && primaryContentCandidate.textLength >= 120) {
                    contentToUse = primaryContentContainer.innerHTML;
                } else if (headingCanRepair || headingIsMateriallyRicher) {
                    // Heading-based repair is gated by paragraph/list/table evidence and
                    // only replaces a weak/template extraction or a much smaller article.
                    contentToUse = headingAnchoredCandidate.el.innerHTML;
                } else if (structuredLinkIndexCandidate && (
                    currentLooksLikeSharedChrome ||
                    structuredIndexMissingFromArticle ||
                    structuredIndexIsMateriallyCleaner
                )) {
                    // A page-local, card-shaped index is stronger evidence than a
                    // Readability result made of the site's shared footer chrome.
                    contentToUse = structuredLinkIndexCandidate.el.innerHTML;
                } else if (primaryContentContainer && currentArticleLength < 600 && primaryContentCandidate.textLength >= 120) {
                    contentToUse = primaryContentContainer.innerHTML;
                } else if (priorityCandidate?.hasBodyEvidence && (!curArticle || currentArticleLength < 600 || currentLooksLikeTemplate || currentLooksNavigationDominated || semanticBodyIsMateriallyCleaner)) {
                    // Readability can prefer a long navigation tree over a concise,
                    // semantic source body. Replace it only when the selected body
                    // has paragraph/table evidence or is a headed official index.
                    contentToUse = priorityContainer.innerHTML;
                } else if (priorityContainer && (!curArticle || priorityContainer.textContent.trim().length > (curArticle?.textContent || '').trim().length * 1.5)) {
                    contentToUse = priorityContainer.innerHTML;
                } else if (!curArticle || curArticle.textContent.trim().length < 500) {
                    const candidates = Array.from(doc.querySelectorAll('main, article, section, div, #content, .content, .main'))
                        .map(el => ({ el, score: scoreElement(el) }))
                        .sort((a, b) => b.score - a.score);
                    if (candidates.length > 0 && candidates[0].score > 50) contentToUse = candidates[0].el.innerHTML;
                }

                if (!contentToUse) contentToUse = blockHtmlInput;
                if (curArticle && curArticle.title && !masterTitle) masterTitle = curArticle.title;

                const blockMd = turndownService.turndown(contentToUse);
                const pSplit = blockMd.split(/\n\n+/);
                pSplit.forEach(p => {
                    const cleanP = p.trim();
                    if (!cleanP) return;
                    const plainTextMatch = cleanP.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const minLen = 10;
                    if (plainTextMatch.length > minLen && !seenMdParagraphs.has(plainTextMatch)) {
                        seenMdParagraphs.add(plainTextMatch);
                        finalMarkdownPieces.push(cleanP);
                    }
                });
            };

            try {
                processSingleBlock(blockHtml);
            } catch (topErr) {
                const hyperNuclearSimple = (h) => {
                    if (!h) return h;
                    return h.replace(/border-width/gi, 'x-bw').replace(/inherit/gi, 'x-inh').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/\sstyle\s*=\s*((['"])(?:(?!\2)[\s\S])*?\2)/gi, '');
                };
                try {
                    processSingleBlock(hyperNuclearSimple(blockHtml));
                } catch (_) {
                    // Absolute fallback: extract text via Turndown (no JSDOM) if even Hyper-Nuclear scrub dies
                    finalMarkdownPieces.push(turndownService.turndown(blockHtml));
                }
            }
        });
    };

    processBlocks(blocks);

    let markdown = finalMarkdownPieces.length > 0 ? finalMarkdownPieces.join('\n\n') : 'No content harvested.';
    const recoverHeadingBoundContentWidgetMarkdown = (currentPlain = '') => {
        const contentWidgetSelector = [
            '.elementor-widget-theme-post-content',
            '[class*="post-content"]',
            '[class*="entry-content"]',
            '[class*="article-content"]',
            '[itemprop="articleBody"]'
        ].join(', ');
        const isUnsafe = (element) => {
            if (!element) return true;
            const signature = `${element.id || ''} ${element.className || ''}`.toLowerCase();
            return /(?:modal|dialog|cookie|consent|banner|popup|overlay|menu|navigation|sidebar|footer|header|accessib|assistive|toolbar|virtual[-_ ]?keyboard)/i.test(signature) ||
                Boolean(element.closest('nav, header, footer, aside, [role="navigation"], [role="dialog"], .cookie, [class*="cookie"], [class*="consent"]'));
        };

        for (const blockHtml of blocks) {
            if (!blockHtml) continue;
            try {
                const dom = createExtractionDom(blockHtml, { url: finalUrl });
                const doc = dom.window.document;
                for (const heading of doc.querySelectorAll('h1')) {
                    if (isUnsafe(heading)) continue;
                    const title = (heading.textContent || '').replace(/\s+/g, ' ').trim();
                    if (title.length < 4) continue;
                    const normalizedTitle = normalizePlain(title).toLocaleLowerCase();
                    // A heading already represented in the extracted text belongs to
                    // the current candidate, not an omitted source body to recover.
                    if (normalizedTitle && currentPlain.toLocaleLowerCase().includes(normalizedTitle)) continue;
                    const structuralSourceContainer = heading.closest('main, article, [role="main"]');
                    if (!isUnsafe(structuralSourceContainer) && (structuralSourceContainer?.textContent || '').replace(/\s+/g, ' ').trim().length >= 40) {
                        const recoveredMarkdown = turndownService.turndown(structuralSourceContainer.outerHTML).trim();
                        if (normalizePlain(recoveredMarkdown).length >= 45) return { title, markdown: recoveredMarkdown };
                    }
                    let container = heading.parentElement;
                    for (let distance = 0; container && container !== doc.body && distance < 6; distance++, container = container.parentElement) {
                        if (isUnsafe(container)) continue;
                        const contentWidget = Array.from(container.querySelectorAll(contentWidgetSelector))
                            .find(widget => !isUnsafe(widget) && (widget.textContent || '').replace(/\s+/g, ' ').trim().length >= 40);
                        if (!contentWidget) continue;

                        const outline = `${heading.outerHTML}\n${contentWidget.outerHTML}`;
                        const recoveredMarkdown = turndownService.turndown(outline).trim();
                        if (normalizePlain(recoveredMarkdown).length >= 45) return { title, markdown: recoveredMarkdown };
                    }
                }
            } catch (_) { }
        }
        return null;
    };

    // Some CMS page indexes have no prose article: their authoritative content is
    // an H1 plus a small post-content widget of links. If Readability omitted that
    // H1 or selected shared chrome beside it, retain only the bound source widget.
    const currentPlainBeforeWidgetRecovery = normalizePlain(markdown);
    let usedHeadingBoundWidgetRecovery = false;
    if (currentPlainBeforeWidgetRecovery.length < 1800) {
        const widgetRecovery = recoverHeadingBoundContentWidgetMarkdown(currentPlainBeforeWidgetRecovery);
        const recoveredPlainLength = widgetRecovery ? normalizePlain(widgetRecovery.markdown).length : 0;
        const recoveredTitle = widgetRecovery ? normalizePlain(widgetRecovery.title).toLocaleLowerCase() : '';
        const currentHasRecoveredTitle = recoveredTitle.length >= 4 &&
            currentPlainBeforeWidgetRecovery.toLocaleLowerCase().includes(recoveredTitle);
        // Do not replace a concise but valid source body. This recovery exists only
        // for a missing source heading plus a materially better bound CMS widget.
        const recoveryIsMateriallyBetter = currentPlainBeforeWidgetRecovery.length < 300 ||
            recoveredPlainLength >= Math.ceil(currentPlainBeforeWidgetRecovery.length * 1.15);
        if (widgetRecovery && !currentHasRecoveredTitle && recoveryIsMateriallyBetter) {
            if (addMissionLog) addMissionLog(`🧭 H1-bound content widget recovery activated (${currentPlainBeforeWidgetRecovery.length} -> ${normalizePlain(widgetRecovery.markdown).length} chars).`, 'warn');
            markdown = widgetRecovery.markdown;
            usedHeadingBoundWidgetRecovery = true;
        }
    }
    const markdownPlainLength = normalizePlain(markdown).length;
    const rawHtmlLength = blocks.reduce((total, block) => total + String(block || '').length, 0);
    if (!usedHeadingBoundWidgetRecovery && (markdownPlainLength < 300 || rawHtmlLength >= 250000)) {
        const rescueResult = rescueDomTextMarkdown();
        const rescuedMarkdown = rescueResult.markdown;
        const rescuedPlainLength = normalizePlain(rescuedMarkdown).length;
        const markdownWords = normalizePlain(markdown).match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
        const markdownLinkCount = (markdown.match(/\]\([^)]+\)/g) || []).length;
        const markdownLinkDensity = markdownLinkCount / Math.max(1, markdownWords.length / 100);
        const markdownLooksNavigationDominated = markdownLinkCount >= 30 && markdownLinkDensity >= 8;
        const verifiedSourceIsMateriallyCleaner = rescueResult.usedVerifiedSourceContainer &&
            rawHtmlLength >= 250000 &&
            markdownPlainLength >= 10000 &&
            markdownPlainLength > rescuedPlainLength * 5;
        const rescueNeeded = markdownPlainLength < 300 || (
            rescuedPlainLength >= 10000 && rescuedPlainLength > markdownPlainLength * 8
        ) || (
            // A concise semantic source body is stronger evidence than a much
            // longer shared navigation tree. This only applies after the rescue
            // found a verified source container, never to broad generic fallback.
            rescueResult.usedVerifiedSourceContainer &&
            markdownLooksNavigationDominated &&
            rescuedPlainLength > 300
        ) || verifiedSourceIsMateriallyCleaner;
        if (rescueNeeded && rescuedPlainLength > 300) {
            if (addMissionLog) addMissionLog(`🛟 DOM text rescue activated (${markdownPlainLength} -> ${rescuedPlainLength} chars).`, 'warn');
            markdown = rescuedMarkdown;
        }
    }
    const resolvedTitle = intelligentlyResolveTitle(finalUrl, masterTitle || '');
    const discoveredLinks = extractLinksFromDom(blocks[0], linkBaseUrl);

    return finalize({
        metadata: { title: resolvedTitle, description: '', author: '', url: finalUrl },
        allText: `# ${resolvedTitle}\nURL: ${finalUrl}\n\n${markdown}`,
        plainText: markdown,
        discoveredLinks
    });
}

async function scrapePDF(url, browser, addMissionLog = null) {
    let buffer;
    if (url.startsWith('chrome-extension://')) {
        url = url.replace(/^chrome-extension:\/\/[a-z]+\//, '');
    }
    // 🛡️ Defensive Normalization: Ensure symbols and accents are properly encoded for sensitive servers
    try { url = new URL(url).href; } catch (e) { }

    try {
        let response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(30000)
        });
        let contentType = response.headers.get('content-type') || '';
        let contentLang = response.headers.get('content-language') || '';
        if (response.ok && contentType.toLowerCase().includes('text/html')) {
            response = await fetch(url, {
                headers: { 'Accept': 'application/pdf,application/octet-stream' },
                signal: AbortSignal.timeout(30000)
            });
            contentType = response.headers.get('content-type') || '';
            contentLang = response.headers.get('content-language') || '';
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const isPdfUrl = url.toLowerCase().split('?')[0].split('#')[0].endsWith('.pdf') || url.toLowerCase().includes('.pdf');

        // 🛡️ v16.86: PDF Challenge Detection
        // If we get HTML instead of PDF on a document URL, check for bot challenge signatures
        if (contentType.toLowerCase().includes('text/html')) {
            const rawBody = await response.text();
            const documentIssue = classifyContentValidity({ metadata: { url }, allText: rawBody }, { url });
            if (documentIssue) throw createUnusableContentError(documentIssue);
            const signatures = [
                'max challenge attempts exceeded', 'cloudflare', 'enable javascript',
                'verify you are not a bot', 'access denied', 'security verification', 'security check'
            ];
            const isChallenge = rawBody.length < 5000 && signatures.some(sig => rawBody.toLowerCase().includes(sig));
            if (isChallenge) throw new Error('BOT_BLOCKED');
            if (!isPdfUrl) throw new Error(`Expected PDF but got ${contentType}`);
            // If it's a PDF URL but we got HTML that isn't a challenge, it might be a viewer wrapper.
            // (buffer assignment will fail later if not handled)
        }
        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        if (contentLength > 50 * 1024 * 1024) throw new Error(`PDF exceeds memory safety limit.`);

        // 🛡️ v16.43: Robust ArrayBuffer with timeout to prevent streaming deadlocks
        const bufferController = new AbortController();
        const bufferTimeout = setTimeout(() => bufferController.abort(), 60000);
        try {
            buffer = Buffer.from(await response.arrayBuffer());
        } finally { clearTimeout(bufferTimeout); }

        if (buffer.length < 100) throw new Error('PDF buffer too small');
        buffer.langHint = contentLang;
    } catch (e) {
        const is404 = e.message.includes('HTTP 404') || e.message.includes('HTTP 410');
        if (browser && !is404) buffer = await performGhostDownload(url, browser, addMissionLog);
        else throw e;
    }
    try {
        let data;
        try { data = await pdf(buffer); } catch (pdfErr) {
            if (browser && !url.includes('ghost=true')) {
                buffer = await performGhostDownload(url + (url.includes('?') ? '&' : '?') + 'ghost=true', browser, addMissionLog);
                data = await pdf(buffer);
            } else throw pdfErr;
        }
        let finalOutput = data.text;
        const isDigital = (() => {
            const text = data.text.substring(0, 5000);
            const total = text.length;
            if (total < 100) return false;
            const gibberish = (text.match(MOJIBAKE_REGEX) || []).length;
            return (gibberish / total <= 0.3);
        })();
        const shouldSkipOCRForParsedText = hasSufficientParsedPdfText(data);
        if (!isDigital && shouldSkipOCRForParsedText && addMissionLog) {
            addMissionLog(`📄 Parsed PDF text looks sufficient. Skipping OCR and keeping pdf-parse output.`, 'info');
        }
        if (!isDigital && !shouldSkipOCRForParsedText && browser) {
            await withOcrDocumentSlot(addMissionLog, async () => {
            const preferredLangs = buildOcrLanguagePreference(url, buffer.langHint || '');
            const fallbackLangs = normalizeOcrLangs('eng+spa');
            let scheduler = null;
            let page = null;

            try {
                try {
                    scheduler = await getOCRParallel(preferredLangs, addMissionLog);
                } catch (ocrInitErr) {
                    if (preferredLangs !== fallbackLangs) {
                        if (addMissionLog) addMissionLog(`⚠️ OCR init failed for ${preferredLangs}. Retrying with ${fallbackLangs}...`, 'warn');
                        scheduler = await getOCRParallel(fallbackLangs, addMissionLog);
                    } else {
                        throw ocrInitErr;
                    }
                }

                page = await browser.newPage();
                const base64Pdf = buffer.toString('base64');

                if (!OCR_ASSETS.pdfJs) {
                    OCR_ASSETS.pdfJs = fs.readFileSync(path.join(process.cwd(), 'public', 'pdf.min.js'), 'utf8');
                    OCR_ASSETS.pdfWorker = fs.readFileSync(path.join(process.cwd(), 'public', 'pdf.worker.min.js'), 'utf8');
                }

                await page.setContent(`<html><body><script>${OCR_ASSETS.pdfJs}</script><script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'data:text/javascript;base64,${Buffer.from(OCR_ASSETS.pdfWorker).toString('base64')}'; 
                    window.docPromise = null;
                    window.render = async (b, n) => { 
                        if (!window.docPromise) window.docPromise = pdfjsLib.getDocument({data: atob(b)}).promise;
                        const d = await window.docPromise;
                        const p = await d.getPage(n); 
                        const v = p.getViewport({scale: 2}); 
                        const c = document.createElement('canvas'); 
                        const x = c.getContext('2d'); 
                        c.height = v.height; c.width = v.width; 
                        await p.render({canvasContext: x, viewport: v}).promise; 
                        
                        // 🎨 v16.65: Grayscale & High Contrast Pre-Processing
                        // This reduces memory by ~60% and improves OCR accuracy for text
                        const id = x.getImageData(0, 0, c.width, c.height);
                        const dts = id.data;
                        for (let i = 0; i < dts.length; i += 4) {
                            const avg = (dts[i] + dts[i + 1] + dts[i + 2]) / 3;
                            // Aggressive Thresholding for cleaner text (Tesseract loves this)
                            const val = avg < 180 ? 0 : 255; 
                            dts[i] = val; dts[i + 1] = val; dts[i + 2] = val;
                        }
                        x.putImageData(id, 0, 0);

                        const dataUrl = c.toDataURL('image/png');
                        c.width = 1; c.height = 1; // Atomic memory cleanup
                        return dataUrl;
                    };
                </script></body></html>`);

                const sourcePages = data.numpages || 1;
                const totalPages = OCR_MAX_PAGES > 0 ? Math.min(sourcePages, OCR_MAX_PAGES) : sourcePages;
                if (addMissionLog) {
                    const capNote = OCR_MAX_PAGES > 0 && sourcePages > totalPages ? ` (capped from ${sourcePages} by SCRAPERITO_OCR_MAX_PAGES)` : '';
                    addMissionLog(`🚚 [Elmo's moving company] Starting delivery of ${totalPages} pages${capNote}...`, 'info');
                }
                let pagesCompleted = 0;

                const results = [];
                for (let batchStart = 1; batchStart <= totalPages; batchStart += OCR_PAGE_CONCURRENCY) {
                    const batchEnd = Math.min(totalPages, batchStart + OCR_PAGE_CONCURRENCY - 1);
                    const jobPromises = [];
                    for (let i = batchStart; i <= batchEnd; i++) {
                        const jobPromise = (async () => {
                            try {
                                if (addMissionLog && (i === 1 || i % 5 === 0 || i === totalPages)) {
                                    addMissionLog(`📦 [Elmo's moving company] Moving Page ${i}/${totalPages}...`, 'info');
                                }
                                const imageData = await page.evaluate(({ b, n }) => window.render(b, n), { b: base64Pdf, n: i });
                                const { data: { text } } = await scheduler.addJob('recognize', imageData);
                                pagesCompleted++;
                                if (addMissionLog) addMissionLog(`✅ [Elmo's moving company] Page ${i}/${totalPages} delivered! (${pagesCompleted}/${totalPages} done)`, 'info');
                                return { i, text };
                            } catch (_) {
                                pagesCompleted++;
                                return { i, text: '' };
                            }
                        })();
                        jobPromises.push(jobPromise);
                    }
                    results.push(...await Promise.all(jobPromises));
                }
                results.sort((a, b) => a.i - b.i);
                const ocrOutput = results.map(r => `\n--- PAGE ${r.i} ---\n${r.text}`).join('\n').trim();

                if (ocrOutput.replace(/\s+/g, '').length > 0) {
                    if (addMissionLog) addMissionLog(`🏁 [Elmo's moving company] All ${totalPages} pages delivered successfully.`, 'success');
                    finalOutput = ocrOutput;
                } else if (addMissionLog) {
                    addMissionLog(`⚠️ OCR returned empty text. Keeping parsed PDF text instead.`, 'warn');
                }
            } catch (ocrErr) {
                if (addMissionLog) addMissionLog(`⚠️ OCR failed for this PDF (${ocrErr.message}). Keeping parsed PDF text.`, 'warn');
            } finally {
                if (page) await page.close().catch(() => { });
            }
            });
        }
        const metadata = { title: data.info?.Title || url.split('/').pop(), url };
        return { metadata, allText: finalOutput, plainText: finalOutput, pdfBuffer: buffer };
    } catch (e) { throw e; }
}

async function performGhostDownload(url, browser, addMissionLog = null) {
    const page = await browser.newPage();
    if (addMissionLog) addMissionLog(`👻 Deploying Ghost Download for: ${url}`, 'info');

    try {
        let downloadBuffer = null;
        let downloadFailure = null;

        // Strategy A: Listen for 'download' events (attachment disposition)
        safePageOn(page, 'download', async (download) => {
            try {
                downloadBuffer = await withTempFile('temp_pdf_download', 'pdf', async (temp) => {
                    await download.saveAs(temp);
                    return fs.readFileSync(temp);
                });
            } catch (err) {
                downloadFailure = err;
                if (addMissionLog) addMissionLog(`Ghost download event failed: ${err.message}`, 'warn');
            }
        }, addMissionLog, 'Ghost PDF download');

        // Strategy B: Listen for PDF responses (inline disposition)
        safePageOn(page, 'response', async (res) => {
            try {
                const ct = res.headers()['content-type'] || '';
                if (ct.toLowerCase().includes('pdf') && res.status() === 200) {
                    downloadBuffer = await res.body();
                }
            } catch (e) { }
        }, addMissionLog, 'Ghost PDF response');

        // Strategy C: Handle navigation with WAF wait
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => {
            if (!e.message.includes('Download is starting')) throw e;
        });

        // Polling loop for async buffers
        for (let i = 0; i < 20 && !downloadBuffer; i++) {
            await new Promise(r => setTimeout(r, 500));
        }

        if (downloadBuffer) {
            if (addMissionLog) addMissionLog(`✅ Ghost captured PDF (${downloadBuffer.length} bytes)`, 'success');
            return downloadBuffer;
        }

        if (downloadFailure) throw downloadFailure;
        throw new Error("No PDF buffer captured after navigation/download.");
    } catch (err) {
        throw new Error(`Ghost Download failed: ${err.message}`);
    } finally {
        await page.close().catch(() => { });
    }
}

async function scrapeWord(url) {
    try {
        // 🛡️ Normalization
        try { url = new URL(url).href; } catch (e) { }

        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
            signal: AbortSignal.timeout(45000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (isDocxBuffer(buffer)) {
            const mammoth = require('mammoth');
            const result = await mammoth.convertToHtml({ buffer });
            const markdown = new TurndownService().turndown(result.value);
            const finalResult = finalize({ metadata: { title: url.split('/').pop(), url }, allText: markdown, plainText: markdown });
            finalResult.docxBuffer = buffer; // Preserve original OOXML bytes for metadata enrichment.
            return finalResult;
        }
        if (isLegacyDocBuffer(buffer)) {
            const plainText = await extractLegacyDocText(buffer);
            const finalResult = finalize({ metadata: { title: url.split('/').pop(), url }, allText: plainText, plainText });
            finalResult.legacyDocBuffer = buffer;
            return finalResult;
        }
        throw new Error('Downloaded buffer is not a valid DOCX or legacy .doc document');
    } catch (err) { throw new Error(`Word Extraction Failed: ${err.message}`); }
}

async function scrapeWordViaTrawl(url, browserOrLog = null, maybeAddMissionLog = null) {
    const mammoth = require('mammoth');
    const browser = typeof browserOrLog === 'function' ? null : browserOrLog;
    const addMissionLog = typeof browserOrLog === 'function' ? browserOrLog : maybeAddMissionLog;
    if (addMissionLog) addMissionLog(`Trawl Word download for: ${url}`, 'info');
    const solverUrl = getTrawlSolverUrl();
    let solveUrl = url;
    try {
        const parsed = new URL(url);
        solveUrl = `${parsed.origin}/`;
    } catch (_) { }

    const sessionResponse = await fetch(solverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cmd: 'request.get',
            url: solveUrl,
            maxTimeout: 60000
        }),
        signal: AbortSignal.timeout(70000)
    });

    if (!sessionResponse.ok) throw new Error(`Trawl returned HTTP ${sessionResponse.status}`);
    const solved = await sessionResponse.json();
    if (solved.status === 'error') throw new Error(`Trawl solver error: ${solved.message}`);

    const solution = solved.solution || {};
    const cookieHeader = Array.isArray(solution.cookies)
        ? solution.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
        : '';
    const userAgent = solution.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

    if (browser && Array.isArray(solution.cookies) && solution.cookies.length > 0) {
        let context = null;
        let page = null;
        try {
            context = await browser.newContext({
                userAgent,
                extraHTTPHeaders: {
                    Accept: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,*/*'
                }
            });
            await context.addCookies(solution.cookies.map(cookie => ({
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || new URL(url).hostname,
                path: cookie.path || '/',
                expires: typeof cookie.expiry === 'number' ? cookie.expiry : (typeof cookie.expires === 'number' ? cookie.expires : -1),
                httpOnly: Boolean(cookie.httpOnly),
                secure: cookie.secure !== false,
                sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : 'Lax'
            })));

            page = await context.newPage();
            let downloadBuffer = null;
            let downloadFailure = null;
            safePageOn(page, 'download', async (download) => {
                try {
                    downloadBuffer = await withTempFile('temp_trawl_word', 'docx', async (temp) => {
                        await download.saveAs(temp);
                        return fs.readFileSync(temp);
                    });
                } catch (err) {
                    downloadFailure = err;
                    if (addMissionLog) addMissionLog(`Trawl Word download event failed: ${err.message}`, 'warn');
                }
            }, addMissionLog, 'Trawl Word download');
            safePageOn(page, 'response', async (res) => {
                try {
                    const ct = (res.headers()['content-type'] || '').toLowerCase();
                    if (res.status() === 200 && (ct.includes('officedocument.wordprocessingml.document') || ct.includes('msword') || res.url().toLowerCase().includes('.docx'))) {
                        const body = await res.body().catch(() => null);
                        if (body && body.length > 100) downloadBuffer = body;
                    }
                } catch (_) { }
            }, addMissionLog, 'Trawl Word response');

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
                if (!err.message.includes('Download is starting') && !err.message.includes('Timeout')) throw err;
            });
            for (let i = 0; i < 40 && !downloadBuffer; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            if (downloadBuffer && isDocxBuffer(downloadBuffer)) {
                const result = await mammoth.convertToHtml({ buffer: downloadBuffer });
                const turndown = new TurndownService();
                const markdown = turndown.turndown(result.value);
                if (addMissionLog) addMissionLog(`Trawl browser Word captured (${downloadBuffer.length} bytes)`, 'success');
                const finalResult = finalize({ metadata: { title: url.split('/').pop(), url }, allText: markdown, plainText: markdown });
                finalResult.docxBuffer = downloadBuffer;
                return finalResult;
            }
            if (downloadFailure) throw downloadFailure;
        } catch (browserErr) {
            if (addMissionLog) addMissionLog(`Trawl browser Word path failed: ${browserErr.message}. Trying cookie fetch...`, 'warn');
        } finally {
            if (page) await page.close().catch(() => { });
            if (context) await context.close().catch(() => { });
        }
    }

    const response = await fetch(url, {
        headers: {
            'User-Agent': userAgent,
            'Accept': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,*/*',
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
        },
        signal: AbortSignal.timeout(45000)
    });

    if (!response.ok) throw new Error(`Trawl cookie download returned HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!isDocxBuffer(buffer)) throw new Error('Trawl cookie download did not return a valid DOCX package');

    const result = await mammoth.convertToHtml({ buffer });
    const turndown = new TurndownService();
    const markdown = turndown.turndown(result.value);
    if (addMissionLog) addMissionLog(`Trawl Word captured (${buffer.length} bytes)`, 'success');
    const finalResult = finalize({ metadata: { title: url.split('/').pop(), url }, allText: markdown, plainText: markdown });
    finalResult.docxBuffer = buffer;
    return finalResult;
}

async function scrapeWordViaGhost(url, browser, addMissionLog = null) {
    const mammoth = require('mammoth');
    if (addMissionLog) addMissionLog(`👻 Ghost Word Download for: ${url}`, 'info');
    const page = await browser.newPage();
    try {
        let downloadBuffer = null;

        // Strategy A: Listen for 'download' events (attachment disposition)
        safePageOn(page, 'download', async (download) => {
            try {
                downloadBuffer = await withTempFile('temp_ghost_word', 'docx', async (temp) => {
                    await download.saveAs(temp);
                    return fs.existsSync(temp) ? fs.readFileSync(temp) : null;
                });
            } catch (e) {
                if (addMissionLog) addMissionLog(`⚠️ Ghost Word download listener error: ${e.message}`, 'warn');
            }
        });

        // Strategy B: Listen for Word responses (inline disposition)
        safePageOn(page, 'response', async (res) => {
            try {
                const ct = res.headers()['content-type'] || '';
                const isWord = ct.toLowerCase().includes('officedocument.wordprocessingml.document') ||
                    ct.toLowerCase().includes('msword') ||
                    url.toLowerCase().endsWith('.docx');
                if (isWord && res.status() === 200) {
                    const body = await res.body().catch(() => null);
                    if (body && body.length > 100) downloadBuffer = body;
                }
            } catch (e) { }
        }, addMissionLog, 'Ghost Word response');

        // Strategy C: Trigger navigation with WAF wait
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
            // Playwright throws this if the navigation is cancelled by a download starting
            if (!e.message.includes('Download is starting') && !e.message.includes('Timeout')) throw e;
        }, addMissionLog, 'Ghost Word download');

        // Polling loop for async buffers (up to 10 seconds)
        for (let i = 0; i < 20 && !downloadBuffer; i++) {
            await new Promise(r => setTimeout(r, 500));
        }

        if (!downloadBuffer || downloadBuffer.length < 100) {
            throw new Error('Ghost Word: No buffer captured after navigation/download');
        }
        if (!isDocxBuffer(downloadBuffer)) {
            throw new Error('Ghost Word captured a non-DOCX response');
        }

        const result = await mammoth.convertToHtml({ buffer: downloadBuffer });
        const turndown = new TurndownService();
        const markdown = turndown.turndown(result.value);
        if (addMissionLog) addMissionLog(`✅ Ghost Word captured (${downloadBuffer.length} bytes)`, 'success');
        const finalResult = finalize({ metadata: { title: url.split('/').pop(), url }, allText: markdown, plainText: markdown });
        finalResult.docxBuffer = downloadBuffer; // v16.95: Preserve binary for metadata enrichment
        return finalResult;
    } catch (err) {
        throw new Error(`Ghost Word Failed: ${err.message}`);
    } finally {
        await page.close().catch(() => { });
    }
}

module.exports = { scrapePage, scrapePDF, scrapeWord, scrapeWordViaGhost, scrapeWordViaTrawl, scrapeViaGoogleCache, scrapeViaJina, scrapeViaTrawl, scrapeViaDirectFetch, scrapeViaArchive, terminateAllOCR, inspectRemoteDocument, __test: { safePageOn, withTempFile, runProcess, inspectRemoteDocument, classifyDocumentBuffer, isPdfBuffer, isDocxBuffer, isLegacyDocBuffer, extractDirectPdfBuffer, extractJinaReaderSource, isBlockedResponseContent, isGoogleCacheMissHtml, getTrawlSolverUrl, isExplicitConsentAction, didAutomatedCleanupChangeSource, shouldPreserveAutomaticSameSiteRedirect, smartExtract, waitForDynamicApplicationContent, detectContentExpanders, findDirectDocumentFallbackUrl, shouldAwaitLateDisclosure, isTechnicalFrameUrl, createExtractionDom, globalBannerCleanupSelectors: GLOBAL_BANNER_CLEANUP_SELECTORS } };
