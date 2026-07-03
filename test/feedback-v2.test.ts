/**
 * Feedback module v2 (ADR-0051) — close the loop. A DEPLOYED result the reporter judges below standard can
 * be refuted (→ contested, re-planned, reopened_count++). Plus bulk review and the status-dashboard read.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminCtx, createAppUser, eventTypesFor, latestEventPayload, migrateTestDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  approveFeedbackPlan,
  bulkReview,
  cancelFeedback,
  contestFeedbackPlan,
  feedbackStatusCounts,
  FeedbackError,
  getFeedback,
  markFeedbackDeployed,
  refuteDeployment,
  restoreFeedback,
  setFeedbackPlan,
  submitFeedback,
} from '../core/feedback';

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
  base = await seedBase();
});

const hire = (name: string) =>
  hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const reporterCtx = async (personId: string): Promise<SessionContext> => {
  const uid = await createAppUser(base.tenantId, personId, 'employee');
  return { tenantId: base.tenantId, userId: uid, personId, roles: ['employee'] };
};

/** Drive a fresh item all the way to `deployed`; returns its id. */
async function deployItem(rctx: SessionContext, employmentId: string, title: string): Promise<string> {
  const { id } = await submitFeedback(rctx, { reporterEmploymentId: employmentId, category: 'issue', title, description: 'x' });
  await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'do the thing', model: 'm' });
  await approveFeedbackPlan(rctx, { feedbackId: id });
  await markFeedbackDeployed(adminCtx(base), { feedbackId: id });
  return id;
}

describe('Feedback v2 — close the loop / bulk / dashboard (ADR-0051)', () => {
  it('a deployed result can be refuted → contested + reopened_count++ + a feedback.deployment.refuted event', async () => {
    const R = await hire('V2 Reporter');
    const rctx = await reporterCtx(R.personId);
    const id = await deployItem(rctx, R.employmentId, 'Charts look wrong');
    expect((await getFeedback(rctx, id))!.status).toBe('deployed');

    // A stranger (non-reporter, non-admin) cannot refute.
    const stranger = await hire('V2 Stranger');
    const sctx = await reporterCtx(stranger.personId);
    await expect(refuteDeployment(sctx, { feedbackId: id, reason: 'nope' })).rejects.toBeInstanceOf(FeedbackError);

    // The reporter refutes: deployed → contested, reopened_count = 1, reason carried, distinct event logged.
    await refuteDeployment(rctx, { feedbackId: id, reason: 'The pie chart legend is cut off.' });
    const fb = (await getFeedback(rctx, id))!;
    expect(fb.status).toBe('contested');
    expect(fb.reopenedCount).toBe(1);
    expect(fb.contestReason).toContain('legend');
    expect(await eventTypesFor(base.tenantId, id)).toContain('feedback.deployment.refuted');
    expect((await latestEventPayload(base.tenantId, id, 'feedback.deployment.refuted'))?.decidedBy).toBe('reporter');

    // Re-plan → re-approve → re-deploy → refute again: the counter climbs to 2.
    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'fix the legend', model: 'm' });
    await approveFeedbackPlan(rctx, { feedbackId: id });
    await markFeedbackDeployed(adminCtx(base), { feedbackId: id });
    await refuteDeployment(rctx, { feedbackId: id, reason: 'still cut off on mobile' });
    expect((await getFeedback(rctx, id))!.reopenedCount).toBe(2);
  });

  it('refute is only valid from deployed (an open item rejects)', async () => {
    const R = await hire('V2 R2');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: 'x', description: 'y' });
    await expect(refuteDeployment(rctx, { feedbackId: id, reason: 'r' })).rejects.toBeInstanceOf(FeedbackError);
  });

  it('bulkReview approves many planned items at once; ineligible ones are skipped, not fatal', async () => {
    const R = await hire('V2 Bulk');
    const rctx = await reporterCtx(R.personId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'enhancement', title: `bulk ${i}`, description: 'd' });
      await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'p', model: 'm' });
      ids.push(id);
    }
    // a 4th item left open (no plan) — not approvable, so it should come back in `failed`.
    const { id: openId } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'enhancement', title: 'still open', description: 'd' });

    const res = await bulkReview(rctx, { ids: [...ids, openId], action: 'approve' });
    expect(res.succeeded.sort()).toEqual([...ids].sort());
    expect(res.failed.map((f) => f.id)).toEqual([openId]);
    for (const id of ids) expect((await getFeedback(rctx, id))!.status).toBe('approved');
  });

  it('feedbackStatusCounts returns positive counts keyed by status', async () => {
    const counts = await feedbackStatusCounts(adminCtx(base));
    expect(counts.reduce((a, c) => a + c.count, 0)).toBeGreaterThan(0);
    for (const c of counts) {
      expect(c.count).toBeGreaterThan(0);
      expect(typeof c.status).toBe('string');
    }
  });

  it('restoreFeedback puts a withdrawn item back exactly where it was (open, and again from contested)', async () => {
    const R = await hire('V2 Restore');
    const rctx = await reporterCtx(R.personId);

    // Withdrawn straight from `open` → restores to `open`.
    const { id: openId } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: 'a', description: 'd' });
    await cancelFeedback(rctx, { feedbackId: openId });
    expect((await getFeedback(rctx, openId))!.status).toBe('cancelled');
    await restoreFeedback(rctx, { feedbackId: openId });
    const restoredOpen = (await getFeedback(rctx, openId))!;
    expect(restoredOpen.status).toBe('open');
    expect(restoredOpen.statusBeforeCancel).toBeNull();
    expect(await eventTypesFor(base.tenantId, openId)).toContain('feedback.restored');
    expect((await latestEventPayload(base.tenantId, openId, 'feedback.restored'))?.restoredStatus).toBe('open');

    // Withdrawn from `contested` (after a plan + a push-back) → restores to `contested`, not `open`.
    const { id: cId } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: 'b', description: 'd' });
    await setFeedbackPlan(adminCtx(base), { feedbackId: cId, plan: 'p1', model: 'm' });
    await contestFeedbackPlan(rctx, { feedbackId: cId, reason: 'missing a bit' });
    await cancelFeedback(rctx, { feedbackId: cId });
    await restoreFeedback(rctx, { feedbackId: cId });
    const restoredContested = (await getFeedback(rctx, cId))!;
    expect(restoredContested.status).toBe('contested');
    expect(restoredContested.contestReason).toContain('missing a bit');
  });

  it('restoreFeedback rejects a non-cancelled item and a non-reporter', async () => {
    const R = await hire('V2 RestoreGuard');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: 'c', description: 'd' });
    // Never withdrawn — nothing to restore.
    await expect(restoreFeedback(rctx, { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);

    await cancelFeedback(rctx, { feedbackId: id });
    const stranger = await hire('V2 RestoreStranger');
    const sctx = await reporterCtx(stranger.personId);
    await expect(restoreFeedback(sctx, { feedbackId: id })).rejects.toBeInstanceOf(FeedbackError);
    // Still cancelled — the rejected attempt didn't mutate it.
    expect((await getFeedback(rctx, id))!.status).toBe('cancelled');
  });

  it('bulkReview restore action un-withdraws many at once, skipping non-cancelled items', async () => {
    const R = await hire('V2 BulkRestore');
    const rctx = await reporterCtx(R.personId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: `wd ${i}`, description: 'd' });
      await cancelFeedback(rctx, { feedbackId: id });
      ids.push(id);
    }
    const { id: stillOpenId } = await submitFeedback(rctx, { reporterEmploymentId: R.employmentId, category: 'issue', title: 'still open', description: 'd' });

    const res = await bulkReview(rctx, { ids: [...ids, stillOpenId], action: 'restore' });
    expect(res.succeeded.sort()).toEqual([...ids].sort());
    expect(res.failed.map((f) => f.id)).toEqual([stillOpenId]);
    for (const id of ids) expect((await getFeedback(rctx, id))!.status).toBe('open');
  });
});
