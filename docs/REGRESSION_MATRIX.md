# Regression selection matrix

Checked against test files on 2026-09-26. Paths below are relative to Sailor root;
in Pocket use `app/`. These are existing checks, not a claim that every real country
site or historical mission has been replayed. Add missing evidence before claiming
coverage. The extraction contract's country counts are historical inventory only.

| Changed area / historical family | Existing automated evidence | Protected behavior and additional evidence |
| --- | --- | --- |
| Input, ES/IT pasted links, HU SPA fragments | `tests/crawl-queue.test.js`, `tests/input-audit.test.js`, `tests/crawl-previsit-filter.test.js` | Nested query/Markdown URLs are not split; invalid/repeated inputs stay ordered; distinct SPA routes remain distinct. Compare input manifest to export if parsing changes. |
| Shared fallback policy | `tests/extraction-policy.test.js`, `tests/trawl-config.test.js` | Four distinct routes, provider availability, validity before quality; Pocket solver labels/defaults differ. Never infer equal provider deployment from equal policy keys. |
| WAF, FR not-found, LT unauthorized, PT shell | `tests/content-validation.test.js`, `tests/blocked-response-detection.test.js`, `tests/jina-reader-envelope.test.js` | A 200 wrapper is not source content; genuine legal text mentioning restrictions remains valid. Live availability is separate from fixtures. |
| BG/HR widgets, CZ notice, consent and minimal content | `tests/content-quality.test.js` | Shared chrome retries without rejecting accessibility articles, cookie law, concise notices or original documents. |
| CZ Liferay, LU CSL, IT AEM, BG templates | `tests/html-extraction-priority.test.js` | Page-local article/main beats chrome; preserve legitimate link indexes, full multi-section articles and generic framework wrappers. Broad cleanup/ranking changes need all these counterexamples. |
| SK nested disclosure, FR France Travail/CLEISS | `tests/content-expander-detection.test.js` | Social actions do not consume disclosure budget; real download shells may promote PDF, substantive HTML may not; technical player vs document frame. Helpers do not prove nested live rendering: inspect parent source text and expanded sections. |
| SL PISRS redirects, consent, HU SPA | `tests/navigation-recovery.test.js`, `tests/crawl-queue.test.js`, `tests/content-quality.test.js` | Expected canonical redirect vs unrelated navigation; CSS shell vs genuine prose; meaningful fragment route survives. Live SPA timing still needs browser evidence. |
| LT E-TAR | `tests/official-source-resolver.test.js` | Exact act/edition and edition-index semantics; reject mismatched identifier/edition; retain provenance. Do not substitute a related law. |
| Direct PDF, DOCX, legacy DOC, download cancellation | `tests/download-safety.test.js`, `tests/pdf-metadata.test.js`, `tests/storage-pdf-metadata.test.js`, `tests/restored-pdf-traceability.test.js` | Byte-type routing, cleanup, metadata opt-out and original/restored provenance; include a real representative document when changing parsers/OCR. |
| IE CloudFront / LIE solver / healthy host | `tests/host-scheduler.test.js`, `tests/worker-page-timeout.test.js`, `tests/session-sailor-finally.test.js`, `tests/interrupted-mission.test.js` | Bounded penalties/recovery, only stuck page closed, early-exit cleanup and pending row accounting. Some checks inspect source structure; no full child-process lifecycle regression exists in this suite. |
| EL/PL Unicode, filename collisions, artifact counts | `tests/zip-layout.test.js`, `tests/storage-pdf-metadata.test.js` | Stored filename equals ZIP/XLSX name; redirects and equivalent skipped rows do not erase artifacts. Repeated input count need not equal number of distinct PDFs. |
| ES INSST false duplicates, NL versions, curation | `tests/content-dedup.test.js`, `tests/curation-review.test.js`, `tests/review-quality.test.js`, `tests/zip-layout.test.js` | Similarity is advisory; original artifacts unchanged; duplicate/irrelevant/re-scrape distinct; combined index chronological and internally ordered. Inspect visible UI when altering staging. |
| Live history, large batches, UI response | `tests/live-history.test.js`, `tests/request-body-limit.test.js` | Revision/request-limit checks only, not a responsiveness benchmark. Browser interaction, polling, preview overlays and scroll preservation need explicit UI checks. |

## Coverage gaps and selection rules

Managed MCP addition (2026-09-27): `tests/managed-agent.test.js` checks opt-in
auth/origin, request replay, stale stop and human approval; `managed-evidence.test.js`
checks the HTTP-reader to shared-classifier boundary. `mcp/test/stdio.test.mjs`
uses the actual SDK/stdio transport and protects a foreign listener. The opt-in
`mcp/smoke.mjs` runs a separate real instance/mission; it is not part of test:stability.
These do not establish full OCR, private-network isolation or all native UI flows.

- A matching country name is not the selection criterion: follow changed functions,
  callers, candidate precedence and result consumers across families.
- HTML ranking/sanitization changes require article, index, multi-article, shared
  footer, AEM and concise-content fixtures; document routing changes require genuine
  document and HTML-with-document-link cases; policy changes require all route tests.
- Test counts are observations, not a target. Read what assertions exercise. Source
  regex checks and mocked network tests cannot certify end-to-end browser behavior.
- The suite does not replay all saved country folders or all external fallbacks.
  Network status, content updates and historical incorrect artifacts prevent treating
  a folder as an unquestioned golden corpus.
- PDF storage verification currently checks file existence/nonzero size and metadata
  association, not comprehensive PDF parseability or semantic correctness. Do not
  describe that as a complete binary-integrity guarantee.
- Pocket lacks Sailor's `session-runner.js` / `session-worker.js` process split.
  Its test success does not establish parity of isolation or UI responsiveness.
- For a broad refactor, add characterization evidence before moving code. Compare
  representative CZ, IT, LT, LU, SL and direct-PDF outputs, plus any newly affected
  family. Check meaning/provenance/artifact kind, not merely text length or title.
