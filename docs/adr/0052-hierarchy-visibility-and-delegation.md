# ADR-0052 — Hierarchy visibility (direct + indirect / HOD) and approval delegation

**Status:** Accepted · **Date:** 2026-06-27 · **Extends:** ADR-0009 (company-scoped authz), reuses the `reporting_line` graph

## Context

`reporting_line` (typed, bitemporal, cycle-guarded) and the self-referential `department` tree already exist. `app.can_see_employment` (migrations 0001/0016) matched only a **direct** administrative manager — a single-hop `EXISTS`. The feedback asks for: managers see **direct + indirect** reports; an **HOD** sees the **department tree**; HR sees all; employees see only self. And a **Delegate** function so an absent reporting-line holder can assign someone to approve on their behalf.

## Decision

1. **Recursive administrative-graph visibility (migration 0108).** A named SECURITY-DEFINER helper `app.is_admin_report_of(subject, manager)` walks DOWN the active `administrative` `reporting_line` graph from the manager (mirroring `wouldCreateAdminCycle` pointed downward). `app.can_see_employment`'s manager branch is rewritten to call it, so a manager now sees direct **and** indirect reports. The self + admin branches are kept byte-identical to 0016.

2. **HOD = derived (D1 = a).** `app.heads_department_of(subject, caller)` is true when the caller is the administrative manager whose **current** assignment department is ancestor-or-self of the subject's current assignment department (walking `department.parent_department_id`). "Current" uses `valid_to IS NULL AND superseded_at IS NULL` (the read-layer predicate). We chose **derived** over an explicit `department.head_employment_id` column: it reuses the recursive helper + department walk, needs zero schema and zero admin UI, and avoids a stale-head lifecycle problem (a transferred/terminated head would keep visibility on a bare column).

3. **Company clamp (D2 = clamp).** The recursive walk is clamped to the manager's own company subtree (`app.is_company_descendant`). An indirect report in a *sibling* company is **not** surfaced unless the manager has a separate admin grant there — preserving the ADR-0009/0016 tenant-leak fix.

4. **See ≠ decide (D3).** An indirect manager / HOD can now **see** a report's employment but `assertCanDecide` / `generateApprovalSteps` still resolve only the **direct** administrative manager (+ HR + an active delegate). Decision authority is intentionally NOT widened to indirect/HOD managers; that would be a separate, larger change. Stated here as deliberate asymmetry.

5. **Multi-employment seed.** The manager and HOD branches resolve the caller over **all** of their employments (a person can hold concurrent employments — Slice D), so visibility is the union over every caller employment.

6. **Compensation/payslip non-regression.** `compensation_rls` (migration 0060) is admin-or-self, NOT `can_see_employment`. An indirect manager who newly gains employment visibility therefore gains **no** base-pay visibility. `payslip_rls` does gate on `can_see_employment`, so an indirect manager gains payslip read — this matches the existing direct-manager behaviour and was accepted.

7. **Terminated-employee handling (Step 3).** `terminateEmploymentTx` now ENDS the terminated employment's open `administrative` reporting-line edges (as manager and as subordinate) in the same transaction, appending `reporting-line.ended` per substrate rule. Belt-and-suspenders, `is_admin_report_of` also filters `terminated_on IS NULL` at every hop and on the subject, so a multi-hop walk never traverses through a fired mid-level manager.

8. **Delegation = approver-routing only.** The "assign an approver during an absence" ask is an **approver substitution**, not a visibility grant. We **reuse `reporting_line`** with a new `delegate` line type rather than a new table — inheriting the bitemporal window, tenant scoping, supersede logic, events, and RLS. Orientation: subordinate = the **delegator** (line-holder going on leave), manager = the **delegate** (stand-in approver), windowed by `valid_from`/`valid_to`. Created via `setReportingLine({ lineType: 'delegate', validTo })`, ended via `endReportingLine`.
   - **Approver functions:** `assertCanDecide` gains a delegation branch — the caller is a valid decider if an **active** `delegate` edge names them as the delegate AND the delegator is the subject's **current direct administrative manager** (re-validated at decision time, not merely at create time) AND the window covers `current_date`. `generateApprovalSteps` is unchanged: steps key off step *kind* (`direct_manager`), so a future-windowed delegation needn't exist at request time.
   - **Edge-case rules (enforced + tested):** (1) **no transitive delegation** — only ONE delegation hop is resolved (A→B, B→C gives C no authority over A's reports); (2) reject **overlapping** active delegations of the same delegator; (3) `valid_from <= valid_to`; (4) re-validate the delegator's underlying administrative line at decision time; (5) the **self-approval ban** (task #84) is preserved against the SUBJECT — a delegate who is themselves the subject is still blocked.
   - **No visibility inheritance:** there is no `can_see_employment` delegate branch. A delegate can approve but cannot read the delegator's reports' employment/compensation just by holding the delegation.

9. **Org-chart / edge-read scoping (Step 6).** `reporting_line_rls` is tenant-only (it does NOT call `can_see_employment`), so `orgChartData`'s edge query previously returned every tenant edge — including edges through terminated managers. The edge query now requires BOTH endpoints to be visible (`app.can_see_employment`) and live (`terminated_on IS NULL`), and excludes `delegate` edges. `reportingLinesFor` and `delegationsFor` likewise separate structural lines from delegation rows.

## Out of scope (flagged, not built)

Delegation visibility inheritance; indirect-manager/HOD **decision** authority; `/me` self-service delegation (D4 — kept out, this is an HR/manager admin action); functional/project/dotted-line visibility; `department.head_employment_id` column; delegation-start notifications and org-chart overlays.
