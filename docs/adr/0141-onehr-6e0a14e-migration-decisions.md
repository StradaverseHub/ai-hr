# ADR-0141 — OneHR 6e0a14e migration decisions (ADR-M01…M16)

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

## Consequences

- New work in this repository on the OneHR delta cites this ADR and the relevant M-number.
- A business-policy item (M05, M11, M16 and the scope rows of M03/M09/M10) is not built until its Chin Hin confirmation is recorded in the migration approval log.
- Nothing here changes current production behaviour.
- When ADR-0135's effective-permission catalogue ships, OneHR admin items and leader abilities map onto it, and ADR-0142's role becomes one of its bindings.
