# Performance parity inventory and first slice

Baseline 3a2a015683c0a1ad8ec6f341186f7fa12a5fcdad. This is a held divergent stack, not a release candidate.

## Existing Assistant effects

- Standard released, submitted own review acknowledgement: native acknowledgeReviewTx; digest-bound source, exact native event, current self/release gate, encrypted custody.
- Closed own OneHR plan acknowledgement: native acknowledgeOnehrPlanTx; distinct conversation meaning, exact plan revision/event and shared custody.

## Native surface inventory

app/performance/actions.ts owns standard cycle creation/open/calibration/release/close; goal proposal/approval/link/unlink; own and manager stage/review submission; peer invitations; check-in scheduling/completion/cancellation; calibration and compensation decisions. Each is a distinct effect except thin aliases that dispatch to those same owners. These effects do not acquire Assistant mutation parity in this change.

app/performance/onehr-actions.ts dispatches cycle/review/feedback commands; department agreement; group locks/bands; calibration; assessment drafts/conversations; KPI/architecture/panel imports; final bands and rating-record capture; bulk release; career/development suggestions and native admin tools. Do not duplicate engine optimization, provider source work or claim-history work.

Native tab-service.ts and tab-model.ts derive actual viewer work from performanceWorkspaceTx. Tabs differentiate own, team and calibration seats; closed module means hidden, and fully locked plan work means disabled. This avoids inventing a blanket HR role. Native destinations retain their own route and command checks. Imports, generated drafts and multi-effect release workflows remain native human workflows.

## Implemented first slice: native workflow handoffs

Assistant Performance now offers only open native tabs, using the native pack facade and its existing tab registry and gate. The acknowledgement choice owner revalidates current principal, Assistant grant, module entitlement and pause first. Empty own acknowledgement choices do not suppress assigned leader work. Both denied reads and read errors fail closed. Output contains only fixed registry ID, route and locale label key; no participant, record IDs, bands, private answers or comments.

These are handoffs, not new action registry effects or a claim that any review was submitted. GET executes no mutations. The native destination rechecks scope/state. Existing six-locale performanceArea labels are reused. No provider/fact reader, authentication or shared custody redesign.

## Verification and remaining work

Five focused unit cases authored for native own/leader gates, disabled plans, registry projection, grant/pause refusal, module closure and read errors. Existing specialist section composition tests selected alongside them. Hosted results recorded in the exclusive phase status file; no local tests/compiler/build/DB executed.

No migration required for this slice. Additional mutation slices need per-action native transactional/event seams and shared custody allocation; do not assign migration slots independently. Remaining work: detailed per-command participant/state inventory and reviewed mutation adapters for goals/check-ins/review decisions; this inventory is a first checkpoint, not complete phase parity. No installation, acceptance or release claim.

## Goal approval transactional groundwork

The native approveGoal wrapper now delegates to approveGoalTx, preserving native decision and unconditional subject-ban rules. The transactional source locks the goal, verifies proposed state and returns a private actor-bound content digest. Optional reviewed calls refuse changed goals before any effect. The one native event returns its exact inserted UUID; that UUID is not proof of commit. Existing native callers still receive void and retain their normal wrapper transaction/module gate. No Assistant goal effect is registered or browser-enabled yet.

Focused native lifecycle coverage adds changed-content refusal, effect/event rollback on completion failure, exact event/subject/actor binding and refusal of a second approval. Existing manager/peer, goal lock and lifecycle cases remain selected. Migration allocation for assigned goal review custody is requested only in the exclusive phase status file.

## Allocated reviewed goal approval slice

`performance.goal.approve` now uses the existing generic assigned review custody and native `approveGoalTx`. The human chooses a proposed goal, prepares a review of its stored title/description/measure/target/weight/due date, then separately confirms the exact saved review. There is no model-authored goal content or rating/pay decision. The dedicated page uses the same same-origin command route, principal-scoped component lifetime, abort/recovery/expiry controls and strict response binding as existing maintenance panels.

The source holds the existing Access configuration lock and goal row lock, repeats native assertCanDecide plus the absolute subject ban, and binds pending approval to current row xmin and native actor/content digest. Completed custody retains only native goal/employment/event references. Current native approval status, approved actor/timestamp and exact null-payload native event must agree on reopen; goal content is not included in the terminal receipt. Shared whole-transaction completion and privacy target capture remain the existing owners.

SQL `0730_assistant_performance_goal_approval.sql` is coordinator-allocated provisional development only (idx710, version7, when1793330000067). It extends the existing ledger's constraints/subject/binding/proof and outcome readers additively, preserving predecessor expressions/SQL. No sibling migrations are imported to fill missing indices. Choice scope mirrors native goal visibility and current direct administrative manager/whole-scope delegation/admin authority, with an unconditional subject ban; it does not substitute a blanket HR requirement. Real unlinked USER administrators are supported; SYSTEM cannot enter human custody.

New tests cover actual migrated native/shared custody, human-only contracts, actual manager and linked-super-admin/employee/peer/unlinked-admin/foreign-tenant actors, current-manager and Assistant revocation, changed goal refusal, no effects at prepare/discard, exact event proof, completed retry/reopen without replay, erasure of terminal private review bodies, and full rollback if custody completion fails. Panel tests cover explicit consent, substituted subject refusal, expiry, lost-reply recovery and six-locale rendered review screenshots. Authored coverage remains distinct from hosted results and authenticated journeys.

Shared-file changes: additive agent registry entry, module-action HTTP union/result/owner, module-action server owner, static source manifest, six locale namespaces and migration journal append. No provider/fact-reader/authentication/runtime redesign. Remaining native slices (review submission/competencies/check-ins/calibration/release etc.) remain inventory gaps and native workflows; the phase is not complete.

## Focused recovery provenance

The first goal candidate db394 had a missing client packet-map entry, missing native capability classification, missing completed-outcome map/parity closure and exponential0730 constraint construction. Original tests/artifacts were preserved; no goal DB cases executed before PostgreSQL OOM. Recovery4298 repairs those mappings, adds a separate real eleven-role Performance group without changing any predecessor actions/variants, and bounds own0730. Its whole compiler and both10-case goal/archive panels passed, while registry/guard inherited metadata expectations and prefix-induced OOM remained.

After all4298 jobs finished, coordinator-authorized isolated source commits d7c(compiler),9bd(seed metadata),22a(portable guard) and f82(bounded UNAPPLIED0726) were adopted as separate commits. Conflicted f82 composition preserves this held branch's cost authority/native/proof SQL and existing document facts; only the exact7-line bounded constraint diff and6-line note are carried. No parent cost bundle is imported. The new goal is added to the explicit probed inventory; old frozen pending ceilings remain unchanged. Final source requires its own focused runtime/whole compiler evidence and OOM/constraint-size/hybrid refusal receipts; passing evidence is never relabelled from earlier SHAs. These source repairs do not lift the global release hold or complete the broader phase.
