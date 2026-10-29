# WP5 — prompt, output and quota hardening

Scope: R11 and S3–S5 from the October review. Reverified against canonical main/alpha
`ddacf666371db472d7070c285e21d62028e2068b`, then released main/alpha
`968354c00a71df7baccd499eb60757a3307ed61e`, rather than the review's `82f7c6570`.
The acted-on core source slices were unchanged by that released base; its import work is preserved.
WP1 and WP3 remain separate PRs. AI-assisted file import belongs to the AI Import session.

## Current-source findings and changes

| Finding | Verified current source | Prepared change |
|---|---|---|
| Manager draft treats record text as instructions and accepts new prose | `core/performance.ts` already rechecks current source and authority at admission and audit; output still accepted arbitrary text | Untrusted JSON data plus bounded source-passage indices; deterministic reconstruction, strict output validation; retain current-source checks |
| Claims triage can send a model-authored question | `core/input-triage.ts` already has closed rule predicates and fresh source admission | Untrusted claim JSON; model chooses only verdict/rule, code supplies one fixed question; reject extra prose/fields |
| Pay parameters need bounds | Canonical `core/pay-rule.ts` already enforces finite nonnegative money/rate values ≤100,000,000, percent ≤1,000 and quantity ≤1,000,000 | Reuse those bounds; restrict AI proposals to the advertised six-kind subset and exact keys; refuse formula/component dependencies |
| Pay preview optional; unauthorized mislabeled | The editor could accept a draft without running its employee sample; service mapped authority refusal to invalid output | Preview + human acknowledgement tied to current rule/sample and live parent form code/category; clear it on edits; distinguish forbidden; use localized generic notification rather than model prose |
| Report designer relies on route authority | Core designer lacked a fresh principal/admin/module check and an admission callback | Check actual principal and module at preparation, actual provider admission and audit; retain selected dataset/schema-only prompt |
| Legacy Assistant quota races and resets in UTC | `core/assistant.ts` counts completed exchanges before network; cached monthly totals exclude concurrent pending requests | Native question reservation, model-run actual/held exposure at each atomic admission, Malaysia clock and durable completion metadata. Coordinated SQL and real DB evidence still pending |

## Evidence at its actual source

GitHub Actions only; no local test/compiler/build/database slots.

- `40838118893` at `5a07827dfcba9544d516936407a5c0c6f995d9c6`: whole compiler passed.
  Focused run failed: seven preview fixture assertions used an incorrect exact `500.00` selector
  (the actual text is `RM 500.00`); four report fixtures tried to configure Leave as an optional module
  (Leave is a core module). Original failures retained privately.
- `40839067279` at `b474e3625a7e711c2cfeefe760a268b8f9ee2a92`: report authority fixture checks passed.
- `40839591512` at `d84ad844cc8d267453d593edde39d24a764714d6`: focused hardening/preview/naming
  checks passed (27 assertions), whole compiler passed. Includes twelve pay-rule component captures,
  six locales at desktop/mobile sizes. English desktop and Tamil mobile visually reviewed; those initial inert captures lost live select/checkbox
  properties during HTML serialization. Layout evidence only; corrected form-state captures are pending. These are rendered fixture
  components, not an authenticated installation journey.
- Native question binding/control-flow checks and whole compiler dispatched at
  `2bc348e20965894b9ea172294c0db06dfa104dfe`: passed 17 assertions and whole compiler.
  Mistyped expected-SHA dispatch `40841164993` is retained as a refusal, not test evidence.
- `40841842377` refused because the queued development branch moved before resolution; no tests ran.
  Later development checks use an immutable checkpoint branch.
- `40842472332` at `720ead74655449eb7a42d467f2de5c21ec962dd2`: all 53 selected assertions passed,
  including corrected six-locale form-state captures. English desktop visually reviewed. Whole compiler
  failed on three optional-adapter narrowing errors in the new database fixture; corrected afterward.
  Parent form code/category binding was subsequently strengthened after source review; new checks pending.
- `test/assistant-question-budget.test.ts` is authored but **unrun** until the coordinated migration
  is allocated and integrated. Its planned cases include concurrent daily admission, monthly held
  estimates, unknown failed usage, legacy retired transcripts, source-owned clock and private scopes.

## Remaining evidence and limits

No full WP5 gate receipt, merge, migration or staging deployment exists yet. The quota migration
allocation/journal append is held behind Board's approved combined Board/Bank/AI Import release. The owner conditionally approved
`0687_assistant_question_budget` at idx677/when1793330000013 only after independently verifying
that release's 562-entry live ledger and checking fresh refs/claims. This allocation is not yet claimed. No applied SQL is edited.

After SQL integration: execute real app-role admission/erasure/concurrency cases, populated-baseline
migration rehearsal, focused affected suites and the full frozen-candidate GitHub Actions gate.
Final integration must preserve WP1, WP3, AI Import and other released work, regenerate the source
manifest and obtain a new exact-source/current-baseline full witness before staging deployment.

Not established: live provider injection behavior, provider invoices, translation review by native
speakers, authenticated staging journeys, or production behavior. The pay preview is an interaction
requirement; native server authorization/validation remains the write authority. Extracted performance
passages may contain an employee's untrusted claims; they are never an automatic rating or HR decision.

## Verified migration predecessor and source allocation

Fresh main/alpha968354c00 matches healthy staging source/build. All562 ordered applied rows were
independently checked through `expectedMigrationLedger`/`validateMigrationLedgerRows`, including
the two explicitly archived historical byte identities; no checksum exception was invented.
The live maximum is1793330000012. Fresh published claims and reachable worktree journals contain
no competing0687/+13. The owner's conditional allocation therefore admits source append
`0687_assistant_question_budget`, idx677/when1793330000013, preserving the complete562-entry prefix.
The SQL and ordinary populated-upgrade fixture are now authored; real DB execution is pending.
Board still holds staging for worker/provider acceptance. No migration, restart or deployment is
performed by this source allocation. Focused check40843714356 passed at4a4b323a22888e62ed6023f25159fef20502722a.
