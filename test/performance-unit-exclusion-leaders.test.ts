/**
 * D-P1-22 X2 (ADR-0150, D5 as amended by APR-022): leader rights while a unit is left out, and the one-level-up
 * reviewer. Only competency review and Career Plan review move up (live); app.onehr_manager is NOT widened, it only
 * gains leader-off. Leader-off reads the unit rule only, per acting employment (D9). Administrators are never stopped.
 * Every read and write runs as the persona (ai_hr_app). Fixture: test/performance-unit-exclusion-fixture.ts, plus:
 *   D (Y) <- H0 (X) <- H1..H5 (X) <- H6 (Y) <- H7 (Y)     the six-level walk (D's stored reviewer is H0)
 *   W (Y) <- G (X) <- W2 (B·Z, W's own second employment)  the walk never reaches the subject
 *   V (Y) <- N0 (X) <- N1 (B·Z)                            a reviewer one level up in another company
 *   U1 (Y) <- E1 (A·X, Dual's employment that is left out)
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import * as perf from '../packs/performance/service';
import { closeAll, owner } from './harness';
import {
  bringBack, buildFixture, effectiveEmployment, exclude, flagAs, kpiLine, moveTo, refusal, reviewOf, revisionOf, setKpis, terminateToday, valueAs, type Fixture,
} from './performance-unit-exclusion-fixture';

let f: Fixture;
let rid: Record<string, string>;
beforeEach(async () => {
  f = await buildFixture(async (g) => {
    const { X, Y, Z } = g.dept, A = g.b.companyId;
    const P = g.P;
    P.D = await g.hire('Deep subject', A, Y);
    for (let i = 0; i <= 7; i++) P[`H${i}`] = await g.hire(`Chain ${i}`, A, i <= 5 ? X : Y);
    await g.line(P.D, P.H0);
    for (let i = 0; i < 7; i++) await g.line(P[`H${i}`], P[`H${i + 1}`]);
    P.W = await g.hire('Self-walk subject', A, Y);
    P.W2 = await g.hire('Self-walk second employment', g.companyB, Z, P.W.personId);
    P.G = await g.hire('Self-walk reviewer', A, X);
    await g.line(P.W, P.G); await g.line(P.G, P.W2);
    g.U.W = await g.login(P.W); g.U.W2 = g.U.W;
    P.V = await g.hire('Cross-company subject', A, Y);
    P.N0 = await g.hire('Cross-company reviewer', A, X);
    P.N1 = await g.hire('Cross-company manager', g.companyB, Z);
    await g.line(P.V, P.N0); await g.line(P.N0, P.N1);
    P.U1 = await g.hire('Dual-reviewed subject', A, Y);
    await g.line(P.U1, P.E1);
  });
  rid = {};
  for (const name of ['M0', 'S', 'C', 'D', 'W', 'V', 'U1']) rid[name] = await reviewOf(f.cycleId, f.P[name]);
});
afterAll(closeAll);

const ruleX = () => exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
const manager = (ctx: SessionContext, review: string) => flagAs(ctx, sql`app.onehr_manager(${review}::uuid)`);
const effective = (ctx: SessionContext, review: string) => flagAs(ctx, sql`app.onehr_effective_reviewer(${review}::uuid)`);
const header = (ctx: SessionContext, review: string) => valueAs<unknown>(ctx, sql`app.onehr_review_header(${review}::uuid)`);
const competencyAnswers = { 'skill-1': { answer: 'yes' as const, remark: 'Delivered the agreed work.' }, 'skill-2': { answer: 'no' as const, remark: 'Still practising.' } };
async function selfCompetencies(review = rid.S, ctx = f.U.S) {
  await perf.submitOnehrCompetencies(ctx, review, await revisionOf(review), competencyAnswers, false, 'My own reflection on the year.');
}
async function sharePlan(review = rid.S, ctx = f.U.S) {
  await perf.saveOnehrPlan(ctx, review, null, { career: { aspiration: 'Lead a team', mobility: 'stay', mobilityNote: '', targetProfileId: null }, goals: [{ id: randomUUID(), area: 'Facilitation', dueOn: '', onJob: 'Run the weekly review', fromOthers: '', formalLearning: '', status: 'not_started' }] }, true);
  const [plan] = await owner.db.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.reviewId, review));
  expect(plan.status).toBe('shared');
  return plan;
}
const planReviewer = (ctx: SessionContext, planId: string) => flagAs(ctx, sql`app.assessment_plan_reviewer(${planId}::uuid)`);
async function session(reviewers: string[], anchor?: { kind: 'bu_ceo'; companyId: string }) {
  return withTenant(f.a, async (tx) => {
    const [s] = await tx.insert(schema.onehrCalibration).values({
      tenantId: f.b.tenantId, cycleId: f.cycleId, companyId: anchor?.companyId ?? null, name: `Session ${randomUUID().slice(0, 8)}`, tier: 'bu', reviewerUserIds: reviewers,
      anchorKind: anchor?.kind ?? null,
    }).returning();
    return s.id;
  });
}
const access = (ctx: SessionContext, id: string) => flagAs(ctx, sql`app.onehr_calibration_access(${id}::uuid)`);
/** loadReview refuses a review the caller cannot open (RLS hides the row, or the header is NULL). */
const GONE = /Assessment not found or access has been removed|Assessment not assigned to you/;

describe('the stored reviewer whose unit is out', () => {
  it('loses every manager right on the review', async () => {
    await perf.assignOnehrPanel(f.a, rid.S, await revisionOf(rid.S), [{ employmentId: f.P.R.employmentId, relationship: 'peer' }]);
    const plan = await sharePlan();
    const panelRows = () => valueAs<number>(f.U.M0, sql`(select count(*)::int from app.onehr_manager_panel(${rid.S}::uuid))`);
    expect([await manager(f.U.M0, rid.S), await header(f.U.M0, rid.S) != null, await panelRows()], 'non-vacuous: the stored reviewer before the rule').toEqual([true, true, 1]);
    await ruleX();
    expect(await manager(f.U.M0, rid.S)).toBe(false);
    expect(await header(f.U.M0, rid.S)).toBeNull();
    expect(await panelRows()).toBe(0);
    expect(await refusal(perf.confirmOnehrPerformance(f.U.M0, rid.S, await revisionOf(rid.S), 'ME', ''))).toMatch(GONE);
    expect(await refusal(perf.assignOnehrPanel(f.U.M0, rid.S, await revisionOf(rid.S), [{ employmentId: f.P.C.employmentId, relationship: 'peer' }]))).toMatch(GONE);
    await selfCompetencies();
    expect(await refusal(perf.submitOnehrCompetencies(f.U.M0, rid.S, await revisionOf(rid.S), competencyAnswers, true, ''))).toMatch(GONE);
    expect(await refusal(perf.reviewOnehrPlan(f.U.M0, plan.id, plan.revision, 'Comment', '', false))).toMatch(/Plan not found|not assigned to you/);
  });

  it('the manager one level up is not given onehr_manager, only the competency and plan reviewer arm', async () => {
    expect([await manager(f.U.M0, rid.S), await effective(f.U.M0, rid.S), await effective(f.U.M1, rid.S)], 'no rule: the effective reviewer is the stored reviewer').toEqual([true, true, false]);
    await ruleX();
    expect([await manager(f.U.M1, rid.S), await effective(f.U.M1, rid.S), await effective(f.U.M0, rid.S)]).toEqual([false, true, false]);
    expect(await effectiveEmployment(f.a, rid.S)).toBe(f.P.M1.employmentId);
  });

  it('the manager one level up reviews the competency self-assessment', async () => {
    await ruleX();
    await selfCompetencies();
    await perf.submitOnehrCompetencies(f.U.M1, rid.S, await revisionOf(rid.S), competencyAnswers, true, 'Agreed with the reflection.');
    const [row] = await owner.db.select({ status: schema.onehrReview.competencyStatus, remark: schema.onehrReview.competencyManagerRemark }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, rid.S));
    expect(row).toEqual({ status: 'reviewed', remark: 'Agreed with the reflection.' });
    const view = await perf.getOnehrReview(f.U.M1, rid.S);
    expect(view).toMatchObject({ reviewer: true, manager: false, competencyStatus: 'reviewed', managerPerformance: null, kpis: [] });
  });

  it('the manager one level up reviews, remarks on and closes the Career Plan; the stored reviewer cannot', async () => {
    await ruleX();
    const plan = await sharePlan();
    expect([await planReviewer(f.U.M1, plan.id), await planReviewer(f.U.M0, plan.id)]).toEqual([true, false]);
    expect(await refusal(perf.reviewOnehrPlan(f.U.M0, plan.id, plan.revision, 'Comment', '', false))).toMatch(/Plan not found|not assigned to you/);
    await perf.reviewOnehrPlan(f.U.M1, plan.id, plan.revision, 'A clear and realistic plan.', 'We agreed the first step.', true);
    const [closed] = await owner.db.select({ status: schema.onehrPlan.status, managerComment: schema.onehrPlan.managerComment }).from(schema.onehrPlan).where(eq(schema.onehrPlan.id, plan.id));
    expect(closed).toEqual({ status: 'closed', managerComment: 'A clear and realistic plan.' });
  });

  it('while the stored reviewer is out, any reviewer of the line may write the overall plan remark', async () => {
    const lines = [kpiLine({ title: 'Line manager KPI', moderator: f.P.M0.employmentId }), kpiLine({ title: 'Matrix KPI', moderator: f.P.A.employmentId, source: 'matrix' })];
    await setKpis(f.a, rid.S, lines);
    const writer = () => flagAs(f.U.A, sql`app.assessment_plan_remark_writer(${rid.S}::uuid)`);
    expect(await writer(), 'non-vacuous: the stored reviewer owns the remark while taking part').toBe(false);
    const { saved } = await ruleX();
    expect(await writer()).toBe(true);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await writer()).toBe(false);
  });

  it('the manager one level up gets no PM, panel or band right', async () => {
    await setKpis(f.a, rid.S, [kpiLine({ title: 'Delivery', moderator: f.P.M0.employmentId, weightBp: 10000 })]);
    await ruleX();
    const [line] = (await owner.db.select({ kpis: schema.onehrReview.kpis }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, rid.S)))[0].kpis as { id: string }[];
    expect(await refusal(perf.confirmOnehrPerformance(f.U.M1, rid.S, await revisionOf(rid.S), 'ME', ''))).toMatch(/not assigned to you/);
    expect(await refusal(perf.assignOnehrPanel(f.U.M1, rid.S, await revisionOf(rid.S), [{ employmentId: f.P.R.employmentId, relationship: 'peer' }]))).toMatch(/not assigned to you/);
    expect(await refusal(perf.moderateOnehrKpi(f.U.M1, rid.S, await revisionOf(rid.S), line.id, 100, 'Checked'))).toMatch(/not assigned to you/);
    expect(await flagAs(f.U.M1, sql`app.onehr_moderator(${rid.S}::uuid)`)).toBe(false);
  });
});

describe('the walk (D6: one function, six levels, stops at a terminated manager or the subject)', () => {
  it('two left-out managers in a row resolve two levels up', async () => {
    await ruleX();
    await moveTo(f.P.M1, f.dept.X);
    expect(await effectiveEmployment(f.a, rid.S)).toBe(f.P.M2.employmentId);
    expect([await effective(f.U.M2, rid.S), await effective(f.U.M1, rid.S)]).toEqual([true, false]);
  });

  it('nobody above leaves the review with no competency or plan reviewer', async () => {
    expect(await effectiveEmployment(f.a, rid.S), 'non-vacuous').toBe(f.P.M0.employmentId);
    await exclude(f.a, f.cycleId, f.b.companyId, null);
    expect(await effectiveEmployment(f.a, rid.S)).toBeNull();
    for (const ctx of [f.U.M0, f.U.M1, f.U.M2]) expect(await header(ctx, rid.S)).toBeNull();
    expect(await header(f.a, rid.S)).not.toBeNull();
  });

  it('stops after six managers: six left out resolve to the seventh, seven left out to nobody', async () => {
    await ruleX();
    expect(await effectiveEmployment(f.a, rid.D)).toBe(f.P.H6.employmentId);
    await moveTo(f.P.H6, f.dept.X);
    expect(await effectiveEmployment(f.a, rid.D), 'H7 takes part, but is beyond the cap').toBeNull();
  });

  it('a terminated manager stops the walk', async () => {
    await ruleX();
    expect(await effectiveEmployment(f.a, rid.S)).toBe(f.P.M1.employmentId);
    await terminateToday(f.P.M1);
    expect(await effectiveEmployment(f.a, rid.S), 'M2 takes part above, but the walk stops at the terminated M1').toBeNull();
  });

  it('the subject is never their own reviewer', async () => {
    expect(await effectiveEmployment(f.a, rid.W)).toBe(f.P.G.employmentId);
    await ruleX();
    expect(await effectiveEmployment(f.a, rid.W), 'the next manager is the subject\'s own second employment').toBeNull();
  });

  it('a manager in another company may review one level up', async () => {
    await ruleX();
    expect(await effectiveEmployment(f.a, rid.V)).toBe(f.P.N1.employmentId);
    const n1 = f.U.N1;
    expect(await effective(n1, rid.V)).toBe(true);
    expect(await header(n1, rid.V)).not.toBeNull();
  });

  it('leader-off applies per acting employment (D9)', async () => {
    expect(await manager(f.U.E1, rid.U1), 'non-vacuous: the person reviews through E1').toBe(true);
    await ruleX();
    expect(await manager(f.U.E1, rid.U1), 'E2 takes part, but E1 is the acting employment').toBe(false);
    expect(await effectiveEmployment(f.a, rid.U1)).toBeNull();
  });
});

describe('moderation, calibration and administrators', () => {
  it('a moderator whose unit is out can neither moderate nor approve, and has no task', async () => {
    const lines = [kpiLine({ title: 'Line manager KPI', moderator: f.P.M0.employmentId, setting: 'approved', actual: 100 }), kpiLine({ title: 'Matrix KPI', moderator: f.P.A.employmentId, source: 'matrix', setting: 'approved', actual: 100 })];
    await setKpis(f.a, rid.S, lines, true);
    const matrix = lines[1].id;
    const taskFor = async (ctx: SessionContext) => (await perf.pendingPerformanceTasks(ctx, undefined)).some((t) => t.linkPath.endsWith(rid.S));
    expect([await flagAs(f.U.A, sql`app.onehr_moderator(${rid.S}::uuid)`), await flagAs(f.U.A, sql`app.onehr_moderator(${rid.S}::uuid,${matrix}::uuid)`), await taskFor(f.U.A)], 'non-vacuous').toEqual([true, true, true]);
    await ruleX();
    await moveTo(f.P.A, f.dept.X);
    expect([await flagAs(f.U.A, sql`app.onehr_moderator(${rid.S}::uuid)`), await flagAs(f.U.A, sql`app.onehr_moderator(${rid.S}::uuid,${matrix}::uuid)`)]).toEqual([false, false]);
    expect(await refusal(perf.moderateOnehrKpi(f.U.A, rid.S, await revisionOf(rid.S), matrix, 100, ''))).toMatch(GONE);
    expect(await taskFor(f.U.A)).toBe(false);
  });

  it('an explicit calibration reviewer whose unit is out loses the session; one with another taking-part employment keeps it', async () => {
    const id = await session([f.U.Q.userId!, f.U.E1.userId!]);
    expect([await access(f.U.Q, id), await access(f.U.E1, id)], 'non-vacuous').toEqual([true, true]);
    await ruleX();
    expect([await access(f.U.Q, id), await access(f.U.E1, id)]).toEqual([false, true]);
    await exclude(f.a, f.cycleId, f.companyB, null);
    expect(await access(f.U.E1, id), 'every live employment of the person in scope is now out').toBe(false);
  });

  it('a seat holder whose unit is out loses the anchored session (B2 seats)', async () => {
    await perf.appointLeaderSeat(f.a, { seatType: 'bu_ceo', companyId: f.b.companyId, holderEmploymentId: f.P.Q.employmentId });
    const id = await session([], { kind: 'bu_ceo', companyId: f.b.companyId });
    expect(await access(f.U.Q, id), 'non-vacuous: the live seat grants the session').toBe(true);
    await ruleX();
    expect(await access(f.U.Q, id)).toBe(false);
  });

  it('the administrator arm is unaffected by the rule', async () => {
    const person = await f.hire('HR administrator in the unit', f.b.companyId, f.dept.X);
    const hr = await f.scoped(person, 'hr_admin', null);
    const id = await session([f.U.Q.userId!]);
    await ruleX();
    expect(await flagAs(f.a, sql`app.assessment_unit_out(${f.cycleId}::uuid,${person.employmentId}::uuid)`), 'the administrator is in the left-out unit').toBe(true);
    expect([await flagAs(hr, sql`app.onehr_cycle_admin(${f.cycleId}::uuid)`), await access(hr, id), await flagAs(hr, sql`app.assessment_review_participates(${rid.S}::uuid)`), await header(hr, rid.S) != null]).toEqual([true, true, true, true]);
  });

  it('AI follows the rights: sources for the effective reviewer only; an excluded leader\'s request is refused', async () => {
    await selfCompetencies();
    const competency = (ctx: SessionContext) => valueAs<unknown>(ctx, sql`app.assessment_competency_source(${rid.S}::uuid)`);
    const insight = (ctx: SessionContext) => valueAs<unknown>(ctx, sql`app.assessment_insight_source(${rid.S}::uuid,${rid.S}::uuid)`);
    const idp = (ctx: SessionContext) => valueAs<unknown>(ctx, sql`app.assessment_idp_source(${rid.S}::uuid,null::uuid)`);
    expect([await competency(f.U.M0) != null, await insight(f.U.M0) != null], 'non-vacuous: the stored reviewer before the rule').toEqual([true, true]);
    await ruleX();
    expect([await competency(f.U.M0), await insight(f.U.M0), await insight(f.U.M1)]).toEqual([null, null, null]);
    expect(await competency(f.U.M1)).not.toBeNull();
    expect(await idp(f.U.M1)).not.toBeNull();
    expect(await refusal(perf.getAssessmentCompetencyInsight(f.U.M0, rid.S))).toMatch(/not assigned to you/);
    expect((await perf.getAssessmentCompetencyInsight(f.U.M1, rid.S)).status).toBe('submitted');
  });

  it('tasks follow the one-level-up review', async () => {
    await ruleX();
    await selfCompetencies();
    const links = async (ctx: SessionContext) => (await perf.pendingPerformanceTasks(ctx, undefined)).map((t) => t.linkPath);
    expect((await links(f.U.M1)).some((l) => l.endsWith(rid.S))).toBe(true);
    expect((await links(f.U.M0)).some((l) => l.endsWith(rid.S))).toBe(false);
  });

  it('the reminder graph names the effective reviewer and drops a moderator whose unit is out', async () => {
    const dispatcher = { ...f.a, userId: undefined, personId: undefined };
    const graph = async () => (await valueAs<{ reviews: { id: string; reviewerEmploymentId: string | null; moderatorIds: string[] }[] }>(dispatcher, sql`app.assessment_pending_work(${f.cycleId}::uuid)`)).reviews.find((r) => r.id === rid.S)!;
    const before = await graph();
    expect(before.reviewerEmploymentId).toBe(f.P.M0.employmentId);
    expect(before.moderatorIds).toContain(f.P.M0.employmentId);
    await ruleX();
    const after = await graph();
    expect(after.reviewerEmploymentId).toBe(f.P.M1.employmentId);
    expect(after.moderatorIds).not.toContain(f.P.M0.employmentId);
  });

  it('Bring back returns every right at once', async () => {
    const { saved } = await ruleX();
    expect([await manager(f.U.M0, rid.S), await effective(f.U.M1, rid.S)]).toEqual([false, true]);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect([await manager(f.U.M0, rid.S), await effective(f.U.M1, rid.S), await effective(f.U.M0, rid.S)]).toEqual([true, false, true]);
  });

  it('an excluded subject\'s cached PM insight is not readable by anyone (U11)', async () => {
    await withTenant(f.U.M1, (tx) => tx.insert(schema.assessmentInsight).values({ tenantId: f.b.tenantId, reviewId: rid.C, actorUserId: f.U.M1.userId!, contextId: rid.C, fingerprint: 'a'.repeat(64), source: 'plain', data: {} as never }));
    const rows = () => withTenant(f.U.M1, (tx) => tx.select({ id: schema.assessmentInsight.id }).from(schema.assessmentInsight).where(eq(schema.assessmentInsight.reviewId, rid.C)));
    expect(await rows(), 'non-vacuous: the reviewer reads the cache').toHaveLength(1);
    await ruleX();
    await moveTo(f.P.C, f.dept.X);
    expect(await manager(f.U.M1, rid.C), 'the reviewer still takes part').toBe(true);
    expect(await rows()).toEqual([]);
  });

  it('a head of department whose unit is out sees no department view; an excluded person leaves it', async () => {
    await setKpis(f.a, rid.S, [kpiLine({ title: 'Delivery', moderator: f.P.M0.employmentId, weightBp: 10000 })]);
    const input = { subjectEmploymentIds: [f.P.S.employmentId], hodEmploymentId: f.P.Q.employmentId };
    const preview = await perf.previewHodChange(f.a, input);
    await perf.applyHodChange(f.a, { ...input, fingerprint: preview.fingerprint, acknowledged: true });
    const view = async () => (await withTenant(f.U.Q, (tx) => tx.execute<{ employment_id: string }>(sql`select employment_id from app.onehr_department_view(${f.cycleId}::uuid) order by employment_id`))).map((r) => r.employment_id);
    expect(await view(), 'non-vacuous: the HOD sees the person').toEqual([f.P.S.employmentId]);
    const { saved } = await ruleX();
    expect(await view()).toEqual([]);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await view()).toEqual([f.P.S.employmentId]);
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.Y);
    expect(await view(), 'the person\'s own unit is out (app.assessment_review_eligible)').toEqual([]);
  });
});

describe('guards', () => {
  it('a cycle without an active rule keeps onehr_manager and the effective reviewer identical', async () => {
    const reviews = await owner.db.select({ id: schema.onehrReview.reviewId }).from(schema.onehrReview).where(eq(schema.onehrReview.cycleId, f.cycleId)).orderBy(asc(schema.onehrReview.reviewId));
    for (const ctx of [f.U.M0, f.U.M1, f.U.H0]) {
      for (const r of reviews) expect(await effective(ctx, r.id), `review ${r.id}`).toBe(await manager(ctx, r.id));
    }
    expect(await owner.db.select().from(schema.assessmentUnitExclusion).where(and(eq(schema.assessmentUnitExclusion.cycleId, f.cycleId)))).toEqual([]);
  });
});
