/**
 * D-P1-22 X3 (ADR-0150): the one-time effects at save, written through the existing single writers, and preview =
 * save. Fixture: test/performance-unit-exclusion-fixture.ts, plus, before the rule (A, X) is previewed and saved:
 *   360 rows: R->S, Q->S, Q->C (Q submits it; C's anonymous report released), R->M0, Q->M0, Q->F (F is frozen).
 *   KPI lines on S (stored reviewer M0): L1 untouched [M0]; L2 [A acted, M0]; L3 [M0, M1]; L5 HR-filled [M0].
 *   On C: L4 [T] (T is in X with nobody above). On P (stored reviewer M0, Xc): L6 [M0], results submitted.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import * as perf from '../packs/performance/service';
import { closeAll, eventTypesFor, owner } from './harness';
import {
  bringBack, buildFixture, cycleRevision, exclude, kpiLine, kpisOf, refusal, reviewOf, revisionOf, setKpis, valueAs, type Fixture,
} from './performance-unit-exclusion-fixture';

let f: Fixture;
let rid: Record<string, string>;
let req: Record<string, string>;
let L: Record<string, string>;

async function assign(subject: string, raters: string[]) {
  await perf.assignOnehrPanel(f.a, rid[subject], await revisionOf(rid[subject]), raters.map((r) => ({ employmentId: f.P[r].employmentId, relationship: 'peer' as const })));
  const rows = await owner.db.select({ requestId: schema.onehrPanel.requestId, peer: schema.onehrPanel.peerEmploymentId }).from(schema.onehrPanel).where(eq(schema.onehrPanel.reviewId, rid[subject]));
  for (const r of raters) req[`${r}>${subject}`] = rows.find((row) => row.peer === f.P[r].employmentId)!.requestId;
}
async function submitAs(rater: string, subject: string) {
  const [review] = await owner.db.select({ statements: schema.onehrReview.statements }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, rid[subject]));
  const answers = Object.fromEntries((review.statements as { id: string }[]).map((s) => [s.id, 'no' as const]));
  await perf.submitOnehrFeedback(f.U[rater], req[`${rater}>${subject}`], answers, 'A dependable colleague.');
}
const panel = async (key: string) => (await owner.db.select().from(schema.onehrPanel).where(eq(schema.onehrPanel.requestId, req[key])))[0];
const leadership = async (review: string) => (await valueAs<{ leadership: unknown[] }>(f.a, sql`app.onehr_assessment_inputs(${review}::uuid)`)).leadership.length;
const preview = () => perf.previewUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X });

beforeEach(async () => {
  f = await buildFixture();
  rid = {}; req = {}; L = {};
  for (const name of ['M0', 'S', 'C', 'F', 'P']) rid[name] = await reviewOf(f.cycleId, f.P[name]);
  await assign('S', ['R', 'Q']);
  await assign('C', ['Q']);
  await assign('M0', ['R', 'Q']);
  await assign('F', ['Q']);
  await submitAs('Q', 'C');
  await withTenant(f.a, (tx) => tx.insert(schema.assessmentRelease).values({ tenantId: f.b.tenantId, reviewId: rid.C, feedbackReleasedAt: new Date(), updatedBy: f.a.userId!, updatedAt: new Date() }));
  await withTenant(f.a, (tx) => tx.insert(schema.onehrResult).values({ tenantId: f.b.tenantId, reviewId: rid.F, cycleId: f.cycleId, employmentId: f.P.F.employmentId, result: { version: 1 }, digest: 'fixture-frozen' }));
  const now = new Date().toISOString(), M0 = f.P.M0.employmentId, M1 = f.P.M1.employmentId;
  const s = [
    kpiLine({ title: 'Untouched', moderator: M0 }),
    kpiLine({ title: 'Acted on', moderator: f.P.A.employmentId, source: 'matrix', chain: [{ employmentId: f.P.A.employmentId, at: now }, { employmentId: M0, at: null }] }),
    kpiLine({ title: 'Two steps', moderator: M0, source: 'matrix', chain: [{ employmentId: M0, at: null }, { employmentId: M1, at: null }] }),
    kpiLine({ title: 'HR filled', moderator: M0, hrOwned: true }),
  ];
  [L.L1, L.L2, L.L3, L.L5] = s.map((k) => k.id);
  await setKpis(f.a, rid.S, s);
  const c = [kpiLine({ title: 'Nobody above', moderator: f.P.T.employmentId, source: 'matrix' })];
  L.L4 = c[0].id;
  await setKpis(f.a, rid.C, c);
  const p = [kpiLine({ title: 'Single line', moderator: M0, setting: 'approved', actual: 100, weightBp: 10000 })];
  L.L6 = p[0].id;
  await setKpis(f.a, rid.P, p, true);
});
afterAll(closeAll);

describe('360 rows (E4)', () => {
  it('archives every live row where someone in the scope is rated or rates, with the rule as the reason; counts equal the preview', async () => {
    const before = await preview();
    expect(before.counts).toMatchObject({ own: 2, places: 2, submitted: 1, frozenSkipped: 1 });
    expect(before.archive.map((a) => a.requestId).sort()).toEqual([req['R>M0'], req['Q>M0'], req['Q>S'], req['Q>C']].sort());
    const saved = await perf.saveUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: before.digest, revision: before.revision });
    expect(saved.archived).toBe(4);
    for (const key of ['R>M0', 'Q>M0', 'Q>S', 'Q>C']) {
      const row = await panel(key);
      expect(row.archivedAt, key).not.toBeNull();
      expect(row.archiveReason, key).toContain(saved.ruleId);
    }
    expect((await panel('R>S')).archivedAt, 'a row with nobody in the scope stays live').toBeNull();
    const audits = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, rid.S), eq(schema.domainEvent.eventType, 'onehr.panel-archive')));
    expect(audits.map((a) => (a.payload as { requestId: string }).requestId)).toEqual([req['Q>S']]);
  });

  it('a submitted rating is archived too and leaves the colleague\'s score', async () => {
    expect(await leadership(rid.C), 'non-vacuous: the submitted rating scores').toBe(1);
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(await leadership(rid.C)).toBe(0);
    expect((await panel('Q>C')).submittedAt, 'the submission is kept with the row').not.toBeNull();
  });

  it('a released anonymous report is revoked', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const [release] = await owner.db.select({ feedback: schema.assessmentRelease.feedbackReleasedAt }).from(schema.assessmentRelease).where(eq(schema.assessmentRelease.reviewId, rid.C));
    expect(release.feedback).toBeNull();
    const [revoked] = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, rid.C), eq(schema.domainEvent.eventType, 'onehr.result-revoked')));
    expect(revoked.payload).toMatchObject({ component: 'feedback', reason: 'panel_changed' });
  });

  it('frozen reviews are skipped and counted (D7)', async () => {
    const { preview: plan, saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(plan.frozenSkipped).toEqual([{ requestId: req['Q>F'], reviewId: rid.F }]);
    expect(saved.skippedFrozen).toBe(1);
    expect((await panel('Q>F')).archivedAt).toBeNull();
  });

  it('Bring back restores neither archived rows nor moved KPI lines', async () => {
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const snapshot = async () => JSON.stringify({ panels: await owner.db.select().from(schema.onehrPanel).orderBy(asc(schema.onehrPanel.requestId)), s: await kpisOf(rid.S) });
    const after = await snapshot();
    await bringBack(f.a, f.cycleId, saved.ruleId);
    expect(await snapshot()).toBe(after);
  });

  it('the panel builder never restores an archived pairing', async () => {
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await bringBack(f.a, f.cycleId, saved.ruleId);
    const built = await perf.buildAssessmentPanels(f.a, f.cycleId, 'missing');
    const m0 = built.rows.find((r) => r.reviewId === rid.M0)!;
    const offered = m0.add.map((m) => m.employmentId);
    // M0's direct reports rank S, Q, P (employee code order); the builder takes two. Q's archived pairing bars it.
    expect(offered, 'non-vacuous: the first direct report is offered').toContain(f.P.S.employmentId);
    expect(offered).not.toContain(f.P.Q.employmentId);
  });
});

describe('KPI lines one level up (E5)', () => {
  it('an untouched line moves; acted-on and HR-filled lines do not', async () => {
    const before = await kpisOf(rid.S);
    expect((await preview()).moves.map((m) => m.kpiId).sort(), 'the preview qualifies exactly the untouched lines').toEqual([L.L1, L.L3, L.L6].sort());
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const after = await kpisOf(rid.S);
    const line = (id: string) => after.find((k) => k.id === id)!;
    expect({ chain: line(L.L1).approvalChain!.map((s) => s.employmentId), moderator: line(L.L1).moderatorEmploymentId, source: line(L.L1).moderatorSource })
      .toEqual({ chain: [f.P.M1.employmentId], moderator: f.P.M1.employmentId, source: 'matrix' });
    expect(line(L.L2)).toEqual(before.find((k) => k.id === L.L2));
    expect(line(L.L5)).toEqual(before.find((k) => k.id === L.L5));
    const audits = await owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, rid.S), eq(schema.domainEvent.eventType, 'onehr.kpi-moderator-assigned')))
      .orderBy(asc(schema.domainEvent.sequence));
    expect(audits.map((a) => a.payload)).toContainEqual(expect.objectContaining({ kpiId: L.L1, previous: f.P.M0.employmentId, moderatorEmploymentId: f.P.M1.employmentId, reason: 'unit_exclusion', ruleId: saved.ruleId }));
  });

  it('a moved chain is de-duplicated', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect((await kpisOf(rid.S)).find((k) => k.id === L.L3)!.approvalChain!.map((s) => s.employmentId)).toEqual([f.P.M1.employmentId]);
  });

  it('a line whose approver has nobody above is not moved, and its subject is listed', async () => {
    const before = await kpisOf(rid.C);
    const { preview: plan } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(plan.nobodyAbove).toContainEqual({ reviewId: rid.C, employmentId: f.P.C.employmentId, reason: 'kpi' });
    expect(await kpisOf(rid.C)).toEqual(before);
  });

  it('sends no notification at save (D10)', async () => {
    const approvalNotices = async () => (await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, f.b.tenantId), eq(schema.domainEvent.eventType, 'onehr.kpi-approval-needed')))).length;
    const before = await approvalNotices();
    const { saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(saved.moved).toBeGreaterThan(0);
    expect(await approvalNotices()).toBe(before);
  });

  it('the moved moderator locks the last line: the classic lock stores the band while the stored reviewer is out (O1)', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect((await kpisOf(rid.P))[0].approvalChain!.map((s) => s.employmentId)).toEqual([f.P.M1.employmentId]);
    await perf.moderateOnehrKpi(f.U.M1, rid.P, await revisionOf(rid.P), L.L6, 100, '');
    const [row] = await owner.db.select({ band: schema.onehrReview.managerPerformance }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, rid.P));
    expect(row.band).not.toBeNull();
    expect(await refusal(perf.confirmOnehrPerformance(f.U.M1, rid.P, await revisionOf(rid.P), row.band as 'ME', '')), 'nobody gains a confirmation right').toMatch(/not assigned to you/);
  });

  it('the moved moderator moderates through the journey; their overall remark is optional', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await setKpis(f.a, rid.S, (await kpisOf(rid.S)).map((k) => (k.hrOwned ? k : { ...k, setting: 'approved' as const, actual: 100 })), true);
    await perf.submitAssessmentModeration(f.U.M1, rid.S, await revisionOf(rid.S), [{ id: L.L1, actual: 150, note: 'Exceeded.' }, { id: L.L3, actual: 100, note: '' }], '');
    const lines = await kpisOf(rid.S);
    expect([lines.find((k) => k.id === L.L1)!.locked, lines.find((k) => k.id === L.L3)!.locked]).toEqual([true, true]);
    expect(lines.find((k) => k.id === L.L2)!.locked, 'the acted-on line still waits for the stored reviewer (E6)').toBe(false);
  });

  it('the moved moderator\'s overall remark is labelled approver, and the journey lock stores the band', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    await perf.submitAssessmentModeration(f.U.M1, rid.P, await revisionOf(rid.P), [{ id: L.L6, actual: 100, note: '' }], 'Checked against the delivery log.');
    const remarks = await owner.db.select({ role: schema.assessmentReviewerRemark.actorRole, actor: schema.assessmentReviewerRemark.actorUserId }).from(schema.assessmentReviewerRemark).where(eq(schema.assessmentReviewerRemark.reviewId, rid.P));
    expect(remarks).toEqual([{ role: 'approver', actor: f.U.M1.userId }]);
    const [row] = await owner.db.select({ band: schema.onehrReview.managerPerformance }).from(schema.onehrReview).where(eq(schema.onehrReview.reviewId, rid.P));
    expect(row.band).not.toBeNull();
  });
});

describe('preview = save', () => {
  it('a repeated save is idempotent: nothing new is archived or moved and no second event is written', async () => {
    await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const snapshot = async () => JSON.stringify({ panels: await owner.db.select().from(schema.onehrPanel).orderBy(asc(schema.onehrPanel.requestId)), s: await kpisOf(rid.S), p: await kpisOf(rid.P) });
    const first = await snapshot();
    const again = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    expect(again.preview.counts).toMatchObject({ own: 0, places: 0, moves: 0, people: 0 });
    expect(again.saved).toMatchObject({ alreadyActive: true, archived: 0, moved: 0 });
    expect(await snapshot()).toBe(first);
    expect((await eventTypesFor(f.b.tenantId, f.cycleId)).filter((e) => e === 'review-cycle.unit-exclusion-set')).toHaveLength(1);
  });

  it('the same data gives the same digest; a stale digest or cycle revision is refused', async () => {
    const one = await preview(), two = await preview();
    expect(two.digest).toBe(one.digest);
    await submitAs('Q', 'S');
    const stale = await refusal(perf.saveUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: one.digest, revision: one.revision }));
    expect(stale).toMatch(/previewed against different data/);
    const fresh = await preview();
    expect(fresh.digest).not.toBe(one.digest);
    await perf.updateOnehrWindows(f.a, f.cycleId, fresh.revision, {}, 'Bump the cycle revision');
    expect(await refusal(perf.saveUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: fresh.digest, revision: fresh.revision }))).toMatch(/cycle changed since the preview/);
    expect(await owner.db.select().from(schema.assessmentUnitExclusion)).toEqual([]);
  });

  it('writes one set event with the counts and the digest, and one ended event on Bring back', async () => {
    const { preview: plan, saved } = await exclude(f.a, f.cycleId, f.b.companyId, f.dept.X);
    const events = async (type: string) => owner.db.select({ payload: schema.domainEvent.payload }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, f.cycleId), eq(schema.domainEvent.eventType, type))).orderBy(desc(schema.domainEvent.sequence));
    const [set] = await events('review-cycle.unit-exclusion-set');
    expect(set.payload).toMatchObject({ ruleId: saved.ruleId, companyId: f.b.companyId, departmentId: f.dept.X, digest: plan.digest, counts: { own: 2, places: 2, moves: plan.counts.moves } });
    await bringBack(f.a, f.cycleId, saved.ruleId);
    const ended = await events('review-cycle.unit-exclusion-ended');
    expect(ended.map((e) => e.payload)).toEqual([expect.objectContaining({ ruleId: saved.ruleId, why: 'brought_back' })]);
  });

  it('only a tenant-wide HR administrator, in an open or calibration cycle, may save (D4, D11)', async () => {
    const plan = await preview();
    const unitAdmin = await f.scoped(null, 'hr_admin', f.b.companyId);
    expect(await refusal(perf.saveUnitExclusion(unitAdmin, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: plan.digest, revision: plan.revision }))).toMatch(/group-wide HR administrator/);
    expect(await refusal(perf.saveUnitExclusion(f.U.M1, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: plan.digest, revision: plan.revision }))).toMatch(/group-wide HR administrator/);
    await perf.closeCycle(f.a, { cycleId: f.cycleId });
    expect(await refusal(perf.saveUnitExclusion(f.a, f.cycleId, { companyId: f.b.companyId, departmentId: f.dept.X, digest: plan.digest, revision: await cycleRevision(f.cycleId) }))).toMatch(/only while the cycle is open or in calibration/);
  });

  it('the preview lists the people one level up, the frozen people and nothing written', async () => {
    const plan = await preview();
    expect(plan.oneLevelUp).toContainEqual({ reviewId: rid.S, employmentId: f.P.S.employmentId, from: f.P.M0.employmentId, to: f.P.M1.employmentId });
    expect(plan.people.map((p) => p.employmentId)).toEqual(expect.arrayContaining([f.P.M0.employmentId, f.P.Q.employmentId, f.P.T.employmentId]));
    expect(plan.people.map((p) => p.employmentId)).not.toContain(f.P.P.employmentId);
    expect(await owner.db.select().from(schema.assessmentUnitExclusion)).toEqual([]);
    expect((await panel('Q>S')).archivedAt).toBeNull();
  });
});
