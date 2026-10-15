import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { grantLeaveCredit, listEarnedLeaveCredits, listOwnEarnedLeaveCredits, setToilPolicy } from '../core/toil';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
let admin: SessionContext;
const today = todayInKualaLumpur();
const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

async function hire(name: string) {
  const employee = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `own-credit-${randomUUID()}@test.local` },
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: day(-365),
  });
  await setCompensation(adminCtx(b), { employmentId: employee.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: day(-365) });
  return employee;
}

async function login(personId: string, role: 'employee' | 'manager' | 'hr_admin' = 'employee'): Promise<SessionContext> {
  return { ...admin, personId, userId: await createAppUser(b.tenantId, personId, role), roles: [role], grants: [{ role, companyId: b.companyId }] };
}

async function grant(ctx: SessionContext, employmentId: string, workedDate = day(-20)) {
  await setRestDay(adminCtx(b), { employmentId, shiftDate: workedDate });
  return grantLeaveCredit(ctx, { employmentId, workedDate, days: 1, reason: 'Extra rest-day work', expiresOn: day(90), today });
}

const actorNames = (ctx: SessionContext, lotIds: string[]) => withTenant(ctx, async tx =>
  await tx.execute(sql`SELECT event_id, actor_name FROM app.own_earned_credit_actors(${`{${lotIds.join(',')}}`}::uuid[]) ORDER BY event_id`) as unknown as { event_id: string; actor_name: string | null }[]);

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  admin = await entitledCtx(b);
  await setToilPolicy(admin, { companyId: b.companyId, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'lapse', allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true });
});

describe('Personal earned-credit actor names and identity boundaries', () => {
  it('shows the same grant actor as HR without making the actor profile readable', async () => {
    const employee = await hire('Personal credit employee'), hrPerson = await hire('Named HR grant actor');
    const employeeCtx = await login(employee.personId), hrCtx = await login(hrPerson.personId, 'hr_admin');
    const lot = await grant(hrCtx, employee.employmentId);
    const hiddenProfile = await withTenant(employeeCtx, tx => tx.select({ name: s.person.fullName }).from(s.person).where(eq(s.person.id, hrPerson.personId)));
    expect(hiddenProfile, 'non-vacuity: the employee cannot read HR’s profile through RLS').toEqual([]);
    const mine = await listOwnEarnedLeaveCredits(employeeCtx, { today });
    const hr = await listEarnedLeaveCredits(hrCtx, { employmentId: employee.employmentId, today });
    expect(mine).toEqual(hr);
    expect(mine.rows).toHaveLength(1);
    expect(mine.rows[0]).toMatchObject({ accrualId: lot.accrualId, actorName: 'Named HR grant actor', actorIsSystem: false });
    expect(await withTenant(employeeCtx, tx => tx.select({ name: s.person.fullName }).from(s.person).where(eq(s.person.id, hrPerson.personId)))).toEqual([]);
  });

  it('the name reader has no manager, HR, missing-login, cross-tenant or temporary-table bypass', async () => {
    const employee = await hire('Owned lot'), manager = await hire('Manager with downward access'), colleague = await hire('Another person'), hrPerson = await hire('Original HR actor');
    const own = await login(employee.personId), managerCtx = await login(manager.personId, 'manager'), other = await login(colleague.personId), hr = await login(hrPerson.personId, 'hr_admin');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: employee.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: day(-300) });
    const lot = await grant(hr, employee.employmentId);
    expect((await withTenant(managerCtx, tx => tx.select({ id: s.toilAccrual.id }).from(s.toilAccrual).where(eq(s.toilAccrual.id, lot.accrualId))))).toHaveLength(1);
    expect(await actorNames(own, [lot.accrualId])).toEqual([expect.objectContaining({ actor_name: 'Original HR actor' })]);
    for (const ctx of [managerCtx, other, hr, { ...own, userId: undefined }]) expect(await actorNames(ctx, [lot.accrualId])).toEqual([]);
    const foreign = await seedBase();
    expect(await actorNames({ ...own, tenantId: foreign.tenantId }, [lot.accrualId])).toEqual([]);
    expect(await actorNames(own, [randomUUID()])).toEqual([]);
    const shadowed = await withTenant(other, async tx => {
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO pg_temp.app_user VALUES (${other.userId}::uuid, ${b.tenantId}::uuid, ${employee.personId}::uuid)`);
      return tx.execute(sql`SELECT event_id FROM app.own_earned_credit_actors(${`{${lot.accrualId}}`}::uuid[])`);
    });
    expect(shadowed as unknown as unknown[]).toEqual([]);
  });

  it('a manager’s personal register excludes a report whom RLS allows them to read', async () => {
    const report = await hire('Report'), manager = await hire('Manager own credit');
    const ctx = await login(manager.personId, 'manager');
    await setReportingLine(adminCtx(b), { subordinateEmploymentId: report.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: day(-300) });
    await grant(admin, report.employmentId);
    const ownLot = await grant(admin, manager.employmentId);
    expect(await withTenant(ctx, tx => tx.select({ id: s.toilAccrual.id }).from(s.toilAccrual).orderBy(s.toilAccrual.id))).toHaveLength(2);
    expect((await listOwnEarnedLeaveCredits(ctx, { today })).rows.map(row => row.accrualId)).toEqual([ownLot.accrualId]);
  });

  it('includes historical employments across companies belonging to the same person only', async () => {
    const employee = await hire('Rehired person'), other = await hire('Other person');
    const ctx = await login(employee.personId);
    const [company] = await owner.db.insert(s.company).values({ tenantId: b.tenantId, legalName: 'Other own employment company', country: 'MY' }).returning();
    const [historical] = await owner.db.insert(s.employment).values({ tenantId: b.tenantId, personId: employee.personId, companyId: company.id, hiredOn: day(-730), terminatedOn: day(-400), employeeCode: 'OLD-OWN' }).returning();
    const ids = [employee.employmentId, historical.id, other.employmentId];
    await owner.db.insert(s.toilAccrual).values(ids.map(employmentId => ({ tenantId: b.tenantId, employmentId, workedDate: day(-30), otMinutes: 0, daysCredited: '1.00', daysTaken: '0.00', accrualBasis: 'hours_worked' as const, expiresOn: day(90) })));
    const mine = await listOwnEarnedLeaveCredits(ctx, { today });
    expect(new Set(mine.rows.map(row => row.employmentId))).toEqual(new Set([employee.employmentId, historical.id]));
    expect(mine.matched).toBe(2);
    for (const forged of [{ employmentId: other.employmentId }, { companyIds: [company.id] }, { personId: other.personId }, { tenantId: randomUUID() }]) {
      await expect(listOwnEarnedLeaveCredits(ctx, forged as never)).rejects.toThrow(/cannot select another employee/);
    }
    await setModule(b.tenantId, 'toil', 'disabled');
    const disabledEntitlements = (await entitledCtx(b)).entitlements;
    expect((await listOwnEarnedLeaveCredits({ ...ctx, entitlements: disabledEntitlements }, { today })).rows).toEqual(mine.rows);
  });

  it('keeps unknown grant and usage provenance unknown, with identical owner figures', async () => {
    const employee = await hire('Legacy own credit'), ctx = await login(employee.personId);
    const [lot] = await owner.db.insert(s.toilAccrual).values({ tenantId: b.tenantId, employmentId: employee.employmentId, workedDate: day(-40), otMinutes: 0, daysCredited: '2.00', daysTaken: '0.50', accrualBasis: 'hours_worked', expiresOn: day(90) }).returning();
    const mine = await listOwnEarnedLeaveCredits(ctx, { today });
    expect(mine).toEqual(await listEarnedLeaveCredits(admin, { employmentId: employee.employmentId, today }));
    expect(mine.rows).toEqual([expect.objectContaining({ accrualId: lot.id, actorName: null, actorIsSystem: false, earned: 2, used: 0.5, available: 1.5, usage: [], unattributedUsed: 0.5, status: 'partially_used' })]);
    expect(await actorNames(ctx, [lot.id])).toEqual([]);
  });

  it('ignores an event linked to the wrong owned employment instead of inventing a grant actor', async () => {
    const employee = await hire('Two own employment identities'), wrongActor = await hire('Wrongly linked actor'), rightActor = await hire('Legitimate grant actor');
    const ctx = await login(employee.personId), wrong = await login(wrongActor.personId, 'hr_admin'), right = await login(rightActor.personId, 'hr_admin');
    const [secondEmployment] = await owner.db.insert(s.employment).values({ tenantId: b.tenantId, personId: employee.personId, companyId: b.companyId, hiredOn: day(-730), terminatedOn: day(-400), employeeCode: 'OLD-SAME-PERSON' }).returning();
    const recordedAt = new Date(`${day(-39)}T01:00:00Z`);
    const [firstLot] = await owner.db.insert(s.toilAccrual).values({ tenantId: b.tenantId, employmentId: employee.employmentId, workedDate: day(-40), createdAt: recordedAt, otMinutes: 0, daysCredited: '1.00', daysTaken: '0.00', accrualBasis: 'hours_worked', expiresOn: day(90) }).returning();
    await owner.db.insert(s.toilAccrual).values({ tenantId: b.tenantId, employmentId: secondEmployment.id, workedDate: day(-41), otMinutes: 0, daysCredited: '1.00', daysTaken: '0.00', accrualBasis: 'hours_worked', expiresOn: day(90) });
    // Both employments are in the shared register's SQL scope, so only the subject correlation can
    // distinguish the damaged event. There is no ledger fallback on this legacy lot.
    await owner.db.insert(s.domainEvent).values({ tenantId: b.tenantId, aggregateType: 'toil-accrual', aggregateId: firstLot.id, eventType: 'toil.accrued', subjectEmploymentId: secondEmployment.id, actorType: 'user', actorId: wrong.userId, occurredAt: recordedAt });
    const unknown = await listOwnEarnedLeaveCredits(ctx, { today });
    expect(unknown).toEqual(await listEarnedLeaveCredits(admin, { today }));
    expect(unknown.rows.find(row => row.accrualId === firstLot.id)?.actorName).toBeNull();
    expect(await actorNames(ctx, [firstLot.id])).toEqual([]);
    await owner.db.insert(s.domainEvent).values({ tenantId: b.tenantId, aggregateType: 'toil-accrual', aggregateId: firstLot.id, eventType: 'toil.accrued', subjectEmploymentId: employee.employmentId, actorType: 'user', actorId: right.userId, occurredAt: recordedAt });
    const known = await listOwnEarnedLeaveCredits(ctx, { today });
    expect(known).toEqual(await listEarnedLeaveCredits(admin, { today }));
    expect(known.rows.find(row => row.accrualId === firstLot.id)?.actorName).toBe('Legitimate grant actor');
  });

  it('uses date, recorded instant and immutable ID ordering across equal-date page boundaries', async () => {
    const employee = await hire('Equal-date credit corrections'), ctx = await login(employee.personId);
    const rows = Array.from({ length: 31 }, (_, i) => ({ id: randomUUID(), tenantId: b.tenantId, employmentId: employee.employmentId, workedDate: day(-40), createdAt: new Date(`${day(-39)}T${String(i % 3).padStart(2, '0')}:00:00Z`), otMinutes: 0, daysCredited: '1.00', daysTaken: '0.00', accrualBasis: 'hours_worked' as const, expiresOn: day(90), status: 'reversed' as const }));
    await owner.db.insert(s.toilAccrual).values(rows);
    const expected = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).map(row => row.id);
    const first = await listOwnEarnedLeaveCredits(ctx, { today, limit: 25 }), second = await listOwnEarnedLeaveCredits(ctx, { today, limit: 25, offset: 25 });
    expect([...first.rows, ...second.rows].map(row => row.accrualId)).toEqual(expected);
    expect(first.matched).toBe(31);
    expect(second.rows).toHaveLength(6);
    expect(await listOwnEarnedLeaveCredits(ctx, { today, limit: 25, offset: 25 })).toEqual(second);
    expect((await listOwnEarnedLeaveCredits(ctx, { today, from: day(-40), to: day(-40), status: 'reversed' })).matched).toBe(31);
    expect((await listOwnEarnedLeaveCredits(ctx, { today, from: day(-39) })).matched).toBe(0);
  });

  it('grants only the name reader, with a pinned search path and a closed result shape', async () => {
    const result = await owner.db.execute(sql`
      SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) AS result,
             has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') AS app_exec,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'own_earned_credit_actors'
    `);
    expect(result as unknown as unknown[]).toEqual([{ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, pg_temp'], result: 'TABLE(event_id uuid, actor_name text)', app_exec: true, public_exec: false }]);
  });
});
