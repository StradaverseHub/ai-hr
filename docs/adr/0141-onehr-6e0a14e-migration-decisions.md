# ADR-0141 — OneHR 6e0a14e migration decisions (ADR-M01…M16)

> Decision record at its recorded date; implementation/status observations are historical. Verify current source and later amendments. [Branch/release policy](../REPOSITORY-AND-ENVIRONMENTS.md) governs operations.

- **Date:** 2026-10-25
- **Status:** Direction accepted by the owner as platform decisions (25 Oct 2026). Business-policy content awaits Chin Hin confirmation. Implementation pending; nothing released.
- **Extends:** ADR-0103 and ADR-0115 (the native OneHR integration built from OneHR `a644fd6`).
- **Related:** ADR-0004, 0009, 0034, 0049, 0052, 0080, 0084, 0117, 0121, 0135.
- **Source records:** the migration reporting workspace outside this repository (`rea-aihr-migration`, deliverables 15–17, 47 and PHASE2_DECISION_BRIEF). Those records hold the evidence, conflict register (CF-01…CF-35) and approval log (APR-001…013). This ADR is the binding summary for work in this repository.

## Context

The supplied Chin Hin OneHR package moved from `a644fd6` (12 Oct 2026) to `6e0a14e` (24 Oct 2026):
- routes grew from 337 to 495;
- tables grew from 112 to 181;
- of 304 catalogued capabilities, 123 are new and 129 changed.

The new scope includes AI+ Learning, a rebuilt roles-and-access model, BU calibration groups, Early Year, a leaders-first release, job-architecture career routes, Help/Ticketing, an Email area and AI failover.

Phase 1 discovery assessed this delta against `main`. Phase 2 recorded the owner's decisions:
- Platform decisions were accepted on 25 Oct 2026.
- Business-policy rows are platform-approved but **require confirmation by a named Chin Hin approver before they are built**.

Phase 3a, authorized 25 Oct 2026, covers only:
- re-verification of the existing integration;
- golden fixtures;
- this ADR;
- the performance-only administrator (ADR-0142).

## Decisions

1. **M01 — Native integration only.** OneHR behaviour is reimplemented against behavioural contracts and golden fixtures extracted from pure functions. There is no Flask runtime, iframe, second frontend, second employee directory, or import of OneHR's `app.py` (importing it mutates its database).

2. **M02 — Re-verify, then apply the delta.** Native features recorded as "implementation unverified" are re-verified on one exact commit before any `6e0a14e` delta builds on them. Until then they are not counted as migrated.

3. **M03 — AI+ Learning is a new installable pack (ADR-0080),** built after the appraisal deltas and entitlement-gated per tenant:
   - Registration chains follow the ADR-0121 versioned approval-hierarchy pattern in Learning-owned tables, because there is no generic approval engine. Tasks are projected into the approvals inbox.
   - Learning reuses notifications (ADR-0034), the AI gateway with propose/adjudicate (ADR-0084), and document storage.
   - The HRD Corp levy balance is an L&D-entered, as-at figure owned by Learning. Payroll's HRDF contributions are a different fact, read only as a cross-check.
   - OneHR defects found by code reading are not reproduced: late-add skips the open-session check, unlimited seats don't promote the waitlist, HRDC status can regress, the certificate-numbering race, and declines sent under the "returned" kind.
   - The Learning access model is a separate pending decision and must be approved before Learning is built.

4. **M04 — One access model.**
   - OneHR's admin items, user roles and leader abilities converge on one effective-permission interpretation (ADR-0135) when that model ships.
   - Role names are never mapped wholesale.
   - Performance administration must be possible **without compensation access**. The first, OneHR-scoped step is ADR-0142.

5. **M05 — Organisation.**
   - A company node per OneHR business group: a real holding company where one exists, otherwise a non-statutory grouping company with no employees.
   - Each business unit is a company or a business unit, decided from the legal-entity register held by HR/Finance, never from OneHR names.
   - Business-policy confirmation pending.

6. **M06 — Identity.**
   - The HR master stays the only owner of people, employments, organisation and reporting lines; migration never creates them.
   - Matching is by tenant → company → exact employee code → employment. Names and emails are never keys. Ambiguous matches go to two-person human review.
   - OneHR admin accounts gain power only after HR attests the human behind them.
   - No password, hash, session or first-password scheme migrates; users enrol through ADR-0117 with MFA.
   - The single decision record is the migration's `idmap_*` family, called `identity_source_map` here. Per-cycle tables are derived projections and are retired after reconciliation.

7. **M07 — Email on the notification engine.** ADR-0034 is extended with pacing and waves, dated templates, release and leader-progress notifications, and idempotent delivery keys. OneHR's re-queue double send and its arbitrary test-recipient override are not adopted. Transport is SMTP through a customer relay; Microsoft Graph only if SMTP is unavailable.

8. **M08 — AI provider.**
   - No automatic cross-border failover until processor terms, zero retention and the employee notice are recorded.
   - An Azure OpenAI adapter only if the customer requires its own tenancy.
   - Every migrated AI feature uses the governed gateway and deterministic adjudication. The model never computes money, bands or approvals.

9. **M09 — Help and Ticketing are out of scope for the first cutover.** Sign-in help uses ADR-0117 recovery. The product-feedback board (ADR-0043/0044) is never repurposed as an HR helpdesk.

10. **M10 — Data scope.**
    - Configuration and reference data only (KPI library, job architecture, competency profiles, frameworks) until a validated, identity-mapped export exists and Gate G4 is approved.
    - No transcripts, no rater identities, and no historical results into Rewards.
    - Any load requires a tested restore first.

11. **M11 — Cutover between cycles.** OneHR stays the system of record for the 2026 Year-End through results release. AI-HR runs the next cycle. One cycle is never run in both systems.

12. **M12 — Release governance.** Migration rounds are **excluded from the standing automatic deploy after a green gate.** Each migration release needs an explicit owner instruction. Merging a migration branch to `main` is itself held until that instruction, because a later release from `main` would deploy it.

13. **M13 — Visual identity.** AI-HR tokens only. Fidelity comes from layout, density and behaviour. Customer colours only through a separate, later tenant-theme decision. Accessibility defects in either system are corrected, not reproduced.

14. **M14 — File storage.** `bytea` stays for evidence and Learning files, with explicit limits and a measured growth budget. Object storage is reconsidered when volumes are known.

15. **M15 — Exposure.** Through tenant module entitlement, per-company enablement, and the existing per-part switches and windows.

16. **M16 — Versioned policy.** Rules where OneHR `6e0a14e` differs from the native implementation apply only to cycles opened after the change. Frozen results are never rescored. These rules include:
    - participation by confirmation date;
    - the 17.5-point Year-End framework with 6.0/12.5 cut-offs;
    - the 300-word remark limit and 5 MB evidence files;
    - the strict scale check;
    - Mid-Year stopping at the HOD;
    - Career Plan "remark + Approve".

    Each is business-policy content awaiting Chin Hin confirmation. The owner explicitly kept AI-HR's reason-on-change for leaders' calibration band moves (CF-19) and AI-HR's confirmed PIP/promotion/special-reward decisions (CF-23).

    **Amended 28 Oct 2026 (APR-022, reverses APR-011).** The owner reversed the leaders' reason-on-change above (CF-19, which APR-011 had extended to every surface): follow OneHR, including its justifications. A BU CEO, BG CEO or Group Chief band move needs no reason on any path (the Talent Box move, the Group performance list, the generic calibration form, the calibration chat and the distribution-fit Apply). The reason field stays available and optional; a given reason is stored and audited as before. Kept as platform safety rules: the HOD's remark on each changed band, the line manager's remark when the overall band moves, and the movement ceiling on the Talent Box and the calibration chat. The fit Apply no longer writes a generated "distribution fit" note (D-P1-23 lapses); a move keeps the person's own note on that axis or none. CF-23 is unchanged.

## Career Plan reviewer scope (TASK-030)

Decided as CF-26 / AC-10; built in migration `0640_onehr_plan_reviewer_scope.sql`. Before 0640, `onehr_plan_access` admitted the whole department tree (`app.visible_employment_ids()`: skip-level managers through the administrative chain, heads of department through the department subtree) to every non-draft Career Plan, and `app.can_see_employment` let the same people write one. After 0640 a plan row is read and written only by:

- **the subject**, at any status;
- **the OneHR administrator of the plan's cycle** — `app.onehr_admin(employment company)` and `app.onehr_cycle_admin(cycle of the plan's review)`, at any status. That is HR administrators in scope and, under ADR-0142, a performance partner for a OneHR-native cycle it administers. A company-scoped grant never covers a group-wide cycle;
- **the assigned reviewer** — `app.assessment_plan_reviewer`: the review's line manager, or an approver/moderator of any of the subject's KPI lines, for a review whose cycle owns the plan year. Shared or closed plans only; a draft stays with the subject and the administrator, as before.

The visibility arm is gone from both USING and WITH CHECK, so no actor writes a plan just because they can see the employee. The scheduled dispatcher's SELECT (`assessment_plan_dispatch_read`, no human user) and the career profile policy (`assessment_career_access`: self, admin, open-review manager/moderator) had no department-tree arm and are unchanged. HR's progress and overview figures are unchanged (pinned in `test/onehr-plan-reviewer-scope.test.ts`). A performance partner now counts shared plans as HR does, where before 0640 it read none.

**Skip-level review: what OneHR does, and what AI-HR lacks (corrected 28 Oct 2026, P1 wave 3a, D-P1-01).** The earlier wording here said AI-HR diverges when a line manager is removed from the cycle. Re-reading the source shows that is not so:

- OneHR moves Career Plan review one level up only when the line manager's **unit or department** is left out of the cycle by the administrator's exclusion rule (`cycle_exclusions`, read by `unit_out`). `_cycle_review_managers` walks down through managers that rule leaves out, and `_pm_is_approver_of` refuses an approver it leaves out (OneHR `app.py:15495`, `:7178`, `:7356`, `:29236`).
- Removing **one person** from the cycle (`cycle_participants` mode `remove`) only affects that person's own participation predicates (`app.py:7429`, `:7481`). Their leader abilities are untouched (`leader_can` reads only the unit rule, `app.py:7196`), so a removed line manager keeps reviewing their reports' plans, and the skip-level manager gains nothing.
- AI-HR's only cycle exclusion is per person (`assessment_participation_snapshot` override). For that case AI-HR already matches OneHR: the removed line manager stays the reviewer (`performance_review.reviewer_employment_id` or a KPI approver), and after 0640 the skip-level manager neither reviews nor reads the plan. This is pinned in `test/onehr-plan-reviewer-scope.test.ts`.
- **The real gap** is that AI-HR has no unit/department exclusion rule. In OneHR that rule carries several effects together: the left-out people's 360 rows are archived, untouched KPI lines whose moderator is out move one level up, the left-out leaders lose every leader ability, and their reports' competency and Career Plan reviews move one level up (`app.py:67974-68098`). Building the one-level-up reviewer without the rule would invent a trigger OneHR does not have. Whether AI-HR gets the rule is a scope decision for the owner (raised as D-P1-22 in the P1 wave 3a log), not a reviewer-derivation change.

## Consequences

- New work in this repository on the OneHR delta cites this ADR and the relevant M-number.
- A business-policy item (M05, M11, M16 and the scope rows of M03/M09/M10) is not built until its Chin Hin confirmation is recorded in the migration approval log.
- Nothing here changes current production behaviour.
- When ADR-0135's effective-permission catalogue ships, OneHR admin items and leader abilities map onto it, and ADR-0142's role becomes one of its bindings.
