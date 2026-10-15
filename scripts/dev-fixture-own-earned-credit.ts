/**
 * Local-only, fictional personal earned-credit experience fixture (board 2634fa7a).
 * Run under both test slots + dev DB lock, AFTER migrations and db:seed:
 * node --env-file=.env.local --import tsx scripts/dev-fixture-own-earned-credit.ts
 * Run twice; reruns preserve completed grants and browser changes. No resets or truncates.
 * Business facts use their canonical services. Owner writes create fixture login/module identities only.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDb, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { DEMO_TENANT_ID, SYSTEM_TENANT_ID, demoSeedRefusal } from '../db/seed-guard';
import { resolveEntitlementsTx } from '../core/entitlements';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { grantLeaveCredit, listOwnEarnedLeaveCredits, reverseLeaveCredit, setToilPolicy } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';

const refusal = demoSeedRefusal(process.env);
if (refusal) throw new Error(refusal);
if (process.env.NODE_ENV === 'production') throw new Error('Personal credit fixture is local development only.');
const targets = [process.env.DATABASE_URL, process.env.MIGRATION_DATABASE_URL].map(value => {
  if (!value) throw new Error('Both app and migration connections are required.');
  const target = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.port !== '5433') throw new Error('Fixture requires disposable localhost:5433 PostgreSQL.');
  return target;
});
if (targets[0].pathname !== targets[1].pathname) throw new Error('App and owner connections must target the same database.');
const owner = createDb(process.env.MIGRATION_DATABASE_URL!);
const tenantId = DEMO_TENANT_ID;
const today = todayInKualaLumpur();
const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const companyCode = 'CREDIT15-DEV';
const keys = ['hr', 'manager', 'employee', 'empty'] as const;
type Key = typeof keys[number];
type Role = 'hr_admin' | 'manager' | 'employee';
const email = (key: Key) => `credit15-${key}@demo.test`;

async function context(user: { id: string; personId: string | null }): Promise<SessionContext> {
  const grants = await owner.db.select({ role: s.roleAssignment.role, companyId: s.roleAssignment.companyId }).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
  const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, tenantId));
  return { tenantId, userId: user.id, personId: user.personId, roles: [...new Set(grants.map(grant => grant.role))], grants, entitlements };
}

async function main() {
  const tenants = await owner.db.select({ id: s.tenant.id }).from(s.tenant);
  if (!tenants.some(tenant => tenant.id === tenantId) || tenants.some(tenant => tenant.id !== tenantId && tenant.id !== SYSTEM_TENANT_ID)) throw new Error('Run db:seed first; refusing a non-demo tenant.');
  const [seedAdmin] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, 'user_dev_admin'), isNull(s.appUser.archivedAt)));
  if (!seedAdmin) throw new Error('Seeded administrator is missing.');
  const bootstrap = await context(seedAdmin);
  if (!bootstrap.grants?.some(grant => grant.companyId === null && ['hr_admin', 'super_admin'].includes(grant.role))) throw new Error('Bootstrap requires the existing group administrator.');
  for (const moduleCode of ['toil']) {
    const [module] = await owner.db.select().from(s.tenantModule).where(and(eq(s.tenantModule.tenantId, tenantId), eq(s.tenantModule.moduleCode, moduleCode), isNull(s.tenantModule.companyId)));
    if (!module) await owner.db.insert(s.tenantModule).values({ tenantId, moduleCode, status: 'active' });
    else if (!['active', 'trial'].includes(module.status)) throw new Error('Existing module disabled; fixture will not reset it.');
  }
  let [company] = await owner.db.select().from(s.company).where(and(eq(s.company.tenantId, tenantId), eq(s.company.companyLabel, companyCode)));
  if (!company) {
    const created = await createCompany(await context(seedAdmin), { legalName: 'Personal earned-credit browser fixture', companyLabel: companyCode, country: 'MY', currency: 'MYR' });
    [company] = await owner.db.select().from(s.company).where(eq(s.company.id, created.id));
  }
  if (company.archivedAt || company.legalName !== 'Personal earned-credit browser fixture') throw new Error('Existing fixture company changed; preserving it.');
  let [department] = await owner.db.select().from(s.department).where(and(eq(s.department.companyId, company.id), eq(s.department.name, 'Credit fixture team')));
  if (!department) {
    const created = await createDepartment(await context(seedAdmin), { companyId: company.id, name: 'Credit fixture team' });
    [department] = await owner.db.select().from(s.department).where(eq(s.department.id, created.id));
  }
  const people = new Map<Key, { employmentId: string; ctx: SessionContext }>();
  for (const key of keys) {
    let [person] = await owner.db.select().from(s.person).where(and(eq(s.person.tenantId, tenantId), eq(s.person.primaryEmail, email(key))));
    let [employment] = person ? await owner.db.select().from(s.employment).where(and(eq(s.employment.personId, person.id), eq(s.employment.companyId, company.id))).orderBy(asc(s.employment.id)) : [];
    if (!person && !employment) {
      const created = await hireEmployee(await context(seedAdmin), { person: { fullName: `Credit fixture ${key}`, primaryEmail: email(key) }, companyId: company.id, departmentId: department.id, employmentType: 'full_time', hiredOn: day(-365) });
      [person] = await owner.db.select().from(s.person).where(eq(s.person.id, created.personId));
      [employment] = await owner.db.select().from(s.employment).where(eq(s.employment.id, created.employmentId));
      await setCompensation(await context(seedAdmin), { employmentId: employment.id, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: employment.hiredOn });
    }
    if (!person || !employment || employment.terminatedOn) throw new Error('Existing fixture employment changed; preserving it.');
    const role: Role = key === 'hr' ? 'hr_admin' : key === 'manager' ? 'manager' : 'employee';
    let [user] = await owner.db.select().from(s.appUser).where(and(eq(s.appUser.tenantId, tenantId), eq(s.appUser.workosUserId, `credit15-fixture:${key}`)));
    if (!user) [user] = await owner.db.insert(s.appUser).values({ tenantId, personId: person.id, workosUserId: `credit15-fixture:${key}`, onboardedAt: new Date() }).returning();
    if (user.personId !== person.id || user.archivedAt) throw new Error('Existing fixture login changed; preserving it.');
    const grants = await owner.db.select().from(s.roleAssignment).where(eq(s.roleAssignment.appUserId, user.id));
    if (!grants.length) await owner.db.insert(s.roleAssignment).values({ tenantId, appUserId: user.id, companyId: company.id, role });
    else if (grants.length !== 1 || grants[0].role !== role || grants[0].companyId !== company.id) throw new Error('Existing fixture role changed; preserving it.');
    people.set(key, { employmentId: employment.id, ctx: await context(user) });
  }
  const hr = people.get('hr')!, employee = people.get('employee')!, manager = people.get('manager')!;
  const [line] = await owner.db.select().from(s.reportingLine).where(and(eq(s.reportingLine.subordinateEmploymentId, employee.employmentId), eq(s.reportingLine.lineType, 'administrative'), isNull(s.reportingLine.validTo), isNull(s.reportingLine.supersededAt)));
  if (!line) await setReportingLine(hr.ctx, { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: day(-365) });
  else if (line.managerEmploymentId !== manager.employmentId) throw new Error('Existing fixture manager changed; preserving it.');
  const [policy] = await owner.db.select().from(s.toilPolicy).where(eq(s.toilPolicy.companyId, company.id));
  if (!policy) await setToilPolicy(hr.ctx, { companyId: company.id, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'lapse', allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true });
  // Stable reasons identify each canonical fixture grant without depending on today's date on reruns.
  for (const [key, days, offset, reversed] of [['employee', 0.5, -20, false], ['employee', 1, -21, false], ['employee', 1.5, -22, true], ['manager', 1, -23, false], ['hr', 1, -24, false]] as const) {
    const subject = people.get(key)!;
    const reason = `Credit15 fixture ${key} ${offset}`;
    let [lot] = await owner.db.select().from(s.toilAccrual).where(and(eq(s.toilAccrual.employmentId, subject.employmentId), eq(s.toilAccrual.note, reason))).orderBy(asc(s.toilAccrual.id));
    if (!lot) {
      await setRestDay(hr.ctx, { employmentId: subject.employmentId, shiftDate: day(offset) });
      const created = await grantLeaveCredit(hr.ctx, { employmentId: subject.employmentId, workedDate: day(offset), days, reason, expiresOn: day(90), today });
      [lot] = await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id, created.accrualId));
      if (reversed) await reverseLeaveCredit(hr.ctx, { accrualId: lot.id, reason: 'Credit fixture correction', today });
    }
  }
  const manifest = [];
  for (const key of keys) {
    const person = people.get(key)!, register = await listOwnEarnedLeaveCredits(person.ctx);
    manifest.push({ role: key, userId: person.ctx.userId, employmentId: person.employmentId, matched: register.matched, rows: register.rows.map(row => ({ id: row.accrualId, status: row.status, earned: row.earned, available: row.available, actorName: row.actorName })) });
  }
  console.log(JSON.stringify({ companyId: company.id, today, manifest }, null, 2));
  await owner.client.end();
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
