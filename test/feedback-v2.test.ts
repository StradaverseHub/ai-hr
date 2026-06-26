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
  feedbackStatusCounts,
  FeedbackError,
  getFeedback,
  markFeedbackDeployed,
  refuteDeployment,
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
});
