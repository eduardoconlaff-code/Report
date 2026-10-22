// ============================================================
// 🧭 navigator.js — Scraperito Sailor, Tier 1 Heuristic Link Scorer
// ============================================================
// Scores and ranks discovered links by content relevance using
// static heuristic signals. Covers all 24 EU official languages.
// No AI, no API keys, zero extra dependencies.
//
// Strategy:
//  • URL signals are largely language-agnostic (path structure, file ext)
//  • Text signals use multilingual keyword sets across all EU languages
//  • Noise signals suppress login/cookie/contact in any member-state language
//  • 🏴‍☠️ Smart Sailor: Context-aware location penalties + Relevance bonuses
// ============================================================

const { JSDOM } = require('jsdom');

// ── HIGH: Legal instrument keywords ─────────────────────────
const TEXT_HIGH = new RegExp(
    '\\b(' +
    'regulation|directive|law|act|decree|statute|legislation|ordinance|provision|treaty|legal.?act|instrument|transposition|gazette|official.?journal|charter|resolution|protocol|convention|accord|agreement' +
    '|r[eè]glement|l[eè]gislation|arr[eê]t[eé]|ordonnance|disposition|loi|d[eé]cret|journal.?officiel|charte|r[eé]solution|protocole|convention' +
    '|verordnung|richtlinie|gesetz|erlass|vorschrift|regelung|rechtsvorschrift|umsetzung|durchf[üu]hrung|amtsblatt|gesetzblatt|statut|charta|entschlie[ßs]ung|protokoll|[üu]bereinkommen' +
    '|reglamento|directiva|legislaci[oó]n|ordenanza|disposici[oó]n|decreto|norma|transposici[oó]n|bolet[íi]n|diario.?oficial|estatuto|acta|carta|resoluci[oó]n|protocolo|convenio' +
    '|regolamento|direttiva|legge|decreto|normativa|legislazione|disposizione|recepimento|gazzetta.?ufficiale|statuto|atto|carta|risoluzione|protocollo|convenzione' +
    '|verordening|richtlijn|wetgeving|besluit|bepaling|verdrag|regeling|omzetting|staatsblad|statuut|handvest|resolutie|protocol|verdrag' +
    '|rozporz[ąa]dzenie|dyrektywa|ustawa|przepis|prawodawstwo|dekret|implementacja|dziennik.?ustaw|statut|karta|rezolucja|protok[óo][łl]|konwencja' +
    '|regulamento|diretiva|legisla[çc][ãa]o|disposi[çc][ãa]o|decreto.lei|transposi[çc][ãa]o|di[áa]rio.?oficial|estatuto|resolu[çc][ãa]o|protocolo|conven[çc][ãa]o' +
    '|regulament|directiv[ăa]|legisla[țt]ie|dispozi[țt]ie|hot[ăa]r[âa]re|monitorul.?oficial|statut|cart[ăa]|rezolu[țt]ie|protocol|conven[țt]ie' +
    '|f[öo]rordning|lagstiftning|lag|direktiv|best[äa]mmelse|f[öo]rdrag|genomf[öo]rande|offentlig.?publikation|stadga|protokoll|konvention' +
    '|forordning|lovgivning|lov|direktiv|bestemmelse|traktat|gennemf[øo]relse|lovtidende|vedt[æa]gt|protokol|konvention' +
    '|asetus|direktiivi|laki|s[äa][äa]d[öo]s|lainsääd[äa]nt[öo]|m[äa][äa]r[äa]ys|toimeenpano|virallinen.?lehti|peruskirja|p[öö]yt[äa]kirja|yleissopimus' +
    '|m[ää][ää]rus|direktiiv|seadus|[öo]igusakt|s[äa]te|rakendamine|teataja|p[õo]hikiri|protokoll|konventsioon' +
    '|regula|direkt[īi]va|likums|ties[īi]bu.?akts|noteikumi|ieviešana|v[ēe]stnesis|statūti|harta|protokols|konvencija' +
    '|reglamentas|direktyva|[įi]statymas|teis[eė]s.?aktas|nuostata|[įi]gyvendinimas|skelbimas|statutas|chartija|protokolas|konvencija' +
    '|na[řr][íi]zen[íi]|sm[ěe]rnice|z[áa]kon|pr[áa]vn[íi].?p[řr]edpis|provád[ěe]n[íi]|v[ěe]stn[íi]k|stanovy|listina|protokol|úmluva' +
    '|nariadenie|smernica|z[áa]kon|pr[áa]vny.?predpis|vykonanie|vestn[íi]k|štatút|charta|protokol|dohovor' +
    '|uredba|zakon|predpis|direktiva|dolo[čc]ba|prenos|uradni.?list|statut|listina|protokol|konvencija' +
    '|rendelet|ir[áa]nyelv|t[öo]rv[eé]ny|jogszab[áa]ly|rendelkez[eé]s|[áa]tv[eé]tel|k[öo]zl[öo]ny|alapszab[áa]ly|okm[áa]ny|jegyz[őo]k[öo]nyv|egyezm[ée]ny' +
    '|регламент|директива|закон|наредба|правен.?акт|законодателство|транспониране|държавен.?вестник|устав|харта|протокол|конвенция' +
    '|uredba|zakon|propis|direktiva|odredba|preuzimanje|narodne.?novine|statut|povelja|protokol|konvencija' +
    '|κανονισμ[όο]ς|οδηγ[ίι]α|ν[όο]μος|διάταγμα|νομοθεσ[ίι]α|εφαρμογ[ήη]|εφημερίδα|καταστατικό|χάρτης|πρωτόκολλο|σύμβαση' +
    '|regolament|direttiva|li[ġg]i|le[ġg]i[żz]lazzjon|gazzetta|statut|karta|protokoll|konvenzjoni' +
    '|rialach[áa]n|treoir|dl[íi]|reacht|reacht[aá][íi]ocht|iris.?oifigi[úu]il|reacht|cairt|pr[óo]tacal|coinbhinsi[úu]n' +
    ')\\b', 'i'
);

// ── MED: Document/publication type keywords ──────────────────
const TEXT_MED = new RegExp(
    '\\b(' +
    'guide|guidance|report|publication|document|handbook|manual|circular|bulletin|notice|factsheet|brochure|briefing|summary|technical.?report' +
    '|r[eè]glement|l[eè]gislation|arr[eê]t[eé]|ordonnance|disposition|loi|d[eé]cret|journal.?officiel|charte|r[eé]solution|protocole|convention' +
    '|leitfaden|bericht|ver[öo]ffentlichung|handbuch|merkblatt|rundschreiben|mitteilung|brosch[üu]re|zusammenfassung|technischer.?bericht' +
    '|gu[íi]a|informe|publicaci[óo]n|documento|manual|circular|bolet[íi]n|ficha|folleto|síntesis|resumen.?técnico' +
    '|guida|relazione|pubblicazione|documento|manuale|circolare|bollettino|scheda|opuscolo|sintesi' +
    '|gids|verslag|publicatie|document|handboek|circulaire|bulletin|brochure|samenvatting' +
    ')\\b', 'i'
);

// ── TOPIC: Workers, employment, social rights (posted workers domain) ──
const TEXT_TOPIC = new RegExp(
    '\\b(' +
    'worker|workers|staff|personnel|employment|employer|labor|labour|posted|posting|secondment|social|rights|protection|salary|wage|wages|pension|contribution|insurance|benefit|minimum.?wage|collective.?agreement|convention|accord|mobility|inspectorate|occupational.?health|safety|protection|dismissal|termination|union|syndicate|strikes|dialogue|redundancy|severance|liable|liability|a1.?certificate|portable.?document|liaison|competent.?authority' +
    '|travailleur|travailleurs|personnel|d[eé]tach[eé]|d[eé]tachement|emploi|salaire|retraite|cotisation|protection.?sociale|droit|accord.?collectif|convention|mobilit[eé]|inspection.?du.?travail|sant[eé].?au.?travail|s[eé]curit[eé]|licenciement|dialogue.?social|formulaire.?a1|bureau.?de.?liaison|autorit[eé].?comp[eé]tente' +
    '|arbeitnehmer[in]?|entsandt|entsendung|besch[äa]ftigung|lohn|geh[aä]lt|rente|sozial|tarifvertrag|mindestlohn|schutz|arbeitsmobilit[äa]t|arbeitsinspektion|arbeitsschutz|k[üu]ndigung|sozialer.?dialog|a1.?bescheinigung|verbindungsstelle|zust[äa]ndige.?beh[öo]rde' +
    '|trabajador|trabajadora|desplazado|desplazamiento|empleo|salario|pensi[óo]n|cotizaci[óo]n|protecci[óo]n.?social|convenio.?colectivo|salario.?m[íi]nimo|movilidad.?laboral|inspecci[oó]n.?de.?trabajo|seguridad.?y.?salud|prevenci[oó]n|despido|di[áa]logo.?social|formulario.?a1|certificado.?a1|oficina.?de.?enlace|autoridad.?competente' +
    '|lavoratori?|distaccato|distacco|occupazione|lavoro|salario|pensione|contributo|protezione.?sociale|contratto.?collettivo|salario.?minimo|mobilit[aà].?del.?lavoro|ispettorato.?del.?lavoro|salute.?e.?szicurezza|licenciement|dialogo.?sociale|modulo.?a1|autorit[aà].?competente' +
    '|werknemers?|gedetacheerd|detachering|tewerkstelling|lohn|pensioen|bijdrage|sociale.?bescherming|cao|minimumloon|arbeidsmobiliteit|arbeidsinspectie|arbeidsomstandigheden|ontslag|sociale.?dialoog|a1.?formulier' +
    '|pracownicy?|delegowany|delegowanie|zatrudnienie|wynagrodzenie|emerytura|sk[łl]adka|ochrona.?socjalna|uk[łl]ad.?zbiorowy|p[łl]aca.?minimalna|mobilno[śs][ćc].?pracy|inspekcja.?pracy|bezpiecze[ńn]stwo.?i.?higiena|zwolnienie|dialog.?spo[łl]eczny|za[śs]wiadczenie.?a1' +
    '|trabalhadores?|destacado|destaque|emprego|sal[áa]rio|pens[ãa]o|contribui[çc][ãa]o|prote[çc][ãa]o.?social|conven[çc][ãa]o.?coletiva|sal[áa]rio.?m[íi]nimo|mobilidade.?laboral|inspe[çc][ãa]o.?do.?trabalho|seguran[çc]a.?e.?sa[úu]de|despedimento|di[áa]logo.?social|formul[áa]rio.?a1' +
    '|lucr[ăa]tori?|deta[șs]at|deta[șs]are|angajare|salariu|pensie|contribu[țt]ie|protec[țt]ie.?social[ăa]|contract.?colectiv|salariu.?minim|mobilitate.?a.?for[țt]ei.?de.?munc[ăa]|inspec[țt]ia.?muncii|s[ăa]n[ăa]tate.?și.?securitate|concediere|dialog.?social|formular.?a1' +
    '|arbetstagare|utstationerad|utstationering|syssels[äa]ttning|l[öo]n|pension|avgift|socialt.?skydd|kollektivavtal|minimilön|arbetskraftens.?r[öo]rlighet|arbetsmilj[öo]|upps[äa]gning|social.?dialog|a1.?intyg' +
    ')\\b', 'i'
);

// ── LOW: General informational keywords ─────────────────────
const TEXT_LOW = new RegExp(
    '\\b(' +
    'information|overview|about|details|news|article|press|update|announcement|summary|introduction|faq|frequently.?asked' +
    '|informations?|aperçu|nouvelles?|article|mise.?[àa].?jour|annonce|r[eé]sum[eé]|pr[eé]sentation' +
    '|informationen?|[üu]berblick|neuigkeiten?|artikel|aktuell|ank[üu]ndigung|zusammenfassung|einf[üu]hrung' +
    '|informaci[oó]n|resumen|noticias?|art[íi]culo|actualizaci[oó]n|anuncio|introducci[oó]n' +
    '|informazioni?|panoramica|notizie?|articolo|aggiornamento|annuncio|riepilogo|introduzione' +
    '|informatie|overzicht|nieuws|artikel|bijwerking|aankondiging|samenvatting|inleiding' +
    '|informacje?|przegl[ąa]d|aktualności?|artyku[łl]|og[łl]oszenie|streszczenie|wprowadzenie' +
    '|informa[çc][ãa]o|vis[ãa]o.?geral|not[íi]cias?|artigo|atualiza[çc][ãa]o|resumo|introdu[çc][ãa]o' +
    ')\\b', 'i'
);

// ── Positive URL signals ─────────────────────────────────────
const URL_DOCUMENT = /\.(pdf|docx?|xlsx?|odt|ods)(\?|#|$)/i;
const URL_CONTENT_HIGH = /\/(document|publication|regulation|directive|legislation|decree|statute|law|guidance|guide|report|circular|bulletin|legal|juridique|rechtlich|juridico|giuridico|juridisch|pravni|prawny|jogi|νομικ[οό]|juridik|convention|accord|agreement|collective)\b/i;
const URL_CONTENT_MED = /\/(news|press|media|blog|article|post|update|announcement|info|actualit|neuigkeit|noticia|notizia|nieuws|aktueln|wiadomo|noticia|stire|nyhet|uudis|uutinen|jaunums|naujiena|zprava|správa|novica|h[íi]r|новини|vijest)\b/i;
const URL_LANG = /\/(en|fr|de|es|pl|it|nl|pt|cs|sk|sl|hu|ro|bg|hr|et|lv|lt|fi|sv|da|el|mt|ga)\//i;

// ── Noise text signals (multilingual) ───────────────────────
const NOISE_TEXT = new RegExp(
    '\\b(' +
    'contact|login|log.?in|sign.?in|sign.?up|register|subscribe|newsletter|cart|checkout|' +
    'cookie|privacy|terms|disclaimer|legal.?notice|accessibility|sitemap|help|faq|search|' +
    'print|share|comment|feedback|logout|profile|account|password|reset|donate|join|membership|' +
    'connexion|inscription|panier|caisse|cookies|confidentialit[eé]|mentions.?l[eé]gales|plan.?du.?site|aide|imprimer|partager|d[eé]connexion|' +
    'kontakt|anmelden|abmelden|registrieren|warenkorb|kasse|datenschutz|impressum|barrierefreiheit|sitemap|hilfe|drucken|teilen|' +
    'contacto|inicio.?sesi[oó]n|registrarse?|bolet[íi]n|carrito|aviso.?legal|privacidad|aksesibilidad|mapa.?web|ayuda|imprimir|compartir|' +
    'contatti?|accesso|registrazione?|carrello|note.?legali|privacy|accessibilit[aà]|mappa.?del.?sito|aiuto|stampa|condividi|' +
    'inloggen|registreren|winkelwagen|privacybeleid|juridische.?informatie|toegankelijkheid|sitemap|hulp|afdrukken|delen|' +
    'logowanie|rejestracja|koszyk|polityka.?prywatności|nota.?prawna|dost[eę]pno[śs][ćc]|mapa.?strony|pomoc|drukuj|udostępnij|wyloguj|' +
    'rgpd|gdpr|lopd|rgdp|dsgvo|protecci[oó]n.?de.?datos|protección.?datos|datos.?personales|aviso.?privacidad|política.?cookies|' +
    'protection.?des.?données|données.?personnelles|politique.?cookies|gestion.?cookies|' +
    'datenschutz|datenschutzerklärung|personenbezogene.?daten|cookie.?einstellungen|' +
    'protezione.?dei.?dati|dati.?personali|informativa.?privacy|gestione.?cookie|' +
    'bescherming.?persoonsgegevens|cookieverklaring|' +
    'ochrona.?danych|dane.?osobowe|polityka.?cookies|' +
    'protec[çc][ão][ao].?dados|rgpd|protec[țt]ia.?datelor|date.?personale|' +
    'tietosuoja|evästeasetukset|henkilötiedot|persónuvernd|vafrakökur|' +
    'read.?more|see.?more|learn.?more|more.?info|click.?here|ver.?más|leer.?más|más.?información|en.?savoir.?plus|weiterlesen|leggi.?di.?più|lees.?meer|czytaj.?więcej|citeste.?mai.?mult|läs.?mer|lue.?lisää' +
    ')\\b', 'i'
);

const NOISE_URL = /\/(contact|login|signin|signup|register|subscribe|newsletter|cart|checkout|cookie|privacy|terms|disclaimer|accessibility|sitemap|rss|feed|share|donate|imprint|impressum|datenschutz|aviso-legal|mentions-legales|note-legali|juridisch|rgpd|gdpr|lopd|proteccion-datos|protecci[oó]n-datos|datos-personales|politique-confidentialite|datenschutzerklaerung|protectia-datelor|ochrana-u-údaju|tietosuoja|cookiebeleid|cookiehinweis|derechos-digitales)\b|(facebook|twitter|x\.com|linkedin|instagram|youtube|tiktok|pinterest|t\.co|cookiepedia\.co\.uk|cookiebot\.com|onetrust\.com|trustarc\.com|usercentrics\.eu|iubenda\.com)(\.|\/)/i;

const CONTENT_CONTAINERS = new Set(['main', 'article', 'section']);

/**
 * Normalize URL for de-duplication (strips fragments, trailing slashes, and tracking params).
 */
function normalizeUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        url.hash = '';
        if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
            url.pathname = url.pathname.slice(0, -1);
        }
        const noiseParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid', 'sid'];
        noiseParams.forEach(p => url.searchParams.delete(p));
        return url.toString().toLowerCase();
    } catch (e) {
        return urlStr.toLowerCase();
    }
}

// Hash fragments are usually in-page anchors and can safely share one visit.
// Client-side routers, however, use `#/route` or `#!/route` as the entire
// document identity. Preserve only those structural route fragments for
// queue/visit keys so distinct SPA pages are never skipped as duplicates.
function normalizeVisitUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        const routeFragment = /^#!?\//.test(url.hash) ? url.hash : '';
        url.hash = '';
        if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
            url.pathname = url.pathname.slice(0, -1);
        }
        const noiseParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid', 'sid'];
        noiseParams.forEach(p => url.searchParams.delete(p));
        return `${url.toString().toLowerCase()}${routeFragment}`;
    } catch (e) {
        return urlStr.toLowerCase();
    }
}

function isClientSideRouteUrl(urlStr) {
    try {
        return /^#!?\//.test(new URL(urlStr).hash);
    } catch (_) {
        return false;
    }
}

/**
 * Score a single link for content relevance.
 */
function scoreLink(href, text, depth = 0, container = '') {
    let score = 0;
    let reason = 'Heurística estándar';
    const t = (text || '').trim();
    const h = (href || '').toLowerCase();

    // ── Positive: text signals (Bonuses) ──
    if (TEXT_HIGH.test(t)) {
        score += 15;
        reason = 'Alta relevancia legal detectada';
    } else if (TEXT_TOPIC.test(t)) {
        score += 15;
        reason = 'Relevancia temática (Derecho Laboral)';
    } else if (TEXT_MED.test(t)) {
        score += 8;
        reason = 'Documento oficial/Publicación';
    } else if (TEXT_LOW.test(t)) {
        score += 4;
        reason = 'Información general';
    }

    // ── Positive: URL signals ──
    if (URL_DOCUMENT.test(h)) score += 10;
    if (URL_CONTENT_HIGH.test(h)) score += 8;
    if (URL_CONTENT_MED.test(h)) score += 4;

    // ── Location Penalties/Bonuses (Smart Sailor) ──
    const containerLower = (container || '').toLowerCase();
    const isNoiseArea = ['nav', 'footer', 'header', 'aside'].includes(containerLower) || containerLower.includes('menu') || containerLower.includes('sidebar');
    const isContentArea = CONTENT_CONTAINERS.has(containerLower);

    if (isContentArea) {
        score += 10;
        if (reason === 'Heurística estándar') reason = 'Ubicado en área de contenido principal';
    } else if (isNoiseArea) {
        score -= 10; 
        if (score < 0) {
            reason = `Excluido: Ubicado en bloque de ruido (${containerLower})`;
        }
    }

    // ── Negative: extreme noise (forced exclusion) ──
    if (NOISE_TEXT.test(t) || NOISE_URL.test(h)) {
        score -= 30;
        reason = 'Excluido: Marcado como ruido (Login/Social/Contacto)';
    }

    // ── Depth penalty ──
    score -= depth * 0.5;

    // ── 🛡️ Baseline Penalty (Neutral links in unknown areas) ──
    // If no positive signals were caught (score <= 0) and not in a main content area
    if (score <= 0 && !isContentArea) {
        score -= 5;
        if (reason === 'Heurística estándar') reason = 'Baja relevancia detectada (Área no principal)';
    }

    const status = score >= 0 ? 'active' : 'excluded';
    
    return { score, status, reason };
}

/**
 * Sort an array of discovered link objects by relevance score.
 */
function sortLinksByScore(links, depth = 1) {
    return links
        .map(link => {
            const audit = scoreLink(link.href, link.text, depth, link.container || '');
            return {
                ...link,
                _score: audit.score,
                status: audit.status,
                reason: audit.reason
            };
        })
        .sort((a, b) => b._score - a._score);
}

/**
 * 🏴‍☠️ Smart Sailor: Extract and score all links with location awareness.
 */
function scoredLinksFromHtml(html, baseUrl, depth = 0) {
    try {
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        const seen = new Set();
        const links = [];

        // ── Expand noise selectors (IDs, Classes, Roles) ──
        const noiseSelectors = [
            'nav', 'footer', 'header', 'aside', 
            '[role="navigation"]', '[role="menubar"]', '[role="contentinfo"]', '[role="banner"]',
            '.menu', '.sidebar', '.navigation', '.cookie-banner', '.footer', '.header', '.nav', '.foot', '.head',
            '.mega-menu', '.sub-menu', '.dropdown', '.breadcrumbs', '.pagination', '.social-links',
            '#navigation', '#footer', '#header', '#sidebar', '#menu', '#nav', '#foot', '#head'
        ].join(', ');
        
        doc.querySelectorAll('a[href]').forEach(a => {
            let href = a.getAttribute('href');
            if (!href) return;
            
            try { 
                const fullUrl = new URL(href, baseUrl).href;
                href = fullUrl; 
            } catch { return; }
            if (!href.startsWith('http')) return;
            
            const key = normalizeUrl(href);
            if (seen.has(key)) return;
            seen.add(key);

            const text = a.textContent.replace(/\s+/g, ' ').trim();
            
            // 🔎 Detect container context (Recursive check for Noise vs Content)
            let container = '';
            const noiseParent = a.closest(noiseSelectors);
            const contentParent = a.closest('main, article, section, [role="main"]');
            
            if (noiseParent) {
                container = noiseParent.tagName.toLowerCase();
                // Refine DIV container identification
                if (container === 'div') {
                    const cls = (noiseParent.className || '').toLowerCase();
                    const id = (noiseParent.id || '').toLowerCase();
                    if (cls.includes('menu') || id.includes('menu')) container = 'menu';
                    else if (cls.includes('sidebar') || id.includes('sidebar')) container = 'sidebar';
                    else if (cls.includes('nav') || id.includes('nav')) container = 'nav';
                    else if (cls.includes('footer') || id.includes('footer')) container = 'footer';
                }
            } else if (contentParent) {
                container = contentParent.tagName.toLowerCase();
            }

            links.push({ href, text, container });
        });

        dom.window.close();
        return sortLinksByScore(links, depth);
    } catch (e) {
        return [];
    }
}

module.exports = { scoreLink, sortLinksByScore, scoredLinksFromHtml, normalizeUrl, normalizeVisitUrl, isClientSideRouteUrl };
