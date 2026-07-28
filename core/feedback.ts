/**
 * In-product feedback → AI-plan → review → build loop (ADR-0043). A user logs feedback; an AI planning
 * agent writes a `plan` (FB-3, via lib/ai); the REPORTER reviews it — approve, or contest (push back) so
 * the agent re-plans; on approval an out-of-app build agent produces a human-reviewed PR (FB-4). Every
 * transition appends a DomainEvent (user / agent actor). RLS scopes reads via can_see_employment; the
 * review authority (only the reporter approves/contests) is enforced here.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { generateDraft, redactPII } from '../lib/ai';
import { resolveActiveAiConfig } from './ai-config';
import {
  employment,
  feedbackAttachment,
  feedbackPlanRevision,
  feedbackRequest,
  person,
  type FeedbackCategory,
  type FeedbackStatus,
} from '../db/schema';
import { settingEnabled } from './entitlements';

export class FeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackError';
  }
}

const CATEGORIES: FeedbackCategory[] = ['issue', 'enhancement', 'new_function'];

/** The reporter logs feedback (status `open`, awaiting a plan). reporterEmploymentId is the caller's own
 *  employment (the action resolves it); reporterUserId is the review gate. */
export async function submitFeedback(
  ctx: SessionContext,
  p: {
    reporterEmploymentId: string;
    category: FeedbackCategory;
    title: string;
    description: string;
    expectedBehavior?: string | null;
    expectedFunction?: string | null;
  },
): Promise<{ id: string }> {
  if (!CATEGORIES.includes(p.category)) throw new FeedbackError('Unknown feedback category.');
  const title = p.title?.trim();
  const description = p.description?.trim();
  if (!title) throw new FeedbackError('A title is required.');
  if (!description) throw new FeedbackError('A description is required.');
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(feedbackRequest)
      .values({
        tenantId: ctx.tenantId,
        reporterEmploymentId: p.reporterEmploymentId,
        reporterUserId: ctx.userId ?? null,
        category: p.category,
        title,
        description,
        expectedBehavior: p.expectedBehavior?.trim() || null,
        expectedFunction: p.expectedFunction?.trim() || null,
      })
      .returning({ id: feedbackRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: row.id,
      eventType: 'feedback.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.reporterEmploymentId,
      payload: { category: p.category, title },
    });
    return { id: row.id };
  });
}

// ── Attachments (supporting documents + images) — mirrors claim_attachment ──

export async function addFeedbackAttachment(
  ctx: SessionContext,
  p: { feedbackId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new FeedbackError('Empty file');
  if (p.content.byteLength > 10 * 1024 * 1024) throw new FeedbackError('File exceeds 10 MB');
  return withTenant(ctx, async (tx) => {
    const [fb] = await tx
      .select({ id: feedbackRequest.id, employmentId: feedbackRequest.reporterEmploymentId })
      .from(feedbackRequest)
      .where(eq(feedbackRequest.id, p.feedbackId))
      .limit(1);
    if (!fb) throw new FeedbackError('Feedback not found (or not visible).');
    const [row] = await tx
      .insert(feedbackAttachment)
      .values({
        tenantId: ctx.tenantId,
        feedbackRequestId: fb.id,
        employmentId: fb.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: feedbackAttachment.id });
    return { id: row.id };
  });
}

export function getFeedbackAttachment(
  ctx: SessionContext,
  id: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ content: feedbackAttachment.content, fileName: feedbackAttachment.fileName, mimeType: feedbackAttachment.mimeType })
      .from(feedbackAttachment)
      .where(eq(feedbackAttachment.id, id))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

// ── Plan (agent) — FB-1 sets the plan directly; FB-3 wraps this with the AI gateway ──

/** Store an implementation plan on an `open`/`contested` item and move it to `planned` for review. Used
 *  by the planning agent (agent actor). plan_revision bumps so re-plans are tracked; clears the contest. */
export async function setFeedbackPlan(
  ctx: SessionContext,
  p: { feedbackId: string; plan: string; model?: string | null },
): Promise<void> {
  const plan = p.plan?.trim();
  if (!plan) throw new FeedbackError('A plan is required.');
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (fb.status !== 'open' && fb.status !== 'contested') {
      throw new FeedbackError(`A plan can only be drafted while the item is open or contested (it is ${fb.status}).`);
    }
    const nextRevision = fb.planRevision + 1;
    // Close the outgoing version FIRST. A contest already stamped its own outcome (with the reporter's
    // words); anything still open was replaced without one, which is `superseded` — an operator re-plan.
    // Guarded on outcome IS NULL so a re-plan can never overwrite the reporter's recorded objection.
    await tx
      .update(feedbackPlanRevision)
      .set({ outcome: 'superseded', outcomeAt: sql`now()` })
      .where(
        and(
          eq(feedbackPlanRevision.feedbackRequestId, fb.id),
          isNull(feedbackPlanRevision.outcome),
        ),
      );
    await tx
      .update(feedbackRequest)
      .set({
        plan,
        planRevision: nextRevision,
        planModel: p.model ?? null,
        contestReason: null,
        status: 'planned',
        updatedAt: sql`now()`,
      })
      .where(eq(feedbackRequest.id, fb.id));
    // The history row is what the reporter reads; `feedback_request.plan` stays the fast path for "the
    // current plan". They are written together so the two can never disagree.
    await tx.insert(feedbackPlanRevision).values({
      tenantId: ctx.tenantId,
      feedbackRequestId: fb.id,
      revision: nextRevision,
      plan,
      planModel: p.model ?? null,
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.drafted',
      actor: { type: 'agent' },
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { revision: nextRevision, model: p.model ?? null },
    });
  });
}

/**
 * FB-3 — the planning agent. Resolves the tenant's AI config, sends the (PII-redacted) feedback (and, on
 * a re-plan, the prior plan + the reporter's push-back) to the gateway, and stores the result via
 * setFeedbackPlan (agent actor). The provider call happens OUTSIDE any DB transaction. Gated: no AI config
 * ⇒ a clear error (the cron skips, the admin button surfaces it).
 */
export async function generateFeedbackPlan(ctx: SessionContext, p: { feedbackId: string }): Promise<{ plan: string }> {
  // Disabled by default — planning now runs in the operator-side improvement loop (ADR-0044), which
  // drafts + adversarially refines the plan locally and pushes it back. Set FEEDBACK_AI_PLANNING_ENABLED
  // to use this single-shot in-app agent instead.
  if (!settingEnabled(ctx, 'feedback.ai_planning_enabled')) {
    throw new FeedbackError('In-app AI planning is disabled — plans are produced by the improvement loop.');
  }
  const gathered = await withTenant(ctx, async (tx) => {
    const [fb] = await tx.select().from(feedbackRequest).where(eq(feedbackRequest.id, p.feedbackId)).limit(1);
    if (!fb) throw new FeedbackError('Feedback not found (or not visible).');
    if (fb.status !== 'open' && fb.status !== 'contested') {
      throw new FeedbackError(`A plan can only be drafted while the item is open or contested (it is ${fb.status}).`);
    }
    const aiCfg = await resolveActiveAiConfig(tx, ctx);
    return { fb, aiCfg };
  });
  const { fb, aiCfg } = gathered;
  if (!aiCfg) {
    throw new FeedbackError('No AI provider is configured for this workspace — set one up to enable automatic planning.');
  }

  const system = [
    'You are a senior software engineer writing an implementation plan for one product-feedback item in a',
    'Malaysian HR / payroll web application (Next.js App Router, Drizzle ORM, PostgreSQL with row-level',
    'security, next-intl). Write a concrete, ordered plan: the data-model / migration changes, the service',
    'logic, the UI, and how to verify it (tests + a browser check). Be specific and realistic; scope it to',
    'exactly what the feedback asks — do not invent extra features. Use British English. Output a numbered',
    'plan in Markdown only — no preamble, no closing remarks.',
  ].join(' ');

  const lines = [
    `Type: ${fb.category}`,
    `Title: ${redactPII(fb.title)}`,
    `Description: ${redactPII(fb.description)}`,
    fb.expectedBehavior ? `Expected behaviour: ${redactPII(fb.expectedBehavior)}` : '',
    fb.expectedFunction ? `Expected function: ${redactPII(fb.expectedFunction)}` : '',
  ].filter(Boolean);
  if (fb.status === 'contested' && fb.plan) {
    lines.push(
      '',
      'A previous plan was sent back by the reporter. Previous plan:',
      fb.plan,
      '',
      `The reporter asked for these changes: ${redactPII(fb.contestReason ?? '')}`,
      'Revise the plan to address that feedback.',
    );
  }

  const plan = await generateDraft(aiCfg, {
    system,
    prompt: `Write an implementation plan for this product feedback:\n\n${lines.join('\n')}`,
    maxTokens: 2048,
  });

  await setFeedbackPlan(ctx, { feedbackId: fb.id, plan, model: `${aiCfg.provider}/${aiCfg.model}` });
  return { plan };
}

/** Ids of items awaiting a (re)plan — the cron's work-list (newest first, capped). */
export function listPlannableFeedback(ctx: SessionContext, limit = 50): Promise<string[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: feedbackRequest.id })
      .from(feedbackRequest)
      .where(inArray(feedbackRequest.status, ['open', 'contested']))
      .orderBy(desc(feedbackRequest.createdAt))
      .limit(limit);
    return rows.map((r) => r.id);
  });
}

/**
 * END the live plan revision (0318). Approval is NOT an ending — see markLiveRevisionApproved.
 *
 * Guarded on `outcome IS NULL` so it only ever touches the open version: replaying a contest cannot
 * rewrite a disposition already recorded. A no-op when the item predates this table, which is the honest
 * behaviour — there is no revision row to answer, and inventing one would fabricate history.
 */
async function closeLiveRevision(
  tx: Tx,
  feedbackId: string,
  outcome: 'contested' | 'refuted' | 'superseded',
  reason?: string | null,
): Promise<void> {
  await tx
    .update(feedbackPlanRevision)
    .set({ outcome, outcomeReason: reason ?? null, outcomeAt: sql`now()` })
    .where(and(eq(feedbackPlanRevision.feedbackRequestId, feedbackId), isNull(feedbackPlanRevision.outcome)));
}

// ── Review (reporter-only) ──

/** The reporter approves the plan (planned → approved), unlocking the build. */
export async function approveFeedbackPlan(ctx: SessionContext, p: { feedbackId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    const { onBehalf } = assertCanReview(ctx, fb);
    if (fb.status !== 'planned') throw new FeedbackError(`Only a planned item can be approved (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'approved', decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    // Stamped, NOT closed. An approved plan is the one being built, so it stays the live revision until
    // something actually replaces it — which is what leaves a post-deploy refute somewhere to attach to.
    // No reason recorded: approving carries no payload by design, and the history must not imply the
    // reporter said something they did not.
    await tx
      .update(feedbackPlanRevision)
      .set({ approvedAt: sql`now()` })
      .where(and(eq(feedbackPlanRevision.feedbackRequestId, fb.id), isNull(feedbackPlanRevision.outcome)));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { revision: fb.planRevision, decidedBy: onBehalf ? 'admin' : 'reporter' },
    });
  });
}

/** The reporter pushes back on the plan (planned → contested, with a reason). The agent will re-plan. */
export async function contestFeedbackPlan(ctx: SessionContext, p: { feedbackId: string; reason: string }): Promise<void> {
  const reason = p.reason?.trim();
  if (!reason) throw new FeedbackError('Please say what should change about the plan.');
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    const { onBehalf } = assertCanReview(ctx, fb);
    if (fb.status !== 'planned') throw new FeedbackError(`Only a planned item can be contested (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'contested', contestReason: reason, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    // THE push-back. Recorded against the plan it answers, so the next re-plan cannot erase it — the
    // whole reason this table exists.
    await closeLiveRevision(tx, fb.id, 'contested', reason);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.contested',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      // The reason travels in the event too, not only in the row: the event stream is the audit record,
      // and it carried only a revision number before, which is how the old push-backs were lost.
      payload: { revision: fb.planRevision, reason, decidedBy: onBehalf ? 'admin' : 'reporter' },
    });
  });
}

/** The reporter withdraws their feedback (any non-terminal state → cancelled). The pre-cancel status is
 *  snapshotted onto status_before_cancel so restoreFeedback can put it back exactly where it was. */
export async function cancelFeedback(ctx: SessionContext, p: { feedbackId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    assertReporter(ctx, fb);
    if (fb.status === 'done' || fb.status === 'cancelled' || fb.status === 'building') {
      throw new FeedbackError(`This feedback can no longer be withdrawn (it is ${fb.status}).`);
    }
    await tx
      .update(feedbackRequest)
      .set({ status: 'cancelled', statusBeforeCancel: fb.status, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { statusBeforeCancel: fb.status },
    });
  });
}

/** The reporter un-withdraws a cancelled item, putting it back exactly where it was before cancelFeedback
 *  ran (open/planned/contested/approved), via the status_before_cancel snapshot. Reporter-only, mirroring
 *  cancelFeedback's own authority (withdrawing and un-withdrawing are the same person's call). */
export async function restoreFeedback(ctx: SessionContext, p: { feedbackId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    assertReporter(ctx, fb);
    if (fb.status !== 'cancelled') {
      throw new FeedbackError(`Only a withdrawn item can be restored (it is ${fb.status}).`);
    }
    const restoredStatus: FeedbackStatus = fb.statusBeforeCancel ?? 'open';
    await tx
      .update(feedbackRequest)
      .set({ status: restoredStatus, statusBeforeCancel: null, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.restored',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { restoredStatus },
    });
  });
}

// ── Build (F4 — agent/admin; the app only tracks status, never self-modifies) ──

/**
 * Park an approved item that turns out to depend on an unanswered question (approved → blocked).
 *
 * This is NOT a rejection and NOT a contest: the plan is agreed and will be built as written. What is
 * missing is an input only the reporter can supply — normally a DECISION NEEDED item, named by
 * `blockedById`, so the board can link the two instead of describing the dependency in prose.
 *
 * Blocking is the mechanism that keeps `approved` honest. startFeedbackBuild below accepts ONLY
 * `approved`, so parking an item here also removes it from every build round until it is unblocked —
 * the block cannot be forgotten and worked around by an agent that never saw the question.
 */
export async function blockFeedback(
  ctx: SessionContext,
  p: { feedbackId: string; reason: string; blockedById?: string | null },
): Promise<void> {
  const reason = p.reason?.trim();
  if (!reason) throw new FeedbackError('Please say what this item is waiting on.');
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (fb.status !== 'approved') {
      throw new FeedbackError(`Only an approved item can be blocked (it is ${fb.status}).`);
    }
    // Self-blocking would strand the item: nothing could ever resolve it, since resolving it is what
    // unblocks it. Cheap to check here, and the alternative is an item no status change can rescue.
    if (p.blockedById && p.blockedById === fb.id) {
      throw new FeedbackError('An item cannot be blocked by itself.');
    }
    if (p.blockedById) await loadDecidable(tx, p.blockedById); // the blocker must exist and be in-tenant
    await tx
      .update(feedbackRequest)
      .set({ status: 'blocked', blockedById: p.blockedById ?? null, blockedReason: reason, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.blocked',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { reason, blockedById: p.blockedById ?? null },
    });
  });
}

/** The blocker was settled — return the item to the build queue (blocked → approved). */
export async function unblockFeedback(ctx: SessionContext, p: { feedbackId: string; note?: string | null }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (fb.status !== 'blocked') throw new FeedbackError(`Only a blocked item can be unblocked (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      // blockedReason/blockedById are cleared: they describe a CURRENT wait, and a stale one would keep
      // rendering "waiting on …" on an item that is queued. The history stays in the event stream.
      .set({ status: 'approved', blockedById: null, blockedReason: null, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.unblocked',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { note: p.note?.trim() || null, wasBlockedBy: fb.blockedById ?? null },
    });
  });
}

/** Mark that a build agent has started on an approved item (approved → building). */
export async function startFeedbackBuild(ctx: SessionContext, p: { feedbackId: string; buildRef?: string | null }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (fb.status !== 'approved') throw new FeedbackError(`Only an approved item can start building (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'building', buildRef: p.buildRef ?? null, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.build.started',
      actor: { type: 'agent' },
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { buildRef: p.buildRef ?? null },
    });
  });
}

/** Mark a build complete with the PR/branch link (building → done). */
export async function completeFeedbackBuild(ctx: SessionContext, p: { feedbackId: string; buildRef: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (fb.status !== 'building') throw new FeedbackError(`Only a building item can complete (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'done', buildRef: p.buildRef, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.build.completed',
      actor: { type: 'agent' },
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { buildRef: p.buildRef },
    });
  });
}

/** The improvement loop releases the built change and closes the item (→ deployed). Allowed from approved
 *  / building / done so the loop can combine the build + release steps. */
export async function markFeedbackDeployed(
  ctx: SessionContext,
  p: { feedbackId: string; buildRef?: string | null },
): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    if (!['approved', 'building', 'done'].includes(fb.status)) {
      throw new FeedbackError(`Only an approved/building/done item can be marked deployed (it is ${fb.status}).`);
    }
    await tx
      .update(feedbackRequest)
      .set({ status: 'deployed', buildRef: p.buildRef ?? undefined, decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.deployed',
      actor: { type: 'agent' },
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { buildRef: p.buildRef ?? null },
    });
  });
}

// ── Close the loop: post-deploy refute (ADR-0051) ──

/** The reporter (or admin) refutes a DEPLOYED result that isn't up to standard, sending it back round the
 *  loop: deployed → contested (the refiner re-plans, carrying contest_reason), reopened_count++. A distinct
 *  `feedback.deployment.refuted` event keeps it separable from a pre-build plan contest in the audit. */
export async function refuteDeployment(ctx: SessionContext, p: { feedbackId: string; reason: string }): Promise<void> {
  const reason = p.reason?.trim();
  if (!reason) throw new FeedbackError('Please say what still needs to change about the deployed result.');
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    const { onBehalf } = assertCanReview(ctx, fb);
    if (fb.status !== 'deployed') {
      throw new FeedbackError(`Only a deployed item can be refuted (it is ${fb.status}).`);
    }
    await tx
      .update(feedbackRequest)
      .set({
        status: 'contested',
        contestReason: reason,
        reopenedCount: sql`${feedbackRequest.reopenedCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(feedbackRequest.id, fb.id));
    // A post-deploy push-back answers the plan that WAS shipped, so it closes that revision rather than
    // opening a new one. Kept distinct from 'contested' in the history for the same reason the event is
    // distinct: "you built the wrong thing" and "we shipped it and it missed" are different complaints.
    await closeLiveRevision(tx, fb.id, 'refuted', reason);
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.deployment.refuted',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { reason, revision: fb.planRevision, decidedBy: onBehalf ? 'admin' : 'reporter' },
    });
  });
}

// ── Bulk review (list-view batch bar) ──

export type BulkAction = 'approve' | 'contest' | 'cancel' | 'restore';

/** Apply one review action to many items at once. Reuses the per-item services so each keeps its own authz,
 *  status guard and event; a single-item failure (wrong status, not the reporter) is reported in `failed`,
 *  never aborts the rest. */
export async function bulkReview(
  ctx: SessionContext,
  p: { ids: string[]; action: BulkAction; reason?: string },
): Promise<{ succeeded: string[]; failed: { id: string; error: string }[] }> {
  const ids = [...new Set(p.ids)].filter(Boolean);
  if (ids.length === 0) throw new FeedbackError('Select at least one item.');
  if (ids.length > 100) throw new FeedbackError('Too many items selected at once (max 100).');
  if (p.action === 'contest' && !p.reason?.trim()) throw new FeedbackError('A reason is required to contest.');
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      if (p.action === 'approve') await approveFeedbackPlan(ctx, { feedbackId: id });
      else if (p.action === 'contest') await contestFeedbackPlan(ctx, { feedbackId: id, reason: p.reason! });
      else if (p.action === 'restore') await restoreFeedback(ctx, { feedbackId: id });
      else await cancelFeedback(ctx, { feedbackId: id });
      succeeded.push(id);
    } catch (e) {
      failed.push({ id, error: e instanceof FeedbackError ? e.message : 'Action failed' });
    }
  }
  return { succeeded, failed };
}

// ── Reads (RLS-scoped) ──

/** Counts by status for the in-app review dashboard (RLS-scoped to visible items). */
export function feedbackStatusCounts(ctx: SessionContext): Promise<{ status: FeedbackStatus; count: number }[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: feedbackRequest.status, count: sql<number>`count(*)::int` })
      .from(feedbackRequest)
      .groupBy(feedbackRequest.status);
    return rows as { status: FeedbackStatus; count: number }[];
  });
}

export type FeedbackRow = {
  id: string;
  category: FeedbackCategory;
  title: string;
  status: FeedbackStatus;
  reporter: string;
  planRevision: number;
  reopenedCount: number;
  createdAt: Date;
};

export function listFeedback(
  ctx: SessionContext,
  opts: { status?: FeedbackStatus; category?: FeedbackCategory } = {},
): Promise<FeedbackRow[]> {
  const filters = [
    opts.status ? eq(feedbackRequest.status, opts.status) : undefined,
    opts.category ? eq(feedbackRequest.category, opts.category) : undefined,
  ].filter(Boolean);
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: feedbackRequest.id,
        category: feedbackRequest.category,
        title: feedbackRequest.title,
        status: feedbackRequest.status,
        reporter: person.fullName,
        planRevision: feedbackRequest.planRevision,
        reopenedCount: feedbackRequest.reopenedCount,
        createdAt: feedbackRequest.createdAt,
      })
      .from(feedbackRequest)
      .innerJoin(employment, eq(employment.id, feedbackRequest.reporterEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(filters.length ? (filters.length === 1 ? filters[0] : (and as any)(...filters)) : undefined)
      .orderBy(desc(feedbackRequest.createdAt))
      .limit(200) as Promise<FeedbackRow[]>,
  );
}

/** One entry in the negotiation: a plan version and how the reporter answered it (0318). */
export type FeedbackPlanRevisionRow = typeof feedbackPlanRevision.$inferSelect;

export type FeedbackDetail = typeof feedbackRequest.$inferSelect & {
  attachments: { id: string; fileName: string; sizeBytes: number }[];
  /** Resolved from blockedById so the board can name what it is waiting on rather than show a bare id. */
  blockedBy: { id: string; title: string; status: FeedbackStatus } | null;
  /**
   * The full plan history, oldest first — what was proposed each round and what the reporter said back.
   *
   * EMPTY does not mean "never re-planned". Items planned before 0318 have no rows at all, because the
   * earlier plan texts were overwritten and are genuinely unrecoverable. The UI compares this length
   * against `planRevision` and says so, rather than presenting a partial history as a complete one.
   */
  planHistory: FeedbackPlanRevisionRow[];
};

export function getFeedback(ctx: SessionContext, id: string): Promise<FeedbackDetail | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(feedbackRequest).where(eq(feedbackRequest.id, id)).limit(1);
    if (!row) return null;
    const atts = await tx
      .select({ id: feedbackAttachment.id, fileName: feedbackAttachment.fileName, sizeBytes: feedbackAttachment.sizeBytes })
      .from(feedbackAttachment)
      .where(eq(feedbackAttachment.feedbackRequestId, id));
    const planHistory = await tx
      .select()
      .from(feedbackPlanRevision)
      .where(eq(feedbackPlanRevision.feedbackRequestId, id))
      .orderBy(asc(feedbackPlanRevision.revision));
    let blockedBy: FeedbackDetail['blockedBy'] = null;
    if (row.blockedById) {
      const [b] = await tx
        .select({ id: feedbackRequest.id, title: feedbackRequest.title, status: feedbackRequest.status })
        .from(feedbackRequest)
        .where(eq(feedbackRequest.id, row.blockedById))
        .limit(1);
      blockedBy = b ?? null; // tenant-scoped by RLS; a cross-tenant id simply resolves to nothing
    }
    return { ...row, attachments: atts, blockedBy, planHistory };
  });
}

// ── helpers ──

type DecidableFeedback = {
  id: string;
  status: FeedbackStatus;
  reporterEmploymentId: string;
  reporterUserId: string | null;
  planRevision: number;
  statusBeforeCancel: FeedbackStatus | null;
  blockedById: string | null;
};

async function loadDecidable(tx: Tx, feedbackId: string): Promise<DecidableFeedback> {
  const [fb] = await tx
    .select({
      id: feedbackRequest.id,
      status: feedbackRequest.status,
      reporterEmploymentId: feedbackRequest.reporterEmploymentId,
      reporterUserId: feedbackRequest.reporterUserId,
      planRevision: feedbackRequest.planRevision,
      statusBeforeCancel: feedbackRequest.statusBeforeCancel,
      blockedById: feedbackRequest.blockedById,
    })
    .from(feedbackRequest)
    .where(eq(feedbackRequest.id, feedbackId))
    .limit(1);
  if (!fb) throw new FeedbackError('Feedback not found (or not visible).');
  return fb;
}

/** Only the person who raised the feedback may withdraw it. */
function assertReporter(ctx: SessionContext, fb: DecidableFeedback): void {
  if (!ctx.userId || fb.reporterUserId !== ctx.userId) {
    throw new FeedbackError('Only the person who raised this feedback can review its plan.');
  }
}

/** Approve/contest a plan: allowed for the reporter OR an admin (HR triage). Returns whether an admin acted
 *  on the reporter's behalf, so the event records the provenance (admin-on-behalf vs self-approval). */
function assertCanReview(ctx: SessionContext, fb: DecidableFeedback): { onBehalf: boolean } {
  const isReporter = !!ctx.userId && fb.reporterUserId === ctx.userId;
  const isAdmin = (ctx.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  if (!isReporter && !isAdmin) {
    throw new FeedbackError('Only the person who raised this feedback, or an admin, can review its plan.');
  }
  return { onBehalf: !isReporter && isAdmin };
}
