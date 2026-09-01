/**
 * ADR-0084 §2.3 / §2.4 — THE PROPOSAL LEDGER AND THE ADJUDICATION CONTRACT.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Before this file there was **no edge anywhere in this codebase from an AI output back to an AI input**.
 * The narrator wrote prose, the pay-rule drafter drafted, the action layer proposed — and not one of them
 * recorded what happened next. So nothing could improve without a developer editing a prompt, and nobody
 * could answer the owner's actual question: does any of this help?
 *
 * This is also the precondition for ADR-0083 §2.5's per-action autonomy. r235 shipped `AutonomyLevel` as a
 * union with ONE member because §2.5 requires autonomy to be earned from MEASURED agreement and there was
 * nothing to measure. This is the measurement.
 *
 * ═══ THE PATTERN IT ENFORCES (§2.1) ═══
 *
 * **Propose** — a proposer emits a STRUCTURED object into a closed vocabulary. **Adjudicate** — the same
 * deterministic code the kernel and the UI already depend on accepts or rejects it, and **rejection is
 * silent and free**, which is what lets a proposer be bold: a bad proposal costs a discarded row, not a
 * wrong payslip. **Learn** — the outcome is recorded here.
 *
 * ═══ FOUR PROPERTIES OF THIS MODULE THAT ARE NOT INCIDENTAL ═══
 *
 *  1. **RECORDING NEVER THROWS INTO THE CALLER.** Every entry point swallows its own failure and returns.
 *     A ledger outage must not break a payslip narration or a pay-rule draft — **measurement is never
 *     worth breaking the thing it measures.** The cost of that choice is that a silent ledger failure
 *     under-counts rather than alarms, which is the right trade for telemetry and the wrong one for money.
 *  2. **RECORDING RUNS IN ITS OWN TRANSACTION**, never the caller's. A rejected proposal usually happens
 *     inside an operation that then aborts, and a row written in that transaction would roll back with
 *     it — so the ledger would only ever contain successes and the adjudication-pass rate would be
 *     structurally 100%. The rejections ARE the measurement.
 *
 *     ⚠️ **THE COROLLARY IS A CALLER REQUIREMENT: DO NOT CALL THESE FROM INSIDE A `withTenant`.**
 *     `withTenant` is `db.transaction`, which takes its own connection from the pool, so a nested call
 *     holds TWO connections for the duration of the outer one. That is fine occasionally and is a pool
 *     exhaustion risk under load — and if the outer transaction ever locks a row the inner one needs, it
 *     is a deadlock. All four call sites shipped in this round record OUTSIDE any open transaction, and
 *     a new one must too.
 *  3. **THE ID IS GENERATED HERE, NOT BY `RETURNING`.** 0452's insert policy is `FOR INSERT` with no
 *     `USING` clause (deliberately, so it cannot widen the admin-only read), and `INSERT ... RETURNING`
 *     needs SELECT. A non-admin session — §2.5's nudge sweep, §2.7's triage in an employee's own session —
 *     would fail on a `.returning()`.
 *  4. **THE FACTS ARE HASHED, NEVER STORED.** `inputDigest` makes identical inputs comparable across time
 *     and model versions without putting a second copy of employee data in a telemetry table.
 */
import { createHash } from 'node:crypto';
import { eq, gte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';

/**
 * The closed vocabulary. Adding a member is the ONLY way a new AI surface enters the ledger, and it is
 * deliberately a TypeScript union rather than a SQL CHECK — see 0452's header for why a migration per AI
 * surface would be friction that discourages the adoption this table needs.
 */
export type ProposalTypeId =
  /** ADR-0076 §2.6 — the narrator's prose for one finding. */
  | 'anomaly_narration'
  /** A pay rule drafted from an admin's sentence, adjudicated by `validatePayRule`. */
  | 'pay_rule_draft'
  /** A report spec drafted from an admin's sentence, adjudicated by `validateReportSpec`. */
  | 'report_spec'
  /** ADR-0083 §2.5 — the action layer. DETERMINISTIC: no model, hence null provider/model. */
  | 'close_fixed_upstream'
  /** ADR-0084 §2.5 — a drafted nudge BODY, one per gap per sweep. Adjudicated by `nudgeIsFaithful`. */
  | 'readiness_nudge'
  /**
   * ADR-0084 §2.6 — a hypothesis about ONE auto-cleared employee's figures, classified into a closed set
   * of five explanations (or `nothing_notable`) and adjudicated by re-deriving every field it cites.
   *
   * ⚠️ **THE ONLY TYPE IN THE PRODUCT WHOSE THREE RATES ARE ALL REAL AND ALL INFORMATIVE.** Its
   * adjudication-pass rate says whether the model cites fields that actually hold; its agreement rate is
   * an operator answering "is this a real problem?" on a row nothing else would have flagged; and its
   * reversal rate is the honest ceiling on ever granting it autonomy. It is also the only type that can
   * produce a payroll FINDING — capped at severity `review`, forever (§2.2).
   */
  | 'anomaly_hypothesis'
  /**
   * ADR-0084 §2.5 — one nudge raised about one person's one gap. DETERMINISTIC, and **the only type in
   * the product with a real agreement rate**: the human's verdict is observable in the record itself,
   * because the gap either closed within the settle window or it did not. Everything else either has no
   * human decision (`anomaly_narration`) or cannot observe a decline (`close_fixed_upstream`).
   */
  | 'readiness_fix';

/** The adjudication contract (§2.4). Every proposal type supplies one; the reason is stored on failure. */
export type Adjudication = { ok: true } | { ok: false; reason: string };

/** Stable, order-independent digest of whatever the proposer was shown. Never reversible to the facts. */
export function digestOf(facts: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, stable(val)]),
      );
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(facts) ?? null)).digest('hex').slice(0, 32);
}

export type RecordProposalInput = {
  type: ProposalTypeId;
  /** Present only when the proposal is ABOUT an existing record. Authoring drafts leave it undefined. */
  subject?: { type: string; id: string };
  /** Hashed into `inputDigest` and then dropped. Do not pass anything you want kept. */
  facts: unknown;
  proposal: Record<string, unknown>;
  adjudication: Adjudication;
  provider?: string | null;
  model?: string | null;
  /**
   * Set ONLY when the human's verdict is known at the same instant the proposal is made — the action
   * layer, where the operator has already clicked. Everything else stamps a decision later via
   * `recordDecision`, and a rejected proposal may never carry one (0452 CHECK).
   */
  decision?: 'approved' | 'declined';
};

/** Returns the new row's id, or null if the ledger could not be written. Never throws (property 1). */
export async function recordProposal(
  ctx: SessionContext,
  p: RecordProposalInput,
): Promise<string | null> {
  const id = crypto.randomUUID();
  const decided = p.adjudication.ok ? p.decision : undefined;
  try {
    await withTenant(ctx, async (tx) => {
      await tx.insert(schema.agentProposal).values({
        id,
        tenantId: ctx.tenantId,
        proposalType: p.type,
        subjectType: p.subject?.type ?? null,
        subjectId: p.subject?.id ?? null,
        inputDigest: digestOf(p.facts),
        proposal: p.proposal,
        adjudication: p.adjudication.ok ? 'accepted' : 'rejected',
        adjudicationReason: p.adjudication.ok ? null : p.adjudication.reason,
        decision: decided ?? null,
        decidedByUserId: decided ? (ctx.userId ?? null) : null,
        decidedAt: decided ? new Date() : null,
        provider: p.provider ?? null,
        model: p.model ?? null,
      } as never);
    });
    return id;
  } catch {
    // Property 1. A ledger failure is a lost data point, not a broken feature.
    return null;
  }
}

/** Stamp the human's verdict on an earlier proposal. No-op on a null id. Never throws. */
export async function recordDecision(
  ctx: SessionContext,
  p: { proposalId: string | null; decision: 'approved' | 'declined' },
): Promise<void> {
  if (!p.proposalId) return;
  try {
    await withTenant(ctx, async (tx) => {
      await tx
        .update(schema.agentProposal)
        .set({ decision: p.decision, decidedByUserId: ctx.userId ?? null, decidedAt: new Date() })
        .where(eq(schema.agentProposal.id, p.proposalId!));
    });
  } catch {
    /* property 1 */
  }
}

/**
 * Record that an approved proposal was undone by later reality (§2.4).
 *
 * THIS IS THE MOST VALUABLE COLUMN IN THE TABLE AND THE ONE NOBODY WILL REMEMBER TO WRITE. A high
 * agreement rate alongside a high reversal rate means the humans are rubber-stamping — and that reads as
 * success in every other metric. For `close_fixed_upstream` it is not merely valuable, it is THE metric:
 * a batch action whose operator simply does not press the button leaves no trace, so agreement is
 * structurally 1.0 for that type and proves nothing. **Whether the closure STUCK is what proves it.**
 */
export async function recordReversal(
  ctx: SessionContext,
  p: { proposalId: string | null; reason: string },
): Promise<void> {
  if (!p.proposalId) return;
  try {
    await withTenant(ctx, async (tx) => {
      await tx
        .update(schema.agentProposal)
        .set({ reversedAt: new Date(), reversalReason: p.reason })
        .where(eq(schema.agentProposal.id, p.proposalId!));
    });
  } catch {
    /* property 1 */
  }
}

export type ProposalRates = {
  type: string;
  total: number;
  accepted: number;
  rejected: number;
  approved: number;
  declined: number;
  reversed: number;
  /** accepted ÷ total — is the proposer even producing valid output? */
  adjudicationPassRate: number | null;
  /** approved ÷ (approved + declined) — when it is valid, is it right? */
  agreementRate: number | null;
  /** reversed ÷ approved — was approval too easy? */
  reversalRate: number | null;
};

/**
 * The three rates, per proposal type.
 *
 * ⚠️ **EVERY RATE IS NULL WHEN ITS DENOMINATOR IS ZERO — never 0, never 1.** Printing "0% agreement"
 * because nothing has been decided is a lie about the system's accuracy, and it is the same discipline
 * `impliedOperators` already applies in `core/control-tower.ts`: a figure nobody can stand behind is not
 * shown. A caller that renders these must render the null as "not measured yet", not as a zero.
 */
export async function proposalRates(
  ctx: SessionContext,
  p?: { sinceDays?: number },
): Promise<ProposalRates[]> {
  const since = p?.sinceDays
    ? new Date(Date.now() - p.sinceDays * 24 * 60 * 60 * 1000)
    : null;
  const rows = await withTenant(ctx, async (tx) =>
    tx
      .select({
        type: schema.agentProposal.proposalType,
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${schema.agentProposal.adjudication} = 'accepted')::int`,
        rejected: sql<number>`count(*) filter (where ${schema.agentProposal.adjudication} = 'rejected')::int`,
        approved: sql<number>`count(*) filter (where ${schema.agentProposal.decision} = 'approved')::int`,
        declined: sql<number>`count(*) filter (where ${schema.agentProposal.decision} = 'declined')::int`,
        reversed: sql<number>`count(*) filter (where ${schema.agentProposal.reversedAt} is not null)::int`,
      })
      .from(schema.agentProposal)
      .where(since ? gte(schema.agentProposal.proposedAt, since) : undefined)
      .groupBy(schema.agentProposal.proposalType),
  );

  const rate = (n: number, d: number) => (d === 0 ? null : n / d);
  return rows
    .map((r) => ({
      ...r,
      adjudicationPassRate: rate(r.accepted, r.total),
      agreementRate: rate(r.approved, r.approved + r.declined),
      reversalRate: rate(r.reversed, r.approved),
    }))
    .sort((a, b) => b.total - a.total);
}
