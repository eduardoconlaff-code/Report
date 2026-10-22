const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyContentValidity, detectDynamicApplicationShell } = require('../lib/content-validation');

function validate({ url = 'https://example.gov/document', title = '', text = '' } = {}) {
    return classifyContentValidity({ metadata: { url, title }, allText: text }, { url });
}

test('rejects browser network-error documents even when they contain escaped markdown text', () => {
    const issue = validate({ text: 'No se puede acceder a este sitio\nERR\\_HTTP2\\_PROTOCOL\\_ERROR' });
    assert.equal(issue?.category, 'browser_network_error');
});

test('rejects Jina HTTP error wrappers instead of accepting their navigation chrome', () => {
    const issue = validate({ text: 'Warning: Target URL returned error 429: Too Many Requests\n# Ministry navigation' });
    assert.equal(issue?.category, 'http_error_page');
});

test('rejects Cloudflare verification pages regardless of HTML size', () => {
    const issue = validate({ title: 'Verifying your browser', text: 'Verifying your browser... window.onload = function () {}' });
    assert.equal(issue?.category, 'waf_challenge');
});

test('rejects explicit soft-404 pages', () => {
    const issue = validate({ title: 'Error 404', text: 'The address requested does not exist.' });
    assert.equal(issue?.category, 'soft_404');
});

test('rejects French not-found templates that return a complete HTML page', () => {
    const issue = validate({
        title: 'Page non trouv\u00e9e | Minist\u00e8re du Travail',
        text: 'La page que vous cherchez est introuvable. Excusez-nous pour la g\u00eane occasionn\u00e9e. Consultez notre page d\'accueil ou utilisez la recherche.'
    });

    assert.equal(issue?.category, 'soft_404');
});

test('rejects public-looking authentication pages', () => {
    const issue = validate({
        url: 'https://example.gov/wp-admin/',
        title: 'Autentificare WordPress',
        text: 'Autentificare WordPress Username Password'
    });
    assert.equal(issue?.category, 'authentication_page');
});

test('does not reject real legal content that mentions access restrictions', () => {
    const issue = validate({
        title: 'Occupational Safety and Health Act',
        text: 'Article 1. The competent authority may restrict access to hazardous workplaces.'
    });
    assert.equal(issue, null);
});

test('identifies a technical SPA shell without treating ordinary legal HTML as a shell', () => {
    const shell = `
        <div id="root">You need to enable JavaScript to run this app.</div>
        <style>.svg-inline--fa { display: inline-block; } .fa-stack { position: relative; } .fa-a { color: red; } .fa-b { color: blue; } .fa-c { color: green; } .fa-d { color: black; } .fa-e { color: white; } .fa-f { color: gray; }</style>
        <script src="/static/js/main.js"></script>`;
    const legalHtml = '<main><h1>Act on posted workers</h1><p>Article 1 establishes the official rules for employers.</p></main>';

    assert.equal(detectDynamicApplicationShell(shell).isShell, true);
    assert.equal(detectDynamicApplicationShell(legalHtml).isShell, false);
});

test('identifies an OutSystems bootstrap document that still requires JavaScript', () => {
    const shell = `
        <script>window.OutSystemsApp = { basePath: '/dr/' };</script>
        <script src="/dr/scripts/OutSystemsManifestLoader.js"></script>
        <body><span>JavaScript is required</span></body>`;
    const renderedDocument = `
        <script>window.OutSystemsApp = { basePath: '/dr/' };</script>
        <main><h1>Lei n.º 29/2017</h1><p>Artigo 1.º Objeto. A presente lei aplica-se ao destacamento de trabalhadores.</p></main>`;

    assert.equal(detectDynamicApplicationShell(shell).isShell, true);
    assert.equal(detectDynamicApplicationShell(renderedDocument).isShell, false);
});
