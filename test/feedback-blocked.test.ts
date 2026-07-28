/**
 * `blocked` — approved work that is waiting on an answer (migration 0317).
 *
 * WHY THE STATUS EXISTS. `approved` means "the reporter agreed to the plan", and the improvement loop
 * reads that as "ready to build". But an item is sometimes approved and then found to depend on a
 * question only the reporter can settle. Those items sat in `approved` looking identical to work merely
 * waiting its turn: the reporter could not tell the two apart, and each build round had to re-derive
 * from memory which approved items were actually parked — a fact that lived nowhere in the system.
 *
 * The load-bearing property is the LAST test in this file: parking an item removes it from the build
 * queue. Everything else here is the surface that makes the park legible; that one is the guard. If
 * startFeedbackBuild ever accepted `blocked`, an agent would build an item whose open question it never
 * saw, guessing at exactly the decision the park exists to force — so it is asserted directly rather
 * than inferred from the status string.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  approveFeedbackPlan,
  blockFeedback,
  FeedbackError,
  getFeedback,
  setFeedbackPlan,
  startFeedbackBuild,
  submitFeedback,
  unblockFeedback,
} from '../core/feedback';
import { adminCtx, closeAll, createAppUser, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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

/** Walk an item to `approved` — the only status a block can be applied from. */
async function approvedItem(title: string): Promise<{ id: string; rctx: SessionContext }> {
  const R = await hire(`Reporter ${randomUUID().slice(0, 4)}`);
  const rctx = await reporterCtx(R.personId);
  const { id } = await submitFeedback(rctx, {
    reporterEmploymentId: R.employmentId,
    category: 'issue',
    title,
    description: 'Something to fix.',
  });
  await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Do the thing.' });
  await approveFeedbackPlan(rctx, { feedbackId: id });
  return { id, rctx };
}

describe('feedback `blocked` — approved work waiting on an answer (0317)', () => {
  it('parks an approved item with its reason, and names what it is waiting on', async () => {
    const { id } = await approvedItem('Fix the leave balance');
    const { id: decisionId } = await approvedItem('DECISION NEEDED: which rounding rule?');

    await blockFeedback(adminCtx(base), {
      feedbackId: id,
      reason: 'Waiting on the rounding decision before the balance can be changed.',
      blockedById: decisionId,
    });

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.status).toBe('blocked');
    expect(d.blockedReason).toContain('rounding decision');
    // The TITLE is resolved, not just the id: an 8-char code tells the reporter nothing about which of
    // their own requests the open question belongs to. This is the whole point of blockedById.
    expect(d.blockedBy).toMatchObject({ id: decisionId, title: 'DECISION NEEDED: which rounding rule?' });

    expect(await eventTypesFor(base.tenantId, id)).toContain('feedback.blocked');
  });

  it('unblocking returns it to the queue and clears the wait — the history stays in the events', async () => {
    const { id } = await approvedItem('Fix the leave balance');
    const { id: decisionId } = await approvedItem('DECISION NEEDED: which rounding rule?');
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: 'Waiting.', blockedById: decisionId });

    await unblockFeedback(adminCtx(base), { feedbackId: id, note: 'Reporter chose calendar-year.' });

    const d = (await getFeedback(adminCtx(base), id))!;
    expect(d.status).toBe('approved');
    // Cleared, not kept: a stale reason would keep rendering "waiting on …" on a queued item.
    expect(d.blockedReason).toBeNull();
    expect(d.blockedBy).toBeNull();
    // …but the fact that it WAS blocked, and on what, survives where audit belongs.
    expect(await eventTypesFor(base.tenantId, id)).toEqual(
      expect.arrayContaining(['feedback.blocked', 'feedback.unblocked']),
    );
  });

  it('refuses to block anything that is not approved — a plan under review is contested, not parked', async () => {
    const R = await hire('Early Reporter');
    const rctx = await reporterCtx(R.personId);
    const { id } = await submitFeedback(rctx, {
      reporterEmploymentId: R.employmentId,
      category: 'issue',
      title: 'Still open',
      description: 'No plan yet.',
    });
    await expect(blockFeedback(adminCtx(base), { feedbackId: id, reason: 'x' })).rejects.toThrow(FeedbackError);

    await setFeedbackPlan(adminCtx(base), { feedbackId: id, plan: 'Do it.' });
    await expect(blockFeedback(adminCtx(base), { feedbackId: id, reason: 'x' })).rejects.toThrow(FeedbackError);
  });

  it('requires a reason, and refuses a self-block that nothing could ever resolve', async () => {
    const { id } = await approvedItem('Fix the thing');
    await expect(blockFeedback(adminCtx(base), { feedbackId: id, reason: '   ' })).rejects.toThrow(FeedbackError);
    // Resolving a self-blocked item is what would unblock it, so it could never leave the park.
    await expect(blockFeedback(adminCtx(base), { feedbackId: id, reason: 'x', blockedById: id })).rejects.toThrow(
      /cannot be blocked by itself/i,
    );
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('approved');
  });

  it('THE GUARD: a blocked item cannot start building — the open question cannot be worked around', async () => {
    const { id } = await approvedItem('Fix the leave balance');
    await blockFeedback(adminCtx(base), { feedbackId: id, reason: 'Waiting on the rounding decision.' });

    await expect(startFeedbackBuild(adminCtx(base), { feedbackId: id })).rejects.toThrow(FeedbackError);
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('blocked');

    // …and it becomes buildable again the moment the question is answered — the park is a pause, not a
    // rejection, so unblock must genuinely restore the build path rather than just relabel the row.
    await unblockFeedback(adminCtx(base), { feedbackId: id });
    await startFeedbackBuild(adminCtx(base), { feedbackId: id, buildRef: 'build/rX' });
    expect((await getFeedback(adminCtx(base), id))!.status).toBe('building');
  });
});
