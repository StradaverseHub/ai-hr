# ADR 0181 addendum: precomputed employment visibility (`access_visible_employment`)

Date: 24 November 2026

Status: **Approved by the owner on 24 November 2026** ("Approve as recommended"): all six decisions of section 10 as
written. Built, not installed: step (a) is PR 295 (headcount, no migration; in staging release 4); step (b) is PR 296
(`7230_assignment_current_department_index`); step (c) is PR 300 (`7240_access_visible_employment`, stacked on 296).
The owner decided 7230 and 7240 ship together as one migration-bearing staging release. Step (d), the leave delegation
set, is not started. Staging work goes through the shared staging queue,
after release 3, which carries 7210. That covers the read-only attribution read approved in decision 6, and later
installing the build for its shadow period, which is a separate staging release. This applies ADR 0181 decision 1 to the next family after the company pilot
([company pilot addendum](0181-addendum-precomputed-company-access.md), migration `7210_access_effective_company`, PRs
280/285/290). Source facts were read at main `a7d452c21`. Installed policy text was derived by replaying the migrations
in journal order; it has not been read back from an installed catalogue (section 9 asks for that read).

Two staging statements are the first consumers (fictional demo data, `pg_stat_statements`, 24 November 2026):

| Mean | Calls | Statement | Source |
|---:|---:|---|---|
| 7,657 ms | 1 | Admin > Organisation headcount per company | `core/company-registration-readiness.ts:19` |
| 2,588 ms | 5 | Employee picker department options | `core/employee-choice.ts` `readOptions` (departments) |

The design keeps every visibility rule as it is today. It changes where the expensive parts of the answer are stored,
and which parts are evaluated once per statement instead of once per row.

## 1. What employment visibility actually depends on

### 1.1 The functions

| Function (installed body) | What it answers | Reads |
|---|---|---|
| `app.can_see_employment(emp)` (5144) | Per-row: may the caller see this employment | admin, self, manager, department head and attendance-window arms below |
| `app.visible_employment_ids()` (5144, statement of 2105) | The same answer as one sorted `uuid[]` per statement | the same arms, as one set-based statement |
| `app.visible_person_ids()` (0515) | The caller's own person plus the persons of `visible_employment_ids()` | `app_user`, `employment`, and a second call of `visible_employment_ids()` |
| `app.is_admin_for(company)` (2303) | Session claim `hr_admin`/`super_admin` covering the company | `app.grants` only, plus `is_company_descendant` |
| `app.can_admin_payroll_for(company)` (2304) | Same, also `payroll_partner` | `app.grants`, `is_company_descendant` |
| `app.can_admin_perfcomp_for(company)` (0099) | `is_admin_for` or `performance_comp_partner` claim | `app.grants`, `is_company_descendant` |
| `app.is_admin()` (0016) | Any `hr_admin`/`super_admin` claim anywhere | `app.grants` only |
| `app.access_workforce_employment(emp, capability)` (5010) | Employment not voided, import condition, and `access_workforce_company(company, capability)` | `employment`, then the company chain 7210 precomputes |
| `app.is_admin_report_of(subject, manager)` (0109) | Recursive administrative-line walk from one manager employment | `reporting_line`, `employment`, `is_company_descendant` |
| `app.heads_department_of(subject, caller)` (0121) | Department subtree walk from the caller's department | `assignment`, `department`, `reporting_line`, `employment`, `is_company_descendant` |
| `app.can_decide_via_delegation(emp)` (0109, one argument) | Caller is a delegate of the subject's direct administrative manager | `reporting_line` (delegate and administrative lines), `employment`, `app_user` |

### 1.2 The policies that consume them

Replaying the migrations gives, for the `ai_hr_app` policies:

- `employment_rls` (0676, rewritten by 3001 and 5054): `voided_at IS NULL AND tenant AND` (bank-import point-read
  marker arm, unchanged) `ELSE id IN (SELECT unnest((SELECT visible_employment_ids()))) OR
  can_admin_payroll_for(company_id) OR can_admin_perfcomp_for(company_id)`. The two partner checks run per row for
  every row outside the visible set.
- `person_rls` (0676): `voided_at IS NULL AND tenant AND ((SELECT is_admin()) OR id = ANY((SELECT
  visible_person_ids())::uuid[]) OR EXISTS (employment e of the person with can_admin_payroll_for or
  can_admin_perfcomp_for on e.company_id))`. The array membership is a linear probe per row, and the `EXISTS` runs both
  partner checks per employment row.
- `assignment_rls` (3102): `tenant AND employment_id IN (SELECT unnest((SELECT visible_employment_ids())))`.
- `reporting_line_rls` (0196) and `department` `tenant_isolation` (0016): **tenant only** for reads. Reporting lines and
  departments are already visible to every user of the tenant.
- Leave (`leave_request_rls`, `leave_approval_step_rls`, `leave_request_date_rls` and the other `leave_*` policies,
  0515): `employment_id = ANY((SELECT visible_employment_ids())::uuid[])`, and for request, approval step and request
  date also `OR app.can_decide_via_delegation(employment_id)` per row.
- In all, about 58 tables call `visible_employment_ids()`, 56 still name `can_see_employment` in some policy, 6 call
  `visible_person_ids()`, and 44 call `can_admin_payroll_for`.

### 1.3 Every input, and how this design treats it

The answer has three parts. The **company part** depends only on session claims and the company tree. The
**relationship part** depends on the organisation structure. The **caller part** depends on who is asking.

| Input | Read by | Treatment |
|---|---|---|
| Session tenant, user, claims (`app.tenant_id`, `app.user_id`, `app.grants`) | all | **Live**, once per statement |
| Admin scope: `hr_admin`/`super_admin` claim covering a company | `is_admin_for` (admin arm) | **Live per company** (once per tenant company per statement, as 2105 already does). It reads session claims, not `role_assignment`, so it cannot be stored per user without changing the rule (see decision 1) |
| Partner scope: `payroll_partner`, `performance_comp_partner` claims | `can_admin_payroll_for`, `can_admin_perfcomp_for` | **Live per company**, once per statement instead of per row |
| Company tree (`company.parent_company_id`, published organisation runs and mappings, Kuala Lumpur date) | `is_company_descendant` in the admin arm, the partner checks and both walks' company clamps | **Reuse 7210's `access_company_closure`** and its date window |
| Caller's person (`app_user.person_id`) and the caller's current employments (`employment.person_id`, `tenant_id`, `terminated_on IS NULL`) | self arm; seeds of both walks | **Live**, once per statement (a few rows). No archive or login-block check is applied in these arms today, and none is added |
| Administrative reporting lines (`reporting_line`: `manager_employment_id`, `subordinate_employment_id`, `line_type = 'administrative'`, `superseded_at IS NULL`, `valid_from <= current_date < valid_to`) | manager arm (recursive, depth < 64); department head qualification | **Stored** as the reporting reach (section 3), valid for a date window (section 5) |
| Employment facts inside the manager walk: `company_id` (per-path company clamp against the root's company), `terminated_on IS NULL` of every intermediate manager and subordinate | manager arm | **Stored** in the reporting reach |
| Department tree (`department.parent_department_id`, `department.company_id`), clamped to the root department's company, depth < 64 | department head arm | **Stored** as a department closure (small) |
| Department head qualification: the caller employment's current assignment department (`assignment.valid_to IS NULL AND superseded_at IS NULL`), and that the caller manages at least one current administrative line | department head arm | **Live**, once per statement for the caller's few employments |
| Subject's current department (`assignment.department_id`, current) | department head arm | **Live**, by an indexed read of current assignments in the closure's departments (section 3) |
| Delegations (`reporting_line` with `line_type = 'delegate'`, its dates, the delegator's current administrative reports) | leave policies through `can_decide_via_delegation` | **Live, once per statement** as a set (decision 3); not stored |
| Attendance final-decision window (5144 setting and token) | last arm of both readers | **Live**, unchanged |
| `employment.voided_at`, import-pending attempt | the policies' own row guards and `access_workforce_employment` | **Live** row guards, unchanged. The readers do not filter them today, and still do not |
| HR date | reporting-line dates use SQL `current_date`; the company tree uses `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date` | Section 5 |

Behaviour kept exactly, worth knowing:

- `terminated_on` is tested for presence, not against a date: an employment with a recorded future termination date
  already drops out of its managers' and department heads' views. This design reproduces that.
- `is_admin()` is true for a subtree administrator, so `person_rls` shows such an administrator every person of the
  tenant. This design reproduces that.
- The leave policies use the 0109 one-argument delegation predicate. The 0818 delegated-approval predicate is
  narrower (module scope, `hired_on`, login block, delegate not the subject, company scope). This design keeps the
  policies' predicate; aligning them would be a separate permission change.

## 2. Writers of the stored inputs

Maintenance is attached to the input tables, not to each writer, as decided for the pilot: statement-level
`AFTER INSERT OR UPDATE OR DELETE` triggers with transition tables call one named definer maintenance function per
table. PostgreSQL does not allow a column list on a trigger with transition tables, so **each function first diffs
`old_rows` against `new_rows` on the columns it reads and returns at once when none differ**. It does not touch the
tenant state or the access version in that case. This is the pilot's lesson from `access_configuration` (PR 290):
most employment writers save columns this answer never reads.

| Table | Columns that matter (anything else returns at once) | Writers found in source |
|---|---|---|
| `reporting_line` | `tenant_id`, `manager_employment_id`, `subordinate_employment_id`, `line_type`, `superseded_at`, `valid_from`, `valid_to` | `core/org.ts` (also reached from `app/delegations/actions.ts` and the employee import worker), `core/movement.ts` and the movement import, `core/movement-history.ts`, `core/direct-superior-periods.ts`, `core/hire-correction.ts`, `core/information-correction.ts` |
| `employment` | `tenant_id`, `person_id`, `company_id`, `terminated_on` (insert and delete always) | insert and termination: `core/org.ts`, `core/rehire.ts`, `core/employee-import-worker.ts`; company change: `core/information-correction.ts`, `core/movement-history.ts`, `core/movement.ts`; SQL: 0279, 0676, 5010, 5012. About fifteen other writers (`attendance-card`, `payroll-policy`, `employment-payment-method`, `roster`, `shift-arrangement`, …) update other columns and must return at once |
| `department` | `tenant_id`, `company_id`, `parent_department_id` | `core/admin.ts`, `db/seed.ts`, 0030, 5070 |
| `company`, `company_organisation_run`, `company_organisation_mapping` | as 7210 | as 7210. The reporting reach and the department closure are recomputed after 7210 refreshes the company closure |
| `assignment`, `app_user` | none | Read live at statement time, so their writers (`core/movement*.ts`, `core/hire*.ts`, `core/org.ts`, invitation and enrolment functions, …) need no maintenance at all |

The rebuild check (section 7) catches anything a trigger misses.

## 3. Schema

All tables are owned by `ai_hr_owner` and created by the migration applying as that role.

- `access_reporting_reach (tenant_id, root_employment_id, subject_employment_id, access_version)`, primary key
  `(root_employment_id, subject_employment_id)`, index `(subject_employment_id)`: for every non-terminated employment
  that manages at least one current administrative line, every employment `app.is_admin_report_of(subject, root)`
  admits, computed with the same recursive walk (per-path company clamp against the root's company, terminated
  intermediates and subordinates excluded, depth < 64, `UNION` semantics so several current managers are handled).
  Foreign keys cascade from `employment`.
- `access_department_closure (tenant_id, ancestor_department_id, descendant_department_id)`, primary key
  `(ancestor_department_id, descendant_department_id)`: each department with itself and every descendant admitted by
  `heads_department_of`'s walk (child's company descends from the ancestor's company, depth < 64).
- `access_employment_state (tenant_id primary key, access_version bigint, computed_for date, valid_until date, trusted
  boolean, last_verified_at, last_difference_count)`: one row per tenant.
- `access_employment_precompute_control (singleton, mode)`, `legacy`, `shadow` or `precomputed`, installation wide.
- A partial index `assignment (tenant_id, department_id) WHERE valid_to IS NULL AND superseded_at IS NULL AND
  department_id IS NOT NULL`. There is no index on `assignment.department_id` today. The department head read needs it,
  and so does the picker's department probe (section 9).

Keys carry no `tenant_id` because employment and department ids are unique across tenants. `tenant_id` is still a
column for row security, cascade and the per-tenant rebuild.

**Why not one row per viewer** (the ADR 0181 sketch `access_visible_employment(viewer_user_id, …)`): the admin arm reads
session claims, which a stored per-user row cannot represent, and it would cost admins × employments rows (20 × 100,000
= 2,000,000) plus a write per admin on every hire. The caller's employments and person are a few indexed rows, read
live. Keying the stored rows by employment gives one owner per fact (the organisation structure) and means a user
being linked to a person, a role grant or a claim change needs no maintenance. The family keeps the name: the reader
is `app.access_visible_employment_ids()` (section 6).

## 4. Grants and row security

- `ENABLE` and `FORCE ROW LEVEL SECURITY` on the four tenant tables, with a tenant policy and an owner policy for the
  maintenance functions, as 7210 does.
- `REVOKE ALL ... FROM PUBLIC, ai_hr_app` on all of them. The application role reads the answer only through the
  definer readers. The sources (reporting lines, departments) are already tenant-visible, so the stored rows would
  disclose nothing new, but keeping one read path keeps shadow and fallback in one place.
- Maintenance and operator functions are `SECURITY DEFINER`, `search_path=pg_catalog,public,pg_temp`, and not granted to
  `ai_hr_app`.

## 5. Maintenance, access version and the HR date

- **Serialisation and version.** As in 7210: each maintenance call that finds a real change increments
  `access_employment_state.access_version` for the tenant first. That row lock serialises maintainers of one tenant,
  and the version is written into recomputed rows.
- **Granularity of the reporting reach.** For a statement whose changes touch employments `X` (the old and new
  subordinates of changed lines, or the changed employments):
  - the affected subjects are `T = X ∪ descendants of X` over current administrative lines, ignoring clamps and
    terminations (a node outside one root's clamp can still be inside another's);
  - the affected roots are `A = X ∪ current ancestors of X ∪ the stored roots that reach any subject in T` (the last
    term covers removed paths);
  - for each root in `A`, the rows for subjects in `T` are recomputed by a walk restricted to `T ∪ ancestors of T`
    (any path from a root to a subject in `T` lies within the subject's ancestors), then written as a diff: delete
    the missing pairs, insert the new ones, leave the rest untouched.

  The cost is about (ancestors of X) × |T|, not the size of every ancestor's whole subtree. Moving one employee touches
  at most depth × 1 pairs; moving a manager with 500 reports touches about depth × 500. All of it is one set-based
  statement per triggering statement, so a 1,000-row import recomputes once.
- **Whole-tenant changes.** A company tree change (7210 recomputes the company closure) or a department tree change
  recomputes the department closure inline (thousands of rows at most). It does **not** recompute the reporting reach
  inline at group scale. It marks the tenant stale, and reads fall back until the bulk-job kernel finishes the
  recompute in chunks. This follows ADR 0181's rule for changes too large for a request.
- **HR date.** No new SQL clock. The existing rules use SQL `current_date` for reporting-line dates. The product's
  sessions run in `Asia/Kuala_Lumpur` (`lib/hr-date.ts`), so that is `todayInKualaLumpur`'s day. The company tree
  already uses `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`. The stored answer is used only when all of these
  hold:
  - `current_date = (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`. A session in another time zone always gets the
    legacy answer, so behaviour stays identical even if that assumption breaks.
  - `computed_for <= current_date < valid_until`, where `valid_until` is the earliest of: the next administrative
    `valid_from` after `computed_for`, the next administrative `valid_to` after `computed_for` (a line stops applying
    on its `valid_to` day), and 7210's company window for the tenant.

  Future-dated movements therefore never serve yesterday's tree. From the effective day the tenant falls back until the
  rebuild sweep shortly after midnight Kuala Lumpur time recomputes it. The department head qualification ("manages at
  least one current line") is read live, so it needs no window.

## 6. Read functions, policies and the fail-closed fallback

All `STABLE SECURITY DEFINER`, granted to `ai_hr_app`, evaluated once per statement as InitPlans:

- `app.access_visible_employment_ids()`: the relationship part. It returns the caller's own employments, plus the
  reach rows whose root is a current caller employment, plus the department head subjects (caller's qualified
  departments, then the department closure, then current assignments by the new index), plus the attendance window
  subject.
- `app.visible_employment_ids()` keeps its signature and sorted result. In `precomputed` mode its body becomes the
  admin arm (unchanged 2105 statement, once per company) united with `access_visible_employment_ids()`. Every one of
  the ~58 policies that use it gains without being restated, and `visible_person_ids()` stops paying for the walk a
  second time.
- `app.employment_read_companies()`: companies where `is_admin_for`, `can_admin_payroll_for` or
  `can_admin_perfcomp_for` holds, once per tenant company. `app.employment_partner_companies()` is the same without the
  admin role. Both are live in every mode: they read session claims and the company tree only, so they are equivalent
  by construction.

Modes, as decided for the pilot:

- `legacy`: the current bodies.
- `shadow`: both answers are computed and the legacy one is served. One `RAISE LOG` line per call gives the counts:
  `access_visible_employment shadow reason=<compared|untrusted|stale|outside_window|clock> missing=<n> extra=<n>
  relationship=<0|1>`. `relationship=1` means the caller had a non-empty relationship part. No tenant, user, person or
  employment values are logged. This compares the **exact set** per call, which is stronger than the pilot's row
  counts.
- `precomputed`: the stored answer when trusted, inside its window and on the Kuala Lumpur clock. Otherwise the legacy
  answer is used. The fallback is never "deny".

Policy restatements in this family (each guarded by the predecessor's exact text, as 3001, 3102 and 5054 do):

```sql
-- employment_rls USING, ELSE arm (the point-read marker arm is unchanged):
company_id = ANY ((SELECT app.employment_read_companies())::uuid[])
OR id IN (SELECT unnest((SELECT app.access_visible_employment_ids())))

-- person_rls USING:
voided_at IS NULL AND tenant_id = app.current_tenant_id() AND (
  (SELECT app.is_admin())
  OR id IN (SELECT unnest((SELECT app.access_visible_person_ids())))
  OR EXISTS (SELECT 1 FROM employment e WHERE e.person_id = person.id AND e.tenant_id = app.current_tenant_id()
             AND e.company_id = ANY ((SELECT app.employment_partner_companies())::uuid[])))
```

Why these are the old predicates:

- The admin arm of `visible_employment_ids()` is exactly "company in `is_admin_for`", so for `employment` it folds into
  the company array together with the two partner checks.
- For `person`, any admin arm implies an `hr_admin`/`super_admin` claim, so `is_admin()` already covers it. The
  remaining persons are those of the relationship part (`access_visible_person_ids()` is that set plus the caller's
  person), and the per-row partner checks become one array.
- `assignment_rls` and the leave policies keep their text and gain through the reader. For the three leave tables
  with delegation, the per-row `can_decide_via_delegation(employment_id)` becomes `employment_id IN (SELECT
  unnest((SELECT app.delegated_decision_employment_ids())))`. That is a live set: the caller's current delegate lines,
  their delegators' current direct administrative reports, delegator not terminated, the 0109 predicate exactly. It is
  a later step (section 9).

## 7. Evidence before the switch

1. **Equivalence tests** (database units, GitHub Actions). Extend the pilot fixture (70 companies in a three-level tree,
   1,000 employments) with:
   - an administrative tree of depth 8;
   - a subordinate with two current managers;
   - a report in a parent company of the manager's (clamp);
   - a terminated intermediate manager, and an employment with a future `terminated_on`;
   - a line starting tomorrow and one ending tomorrow (checked the day before and on the day);
   - a department tree of depth 5 with a cross-company child; a department head with no current reports (not
     qualified); a caller with two employments in different companies;
   - a voided employment, an import-pending employment, an open attendance window;
   - a delegate line;
   - a session in UTC between 00:00 and 08:00 Kuala Lumpur time.

   Actors: group-wide and subtree `hr_admin`, payroll partner, performance-and-compensation partner, line manager,
   department head, self-only employee, delegate. For each actor in each mode:
   - `visible_employment_ids()` and `visible_person_ids()` are identical arrays;
   - `employment`, `person`, `assignment` and `leave_request` lists and counts are identical in rows and order;
   - the two consumer statements return identical results.
2. **Maintenance tests.**
   - Each writer class (hire, termination, rehire, company transfer, line change, line dates, department move, company
     restructure, import of 1,000 movements) shows its effect in the same transaction.
   - An update of a column this answer does not read (payment method, employee code, attendance card) leaves
     `access_version` and the stored rows unchanged. This is the pilot's lesson, as a test.
3. **Staging shadow**, under the staging lease: seven days with zero unexplained differences, counting only once the
   log holds the minimum number of `reason=compared` lines (decision 5). Admins exercise mostly the unchanged admin
   arm, so the minimum is counted separately for `relationship=1` lines, and a scheduled fictional walkthrough by
   manager and department head users supplies them, as for the pilot.
4. **Scheduled rebuild and compare**, on the existing worker sweep after midnight Kuala Lumpur time and when a window
   expires. It recomputes each tenant's reach and closure from scratch, compares them, records `last_verified_at` and
   the difference count, and on any difference marks the tenant untrusted (reads fall back) until an operator
   re-trusts it (pilot decision 2).

## 8. Size bounds at group scale

Worked for a fictional group: 100,000 employments, 70 companies, 2,000 departments, average reporting depth 6 (maximum
12), average department depth 4, 20 administrators.

| Data | Rows | Approximate size |
|---|---:|---:|
| `access_reporting_reach` | Σ ancestors per employment ≈ 100,000 × 6 = 600,000. Hard ceiling 64 × employments (the existing depth cap) | ~200 bytes per row with both indexes, so ~120 MB |
| `access_department_closure` | 2,000 × 4 ≈ 8,000 | < 1 MB |
| `access_employment_state` | 1 per tenant | negligible |
| Per-viewer alternative (ADR sketch) | admin arm alone 20 × 100,000 = 2,000,000, plus every relationship row per viewer | ~400 MB+, 20 writes per hire |

Per statement:

- The caller's roots are a few rows. A line manager of 50 reads 50 index entries instead of walking.
- A non-admin at the top of a 100,000-person tree reads up to 100,000 entries, about tens of milliseconds and linear,
  instead of a 100,000-node recursive walk with a definer call per hop.
- The admin arm stays one check per company. For admins the restated `employment` and `person` policies no longer
  build a 100,000-id array at all.

Per maintenance statement: about (ancestors of the changed employments) × (their subtree), written as a diff (section
5).

## 9. First consumers and expected effect

**Admin > Organisation headcount** (`core/company-registration-readiness.ts:19`). The statement calls
`app.is_admin_for(company_id)` and `app.access_workforce_employment(id, 'workforce.view')` per employment row. Both are
company-level questions. The second runs the configurable-access chain per row, the same chain the pilot measured at
16–24 s per test pass. The fix needs no stored reach. Rewrite the statement:

- `company_id = ANY((SELECT app.access_workforce_companies('workforce.view'))::uuid[])` (7210, on main);
- an `is_admin_for` company array evaluated once;
- the import-pending condition of `access_workforce_employment` written out
  (`import_pending_attempt_id IS NULL OR = current_setting('app.import_attempt', true)`), which is stricter than the
  restrictive policy's released-attempt arm.

Even in 7210's `legacy` mode this evaluates the chain once per company (70) instead of once per employment
(thousands). It can ship first, behind its own equivalence test.

**Employee picker department options** (`core/employee-choice.ts`, `readOptions`). For populations over 25 the query
crosses every company with every department and probes current assignments per pair. There is no index on
`assignment.department_id`, and `employment`, `person` and `assignment` row security runs inside each probe. Plausible
contributors, not yet separated:

- the unindexed probe;
- the per-row partner checks in `employment_rls` and `person_rls`;
- the linear `person_rls` array probe;
- `visible_employment_ids()` being walked twice (once directly, once inside `visible_person_ids()`).

The plan is the partial assignment index, the two restatements and the reader, then re-measure. The materialized
("sparse") path may then suit every population size, and that is a consumer change to measure, not assume.

**Attribution first.** Before building, run `EXPLAIN (ANALYZE, BUFFERS)` of both statements on staging as `ai_hr_app`
(read-only transaction, the session's exact settings, a fictional admin and a fictional line manager), plus a
read-back of `pg_policy` for the tables above. This session's attempt at that read was refused by the tool permission
check, so it needs the owner's go-ahead (decision 6). The equivalence-test timing on GitHub Actions follows, as in the
pilot's section 8.

### 9.1 Attribution read on staging (24 November 2026, decision 6)

Read-only transaction as `ai_hr_app` on the fictional demo tenant (2,959 employments, 74 companies, 98 departments,
58 current administrative lines), staging at `41482ceb0` with 7210 applied, `EXPLAIN (ANALYZE, BUFFERS)`, rolled back.
The 7210 mode was reported as `legacy` at release 3's hand-back and as `shadow` by the pilot session; this read did not
check it. In `shadow`, `access_workforce_companies` computes both answers, so the PR 295 time is an upper bound. Status ladder omitted from the headcount statement in both forms.

| Statement | Group administrator | Line manager |
|---|---:|---:|
| Headcount, previous statement | 1,406 ms | |
| Headcount, PR 295 statement | 75 ms | |
| Picker department options | 6,179 ms (20.4 M buffer hits) | 6,563 ms (19.9 M) |
| `visible_employment_ids()` alone | 8 ms | 1 ms |
| `visible_person_ids()` alone | 9 ms | 1 ms |

The picker's cost is not employment visibility. For each of the 7,252 company and department pairs, the assignment
probe scans the tenant's current assignments through `assignment_no_overlap` and filters `department_id` (about 3,190
rows removed per pair), evaluating the ORed `contract_posting_assignment_read` policy
(`app.contract_shared_posting_tx_subject(employment_id)`) on each. The 7230 index addresses exactly this. On this tenant
the visibility walks are shallow and cheap; the stored reach (7240) matters for deep trees and group scale, not for
these two statements.

## 10. Owner decisions requested

1. **Store relationships by employment, keep admin scope company-level** (recommended), instead of one row per viewer
   as sketched in ADR 0181. The reason: the admin arm reads session claims, one owner per fact, and 3–4× fewer rows
   with no writes on hire per admin.
2. **Validity by a tenant window plus the Kuala Lumpur clock guard** (recommended, the pilot's approach), instead of a
   date range per row. The cost is a few minutes of fallback after midnight on days a dated line takes effect, until
   the sweep recomputes.
3. **Delegations live, once per statement, not stored** (recommended). The leave policies keep the 0109 predicate.
   Whether they should adopt 0818's narrower delegation rule is a separate permission decision, not part of this
   change.
4. **Order of delivery** (recommended):
   - (a) the headcount rewrite, needing only 7210 and an equivalence test;
   - (b) the assignment department index;
   - (c) the stored reach, closure and readers with `employment`/`person` restatements, `legacy` everywhere, `shadow`
     on staging;
   - (d) the leave delegation set after (c) is accepted.

   (c) may be built and shadowed while the company pilot is still in its shadow period: the log tags and readers are
   separate.
5. **Shadow minimum:** 20,000 `reason=compared` reader calls in seven days, of which at least 2,000 have
   `relationship=1`, with zero unexplained differences. Proposed; to be confirmed against staging traffic before the
   period starts, as for the pilot.
6. **Staging attribution read:** permission for the read-only `EXPLAIN (ANALYZE, BUFFERS)` and `pg_policy` read-back of
   section 9 on staging (aggregates and plans only, fictional demo tenant, under the staging lease).

Out of scope: the other ~55 child-table policies beyond `employment`, `person`, `assignment` and leave (they gain
through the reader without restatement); `can_admin_employment` and write policies; the cached viewer profile
(Phase 3).
