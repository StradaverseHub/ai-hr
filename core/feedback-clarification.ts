/** Pre-plan dialogue on the existing append-and-close-once question owner. No model calls. */
import {and, eq, isNull, sql} from 'drizzle-orm';
import {withTenant, type SessionContext, type Tx} from '../db/client';
import {actorOf, appendEvent} from '../db/events';
import {feedbackBlock, feedbackRequest} from '../db/schema';
import {dialogueText, FEEDBACK_ANSWER_LIMIT, FEEDBACK_QUESTION_LIMIT, FEEDBACK_PREPLAN_STATES} from '../lib/feedback-dialogue';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ids(...values: string[]) {
  if (!values.every(v => typeof v === 'string' && uuid.test(v))) throw new Error('A valid report and question are required.');
}
function admin(ctx: SessionContext) {
  if (!ctx.userId || !ctx.roles?.some(r => r === 'hr_admin' || r === 'super_admin'))
    throw new Error('An administrator must review questions before sending them.');
}
async function lockedFeedback(tx: Tx, id: string) {
  const [fb] = await tx.select().from(feedbackRequest).where(eq(feedbackRequest.id, id)).limit(1).for('update');
  if (!fb) throw new Error('Report not found or not available to you.');
  return fb;
}
function preplan(status: string) {
  if (!(FEEDBACK_PREPLAN_STATES as readonly string[]).includes(status))
    throw new Error('Questions before planning are available only while a report is open or awaiting a revised plan.');
}

/** Caller already owns the feedback row lock when changing its plan or question state. */
export async function assertNoPendingFeedbackQuestion(tx: Tx, feedbackId: string): Promise<void> {
  const [pending] = await tx.select({id: feedbackBlock.id}).from(feedbackBlock)
    .where(and(eq(feedbackBlock.feedbackRequestId, feedbackId), isNull(feedbackBlock.resolvedAt))).limit(1);
  if (pending) throw new Error('This report is waiting for an answer. Read the reply before preparing a plan.');
}

export async function askFeedbackClarification(ctx: SessionContext, p: {
  feedbackId: string; questionId: string; expectedPlanRevision: number; question: string;
}): Promise<{id: string; waiting: boolean}> {
  admin(ctx); ids(p.feedbackId, p.questionId);
  const question = dialogueText(p.question, FEEDBACK_QUESTION_LIMIT);
  if (!Number.isSafeInteger(p.expectedPlanRevision) || p.expectedPlanRevision < 0) throw new Error('Refresh the report before asking a question.');
  return withTenant(ctx, async tx => {
    const fb = await lockedFeedback(tx, p.feedbackId);
    const [prior] = await tx.select().from(feedbackBlock).where(eq(feedbackBlock.id, p.questionId)).limit(1);
    if (prior) {
      if (prior.feedbackRequestId !== fb.id || prior.question !== question) throw new Error('This question reference was already used. Refresh the report.');
      return {id: prior.id, waiting: prior.resolvedAt === null};
    }
    preplan(fb.status);
    if (fb.planRevision !== p.expectedPlanRevision) throw new Error('The plan changed. Read the current report before asking a question.');
    await assertNoPendingFeedbackQuestion(tx, fb.id);
    const [answered] = await tx.select({id: feedbackBlock.id}).from(feedbackBlock)
      .where(and(eq(feedbackBlock.feedbackRequestId, fb.id), eq(feedbackBlock.question, question))).limit(1);
    if (answered) throw new Error('This question is already in the history. Read the earlier answer or explain what has changed.');
    await tx.insert(feedbackBlock).values({id: p.questionId, tenantId: ctx.tenantId, feedbackRequestId: fb.id, question});
    await tx.update(feedbackRequest).set({updatedAt: sql`now()`}).where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'feedback', aggregateId: fb.id,
      eventType: 'feedback.clarification.requested', actor: actorOf(ctx), subjectEmploymentId: fb.reporterEmploymentId,
      payload: {questionId: p.questionId, planRevision: fb.planRevision}});
    return {id: p.questionId, waiting: true};
  });
}

/** The exact question ID fences stale tabs. Answering resumes investigation, never approves a plan. */
export async function answerFeedbackClarification(ctx: SessionContext, p: {
  feedbackId: string; questionId: string; answer: string;
}): Promise<void> {
  ids(p.feedbackId, p.questionId);
  const answer = dialogueText(p.answer, FEEDBACK_ANSWER_LIMIT);
  await withTenant(ctx, async tx => {
    const fb = await lockedFeedback(tx, p.feedbackId);
    const reviewer = !!ctx.userId && (ctx.userId === fb.reporterUserId || ctx.roles?.some(r => r === 'hr_admin' || r === 'super_admin'));
    if (!reviewer) throw new Error('Only the reporter or an administrator acting for them can answer.');
    const [question] = await tx.select().from(feedbackBlock)
      .where(and(eq(feedbackBlock.id, p.questionId), eq(feedbackBlock.feedbackRequestId, fb.id))).limit(1);
    if (!question) throw new Error('This question is no longer available. Refresh the report.');
    if (question.resolvedAt) {
      if (question.answer === answer && question.answeredByUserId === ctx.userId) return;
      throw new Error('This question has already been resolved. Your earlier answer is preserved.');
    }
    preplan(fb.status);
    const closed = await tx.update(feedbackBlock).set({answer, answeredByUserId: ctx.userId, resolvedAt: sql`now()`})
      .where(and(eq(feedbackBlock.id, question.id), isNull(feedbackBlock.resolvedAt))).returning({id: feedbackBlock.id});
    if (closed.length !== 1) throw new Error('The question changed. Refresh the report before answering.');
    await tx.update(feedbackRequest).set({updatedAt: sql`now()`}).where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'feedback', aggregateId: fb.id,
      eventType: 'feedback.clarification.answered', actor: actorOf(ctx), subjectEmploymentId: fb.reporterEmploymentId,
      payload: {questionId: question.id, planRevision: fb.planRevision, resumes: 'investigation'}});
  });
}

/** Explicitly retire an obsolete question; no fabricated answer or automatic scope approval. */
export async function closeFeedbackClarification(ctx: SessionContext, p: {
  feedbackId: string; questionId: string; reason: string;
}): Promise<void> {
  admin(ctx); ids(p.feedbackId, p.questionId);
  const reason = dialogueText(p.reason, FEEDBACK_QUESTION_LIMIT);
  await withTenant(ctx, async tx => {
    const fb = await lockedFeedback(tx, p.feedbackId); preplan(fb.status);
    const closed = await tx.update(feedbackBlock).set({resolvedAt: sql`now()`})
      .where(and(eq(feedbackBlock.id, p.questionId), eq(feedbackBlock.feedbackRequestId, fb.id), isNull(feedbackBlock.resolvedAt)))
      .returning({id: feedbackBlock.id});
    if (closed.length !== 1) throw new Error('The question was already resolved. Refresh the report.');
    await tx.update(feedbackRequest).set({updatedAt: sql`now()`}).where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {tenantId: ctx.tenantId, aggregateType: 'feedback', aggregateId: fb.id,
      eventType: 'feedback.clarification.closed', actor: actorOf(ctx), subjectEmploymentId: fb.reporterEmploymentId,
      payload: {questionId: p.questionId, reason, resumes: 'investigation'}});
  });
}
