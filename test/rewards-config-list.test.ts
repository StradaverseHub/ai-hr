import {setRewardMember} from './rewards-access-fixture';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { cancelRewardReview, createRewardUnit, decideRewardUnit, emptyRewardCalendar, getRewardUnit, listRewardUnits, pendingRewardTasks, rewardApprovalsBoard, saveRewardCalendar, saveRewardEntry, saveRewardPolicy } from '../packs/rewards/service';
import { emptyFacts, type RewardRole } from '../packs/rewards/model';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
describe('Rewards configuration list (7a8102a7) and review cancellation (62e743ed)', () => {
  let b: Base, admin: SessionContext, unitId: string;
  const actors: Partial<Record<RewardRole, SessionContext>> = {};
  const view = () => getRewardUnit(admin, unitId);
  const row = async (who = admin) => (await listRewardUnits(who, [b.companyId])).find(r => r.id === unitId)!;
  beforeEach(async () => {
    await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'rewards', 'active'); admin = await entitledCtx(b);
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional Rewards administrator', primaryEmail: 'administrator@rewards-config.test' }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, admin.userId!));
    admin = { ...admin, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    for (const n of [1, 2]) {
      const hire = await hireEmployee(admin, { person: { fullName: `Fictional Reward Employee ${n}`, primaryEmail: `employee${n}@rewards-config.test` }, companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
      await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, hire.employmentId));
      await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, hire.employmentId));
      await setCompensation(admin, { employmentId: hire.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    }
    unitId = await createRewardUnit(admin, { name: 'Fictional Annual Compensation Review', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    for (const role of ['bu', 'bg', 'ctro', 'ec'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Fictional ${role} reviewer`, primaryEmail: `${role}@rewards-config.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...admin, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(admin, unitId, (await view()).unit.revision, userId, role);
    }
    actors.gr = admin;
    await setRewardMember(admin, unitId, (await view()).unit.revision, admin.userId!, 'payroll');
  });
  /** Verify every employee and submit to the BG CEO; returns the revision the review is at. */
  async function submit() {
    let v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    for (const i of [0, 1]) { v = await view(); await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[i].id, v.rows[i].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' }); }
    const rev = (await view()).unit.revision;
    expect(await decideRewardUnit(actors.bu!, unitId, rev, 'submit', 'Reviewed recommendations')).toBe('bg');
    return rev;
  }
  const events = (type: string) => owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, unitId), eq(schema.domainEvent.eventType, type)));
  afterAll(closeAll);

  it('lists counts, the current seat with its holders, the due date and the salary effective date', async () => {
    const v = await view();
    await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    const due = addDays(today, 3);
    await saveRewardCalendar(admin, unitId, 0, { ...emptyRewardCalendar(), due: { ...emptyRewardCalendar().due, bu: due } });
    const r = await row();
    expect(r).toMatchObject({ status: 'draft', people: 2, verified: 1, seat: 'bu', holders: ['Fictional bu reviewer'], due, daysUntilDue: 3, effectiveFrom: `${year + 1}-01-01`, year });
    // Counts only: no salary or employee field leaves the list.
    expect(JSON.stringify(r)).not.toMatch(/5000|Fictional Reward Employee/);
  });

  it('withholds counts from a viewer without a seat rather than showing a partial total', async () => {
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional seatless administrator', primaryEmail: 'seatless@rewards-config.test' }).returning();
    const userId = await createAppUser(b.tenantId, p.id, 'hr_admin');
    const r = await row({ ...admin, userId, personId: p.id });
    expect(r.people).toBeNull(); expect(r.verified).toBeNull();
    expect(r.seat).toBe('bu');
  });

  it('shows no holder when the seat is empty and no due date when the calendar has none', async () => {
    // Access maintenance refuses to empty a required seat (cd72f915); a review created before that rule can still have one.
    await owner.db.delete(schema.rewardMember).where(and(eq(schema.rewardMember.unitId, unitId), eq(schema.rewardMember.role, 'bu')));
    const r = await row();
    expect(r.holders).toEqual([]); expect(r.due).toBeNull(); expect(r.daysUntilDue).toBeNull();
  });

  it('adds a review to an existing cycle without a name and keeps the cycle name; a new cycle still needs one', async () => {
    const r = await row();
    const [other] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'BR', name: 'Branch' }).returning();
    const id = await createRewardUnit(admin, { cycleId: r.cycleId, year, companyId: b.companyId, businessUnitId: other.id, snapshotDate: today });
    expect((await listRewardUnits(admin, [b.companyId])).find(x => x.id === id)?.cycle).toBe('Fictional Annual Compensation Review');
    await expect(createRewardUnit(admin, { name: '  ', year, companyId: b.companyId, businessUnitId: other.id, snapshotDate: today })).rejects.toThrow('Name the new review cycle.');
  });

  it('reads the effective date from the review settings', async () => {
    const v = await view();
    await saveRewardPolicy(admin, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: `${year + 1}-03-01` });
    expect((await row()).effectiveFrom).toBe(`${year + 1}-03-01`);
  });

  it('cancels a started review with a reason: kept read-only, off the board, the task list and posting', async () => {
    const rev = await submit();
    expect((await pendingRewardTasks(actors.bg!, undefined)).map(x => x.id)).toContain(unitId);
    await expect(cancelRewardReview(admin, unitId, rev, 'too short')).rejects.toThrow('at least 10 characters');
    await expect(cancelRewardReview(actors.bu!, unitId, rev, 'Unit merged into another review')).rejects.toThrow('Only the company Rewards administrator or Group Rewards');
    await cancelRewardReview(admin, unitId, rev, 'Unit merged into another review');
    const v = await view();
    expect(v.unit.status).toBe('withdrawn'); expect(v.rows).toHaveLength(2);
    expect(v.decisions[0]).toMatchObject({ action: 'withdraw', fromStage: 'bg', toStage: 'withdrawn', reason: 'Unit merged into another review' });
    const [event] = await events('reward-unit.cancelled');
    expect(event.payload).toMatchObject({ fromStage: 'bg', reason: 'Unit merged into another review', before: { status: 'bg' }, after: { status: 'withdrawn' } });
    expect(await pendingRewardTasks(actors.bg!, undefined)).toEqual([]);
    expect((await rewardApprovalsBoard(admin, [b.companyId])).map(x => x.id)).not.toContain(unitId);
    await expect(decideRewardUnit(actors.bg!, unitId, v.unit.revision, 'approve', 'Approving a cancelled review')).rejects.toThrow();
    await expect(cancelRewardReview(admin, unitId, v.unit.revision, 'Cancel it a second time')).rejects.toThrow('can no longer be cancelled');
    const r = await row();
    expect(r).toMatchObject({ status: 'withdrawn', canCancel: false, seat: null, cancellation: { on: today, reason: 'Unit merged into another review', by: 'Fictional Rewards administrator' } });
  });

  it('lets a seatless company administrator cancel, recorded by the audit event alone', async () => {
    const rev = await submit();
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Fictional seatless administrator', primaryEmail: 'seatless@rewards-config.test' }).returning();
    const seatless = { ...admin, userId: await createAppUser(b.tenantId, p.id, 'hr_admin'), personId: p.id };
    expect((await row(seatless)).canCancel).toBe(true);
    await cancelRewardReview(seatless, unitId, rev, 'Stopped by the company administrator');
    expect((await view()).decisions.filter(d => d.action === 'withdraw')).toEqual([]);
    expect(await events('reward-unit.cancelled')).toHaveLength(1);
    expect((await row()).status).toBe('withdrawn');
  });

  it('keeps delete refused for a used draft and offers cancel instead', async () => {
    const v = await view();
    await saveRewardEntry(admin, unitId, v.unit.revision, v.rows[0].id, v.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    expect(await row()).toMatchObject({ deletionReason: 'recommendations', canCancel: true });
  });

  it('records before and after for deadline and policy edits, and deadlines stay editable after launch', async () => {
    await submit();
    const first = { ...emptyRewardCalendar(), due: { ...emptyRewardCalendar().due, bg: addDays(today, 5) } };
    await saveRewardCalendar(admin, unitId, 0, first);
    await saveRewardCalendar(admin, unitId, 1, { ...first, due: { ...first.due, bg: addDays(today, 9) } });
    const calendar = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'reward-calendar.updated')).orderBy(schema.domainEvent.occurredAt);
    expect(calendar[0].payload).toMatchObject({ before: null, after: { due: { bg: addDays(today, 5) } } });
    expect(calendar[1].payload).toMatchObject({ before: { due: { bg: addDays(today, 5) } }, after: { due: { bg: addDays(today, 9) } } });
    expect((await row()).due).toBe(addDays(today, 9));
    const [policy] = (await events('reward-unit.policy-updated')).slice(-1);
    expect(policy.payload).toMatchObject({ before: { patActual: 0, effectiveFrom: `${year + 1}-01-01` }, after: { patActual: 100, effectiveFrom: today } });
    expect(Object.keys((policy.payload as { after: object }).after)).not.toContain('meritMatrix');
  });
});
