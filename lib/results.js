const fs = require('fs-extra');
const nodeFs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const SCRAPES_DIR = path.join(DATA_DIR, 'scrapes');
const MISSIONS_DIR = path.join(DATA_DIR, 'missions');
const { normalizeUrl } = require('./navigator');
const { getUserContext } = require('./missions');
const { loadReviewState, saveReviewState, buildReviewGroups, safeMissionId, combinedReviewId } = require('./curation-review');
const { getExtractedTextAuditFingerprint } = require('./content-dedup');
const { reviewSourceId } = require('./review-quality');
const { sanitizeFilenameStem } = require('./filename');

function looksLikeCorruptTitle(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return true;

    const letters = (raw.match(/\p{L}/gu) || []).length;
    const safeChars = (raw.match(/[\p{L}\p{N}\s._\-(),[\]]/gu) || []).length;
    const unsafeRatio = raw.length > 0 ? 1 - (safeChars / raw.length) : 1;

    if (letters < 3) return true;
    if (unsafeRatio > 0.35) return true;
    if (/[$%^*#@!~`]{3,}/.test(raw)) return true;
    if (/^[A-Z0-9_$%-]{6,}$/.test(raw) && !/\s/.test(raw)) return true;

    return false;
}

function deriveTitleFromBaseName(baseName = '', domain = '') {
    const hash = baseName.split('_').pop() || '';
    const suffix = `_${domain}_${hash}`;
    const stem = baseName.endsWith(suffix) ? baseName.slice(0, -suffix.length) : baseName;
    return stem.replace(/_+/g, ' ').trim();
}

function resolveDisplayTitle(meta = {}, baseName = '', domain = '') {
    const metaTitle = String(meta.title || '').trim();
    if (metaTitle && !looksLikeCorruptTitle(metaTitle)) return metaTitle;

    const fileDerived = deriveTitleFromBaseName(baseName, domain);
    if (fileDerived && !looksLikeCorruptTitle(fileDerived)) return fileDerived;

    const url = String(meta.url || '').trim();
    if (url) {
        try {
            const parsed = new URL(url);
            const segments = parsed.pathname.split('/').filter(Boolean);
            if (segments.length > 0) return segments.join(' / ');
            return parsed.hostname;
        } catch (_) { }
    }

    return metaTitle || 'No Title';
}

async function resolveDisplayTitleFromStoredFiles(meta = {}, baseName = '', domain = '', domainPath = '', files = []) {
    const metaTitle = String(meta.title || '').trim();
    if (metaTitle && !looksLikeCorruptTitle(metaTitle)) return metaTitle;

    const fileDerived = deriveTitleFromBaseName(baseName, domain);
    if (fileDerived && !looksLikeCorruptTitle(fileDerived)) return fileDerived;

    const candidates = [`${baseName}.md`, `${baseName}.txt`];
    for (const candidate of candidates) {
        if (!files.includes(candidate)) continue;
        try {
            // A title is stored at the beginning of Scraperito text artifacts.
            // Avoid allocating whole historical documents during a history refresh.
            const content = await readTextPrefix(path.join(domainPath, candidate));
            const lines = content
                .split(/\r?\n/)
                .map(line => line.replace(/^#+\s*/, '').trim())
                .filter(Boolean);

            for (const line of lines) {
                if (line.length < 8) continue;
                if (/^url\s*:/i.test(line)) continue;
                if (!looksLikeCorruptTitle(line)) return line.substring(0, 160);
            }
        } catch (_) { }
    }

    return resolveDisplayTitle(meta, baseName, domain);
}

async function readTextPrefix(filePath, maxBytes = 64 * 1024) {
    let handle;
    try {
        handle = await nodeFs.promises.open(filePath, 'r');
        const buffer = Buffer.allocUnsafe(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
}

// ──────────────────────────────────────────────────────────
// Results Discovery
// ──────────────────────────────────────────────────────────

async function getResults(userId) {
    const userPath = path.join(SCRAPES_DIR, userId);
    const results = [];
    try {
        if (await fs.pathExists(userPath)) {
            const domains = await fs.readdir(userPath);
            for (const domain of domains) {
                const domainPath = path.join(userPath, domain);
                if (!(await fs.stat(domainPath)).isDirectory()) continue;
                const files = await fs.readdir(domainPath);
                for (const metaFile of files.filter(f => f.endsWith('.json'))) {
                    try {
                        const metaPath = path.join(domainPath, metaFile);
                        const meta = await fs.readJson(metaPath);
                        const mtime = (await fs.stat(metaPath)).mtime;
                        const baseName = metaFile.replace('.json', '');
                        const displayTitle = await resolveDisplayTitleFromStoredFiles(meta, baseName, domain, domainPath, files);
                        results.push({
                            domain, path: baseName,
                            title: displayTitle, url: meta.url,
                            timestamp: meta.timestamp || new Date(mtime).toLocaleTimeString(),
                            seedUrl: meta.seedUrl || null,
                            batchId: meta.batchId || null,
                            size_kb: meta.size_kb || 0,
                            // 🏴‍☠️ Sailor Mode flags
                            isSailor: meta.sailorMode === true,
                            urlCount: meta.urlCount || 1,
                            // v16.74 (M2): Use already-loaded files list instead of 3 extra syscalls
                            hasPdf: !meta.sailorMode && files.includes(`${baseName}.pdf`),
                            hasMd: !meta.sailorMode && files.includes(`${baseName}.md`),
                            hasTxt: !meta.sailorMode && files.includes(`${baseName}.txt`),
                            mtime: mtime
                        });
                    } catch (e) { }
                }
            }
        }
        return results.sort((a, b) => b.mtime - a.mtime);
    } catch (err) {
        return [];
    }
}

// ──────────────────────────────────────────────────────────
// Exporting & ZIP Generation
// ──────────────────────────────────────────────────────────

async function loadMissionManifestDetails(userId, batchId) {
    const ctx = getUserContext(userId);
    const requestedBatchId = String(batchId || '').trim();
    if (
        ctx.sessionActive === true &&
        String(ctx.currentMissionId || '').trim() === requestedBatchId &&
        Array.isArray(ctx.linkProgress?.details)
    ) {
        // A mission manifest is intentionally written once at completion. Exports
        // requested mid-mission must instead use the authoritative live progress
        // state, including deduplication and review decisions made moments ago.
        return ctx.linkProgress.details;
    }

    const manifestPath = path.join(MISSIONS_DIR, userId, `${batchId}.json`);
    if (!(await fs.pathExists(manifestPath))) return [];
    const manifest = await fs.readJson(manifestPath).catch(() => null);
    return Array.isArray(manifest?.details) ? manifest.details : [];
}

function missionTimestampFromId(missionId = '') {
    const match = String(missionId).match(/(?:^|_)mission_(\d{10,})$/i)
        || String(missionId).match(/(\d{10,})/);
    return match ? new Date(Number(match[1])).toISOString() : '';
}

async function loadCompletedMissionBundle(userId, batchId) {
    const id = safeMissionId(batchId);
    if (!id) return null;
    const manifestPath = path.join(MISSIONS_DIR, userId, `${id}.json`);
    if (!(await fs.pathExists(manifestPath))) return null;
    const manifest = await fs.readJson(manifestPath).catch(() => null);
    if (!manifest || !Array.isArray(manifest.details)) return null;
    return {
        id,
        timestamp: manifest.timestamp || missionTimestampFromId(id) || new Date(0).toISOString(),
        details: manifest.details
    };
}

async function collectCombinedMissionRows(userId, missionIds = []) {
    const requestedIds = (Array.isArray(missionIds) ? missionIds : [])
        .map(value => safeMissionId(value))
        .filter(Boolean);
    if (requestedIds.length !== 2 || new Set(requestedIds).size !== 2) {
        throw new Error('Select exactly two distinct completed missions');
    }

    const bundles = await Promise.all(requestedIds.map(id => loadCompletedMissionBundle(userId, id)));
    if (bundles.some(bundle => !bundle)) throw new Error('One or more selected missions could not be loaded');
    bundles.sort((first, second) => (
        new Date(first.timestamp).getTime() - new Date(second.timestamp).getTime()
        || first.id.localeCompare(second.id)
    ));

    const orderedIds = bundles.map(bundle => bundle.id);
    const reviewId = combinedReviewId(orderedIds);
    const rows = [];
    for (let missionIndex = 0; missionIndex < bundles.length; missionIndex++) {
        const bundle = bundles[missionIndex];
        const needsLegacyMerge = bundle.details.some(row => {
            if (row.status !== 'success') return false;
            const files = row.filesSaved || row.artifacts?.files || {};
            return !files.pdf && !files.txt && !files.json;
        });
        let missionRows = bundle.details;
        if (needsLegacyMerge) {
            const collected = await collectClassicBatchRows(userId, bundle.id);
            if (collected.sailorOutput) throw new Error('Sailor link-only missions cannot be used in document corpus review');
            missionRows = collected.rows;
        }
        missionRows.forEach((row, rowIndex) => {
            const localSourceId = reviewSourceId(row);
            rows.push({
                ...row,
                reviewSourceId: `mission:${bundle.id}:${localSourceId}`,
                reviewMissionId: bundle.id,
                reviewMissionTimestamp: bundle.timestamp,
                reviewMissionOrder: missionIndex + 1,
                reviewMissionInputIndex: row.inputIndex ?? rowIndex + 1
            });
        });
    }

    return {
        reviewId,
        missionIds: orderedIds,
        missions: bundles.map((bundle, index) => ({
            id: bundle.id,
            timestamp: bundle.timestamp,
            order: index + 1,
            rows: bundle.details.length
        })),
        rows
    };
}

function csvCell(value = '') {
    const text = String(value ?? '');
    return `"${text.replace(/"/g, '""')}"`;
}

function resolveRowLevel(row = {}) {
    const raw = row.level ?? row.lvl ?? row.depth;
    if (raw === 0 || raw === '0') return '0';
    if (raw === 1 || raw === '1') return '1';
    if (row.seedUrl && row.url) {
        return normalizeUrl(row.seedUrl) === normalizeUrl(row.url) ? '0' : '1';
    }
    return '';
}

function primaryFilenameFromRow(row = {}) {
    const artifacts = row.artifacts || {};
    const files = row.filesSaved || artifacts.files || {};
    const canonicalFiles = row.duplicateOfFiles || {};
    return files.pdf || files.docx || files.md || files.txt || files.json ||
        canonicalFiles.pdf || canonicalFiles.docx || canonicalFiles.md || canonicalFiles.txt || canonicalFiles.json ||
        artifacts.safeFilename || '';
}

function artifactHandlingFromRow(row = {}) {
    if (row.status === 'deduplicated') return 'Canonical artifact reused';
    if (row.duplicateReviewStatus) return 'Own artifact saved; possible duplicate review';
    if (row.status === 'success') return 'Own artifact saved';
    return 'No corpus artifact';
}

// Curation choices live outside mission artifacts. Mirror them into the Excel
// audit so a reviewer can see precisely why a curated ZIP omits a source.
function buildCurationExportMap(state = {}) {
    const decisionsBySource = new Map();
    for (const group of Object.values(state.groups || {})) {
        const canonicalUrl = group.canonicalUrl || '';
        const canonicalSourceId = group.canonicalSourceId || '';
        const sourceUrls = group.sourceUrls || {};
        for (const [key, decision] of Object.entries(group.decisions || {})) {
            const exactUrl = sourceUrls[key] || (/^(?:input|url):/.test(key) ? '' : key);
            if (!exactUrl) continue;
            const review = { decision, canonicalUrl, canonicalSourceId };
            if (sourceUrls[key]) decisionsBySource.set(key, review);
            decisionsBySource.set(exactUrl, review);
            // Reviews written before schema v2 used normalized URLs as keys.
            if (!sourceUrls[key]) decisionsBySource.set(normalizeUrl(exactUrl), review);
        }
    }
    return decisionsBySource;
}

function curationExportFields(row = {}, decisionsBySource = new Map()) {
    const exactUrl = String(row.url || '');
    const sourceId = reviewSourceId(row);
    const review = decisionsBySource.get(sourceId)
        || decisionsBySource.get(exactUrl)
        || decisionsBySource.get(normalizeUrl(exactUrl));
    if (!review) {
        return {
            'Curated ZIP Status': 'Included',
            'Curation Decision': 'No manual review decision',
            'Curation Reason': 'Included because no explicit curation exclusion was recorded.',
            'Curated Canonical URL': ''
        };
    }

    if (review.decision === 'irrelevant') {
        return {
            'Curated ZIP Status': 'Excluded from curated ZIP',
            'Curation Decision': 'Excluded as irrelevant content',
            'Curation Reason': 'Explicit reviewer decision: the retrieved source is not useful corpus content. The original mission artifacts and regular ZIP retain this source.',
            'Curated Canonical URL': ''
        };
    }

    if (review.decision === 'rescrape') {
        return {
            'Curated ZIP Status': 'Excluded from curated ZIP',
            'Curation Decision': 'Needs re-scrape',
            'Curation Reason': 'Reviewer identified an extraction-quality problem. Original artifacts remain available for audit, but this result is quarantined from the curated corpus.',
            'Curated Canonical URL': ''
        };
    }

    if (review.decision === 'related') {
        return {
            'Curated ZIP Status': 'Included',
            'Curation Decision': 'Kept as related/version source',
            'Curation Reason': 'Reviewer confirmed that this source is related to another candidate but should remain a separate corpus document.',
            'Curated Canonical URL': review.canonicalUrl || ''
        };
    }

    if (review.decision === 'exclude') {
        return {
            'Curated ZIP Status': 'Excluded from curated ZIP',
            'Curation Decision': 'Excluded after duplicate review',
            'Curation Reason': 'Explicit reviewer decision. The original mission artifacts and regular ZIP retain this source.',
            'Curated Canonical URL': review.canonicalUrl || ''
        };
    }

    const isCanonical = review.canonicalSourceId
        ? review.canonicalSourceId === sourceId
        : (review.canonicalUrl && review.canonicalUrl === exactUrl);
    return {
        'Curated ZIP Status': 'Included',
        'Curation Decision': isCanonical ? 'Selected as curated canonical source' : 'Kept after duplicate review',
        'Curation Reason': isCanonical
            ? 'Explicit reviewer decision. Other sources in this match group may be excluded only from the curated ZIP.'
            : 'Explicit reviewer decision to retain this source in the curated ZIP.',
        'Curated Canonical URL': review.canonicalUrl || ''
    };
}

function storageDomainFromUrl(targetUrl = '') {
    try {
        return new URL(targetUrl).hostname.replace(/[^a-z0-9]/gi, '_');
    } catch (_) {
        return '';
    }
}

function artifactLineFromRow(row) {
    const artifacts = row.artifacts || {};
    const files = row.filesSaved || artifacts.files || {};
    const artifactLabels = [];
    if (files.pdf || row.hasPdf || row.pdfSaved) artifactLabels.push('PDF');
    if (files.docx || artifacts.hasDocx) artifactLabels.push('DOCX');
    if (files.md || artifacts.hasMd) artifactLabels.push('MD');
    if (files.txt || artifacts.hasTxt) artifactLabels.push('TXT');
    if (files.json || artifacts.hasJson) artifactLabels.push('JSON');
    if (files.rawDump || artifacts.hasRawDump) artifactLabels.push('RAW');
    return artifactLabels.length > 0 ? artifactLabels.join(',') : 'none';
}

async function collectClassicBatchRows(userId, batchId) {
    const userPath = path.join(SCRAPES_DIR, userId);
    const rowsByUrl = new Map();
    const rowsByJsonFile = new Map();
    let foundSailor = false;

    if (await fs.pathExists(userPath)) {
        const domains = await fs.readdir(userPath);
        for (const domain of domains) {
            const domainPath = path.join(userPath, domain);
            if (!(await fs.stat(domainPath)).isDirectory()) continue;
            const files = await fs.readdir(domainPath);
            for (const metaFile of files.filter(f => f.endsWith('.json'))) {
                const meta = await fs.readJson(path.join(domainPath, metaFile)).catch(() => null);
                if (!meta || (meta.batchId || 'legacy') !== batchId) continue;
                if (meta.sailorMode) {
                    foundSailor = true;
                    continue;
                }

                const baseName = metaFile.replace('.json', '');
                const hasPdf = files.includes(`${baseName}.pdf`);
                const hasDocx = files.includes(`${baseName}.docx`);
                const seedUrl = meta.seedUrl || meta.url || '';
                const storedRow = {
                    url: meta.url,
                    seedUrl,
                    level: seedUrl && normalizeUrl(seedUrl) !== normalizeUrl(meta.url) ? 1 : 0,
                    status: 'success',
                    sizeKb: meta.size_kb ? Number(meta.size_kb).toFixed(1) : '',
                    pdfSaved: hasPdf,
                    pdfKind: hasPdf ? (meta.pdfKind || 'saved') : 'none',
                    pdfReason: hasPdf ? (meta.pdfReason || 'PDF artifact exists in storage.') : 'No PDF artifact found in storage for this result.',
                    sourceKind: meta.sourceKind || null,
                    sourceDetail: meta.sourceDetail || null,
                    filesSaved: {
                        ...(hasPdf ? { pdf: `${baseName}.pdf` } : {}),
                        ...(hasDocx ? { docx: `${baseName}.docx` } : {}),
                        ...(files.includes(`${baseName}.md`) ? { md: `${baseName}.md` } : {}),
                        ...(files.includes(`${baseName}.txt`) ? { txt: `${baseName}.txt` } : {}),
                        json: `${baseName}.json`
                    }
                };
                rowsByUrl.set(normalizeUrl(meta.url), storedRow);
                rowsByJsonFile.set(`${domain}/${metaFile}`, storedRow);
                // Older mission manifests did not retain storageDomain. Keep a
                // filename fallback so redirected documents still merge correctly.
                if (!rowsByJsonFile.has(metaFile)) rowsByJsonFile.set(metaFile, storedRow);
            }
        }
    }

    if (foundSailor && rowsByUrl.size === 0) {
        return { rows: [], sailorOutput: await exportSailorIndex(userId, batchId) };
    }

    const manifestDetails = await loadMissionManifestDetails(userId, batchId);
    if (manifestDetails.length === 0) {
        return { rows: Array.from(rowsByUrl.values()), sailorOutput: null };
    }

    // The manifest is the audit record of every submitted URL. Preserve its rows
    // exactly, even when navigation normalization identifies two URLs as equivalent.
    const rows = manifestDetails.map(detail => {
        const files = detail.filesSaved || detail.artifacts?.files || {};
        const storageDomain = detail.artifacts?.storageDomain || storageDomainFromUrl(detail.url);
        const storedKey = files.json && storageDomain ? `${storageDomain}/${files.json}` : '';
        const existing = detail.status === 'success'
            ? (rowsByJsonFile.get(storedKey) || rowsByJsonFile.get(files.json) || rowsByUrl.get(normalizeUrl(detail.url)) || {})
            : {};
        return { ...existing, ...detail, url: detail.url || existing.url };
    });

    return { rows, sailorOutput: null };
}

async function exportClassicArtifactIndex(userId, batchId) {
    const { rows, sailorOutput } = await collectClassicBatchRows(userId, batchId);
    if (sailorOutput) return sailorOutput;

    const total = rows.length;
    const success = rows.filter(r => r.status === 'success').length;
    const deduplicated = rows.filter(r => r.status === 'deduplicated').length;
    const pdfSaved = rows.filter(r => r.pdfSaved === true || r.artifacts?.hasPdf === true).length;
    const pdfMissing = rows.filter(r => r.status === 'success' && !(r.pdfSaved === true || r.artifacts?.hasPdf === true)).length;
    const failed = rows.filter(r => r.status && !['success', 'deduplicated'].includes(r.status)).length;

    let output = `# SCRAPERITO BATCH INDEX - Artifact Audit\n`;
    output += `# Mission ID: ${batchId}\n`;
    output += `# Total URLs: ${total} | Success: ${success} | Exact duplicates: ${deduplicated} | PDF saved: ${pdfSaved} | Success without PDF: ${pdfMissing} | Failed/Skipped: ${failed}\n`;
    output += `# Columns: STATUS | PDF | PDF_KIND | SIZE_KB | ARTIFACTS | URL | DETAIL\n`;
    output += `${'='.repeat(120)}\n\n`;

    if (rows.length === 0) {
        output += `[!] No mission rows or stored artifacts were found for this batch.\n`;
        return output;
    }

    for (const row of rows) {
        const artifacts = row.artifacts || {};
        const pdfOk = row.pdfSaved === true || artifacts.hasPdf === true;
        const pdfKind = row.pdfKind || artifacts.pdfKind || (pdfOk ? 'saved' : 'none');
        const size = row.sizeKb || (artifacts.sizeKb ? String(artifacts.sizeKb) : '');
        const detail = row.pdfReason || artifacts.pdfReason || row.reason || '';
        output += `${String(row.status || 'unknown').toUpperCase()} | ${pdfOk ? 'PDF_SAVED' : 'PDF_NOT_SAVED'} | ${pdfKind} | ${size} | ${artifactLineFromRow(row)} | ${row.url || ''} | ${detail}\n`;
    }

    return output;
}

async function exportBatchCsvIndex(userId, batchId) {
    const { rows, sailorOutput } = await collectClassicBatchRows(userId, batchId);
    if (sailorOutput) return { output: sailorOutput, count: sailorOutput ? 1 : 0, contentType: 'text/plain; charset=UTF-8', extension: 'txt' };
    if (rows.length === 0) return { output: '', count: 0, contentType: 'text/csv; charset=UTF-8', extension: 'csv' };

    const lines = [
        'sep=;',
        ['URL', 'Level', 'File Name', 'Status', 'Reason', 'Canonical URL', 'Content Fingerprint', 'Artifact Handling'].map(csvCell).join(';')
    ];

    for (const row of rows) {
        const status = row.status === 'success' ? 'succeeded' : (row.status || 'unknown');
        const artifacts = row.artifacts || {};
        const reason = row.reason || row.pdfReason || artifacts.pdfReason || artifacts.storageWarning || '';
        lines.push([
            row.url || '',
            resolveRowLevel(row),
            primaryFilenameFromRow(row),
            status,
            reason || (status === 'succeeded' ? '' : 'No reason recorded'),
            row.duplicateOfUrl || '',
            row.contentFingerprint || '',
            artifactHandlingFromRow(row)
        ].map(csvCell).join(';'));
    }

    return {
        output: `\uFEFF${lines.join('\r\n')}\r\n`,
        count: rows.length,
        contentType: 'text/csv; charset=UTF-8',
        extension: 'csv'
    };
}

async function exportBatchExcelIndex(userId, batchId) {
    const { rows, sailorOutput } = await collectClassicBatchRows(userId, batchId);
    if (sailorOutput || rows.length === 0) return { output: null, count: 0 };

    const curationDecisions = buildCurationExportMap(await loadReviewState(userId, batchId));

    const data = rows.map(row => {
        const artifacts = row.artifacts || {};
        const reason = row.reason || row.pdfReason || artifacts.pdfReason || artifacts.storageWarning || '';
        const curation = curationExportFields(row, curationDecisions);
        // The exported Status is the corpus outcome. The mission's internal
        // success state remains immutable so normal downloads stay auditable.
        const status = curation['Curation Decision'] === 'Excluded as irrelevant content'
            ? 'Excluded as irrelevant content'
            : (curation['Curation Decision'] === 'Needs re-scrape'
                ? 'Needs re-scrape'
            : (curation['Curated ZIP Status'] === 'Excluded from curated ZIP'
                ? 'Skipped after duplicate review'
                : (row.status === 'success' ? 'succeeded' : (row.status || 'unknown'))));
        return {
            URL: row.url || '',
            Level: resolveRowLevel(row),
            'File Name': primaryFilenameFromRow(row),
            Status: status,
            Reason: reason || (status === 'succeeded' ? '' : 'No reason recorded'),
            'Canonical URL': row.duplicateOfUrl || '',
            'Duplicate Review': row.duplicateReviewReason || '',
            'Related URL': row.duplicateReviewOfUrl || '',
            'Content Fingerprint': row.contentFingerprint || '',
            'Artifact Handling': artifactHandlingFromRow(row),
            ...curation
        };
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    worksheet['!cols'] = [
        { wch: 74 },
        { wch: 10 },
        { wch: 58 },
        { wch: 14 },
        { wch: 64 },
        { wch: 74 },
        { wch: 70 },
        { wch: 74 },
        { wch: 66 },
        { wch: 28 },
        { wch: 28 },
        { wch: 34 },
        { wch: 78 },
        { wch: 74 }
    ];
    worksheet['!autofilter'] = { ref: `A1:N${data.length + 1}` };
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Mission Index');

    const statusCounts = data.reduce((counts, row) => {
        const status = row.Status || 'unknown';
        counts.set(status, (counts.get(status) || 0) + 1);
        return counts;
    }, new Map());
    const reviewSummary = [
        { Metric: 'Mission rows', Value: data.length },
        ...Array.from(statusCounts.entries()).map(([status, count]) => ({ Metric: status, Value: count })),
        { Metric: 'Included in curated ZIP', Value: data.filter(row => row['Curated ZIP Status'] === 'Included').length },
        { Metric: 'Excluded from curated ZIP', Value: data.filter(row => row['Curated ZIP Status'] === 'Excluded from curated ZIP').length },
        { Metric: 'No manual review decision', Value: data.filter(row => row['Curation Decision'] === 'No manual review decision').length }
    ];
    const summarySheet = XLSX.utils.json_to_sheet(reviewSummary);
    summarySheet['!cols'] = [{ wch: 38 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Review Summary');

    const retryQueue = data
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row['Curation Decision'] === 'Needs re-scrape')
        .map(({ row, index }) => ({
            'Input Order': index + 1,
            URL: row.URL,
            Level: row.Level,
            'File Name': row['File Name'],
            'Original Mission Status': rows[index]?.status || 'unknown',
            Reason: row['Curation Reason']
        }));
    const retrySheet = XLSX.utils.json_to_sheet(retryQueue, {
        header: ['Input Order', 'URL', 'Level', 'File Name', 'Original Mission Status', 'Reason']
    });
    retrySheet['!cols'] = [
        { wch: 12 },
        { wch: 74 },
        { wch: 10 },
        { wch: 58 },
        { wch: 24 },
        { wch: 90 }
    ];
    if (retryQueue.length > 0) retrySheet['!autofilter'] = { ref: `A1:F${retryQueue.length + 1}` };
    XLSX.utils.book_append_sheet(workbook, retrySheet, 'Retry Queue');

    return {
        output: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
        count: rows.length,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx'
    };
}

function combinedRowStatus(row = {}, curation = {}) {
    if (curation['Curation Decision'] === 'Excluded as irrelevant content') return 'Excluded as irrelevant content';
    if (curation['Curation Decision'] === 'Needs re-scrape') return 'Needs re-scrape';
    if (curation['Curated ZIP Status'] === 'Excluded from curated ZIP') return 'Skipped after duplicate review';
    return row.status === 'success' ? 'succeeded' : (row.status || 'unknown');
}

function combinedPdfDisplayName(row = {}, targetName = '', domain = '') {
    const targetExt = '.pdf';
    const stem = targetName.replace(/\.pdf$/i, '');
    const hash = stem.split('_').pop() || 'document';
    const safeTitle = sanitizeFilenameStem(resolveDisplayTitle(
        { title: row.artifacts?.title || '', url: row.url || '' },
        stem,
        domain
    ), 'document', 60);
    return `${safeTitle}_${sanitizeFilenameStem(hash, 'document', 32)}${targetExt}`;
}

async function buildCombinedPdfPlan(userId, missionIds = []) {
    const combined = await collectCombinedMissionRows(userId, missionIds);
    const state = await loadReviewState(userId, combined.reviewId);
    const decisions = buildCurationExportMap(state);
    const candidates = await mapWithConcurrency(combined.rows, 16, async (row, globalIndex) => {
        const curation = curationExportFields(row, decisions);
        const files = row.filesSaved || row.artifacts?.files || {};
        const storedPdfFilename = files.pdf || '';
        const domain = row.artifacts?.storageDomain || storageDomainFromUrl(row.url);
        const shouldInclude = row.status === 'success'
            && row.validationStatus !== 'invalid'
            && curation['Curated ZIP Status'] !== 'Excluded from curated ZIP';
        const entry = {
            row,
            globalIndex,
            sourceId: reviewSourceId(row),
            missionId: row.reviewMissionId,
            missionTimestamp: row.reviewMissionTimestamp,
            missionRow: row.reviewMissionInputIndex ?? row.inputIndex ?? globalIndex + 1,
            curation,
            domain,
            storedPdfFilename,
            shouldInclude,
            included: false,
            zipName: '',
            filePath: '',
            artifactIssue: ''
        };

        if (!shouldInclude) return entry;
        if (!storedPdfFilename || !domain) {
            entry.artifactIssue = 'No declared PDF artifact was found for this successful URL.';
            return entry;
        }

        entry.filePath = path.join(SCRAPES_DIR, userId, domain, storedPdfFilename);
        const stat = await fs.stat(entry.filePath).catch(() => null);
        if (!stat || !stat.isFile()) {
            entry.artifactIssue = `PDF artifact missing from storage: ${storedPdfFilename}`;
            return entry;
        }
        if (stat.size === 0) {
            entry.artifactIssue = `PDF artifact is empty: ${storedPdfFilename}`;
            return entry;
        }
        entry.proposedZipName = combinedPdfDisplayName(row, storedPdfFilename, domain);
        return entry;
    });

    const usedNames = new Set();
    for (const entry of candidates) {
        if (!entry.proposedZipName || entry.artifactIssue || !entry.shouldInclude) continue;
        const ext = path.extname(entry.proposedZipName);
        const stem = ext ? entry.proposedZipName.slice(0, -ext.length) : entry.proposedZipName;
        let zipName = entry.proposedZipName;
        let counter = 2;
        while (usedNames.has(zipName.toLowerCase())) {
            zipName = `${stem}_${counter}${ext}`;
            counter++;
        }
        usedNames.add(zipName.toLowerCase());
        entry.zipName = zipName;
        entry.included = true;
    }

    return {
        ...combined,
        state,
        entries: candidates,
        missingFiles: candidates
            .filter(entry => entry.shouldInclude && !entry.included)
            .map(entry => ({
                missionId: entry.missionId,
                inputIndex: entry.missionRow,
                url: entry.row.url || '',
                expectedFile: entry.storedPdfFilename,
                reason: entry.artifactIssue || 'PDF artifact could not be included'
            })),
        excludedByReview: candidates.filter(entry => (
            entry.curation['Curated ZIP Status'] === 'Excluded from curated ZIP'
        )).length
    };
}

function buildCombinedExcelWorkbook(plan) {
    const data = plan.entries.map((entry, index) => {
        const row = entry.row;
        const artifacts = row.artifacts || {};
        const status = combinedRowStatus(row, entry.curation);
        const originalReason = row.reason || row.pdfReason || artifacts.pdfReason || artifacts.storageWarning || '';
        const curationReason = entry.curation['Curation Reason'] || '';
        const reason = entry.artifactIssue
            || (status === 'succeeded' ? originalReason : (originalReason || curationReason || 'No reason recorded'));
        return {
            'Global Row': index + 1,
            'Mission ID': entry.missionId,
            'Mission Date': entry.missionTimestamp,
            'Mission Row': entry.missionRow,
            URL: row.url || '',
            Level: resolveRowLevel(row),
            'File Name': entry.zipName || entry.storedPdfFilename || primaryFilenameFromRow(row),
            'Stored PDF Filename': entry.storedPdfFilename,
            'Combined ZIP Filename': entry.zipName,
            Status: status,
            'PDF Included': entry.included ? 'Yes' : 'No',
            Reason: reason,
            'Curated ZIP Status': entry.curation['Curated ZIP Status'],
            'Curation Decision': entry.curation['Curation Decision'],
            'Curation Reason': curationReason,
            'Curated Canonical URL': entry.curation['Curated Canonical URL'] || ''
        };
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(data);
    worksheet['!cols'] = [
        { wch: 12 }, { wch: 28 }, { wch: 24 }, { wch: 12 },
        { wch: 78 }, { wch: 8 }, { wch: 62 }, { wch: 62 },
        { wch: 62 }, { wch: 30 }, { wch: 14 }, { wch: 78 },
        { wch: 28 }, { wch: 36 }, { wch: 90 }, { wch: 78 }
    ];
    if (data.length > 0) worksheet['!autofilter'] = { ref: `A1:P${data.length + 1}` };
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Combined Index');

    const missionRows = plan.missions.map(mission => ({
        'Mission Order': mission.order,
        'Mission ID': mission.id,
        'Mission Date': mission.timestamp,
        'Rows': mission.rows
    }));
    const missionsSheet = XLSX.utils.json_to_sheet(missionRows);
    missionsSheet['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 24 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(workbook, missionsSheet, 'Missions');

    const summaryRows = [
        { Metric: 'Combined mission rows', Value: data.length },
        { Metric: 'PDFs included', Value: data.filter(row => row['PDF Included'] === 'Yes').length },
        { Metric: 'Excluded by review', Value: plan.excludedByReview },
        { Metric: 'Expected PDF artifacts missing', Value: plan.missingFiles.length },
        { Metric: 'Needs re-scrape', Value: data.filter(row => row['Curation Decision'] === 'Needs re-scrape').length },
        { Metric: 'Irrelevant content', Value: data.filter(row => row['Curation Decision'] === 'Excluded as irrelevant content').length }
    ];
    const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
    summarySheet['!cols'] = [{ wch: 38 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Review Summary');

    const retryRows = data
        .filter(row => row['Curation Decision'] === 'Needs re-scrape')
        .map(row => ({
            'Global Row': row['Global Row'],
            'Mission ID': row['Mission ID'],
            'Mission Row': row['Mission Row'],
            URL: row.URL,
            'File Name': row['Stored PDF Filename'],
            Reason: row['Curation Reason']
        }));
    const retrySheet = XLSX.utils.json_to_sheet(retryRows, {
        header: ['Global Row', 'Mission ID', 'Mission Row', 'URL', 'File Name', 'Reason']
    });
    retrySheet['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 12 }, { wch: 78 }, { wch: 62 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(workbook, retrySheet, 'Retry Queue');

    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

async function exportCombinedExcelIndex(userId, missionIds = []) {
    const plan = await buildCombinedPdfPlan(userId, missionIds);
    return {
        output: buildCombinedExcelWorkbook(plan),
        count: plan.entries.length,
        reviewId: plan.reviewId,
        missionIds: plan.missionIds
    };
}

async function exportCombinedCuratedZip(userId, missionIds = []) {
    const plan = await buildCombinedPdfPlan(userId, missionIds);
    const zip = new AdmZip();
    for (const entry of plan.entries) {
        if (!entry.included) continue;
        const content = await fs.readFile(entry.filePath);
        zip.addFile(entry.zipName, content);
    }
    const indexName = `combined_${plan.reviewId}_index.xlsx`;
    zip.addFile(indexName, buildCombinedExcelWorkbook(plan));
    return {
        zip,
        filesAdded: plan.entries.filter(entry => entry.included).length,
        filesSkipped: plan.missingFiles.length,
        missingFiles: plan.missingFiles,
        excludedByReview: plan.excludedByReview,
        reviewId: plan.reviewId,
        missionIds: plan.missionIds,
        indexName
    };
}

async function exportToText(userId, batchId, type) {
    const userPath = path.join(SCRAPES_DIR, userId);
    let output = "";
    let filenamesProcessed = 0;

    if (type === 'index') {
        return await exportBatchExcelIndex(userId, batchId);
    }

    const domains = await fs.readdir(userPath);
    for (const domain of domains) {
        const domainPath = path.join(userPath, domain);
        if (!(await fs.stat(domainPath)).isDirectory()) continue;
        const files = await fs.readdir(domainPath);

        for (const metaFile of files.filter(f => f.endsWith('.json'))) {
            const meta = await fs.readJson(path.join(domainPath, metaFile));
            if ((meta.batchId || 'legacy') === batchId) {
                const name = metaFile.replace('.json', '');
                if (type === 'index') {
                    if (meta.sailorMode) {
                        // 🏴‍☠️ Robust Hijack: If this is a Sailor mission, the basic index is useless.
                        // We delegate to the advanced aggregator to ensure the user gets scores and text.
                        const sailorIdx = await exportSailorIndex(userId, batchId);
                        return { output: sailorIdx, count: 1 }; 
                    }
                    output += `${meta.url}\n`;
                } else if (type === 'txt' || type === 'md') {
                    const contentPath = path.join(domainPath, `${name}.${type}`);
                    if (await fs.pathExists(contentPath)) {
                        const content = await fs.readFile(contentPath, 'utf8');
                        output += `\n${'='.repeat(50)}\n`;
                        output += `FILE: ${meta.url}\n`;
                        output += `${'='.repeat(50)}\n\n`;
                        output += content + "\n\n";
                    }
                }
                filenamesProcessed++;
            }
        }
    }
    return { output, count: filenamesProcessed };
}

async function exportToZip(userId, batchId, type, options = {}) {
    const userPath = path.join(SCRAPES_DIR, userId);
    const zip = new AdmZip();
    let filesAdded = 0;
    let filesSkipped = 0;
    const missingFiles = [];
    const layout = options.layout === 'flat' ? 'flat' : 'domain';
    const zipNames = new Set();
    const manifestDetails = await loadMissionManifestDetails(userId, batchId);
    const excludedUrls = options.excludedUrls instanceof Set ? options.excludedUrls : new Set();
    const excludedSourceIds = options.excludedSourceIds instanceof Set ? options.excludedSourceIds : new Set();
    const validSuccessDetails = manifestDetails
        .filter(detail => detail.status === 'success' && detail.validationStatus !== 'invalid')
        // Curated exports only: ordinary batch ZIPs never pass this set.
        .filter(detail => !excludedSourceIds.has(reviewSourceId(detail)) && !excludedUrls.has(normalizeUrl(detail.url)));

    const uniqueZipName = (zipName) => {
        let candidate = zipName;
        let counter = 2;
        const ext = path.extname(zipName);
        const stem = ext ? zipName.slice(0, -ext.length) : zipName;
        while (zipNames.has(candidate.toLowerCase())) {
            candidate = `${stem}_${counter}${ext}`;
            counter++;
        }
        zipNames.add(candidate.toLowerCase());
        return candidate;
    };

    const storedArtifactsByUrl = new Map();
    const needsLegacyLookup = manifestDetails.length === 0 || validSuccessDetails.some(detail => {
        const files = detail.filesSaved || detail.artifacts?.files || {};
        return !files[type];
    });
    if (needsLegacyLookup) {
        const domains = await fs.readdir(userPath);
        for (const domain of domains) {
            const domainPath = path.join(userPath, domain);
            if (!(await fs.stat(domainPath)).isDirectory()) continue;
            const files = await fs.readdir(domainPath);
            for (const file of files.filter(f => f.endsWith('.json'))) {
                const meta = await fs.readJson(path.join(domainPath, file)).catch(() => null);
                if (!meta || (meta.batchId || 'legacy') !== batchId) continue;
                const key = normalizeUrl(meta.url);
                const entries = storedArtifactsByUrl.get(key) || [];
                entries.push({ domain, domainPath, metaFile: file, meta });
                storedArtifactsByUrl.set(key, entries);
            }
        }
    }

    const addArtifact = async ({ url, domain, domainPath, targetName, meta = {}, title = '' }) => {
        const targetExt = `.${type}`;
        const targetPath = path.join(domainPath, targetName);
        if (!(await fs.pathExists(targetPath))) {
            filesSkipped++;
            missingFiles.push({
                url,
                domain,
                expectedFile: targetName,
                reason: `${targetExt.toUpperCase()} artifact missing from storage`
            });
            return;
        }

        try {
            const fileContent = await fs.readFile(targetPath);
            if (fileContent.length === 0) throw new Error('Artifact file is empty');
            // The manifest filename is the artifact contract. Use it unchanged
            // so the regular ZIP and the Excel always name the same file.
            const zipPath = layout === 'flat' ? targetName : `${domain}/${targetName}`;
            zip.addFile(uniqueZipName(zipPath), fileContent);
            filesAdded++;
        } catch (readErr) {
            console.error(`[ZIP] Failed to read ${targetPath}:`, readErr);
            filesSkipped++;
            missingFiles.push({
                url,
                domain,
                expectedFile: targetName,
                reason: `Failed to read ${targetExt.toUpperCase()} artifact: ${readErr.message}`
            });
        }
    };

    if (manifestDetails.length > 0) {
        // The manifest is the mission's contract: export exactly one declared
        // artifact for every successful URL, never an inferred redirect record.
        for (const detail of validSuccessDetails) {
            const files = detail.filesSaved || detail.artifacts?.files || {};
            const targetName = files[type];
            const domain = detail.artifacts?.storageDomain || storageDomainFromUrl(detail.url);
            const domainPath = domain ? path.join(userPath, domain) : '';

            if (targetName && domainPath) {
                const metaFile = files.json;
                const meta = metaFile
                    ? await fs.readJson(path.join(domainPath, metaFile)).catch(() => ({}))
                    : {};
                await addArtifact({
                    url: detail.url || '',
                    domain,
                    domainPath,
                    targetName,
                    meta,
                    title: detail.artifacts?.title || ''
                });
                continue;
            }

            // Legacy manifests may lack filenames. Retain their old URL lookup
            // behaviour, but make the missing artifact explicit instead of silent.
            const fallback = (storedArtifactsByUrl.get(normalizeUrl(detail.url)) || [])[0];
            if (fallback) {
                await addArtifact({
                    url: detail.url || fallback.meta.url || '',
                    domain: fallback.domain,
                    domainPath: fallback.domainPath,
                    targetName: fallback.metaFile.replace('.json', `.${type}`),
                    meta: fallback.meta
                });
            } else {
                filesSkipped++;
                missingFiles.push({
                    url: detail.url || '',
                    domain,
                    expectedFile: '',
                    reason: `No declared ${type.toUpperCase()} artifact was found for this successful URL.`
                });
            }
        }
        return { zip, filesAdded, filesSkipped, missingFiles };
    }

    // Fallback only for legacy batches without a persisted manifest.
    for (const entries of storedArtifactsByUrl.values()) {
        for (const entry of entries) {
            await addArtifact({
                url: entry.meta.url || '',
                domain: entry.domain,
                domainPath: entry.domainPath,
                targetName: entry.metaFile.replace('.json', `.${type}`),
                meta: entry.meta
            });
        }
    }
    return { zip, filesAdded, filesSkipped, missingFiles };
}

// ──────────────────────────────────────────────────────────
// Sailor Mode: Link retrieval
// ──────────────────────────────────────────────────────────

// Curation is deliberately post-processing only. It reads persisted mission
// details and writes decisions to data/reviews; it never touches artifacts.
async function mapWithConcurrency(items, concurrency, mapper) {
    const output = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            output[index] = await mapper(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return output;
}

async function hydrateReviewRows(userId, rows = []) {
    return mapWithConcurrency(rows, 16, async row => {
        if (row.status !== 'success') return row;
        const files = row.filesSaved || row.artifacts?.files || {};
        const domain = row.artifacts?.storageDomain || storageDomainFromUrl(row.url);
        const textName = files.txt;
        const textPath = domain && textName ? path.join(SCRAPES_DIR, userId, domain, textName) : '';
        const text = textPath ? await fs.readFile(textPath, 'utf8').catch(() => '') : '';
        const fingerprint = row.contentFingerprint
            ? null
            : (text ? getExtractedTextAuditFingerprint({ plainText: text }) : null);
        return {
            ...row,
            reviewText: text,
            contentFingerprint: row.contentFingerprint || fingerprint?.hash || null,
            contentFingerprintKind: row.contentFingerprintKind || fingerprint?.kind || null
        };
    });
}

async function getDuplicateReviewCandidates(userId, batchId) {
    if (!safeMissionId(batchId)) return null;
    // Completed and live mission manifests already contain the authoritative
    // ordered rows and artifact names. Avoid rescanning every historical JSON
    // in the user's storage just to open the review workspace. Legacy missions
    // without a manifest retain the original discovery path below.
    const manifestRows = await loadMissionManifestDetails(userId, batchId);
    let rows = manifestRows;
    if (rows.length === 0) {
        const collected = await collectClassicBatchRows(userId, batchId);
        if (collected.sailorOutput) return { batchId: String(batchId), groups: [] };
        rows = collected.rows;
    }

    // Old missions predate fingerprint persistence. Calculate their exact TXT
    // audit value lazily here, never write it back to their manifest or files.
    const manifestDetails = await hydrateReviewRows(userId, rows);
    const state = await loadReviewState(userId, batchId);
    return {
        batchId: String(batchId),
        revision: state.revision || 0,
        groups: buildReviewGroups(manifestDetails, state)
    };
}

async function getCombinedReviewCandidates(userId, missionIds = []) {
    const combined = await collectCombinedMissionRows(userId, missionIds);
    const reviewRows = await hydrateReviewRows(userId, combined.rows);
    const state = await loadReviewState(userId, combined.reviewId);
    return {
        batchId: combined.reviewId,
        combined: true,
        missionIds: combined.missionIds,
        missions: combined.missions,
        revision: state.revision || 0,
        groups: buildReviewGroups(reviewRows, state)
    };
}

function applyDuplicateReviewDecision(state, group, groupId, action, url = '', sourceId = '') {
    let member = sourceId ? group.members.find(candidate => candidate.sourceId === sourceId) : null;
    if (!member && url) member = group.members.find(candidate => candidate.url === url);
    if (!member && url) {
        const normalizedMatches = group.members.filter(candidate => normalizeUrl(candidate.url) === normalizeUrl(url));
        if (normalizedMatches.length === 1) member = normalizedMatches[0];
    }
    const isMember = Boolean(member);
    const savedGroup = state.groups[groupId] || { decisions: {}, sourceUrls: {} };
    const decisions = { ...(savedGroup.decisions || {}) };
    const sourceUrls = { ...(savedGroup.sourceUrls || {}) };
    for (const candidate of group.members) sourceUrls[candidate.sourceId] = candidate.url;
    const selectedSourceId = member?.sourceId || sourceId;

    if (action === 'keep_all') {
        for (const candidate of group.members) decisions[candidate.sourceId] = 'include';
        savedGroup.canonicalUrl = null;
        savedGroup.canonicalSourceId = null;
    } else if (['exclude', 'irrelevant', 'include', 'rescrape', 'related'].includes(action)) {
        if (!isMember) throw new Error('Selected URL is not part of this review group');
        decisions[selectedSourceId] = action;
        if (['exclude', 'irrelevant', 'rescrape'].includes(action) && savedGroup.canonicalSourceId === selectedSourceId) {
            savedGroup.canonicalUrl = null;
            savedGroup.canonicalSourceId = null;
        }
    } else if (action === 'canonical') {
        if (!isMember) throw new Error('Selected URL is not part of this review group');
        if (group.category === 'quality') throw new Error('Quality-anomaly groups do not support canonical duplicate decisions');
        for (const candidate of group.members) {
            decisions[candidate.sourceId] = candidate.sourceId === selectedSourceId ? 'include' : 'exclude';
        }
        savedGroup.canonicalUrl = member.url;
        savedGroup.canonicalSourceId = selectedSourceId;
    } else if (action === 'reset') {
        if (!isMember) throw new Error('Selected URL is not part of this review group');
        delete decisions[selectedSourceId];
        if (savedGroup.canonicalSourceId === selectedSourceId) {
            savedGroup.canonicalUrl = null;
            savedGroup.canonicalSourceId = null;
        }
    } else {
        throw new Error('Unsupported review action');
    }

    state.groups[groupId] = { ...savedGroup, decisions, sourceUrls };
}

async function saveDuplicateReviewDecisions(userId, batchId, changes = []) {
    if (!safeMissionId(batchId) || !Array.isArray(changes) || changes.length === 0) {
        throw new Error('At least one valid review change is required');
    }

    const candidates = await getDuplicateReviewCandidates(userId, batchId);
    if (!candidates) throw new Error('Mission not found');
    const groupsById = new Map(candidates.groups.map(group => [group.id, group]));
    const state = await loadReviewState(userId, batchId);

    for (const change of changes) {
        const groupId = String(change?.groupId || '');
        const group = groupsById.get(groupId);
        if (!group) throw new Error('Review group not found for this mission');
        applyDuplicateReviewDecision(state, group, groupId, change?.action, change?.url || '', change?.sourceId || '');
    }

    await saveReviewState(userId, batchId, state);
    return getDuplicateReviewCandidates(userId, batchId);
}

async function saveDuplicateReviewDecision(userId, batchId, groupId, action, url = '', sourceId = '') {
    return saveDuplicateReviewDecisions(userId, batchId, [{ groupId, action, url, sourceId }]);
}

async function saveCombinedReviewDecisions(userId, missionIds, changes = []) {
    if (!Array.isArray(changes) || changes.length === 0) {
        throw new Error('At least one valid review change is required');
    }
    const candidates = await getCombinedReviewCandidates(userId, missionIds);
    const groupsById = new Map(candidates.groups.map(group => [group.id, group]));
    const state = await loadReviewState(userId, candidates.batchId);

    for (const change of changes) {
        const groupId = String(change?.groupId || '');
        const group = groupsById.get(groupId);
        if (!group) throw new Error('Review group not found for these missions');
        applyDuplicateReviewDecision(state, group, groupId, change?.action, change?.url || '', change?.sourceId || '');
    }

    await saveReviewState(userId, candidates.batchId, state);
    return getCombinedReviewCandidates(userId, candidates.missionIds);
}

async function exportCuratedZip(userId, batchId, type, options = {}) {
    if (!safeMissionId(batchId)) throw new Error('Invalid mission id');
    const state = await loadReviewState(userId, batchId);
    const excludedUrls = new Set();
    const excludedSourceIds = new Set();
    for (const group of Object.values(state.groups || {})) {
        const sourceUrls = group.sourceUrls || {};
        for (const [key, decision] of Object.entries(group.decisions || {})) {
            if (!['exclude', 'irrelevant', 'rescrape'].includes(decision)) continue;
            if (sourceUrls[key]) {
                excludedSourceIds.add(key);
                continue;
            }
            // Legacy review states had URL keys and no stable source identity.
            if (!/^(?:input|url):/.test(key)) excludedUrls.add(normalizeUrl(key));
        }
    }

    const exported = await exportToZip(userId, batchId, type, { ...options, excludedUrls, excludedSourceIds });
    return { ...exported, excludedByReview: excludedUrls.size + excludedSourceIds.size };
}

async function getSailorLinks(userId, domain, name) {
    try {
        const metaPath = path.join(SCRAPES_DIR, userId, domain, `${name}.json`);
        const meta = await fs.readJson(metaPath);
        if (!meta.sailorMode) return [];
        return meta.links || [];
    } catch (e) {
        return [];
    }
}

/**
 * 🏴‍☠️ Sailor Mode: Aggregate ALL discovered links across a full batch.
 * Deduplicates by href, sorts by score descending.
 * Used for the batch-level "Export Index" download.
 */
async function exportSailorIndex(userId, batchId) {
    const userPath = path.join(SCRAPES_DIR, userId);
    if (!(await fs.pathExists(userPath))) return '';

    const linkMap = new Map();
    const excludedMap = new Map();
    const domainPath = (await fs.readdir(userPath)).map(d => path.join(userPath, d));
    let pageCount = 0;

    for (const dPath of domainPath) {
        if (!(await fs.stat(dPath)).isDirectory()) continue;
        const files = await fs.readdir(dPath);
        for (const file of files.filter(f => f.endsWith('.json'))) {
            const meta = await fs.readJson(path.join(dPath, file)).catch(() => null);
            if (!meta || !meta.sailorMode) continue;
            const mId = String(meta.batchId || 'legacy').trim();
            if (mId !== String(batchId).trim()) continue;
            pageCount++;
            for (const link of (meta.links || [])) {
                const nHref = normalizeUrl(link.href);
                const isExcluded = link.status === 'excluded';
                
                if (isExcluded) {
                    const existing = excludedMap.get(nHref);
                    if (!existing) {
                        excludedMap.set(nHref, { href: link.href, text: link.text || '', _score: link._score || 0, reason: link.reason || 'Noise' });
                    }
                } else {
                    const existing = linkMap.get(nHref);
                    if (!existing || (link._score || 0) > (existing._score || 0)) {
                        linkMap.set(nHref, { href: link.href, text: link.text || '', _score: link._score || 0, sourceUrl: meta.url });
                    }
                }
            }
        }
    }

    let output = `# 🏴‍☠️ SAILOR AUDITOR INDEX — v17.02 (Full Audit)\n`;
    output += `# Mission ID: ${batchId}\n`;
    output += `# Pages visited: ${pageCount} | Active: ${linkMap.size} | Excluded: ${excludedMap.size}\n`;
    output += `# Format: [score] | Link text | URL\n`;
    output += `${'='.repeat(80)}\n\n`;

    if (linkMap.size === 0 && excludedMap.size === 0) {
        output += `[!] No links were found matching this mission ID.\n`;
        return output;
    }

    // 🟢 Section 1: Active Links
    output += `### ACTIVE LINKS (Verified Content)\n`;
    const sorted = Array.from(linkMap.entries())
        .sort((a, b) => b[1]._score - a[1]._score);
    
    for (const [nHref, info] of sorted) {
        const score = info._score.toFixed(1).padStart(5);
        const text = (info.text || '—').substring(0, 80).padEnd(80);
        output += `[${score}] | ${text} | ${info.href}\n`;
    }

    // 🔴 Section 2: Excluded Links (Transparency)
    if (excludedMap.size > 0) {
        output += `\n\n### EXCLUDED NOISE (Audit Trail)\n`;
        output += `# These links were rejected due to low score or noise containers.\n`;
        const sortedExcluded = Array.from(excludedMap.entries())
            .sort((a, b) => b[1]._score - a[1]._score);
        
        for (const [nHref, info] of sortedExcluded) {
            const score = info._score.toFixed(1).padStart(5);
            const text = (info.text || '—').substring(0, 60).padEnd(60);
            output += `[${score}] | ${text} | ${info.href} | REASON: ${info.reason}\n`;
        }
    }

    return output;
}

/**
 * 🏴‍☠️ Sailor Mode: Full grouped report — all visited pages, all discovered links.
 * Unlike exportSailorIndex (flat deduped), this keeps all links PER SOURCE PAGE.
 * Good for understanding what was found on each visited page (lvl 0 + lvl 1).
 */
async function exportSailorReport(userId, batchId) {
    const userPath = path.join(SCRAPES_DIR, userId);
    if (!(await fs.pathExists(userPath))) return '';

    const pages = []; // { url, title, links[] }

    const domains = await fs.readdir(userPath);
    for (const domain of domains) {
        const domainPath = path.join(userPath, domain);
        if (!(await fs.stat(domainPath)).isDirectory()) continue;
        const files = await fs.readdir(domainPath);
        for (const file of files.filter(f => f.endsWith('.json'))) {
            const meta = await fs.readJson(path.join(domainPath, file)).catch(() => null);
            if (!meta || !meta.sailorMode) continue;
            if ((meta.batchId || 'legacy') !== batchId) continue;
            pages.push({ url: meta.url, title: meta.title || meta.url, links: meta.links || [], timestamp: meta.timestamp || '' });
        }
    }

    if (pages.length === 0) return '';

    // Sort pages: seed first (url === seedUrl if available), then by timestamp
    pages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));

    const totalLinks = pages.reduce((acc, p) => acc + p.links.length, 0);
    let output = `# Sailor Full Report — Mission ${batchId}\n`;
    output += `# Pages visited: ${pages.length} | Total link entries: ${totalLinks}\n`;
    output += `# Format per link: [score] | Link text | URL\n`;
    output += `${'='.repeat(80)}\n\n`;

    for (const page of pages) {
        output += `## ${page.url}\n`;
        output += `# Title: ${page.title}\n`;
        
        const active = page.links.filter(l => l.status !== 'excluded');
        const excluded = page.links.filter(l => l.status === 'excluded');

        output += `# Found: ${active.length} active | ${excluded.length} excluded\n`;
        output += `${'='.repeat(80)}\n`;
        output += `### ACTIVE LINKS\n`;
        for (const link of active) {
            const score = (link._score || 0).toFixed(1).padStart(5);
            const text = (link.text || '\u2014').substring(0, 80).padEnd(80);
            output += `[${score}] | ${text} | ${link.href}\n`;
        }

        if (excluded.length > 0) {
            output += `\n### EXCLUDED NOISE (All)\n`;
            for (const link of excluded) {
                const score = (link._score || 0).toFixed(1).padStart(5);
                const text = (link.text || '\u2014').substring(0, 60).padEnd(60);
                output += `[${score}] | ${text} | ${link.href} | REASON: ${link.reason || 'Noise'}\n`;
            }
        }
        output += `\n`;
    }
    return output;
}

/**
 * 🏴‍☠️ Sailor Mode: Export ALL links in a mission to Excel.
 * Format: One row per link with its source page.
 */
async function exportSailorBatchExcel(userId, batchId) {
    const userPath = path.join(SCRAPES_DIR, userId);
    if (!(await fs.pathExists(userPath))) return null;

    const data = [];
    const domains = await fs.readdir(userPath);
    for (const domain of domains) {
        const domainPath = path.join(userPath, domain);
        if (!(await fs.stat(domainPath)).isDirectory()) continue;
        const files = await fs.readdir(domainPath);
        for (const file of files.filter(f => f.endsWith('.json'))) {
            const meta = await fs.readJson(path.join(domainPath, file)).catch(() => null);
            if (!meta || !meta.sailorMode) continue;
            if ((meta.batchId || 'legacy') !== batchId) continue;
            
            for (const link of (meta.links || [])) {
                data.push({
                    'Score': (link._score || 0).toFixed(1),
                    'Link Text': link.text || '',
                    'Link URL': link.href || '',
                    'Status': link.status || 'active',
                    'Reason': link.reason || '',
                    'Source Page Title': meta.title || '',
                    'Source Page URL': meta.url || ''
                });
            }
        }
    }

    if (data.length === 0) return null;

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "Links");
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * 🏴‍☠️ Sailor Mode: Export links from a SINGLE page to Excel.
 */
async function exportSailorSingleExcel(userId, domain, name) {
    try {
        const metaPath = path.join(SCRAPES_DIR, userId, domain, `${name}.json`);
        const meta = await fs.readJson(metaPath);
        if (!meta.sailorMode || !meta.links) return null;

        const data = meta.links.map(link => ({
            'Score': (link._score || 0).toFixed(1),
            'Status': link.status || 'active',
            'Reason': link.reason || '',
            'Link Text': link.text || '',
            'Link URL': link.href || ''
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, "Links");
        return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    } catch (e) {
        return null;
    }
}

module.exports = {
    getResults,
    exportToText,
    exportBatchCsvIndex,
    exportBatchExcelIndex,
    exportToZip,
    getDuplicateReviewCandidates,
    getCombinedReviewCandidates,
    saveDuplicateReviewDecision,
    saveDuplicateReviewDecisions,
    saveCombinedReviewDecisions,
    exportCuratedZip,
    exportCombinedExcelIndex,
    exportCombinedCuratedZip,
    getSailorLinks,
    exportSailorIndex,
    exportSailorReport,
    exportSailorBatchExcel,
    exportSailorSingleExcel,
    SCRAPES_DIR
};
