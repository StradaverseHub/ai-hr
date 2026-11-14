import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { getRewardUnit, saveRewardEntry, decideRewardUnit } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

/**
 * 37f82412 — the simplified Review tab's server rules: the BG CEO edits recommendations at the BG CEO step
 * (the review stays there and the submitted digest is re-stamped), the approver projection leaves out the
 * calculation workings, the note survives forms that do not carry it, and visibility totals still include
 * people a seat may not see.
 */
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Rewards review desk (37f82412)', () => {
  let b: Base, admin: SessionContext, unitId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = (ctx: SessionContext = admin) => getRewardUnit(ctx, unitId);
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional rewards administrator', primaryEmail: 'administrator@desk.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'DESK', name: 'Fictional desk unit' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Fictional Desk Employee', primaryEmail: 'employee@desk.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.withTenant(admin, tx => tx.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, hire.employmentId)));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, hire.employmentId));
    await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    unitId = await createApprovedRewardUnit(admin, { name: 'Fictional annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Fictional ${role} reviewer`, primaryEmail: `${role}@desk.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin;
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
    const v = await view();
    await configureRewardFixture(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, targetMonthsBp: 20000, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    await refreshRewardFixtureBudget(admin, unitId);
  });
  afterAll(closeAll);
  const submit = async () => { const rev = (await view()).unit.revision; expect(await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Fictional recommendations reviewed')).toBe('bg'); };

  it('lets the BG CEO change a recommendation at the BG CEO step and then approve, keeping the review at its stage', async () => {
    await submit();
    const before = await view(actors.bg!), row = before.rows[0];
    expect(before.unit.status).toBe('bg');
    expect(before.canEdit).toBe(true);
    // 4% stays inside the 5% merit pool, so only the "differs from the matrix" exception is raised.
    await saveRewardEntry(actors.bg!, unitId, before.unit.revision, row.id, { ...row.recommendation, meritBp: 400 });
    const after = await view(actors.bg!);
    expect(after.unit.status).toBe('bg');
    expect(after.unit.revision).toBe(before.unit.revision + 1);
    expect(after.rows[0].meritBp).toBe(400);
    // 5,000.00 basic at 4% merit is 200.00.
    expect(after.rows[0].meritCents).toBe(20000);
    // The re-stamped digest keeps the next approval admissible without returning the review.
    expect(await decideRewardUnit(actors.bg!, unitId, after.unit.revision, 'approve', 'Fictional BG CEO adjustment accepted')).toBe('gr');
  });

  it('re-stamps the submitted digest from the stored rows after a whole-group approval-step edit, so the next approval is admitted', async () => {
    // The whole-group GR/CTRO/EC edit shares the BG CEO step's re-stamp: jsonb reorders recommendation keys,
    // so a digest of the in-memory recommendation would not match the rows the next approval reads back.
    const hire = await hireEmployee(admin, { person: { fullName: 'Fictional whole-group Rewards holder', primaryEmail: 'group@desk.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    const [holder] = await owner.db.select({ personId: schema.employment.personId }).from(schema.employment).where(eq(schema.employment.id, hire.employmentId));
    const groupUserId = await createAppUser(b.tenantId, holder.personId, 'employee');
    await withTenant(admin, tx => tx.execute(sql`select app.reward_save_group_role(${groupUserId}::uuid, 'gr', true, 0, 'Verified fictional whole-group role')`));
    const group: SessionContext = { ...admin, userId: groupUserId, personId: holder.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await submit();
    const atBg = await view(actors.bg!);
    expect(await decideRewardUnit(actors.bg!, unitId, atBg.unit.revision, 'approve', 'Fictional BG CEO approval')).toBe('gr');
    const before = await view(group), row = before.rows[0];
    expect(before.unit.status).toBe('gr');
    expect(before.canEdit).toBe(true);
    await saveRewardEntry(group, unitId, before.unit.revision, row.id, { ...row.recommendation, meritBp: 450 });
    const after = await view(admin);
    expect(after.unit.status).toBe('gr');
    expect(after.unit.revision).toBe(before.unit.revision + 1);
    expect(after.rows[0].meritBp).toBe(450);
    // 5,000.00 basic at 4.5% merit is 225.00.
    expect(after.rows[0].meritCents).toBe(22500);
    expect(await decideRewardUnit(admin, unitId, after.unit.revision, 'approve', 'Fictional Group Rewards approval after the edit')).toBe('ctro');
  });

  it('refuses classification changes by the BG CEO, BU CEO edits after submission and stale revisions', async () => {
    await submit();
    const v = await view(actors.bg!), row = v.rows[0];
    await expect(saveRewardEntry(actors.bg!, unitId, v.unit.revision, row.id, row.recommendation, { ...row.facts, talent: 'STAR' })).rejects.toThrow(/Only the recommendation|Only Group Rewards/);
    await expect(saveRewardEntry(actors.bu!, unitId, v.unit.revision, row.id, { ...row.recommendation, meritBp: 800 })).rejects.toThrow(/Return the unit to draft|cannot edit/);
    await saveRewardEntry(actors.bg!, unitId, v.unit.revision, row.id, { ...row.recommendation, meritBp: 650 });
    await expect(saveRewardEntry(actors.bg!, unitId, v.unit.revision, row.id, { ...row.recommendation, meritBp: 600 })).rejects.toThrow(/changed in another session/);
    expect((await view()).rows[0].meritBp).toBe(650);
  });

  it('gives BU CEO and PBP the approver projection without calculation workings, and Group Rewards the full view', async () => {
    const bu = await view(actors.bu!), gr = await view(admin);
    expect(bu.fullView).toBe(false);
    expect(bu.suggestion).toBeNull();
    expect(bu.lumpWorking).toEqual([]);
    expect(bu.ec).toBeNull();
    expect(gr.fullView).toBe(true);
    expect(gr.ec).not.toBeNull();
    // Pay position is worked out by the service: 5,000 basic against a 5,000 midpoint is 100%.
    expect(gr.rows[0].crBeforeBp).toBe(10000);
    expect(gr.rows[0].totalIncreaseBp).toBe(gr.rows[0].meritBp + gr.rows[0].promotionBp + gr.rows[0].specialBp);
    expect((await view(actors.pbp!)).fullView).toBe(false);
  });

  it('keeps a saved note when a form does not send one, and stores it within its cap', async () => {
    const v = await view(), row = v.rows[0];
    await saveRewardEntry(actors.bu!, unitId, v.unit.revision, row.id, { ...row.recommendation, note: 'Fictional note for the BG CEO.' });
    const noted = await view();
    expect(noted.rows[0].recommendation.note).toBe('Fictional note for the BG CEO.');
    const { note: _note, ...withoutNote } = noted.rows[0].recommendation;
    await saveRewardEntry(actors.bu!, unitId, noted.unit.revision, row.id, { ...withoutNote, meritBp: 500 });
    const kept = await view();
    expect(kept.rows[0].recommendation.note).toBe('Fictional note for the BG CEO.');
    await expect(saveRewardEntry(actors.bu!, unitId, kept.unit.revision, row.id, { ...kept.rows[0].recommendation, note: 'x'.repeat(2001) })).rejects.toThrow();
  });

  it('hides a BG-confidential person from the BU CEO while the unit totals still include them', async () => {
    const v = await view(), row = v.rows[0];
    await saveRewardEntry(admin, unitId, v.unit.revision, row.id, row.recommendation, { ...row.facts, confidentiality: 'bg' });
    await refreshRewardFixtureBudget(admin, unitId);
    const full = await view(), bu = await view(actors.bu!);
    expect(full.rows).toHaveLength(1);
    expect(bu.rows).toHaveLength(0);
    expect(bu.hiddenCount).toBe(1);
    expect(bu.budgets.standard.used[0]).toBe(full.budgets.standard.used[0]);
    expect(bu.budgets.standard.used[0]).toBeGreaterThan(0);
  });
});
