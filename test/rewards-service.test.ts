import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, setPayrollInput } from '../packs/payroll/service';
import { createOffcycleReview, createRewardUnit, getRewardUnit, saveRewardEntry, saveRewardPolicy, setRewardMember, decideRewardUnit, postRewardUnit } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards persistence, authorization and atomic enactment', () => {
  let b: Base, admin: SessionContext, unitId: string, employmentId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Reward Employee', primaryEmail: 'employee@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    employmentId = hire.employmentId;
    await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employmentId));
    await setCompensation(admin, { employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    unitId = await createRewardUnit(admin, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${role} reviewer`, primaryEmail: `${role}@rewards.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin; actors.payroll = admin;
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
  });
  afterAll(closeAll);
  async function approve() {
    const rev = (await view()).unit.revision;
    expect(await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations')).toBe('bg');
    for (const role of ['bg', 'gr', 'ctro', 'ec'] as const) await decideRewardUnit(actors[role]!, unitId, rev, 'approve', 'Reviewed recommendations');
    return rev;
  }
  it('snapshots real employment and compensation and rejects stale forms', async () => {
    const v = await view(); expect(v.rows[0].source.employmentId).toBe(employmentId); expect(v.rows[0].newBasicCents).toBe(522500);
    await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation);
    await expect(saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/another session/);
  });
  it('enforces tenant, live membership, module and read-only boundaries', async () => {
    const v = await view();
    await expect(saveRewardEntry(actors.pbp!, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/cannot edit|not found/);
    await setRewardMember(admin, unitId, v.unit.revision, actors.bu!.userId!, 'bu', true);
    await expect(getRewardUnit(actors.bu!, unitId)).rejects.toThrow(/not found|removed/);
    expect(await withTenant(actors.bu!, tx => tx.select().from(schema.rewardEntry))).toEqual([]);
    const other = await seedBase(); await setModule(other.tenantId, 'rewards', 'active');
    await expect(getRewardUnit(await entitledCtx(other), unitId)).rejects.toThrow(/not found|removed/);
    await setModule(b.tenantId, 'rewards', null);
    await expect(getRewardUnit(await entitledCtx(b), unitId)).rejects.toThrow();
  });
  it('revokes archived reviewer access even with an existing session and refuses an incomplete route', async () => {
    const ctx = actors.bg!;
    expect((await getRewardUnit(ctx, unitId)).rows).toHaveLength(1);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, ctx.userId!));
    await expect(getRewardUnit(ctx, unitId)).rejects.toThrow();
    expect(await withTenant(ctx, tx => tx.select().from(schema.rewardEntry))).toEqual([]);
    await expect(decideRewardUnit(actors.bu!, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).rejects.toThrow(/Assign every approval role/);
  });
  it('allows BU case decisions but refuses a classification or rating change', async () => {
    const v = await getRewardUnit(actors.bu!, unitId), e = v.rows[0];
    await saveRewardEntry(actors.bu!, unitId, v.unit.revision, e.id, e.recommendation, { ...e.facts, erDecision: 'in', caseReason: 'Reviewed with the people business partner' });
    const fresh = await getRewardUnit(actors.bu!, unitId);
    expect(fresh.rows[0].facts.erDecision).toBe('in');
    await expect(saveRewardEntry(actors.bu!, unitId, fresh.unit.revision, e.id, e.recommendation, { ...fresh.rows[0].facts, confidentiality: 'ec' })).rejects.toThrow(/Only Group Rewards/);
  });
  it('does not serialize own-person or EC reward rows to unauthorized viewers', async () => {
    const v = await view(), row = v.rows[0];
    await saveRewardEntry(admin, unitId, v.unit.revision, row.id, row.recommendation, { ...row.facts, confidentiality: 'ec' });
    await saveRewardEntry(admin, unitId, (await view()).unit.revision, row.id, { ...row.recommendation, bonusCents: 987654321 });
    const bu = await getRewardUnit(actors.bu!, unitId);
    expect(bu.rows).toEqual([]); expect(bu.ec).toBeNull(); expect(JSON.stringify(bu)).not.toContain('987654321');
    // Give the employee a genuine review role; self exclusion still wins.
    const userId = await createAppUser(b.tenantId, row.source.personId, 'employee');
    await setRewardMember(admin, unitId, (await view()).unit.revision, userId, 'gr');
    const self = await getRewardUnit({ ...actors.bu!, userId, personId: row.source.personId }, unitId);
    expect(self.rows).toEqual([]); expect(self.ec?.count).toBe(0);
    await expect(saveRewardEntry({ ...actors.bu!, userId, personId: row.source.personId }, unitId, self.unit.revision, row.id, row.recommendation)).rejects.toThrow(/not available/);
  });
  it('checks approval order, freezes submitted inputs and can reopen an unposted approval', async () => {
    const v = await view();
    await expect(decideRewardUnit(actors.ec!, unitId, v.unit.revision, 'approve', 'Approved')).rejects.toThrow(/current approval stage/);
    const rev = await approve();
    await expect(saveRewardEntry(admin, unitId, rev, v.rows[0].id, v.rows[0].recommendation)).rejects.toThrow(/Return/);
    expect(await decideRewardUnit(admin, unitId, rev, 'return', 'Source salary needs refreshing')).toBe('draft');
    expect((await view()).unit.revision).toBe(rev + 1);
  });
  it('posts exactly once, adds awards to existing payroll and preserves unrelated inputs', async () => {
    const rev = await approve();
    const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setPayrollInput(admin, { batchId: batch.batchId, employmentId, overtimeAmount: 123, bonusAmount: 80, tp1Deduction: 44, zakat: 9 });
    const results = await Promise.all([postRewardUnit(admin, unitId, rev, batch.batchId), postRewardUnit(admin, unitId, rev, batch.batchId)]);
    expect(results.map(r => r.alreadyPosted).sort()).toEqual([false, true]);
    const [comp] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
    expect(Number(comp.basicSalary)).toBe(5225);
    const [input] = await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId));
    expect(Number(input.bonusAmount)).toBe(10055); expect(Number(input.overtimeAmount)).toBe(123); expect(Number(input.tp1Deduction)).toBe(44); expect(Number(input.zakat)).toBe(9);
    expect((await view()).unit.status).toBe('posted');
  });
  it('a changed salary rejects posting without writing any award', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setCompensation(admin, { employmentId, basicSalary: 5500, effectiveFrom: `${year - 1}-01-01` });
    await expect(postRewardUnit(admin, unitId, rev, batch.batchId)).rejects.toThrow(/Salary data changed/);
    expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId))).toEqual([]);
    expect((await view()).unit.status).toBe('approved');
  });
  it('rolls back earlier employee writes when a later salary is stale', async () => {
    const initial = (await view()).rows[0];
    const hire = await hireEmployee(admin, { person: { fullName: 'Second Reward Employee', primaryEmail: 'second@rewards.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.db.update(schema.employment).set({ gradeId: initial.source.gradeId }).where(eq(schema.employment.id, hire.employmentId));
    const comp = await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const [employee] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, hire.employmentId));
    await owner.db.insert(schema.rewardEntry).values({ tenantId: b.tenantId, unitId, employmentId: hire.employmentId, source: { ...initial.source, employmentId: hire.employmentId, personId: employee.personId, compensationId: comp.compensationId }, facts: initial.facts, recommendation: initial.recommendation });
    const ordered = [employmentId, hire.employmentId].sort((a, b) => a.localeCompare(b));
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await setCompensation(admin, { employmentId: ordered[1], basicSalary: 5500, effectiveFrom: `${year - 1}-01-01` });
    await expect(postRewardUnit(admin, unitId, rev, batch.batchId)).rejects.toThrow(/Salary data changed/);
    const [unchanged] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, ordered[0]), isNull(schema.compensation.validTo)));
    expect(Number(unchanged.basicSalary)).toBe(5000);
    expect(await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batch.batchId))).toEqual([]);
    expect((await view()).unit.status).toBe('approved');
  });
  it('posts an approved off-cycle increase once and retains its funding consumption', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await postRewardUnit(admin, unitId, rev, batch.batchId);
    const parent = await view();
    const childId = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
    let child = await getRewardUnit(actors.bu!, childId);
    await saveRewardEntry(actors.bu!, childId, child.unit.revision, child.rows[0].id, { ...child.rows[0].recommendation, meritBp: 100, reason: 'Expanded responsibilities' });
    child = await getRewardUnit(actors.bu!, childId);
    await decideRewardUnit(actors.bu!, childId, child.unit.revision, 'submit', 'Reviewed recommendations');
    for (const role of ['bg', 'gr', 'ctro'] as const) await decideRewardUnit(actors[role]!, childId, child.unit.revision, 'approve', 'Reviewed recommendations');
    expect(await postRewardUnit(admin, childId, child.unit.revision)).toEqual({ alreadyPosted: false });
    expect(await postRewardUnit(admin, childId, child.unit.revision)).toEqual({ alreadyPosted: true });
    const [salary] = await owner.db.select().from(schema.compensation).where(and(eq(schema.compensation.employmentId, employmentId), isNull(schema.compensation.validTo)));
    expect(Number(salary.basicSalary)).toBe(5277);
    const nextId = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-03-01`, exceptionReason: '' });
    expect((await getRewardUnit(actors.bu!, nextId)).budgets.standard.pools[0]).toBe(7300);
  });
  it('reserves annual remainder atomically and rejects a concurrent duplicate employee request', async () => {
    const rev = await approve(); const batch = await createBatch(admin, { companyId: b.companyId, payPeriod: today.slice(0, 7) });
    await postRewardUnit(admin, unitId, rev, batch.batchId);
    const parent = await view();
    expect(parent.unit.fundingCents.standard).toBe(12500);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await createOffcycleReview(actors.bu!, unitId, { kind: 'adhoc', entryIds: [parent.rows[0].id], effectiveFrom: `${year + 1}-02-01`, exceptionReason: '' });
      const v = await getRewardUnit(actors.bu!, id);
      await saveRewardEntry(actors.bu!, id, v.unit.revision, v.rows[0].id, { ...v.rows[0].recommendation, meritBp: 100, reason: 'Expanded responsibilities' });
      ids.push(id);
    }
    const results = await Promise.allSettled(ids.map(async id => decideRewardUnit(actors.bu!, id, (await getRewardUnit(actors.bu!, id)).unit.revision, 'submit', 'Reviewed off-cycle request')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const accepted = ids[results.findIndex(r => r.status === 'fulfilled')];
    let v = await getRewardUnit(actors.bg!, accepted);
    expect(v.unit.reservedCents.standard).toBe(5200);
    await decideRewardUnit(actors.bg!, accepted, v.unit.revision, 'return', 'Please revise the business case');
    const other = ids.find(id => id !== accepted)!;
    v = await getRewardUnit(actors.bu!, other);
    expect(await decideRewardUnit(actors.bu!, other, v.unit.revision, 'submit', 'Revised and ready for approval')).toBe('bg');
  });

});
