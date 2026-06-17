/**
 * Performance Phase B — goals / OKRs (ADR-0022, slice 1). Continuous + cycle-linkable goals,
 * co-owned by subject + admin-line manager + admin (can_see_employment RLS), reference-only
 * (never compute pay). Covers CRUD + progress lifecycle, RLS isolation, myGoals, and review linkage.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  createCycle,
  createGoal,
  goalsForReview,
  linkGoalToReview,
  listGoalsForEmployment,
  myGoals,
  openCycle,
  PerfError,
  unlinkGoalFromReview,
  updateGoal,
  updateGoalProgress,
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

describe('ADR-0022 — performance goals', () => {
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

  // E (employee) reports to M (manager); X is an unrelated peer. Returns ctxs.
  async function people() {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Goalie');
    const M = await hire(a, base, 'Boss');
    const X = await hire(a, base, 'Peer');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E.personId };
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const xCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'], personId: X.personId };
    return { a, E, M, X, eCtx, mCtx, xCtx };
  }

  it('creates a continuous goal (no cycle) and reads it back + event', async () => {
    const { a, E } = await people();
    const { id } = await createGoal(a, { employmentId: E.employmentId, title: 'Ship the redesign', metric: 'launches', target: '1' });
    expect(await eventTypesFor(base.tenantId, id)).toContain('performance-goal.created');
    const [g] = await listGoalsForEmployment(a, E.employmentId);
    expect(g).toMatchObject({ id, title: 'Ship the redesign', cycleId: null, cycleName: null, progress: 0, status: 'active' });
  });

  it('lets the employee own their own goal (self) and surfaces it on myGoals', async () => {
    const { E, eCtx } = await people();
    await createGoal(eCtx, { employmentId: E.employmentId, title: 'Learn Drizzle' });
    expect((await myGoals(eCtx)).map((g) => g.title)).toContain('Learn Drizzle');
  });

  it('blocks a peer from creating or seeing another employee\'s goal (RLS)', async () => {
    const { a, E, xCtx } = await people();
    await expect(createGoal(xCtx, { employmentId: E.employmentId, title: 'sneaky' })).rejects.toThrow();
    await createGoal(a, { employmentId: E.employmentId, title: 'private goal' });
    expect(await listGoalsForEmployment(xCtx, E.employmentId)).toEqual([]); // RLS hides it
  });

  it('lets the admin-line manager create + see a report\'s goal', async () => {
    const { E, mCtx } = await people();
    await createGoal(mCtx, { employmentId: E.employmentId, title: 'Stretch target' });
    expect((await listGoalsForEmployment(mCtx, E.employmentId)).map((g) => g.title)).toContain('Stretch target');
  });

  it('tracks progress (clamped 0–100) and moves the lifecycle + event', async () => {
    const { a, E } = await people();
    const { id } = await createGoal(a, { employmentId: E.employmentId, title: 'Hit quota' });
    await updateGoalProgress(a, { goalId: id, progress: 150, status: 'achieved' });
    const [g] = await listGoalsForEmployment(a, E.employmentId);
    expect(g.progress).toBe(100); // clamped
    expect(g.status).toBe('achieved');
    expect(await eventTypesFor(base.tenantId, id)).toContain('performance-goal.progressed');
  });

  it('edits descriptive fields without touching progress', async () => {
    const { a, E } = await people();
    const { id } = await createGoal(a, { employmentId: E.employmentId, title: 'Old', weight: 2 });
    await updateGoalProgress(a, { goalId: id, progress: 40 });
    await updateGoal(a, { goalId: id, title: 'New title', description: 'context', weight: 3 });
    const [g] = await listGoalsForEmployment(a, E.employmentId);
    expect(g).toMatchObject({ title: 'New title', description: 'context', weight: 3, progress: 40 });
  });

  it('binds a goal to a cycle (cycleName populated)', async () => {
    const { a, E } = await people();
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await createGoal(a, { employmentId: E.employmentId, cycleId, title: 'Cycle goal' });
    const [g] = await listGoalsForEmployment(a, E.employmentId);
    expect(g).toMatchObject({ cycleId, cycleName: '2026 Annual' });
  });

  it('links a goal onto the subject\'s review (idempotent), rejects cross-subject, and unlinks', async () => {
    const { a, E, M, mCtx } = await people();
    const { cycleId } = await createCycle(a, { name: '2026 Annual', periodStart: '2026-01-01', periodEnd: '2026-12-31' });
    await openCycle(a, { cycleId });
    const [review] = await owner.db
      .select()
      .from(schema.performanceReview)
      .where(eq(schema.performanceReview.employmentId, E.employmentId));
    const { id: goalId } = await createGoal(a, { employmentId: E.employmentId, title: 'Worked on this' });

    await linkGoalToReview(mCtx, { reviewId: review.id, goalId });
    await linkGoalToReview(mCtx, { reviewId: review.id, goalId }); // idempotent
    expect((await goalsForReview(a, review.id)).map((g) => g.id)).toEqual([goalId]);
    expect(await eventTypesFor(base.tenantId, review.id)).toContain('performance-review.goal-linked');

    // a goal belonging to the manager cannot be linked onto E's review
    const { id: mGoal } = await createGoal(a, { employmentId: M.employmentId, title: 'manager goal' });
    await expect(linkGoalToReview(mCtx, { reviewId: review.id, goalId: mGoal })).rejects.toBeInstanceOf(PerfError);

    await unlinkGoalFromReview(mCtx, { reviewId: review.id, goalId });
    expect(await goalsForReview(a, review.id)).toEqual([]);
  });
});
