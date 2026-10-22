const crypto = require('crypto');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function reviewSourceId(detail = {}) {
    const explicitSourceId = String(detail.reviewSourceId || '').trim();
    if (explicitSourceId) return explicitSourceId;
    if (Number.isInteger(detail.inputIndex) && detail.inputIndex > 0) {
        return `input:${detail.inputIndex}`;
    }
    return `url:${sha256(String(detail.url || '').trim()).slice(0, 24)}`;
}

function logicalHost(url = '') {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
        return '';
    }
}

function normalizeWords(value = '') {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) || [];
}

function paragraphRecords(value = '') {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n{1,}|(?<=[.!?\u2026])\s+(?=[\p{Lu}\d])/u)
        .map(text => text.replace(/\s+/g, ' ').trim())
        .filter(text => (text.match(/[\p{L}\p{N}]/gu) || []).length >= 30)
        .map(text => {
            const normalized = normalizeWords(text).join(' ');
            return {
                text,
                normalized,
                hash: sha256(normalized),
                chars: (text.match(/[\p{L}\p{N}]/gu) || []).length
            };
        })
        .filter(record => record.normalized.length >= 20);
}

function shingleSet(value = '', size = 5, maximum = 4000) {
    const words = normalizeWords(value);
    if (words.length < size) return new Set();
    const shingles = [];
    for (let index = 0; index <= words.length - size; index++) {
        shingles.push(words.slice(index, index + size).join(' '));
    }
    if (shingles.length <= maximum) return new Set(shingles);

    const sampled = new Set();
    const step = shingles.length / maximum;
    for (let index = 0; index < maximum; index++) {
        sampled.add(shingles[Math.floor(index * step)]);
    }
    return sampled;
}

function jaccardSimilarity(first = new Set(), second = new Set()) {
    if (first.size === 0 || second.size === 0) return 0;
    const [small, large] = first.size <= second.size ? [first, second] : [second, first];
    let intersection = 0;
    for (const item of small) if (large.has(item)) intersection++;
    return intersection / (first.size + second.size - intersection);
}

function buildReviewQualityProfiles(details = []) {
    const documents = details
        .filter(detail => detail.status === 'success')
        .map(detail => {
            const text = String(detail.reviewText || '');
            return {
                detail,
                sourceId: reviewSourceId(detail),
                host: logicalHost(detail.url),
                text,
                paragraphs: paragraphRecords(text)
            };
        });

    const documentsByHost = new Map();
    const paragraphFrequencyByHost = new Map();
    for (const document of documents) {
        documentsByHost.set(document.host, (documentsByHost.get(document.host) || 0) + 1);
        if (!paragraphFrequencyByHost.has(document.host)) paragraphFrequencyByHost.set(document.host, new Map());
        const frequencies = paragraphFrequencyByHost.get(document.host);
        for (const hash of new Set(document.paragraphs.map(paragraph => paragraph.hash))) {
            frequencies.set(hash, (frequencies.get(hash) || 0) + 1);
        }
    }

    const profiles = new Map();
    for (const document of documents) {
        const words = normalizeWords(document.text);
        const semanticChars = (document.text.match(/[\p{L}\p{N}]/gu) || []).length;
        const sentences = (document.text.match(/[.!?\u2026](?:\s|$)/gu) || []).length;
        const hostDocuments = documentsByHost.get(document.host) || 1;
        const repeatedThreshold = Math.max(3, Math.ceil(hostDocuments * 0.12));
        const frequencies = paragraphFrequencyByHost.get(document.host) || new Map();
        const repeatedParagraphs = document.paragraphs.filter(paragraph => (
            (frequencies.get(paragraph.hash) || 0) >= repeatedThreshold
        ));
        const repeatedHashes = new Set(repeatedParagraphs.map(paragraph => paragraph.hash));
        const totalParagraphChars = document.paragraphs.reduce((sum, paragraph) => sum + paragraph.chars, 0);
        const repeatedChars = repeatedParagraphs.reduce((sum, paragraph) => sum + paragraph.chars, 0);
        const boilerplateRatio = totalParagraphChars > 0 ? repeatedChars / totalParagraphChars : 0;
        const uniqueText = document.paragraphs
            .filter(paragraph => !repeatedHashes.has(paragraph.hash))
            .map(paragraph => paragraph.text)
            .join('\n');
        const uniqueChars = (uniqueText.match(/[\p{L}\p{N}]/gu) || []).length;
        const pdfKind = document.detail.pdfKind || document.detail.artifacts?.pdfKind || 'none';
        const isOriginalDocument = pdfKind === 'original' || pdfKind === 'original_with_metadata';
        const hasReviewText = document.text.trim().length > 0;
        const signals = [];

        if (hasReviewText && !isOriginalDocument && semanticChars < 250) {
            signals.push({
                code: 'very_short_content',
                label: 'Very short extracted content',
                severity: 'high'
            });
        }
        if (hasReviewText && !isOriginalDocument && boilerplateRatio >= 0.68 && repeatedChars >= 180 && uniqueChars < 700) {
            signals.push({
                code: 'shared_boilerplate_dominates',
                label: 'Shared host boilerplate dominates',
                severity: 'high'
            });
        }
        if (hasReviewText && !isOriginalDocument && String(pdfKind).startsWith('restored') && semanticChars < 500) {
            signals.push({
                code: 'thin_restored_pdf',
                label: 'Restored PDF contains little source text',
                severity: 'medium'
            });
        }
        if (document.detail.retrievalSourceUrl && document.detail.retrievalSourceUrl !== document.detail.url) {
            signals.push({
                code: 'alternate_retrieval_source',
                label: 'Content came from an alternate retrieval URL',
                severity: 'info'
            });
        }

        const qualityScore = Math.max(0, Math.min(100, Math.round(
            25 +
            Math.min(35, Math.log10(Math.max(10, semanticChars)) * 10) +
            ((1 - boilerplateRatio) * 30) +
            (isOriginalDocument ? 10 : 0) -
            (signals.filter(signal => signal.severity === 'high').length * 25)
        )));

        profiles.set(document.sourceId, {
            sourceId: document.sourceId,
            host: document.host,
            semanticChars,
            words: words.length,
            sentences,
            paragraphCount: document.paragraphs.length,
            repeatedParagraphs: repeatedParagraphs.length,
            repeatedChars,
            uniqueChars,
            boilerplateRatio: Number(boilerplateRatio.toFixed(3)),
            qualityScore,
            pdfKind,
            isOriginalDocument,
            signals,
            cleanedText: uniqueText || document.text,
            shingles: shingleSet(uniqueText || document.text)
        });
    }

    return profiles;
}

module.exports = {
    reviewSourceId,
    logicalHost,
    paragraphRecords,
    shingleSet,
    jaccardSimilarity,
    buildReviewQualityProfiles
};
