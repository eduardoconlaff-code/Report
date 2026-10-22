const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueUniqueCrawlItems, prepareStartUrls, retryClientSideRouteExtraction } = require('../lib/session');
const { parseSubmittedUrls, parseSubmittedUrlEntries } = require('../lib/url-input');
const { normalizeVisitUrl, isClientSideRouteUrl } = require('../lib/navigator');

const visitKey = (baseUrl, targetUrl) => `${baseUrl}|${targetUrl}`;

test('duplicate discovered links are coalesced before they enter the worker queue', () => {
    const queue = [];
    const scheduled = new Set();
    const items = [
        { baseUrl: 'https://example.gov', url: 'https://example.gov/a' },
        { baseUrl: 'https://example.gov', url: 'https://example.gov/a' },
        { baseUrl: 'https://example.gov', url: 'https://example.gov/b' }
    ];

    const result = enqueueUniqueCrawlItems(queue, scheduled, items, visitKey);

    assert.deepEqual(result, { added: 2, duplicates: 1 });
    assert.deepEqual(queue.map(item => item.url), ['https://example.gov/a', 'https://example.gov/b']);
});

test('visit normalization preserves SPA hash routes while coalescing ordinary anchors', () => {
    const routeA = 'https://official.example/#/posting_en';
    const routeB = 'https://official.example/#/information_en';
    const anchorA = 'https://official.example/document#section-one';
    const anchorB = 'https://official.example/document#section-two';

    assert.notEqual(normalizeVisitUrl(routeA), normalizeVisitUrl(routeB));
    assert.equal(normalizeVisitUrl(anchorA), normalizeVisitUrl(anchorB));
    assert.equal(isClientSideRouteUrl(routeA), true);
    assert.equal(isClientSideRouteUrl(anchorA), false);

    const queue = [];
    const scheduled = new Set();
    const result = enqueueUniqueCrawlItems(queue, scheduled, [
        { baseUrl: 'https://official.example/#/seed', url: routeA },
        { baseUrl: 'https://official.example/#/seed', url: routeB }
    ], (baseUrl, targetUrl) => `${normalizeVisitUrl(baseUrl)}|${normalizeVisitUrl(targetUrl)}`);

    assert.deepEqual(result, { added: 2, duplicates: 0 });
});

test('client-side route retry closes its fresh page when navigation fails', async () => {
    let closed = false;
    const browser = {
        async newPage() {
            return {
                route: async () => {},
                goto: async () => ({ ok: () => false, status: () => 503 }),
                close: async () => { closed = true; }
            };
        }
    };

    await assert.rejects(
        retryClientSideRouteExtraction(browser, 'https://official.example/#/route'),
        /HTTP 503/
    );
    assert.equal(closed, true);
});

test('Smart Navigator priority is preserved while duplicate links are coalesced', () => {
    const queue = [{ baseUrl: 'https://example.gov', url: 'https://example.gov/later' }];
    const scheduled = new Set([visitKey('https://example.gov', 'https://example.gov/later')]);
    const items = [
        { baseUrl: 'https://example.gov', url: 'https://example.gov/high' },
        { baseUrl: 'https://example.gov', url: 'https://example.gov/later' },
        { baseUrl: 'https://example.gov', url: 'https://example.gov/next' }
    ];

    const result = enqueueUniqueCrawlItems(queue, scheduled, items, visitKey, true);

    assert.deepEqual(result, { added: 2, duplicates: 1 });
    assert.deepEqual(queue.map(item => item.url), [
        'https://example.gov/high',
        'https://example.gov/next',
        'https://example.gov/later'
    ]);
});

test('repeated submitted URLs remain visible while only first occurrences are scheduled', () => {
    const prepared = prepareStartUrls([
        'https://example.gov/a',
        'https://example.gov/b',
        'https://example.gov/a',
        'https://example.gov/a'
    ]);

    assert.deepEqual(prepared.scheduledUrls, ['https://example.gov/a', 'https://example.gov/b']);
    assert.equal(prepared.details.length, 4);
    assert.equal(prepared.duplicateCount, 2);
    assert.equal(prepared.details[2].status, 'skipped');
    assert.equal(prepared.details[2].inputDuplicateOf, 1);
    assert.match(prepared.details[3].reason, /identical entry #1/i);
});

test('submitted SPA routes remain distinct while ordinary anchors and www aliases coalesce', () => {
    const spaRoutes = [
        'https://mvff.munka.hu/#/posting_en',
        'https://mvff.munka.hu/#/information_en',
        'https://mvff.munka.hu/#/questions',
        'https://mvff.munka.hu/#/occupational_safety_and_health',
        'https://mvff.munka.hu/#/francais'
    ];
    const spaPreparation = prepareStartUrls(spaRoutes);

    assert.deepEqual(spaPreparation.scheduledUrls, spaRoutes);
    assert.equal(spaPreparation.details.length, spaRoutes.length);
    assert.equal(spaPreparation.duplicateCount, 0);
    assert.ok(spaPreparation.details.every(detail => detail.status === 'pending'));

    const anchorPreparation = prepareStartUrls([
        'https://www.official.example/document#section-one',
        'https://official.example/document#section-two'
    ]);

    assert.equal(anchorPreparation.scheduledUrls.length, 1);
    assert.equal(anchorPreparation.duplicateCount, 1);
    assert.equal(anchorPreparation.details[1].inputDuplicateOf, 1);
});

test('input parser keeps literal spaces inside a URL and separates the next URL', () => {
    const urls = parseSubmittedUrls('https://official.example/Files/Ministry of Labour/report.pdf\nhttps://official.example/next');

    assert.deepEqual(urls, [
        'https://official.example/Files/Ministry%20of%20Labour/report.pdf',
        'https://official.example/next'
    ]);
});

test('input parser preserves already encoded document-viewer query parameters', () => {
    const url = 'https://viewer.example/open?src=https%3A%2F%2Fofficial.example%2FReport%25202024.docx';

    assert.deepEqual(parseSubmittedUrls(url), [url]);
});

test('input parser keeps a plain URL and a Markdown document link as separate entries', () => {
    const input = [
        'https://www.service-public.gouv.fr/particuliers/vosdroits/F36444',
        '[EN_Information on remuneration of posted drivers_2023.pdf](https://www.ecologie.gouv.fr/sites/default/files/documents/EN_Information%20on%20remuneration%20of%20posted%20drivers_2023.pdf)'
    ].join('\n');

    assert.deepEqual(parseSubmittedUrls(input), [
        'https://www.service-public.gouv.fr/particuliers/vosdroits/F36444',
        'https://www.ecologie.gouv.fr/sites/default/files/documents/EN_Information%20on%20remuneration%20of%20posted%20drivers_2023.pdf'
    ]);
});

test('input parser keeps an unencoded nested query URL inside its submitted redirect URL', () => {
    const redirectUrl = 'https://www.xing.com/spi/shares/new?url=https://www.wko.at/entlohnung/lohn-und-sozialdumping';
    const referrerUrl = 'https://europa.eu/youreurope/information-service-feedback/index_en.htm?ft=no&referrer=https://www.usp.gv.at/en/test';

    assert.deepEqual(parseSubmittedUrls(`${redirectUrl}\n${referrerUrl}`), [
        redirectUrl,
        referrerUrl
    ]);
});

test('input parser keeps a fragment filter containing a nested URL as one Markdown entry', () => {
    const sourceUrl = 'https://www.lavoro.gov.it/documenti-e-norme/normative/Pagine/Normativa#k=Path:http://authoringlavoronew:1162/documenti-e-norme/normative/Documents';
    const markdownUrl = `[${sourceUrl}](${sourceUrl})`;

    assert.deepEqual(parseSubmittedUrls(sourceUrl), [sourceUrl]);
    assert.deepEqual(parseSubmittedUrls(markdownUrl), [sourceUrl]);
    assert.equal(parseSubmittedUrlEntries(markdownUrl).length, 1);
});

test('input parser still separates two ordinary URLs on the same line', () => {
    assert.deepEqual(
        parseSubmittedUrls('https://official.example/first, https://official.example/second'),
        ['https://official.example/first', 'https://official.example/second']
    );
});

test('invalid HTTP candidates remain auditable instead of silently disappearing', () => {
    const entries = parseSubmittedUrlEntries('https://official.example/valid\nhttps://\nhttps://official.example/also-valid');

    assert.equal(entries.length, 3);
    assert.equal(entries[1].inputIndex, 2);
    assert.equal(entries[1].url, null);
    assert.match(entries[1].reason, /invalid url syntax/i);

    const prepared = prepareStartUrls(entries);
    assert.equal(prepared.details.length, 3);
    assert.equal(prepared.scheduledUrls.length, 2);
    assert.equal(prepared.invalidCount, 1);
    assert.equal(prepared.details[1].inputIndex, 2);
    assert.equal(prepared.details[1].status, 'skipped');
    assert.match(prepared.details[1].reason, /invalid url syntax/i);
});
