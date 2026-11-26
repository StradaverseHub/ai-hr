# ADR 0181 addendum: precomputed company access pilot (Job descriptions)

Date: 24 November 2026

Status: Approved by the owner on 24 November 2026 ("Okay proceed" in the review session, and "Approve, build it" in
the build session), with decisions 1–3 of section 9 as written and decision 4 with a minimum compared-statement count
added (section 9). It is built
as migration `7210_access_effective_company`, `core/access-effective-company-check.ts`,
`scripts/access-effective-company-check.ts`, `test/access-effective-company-equivalence.test.ts` and
`test/access-effective-company-maintenance.test.ts` (shared fixture `test/access-effective-company-fixture.ts`). Built is not
installed or accepted: staging shadow evidence and the switch to `precomputed` follow separately. It applies ADR 0181
decision 1 (on PR 277, branch `claude/wonderful-pike-8d253b`) to the pilot scope the owner approved on 24 November
2026: company-level access and the Job descriptions read path. Source facts were read at main `d9db526a2`.

Two refinements made while building, within the approved decisions:

- An `access_capability` change recomputes every tenant inline instead of marking them untrusted. The catalogue is
  changed only by migrations, and recomputing keeps reads on the stored answer rather than on the fallback.
- `job_document_revision_write` is a `FOR ALL` policy, so PostgreSQL also applies it to every revision read; left
  unchanged it would keep the per-row chain on reads. It is restated once per statement with the same predicate
  (view and maintain on the job's company), and the equivalence test compares it through `SELECT ... FOR UPDATE`.
  The `job_document` insert, update and delete policies are unchanged.
- The rebuild check reports through the cron wrapper (exit code, heartbeat, journal) like the other wrapper jobs and
  does not yet write a `job_run` row. Adding it to `/admin/scheduled-actions` needs a job key and its translations,
  which is a follow-up.

## 1. What `app.access_workforce_company(company, capability)` actually depends on

The installed body is `0579_configurable_access.sql`, with plan-reuse rewrites of its helpers in 2105, 2302, 2509 and
2510 (same results). For capability `workforce.view` or `workforce.maintain` it is true when either branch holds:

- **Storage-owner branch:** no current user, the session is the storage owner, and the session's claimed grants hold
  `hr_admin` or `super_admin` covering the company.
- **User branch:** the principal snapshot is current, the user exists in the tenant, is not archived and is not login
  blocked, and some `role_assignment` of that user with role `hr_admin` or `super_admin` is claimed in the session
  for the company, its scope covers the company, and (when the capability is `supported`) the configurable-access
  allowance holds for that user, capability and company.

Every input, and how the pilot treats it:

| Input | Read by | Depends on | Pilot treatment |
|---|---|---|---|
| Session identity, tenant, claimed roles and grants (`app.user_id`, `app.tenant_id`, `app.roles`, `app.grants`) | `current_user_id`, `has_role_for`, `principal_snapshot_current` | the request | **Live**, once per statement |
| Principal snapshot (claims ⊆ actual role assignments) | `principal_snapshot_current` | `role_assignment`, `app_user` | **Live**, once per statement |
| User archived / login blocked | `login_blocked` → `login_blocked_on(user, current_date)` | `app_user`, the person's `employment` end dates and blacklisting, **`current_date`** | **Live**, once per statement (one user) |
| Storage-owner session | `access_workforce_storage_owner` | `session_user`, role membership | **Live**, once per statement |
| Admin role assignments and their company scope | the join on `role_assignment` | `role_assignment` | **Precomputed** |
| Company scope cover and company tree | `access_scope_covers` → `is_company_descendant` → `company_org_parent_for_tenant` | `company.parent_company_id`, published `company_organisation_run` + `company_organisation_mapping`, **`(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`** | **Precomputed** as a company closure, valid for a date window (section 5) |
| Capability catalogue (`supported`, `bindings`, `scope`) as the tenant sees it | `access_workforce_company` and `access_allowed_for_tenant`, through `app.access_capability_effective(tenant)` (5071) | `access_capability` (global, migration-owned), `app.access_capability_publication`, `app.access_capability_tenant_publication` (a tenant not yet published keeps the previous catalogue) | **Precomputed** |
| Tenant configuration initialised | same | `access_configuration.initialized` | **Precomputed** |
| Deny and allow overrides | same | `access_user_override` (`effect`, `company_id`, `retired_at`) | **Precomputed** |
| Group memberships and grants | same, via the `access_effective_membership` view | `access_membership`, `access_group` (`legacy_key`, `retired_at`), `access_group_grant`, `role_assignment` | **Precomputed** |

Only facts that differ per company are stored. Facts about the current user alone (snapshot, archive, login block,
claims, storage owner) are the same for every row of a statement, so evaluating them once per statement is cheap;
they stay live and keep their existing owners and clocks exactly. That is also why the login block's `current_date`
needs no stored validity: it is evaluated as today.

## 2. Writers of the precomputed inputs

Writers found in source (SQL definer functions and TypeScript), as of `d9db526a2`:

| Table | Writers |
|---|---|
| `role_assignment` | `core/admin.ts`, `db/provision.ts`, invitation consumption (0151, 0281, 0312, 5864), manual identity enrolment (0526), performance partner access (0611), Entra workforce (0899), reader/writer core (5000), recruitment (5851), fixtures |
| `access_membership`, `access_user_override` | configurable access editor (0579 commit functions), probation permission (2107) |
| `access_group`, `access_group_grant` | 0579, 2107, access editor owner presentation (3211), movement payroll protection (5773) |
| `access_configuration` | 0579, 2107, 3211, 5000, 5003, 5012 |
| `access_capability` | migrations only (0579, 2107, 5773) |
| `app.access_capability_publication`, `app.access_capability_tenant_publication` | the per-tenant capability publication (5071, `deploy/access/publish-workforce-capabilities.ts`) |
| `company` (insert, delete, `parent_company_id`) | `core/admin.ts`, `db/provision.ts`, `core/hiring-defaults.ts`, `core/company-display-group.ts`, `core/leave-approval-policy.ts`, `core/leave-team-minimum.ts`, 0030, 0324 |
| `company_organisation_run`, `company_organisation_mapping` | Company organisation tagging (2126), employee import staged job (5010) |

Because there are more than twenty writers across SQL and TypeScript, and new ones will appear, **maintenance is
attached to the tables, not to each writer**: statement-level `AFTER INSERT OR UPDATE OR DELETE` triggers (with
transition tables, column-limited where possible) on each input table call one named definer maintenance function.
Every writer, present and future, therefore maintains the access answer in its own transaction, and no writer can
forget. The rebuild check (section 7) catches anything a trigger misses, for example a capability change shipped by a
migration.

## 3. Schema

All tables are owned by `ai_hr_owner`, created by the migration applying as that role.

- `access_company_closure (tenant_id, ancestor_id, descendant_id)`, primary key `(tenant_id, ancestor_id,
  descendant_id)`: every company paired with itself and each ancestor, walked exactly as
  `company_org_descendant_for_tenant` walks (stop at a missing company, a cycle or the root).
- `access_effective_company (tenant_id, user_id, capability, company_id, roles text[], access_version)`, primary key
  `(tenant_id, user_id, capability, company_id)`: the user's admin role assignments whose scope covers the company
  and whose allowance holds, for `workforce.view` and `workforce.maintain` only. `roles` keeps which of `hr_admin` /
  `super_admin` qualify, so the live claim check can match role as well as company. Foreign keys cascade from
  `app_user` and `company`.
- `access_company_state (tenant_id primary key, access_version bigint, computed_for date, valid_until date,
  trusted boolean, last_verified_at, last_difference_count)`: one row per tenant.
- `access_precompute_control (singleton, mode)` with `mode` one of `legacy`, `shadow`, `precomputed`: installation
  wide, no tenant data.

Size is bounded by admin role holders × companies × 2, not by employees (for example 20 admins × 70 companies × 2 =
2,800 rows).

## 4. Grants and row security

- `ENABLE` and `FORCE ROW LEVEL SECURITY` on the three tenant tables, with a tenant policy
  (`tenant_id = app.current_tenant_id()`) for `ai_hr_app` and an owner policy for the definer maintenance functions.
- `REVOKE ALL ... FROM PUBLIC, ai_hr_app` on all four tables. The application role has no direct read or write: it
  reaches the answer only through the definer read function, which returns the current user's companies.
- Maintenance functions are `SECURITY DEFINER`, `search_path=pg_catalog,public,pg_temp`, revoked from `PUBLIC` and
  `ai_hr_app` (triggers call them). The operator functions (rebuild, verify, set mode, re-trust) are not granted to
  `ai_hr_app`.

## 5. Maintenance, access version and the HR date

- **Serialisation.** Every maintenance call first increments `access_company_state.access_version` for the tenant.
  That row lock serialises maintainers of one tenant; under Read Committed the recompute statements that follow see
  every earlier committer. Writers already take the exclusive Access lock first, so the lock order is unchanged. Reads
  take no lock (rule 1).
- **Granularity.** `role_assignment`, `access_membership` and `access_user_override` changes recompute the affected
  users of the tenant. `access_group`, `access_group_grant`, `access_configuration`, `company` and the organisation
  run/mapping changes recompute the tenant (closure and rows). Both are set-based statements, bounded by the size above.
  An `access_capability` change to a Workforce capability recomputes every tenant that has companies (see the
  refinement under Status).
- **Access version.** The incremented `access_version` is written into each recomputed row. It will key the cached
  viewer profile (Phase 3) and lets tests and the rebuild check prove freshness.
- **HR date.** No new SQL clock. The company tree already decides "today" with
  `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`, the SQL form of `todayInKualaLumpur` in `lib/hr-date.ts`; the
  closure is computed with that same function, and the state records `computed_for` (that day) and `valid_until`
  (the earliest published organisation run effective after it, or none). The stored answer is used only when
  `computed_for <= today < valid_until`. A future-dated restructure therefore never serves yesterday's tree: from its
  effective day the read falls back (section 6) until the rebuild job recomputes. The login block keeps its own
  `current_date`, live, exactly as today.

## 6. Read function, policies and the fail-closed fallback

`app.access_workforce_companies(capability) RETURNS uuid[]`, `STABLE SECURITY DEFINER`, granted to `ai_hr_app`,
evaluated once per statement as an InitPlan:

- `legacy` mode: the existing check once per tenant company, `array_agg` of companies where
  `app.access_workforce_company(c.id, capability)` holds. This is the proven 5076 / 7150 pattern and is identical by
  construction.
- `precomputed` mode: when the live user facts hold and the tenant state is trusted and inside its date window, the
  companies from `access_effective_company` for the current user and capability whose stored roles are claimed in the
  session for that company (claims joined to the closure). The storage-owner branch is evaluated live in every mode.
  Otherwise it returns the `legacy` answer.
- `shadow` mode: computes both, serves `legacy`, and emits one `RAISE LOG` line per statement with counts only:
  capability, missing, extra, and the reason when the stored answer was not usable (untrusted, outside window). No
  tenant, user, person or company values. `RAISE LOG` writes nothing, so it works inside the read-only shared read
  transaction.

The fallback is never "deny": it is the existing authority, evaluated per company instead of per row.

New read policies for `ai_hr_app` (plus the `FOR ALL` revision write policy, restated the same way; see Status):

```sql
job_document_read:          tenant_id = app.current_tenant_id()
                            AND company_id = ANY ((SELECT app.access_workforce_companies('workforce.view'))::uuid[])
job_document_revision_read: tenant_id = app.current_tenant_id()
                            AND EXISTS (SELECT 1 FROM job_document j
                                        WHERE j.tenant_id = job_document_revision.tenant_id
                                          AND j.id = job_document_revision.job_id
                                          AND j.company_id = ANY ((SELECT app.access_workforce_companies('workforce.view'))::uuid[]))
```

These are exactly the old predicates: `app.job_document_scope` is `p_tenant = current tenant AND EXISTS(job in
tenant whose company passes access_workforce_company(view))`. The retention policies (owner-only) and the Job
Architecture profile reader policies are untouched. The migration guards the predecessor bodies by hash, as 2510 and
7150 do.

## 7. Evidence before the switch

1. **Equivalence tests** (`test/access-effective-company-equivalence.test.ts` and, for the date window and the bypassing writer,
   `test/access-effective-company-maintenance.test.ts`; database units): a fixture of 70
   companies in a three-level tree and 1,000 employments with Job descriptions and revisions across them; actors
   covering group-wide and subtree `hr_admin`/`super_admin`, a non-admin, a configurable-access deny on a subtree,
   an allow override, a group grant, a retired override, an archived user, a login-blocked user (employment ended
   yesterday), a stale session claim narrower than the actual grant, and a future-dated published restructure
   (checked the day before and on the effective day). For each actor, under "All companies" and one company, the old
   policies and the new policies in each mode return identical rows, order and counts for the list, its count and the
   revision history, plus a test that each trigger-maintained change is visible in the same transaction.
2. **Staging shadow comparison:** staging runs `shadow` under the staging lease for seven days with zero
   unexplained differences in the logged counts, and the period counts only once it holds the minimum number of
   compared statements per capability (decision 4). Count them from the database log:
   `grep -c 'access_effective_company shadow capability=workforce.view .* reason=compared'` (and the same for
   `workforce.maintain`), and sum `missing=` and `extra=` over the same lines.
3. **Scheduled rebuild-and-compare:** a worker sweep recomputes each tenant from scratch into a temporary set, compares
   it with the maintained rows, records `last_verified_at` and the difference count, and on any difference marks the
   tenant untrusted (reads fall back) and logs an alert with counts only. It also recomputes tenants whose date window
   has passed. It runs on the existing worker sweep shortly after midnight Kuala Lumpur time and when a window expires.

## 8. Measured in the equivalence test

The draft of this section expected the once-per-company `legacy` form to remove most of the per-row cost. The
equivalence test on GitHub Actions (fictional fixture: 70 companies, 1,000 employments, 140 documents, 280 revisions)
showed otherwise. One pass of 24 observations (12 actors, "All companies" and one company: list, count, revisions,
locked revisions, two pages with totals, document read) took about 16–24 s under the previous policies, about the same
in `legacy` and `shadow`, and about 0.4–0.5 s in `precomputed`. When the stored answer is unusable (outside its date
window, or untrusted) `precomputed` takes the `legacy` time, as designed. So the stored answer is what removes the
cost; the per-company form is only the safe fallback. Staging measurements, including plan time
(`pg_stat_statements` `mean_plan_time` and `total_plan_time`) as well as execution time, follow when the pilot is
installed there.

## 9. Owner decisions (approved 24 November 2026)

1. **Maintenance by table triggers** (recommended) rather than calls added to each writer.
2. **After a rebuild difference** the tenant stays on the fallback until an operator re-trusts it after the cause is
   fixed (recommended), rather than repairing itself automatically, which would hide a missed writer.
3. **Mode per installation:** `legacy` on production and on install by default; `shadow` on staging from its next
   release; `precomputed` only after acceptance, by a separate request.
4. **Shadow period:** seven days of staging traffic with zero unexplained differences, which counts only once the
   shadow log holds a minimum number of compared statements (`reason=compared` lines) for each capability,
   `workforce.view` and `workforce.maintain`, inside those seven days. Approved with the minimum added; the figure is
   proposed in the pilot's pull request from staging's request timing and confirmed by the owner before the period
   starts.

Out of scope until the pilot is accepted: `access_visible_employment` and the employment, person, reporting line and
leave families; the Job descriptions write, review, attachment and audit policies; the cached viewer profile.
