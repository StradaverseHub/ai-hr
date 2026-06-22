# Consultant Feedback Triage & Plan — June 2026

Source: `AI-HR-Consultant-Feedback-Template-3.xlsx` (two reviewers).
- **Feedback Log** — 31 itemised bug/idea/suggestion rows (Yi Wei, Jess, Terrence).
- **Module Checklist (TT)** — a second reviewer, module-by-module, with Status + comments (5 blockers/bugs).
- **Module Ratings** — left blank.

## The headline finding (read first)

The demo the consultants tested is a **stale build with finished features gated off**. Five flags default OFF in code:
`MULTI_CYCLE_PAYROLL_ENABLED`, `TYPED_PAY_COMPONENTS_ENABLED`, `NOTIFICATIONS_ENABLED`, `TOIL_ENABLED`, `AUDIT_HASH_CHAIN_ENABLED`.
And several items reported as "missing/cluttered" were already merged to `main` (Wave 1 profile sub-nav, manager-comp lockdown, leave declutter, org-chart interactions, the notification bell shipped 2026-06-22).

**~12 of the 31 items close by redeploying `main` to the demo + enabling flags + fixing 5 small bugs** — near-zero new build. Do this *first* so the consultant re-evaluates the real product, then invest build effort in the genuine gaps.

Status legend: ✅ DONE (redeploy) · 🔒 GATED (enable flag) · 🟡 PARTIAL (extend) · 🆕 NEW (slice/ADR) · 🐞 BUG (fix)

## Feedback Log — per-item triage

| # | Item (short) | Status | Plan | Epic |
|---|---|---|---|---|
| 1 | Multiple payroll cycles within a month | 🔒 GATED | Enable `MULTI_CYCLE_PAYROLL_ENABLED` on demo (ADR-0024 built); verify cycle UI | A→B |
| 2 | EPF modes: Auto / Manual% / Manual fixed / Semi-Auto / None | 🟡 PARTIAL | Wave 2B built modes; add the 5-mode selector + manual rate input on statutory profile | B |
| 3 | Standard HR reports + export (xlsx/csv/pdf/docx) | 🟡 PARTIAL | Wave 4 has 5 analytics reports; add report catalog + export framework + scopes/filters | E |
| 4 | Employee Profile: left-nav (declutter) | ✅ DONE | Wave 1 #132 shipped; redeploy + verify; extend sections if thin | A |
| 5 | Manager can see subordinate compensation | ✅ DONE | Wave 1 #129 locked this down; redeploy + verify | A |
| 6 | Per-statutory-body independent versioning | 🆕 NEW | ADR: split single statutory publish into per-body (EPF/SOCSO/EIS/PCB/HRDF) packs | B |
| 7 | HRDF missing from statutory config | 🟡 PARTIAL | Wave 2A built HRDF levy; surface it in the statutory config editor (rates + T&C) | B |
| 8 | Leave page: remove Team Availability calendar | ✅ DONE | Wave 1 #130 decluttered; redeploy; team availability lives on dashboard | A |
| 9 | Define payment items: Allowance/Deduction/Contribution/Non-Payable | 🟡 PARTIAL | Enable typed components (ADR-0025) + add the 4 item classes + config UI | B |
| 10 | Leave page: only balance/history/apply | ✅ DONE | Wave 1 #130; redeploy + verify employee Leave page scope | A |
| 11 | Notification bell 🔔 with red badge | 🔒 GATED | Enable `NOTIFICATIONS_ENABLED` (shipped 34-3 this week); verify | A |
| 12 | Manual payroll input / import (OT, allowances, deductions) | 🟡 PARTIAL | `payroll_input` exists; add manual-entry UI + CSV import of pay inputs | B |
| 13 | People page: search + structured filters (scale to 500+) | 🟡 PARTIAL | #109 added search+pagination; add company/dept/status filters + search by ID/email | F |
| 14 | EA-Form line on PCB-subject components | 🔒 GATED | Add `eaFormLine` attr to typed components; enable | B |
| 15 | Rounding method per component (Up/Down/Nearest) | 🔒 GATED | Add rounding config on component | B |
| 16 | Org chart: expand/collapse on click + photo upload | ✅ DONE +🆕 | #79 shipped interactions (redeploy); add employee profile-photo upload (onboarding task) | A + F |
| 17 | Payroll Config tab (cut-off methods, payment basis, OT/claim/leave/attendance/salary cut-offs) | 🆕 NEW | New Payroll Config tab under Payroll Policy | B |
| 18 | Leave depth: cycle, category-by-grade, multi-level approver (≥3), holiday group by state, earned/lump-sum | 🆕 NEW (Blocker) | Leave configuration-depth slice + ADR | C |
| 19 | Fewer / job-function roles (Recruiting/Payroll/Comp/Performance Partner) | 🆕 NEW | RBAC role redesign + ADR | H |
| 20 | (blank/incomplete entry — "Admin & Setup", no detail) | — | Confirm intent with reviewer | — |
| 21 | Pay-component Edit/Delete (guard historical-use) | 🟡 PARTIAL | pay-components admin exists; add edit/delete + "used in history ⇒ cannot delete" guard | B |
| 22 | Payslip templates + PDF + email + password (+ A5 print, TT) | 🆕 NEW | Payslip template engine + PDF render + email (34-5 adapter) + encryption + A5 | B |
| 23 | Batch payroll by employee/department selection | 🟡 PARTIAL | Batches exist; add selection UI (group/dept/individual) before run | B |
| 24 | ESS personal-info change → approval workflow (marital/dependents) + HR task | 🟡 PARTIAL | Bank/PCB already approval-gated; extend to personal info + HR follow-up tasks | D |
| 25 | Leave validation engine: maternity/paternity/sick/hospitalization eligibility + mandatory docs + workflow + notifications + audit | 🆕 NEW (large) | Leave validation + structured approval-workflow engine; ADR (statutory facts sourced) | C |
| 26 | Visual analytics: charts + dashboards + filters + export | 🟡 PARTIAL | Extend Wave 4 analytics with chart layer + demographic/headcount/leave dashboards | E |
| 27 | Data templates (download template + validating import) on every upload | 🆕 NEW | Per-module template download + validating importer (extends CSV importer #107) | F |
| 28 | Performance full lifecycle (init→goals→MYR→YER→calibration→closure + attachments + 360) | 🟡 PARTIAL | ADR-0022 Phase B built goals/check-ins/360/calibration; assemble into guided lifecycle + per-step attachments + employee-set-KPI | G |
| 29 | Submit Resignation + offboarding workflow (manager ack → HR → offboarding → done) | 🆕 NEW | Resignation + offboarding workflow | D |
| 30 | AI-assisted configurable payroll formula engine | 🆕 NEW (large) | Configurable formula engine + AI assist | K |
| 31 | KB hierarchy (Spaces→Sections→Pages) + enforced role/grade visibility | 🟡 PARTIAL | `audience` field exists; add hierarchy + enforce visibility filter (fixes TT R34) | J |

## Module Checklist (TT) — bugs, blockers & extra suggestions

| Ref | Finding | Status | Plan | Epic |
|---|---|---|---|---|
| R8 | Dashboard: want configurable drag-drop widgets | 🆕 NEW (low) | Configurable dashboard layout (later) | E |
| R9 | Planned absences not expandable from Dashboard | 🐞 small | Add expand/deep-link from dashboard timeline | A |
| R10 | Download monthly attendance + payslip as PDF | 🆕 | PDF export (ties to #22) | B/F |
| R11 | 1st-time auto-save, 2nd-time onward needs approval | 🟡 | Nuance on #29 ESS workflow | D |
| R13 | Profile lacks many required fields | 🟡 | Expand profile master-data fields (with #3 field list) | F |
| R14 | Excel import: profile + historical payroll/leave/claim | 🆕 | Historical-data migration importers | F |
| R16 | Org-chart "back" returns to People, not the chart | 🐞 BUG | Fix back target | A |
| R17 | "Not able to add reporting line" | 🐞 verify | Capability exists in `core/org.ts`; reproduce on demo (UI/permission/discoverability) | A |
| R18 | Show more leave-type balances to staff | 🟡 small | Surface all entitled balances | C |
| R19 | Multi-level approval | 🟡 | = #18.3 | C |
| R20 | "Cant find where to set public holiday" | 🐞 discover | UI exists at `/admin/holidays`; improve nav surfacing | A |
| R21 | Multi-shift, mobile attendance, duty roster, geofencing, wifi-restriction | 🟡 + 🆕 | Shift/roster ADR-0032 built+gated (enable); mobile/geofencing = mobile app | I |
| R22 | OT submission types: pre-OT / post-OT / auto-OT | 🆕 | OT request typing on attendance | I |
| R23 | Calendar view + applicant leave history before approving | 🟡 | Approvals context panel | C |
| R24 | Employee sets own KPI/RFI, manager approves/monitors | 🟡 | = #28 employee-set-goal flow | G |
| R26 | "Not able to self-review (Mei Ling)" | 🐞 verify | Self-review exists; likely no open self-review assigned in demo seed | A/G |
| R28 | A5 payslip for carbon-copy printing | 🆕 | = #22 template engine | B |
| R31 | Company may have multiple EPF/SOCSO/HRDF numbers | 🆕 | Schema: multiple employer numbers per company | B/H |
| R32 | Role assignment: select multiple companies (not just group/one) | 🆕 | Multi-company access selection | H |
| R34 | Employee can still see HR guide in KB | 🐞 BUG | Enforce `audience` filter on KB list/detail | J |
| R37 | Translate leave-type names per language | 🟡 small | i18n leave-type names | C |

## Epic roadmap & sequencing

- **Wave 0 — Reclaim + Bugs (days, near-zero build).** Redeploy `main` to the demo; enable `MULTI_CYCLE_PAYROLL_ENABLED`, `TYPED_PAY_COMPONENTS_ENABLED`, `NOTIFICATIONS_ENABLED`, shift/roster; fix R16/R20/R17/R26/R34 + R9; re-verify #4/#5/#8/#10/#11/#16. Closes ~12 items.
- **Wave 1 — EPIC B · Payroll config & pay-components.** #2,6,7,9,12,14,15,17,21,22,23 + R10/R28/R31. Biggest cluster, mostly extends gated work. (Yi Wei's list.)
- **Wave 2 — EPIC C · Leave 2.0.** #18 (Blocker) + #25 + R18/R19/R23/R37. Core MY HR; statutory facts sourced.
- **Wave 3 — EPIC E · Reporting/analytics + EPIC F · People depth/templates.** #3,26,13,27,16-photo + R8/R13/R14.
- **Wave 4 — EPIC D · ESS workflows + EPIC G · Performance lifecycle.** #24 (personal-info approval), #29 (resignation/offboarding), #28 + R11/R24/R26.
- **Wave 5 — EPIC H · Roles/access + EPIC J · KB hierarchy + EPIC I · Attendance depth.** #19 (job-function roles), #31 (KB hierarchy) + R21/R22/R32.
- **Later — EPIC K · AI formula engine (#30/#35); mobile app (geofencing/mobile attendance).**

### Cross-cutting platform pieces (build once, reuse)
- **Export framework** (xlsx/csv/pdf/docx) — recurs in #3/#22/#26/#27/R10.
- **Attachment/document-upload** — recurs in #25/#28/#34.
- **Notification engine** (shipped 34-x) — substrate for every "notify on submit/approve/reject" in #25/#29/#34. Ready; 34-5 email adapter unblocks payslip-by-email (#22).

### Wave 0 outcome (2026-06-22)
Deployed `main` to the demo (CHGBAPP) + enabled NOTIFICATIONS / MULTI_CYCLE_PAYROLL / TYPED_PAY_COMPONENTS. Fixed R34 (KB audience clearance now enforced on every read; 425 tests green). Confirmed R16/R17/R20/R26 already correct in the current build (the demo was stale). **Pending:** the operator must `sudo systemctl restart aihr` for the new build + flags to take effect.
