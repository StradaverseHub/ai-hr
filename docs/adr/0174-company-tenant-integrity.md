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

## Follow-up: 2500–2502 (4–6 November 2026)

Proposed on branch `claude/pensive-hofstadter-d1bf14`; no deployment authorized. First numbered 2120–2123, then
2150–2153, then 2240–2242, then 2400–2402. Each time the combined release on main and staging rose above the
block. It now sits above main's 2450 and every claim through 2451 (6 November 2026, `docs/MIGRATION-ALLOCATION.md`).
The gaps this ADR left open are closed as follows. None was a known exploitable path.

1. **Every definer names pg_temp last (2500).** A path that does not name pg_temp searches the session's
   temporary schema first for relation *and type* names. Schema-qualifying relations is therefore not enough:
   a TEMP table named `uuid` or `jsonb` replaces that type inside a body whose path is `pg_catalog` alone.
   - `app.can_see_employment`, `app.can_see_person`, `app.is_admin_report_of` and `app.heads_department_of` are
     re-issued with `pg_catalog, public, pg_temp` and qualified relations. The two walks also pin every row they
     read to the session tenant, because `ai_hr_app` can call them with arbitrary ids.
   - Every other unpinned function keeps its path with pg_temp appended; nothing else about it changes. The set
     is read from the catalog when 2500 runs, so a function another migration re-issued earlier in the same
     upgrade keeps that migration's path, with pg_temp added. On main's 698-entry catalog that is 259 functions:
     138 definers and 61 invokers owned by the migrator, and 60 owned by dedicated NOLOGIN roles. The dedicated
     roles are the Rewards posting, setup, upload and view readers, the job profile reader and the architecture
     grade guard, and their functions are altered as those roles. Anything the sweep cannot pin stops the
     migration with its name.
   - `test/definer-search-path-pin.test.ts` fails on any future definer, or function with its own path, that
     does not end its path with pg_temp.
2. **`app.is_company_descendant`** was re-issued by 2126 (company organisation tagging) to walk only the session
   tenant, so this follow-up leaves it alone. As a consequence the company cycle trigger, which calls it, sees a
   cycle only inside a session tenant; an owner write with no tenant set is not checked. That is 2126's design,
   noted for its owner rather than changed here.
3. **The six remaining company references carry the composite key (2501 NOT VALID, 2502 validate).**
   - `company.parent_company_id`, `reporting_line.scope_company_id`, `notice.owner_company_id`,
     `overtime_pattern(.version).creation_company_id` and `performance_kpi_library.group_company_id` reference
     `company(id, tenant_id)` as `<table>_<column minus _id>_tenant_fk`, ON DELETE NO ACTION like their plain keys.
   - `teras_chat.company_id` (2000), which had no company key, gets `teras_chat_company_tenant_fk`.
   - `setCompanyParent` and the delegation scope picker pass a submitted company id straight through, and a chat
     takes its company from the browser's conversation scope, so the key is what refuses another tenant's.
   - 2502 reports every offending table and stops the upgrade, as 2102 does.
   - `test/tenant-company-fk.test.ts` now requires a twin for every single-column company key on a tenant table,
     and `test/company-reference-tenant-fk-upgrade.test.ts` rehearses both outcomes at the 698-entry boundary.

The owner chose ON DELETE NO ACTION for `teras_chat` (4 November 2026) over CASCADE. A company with chats or chat
tombstones refuses deletion as `other` (declared in `core/company-refs.ts`) until retention removes them, at most
the tenant's "Keep chats for" period (1 to 365 days). Deleting a company never deletes anyone's chats. A chat
naming a company outside the tenant is not stored; the reply is still shown.
