# Scraperito Sailor Extraction Contract

## 1. Status and purpose

This is the mandatory engineering contract for changes to Sailor retrieval,
extraction, fallback, document handling, content validation, quality assessment,
storage, review signals, and related exports. Read it before changing any of those
areas.

The contract has four purposes:

1. Make the current decision flow explicit instead of leaving it distributed across
   large functions.
2. Preserve behavior that already works when a new website pattern is added.
3. Record the historical country cases that produced current generic safeguards.
4. Define the evidence and tests required before a change may be considered safe.

The current runtime is the repository root. `Sailor production_ready` is a separate,
inactive online snapshot and must not be modified by default. Pocket Sailor is
updated only after root verification.

This document describes the current code, not an idealized replacement. Remaining
technical debt is recorded explicitly in section 13.

Documentation audit: 2026-09-26. The engineering workflow and current test selection
live in `docs/CHANGE_SAFETY.md` and `docs/REGRESSION_MATRIX.md`. Country inventory and
past live results below are dated evidence, not a fresh replay of every source.

## 2. Non-negotiable invariants

Every extraction change must preserve these invariants:

- One submitted input row remains one ordered mission-manifest row. Retrieval URL
  normalization may prevent duplicate work, but must not erase the original row.
- Every non-empty submitted line without a recognised `http://` or `https://` URL is
  retained as an explicit invalid row. It may not disappear before mission creation.
- HTTP 200, a browser navigation, or a generated PDF is never sufficient evidence
  of success.
- Original PDF, DOCX, and legacy DOC bytes are source-of-truth artifacts. HTML text
  thresholds must not reject a valid original document.
- A fallback response is validated with the same validity-first, quality-second
  contract as the primary response.
- Scraper-injected interaction CSS is transient browser state. It must be removed
  before HTML serialization and must never count as source text or justify a PDF.
- Different fallback routes remain different. An HTML provider must not leak into a
  document route simply because a shared array was edited.
- Automated navigation must not silently change source identity. The submitted URL,
  final browser URL, retrieval URL, and official alternate source are distinct data.
- Similar titles, filenames, paths, or text are review signals, never automatic proof
  that two official sources are equivalent.
- Review decisions do not mutate original mission artifacts. They affect review
  fields and curated exports only.
- A domain-specific adapter is allowed only when it maps deterministically to a
  verified official source. Generic DOM and quality improvements are preferred.
- A new positive case must include a counterexample demonstrating what the new rule
  must not capture.
- Root Sailor is verified first. Pocket is synchronized deliberately and tested
  separately. `Sailor production_ready` remains untouched unless explicitly requested.
  Record Pocket synchronization as completed, deferred or not applicable for each
  change; shared policy does not imply identical runtime packaging/process models.

## 3. Module ownership

| Concern | Owner | Contract |
| --- | --- | --- |
| Mission orchestration, queue, retries and fallback dispatch | `lib/session.js` | Decides when to retrieve again; does not invent extraction validity rules. |
| Browser navigation, dynamic interaction, document interception and DOM extraction | `lib/scraper.js` | Produces source candidates and retrieval evidence; does not decide mission row order. |
| Shared fallback route order and cross-stage assessment | `lib/extraction-policy.js` | Single source of truth for named routes and validity-before-quality assessment. |
| Error, WAF, authentication and interstitial detection | `lib/content-validation.js` | Rejects responses that are not the requested source. Runs before quality. |
| Minimal, template-only, media and low-substance detection | `lib/content-quality.js` | Rejects or retries unusable corpus content after validity passes. |
| Official deterministic alternate sources | `lib/official-source-resolver.js` | Resolves known official identifiers; cannot silently substitute a merely related document. |
| Mission persistence and artifact integrity | `lib/results.js`, `lib/storage.js` | Preserve row identity, artifact state and export traceability. |
| Human curation signals | `lib/review-quality.js`, review API/UI | Suggest review; never suppress originals automatically. |
| HTTP endpoints and local UI delivery | `server.js`, `public/` | Present state; do not redefine extraction semantics. |

Duplicated policy code across these owners is a defect. Shared behavior should move
to a small pure helper only when its callers genuinely require identical semantics.

## 4. End-to-end decision flow

The active flow for one submitted URL is:

1. `runScraperSession()` retains the original input row and schedules retrieval.
2. URL/resource classification routes obvious PDF, Word, non-document media, or HTML.
3. A deterministic official alternate source may be resolved before a generic bypass
   only when the submitted identifier can be mapped exactly.
4. The browser/direct document path retrieves bytes or HTML.
5. `scrapePage()` protects source identity, handles navigations/downloads, waits for
   dynamic content when justified, and calls `smartExtract()` for HTML.
6. `assessExtractedContent()` runs validity first and quality second.
7. A retry or named fallback route may run only for the relevant failure class.
8. Every recovered response goes through the same assessment again.
9. Valid artifacts are persisted and verified before final success.
10. The ordered manifest records the outcome for the original input row.
11. Review analysis adds non-destructive signals after collection.

### Why validity runs before quality

A Cloudflare page can contain thousands of polished words. A localized 404 can look
like a concise official notice. Quality scoring first would allow these responses to
be treated as useful text. `assessExtractedContent()` therefore exposes one ordered
decision:

```text
validity issue -> stop and recover/fail as a source error
no validity issue + quality issue -> retry/recover as unusable extraction
no issue -> eligible for persistence
```

Do not call both classifiers independently in a new orchestration branch.

## 5. Fallback route contract

Fallback order is defined only in `lib/extraction-policy.js`.

| Route | Exact current order | Used for |
| --- | --- | --- |
| `sailorLinks` | Jina Reader, Trawl, Archive.org, Google Cache | Sailor-mode link recovery after primary navigation failure. |
| `documentRecovery` | Google Cache, Jina Reader, Archive.org | A URL expected to identify a document when direct document retrieval fails. |
| `htmlRecovery` | Google Cache, Jina Reader, Trawl, Archive.org | Blocked or unusable HTML retrieval. |
| `lowQualityRecovery` | Direct Fetch, Jina Reader, Trawl | Valid transport with empty, shell, or low-quality extraction. |

`getFallbackRoute()` fails closed when a named provider is absent. This is deliberate:
a partially constructed chain must not silently change behavior.

Two recovery optimizations must remain distinct. Exact-template recovery reuses a
method for a domain-scoped template fingerprint and only the eligible template
categories below. Host scheduling separately tracks repeated access failures and
validated reader/solver successes, with primary canaries and bounded pacing. A
provider preference leaves normal recovery available if it fails; neither mechanism
may skip validation or classify every page on a host as equivalent.

### Provider boundaries

- Direct Fetch is lightweight and useful for server-rendered HTML or direct documents;
  it does not execute client JavaScript.
- Jina Reader may recover readable public text but is a third-party representation;
  its returned URL and validity remain auditable.
- Trawl is a browser recovery provider for difficult dynamic/WAF cases. Local Sailor
  may use it when configured. Pocket exposes it as optional because it is not bundled.
- FlareSolverr remains a browser fallback where configured, but a 200 response from it
  is not proof that the challenge was solved.
- Archive.org and Google Cache are recovery representations, not automatically the
  current canonical source.

## 6. Validation and quality taxonomy

### Validity categories

`lib/content-validation.js` rejects source-level failures:

| Category | Meaning |
| --- | --- |
| `browser_network_error` | Browser/network error page or transport message. |
| `http_error_page` | Returned body represents an HTTP error. |
| `waf_challenge` | Cloudflare, Unauthorized Request Blocked, or equivalent security challenge. |
| `soft_404` | Localized not-found page returned as normal HTML. |
| `authentication_page` | Login/authentication UI instead of public source content. |
| `search_interstitial` | Search or technical interstitial replaced the requested source. |

`scraper.js` also emits `automated_navigation_source_mismatch` when browser activity
lands on an unrelated target. That is a source-identity failure and must not be
converted into a low-quality success.

### Quality categories

`lib/content-quality.js` evaluates content only after validity passes:

| Category | Intended meaning | Retry behavior |
| --- | --- | --- |
| `cookie_consent_only` | Consent interface dominates and no source body remains. | Retryable. |
| `external_handoff_only` | Page contains only a handoff/link to another service. | Retryable. |
| `browser_compatibility_notice` | Unsupported-browser notice replaced content. | Retryable. |
| `accessibility_widget_only` | Accessibility control text dominates. | Retryable and eligible for exact-template host recovery. |
| `development_banner_only` | Deployment/development banner dominates. | Retryable and eligible for exact-template host recovery. |
| `template_footer_only` | Project/funding footer dominates. | Retryable and eligible for exact-template host recovery. |
| `shared_page_chrome_only` | Footer/social navigation shape with almost no body. | Retryable, but **not** an exact-template host shortcut. |
| `dynamic_application_shell` | JavaScript bootstrap/CSS shell without rendered source. | Retryable; hash/client route may receive one fresh-page retry. |
| `technical_css_shell` | Extracted technical CSS with no substantive source prose. | Retryable; included in the bounded SPA retry gate. |
| `empty_extraction` | No document body remains after envelope removal. | Retryable; hash/client route may receive one fresh-page retry. |
| `title_only_extraction` | Only title, breadcrumb, or trivial chrome. | Retryable. |
| `insufficient_substantive_text` | Conservative text/word/sentence floor not met. | Retryable; hash/client route may receive one fresh-page retry. |
| `static_or_media_resource` | URL points to a non-document resource. | Non-retryable. |
| `accessibility_audio_proxy` | Text-to-speech/audio proxy should not become a corpus row. | Non-retryable. |
| `media_response` | Audio, video, or image response. | Non-retryable. |

The current template-recovery shortcut intentionally contains only
`accessibility_widget_only`, `development_banner_only`, and `template_footer_only`.
Adding `shared_page_chrome_only` would broaden host-level behavior and previously
failed the no-regression counterexample.

Original document buffers bypass HTML quality thresholds. Binary Office payloads
must never be stored as extracted text; `looksLikeOfficeBinaryText()` is centralized
in `lib/extraction-policy.js` for both browser and session paths.

## 7. HTML extraction contract

### Browser stage

`scrapePage()` owns live browser behavior:

- navigation and response evidence;
- safe asynchronous Playwright event listeners;
- downloads and temporary-file cleanup;
- accidental-navigation detection and target restoration;
- dynamic application waiting;
- meaningful iframe inspection;
- conservative interaction with collapsed/accordion content;
- PDF viewer and embedded-document interception;
- DOM capture for static extraction.

Nested disclosure handling excludes social/favourite/print/download actions and
processes pending disclosures breadth-first within its budget. A large hidden-text
gap plus actual disclosure controls can trigger bounded late readiness; ordinary
pages must not inherit that wait. Technical media player frames are not source
documents; same-site and external document frames remain eligible. France Travail
motivated these guards; helper tests do not replace a real nested-rendering check.

Interactions are cumulative but bounded. A click must not be performed merely because
an element is clickable. It must look like a content disclosure, preserve source
identity, and remain within resource guards.

### Static extraction stage

`smartExtract()` parses the captured HTML. Its current candidate precedence is:

1. A dedicated primary article/content region.
2. Combined primary articles when a page is genuinely split across them.
3. An H1/heading-anchored repair when navigation chrome dominates a primary region.
4. A structured link index when links are the actual page content.
5. The primary candidate when Readability is weak or empty.
6. A priority semantic body (`main`, article/content classes) when it clearly improves
   source coverage.
7. A longer high-priority semantic candidate.
8. Generic scored candidates as the final extraction choice.
9. Paragraph-level duplicate removal inside the selected single URL.
10. H1-bound widget recovery and final DOM rescue when the chosen text is implausible.

This order is behavior, not implementation trivia. Reordering candidates can cause a
site-wide menu to replace an article, or an article to replace a legitimate index.

### DOM cleanup boundaries

There are two cleanup moments: live-browser cleanup and static `sanitizeDom()`.
Both must follow these rules:

- Remove scripts, styles, hidden technical nodes, consent overlays, and proven shared
  chrome only when the selector is semantically narrow.
- Do not remove generic framework containers such as `.cmp-container`; an AEM site may
  put the whole article inside them.
- Do not treat every `footer`, `nav`, or link-heavy block as noise without checking
  whether it is the page's source content.
- Do not perform consent/navigation actions that can redirect away from the submitted
  source without source restoration.
- A selector fix needs a positive fixture and an unrelated counterexample fixture.

## 8. Documents and source identity

### Documents

- Direct PDF bytes are retained as the primary artifact when available.
- DOCX and legacy DOC follow dedicated extraction paths; browser-rendered binary text
  is rejected.
- Scanned/image PDFs may require bounded OCR. OCR resource limits are separate from
  HTML extraction limits.
- A webpage that lists document editions is not equivalent to one edition document.
  A resolver must preserve the semantics of the submitted URL.
- A substantive HTML page with a related PDF link remains that HTML source. Direct
  PDF promotion requires a download-only shell with minimal non-link text, no
  substantive semantic body and explicit document intent (CLEISS regression case).
- A restored/generated PDF is accepted only after source text and final artifact
  validation. “PDF saved” is an artifact state, not a quality verdict.

### Identity fields

Keep these concepts separate:

- `submittedUrl`: exact user input represented by the manifest row.
- normalized scheduling identity: prevents redundant retrieval work only.
- final browser URL: where navigation actually ended.
- retrieval source URL: Jina/cache/archive/Trawl/official API representation used.
- official source: verified alternate official registry or document.
- discovered links: child URLs found during crawling.

Fragments are significant for client-side applications. Query parameters may encode
document version, language, edition, or search state. URL normalization may classify
equivalence for scheduling, but cannot assert semantic equality for curation.
Submitted-input de-duplication must use the same visit identity: it preserves `#/...`
and `#!/...` routes, while ordinary in-page anchors may coalesce. It may apply only
safe host aliases such as `www.` versus non-`www.` after preserving that distinction.

Technical CSS with no remaining substantive prose is a quality failure, not a long
document. For a client-side route it receives one bounded fresh-page retry; it may
not become a restored PDF merely because style declarations increase its character
count.

## 9. Persistence, export and review

The ordered mission manifest is authoritative for UI counts and Excel rows. Filesystem
enumeration is not authoritative because a valid result may lack a PDF, filenames may
collide safely, and review decisions may exclude a curated artifact.

Exports must preserve:

- original input order;
- one row per submitted input;
- exact artifact filename after filesystem-safe normalization;
- scrape status and reason;
- PDF state;
- retrieval/official source evidence;
- review state and review reason;
- curated inclusion state.

Review groups are evidence queues. Exact stored text, similar names, repeated chrome,
and quality anomalies can all create a group. They must remain distinguishable.
“Duplicate”, “irrelevant”, “related/version”, and “needs re-scrape” are separate human
decisions. No review signal may rewrite another URL's stored title or artifact.

## 10. Historical country and corpus matrix

Counts are approximate inventory from the earlier contract audit, not counts verified
on 2026-09-26 and not acceptance targets for future batches.

The corpus under `C:\Users\ecl87\Desktop\scrapes` is regression evidence, not an
automatic oracle. Some old folders contain artifacts that led to later fixes. Compare
content and source identity, not only file counts or filenames.

| Corpus | Approx. saved PDFs | Historical patterns and protected behavior |
| --- | ---: | --- |
| AT | 840 | Mixed official HTML/PDF baseline; protects generic article and direct-document behavior. |
| BE | 342 | Multilingual public portals and documents; protects language/query identity. |
| BG | 644 | `postedworkers.gli`, GLI, MLSP and NSSI shared templates, accessibility widgets and DOC files. Template text must trigger recovery/review, not false duplication. |
| CY | 401 | Official portal/document baseline; no dedicated domain branch currently required. |
| CZ | 426 | CSSZ Liferay pages. `journal-content-article` must beat global footer/menu content; unsupported-IE notices must not become source text. |
| DE | 856 | `gesetze` and official documents; version/query identity and direct documents are protected. |
| DK | 438 | `retsinformation` legislation pages, script/SVG noise and Workplace Denmark multilingual pages. Structured legal text must beat page code and shared chrome. |
| EE | 346 | Official HTML/PDF baseline; no active country-specific adapter. |
| EL | 175 | Greek Unicode filenames/text and `ypergasias` shared restored output. Encoding must remain lossless; repeated recovery output is a warning, not proof of duplicate sources. |
| EMPL | 165 | EU employment/publication documents; protects embedded and direct official documents. |
| ES | 496 | INSST, MITES, BOE and transparency sites. Cookie/error/minimal pages must not pass; embedded documents and concise official notices must remain valid. Old bad image/processing artifacts are not a golden baseline. |
| FI | 927 | Large multilingual official corpus; concurrency and generic HTML/document regression baseline. |
| FR | 343 | Consent-only pages, localized 404s, blocked Travail/Legifrance content. Error detection must be localized and fallbacks must remain auditable. |
| HR | 494 | Consent/shared DIRH template failures. Same recovered shell across URLs is extraction failure evidence. |
| HU | 570 | Hash-routed SPA pages such as `mvff.munka.hu/#/...`; fragments must be preserved and one fresh-page retry may recover rendered content. |
| IE | 608 | `gov.ie`, WRC, HSA and Oireachtas. Intermittent CloudFront blocking requires host-aware recovery without fixed per-URL 90-second stalls. |
| IS | 327 | Official HTML/PDF baseline; no active dedicated branch. |
| IT | 417 | INPS and AEM-based government pages. Generic `.cmp-container` removal is forbidden because it deleted real article bodies. Consent/handoff text must not become success. |
| LIE | 425 | `llv.li` Cloudflare/Trawl recovery and `gesetze.li` legal sources. Trawl preference is provider configuration, not permission to accept challenge HTML. |
| LT | 109 | E-TAR legal identifiers and VDI/EURES. E-TAR has the only current country registry adapter; mapping must be exact and preserve edition/page semantics. |
| LU | 785 | CSL and Guichet/ITM pages. CSL navigation could dominate 44 pages; semantic main/article rescue must be generic and guarded. |
| LV | 488 | Official HTML/PDF baseline; no active dedicated branch. |
| MT | 358 | Official portal/document baseline; no active dedicated branch. |
| NL | 593 | `wetten.overheid.nl` query/version URLs and repeated review groups. Query identity must be preserved; review cannot auto-delete variants. |
| NO | 513 | NAV and Arbeidstilsynet content; generic dynamic/document baseline. |
| PL | 667 | Multilingual official pages and Unicode filenames. Filesystem and Excel names must use the same safe normalization. |
| PT | 167 | DRE OutSystems application shell and direct documents. “JavaScript is required” is not source content; rendered/official recovery is required. |
| RO | 332 | Dynamic government portals, WordPress/template pages and WAF/geographic restrictions. Old template artifacts are not correct-content evidence. |
| SE | 500 | Official HTML/PDF baseline and query/version behavior. |
| SK | 0 | `navody.slovensko.sk` nested dropdown/accordion content was the motivating case; no saved historical oracle exists, so live/fixture evidence is mandatory. |
| SL | 177 | PISRS canonical redirect and consent/navigation regression. The target law body must survive redirect handling and source restoration. |
| YEP | 156 | `ypergasias`/employment corpus baseline; protects Greek content and shared-template detection. |

Country labels do not justify country-wide code branches. They identify regression
evidence. A rule discovered in one country should be implemented as a structural rule
when possible and tested against at least one unrelated site family.

## 11. Case-study pattern library

Each future incident should be documented in this shape: observed false output,
root cause, narrow guard, protected counterexample, and verification evidence.

### Shared page chrome mistaken for source

- Observed in CSL (LU), CSSZ (CZ), Bulgarian portals and Croatian pages.
- Failure: many distinct URLs produce identical menus, footers, widgets or notices.
- Safe response: prefer a clearly bounded semantic article; classify proven
  chrome-only output as retryable; send ambiguous repetition to review.
- Unsafe response: declare URLs duplicates or remove every link-heavy region.
- Counterexample: a legitimate legal index or directory whose main content is links.

### Generic framework selector removes real content

- Observed in Italian AEM pages.
- Failure: deleting `.cmp-container` removed the article because the class is a layout
  primitive, not a cookie/banner identity.
- Safe response: target semantically verified overlay/banner selectors.
- Counterexample: any AEM article whose complete body sits inside `.cmp-container`.

### Automated navigation changes the requested source

- Observed in PISRS (SL), portals with logout/consent actions, and redirecting shells.
- Failure: interaction or canonical navigation lands on home/search/consent content.
- Safe response: compare source identity, restore target, and fail/recover on mismatch.
- Counterexample: an expected same-document canonical redirect that preserves content.

### Client-side route appears empty

- Observed in Hungarian hash routes, OutSystems (PT), Slovak dropdown applications.
- Failure: direct HTML contains bootstrap code or default route rather than rendered body.
- Safe response: preserve fragment, wait for justified dynamic change, one bounded fresh
  browser retry, then named recovery route.
- Counterexample: a static concise notice that should not incur dynamic interaction.

### Fallback returns a polished security/error page

- Observed with E-TAR, LLV, gov.ie and French protected sites.
- Failure: provider reports HTTP 200 but content is WAF, unauthorized, or localized 404.
- Safe response: validity-first assessment on every provider result.
- Counterexample: a real official page discussing authentication or accessibility.

### Listing page substituted with one document

- Observed while resolving E-TAR editions.
- Failure: a page representing multiple editions is replaced by one PDF/document.
- Safe response: deterministic identifier mapping that preserves submitted-page
  semantics; otherwise retain page text or mark unavailable.
- Counterexample: a URL that directly identifies one official document edition.

### Related PDF or player replaces the requested HTML

- Observed in CLEISS and France Travail (FR); recorded on 2026-09-03.
- Failure: a short useful HTML page becomes a linked guide, or a nested FAQ becomes
  player/login text after consuming its interaction budget on non-content controls.
- Safe response: download-shell evidence before PDF promotion; breadth-first
  bounded disclosures; technical-frame filtering with parent-content comparison.
- Counterexamples: genuine download-only wrapper, embedded official document frame,
  concise HTML notice and ordinary page with no disclosure readiness wait.

## 12. Mandatory change procedure

Before editing extraction behavior:

1. Read this document completely.
2. Read the relevant current code and related entries in `MASTER_MODIFICATIONS.md`.
3. Inspect the latest mission manifest plus MD/TXT/JSON/PDF artifacts. A screenshot or
   reviewer preview alone is insufficient.
4. Identify the owning stage: scheduling, retrieval, browser interaction, extraction,
   validity, quality, persistence, review, or export.
5. Write the proposed rule in one sentence and name at least one protected
   counterexample from this document or the corpus.
6. Prefer a pure helper or narrow branch. Do not append another parallel classifier,
   fallback array, URL normalizer, or content-selection pipeline.
7. Add a positive regression test and a counterexample test.
8. Run targeted tests, the full stability suite, syntax checks and `git diff --check`.
9. Verify at least one affected source and one unrelated protected family when network
   behavior is involved.
10. Update this contract when the decision flow, taxonomy, route, or country evidence
    changes. Add a dated implementation record to `MASTER_MODIFICATIONS.md`.
11. Synchronize in-scope Pocket behavior only after root passes and re-run its full
    suite. Otherwise record deferred/not applicable, not implied parity.

Apply `docs/CHANGE_SAFETY.md` for impact analysis, baseline comparison, OpenSpec
artifacts and handling unavailable evidence. No required failure or unrun check may
be hidden by a completion claim. Documentation-only changes use its lighter path.

### Required change note template

```text
Observed failure:
Owning stage:
Root cause:
New narrow rule:
Existing rules/routes intentionally unchanged:
Positive fixture/source:
Protected counterexample:
Root verification:
Pocket verification:
Documentation updated:
```

## 13. Conflict register and remaining technical debt

### Resolved in the current structural pass

- Fallback route arrays are centralized in `lib/extraction-policy.js`.
- Validity-before-quality orchestration is centralized in
  `assessExtractedContent()` instead of repeated pairs in `session.js`.
- Office binary-text detection is shared by browser and session paths.
- Template and SPA retry category gates are named and tested.
- Unknown routes or missing providers fail closed.

### Deliberately not split yet

`scrapePage()`, `smartExtract()`, and `runScraperSession()` remain large. A mechanical
file split would lower line counts but could obscure closure state and reorder subtle
behavior. They should be decomposed only behind characterization tests in this order:

1. Extract pure DOM candidate scoring and content-selection policy from
   `smartExtract()` without changing precedence.
2. Extract browser navigation/source-identity state from `scrapePage()`.
3. Extract fallback execution and result finalization from `runScraperSession()`.
4. Compare representative artifacts from CZ, IT, LT, LU, SL and one generic PDF corpus
   before and after each phase.

### Known overlaps that remain intentional

- Browser cleanup and static DOM sanitation both exist because they operate on
  different representations. Their selector policy must stay aligned.
- Early provider validation in `scraper.js` and final assessment in `session.js` are
  defense in depth. They must use the same classifier modules.
- Repetition analysis and duplicate review both inspect similarity, but only review
  owns human curation decisions.

## 14. Test ownership map

Use `docs/REGRESSION_MATRIX.md` for exact existing filenames, protected examples and
coverage gaps. In particular, HTML precedence lives in
`tests/html-extraction-priority.test.js`, disclosure/document-shell checks in
`tests/content-expander-detection.test.js`, and XLSX/ZIP/combined-review behavior in
`tests/zip-layout.test.js`; there are no `scraper-*` or `results-*` test families in
the current suite. `npm run test:stability` runs `tests/*.test.js`, not every test-like
file elsewhere in the workspace.

Passing tests is necessary, not sufficient. If a live site changed, store a minimal
sanitized fixture that captures the structural failure so future correctness does not
depend on that site remaining unchanged.

## 15. Safe Sailor policy supplement — 2026-10-13

The independent Safe application now uses policy/notice-discovery.js for bounded institutional evidence discovery and operation-specific standard licence decisions. This does not alter root Sailor extraction, fallback ordering, source identity, originals or advisory review. Generic copyright/mining reservations and actual prohibitions are separate checks; unknown copying bases never become permission. Safe's exact source scope, regressions, dated eligibility and outstanding institutional gates are recorded in safe-sailor/docs/POLICY_SIMPLIFICATION.md. Pocket remains deferred; no country-wide or universal compliance inference follows from this supplement.
