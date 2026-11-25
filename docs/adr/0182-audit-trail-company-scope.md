# ADR 0182 Audit Trail company scope for company-scoped administrators

Date: 25 November 2026

Status: Accepted by the owner on 25 November 2026 (Phase 1: decisions 2a, 3 and 4 below). Phase 2 needs its own approval. Amends ADR-0015 §1 ("Admins read every event in their tenant") for the Audit Trail reads.

## Context

The `domain_event` read policy (0037, made set-based in 0515) is `tenant AND (app.is_admin() OR subject employment visible)`. `app.is_admin()` (0016) is true for any `hr_admin` or `super_admin` grant, including an `hr_admin` granted a single company. So a company-scoped administrator could open `/admin/audit`, and its CSV, XLSX and PDF download, and read every company's events with their payloads. The Company filter listed every company. A two-company fixture confirmed this on GitHub Actions (alpha-focused-checks run 45535329171, probe commit e04d7835b, not merged).

Later decisions had already narrowed individual record kinds through restrictive policies: feedback (0561), tax (0579), notices (0582) and the group-wide attendance clock policy (4342, owner decision 11 Nov 2026). The general rule remained tenant-wide.

About fifteen other features read the same table under that policy and some depend on whole-ledger sight. Examples are the delete-safety checks for termination reason codes and movement types, the repeat-submit receipts for attendance workflow save and chat import, payroll-audit capture, last sign-in, and the payroll run screens. About 700 of about 1,770 event-writing call sites record neither a company nor a subject employment. Narrowing the shared policy in one step would therefore silently change those features.

## Decision

### Phase 1 (this change): narrow the Audit Trail reads

Every Audit Trail read applies a company scope through `auditCompanyScope()` in `core/read.ts`. The reads are the rows, the count, the record-type and user dropdowns, the per-record History reads built on `auditEvents`, and every download format. The Company filter lists only the companies the viewer administers (`listCompanies(…, {adminOnly: true})`).

- Group administrators (a group-wide `hr_admin`, or any `super_admin`) see exactly what they saw before.
- Non-administrators are unchanged: row security alone decides.
- For a company-scoped administrator an event is in scope when any of these anchors holds:
  1. its subject employment is one they may see (`app.visible_employment_ids()`);
  2. its payload records one of their companies as `companyId`;
  3. its aggregate is one of their companies, a company-owned row in one of their companies (payroll run, pay period, payroll cycle, leave approval policy, shift, payroll policy, position, review cycle, department, cost centre, business unit, statutory report, attendance allowance policy), or the login account, person, statutory or compensation record of someone employed there (`app.audit_admin_aggregates()`);
  4. they performed it themselves.
- **Decision 2a:** group-level records, meaning those with no company in particular (group settings, access configuration, AI Centre, group-wide policies and catalogues, a JSON-null `companyId`), are for group administrators only. The person who made the change also sees them, under anchor 4.
- **Decision 3:** an employee's history follows their **current** company, exactly as Personnel visibility does. After a transfer the new company's administrator sees it and the old one no longer does.
- **Decision 4:** a company administrator always sees the changes they made.
- When a Personnel subject is named (`?employment=` / `employeeAudit`), the existing Workforce-visibility clause for that employment is the authorization. No further scope applies there.

Migration 7360 adds `app.admin_company_ids()` and `app.audit_admin_aggregates()`. Both are SECURITY DEFINER, STABLE, pinned to `search_path`, granted EXECUTE to `ai_hr_app` only, and bounded by the current tenant and the session's own grants. No table, row, policy or existing function changes. The scope's sub-selects are uncorrelated, so PostgreSQL evaluates each once per statement, as an InitPlan or a hashed SubPlan, and never once per event row. The group-administrator arm short-circuits before any of them run. Reads take no Access lock.

### Phase 2 (separate approval): narrow the shared policy

First move each reader that genuinely needs whole-ledger sight behind its own reviewed definer function. These are the delete-safety checks, the repeat-submit receipts, payroll-audit capture, the 6376 invoker guard and the chat-import outcome. Then record a resolvable company on sign-in, payroll-run and catalogue events, and narrow `domain_event_read` with the same anchors so future readers are safe by default. `app.approval_history()`, which treats any administrator as whole-tenant, is a related follow-up.

## Consequences

- A company-scoped administrator no longer reads other companies' audit history or payloads on the Audit Trail screen or its download. The Personnel History, payroll run "closed by", attendance policy "last updated" and attendance recompute run history are scoped the same way, because they read through `auditEvents`. Their in-scope rows are unchanged.
- Record kinds that carry no company and no anchor leave a company administrator's Audit Trail. Under 2a that is intended. Any kind that should be company-visible must record its company or gain an anchor in `app.audit_admin_aggregates()`.
- The anchor list is closed. A new company-owned aggregate falls into "group-level" until it is added, which fails closed.
- Group administrators' results are proved equal to the previous reader (rows, order, counts) in `test/audit-trail-company-scope.test.ts`, on a 72-company, 1,000+ employment fixture.
