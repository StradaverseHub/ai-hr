/**
 * LOCAL ONLY. Run after migrations/db:seed and dev-fixture-board-ten.ts, with all gate slots released:
 *   node --env-file=.env.local --import tsx scripts/dev-fixture-board-ten-workflows.ts
 *
 * Extends BOARD10-DEV without touching its identities, grants, allowance policy or draft payroll scope.
 * Attendance stays pending for browser manager -> HR approval/cancellation. Real Leave commands create
 * fully used / partially used / available earned lots, plus a separate cancelled application/return.
 * All business writes use services; the sole owner write is a missing local-demo toil module grant.
 * An immutable completion receipt makes completed reruns read-only, preserving browser changes.
 * Interrupted setup resumes from stable keys; changed/rejected objects refuse instead of resetting.
 * No payroll processing, fabricated payslips, money calculations or SQL status transitions.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { createDb, withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { setCompensation } from '../core/comp';
import { createShift } from '../core/roster';
import {
  allowanceScheduleFactsTx, attendanceApplicationDetail, getScheduleRotation, requestAttendanceCorrection,
  saveAttendanceWorkflow, saveScheduleRotation, setAttendanceWorkflowEnabled,
} from '../packs/attendance/service';
import {
  adminCancelLeave, createLeaveApprovalRule, decideLeave, findReplacementLeaveTypeIdTx, grantLeaveCredit, listEarnedLeaveCredits,
  previewLeaveCredit, requestLeave, setToilPolicy,
} from '../packs/leave/service';
import { preProcessAdvisory } from '../packs/payroll/service';
import { requirePackFor } from '../localization/registry';
import { todayInKualaLumpur } from '../lib/hr-date';
import { monthDates } from '../lib/roster-month';

const refusal = demoSeedRefusal(process.env);
if (refusal) throw new Error(refusal);
if (process.env.NODE_ENV === 'production') throw new Error('Board workflow fixture is local development only.');
const targets = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].map(value => {
  if (!value) throw new Error('Both DATABASE_URL and MIGRATION_DATABASE_URL are required.');
  const target = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '5433')
    throw new Error('Board workflow fixture requires disposable localhost:5433 connections.');
  return target;
});
if (targets[0].pathname !== targets[1].pathname) throw new Error('App and owner connections must target the same database.');
const owner = createDb(process.env.MIGRATION_DATABASE_URL!), tenantId = DEMO_TENANT_ID;
const companyCode = 'BOARD10-DEV', workflowCode = 'BOARD10_CLOCK', nightCode = 'BOARD10_NIGHT';
const prefix = 'Board ten workflow fixture: ', completedEvent = 'dev-fixture.board-ten.workflows.completed';
const keys = ['hr', 'manager', 'recipient', 'control'] as const;
type Key = typeof keys[number];
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function context(user: {id: string; personId: string | null}): Promise<SessionContext> {
  const grants = await owner.db.select({role: s.roleAssignment.role, companyId: s.roleAssignment.companyId})
    .from(s.roleAssignment).where(and(eq(s.roleAssignment.tenantId, tenantId), eq(s.roleAssignment.appUserId, user.id)));
  const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId));
  return {tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map(g => g.role))], grants, entitlements};
}
async function loadBase() {
  const [company] = await owner.db.select().from(s.company).where(and(eq(s.company.tenantId, tenantId), eq(s.company.companyLabel, companyCode)));
  if (!company || company.legalName !== 'Board ten browser (dev fixture)') throw new Error('Run dev-fixture-board-ten.ts first; fictional company missing.');
  const users = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), inArray(s.appUser.workosUserId, keys.map(key => `board-ten-fixture:${key}`))));
  const identities = new Map<Key, {user: typeof s.appUser.$inferSelect; employment: typeof s.employment.$inferSelect | null}>();
  for (const key of keys) {
    const user = users.find(u => u.workosUserId === `board-ten-fixture:${key}`);
    if (!user || !user.personId) throw new Error(`Base fixture ${key} login missing.`);
    const employments = await owner.db.select().from(s.employment).where(and(eq(s.employment.tenantId, tenantId), eq(s.employment.personId, user.personId)));
    if (employments.length > 1) throw new Error(`Base ${key} has multiple employments; refusing an ambiguous fixture subject.`);
    identities.set(key, {user, employment: employments[0] ?? null});
  }
  const [department] = await owner.db.select().from(s.department).where(and(eq(s.department.companyId, company.id), eq(s.department.name, 'Board ten fictional department')));
  const [shift] = await owner.db.select().from(s.shift).where(and(eq(s.shift.tenantId, tenantId), eq(s.shift.code, 'BOARD10_DAY')));
  const [batch] = await owner.db.select().from(s.payrollBatch).where(and(eq(s.payrollBatch.companyId, company.id), eq(s.payrollBatch.runType, 'regular'))).orderBy(asc(s.payrollBatch.createdAt));
  if (!department || !shift?.ruleId || !batch) throw new Error('Base fixture is incomplete: department, group/day shift or payroll run missing.');
  return {company, department, shift, batch, identities};
}
type Base = Awaited<ReturnType<typeof loadBase>>;
function subject(base: Base, key: 'recipient' | 'control' | 'manager') {
  const value = base.identities.get(key)!.employment;
  if (!value) throw new Error(`Base ${key} employment missing.`);
  return value;
}
async function main() {
  const tenants = await owner.db.select({id: s.tenant.id}).from(s.tenant);
  if (!tenants.some(t => t.id === tenantId) || tenants.some(t => t.id !== tenantId && t.id !== SYSTEM_TENANT_ID))
    throw new Error('Refusing fixture: seed the disposable demo-only database first. No override is accepted.');
  const lock = await owner.client.reserve();
  try {
    // Share the base fixture mutex; services use separate app-role transactions, no business-row lock here.
    await lock`select pg_advisory_lock(hashtextextended('dev-fixture-board-ten',0))`;
    const base = await loadBase();
    const [done] = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId, tenantId), eq(s.domainEvent.aggregateId, base.company.id), eq(s.domainEvent.eventType, completedEvent)));
    if (done) { await manifest(base, true); return; }
    await prepare(base);
    await manifest(base, false);
  } finally {
    await lock`select pg_advisory_unlock(hashtextextended('dev-fixture-board-ten',0))`;
    lock.release();
    await owner.client.end();
  }
}
async function prepare(base: Base) {
  const {company, department, shift, batch} = base, recipient = subject(base, 'recipient'), control = subject(base, 'control');
  if (company.archivedAt || company.country !== 'MY' || shift.archivedAt || shift.companyId !== company.id || batch.status !== 'draft')
    throw new Error('Base company/shift changed or payroll already processed; preserving browser work.');
  for (const key of keys) {
    const {user, employment} = base.identities.get(key)!, ctx = await context(user);
    const role = key === 'hr' ? 'hr_admin' : key === 'manager' ? 'manager' : 'employee';
    if (user.archivedAt || ctx.grants?.length !== 1 || ctx.grants[0].role !== role || ctx.grants[0].companyId !== company.id
      || (key !== 'hr' && (!employment || employment.companyId !== company.id || employment.terminatedOn)))
      throw new Error(`Base ${key} identity/scope changed; fixture will not broaden or reset it.`);
  }
  const [module] = await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId, tenantId), eq(s.tenantModule.moduleCode, 'toil'), isNull(s.tenantModule.companyId)));
  if (!module) await owner.db.insert(s.tenantModule).values({tenantId, moduleCode: 'toil', status: 'active'});
  else if (module.status !== 'active' || module.expiresAt) throw new Error('Existing toil module is disabled/trial/expiring; activate explicitly, never reset by this fixture.');
  const a = await context(base.identities.get('hr')!.user), employee = await context(base.identities.get('recipient')!.user);
  const mgr = await context(base.identities.get('manager')!.user), controlCtx = await context(base.identities.get('control')!.user);
  const pack = requirePackFor(company.country);
  for (const [index, emp] of [recipient, control].entries()) {
    const comps = await owner.db.select().from(s.compensation).where(eq(s.compensation.employmentId, emp.id));
    if (!comps.length) await setCompensation(a, {employmentId: emp.id, basicSalary: 6000, monthlyAllowance: 0,
      currency: 'MYR', payMode: 'monthly', paymentTerm: 'monthly', effectiveFrom: emp.hiredOn, remarks: `${prefix}fictional payroll readiness`});
    else if (!comps.some(c => !c.supersededAt && !c.validTo && Number(c.basicSalary) === 6000 && Number(c.monthlyAllowance) === 0))
      throw new Error('Existing compensation differs; preserving it instead of inventing Leave Credit eligibility.');
    const statutory = await pack.statutory.get(a, emp.personId);
    if (!statutory) {
      await pack.statutory.set(a, {personId: emp.personId, icNumber: `90010114910${index + 1}`, taxCategory: 1,
        bankName: 'Fictional demo bank', bankAccountNo: `BOARD10-DEV-${index + 1}`});
    }
    // Existing profiles and tax elections are intentionally never overwritten. The real batch advisory
    // below checks its supported compensation/statutory/bank gaps, but does not validate tax selections
    // or incentive declarations. Payroll processing performs those separate country-pack checks.
  }
  let [night] = await owner.db.select().from(s.shift).where(and(eq(s.shift.tenantId, tenantId), eq(s.shift.code, nightCode)));
  if (!night) {
    const created = await createShift(a, {companyId: company.id, name: 'Board ten half-night reference', code: nightCode,
      ruleId: shift.ruleId!, startTime: '20:00', endTime: '05:00', breakMinutes: 60, weeklyPattern: [1,2,3,4,5]});
    [night] = await owner.db.select().from(s.shift).where(eq(s.shift.id, created.id));
  }
  if (night.companyId !== company.id || night.ruleId !== shift.ruleId || night.archivedAt) throw new Error('Fixture night shift changed; preserving it.');
  const rotation = await getScheduleRotation(a, shift.ruleId!);
  const anchor = rotation.versions[0]?.effectiveFrom ?? addDays(todayInKualaLumpur(), 8);
  if (rotation.versions.length && (rotation.versions.length !== 1 || !rotation.versions[0].allowedShiftIds.includes(night.id)))
    throw new Error('Existing rotation is not this fixture; preserving it.');
  if (!rotation.versions.length) {
    const [bootstrapUser] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
    if (!bootstrapUser) throw new Error('Seeded group administrator missing.');
    const bootstrap = await context(bootstrapUser);
    if (!bootstrap.grants?.some(g => g.companyId === null && ['hr_admin', 'super_admin'].includes(g.role))) throw new Error('Seeded group administrator lacks rotation authority.');
    await saveScheduleRotation(bootstrap, {ruleId: shift.ruleId!, expectedRevision: rotation.revision,
      allowedShiftIds: [shift.id, night.id], cycle: {unit: 'day', length: 2, anchorDate: anchor, effectiveFrom: anchor,
        days: [{kind: 'full', shiftId: shift.id}, {kind: 'half', shiftId: night.id}]}});
  }
  let [workflow] = await owner.db.select().from(s.attendanceWorkflowTemplate).where(and(eq(s.attendanceWorkflowTemplate.companyId, company.id), eq(s.attendanceWorkflowTemplate.code, workflowCode), isNull(s.attendanceWorkflowTemplate.supersededAt)));
  if (!workflow) workflow = await saveAttendanceWorkflow(a, {companyId: company.id, code: workflowCode,
    name: 'Board ten clock review', description: `${prefix}manager review followed by HR; stage one permits HR cover for the department manager.`,
    applicationType: 'irregularity', priority: 100, criteria: {departmentIds: [department.id]}, active: true,
    stages: [{name: 'Manager review or HR cover', level: {kind: 'direct_manager', employmentId: null, alternates: [{kind: 'hr_admin', employmentId: null}]}},
      {name: 'HR final approval', level: {kind: 'hr_admin', employmentId: null, alternates: []}}]});
  if (!workflow.active || workflow.applicationType !== 'irregularity'
    || JSON.stringify(workflow.criteria) !== JSON.stringify({departmentIds: [department.id]}))
    throw new Error('Fixture workflow scope changed/deactivated; preserving it.');
  const [routing] = await owner.db.select().from(s.attendanceWorkflowSetting).where(and(eq(s.attendanceWorkflowSetting.companyId, company.id), eq(s.attendanceWorkflowSetting.applicationType, 'irregularity')));
  if (!routing) await setAttendanceWorkflowEnabled(a, company.id, 'irregularity', true);
  else if (!routing.enabled) throw new Error('Fixture routing disabled; preserving it.');
  const days = await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId, recipient.id)).orderBy(asc(s.attendance.attendanceDate));
  const source = days.find(d => d.attendanceDate.startsWith(batch.payPeriod) && d.checkInAt && d.checkOutAt);
  if (!source) throw new Error('Base recipient has no completed past-month clock day.');
  const reason = `${prefix}pending clock review`;
  let [correction] = await owner.db.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId, recipient.id), eq(s.attendanceCorrection.reason, reason)));
  if (!correction) {
    const created = await requestAttendanceCorrection(employee, {employmentId: recipient.id, date: source.attendanceDate,
      checkIn: '09:15', checkOut: '18:15', requestKind: 'other', reason});
    [correction] = await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id, created.correctionId));
  }
  const detail = await attendanceApplicationDetail(a, [company.id], correction.id);
  if (!detail?.workflow || detail.workflow.stages.length !== 2 || correction.status !== 'pending') throw new Error('Fixture request is no longer a pending two-stage review; preserving browser changes.');
  const [policy] = await owner.db.select().from(s.toilPolicy).where(eq(s.toilPolicy.companyId, company.id));
  if (!policy) await setToilPolicy(a, {companyId: company.id, enabled: true, accrualBasis: 'hours_worked', expiryDays: 180,
    onExpiry: 'lapse', allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false});
  else if (!policy.enabled) throw new Error('Fixture Leave Credit policy was disabled; preserving it.');
  const leaveTypeId = await withTenant(a, tx => findReplacementLeaveTypeIdTx(tx, tenantId));
  if (!leaveTypeId) throw new Error('Replacement Leave type not provisioned by the real policy service.');
  const ruleName = `${prefix}Replacement Leave manager approval`;
  const [approval] = await owner.db.select().from(s.leaveApprovalPolicy).where(and(eq(s.leaveApprovalPolicy.companyId, company.id), eq(s.leaveApprovalPolicy.ruleName, ruleName)));
  if (!approval) await createLeaveApprovalRule(a, {companyId: company.id, departmentId: department.id, leaveTypeId, ruleName, levels: ['direct_manager']});
  else if (!approval.active || approval.departmentId !== department.id || approval.leaveTypeId !== leaveTypeId
    || JSON.stringify(approval.levels) !== JSON.stringify(['direct_manager']))
    throw new Error('Fixture Leave approval rule changed/archived; preserving it.');
  const workedDates: string[] = [];
  for (const date of monthDates(batch.payPeriod)) {
    if (workedDates.length === 3) break;
    const facts = await previewLeaveCredit(a, {employmentId: recipient.id, workedDate: date});
    if (facts.workedDayKind !== 'workday' && date >= recipient.hiredOn) workedDates.push(date);
  }
  if (workedDates.length !== 3) throw new Error('Need three canonical non-working dates in the base month for fictional HR grants.');
  async function grant(emp: typeof recipient, date: string, days: number, key: string, expiryOffset: number) {
    const note = `${prefix}${key}`;
    const [lot] = await owner.db.select().from(s.toilAccrual).where(and(eq(s.toilAccrual.employmentId, emp.id), eq(s.toilAccrual.note, note)));
    if (!lot) await grantLeaveCredit(a, {employmentId: emp.id, workedDate: date, days, reason: note, expiresOn: addDays(anchor, expiryOffset)});
    else if (lot.workedDate !== date || Number(lot.daysCredited) !== days || lot.status === 'reversed') throw new Error(`Existing ${key} credit changed; preserving it.`);
  }
  await grant(recipient, workedDates[0], .75, 'recipient first lot', 90);
  await grant(recipient, workedDates[1], 1.25, 'recipient second lot', 100);
  await grant(recipient, workedDates[2], 1, 'recipient available lot', 110);
  await grant(control, workedDates[0], 1, 'control returned lot', 90);
  async function fullDate(emp: typeof recipient) {
    for (let offset = 14; offset < 90; offset++) {
      const date = addDays(anchor, offset);
      const facts = await withTenant(a, tx => allowanceScheduleFactsTx(tx, emp.id, date));
      if (facts.kind === 'full' && facts.scheduledMinutes === 480) return date;
    }
    throw new Error('No future canonical full working day for fixture leave.');
  }
  async function leave(emp: typeof recipient, ctx: SessionContext, key: string, mayBeCancelled = false) {
    const reason = `${prefix}${key}`;
    let [row] = await owner.db.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.employmentId, emp.id), eq(s.leaveRequest.reason, reason)));
    if (!row) {
      const date = await fullDate(emp);
      if (date <= todayInKualaLumpur()) throw new Error('Interrupted fixture dates are now past; reseed instead of inventing backdated leave.');
      const created = await requestLeave(ctx, {employmentId: emp.id, leaveTypeId, startDate: date, endDate: date, reason});
      [row] = await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id, created.leaveRequestId));
    }
    if (Number(row.days) !== 1) throw new Error('Configured Leave Type did not charge one day; preserving the actual request.');
    if (row.status === 'pending') await decideLeave(mgr, {leaveRequestId: row.id, decision: 'approved', deciderEmploymentId: subject(base, 'manager').id});
    [row] = await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id, row.id));
    if (row.status !== 'approved' && !(mayBeCancelled && row.status === 'cancelled')) throw new Error(`Fixture ${key} was changed/refused; preserving it.`);
    return row;
  }
  const used = await leave(recipient, employee, 'recipient approved usage');
  const returned = await leave(control, controlCtx, 'control cancelled usage', true);
  if (returned.status === 'approved') await adminCancelLeave(a, {leaveRequestId: returned.id, reason: `${prefix}return control credit`});
  const earned = await listEarnedLeaveCredits(a, {companyIds: [company.id], employmentId: recipient.id});
  for (const expected of [
    {key: 'recipient first lot', earned: .75, used: .75, available: 0, status: 'fully_used'},
    {key: 'recipient second lot', earned: 1.25, used: .25, available: 1, status: 'partially_used'},
    {key: 'recipient available lot', earned: 1, used: 0, available: 1, status: 'available'},
  ]) {
    const row = earned.rows.find(value => value.reason === `${prefix}${expected.key}`);
    if (!row || row.earned !== expected.earned || row.used !== expected.used || row.available !== expected.available
      || row.status !== expected.status || row.unattributedUsed !== 0
      || row.usage.some(usage => usage.requestId !== used.id || usage.date !== used.startDate))
      throw new Error(`Real Leave allocation did not produce the intended ${expected.key}; no completion receipt was written.`);
  }
  const restored = await listEarnedLeaveCredits(a, {companyIds: [company.id], employmentId: control.id});
  if (!restored.rows.some(row => row.reason === `${prefix}control returned lot` && row.available === 1 && row.used === 0)) throw new Error('Control cancellation did not restore its real credit.');
  await withTenant(a, tx => appendEvent(tx, {tenantId, aggregateType: 'company', aggregateId: company.id, eventType: completedEvent,
    actor: actorOf(a), payload: {fixture: 'board-ten-workflows', correctionId: correction.id, workflowLineageId: workflow.lineageId,
      rotationRuleId: shift.ruleId, anchor, usedRequestId: used.id, returnedRequestId: returned.id, payrollBatchId: batch.id}}));
}
async function manifest(base: Base, reused: boolean) {
  const a = await context(base.identities.get('hr')!.user), companyId = base.company.id;
  const attempt = async <T>(read: () => Promise<T>) => { try { return await read(); } catch (error) { return {error: error instanceof Error ? error.message : String(error)}; } };
  const corrections = await owner.db.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId, subject(base, 'recipient').id), eq(s.attendanceCorrection.reason, `${prefix}pending clock review`)));
  const requests = await owner.db.select().from(s.leaveRequest).where(inArray(s.leaveRequest.employmentId, [subject(base, 'recipient').id, subject(base, 'control').id]));
  const [bootstrap] = await owner.db.select({id: s.appUser.id}).from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
  console.log(JSON.stringify({fixture: 'board-ten-workflows', reused, companyId, companyCode,
    logins: keys.map(key => ({key, userId: base.identities.get(key)!.user.id, employmentId: base.identities.get(key)!.employment?.id ?? null, devCookie: `dev_user=${base.identities.get(key)!.user.id}`})),
    attendance: await Promise.all(corrections.map(row => attempt(() => attendanceApplicationDetail(a, [companyId], row.id)))),
    rotation: await attempt(() => getScheduleRotation(a, base.shift.ruleId!)),
    rotationGroupAdmin: bootstrap ? {userId: bootstrap.id, devCookie: `dev_user=${bootstrap.id}`} : null,
    credits: await attempt(() => listEarnedLeaveCredits(a, {companyIds: [companyId]})),
    leaveRequests: requests.filter(row => row.reason?.startsWith(prefix)).map(row => ({id: row.id, employmentId: row.employmentId, status: row.status, startDate: row.startDate, endDate: row.endDate, days: row.days})),
    payroll: {batchId: base.batch.id, status: base.batch.status, scope: base.batch.scope, readiness: await attempt(() => preProcessAdvisory(a, base.batch.id))},
    screens: {workflow: '/admin/attendance/approval-workflow', history: '/attendance/application-history',
      request: corrections[0] ? `/attendance/application-history/${corrections[0].id}` : null,
      rotation: `/admin/attendance/schedule/${base.shift.ruleId}/edit`, credits: '/admin/leave-config/leave-credit', payroll: `/payroll/process?resume=${base.batch.id}`},
    expectedFresh: {attendance: 'Pending manager-or-HR stage, then HR final; attendance changes only on final approval.',
      recipientCredits: '0.75 fully used, 1.25 partially used (0.25 used / 1 available), 1 available.', controlCredits: '1 available after real leave approval and HR cancellation.'},
    limitations: ['Never run during a test/release gate; this script has not been executed by its author.',
      'No automatic attendance approval, allowance transfer, payroll generation or browser verification.',
      'No tax declarations/elections or statutory table overrides. Payroll advisory does not validate tax selections or incentive declarations; processing can still refuse unresolved, stale or unsupported tax configuration.',
      'UNKNOWN until runtime: database timezone/current_date versus Kuala Lumpur today. Leave manager authorization uses current_date and can refuse a not-yet-effective base reporting line; no dates or roles are rewritten to bypass it.',
      'HR manual non-working-day grants use fictional HR evidence, not fabricated clockings.',
      'Attendance stage one includes HR cover because the same department contains the top manager; browser may still exercise manager then HR.',
      'Control demonstrates full HR cancellation; employee partial-cancellation settings on the shared Leave Type are preserved.',
      'Completed reruns preserve browser edits, scope changes, module disabling and processed payroll; expectedFresh is initial state only.'],
  }, null, 2));
}
// Services also open the module-level app pool; explicit exit prevents idle connections hanging.
main().then(() => process.exit(0)).catch(error => {console.error(error); process.exit(1);});
