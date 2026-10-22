const crypto = require('crypto');

// Content fingerprints are audit-only. Different official URLs always retain
// their own artifacts because extraction equality is not proof of source equality.
function normalizeExactExtractedText(value = '') {
    return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function getExtractedTextAuditFingerprint(result = {}) {
    const text = normalizeExactExtractedText(result.plainText || '');
    if (!text) return null;
    return {
        kind: 'extracted_text_audit',
        hash: sha256(Buffer.from(text, 'utf8')),
        scope: 'Exact stored TXT content after line-ending normalization; audit only, never automatic artifact deduplication'
    };
}

function getContentAuditFingerprint(result = {}) {
    return getExtractedTextAuditFingerprint(result);
}

// Keeps a non-destructive trail of matching stored TXT. It is intentionally
// It only flags a review and never suppresses an artifact.
class ContentReviewRegistry {
    constructor() {
        this.entries = new Map();
    }

    claim(fingerprint, url) {
        const key = fingerprint ? `${fingerprint.kind}:${fingerprint.hash}` : '';
        if (!key) return null;

        const existing = this.entries.get(key);
        if (existing) return existing;

        const entry = { url, fingerprint };
        this.entries.set(key, entry);
        return null;
    }
}

module.exports = {
    normalizeExactExtractedText,
    getExtractedTextAuditFingerprint,
    getContentAuditFingerprint,
    ContentReviewRegistry
};
