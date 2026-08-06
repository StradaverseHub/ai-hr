/** Test harness: owner-role DB access for setup/seed/reset + migration of the test DB. */
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { randomUUID } from 'node:crypto';
import { createDb, client as appClient, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { legacyEnabledModulesIn, legacyEnabledSettingsIn } from '../packs/catalog';
import { resolveEntitlementsTx } from '../core/entitlements';
import type { EntitlementSnapshot } from '../core/entitlement-types';

// Owner connection (postgres) — bypasses RLS, used only for setup/seed/reset.
export const owner = createDb(process.env.TEST_MIGRATION_DATABASE_URL!);

const ALL_TABLES = [
  'tenant', 'company', 'company_logo', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'leave_type', 'leave_ledger',
  // 491c499f — the adjustment batch header. leave_ledger.adjustment_batch_id points AT it, so it must
  // be truncated too: leaving it out lets a batch row survive between files and the next test's
  // "recent adjustments" list reads a batch whose ledger rows are gone. This is the ADR-0071 leak
  // the comment below records, and it is why the list is edited whenever a leave table is added.
  'leave_adjustment_batch',
  'leave_request', 'leave_request_date', 'leave_cancellation_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  // 6d671f44 — Create New Employee drafts (migration 0337). Listed explicitly rather than left to the
  // TRUNCATE ... CASCADE from `tenant`: the ADR-0071 note below is what happens when a table is only
  // ever cleared by accident.
  'employee_draft',
  // 476f23ed — the movement event-type catalogue (migration 0340). Explicit for the same reason as the
  // line above: a surviving overlay row would rename or switch off an event type for a later test file,
  // and the symptom would be a movement that "disappeared" from Employment History with no obvious cause.
  'movement_event_type',
  'holiday', 'holiday_group_holiday', 'attendance', 'attendance_policy', 'travel_request',
  'payroll_batch', 'payslip', 'payroll_input', 'payroll_individual_txn', 'employee_cp38', 'company_statutory_my',
  'payroll_policy',
  'statutory_ruleset', 'statutory_pack', 'statutory_signing_key', 'statutory_pack_sync_log',
  'claim_type', 'claim_policy', 'claim_request', 'claim_attachment',
  'employee_loan', 'loan_repayment',
  'performance_goal', 'review_goal', 'performance_checkin', 'peer_feedback_request', 'peer_feedback', 'calibration_session', 'calibration_entry', 'performance_attachment',
  'shift', 'roster_assignment', 'toil_policy', 'toil_accrual', 'location',
  'clocking_location', 'employee_clocking_location',
  // 5249d43f — registered clocking devices: truncate between test files (the global unique token index
  // means a leaked row can't collide, but a surviving device would make a later gate test false-green).
  'employee_device',
  'notification', 'notification_pref', 'notification_delivery', 'notification_cursor',
  // 6e122302 — the Notice Board. `notice_recipient` cascades from `notice`, but BOTH are listed for the
  // ADR-0071 reason recorded further down: a table only ever cleared as a side effect is a table that
  // stops being cleared the day the cascade path changes. A surviving notice would also make a later
  // file's dashboard card or popup read a notice whose recipients belong to a deleted tenant.
  'notice', 'notice_recipient',
  // 6e9a126e — the entitlement redesign's three tables. Listed explicitly per the convention above: a
  // leaked template would trip the (tenant, leave_type, lower(name)) partial-unique index in a later test
  // file, and a leaked archive row would be counted by the listing/CSV assertions.
  'entitlement_template', 'entitlement_eligibility_rule', 'entitlement_reset_archive',
  'tp1_relief',
  'employee_dependent',
  // 23ad620e — emergency-contact register: a leaked live 'primary' row would trip the partial unique
  // index (person_emergency_contact_one_primary_uq) in a later test file. CASCADE from `person` would
  // reach it, but the two tables above are listed explicitly for the same reason and this one matches.
  'person_emergency_contact',
  // a949184a — qualification register: a leaked live is_highest row would trip the partial unique index
  // (employee_qualification_one_highest_uq) across test files.
  'employee_qualification',
  // 0110 — leaking review rows across tests would make the partial-unique index throw spuriously
  // (order-dependent false-green/false-red). Must be truncated between tests.
  'employment_review',
  // 6522d26a — reminder dedup rows + letter documents: a leaked (review, offset) row would trip the
  // unique index (or make a reminder-sweep test see a phantom "already sent") across test files.
  'employment_review_reminder', 'review_document',
  // ADR-0069 — leave encashment: leaking a frozen snapshot across tests would make the partial unique
  // index (employment_id, leave_type_id) WHERE status='frozen' throw spuriously.
  'leave_encashment_policy', 'leave_encashment_snapshot',
  // ADR-0071 — leave-approval rule matrix: these two were MISSING from ALL_TABLES, so resetDb() never
  // truncated them between test files (a currently-live isolation bug). A rule/BU row from an earlier test
  // file would silently survive and match (or throw the wildcard-unique index) in a later one.
  'leave_approval_policy', 'business_unit',
  // 6fadb036 (R17) — reusable approval templates: truncate between test files (same isolation reason as
  // leave_approval_policy above; a surviving template + its unique-name index would collide across files).
  'leave_approval_template',
  // ADR-0072 — real auth: invitations must be truncated between tests, and the global unique index on
  // app_user.workos_user_id would otherwise let a leaked subject collide across test files.
  'app_invitation',
  // ADR-0072 — attendance allowance policy (a leaked row would trip the partial-unique code index).
  'attendance_allowance_policy',
  // ADR-0073 — shared system labels junction: a leaked (label_id, company_id) row would trip the unique
  // index (or make a resolver test see a phantom shared label) across test files.
  'label_company_assignment',
  // 7d309da7 — Personnel profile dropdown catalog: a leaked option row would trip the
  // (tenant, category, value) unique index (or make a seed-idempotency test see phantom rows).
  'profile_option',
  // 9aa894a4 — Leave Year Configuration: a leaked row would trip the (tenant, year) unique index across
  // test files.
  'leave_year_config',
  // f018ce8d — general employee document store: truncate between test files so a leaked bytea row
  // doesn't survive into a later file's count/RLS assertions.
  'employee_document',
  // 88e94371 — attendance-rule library: a leaked rule (or its OT rows) would trip the per-company default /
  // name unique indexes across test files. CASCADE from company already clears them, but list explicitly.
  'attendance_rule', 'attendance_rule_ot_row',
  // 3d0031e6 — Employee ID Auto Running Number Setup: a leaked active config would trip the partial
  // one-active-per-scope unique indexes (or make a later hire auto-generate unexpectedly) across test files.
  'employee_id_config',
  // R46 orgbank (84719377) — company bank accounts + per-authority statutory payment config. Both cascade
  // from company, but list them explicitly: a leaked row would trip the one-primary-per-company partial
  // unique index / the (company, authority) unique index across test files.
  'company_bank_profile', 'company_statutory_authority',
  // 0280 — scheduled-actions run log. GLOBAL (no tenant_id) and never seeded, so nothing CASCADEs it
  // away: without this entry a run row written by one test file would survive into every later file
  // that calls resetDb, exactly the ADR-0071 isolation bug documented above.
  'job_run',
  // 0295 — operator console provisioning queue. GLOBAL (no tenant_id); its tenant_id column is a RESULT
  // FK, so truncating `tenant` would cascade it away, but list it explicitly per the convention above:
  // a request row leaking between test files would be counted by the RLS/claim assertions.
  'tenant_provision_request',
  // ADR-0077 slice 1 — entitlement + settings rows. All of these would CASCADE from `tenant` (or from
  // `tenant_provision_request`) anyway, but they are listed explicitly per the convention above: a
  // leaked entitlement row would silently change what a later test file's module gate resolves to,
  // which is the hardest class of cross-file bug to attribute.
  //
  // `module` and `setting_definition` are DELIBERATELY ABSENT. They are installation-wide CATALOGS
  // seeded once into the template by scripts/seed-catalogs.ts (C11), not test data — truncating them
  // here would empty the catalog on the first resetDb() and every later FK insert would fail.
  'tenant_module', 'tenant_setting', 'subscription', 'subscription_line', 'usage_snapshot',
  'platform_user', 'tenant_provision_request_module',
];

/**
 * No-op since the template-database switch (test/global-setup.ts): this worker's database was stamped from
 * an already-migrated template, so there is nothing left to apply.
 *
 * Kept as an exported function because 247 test files call it in `beforeAll`. Those calls used to re-read
 * and hash all ~233 migrations apiece just to discover they had no work to do, which was the single largest
 * cost in the suite. Deleting the call sites would be a 247-file diff for no behavioural gain, so the
 * function stays and simply returns.
 */
export async function migrateTestDb() {
  // Intentionally empty — see the note above.
}


/**
 * The ~100-table TRUNCATE, made to fail FAST and retry instead of hanging.
 *
 * ## The bug this fixes, measured 2026-08-06
 *
 * There are TWO connection pools open on every worker database: `owner` (this file, used for the
 * TRUNCATE) and the application's own pool in db/client.ts, which every `withTenant` call in the code
 * under test uses. Both are up to ten connections.
 *
 * `TRUNCATE ... CASCADE` takes an AccessExclusiveLock on all ~100 tables. If ANY app-pool connection
 * still holds a lock from the test that just finished, the TRUNCATE queues behind it — and because it
 * already holds locks of its own by then, the two can deadlock outright. The server log shows exactly
 * that: "Process A waits for AccessExclusiveLock ... blocked by process B. Process B waits for
 * RowShareLock ... blocked by process A."
 *
 * Without a lock_timeout that wait is UNBOUNDED, so what should be a fast reset became a 15-minute hang
 * that vitest eventually reported as "Hook timed out in 30000ms" — in `beforeEach`, in whichever file
 * happened to draw the short straw. A full run produced seventeen such failures across nine unrelated
 * files, with ZERO assertion failures among them. Every one of them was this.
 *
 * ## Why a timeout + retry rather than something cleverer
 *
 * `lock_timeout` turns an unbounded wait into a fast, named failure, and a lock held by a
 * just-finished test clears in milliseconds — so a couple of retries is all it takes. The last attempt
 * terminates any OTHER backend on this database first: between tests nothing should legitimately be
 * in flight, so a connection still holding locks is either a leak or a straggler, and postgres.js
 * transparently reconnects the app pool afterwards.
 *
 * What this deliberately does NOT do is raise the hook timeout, which would hide the wait rather than
 * remove it, and would keep every one of those runs 15 minutes long.
 */
async function truncateAllTables(): Promise<void> {
  const sqlText = `TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`;
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      // ONE transaction, deliberately. `SET LOCAL` only has meaning inside a transaction, and the pool
      // gives no guarantee that a bare SET and the TRUNCATE that follows land on the SAME connection —
      // so setting it separately could time out a different connection and leave this one unbounded.
      // Sending both in one multi-statement string does not work either: drizzle's execute goes through
      // the extended protocol, which refuses multiple commands.
      await owner.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql.raw(sqlText));
      });
      return;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const lockish = /lock_timeout|deadlock detected|canceling statement/i.test(msg);
      if (!lockish || attempt === ATTEMPTS) throw e;
      // Last try: clear anything else still attached to this database, then go again.
      if (attempt === ATTEMPTS - 1) {
        await owner.db
          .execute(
            sql`select pg_terminate_backend(pid) from pg_stat_activity
                where datname = current_database() and pid <> pg_backend_pid()`,
          )
          .catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

export async function resetDb() {
  // Overrides are per-test state; leaking them across files is the ADR-0071 isolation bug in a new coat.
  clearHarnessEntitlementOverrides();
  await truncateAllTables();
  // ADR-0072: TRUNCATE tenant also drops the reserved system tenant that pre-auth auth events FK to
  // (app.append_auth_event stamps tenant 0…0 for login-failed / reset-request). Re-seed it (idempotent)
  // so the auth-audit writer keeps working across tests. Real tenants are seeded per-test as usual.
  await owner.db.execute(
    sql`INSERT INTO tenant (id, workos_org_id, name)
        VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'org_system_auth_audit', 'System (auth audit)')
        ON CONFLICT (id) DO NOTHING`,
  );
}

export async function closeAll() {
  await appClient.end({ timeout: 5 });
  await owner.client.end({ timeout: 5 });
}

export type Base = {
  tenantId: string;
  companyId: string;
  deptA: string;
  deptB: string;
  positionId: string;
  costCenterId: string;
  annualLeaveTypeId: string;
  adminUserId: string;
};

export async function seedBase(): Promise<Base> {
  const [t] = await owner.db
    .insert(schema.tenant)
    .values({ workosOrgId: `org_${randomUUID()}`, name: 'Acme Group' })
    .returning({ id: schema.tenant.id });
  const tenantId = t.id;
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId, legalName: 'Acme Sdn Bhd' })
    .returning({ id: schema.company.id });
  const [da] = await owner.db
    .insert(schema.department)
    .values({ tenantId, companyId: c.id, name: 'Finance' })
    .returning({ id: schema.department.id });
  const [dbp] = await owner.db
    .insert(schema.department)
    .values({ tenantId, companyId: c.id, name: 'Operations' })
    .returning({ id: schema.department.id });
  const [pos] = await owner.db
    .insert(schema.position)
    .values({ tenantId, companyId: c.id, title: 'Executive' })
    .returning({ id: schema.position.id });
  const [cc] = await owner.db
    .insert(schema.costCenter)
    .values({ tenantId, companyId: c.id, code: 'CC1', name: 'HQ' })
    .returning({ id: schema.costCenter.id });
  const [lt] = await owner.db
    .insert(schema.leaveType)
    // Configurable Negative Leave Balance Validation (0ef0defd): the PRODUCTION default for the new
    // allow_negative_balance column is false (block over-application at submission). The shared test fixture,
    // however, has always submitted leave against this ANNUAL type WITHOUT seeding a ledger balance — dozens of
    // balance-agnostic tests (backdating, documents, eligibility, approvals, …) rely on that. So the fixture
    // opts ANNUAL OUT of the submit-time balance gate (true) to preserve those tests unchanged; tests that
    // specifically exercise the balance gate create their own type and set the flag explicitly. The
    // approval-time guard (finalizeLeaveApproval) is unaffected by this flag and still fires as before.
    .values({ tenantId, code: 'ANNUAL', name: 'Annual Leave', paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  // No default leave_policy here: policies now genuinely override the statutory floor
  // (max(floor, policy) at grant), so the base tenant stays floor-only and tests that
  // exercise policies create their own.
  const [au] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId, appUserId: au.id, companyId: null, role: 'hr_admin' });

  // ADR-0077 slice 1 — the tenant's default entitlements and settings, via the OWNER connection (both
  // tables are SELECT-only or scope-gated to ai_hr_app by design, migration 0313).
  //
  // THE SET IS NOT DEFINED HERE. It is `LEGACY_ENABLED_MODULE_CODES` / `LEGACY_ENABLED_SETTINGS` in
  // packs/catalog.ts, shared with migration 0313's backfill (existing tenants) and db/seed.ts (the demo
  // tenant) — because a parity set that only the test harness knows is not parity, it is a fixture that
  // makes the suite agree with itself while production diverges. That was the original shape of this
  // comment and it was wrong.
  //
  // NARROWED BY THE LIVE ENV, and that is the point rather than a shortcut. The deployment parity set
  // and the set THIS PROCESS runs with are different, because test/env.ts deliberately deletes
  // MULTI_CYCLE_PAYROLL_ENABLED / TYPED_PAY_COMPONENTS_ENABLED / PAYROLL_RESET_ENABLED so the suite
  // exercises the legacy payroll path. Seeding ACTIVE rows for those would be the OPPOSITE of parity —
  // it would switch multi-cycle payroll on for 299 test files the moment slice 3 reads rows instead of
  // env. `legacyEnabledModulesIn(process.env)` makes the row and the flag agree in every environment,
  // including the files that opt a flag in per-test before calling seedBase.
  //
  // WHERE THIS DIVERGES, AND IT IS NOT FOUR FILES. This comment used to name four (the
  // NOTIFICATIONS_ENABLED deleters) as the sole exception. The real number is 46, because the seed set
  // is computed ONCE, here, in beforeEach — while most opt-in files mutate their gate INSIDE the test
  // body, i.e. after this ran. Ordering, not intent, decides whether a row exists:
  //   - test/payroll-reset.test.ts sets PAYROLL_RESET_ENABLED BEFORE seedBase → it gets a row;
  //   - test/multicycle-kernel.test.ts sets MULTI_CYCLE_PAYROLL_ENABLED AFTER → it does not.
  // And the SETTING axis is EMPTY for everyone: test/env.ts deletes all nine tracked gates, so
  // `legacyEnabledSettingsIn` returns the empty set and no test tenant in the suite carries a
  // tenant_setting row until a test writes one with `setSetting`.
  //
  // That last sentence used to read "…and nothing sets PAYROLL_UNLOCK_ENABLED or
  // INDIVIDUAL_TXN_PAY_ENABLED", which was a claim about an UNTRACKED file (test/env.ts loads
  // `.env.local`) that .env.example directly contradicted — it ships PAYROLL_UNLOCK_ENABLED
  // uncommented, and a developer who copied it seeded a tenant_setting row into every test tenant and
  // into adminCtx's snapshot while CI ran with neither. test/env.ts now deletes the whole set and
  // test/module-catalog-drift.test.ts → "the suite's entitlement BASELINE is empty" ASSERTS it, so this
  // paragraph describes a pinned fact rather than a hope about someone's machine.
  //
  // Both facts are now ASSERTED rather than described: `test/module-catalog-drift.test.ts` →
  // 'the slice-3 worklist is a pinned inventory' greps every test file for a mutation of a tracked gate
  // and pins the file→gates map. That map IS slice 3's worklist — each listed file needs a matching
  // `setModule` / `setSetting` call when its gate stops being an env read — and a new file that mutates
  // a gate turns the suite red until it is added, instead of surfacing as an unattributed failure two
  // slices later. Prose could not be trusted with this: it was wrong by an order of magnitude.
  const modules = legacyEnabledModulesIn(process.env);
  if (modules.length > 0) {
    await owner.db.insert(schema.tenantModule).values(
      modules.map((moduleCode) => ({ tenantId, moduleCode, status: 'active' })),
    );
  }
  const settings = legacyEnabledSettingsIn(process.env);
  if (settings.length > 0) {
    await owner.db.insert(schema.tenantSetting).values(
      settings.map(({ key, value }) => ({ tenantId, key, value, source: 'platform' })),
    );
  }

  return {
    tenantId,
    companyId: c.id,
    deptA: da.id,
    deptB: dbp.id,
    positionId: pos.id,
    costCenterId: cc.id,
    annualLeaveTypeId: lt.id,
    adminUserId: au.id,
  };
}

export async function createAppUser(
  tenantId: string,
  personId: string,
  role: 'employee' | 'manager' | 'hr_admin' | 'super_admin',
): Promise<string> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId, appUserId: u.id, companyId: null, role });
  return u.id;
}

export async function ledgerBalance(employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)),
    );
  return Number(row?.bal ?? 0);
}

export async function eventTypesFor(tenantId: string, aggregateId: string): Promise<string[]> {
  const rows = await owner.db
    .select({ t: schema.domainEvent.eventType })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, tenantId), eq(schema.domainEvent.aggregateId, aggregateId)));
  return rows.map((r) => r.t);
}

/** The payload of the latest (highest-sequence) event of a given type for an aggregate. */
export async function latestEventPayload(
  tenantId: string,
  aggregateId: string,
  eventType: string,
): Promise<Record<string, unknown> | null> {
  const rows = await owner.db
    .select({ payload: schema.domainEvent.payload, seq: schema.domainEvent.sequence })
    .from(schema.domainEvent)
    .where(
      and(
        eq(schema.domainEvent.tenantId, tenantId),
        eq(schema.domainEvent.aggregateId, aggregateId),
        eq(schema.domainEvent.eventType, eventType),
      ),
    );
  if (rows.length === 0) return null;
  rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  return (rows[rows.length - 1].payload ?? null) as Record<string, unknown> | null;
}

/**
 * Turn a module on or off for a tenant (owner connection — the app role can never write these).
 * `status: null` DELETES the row, which is how a test asserts the disabled path: a missing row is
 * disabled (C7), and that is a different state from an explicit `status='disabled'` row.
 *
 * `expiresAt` is the second half of what the resolver actually reads (`expires_at IS NULL OR expires_at
 * > now()`). It is a parameter rather than something a test writes by hand precisely so the in-memory
 * mirror below can stay in step with it: an expired grant that reached the table by raw SQL would read
 * ON through `adminCtx` and OFF through a real session.
 */
export async function setModule(
  tenantId: string,
  moduleCode: string,
  status: 'active' | 'trial' | 'disabled' | null,
  companyId: string | null = null,
  expiresAt: Date | null = null,
): Promise<void> {
  await owner.db.execute(
    sql`DELETE FROM tenant_module WHERE tenant_id = ${tenantId} AND module_code = ${moduleCode}
        AND COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(${companyId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
  );
  if (status !== null) {
    await owner.db.insert(schema.tenantModule).values({ tenantId, moduleCode, companyId, status, expiresAt });
  }
  // Mirror it, so a context built AFTER this call sees it (see HARNESS_MODULE_OVERRIDES).
  //
  // An ALREADY-EXPIRED grant is mirrored as absent, matching the resolver. Note the mirror is a
  // point-in-time copy either way: a grant that expires later in the test's wall-clock life stays ON in
  // a snapshot resolved before it lapsed, which is exactly how a real session behaves too.
  const live = status !== null && (expiresAt === null || expiresAt.getTime() > Date.now());
  if (companyId == null) {
    const m = HARNESS_MODULE_OVERRIDES.get(tenantId) ?? new Map<string, string | null>();
    m.set(moduleCode, live ? status : 'disabled');
    HARNESS_MODULE_OVERRIDES.set(tenantId, m);
  } else {
    // THE COMPANY GRAIN, mirrored too (slice 3 review). It used to be dropped with the note "a
    // company-scoped grant needs entitledCtx" — which described a limitation rather than removing one:
    // `toSnapshot` builds `scopedModules` from exactly these rows and `moduleEnabled` step 6 reads them,
    // so a fixture that silently modelled none of it answered a narrower question than the application
    // for the ~247 files that use adminCtx. Mirroring costs nothing and closes the axis.
    const sc = HARNESS_SCOPED_MODULE_OVERRIDES.get(tenantId) ?? new Map<string, Set<string>>();
    const forCode = sc.get(moduleCode) ?? new Set<string>();
    if (live) forCode.add(companyId);
    else forCode.delete(companyId);
    sc.set(moduleCode, forCode);
    HARNESS_SCOPED_MODULE_OVERRIDES.set(tenantId, sc);
  }
}

/**
 * Set a tenant's commercial standing, mirroring it the same way `setModule` mirrors a grant.
 *
 * WHY IT EXISTS (slice 3 review). `moduleEnabled` step 5 is
 * `if (!TENANT_STATUS_GOOD_STANDING.has(snap.tenantStatus)) return false` — the branch that closes EVERY
 * billable module for a suspended or closed tenant, and the branch `toSnapshot`'s
 * TENANT_STATUS_UNRESOLVED fail-closed fix feeds. `harnessSnapshot` hardcoded `tenantStatus: 'active'`,
 * so no test could suspend a tenant and then drive a call through `adminCtx`: the fixture said ON where
 * a real session said OFF. That is the same class of defect as the exemption marker this slice removed,
 * one axis over. Slice 9's suspension overlay hangs off this field, so it needed a fixture before then.
 */
export async function setTenantStatus(
  tenantId: string,
  status: 'active' | 'trial' | 'suspended' | 'closed',
): Promise<void> {
  await owner.db.execute(sql`UPDATE tenant SET status = ${status} WHERE id = ${tenantId}`);
  HARNESS_TENANT_STATUS.set(tenantId, status);
}

/** Set a tenant's value for a setting key (owner connection — bypasses the scope policy on purpose). */
export async function setSetting(tenantId: string, key: string, value: unknown): Promise<void> {
  const sm = HARNESS_SETTING_OVERRIDES.get(tenantId) ?? new Map<string, unknown>();
  sm.set(key, value);
  HARNESS_SETTING_OVERRIDES.set(tenantId, sm);
  await owner.db
    .insert(schema.tenantSetting)
    .values({ tenantId, key, value, source: 'platform' })
    .onConflictDoUpdate({
      target: [schema.tenantSetting.tenantId, schema.tenantSetting.key],
      set: { value, source: 'platform' },
    });
}

/**
 * The snapshot `adminCtx` carries — built from the SAME two helpers `seedBase` uses to decide which
 * rows to insert, so the context and the database cannot disagree.
 *
 * Synthetic and synchronous on purpose: `adminCtx` is called inline by ~247 files and cannot become
 * async without touching all of them. It is safe precisely because it is derived, not guessed —
 * `seedBase` inserts `legacyEnabledModulesIn(process.env)` and `legacyEnabledSettingsIn(process.env)`,
 * and this reads the same two functions against the same env.
 */
/**
 * What `setModule` / `setSetting` have changed for a tenant, mirrored in memory.
 *
 * WHY THIS EXISTS. `adminCtx` is SYNCHRONOUS (247 files call it inline), so its snapshot cannot query
 * the database. Deriving it from `process.env` alone made it agree with a freshly-seeded tenant but
 * NOT with one a test had since modified: a test could `await setModule(t, 'notifications', 'active')`
 * and then dispatch through `adminCtx(b)`, which still answered from the env and never saw the row.
 * That is invisible rather than red — the grant silently does nothing, and on a machine whose
 * .env.local happens to set the flag the test passes for the wrong reason while failing in CI.
 * test/notifications.test.ts was exactly this shape.
 *
 * Mirroring the writes keeps the two in step without making adminCtx async: `setModule` updates the
 * row AND this map, so any context built afterwards reflects it. `entitledCtx` still resolves the real
 * rows and remains the stricter choice; this just removes the trap from the common one.
 */
const HARNESS_MODULE_OVERRIDES = new Map<string, Map<string, string | null>>();
const HARNESS_SETTING_OVERRIDES = new Map<string, Map<string, unknown>>();
/** tenantId → moduleCode → the companyIds holding a live company-scoped grant (`toSnapshot`'s shape). */
const HARNESS_SCOPED_MODULE_OVERRIDES = new Map<string, Map<string, Set<string>>>();
/** tenantId → `tenant.status`. Absent = 'active', which is what `seedBase` inserts. */
const HARNESS_TENANT_STATUS = new Map<string, string>();

/**
 * The statuses that resolve ENABLED — an ALLOW-list, mirroring `snapshotQuery`'s
 * `status IN ('active','trial')` rather than restating it as a deny-list.
 *
 * The first mirror asked "is it null or 'disabled'?" and treated everything else as on. That is not the
 * same predicate: `setModule(t, code, 'suspended')` — or any status a later migration adds to the
 * `tenant_module.status` CHECK — read ON through `adminCtx` and OFF through a real session. A fixture
 * used by ~247 files answering a different question than the application is the exact defect this slice
 * exists to remove, reintroduced one level down; it was latent only because the suite happens to use
 * just 'active' / 'trial' / 'disabled' / null today. `test/entitlement-resolver.test.ts` now asserts the
 * two agree over a status matrix rather than trusting this comment.
 */
const MODULE_STATUS_ENABLED: ReadonlySet<string> = new Set(['active', 'trial']);

/** Cleared by resetDb, so overrides can never leak between test files. */
export function clearHarnessEntitlementOverrides(): void {
  HARNESS_MODULE_OVERRIDES.clear();
  HARNESS_SETTING_OVERRIDES.clear();
  HARNESS_SCOPED_MODULE_OVERRIDES.clear();
  HARNESS_TENANT_STATUS.clear();
}

/**
 * The snapshot `adminCtx` carries. Every field the resolver reads is modelled — the four axes are
 * tenant-wide grants, COMPANY-SCOPED grants, settings and TENANT STANDING — because a fixture used by
 * ~247 files that models three of them answers a narrower question than the application does, silently.
 * `test/entitlement-resolver.test.ts` pins the mirror against the real resolver over all four.
 */
function harnessSnapshot(tenantId: string): EntitlementSnapshot {
  return {
    // The snapshot names the tenant it belongs to — slice 2's attribution guard refuses a snapshot
    // resolved for one tenant being asked about another.
    tenantId,
    enabledModules: (() => {
      const set = new Set(legacyEnabledModulesIn(process.env));
      for (const [code, status] of HARNESS_MODULE_OVERRIDES.get(tenantId) ?? []) {
        if (status !== null && MODULE_STATUS_ENABLED.has(status)) set.add(code);
        else set.delete(code);
      }
      return [...set];
    })(),
    scopedModules: Object.fromEntries(
      [...(HARNESS_SCOPED_MODULE_OVERRIDES.get(tenantId) ?? [])]
        .filter(([, companies]) => companies.size > 0)
        .map(([code, companies]) => [code, [...companies]]),
    ),
    settings: {
      ...Object.fromEntries(legacyEnabledSettingsIn(process.env).map((s) => [s.key, s.value])),
      ...Object.fromEntries(HARNESS_SETTING_OVERRIDES.get(tenantId) ?? []),
    },
    tenantStatus: HARNESS_TENANT_STATUS.get(tenantId) ?? 'active',
  };
}

/**
 * The standard admin fixture context.
 *
 * WHY THIS CARRIES A REAL SNAPSHOT AND NOT `entitlementsExempt: 'harness'`
 * -----------------------------------------------------------------------
 * It used to carry the exemption marker, and that was a genuine defect rather than a convenience.
 * An exempt context answers TRUE for every catalogued module, so the moment slice 3 made the kernel
 * read entitlements instead of env, all 247 adminCtx files silently switched FOUR modules ON that the
 * suite had always run with OFF — `typed_pay_components`, `multi_cycle_payroll`, `toil`,
 * `notifications`.
 *
 * That is not a cosmetic difference. With `typed_pay_components` on, `earningsOf`
 * (core/payroll.ts) sources allowance/overtime/bonus ONLY from typed component rows, which no test
 * tenant has — so `compensation.monthlyAllowance` and payroll_input overtime were being silently
 * DROPPED from every payslip. Worse, most assertions did not notice: comparisons between two
 * employees stayed byte-identical because both lost the allowance equally, and only an absolute-figure
 * assertion caught it. Anyone "fixing" those absolute figures downward would have baked a silent
 * allowance loss into a fully green suite.
 *
 * `seedBase` already goes to real trouble to seed exactly the env-parity set (see its comment). The
 * exemption defeated that from the other side: the two halves of the harness contradicted each other.
 * Deriving the snapshot from the same helpers makes them agree by construction — and, as a bonus, lets
 * these files actually demonstrate a gate CLOSING, which an exempt context structurally never could.
 */
export function adminCtx(b: Base): SessionContext {
  return { tenantId: b.tenantId, userId: b.adminUserId, roles: ['hr_admin'], entitlements: harnessSnapshot(b.tenantId) };
}

/**
 * The fixture context that can actually EXERCISE A GATE — a REAL snapshot, resolved from this tenant's
 * rows, with no exemption marker.
 *
 * HOW THIS DIFFERS FROM `adminCtx` (corrected in slice 3 — the previous text here was wrong once the
 * exemption was removed, and a comment that lies about a fixture's semantics is how the next
 * conversion goes wrong):
 *
 * `adminCtx` carries a SYNTHETIC snapshot derived from `legacyEnabledModulesIn(process.env)` — the
 * same helper `seedBase` uses to choose its rows — so it answers exactly what the seeded tenant has,
 * and a gate CAN close through it. `entitledCtx` resolves the tenant's REAL rows from the database.
 *
 * Prefer `entitledCtx` when the test manipulates entitlements mid-test (setModule/setSetting after
 * the context was built), because a synthetic snapshot is a point-in-time copy and will not see the
 * change. Prefer `adminCtx` for the ~247 files that simply exercise the feature behind a gate: it is
 * synchronous, and it is now honest about what the tenant actually has.
 *
 * Slice 3's acceptance criterion is unchanged: every gate it installs has at least one test proving
 * the REFUSAL, not merely the feature behind it.
 *
 * Resolved as the OWNER, which bypasses RLS — right here, because what it fixtures is the resolver's
 * SEMANTICS, not the policies. `test/entitlement-resolver.test.ts` owns the under-RLS coverage.
 *
 * Call it AFTER the `setModule`/`setSetting` calls a test needs: the snapshot is a point-in-time read,
 * exactly as it is for a real session, so a grant written afterwards is not in it.
 */
export async function entitledCtx(b: Base, roles: string[] = ['hr_admin']): Promise<SessionContext> {
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, b.tenantId));
  return { tenantId: b.tenantId, userId: b.adminUserId, roles, entitlements };
}
