# WP5 — prompt, output and quota hardening

Scope: R11 and S3–S5 from the October review. Reverified against canonical main/alpha
`ddacf666371db472d7070c285e21d62028e2068b`, rather than the review's `82f7c6570`.
WP1 and WP3 remain separate PRs. AI-assisted file import belongs to the AI Import session.

## Current-source findings and changes

| Finding | Verified current source | Prepared change |
|---|---|---|
| Manager draft treats record text as instructions and accepts new prose | `core/performance.ts` already rechecks current source and authority at admission and audit; output still accepted arbitrary text | Untrusted JSON data plus bounded source-passage indices; deterministic reconstruction, strict output validation; retain current-source checks |
| Claims triage can send a model-authored question | `core/input-triage.ts` already has closed rule predicates and fresh source admission | Untrusted claim JSON; model chooses only verdict/rule, code supplies one fixed question; reject extra prose/fields |
| Pay parameters need bounds | Canonical `core/pay-rule.ts` already enforces finite nonnegative money/rate values ≤100,000,000, percent ≤1,000 and quantity ≤1,000,000 | Reuse those bounds; restrict AI proposals to the advertised six-kind subset and exact keys; refuse formula/component dependencies |
| Pay preview optional; unauthorized mislabeled | The editor could accept a draft without running its employee sample; service mapped authority refusal to invalid output | Preview + human acknowledgement tied to current rule/sample identity; clear it on edits; distinguish forbidden; use localized generic notification rather than model prose |
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
  six locales at desktop/mobile sizes. English desktop visually reviewed. These are rendered fixture
  components, not an authenticated installation journey.
- Native question binding/control-flow checks and whole compiler dispatched at
  `2bc348e20965894b9ea172294c0db06dfa104dfe`; results pending.
  Mistyped expected-SHA dispatch `40841164993` is retained as a refusal, not test evidence.
- `test/assistant-question-budget.test.ts` is authored but **unrun** until the coordinated migration
  is allocated and integrated. Its planned cases include concurrent daily admission, monthly held
  estimates, unknown failed usage, legacy retired transcripts, source-owned clock and private scopes.

## Remaining evidence and limits

No full WP5 gate receipt, merge, migration or staging deployment exists yet. The quota migration
allocation/journal append is held behind Board's verified predecessor release and Bank's agreed
relative successor proposal. No applied SQL is edited.

After SQL integration: execute real app-role admission/erasure/concurrency cases, populated-baseline
migration rehearsal, focused affected suites and the full frozen-candidate GitHub Actions gate.
Final integration must preserve WP1, WP3, AI Import and other released work, regenerate the source
manifest and obtain a new exact-source/current-baseline full witness before staging deployment.

Not established: live provider injection behavior, provider invoices, translation review by native
speakers, authenticated staging journeys, or production behavior. The pay preview is an interaction
requirement; native server authorization/validation remains the write authority. Extracted performance
passages may contain an employee's untrusted claims; they are never an automatic rating or HR decision.
