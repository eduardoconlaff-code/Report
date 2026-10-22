// Corpus-quality checks are intentionally separate from HTTP/WAF validation.
// A response can be technically valid but still contain no useful source text.

const { detectDynamicApplicationShell } = require('./content-validation');

const STATIC_OR_MEDIA_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif|css|js|mjs|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|m4a|aac|flac|zip|rar|7z)(?:$|[?#])/i;
const ACCESSIBILITY_SERVICE_HOST = /(?:^|\.)(?:[^.]*readspeaker|readspeaker|tts|text-to-speech|texttospeech|responsivevoice)(?:\.|$)/i;
const ACCESSIBILITY_SERVICE_PATH = /\/(?:cgi-bin\/)?(?:rsent|readpage|speak|tts|voice|audio)(?:[/?#]|$)/i;
const PLACEHOLDER_TEXT = [
    /^no content harvested\.?$/i,
    /^embedded document viewer detected(?:,? but pdf could not be automatically extracted from viewer)?\.?$/i,
    /^pdf could not be automatically extracted from viewer\.?$/i,
    /^document viewer detected\.?$/i
];
const COOKIE_CONSENT_WORD = /(?:\bcookies?\b|kola\u010di\u0107(?:i|ima|e)?|kolacici?)/iu;
const COOKIE_CONSENT_ACTION = /(?:accept|reject|decline|allow|refuse|settings|preferences|manage|accetta|rifiuta|impostazioni|consenti|prihva\u0107am|odbijam|postavke)/iu;
const COOKIE_CONSENT_CATEGORY = /(?:necessary|functional|statistical|analytics|tracking|tecnic(?:i|he)|statistic(?:i|he)|nu\u017eni|funkcionalni|statisti\u010dki)/giu;
const LEGAL_COOKIE_CONTEXT = /(?:\barticle\s+\d|\b(?:law|act|regulation|directive)\b|\bgdpr\b|zakon(?:a|om|u)?|uredb(?:a|e|om)|direktiv(?:a|e|om))/iu;
const BROWSER_COMPATIBILITY_NOTICE = /(?:internet explorer|\bmsie\b|\btrident\b).{0,360}(?:not supported|unsupported|no longer supported|not compatible|nepatri.{0,60}podporovan|neni.{0,60}podporovan|nicht.{0,60}unterstutz|non.{0,60}pris en charge|no.{0,60}compatible)/iu;
const COOKIE_POLICY_TITLE = /(?:cookies?|cookie policy|privacy policy|gestion des cookies|politique de confidentialit[eé]|protection des donn[eé]es)/iu;
const COOKIE_INTERFACE_MARKER = /(?:cookie (?:settings|banner|preferences)|manage cookies|gestion des cookies|panneau de gestion|tout (?:accepter|refuser)|personnalis(?:er|ez)|accept all|reject all|allow all|necessary cookies|we use cookies|ce site utilise des cookies|questo sito utilizza i cookie|accetta tutti|rifiuta i cookie|impostazioni dei cookie)/iu;
const EXTERNAL_HANDOFF_MARKER = /(?:selected item corresponds to an external resource|continuing you will be directed to (?:the )?(?:sub-?portal|external resource)|you will be redirected to (?:an )?external (?:resource|site))/iu;
const ACCESSIBILITY_WIDGET_MARKER = /(?:accessibility system|accessibility widget|press\s+(?:ctrl|control)[+\- ]?f1[01]|systema\s+za\s+dostapnost|система\s+за\s+достъпност)/iu;
const DEVELOPMENT_BANNER_MARKER = /(?:wpml\.org.{0,140}development site|registered on wpml\.org as a development site)/iu;
const PROJECT_TEMPLATE_MARKER = /(?:website is developed within (?:the )?project|co-funded by (?:the )?european social fund|fund for bilateral relations|operational programme.{0,120}(?:project|fund))/iu;
const BULGARIAN_ACCESSIBILITY_WIDGET_MARKER = /\u0441\u0438\u0441\u0442\u0435\u043c\u0430\s+\u0437\u0430\s+\u0434\u043e\u0441\u0442\u044a\u043f\u043d\u043e\u0441\u0442/iu;
const ACCESSIBILITY_CONTROL_MARKER = /(?:ctrl|control)[+\- ]?f1[01]/iu;
const TEMPLATE_RELATED_TITLE = /(?:accessibilit|dostapnost|достъпност|wpml|development|project|programme|fund(?:ing)?|finan[ct]|co-?fund)/iu;

function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\r/g, '')
        .replace(/[\t ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeForComparison(value = '') {
    return normalizeText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\W_]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function stripMarkdownEnvelope(value = '', title = '') {
    const normalizedTitle = normalizeForComparison(title);
    return normalizeText(value)
        .split('\n')
        .map(line => line
            .replace(/^\s{0,3}#{1,6}\s+/, '')
            .replace(/^\s*[-*+]\s+/, '')
            .replace(/^\s*\[([^\]]+)\]\([^)]*\)\s*$/, '$1')
            .trim())
        .filter(line => {
            if (!line) return false;
            if (/^url\s*:/i.test(line)) return false;
            return normalizeForComparison(line) !== normalizedTitle;
        })
        .join('\n');
}

function classifyCookieConsentOnly(body = '', title = '') {
    const normalized = normalizeText(body);
    if (!COOKIE_CONSENT_WORD.test(normalized) || !COOKIE_CONSENT_ACTION.test(normalized)) return null;
    if (LEGAL_COOKIE_CONTEXT.test(normalized)) return null;
    // A dedicated public cookie/privacy policy is legitimate source content.
    // The guard targets incidental UI overlays on otherwise unrelated pages.
    if (COOKIE_POLICY_TITLE.test(title)) return null;

    const categoryCount = (normalized.match(COOKIE_CONSENT_CATEGORY) || []).length;
    const actionCount = (normalized.match(/(?:accept|reject|decline|allow|refuse|personalize|customi[sz]e|manage|settings|preferences|accetta|rifiuta|impostazioni|consenti|prihva\u0107am|odbijam|postavke)/giu) || []).length;
    const semanticChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
    // A real page can include an overlay. This guard is intentionally limited
    // to short responses dominated by several consent-interface categories.
    const isExplicitConsentInterface = COOKIE_INTERFACE_MARKER.test(normalized) && actionCount >= 2;
    if (semanticChars > 2500 || (categoryCount < 2 && !isExplicitConsentInterface)) return null;

    return {
        category: 'cookie_consent_only',
        reason: 'Extraction contains a cookie-consent interface rather than the requested source content.',
        retryable: true,
        metrics: { chars: semanticChars, consentCategories: categoryCount, consentActions: actionCount }
    };
}

function classifyExternalHandoffOnly(body = '') {
    const normalized = normalizeText(body);
    const semanticChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
    // A short notice that explicitly hands the user to another portal is not
    // the requested source document. The small cap protects genuine guidance
    // pages which may refer to an external service in passing.
    if (semanticChars > 600 || !EXTERNAL_HANDOFF_MARKER.test(normalized)) return null;

    return {
        category: 'external_handoff_only',
        reason: 'Extraction contains an external-resource handoff notice rather than the requested source content.',
        retryable: true,
        metrics: { chars: semanticChars }
    };
}

function classifyBrowserCompatibilityOnly(body = '') {
    const normalized = normalizeForComparison(body);
    const semanticChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
    // A real official notice may mention legacy browsers. Only reject a short
    // response where the compatibility warning is effectively all we received.
    if (semanticChars > 700 || !BROWSER_COMPATIBILITY_NOTICE.test(normalized)) return null;

    return {
        category: 'browser_compatibility_notice',
        reason: 'Extraction contains a browser-compatibility notice rather than the requested source content.',
        retryable: true,
        metrics: { chars: semanticChars }
    };
}

function classifyTemplateOnly(body = '', title = '') {
    const normalized = normalizeText(body);
    // URLs inside Markdown links are transport metadata, not visible body text.
    // Excluding them prevents a long banner/help URL from hiding template dominance.
    const visibleText = normalized.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    const semanticChars = (visibleText.match(/[\p{L}\p{N}]/gu) || []).length;
    // A short widget or deployment banner is never a source page. The title
    // exception protects genuine official accessibility/project documentation.
    if (semanticChars > 900 || TEMPLATE_RELATED_TITLE.test(title)) return null;

    const templates = [
        ['accessibility_widget_only', ACCESSIBILITY_WIDGET_MARKER, 'Extraction contains an accessibility widget rather than the requested source content.'],
        ['development_banner_only', DEVELOPMENT_BANNER_MARKER, 'Extraction contains a development/deployment banner rather than the requested source content.'],
        ['template_footer_only', PROJECT_TEMPLATE_MARKER, 'Extraction contains a shared project or funding footer rather than the requested source content.']
    ];

    for (const [category, marker, reason] of templates) {
        const hasMarker = marker.test(visibleText) || (
            category === 'accessibility_widget_only' &&
            BULGARIAN_ACCESSIBILITY_WIDGET_MARKER.test(visibleText)
        );
        if (!hasMarker) continue;

        const segments = visibleText
            .split(/\n+|(?<=[.!?\u2026])\s+/u)
            .map(segment => segment.trim())
            .filter(Boolean);
        const markedChars = segments
            .filter(segment => marker.test(segment) || (
                category === 'accessibility_widget_only' &&
                (BULGARIAN_ACCESSIBILITY_WIDGET_MARKER.test(segment) || ACCESSIBILITY_CONTROL_MARKER.test(segment))
            ))
            .reduce((total, segment) => total + (segment.match(/[\p{L}\p{N}]/gu) || []).length, 0);
        const dominance = semanticChars > 0 ? markedChars / semanticChars : 0;
        const residualChars = Math.max(0, semanticChars - markedChars);

        // Shared widgets and funding/deployment footers often coexist with a
        // valid concise page. Reject only when the marked template dominates.
        if (dominance >= 0.45 && residualChars <= 220) {
            return {
                category,
                reason,
                retryable: true,
                metrics: {
                    chars: semanticChars,
                    templateDominance: Number(dominance.toFixed(3)),
                    residualChars
                }
            };
        }
    }
    return null;
}

function classifySharedPageChromeOnly(body = '') {
    const normalized = normalizeText(body);
    const semanticChars = (normalized.match(/[\p{L}\p{N}]/gu) || []).length;
    if (semanticChars > 1800) return null;

    const links = Array.from(normalized.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)).map(match => match[1]);
    const socialLinks = links.filter(link => /(?:facebook|instagram|linkedin|twitter|youtube)/i.test(link)).length;
    const residual = normalized.replace(/!?\[[^\]]*\]\([^)]+\)/g, ' ');
    const residualSemanticChars = (residual.match(/[\p{L}\p{N}]/gu) || []).length;
    const hasFooterMarker = /(?:\u00a9|all rights reserved|copyright|call\s+(?:centre|center)|site map|mapa str[aá]nek)/iu.test(normalized);

    // A real concise index may be link-heavy. This requires the combined shape
    // of a footer: many links, multiple social destinations, a footer marker,
    // and almost no non-link source text.
    if (links.length < 8 || socialLinks < 2 || !hasFooterMarker || residualSemanticChars > 350) return null;

    return {
        category: 'shared_page_chrome_only',
        reason: 'Extraction contains shared footer or social-navigation chrome rather than the requested source content.',
        retryable: true,
        metrics: { chars: semanticChars, links: links.length, socialLinks, residualChars: residualSemanticChars }
    };
}

function classifyTechnicalCssShell(body = '') {
    const normalized = normalizeText(body);
    // Generated source text should never consist primarily of CSS. Require both
    // multiple declaration-bearing rules and almost no residual prose so that a
    // legitimate public page discussing a CSS example remains eligible.
    const cssRules = normalized.match(/(?:[.#][\w-]+(?:\s*:[\w-]+)?|(?:main|article|#content)\s+[.#\[][^{}]{0,180})\s*\{[^{}]{8,1200}\}/giu) || [];
    const declarationRules = cssRules.filter(rule => (
        rule.match(/\b(?:display|visibility|opacity|height|max-height|overflow|width|padding(?:-[\w-]+)?|position|color|margin|font(?:-[\w-]+)?)\s*:/giu) || []
    ).length >= 2);
    const cssChars = declarationRules.reduce((total, rule) => total + rule.length, 0);
    let residual = normalized;
    declarationRules.forEach(rule => { residual = residual.replace(rule, ' '); });
    const residualChars = (residual.match(/[\p{L}\p{N}]/gu) || []).length;

    if (declarationRules.length < 2 || cssChars < 120 || residualChars >= 180) return null;

    return {
        category: 'technical_css_shell',
        reason: 'Extraction is dominated by technical CSS with no substantive source text.',
        retryable: true,
        metrics: { cssRules: declarationRules.length, cssChars, residualChars }
    };
}

function classifyNonDocumentUrl(url = '') {
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_) {
        return null;
    }

    if (STATIC_OR_MEDIA_EXTENSION.test(parsed.pathname)) {
        return {
            category: 'static_or_media_resource',
            reason: 'Non-document static or media resource skipped before navigation.'
        };
    }

    const hasNestedSourceUrl = parsed.searchParams.has('url') || parsed.searchParams.has('source');
    const hasAccessibilityParameters = ['readclass', 'customerid', 'voice', 'speaker', 'audio', 'tts']
        .some(key => parsed.searchParams.has(key));
    const isAccessibilityProxy = (
        ACCESSIBILITY_SERVICE_HOST.test(parsed.hostname) ||
        (ACCESSIBILITY_SERVICE_PATH.test(parsed.pathname) && hasAccessibilityParameters)
    ) && (hasNestedSourceUrl || hasAccessibilityParameters);

    if (isAccessibilityProxy) {
        return {
            category: 'accessibility_audio_proxy',
            reason: 'Accessibility audio/reading proxy skipped; crawl the linked source page instead.'
        };
    }

    return null;
}

function classifyNonDocumentResponse(contentType = '') {
    const type = String(contentType || '').toLowerCase().split(';')[0].trim();
    if (/^(?:audio|video|image)\//.test(type)) {
        return {
            category: 'media_response',
            reason: `Non-document media response skipped (${type}).`
        };
    }
    return null;
}

function classifyContentQuality(result = {}, options = {}) {
    // Original documents can be short, scanned, or form-like. Their bytes are
    // the source of truth, so text-quality thresholds must never discard them.
    if (Buffer.isBuffer(result.pdfBuffer) || Buffer.isBuffer(result.docxBuffer) || Buffer.isBuffer(result.legacyDocBuffer)) return null;

    const urlIssue = classifyNonDocumentUrl(options.url || result.metadata?.url || result.url || '');
    if (urlIssue) return { ...urlIssue, retryable: false };

    const title = result.metadata?.title || '';
    const source = result.plainText || result.allText || '';
    const dynamicShell = detectDynamicApplicationShell(source);
    if (dynamicShell.isShell) {
        return {
            category: 'dynamic_application_shell',
            reason: 'Extraction contains an application bootstrap shell rather than the requested source document.',
            retryable: true,
            metrics: { cssRules: dynamicShell.cssRuleCount || 0 }
        };
    }
    const body = stripMarkdownEnvelope(source, title);
    const compactBody = normalizeText(body);
    const compactComparison = normalizeForComparison(compactBody);
    const compactTitle = normalizeForComparison(title);

    const technicalCssIssue = classifyTechnicalCssShell(compactBody);
    if (technicalCssIssue) return technicalCssIssue;

    const cookieConsentIssue = classifyCookieConsentOnly(compactBody, title);
    if (cookieConsentIssue) return cookieConsentIssue;

    const externalHandoffIssue = classifyExternalHandoffOnly(compactBody);
    if (externalHandoffIssue) return externalHandoffIssue;

    const browserCompatibilityIssue = classifyBrowserCompatibilityOnly(compactBody);
    if (browserCompatibilityIssue) return browserCompatibilityIssue;

    const templateIssue = classifyTemplateOnly(compactBody, title);
    if (templateIssue) return templateIssue;

    const chromeIssue = classifySharedPageChromeOnly(compactBody);
    if (chromeIssue) return chromeIssue;

    if (!compactBody || PLACEHOLDER_TEXT.some(pattern => pattern.test(compactBody))) {
        return {
            category: 'empty_extraction',
            reason: 'Extraction returned no document body; the response is not suitable for the corpus.',
            retryable: true,
            metrics: { chars: 0, words: 0, sentences: 0 }
        };
    }

    if (compactComparison === compactTitle || compactComparison.length < 12) {
        return {
            category: 'title_only_extraction',
            reason: 'Extraction contains only a title, breadcrumb, or similarly minimal page chrome.',
            retryable: true,
            metrics: { chars: compactBody.length, words: 0, sentences: 0 }
        };
    }

    const words = compactBody.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'\u2019.-]*/gu) || [];
    const semanticChars = (compactBody.match(/[\p{L}\p{N}]/gu) || []).length;
    const sentences = (compactBody.match(/[.!?\u2026](?:\s|$)/gu) || []).length;

    // This is deliberately conservative. A concise official notice with two
    // complete sentences remains eligible; menus, placeholders, and headings do not.
    if (semanticChars < 80 || words.length < 12 || (semanticChars < 180 && words.length < 30 && sentences < 2)) {
        return {
            category: 'insufficient_substantive_text',
            reason: 'Extracted text is too limited to form a reliable standalone source document.',
            retryable: true,
            metrics: { chars: semanticChars, words: words.length, sentences }
        };
    }

    return null;
}

module.exports = {
    classifyContentQuality,
    classifyNonDocumentResponse,
    classifyNonDocumentUrl
};
