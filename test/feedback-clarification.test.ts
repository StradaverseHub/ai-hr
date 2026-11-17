import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import type {SessionContext} from '../db/client';
import {askFeedbackClarification, answerFeedbackClarification, closeFeedbackClarification} from '../core/feedback-clarification';
import {approveFeedbackPlan, contestFeedbackPlan, getFeedback, listPlannableFeedback, setFeedbackPlan, submitFeedback} from '../core/feedback';
import {askClarificationSql, blockTrailSql, closeClarificationSql, feedbackSelectSql, pushPlanSql, waitingForClarification} from '../scripts/improve/remote';
import {adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base} from './harness';

let b: Base, admin: SessionContext, reporter: SessionContext, other: SessionContext;
beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); admin = {...adminCtx(b), grants: [{role: 'hr_admin', companyId: null}]};
  async function login(label: string): Promise<SessionContext> {
    const [u] = await owner.db.insert(s.appUser).values({tenantId: b.tenantId, workosUserId: `${label}-${randomUUID()}`, personId: null}).returning();
    await owner.db.insert(s.roleAssignment).values({tenantId: b.tenantId, appUserId: u.id, role: 'employee', companyId: null});
    return {...adminCtx(b), userId: u.id, roles: ['employee'], personId: null, grants: [{role: 'employee', companyId: null}]};
  }
  reporter = await login('reporter'); other = await login('other');
});
const QUESTION = 'Is overtime missing from approval or the payroll preview? Which month?';
const ANSWER = 'The November preview; approval already includes it.';
const report = () => submitFeedback(reporter, {category: 'issue', title: 'Fictional overtime preview', description: 'The preview omits an approved entry.'});
const ask = (feedbackId: string, questionId = randomUUID(), question = QUESTION, expectedPlanRevision = 0) =>
  askFeedbackClarification(admin, {feedbackId, questionId, question, expectedPlanRevision});
const events = (id: string) => owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId, id));
async function script(text: string) {
  const c = await owner.client.reserve();
  try { return await c.unsafe(text).simple(); }
  catch (e) { await c.unsafe('ROLLBACK').simple(); throw e; }
  finally { c.release(); }
}

describe('asynchronous clarification before a plan', () => {
  it('clear reports need no dialogue, and asking does not approve or change their workflow stage', async () => {
    const {id} = await report(); expect(await listPlannableFeedback(admin)).toContain(id);
    const q = await ask(id);
    expect((await getFeedback(reporter, id))?.status).toBe('open');
    expect((await getFeedback(reporter, id))?.blockHistory[0]).toMatchObject({id: q.id, question: QUESTION, answer: null, resolvedAt: null});
    expect(await listPlannableFeedback(admin)).not.toContain(id);
    await expect(setFeedbackPlan(admin, {feedbackId: id, plan: 'Guess what the reporter means.'})).rejects.toThrow(/waiting for an answer/);
    await expect(script(pushPlanSql({id, tenantId: b.tenantId, reporterEmploymentId: null, plan: 'Guess.', model: 'fixture'}))).rejects.toThrow();
    expect((await getFeedback(reporter, id))?.planRevision).toBe(0);
  });
  it('an answer survives restarts and returns to investigation, with a plan still requiring separate approval', async () => {
    const {id} = await report(), q = await ask(id);
    await answerFeedbackClarification(reporter, {feedbackId: id, questionId: q.id, answer: ANSWER});
    const fresh = await getFeedback(reporter, id);
    expect(fresh?.status).toBe('open'); expect(fresh?.plan).toBeNull();
    expect(fresh?.blockHistory[0]).toMatchObject({question: QUESTION, answer: ANSWER, answeredByUserId: reporter.userId});
    expect(await listPlannableFeedback(admin)).toContain(id);
    const rows = await owner.client.unsafe(blockTrailSql([id]));
    const trail = (rows[0].coalesce as unknown as {question: string; answer: string; resolved_at: string}[]);
    expect(trail[0]).toMatchObject({question: QUESTION, answer: ANSWER});
    expect(waitingForClarification({block_trail: trail as never})).toBe(false);
    await setFeedbackPlan(admin, {feedbackId: id, plan: 'Fix the November preview and show independent expected results.'});
    expect((await getFeedback(reporter, id))?.status).toBe('planned');
    await approveFeedbackPlan(reporter, {feedbackId: id});
    expect((await getFeedback(reporter, id))?.status).toBe('approved');
  });
  it('replayed sends and identical answer retries produce one question and one answer event', async () => {
    const {id} = await report(), questionId = randomUUID();
    await Promise.all([ask(id, questionId), ask(id, questionId)]);
    await answerFeedbackClarification(reporter, {feedbackId: id, questionId, answer: ANSWER});
    await answerFeedbackClarification(reporter, {feedbackId: id, questionId, answer: ANSWER});
    expect((await getFeedback(reporter, id))?.blockHistory).toHaveLength(1);
    const types = (await events(id)).map(e => e.eventType);
    expect(types.filter(t => t === 'feedback.clarification.requested')).toHaveLength(1);
    expect(types.filter(t => t === 'feedback.clarification.answered')).toHaveLength(1);
    await expect(ask(id, randomUUID())).rejects.toThrow(/earlier answer/);
  });
  it('a stale tab cannot overwrite an earlier answer or answer the next question', async () => {
    const {id} = await report(), first = await ask(id);
    await answerFeedbackClarification(reporter, {feedbackId: id, questionId: first.id, answer: ANSWER});
    const next = await ask(id, randomUUID(), 'Which preview screen did you open?');
    await expect(answerFeedbackClarification(reporter, {feedbackId: id, questionId: first.id, answer: 'A changed old answer.'})).rejects.toThrow(/already been resolved/);
    const d = await getFeedback(reporter, id);
    expect(d?.blockHistory.find(q => q.id === first.id)?.answer).toBe(ANSWER);
    expect(d?.blockHistory.find(q => q.id === next.id)?.answer).toBeNull();
    expect(await listPlannableFeedback(admin)).not.toContain(id);
  });
  it('unrelated users and other tenants cannot ask, answer or read the private exchange', async () => {
    const {id} = await report(), q = await ask(id);
    await expect(askFeedbackClarification(reporter, {feedbackId: id, questionId: randomUUID(), question: QUESTION, expectedPlanRevision: 0})).rejects.toThrow(/administrator/);
    await expect(answerFeedbackClarification(other, {feedbackId: id, questionId: q.id, answer: 'Not mine.'})).rejects.toThrow();
    const foreign = await seedBase();
    await expect(answerFeedbackClarification(adminCtx(foreign), {feedbackId: id, questionId: q.id, answer: 'Foreign.'})).rejects.toThrow();
    expect(await getFeedback(other, id)).toBeNull(); expect(await getFeedback(adminCtx(foreign), id)).toBeNull();
    expect((await getFeedback(reporter, id))?.blockHistory[0].answer).toBeNull();
  });
  it('a revision change rejects a stale question, and a reply on a contested plan does not reapprove it', async () => {
    const {id} = await report();
    await setFeedbackPlan(admin, {feedbackId: id, plan: 'Wrong screen.'});
    await contestFeedbackPlan(reporter, {feedbackId: id, reason: 'It is the payroll preview.'});
    await expect(ask(id)).rejects.toThrow(/plan changed/i);
    const q = await ask(id, randomUUID(), QUESTION, 1);
    await answerFeedbackClarification(reporter, {feedbackId: id, questionId: q.id, answer: ANSWER});
    expect((await getFeedback(reporter, id))?.status).toBe('contested');
    expect((await getFeedback(reporter, id))?.contestReason).toBe('It is the payroll preview.');
    await expect(approveFeedbackPlan(reporter, {feedbackId: id})).rejects.toThrow();
  });
  it('operator SQL opens and explicitly closes a question without inventing an answer', async () => {
    const {id} = await report(), questionId = randomUUID();
    const p = {id, tenantId: b.tenantId, reporterEmploymentId: null, questionId, question: "Which screen? '$fb$'", expectedPlanRevision: 0};
    await script(askClarificationSql(p)); await script(askClarificationSql(p));
    let d = await getFeedback(reporter, id);
    expect(d?.blockHistory).toHaveLength(1); expect(d?.blockHistory[0].question).toBe(p.question);
    const before = await owner.client.unsafe(blockTrailSql([id]));
    expect(waitingForClarification({block_trail: before[0].coalesce as never})).toBe(true);
    await script(closeClarificationSql({...p, reason: 'Reproduced from the attached screenshot.'}));
    d = await getFeedback(reporter, id);
    expect(d?.blockHistory[0].answer).toBeNull(); expect(d?.blockHistory[0].resolvedAt).not.toBeNull();
    expect(await listPlannableFeedback(admin)).toContain(id);
    const pulled = await owner.client.unsafe(feedbackSelectSql("'open','contested'"));
    expect((pulled[0].coalesce as {id: string}[]).map(r => r.id)).toContain(id);
  });
  it('different concurrent questions cannot both become active, and administrators can retire a stale request', async () => {
    const {id} = await report();
    const results = await Promise.allSettled([ask(id), ask(id, randomUUID(), 'Which payslip view?')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const q = (await getFeedback(reporter, id))!.blockHistory[0];
    await closeFeedbackClarification(admin, {feedbackId: id, questionId: q.id, reason: 'The attached screenshot settles this.'});
    expect(await listPlannableFeedback(admin)).toContain(id);
    await expect(answerFeedbackClarification(reporter, {feedbackId: id, questionId: q.id, answer: ANSWER})).rejects.toThrow(/already been resolved/);
  });
});
