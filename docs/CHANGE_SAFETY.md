# Change safety and OpenSpec workflow

Reviewed against the local code and tests on 2026-09-26. This is an engineering
procedure, not a claim of universal extraction correctness or an automated CI gate.

## 1. Documentation ownership

Read this guide before changing behavior, regardless of whether OpenSpec is used.

| Reference | Purpose | Read/update when |
| --- | --- | --- |
| `SAILOR_EXTRACTION_CONTRACT.md` in this directory | Invariants, route order, extraction precedence, country history | Read fully for extraction, document, queue, review and export changes; update changed contracts. |
| `../SAILOR_ARCHITECTURE.md` | Current runtime/module overview | Read affected modules and upstream/downstream dependencies; update runtime changes. |
| `../MASTER_MODIFICATIONS.md` | Dated decisions, experiments and superseded rules | Search country, domain, framework, failure class and function; append evidence, do not rewrite history. |
| `REGRESSION_MATRIX.md` in this directory | Actual test files and protected families | Select tests by impact, not only hostname; extend for new failure classes. |
| `../openspec/specs/change-safety/spec.md` | Required engineering acceptance criteria | Read before new delta specs; not a substitute for runtime tests. |
| `../openspec/changes/<change>/` | Change-specific proposal, design, delta specs, tasks | Record scope, evidence and decisions for that change. |

Pocket keeps this guide and matrix locally. Its `POCKET_ENGINEERING.md` maps paths
to `app/` and to versioned Sailor reference snapshots. Read that mapping first when
working in Pocket; do not assume the Sailor process model applies there.

Instructions specify required behavior; code and tests establish observed behavior.
If they conflict, document the discrepancy and investigate. Do not silently relax
an invariant to fit a bug, or alter code merely to match a stale description.
The master log is historical: newer entries and current code may supersede a rule.

## 2. Scope and evidence gate

Before implementation, record in the OpenSpec design (or a dated change note for a
small fix):

```text
Target repository and baseline commit:
Observed failure / intended improvement:
Evidence: input row, requested/final/retrieval URL, manifest, saved text/document:
Owning stage and root cause (or explicitly unresolved):
Affected callers, upstream producers and downstream consumers:
New narrow rule and why it does not compete with an existing rule:
Existing routes/precedence/categories intentionally unchanged:
Positive reproducer and expected output:
Protected counterexample(s) and unrelated family:
Historical evidence used, date, and known limitations:
Verification commands and acceptance criteria:
Pocket scope / differences / synchronization decision:
Rollback scope without deleting later work or historical artifacts:
```

Inspect the actual implementation and call sites. Include error paths, early
returns, cancellation, fallback success/failure, persistence and exports when they
consume the changed output. A screenshot, high quality score, equal title or PDF
count alone cannot establish a root cause or a successful extraction.

Do not introduce speculative website exceptions while the cause is unresolved.
Prefer structural/capability guards. An official adapter needs a verified exact
mapping, preserving edition, language, date and listing-versus-document semantics.
Use representative samples from `Scrapes` only after confirming they were good;
old bad artifacts also exist there. Never mutate that evidence to make tests pass.

## 3. Global invariants

All affected callers must retain the contract, including recovered content:

- Preserve submitted row identity, order and invalid/repeated inputs; discovered
  crawl rows are a separate population. Combined export is older mission first.
- Keep SPA fragments, meaningful query state and provenance distinct. Scheduling
  equivalence is not evidence of equivalent official content.
- Use named fallback routes and validity-before-quality assessment. Do not add a
  parallel array/classifier/normalizer or broaden a host shortcut accidentally.
- Original documents are not subject to HTML text-size thresholds. A concise page
  linking to a PDF is not automatically that PDF; technical frames are not articles.
- Keep content expansion bounded and source-preserving. Do not remove a generic
  framework container or link-heavy index solely because of its class or density.
- Preserve the stored artifact filename through normal/curated ZIP and XLSX export.
  Distinguish source success, PDF availability and manual review outcome.
- Similarity signals are advisory. Review never overwrites/deletes original mission
  artifacts or reuses another source's title/PDF automatically.
- Preserve bounded memory, polite host scheduling, cancellation and per-URL failure
  visibility. Speed improvements cannot trade away source completeness silently.

## 4. Verification gates

### Behavior changes

1. Run the current relevant tests before editing and record pre-existing failures.
2. Add a behavioral reproducer that fails on the old behavior and passes with the
   fix. If a test can only pin source structure, label that limitation and add a
   behavioral fixture/integration check where feasible; a regex test is not a live
   browser test.
3. Add a nearby valid counterexample and select an unrelated protected family from
   the matrix. Shared candidate ranking/cleanup/normalization/policy changes require
   all affected families, not just one friendly page. Refactors first need
   characterization tests; keep behavior changes in a separate phase.
4. Run targeted tests and `npm run test:stability` in Sailor; in Pocket run it from
   `app/` using its bundled Node, or `../runtime/node/node.exe --test 'tests/*.test.js'`.
   Run `node --check` for touched JavaScript and `git diff --check`. Inspect any
   pre-existing formatting noise separately; do not hide new failures.
5. For browser/network behavior, check an affected source and a protected source,
   inspecting source-specific text, provenance, artifact kind and final status.
   Use an isolated test data directory, not an active mission. Capture a minimal
   sanitized fixture so the regression is reproducible offline.
6. For storage/review/export changes, inspect actual XLSX rows and ZIP entry names,
   order, collisions, Unicode, kept/excluded states and normal artifacts. Counts
   alone are insufficient. Exercise single and combined missions when affected.
7. For UI changes, verify relevant controls, staged apply, scrolling and previews
   in the browser. For performance claims, use comparable inputs/options and record
   elapsed time/resource observations; do not infer speed from free RAM.
8. Synchronize compatible Pocket behavior only within the declared scope, preserving
   packaging/provider differences. Test each changed repository separately. If
   Pocket is deferred, record that explicitly; never claim parity without checking.

A required failure stops release-ready sign-off. Do not weaken/remove tests or
change expected content to hide it. Fix a new regression or isolate/defer the change.
If a live source is blocked/unavailable, record that condition, use captured evidence
where possible, and leave live acceptance unverified. User-approved limited delivery
is possible, but it must not be described as fully verified.

### Documentation/configuration-only changes

Check referenced paths, examples and commands against the code, parse configuration,
validate OpenSpec specs and inspect the diff to confirm no runtime changes. Do not
invent live verification or run a new scrape just to validate prose. A stability
suite run can document a baseline but does not prove the prose is complete.

## 5. OpenSpec artifacts and closure

- Proposal: behavior, target repository, non-goals, affected stages and risks.
- Design: evidence and impact record from section 2, conflicts, boundaries,
  before/after behavior, protected cases and rollback scope.
- Specs: observable requirements and scenarios, including negative/counterexample
  cases and unchanged invariants; no vague 'works for every country' acceptance.
- Tasks: reproducer, focused change, cross-family checks, full suites, applicable
  browser/export checks, documentation and Pocket status. Test tasks are complete
  only after execution; record command, environment, result and limitations.

Before closing, run `openspec validate --all --strict --no-interactive`. This checks
spec structure, not application correctness. Preserve a verification summary with
the change: baseline, tests, artifact evidence, unchecked criteria and residual risk.
Archive only completed work with required checks satisfied; an accepted deferral
must remain explicit, not a checked-off test. Update current docs and append a dated
master-log entry. Record a new source snapshot revision when updating Pocket docs.

Do not customize generated `openspec-*` skills for project policy: an OpenSpec update
can replace them. Keep policy in `AGENTS.md`, config, specs and the project-owned
`scraperito-extraction-contract` skill. After an OpenSpec upgrade, recheck config
loading and that the project rules still reach proposal/design/spec/tasks/apply.
