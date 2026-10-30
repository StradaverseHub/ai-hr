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
