/**
 * In-product feedback → AI-plan → review → build loop (ADR-0043). A user logs feedback; an AI planning
 * agent writes a `plan` (FB-3, via lib/ai); the REPORTER reviews it — approve, or contest (push back) so
 * the agent re-plans; on approval an out-of-app build agent produces a human-reviewed PR (FB-4). Every
 * transition appends a DomainEvent (user / agent actor). RLS scopes reads via can_see_employment; the
 * review authority (only the reporter approves/contests) is enforced here.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { generateDraft, redactPII } from '../lib/ai';
import { resolveActiveAiConfig } from './ai-config';
import {
  employment,
  feedbackAttachment,
  feedbackRequest,
  person,
  type FeedbackCategory,
  type FeedbackStatus,
} from '../db/schema';

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
    await tx
      .update(feedbackRequest)
      .set({
        plan,
        planRevision: fb.planRevision + 1,
        planModel: p.model ?? null,
        contestReason: null,
        status: 'planned',
        updatedAt: sql`now()`,
      })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.drafted',
      actor: { type: 'agent' },
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { revision: fb.planRevision + 1, model: p.model ?? null },
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
  if (process.env.FEEDBACK_AI_PLANNING_ENABLED !== 'true') {
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

// ── Review (reporter-only) ──

/** The reporter approves the plan (planned → approved), unlocking the build. */
export async function approveFeedbackPlan(ctx: SessionContext, p: { feedbackId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    assertReporter(ctx, fb);
    if (fb.status !== 'planned') throw new FeedbackError(`Only a planned item can be approved (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'approved', decidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { revision: fb.planRevision },
    });
  });
}

/** The reporter pushes back on the plan (planned → contested, with a reason). The agent will re-plan. */
export async function contestFeedbackPlan(ctx: SessionContext, p: { feedbackId: string; reason: string }): Promise<void> {
  const reason = p.reason?.trim();
  if (!reason) throw new FeedbackError('Please say what should change about the plan.');
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    assertReporter(ctx, fb);
    if (fb.status !== 'planned') throw new FeedbackError(`Only a planned item can be contested (it is ${fb.status}).`);
    await tx
      .update(feedbackRequest)
      .set({ status: 'contested', contestReason: reason, updatedAt: sql`now()` })
      .where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.plan.contested',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: { revision: fb.planRevision },
    });
  });
}

/** The reporter withdraws their feedback (any non-terminal state → cancelled). */
export async function cancelFeedback(ctx: SessionContext, p: { feedbackId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const fb = await loadDecidable(tx, p.feedbackId);
    assertReporter(ctx, fb);
    if (fb.status === 'done' || fb.status === 'cancelled' || fb.status === 'building') {
      throw new FeedbackError(`This feedback can no longer be withdrawn (it is ${fb.status}).`);
    }
    await tx.update(feedbackRequest).set({ status: 'cancelled', updatedAt: sql`now()` }).where(eq(feedbackRequest.id, fb.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'feedback',
      aggregateId: fb.id,
      eventType: 'feedback.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: fb.reporterEmploymentId,
      payload: {},
    });
  });
}

// ── Build (F4 — agent/admin; the app only tracks status, never self-modifies) ──

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

// ── Reads (RLS-scoped) ──

export type FeedbackRow = {
  id: string;
  category: FeedbackCategory;
  title: string;
  status: FeedbackStatus;
  reporter: string;
  planRevision: number;
  createdAt: Date;
};

export function listFeedback(ctx: SessionContext, opts: { status?: FeedbackStatus } = {}): Promise<FeedbackRow[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: feedbackRequest.id,
        category: feedbackRequest.category,
        title: feedbackRequest.title,
        status: feedbackRequest.status,
        reporter: person.fullName,
        planRevision: feedbackRequest.planRevision,
        createdAt: feedbackRequest.createdAt,
      })
      .from(feedbackRequest)
      .innerJoin(employment, eq(employment.id, feedbackRequest.reporterEmploymentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(opts.status ? eq(feedbackRequest.status, opts.status) : undefined)
      .orderBy(desc(feedbackRequest.createdAt))
      .limit(200) as Promise<FeedbackRow[]>,
  );
}

export type FeedbackDetail = typeof feedbackRequest.$inferSelect & {
  attachments: { id: string; fileName: string; sizeBytes: number }[];
};

export function getFeedback(ctx: SessionContext, id: string): Promise<FeedbackDetail | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(feedbackRequest).where(eq(feedbackRequest.id, id)).limit(1);
    if (!row) return null;
    const atts = await tx
      .select({ id: feedbackAttachment.id, fileName: feedbackAttachment.fileName, sizeBytes: feedbackAttachment.sizeBytes })
      .from(feedbackAttachment)
      .where(eq(feedbackAttachment.feedbackRequestId, id));
    return { ...row, attachments: atts };
  });
}

// ── helpers ──

type DecidableFeedback = {
  id: string;
  status: FeedbackStatus;
  reporterEmploymentId: string;
  reporterUserId: string | null;
  planRevision: number;
};

async function loadDecidable(tx: Tx, feedbackId: string): Promise<DecidableFeedback> {
  const [fb] = await tx
    .select({
      id: feedbackRequest.id,
      status: feedbackRequest.status,
      reporterEmploymentId: feedbackRequest.reporterEmploymentId,
      reporterUserId: feedbackRequest.reporterUserId,
      planRevision: feedbackRequest.planRevision,
    })
    .from(feedbackRequest)
    .where(eq(feedbackRequest.id, feedbackId))
    .limit(1);
  if (!fb) throw new FeedbackError('Feedback not found (or not visible).');
  return fb;
}

/** Only the person who raised the feedback may approve/contest/cancel it (admins triage but do not review
 *  on the reporter's behalf). */
function assertReporter(ctx: SessionContext, fb: DecidableFeedback): void {
  if (!ctx.userId || fb.reporterUserId !== ctx.userId) {
    throw new FeedbackError('Only the person who raised this feedback can review its plan.');
  }
}
