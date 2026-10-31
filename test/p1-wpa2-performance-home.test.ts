/**
 * WP-A2 (APR-015) — the Performance block on Home, against real RLS as ai_hr_app.
 *
 *   THE FINDING, AS AN ASSERTION: the team count on Home is the bell's own projection
 *   (`pendingPerformanceTasks`, which already contains `pendingCalibrationTasks`), so Home, the bell and the
 *   chips cannot disagree — and calibration is not counted twice.
 *   Released results only: before release there is no band key anywhere in the block; after release there is.
 *   Module off, or no open cycle of one's own: no block. Company scope: no other company's counts.
 *   Stage-strip words at different stages, windows derived from the clock.
 *   D-P1-03: an employee-role reviewer has assigned work (so /performance admits them); a plain employee has none.
 *
 * Fixture pattern: test/wpa1-pack-task-projection.test.ts and test/p1-wave1-seams.test.ts.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee, setReportingLine } from '../core/org';
import { listPendingTasks, type InboxModules, type PendingTaskItem } from '../core/approvals-inbox';
import * as perf from '../packs/performance/service';
import { defaultPolicy, pmBands, type PMBand, type Policy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { PACK_TASK_KINDS } from '../lib/assigned-work';
import { closeAll, createAppUser, entitledCtx, harnessSnapshot, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const today = todayInKualaLumpur(), year = Number(today.slice(0, 4));
const ALL: InboxModules = { attendance: false, claims: false, performance: true, rewards: false };
const packKinds = new Set<string>(PACK_TASK_KINDS);
const packItems = (rows: PendingTaskItem[]) => rows.filter((row) => packKinds.has(row.kind));
type Hired = { employmentId: string; personId: string };

let b: Base, a: SessionContext;
const hire = (name: string, companyId = b.companyId, departmentId = b.deptA): Promise<Hired> =>
  hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@wpa2.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
const as = async (p: Hired, role: 'employee' | 'manager'): Promise<SessionContext> =>
  ({ ...a, userId: await createAppUser(b.tenantId, p.personId, role), personId: p.personId, roles: [role], grants: [{ role, companyId: null }] });
const block = async (ctx: SessionContext, scope?: string[]) => perf.getPerformanceHomeBlock(ctx, scope);
const must = <T,>(v: T | null | undefined, what: string): T => { if (v == null) throw Error(`missing ${what}`); return v; };
const stepOf = (blk: perf.PerformanceHomeBlock, key: perf.HomeStepKey) => blk.steps.find((s) => s.key === key);
/** Every key anywhere in a value. */
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  a = await entitledCtx(b);
});
afterAll(closeAll);

async function openCycle(name: string, companyId: string, shape: (p: Policy) => void) {
  const { cycleId } = await perf.createCycle(a, { name, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` });
  const policy = defaultPolicy(framework);
  shape(policy);
  await perf.configureOnehrCycle(a, cycleId, null, policy);
  await perf.openCycle(a, { cycleId });
  return cycleId;
}
async function gradeAll() {
  const [existing] = await owner.db.select().from(schema.jobGrade).where(and(eq(schema.jobGrade.tenantId, b.tenantId), eq(schema.jobGrade.code, '12')));
  const grade = existing ?? (await owner.db.insert(schema.jobGrade).values({ tenantId: b.tenantId, code: '12', name: 'Grade 12' }).returning())[0];
  await owner.db.update(schema.employment).set({ gradeId: grade.id }).where(eq(schema.employment.tenantId, b.tenantId));
}
const reviewIdFor = async (cycleId: string, p: Hired) =>
  must((await owner.db.select().from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, p.employmentId))))[0], 'review').id;

describe('the Performance block for a line manager and an employee (PM only)', () => {
  let subject: Hired, manager: Hired, plain: Hired, matrix: Hired, self: SessionContext, mgr: SessionContext, plainCtx: SessionContext, matrixCtx: SessionContext;
  let cycleId: string, reviewId: string;
  const rev = async (ctx: SessionContext) => must(await perf.getOnehrReview(ctx, reviewId), 'view').revision;
  const kpiId = randomUUID();
  const kpi = (moderator: Hired) => ({ id: kpiId, title: 'Agreed delivery', description: 'Fictional measure.', weightBp: 10000, unit: 'milestones', scoring: { mechanism: 'A' as const, method: 'more' as const, rates: [0, 1, 2, 3, 4] }, moderatorEmploymentId: moderator.employmentId });

  beforeEach(async () => {
    subject = await hire('Home subject'); manager = await hire('Home manager'); plain = await hire('Home bystander'); matrix = await hire('Matrix moderator', b.companyId, b.deptB);
    const reports = [subject, plain];
    for (let i = 0; i < 2; i++) reports.push(await hire(`Home report ${i}`));
    await gradeAll();
    for (const e of reports) await setReportingLine(a, { subordinateEmploymentId: e.employmentId, managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    cycleId = await openCycle('WP-A2 annual', b.companyId, (p) => { p.modules = { pm: true, tm: false, idp: false, evidence: false }; });
    reviewId = await reviewIdFor(cycleId, subject);
    self = await as(subject, 'employee'); mgr = await as(manager, 'manager'); plainCtx = await as(plain, 'employee'); matrixCtx = await as(matrix, 'employee');
  });

  it('the finding: the team count is the bell\'s projection, chip for chip, calibration included once', async () => {
    // A calibration session naming the manager, with people still to decide (the wave-1 calibration task).
    const subjects = [subject, plain];
    const sessionId = await withTenant(a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId, companyId: b.companyId, name: 'WP-A2 department', tier: 'hod', reviewerUserIds: [mgr.userId!] }).returning();
      for (const p of subjects) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: await reviewIdFor(cycleId, p), employmentId: p.employmentId });
      return s.id;
    });
    const projection = await perf.pendingPerformanceTasks(mgr, undefined);
    const calibration = await perf.pendingCalibrationTasks(mgr);
    expect(projection.filter((t) => t.kind === 'performanceReview').length).toBe(4); // non-vacuous: every report awaits the manager
    expect(calibration.map((t) => t.id)).toEqual([sessionId]);
    expect(projection.filter((t) => t.kind === 'calibration').map((t) => t.id)).toEqual([sessionId]); // already inside the projection

    const blk = must(await block(mgr), 'manager block');
    const team = must(blk.team, 'team row');
    expect(team.total).toBe(projection.length);
    expect(team.total).toBe(packItems(await listPendingTasks(mgr, undefined, ALL)).length); // the bell's own list
    expect(team.chips).toEqual([{ kind: 'performanceReview', count: 4 }, { kind: 'calibration', count: calibration.length }]);
    expect(team.chips.reduce((n, c) => n + c.count, 0)).toBe(team.total);
    expect(stepOf(blk, 'teamReview')).toEqual({ key: 'teamReview', state: 'waiting', count: 4 });
    expect(stepOf(blk, 'calibration')).toEqual({ key: 'calibration', state: 'waiting', count: 1 });
    expect(blk.team?.href).toBe(`/performance/workspace?cycle=${cycleId}&view=team`);
  });

  it('counts a department review the manager leads as its HOD anchor, with no explicit grant (WP-B2)', async () => {
    const sessionId = await withTenant(a, async (tx) => {
      const [s] = await tx.insert(schema.onehrCalibration).values({ tenantId: b.tenantId, cycleId, companyId: b.companyId, name: 'WP-B2 anchored department', tier: 'hod', reviewerUserIds: [], anchorKind: 'hod', anchorEmploymentId: manager.employmentId }).returning();
      for (const p of [subject, plain]) await tx.insert(schema.onehrCalibrationEntry).values({ tenantId: b.tenantId, sessionId: s.id, reviewId: await reviewIdFor(cycleId, p), employmentId: p.employmentId });
      return s.id;
    });
    expect((await perf.pendingCalibrationTasks(mgr)).map((t) => t.id)).toEqual([sessionId]);
    expect(await perf.hasCalibrationAssignment(mgr)).toBe(true);
    const blk = must(await block(mgr), 'manager block');
    expect(stepOf(blk, 'calibration')).toEqual({ key: 'calibration', state: 'waiting', count: 1 });
    expect(must(blk.team, 'team row').chips).toContainEqual({ kind: 'calibration', count: 1 });
  });

  it('APR-028: before release the person sees only their manager\'s confirmed band (no score); after release the released band', async () => {
    await perf.saveOnehrKpis(self, reviewId, await rev(self), [kpi(manager)], true);
    await perf.approveOnehrScorecard(mgr, reviewId, await rev(mgr), true, 'Objectives agreed.');
    await perf.submitOnehrResults(self, reviewId, await rev(self), [{ id: kpiId, actual: 2, note: 'Fictional record.' }], 'Delivered the agreed milestones this year.');
    await perf.moderateOnehrKpi(mgr, reviewId, await rev(mgr), kpiId, 2, 'Verified.');
    let confirmed: PMBand | null = null;
    for (const band of pmBands) {
      try { await perf.confirmOnehrPerformance(mgr, reviewId, await rev(mgr), band, ''); confirmed = band; break; }
      catch (e) { if (!/calculated/i.test((e as Error).message)) throw e; }
    }
    const band = must(confirmed, 'confirmed band');
    // Non-vacuous: the manager's band exists and the subject's own page CAN see it is decided.
    expect((await perf.getOnehrReview(self, reviewId))?.managerPerformance).toBe(band);

    const before = must(await block(self), 'subject block');
    expect(before.standing.performance).toEqual({ state: 'lineManagerApproved', band });
    expect([...keysOf(before)].filter((k) => /score/i.test(k))).toEqual([]);
    expect(stepOf(before, 'kpi')?.state).toBe('done');
    expect(stepOf(before, 'results')?.state).toBe('locked');

    await perf.releaseOnehrResult(a, reviewId, 'performance', true);
    const after = must(await block(self), 'subject block after release');
    expect(after.standing.performance).toEqual({ state: 'released', band });
    expect(stepOf(after, 'results')?.state).toBe('released');
    expect(after.done).toBe(before.done + 1);
  });

  it('stage-strip words follow the subject through the cycle', async () => {
    const words = async () => must(await block(self), 'block').steps.map((s) => `${s.key}:${s.state}`);
    expect(await words()).toEqual(['kpiSetting:yourTurn', 'results:locked']);
    const first = must(await block(self), 'block');
    expect(first.next).toMatchObject({ kind: 'kpiSetting', done: 0, total: 0, href: `/performance/workspace?cycle=${cycleId}&view=mine&module=pm` });
    expect(first.cycle).toEqual({ id: cycleId, name: 'WP-A2 annual', closesOn: `${year}-12-31` });
    await perf.saveOnehrKpis(self, reviewId, await rev(self), [kpi(manager)], true);
    expect(await words()).toEqual(['kpiSetting:inProgress', 'results:locked']);
    await perf.approveOnehrScorecard(mgr, reviewId, await rev(mgr), true, 'Objectives agreed.');
    expect(await words()).toEqual(['kpi:yourTurn', 'results:locked']);
    expect(must(await block(self), 'block').next).toMatchObject({ kind: 'kpi', done: 0, total: 1 });
    await perf.submitOnehrResults(self, reviewId, await rev(self), [{ id: kpiId, actual: 2, note: 'Fictional record.' }], 'Delivered the agreed milestones this year.');
    // The workspace derivation marks the subject's own part done once submitted; moderation is the manager's.
    expect(await words()).toEqual(['kpi:done', 'results:locked']);
    expect(must(await block(self), 'block').standing.performance).toEqual({ state: 'awaitingManager' });
  });

  it('a window that has not opened yet is Locked, and "your next step" names when it opens', async () => {
    const opens = new Date(Date.now() + 5 * 86_400_000).toISOString(), closes = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [cfg] = await owner.db.select().from(schema.onehrCycle).where(eq(schema.onehrCycle.cycleId, cycleId));
    await owner.db.update(schema.onehrCycle).set({ policy: { ...(cfg.policy as object), windows: { pm_setting: { opensAt: opens, closesAt: closes } } } }).where(eq(schema.onehrCycle.cycleId, cycleId));
    const blk = must(await block(self), 'block');
    expect(stepOf(blk, 'kpiSetting')?.state).toBe('locked');
    expect(blk.next).toEqual({ kind: 'none', nextDate: { kind: 'opens', on: todayInKualaLumpur(new Date(opens)) } });
    await owner.db.update(schema.onehrCycle).set({ policy: { ...(cfg.policy as object), windows: { pm_setting: { opensAt: null, closesAt: closes } } } }).where(eq(schema.onehrCycle.cycleId, cycleId));
    expect(must(await block(self), 'block').next).toMatchObject({ kind: 'kpiSetting', dueOn: todayInKualaLumpur(new Date(closes)) });
  });

  it('module off, or no open cycle of one\'s own: no block', async () => {
    expect(await block(self)).not.toBeNull();
    const { id: coB } = await createCompany(a, { legalName: 'No cycle Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'No-cycle dept' });
    const outsider = await as(await hire('Outside the cycle', coB, deptB.id), 'employee');
    expect(await block(outsider)).toBeNull();
    await setModule(b.tenantId, 'performance', 'disabled');
    expect(await block({ ...self, entitlements: harnessSnapshot(b.tenantId) })).toBeNull();
    expect(await perf.hasAssignedPerformanceWork({ ...mgr, entitlements: harnessSnapshot(b.tenantId) }, undefined)).toBe(false);
  });

  it('company scope: a viewer gets no other company\'s counts', async () => {
    const { id: coB } = await createCompany(a, { legalName: 'Company B Sdn Bhd' });
    const deptB = await createDepartment(a, { companyId: coB, name: 'B-Dept' });
    const managerB = await hire('Manager B', coB, deptB.id), reportB = await hire('Report B', coB, deptB.id);
    await gradeAll();
    await setReportingLine(a, { subordinateEmploymentId: reportB.employmentId, managerEmploymentId: managerB.employmentId, lineType: 'administrative', validFrom: `${year - 2}-01-01` });
    await openCycle('WP-A2 company B', coB, (p) => { p.modules = { pm: true, tm: false, idp: false, evidence: false }; });
    const mgrB = await as(managerB, 'manager');
    const blkB = must(await block(mgrB), 'manager B block');
    expect(blkB.team?.total).toBe(1);
    expect(blkB.cycle.name).toBe('WP-A2 company B');
    // Manager A scoped to company B sees none of A's four; scoped to A, all four.
    expect(must(await block(mgr, [coB]), 'A scoped to B').team?.total ?? 0).toBe(0);
    expect(must(await block(mgr, [b.companyId]), 'A scoped to A').team?.total).toBe(4);
  });

  it('D-P1-03: an employee-role KPI moderator has assigned work; a plain employee has none', async () => {
    await perf.saveOnehrKpis(self, reviewId, await rev(self), [kpi(manager)], true);
    await perf.assignAssessmentKpiModerator(a, reviewId, await rev(a), kpiId, matrix.employmentId);
    expect(matrixCtx.roles).toEqual(['employee']);
    expect(packItems(await listPendingTasks(matrixCtx, undefined, ALL)).map((t) => t.kind)).toEqual(['assessmentWork']);
    expect(await perf.hasAssignedPerformanceWork(matrixCtx, undefined)).toBe(true);
    expect(await perf.hasAssignedPerformanceWork(plainCtx, undefined)).toBe(false);
    expect(await perf.hasAssignedPerformanceWork(self, undefined)).toBe(false); // their own review is not work assigned to them
    // WP-E: a leader (HOD or a BU / BG / group seat) also reaches the page for "What you led". Neither employee leads
    // anyone, so a plain employee is still redirected: no admin, no manager role, no assigned work, no led people.
    expect(await perf.hasLedPeople(plainCtx)).toBe(false);
    expect(await perf.hasLedPeople(self)).toBe(false);
    expect(await perf.hasLedPeople(mgr)).toBe(true); // the control: the line manager leads their reports in this cycle
    // The page consults exactly these predicates before its redirect (contract across the two files).
    const page = fs.readFileSync(path.resolve(__dirname, '../app/(app)/performance/page.tsx'), 'utf8');
    expect(page).toMatch(/const leads = await hasLedPeople\(s\);/);
    expect(page).toMatch(/if \(!performanceAdmin && !manager && !leads && !\(await hasAssignedPerformanceWork\(s, scopeIds\)\)\) redirect\('\/'\);/);
  });
});

describe('the Performance block with competencies and a Career Plan', () => {
  it('Competency is the subject\'s turn, the Career Plan is Locked until it, and Where you stand says so in words', async () => {
    const subject = await hire('Full journey subject');
    await gradeAll();
    const profileId = randomUUID();
    const cycleId = await openCycle('WP-A2 full', b.companyId, (p) => {
      p.profiles = [{ id: profileId, companyId: b.companyId, grade: '12', name: 'Engineering', jobTitle: 'Engineer', competencies: [{ id: 'skill-1', principle: 'Technical', text: 'Current skill', future: false }, { id: 'skill-2', principle: 'Technical', text: 'Second skill', future: false }] }];
    });
    const self = await as(subject, 'employee');
    // No profile matched at opening: competency is not required of this person (and is not counted).
    const unassigned = must(await block(self), 'block');
    expect(unassigned.steps.map((s) => `${s.key}:${s.state}`)).toEqual(['kpiSetting:yourTurn', 'competency:notRequired', 'careerPlan:locked', 'results:locked']);
    expect(unassigned).toMatchObject({ done: 0, total: 3 });
    expect(unassigned.standing.competency).toBeNull();
    const reviewId = await reviewIdFor(cycleId, subject);
    await perf.assignAssessmentProfile(a, reviewId, must(await perf.getOnehrReview(a, reviewId), 'view').revision, profileId);
    const blk = must(await block(self), 'block');
    expect(blk.steps.map((s) => `${s.key}:${s.state}`)).toEqual(['kpiSetting:yourTurn', 'competency:yourTurn', 'careerPlan:locked', 'results:locked']);
    expect(blk).toMatchObject({ done: 0, total: 4 });
    expect(blk.standing).toEqual({ performance: { state: 'awaitingManager' }, competency: 'notSubmitted', feedback360: 'notReleased', careerTarget: { state: 'notSet' } });
    expect(blk.team).toBeNull();
    expect(blk.cycle.id).toBe(cycleId);
  });
});
