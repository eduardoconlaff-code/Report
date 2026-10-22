const assert = require('node:assert/strict');
const test = require('node:test');
const { buildReviewGroups } = require('../lib/curation-review');

function detail({ url, title, fingerprint = '', inputIndex = null, reviewText = '', pdfKind = 'restored' }) {
    return {
        inputIndex,
        url,
        status: 'success',
        contentFingerprint: fingerprint,
        reviewText,
        pdfKind,
        artifacts: { title, storageDomain: new URL(url).hostname.replace(/[^a-z0-9]/gi, '_') },
        filesSaved: { txt: `${title.replace(/\s+/g, '_')}_example_0123456789abcdef.txt` }
    };
}

test('review includes same-title candidates on www and non-www hosts without changing exact groups', () => {
    const exactA = detail({ url: 'https://example.gov/exact-a', title: 'Exact official document', fingerprint: 'exact-hash' });
    const exactB = detail({ url: 'https://example.gov/exact-b', title: 'Exact official document', fingerprint: 'exact-hash' });
    const titleA = detail({ url: 'https://workplacedenmark.dk/path-a', title: 'Temporary staff posted to work abroad' });
    const titleB = detail({ url: 'http://www.workplacedenmark.dk/path-b', title: 'Temporary staff posted to work abroad' });
    const genericA = detail({ url: 'https://example.gov/home-a', title: 'Home' });
    const genericB = detail({ url: 'https://example.gov/home-b', title: 'Home' });

    const groups = buildReviewGroups([exactA, exactB, titleA, titleB, genericA, genericB]);
    const exactGroup = groups.find(group => group.matchType.startsWith('Exact'));
    const titleGroup = groups.find(group => group.matchType.startsWith('Matching source title'));

    assert.equal(exactGroup.members.length, 2);
    assert.equal(titleGroup.members.length, 2);
    assert.match(titleGroup.id, /^title:/);
    assert.equal(groups.some(group => group.members.some(member => member.url === exactA.url) && group.matchType.startsWith('Matching source title')), false);
    assert.equal(groups.some(group => group.members.some(member => member.url === genericA.url)), false);
});

test('schema v2 decisions remain attached to stable input identities', () => {
    const upper = detail({
        inputIndex: 1,
        url: 'https://example.gov/Act?ID=ABC',
        title: 'Official Act uppercase route',
        fingerprint: 'same-text'
    });
    const lower = detail({
        inputIndex: 2,
        url: 'https://example.gov/act?id=abc',
        title: 'Official Act lowercase route',
        fingerprint: 'same-text'
    });
    const state = {
        groups: {
            'same-text': {
                decisions: { 'input:1': 'include', 'input:2': 'exclude' },
                sourceUrls: { 'input:1': upper.url, 'input:2': lower.url }
            }
        }
    };

    const [group] = buildReviewGroups([upper, lower], state);
    assert.equal(group.members.find(member => member.sourceId === 'input:1').decision, 'include');
    assert.equal(group.members.find(member => member.sourceId === 'input:2').decision, 'exclude');
});

test('short restored text becomes a quality review signal, never an automatic duplicate', () => {
    const thin = detail({
        inputIndex: 3,
        url: 'https://example.gov/thin-page',
        title: 'Official thin extraction result',
        reviewText: 'Cookie settings only.',
        pdfKind: 'restored'
    });

    const groups = buildReviewGroups([thin]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].category, 'quality');
    assert.equal(groups[0].members.length, 1);
    assert.match(groups[0].reason, /quality signal, not a duplicate claim/i);
});

test('high textual similarity is exposed as review-only near duplicate', () => {
    const base = Array.from({ length: 160 }, (_, index) => `official provision ${index} protects posted workers`).join(' ');
    const first = detail({
        inputIndex: 4,
        url: 'https://example.gov/edition-one',
        title: 'First official edition source',
        reviewText: base,
        pdfKind: 'original'
    });
    const second = detail({
        inputIndex: 5,
        url: 'https://example.gov/edition-two',
        title: 'Second official version source',
        reviewText: base.replace('provision 88', 'amended provision 88'),
        pdfKind: 'original'
    });

    const groups = buildReviewGroups([first, second]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].category, 'near_duplicate');
    assert.equal(groups[0].members.every(member => member.decision === 'undecided'), true);
});
