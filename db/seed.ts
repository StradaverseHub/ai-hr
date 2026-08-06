/**
 * Demo seed for local dev (resets the dev DB to a known state).
 * Run: `pnpm db:seed`  — structural data via the owner role, employees via the real
 * hireEmployee service (so the seed also exercises the service path).
 */
import { and, eq, sql } from 'drizzle-orm';
import { createDb, type SessionContext } from './client';
import * as schema from './schema';
import { hireEmployee, setCostAllocation, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, requestAttendanceCorrection } from '../packs/attendance/service';
import { requestLeave, decideLeave, addLeaveAttachment, accrueEarnedLeave } from '../core/leave';
import { createJobGrade, setLeaveTypeRules } from '../core/admin';
// 6e9a126e RELEASE THREE — the demo's entitlement is configured through the TEMPLATE layer now.
// createLeavePolicy is gone with leave_policy; these are its replacements.
import { createEntitlementTemplate, createEligibilityRule } from '../core/entitlement-template';
import { createCycle, openCycle, submitManagerReview, submitSelfReview } from '../packs/performance/service';
// Rung 5c (ADR-0080 D1) — the demo statutory profile is written through the pack registry, not a
// direct localization/my import (myPack was already unused here). requirePackFor fails closed for an
// unknown country (D3); the demo company is MY.
import { requirePackFor } from '../localization/registry';
import { seedGuides } from './seed-guides';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { createAdminChain, seedCompanyCatalogs, seedTenantCatalogs } from './provision';
import { seedCatalogs } from '../scripts/seed-catalogs';
import { legacyEnabledModulesIn, legacyEnabledSettingsIn } from '../packs/catalog';

const DEV_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEV_ADMIN_USER_ID = '22222222-2222-2222-2222-222222222222';
/** The dedicated OPERATOR dev identity (0295) — separate login, separate tier, never the HR admin. */
const DEV_OPERATOR_USER_ID = '33333333-3333-3333-3333-333333333333';

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);

const TABLES = [
  'tenant', 'company', 'person', 'position', 'department', 'cost_center', 'employment',
  'assignment', 'reporting_line', 'job_grade', 'leave_type', 'leave_ledger',
  'leave_request', 'resignation_request', 'app_user', 'role_assignment', 'domain_event',
  'compensation', 'employee_statutory_my', 'tenant_counter',
  'attendance', 'attendance_policy', 'payroll_batch', 'payslip', 'company_statutory_my',
  'location', 'kb_document', 'tenant_provision_request',
];

async function main() {
  console.log('Resetting dev database…');
  await owner.db.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));

  await owner.db.insert(schema.tenant).values({ id: DEV_TENANT_ID, workosOrgId: 'org_dev', name: 'Demo Group' });
  // Group structure (ADR-0009): a holding company over the operating entity.
  const [holding] = await owner.db
    .insert(schema.company)
    .values({ tenantId: DEV_TENANT_ID, legalName: 'Demo Group Holdings Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  const [company] = await owner.db
    .insert(schema.company)
    .values({
      tenantId: DEV_TENANT_ID,
      legalName: 'Demo Sdn Bhd',
      country: 'MY',
      currency: 'MYR',
      parentCompanyId: holding.id,
      defaultWorkState: 'Selangor', // 2C: HQ default; employees without an explicit work_state inherit it
    })
    .returning({ id: schema.company.id });
  // 2B-2 (ADR-0039): an explicit approval chain for the demo company (direct manager → HR), so the
  // editor shows a configured policy.
  //
  // r79 0322 — this TWO-level chain is now the whole reason the company runs multi-step approval; the
  // `leaveMultiApproval: true` that used to sit on the company row above is gone with the switch itself.
  await owner.db.insert(schema.leaveApprovalPolicy).values({
    tenantId: DEV_TENANT_ID,
    companyId: company.id,
    leaveTypeId: null,
    levels: ['direct_manager', 'hr_admin'],
  });
  // r79 0322 — and the HOLDING company gets an explicit ONE-level chain, which is how a company says
  // "single approver" now. It used to say it by leaving leaveMultiApproval at its false default; without
  // this row it would resolve to the built-in direct_manager → hr_admin fallback and the single-step
  // Partial Leave Approval demo seeded further down would stop producing per-date rows.
  await owner.db.insert(schema.leaveApprovalPolicy).values({
    tenantId: DEV_TENANT_ID,
    companyId: holding.id,
    leaveTypeId: null,
    levels: ['direct_manager'],
  });
  await owner.db.insert(schema.companyStatutoryMy).values({
    tenantId: DEV_TENANT_ID,
    companyId: company.id,
    epfEmployerNo: 'A1234567890',
    socsoEmployerCode: 'B9876543',
    lhdnEmployerNo: 'E1234567890',
    myinvoisTin: 'C12345678901',
    ssmRegistrationNo: '202301012345',
  });
  const [finance] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Finance' })
    .returning({ id: schema.department.id });
  const [ops] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Operations' })
    .returning({ id: schema.department.id });
  const [eng] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, name: 'Engineering' })
    .returning({ id: schema.department.id });
  const [pos] = await owner.db
    .insert(schema.position)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, title: 'Executive' })
    .returning({ id: schema.position.id });
  await owner.db
    .insert(schema.costCenter)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, code: 'HQ', name: 'Headquarters' });
  // ── Starter catalogs: THE SHARED LAYER (db/provision.ts) ──────────────────────────────────────
  // Leave types, public holidays and the profile-option catalogs (tenant-wide), then the per-company
  // attendance policy + payroll cycle catalog. These are the SAME functions a real customer is
  // provisioned with, which is the point: the demo and real onboarding cannot drift apart on starter
  // settings, because there is only one definition of them.
  //
  // Scope of the sharing is deliberately the CATALOG layer only — the demo's two-company ADR-0009
  // structure, approval policies, sample people and transactions stay here and are never pulled into
  // provisioning. `holding` takes the payroll cycle catalog but NOT an attendance policy, exactly as
  // before this refactor (only the operating company has ever had one, and the demo's attendance
  // fixtures are built on that).
  // ADR-0077 C11: the installation-wide catalogs, before anything tenant-scoped can reference them.
  // Outside the transaction below because it is installation-level, not part of this tenant's seed.
  await seedCatalogs(owner.db);

  // ADR-0077 slice 1 — the demo tenant's entitlements and settings. It is created HERE, after
  // migrations, so 0313's backfill (which covers tenants that already existed) never sees it; without
  // these rows the demo would be the one deployment that reads as "everything disabled" once slice 2's
  // fail-closed resolver lands. Same constants the backfill and the test harness use, so all three
  // cannot drift — but narrowed to what THIS process's env actually has on, which the migration cannot
  // do and which is what keeps the row and the flag saying the same thing on every box.
  const seedModules = legacyEnabledModulesIn(process.env);
  if (seedModules.length > 0) {
    await owner.db.insert(schema.tenantModule).values(
      seedModules.map((moduleCode) => ({ tenantId: DEV_TENANT_ID, moduleCode, status: 'active' })),
    );
  }
  const seedSettings = legacyEnabledSettingsIn(process.env);
  if (seedSettings.length > 0) {
    await owner.db.insert(schema.tenantSetting).values(
      seedSettings.map(({ key, value }) => ({ tenantId: DEV_TENANT_ID, key, value, source: 'platform' })),
    );
  }

  const leaveTypeIds = await owner.db.transaction(async (tx) => {
    const ids = await seedTenantCatalogs(tx, DEV_TENANT_ID);
    await seedCompanyCatalogs(tx, DEV_TENANT_ID, company.id);
    // `entitlementsExempt: 'seeding'` for the same reason as every other synthetic context in this
    // file: the seeder runs as the owner with no session. Round 3 caught this ONE call unmarked while
    // the identical call in db/provision.ts:140 was marked — `seedPayrollCycleCatalog` is payroll-module
    // functionality, so the first gate slice 3 puts on it would have killed `pnpm db:seed`.
    await seedPayrollCycleCatalog({ tenantId: DEV_TENANT_ID, entitlementsExempt: 'seeding' }, holding.id, tx);
    return ids;
  });
  const annual = { id: leaveTypeIds.ANNUAL };
  // Partial Leave Approval demo (ADR-0068): opt ANNUAL into per-date approval so a tester can actually reach
  // the feature. ANNUAL is full-day + working_days-counted, which the gate requires. The primary demo
  // `company` runs a MULTI-STEP chain (its two-level default policy above), where per-date approval intentionally
  // falls back to the whole-request flow — so the reachable scenario lives in the single-step `holding`
  // company below (see "Partial Leave Approval demo — single-step" block).
  await owner.db.update(schema.leaveType).set({ perDateApproval: true }).where(eq(schema.leaveType.id, annual.id));
  // R18 7e532d23: also opt the medical (SICK) type into per-date approval so reseeds demo the admin toggle on
  // more than one type. NOTE the runtime gate (core/leave.ts requestLeave) additionally requires
  // counting === 'working_days' — the MY pack counts SICK in calendar days (EA s.60F practice), so a SICK
  // request only decomposes into per-date rows if an admin also switches its counting. The platform default
  // (leave_type.per_date_approval = false) is deliberately unchanged.
  await owner.db.update(schema.leaveType).set({ perDateApproval: true }).where(eq(schema.leaveType.id, leaveTypeIds.SICK));
  // Standing entitlements granted on every hire (EA s.60E / s.60F via the MY pack).
  const standingGrants = [
    { id: leaveTypeIds.ANNUAL, code: 'ANNUAL' },
    { id: leaveTypeIds.SICK, code: 'SICK' },
    { id: leaveTypeIds.HOSPITALIZATION, code: 'HOSPITALIZATION' },
  ];
  // (National + state public holidays are seeded by seedTenantCatalogs above — see the shared-layer note.)
  // Holiday grouping: one illustrative multi-state group (no holiday re-tagging). Assigned to a demo
  // employee below so the group path resolving e.g. Sarawak Day / Pesta Kaamatan is demonstrable.
  const [eastMalaysiaGroup] = await owner.db
    .insert(schema.holidayGroup)
    .values({ tenantId: DEV_TENANT_ID, name: 'East Malaysia', states: ['Sabah', 'Sarawak', 'Labuan'] })
    .returning({ id: schema.holidayGroup.id });
  // ADR-0054: demo locations. HQ (Selangor = the company default, so no reclassification of existing data)
  // and a Kuching site (Sarawak) — assigned below to Mei Ling, whose work_state is ALREADY Sarawak, so her
  // attendance classification is unchanged by the location (the location merely confirms her state).
  const [hqLocation] = await owner.db
    .insert(schema.location)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, code: 'HQ', name: 'Headquarters', country: 'MY', state: 'Selangor' })
    .returning({ id: schema.location.id });
  const [kuchingLocation] = await owner.db
    .insert(schema.location)
    .values({ tenantId: DEV_TENANT_ID, companyId: company.id, code: 'KCH', name: 'Kuching Office', country: 'MY', state: 'Sarawak' })
    .returning({ id: schema.location.id });
  // The dev admin is a real principal in the audit trail: link it to a person so its actions resolve to
  // a name ("HR Admin") instead of the bare actor type. No employment, so it never appears in People /
  // org / headcount — it's a back-office identity, not an employee.
  //
  // Built by the SHARED createAdminChain (db/provision.ts), the same function that makes a real
  // customer's first admin — so the two cannot drift on the person → app_user → grant shape. Two
  // demo-only pins: the fixed app_user id the dev switcher resolves, and the 'user_dev_admin'
  // placeholder subject. And withRoleAssignment: TRUE, which is the inverse of provisioning — the demo
  // mints no invitation, so nothing else would ever grant the role, whereas a provisioned admin gets
  // exactly one grant from app.consume_invitation when they activate.
  await owner.db.transaction(async (tx) => {
    await createAdminChain(tx, DEV_TENANT_ID, {
      email: 'admin@demo.test',
      fullName: 'HR Admin',
      appUserId: DEV_ADMIN_USER_ID,
      workosUserId: 'user_dev_admin',
      withRoleAssignment: true,
    });
  });

  // ── The operator identity (0295) ──────────────────────────────────────────────────────────────
  // A SEPARATE login from the HR admin above, on purpose: operator is an installation tier, not a
  // customer role, and bundling the two grants onto one identity would make it impossible to see in the
  // dev switcher whether a screen is reachable as a plain admin. It gets no employment and no hr_admin
  // grant, so it reaches /operator and nothing else.
  //
  // WITHHELD ON THE GATED DEMO. That deployment runs ALLOW_DEMO_SESSION=true with the switcher live
  // behind SHARE_PASSWORD, so a seeded operator identity would be one dropdown click away for any
  // consultant kicking the tyres. core/operator.ts refuses on that deployment anyway
  // (isDemoDeployment) — this is the second lock, not the only one.
  const operatorGranted = process.env.ALLOW_DEMO_SESSION !== 'true';
  await owner.db.transaction(async (tx) => {
    await createAdminChain(tx, DEV_TENANT_ID, {
      email: 'operator@demo.test',
      fullName: 'Platform Operator',
      appUserId: DEV_OPERATOR_USER_ID,
      workosUserId: 'user_dev_operator',
      withRoleAssignment: false,
    });
    if (operatorGranted) {
      await tx
        .insert(schema.roleAssignment)
        .values({ tenantId: DEV_TENANT_ID, appUserId: DEV_OPERATOR_USER_ID, role: 'operator', companyId: null });
    }
  });

  // ADR-0077 slice 2: the seeder builds contexts directly and runs before any session exists, so it
  // carries the 'seeding' exemption. See ENTITLEMENTS_EXEMPT_REASONS — the marker is checked for
  // MEMBERSHIP at runtime, and a drift test reads this file to prove the exemption names real code.
  const admin: SessionContext = {
    tenantId: DEV_TENANT_ID,
    userId: DEV_ADMIN_USER_ID,
    roles: ['hr_admin'],
    entitlementsExempt: 'seeding',
  };
  // Rung 5c — the demo company's country pack (MY); the statutory profile writes go through it.
  const countryPack = requirePackFor('MY');
  // ADR-0040 (2D): demo ANNUAL *accrues monthly* (earned), not as a lump on hire — so balances grow
  // through the year. Entitlement is the policy's 12 days → 1 day/month; the hire grant skips earned
  // types and accrueEarnedLeave (run after hiring, below) tops each employee up to today's share.
  //
  // r88 (fa3f4ccb): this comment used to read "max(EA floor 8, policy 12) = 12". The statutory floor no
  // longer OVERRIDES configuration — it is a warning now, not a minimum — so the 12 stands on its own.
  // ANNUAL was never at risk (12 > 8), but see the SICK policy below, which WAS.
  // bc36c768 — THE EARNING METHOD IS SET ON THE LEAVE TYPE, NOT ON THE POLICY ROW, and this is the seed's
  // half of the reset. The two `createLeavePolicy(... method: 'earned_monthly' ...)` calls this replaces
  // wrote the method into `leave_policy.accrual` — the duplicated second surface migration 0376 strips
  // from every existing row. A seed that kept writing it would re-introduce, on every fresh tenant, the
  // exact key the reset removes, and the reset would be untrue for anyone provisioned after it.
  //
  // ONE CALL COVERS BOTH POLICY ROWS below (the 12-day group default and the 18-day Executive override),
  // which is the consolidation working as intended: the policy row decides the DAYS, the leave TYPE
  // decides the RULE. Through `setLeaveTypeRules` — the single writer — rather than a direct column
  // update, so the seed exercises the same validation and the same audit event a real save does.
  //
  // accrualDay 1 is stated EXPLICITLY rather than left null. Null means day 1 too, but a demo tenant is
  // the thing people read to learn what a configured leave type looks like, and "configured to credit on
  // the 1st" and "never told us when to credit" should not look identical there.
  await setLeaveTypeRules(admin, { id: annual.id, accrualMethod: 'earned_monthly', accrualDay: 1 });
  // 6e9a126e RELEASE THREE — was createLeavePolicy(annual, 12 days). The TEMPLATE holds the days and an
  // eligibility rule says who gets them; empty criteria means everyone, which is what a grade-less
  // leave_policy row meant.
  const annualStd = await createEntitlementTemplate(admin, {
    leaveTypeId: annual.id,
    name: 'Annual leave — standard',
    serviceBands: [{ fromYears: 0, toYears: null, days: 12 }],
    validFrom: '2026-01-01',
  });
  await createEligibilityRule(admin, {
    name: 'All employees — annual leave',
    templateLineageId: annualStd.lineageId,
    criteria: {},
    validFrom: '2026-01-01',
  });
  // r88 (fa3f4ccb) — SICK MUST BE CONFIGURED EXPLICITLY NOW, and this is the seed's half of a real
  // behaviour change worth understanding.
  //
  // This policy did not exist before. It did not need to: entitlement was max(statutoryFloor, policy),
  // and with no SICK policy at all the EA s.60F floor supplied the days on its own. Once the floor stopped
  // overriding, an UNCONFIGURED statutory leave type resolves to ZERO — so the demo's sick-leave request
  // began failing with InsufficientLeaveBalanceOnSubmitError, and the upgrade rehearsal failed with it.
  //
  // 14 days is the EA s.60F(1)(a) entitlement for under 2 years' service, i.e. the figure the floor used
  // to supply here. Granted UP FRONT rather than earned, which is how sick leave works.
  //
  // THE GENERAL LESSON, which production escaped only by being well configured: after fa3f4ccb, a leave
  // type with no policy and no scheme row grants NOTHING. Production's ANNUAL bands are 20-24 days and
  // SICK 14-22, all at or above the statutory minimum, so no live employee lost a day. A tenant that had
  // been relying on the floor to supply an unconfigured type would have.
  // THIS IS THE ONE THAT BREAKS THE UPGRADE REHEARSAL IF IT IS DROPPED RATHER THAN REPOINTED. The comment
  // above records why: after fa3f4ccb the statutory floor stopped OVERRIDING configuration, so an
  // UNCONFIGURED leave type grants ZERO — the demo's sick-leave request then fails with
  // InsufficientLeaveBalanceOnSubmitError and the rehearsal fails with it.
  const sickStd = await createEntitlementTemplate(admin, {
    leaveTypeId: leaveTypeIds.SICK,
    name: 'Sick leave — statutory',
    serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
    validFrom: '2026-01-01',
  });
  await createEligibilityRule(admin, {
    name: 'All employees — sick leave',
    templateLineageId: sickStd.lineageId,
    criteria: {},
    validFrom: '2026-01-01',
  });
  // ADR-0041 (2E): grade catalog + a grade-scoped ANNUAL policy. Executives earn 18 annual days (vs the
  // 12-day default), so a graded employee (Daniel, below) accrues more — grade-based entitlement, visible.
  const execGrade = await createJobGrade(admin, { code: 'EXEC', name: 'Executive', rank: 1 });
  await createJobGrade(admin, { code: 'NONEXEC', name: 'Non-Executive', rank: 2 });
  // bc36c768: no `method` here either — the type-level rule set above governs every policy row under
  // ANNUAL, this one included. Executives earn 18 days instead of 12; they earn them the same way.
  // The grade override. TWO rules now match an Executive, and the resolver picks the MOST SPECIFIC
  // (core/entitlement-template.ts, orgCriteriaSpecificity) — so one narrowed axis beats the empty-criteria
  // rule above and an Executive earns 18 rather than 12. That ordering is the template layer's job now;
  // it used to be leave_policy's grade column.
  const annualExec = await createEntitlementTemplate(admin, {
    leaveTypeId: annual.id,
    name: 'Annual leave — Executive',
    serviceBands: [{ fromYears: 0, toYears: null, days: 18 }],
    validFrom: '2026-01-01',
  });
  await createEligibilityRule(admin, {
    name: 'Executives — annual leave',
    templateLineageId: annualExec.lineageId,
    criteria: { gradeIds: [execGrade.id] },
    validFrom: '2026-01-01',
  });
  const people: {
    fullName: string;
    email: string;
    dept: string;
    salary: number;
    ic: string;
    bank: string;
    gender: string;
    marital: string;
    workState?: string;
  }[] = [
    { fullName: 'Aisyah Rahman', email: 'aisyah@demo.test', dept: finance.id, salary: 6500, ic: '900101011234', bank: 'Maybank', gender: 'female', marital: 'married' },
    { fullName: 'Daniel Tan', email: 'daniel@demo.test', dept: eng.id, salary: 11000, ic: '850202022345', bank: 'CIMB', gender: 'male', marital: 'married' },
    { fullName: 'Mei Ling', email: 'meiling@demo.test', dept: ops.id, salary: 5800, ic: '920303033456', bank: 'Public Bank', gender: 'female', marital: 'single', workState: 'Sarawak' },
    { fullName: 'Arjun Kumar', email: 'arjun@demo.test', dept: eng.id, salary: 7200, ic: '880404044567', bank: 'RHB', gender: 'male', marital: 'married' },
  ];
  const hired: { employmentId: string; personId: string; session: SessionContext }[] = [];
  let danielPersonId = '';
  for (const [i, p] of people.entries()) {
    const { employmentId, personId } = await hireEmployee(admin, {
      person: { fullName: p.fullName, primaryEmail: p.email },
      companyId: company.id,
      departmentId: p.dept,
      positionId: pos.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-06',
      grantLeaveTypes: standingGrants,
    });
    if (i === 1) danielPersonId = personId;
    // ADR-0038 2A-1: self-declared gender + marital so maternity/paternity eligibility is demonstrable.
    await owner.db.update(schema.person).set({ gender: p.gender, maritalStatus: p.marital }).where(eq(schema.person.id, personId));
    // ADR-0038 2C: work state (Mei Ling in Sarawak) so state-holiday differences are demonstrable.
    if (p.workState) {
      await owner.db.update(schema.employment).set({ workState: p.workState }).where(eq(schema.employment.id, employmentId));
    }
    // ADR-0041 2E: Daniel (the manager) is an Executive, so his ANNUAL accrues on the 18-day grade policy
    // (9 days by late June) vs the 12-day default (6 days) — grade-based accrual, visible in the demo.
    if (i === 1) {
      await owner.db.update(schema.employment).set({ gradeId: execGrade.id }).where(eq(schema.employment.id, employmentId));
    }
    // Local user record + role (login identity itself is provisioned by WorkOS later).
    const role = i === 1 ? 'manager' : 'employee';
    const [u] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: DEV_TENANT_ID, workosUserId: `seed:${p.email}`, personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: DEV_TENANT_ID, appUserId: u.id, role, companyId: null });
    // Their own session — used below so leave requests are authored by the employee (and
    // approvals by their manager), giving the audit trail real, differentiated actors.
    const session: SessionContext = {
      tenantId: DEV_TENANT_ID,
      userId: u.id,
      roles: [role],
      personId,
      entitlementsExempt: 'seeding',
    };
    hired.push({ employmentId, personId, session });

    // ADR-0078 — payMode/paymentTerm/rateAmount are omitted on every seed call: the service defaults a
    // brand-new record to monthly / monthly / no rate, which is exactly what the demo staff are.
    await setCompensation(admin, { employmentId, basicSalary: p.salary, monthlyAllowance: 500, effectiveFrom: '2026-01-06' });
    await countryPack.statutory.set(admin, {
      personId,
      icNumber: p.ic,
      epfNumber: `EPF${p.ic.slice(0, 7)}`,
      socsoNumber: `SOC${p.ic.slice(0, 7)}`,
      taxNumber: `SG${p.ic.slice(0, 8)}`,
      eisEligible: true,
      bankName: p.bank,
      bankAccountNo: `8800${p.ic.slice(0, 8)}`,
    });
  }

  // Holiday grouping: assign Arjun (no bare work_state) to the East-Malaysia group so the group
  // resolution path is demonstrable alongside Mei Ling's single-state (Sarawak) path. XOR-safe: he has
  // no work_state, so only holiday_group_id is set.
  await owner.db
    .update(schema.employment)
    .set({ holidayGroupId: eastMalaysiaGroup.id })
    .where(eq(schema.employment.id, hired[3].employmentId));

  // ADR-0054: set demo locations on the OPEN assignment row (no history churn). Regression-safe:
  // Mei Ling → Kuching (Sarawak) matches her existing work_state Sarawak, and Aisyah → HQ (Selangor)
  // matches the company default, so neither location reclassifies any already-seeded attendance.
  await owner.db
    .update(schema.assignment)
    .set({ locationId: kuchingLocation.id })
    .where(and(eq(schema.assignment.employmentId, hired[2].employmentId), sql`valid_to is null and superseded_at is null`));
  await owner.db
    .update(schema.assignment)
    .set({ locationId: hqLocation.id })
    .where(and(eq(schema.assignment.employmentId, hired[0].employmentId), sql`valid_to is null and superseded_at is null`));

  // Administrative backbone (multi-level) + cross-cutting lines so the org chart can render
  // typed connectors: functional, project, and dotted-line reporting.
  const reportsTo = (
    sub: string,
    mgr: string,
    lineType: 'administrative' | 'functional' | 'project' | 'dotted',
    validFrom = '2026-01-06',
  ) => setReportingLine(admin, { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType, validFrom });
  await reportsTo(hired[0].employmentId, hired[1].employmentId, 'administrative'); // Aisyah -> Daniel
  await reportsTo(hired[3].employmentId, hired[1].employmentId, 'administrative'); // Arjun -> Daniel
  await reportsTo(hired[2].employmentId, hired[0].employmentId, 'administrative'); // Mei Ling -> Aisyah
  await reportsTo(hired[2].employmentId, hired[3].employmentId, 'functional'); // Mei Ling ~ Arjun (functional)
  await reportsTo(hired[3].employmentId, hired[0].employmentId, 'dotted'); // Arjun ~ Aisyah (dotted-line)

  // Concurrent multi-company (ADR-0009): Daniel is also Group CFO at the holding company — a
  // shared-services role whose cost is recharged 50% to the operating company.
  const [groupDept] = await owner.db
    .insert(schema.department)
    .values({ tenantId: DEV_TENANT_ID, companyId: holding.id, name: 'Group Office' })
    .returning({ id: schema.department.id });
  const [groupPos] = await owner.db
    .insert(schema.position)
    .values({ tenantId: DEV_TENANT_ID, companyId: holding.id, title: 'Group CFO' })
    .returning({ id: schema.position.id });
  const daniel2 = await hireEmployee(admin, {
    person: { id: danielPersonId },
    companyId: holding.id,
    departmentId: groupDept.id,
    positionId: groupPos.id,
    employmentType: 'part_time',
    hiredOn: '2026-02-01',
  });
  await setCompensation(admin, {
    employmentId: daniel2.employmentId,
    basicSalary: 4000,
    monthlyAllowance: 0,
    effectiveFrom: '2026-02-01',
  });
  await setCostAllocation(admin, {
    employmentId: daniel2.employmentId,
    allocations: [{ companyId: company.id, percent: 50 }],
  });

  // A couple of recent hires — shape for the Onboarding card and depth for the org chart.
  const nurul = await hireEmployee(admin, {
    person: { fullName: 'Nurul Huda', primaryEmail: 'nurul@demo.test' },
    companyId: company.id,
    departmentId: ops.id,
    positionId: pos.id,
    employmentType: 'full_time',
    hiredOn: '2026-06-04',
    grantLeaveTypes: standingGrants,
  });
  const weijie = await hireEmployee(admin, {
    person: { fullName: 'Wei Jie Lim', primaryEmail: 'weijie@demo.test' },
    companyId: company.id,
    departmentId: eng.id,
    positionId: pos.id,
    employmentType: 'full_time',
    hiredOn: '2026-05-22',
    grantLeaveTypes: standingGrants,
  });
  await reportsTo(nurul.employmentId, hired[3].employmentId, 'administrative', '2026-06-04'); // Nurul -> Arjun
  await reportsTo(weijie.employmentId, hired[0].employmentId, 'administrative', '2026-05-22'); // Wei Jie -> Aisyah
  await reportsTo(weijie.employmentId, hired[2].employmentId, 'project', '2026-05-22'); // Wei Jie ~ Mei Ling (project)
  // Comps under the RM4,000 First Schedule ceiling — they are the OT-eligible demo cases.
  await setCompensation(admin, { employmentId: nurul.employmentId, basicSalary: 3200, effectiveFrom: '2026-06-04' });
  await setCompensation(admin, { employmentId: weijie.employmentId, basicSalary: 3800, effectiveFrom: '2026-05-22' });

  // Live demo punches around the real "today" (ADR-0011: hours/OT derive from the schedule; Aisyah
  // stays rowless today so the approved-leave context pill shows). The attendance policy this reads is
  // seeded by seedCompanyCatalogs above — same default 09:00-18:00 Mon-Fri row as before.
  const seedToday = new Date().toISOString().slice(0, 10);
  const seedYesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // Yesterday: two completed days — Arjun with 90m OT, Wei Jie a clean standard day.
  await checkIn(admin, { employmentId: hired[3].employmentId, date: seedYesterday, time: '09:00' });
  await checkOut(admin, { employmentId: hired[3].employmentId, date: seedYesterday, time: '19:30' });
  await checkIn(admin, { employmentId: weijie.employmentId, date: seedYesterday, time: '09:05' });
  await checkOut(admin, { employmentId: weijie.employmentId, date: seedYesterday, time: '19:05' }); // 60m OT (eligible)
  // Today: Daniel late, Wei Jie present (both still in the office).
  await checkIn(admin, { employmentId: hired[1].employmentId, date: seedToday, time: '09:30' });
  await checkIn(admin, { employmentId: weijie.employmentId, date: seedToday, time: '09:00' });
  // A pending correction so the manager inbox has something to act on (Mei Ling forgot to punch).
  await requestAttendanceCorrection(admin, {
    employmentId: hired[2].employmentId,
    date: seedYesterday,
    checkIn: '09:00',
    checkOut: '18:00',
    reason: 'Forgot to clock in',
  });

  // Planned absences around 'today' (2026-06) so the dashboard timeline has shape.
  const manager = hired[1]; // Daniel — administrative manager of Aisyah and Arjun
  // A tiny stand-in for an uploaded medical certificate, so document-gated demo leave is valid.
  const demoMc = () => Buffer.from('%PDF-1.4\n% Demo medical certificate (seed data)\n');
  const seedLeave = async (
    idx: number,
    leaveTypeId: string,
    startDate: string,
    endDate: string,
    approve: boolean,
    withDoc = false,
  ) => {
    const { employmentId, session } = hired[idx];
    // Authored by the employee (the real-world actor), so the event carries their identity.
    const { leaveRequestId } = await requestLeave(session, { employmentId, leaveTypeId, startDate, endDate, hasDocument: withDoc });
    if (withDoc) {
      await addLeaveAttachment(session, {
        leaveRequestId,
        fileName: 'medical-certificate.pdf',
        mimeType: 'application/pdf',
        content: demoMc(),
      });
    }
    if (approve) {
      try {
        await decideLeave(manager.session, {
          leaveRequestId,
          decision: 'approved',
          deciderEmploymentId: manager.employmentId,
        });
        // 2B-1: a multi-step company needs a second (HR) approval to finalize. Harmless on single-step
        // (the request is already approved, so this branch is skipped).
        const [after] = await owner.db
          .select({ status: schema.leaveRequest.status })
          .from(schema.leaveRequest)
          .where(eq(schema.leaveRequest.id, leaveRequestId));
        if (after?.status === 'pending') {
          await decideLeave(admin, { leaveRequestId, decision: 'approved' });
        }
      } catch (e) {
        console.warn(`  (leave ${startDate} left pending: ${(e as Error).message})`);
      }
    }
  };
  // ADR-0040 (2D): grant everyone their earned-to-date ANNUAL share before any leave is taken below
  // (~6 days by late June for a Jan joiner on a 12-day, earn-monthly policy). Idempotent.
  await accrueEarnedLeave(admin, { asOf: '2026-06-23' });
  await seedLeave(0, annual.id, '2026-06-10', '2026-06-12', true); // Aisyah · annual · approved by Daniel
  await seedLeave(3, annual.id, '2026-06-16', '2026-06-18', true); // Arjun · annual · approved by Daniel
  await seedLeave(2, leaveTypeIds.SICK, '2026-06-09', '2026-06-10', false, true); // Mei Ling · sick · pending · with MC
  await seedLeave(1, annual.id, '2026-06-11', '2026-06-11', false); // Daniel · annual · pending
  // One rejected request so the Leave page's status chips have every state.
  const rejected = await requestLeave(hired[3].session, {
    employmentId: hired[3].employmentId,
    leaveTypeId: leaveTypeIds.SICK,
    startDate: '2026-06-19',
    endDate: '2026-06-19',
    hasDocument: true,
  });
  await addLeaveAttachment(hired[3].session, {
    leaveRequestId: rejected.leaveRequestId,
    fileName: 'medical-certificate.pdf',
    mimeType: 'application/pdf',
    content: demoMc(),
  });
  await decideLeave(manager.session, {
    leaveRequestId: rejected.leaveRequestId,
    decision: 'rejected',
    deciderEmploymentId: manager.employmentId,
    // Partial Leave Approval (0131) made a reject reason mandatory; the seed's demo rejection must supply one
    // or the whole seed aborts here (and never reaches the per-date demo block below).
    rejectReason: 'Insufficient coverage on this date — please reschedule.',
  });

  // Partial Leave Approval demo — single-step (ADR-0068): the primary `company` runs a multi-step chain, where
  // per-date approval intentionally does NOT fire. So the REACHABLE per-date scenario lives in the `holding`
  // company, which is single-step (its ONE-level default policy above). We hire one employee there reporting
  // to Daniel (already Group CFO at holding), grant ANNUAL, and file a PENDING 3-working-day ANNUAL request.
  // Because ANNUAL now opts into per-date approval and the company is single-step, requestLeave decomposes the
  // request into per-date rows — so a tester who opens Daniel's approvals inbox sees one row with the
  // expandable per-date breakdown (approve some dates, reject others). Wrapped in try/catch so a demo-data
  // hiccup never fails the whole seed.
  try {
    const pdManager = daniel2; // Daniel's holding-company employment (Group CFO)
    const pdSub = await hireEmployee(admin, {
      person: { fullName: 'Priya Devan', primaryEmail: 'priya@demo.test' },
      companyId: holding.id,
      departmentId: groupDept.id,
      positionId: groupPos.id,
      employmentType: 'full_time',
      hiredOn: '2026-01-06',
      grantLeaveTypes: [{ id: annual.id, code: 'ANNUAL' }],
    });
    const [pdUser] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: DEV_TENANT_ID, workosUserId: 'seed:priya@demo.test', personId: pdSub.personId })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: DEV_TENANT_ID, appUserId: pdUser.id, role: 'employee', companyId: null });
    await reportsTo(pdSub.employmentId, pdManager.employmentId, 'administrative', '2026-01-06');
    // A top-up grant so the 3-day request comfortably clears the finalization balance gate.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: DEV_TENANT_ID,
      employmentId: pdSub.employmentId,
      leaveTypeId: annual.id,
      entryType: 'accrual',
      days: '14.00',
      effectiveOn: '2026-01-06',
    });
    const pdSession: SessionContext = {
      tenantId: DEV_TENANT_ID,
      userId: pdUser.id,
      roles: ['employee'],
      personId: pdSub.personId,
      entitlementsExempt: 'seeding',
    };
    // 3 consecutive working days (Mon–Wed) — left PENDING so the manager can approve some / reject others.
    await requestLeave(pdSession, {
      employmentId: pdSub.employmentId,
      leaveTypeId: annual.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
  } catch (e) {
    console.warn(`  (partial-approval demo skipped: ${(e as Error).message})`);
  }

  // Performance (ADR-0013): a live annual cycle so the module has shape — most reviews sit at
  // self-review; Aisyah's is finalized with a 5% merit recommendation awaiting enactment.
  const { cycleId: perfCycle } = await createCycle(admin, {
    name: '2026 Annual',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    meritBudget: { kind: 'percent', value: 4 },
  });
  await openCycle(admin, { cycleId: perfCycle });
  const [aisyahReview] = await owner.db
    .select({ id: schema.performanceReview.id })
    .from(schema.performanceReview)
    .where(
      and(
        eq(schema.performanceReview.cycleId, perfCycle),
        eq(schema.performanceReview.employmentId, hired[0].employmentId),
      ),
    );
  if (aisyahReview) {
    await submitSelfReview(admin, {
      reviewId: aisyahReview.id,
      selfRating: 4,
      selfComments: 'Strong delivery on the migration; want more cross-team scope next year.',
    });
    await submitManagerReview(admin, {
      reviewId: aisyahReview.id,
      managerRating: 4,
      overallRating: 4,
      managerComments: 'Reliable and high-quality. Ready for more responsibility.',
      recommendedMeritPct: 5,
    });
  }

  const guideCount = await seedGuides(owner.db, DEV_TENANT_ID);

  console.log(`✓ Seeded demo tenant with ${people.length} employees.`);
  console.log(`  ${guideCount} Knowledge Base guides seeded.`);
  console.log(`  DEV_TENANT_ID=${DEV_TENANT_ID}`);
  console.log(`  DEV_USER_ID=${DEV_ADMIN_USER_ID}`);

  await owner.client.end({ timeout: 5 });
  const { client } = await import('./client');
  await client.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
