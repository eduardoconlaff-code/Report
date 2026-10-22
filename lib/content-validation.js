// Central validation for pages that returned HTTP 200 but are not the requested content.
function normalizeContent(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\\_/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function contentSample(result = {}) {
    const metadata = result.metadata || {};
    return `${metadata.title || ''}\n${result.allText || result.plainText || ''}`.slice(0, 12000);
}

// A number of official portals return a React/SPA bootstrap document first and
// load the actual source through a later API request. CSS or framework scripts
// can make that shell look large even though it has no source content.
function detectDynamicApplicationShell(value = '') {
    const raw = String(value || '');
    const normalized = normalizeContent(raw);
    const hasShellMessage = [
        'you need to enable javascript to run this app',
        'please enable javascript to continue',
        'javascript is required to run this application',
        'javascript is required',
        'loading application',
        'loading document',
        'henter dokument'
    ].some(marker => normalized.includes(marker));

    if (!hasShellMessage) return { isShell: false };

    const hasAppBootstrap = /(?:id\s*=\s*["'](?:root|app|__next)["']|data-reactroot|\/(?:static\/js|_next\/static)|react(?:\.production)?(?:\.min)?\.js|window\.__(?:next|cf))/i.test(raw);
    // OutSystems exposes a server-rendered bootstrap document before its
    // React view has loaded. The framework marker alone is not enough to
    // classify a page as a shell; it must also contain a loading message.
    const hasOutSystemsBootstrap = /(?:window\.OutSystemsApp|OutSystemsManifestLoader|OutSystemsReactView|OutSystems\.js)/i.test(raw);
    const cssRuleCount = (raw.match(/(?:^|[;}])\s*(?:[.#][a-z][\w-]*|svg(?:[:\[]|\s))[^{}]{0,180}\{[^{}]{5,600}\}/gim) || []).length;

    return {
        isShell: hasAppBootstrap || hasOutSystemsBootstrap || cssRuleCount >= 8,
        hasShellMessage,
        hasAppBootstrap,
        hasOutSystemsBootstrap,
        cssRuleCount
    };
}

function classifyContentValidity(result = {}, options = {}) {
    const sample = normalizeContent(contentSample(result));
    const title = normalizeContent(result.metadata?.title || '');
    const url = String(options.url || result.metadata?.url || result.url || '');
    const firstChunk = sample.slice(0, 3000);

    if (!sample) return null;

    if (/\berr_[a-z0-9_]+\b/.test(firstChunk) ||
        /no se puede acceder a este sitio|this site can.t be reached|site can.t be reached|connection (?:timed out|reset|closed|refused)|dns_probe_finished/i.test(firstChunk)) {
        return {
            category: 'browser_network_error',
            reason: 'Browser returned a network error page instead of the requested content.',
            retryable: true
        };
    }

    const jinaHttpError = /warning:\s*target url returned error\s*(?:401|403|404|408|409|410|429|5\d\d)\b/.test(firstChunk);
    const explicitHttpError = /\b(?:http\s*)?(?:401|403|404|408|409|410|429|500|502|503|504)\b/.test(title) &&
        /(?:forbidden|too many requests|internal server error|service unavailable|not found|access denied)/.test(firstChunk);
    if (jinaHttpError || explicitHttpError) {
        return {
            category: 'http_error_page',
            reason: 'Retrieved content is an HTTP error page, not the requested document.',
            retryable: true
        };
    }

    const wafTitle = /^(?:just a moment|un momento|access denied|unauthorized request blocked|security verification|verifying your browser)/.test(title);
    const wafBody = /verifying your browser|checking your browser|performing security verification|challenges\.cloudflare\.com|max challenge attempts exceeded|unauthorized request blocked/.test(firstChunk);
    if (wafTitle || wafBody) {
        return {
            category: 'waf_challenge',
            reason: 'Retrieved content is a security or WAF challenge, not the requested document.',
            retryable: true
        };
    }

    const soft404Title = /^(?:error\s*404|pagina no encontrada|page not found|not found|document not found|seite nicht gefunden|page (?:introuvable|non trouvee)|pagina non trovata|pagina nao encontrada)\b/.test(title);
    const soft404Body = /(?:address|url).{0,120}(?:does not exist|not found)|error\s*404\s*[-:]|pagina no encontrada|page not found|document not found|la page que vous (?:cherchez|demandez).{0,120}(?:introuvable|n existe pas)|(?:cette|la) page (?:est |a ete )?(?:introuvable|supprimee|non disponible)/.test(firstChunk);
    if (soft404Title || soft404Body) {
        return {
            category: 'soft_404',
            reason: 'Retrieved content is a not-found page instead of the requested document.',
            retryable: false
        };
    }

    const loginUrl = /\/(?:wp-admin(?:\/|$)|wp-login\.php|site\/login)(?:[/?#]|$)/i.test(url);
    const loginForm = /(?:wordpress\s+login|autentificare\s+wordpress|username|user name).{0,500}(?:password|parola)/.test(firstChunk);
    if (loginUrl || loginForm) {
        return {
            category: 'authentication_page',
            reason: 'Retrieved content is an authentication page, not public source content.',
            retryable: false
        };
    }

    try {
        const parsedUrl = new URL(url);
        if (/^www\.google\./i.test(parsedUrl.hostname) && /^\/imgres$/i.test(parsedUrl.pathname)) {
            return {
                category: 'search_interstitial',
                reason: 'Retrieved URL is a Google image-search redirect, not a source document.',
                retryable: false
            };
        }
    } catch (_) {
        // Invalid URLs are handled by the crawler before extraction.
    }

    return null;
}

function createUnusableContentError(issue) {
    const error = new Error(`UNUSABLE_CONTENT:${issue.category}:${issue.reason}`);
    error.code = 'UNUSABLE_CONTENT';
    error.contentValidation = issue;
    return error;
}

function isUnusableContentError(error) {
    return error?.code === 'UNUSABLE_CONTENT' || String(error?.message || '').startsWith('UNUSABLE_CONTENT:');
}

function getUnusableContentIssue(error) {
    return error?.contentValidation || null;
}

module.exports = {
    classifyContentValidity,
    detectDynamicApplicationShell,
    createUnusableContentError,
    isUnusableContentError,
    getUnusableContentIssue
};
