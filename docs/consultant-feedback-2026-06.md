# Consultant testing feedback — triage & roadmap (June 2026)

Source: `AI-HR-Consultant-Feedback-Template.xlsx` (remote consultant round, gated demo).
Only the **Feedback Log** tab was filled — 11 items, two reviewers (**Yi Wei** → payroll/statutory;
**Jess** → UX/reporting/profile). The *Module Checklist* and *Module Ratings* tabs were left blank, so
there are no per-module statuses or 1–5 scores — just these 11 written items (10 of 11 rated High).

Status legend: `todo` · `in progress` · `done` · `needs decision` (owner fork) · `needs sourcing` (official MY figures).

## The 11 items

| # | Theme | Module | Item | By | Sev | Verified current state | Status |
|---|---|---|---|---|---|---|---|
| 5 | Access control | People / Perf | Manager can see subordinate **base compensation**; restrict to HR/Payroll/C&B/HRBP | Jess | High | People detail page renders `currentCompensation` (RLS visibility is downward → a manager can read a report's comp). The perf-review **merit/bonus recommendation** is a deliberate manager-authored exception. | todo (Wave 1) |
| 8 | UX | Leave | Manager: "too many things on one page" — remove Team Availability calendar from Leave; keep it on the Dashboard | Jess | High | Leave page carries balances + team availability + requests in one screen | todo (Wave 1) |
| 10 | UX | Leave | Same as #8 — Leave page should show only Balance + History + Apply; no team calendar/approval queue/team requests | Jess | Med | (duplicate of #8 — one task) | todo (Wave 1) |
| 11 | UX | Approvals | A 🔔 notification bell (top-right) with a red badge for pending actions; approvals as actionable notifications | — | Low | Approvals live only in the `/approvals` inbox; no global indicator | todo (Wave 1) |
| 4 | UX | People / Profile | Employee profile is one overloaded screen → introduce a **persistent sub-navigation** (sectioned tabs) | Jess | High | Profile pages render every section in one long scroll | todo (Wave 1) |
| 7 | Payroll/statutory | Payroll | **HRDF (HRD Corp) levy** is missing — add config (rates + T&C) | Yi Wei | High | Not present anywhere | todo (Wave 2) · needs sourcing |
| 2 | Payroll/statutory | Payroll (EPF) | EPF **contribution modes**: Auto / Manual-% / Manual-fixed / Semi-auto / No-contribution, admin-overridable | Yi Wei | High | Exact **auto** rates only (they acknowledge the rate is now correct) | todo (Wave 2) · needs sourcing (voluntary/special rates) |
| 1 | Payroll/statutory | Payroll | Allow **multiple payroll cycles in the same month** (off-cycle / bonus / mid-month) | Yi Wei | High | Unique index `(company, 'YYYY-MM')` → exactly one batch per month | todo (Wave 2) · needs decision (period model + MTD aggregation) |
| 9 | Payroll/statutory | Payroll | **Typed payment items** — configurable Allowance / Deduction / Contribution / Non-Payable | Yi Wei | High | basic + single allowance only; this is the deferred "typed pay components" fork | todo (Wave 3) · needs decision (ADR) |
| 6 | Payroll/statutory | Payroll | **Per-statutory-body versioning** — publish a version per body, not one global ruleset | Yi Wei | High | `StatutoryRuleset` is versioned as ONE blob (ADR-0019/0020) | todo (Wave 3) · needs decision (re-architect) |
| 3 | Reporting | Overall | **HR analytics + master-data reports** (turnover, absenteeism, headcount/workforce planning, salary benchmarking, dept cost, payroll validation) + standard exports with a long field list | Jess | High | We have **statutory** reports (EA/Form E/CP39…); no **people** analytics | todo (Wave 4) · needs decision (first tranche) |

## Themes
- **Payroll depth & MY statutory completeness** (5/11, all High, all Yi Wei) — our actual moat; the heaviest and most architectural cluster (#1/#2/#6/#7/#9).
- **UX "too much on one page"** (Jess) — appears 3× (profile, leave ×2) + the notification bell. Cheap, visible wins.
- **Reporting & analytics** (#3) — a large new module; high business value.
- **Access control / privacy** (#5) — small to scope, security-sensitive.

## Plan — four waves

**Wave 1 — quick, high-trust wins (UX + the one security item).** ← *in progress*
1. **#5** Access-control: audit where managers see base comp; restrict to admins (keep the perf merit/bonus recommendation the manager authors).
2. **#8/#10** Leave page declutter → Balance + History + Apply; team availability lives on the Dashboard.
3. **#11** Notification bell — global pending-approvals indicator.
4. **#4** Profile sub-navigation — sectioned profile.

**Wave 2 — payroll flexibility (MY moat).** #7 HRDF (sourced) · #2 EPF modes · #1 multi-cycle (period model + MTD aggregation; needs sign-off).

**Wave 3 — pay-component & statutory architecture (ADRs).** #9 typed pay components · #6 per-body statutory versioning.

**Wave 4 — HR analytics & reporting (#3).** New module; start with a first tranche (Headcount, Active Master Data ±comp, New Hire, Termination, Turnover %).

## Decisions needed (owner forks — do not guess)
- **#5** — managers never see base comp, or only the merit/bonus recommendation they author? *(Wave 1 default applied: restrict base comp to admins; recommendation stays.)*
- **#1** — supplementary/off-cycle run model + how PCB/EPF month-to-date aggregates across multiple runs.
- **#9** — the pay-component model (per-component tax/EPF/SOCSO treatment flags).
- **#6** — re-architect statutory versioning to per-body (revisits ADR-0019/0020)?
- **#3** — which reports form the first tranche.

## Sourcing needed (official MY figures — never invent)
- **#7 HRDF** — HRD Corp levy rate, wage base, employer eligibility/sector coverage, T&C.
- **#2 EPF** — voluntary/special contribution rate rules (the "auto" path already uses the verified table).
