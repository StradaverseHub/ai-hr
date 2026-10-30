# Lifecycle offboarding step completion — development candidate

Held base3a2a015683c0a1ad8ec6f341186f7fa12a5fcdad. DraftPR118 adds bounded native offboarding navigation and one human-reviewed `lifecycle.offboarding.step.complete` action. No deployment authority.0735/idx715/when1793330000072 is coordinator-assigned UNAPPLIED PROVISIONAL DEVELOPMENT, mandatory installation reconciliation.

## Native ownership and boundaries

Existing `tickStep` delegates to supplied-Tx `tickStepTx` through `packs/lifecycle/service`. Native applicability, phase rules, state transitions, cleaning and audit remain one owner. The public UI API still returns only `{status}`. Native step writes one step/history/event and can derive case status/completedAt +case.completed history/event in the same top transaction. Native events now include an exact persisted step-row hash. No outcome, IT Return, provisioning, notifications, payroll or employment-termination effect is reachable. The outcome control is always excluded.

V9 onboarding and task assignment/delegation stay with their existing owner. Personnel activation is untouched. Legacy step authority is current company lifecycle staff (`lc_level>=agent`), not HR-only or assigned-approver authority. A real unlinked USER is supported; no PERSON or EMPLOYMENT is fabricated. SYSTEM cannot human-confirm. No delegation or effective-date authority is inferred: native server time owns completion; resignation/last-working dates are reviewed source context.

## Review, custody, proof

Same physical encrypted ledger and `createReviewCustody`; true tenant/user/nullable actor-person/company/case/step/nullable case-person/employment binding. Shared generic assigned/employment bindings are unchanged. Closed source locks Access/principal configuration, definitions (SHARE NOWAIT table lock prevents phantoms), case and step state, hashing all case/definition/step values+versions. This deliberately refuses on concurrent configuration work rather than wait. Current native staff and Assistant/module/pause/grant checks precede body unwrap. Changed definitions/state/dates/links refuse the original review.

Human input attests the selected step and separately accepts possible derived case completion. Canonical before/after is shown before another explicit confirmation; a last-step review cannot proceed without the derived-consequence consent. Completion SQL requires exact tenant/actor/case/step/persisted row hash/history/event from current TOP transaction and required-or-absent derived completion event. Recovery reuses original events, never repeats an effect or accepts merely a done flag. Body budgets, expiry, erasure, discard and privacy capture reuse existing owners, including actual lifecycle_case/person/employment privacy targets.

0735 adds one closed kind, three dedicated columns and case-specific functions. Each predecessor CHECK predicate appears exactly once in ELSE. One strict new-kind invariant requires every unrelated actual ledger column NULL, avoiding hybrid receipt shapes and recursive predicate duplication. No historical SQL edited.

## Shared integration and evidence limits

Additive registry actor/subject vocabulary, action/pack inventory, dedicated browser packet lane, server/receipt mapping, source-manifest and six-locale review UI. Conservative inline catalogue actor remains false: case-specific native admission owns it. The generic employment browser protocol is not widened.

Authored focused coverage: actual unlinked USER, native company denial, stale dates/steps/definitions, revoked-before-unwrap, SYSTEM/actor/digest refusal, separate derived completion consent/event pair, expiry/discard, committed-event rejection, replay/recovery and browser confirmation/uncertainty. Original native-seam run41020677752 passed selected tests ondd9; compiler failed inherited Personnel TS2339. Dedicated single-file d7c479fa1461a9147977ee0bbc2bbe763b7c270f adopted as8431cfc1b1b69d3043cd0820f8289853e366c4f5 only after originals terminal. New whole compiler and action-specific hosted results remain pending. Authored tests, hosted passes, rendered screens, authenticated journeys, installed and accepted remain distinct claims.

## Native-export inventory scope correction

The Assistant owns ONE active applicable offboarding non-outcome step operation, not the complete generic native export. `tickStepAction` accepts `kindOf(form)` and can reach legacy onboarding and outcome-related variants; it remains `backlog:confirm` in the machine inventory. The bounded registry action retains its actual native offboarding page and service anchor but has `screen.entryPoints:[]`. This changes metadata only, preserving native permissions, source/proof, case state and default API. Prior focused runtime receipts remain on their actual source SHAs; only affected registry/catalogue/capability checks and compiler need revalidation.
