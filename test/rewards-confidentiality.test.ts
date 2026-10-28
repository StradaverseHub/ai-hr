import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createRewardUnit, getRewardUnit, importRewardFacts, refreshRewardSources, saveRewardEntry, setRewardMember } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

/** 6fd08f37 — confidentiality derived from administrative reporting lines to the BG CEO / EC seat holders. */
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards derived confidentiality', () => {
  let b: Base, admin: SessionContext, unitId: string, buId: string, gradeId: string;
  const emp: Record<string, { employmentId: string; personId: string }> = {}, actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = (ctx = admin) => getRewardUnit(ctx, unitId);
  const row = async (key: string, ctx = admin) => (await view(ctx)).rows.find(r => r.source.employmentId === emp[key].employmentId);
  async function hire(key: string, inUnit: boolean) {
    const h = await hireEmployee(admin, { person: { fullName: `Confidential ${key}`, primaryEmail: `${key}@confidential.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    if (inUnit) await owner.db.update(schema.assignment).set({ businessUnitId: buId }).where(eq(schema.assignment.employmentId, h.employmentId));
    await owner.db.update(schema.employment).set({ gradeId, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, h.employmentId));
    await setCompensation(admin, { employmentId: h.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const [e] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, h.employmentId));
    emp[key] = { employmentId: h.employmentId, personId: e.personId };
  }
  const line = (sub: string, mgr: string, validFrom = `${year - 2}-01-01`) => owner.db.insert(schema.reportingLine).values({ tenantId: b.tenantId, subordinateEmploymentId: emp[sub].employmentId, managerEmploymentId: emp[mgr].employmentId, lineType: 'administrative', validFrom });
  async function seat(role: RewardRole, personId: string, name: string) {
    const userId = await createAppUser(b.tenantId, personId, 'employee');
    actors[role] = { ...admin, userId, personId, roles: ['employee'], grants: undefined };
    await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    return userId;
  }
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Confidential administrator', primaryEmail: 'administrator@confidential.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [unit] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'CF', name: 'Confidential unit' }).returning(); buId = unit.id;
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning(); gradeId = grade.id;
    await hire('bgCeo', false); await hire('chairman', false);
    for (const key of ['bgReport', 'ecReport', 'plain']) await hire(key, true);
    await line('bgReport', 'bgCeo'); await line('ecReport', 'chairman');
    unitId = await createRewardUnit(admin, { name: 'Confidential rewards', year, companyId: b.companyId, businessUnitId: buId, snapshotDate: today });
    await seat('bg', emp.bgCeo.personId, 'BG CEO'); await seat('ec', emp.chairman.personId, 'Chairman');
    for (const role of ['bu', 'pbp', 'ctro'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${role} reviewer`, primaryEmail: `${role}@confidential.test` }).returning();
      await seat(role, p.id, role);
    }
    for (const r of (await view()).rows) await saveRewardEntry(admin, unitId, (await view()).unit.revision, r.id, r.recommendation, { ...r.facts, reviewed: true, talent: 'SCORE', performance: 'ME' });
  });
  afterAll(closeAll);

  it('marks direct reports of the BG and EC seat holders, with the reason, when the seats are assigned', async () => {
    expect((await row('bgReport'))!).toMatchObject({ facts: { confidentiality: 'bg' }, source: { confidentialityFloor: 'bg', confidentialityReason: { seat: 'bg', managerEmploymentId: emp.bgCeo.employmentId } } });
    expect((await row('ecReport'))!).toMatchObject({ facts: { confidentiality: 'ec' }, source: { confidentialityFloor: 'ec' } });
    expect((await row('plain'))!.facts.confidentiality).toBe('standard');
    expect((await row('plain'))!.source.confidentialityFloor).toBeUndefined();
  });

  it('hides a BG direct report from the BU CEO and PBP and an EC direct report from all but GR/CTRO/EC, totals unchanged', async () => {
    const gr = await view();
    for (const role of ['bu', 'pbp'] as const) {
      const v = await view(actors[role]);
      expect(v.rows.map(r => r.source.employmentId)).toEqual([emp.plain.employmentId]);
      expect(v.hiddenCount).toBe(2);
      expect(v.budgets.standard.payrollCents).toBe(gr.budgets.standard.payrollCents);
    }
    const bg = await view(actors.bg);
    expect(bg.rows.map(r => r.source.employmentId).sort()).toEqual([emp.bgReport.employmentId, emp.plain.employmentId].sort());
    for (const role of ['ctro', 'ec'] as const) expect((await view(actors[role])).rows).toHaveLength(3);
  });

  it('Group Rewards can make a marking stricter but never lower, by screen or import', async () => {
    const r = (await row('bgReport'))!;
    await expect(saveRewardEntry(admin, unitId, (await view()).unit.revision, r.id, r.recommendation, { ...r.facts, confidentiality: 'standard' })).rejects.toThrow(/never lower/);
    await expect(importRewardFacts(admin, unitId, (await view()).unit.revision, [{ employmentId: emp.bgReport.employmentId, facts: { ...r.facts, confidentiality: 'standard' } }])).rejects.toThrow(/never lower/);
    await saveRewardEntry(admin, unitId, (await view()).unit.revision, r.id, r.recommendation, { ...r.facts, confidentiality: 'ec' });
    expect((await row('bgReport'))!.facts.confidentiality).toBe('ec');
  });

  it('re-derives when the BG seat changes person, keeping a stricter manual marking', async () => {
    const plain = (await row('plain'))!;
    await saveRewardEntry(admin, unitId, (await view()).unit.revision, plain.id, plain.recommendation, { ...plain.facts, confidentiality: 'ec' });
    await line('plain', 'bgCeo');
    // The last BG holder cannot be removed (cd72f915), so a stand-in with no reporting lines takes the seat first.
    const [standIn] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Stand-in BG CEO', primaryEmail: 'stand-in-bg@rewards.test' }).returning();
    await setRewardMember(admin, unitId, (await view()).unit.revision, await createAppUser(b.tenantId, standIn.id, 'employee'), 'bg');
    await setRewardMember(admin, unitId, (await view()).unit.revision, actors.bg!.userId!, 'bg', true);
    const after = (await row('bgReport'))!;
    expect(after.facts).toMatchObject({ confidentiality: 'standard', reviewed: false });
    expect(after.source.confidentialityFloor).toBeUndefined();
    expect((await row('plain'))!.facts.confidentiality).toBe('ec');
    await setRewardMember(admin, unitId, (await view()).unit.revision, actors.bg!.userId!, 'bg');
    expect((await row('bgReport'))!.facts.confidentiality).toBe('bg');
    expect((await row('plain'))!).toMatchObject({ facts: { confidentiality: 'ec' }, source: { confidentialityFloor: 'bg' } });
  });

  it('applies a reporting line recorded after creation on refresh, and never shows a viewer their own line', async () => {
    await line('plain', 'chairman', today);
    await refreshRewardSources(admin, unitId, (await view()).unit.revision);
    expect((await row('plain'))!.facts.confidentiality).toBe('ec');
    const self = { ...actors.ctro!, personId: emp.ecReport.personId };
    expect((await view(self)).rows.map(r => r.source.employmentId)).not.toContain(emp.ecReport.employmentId);
  });
});
