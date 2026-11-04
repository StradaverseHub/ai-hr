# ADR-0174: Company references stay inside their tenant

Status: proposed on branch `claude/wonderful-mccarthy-2fb38f`, 3 November 2026; no deployment authorized.
Staging goes through the shared staging queue separately.

## Context

A read-only replay of every journal migration on 3 November 2026 (919 policy expressions on 379 tables)
found no read or write path into another tenant's rows: every policy that calls `app.is_admin_for` pairs it
with a tenant conjunct or sits under a restrictive tenant policy. It did find three places where safety
depended on that pairing rather than on the object itself.

- `app.is_admin_for(company)` answers from grants alone. It cannot read the company row, because a root-company
  INSERT is checked before that row exists. A group-wide grant therefore says yes for any company id.
- Most company-stamped tables referenced `company(id)` alone. A tenant-A group admin could store a department
  in tenant A naming tenant B's company. Nothing of B became readable, but the row was a dangling
  cross-tenant reference. `company(id, tenant_id)` has been unique since 0313; only four tables used it.
- `app.can_admin_employment`, `app.can_admin_payroll_employment` and `app.can_admin_perfcomp_employment` are
  SECURITY DEFINER, did not pin the employment to the session tenant, and used `SET search_path = public`,
  which a session can defeat with a TEMP table (0312). `app.company_subtree` was SECURITY DEFINER, unfiltered,
  executable by PUBLIC and unused.

## Decision

The database, not the policy author, keeps a company reference inside its tenant.

1. Every tenant-scoped table with `tenant_id`, `company_id` and a `company_id → company(id)` key also carries
   `FOREIGN KEY (company_id, tenant_id) REFERENCES company (id, tenant_id)` named `<table>_company_tenant_fk`,
   with the same ON DELETE action as its existing key (2101, 148 tables). It was added NOT VALID and validated
   separately (2102), whose data check reports every offending table instead of the first. A defect stops the
   upgrade; the migration never rewrites or deletes rows. New tables of that shape must carry the key;
   `test/tenant-company-fk.test.ts` fails otherwise.
2. The three employment helpers pin `e.tenant_id = app.current_tenant_id()`, as `app.can_see_employment` has
   since 0016, and use `SET search_path = pg_catalog, public, pg_temp` with schema-qualified relations (2100).
3. `app.company_subtree` walks only the session tenant and is no longer executable by PUBLIC or `ai_hr_app`.
   A future caller must be granted EXECUTE deliberately.

`app.is_admin_for` keeps answering from grants. No column, table grant or policy changes.

## Consequences

Every INSERT, and every UPDATE of `company_id` or `tenant_id`, on those tables does one more unique-index
lookup on `company`. Writers were reviewed before the change: application writes stamp the session tenant
under RLS, company moves and reparenting stay inside one tenant, and nothing updates `company.tenant_id`.
Deleting a company behaves as before. When 2101 and 2102 install in the same run, the 2101 locks are held
until the commit: writes to those tables wait for the validation scans, reads continue.

An installation with a cross-tenant row cannot complete the upgrade until its owner reviews and resolves
that row. The error names each table and its first offending key, and the journal stays on its previous row.

`test/tenant-company-fk-upgrade.test.ts` rehearses both outcomes on a populated database at the 668-entry
boundary.

## Not covered

- Other company-referencing columns keep a plain key: `company.parent_company_id`,
  `reporting_line.scope_company_id`, `notice.owner_company_id`, `overtime_pattern.creation_company_id`,
  `overtime_pattern_version.creation_company_id` and `performance_kpi_library.group_company_id`.
- `app.can_see_employment`, `app.can_see_person` and the definer helpers they call
  (`app.is_admin_report_of`, `app.heads_department_of`), plus about forty other SECURITY DEFINER functions,
  still use `search_path = public`. Each needs the same pin, together with its callees.
- `app.is_company_descendant` is SECURITY DEFINER, executable by PUBLIC and unfiltered by tenant.
- `teras_chat.company_id` (2000) has no company key at all, so the composite rule does not reach it; adding one
  changes its retention semantics and belongs with its owner.
