# Sailor content curation: technical report

**Code inspected:** root Scraperito Sailor, 2026-10-22. **Scope:** the normal UI's
URL text area and full-document missions. Link-only Sailor Mode is called out where
its rules differ. Safe Sailor, Pocket, `Sailor production_ready`, and the optional
managed-agent interface have separate processes/contracts and are not certified by
this report. This is an implementation audit, not a replay of every historical
mission or a guarantee that every external site is classified correctly.

## 1. The governing distinction

There is no single "deduplicator" and no single definition of "irrelevant".
The system makes decisions at different stages, on different evidence:

| Stage | Question | Possible effect | Authoritative code |
| --- | --- | --- | --- |
| Input parsing | What URLs or invalid lines did the user submit? | An ordered row for each recognized URL or nonempty invalid line | [`url-input.js`](../lib/url-input.js), [`server.js`](../server.js) |
| Scheduling | Would this visit repeat a normalized URL within its queue scope? | Visit once; keep repeated *submitted* input as a skipped row | [`session.js`](../lib/session.js), [`navigator.js`](../lib/navigator.js) |
| Resource policy | Is this obviously media/static content, social media, too deep, or off-domain? | Skip before navigation, with a reason | [`content-quality.js`](../lib/content-quality.js), [`session.js`](../lib/session.js) |
| Retrieval and source validation | Is the response actually the requested source? | Retry a suitable route or fail the URL | [`scraper.js`](../lib/scraper.js), [`content-validation.js`](../lib/content-validation.js), [`extraction-policy.js`](../lib/extraction-policy.js) |
| Corpus text quality | Is the retrieved HTML merely UI/chrome or too thin to use? | Recover; otherwise skip as excluded from corpus | [`content-quality.js`](../lib/content-quality.js), [`session.js`](../lib/session.js) |
| Content review | Do stored *successful* sources look alike or suspicious? | Advisory group only; retain every source artifact | [`content-dedup.js`](../lib/content-dedup.js), [`review-quality.js`](../lib/review-quality.js), [`curation-review.js`](../lib/curation-review.js) |
| Human curation | Which saved sources should enter the *separate* curated corpus? | Include, exclude, or send to re-scrape; original mission unchanged | [`results.js`](../lib/results.js), [`public/app.js`](../public/app.js) |

In particular, **"same submitted URL", "same queued visit", "same extracted
TXT", "similar substantive TXT", "same title", and "same official document"
are not interchangeable claims. The last one is *not* inferred automatically.

## 2. Input: what enters a mission

The browser sends the exact text-area value as `rawUrls` to `POST /api/scrape`.
`parseSubmittedUrlEntries()` extracts Markdown destinations such as
`[law](https://example.gov/law.pdf)` without counting the label as another URL,
supports multiple ordinary URLs on one line, and avoids splitting a nested
`?url=https://...` or fragment-embedded URL. It accepts only `http://` or
`https://`; literal spaces in a plain URL become `%20`, while existing `%XX`
escapes are left intact. Wrapping punctuation is stripped conservatively.

Each candidate gets a 1-based `inputIndex`. A nonempty line with no recognized
HTTP URL is *also retained* as an invalid input row. Empty lines are not rows;
one line can yield multiple URL rows. If no valid URL exists, the API refuses to
start a mission and returns an input audit. Otherwise the launch returns counts
for submitted, navigable, and invalid entries. This is syntax recognition, not
proof that a URL is reachable or relevant.

`prepareStartUrls()` creates the ordered initial manifest, marks invalid entries
`skipped` with their reason, and schedules the first occurrence of each input
visit identity. Later equivalent inputs remain visible at their original
positions as `skipped`, with `inputDuplicateOf` and no PDF. Therefore an XLSX
row count can equal the number of submitted candidates while the count of
distinct visits and PDFs is lower. A discovered level-1 URL is a *separate*
population: it can increase the live mission total, but cannot erase a
submitted row. The server caps crawl depth at 1; the page budget can end before
all queued URLs are visited. See [`input-audit.test.js`](../tests/input-audit.test.js)
and [`crawl-queue.test.js`](../tests/crawl-queue.test.js).

### 2.1 URL equivalence is operational, not legal equivalence

`normalizeVisitUrl()` removes ordinary `#anchor` fragments, a trailing path
slash, and selected tracking parameters (`utm_*`, `ref`, `fbclid`, `gclid`,
`sid`). It preserves router fragments beginning `#/` or `#!/` so, for example,
`https://mvff.munka.hu/#/questions` and `.../#/posting_en` have different visit
keys. Input deduplication additionally treats `www.` and non-`www.` hostnames
as equivalent. It lowercases the resulting URL string.

That normalization is only a *scheduling heuristic*. It does not verify that
two official records are the same. It can be too aggressive on case-sensitive
paths, case-sensitive query values, meaningful `ref`/`sid` parameters, or
ordinary fragments that drive nonstandard applications. It also does not make
`http` and `https` equivalent. The skipped-input reason currently says
"identical entry" even when the strings differ after normalization; read it as
"same normalized visit key", not byte-for-byte identity.

Discovered links use a key of normalized seed/base URL plus normalized target
URL (after unwrapping known document viewers). The queue coalesces repeated
discovery under the same key *before* processing. It does not keep a manifest
row for every repeated `<a>` occurrence. This seed-scoped identity means a
target discovered under two different seeds may still be visited twice.
The worker also reserves the visit key before its first `await`, preventing two
workers from processing the same queued identity concurrently.

**Important implementation differences:** `scoredLinksFromHtml()` deduplicates
links inside a page with `normalizeUrl()`, which drops *all* fragments, unlike
`normalizeVisitUrl()`. The normal HTML discovery path also strips fragments
from `a.href` before queueing. Consequently the SPA-aware worker identity
does not, by itself, guarantee that distinct *discovered* hash routes survive
link extraction. Directly submitted SPA URLs are protected by the input/visit
key logic. The normalization code is not a semantic source-identity oracle.

### 2.2 Pre-visit skips

Before consuming page budget, `getPreVisitSkipReason()` checks, in order:
depth greater than the allowed depth; non-document URL; a social-media
blocklist; invalid URL; and, for depth > 0 when `stayOnDomain` is enabled,
host different from the seed host (ignoring `www.` only). A skipped URL records
the explicit reason and no PDF.

The non-document URL classifier covers common image, stylesheet, JavaScript,
font, video, audio, and archive extensions (`.mp3`, `.png`, `.zip`, etc.), plus
recognizable ReadSpeaker/TTS accessibility proxy URLs with source/audio
parameters. If a URL survives that test but the HTTP MIME type is `audio/*`,
`video/*`, or `image/*`, it is skipped at the response stage. A real PDF, DOC,
or DOCX is *not* filtered by a small-text threshold just because OCR or text
extraction is short.

The social-media blocklist includes Facebook, Instagram, LinkedIn, Twitter/X,
YouTube, Pinterest, and TikTok. **Current caveat:** it tests whether the full
target URL *contains* a blocklisted domain string, rather than parsing and
comparing the hostname. A government URL whose query merely mentions
`facebook.com` can therefore be skipped; conversely, this is not a general
social-network taxonomy. This is a known implementation boundary, not a claim
that all social pages are classified perfectly.

## 3. Link relevance is ranking, not corpus curation

`scoreLink()` examines multilingual link text, URL path/file extension, DOM
container, and crawl depth. Current weights are:

| Signal | Score change |
| --- | ---: |
| Legal instrument or labour/social-rights topic in link text | +15 |
| Document/publication term in text | +8 |
| General informational term in text | +4 |
| PDF/Office file extension | +10 |
| Document/legal path segment | +8 |
| News/article path segment | +4 |
| Inside `main`, `article`, or `section` | +10 |
| Inside nav/footer/header/aside/menu/sidebar | -10 |
| Noise text or URL (login, newsletter, contact, privacy, social, etc.) | -30 |
| Crawl depth | -0.5 per level |
| No positive score outside a content area | further -5 |

Scores `>= 0` are labelled `active`; negative scores `excluded`. These labels
are **link-ranking labels**, not mission statuses or editorial relevance
verdicts. For example, a discovered newsletter link generally receives a
negative score, but an explicitly pasted newsletter URL bypasses discovery
scoring. Further, in *full-document mode*, `queueDiscoveredLinks()` and the
normal success path enqueue the ranked list **without filtering out negative
scores**. Link-only Sailor Mode does filter `status === 'excluded'` before
queueing. The browser's ordinary link-discovery evaluation also has separate
`excludeNoise` and nav/footer guards, but other extraction paths can supply
`discoveredLinks`. Thus "newsletter was scored excluded" does **not** imply
"newsletter cannot be visited in full-document mode". The final retrieved
content must still pass validation/quality, or a human must exclude it.

`NOISE_TEXT`/`NOISE_URL` are regular expressions across many, but not all,
European-language forms. They do not classify by actual article semantics,
publication date, regulatory importance, or whether a newsletter contains
substantive official guidance. A page about newsletter regulation, or a
newsletter with useful legal content, can be valid source material despite a
negative discovery score.

## 4. Retrieval and source validity

For each non-skipped URL, the worker routes recognizable direct PDFs/Word
documents to document extraction and HTML to the browser/DOM path. Document
handling also considers response content type, direct-download behavior, and
byte inspection; a URL ending in `.pdf` is not itself proof that the response
contains a valid PDF. A known official-source adapter may supply an exact
verified alternative representation. `scrapePage()` handles dynamic expansion,
viewer/download capture, source-preserving navigation, and DOM content
selection. An HTML listing page is not silently replaced with one linked PDF;
PDF promotion requires download-only-shell evidence. See
[`SAILOR_EXTRACTION_CONTRACT.md`](SAILOR_EXTRACTION_CONTRACT.md), sections 7-8.

Content selection itself is another curation boundary. In the browser,
`scrapePage()` waits for applicable dynamic content, expands bounded disclosure
controls, checks meaningful frames/downloads, detects accidental navigation,
and captures HTML. In static extraction, `smartExtract()` considers dedicated
article containers, genuinely split primary articles, heading-anchored
repairs, structured link indexes, semantic `main`/`article` candidates,
Readability, and scored fallbacks. It can remove duplicate *paragraphs inside
one selected page*; this is not cross-URL deduplication. Script/style nodes,
consent overlays and proven shared chrome are pruned, but generic CMS
containers or a link-heavy *real index* cannot safely be deleted wholesale.
If the wrong DOM region wins, many distinct URLs can save the same footer or
navigation text and then appear as exact TXT matches in review. Review detects
that symptom; it does not repair the original extraction retroactively.

The source assessment order is fixed:

```text
candidate result -> classifyContentValidity()
                 -> if valid, classifyContentQuality()
                 -> if both pass, save source artifacts
```

`classifyNavigationResponse()` treats an explicit HTTP **404 or 410** as a
terminal broken link and records `failed` without HTML fallback. Other
non-2xx responses, including 401/403/429/5xx and ambiguous failures, can use
the configured fallback chain. Transport `200` does **not** establish that
the requested source was returned. The text/title validity gate catches:

| Category | Evidence used | Effect if no valid source is recovered |
| --- | --- | --- |
| `browser_network_error` | Browser `ERR_*`, DNS, timeout/refusal text | `failed` |
| `http_error_page` | Jina's returned-error wrapper or explicit error title/body | `failed` |
| `waf_challenge` | Security/challenge title or body, including Cloudflare markers | `failed` |
| `soft_404` | Localized not-found title or body in implemented languages | `failed` |
| `authentication_page` | Recognized login path or username/password form | `failed` |
| `search_interstitial` | Google image redirect path | `failed` |

The classifier samples title plus up to 12,000 characters of stored text;
network/WAF/404 checks focus on the first 3,000 characters. It normalizes
case, whitespace, accents, and escaped underscores. A French page saying
"Page non trouvée" can therefore be rejected even with HTTP 200. The
implemented patterns are finite: an unknown-language error page, a novel CDN
challenge, or a valid article containing an error phrase can still be
misclassified. The validity result is evidence of a *failure signature*, not
a universal proof of HTTP state or legal relevance.

Named fallback routes in [`extraction-policy.js`](../lib/extraction-policy.js)
are intentionally distinct: `htmlRecovery` is Google Cache, Jina Reader,
Trawl, Archive.org; `documentRecovery` is Google Cache, Jina Reader,
Archive.org; `lowQualityRecovery` is Direct Fetch, Jina Reader, Trawl; and
link-only `sailorLinks` is Jina Reader, Trawl, Archive.org, Google Cache.
Host-specific preference/scheduling can alter the first tried provider, but
does not make a fallback response trustworthy. Each successful candidate
must still pass validity, then quality. Availability of external providers
depends on local configuration and the site.

## 5. Corpus quality: unusable extraction versus editorial irrelevance

After validity succeeds, `classifyContentQuality()` checks whether HTML text
contains a usable standalone source. It does **not** decide whether the topic
belongs in this user's AI corpus. The main categories and guards are:

| Category | Required shape / current limit | Why it matters |
| --- | --- | --- |
| `dynamic_application_shell` | JS-required/loading text plus app/bootstrap or many CSS rules | SPA shell is not rendered law/content |
| `technical_css_shell` | At least two declaration-heavy CSS rules, `>=120` CSS chars, `<180` residual prose chars | CSS must not create a fake long document |
| `cookie_consent_only` | Cookie word + action, short (`<=2500` semantic chars), multiple consent categories or explicit UI/actions | Consent overlay is not the target page |
| `external_handoff_only` | Explicit redirect/handoff notice and `<=600` semantic chars | A portal gateway is not the destination content |
| `browser_compatibility_notice` | Recognized unsupported-IE notice and `<=700` semantic chars | Compatibility banner is not source text |
| `accessibility_widget_only`, `development_banner_only`, `template_footer_only` | Short (`<=900`), matching marker dominates `>=45%`, `<=220` non-template chars | Shared widget/footer must not be a success |
| `shared_page_chrome_only` | Short (`<=1800`), `>=8` Markdown links, `>=2` social links, footer marker, `<=350` non-link chars | Repeated footer/menu is not page-specific content |
| `empty_extraction`, `title_only_extraction` | Placeholder/empty result or title-only/minimal heading | No standalone body |
| `insufficient_substantive_text` | `<80` alphanumeric chars, or `<12` words, or `<180` chars with `<30` words and `<2` sentences | Reject thin fragments without using PDF file size |

Before these checks, Markdown wrappers, title-only lines, and `URL:` envelope
lines are removed for assessment. A dedicated cookie/privacy-policy title or
legal-cookie discussion is protected from the cookie-overlay rule; a genuine
accessibility/project page is protected by title and residual-content guards.
A concise two-sentence official notice can pass. These are *conservative
structural tests*, not semantic comprehension. Original PDF/DOCX/DOC buffers
bypass HTML text-size/quality thresholds; original document validity is a
different problem.

Most quality categories are retryable. For a client-side `#/` route with an
empty/short/dynamic/CSS shell, the worker attempts one bounded fresh-browser
retry. Low-quality recovery then tries the named route, validating each
recovered response again. If no substantive source is obtained, the mission
row is `skipped` with `qualityStatus: excluded`, a specific
`qualityCategory`, and reason `Excluded from corpus: ...`; no PDF is saved.
Discovered links from the poor result may still be followed. Invalid *source*
responses (WAF, soft 404, login, etc.) are `failed`, not editorially
`irrelevant`. A failed document extraction or exhausted fallback is also
`failed`, with a reason.

**Manual "Irrelevant" is different:** it is a reviewer's post-scrape judgment
that an already saved, successful item is not useful for the intended corpus.
The system cannot generally infer this from word count, a URL path, a
newsletter label, or PDF size. `Needs re-scrape` means the source may matter
but its *stored extraction* is suspect. These decisions are not synonyms for
automatic `qualityStatus: excluded`.

## 6. Similarity and the reviewer

Successful sources retain their own saved artifacts. `ContentReviewRegistry`
records the first URL sharing a fingerprint of extracted plain TXT after
normalizing line endings and trimming; later equal TXT gets a
`possible_exact_text_duplicate_unverified` warning. This happens after
`saveData()`, so no PDF/MD/TXT is suppressed or borrowed. A separate content
fingerprint can also be stored for audit; the review grouping specifically
uses the *extracted-text* fingerprint or computes it lazily from stored TXT for
older missions. Identical extracted text can mean identical source, but can
also mean identical error page, shared footer, failed fallback, or truncated
DOM extraction (historical CZ/EL/HR cases).

When the reviewer opens, it hydrates only successful mission rows with stored
TXT (bounded parallel reads) and calculates per-host quality profiles. Each
source appears in **at most one** group, in this priority order:

1. **Exact stored TXT:** same SHA-256 of line-ending-normalized, trimmed TXT,
   across hosts if necessary; title differences and high-risk quality signals
   produce warnings. No claim about the original website/PDF bytes.
2. **Matching source title / filename:** remaining successes on the same
   logical host (`www.` ignored), with the same Unicode-normalized specific
   title/filename. Title must have at least 20 normalized characters and
   three words. Same name does not establish same text.
3. **Quality anomalies:** remaining successes with a high or medium signal;
   grouped by host plus signal, not because their texts are duplicates.
4. **Possible near-duplicates:** remaining successes on the same logical host
   with `>=500` semantic chars and `>=40` five-word shingles. Candidate pairs
   are blocked via six MinHash signature values; actual pairwise Jaccard
   similarity of cleaned five-word shingle *sets* must be `>=0.94`. Connected
   matches are merged into groups; two members joined through a third need
   not themselves reach 0.94. No file is removed.

`Jaccard(A,B) = |A intersect B| / |A union B|`. Words are Unicode-tokenized,
lowercased, NFKD-normalized, and stripped of combining marks. For texts with
over 4,000 shingles, 4,000 positions are sampled. Frequently repeated
paragraphs on the same host (frequency `>= max(3, ceil(0.12 * host documents))`)
are treated as shared boilerplate before near-match comparison. A high-risk
boilerplate signal requires ratio `>=0.68`, at least 180 repeated characters,
and fewer than 700 unique characters. Very short non-original text is high
risk below 250 semantic chars; a restored PDF below 500 is a medium signal.
An alternate retrieval URL is informational, not a quality group by itself.

The displayed `qualityScore` is the rounded, clamped value of
`25 + min(35, 10*log10(max(10, semanticChars))) + 30*(1-boilerplateRatio)
+ (10 if original document) - (25 per high-severity signal)`, bounded to
`0..100`. It is a ranking heuristic, not a probability of correctness or an
automated acceptance gate.

These thresholds are heuristics, not calibrated probabilities. MinHash blocking
can miss a true near-match; same-host restrictions can miss cross-domain
mirrors; different languages/editions can legitimately have similar titles;
shared chrome can dominate even a long extract. The displayed quality score
and suggested canonical source rank candidates for inspection, not automatic
approval. A URL absent from review is **not** certified unique or relevant.
The UI previews stored TXT and lets the reviewer inspect the original source;
previews are not a new scrape or a proof of source identity.

### 6.1 What manual actions actually do

The reviewer stages actions locally until **Apply** sends them to the server.
`include`/Keep retains a source; `canonical` keeps the chosen member and
marks the *other members of that group* excluded; `exclude`/Duplicate removes
only that source from the curated export; `related`/version keeps a distinct
related source; `irrelevant` excludes for editorial reasons; `rescrape`
quarantines a suspect extraction and adds it to the Retry Queue; `reset`
returns it to undecided; `keep_all` retains the whole group. Quality-only
groups cannot choose a canonical duplicate. The bulk "source A canonical"
control is a staging convenience, not evidence that A is truly authoritative.

Decisions are saved in a separate versioned review ledger under
`data/reviews/<user>/<mission>.json`, keyed by stable input-source identity
(`input:<index>` for current single missions, mission-namespaced identities
for combined review). Original mission files and ordinary ZIPs are not
rewritten. Legacy URL-keyed decisions remain readable, with weaker identity
when URLs normalize together. Two-mission review has its own ledger; it does
not silently overwrite individual-mission review decisions.

## 7. Statuses, counts, Excel, and ZIP

The mission manifest is the ordered audit record. `success` means a source
passed the current extraction checks and was stored; it does **not** mean a
human approved its content. `failed` means unavailable/invalid retrieval or
processing. `skipped` covers invalid/repeated input, policy/media exclusion,
unrecovered low-quality HTML, or an unprocessed URL after stop/page limit.
`pending` is transient; the final sweep converts remaining pending rows to
skipped. The internal `deduplicated` status is retained in some legacy export
handling, but current content matches are review-only, not automatic
`deduplicated` results. The `deduplicated` numeric progress field is not a
count of curator-approved duplicate documents.

The ordinary mission Excel maps internal `success` to `succeeded` and then
overlays *applied* curation decisions in its exported `Status` field:

| Applied decision | Exported `Status` | Curated PDF ZIP | Original mission artifact |
| --- | --- | --- | --- |
| None / Keep / Related / Canonical | `succeeded` | Include if saved PDF exists | Retained |
| Duplicate exclusion | `Skipped after duplicate review` | Exclude | Retained |
| Irrelevant | `Excluded as irrelevant content` | Exclude | Retained |
| Needs re-scrape | `Needs re-scrape` | Exclude; add Retry Queue | Retained |

The sheet has separate `Reason` (original scrape outcome), `Curation
Decision`, `Curation Reason`, `Curated ZIP Status`, canonical/review fields,
and artifact fingerprint. It does not edit the internal scrape status. The
normal PDF ZIP ignores review decisions; the curated PDF Flat ZIP applies
them. The current ZIP builder uses manifest-declared filenames, checks file
presence/nonzero content, and reports missing files rather than silently
counting them as included. End-of-mission reconciliation can demote a
`success` whose declared PDF fails artifact verification. These checks do
not prove the PDF's semantic correctness or full binary parseability.

For a two-mission combined review/export, the older mission comes first,
followed by the newer, each preserving its manifest row order. The combined
XLSX has both stored and combined ZIP filename columns plus `PDF Included`.
Combined flat ZIP names can receive a collision suffix; use **Combined ZIP
Filename**, not the original stored filename, to match a combined ZIP entry.
An input row, a success, a saved PDF, and an included curated PDF are four
different counts; expecting them always to be equal is incorrect.

## 8. Worked examples and failure boundaries

| Input/observation | Actual decision path | What must not be inferred |
| --- | --- | --- |
| `https://agency.gov/a` pasted twice | Two ordered input rows; first scheduled, second skipped as repeated normalized input | Second is not proof of duplicate *content* |
| `[Law](https://agency.gov/law.pdf)` pasted | One Markdown URL candidate; direct document route if bytes/response confirm | Markdown wrapper is not part of URL |
| `https://agency.gov/page` returns HTTP 404 | Terminal `failed` broken link | Do not call it irrelevant or a duplicate |
| HTTP 200 page says `Page non trouvée` | Validity gate may classify `soft_404`; `failed` | HTTP 200 is not success |
| ReadSpeaker `.mp3` URL | Pre-visit non-document skip, or media MIME skip | Audio file is not a failed PDF |
| Discovered `/newsletter` link | Usually negative relevance score; may still enter full-document queue | Negative score is not a guaranteed full-mode exclusion |
| Site returns only consent buttons | Retryable quality issue; after unsuccessful recovery, skipped/excluded from corpus | Real cookie-law articles should not be discarded by that rule |
| Two distinct Czech pages store the same footer TXT | Exact-TXT review warning, possibly boilerplate signal; both original files retained | Stored TXT equality is not proof that source pages are identical |
| Two valid editions share a title | Same-title review candidate if same logical host; no automatic removal | Title equality is not legal-edition equality |
| One good law and one bad extraction look "similar" | Inspect saved text, source URL, provenance, and PDF kind; mark bad one `Needs re-scrape` | `Duplicate` would hide the extraction failure |

**Known implementation risks requiring separate fixes/tests, not silent prose
redefinitions:** (1) full-document mode does not consistently filter links
with negative `scoreLink()` status; (2) the social blocklist searches the full
URL string; (3) normalizers can merge meaningful case/query/fragment variants,
and discovered HTML links may lose SPA fragments; (4) the final pending-row
sweep labels a URL "duplicate after normalization" if *any* equivalent row is
non-pending, even one that failed or was skipped. That final message can
overstate "already processed". None of these findings justifies deleting
historical artifacts or automatically deduplicating content.

## 9. How to audit a disputed result

1. Compare the exact pasted input and `inputIndex` with the mission manifest
   under `data/missions/`, not only the progress badge.
2. Identify whether the row was an input duplicate, discovered-queue duplicate,
   policy skip, transport/source failure, quality exclusion, or a saved success.
3. For a success, inspect saved JSON, TXT/MD, and PDF together with requested,
   final-navigation, retrieval, and official-source URLs. A PDF filename or
   reviewer preview alone cannot establish source fidelity.
4. Check the review group *type* and quality signals. Exact TXT, same title,
   near TXT, and quality anomaly demand different interpretations.
5. Inspect the applied ledger and the exported curation fields; compare normal
   versus curated ZIP entries and the actual XLSX filenames/order.
6. If changing a rule, follow [`CHANGE_SAFETY.md`](CHANGE_SAFETY.md), the
   [`SAILOR_EXTRACTION_CONTRACT.md`](SAILOR_EXTRACTION_CONTRACT.md), and the
   [`REGRESSION_MATRIX.md`](REGRESSION_MATRIX.md). Relevant automated checks
   include [`crawl-queue.test.js`](../tests/crawl-queue.test.js),
   [`content-validation.test.js`](../tests/content-validation.test.js),
   [`content-quality.test.js`](../tests/content-quality.test.js),
   [`curation-review.test.js`](../tests/curation-review.test.js), and
   [`zip-layout.test.js`](../tests/zip-layout.test.js). Fixtures and mocked
   tests do not certify current access to every live website.

## 10. Verification and limits of this report

I traced the code paths above and checked all local links in this document.
On 2026-10-22, this documentation review ran 65 focused tests across input
audit, crawl queue/pre-visit policy, validity, quality, text fingerprints,
review profiles/groups, and ZIP/XLSX behavior: 65 passed, 0 failed. No live
mission or historical-country corpus was replayed, and no application logic
was changed. The tests establish these selected local behaviors, not perfect
classification on every current website. The four implementation risks in
section 8 remain open findings rather than implicitly solved safeguards.
