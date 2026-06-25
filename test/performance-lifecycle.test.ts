/**
 * Performance Tracking — full lifecycle (ADR-0022 lifecycle extension). Column-widening (not a stage
 * table): YER reuses the canonical self/manager/overall columns; MYR + goal-setting get their own.
 * Covers MYR/YER stage evals + scope guards, super_admin self-ban, goal propose/approve/lock +
 * immutability, calibration mandatory-justification + byDepartment, closure (ABC + finalScore +
 * release gate + status preserved + concurrency), the notification projection, attachments + RLS,
 * and a YER-only regression (distribution + merit pool unchanged).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  acknowledgeReview,
  addPerformanceAttachment,
  approveGoal,
  calibrationView,
  closeReview,
  commitCalibration,
  createCycle,
  createGoal,
  cycleDetail,
  getPerformanceAttachment,
  listAttachmentsForReview,
  lockGoalSetting,
  moveCycleToCalibration,
  openCalibrationSession,
  openCycle,
  PerfError,
  proposeCalibration,
  proposeGoals,
  releaseCycle,
  reviewForViewer,
  submitManagerReview,
  submitSelfReview,
  submitStageManager,
  submitStageSelf,
  updateGoal,
} from '../core/performance';
import { dispatchNotifications } from '../core/notifications';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, deptId?: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const reviewRow = (id: string) =>
  owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, id)).then((r) => r[0]);

describe('performance lifecycle', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  // Manager M with a subordinate E1; a 3-stage cycle, opened.
  async function setup(opts: { deptId?: string } = {}) {
    const a = adminCtx(base);
    const M = await hire(a, base, 'Manager');
    const E1 = await hire(a, base, 'Emp', opts.deptId);
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const uE = await createAppUser(base.tenantId, E1.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E1.personId };
    await setReportingLine(a, { subordinateEmploymentId: E1.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    // openCycle snapshots EVERY in-scope employee (the manager too), so resolve E1's review by hand.
    const [r1] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, E1.employmentId)));
    return { a, M, E1, mCtx, eCtx, cycleId, r1: r1.id };
  }

  it('MYR self/manager submit writes its own columns + emits stage events; rating-scale validated', async () => {
    const { a, mCtx, eCtx, r1 } = await setup();
    await submitStageSelf(eCtx, { reviewId: r1, stage: 'mid_year', selfRating: 4, selfComments: 'mid self' });
    await submitStageManager(mCtx, { reviewId: r1, stage: 'mid_year', managerRating: 3, managerComments: 'mid mgr' });
    const rv = await reviewRow(r1);
    expect(rv.midSelfRating).toBe(4);
    expect(rv.midManagerRating).toBe(3);
    expect(rv.midSelfSubmittedAt).not.toBeNull();
    expect(rv.midManagerSubmittedAt).not.toBeNull();
    // MYR must NOT touch the canonical year-end status machine.
    expect(rv.status).toBe('self_review');
    const types = await eventTypesFor(base.tenantId, r1);
    expect(types).toContain('performance-review.stage-self-submitted');
    expect(types).toContain('performance-review.stage-manager-submitted');
    // Out-of-scale rejected.
    await expect(submitStageSelf(eCtx, { reviewId: r1, stage: 'mid_year', selfRating: 9 })).rejects.toBeInstanceOf(PerfError);
    void a;
  });

  it('YER manager submit writes preliminaryScore + emits forwarded-to-hr', async () => {
    const { mCtx, eCtx, r1 } = await setup();
    await submitStageSelf(eCtx, { reviewId: r1, stage: 'year_end', selfRating: 4 });
    await submitStageManager(mCtx, { reviewId: r1, stage: 'year_end', managerRating: 5, overallRating: 5 });
    const rv = await reviewRow(r1);
    expect(rv.status).toBe('submitted');
    expect(rv.overallRating).toBe(5);
    expect(Number(rv.preliminaryScore)).toBe(5);
    expect(await eventTypesFor(base.tenantId, r1)).toContain('performance-review.forwarded-to-hr');
  });

  it('column-scope: a subject calling submitStageSelf cannot write managerRating', async () => {
    const { mCtx, eCtx, r1 } = await setup();
    // Manager sets MYR manager column; then the subject submits their MYR self — the manager column
    // must be untouched (the service writes ONLY its own column set).
    await submitStageManager(mCtx, { reviewId: r1, stage: 'mid_year', managerRating: 2 });
    await submitStageSelf(eCtx, { reviewId: r1, stage: 'mid_year', selfRating: 5 });
    const rv = await reviewRow(r1);
    expect(rv.midManagerRating).toBe(2); // subject did not overwrite the manager column
    expect(rv.midSelfRating).toBe(5);
    // And a subject cannot drive the manager path at all (assertCanDecide).
    await expect(submitStageManager(eCtx, { reviewId: r1, stage: 'year_end', managerRating: 3, overallRating: 3 })).rejects.toThrow();
  });

  it('super_admin cannot finalize their own year-end review (explicit subject-ban → PerfError)', async () => {
    const a = adminCtx(base);
    const S = await hire(a, base, 'Sadmin');
    const uS = await createAppUser(base.tenantId, S.personId, 'super_admin');
    const sCtx: SessionContext = { tenantId: base.tenantId, userId: uS, roles: ['super_admin'], personId: S.personId };
    const { cycleId } = await createCycle(a, { name: 'C', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const [rev] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, S.employmentId)));
    await expect(submitStageManager(sCtx, { reviewId: rev.id, stage: 'year_end', managerRating: 5, overallRating: 5 })).rejects.toBeInstanceOf(PerfError);
  });

  it('a peer cannot approve a goal (plain Error from assertCanDecide)', async () => {
    const { a, eCtx, E1, cycleId, r1 } = await setup();
    // A second employee (peer) who is not E1's manager.
    const P = await hire(a, base, 'Peer');
    const uP = await createAppUser(base.tenantId, P.personId, 'employee');
    const pCtx: SessionContext = { tenantId: base.tenantId, userId: uP, roles: ['employee'], personId: P.personId };
    const { id: goalId } = await createGoal(eCtx, { employmentId: E1.employmentId, cycleId, title: 'Ship it' });
    await proposeGoals(eCtx, { reviewId: r1 });
    await expect(approveGoal(pCtx, { goalId })).rejects.toThrow(); // assertCanDecide → plain Error
  });

  it('goal flow: propose→approve→lock; lock blocked while unapproved; locked goals immutable; empty propose errors', async () => {
    const { a, mCtx, eCtx, E1, cycleId, r1 } = await setup();
    // Zero cycle-bound goals ⇒ clear error (not a silent no-op).
    await expect(proposeGoals(eCtx, { reviewId: r1 })).rejects.toBeInstanceOf(PerfError);
    const { id: g1 } = await createGoal(eCtx, { employmentId: E1.employmentId, cycleId, title: 'G1' });
    const { id: g2 } = await createGoal(eCtx, { employmentId: E1.employmentId, cycleId, title: 'G2' });
    await proposeGoals(eCtx, { reviewId: r1 });
    // Lock blocked while any cycle-bound goal is unapproved.
    await expect(lockGoalSetting(mCtx, { reviewId: r1 })).rejects.toBeInstanceOf(PerfError);
    await approveGoal(mCtx, { goalId: g1 });
    await approveGoal(mCtx, { goalId: g2 });
    await lockGoalSetting(mCtx, { reviewId: r1 });
    const rv = await reviewRow(r1);
    expect(rv.goalStageStatus).toBe('locked');
    // Locked goal is immutable.
    await expect(updateGoal(eCtx, { goalId: g1, title: 'edit' })).rejects.toBeInstanceOf(PerfError);
    const types = await eventTypesFor(base.tenantId, r1);
    expect(types).toContain('performance-review.goal-stage.locked');
    void a;
  });

  it('calibration: justification mandatory on an adjustment; not on no-op / first-value; byDepartment sums to roster', async () => {
    const a = adminCtx(base);
    const M = await hire(a, base, 'Mgr');
    const E1 = await hire(a, base, 'Ann', base.deptA);
    const E2 = await hire(a, base, 'Bob', base.deptB);
    for (const e of [E1, E2]) {
      await setReportingLine(a, { subordinateEmploymentId: e.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    }
    const { cycleId } = await createCycle(a, { name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const reviews = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.cycleId, cycleId));
    const r1 = reviews.find((r) => r.employmentId === E1.employmentId)!;
    const r2 = reviews.find((r) => r.employmentId === E2.employmentId)!;
    await submitSelfReview(a, { reviewId: r1.id, selfRating: 5 });
    await submitManagerReview(a, { reviewId: r1.id, managerRating: 5, overallRating: 5 });
    await submitSelfReview(a, { reviewId: r2.id, selfRating: 3 });
    await submitManagerReview(a, { reviewId: r2.id, managerRating: 3, overallRating: 3 });
    await moveCycleToCalibration(a, { cycleId });

    // byDepartment: one bucket per dept, counts sum to the roster.
    const view = await calibrationView(a, cycleId);
    const totalDeptCount = view.byDepartment.reduce((s, d) => s + d.count, 0);
    expect(totalDeptCount).toBe(view.rows.length);
    expect(view.byDepartment.length).toBe(2); // Finance + Operations

    // Adjustment without justification ⇒ rejected.
    const { sessionId } = await openCalibrationSession(a, { cycleId });
    await proposeCalibration(a, { sessionId, reviewId: r1.id, proposedRating: 4 }); // 5 → 4, no note
    await expect(commitCalibration(a, { sessionId })).rejects.toBeInstanceOf(PerfError);
    // With a note ⇒ accepted; a no-op proposal (3 → 3) needs none.
    await proposeCalibration(a, { sessionId, reviewId: r1.id, proposedRating: 4, note: 'normalize top' });
    await proposeCalibration(a, { sessionId, reviewId: r2.id, proposedRating: 3 }); // no-op, no note ok
    const { applied } = await commitCalibration(a, { sessionId });
    expect(applied).toBe(2);
    expect((await reviewRow(r1.id)).overallRating).toBe(4);
  });

  // Closure: full happy path to release, then close.
  async function toReleased() {
    const { a, mCtx, eCtx, E1, cycleId, r1 } = await setup();
    await submitStageSelf(eCtx, { reviewId: r1, stage: 'year_end', selfRating: 4 });
    await submitStageManager(mCtx, { reviewId: r1, stage: 'year_end', managerRating: 4, overallRating: 4 });
    await moveCycleToCalibration(a, { cycleId });
    await releaseCycle(a, { cycleId });
    return { a, mCtx, eCtx, E1, cycleId, r1 };
  }

  it('closeReview: ABC + finalScore (default = overall), status preserved, asserts released, admin-only', async () => {
    const { a, mCtx, eCtx, cycleId, r1 } = await toReleased();
    // Non-admin rejected.
    await expect(closeReview(mCtx, { reviewId: r1, abcClass: 'A' })).rejects.toBeInstanceOf(PerfError);
    const res = await closeReview(a, { reviewId: r1, abcClass: 'A' });
    expect(res.finalScore).toBe(4); // defaulted from overallRating
    const rv = await reviewRow(r1);
    expect(rv.abcClass).toBe('A');
    expect(Number(rv.finalScore)).toBe(4);
    expect(rv.closedAt).not.toBeNull();
    // Status must NOT change — the acknowledge path still requires 'submitted'.
    expect(rv.status).toBe('submitted');
    expect(await eventTypesFor(base.tenantId, r1)).toContain('performance-review.closed');
    // The acknowledge path still works after closure.
    await acknowledgeReview(eCtx, { reviewId: r1 });
    expect((await reviewRow(r1)).status).toBe('acknowledged');
    void cycleId;
  });

  it('closeReview asserts the cycle is released first', async () => {
    const { a, mCtx, eCtx, cycleId, r1 } = await setup();
    await submitStageSelf(eCtx, { reviewId: r1, stage: 'year_end', selfRating: 4 });
    await submitStageManager(mCtx, { reviewId: r1, stage: 'year_end', managerRating: 4, overallRating: 4 });
    await moveCycleToCalibration(a, { cycleId });
    // Not released yet ⇒ rejected.
    await expect(closeReview(a, { reviewId: r1, abcClass: 'B' })).rejects.toBeInstanceOf(PerfError);
  });

  it('a second close is rejected (serialized via the row lock)', async () => {
    const { a, r1 } = await toReleased();
    await closeReview(a, { reviewId: r1, abcClass: 'C' });
    await expect(closeReview(a, { reviewId: r1, abcClass: 'A' })).rejects.toBeInstanceOf(PerfError);
  });

  it('notification projection: closeReview → a notification row for the subject (NOTIFICATIONS_ENABLED)', async () => {
    const prev = process.env.NOTIFICATIONS_ENABLED;
    process.env.NOTIFICATIONS_ENABLED = 'true';
    try {
      const { a, E1, r1 } = await toReleased();
      await closeReview(a, { reviewId: r1, abcClass: 'A' });
      await dispatchNotifications(a);
      const notes = await owner.db
        .select()
        .from(schema.notification)
        .where(and(eq(schema.notification.recipientEmploymentId, E1.employmentId), eq(schema.notification.kind, 'performance.closed')));
      expect(notes.length).toBe(1);
      // Release-safe body: never the class.
      expect(notes[0].body).not.toContain('A');
    } finally {
      process.env.NOTIFICATIONS_ENABLED = prev;
    }
  });

  it('regression: a YER-only cycle still calibrates, rolls up merit, releases, acknowledges; distribution unchanged', async () => {
    const a = adminCtx(base);
    const M = await hire(a, base, 'Mgr');
    const E1 = await hire(a, base, 'Ann');
    await setReportingLine(a, { subordinateEmploymentId: E1.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: E1.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    // Year-end-only cycle with a percent merit pool.
    const { cycleId } = await createCycle(a, {
      name: 'YER only',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      meritBudget: { kind: 'percent', value: 10 },
      stages: [{ kind: 'year_end', label: 'Year-end' }],
    });
    await openCycle(a, { cycleId });
    // openCycle snapshots the manager too; target E1's review (the one with compensation) explicitly.
    const [rev] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(and(eq(schema.performanceReview.cycleId, cycleId), eq(schema.performanceReview.employmentId, E1.employmentId)));
    // The classic single-review flow (NOT the stage helpers) must still work end to end.
    await submitSelfReview(a, { reviewId: rev.id, selfRating: 4 });
    await submitManagerReview(a, { reviewId: rev.id, managerRating: 4, overallRating: 4, recommendedMeritPct: 5 });
    const detail = (await cycleDetail(a, cycleId))!;
    expect(detail.distribution.find((d) => d.value === 4)?.count).toBe(1);
    // Merit pool = 10% of 5000 = 500; consumed = 5% of 5000 = 250.
    expect(detail.budget.pool).toBe(500);
    expect(detail.budget.consumed).toBe(250);
    await moveCycleToCalibration(a, { cycleId });
    await releaseCycle(a, { cycleId });
    // closeReview must also work on a YER-only cycle.
    await closeReview(a, { reviewId: rev.id, abcClass: 'B' });
    expect((await reviewRow(rev.id)).status).toBe('submitted');
  });

  it('attachments: 10 MB cap + empty guard; metadata grouped by stageKind; a peer cannot read another\'s', async () => {
    const { a, eCtx, r1 } = await setup();
    await expect(addPerformanceAttachment(a, { reviewId: r1, stageKind: 'mid_year', fileName: 'x', mimeType: 'text/plain', content: Buffer.alloc(0) })).rejects.toBeInstanceOf(PerfError);
    await expect(addPerformanceAttachment(a, { reviewId: r1, stageKind: 'mid_year', fileName: 'big', mimeType: 'application/pdf', content: Buffer.alloc(10 * 1024 * 1024 + 1) })).rejects.toBeInstanceOf(PerfError);
    const { id: attId } = await addPerformanceAttachment(eCtx, { reviewId: r1, stageKind: 'year_end', fileName: 'note.txt', mimeType: 'text/plain', content: Buffer.from('hello') });
    const metas = await listAttachmentsForReview(eCtx, r1);
    expect(metas).toHaveLength(1);
    expect(metas[0].stageKind).toBe('year_end');
    expect(metas[0].fileName).toBe('note.txt');
    expect(await eventTypesFor(base.tenantId, r1)).toContain('performance-attachment.added');
    // A peer (no RLS access to the subject) cannot read the bytes → not found.
    const P = await hire(a, base, 'Stranger');
    const uP = await createAppUser(base.tenantId, P.personId, 'employee');
    const pCtx: SessionContext = { tenantId: base.tenantId, userId: uP, roles: ['employee'], personId: P.personId };
    expect(await getPerformanceAttachment(pCtx, attId)).toBeNull();
    // …but the subject can.
    expect(await getPerformanceAttachment(eCtx, attId)).not.toBeNull();
  });

  it('reviewForViewer exposes lifecycle fields + attachments; subject gets MYR manager side only after release', async () => {
    const { a, mCtx, eCtx, cycleId, r1 } = await setup();
    await submitStageManager(mCtx, { reviewId: r1, stage: 'mid_year', managerRating: 3, managerComments: 'mid mgr note' });
    // Before release, the subject must not see the MYR manager side.
    const beforeRelease = (await reviewForViewer(eCtx, r1))!;
    expect(beforeRelease.midManagerRating).toBeNull();
    expect(beforeRelease.stages.map((s) => s.kind)).toEqual(['goal_setting', 'mid_year', 'year_end']);
    // The manager always sees it.
    expect((await reviewForViewer(mCtx, r1))!.midManagerRating).toBe(3);
    await releaseCycle(a, { cycleId });
    expect((await reviewForViewer(eCtx, r1))!.midManagerRating).toBe(3);
  });
});
