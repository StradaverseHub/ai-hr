/**
 * Performance Phase B — calibration + analytics (ADR-0022, slice 4). Advisory: an admin proposes
 * adjusted overall ratings across a cohort, then COMMITS — only the commit writes the rating (+ event).
 * A proposal never mutates a rating. Plus the analytics the view carries (distribution + leniency).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  calibrationView,
  commitCalibration,
  createCycle,
  moveCycleToCalibration,
  openCalibrationSession,
  openCycle,
  PerfError,
  proposeCalibration,
  submitManagerReview,
  submitSelfReview,
} from '../core/performance';
import { hireEmployee, setReportingLine } from '../core/org';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0022 — calibration', () => {
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

  // Two employees of manager M, both with finalized reviews; cycle moved to calibration.
  async function setup() {
    const a = adminCtx(base);
    const M = await hire(a, base, 'Manager');
    const E1 = await hire(a, base, 'Ann');
    const E2 = await hire(a, base, 'Bob');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    for (const e of [E1, E2]) {
      await setReportingLine(a, { subordinateEmploymentId: e.employmentId, managerEmploymentId: M.employmentId, lineType: 'administrative', validFrom: '2026-01-01' });
    }
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const reviews = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.cycleId, cycleId));
    const r1 = reviews.find((r) => r.employmentId === E1.employmentId)!;
    const r2 = reviews.find((r) => r.employmentId === E2.employmentId)!;
    // finalize both (overall 5 and 3) — admin can drive both steps; reviewer stays M (set at open).
    await submitSelfReview(a, { reviewId: r1.id, selfRating: 5 });
    await submitManagerReview(a, { reviewId: r1.id, managerRating: 5, overallRating: 5 });
    await submitSelfReview(a, { reviewId: r2.id, selfRating: 3 });
    await submitManagerReview(a, { reviewId: r2.id, managerRating: 3, overallRating: 3 });
    await moveCycleToCalibration(a, { cycleId });
    return { a, M, E1, E2, mCtx, cycleId, r1: r1.id, r2: r2.id };
  }

  it('opens a session only in calibration status; reuses the open one', async () => {
    const { a, cycleId } = await setup();
    const { sessionId } = await openCalibrationSession(a, { cycleId });
    expect(await eventTypesFor(base.tenantId, sessionId)).toContain('calibration-session.opened');
    expect((await openCalibrationSession(a, { cycleId })).sessionId).toBe(sessionId); // reused
  });

  it('a manager (non-admin) cannot run calibration', async () => {
    const { mCtx, cycleId } = await setup();
    await expect(openCalibrationSession(mCtx, { cycleId })).rejects.toBeInstanceOf(PerfError);
  });

  it('proposes (no rating write) then commits (writes overall + event)', async () => {
    const { a, cycleId, r1 } = await setup();
    const { sessionId } = await openCalibrationSession(a, { cycleId });
    await proposeCalibration(a, { sessionId, reviewId: r1, proposedRating: 4, note: 'normalize the top' });

    // Proposal alone does NOT change the rating.
    let [rev1] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, r1));
    expect(rev1.overallRating).toBe(5);
    // …but it shows in the view.
    const view = await calibrationView(a, cycleId);
    expect(view.rows.find((x) => x.reviewId === r1)?.proposedRating).toBe(4);

    const { applied } = await commitCalibration(a, { sessionId });
    expect(applied).toBe(1);
    [rev1] = await owner.db.select().from(schema.performanceReview).where(eq(schema.performanceReview.id, r1));
    expect(rev1.overallRating).toBe(4); // now written
    expect(await eventTypesFor(base.tenantId, r1)).toContain('performance-review.calibrated');
    await expect(commitCalibration(a, { sessionId })).rejects.toBeInstanceOf(PerfError); // already committed
  });

  it('rejects a proposed rating outside the cycle scale', async () => {
    const { a, cycleId, r1 } = await setup();
    const { sessionId } = await openCalibrationSession(a, { cycleId });
    await expect(proposeCalibration(a, { sessionId, reviewId: r1, proposedRating: 9 })).rejects.toBeInstanceOf(PerfError);
  });

  it('analytics: rating distribution + per-reviewer leniency over the effective ratings', async () => {
    const { a, cycleId } = await setup();
    const view = await calibrationView(a, cycleId);
    // Ann=5, Bob=3 → distribution has count 1 at value 5 and 1 at value 3.
    expect(view.distribution.find((d) => d.value === 5)?.count).toBe(1);
    expect(view.distribution.find((d) => d.value === 3)?.count).toBe(1);
    // Manager reviews both → leniency avg = 4 over 2.
    const lenient = view.reviewerLeniency.find((r) => r.reviewer === 'Manager');
    expect(lenient).toMatchObject({ avg: 4, count: 2 });
  });
});
