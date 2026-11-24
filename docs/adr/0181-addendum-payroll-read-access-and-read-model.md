# ADR 0181 addendum: payroll reads (once-per-statement payroll access, and the Phase 5 payroll read model)

Date: 25 November 2026

Status: **Revised after the owner's risk review on 25 November 2026.** The owner asked whether the risks could be
removed, then said "go ahead" to revising the design with the risk reductions in section 11, starting with the
migration-free quick fix (section 9, step 2). Section 11 changes sections 5–9 wherever they differ, and section 10 lists
the decisions as they now stand. Each migration-bearing step is still built inert, and is switched only by a separate
owner request. No migration is reserved yet. This addendum applies ADR 0181 decision 1 (precomputed access) and decision
6 (change F, read models) to the payroll family: `payslip`, `payroll_batch`, their policies, the
`payroll_history_effective_batch` and `payroll_history_native_payslip` views, and the payroll history barrier. It
reuses the company pilot ([7210](0181-addendum-precomputed-company-access.md)) and employment visibility (7240, PR 292 /
PR 300) where they apply.

Source facts were read at main `66f8c20fe`. Installed policy and function text was read back from the staging
catalogue (build `3fe15c9cc`, which contains PRs 273 and 287) as the application role. Staging measurements use
fictional demo data. Installation-specific production figures stay in the private review and are not repeated here.

## 1. Where payroll read time goes (staging, `pg_stat_statements`, fictional data)

Staging data volume: `payslip` 6,765 rows (799 pages), `payroll_batch` 605 rows (48 pages), 70 companies, 3,015
employments, 6,704 history import snapshots.

| Statement | Mean exec | Mean plan | Buffers per call | Rows | Status in source |
|---|---:|---:|---:|---:|---|
| Payroll list count over `payroll_history_effective_batch` | 3,761 ms | 17 ms | 144,826 | 1 | Removed by PR 287 |
| Payroll list `max(pay_period)` over the same view | 4,103–4,586 ms | 7–64 ms | 144,780 | 1 | Removed by PR 287 |
| Latest listed period, with an effective-view subselect per candidate (`latestListedBatchPeriodTx`) | 408–867 ms | 164–169 ms | 930–2,903 | 1 | **Current** (added by PR 287) |
| Payslips by one pay period, every company (`core/payroll-anomaly.ts` concurrent pay) | 700 ms | 6 ms | 112,285 | 24 | **Current** (Evaluate action, payroll audit loop) |
| Payslip money columns, one company, four periods (`core/loops/swing-rows.ts`) | 946 ms | 6 ms | 112,245 | 10 | **Current** (salary loop tick) |
| Transaction View History list, before PR 273 | 567 ms | 7 ms | 141,814 | 2 | Fenced by PR 273 (about 23 ms) |
| Latest payroll batch event per company (`core/loops/payroll-freshness.ts`) | 42 ms | 203 ms | 3,143 | 0 | **Current** (planning-bound) |

What this shows:

- **Data volume is about 1% of the time.** A full scan of both tables is about 850 pages. These statements touch
  112,000–145,000 buffers per call to return 1–24 rows: 130–170 times the size of the tables.
- **Planning is 1–2%** of these statements, except the `domain_event` statement and the latest-period subselect, where
  planning dominates. A plain `EXPLAIN` of the 24-row payslip statement expands into 179 InitPlans and 37 SubPlans,
  with 22 calls of `can_admin_payroll_for` and 21 of `is_admin_for` in its filters.
- **The rest, about 98%, is per-row authority and per-batch history derivation.** Request timing on staging before
  PRs 273/287 agrees: Payroll list mean 5.3 s (max 11.4 s), Transaction View mean 4.1 s (max 28 s), with 96–99% of
  request time spent in the database.

PRs 273 and 287 removed the worst statements by fencing reads to the needed batches. They did not make any single
payslip or batch row cheaper to authorise, so every new read shape, every larger tenant, and the background loops still
pay the per-row chain. Staging has had no payroll page traffic since PR 287 was installed. A post-287 "before"
measurement is step 1 of section 9.

## 2. What the payroll policies evaluate per row today

Installed policies for `ai_hr_app` reads. "Per row" means a non-inlinable function call for every candidate row.

### 2.1 `payslip`

| Policy | Kind | Predicate | Cost |
|---|---|---|---|
| `payslip_rls` (0492) | permissive, ALL | tenant AND (`can_admin_payroll_employment(employment_id)` OR EXISTS(`employment e` WHERE `e.id = employment_id` AND `is_self_person(e.person_id)`)) | **Per row.** The admin arm is a plpgsql definer that reads the employment's current company, then `can_admin_payroll_for` (parses `app.grants` and walks `is_company_descendant` per grant). The self arm's `EXISTS` applies all of `employment`'s own policies per row. |
| `payslip_original_employer_read` (6661) | permissive, SELECT | tenant AND `payroll_tax_basis_original_employer_read(batch_id)` | **Per row**: batch company, `principal_snapshot_current()` (plpgsql), `payroll_tax_basis_permission` |
| `payroll_history_effective_only` (0602/0660) | restrictive | `payroll_history_effective(id)` OR `payroll_history_self_issued(id)` | **Per row.** This is the history barrier. `payroll_history_effective(id)` calls the set function `payroll_history_effective_ids` with a one-element array, so its whole CTE chain runs once per row. |
| `payroll_tax_basis_reader_guard` (0874) | restrictive | `payroll_tax_basis_reader_compatible(employment_id, batch_id)` | **Per row** plpgsql call. Every tenant transaction sets `app.payroll_tax_basis_reader='1'` in `bootstrapTenantTx` (`db/client.ts:548`), so the call always returns true at its first line. |
| `payroll_import_tax_basis_reader_guard` (6660) | restrictive | `payroll_import_tax_reader_compatible(employment_id, batch_id, statutory->'importedTaxBasis')` | Same: always set to `'1'`, so it returns true at the first line, still called per row. |
| `payslip_current_human_read` (7051) | restrictive | CASE over InitPlans | Once per statement (the leaver branch is per row, but rare) |
| `payslip_history_stage` | restrictive | NOT `id` IN (unnest(`payroll_history_hidden_rows('payslip')`)) | Once per statement |

### 2.2 `payroll_batch`

| Policy | Kind | Predicate | Cost |
|---|---|---|---|
| `payroll_batch_rls` | permissive, ALL | tenant AND (`can_admin_payroll_for(company_id)` OR EXISTS(`payslip ps` WHERE `ps.batch_id = id` AND `ps.employment_id = ANY(visible_employment_ids())`)) | **Per row.** The `EXISTS` applies every `payslip` policy above to each payslip it probes. |
| `payroll_batch_current_human_read`, `payroll_batch_history_stage` | restrictive | as for payslip | Once per statement |
| owner-read policies (overtime context, retired attendance formula) | permissive, `CURRENT_USER` checks | InitPlan | Once per statement |

### 2.3 The history views

- `payroll_history_effective_batch` (security invoker). For every batch it runs a LATERAL that calls
  `payroll_history_batch_adopted(id)` and `payroll_history_native_batch_override(id)` (definers reading snapshots,
  revisions and captures). For a derived batch it then calls a totals function. Because every transaction sets the
  tax-basis reader to `'1'`, that function is `payroll_history_batch_visible_totals`, which gives the viewer's own
  totals: their administered employer companies plus their own payslips. This view is why the Payroll list pays per
  batch even after PR 287.
- `payroll_history_native_payslip` (security barrier). It calls `payroll_history_native_artifact_allowed(batch,
  employment, payslip)` per row, which uses the batch register (`/payroll/[batchId]`).

### 2.4 The payroll history barrier: what it hides

`payroll_history_effective_ids` hides a payslip id when any of these holds:

1. It is a history import snapshot that is not the latest non-hidden revision of its record.
2. It is staged by an import stage that is not this transaction's authorised stage.
3. It is a native payslip that a later adopted history record replaces (the 6693 `native_replaced` proof).

Parts 1 and 3 depend only on committed history rows. Part 2 depends on the session (`app.payroll_history_stage`,
`payroll_history_stage_authorized`), but only while some stage is in state `staged`, which happens only during a
running history import job. ADR 0181 keeps the barrier's rules and its advisory lock unchanged, and so does this design.

## 3. Design overview

There are two changes, and they can ship separately.

- **Change P (payroll access, ADR 0181 decision 1).** Restate the payroll policies so every authority check runs
  **once per statement**, as a company or id set. Store only the parts of the history barrier that depend on
  committed history (section 5). This is a security change on the money tables, so it follows the pilot's proof path
  (section 8) and its `legacy` → `shadow` → `precomputed` modes.
- **Change F (payroll read model, ADR 0181 decision 6, Phase 5).** A row-secured, per-batch summary maintained by the
  worker from the `domain_event` outbox. It serves the Payroll list and the period pickers of Transaction View. Each
  row records the source version it reflects. The read uses a row only when that version is current, and otherwise
  reads the source.

Not in scope: changing who may see what. Every rule below is the current rule, evaluated in a different place.

## 4. Change P: what is live, what is stored

| Input | Read by | Treatment |
|---|---|---|
| Session tenant, user, claims (`app.grants`) | all policies | **Live**, once per statement |
| Payroll admin scope: `hr_admin`, `super_admin` or `payroll_partner` claim covering the company (`can_admin_payroll_for`) | `payslip_rls` (via the employment's current company), `payroll_batch_rls` | **Live per company**, once per statement: `app.payroll_admin_companies()`. This is the 7240 `employment_partner_companies()` pattern. It reads claims, so it cannot be stored per user without changing the rule (same reasoning as 7240 decision 1). |
| Company tree | `can_admin_payroll_for` → `is_company_descendant` | Unchanged live function, called once per company per statement. 7210's `access_company_closure` can replace it in the `precomputed` mode, with its date window. That is an optimisation, not a dependency. |
| Employment's **current** company (the admin arm uses the employment's company, not the batch's) | `payslip_rls` admin arm | **Live set**: `app.payroll_admin_employment_ids()`, a definer that returns the tenant's employments whose company is in `payroll_admin_companies()`. It reads without row security, as `can_admin_payroll_employment` does today, so voided and import-pending employments are included exactly as now. |
| Caller's own employments as `employment`'s policies show them | `payslip_rls` self arm (`EXISTS` under employment row security) | **Live set**: `app.payroll_self_visible_employment_ids()`, a **security-invoker** function, so `employment`'s policies apply to it exactly as they apply inside the `EXISTS` today. With `is_self_person`'s predicate. |
| Tax-basis original-employer permission | `payslip_original_employer_read` | **Live per company**, once per statement: `app.payroll_tax_basis_view_batch_ids()` (definer). It returns the batches whose company passes `principal_snapshot_current()` and `payroll_tax_basis_permission(company, 'payroll.tax-basis.view')`. |
| Reader settings (`app.payroll_tax_basis_reader`, `app.payroll_import_tax_basis_reader`, `app.payslip_self_issued`) | the two guards, the self-issued arm | **Live**, once per statement, as InitPlans ahead of the per-row call. Each guard function returns true at its first line when its setting is `'1'`, so skipping it then is equivalent by construction. The per-row call remains for a transaction without the setting, so it still raises exactly where it raises today. |
| History barrier parts 1 and 3 (committed history) | `payroll_history_effective_only` | **Stored**: `payroll_history_ineffective_payslip` (section 5) |
| History barrier part 2 (staged rows, session stage) | the same, and `payslip_history_stage` | **Live**. While the tenant has any stage in state `staged`, the policy falls back to the per-row function for that statement (section 5). |
| Self-issued history (`payroll_history_self_issued`) | `payroll_history_effective_only` second arm | Per row, but only when `app.payslip_self_issued = 'on'` (an InitPlan gate). That is set only by the two own-payslip readers, whose rows are one person's payslips. |

## 5. Stored part: the ineffective-payslip set

`payroll_history_ineffective_payslip (tenant_id, payslip_id primary key, reason, history_version)`, where `reason` is
`superseded_snapshot` or `native_replaced`. It holds exactly the payslip ids that parts 1 and 3 of
`payroll_history_effective_ids` hide **when no stage is in state `staged`**. It is usually small: superseded import
snapshots plus replaced native payslips, not every payslip.

- **Maintenance.** Statement-level `AFTER INSERT OR UPDATE OR DELETE` triggers with transition tables on
  `payroll_history_import_revision`, `payroll_history_import_snapshot`, `payroll_history_native_capture`,
  `payroll_history_import_record` and `payslip`, plus `payroll_batch` (only `company_id`, `pay_period`,
  `payroll_cycle_id`; these feed the 6693 proof). Each trigger recomputes the affected records' payslips set-wise
  and writes the difference. As in 7240, each function first diffs `old_rows` against `new_rows` on the columns it
  reads and returns at once when nothing it reads changed. Most payslip writes (money columns) return there. Each
  trigger is attached to the table, not to each writer: the writers include the history confirm, the staged job's
  finalize, adoption and reversal, native capture and the payroll processing chunks. Adoption and reversal change
  effectiveness without writing `payslip` at all, which is why the revision and snapshot triggers exist.
- **State.** `payroll_history_access_state (tenant_id, history_version, trusted, last_verified_at,
  last_difference_count)`. As in 7210, every maintaining statement increments the version first, and that row lock
  serialises maintainers within one tenant. History writers already take the payroll history barrier lock first, so
  the lock order is unchanged. Reads take no lock (rule 1).
- **Read rule.** The stored set is used only when the tenant is trusted **and** has no stage in state `staged`. Both
  are checked once per statement through one indexed probe. A tenant with an import in progress therefore reads
  exactly as today. The fallback is never "deny".
- **Policy form** (in `precomputed` mode):

```sql
payroll_history_effective_only:
  CASE WHEN (SELECT app.payroll_history_store_usable())
       THEN NOT EXISTS (SELECT 1 FROM public.payroll_history_ineffective_payslip x
                        WHERE x.payslip_id = payslip.id)
       ELSE app.payroll_history_effective(id) END
  OR ((SELECT coalesce(current_setting('app.payslip_self_issued', true), '') = 'on')
      AND app.payroll_history_self_issued(id))
```

  The `NOT EXISTS` is an indexed anti-join probe, not a function chain. The table carries tenant row security and a
  `SELECT` grant to `ai_hr_app`, because it is read inside the policy as the caller. It discloses nothing beyond
  which payslip ids of the caller's tenant are superseded. Writes go only through the definer maintenance functions.
- **`payroll_history_effective_batch`**: the per-batch `adopted` and `native_batch_override` probes keep their
  functions. Change F removes the list's dependence on them, and the register keeps them (one batch per page).

## 6. Restated policies

Each restatement is guarded by its predecessor's exact text, as 2510, 7150 and 7210 do. Write `WITH CHECK` clauses are
unchanged.

```sql
-- payslip_rls USING (FOR ALL, so this also governs UPDATE/DELETE visibility; equivalent for every command):
tenant_id = app.current_tenant_id() AND (
  employment_id IN (SELECT unnest((SELECT app.payroll_admin_employment_ids())))
  OR employment_id IN (SELECT unnest((SELECT app.payroll_self_visible_employment_ids()))))

-- payslip_original_employer_read USING:
tenant_id = app.current_tenant_id()
  AND batch_id IN (SELECT unnest((SELECT app.payroll_tax_basis_view_batch_ids())))

-- payroll_tax_basis_reader_guard USING:
(SELECT current_setting('app.payroll_tax_basis_reader', true) = '1')
  OR app.payroll_tax_basis_reader_compatible(employment_id, batch_id)

-- payroll_import_tax_basis_reader_guard USING:
(SELECT current_setting('app.payroll_import_tax_basis_reader', true) = '1')
  OR (statutory -> 'importedTaxBasis') IS NULL
  OR app.payroll_import_tax_reader_compatible(employment_id, batch_id, statutory -> 'importedTaxBasis')

-- payroll_batch_rls USING (the EXISTS keeps payslip's own policies as the owner of payslip visibility):
tenant_id = app.current_tenant_id() AND (
  company_id = ANY ((SELECT app.payroll_admin_companies())::uuid[])
  OR EXISTS (SELECT 1 FROM payslip ps WHERE ps.batch_id = payroll_batch.id
             AND ps.employment_id = ANY ((SELECT app.visible_employment_ids())::uuid[])))
```

Why these are the old predicates:

- `can_admin_payroll_employment(e)` is "e exists in the tenant (read without row security) and its company passes
  `can_admin_payroll_for`". That is membership in `payroll_admin_employment_ids()` by definition.
- The self arm's `EXISTS` read `employment` as the caller, under employment's policies. An invoker function with the
  same predicate reads the same rows. Running it once per statement rather than per row does not change its answer
  within one statement snapshot.
- The guards return true at their first line in exactly the cases the new leading terms short-circuit.
  `payroll_import_tax_reader_compatible` also returns true when its stamp is null.
- `payroll_tax_basis_original_employer_read(batch)` reads the batch without row security and decides on the batch's
  company only, so it is a per-company answer mapped to batches.
- In `payroll_batch_rls`, `can_admin_payroll_for(company_id)` per row becomes the same answer once per company. The
  `EXISTS` is unchanged. It becomes cheap because the payslip policies it applies are now set-based.

Scale note: `payroll_admin_employment_ids()` returns every employment of an administered company. For a group
administrator that is the whole tenant, the same size as `visible_employment_ids()`, which about 58 policies already
build once per statement. Using the **batch's** company instead would be smaller, but it is a different rule (an
employee who moved company would follow the batch, not their current employer), so it is not proposed here; see
decision 5.

Two other per-row readers on payroll screens follow the same rules: `payroll_history_native_artifact_allowed` (batch
register) and the payroll-permission loop in `payrollCloseCompanyIdsTx` / `listReprocessEmployeeOutcomes`, which runs 3
statements per company one after another (rule 2). The loop becomes one set statement without any schema change and
can ship ahead of change P (section 9, step 2).

## 7. Change F: the payroll batch read model (Phase 5)

### 7.1 What it serves

- **Payroll list:** rows, `employee_count`, totals, the "hide empty imported runs" filter, the latest listed period
  (`latestListedBatchPeriodTx`) and the unpublished count.
- **Transaction View:** the latest processed period and the year/period pickers. The History, Grid and Statutory
  money rows themselves stay on `payslip` (fenced by PR 273 and cheap after change P). A per-payslip projection would
  duplicate money for every payslip and is not proposed.

### 7.2 Schema

`payroll_batch_summary (tenant_id, batch_id primary key, company_id, pay_period, payroll_cycle_id, run_type, run_seq,
status, history_import_attempt_id, derived boolean, effective_employee_count int, effective_totals jsonb,
employer_company_ids uuid[], source_version bigint, projected_at)`, plus
`payroll_batch_source_version (tenant_id, batch_id primary key, version bigint)`.

- **Source version.** Statement triggers on `payslip`, `payroll_batch`, the history import tables (as in section 5) and
  `employment.company_id` bump `payroll_batch_source_version` for each affected batch, in the writer's transaction.
  This is one upsert per affected batch per statement and does no recomputation. It is the freshness truth.
- **Worker projection.** A worker sweep on the existing lane, with no new lane, recomputes summaries for batches whose
  `source_version` is ahead of their summary row. It uses the **existing** derivation functions
  (`payroll_history_batch_totals`, the adopted and override probes) run as the storage owner, and copies
  `payroll_batch.totals` for native runs. `domain_event` rows (`aggregate_type` `payroll-batch` and
  `payroll-history-import`) wake the sweep for low lag. Correctness does not depend on the event stream: several
  writers emit no event (processing chunks, the intermediate discard units, the staged history job, `discardHistory`),
  and `domain_event.sequence` is a `bigserial`, so a reader cannot rely on commit order. The version comparison catches
  everything the events miss.
- **No money is computed from the projection.** `effective_totals` is a copy of what the deterministic SQL derivation
  returns from source rows, stamped with the version it read. The page displays it or reads the source. It never sums,
  nets or adjusts projected figures. Payroll truth stays in `payslip` and `payroll_batch`.

### 7.3 Read rule (exact, per row)

A summary row is served for a viewer when all of these hold:

1. `summary.source_version = payroll_batch_source_version.version` (one indexed join).
2. The tenant has no stage in state `staged` (the section 5 check).
3. The viewer administers every employer company of the batch:
   `employer_company_ids <@ (SELECT app.payroll_admin_companies())`.

When all three hold, the viewer's visible totals equal the batch's effective totals:

- `payroll_history_batch_admin_totals` counts every effective payslip whose employer company is administered, and
  that is all of them.
- The own-employment extra in `payroll_history_batch_visible_totals` adds only payslips of non-administered
  companies, and there are none.

Otherwise that row is read from the source, exactly as today. The usual viewer, a payroll administrator of the run's
company, is served from the summary. A viewer with partial scope gets the live per-viewer answer.

Row security on `payroll_batch_summary` is the restated `payroll_batch_rls` admin arm (company in
`payroll_admin_companies()`) plus the restrictive stage and current-human policies of `payroll_batch`. A non-admin
viewer never reads it and stays on the source path. It has a `SELECT` grant to `ai_hr_app`, and writes come only from
the owner sweep.

### 7.4 Proof

The proof is the same equivalence fixture as section 8, comparing the summary path against the source path:

- rows, order, counts, `employee_count` and every totals key, byte for byte as `jsonb`;
- for every actor, under "All companies" and one company;
- after each kind of write: process, selective reprocess, close, unlock, reset, remove an employee, history confirm,
  adoption, reversal, staged import in flight, and an employment company change.

Before the projection catches up, a stale row must take the source path. A rebuild check recomputes every summary and
compares it with the stored one, as in section 8.3.

## 8. Evidence before any switch (same path as 7210 and 7240)

1. **Equivalence tests** (database units on GitHub Actions). Extend the shared 70-company, 1,000-employment fixture
   (`test/access-effective-company-fixture.ts`) with payroll:
   - native runs across 12 periods, including an additional run and a payroll cycle;
   - a closed, unlocked and reset run;
   - a history import with a superseded revision and an adopted native record (6693 `native_replaced`);
   - a staged import in flight, checked both with and without the stage's authority;
   - a tax-basis revision, an imported-tax-basis stamp, and a transaction without the reader settings (each guard
     must still raise);
   - an employee who moved company after the run, a voided employment and an import-pending employment;
   - a former employee (leaver self-history), and a self-issued payslip read.

   Actors: group-wide and subtree `hr_admin` / `super_admin`, `payroll_partner`, a tax-basis viewer with and without
   the permission grant, a manager, a department head, an employee, and a stale session claim. For each actor, under
   "All companies" and one company, the old and new policies in each mode must return identical rows, order and
   counts for:
   - the Payroll list, its count and its latest period;
   - the Transaction View History list, latest period and pickers;
   - the payslip review, the register, and own payslips;
   - the anomaly and swing-row loop reads, and `SELECT ... FOR UPDATE` on payslip and batch.

   Every guard exception must be raised identically in each mode. A test must show that each trigger-maintained change
   is visible in the same transaction.
2. **Staging shadow comparison.** In `shadow` mode, `payroll_history_effective_only` computes both answers and serves
   the legacy one. Exactly as 7240 does, it emits one `RAISE LOG` per statement with counts only:
   `payroll_history_access shadow reason=<compared|untrusted|staged> missing=<n> extra=<n>`. The set-based
   restatements of section 6 are equivalent by construction and compared by the tests. Shadow runs on staging for
   the same seven days with zero unexplained differences, with a minimum compared count the owner confirms.
3. **Rebuild check.** A worker sweep, shortly after midnight Kuala Lumpur time, recomputes the ineffective set and the
   summaries from scratch and compares them with the maintained rows. A difference marks the tenant untrusted, so
   reads fall back. It also logs an alert with counts only. An operator re-trusts the tenant after the cause is fixed
   (7210 decision 2).

## 9. Order of work (revised by section 11)

| Step | What | Schema | Switch |
|---|---|---|---|
| 1 | Post-287 staging "before": request timing and `pg_stat_statements` for `/payroll`, Transaction View tabs, the register and own payslips, on the owner's account or a fictional staging admin, under the staging lease | No | — |
| 2 | Quick fix: one set statement for payroll permission in `payrollCloseCompanyIdsTx` and `listReprocessEmployeeOutcomes`, with an equivalence test against `resolvePayrollPermission` per company | No | — |
| 3 | P1: the two tax-basis guards (reader settings as InitPlans). Also installs the shared switch, the full comparison job and the save-cost test | next free | Inert on install |
| 4 | P2: payroll admin companies once per statement (`payroll_batch_rls`, `payslip_rls` admin arm, original-employer arm) | next free | Inert on install |
| 5 | P3: own payslips once per statement (`payslip_rls` self arm) | next free | Inert on install |
| 6 | P4: the stored history filter (section 5 as revised by 11.4) | next free | Inert on install |
| 7 | F: imported-history run summary (section 7 as revised by 11.5), read only where P2 and P4 are on | next free | Inert on install |
| 8 | Staging after-measurement; close matching findings in `docs/ARCHITECTURE-PERFORMANCE-REMEDIATION.md` with their evidence | No | — |

Migration numbers are not fixed: each step takes the next free number at build time, as reported by
`node .github/ci/check-migration-collisions.mjs --local --next` (currently from 7320; 7300 and 7310 are taken). Each is reserved through `docs/MIGRATION-ALLOCATION.md` and
checked with the database revamp session only when its step is built.

`docs/ARCHITECTURE-PERFORMANCE-REMEDIATION.md` has no finding for the Payroll list or Transaction View load. AP-037
(mobile payslip lists) and AP-045 (run row-menu screens) read the same policies and are re-measured in step 8. They are
closed only if that evidence shows them fixed.

## 10. Owner decisions

Decided on 25 November 2026 ("go ahead", after the risk review in this session):

- Revise the design with the risk reductions of section 11.
- Start with step 2, the quick fix. It has no migration and goes through the staging queue under the staging release
  approval already relayed by the coordinator.

Still open, and asked step by step:

1. Each step's switch from `legacy` to `shadow`, and then to `precomputed`, on staging. This is a separate request per
   step, after its full comparison reports zero differences.
2. Running the full comparison job read-only on production (counts only) before any production switch. This needs a
   separate production permission.
3. The save-cost limit (section 11.6). Proposed: 2%.
4. Keep the admin arm on the employment's current company (section 6). *Recommended: keep.* The batch-company
   alternative changes who sees a moved employee's earlier payslips, so it would be a separate permission decision.

## 11. Risk reductions (owner review, 25 November 2026)

The owner judged the first draft's risks too high. These changes take the risk out of installation and prove each
step on real data before anyone relies on it. Where they differ from sections 5–9, they win.

### 11.1 Installing changes nothing

- No migration replaces a payroll policy. Each step's migration adds the new functions and tables, and keeps today's
  policies word for word.
- Each step's restated policy is created alongside the old one but stays detached. A definer operator function owned
  by `ai_hr_owner`, not granted to `ai_hr_app`, swaps them atomically in one transaction, and swaps them back. Each
  swap is guarded by the exact predecessor text, so a swap never applies over an unexpected policy.
- Until the swap is requested, behaviour is today's, apart from `shadow` work (11.2). Rollback is the reverse swap: it
  takes seconds and needs no migration.

### 11.2 Compare every person against every row, not a sample

- **Full comparison job.** For every user of a tenant with a payroll-relevant role or an employment, it computes the
  payslip and run ids they can see under the old predicate and under the new one. It also compares each guard's raise
  or no-raise, and, for P4 and F, the effective totals. It reports differences as counts by step and reason, with no
  person, tenant or money values.
- It runs on staging after each install and nightly during the shadow period. A step switches only after zero
  differences on every run.
- Before any production switch, the same job runs read-only on production under a separate production permission
  (decision 2). It proves the new rules give identical answers on real data, for every user.
- The traffic-based `shadow` log of section 8.2 stays as a second witness.

### 11.3 Small steps, each with its own switch

The steps run in the order P1–P4 of section 9, lowest risk first. Each has its own switch, comparison report and
rollback, so a problem in one step is switched back without undoing the others.

- **P1 is identical by construction.** Every tenant transaction sets both reader settings, and each guard returns true
  at its first line when its setting holds.

### 11.4 History import in progress: fall back only for the imported rows

Section 5's "any staged stage, whole tenant falls back" becomes a per-row fallback:

- The stored set is read for every payslip that no staged row touches.
- The per-row `payroll_history_effective(id)` runs only for payslips an in-progress stage touches. Those are payslips
  staged directly, plus payslips of the history records whose revisions or snapshots are staged.
- That affected set is computed once per statement from `payroll_history_staged_row` (already read once per statement
  by `payroll_history_hidden_rows`).
- The equivalence tests cover a stage in flight, both for its authorised importer and for every other actor.

### 11.5 Payroll saves get no extra work

- **P4 triggers fire only on what can change the history filter.** That means payslip INSERT and DELETE (transition
  tables), payslip `UPDATE OF batch_id, employment_id` (a statement trigger without transition tables, so it can take
  a column list), and the history import, revision, snapshot and capture tables.
  - Money-column updates by processing, reprocessing and corrections fire nothing.
  - For `payroll_batch`, an `UPDATE OF company_id, pay_period, payroll_cycle_id` statement trigger, plus insert and
    delete.
- **F covers imported-history runs only.** For a native run, `payroll_history_effective_batch` already serves
  `payroll_batch.employee_count` and `totals` from the run itself, and the list keeps reading those directly.
  - The summary holds only the `derived` flag, the derived totals, the employer companies and the source version.
  - Its source version moves only on history import, adoption and reversal, native capture, and an employment company
    change for an employment that has imported history. The last is one indexed probe on that save.
  - `payroll_batch` and payslip money writes never touch it.
- **No new waiting.** History writers already hold the payroll history barrier lock. Movement and employment writers
  take the Access lock before any maintenance, so the lock order is unchanged.

### 11.6 Save-cost limit before install

A focused CI test times, with and without each step's maintenance:

- a payroll processing chunk;
- a selective reprocess;
- a history confirm and an adoption;
- a 1,000-employee movement import.

The build fails if any of them is slower by more than the owner's limit (decision 3; proposed 2%).

### 11.7 Automatic fall back, never to "deny"

- A nightly rebuild difference (section 8.3) marks that tenant's step untrusted, and its reads use today's rules.
- A full comparison difference does the same for that step on that tenant. An operator re-trusts it only after the
  cause is fixed (7210 decision 2).
