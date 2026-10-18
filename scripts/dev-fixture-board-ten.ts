/**
 * Fictional, local-only fixture for the ten approved Attendance board items.
 * Run AFTER migrations/db:seed, with the parent test/release slots released:
 *   node --env-file=.env.local --import tsx scripts/dev-fixture-board-ten.ts
 *
 * Own company, genuinely company-scoped HR, manager and two employees. Real service-created
 * punches feed a DAILY 12.50 ALL policy and a draft run scoped to the first employee. This script
 * does not transfer or process payroll: the browser performs those actions. A completed rerun is
 * read-only and prints current state, preserving browser edits, transfers and processed runs.
 * An interrupted initial run fills missing objects using stable keys, never resets existing rows.
 * Owner writes are limited to fictional HR/login identities and the local demo's module entitlements.
 * All org/attendance/payroll business writes use their real services and pack facades.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { createBusinessUnit, createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { assignDefaultShift, createShift } from '../core/roster';
import {
  allowanceScheduleFactsTx, checkIn, checkOut, createAllowancePolicy, createAttendanceRule,
  emptyAllowanceRules, evaluateAllowancesForPeriod, setAttendancePolicy,
} from '../packs/attendance/service';
import { createBatch, listAttendanceAllowancePayCodes, upsertPayComponent } from '../packs/payroll/service';
import { requirePackFor } from '../localization/registry';
import { addMonths, monthDates } from '../lib/roster-month';
import { todayInKualaLumpur } from '../lib/hr-date';

const refusal = demoSeedRefusal(process.env);
if (refusal) throw new Error(refusal);
if (process.env.NODE_ENV === 'production') throw new Error('Board fixture is local development only.');
const targets = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].map(value => {
  if (!value) throw new Error('Both DATABASE_URL and MIGRATION_DATABASE_URL are required.');
  const target = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '5433') {
    throw new Error('Board fixture requires both connections to the disposable localhost:5433 PostgreSQL.');
  }
  return target;
});
if (targets[0].pathname !== targets[1].pathname) throw new Error('App and owner connections must target the same database.');
if(targets.some(target=>target.pathname!=='/ai_hr_board15_browser') || process.env.TEST_DB_NAMESPACE!=='board15integration')throw new Error('Use the named Board integration database and namespace.');
if(decodeURIComponent(targets[0].username)!=='ai_hr_app'||targets[0].username===targets[1].username)throw new Error('Separate non-owner app and migration roles are required.');

const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const tenantId = DEMO_TENANT_ID;
const companyName = 'Board ten browser (dev fixture)', companyCode = 'BOARD10-DEV';
const policyCode = 'BOARD10_DAILY', ruleName = 'Board ten weekday group (dev fixture)', shiftCode = 'BOARD10_DAY';
const keys = ['hr', 'manager', 'recipient', 'control'] as const;
type Key = typeof keys[number];
type Role = 'hr_admin' | 'manager' | 'employee';
const email = (key: Key) => `board-ten-${key}@demo.test`;
const loginKey = (key: Key) => `board-ten-fixture:${key}`;

async function context(user: {id: string; personId: string | null}): Promise<SessionContext> {
  const grants = await owner.db.select({role: s.roleAssignment.role, companyId: s.roleAssignment.companyId})
    .from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId, tenantId), eq(s.roleAssignment.appUserId, user.id)));
  const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId));
  return {tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map(g => g.role))], grants, entitlements};
}

async function login(key: Key, personId: string, companyId: string, role: Role) {
  let [user] = await owner.db.select().from(s.appUser)
    .where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, loginKey(key))));
  if (!user) [user] = await owner.db.insert(s.appUser)
    .values({tenantId, personId, workosUserId: loginKey(key), onboardedAt: new Date()}).returning();
  if (user.personId !== personId || user.archivedAt) throw new Error(`Existing ${key} login changed; preserving it. Re-seed to rebuild.`);
  const grants = await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
  if (!grants.length) await owner.db.insert(s.roleAssignment).values({tenantId, appUserId: user.id, companyId, role});
  else if (grants.length !== 1 || grants[0].role !== role || grants[0].companyId !== companyId) {
    throw new Error(`Existing ${key} grants changed; fixture will not broaden or reset them.`);
  }
  return user;
}

async function main() {
  const tenants = await owner.db.select({id: s.tenant.id}).from(s.tenant);
  if (!tenants.some(t => t.id === tenantId)) throw new Error('Run db:seed first.');
  if (tenants.some(t => t.id !== tenantId && t.id !== SYSTEM_TENANT_ID)) {
    throw new Error('Refusing board fixture: database contains a non-demo tenant. No override is accepted.');
  }
  // Serialize initial creation across invocations. Services use their own app-role transactions;
  // this reserved owner connection holds only the fixture mutex, never any business-row locks.
  const lock = await owner.client.reserve();
  try {
    await lock`select pg_advisory_lock(hashtextextended('dev-fixture-board-ten',0))`;
    await ensureFixture();
  } finally {
    await lock`select pg_advisory_unlock(hashtextextended('dev-fixture-board-ten',0))`;
    lock.release();
  }
  await owner.client.end();
}

async function ensureFixture() {
  let [company] = await owner.db.select().from(s.company)
    .where(and(eq(s.company.tenantId, tenantId), eq(s.company.companyLabel, companyCode)));
  if (company && company.legalName !== companyName) throw new Error('Fixture company code belongs to another company.');
  if (company) {
    const [policy] = await owner.db.select().from(s.attendanceAllowancePolicy)
      .where(and(eq(s.attendanceAllowancePolicy.companyId, company.id), eq(s.attendanceAllowancePolicy.code, policyCode)));
    const [batch] = await owner.db.select().from(s.payrollBatch)
      .where(and(eq(s.payrollBatch.companyId, company.id), eq(s.payrollBatch.runType, 'regular'))).orderBy(asc(s.payrollBatch.createdAt));
    if (policy && batch) { await manifest(company.id, policy.id, batch.id, true); return; }
  }

  // The product's service-deep module gate asks the tenant-wide question. These are real grants,
  // not entitlementsExempt. Existing active tenant-wide rows remain untouched.
  for (const moduleCode of ['attendance', 'payroll', 'typed_pay_components']) {
    const [module] = await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId, tenantId), eq(s.tenantModule.moduleCode, moduleCode), isNull(s.tenantModule.companyId)));
    if (!module) await owner.db.insert(s.tenantModule).values({tenantId, moduleCode, status: 'active'});
    else if (module.status !== 'active' || module.expiresAt) {
      throw new Error(`Existing ${moduleCode} entitlement is disabled/trial/expiring; activate it explicitly before this fixture.`);
    }
  }
  // Only company creation and missing tenant-global ATTENDANCE catalog creation need the seeded
  // group administrator. The fixture's own HR principal has exactly one company-scoped grant.
  const [seedAdmin] = await owner.db.select().from(s.appUser)
    .where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
  if (!seedAdmin) throw new Error('Seeded dev administrator missing; run db:seed first.');
  const bootstrap = await context(seedAdmin);
  if (!bootstrap.grants?.some(g => g.companyId === null && ['hr_admin', 'super_admin'].includes(g.role))) throw new Error('Seeded dev administrator lacks its group grant.');
  if (!company) {
    const created = await createCompany(bootstrap, {legalName: companyName, companyLabel: companyCode, country: 'MY', currency: 'MYR'});
    [company] = await owner.db.select().from(s.company).where(eq(s.company.id, created.id));
  }
  if (company.archivedAt) throw new Error('Fixture company was archived; preserving it.');
  const companyId = company.id;
  let [hrPerson] = await owner.db.select().from(s.person).where(and(eq(s.person.tenantId, tenantId), eq(s.person.primaryEmail, email('hr'))));
  if (!hrPerson) [hrPerson] = await owner.db.insert(s.person).values({tenantId, fullName: 'Board ten fictional HR', primaryEmail: email('hr')}).returning();
  const hr = await login('hr', hrPerson.id, companyId, 'hr_admin'), a = await context(hr);

  let [bu] = await owner.db.select().from(s.businessUnit).where(and(eq(s.businessUnit.companyId, companyId), eq(s.businessUnit.code, 'BOARD10')));
  if (!bu) { const created = await createBusinessUnit(a, {companyId, code: 'BOARD10', name: 'Board ten fictional team'}); [bu] = await owner.db.select().from(s.businessUnit).where(eq(s.businessUnit.id, created.id)); }
  let [dept] = await owner.db.select().from(s.department).where(and(eq(s.department.companyId, companyId), eq(s.department.name, 'Board ten fictional department')));
  if (!dept) { const created = await createDepartment(a, {companyId, businessUnitId: bu.id, name: 'Board ten fictional department'}); [dept] = await owner.db.select().from(s.department).where(eq(s.department.id, created.id)); }
  let [rule] = await owner.db.select().from(s.attendanceRule).where(and(eq(s.attendanceRule.tenantId, tenantId), eq(s.attendanceRule.name, ruleName)));
  if (!rule) {
    const created = await createAttendanceRule(a, {name: ruleName, weeklyPattern: [1,2,3,4,5], halfPattern: [], offPattern: [6],
      lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false,
      earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
      applyToEarlyOt: false, applyDeductions: false,
      // A real band lets browser checks retain an independent OT draft while saving another section.
      otRows: [{fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: 1.5,
        phRate: null, roundingMode: 'down', roundToMinutes: 15}]});
    [rule] = await owner.db.select().from(s.attendanceRule).where(eq(s.attendanceRule.id, created.id));
  }
  if (rule.status !== 'active') throw new Error('Existing fixture schedule group was deactivated; preserving it.');
  let [shift] = await owner.db.select().from(s.shift).where(and(eq(s.shift.tenantId, tenantId), eq(s.shift.code, shiftCode)));
  if (!shift) {
    const created = await createShift(a, {companyId, name: 'Board ten 09–18 (dev fixture)', code: shiftCode, ruleId: rule.id,
      startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1,2,3,4,5], halfPattern: [], offPattern: [6]});
    [shift] = await owner.db.select().from(s.shift).where(eq(s.shift.id, created.id));
  }
  if (shift.companyId !== companyId || shift.ruleId !== rule.id || shift.archivedAt) throw new Error('Existing fixture shift changed; preserving it.');
  const [attendancePolicy] = await owner.db.select().from(s.attendancePolicy).where(eq(s.attendancePolicy.companyId, companyId));
  if (!attendancePolicy) await setAttendancePolicy(a, {companyId, workStart: '09:00', workEnd: '18:00', breakMinutes: 60,
    lateAfter: '09:00', halfDayBefore: '13:00', workingDays: [1,2,3,4,5]});

  let [component] = await owner.db.select().from(s.payComponent).where(and(eq(s.payComponent.tenantId, tenantId), eq(s.payComponent.code, 'ATTENDANCE')));
  if (!component) {
    const seed = requirePackFor('MY').payComponents.defaults.find(c => c.code === 'ATTENDANCE');
    if (!seed) throw new Error('MY registry has no ATTENDANCE default.');
    await upsertPayComponent(bootstrap, {...seed, label: seed.name, rule: {kind: 'fixed'}});
    [component] = await owner.db.select().from(s.payComponent).where(and(eq(s.payComponent.tenantId, tenantId), eq(s.payComponent.code, 'ATTENDANCE')));
  }
  if (!(await listAttendanceAllowancePayCodes(a)).some(c => c.id === component.id && c.kind === 'allowance')) {
    throw new Error('Existing ATTENDANCE code is incompatible/archived; fixture will not reset a shared pay code.');
  }
  let [policy] = await owner.db.select().from(s.attendanceAllowancePolicy).where(and(eq(s.attendanceAllowancePolicy.companyId, companyId), eq(s.attendanceAllowancePolicy.code, policyCode)));
  const today = todayInKualaLumpur(), month = policy?.effectiveFrom.slice(0,7) ?? addMonths(today.slice(0,7), -1);
  if (!policy) {
    const rules = emptyAllowanceRules(); // employee.mode=all, no profile narrowing
    rules.attendance.criteria = [{field: 'attendanceDays', operator: 'gte', value: '1', unit: 'days'}];
    const created = await createAllowancePolicy(a, {companyId, code: policyCode, name: 'Board ten daily 12.50 (dev fixture)',
      amount: '12.50', payComponentId: component.id, method: 'daily', effectiveFrom: `${month}-01`, policyType: 'earning', rules});
    [policy] = await owner.db.select().from(s.attendanceAllowancePolicy).where(eq(s.attendanceAllowancePolicy.id, created.id));
  }
  if (policy.archivedAt || policy.status !== 'active') throw new Error('Existing fixture allowance policy was deactivated; preserving it.');
  async function employee(key: 'manager' | 'recipient' | 'control', role: Role) {
    let [person] = await owner.db.select().from(s.person).where(and(eq(s.person.tenantId, tenantId), eq(s.person.primaryEmail, email(key))));
    let [employment] = person ? await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId, tenantId), eq(s.employment.personId, person.id))) : [];
    if (!person && !employment) {
      const hired = await hireEmployee(a, {person: {fullName: `Board ten fictional ${key}`, primaryEmail: email(key)}, companyId,
        departmentId: dept.id, employmentType: 'full_time', hiredOn: key === 'manager' ? today : `${month}-01`});
      [person] = await owner.db.select().from(s.person).where(eq(s.person.id, hired.personId));
      [employment] = await owner.db.select().from(s.employment).where(eq(s.employment.id, hired.employmentId));
    }
    if (!person || !employment || employment.companyId !== companyId || employment.terminatedOn) throw new Error(`Existing ${key} person/employment is incomplete or moved; preserving it.`);
    await login(key, person.id, companyId, role);
    if (!employment.defaultShiftId) await assignDefaultShift(a, {employmentId: employment.id, shiftId: shift.id});
    else if (employment.defaultShiftId !== shift.id) throw new Error(`Existing ${key} shift changed; preserving it.`);
    return employment;
  }
  // Manager starts in the current month, outside the completed payroll month, so ALL preview has
  // exactly the two historical employees. Current dated reporting lines support workflow browser work.
  const manager = await employee('manager', 'manager'), recipient = await employee('recipient', 'employee'), control = await employee('control', 'employee');
  for (const subordinate of [recipient, control]) {
    const [line] = await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId, subordinate.id), eq(s.reportingLine.lineType, 'administrative'), isNull(s.reportingLine.validTo), isNull(s.reportingLine.supersededAt)));
    if (!line) await setReportingLine(a, {subordinateEmploymentId: subordinate.id, managerEmploymentId: manager.id, lineType: 'administrative', validFrom: today});
    else if (line.managerEmploymentId !== manager.id) throw new Error('Existing reporting manager changed; preserving it.');
  }
  const existingDays = await owner.db.select().from(s.attendance).where(inArray(s.attendance.employmentId, [recipient.id, control.id]));
  const dates = [...new Set(existingDays.map(r => r.attendanceDate))].sort();
  if (dates.length > 2 || dates.some(d => !d.startsWith(`${month}-`))) throw new Error('Existing fixture punches changed; preserving them.');
  for (const date of monthDates(month)) {
    if (dates.length === 2) break;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!weekday || weekday === 6 || dates.includes(date)) continue;
    const facts = await owner.withTenant(a, tx => allowanceScheduleFactsTx(tx, recipient.id, date));
    if (facts.kind === 'full' && facts.scheduledMinutes === 480) dates.push(date);
  }
  dates.sort();
  if (dates.length !== 2) throw new Error('Could not find two canonical 480-minute Mon–Fri days in the completed month.');
  for (const employment of [recipient, control]) for (const date of dates) {
    const existing = existingDays.find(r => r.employmentId === employment.id && r.attendanceDate === date);
    if (existing?.checkOutAt && !existing.checkInAt) throw new Error('Existing punch has checkout without check-in; preserving it.');
    if (!existing?.checkInAt) await checkIn(a, {employmentId: employment.id, date, time: '09:00:00'});
    if (!existing?.checkOutAt) await checkOut(a, {employmentId: employment.id, date, time: '18:00:00'});
  }
  const punched = await owner.db.select().from(s.attendance).where(inArray(s.attendance.employmentId, [recipient.id, control.id]));
  if (punched.length !== 4 || punched.some(r => r.workedMinutes !== 480 || r.otMinutes !== 0 || !r.checkInAt || !r.checkOutAt || r.dayType !== 'workday')) {
    throw new Error('Real punches did not produce four complete 480-minute workdays. No payroll run was created.');
  }
  const unscoped = await evaluateAllowancesForPeriod(a, {policyId: policy.id, month});
  if (unscoped.rows.length !== 2 || unscoped.rows.some(r => r.amount !== '25.00' || r.periods.filter(p => p.qualified).length !== 2
    || r.periods.filter(p => p.qualified).some(p => p.metrics.actualMinutes !== 480 || p.metrics.workingMinutes !== 480))) {
    throw new Error('Positive allowance preview must contain exactly two employees, 25.00 and two qualifying days each.');
  }
  let [batch] = await owner.db.select().from(s.payrollBatch).where(and(eq(s.payrollBatch.companyId, companyId), eq(s.payrollBatch.payPeriod, month), eq(s.payrollBatch.runType, 'regular')));
  if (!batch) { const created = await createBatch(a, {companyId, payPeriod: month, scope: {employmentIds: [recipient.id]}}); [batch] = await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id, created.batchId)); }
  if (batch.status !== 'draft') throw new Error('Fixture run was already processed; preserving it.');
  const scoped = await evaluateAllowancesForPeriod(a, {policyId: policy.id, month, batchId: batch.id});
  if (scoped.rows.length !== 1 || scoped.rows[0].employmentId !== recipient.id || scoped.rows[0].amount !== '25.00') throw new Error('Scoped preview did not preserve exactly the intended 25.00 recipient.');
  await manifest(companyId, policy.id, batch.id, false);
}

async function manifest(companyId: string, policyId: string, batchId: string, reused: boolean) {
  const users = await owner.db.select({id: s.appUser.id, personId: s.appUser.personId, key: s.appUser.workosUserId, email: s.person.primaryEmail})
    .from(s.appUser).innerJoin(s.person, eq(s.person.id, s.appUser.personId))
    .where(and(eq(s.appUser.tenantId, tenantId), inArray(s.appUser.workosUserId, keys.map(loginKey))));
  const hr = users.find(u => u.key === loginKey('hr'));
  if (!hr || users.length !== keys.length) throw new Error('Fixture login manifest is incomplete; preserving saved data.');
  const a = await context(hr);
  const employees = await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId, tenantId), eq(s.employment.companyId, companyId)));
  const [batch] = await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id, batchId));
  const [policy] = await owner.db.select().from(s.attendanceAllowancePolicy).where(eq(s.attendanceAllowancePolicy.id, policyId));
  const punches = await owner.db.select({id: s.attendance.id, employmentId: s.attendance.employmentId, date: s.attendance.attendanceDate, workedMinutes: s.attendance.workedMinutes, overtimeMinutes: s.attendance.otMinutes, checkInAt: s.attendance.checkInAt, checkOutAt: s.attendance.checkOutAt})
    .from(s.attendance).where(inArray(s.attendance.employmentId, employees.map(e => e.id))).orderBy(asc(s.attendance.attendanceDate));
  const sources = await owner.db.select().from(s.payrollAttendanceAllowanceSource).where(eq(s.payrollAttendanceAllowanceSource.batchId, batchId));
  const components = await owner.db.select().from(s.payrollBatchComponent).where(eq(s.payrollBatchComponent.batchId, batchId));
  // A browser check may deliberately disable a module, edit scope or change policy eligibility.
  // A completed rerun still prints identities/current evidence, with the real preview refusal.
  const preview = async (scoped: boolean) => {
    try {
      const value = await evaluateAllowancesForPeriod(a, {policyId, month: batch.payPeriod, ...(scoped ? {batchId} : {})});
      return {rows: value.rows.map(r => ({employmentId: r.employmentId, amount: r.amount, qualifiedPeriods: r.periods.filter(p => p.qualified).map(p => ({date: p.from, amount: p.amount, attendanceIds: p.attendanceIds, actualMinutes: p.metrics.actualMinutes, workingMinutes: p.metrics.workingMinutes}))}))};
    } catch (error) {
      if (!reused) throw error;
      return {error: error instanceof Error ? error.message : String(error)};
    }
  };
  const unscoped = await preview(false), scoped = await preview(true);
  const [shift] = await owner.db.select({id: s.shift.id, ruleId: s.shift.ruleId}).from(s.shift).where(and(eq(s.shift.tenantId, tenantId), eq(s.shift.code, shiftCode)));
  const [department] = await owner.db.select({id: s.department.id, businessUnitId: s.department.businessUnitId}).from(s.department).where(and(eq(s.department.companyId, companyId), eq(s.department.name, 'Board ten fictional department')));
  const [bootstrapUser] = await owner.db.select({id: s.appUser.id, personId: s.appUser.personId}).from(s.appUser)
    .where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
  const bootstrapContext = bootstrapUser ? await context(bootstrapUser) : null;
  console.log('BOARD15_INTEGRATION_MANIFEST\n'+JSON.stringify({fixture: 'board-ten', reused, tenantId, companyId, companyCode, policyId, policyVersion: policy.version,
    payComponentId: policy.payComponentId, batchId, month: batch.payPeriod, batchStatus: batch.status, batchScope: batch.scope,
    shiftId: shift?.id, scheduleGroupId: shift?.ruleId, departmentId: department?.id, businessUnitId: department?.businessUnitId,
    // Rotation writes require a group administrator; company HR is intentionally not widened.
    bootstrapGroupAdmin: bootstrapUser ? {userId: bootstrapUser.id, devCookie: `dev_user=${bootstrapUser.id}`, grants: bootstrapContext?.grants,
      rotationAuthorized: bootstrapContext?.grants?.some(g => g.companyId === null && ['hr_admin', 'super_admin'].includes(g.role)) ?? false} : null,
    logins: users.map(u => ({...u, devCookie: `dev_user=${u.id}`, employmentId: employees.find(e => e.personId === u.personId)?.id ?? null, hiredOn: employees.find(e => e.personId === u.personId)?.hiredOn ?? null, grants: u.id === hr.id ? a.grants : undefined})),
    punches, preview: {unscoped, scoped},
    existingSources: sources.map(r => ({id: r.id, employmentId: r.employmentId, amount: r.amount, periodKey: r.periodKey})),
    existingPayrollInputs: components.map(r => ({employmentId: r.employmentId, componentId: r.componentId, amount: r.amount})),
    screens: {settings: '/admin/attendance/settings', allowanceUnscoped: `/admin/attendance-allowance/${policyId}?month=${batch.payPeriod}`, allowanceScoped: `/admin/attendance-allowance/${policyId}?month=${batch.payPeriod}&batchId=${batchId}`},
    expectedFresh: {unscopedRecipients: 2, perEmployeeAmount: '25.00', scopedRecipients: 1, afterBrowserTransfer: {amount: '25.00', sourceCount: 2}, retry: '25.00 and two sources; control employee receives no payroll input'},
    limitations: ['No automatic transfer, payslip processing or browser verification.', 'Compensation/statutory readiness is not seeded; extend before generating real payslips.', 'Rotation/workflow definitions and requests are not seeded; own shift/group/manager are extension points.', 'Rotation editing requires bootstrapGroupAdmin; company HR should refuse and is not widened.', 'Completed reruns preserve browser changes; expectedFresh describes initial state only.', 'Missing tenant-wide module grants are added on initial setup; existing disabled/trial/expiring grants refuse.'],
  }, null, 2));
}

// Services open the module-level app-role pool as well as this owner pool. Explicit exit avoids a
// successful fixture hanging on idle app connections (same pattern as dev-fixture-onehr.ts).
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
