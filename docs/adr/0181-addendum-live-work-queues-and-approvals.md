# ADR 0181 addendum: live work queues and approval reads

Date: 25 November 2026

Status: **Approved by the owner on 25 November 2026** ("Approve as recommended"): all six decisions of section 8 as
written. Nothing in it is built yet. No migration is reserved: each migration-bearing step takes the
next free number at build time from `node .github/ci/check-migration-collisions.mjs --local --next` (currently 7320 or
above) and is recorded in `docs/MIGRATION-ALLOCATION.md`. ADR 0181 Phase 3 (PR 302) deliberately left these reads
uncached; this addendum makes them cheap instead. It applies ADR 0181 decisions 1 and 5 (per-row authority, per-row loops)
to the work queues and approval reads that run on every signed-in page, on Home (Admin, Manager and Employee Today, all
at `/`) and on Approvals. It follows the risk reductions the owner asked for in the payroll addendum
([0181 payroll addendum](0181-addendum-payroll-read-access-and-read-model.md), section 11): installing changes nothing,
each step has its own switch, and fallback is never "deny".

Source facts were read at alpha `f2fbfdbd6` (staging release 6 with 7245 and 7250). Installed policy and function
metadata was read back from the staging catalogue as the application role, read only. Staging figures use fictional
demo data. Installation-specific production figures are not repeated here.

## 1. Where the time goes (staging, fictional data)

`pg_stat_statements` from 24 November 15:42 to 25 November 09:17 (+08), read as `ai_hr_app` in a read-only session,
aggregates only. The statistics count top-level statements only (`track = top`), so a definer function's inner
planning is inside its execution time.

| Statement (caller) | Calls | Execution mean | Planning mean | 24 Nov first read |
|---|---:|---:|---:|---|
| `app.offboarding_posting_queue_access()` (frame, every page) | 227 | 428 ms | — | 141 ms |
| `app.contract_shared_navigation_access()` (frame menu) | 227 | 174 ms | — | 194 ms |
| `app.contract_shared_work_page(...)` (frame bell, Home, Approvals) | 298 | 120 ms | — | 280 ms |
| `app.contract_shared_posting_work_page(...)` (frame bell) | 227 | 124 ms | — | 154 ms |
| `app.probation_navigation_access()` + `app.probation_access_navigation()` (frame menu) | 227 | 43 ms | — | 107 ms |
| `app.probation_task_list(text, integer)` (frame bell, Home, Approvals) | 260 | 25 ms | — | 103 ms |
| Account task statement, `task_caller` (frame bell, Home), three shapes | 197 / 30 / 4 | 343 / 332 / 278 ms | 156 / 391 / 291 ms | 513 / 555 ms |
| Recruitment approval steps, `packs/recruitment/tasks.ts` (frame bell) | 12 | 0.9 ms | 316 ms | 290 ms |

Request timing (`[aihr-timing]` window lines, page GETs over the same period):

| Route | Renders | Mean | Database | Transactions per render | Over 1 s |
|---|---:|---:|---:|---:|---:|
| `/` (Home and Today) | 54 (16 under 100 ms) | 1,652 ms | 1,591 ms | 23.2 | 37 |
| `/approvals` | 29 | 2,274 ms | 2,181 ms | 45.4 | 29 |

The frame's queue and menu functions add about 0.9 s of database work to every signed-in page. The account task
statement adds about 0.5 s more on Home and in the bell. The sampled `auto_explain` (5%, statements of 500 ms or more,
nested statements on) confirms where the time inside them goes. In `offboarding_posting_queue_access` it is the posting
and company `EXISTS`. In `contract_shared_work_page` it is the assigned-work CTE. In the account task statement,
the most-looped relations are `employment`, `person`, `notice` and `leave_approval_step`.

Two numbers moved since the first read. `contract_shared_work_page` and `probation_task_list` got cheaper, through
Phase 1's warm connections and a lighter mix of users. `offboarding_posting_queue_access` got dearer, because its
cost grows with the number of users and postings in the tenant (section 2.1). The recruitment statement's 316 ms
planning comes from 12 calls. Its source header measured 1.6–2.4 ms warm and 10–15 ms on a fresh backend, so cold
backends are the likely cause. Section 7 asks for one attribution read to confirm it.

### 1.1 Attribution read (step 0, 25 November 2026)

This was owner decision 6. The read was read-only and rolled back, run while the staging lease was free. It used the demo
tenant's own fictional administrator, manager and employee claims, and printed timings and counts only.

The demo tenant has:

- 24 users, 74 companies and 2,959 employments;
- no offboarding postings and no probation cases;
- no contract approvals or letters.

Warm timings per call:

| Read | Administrator | Manager | Employee |
|---|---:|---:|---:|
| `offboarding_posting_queue_access()` | 103 ms | 104 ms | 106 ms |
| of which: `offboarding_posting_ops` over the 74 companies | 21 ms | 20 ms | 22 ms |
| `contract_shared_navigation_access()` | 41 ms | 177 ms | 177 ms |
| of which: `automation_can_configure('contract_staff')` | 2 ms | 134 ms | 135 ms |
| `contract_shared_work_page('all', 20)`, no work | 47 ms | 38 ms | 39 ms |
| `contract_shared_posting_work_page`, no postings | 26 ms | 27 ms | 26 ms |
| `probation_navigation_access()` / `probation_task_list(NULL, 200)`, no cases | 3 / 5 ms | 2 / 4 ms | 2 / 4 ms |

What this shows:

- The offboarding cost is a floor of about 0.1 s per page for everyone, even with no posting to review. It comes from the
  per-company arms, which repeat the principal, admin and Workforce checks for each company. The scan of the group's
  members is only 1 ms with 24 users, but it grows with every user. The 428 ms `pg_stat_statements` mean is that floor
  plus concurrency and cold backends.
- Contract navigation costs a non-administrator about 0.18 s, three quarters of it in the per-company permission checks.
- Recruitment: `count(*)` over `recruitment_application` as the application role planned in 64.6 ms on a fresh backend
  and 0.29 ms on the next call. Joined to `recruitment_candidate`, it took 41.6 ms and then 1.1 ms. The 316 ms mean
  is a cold-backend effect, so step Q2a matters less than Q1.

## 2. What these reads actually evaluate

### 2.1 `app.offboarding_posting_queue_access()` (6302)

The function is `LANGUAGE sql SECURITY DEFINER` with `SET`, so it is never inlined and is re-planned on every call. It
answers "may this user open the offboarding posting queue".

- It calls `app.personnel_posting_visible(group, employment, source)` once per offboarding posting of the tenant, in
  every status.
- It then calls `app.offboarding_posting_ops(company)` and `app.offboarding_posting_group(company, group)` once per
  company.
- Each of those calls `app.offboarding_posting_group_members(group)`. That function reads **every active user of the
  tenant**, with `app.login_blocked(user)` per user, only to test whether the current user is in one group. Each of
  them also repeats `app.principal_snapshot_current()`.
- The cost is therefore about (postings + companies) × tenant users `login_blocked` calls, for every user on every page.
  An ordinary employee pays it in full, because `ops` stops at `is_admin_for` but `group` does not stop.

### 2.2 `app.contract_shared_navigation_access()` (6432)

`LANGUAGE sql SECURITY DEFINER` with `SET`. It answers five menu booleans.

- Per company, it calls `contract_company_entitled`, `contract_configure` and `contract_gbs_company_scope`.
- `app.automation_can_configure('contract_staff')` calls `contract_shared_permitted` up to three times per company. Each
  call repeats `contract_verified_human` (and so `login_blocked`), entitlement and `contract_hr_admin`'s ancestry walk.
- The set-based parts (`contract_shared_tracker_company_scope`, the configuration scope, the posting scope, managed
  subjects) run once each.

### 2.3 `app.contract_shared_work_page(...)` and `app.contract_shared_posting_work_page(...)` (6373, 6415, 6416, 6365)

- **Neither function asks company or employment visibility.** Their authority is "this actor holds the step": signing
  assignments, step holders, `lc_v9_config` group members, the subject person.
- In `contract_shared_work_page`:
  - The email arm calls `app.contract_shared_current_email_documents(tenant)`, which scans every email letter of the
    tenant before it is joined to the actor's candidates.
  - The group arm expands the `assignments` JSON of every `contract_shared_approval` in the tenant.
  - Each case recomputes a sha256 period hash, and each document calls the step JSON helpers once (definer with `SET`, so
    not inlined).
  - `contract_verified_human` is evaluated 4–6 times per call.
- The frame bell calls it with `all`, Home with `tasks`, and Approvals with `approvals`. One page therefore computes
  the same assigned set two or three times.
- `contract_shared_posting_work_page` is already set-based: its scope runs once per statement. Its remaining cost is the
  scan of every contract-staff posting.

### 2.4 Probation (`2252`, `5763`, `6687`)

- **`probation_navigation_access`, `participant`:** it runs `EXISTS(probation_case WHERE probation_case_access(id))`.
  That calls the whole of `probation_visible_among(ARRAY[case])` once per case, and stops only at a visible case. A user
  who sees no case, which is most employees, pays for every case in the tenant.
- **`intake`, for PBP/GBS opt-in users:** it calls `probation_role(employment, 'pbp'|'gbs')` per employment of each
  covered company. That is about three holder resolutions per employee.
- **`probation_task_list`:**
  - It computes `probation_visible_among(NULL)` once, then resolves the same holders a second time through
    `probation_holders_set`.
  - It calls `probation_commands(part)` per candidate (up to 200). Each call repeats visibility 4–5 times and holder
    resolution 5–8 times.
  - It calls `probation_letter_tasks(case)` per visible case with an unreleased letter, with no cap.
- `probation_access_navigation` is already set-based and cheap.
- Callers: the frame bell calls `probation_task_list(NULL, 200)`, Home calls it again, and Approvals calls it a third
  time with `'approval'`. On `/tasks` the menu reads `probationNavigationAccess` twice (layout and page).

### 2.5 The account task statement (`core/account-task-bundle.ts`)

- It is one statement with 14 scalar sections (leave, cancellations, resignations, reviews, replacement, attendance,
  profile, notices, performance, rewards, claims, feedback, onboarding).
- Its cost is row security copied many times:
  - For a manager with every module on, the plan holds about 30 copies of the `employment` policies and about 8 of
    `person`. `person_rls`, notices, feedback and performance nest further `EXISTS` over `employment`.
  - Each `employment` copy carries the `visible_employment_ids()` InitPlan and its hashed SubPlan twice (once per arm
    of the 7245 `CASE`).
  - Each copy also carries per-row `is_admin_for`, `can_admin_payroll_for` and `can_admin_perfcomp_for`, and two more
    per-row policies: `employment_agent_read` (`app.current_agent_principal() IS NOT NULL`, not wrapped as an InitPlan)
    and `contract_posting_employment_read` (`app.contract_shared_posting_tx_subject(id)`, a `LANGUAGE sql` definer with
    `SET` probing `contract_shared_posting_tx` per row).
- Two sections ignore the caller's `own` employments, replacement and claims, and re-read `employment` for them. The
  manager and HR review sections read `employment_review` twice.

### 2.6 Recruitment policies

`recruitment_application` has 9 permissive policies that apply to `SELECT` for every role, and no restrictive ones.

- **7 are owner-only.** Each has the shape `current_user = pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid =
  '<table>'::regclass)) AND <context>`, with roles `public`. For `ai_hr_app` they are always false, but every one is
  still planned, each with a `pg_class` InitPlan and a definer call.
- **`recruitment_application_admin` (`FOR ALL`) adds nothing to reads.** Every row it admits is also admitted by
  `recruitment_application_team_read`. The chain is `can_admin_recruitment_for` ⇒ `can_review_recruitment_job` ⇒
  `can_read_recruitment_application`, under the same tenant test, and none of these functions returns NULL.
- **The pattern is schema-wide.** The staging catalogue has 239 owner-shaped policies with roles `public`, on 97 tables:
  `recruitment_*` and `letter_request` lead with 6–7 each.
- `ai_hr_app` is not a member of `ai_hr_owner` (checked on staging).

Other `FOR ALL` policies whose `SELECT` side is subsumed by a read policy on the same table:

- `review_cycle_write`, because `review_cycle_read` is tenant only.
- `recruitment_job_agency_contract_write`.
- `recruitment_export_template_admin`.

## 3. Why this addendum does not add new stored access tables

The task as briefed was to extend precomputed access (7210 company, 7240 employment visibility) to the recruitment,
contract-management, probation and offboarding families. The source shows that it mostly does not fit:

- **Different authority relations.**
  - 7210 stores `workforce.view` and `workforce.maintain` only. It returns `{}` for any other capability.
  - Contract authority is `contract_role_assignment`, `contract_access_member`, `lc_*_config` groups and raw
    `parent_company_id` walks.
  - Probation authority is live holders (line manager, routed HOD and PBP, group members), probation access roles, GBS
    mappings and delegations.
  - Recruitment authority is job roles and recruiting partners.
- **7240 would widen or narrow these answers.** It stores the transitive administrative reach plus department heads.
  Contract "managed subjects" are direct reports only. Probation uses the direct line manager and the routed or
  department head. Neither is a subset of 7240's answer.
- **Three ancestry meanings coexist:**
  - raw `parent_company_id` (contract tracker, configuration and posting scopes);
  - organisation-mapping-aware `is_company_descendant` (`contract_hr_admin`, `access_scope_covers`, probation);
  - session claims (`is_admin_for`).

  Moving any of them onto one closure changes answers.
- **Stored answers would need large maintenance.** Each would need its own maintained table with 15–25 input tables:
  probation holders alone read employment, assignment, position, department, reporting lines, `lc_v9_config`, routing
  versions, business partner rules, probation access, delegates and login blocks. They also depend on two clocks
  (`current_date` and the Kuala Lumpur HR date). Every writer of those tables would gain a maintenance obligation.

The measured cost does not come from a missing stored answer. It comes from **per-row and per-company calls of definer
helpers, the same facts recomputed many times per statement, the same reader called two or three times per page, and
policies planned for roles they can never admit**. All of these can be removed by restating the same rules once per
statement, which adds no new owner of any fact and no writer obligation. 7210 is reused exactly where it already
answers the question (section 4, step Q1).

If the after-measurement (section 7) still misses the targets, stored module answers can be designed then, family by
family, with the evidence of which part remains.

## 4. Design

Four steps. Each is proven, installed and switched on its own.

### Q0. Read each queue once per request (no migration)

- **Contract work page.** Inside a page render, the frame bell and Home's Contract slot share one owner read: the first
  page of every category, at the owner's largest limit (100), with no company filter. It is shared through
  `lib/request-memo.ts` in the render's read scope.
  - An `all` page inside that page is its slice. Any category page is the filtered slice when the shared page holds
    every item. Otherwise the caller reads the owner itself.
  - Approvals filters by company, and the items carry no company, so it still reads the owner. Step Q1 adds the company to
    the set so that Approvals can share it too.
- **Probation task list.** The frame bell and Approvals share one `probation_task_list(NULL, 200)` read. Each derives its
  category when that read holds every task (`count` equals the items returned), and otherwise reads the owner. Home
  reads its tasks from `/api/home/tasks`, a separate request, so it is not shared.
- **Navigation.** `lifecycleModuleNavigation` is memoised per request, so `/tasks` reads it once.
- **Account task statement:**
  - Pass `own` to the replacement and claims sections, as the other sections do. This is equivalent by the argument
    already recorded at `core/approvals.ts:137-141`.
  - A review stage in which the caller can decide nothing returns its empty array without reading the headers: the HR
    stage for a non-administrator, and the manager stage for a non-administrator with no person. This is exactly what
    the aggregate returns when every row is filtered out. It replaces the merged review read first proposed, which
    would change more SQL for the same saving.
- **Proof:** the derived pages and counts must equal the old per-caller calls for every category, company filter, limit
  and offset under the cap, for every actor of the fixture (section 5).

### Q1. Set-based queue and menu functions (migration, inert on install)

For each function below, the migration:

- renames the current body to `<name>_legacy` (guarded by its exact source hash, as 2252, 6432 and 7150 do);
- adds `<name>_v2` with the same rules evaluated once per statement;
- puts a small dispatcher at the original name and signature.

The dispatcher reads a per-function mode from `app.queue_read_control` (installation-wide, no tenant data). In `legacy`
it calls the old body. In `v2` it calls the new one. In `shadow` it calls both, serves `legacy`, and emits one
`RAISE LOG` per call with counts only: `queue_read shadow fn=<name> reason=compared differs=<0|1>`, and for page
functions `missing=<n> extra=<n>`. Every mode starts as `legacy`, so installing changes nothing but one indexed control
read.

1. **`offboarding_posting_queue_access_v2`:**
   - `principal_snapshot_current()` once.
   - Membership as a single-user test: an indexed probe of the current `app_user` (tenant, not archived, not login
     blocked) inside the group JSON, read from `coalesce(lc_onboarding_config.groups, lc_v9_config.groups)` as today.
     It runs once per distinct group, instead of a scan of every user.
   - The admin companies once (`is_admin_for` over the tenant's companies, as `visible_employment_ids()` already does).
     The `workforce.maintain` companies from 7210's `app.access_workforce_companies('workforce.maintain')`, which equals
     `access_workforce_company(c, 'workforce.maintain')` per company in every mode (its own fallback is the per-company
     legacy check).
   - The posting arm grouped by distinct (company, approver group), plus the per-row self exclusion on the person.
   - Kept exactly: every posting status counts; the self test is on the person; `login_blocked` uses `current_date`;
     `is_admin_for` reads session claims.
2. **`contract_shared_navigation_access_v2`:**
   - Actor facts once: verified human, active user, roles held, contract access memberships, people-ops and group
     memberships.
   - One company set with entitlement, writability, `contract_hr_admin` and member permissions.
   - `intake`, `configure` and the `contract_staff` automation arm as `EXISTS` over that set, instead of three
     `contract_shared_permitted` calls per company.
   - Each ancestry walk keeps its own meaning: raw parent walks stay raw. `contract_hr_admin`'s `is_company_descendant`
     may read 7210's `access_company_closure` only when `app.access_effective_company_unusable()` is null, and walks
     as today otherwise.
   - The 6432 named-role clause is kept word for word.
3. **`contract_shared_work_page` source:**
   - `contract_shared_current_email_documents` takes the actor's candidate letter ids, so it no longer scans every email
     letter of the tenant.
   - The group arm reads only approvals whose `assignments` name one of the actor's groups. It uses an expression index on
     the group ids, or a generated array column if the index cannot express it.
   - `contract_verified_human(current_user)` once.
   - Kept exactly: the per-path archived-company rules (6415), `DISTINCT ON (kind, subject_id)` with its order, and the
     per-step `eligible`.
4. **`probation_navigation_access_v2`:**
   - `participant` becomes `EXISTS(SELECT 1 FROM app.probation_visible_among(NULL))`. This is exact, because every CTE
     of `visible_among` decides each case on its own. It is skipped when `configure` is already true, since the caller
     only needs `page = configure OR participant`.
   - `intake` uses one `probation_routed_holders` over the employments of the covered companies (testing `pbp_users`)
     plus the set-based GBS cover `visible_among` already uses.
   - Kept exactly: false for a non-entitled company; group members count for PBP; every employment of the company,
     with no status filter.
   - The 2252 guard on the predecessor is moved deliberately to the legacy body.
5. **`probation_task_list_v2`:**
   - Visibility returns its holder rows once, and both the visible set and the candidates use them.
   - `probation_commands` is split into an inner `probation_commands_for(part, case, holders, roles, route)` that both
     the public function and the task list call, so a listed task is still exactly a command the case view offers (5751).
   - Kept exactly:
     - candidates test the single `pbp` / `hod` holder, not `pbp_users` / `hod_users`;
     - line-manager visibility uses `superior_rule.can_view`, and the line-manager role uses `superior_rule.enabled`;
     - a person with more than one usable login holds no role;
     - `count` and `capped` keep their current meaning.
   - The letter pre-filter (calling `probation_letter_tasks` only for cases where the caller could hold a task) is
     **not** in this step. It must first be proven a superset of the live route resolution (`resolve_route_unchecked`
     moves steps through delegates). It follows as Q1b only with that proof.

**Language rule (the release 6 lesson).** Every new or restated hot read-path function is `LANGUAGE plpgsql STABLE
SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp`, so each inner statement keeps its plan for the life of the
connection. `LANGUAGE sql` with `SECURITY DEFINER` and `SET` is never inlined and re-plans every call. It is used only
where planning is negligible and the function is not called per row. A database unit test fails the build if a
migration from this addendum creates a function on the hot-reader list with that combination. 7245 showed that plan
reuse alone does not fix a bad join order (section 6), so it is a requirement, not the remedy.

### Q2. Policies planned only for the roles they can admit (migration, operator-applied)

These are identical by construction. The migration installs only the operator functions
`app.queue_policy_apply(step)` and `app.queue_policy_revert(step)`: definer functions owned by `ai_hr_owner`, not granted
to `ai_hr_app`. Each guards the exact current text and roles of every policy it touches, then changes them in one
transaction. Revert restores the recorded text. Nothing changes until the operator applies a step under the staging
lease.

- **Q2a, recruitment.** On every `recruitment_*` policy of the owner-only shape (`current_user =
  pg_get_userbyid(relowner)`), set `TO <that table's owner>` and keep the qual unchanged.
  - Why it is exact: PostgreSQL applies a policy only to members of its roles. A user who is not the owner never
    satisfied `current_user = owner`. A member of the owner role who is not the owner still meets the unchanged qual,
    which stays false for it.
  - Split `recruitment_application_admin`, `recruitment_job_agency_contract_write` and
    `recruitment_export_template_admin` from `FOR ALL` into `INSERT`, `UPDATE` and `DELETE` policies with the same
    `USING` and `WITH CHECK`, because their `SELECT` side is subsumed (section 2.6).
  - The `FOR ALL` admin policy on `recruitment_application_event` is left alone: its subsumption by
    `recruitment_application_event_team` holds only through a foreign key and another table's policies.
  - For `ai_hr_app`, `recruitment_application` goes from 9 planned read policies to 1. The approval steps statement
    loses 13 owner-only copies.
- **Q2b, every other owner-shaped policy.** The same change on the remaining tables (239 in all on staging, 97 tables,
  owner read per table from `pg_class.relowner`). `review_cycle_write` is split as in Q2a.
- **Q2c, statement-level forms on `employment`, `assignment` and `notice`.** These are the hottest tables, so this step
  is separate and last.
  - `employment_agent_read`: `(SELECT app.current_agent_principal()) IS NOT NULL`, evaluated once per statement instead
    of per row.
  - `contract_posting_employment_read` and `contract_posting_assignment_read`: `id IN (SELECT unnest((SELECT
    app.contract_shared_posting_tx_subjects())))`. This is a new PL/pgSQL definer returning the transaction's posting
    subjects once per statement, with the same tenant, transaction, backend, login and actor tests as
    `contract_shared_posting_tx_subject`.
  - `notice_admin_rls`: `(SELECT app.is_group_admin())`.
  - Why it is exact: each function is `STABLE`, so its answer is fixed within a statement, and the subjects read is the
    same table under the same snapshot.
  - Q2c must pass the consumer scale tests of section 5 before it is applied. 7245 shows that an equal predicate can
    still change join order.

### Q3. Deferred: stored module answers

Not proposed now (section 3). Revisited only with after-measurement evidence that Q0–Q2 leave a family over its target.

## 5. Evidence before any switch

The same three proofs as 7210 and 7240, adapted to steps that store nothing:

1. **Equivalence tests** (database units on GitHub Actions, `alpha-focused-checks.yml`). The shared 70-company,
   1,000-employment fixture (`test/access-effective-company-fixture.ts`) is extended with:
   - contract shared cases, approvals with group and person assignments, email and routing letters, and contract-staff
     postings;
   - probation cases with direct, routed and group-held PBP/HOD, delegates, GBS mappings, letters in each state and
     a pending escalation;
   - offboarding postings in every status with approver groups;
   - recruitment jobs, applications, interviews, offers, requisitions, screening and background checks;
   - account-task rows for every section.

   Actors:
   - group-wide and subtree `hr_admin` / `super_admin`;
   - payroll, performance and recruiting partners;
   - contract PBP and GBS;
   - probation access roles, People Ops and posting-approver group members;
   - a manager, a department head, a delegate and an employee;
   - a login-blocked user, an archived user and a stale session claim.

   Under "All companies" and one company, each function must return identical JSON (rows, order, counts, `capped`) in
   `legacy`, `shadow` and `v2`. The Q0 derived pages must equal the per-caller calls. For Q2, the affected reads (the
   recruitment to-dos and names, recruitment lists, the account task statement, Approvals) must return identical rows,
   order and counts before and after `apply`, and again after `revert`.
2. **Shadow comparison on staging** (Q1). Each function runs in `shadow` for seven days of staging traffic, with zero
   `differs=1` lines and at least the owner-confirmed minimum of `reason=compared` lines per function.
3. **Full comparison job, in place of the rebuild check.** Q0–Q2 store nothing, so there is nothing to rebuild. A
   read-only job, run after install and nightly during shadow, compares the Q1 answers under `legacy` and `v2` for
   **every user of the tenant**, not only for those who visit. It reports differences by function, as counts only. A
   difference sets that function back to `legacy` on that installation and alerts. An operator re-enables it after the
   cause is fixed (7210 decision 2).

Performance evidence, before any staging install:

- Planning and execution on the fixture with `EXPLAIN (ANALYZE, SUMMARY, BUFFERS)`, warm and on a fresh backend, for
  each function and for the account task and recruitment statements.
- **Consumer scale tests no slower** (the 7245 lesson): Transaction View History
  (`test/transaction-view-history-scale-db.test.ts`), the Personnel list and the Approvals page, before and after each
  Q2 step.
- **No save cost.** Q0–Q2 add no trigger and no maintenance. A test asserts that no new trigger exists on any input table.

**Targets** (staging timing logs, before and after):

- the frame's queue and menu functions under 100 ms together per render (from about 0.9 s);
- the account task statement under 150 ms, planning included (from about 0.5 s);
- Home and Approvals p95 under 1 s (ADR 0181 decision 8).

## 6. Risks and how each is held

- **A restated function differs in a corner case.** Q1 keeps the legacy body, and the dispatcher switches back in one
  update. Equivalence covers the behaviours listed as "kept exactly". Shadow and the full comparison look for unknown
  ones.
- **A policy change alters a plan for the worse.** Q2 steps are applied by an operator and reverted in seconds.
  Consumer scale tests gate each step. Q2c, on the hottest tables, goes last.
- **A request-scoped read leaks across identities.** The request read scope already refuses another identity
  (ADR 0181 decision 2). Derived pages are computed from the same caller's answer only.
- **Clock and ancestry drift.** No step changes a clock or an ancestry meaning. 7210's closure is read only where the
  walk is the same organisation-mapping walk, and only while 7210 reports it usable.

## 7. Order of work

| Step | What | Schema | Switch |
|---|---|---|---|
| 0 | One read-only attribution read on staging as a fictional admin, manager and employee: `EXPLAIN (ANALYZE, SUMMARY, BUFFERS)` of each statement in section 1, warm and fresh backend, rolled back, plans and timings only (decision 6) | No | — |
| 1 | Q0: once per request; account task `own` and the review merge | No | — |
| 2 | Q1: offboarding access, contract navigation, contract work page source | next free | Inert, per function |
| 3 | Q1: probation navigation and task list | next free | Inert, per function |
| 4 | Q2a: recruitment policies | next free | Operator apply |
| 5 | Q2b: remaining owner-shaped policies, `review_cycle_write` | next free | Operator apply |
| 6 | Q2c: `employment`, `assignment`, `notice` statement-level forms | next free | Operator apply |
| 7 | Staging after-measurement for Home, Today (`/` as manager and employee) and Approvals; close matching findings (AP-004, AP-007, AP-029) in `docs/ARCHITECTURE-PERFORMANCE-REMEDIATION.md` only with that evidence | No | — |

Each step ships as its own PR with green `alpha-focused-checks.yml`. It goes to staging only with the owner's go-ahead,
through the shared staging queue (coordinator "ORCHESTRATOR"). Production follows only by a separate explicit request.

## 8. Owner decisions

Approved on 25 November 2026 ("Approve as recommended"), all six as written below. Each staging release and each
switch from `legacy` still needs its own go-ahead; production needs a separate explicit request.

1. **Approach.** Restate these families' rules once per statement and plan policies only for the roles they can admit,
   instead of new stored access tables (section 3). Stored module answers are reconsidered only if the
   after-measurement misses its target. *Recommended.*
2. **Install inert, one switch per function (Q1) and per policy step (Q2),** as payroll 11.1–11.3. *Recommended.*
3. **Q2 scope:** recruitment first (Q2a), then all remaining owner-shaped policies in one step (Q2b), then the hot-table
   forms last (Q2c). *Recommended.* The alternative is recruitment only.
4. **Shadow period:** seven days, with a minimum of compared calls per function proposed from staging traffic in the
   Q1 PR and confirmed by the owner before the period starts (as 7210 decision 4).
5. **Q0 ships first.** It has no migration. Its staging release goes through the queue with the owner's go-ahead.
6. **The staging attribution read in step 0:** read only, rolled back, fictional accounts, plans and timings only, under
   the staging lease. It confirms the 428 ms offboarding cost and whether the recruitment planning is a cold-backend
   effect.
