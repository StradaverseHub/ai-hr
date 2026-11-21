import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import * as schema from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { rewardAnalytics, type AnalyticsSelection } from '../packs/rewards/analytics';
import { getRewardUnit, saveRewardEntry } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule } from './harness';
import { createApprovedRewardUnit } from './rewards-setup-fixture';
import { configureRewardFixture, refreshRewardFixtureBudget } from './rewards-governance-fixture';
import { setRewardMember } from './rewards-access-fixture';

const selection: AnalyticsSelection = {
  cycleId: null, companyId: null, businessUnitId: null, unitId: null, groupId: null, uploaded: 'include',
};

afterAll(closeAll);

describe('Rewards Analytics native authority and reconciliation', () => {
  it('shows authorized live figures without own records or PAT to BU, and returns no metadata across tenants', async () => {
    await resetDb();
    const b = await seedBase();
    await setModule(b.tenantId, 'rewards', 'active');
    const [adminPerson] = await owner.db.insert(schema.person).values({
      tenantId: b.tenantId, fullName: 'Fictional Analytics administrator', primaryEmail: 'analytics-admin@rewards.test',
    }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, b.adminUserId));
    const admin = { ...await entitledCtx(b), personId: adminPerson.id };
    const [unit] = await owner.db.insert(schema.businessUnit).values({
      tenantId: b.tenantId, companyId: b.companyId, code: 'ANALYTICS', name: 'Fictional Analytics unit',
    }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
    const hire = async (name: string, email: string, basicSalary: number) => {
      const employee = await hireEmployee(admin, {
        person: { fullName: name, primaryEmail: email },
        companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01`,
      });
      await owner.withTenant(admin, tx => tx.update(schema.assignment).set({ businessUnitId: unit.id }).where(eq(schema.assignment.employmentId, employee.employmentId)));
      await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employee.employmentId));
      await setCompensation(admin, { employmentId: employee.employmentId, basicSalary, effectiveFrom: `${year - 2}-01-01` });
      return employee;
    };
    const own = await hire('Fictional private own line', 'analytics-own@rewards.test', 9876);
    await hire('Fictional visible peer', 'analytics-peer@rewards.test', 5000);
    const id = await createApprovedRewardUnit(admin, { name: 'Annual Rewards Analytics', year, companyId: b.companyId, businessUnitId: unit.id, snapshotDate: today });
    const reviewer = { ...admin, userId: await createAppUser(b.tenantId, own.personId, 'employee'), personId: own.personId, roles: ['employee'], grants: undefined };
    await setRewardMember(admin, id, (await getRewardUnit(admin, id)).unit.revision, reviewer.userId, 'bu');
    const before = await getRewardUnit(admin, id);
    await configureRewardFixture(admin, id, before.unit.revision, {
      ...before.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100,
      ranges: { '12': [300000, 500000, 700000] },
    });
    for (const entry of (await getRewardUnit(admin, id)).rows) {
      await saveRewardEntry(admin, id, (await getRewardUnit(admin, id)).unit.revision, entry.id,
        entry.recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    }
    await refreshRewardFixtureBudget(admin, id);

    const groupReport = await rewardAnalytics(admin, [b.companyId], {}, selection);
    expect(groupReport.selected).toHaveLength(1);
    expect(groupReport.selected[0]).toMatchObject({ id, canSeePat: true, patAchievement: 1 });
    expect(groupReport.rows).toHaveLength(2);
    expect(groupReport.reconciled).toBe(true);
    const report = await rewardAnalytics(reviewer, [b.companyId], {}, selection);
    expect(report.selected).toHaveLength(1);
    expect(report.selected[0]).toMatchObject({ id, canSeePat: false, patAchievement: null, people: 1 });
    expect(report.rows.map(row => row.name)).toEqual(['Fictional visible peer']);
    expect(report.totals).toMatchObject({ beforeCents: 500_000, people: 1 });
    expect(report.reconciled).toBe(true);
    expect(JSON.stringify(report)).not.toContain('Fictional private own line');

    const current = await getRewardUnit(admin, id);
    const peer = current.rows.find(row => row.source.name === 'Fictional visible peer')!;
    await saveRewardEntry(admin, id, current.unit.revision, peer.id, { ...peer.recommendation, meritBp: 1000 }, peer.facts);
    const refreshed = await rewardAnalytics(reviewer, [b.companyId], {}, selection);
    expect(refreshed.totals.afterCents).toBeGreaterThan(report.totals.afterCents);
    expect(refreshed.digest).not.toBe(report.digest);

    const other = await seedBase();
    await setModule(other.tenantId, 'rewards', 'active');
    const denied = await rewardAnalytics(await entitledCtx(other), [b.companyId], {}, { ...selection, unitId: id });
    expect(denied).toMatchObject({ units: [], selected: [], rows: [] });
  }, 35_000);
});
