const { classifyContentValidity } = require('./content-validation');
const { classifyContentQuality } = require('./content-quality');

// These routes are intentionally different. Document recovery must never inherit
// an HTML-only provider merely because another branch changes its order.
const FALLBACK_ROUTES = Object.freeze({
    sailorLinks: Object.freeze(['Jina Reader', 'Trawl', 'Archive.org', 'Google Cache']),
    documentRecovery: Object.freeze(['Google Cache', 'Jina Reader', 'Archive.org']),
    htmlRecovery: Object.freeze(['Google Cache', 'Jina Reader', 'Trawl', 'Archive.org']),
    lowQualityRecovery: Object.freeze(['Direct Fetch', 'Jina Reader', 'Trawl'])
});

const TEMPLATE_RECOVERY_CATEGORIES = new Set([
    'accessibility_widget_only',
    'development_banner_only',
    'template_footer_only'
]);

const SPA_RETRY_CATEGORIES = new Set([
    'empty_extraction',
    'insufficient_substantive_text',
    'dynamic_application_shell',
    'technical_css_shell'
]);

function getFallbackRoute(routeName, providers = {}) {
    const providerNames = FALLBACK_ROUTES[routeName];
    if (!providerNames) throw new Error(`Unknown extraction fallback route: ${routeName}`);

    return providerNames.map(name => {
        const provider = providers[name];
        const fn = typeof provider === 'function' ? provider : provider?.fn;
        if (typeof fn !== 'function') {
            throw new Error(`Missing provider "${name}" for extraction fallback route "${routeName}"`);
        }
        const displayName = typeof provider === 'function' ? name : (provider?.name || name);
        return { name: displayName, fn };
    });
}

function assessExtractedContent(result = {}, options = {}) {
    const validityIssue = classifyContentValidity(result, options);
    if (validityIssue) {
        return {
            ok: false,
            phase: 'validity',
            issue: validityIssue,
            validityIssue,
            qualityIssue: null
        };
    }

    const qualityIssue = classifyContentQuality(result, options);
    return {
        ok: !qualityIssue,
        phase: qualityIssue ? 'quality' : null,
        issue: qualityIssue || null,
        validityIssue: null,
        qualityIssue: qualityIssue || null
    };
}

function looksLikeOfficeBinaryText(value = '') {
    const text = String(value || '').slice(0, 6000);
    if (!text) return false;

    const hasZipHeader = text.includes('PK\u0003\u0004') || text.startsWith('PK');
    const hasOfficeParts =
        /\[Content[_\\]?Types\]\.xml/i.test(text) ||
        /word[\\/]_rels[\\/]document\.xml\.rels/i.test(text) ||
        /word[\\/]document\.xml/i.test(text) ||
        /_rels[\\/]\.rels/i.test(text);

    return hasZipHeader && hasOfficeParts;
}

function isTemplateRecoveryCategory(category = '') {
    return TEMPLATE_RECOVERY_CATEGORIES.has(category);
}

function isSpaRetryCategory(category = '') {
    return SPA_RETRY_CATEGORIES.has(category);
}

module.exports = {
    FALLBACK_ROUTES,
    assessExtractedContent,
    getFallbackRoute,
    isSpaRetryCategory,
    isTemplateRecoveryCategory,
    looksLikeOfficeBinaryText
};
