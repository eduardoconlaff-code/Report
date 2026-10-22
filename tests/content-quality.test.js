const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyContentQuality,
    classifyNonDocumentResponse,
    classifyNonDocumentUrl
} = require('../lib/content-quality');
const { getPreVisitSkipReason, getTemplateRecoveryCacheKey } = require('../lib/session');

test('pre-visit quality guard skips audio files and accessibility reading proxies', () => {
    const mp3 = 'https://media-eu.readspeaker.com/cache/9c9031f09adca8ecce0dc8785079a585.mp3';
    const readerProxy = 'https://app-eu.readspeaker.com/cgi-bin/rsent?customerid=4885&readclass=general_content&url=https://example.gov/page';

    assert.equal(classifyNonDocumentUrl(mp3).category, 'static_or_media_resource');
    assert.equal(classifyNonDocumentUrl(readerProxy).category, 'accessibility_audio_proxy');
    assert.match(getPreVisitSkipReason(mp3, 'https://example.gov/', 1, 1, false), /media resource/i);
    assert.match(getPreVisitSkipReason(readerProxy, 'https://example.gov/', 1, 1, false), /Accessibility audio/i);
});

test('response quality guard skips non-document media MIME types', () => {
    assert.equal(classifyNonDocumentResponse('audio/mpeg').category, 'media_response');
    assert.equal(classifyNonDocumentResponse('video/mp4').category, 'media_response');
    assert.equal(classifyNonDocumentResponse('application/pdf'), null);
});

test('content-quality guard rejects placeholders and title-only extraction', () => {
    const placeholder = classifyContentQuality({
        metadata: { title: 'Rsent' },
        plainText: 'No content harvested.'
    }, { url: 'https://app-eu.readspeaker.com/cgi-bin/rsent' });
    const titleOnly = classifyContentQuality({
        metadata: { title: 'Portal Transparencia | Inicio' },
        plainText: 'Portal Transparencia | Inicio'
    }, { url: 'https://transparencia.gob.es/' });

    assert.equal(placeholder.category, 'empty_extraction');
    assert.equal(titleOnly.category, 'empty_extraction');
    assert.equal(placeholder.retryable, true);
});

test('content-quality guard retains concise substantive notices and original documents', () => {
    const conciseNotice = classifyContentQuality({
        metadata: { title: 'Posting declaration' },
        plainText: 'Employers posting workers must submit the declaration before work starts. The competent authority may request the A1 certificate.'
    }, { url: 'https://example.gov/posting-declaration' });
    const shortOriginalPdf = classifyContentQuality({
        metadata: { title: 'Official form' },
        plainText: '',
        pdfBuffer: Buffer.from('%PDF-1.4')
    }, { url: 'https://example.gov/form.pdf' });

    assert.equal(conciseNotice, null);
    assert.equal(shortOriginalPdf, null);
});

test('content-quality guard rejects technical SPA shells that contain inflated CSS text', () => {
    const shell = `You need to enable JavaScript to run this app. svg:not(:root).svg-inline--fa { overflow: visible; } .fa-stack { position: relative; } .fa-a { color: red; } .fa-b { color: blue; } .fa-c { color: green; } .fa-d { color: black; } .fa-e { color: white; } .fa-f { color: gray; } <script src="/static/js/main.js"></script>`;
    const issue = classifyContentQuality({ metadata: { title: 'Retsinformation | Henter dokument...' }, plainText: shell }, { url: 'https://example.gov/legal-act' });

    assert.equal(issue?.category, 'dynamic_application_shell');
    assert.equal(issue?.retryable, true);
});

test('content-quality guard rejects CSS-only extraction but retains a substantive page with a CSS example', () => {
    const cssOnly = '.video-js { width: 300px; height: 150px; } .vjs-fluid:not(.vjs-audio-only-mode) { padding-top: 56.25% } Munkavédelem, Foglalkoztatás-felügyelet main .collapse, article .collapse, #content .collapse { display: block !important; visibility: visible !important; opacity: 1 !important; height: auto !important; max-height: none !important; overflow: visible !important; } .accordion-content, .panel-body, .expandable-content { display: block !important; visibility: visible !important; height: auto !important; } Munkavédelem, Foglalkoztatás-felügyelet';
    const sourceWithExample = 'The authority publishes this accessibility implementation guidance for public-service developers. The following CSS example illustrates one optional visual treatment: .notice { display: block; color: blue; } Agencies must still provide the full legal notice, contact details, accessible alternatives, and the substantive instructions that apply to users of the service.';

    assert.equal(classifyContentQuality({ metadata: { title: 'Questions' }, plainText: cssOnly })?.category, 'technical_css_shell');
    assert.equal(classifyContentQuality({ metadata: { title: 'Accessibility guidance' }, plainText: sourceWithExample }), null);
});

test('content-quality guard rejects consent-only pages but preserves legal cookie content', () => {
    const cookieOnly = classifyContentQuality({
        metadata: { title: 'Contact' },
        plainText: 'Nu\u017eni kola\u010di\u0107i omogu\u0107uju osnovne funkcije stranice. Funkcionalni kola\u010di\u0107i pamte odabire. Statisti\u010dki kola\u0107i poma\u017eu analizirati posje\u0107enost. Prihva\u0107am. Ne prihva\u0107am.'
    }, { url: 'https://example.gov/contact' });
    const legalCookieContent = classifyContentQuality({
        metadata: { title: 'Cookie regulation' },
        plainText: 'Article 5 of the Regulation establishes the legal conditions for cookies and other tracking technologies. The authority must apply the GDPR safeguards when processing personal data.'
    }, { url: 'https://example.gov/regulation' });

    assert.equal(cookieOnly?.category, 'cookie_consent_only');
    assert.equal(cookieOnly?.retryable, true);
    assert.equal(legalCookieContent, null);
});

test('content-quality guard recognises explicit cookie panels without category labels', () => {
    const frenchPanel = classifyContentQuality({
        metadata: { title: 'Un particulier' },
        plainText: 'Panneau de gestion des cookies. Ce site utilise des cookies. Tout accepter. Tout refuser. Personnaliser.'
    }, { url: 'https://example.gov/un-particulier' });
    const cookiePolicy = classifyContentQuality({
        metadata: { title: 'Gestion des cookies' },
        plainText: 'Panneau de gestion des cookies. Ce site utilise des cookies. Tout accepter. Tout refuser. Personnaliser.'
    }, { url: 'https://example.gov/cookies' });

    assert.equal(frenchPanel?.category, 'cookie_consent_only');
    assert.equal(cookiePolicy, null);
});

test('content-quality guard rejects Italian consent panels and external handoff notices', () => {
    const italianPanel = classifyContentQuality({
        metadata: { title: 'Dettaglio' },
        plainText: 'Questo sito utilizza i cookie per migliorare i servizi. I cookie tecnici sono necessari. Cookie statistici. Accetta tutti. Rifiuta i cookie non tecnici. Impostazioni dei cookie.'
    }, { url: 'https://www.inps.it/dettaglio' });
    const handoff = classifyContentQuality({
        metadata: { title: 'Workers moving within the EU' },
        plainText: 'The selected item corresponds to an external resource. Continuing you will be directed to the sub-portal.'
    }, { url: 'https://www.inps.it/workers-moving' });
    const substantiveExternalReference = classifyContentQuality({
        metadata: { title: 'Cross-border work guidance' },
        plainText: 'Employers must submit the posting declaration before work begins. The authority provides the official declaration service through an external resource, together with instructions, statutory deadlines, remuneration guidance, and inspection contacts for workers and undertakings.'
    }, { url: 'https://example.gov/guidance' });

    assert.equal(italianPanel?.category, 'cookie_consent_only');
    assert.equal(handoff?.category, 'external_handoff_only');
    assert.equal(substantiveExternalReference, null);
});

test('content-quality guard rejects a short browser-compatibility notice', () => {
    const issue = classifyContentQuality({
        plainText: 'Váš prohlížeč - MS Internet Explorer #version# - již nepatří mezi podporované prohlížeče. Doporučujeme přejít na některý jiný prohlížeč.'
    });

    assert.equal(issue?.category, 'browser_compatibility_notice');
    assert.equal(issue?.retryable, true);
});

test('content-quality guard rejects short shared widgets and deployment banners', () => {
    const accessibilityWidget = classifyContentQuality({
        metadata: { title: 'Equal opportunities' },
        plainText: 'This website has an accessibility system. Press Control-F10 to open the accessibility menu and adjust the page display.'
    }, { url: 'https://example.gov/equal-opportunities' });
    const wpmlBanner = classifyContentQuality({
        metadata: { title: 'Official reports' },
        plainText: 'This site is registered on wpml.org as a development site. Switch to a production domain before publishing content.'
    }, { url: 'https://example.gov/reports' });
    const projectFooter = classifyContentQuality({
        metadata: { title: 'Codes' },
        plainText: 'This website is developed within the project for institutional capacity and is co-funded by the European Social Fund.'
    }, { url: 'https://example.gov/codes' });

    assert.equal(accessibilityWidget?.category, 'accessibility_widget_only');
    assert.equal(wpmlBanner?.category, 'development_banner_only');
    assert.equal(projectFooter?.category, 'template_footer_only');
    assert.equal(projectFooter?.retryable, true);
});

test('content-quality guard rejects shared footer chrome but retains a concise official link index', () => {
    const chrome = classifyContentQuality({
        metadata: { title: 'Employer guidance' },
        plainText: '[Portal](/portal) [Forms](/forms) [Contacts](/contacts) [Facebook](https://facebook.example/authority) [Instagram](https://instagram.example/authority) [LinkedIn](https://linkedin.example/company) [Accessibility](/accessibility) [Site map](/sitemap) Call center 0800 000 000. © Official authority.'
    }, { url: 'https://official.example/employers' });
    const index = classifyContentQuality({
        metadata: { title: 'Employer guidance' },
        plainText: 'Employer guidance. [Insurance duties](/employers/insurance) [Monthly reporting](/employers/reporting) [Employer forms](/employers/forms) [Contribution rates](/employers/rates) [Electronic filing](/employers/filing) [Official contacts](/employers/contacts) [Publication archive](/employers/archive) [Legal basis](/employers/law)'
    }, { url: 'https://official.example/employers' });

    assert.equal(chrome?.category, 'shared_page_chrome_only');
    assert.equal(index, null);
});

test('content-quality guard recognises a Bulgarian accessibility overlay and Markdown-heavy WPML banner', () => {
    const bulgarianWidget = classifyContentQuality({
        metadata: { title: 'Equal opportunities' },
        plainText: '\u041c\u043e\u043b\u044f, \u043e\u0431\u044a\u0440\u043d\u0435\u0442\u0435 \u0432\u043d\u0438\u043c\u0430\u043d\u0438\u0435: \u0422\u043e\u0437\u0438 \u0443\u0435\u0431\u0441\u0430\u0439\u0442 \u0440\u0430\u0437\u043f\u043e\u043b\u0430\u0433\u0430 \u0441\u044a\u0441 \u0441\u0438\u0441\u0442\u0435\u043c\u0430 \u0437\u0430 \u0434\u043e\u0441\u0442\u044a\u043f\u043d\u043e\u0441\u0442. \u041d\u0430\u0442\u0438\u0441\u043d\u0435\u0442\u0435 Control-F11 \u0437\u0430 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0430.'
    }, { url: 'https://example.gov/equal-opportunities' });
    const markdownBanner = classifyContentQuality({
        metadata: { title: 'Reports' },
        plainText: 'This site is registered on [wpml.org](https://wpml.org/) as a development site. Switch to a production site key to [remove this banner](https://wpml.org/faq/how-to-remove-the-this-site-is-registered-on-wpml-org-as-a-development-site-notice/).'
    }, { url: 'https://example.gov/reports' });

    assert.equal(bulgarianWidget?.category, 'accessibility_widget_only');
    assert.equal(markdownBanner?.category, 'development_banner_only');
});

test('content-quality guard preserves genuine accessibility and project pages', () => {
    const accessibilityStatement = classifyContentQuality({
        metadata: { title: 'Accessibility statement' },
        plainText: 'This accessibility statement explains how the authority makes its public services accessible and how users may report a barrier. The competent office reviews each report and publishes improvement measures.'
    }, { url: 'https://example.gov/accessibility' });
    const projectInformation = classifyContentQuality({
        metadata: { title: 'Project funding information' },
        plainText: 'This project is co-funded by the European Social Fund and publishes its objectives, eligible beneficiaries, annual implementation plan, responsible public authority, budget allocation, monitoring committee, evaluation timetable, and contact arrangements for every interested applicant.'
    }, { url: 'https://example.gov/project-funding' });

    assert.equal(accessibilityStatement, null);
    assert.equal(projectInformation, null);
});

test('a shared project footer does not exclude a substantive short official page', () => {
    const issue = classifyContentQuality({
        metadata: { title: 'Workplace inspection procedure' },
        plainText: 'Employers must notify the labour inspectorate before posted work begins. The declaration identifies the undertaking, workers, workplace, service recipient, expected duration, and representative available to the authority. Inspectors may request employment contracts, pay records, working-time evidence, and A1 certificates. This website is developed within the project for institutional capacity and is co-funded by the European Social Fund.'
    }, { url: 'https://example.gov/inspection-procedure' });

    assert.equal(issue, null);
});

test('template recovery cache keys are exact, domain-scoped, and template-only', () => {
    const issue = { category: 'accessibility_widget_only' };
    const first = getTemplateRecoveryCacheKey({ plainText: 'Shared accessibility widget text' }, issue, 'https://one.example.gov/a');
    const same = getTemplateRecoveryCacheKey({ plainText: 'Shared accessibility widget text' }, issue, 'https://one.example.gov/b');
    const otherText = getTemplateRecoveryCacheKey({ plainText: 'Different accessibility widget text' }, issue, 'https://one.example.gov/c');
    const otherHost = getTemplateRecoveryCacheKey({ plainText: 'Shared accessibility widget text' }, issue, 'https://two.example.gov/a');

    assert.equal(first, same);
    assert.notEqual(first, otherText);
    assert.notEqual(first, otherHost);
    assert.equal(getTemplateRecoveryCacheKey({ plainText: 'text' }, { category: 'empty_extraction' }, 'https://one.example.gov/a'), null);
});
