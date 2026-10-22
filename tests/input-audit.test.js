const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSubmittedUrlEntries } = require('../lib/url-input');
const { prepareStartUrls } = require('../lib/session');

test('input audit retains every non-empty pasted line when some links lack an HTTP scheme', () => {
    const navigable = Array.from(
        { length: 608 },
        (_, index) => `https://official.example/document/${index + 1}`
    );
    const unrecognised = Array.from(
        { length: 120 },
        (_, index) => `www.official.example/missing-scheme/${index + 1}`
    );

    const entries = parseSubmittedUrlEntries([...navigable, ...unrecognised].join('\r\n'));
    const prepared = prepareStartUrls(entries);

    assert.equal(entries.length, 728);
    assert.equal(entries.filter(entry => entry.url).length, 608);
    assert.equal(entries.filter(entry => !entry.url).length, 120);
    assert.equal(prepared.details.length, 728);
    assert.equal(prepared.scheduledUrls.length, 608);
    assert.equal(prepared.invalidCount, 120);
    assert.deepEqual(
        prepared.details.map(detail => detail.inputIndex),
        Array.from({ length: 728 }, (_, index) => index + 1)
    );
    assert.equal(prepared.details[727].status, 'skipped');
    assert.match(prepared.details[727].reason, /no http:\/\/ or https:\/\//i);
});

test('input audit does not create a phantom invalid row for a valid Markdown link', () => {
    const entries = parseSubmittedUrlEntries(
        '[Official document](https://official.example/document.pdf)\nhttps://official.example/page'
    );

    assert.deepEqual(entries.map(entry => entry.url), [
        'https://official.example/document.pdf',
        'https://official.example/page'
    ]);
    assert.equal(entries.every(entry => entry.reason === null), true);
});
