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
  'assignment', 'reporting_line', 'leave_type', 'leave_policy', 'leave_ledger',
  'leave_request', 'leave_request_date', 'leave_cancellation_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
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
  'tp1_relief',
  'employee_dependent',
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

export async function resetDb() {
  await owner.db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`));
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
  // And the SETTING axis diverges for everyone: under the suite's env (test/env.ts deletes
  // PAYROLL_RESET_ENABLED / AUDIT_HASH_CHAIN_ENABLED, and nothing sets PAYROLL_UNLOCK_ENABLED or
  // INDIVIDUAL_TXN_PAY_ENABLED) `legacyEnabledSettingsIn` returns the EMPTY set, so no test tenant in
  // the suite carries a single tenant_setting row today.
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
 */
export async function setModule(
  tenantId: string,
  moduleCode: string,
  status: 'active' | 'trial' | 'disabled' | null,
  companyId: string | null = null,
): Promise<void> {
  await owner.db.execute(
    sql`DELETE FROM tenant_module WHERE tenant_id = ${tenantId} AND module_code = ${moduleCode}
        AND COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(${companyId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
  );
  if (status !== null) {
    await owner.db.insert(schema.tenantModule).values({ tenantId, moduleCode, companyId, status });
  }
}

/** Set a tenant's value for a setting key (owner connection — bypasses the scope policy on purpose). */
export async function setSetting(tenantId: string, key: string, value: unknown): Promise<void> {
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
function harnessSnapshot(tenantId: string): EntitlementSnapshot {
  return {
    // The snapshot names the tenant it belongs to — slice 2's attribution guard refuses a snapshot
    // resolved for one tenant being asked about another.
    tenantId,
    enabledModules: legacyEnabledModulesIn(process.env),
    scopedModules: {},
    settings: Object.fromEntries(legacyEnabledSettingsIn(process.env).map((s) => [s.key, s.value])),
    tenantStatus: 'active',
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
