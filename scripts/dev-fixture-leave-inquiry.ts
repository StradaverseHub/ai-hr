/** Local fictional inquiry experience. Run twice under both slots+DB; preserves completed business facts.
 * Requires the named disposable ai_hr_board15_inquiry_browser database, migrated and seeded first.
 * Org/adjustment/request/decision facts use canonical services. Owner creates fictional login grants only.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { createCompany, createDepartment, createLeaveType, assignRole } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { applyLeaveAdjustmentBatch, requestLeave, decideLeave, adminCancelLeave, setLeaveApprovalPolicy } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
const refusal = demoSeedRefusal(process.env);
if (refusal || process.env.NODE_ENV === 'production') throw new Error(refusal ?? 'Development only');
for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
  const url = new URL(process.env[key]!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port !== '5433' || url.pathname !== '/ai_hr_board15_inquiry_browser') throw new Error('Only the named disposable inquiry database is allowed.');
}
const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const tenantId = DEMO_TENANT_ID, today = todayInKualaLumpur();
async function context(user: { id: string; personId: string | null }): Promise<SessionContext> {
  const grants = await owner.db.select({ role: s.roleAssignment.role, companyId: s.roleAssignment.companyId }).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
  const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId));
  return { tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map(g => g.role))], grants, entitlements };
}
async function main() {
  const tenants = await owner.db.select().from(s.tenant);
  if (!tenants.some(t => t.id === tenantId) || tenants.some(t => t.id !== tenantId && t.id !== SYSTEM_TENANT_ID)) throw new Error('Seeded demo tenants only.');
  const [seedAdmin] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.workosUserId, 'user_dev_admin'), eq(s.appUser.tenantId, tenantId)));
  if (!seedAdmin) throw new Error('Seed administrator missing.');
  const bootstrap = await context(seedAdmin);
  const companies: Record<string, string> = {}, departments: Record<string, string> = {};
  for (const key of ['A', 'B', 'Hidden', 'Empty']) {
    const label = `INQUIRY15-${key}`;
    let [company] = await owner.db.select().from(s.company).where(and(eq(s.company.tenantId, tenantId), eq(s.company.companyLabel, label)));
    if (!company) { const created = await createCompany(bootstrap, { legalName: `Inquiry fixture ${key}`, companyLabel: label, country: 'MY', currency: 'MYR' }); [company] = await owner.db.select().from(s.company).where(eq(s.company.id, created.id)); }
    if (company.archivedAt) throw new Error('Fixture company archived; preserving it.');
    companies[key] = company.id;
    let [department] = await owner.db.select().from(s.department).where(and(eq(s.department.companyId, company.id), eq(s.department.name, `Inquiry team ${key}`)));
    if (!department) { const created = await createDepartment(bootstrap, { companyId: company.id, name: `Inquiry team ${key}` }); [department] = await owner.db.select().from(s.department).where(eq(s.department.id, created.id)); }
    departments[key] = department.id;
    if (key === 'A' || key === 'B') {
      const [policy] = await owner.db.select().from(s.leaveApprovalPolicy).where(eq(s.leaveApprovalPolicy.companyId, company.id));
      if (!policy) await setLeaveApprovalPolicy(bootstrap, { companyId: company.id, levels: ['hr_admin'] });
    }
  }
  const people: { key: string; employmentId: string; personId: string; companyId: string }[] = [];
  for (const key of ['hr', 'manager', ...Array.from({ length: 28 }, (_, i) => `employee-${String(i).padStart(2, '0')}`)]) {
    const companyKey = key === 'hr' ? 'Hidden' : key === 'manager' ? 'A' : Number(key.slice(-2)) % 2 ? 'B' : 'A';
    const email = `inquiry15-${key}@demo.test`;
    let [person] = await owner.db.select().from(s.person).where(and(eq(s.person.tenantId, tenantId), eq(s.person.primaryEmail, email)));
    let [employment] = person ? await owner.db.select().from(s.employment).where(and(eq(s.employment.personId, person.id), eq(s.employment.companyId, companies[companyKey]))) : [];
    if (!person && !employment) {
      const created = await hireEmployee(bootstrap, { person: { fullName: key.startsWith('employee') ? 'Inquiry duplicate name' : `Inquiry fixture ${key}`, primaryEmail: email }, companyId: companies[companyKey], departmentId: departments[companyKey], employmentType: 'full_time', hiredOn: `${today.slice(0, 4)}-01-01` });
      [person] = await owner.db.select().from(s.person).where(eq(s.person.id, created.personId)); [employment] = await owner.db.select().from(s.employment).where(eq(s.employment.id, created.employmentId));
    }
    if (!person || !employment || employment.terminatedOn) throw new Error('Existing fixture person changed; preserving it.');
    people.push({ key, employmentId: employment.id, personId: person.id, companyId: employment.companyId });
    if (['hr', 'manager', 'employee-00'].includes(key)) {
      let [user] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, `inquiry15-fixture:${key}`)));
      if (!user) [user] = await owner.db.insert(s.appUser).values({ tenantId, personId: person.id, workosUserId: `inquiry15-fixture:${key}`, onboardedAt: new Date() }).returning();
      if (user.personId !== person.id || user.archivedAt) throw new Error('Existing fixture login changed; preserving it.');
      const expected = key === 'hr' ? [{ role: 'hr_admin' as const, companyId: companies.A }, { role: 'hr_admin' as const, companyId: companies.B }, { role: 'hr_admin' as const, companyId: companies.Empty }, { role: 'employee' as const, companyId: null }] : [{ role: key === 'manager' ? 'manager' as const : 'employee' as const, companyId: null }];
      const grants = await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
      if (!grants.length) for (const grant of expected) await assignRole(bootstrap, { appUserId: user.id, role: grant.role, ...(grant.companyId ? { companyId: grant.companyId } : {}) });
      else if (grants.length !== expected.length || expected.some(g => !grants.some(existing => existing.role === g.role && existing.companyId === g.companyId))) throw new Error('Existing fixture roles changed; preserving them.');
    }
  }
  const manager = people.find(p => p.key === 'manager')!, employee = people.find(p => p.key === 'employee-00')!;
  const [line] = await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId, employee.employmentId), eq(s.reportingLine.lineType, 'administrative'), isNull(s.reportingLine.validTo), isNull(s.reportingLine.supersededAt)));
  if (!line) await setReportingLine(bootstrap, { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${today.slice(0, 4)}-01-01` });
  const types: string[] = [];
  for (const code of ['INQ15_A', 'INQ15_B']) {
    let [type] = await owner.db.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId, tenantId), eq(s.leaveType.code, code)));
    if (!type) { const created = await createLeaveType(bootstrap, { code, name: `Inquiry fixture ${code.slice(-1)}`, paid: true }); [type] = await owner.db.select().from(s.leaveType).where(eq(s.leaveType.id, created.id)); }
    if (type.archivedAt) throw new Error('Fixture type archived; preserving it.'); types.push(type.id);
  }
  const targets = people.filter(p => p.key.startsWith('employee'));
  const reason = 'Inquiry15 fixture opening allocation';
  const [batch] = await owner.db.select().from(s.leaveAdjustmentBatch).where(and(eq(s.leaveAdjustmentBatch.tenantId, tenantId), eq(s.leaveAdjustmentBatch.reason, reason)));
  if (!batch) await applyLeaveAdjustmentBatch(bootstrap, { leaveTypeIds: types, days: 20, effectiveOn: `${today.slice(0, 4)}-01-01`, reason, targetMode: 'individual', employmentIds: targets.map(p => p.employmentId) });
  let monday = new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000);
  while (monday.getUTCDay() !== 1) monday = new Date(monday.getTime() + 86_400_000);
  for (const [index, typeId] of types.entries()) {
    const date = new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10);
    for (const target of targets) {
      const reason = `Inquiry15 fixture request ${target.key} ${index}`;
      let [request] = await owner.db.select().from(s.leaveRequest).where(and(eq(s.leaveRequest.employmentId, target.employmentId), eq(s.leaveRequest.reason, reason)));
      if (!request) { const created = await requestLeave(bootstrap, { employmentId: target.employmentId, leaveTypeId: typeId, startDate: date, endDate: date, reason, today }); [request] = await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id, created.leaveRequestId)); }
      if (target.key === 'employee-00' && request.status === 'pending') await decideLeave(bootstrap, { leaveRequestId: request.id, decision: 'approved' });
      if (target.key === 'employee-00' && index === 1) { [request] = await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id, request.id)); if (request.status === 'approved') await adminCancelLeave(bootstrap, { leaveRequestId: request.id, reason: 'Inquiry15 fixture correction' }); }
    }
  }
  const users = await owner.db.select({ userId: s.appUser.id, login: s.appUser.workosUserId }).from(s.appUser).where(eq(s.appUser.tenantId, tenantId));
  console.log(JSON.stringify({ companies, departments, types, today, users: users.filter(u => u.login.startsWith('inquiry15-fixture:')).sort((a, b) => a.login.localeCompare(b.login)), people }, null, 2));
  await owner.client.end();
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
