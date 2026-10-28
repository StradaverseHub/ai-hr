# ADR-0149 — Two-step result release and leader reads

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-28
- **Status:** Built (WP-E, migration 0665); merge held until the client confirms CF-08 (APR-021, APR-022). Not released.
- **Amends:** ADR-0103 §Frozen results, authorization and releases (see its amendment of the same date).
- **Related:** ADR-0034 (notifications), ADR-0103, ADR-0141, ADR-0142; WP-B2 leader seats (migration 0663).

## Context

AI-HR released each result component (performance, potential, talent, 360 report) to the person in one step. The source system releases in two steps (CF-08): first to the person's leaders, so they can discuss the result, then to the person. APR-022 asks for the source's behaviour exactly, with AI-HR's role structure (APR-015).

AI-HR also let a line manager read a frozen final band as soon as HR froze it, before any release (E-1). The source makes the line manager wait for the release to leaders.

## Decision

1. **Two steps on the one release owner.** `performance_assessment_release` gains nullable `performance_`, `potential_` and `talent_leader_released_at`. Its only application writer is `packs/performance/onehr/release-service.ts`, used by the per-person panel (both steps at once, the source's form without a step) and the bulk release page. Employee columns stay mirrored into `performance_onehr_result`; leader columns are never mirrored. Releases recorded before this change count as released to leaders (backfill).
2. **Rules, decided from the row locked under the review's advisory lock** (the key freeze and calibration writes use):
   - release 1 goes to the line manager (the review's reviewer), the live HOD assignment and the live business unit CEO seat; components are performance, potential and talent;
   - a component is released only when its result resolves; a re-release keeps the first timestamp;
   - release 2 needs release 1 for that component, otherwise the person is skipped and counted;
   - revoking release 1 is refused, and counted, while release 2 stands;
   - the 360 report stays single-step to the person and needs the valid minimum.
   There is no CHECK for the ordering (E-4): the service owns it and the writers are enumerated in migration 0665.
3. **Authority stays AI-HR's (E-3).** The release administrator is the cycle's OneHR administrator who administers the person's company and is not the person (`app.onehr_release_admin`, the release row's policy). The source restricts the page to its super administrator; AI-HR keeps its composable roles, including the performance partner on OneHR-native cycles (ADR-0142).
4. **Leader reads are definer projections**, never a policy on the release table. `app.onehr_leader_role` resolves the viewer's role over a review, strongest first: business group CEO, group chief, business unit CEO, HOD, line manager; never the person. `app.onehr_leader_result` returns each axis's steps (self, line manager, HOD, BU CEO, BG CEO, group chief, HR) cut at the leader's own step until release 1 (Mid-Year: the chain ends at the HOD), and the whole chain with the final band after it. BG CEOs and group chiefs read at once. The cut happens in the database: hidden steps carry no band and no reason. An administrator is not a leader by being an administrator.
5. **Line-manager masking (E-1).** Readers that show a frozen band to anyone but the person mask it through `app.onehr_frozen_visible`: a cycle administrator sees every component; a leader sees a component once it is released to leaders. `onehr_result_read` is unchanged, because services use the manager's ability to see the frozen row as their is-it-frozen guard. Masked readers: the review projection (`getOnehrReviewTx`, and with it the review screen and the AI context built from it) and the performance report (`onehrReportResultsTx`). The home and task projections carry no band.
6. **Notices.** After the writes, in the same transaction: one `onehr.results-to-leader` event per leader newly reached, with a count (a BU CEO's also counts the BG CEO's own moves and names the units; not at Mid-Year), and one `onehr.results-to-person` event per person, naming the components. Never a band, never another person's name, nothing on revoke. The append-only ledger `performance_assessment_release_notice` (UNIQUE per review, component, step and recipient) decides "newly" atomically and survives a revoke, so a revoke and re-release tells nobody again.
7. **Email follows AI-HR's rules (E-6, AIHR-STRUCTURE).** The in-app notice always lands. Email follows the tenant's performance category policy and each recipient's consent, and carries the category alert, not the notice text. The source mails everyone with an address, in waves.
8. **Screens.** `/performance/[cycleId]/release` (performance administration, `requireOnehrAdminAccess`) and `/performance/led` (any signed-in person; a viewer who leads nobody sees an empty page). Both are registered in the function-access registry.

## Consequences

- A line manager no longer sees a frozen band before HR releases it to leaders. This is a visible change for managers and is the source's behaviour.
- Leaders see each calibration tier's recorded reason on the steps they may read (E-2; ADR-0103 amendment).
- The per-person panel now notifies once per release action rather than once per component, and also tells the leaders it reached.
- Not reproduced: the source's business-unit calibration-group calibrator as a second BU CEO source (B2 kept no BU-level groups), imported pre-system talent statuses, and email waves.
