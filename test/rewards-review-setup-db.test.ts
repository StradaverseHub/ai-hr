import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {configureRewardFixture,refreshRewardFixtureBudget} from './rewards-governance-fixture';
import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { getRewardPreparationChecklist, getRewardUnit, rewardNavigation, rewardReviewSetupList, saveRewardEntry } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

/**
 * 70d5e7c5 — Configuration › Review Set-up: Group Rewards edits, CTRO and EC view, every other seat is refused;
 * reviews from before step tracking list as Released; an exclusion window outside the review year is flagged
 * and blocks its step.
 */
const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
describe('Review Set-up list and checks (70d5e7c5)', () => {
  let b: Base, admin: SessionContext, unitId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional set-up doer', primaryEmail: 'doer@setup.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'SET', name: 'Fictional set-up unit' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const hire = await hireEmployee(admin, { person: { fullName: 'Fictional Set-up Employee', primaryEmail: 'employee@setup.test' }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
    await owner.withTenant(admin, tx => tx.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, hire.employmentId)));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, hire.employmentId));
    await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    unitId = await createApprovedRewardUnit(admin, { name: 'Fictional annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Fictional ${role} seat`, primaryEmail: `${role}@setup.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    const v = await view();
    await configureRewardFixture(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, targetMonthsBp: 20000, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(admin, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    await refreshRewardFixtureBudget(admin, unitId);
  });
  afterAll(closeAll);

  it('lists the review for Group Rewards (edit), CTRO and EC (view) and refuses BU CEO, BG CEO and PBP', async () => {
    const gr = await rewardReviewSetupList(admin);
    expect(gr.allowed).toBe(true);
    if (!gr.allowed) return;
    expect(gr.editor).toBe(true);
    expect(gr.rows.map(row => row.unitId)).toEqual([unitId]);
    // A review created before step tracking already went to its BU CEO: Released, steps done before tracking.
    expect(gr.rows[0]).toMatchObject({ status: 'released', legacy: true, stepsDone: 6, unit: 'SET', windowOutsideYear: false });
    expect(gr.total).toBe(1);
    for (const role of ['ctro', 'ec'] as const) {
      const seen = await rewardReviewSetupList(actors[role]!);
      expect(seen).toMatchObject({ allowed: true, editor: false });
    }
    for (const role of ['bu', 'bg', 'pbp'] as const) expect(await rewardReviewSetupList(actors[role]!)).toEqual({ allowed: false });
    expect(await rewardNavigation(admin)).toContain('/admin/rewards/review-setup');
    expect(await rewardNavigation(actors.bu!)).not.toContain('/admin/rewards/review-setup');
  });

  it('derives Preparing for a tracked review and filters by status in SQL', async () => {
    await owner.db.execute(sql`update public.reward_unit set preparation_required=true where id=${unitId}::uuid`);
    const all = await rewardReviewSetupList(admin);
    expect(all.allowed && all.rows[0]).toMatchObject({ status: 'preparing', legacy: false, stepsDone: 0 });
    const released = await rewardReviewSetupList(admin, { status: 'released' });
    expect(released.allowed && released.rows).toEqual([]);
    expect(released.allowed && released.total).toBe(0);
    // While it is being prepared, the BU CEO seat is withheld, so the list stays closed to them.
    expect(await rewardReviewSetupList(actors.bu!)).toEqual({ allowed: false });
  });

  it("flags an exclusion window outside the review's own year and keeps that step from completing", async () => {
    await owner.db.execute(sql`update public.reward_unit set preparation_required=true,
      policy=jsonb_set(jsonb_set(policy,'{blockedFrom}',to_jsonb(${`${year - 1}-10-01`}::text)),'{blockedTo}',to_jsonb(${`${year - 1}-12-31`}::text)) where id=${unitId}::uuid`);
    const list = await rewardReviewSetupList(admin);
    expect(list.allowed && list.rows[0].windowOutsideYear).toBe(true);
    const checklist = await getRewardPreparationChecklist(admin, unitId);
    expect(checklist.exclusionWindow).toEqual({ from: `${year - 1}-10-01`, to: `${year - 1}-12-31`, outsideYear: true });
    expect(checklist.checks?.excluded).toBe(false);
    // The live review's dates are reported, never rewritten.
    expect((await view()).unit.policy.blockedFrom).toBe(`${year - 1}-10-01`);
  });
});
