/**
 * P1 wave 1 (APR-020) — the seams between WP-F (returned Rewards reviews), WP-B1 (Calibration destination)
 * and WP-A1 (pack work in the shared task list), against real RLS as ai_hr_app.
 *
 *   (a) A Rewards review returned to the BU seat is a `rewardReview` task for the BU member only — not the
 *       BG member who returned it, not PBP, not Group Rewards — and stops being one on resubmission.
 *   (b) A calibration session is a `calibration` task only for a NAMED reviewer (named in reviewer_user_ids, or
 *       the live holder of the session anchor's leader seat — WP-B2) whose tier window is open and who still has
 *       people to decide; never for an HR administrator who merely administers it, never across companies,
 *       never on the final tier, never for a seat that has ended.
 *   (c) Every pack task still carries exactly {id, kind, subjectName, createdAt, linkPath}.
 *
 * Fixtures follow test/wpa1-pack-task-projection.test.ts (Rewards) and test/performance-calibration-list.test.ts
 * (Calibration). Every read is a persona's app-role session through listPendingTasks.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { listPendingTasks, type InboxModules, type PendingTaskItem } from '../core/approvals-inbox';
import * as perf from '../packs/performance/service';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { createRewardUnit, decideRewardUnit, getRewardUnit, returnedRewardUnits, saveRewardEntry, saveRewardPolicy, setRewardMember } from '../packs/rewards/service';
import { emptyFacts } from '../packs/rewards/model';
import { PACK_TASK_KINDS } from '../lib/assigned-work';
import { HOME_TASK_KINDS, validateEmployeeHomeConfiguration } from '../lib/employee-home';
import { defaultEmployeeHomeConfiguration } from '../lib/employee-home-defaults';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const ALL: InboxModules = { attendance: false, claims: false, performance: true, rewards: true };
const PAYLOAD_KEYS = ['createdAt', 'id', 'kind', 'linkPath', 'subjectName'];
const packKinds = new Set<string>(PACK_TASK_KINDS);
const packItems = (rows: PendingTaskItem[]) => rows.filter((row) => packKinds.has(row.kind));
const ofKind = (rows: PendingTaskItem[], kind: string) => rows.filter((row) => row.kind === kind);
const expectPayloadShape = (rows: PendingTaskItem[]) => {
  for (const item of packItems(rows)) {
    expect(Object.keys(item).sort()).toEqual(PAYLOAD_KEYS);
    expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
  }
  // One task per (kind, id): a unit is never both returned and awaiting approval.
  const keys = packItems(rows).map((t) => `${t.kind}:${t.id}`);
  expect(new Set(keys).size).toBe(keys.length);
};

let b: Base, a: SessionContext;
type Hired = { employmentId: string; personId: string };
const hire = (name: string, companyId = b.companyId, departmentId = b.deptA): Promise<Hired> =>
  hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@p1wave1.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active'); await setModule(b.tenantId, 'rewards', 'active');
  a = await entitledCtx(b);
});
afterAll(closeAll);

describe('(a) a returned Rewards review in the shared task list', () => {
  it('is a task for the BU member only, links to the review, carries no reason, and clears on resubmission', async () => {
    const [adminPerson] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: 'Rewards administrator', primaryEmail: `${randomUUID()}@p1wave1.test` }).returning();
    await owner.db.update(schema.appUser).set({ personId: adminPerson.id }).where(eq(schema.appUser.id, a.userId!));
    a = { ...a, personId: adminPerson.id };
    const [bu] = await owner.db.insert(schema.businessUnit).values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Headquarters' }).returning();
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    const employee = await hire('Reward Employee');
    await owner.db.update(schema.assignment).set({ businessUnitId: bu.id }).where(eq(schema.assignment.employmentId, employee.employmentId));
    await owner.db.update(schema.employment).set({ gradeId: grade.id, confirmationDate: `${year - 2}-04-01` }).where(eq(schema.employment.id, employee.employmentId));
    await setCompensation(a, { employmentId: employee.employmentId, basicSalary: 5000, effectiveFrom: `${year - 2}-01-01` });
    const unitId = await createRewardUnit(a, { name: 'Annual rewards', year, companyId: b.companyId, businessUnitId: bu.id, snapshotDate: today });
    const view = () => getRewardUnit(a, unitId);
    const actors: Record<string, SessionContext> = {};
    for (const role of ['bu', 'bg', 'gr', 'ctro', 'ec', 'pbp'] as const) {
      const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `${role} reviewer`, primaryEmail: `${randomUUID()}@p1wave1.test` }).returning();
      const userId = await createAppUser(b.tenantId, p.id, 'employee');
      actors[role] = { ...a, userId, personId: p.id, roles: ['employee'], grants: undefined };
      await setRewardMember(a, unitId, (await view()).unit.revision, userId, role);
    }
    await setRewardMember(a, unitId, (await view()).unit.revision, a.userId!, 'payroll');
    const v = await view();
    await saveRewardPolicy(a, unitId, v.unit.revision, { ...v.unit.policy, effectiveFrom: today, patActual: 100, patTarget: 100, ranges: { '12': [300000, 500000, 700000] } });
    const v2 = await view();
    await saveRewardEntry(a, unitId, v2.unit.revision, v2.rows[0].id, v2.rows[0].recommendation, { ...emptyFacts(), reviewed: true, talent: 'SCORE', performance: 'ME' });
    expect(await decideRewardUnit(actors.bu, unitId, (await view()).unit.revision, 'submit', 'Reviewed recommendations')).toBe('bg');
    expect(await decideRewardUnit(actors.bg, unitId, (await view()).unit.revision, 'return', 'Merit for the sales team needs a rethink')).toBe('draft');

    const [returned] = await returnedRewardUnits(actors.bu);
    expect(returned?.id).toBe(unitId); // the owner says the BU seat holds it
    const buTasks = await listPendingTasks(actors.bu, undefined, ALL);
    expect(ofKind(buTasks, 'rewardReview')).toEqual([{ id: unitId, kind: 'rewardReview', subjectName: `${returned.cycle} · ${returned.name}`, createdAt: returned.returnedAt, linkPath: `/rewards/${unitId}` }]);
    expectPayloadShape(buTasks);
    expect(JSON.stringify(packItems(buTasks))).not.toMatch(/sales team|rethink|bg reviewer|5000|budget|salary|amount|bonus/i);
    // Scoped by company like every other source.
    expect(ofKind(await listPendingTasks(actors.bu, [b.companyId], ALL), 'rewardReview').map((t) => t.id)).toEqual([unitId]);
    const { id: otherCompany } = await createCompany(a, { legalName: 'Other Sdn Bhd' });
    expect(ofKind(await listPendingTasks(actors.bu, [otherCompany], ALL), 'rewardReview')).toEqual([]);
    // Not the BG member who returned it, nor PBP, nor Group Rewards.
    for (const role of ['bg', 'pbp', 'gr'] as const) expect(ofKind(await listPendingTasks(actors[role], undefined, ALL), 'rewardReview')).toEqual([]);

    expect(await decideRewardUnit(actors.bu, unitId, (await view()).unit.revision, 'submit', 'Revised and ready for approval')).toBe('bg');
    expect(ofKind(await listPendingTasks(actors.bu, undefined, ALL), 'rewardReview')).toEqual([]);
    // Back at BG it is the BG member's approval task again, once.
    const bgTasks = await listPendingTasks(actors.bg, undefined, ALL);
    expect(ofKind(bgTasks, 'rewardReview').map((t) => [t.id, t.linkPath])).toEqual([[unitId, `/rewards/${unitId}?view=approvals`]]);
    expectPayloadShape(bgTasks);
  });
});

describe('(b) calibration in the shared task list', () => {
  let coB: string, hod: SessionContext, reviewerB: SessionContext, finalNamed: SessionContext, partner: SessionContext;
  let cycleA: string, hodSession: string, buSessionB: string, buSession: string, seatSubject: Hired;

  async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
    const userId = await createAppUser(b.tenantId, personId, role);
    return { tenantId: b.tenantId, userId, personId, roles: [role], grants: [{ role, companyId: null }], entitlements: a.entitlements };
  }
  async function onehrCycle(name: string, companyId: string) {
    const { cycleId } = await perf.createCycle(a, { name, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
    await perf.configureOnehrCycle(a, cycleId, null, defaultPolicy(framework));
    await perf.openCycle(a, { cycleId });
    return cycleId;
  }
  async function session(cycleId: string, companyId: string | null, tier: 'hod' | 'bu' | 'final', name: string, reviewers: string[], people: Hired[]) {
    const reviewIds: string[] = [];
    for (const p of people) {
      const [r] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, p.employmentId)));
      expect(r, 'the opened OneHR cycle has a review for the fixture person').toBeDefined();
      reviewIds.push(r.id);
    }
    return withTenant(a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId, companyId, name, tier, reviewerUserIds: reviewers }).returning();
      for (let i = 0; i < people.length; i++) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: reviewIds[i], employmentId: people[i].employmentId });
      return s.id;
    });
  }
  const calibrationTasks = async (ctx: SessionContext, scope?: string[]) => ofKind(await listPendingTasks(ctx, scope, ALL), 'calibration');
  const setWindows = async (windows: Record<string, { opensAt: string | null; closesAt: string | null }>) => {
    const [cfg] = await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId, cycleA));
    await owner.db.update(schema.onehrCycle).set({ policy: { ...(cfg.policy as object), windows } }).where(eq(schema.onehrCycle.cycleId, cycleA));
  };

  beforeEach(async () => {
    const hodPerson = await hire('Head of department');
    const buPerson = await hire('BU chief');
    const finalPerson = await hire('Named on final only');
    const partnerPerson = await hire('Performance partner', b.companyId, b.deptB);
    const subjects = [await hire('Subject one'), await hire('Subject two')];
    seatSubject = await hire('Seat subject'); // WP-B2: in no hand-built session, so an anchored BU scope can hold them
    ({ id: coB } = await createCompany(a, { legalName: 'Other Company Sdn Bhd' }));
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const subjectB = await hire('Company B subject', coB, deptB.id);
    const reviewerBPerson = await hire('Company B reviewer', coB, deptB.id);
    const [grade] = await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning();
    await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
    cycleA = await onehrCycle('Company A annual', b.companyId);
    const cycleB = await onehrCycle('Company B annual', coB);
    hod = await userCtx(hodPerson.personId, 'manager');
    const bu = await userCtx(buPerson.personId, 'manager');
    finalNamed = await userCtx(finalPerson.personId, 'manager');
    reviewerB = await userCtx(reviewerBPerson.personId, 'manager');
    const [pu] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: partnerPerson.personId }).returning({ id: schema.appUser.id });
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: pu.id, companyId: b.companyId, role: 'performance_partner' });
    partner = { tenantId: b.tenantId, userId: pu.id, personId: partnerPerson.personId, roles: ['performance_partner'], grants: [{ role: 'performance_partner', companyId: b.companyId }], entitlements: a.entitlements };
    hodSession = await session(cycleA, b.companyId, 'hod', 'A department', [hod.userId!], [...subjects, hodPerson]);
    buSession = await session(cycleA, b.companyId, 'bu', 'A business unit', [bu.userId!], subjects);
    await session(cycleA, b.companyId, 'final', 'A final override', [finalNamed.userId!, hod.userId!], subjects);
    buSessionB = await session(cycleB, coB, 'bu', 'B business unit', [reviewerB.userId!], [subjectB]);
  });

  it('a named HOD reviewer with people to decide in an open window gets exactly one calibration task', async () => {
    const [listed] = (await perf.listMyCalibrationSessions(hod)).filter((s) => s.id === hodSession);
    expect(listed).toMatchObject({ window: 'open', toDo: 2 }); // the precondition, from the Calibration page's own read
    const [row] = await owner.db.select().from(schema.onehrCalibration).where(eq(schema.onehrCalibration.id, hodSession));
    const tasks = await listPendingTasks(hod, undefined, ALL);
    expect(ofKind(tasks, 'calibration')).toEqual([{ id: hodSession, kind: 'calibration', subjectName: 'A department', createdAt: row.createdAt.toISOString(), linkPath: `/performance/assessment/calibration/${hodSession}` }]);
    expectPayloadShape(tasks);
    expect(await calibrationTasks(hod, [b.companyId])).toHaveLength(1);
    expect(await calibrationTasks(hod, [coB])).toEqual([]);
    // Off when the caller resolved Performance as off.
    expect(ofKind(await listPendingTasks(hod, undefined, { ...ALL, performance: false }), 'calibration')).toEqual([]);
  });

  it('a closed window, or nobody left to decide, is no task', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await setWindows({ pm_hod: { opensAt: null, closesAt: past }, pot_hod: { opensAt: null, closesAt: past } });
    expect((await perf.listMyCalibrationSessions(hod)).find((s) => s.id === hodSession)).toMatchObject({ window: 'closed', toDo: 2 });
    expect(await calibrationTasks(hod)).toEqual([]);
    await setWindows({});
    expect(await calibrationTasks(hod)).toHaveLength(1);
    await owner.db.update(schema.onehrCalibration).set({ performanceLockedAt: new Date(), potentialLockedAt: new Date() }).where(eq(schema.onehrCalibration.id, hodSession));
    expect((await perf.listMyCalibrationSessions(hod)).find((s) => s.id === hodSession)).toMatchObject({ window: 'open', toDo: 0 });
    expect(await calibrationTasks(hod)).toEqual([]);
  });

  it('owes the work from the window opening when it opened after the session was created', async () => {
    const created = new Date(Date.now() - 10 * 86_400_000), opened = new Date(Date.now() - 86_400_000);
    await owner.db.update(schema.onehrCalibration).set({ createdAt: created }).where(eq(schema.onehrCalibration.id, hodSession));
    await setWindows({ pm_hod: { opensAt: opened.toISOString(), closesAt: null }, pot_hod: { opensAt: opened.toISOString(), closesAt: null } });
    expect((await calibrationTasks(hod)).map((t) => t.createdAt)).toEqual([opened.toISOString()]);
  });

  it('an HR administrator or partner who only administers the sessions, a final-tier name and a company-B reviewer get none of company A', async () => {
    // Non-vacuous: the administrator and the partner CAN open the HOD session.
    expect((await perf.listMyCalibrationSessions(a)).map((s) => s.id)).toContain(hodSession);
    expect((await perf.listMyCalibrationSessions(partner)).map((s) => s.id)).toContain(hodSession);
    expect(await calibrationTasks(a)).toEqual([]);
    expect(await calibrationTasks(partner)).toEqual([]);
    expect(await calibrationTasks(finalNamed)).toEqual([]);
    const b2 = await calibrationTasks(reviewerB);
    expect(b2.map((t) => t.id)).not.toContain(hodSession);
    expect(b2.map((t) => t.id)).not.toContain(buSession);
    expect(b2.map((t) => t.id)).toEqual([buSessionB]);
  });

  it('a live BU CEO seat holder gets exactly one calibration task without being named; an ended seat gets none (WP-B2)', async () => {
    const [review] = await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleA), eq(schema.performanceReview.employmentId, seatSubject.employmentId)));
    const seatSession = await withTenant(a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId: cycleA, companyId: b.companyId, name: 'Seat business unit', tier: 'bu', reviewerUserIds: [], anchorKind: 'bu_ceo' }).returning();
      await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: review.id, employmentId: seatSubject.employmentId });
      return s.id;
    });
    const holderPerson = await hire('BU seat holder');
    const holder = await userCtx(holderPerson.personId, 'manager');
    expect(await calibrationTasks(holder)).toEqual([]); // non-vacuous: no seat, no task
    const seat = await perf.appointLeaderSeat(a, { seatType: 'bu_ceo', companyId: b.companyId, holderEmploymentId: holderPerson.employmentId });
    const [row] = await owner.db.select().from(schema.onehrCalibration).where(eq(schema.onehrCalibration.id, seatSession));
    expect(await calibrationTasks(holder)).toEqual([{ id: seatSession, kind: 'calibration', subjectName: 'Seat business unit', createdAt: row.createdAt.toISOString(), linkPath: `/performance/assessment/calibration/${seatSession}` }]);
    expect(await calibrationTasks(holder, [coB])).toEqual([]);
    await perf.endLeaderSeat(a, seat.id);
    expect(await calibrationTasks(holder)).toEqual([]);
  });
});

describe('(c) the task vocabulary', () => {
  it('calibration is a pack kind and a Home kind, and Home effort configuration accepts it', () => {
    expect(PACK_TASK_KINDS).toContain('calibration');
    for (const kind of PACK_TASK_KINDS) expect(HOME_TASK_KINDS as readonly string[]).toContain(kind);
    const config = defaultEmployeeHomeConfiguration();
    expect(validateEmployeeHomeConfiguration({ ...config, effortMinutes: { calibration: 15, rewardReview: 30 } }).effortMinutes).toEqual({ calibration: 15, rewardReview: 30 });
    expect(() => validateEmployeeHomeConfiguration({ ...config, effortMinutes: { calibrations: 15 } })).toThrow();
  });
});
