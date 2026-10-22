const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scraperito-zip-layout-'));
process.env.DATA_DIR = tmpRoot;

const {
    exportToZip,
    exportBatchCsvIndex,
    exportBatchExcelIndex,
    getDuplicateReviewCandidates,
    getCombinedReviewCandidates,
    saveDuplicateReviewDecision,
    saveDuplicateReviewDecisions,
    saveCombinedReviewDecisions,
    exportCuratedZip,
    exportCombinedExcelIndex,
    exportCombinedCuratedZip
} = require('../lib/results');
const { getUserContext } = require('../lib/missions');

async function seedPdfResult() {
    const userId = 'zip-user';
    const batchId = 'zip-batch';
    const domain = 'example_com';
    const baseName = 'Example_Document_example_com_ab12cd';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    fs.mkdirSync(domainPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, `${baseName}.pdf`), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({
        url: 'https://example.com/doc',
        title: 'Example Document',
        batchId,
        size_kb: 1
    }));
    return { userId, batchId, domain };
}

test('PDF ZIP supports domain and flat layouts', async () => {
    const { userId, batchId, domain } = await seedPdfResult();

    const domainZipResult = await exportToZip(userId, batchId, 'pdf');
    const domainEntries = new AdmZip(domainZipResult.zip.toBuffer()).getEntries().map(entry => entry.entryName);
    assert.equal(domainZipResult.filesAdded, 1);
    assert.equal(domainEntries.length, 1);
    assert.ok(domainEntries[0].startsWith(`${domain}/`));

    const flatZipResult = await exportToZip(userId, batchId, 'pdf', { layout: 'flat' });
    const flatEntries = new AdmZip(flatZipResult.zip.toBuffer()).getEntries().map(entry => entry.entryName);
    assert.equal(flatZipResult.filesAdded, 1);
    assert.equal(flatEntries.length, 1);
    assert.equal(flatEntries[0].includes('/'), false);
    assert.ok(flatEntries[0].endsWith('.pdf'));
});

test('PDF ZIP excludes artifacts that a mission has marked invalid', async () => {
    const userId = 'validated-zip-user';
    const batchId = 'validated-zip-batch';
    const domain = 'example_com';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });

    for (const [baseName, url] of [
        ['Valid_example_com_aaaaaa', 'https://example.com/valid'],
        ['Invalid_example_com_bbbbbb', 'https://example.com/invalid']
    ]) {
        fs.writeFileSync(path.join(domainPath, `${baseName}.pdf`), Buffer.from('%PDF-1.4\n%test\n'));
        fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({ url, title: baseName, batchId }));
    }

    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            { url: 'https://example.com/valid', status: 'success' },
            { url: 'https://example.com/invalid', status: 'failed', validationStatus: 'invalid' }
        ]
    }));

    const zipResult = await exportToZip(userId, batchId, 'pdf');
    const entries = new AdmZip(zipResult.zip.toBuffer()).getEntries().map(entry => entry.entryName);
    assert.equal(zipResult.filesAdded, 1);
    assert.equal(entries.some(name => name.includes('Invalid')), false);
});

test('PDF ZIP keeps a successful artifact when an equivalent URL was skipped', async () => {
    const userId = 'zip-equivalent-user';
    const batchId = 'zip-equivalent-batch';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, 'example_com');
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const baseName = 'Equivalent_example_com_eeeeee';
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, `${baseName}.pdf`), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({
        url: 'https://example.com/document/', title: 'Equivalent', batchId
    }));
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            { url: 'https://example.com/document/', status: 'success' },
            { url: 'https://example.com/document/#main-content', status: 'skipped', reason: 'Duplicate URL after normalization.' }
        ]
    }));

    const result = await exportToZip(userId, batchId, 'pdf');
    assert.equal(result.filesAdded, 1);
    assert.equal(result.filesSkipped, 0);
});

test('manifest artifact filenames keep redirected downloads in the ZIP and Excel exactly once', async () => {
    const userId = 'redirect-contract-user';
    const batchId = 'redirect-contract-batch';
    const domain = 'example_gov';
    const originalUrl = 'https://example.gov/requested-page';
    const redirectedUrl = 'https://example.gov/downloads/official-document.pdf';
    const baseName = 'Official_Document_example_gov_abcdef';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, `${baseName}.pdf`), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({
        // This models a historical artifact written with the final redirect URL.
        url: redirectedUrl,
        title: 'Official Document',
        batchId
    }));
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [{
            url: originalUrl,
            status: 'success',
            artifacts: { storageDomain: domain, title: 'Official Document' },
            filesSaved: { pdf: `${baseName}.pdf`, json: `${baseName}.json` }
        }]
    }));

    const zipResult = await exportToZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(zipResult.filesAdded, 1);
    assert.equal(zipResult.filesSkipped, 0);
    const zipEntries = new AdmZip(zipResult.zip.toBuffer()).getEntries().map(entry => entry.entryName);
    assert.deepEqual(zipEntries, [`${baseName}.pdf`]);

    const excel = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].URL, originalUrl);
    assert.equal(rows[0].Status, 'succeeded');
    assert.equal(rows[0]['File Name'], `${baseName}.pdf`);
    assert.equal(rows[0]['File Name'], zipEntries[0]);
});

test('CSV index preserves each original manifest URL after normalization', async () => {
    const userId = 'csv-url-user';
    const batchId = 'csv-url-batch';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, 'example_com');
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const baseName = 'Example_example_com_cccccc';
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, `${baseName}.pdf`), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({
        url: 'https://example.com/document/', title: 'Example', batchId
    }));
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            { url: 'https://example.com/document/', status: 'success', filesSaved: { pdf: `${baseName}.pdf` } },
            { url: 'https://example.com/document/#main-content', status: 'skipped', reason: 'Duplicate URL after normalization.' }
        ]
    }));

    const result = await exportBatchCsvIndex(userId, batchId);
    const lines = result.output.trimEnd().split(/\r?\n/).slice(2);
    assert.equal(result.count, 2);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /Example_example_com_cccccc\.pdf/);
    assert.match(lines[1], /#main-content/);
    assert.doesNotMatch(lines[1], /Example_example_com_cccccc\.pdf/);
});

test('Excel index preserves Unicode artifact filenames', async () => {
    const userId = 'xlsx-unicode-user';
    const batchId = 'xlsx-unicode-batch';
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const greekName = 'ΟΜΕΔ_Οργανισμός_Μεσολάβησης_και_Διαιτησίας_www_omed_gr_1f8f7b.pdf';
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [{
            url: 'https://www.omed.gr/',
            status: 'success',
            level: 0,
            filesSaved: { pdf: greekName }
        }]
    }));

    const result = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(result.output, { type: 'buffer' });
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    assert.equal(result.count, 1);
    assert.equal(sheet[0]['File Name'], greekName);
});

test('Excel index records exact duplicates as canonical references without inventing a second PDF', async () => {
    const userId = 'dedup-index-user';
    const batchId = 'dedup-index-batch';
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const domainPath = path.join(tmpRoot, 'scrapes', userId, 'example_gov');
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.mkdirSync(domainPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, 'canonical.pdf'), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            {
                url: 'https://example.gov/canonical',
                status: 'success',
                contentFingerprint: 'a'.repeat(64),
                duplicateReviewStatus: 'possible_exact_text_duplicate_unverified',
                duplicateReviewOfUrl: 'https://unverified.example.gov/alias',
                duplicateReviewReason: 'Possible duplicate review: source-body equality was not verified.',
                filesSaved: { pdf: 'canonical.pdf' }
            },
            {
                url: 'https://mirror.example.gov/alias',
                status: 'deduplicated',
                duplicateOfUrl: 'https://example.gov/canonical',
                duplicateOfFiles: { pdf: 'canonical.pdf' },
                contentFingerprint: 'a'.repeat(64)
            }
        ]
    }));

    const result = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(result.output, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);

    assert.equal(result.count, 2);
    assert.equal(rows[0].Status, 'succeeded');
    assert.equal(rows[0]['Artifact Handling'], 'Own artifact saved; possible duplicate review');
    assert.equal(rows[0]['Related URL'], 'https://unverified.example.gov/alias');
    assert.equal(rows[1].Status, 'deduplicated');
    assert.equal(rows[1]['Canonical URL'], 'https://example.gov/canonical');
    assert.equal(rows[1]['Artifact Handling'], 'Canonical artifact reused');

    const zipResult = await exportToZip(userId, batchId, 'pdf');
    assert.equal(zipResult.filesAdded, 1);
});

test('mid-mission Excel uses live progress instead of a stale completed manifest', async () => {
    const userId = 'live-export-user';
    const batchId = 'live-export-batch';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, 'example_gov');
    fs.mkdirSync(domainPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, 'live.pdf'), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, 'live.json'), JSON.stringify({
        url: 'https://example.gov/live',
        title: 'Live result',
        batchId
    }));

    const ctx = getUserContext(userId);
    Object.assign(ctx, {
        sessionActive: true,
        currentMissionId: batchId,
        linkProgress: {
            missionId: batchId,
            details: [{
                url: 'https://example.gov/live',
                status: 'success',
                filesSaved: { pdf: 'live.pdf', json: 'live.json' },
                duplicateReviewStatus: 'possible_exact_text_duplicate_unverified',
                duplicateReviewOfUrl: 'https://example.gov/first',
                duplicateReviewReason: 'Possible duplicate review: live state was used.'
            }]
        }
    });

    try {
        const result = await exportBatchExcelIndex(userId, batchId);
        const workbook = XLSX.read(result.output, { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]['Related URL'], 'https://example.gov/first');
        assert.equal(rows[0]['Artifact Handling'], 'Own artifact saved; possible duplicate review');
    } finally {
        Object.assign(ctx, { sessionActive: false, currentMissionId: null, linkProgress: { total: 0, successful: 0, details: [] } });
    }
});

test('curation decisions create a separate ZIP without changing source artifacts or the normal ZIP', async () => {
    const userId = 'curation-user';
    const batchId = 'curation-batch';
    const domain = 'example_gov';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const firstFile = 'First_example_gov_1111111111111111.pdf';
    const secondFile = 'Second_example_gov_2222222222222222.pdf';
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });

    for (const [filename, url, title] of [
        [firstFile, 'https://example.gov/first', 'First source'],
        [secondFile, 'https://example.gov/second', 'Second source']
    ]) {
        const baseName = filename.replace('.pdf', '');
        fs.writeFileSync(path.join(domainPath, filename), Buffer.from('%PDF-1.4\n%test\n'));
        fs.writeFileSync(path.join(domainPath, `${baseName}.txt`), 'Same historical stored text\n');
        fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({ url, title, batchId }));
    }

    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            {
                url: 'https://example.gov/first',
                status: 'success',
                artifacts: { storageDomain: domain },
                filesSaved: { pdf: firstFile, txt: firstFile.replace('.pdf', '.txt'), json: firstFile.replace('.pdf', '.json') }
            },
            {
                url: 'https://example.gov/second',
                status: 'success',
                artifacts: { storageDomain: domain },
                filesSaved: { pdf: secondFile, txt: secondFile.replace('.pdf', '.txt'), json: secondFile.replace('.pdf', '.json') }
            }
        ]
    }));

    const beforeReview = await getDuplicateReviewCandidates(userId, batchId);
    assert.equal(beforeReview.groups.length, 1);
    assert.equal(beforeReview.groups[0].members.length, 2);

    await saveDuplicateReviewDecisions(userId, batchId, [
        { groupId: beforeReview.groups[0].id, action: 'include', url: 'https://example.gov/first' },
        { groupId: beforeReview.groups[0].id, action: 'exclude', url: 'https://example.gov/second' }
    ]);

    assert.equal(fs.existsSync(path.join(domainPath, firstFile)), true);
    assert.equal(fs.existsSync(path.join(domainPath, secondFile)), true);

    const normalZip = await exportToZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(normalZip.filesAdded, 2);

    const curatedZip = await exportCuratedZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(curatedZip.filesAdded, 1);
    assert.equal(curatedZip.excludedByReview, 1);

    const excel = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    const excluded = rows.find(row => row.URL === 'https://example.gov/second');
    assert.equal(excluded.Status, 'Skipped after duplicate review');
    assert.equal(excluded['Curated ZIP Status'], 'Excluded from curated ZIP');
    assert.equal(excluded['Curation Decision'], 'Excluded after duplicate review');
    assert.match(excluded['Curation Reason'], /original mission artifacts and regular ZIP retain this source/i);
});

test('curated ZIP and Excel keep case-sensitive source decisions separate', async () => {
    const userId = 'case-sensitive-curation-user';
    const batchId = 'case-sensitive-curation-batch';
    const domain = 'example_gov';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const sources = [
        { inputIndex: 1, url: 'https://example.gov/Act?ID=ABC', file: 'Upper_example_gov_aaaaaaaaaaaaaaaa.pdf' },
        { inputIndex: 2, url: 'https://example.gov/act?id=abc', file: 'Lower_example_gov_bbbbbbbbbbbbbbbb.pdf' }
    ];
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });
    for (const source of sources) {
        const baseName = source.file.replace('.pdf', '');
        fs.writeFileSync(path.join(domainPath, source.file), Buffer.from('%PDF-1.4\n%test\n'));
        fs.writeFileSync(path.join(domainPath, `${baseName}.txt`), 'Identical stored text for manual review.');
        fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({ url: source.url, batchId }));
        source.filesSaved = { pdf: source.file, txt: `${baseName}.txt`, json: `${baseName}.json` };
    }
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: sources.map(source => ({
            inputIndex: source.inputIndex,
            url: source.url,
            status: 'success',
            contentFingerprint: 'case-sensitive-match',
            filesSaved: source.filesSaved,
            artifacts: { storageDomain: domain }
        }))
    }));

    const review = await getDuplicateReviewCandidates(userId, batchId);
    const first = review.groups[0].members.find(member => member.sourceId === 'input:1');
    const second = review.groups[0].members.find(member => member.sourceId === 'input:2');
    await saveDuplicateReviewDecisions(userId, batchId, [
        { groupId: review.groups[0].id, action: 'include', url: first.url, sourceId: first.sourceId },
        { groupId: review.groups[0].id, action: 'exclude', url: second.url, sourceId: second.sourceId }
    ]);

    const curatedZip = await exportCuratedZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(curatedZip.filesAdded, 1);
    assert.equal(curatedZip.excludedByReview, 1);

    const excel = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    assert.equal(rows.find(row => row.URL === first.url).Status, 'succeeded');
    assert.equal(rows.find(row => row.URL === second.url).Status, 'Skipped after duplicate review');
});

test('irrelevant-content review decisions stay distinct from duplicate exclusions in the Excel index', async () => {
    const userId = 'irrelevant-curation-user';
    const batchId = 'irrelevant-curation-batch';
    const domain = 'example_gov';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const firstFile = 'Relevant_example_gov_3333333333333333.pdf';
    const secondFile = 'Cookie_notice_example_gov_4444444444444444.pdf';
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });

    for (const [filename, url] of [
        [firstFile, 'https://example.gov/relevant'],
        [secondFile, 'https://example.gov/cookie-notice']
    ]) {
        const baseName = filename.replace('.pdf', '');
        fs.writeFileSync(path.join(domainPath, filename), Buffer.from('%PDF-1.4\n%test\n'));
        fs.writeFileSync(path.join(domainPath, `${baseName}.txt`), 'Same short stored text\n');
        fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({ url, batchId }));
    }

    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [
            { url: 'https://example.gov/relevant', status: 'success', artifacts: { storageDomain: domain }, filesSaved: { pdf: firstFile, txt: firstFile.replace('.pdf', '.txt'), json: firstFile.replace('.pdf', '.json') } },
            { url: 'https://example.gov/cookie-notice', status: 'success', artifacts: { storageDomain: domain }, filesSaved: { pdf: secondFile, txt: secondFile.replace('.pdf', '.txt'), json: secondFile.replace('.pdf', '.json') } }
        ]
    }));

    const review = await getDuplicateReviewCandidates(userId, batchId);
    await saveDuplicateReviewDecisions(userId, batchId, [
        { groupId: review.groups[0].id, action: 'irrelevant', url: 'https://example.gov/cookie-notice' }
    ]);

    const curatedZip = await exportCuratedZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(curatedZip.filesAdded, 1);
    assert.equal(curatedZip.excludedByReview, 1);

    const excel = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    const irrelevant = rows.find(row => row.URL === 'https://example.gov/cookie-notice');
    assert.equal(irrelevant.Status, 'Excluded as irrelevant content');
    assert.equal(irrelevant['Curation Decision'], 'Excluded as irrelevant content');
    assert.match(irrelevant['Curation Reason'], /not useful corpus content/i);

    await saveDuplicateReviewDecision(
        userId,
        batchId,
        review.groups[0].id,
        'reset',
        'https://example.gov/cookie-notice',
        review.groups[0].members.find(member => member.url === 'https://example.gov/cookie-notice').sourceId
    );
    const restoredZip = await exportCuratedZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(restoredZip.filesAdded, 2);
    const restoredExcel = await exportBatchExcelIndex(userId, batchId);
    const restoredWorkbook = XLSX.read(restoredExcel.output, { type: 'buffer' });
    const restoredRows = XLSX.utils.sheet_to_json(restoredWorkbook.Sheets['Mission Index']);
    const restored = restoredRows.find(row => row.URL === 'https://example.gov/cookie-notice');
    assert.equal(restored.Status, 'succeeded');
    assert.equal(restored['Curation Decision'], 'No manual review decision');
});

test('needs re-scrape decisions create an ordered Retry Queue without changing the normal ZIP', async () => {
    const userId = 'rescrape-curation-user';
    const batchId = 'rescrape-curation-batch';
    const domain = 'example_gov';
    const domainPath = path.join(tmpRoot, 'scrapes', userId, domain);
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    const filename = 'Thin_result_example_gov_5555555555555555.pdf';
    const baseName = filename.replace('.pdf', '');
    const url = 'https://example.gov/thin-result';
    fs.mkdirSync(domainPath, { recursive: true });
    fs.mkdirSync(missionsPath, { recursive: true });
    fs.writeFileSync(path.join(domainPath, filename), Buffer.from('%PDF-1.4\n%test\n'));
    fs.writeFileSync(path.join(domainPath, `${baseName}.txt`), 'Cookie settings only.');
    fs.writeFileSync(path.join(domainPath, `${baseName}.json`), JSON.stringify({ url, title: 'Thin result', batchId }));
    fs.writeFileSync(path.join(missionsPath, `${batchId}.json`), JSON.stringify({
        details: [{
            inputIndex: 1,
            url,
            status: 'success',
            pdfKind: 'restored',
            filesSaved: { pdf: filename, txt: `${baseName}.txt`, json: `${baseName}.json` },
            artifacts: { storageDomain: domain, pdfKind: 'restored' }
        }]
    }));

    const review = await getDuplicateReviewCandidates(userId, batchId);
    assert.equal(review.groups[0].category, 'quality');
    await saveDuplicateReviewDecision(
        userId,
        batchId,
        review.groups[0].id,
        'rescrape',
        url,
        review.groups[0].members[0].sourceId
    );

    const normalZip = await exportToZip(userId, batchId, 'pdf', { layout: 'flat' });
    const curatedZip = await exportCuratedZip(userId, batchId, 'pdf', { layout: 'flat' });
    assert.equal(normalZip.filesAdded, 1);
    assert.equal(curatedZip.filesAdded, 0);

    const excel = await exportBatchExcelIndex(userId, batchId);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, ['Mission Index', 'Review Summary', 'Retry Queue']);
    const missionRows = XLSX.utils.sheet_to_json(workbook.Sheets['Mission Index']);
    const retryRows = XLSX.utils.sheet_to_json(workbook.Sheets['Retry Queue']);
    assert.equal(missionRows[0].Status, 'Needs re-scrape');
    assert.equal(retryRows[0]['Input Order'], 1);
    assert.equal(retryRows[0].URL, url);
    assert.equal(retryRows[0]['File Name'], filename);
});

test('combined review preserves chronological row order and matches Excel filenames to one flat ZIP', async () => {
    const userId = 'combined-review-user';
    const olderId = 'mission_1700000000000';
    const newerId = 'mission_1800000000000';
    const missionsPath = path.join(tmpRoot, 'missions', userId);
    fs.mkdirSync(missionsPath, { recursive: true });

    const missionSpecs = [
        {
            id: olderId,
            timestamp: '2025-01-02T09:00:00.000Z',
            domain: 'older_gov',
            urls: ['https://older.gov/shared-law', 'https://older.gov/collision-file'],
            files: ['Older_Law_older_gov_oldlawhash000001.pdf', 'Collision_older_gov_samehash00000001.pdf'],
            texts: ['Identical official legal text retained for cross mission review.', 'Older mission unique official guidance text.']
        },
        {
            id: newerId,
            timestamp: '2025-02-03T09:00:00.000Z',
            domain: 'newer_gov',
            urls: ['https://newer.gov/shared-law-copy', 'https://newer.gov/collision-file'],
            files: ['Newer_Law_newer_gov_newlawhash000002.pdf', 'Collision_newer_gov_samehash00000001.pdf'],
            texts: ['Identical official legal text retained for cross mission review.', 'Newer mission different official guidance text.']
        }
    ];

    for (const spec of missionSpecs) {
        const domainPath = path.join(tmpRoot, 'scrapes', userId, spec.domain);
        fs.mkdirSync(domainPath, { recursive: true });
        const details = [];
        for (let index = 0; index < spec.urls.length; index++) {
            const pdf = spec.files[index];
            const base = pdf.replace('.pdf', '');
            const txt = `${base}.txt`;
            const json = `${base}.json`;
            fs.writeFileSync(path.join(domainPath, pdf), Buffer.from(`%PDF-1.4\n%${spec.id}-${index}\n`));
            fs.writeFileSync(path.join(domainPath, txt), spec.texts[index]);
            fs.writeFileSync(path.join(domainPath, json), JSON.stringify({
                url: spec.urls[index],
                title: index === 1 ? 'Collision Official File' : 'Shared Official Law',
                batchId: spec.id
            }));
            details.push({
                inputIndex: index + 1,
                url: spec.urls[index],
                status: 'success',
                pdfKind: 'original',
                contentFingerprint: index === 0 ? 'cross-mission-exact-text' : '',
                artifacts: {
                    storageDomain: spec.domain,
                    title: index === 1 ? 'Collision Official File' : 'Shared Official Law',
                    pdfKind: 'original'
                },
                filesSaved: { pdf, txt, json }
            });
        }
        fs.writeFileSync(path.join(missionsPath, `${spec.id}.json`), JSON.stringify({
            missionId: spec.id,
            timestamp: spec.timestamp,
            total: details.length,
            successful: details.length,
            details
        }));
    }

    const review = await getCombinedReviewCandidates(userId, [newerId, olderId]);
    assert.deepEqual(review.missionIds, [olderId, newerId]);
    const exactGroup = review.groups.find(group => group.id === 'cross-mission-exact-text');
    assert.ok(exactGroup);
    assert.equal(exactGroup.members.length, 2);
    assert.notEqual(exactGroup.members[0].sourceId, exactGroup.members[1].sourceId);
    assert.match(exactGroup.members[0].sourceId, new RegExp(olderId));
    assert.match(exactGroup.members[1].sourceId, new RegExp(newerId));

    await saveCombinedReviewDecisions(userId, [newerId, olderId], [{
        groupId: exactGroup.id,
        action: 'canonical',
        url: exactGroup.members[0].url,
        sourceId: exactGroup.members[0].sourceId
    }]);

    const combinedZip = await exportCombinedCuratedZip(userId, [newerId, olderId]);
    assert.equal(combinedZip.filesAdded, 3);
    assert.equal(combinedZip.filesSkipped, 0);
    assert.equal(combinedZip.excludedByReview, 1);
    const zipEntries = new AdmZip(combinedZip.zip.toBuffer()).getEntries().map(entry => entry.entryName);
    const pdfEntries = zipEntries.filter(name => name.endsWith('.pdf'));
    assert.equal(pdfEntries.length, 3);
    assert.ok(zipEntries.some(name => name.endsWith('.xlsx')));
    assert.equal(new Set(pdfEntries.map(name => name.toLowerCase())).size, 3);
    assert.ok(pdfEntries.some(name => /_2\.pdf$/i.test(name)), 'flat ZIP collisions must be renamed deterministically');

    const excel = await exportCombinedExcelIndex(userId, [newerId, olderId]);
    const workbook = XLSX.read(excel.output, { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, ['Combined Index', 'Missions', 'Review Summary', 'Retry Queue']);
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Combined Index']);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(row => row['Global Row']), [1, 2, 3, 4]);
    assert.deepEqual(rows.map(row => row['Mission ID']), [olderId, olderId, newerId, newerId]);
    assert.deepEqual(rows.map(row => row['Mission Row']), [1, 2, 1, 2]);
    assert.equal(rows[2].Status, 'Skipped after duplicate review');
    assert.equal(rows[2]['PDF Included'], 'No');
    const includedNames = rows.filter(row => row['PDF Included'] === 'Yes').map(row => row['Combined ZIP Filename']);
    assert.deepEqual(new Set(includedNames), new Set(pdfEntries));

    const olderNormal = await exportToZip(userId, olderId, 'pdf', { layout: 'flat' });
    const newerNormal = await exportToZip(userId, newerId, 'pdf', { layout: 'flat' });
    assert.equal(olderNormal.filesAdded, 2);
    assert.equal(newerNormal.filesAdded, 2);
});
