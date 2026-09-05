/**
 * ADR-0074 — THE CONTROL TOWER, ROLLED UP ACROSS RUNS, AND THE RATIO QUESTION ANSWERED HONESTLY.
 *
 * The anomaly layer (ADR-0076) shipped per BATCH: `evaluateBatchAnomalies` writes verdicts, the queue at
 * /payroll/<batch>/anomalies works one run, and `anomalyMetrics` reports on one run. That is the right
 * shape for an operator clearing today's exceptions and the wrong shape for the question the owner
 * actually asks, which is about the whole operation: **does this let three people run three thousand?**
 *
 * This module answers that, and the interesting part is what it REFUSES to answer.
 *
 * ADR-0074's arithmetic is simple — at a 97% auto-clear rate ~90 of 3,000 need human eyes per cycle,
 * about 1.4 per operator per working day — and it is only as good as the two inputs underneath it:
 *
 *   1. ARE THE THRESHOLDS TUNED? `payroll_anomaly_config` is empty on production today, so every verdict
 *      was classified by the 30%/15% PLACEHOLDERS r177 shipped and labelled as untuned. An auto-clear
 *      rate computed from placeholder thresholds measures the placeholders.
 *   2. HAS A HUMAN EVER DISAGREED? `falsePositiveRate` needs resolved verdicts. With none resolved it is
 *      null — not zero. A system nobody has audited has no measured accuracy, and "no false positives
 *      recorded" reads as "no false positives" to everyone who did not write it.
 *
 * So `impliedOperators` is `number | null`, and it is null until both hold. AGENTS 28 is the rule and a
 * staffing number is exactly the shape it warns about: a headcount projection on a slide is acted on. An
 * absent figure with a stated reason is honest; a confident wrong one gets somebody's job cut. The screen
 * renders `blockedBy` instead, which names what is missing rather than printing a number nobody can
 * defend — and r177's own warning says it in as many words: never quote an auto-clear rate from the
 * synthetic harness.
 *
 * NOTHING HERE COMPUTES OR TOUCHES MONEY. It reads verdicts and batch rows. Same guarantee as the layer
 * it reports on.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { proposalRates, type ProposalRates } from './agent-proposal';
import { resolveActiveAiConfig } from './ai-config';
import { isModuleEnabled, settingEnabled } from './entitlements';

/** ADR-0074 §"the reframe": the target the whole design serves. */
export const TARGET_AUTO_CLEAR_RATE = 0.95;

/**
 * Exceptions one operator can carry per cycle, used only to turn an exception COUNT into a headcount.
 *
 * ADR-0074 works the example the other way round (90 exceptions across 3 operators over a working month
 * is ~1.4 each per day); at ~20 working days that is ~30 per operator per cycle. Stated as a named
 * constant rather than buried in an expression because it is an ASSUMPTION, it is the one input here that
 * did not come from this database, and the screen labels it as such.
 */
export const EXCEPTIONS_PER_OPERATOR_PER_CYCLE = 30;

/** One run, as the tower lists it. */
export type ControlTowerRun = {
  batchId: string;
  companyName: string;
  payPeriod: string;
  status: string;
  employees: number;
  autoClear: number;
  review: number;
  block: number;
  unresolvedFlagged: number;
  /** Null when the evaluator has never written a live verdict for this run. */
  autoClearRate: number | null;
};

/** Why a staffing projection is not being shown. Empty = it is. */
export type RatioBlocker = 'no_verdicts' | 'thresholds_untuned' | 'no_human_signal';

export type ControlTowerView = {
  /** Open runs (processed, not yet closed) newest first — the window where the queue is actionable. */
  runs: ControlTowerRun[];
  totals: {
    runs: number;
    employees: number;
    autoClear: number;
    review: number;
    block: number;
    unresolvedFlagged: number;
    /** Across every live verdict in scope, not an average of per-run rates — a 4-person run and a
     *  400-person run must not carry equal weight in a number quoted as the operation's. */
    autoClearRate: number | null;
    coverage: number | null;
    falsePositiveRate: number | null;
    mttrSeconds: number | null;
    /** Flagged verdicts a human has dispositioned. The denominator of every accuracy claim. */
    resolvedFlagged: number;
  };
  ratio: {
    /** Employees the tower actually opined on. */
    covered: number;
    /** review + block — the ones that needed a person. */
    exceptions: number;
    /** Operators implied at EXCEPTIONS_PER_OPERATOR_PER_CYCLE. NULL while `blockedBy` is non-empty. */
    impliedOperators: number | null;
    /** What has to be true before the figure above means anything. */
    blockedBy: RatioBlocker[];
    thresholdsTuned: boolean;
    meetsTarget: boolean | null;
  };
};

/**
 * The whole tower in one read.
 *
 * Scoped by RLS to the caller's tenant like every other read here; `scopedAdmin` on the screen decides
 * who may open it. Live verdicts only (`supersededAt IS NULL`) — a re-evaluation supersedes rather than
 * deletes, so counting superseded rows would double-count every re-run.
 */
export async function controlTowerView(ctx: SessionContext): Promise<ControlTowerView> {
  return withTenant(ctx, async (tx) => {
    // PROCESSED RUNS ONLY, the same window scripts/anomaly-sweep.ts evaluates: a draft has no payslips to
    // opine on and a closed run is finished, so exceptions on either are not something an operator can act
    // on today. Keeping the two definitions identical is what stops the tower listing runs the sweep never
    // looks at.
    const batches = await tx
      .select({
        batchId: schema.payrollBatch.id,
        payPeriod: schema.payrollBatch.payPeriod,
        status: schema.payrollBatch.status,
        employees: schema.payrollBatch.employeeCount,
        companyName: schema.company.legalName,
      })
      .from(schema.payrollBatch)
      .innerJoin(schema.company, eq(schema.company.id, schema.payrollBatch.companyId))
      .where(eq(schema.payrollBatch.status, 'processed'))
      .orderBy(desc(schema.payrollBatch.payPeriod));

    const ids = batches.map((b) => b.batchId);
    const verdicts = ids.length
      ? await tx
          .select({
            batchId: schema.payrollAnomalyVerdict.batchId,
            disposition: schema.payrollAnomalyVerdict.disposition,
            detectorsRun: schema.payrollAnomalyVerdict.detectorsRun,
            detectorsSkipped: schema.payrollAnomalyVerdict.detectorsSkipped,
            computedAt: schema.payrollAnomalyVerdict.computedAt,
            resolvedAt: schema.payrollAnomalyVerdict.resolvedAt,
            resolution: schema.payrollAnomalyVerdict.resolution,
          })
          .from(schema.payrollAnomalyVerdict)
          .where(
            and(
              inArray(schema.payrollAnomalyVerdict.batchId, ids),
              isNull(schema.payrollAnomalyVerdict.supersededAt),
            ),
          )
      : [];

    // Has anyone tuned the thresholds, or is every verdict still the shipped placeholder?
    const [cfg] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.payrollAnomalyConfig)
      .where(isNull(schema.payrollAnomalyConfig.archivedAt));
    const thresholdsTuned = Number(cfg?.n ?? 0) > 0;

    const byBatch = new Map<string, typeof verdicts>();
    for (const v of verdicts) {
      const list = byBatch.get(v.batchId) ?? [];
      list.push(v);
      byBatch.set(v.batchId, list);
    }

    const runs: ControlTowerRun[] = batches.map((b) => {
      const vs = byBatch.get(b.batchId) ?? [];
      const autoClear = vs.filter((v) => v.disposition === 'auto_clear').length;
      const review = vs.filter((v) => v.disposition === 'review').length;
      const block = vs.filter((v) => v.disposition === 'block').length;
      const flagged = vs.filter((v) => v.disposition !== 'auto_clear');
      return {
        batchId: b.batchId,
        companyName: b.companyName,
        payPeriod: b.payPeriod,
        status: b.status,
        employees: b.employees,
        autoClear,
        review,
        block,
        unresolvedFlagged: flagged.filter((v) => v.resolvedAt == null).length,
        // NULL, not 1.0, when the evaluator has not run: "no verdicts" and "everything cleared" are
        // opposite facts and a rate of 1 says the second.
        autoClearRate: vs.length ? autoClear / vs.length : null,
      };
    });

    const total = verdicts.length;
    const autoClear = verdicts.filter((v) => v.disposition === 'auto_clear').length;
    const review = verdicts.filter((v) => v.disposition === 'review').length;
    const block = verdicts.filter((v) => v.disposition === 'block').length;
    const flagged = verdicts.filter((v) => v.disposition !== 'auto_clear');
    const resolvedFlags = flagged.filter((v) => v.resolvedAt != null);

    const coverage = total
      ? verdicts.reduce((acc, v) => {
          const ran = (v.detectorsRun as string[] | null)?.length ?? 0;
          const skipped = (v.detectorsSkipped as unknown[] | null)?.length ?? 0;
          return acc + (ran + skipped === 0 ? 1 : ran / (ran + skipped));
        }, 0) / total
      : null;

    const durations = resolvedFlags
      .map((v) => (v.resolvedAt!.getTime() - v.computedAt.getTime()) / 1000)
      .sort((a, b) => a - b);
    const mttrSeconds = durations.length
      ? durations.length % 2
        ? durations[(durations.length - 1) / 2]!
        : (durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2
      : null;

    // ── The ratio, and the three things that have to be true before it is worth printing ──────────────
    const blockedBy: RatioBlocker[] = [];
    if (total === 0) blockedBy.push('no_verdicts');
    if (!thresholdsTuned) blockedBy.push('thresholds_untuned');
    if (resolvedFlags.length === 0) blockedBy.push('no_human_signal');

    const exceptions = review + block;
    const autoClearRate = total ? autoClear / total : null;

    return {
      runs,
      totals: {
        runs: runs.length,
        employees: batches.reduce((a, b) => a + b.employees, 0),
        autoClear,
        review,
        block,
        unresolvedFlagged: flagged.length - resolvedFlags.length,
        autoClearRate,
        coverage,
        falsePositiveRate: resolvedFlags.length
          ? resolvedFlags.filter((v) => v.resolution === 'false_positive').length / resolvedFlags.length
          : null,
        mttrSeconds,
        resolvedFlagged: resolvedFlags.length,
      },
      ratio: {
        covered: total,
        exceptions,
        impliedOperators: blockedBy.length
          ? null
          : Math.max(1, Math.ceil(exceptions / EXCEPTIONS_PER_OPERATOR_PER_CYCLE)),
        blockedBy,
        thresholdsTuned,
        meetsTarget: autoClearRate == null ? null : autoClearRate >= TARGET_AUTO_CLEAR_RATE,
      },
    };
  });
}


/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * ADR-0084 Phase 3 item 5 — AGREEMENT MEASUREMENT
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Why there is nothing to measure. Same shape and same discipline as `ratio.blockedBy` above: name what
 * is missing rather than print a figure nobody can defend.
 *
 * The order is causal, not alphabetical — a tenant with no provider ALSO has no proposals, and telling
 * them "nothing proposed yet" first would send them looking in the wrong place.
 */
export type AgreementBlocker = 'no_provider' | 'no_agent_on' | 'nothing_proposed' | 'nothing_decided';

/**
 * ⚠️ **NOTHING IN THIS PRODUCT CALLS `recordReversal` YET, SO A REVERSAL RATE WOULD BE A FABRICATION.**
 *
 * `proposalRates` computes `reversed ÷ approved`, and that arithmetic is right: once one proposal is
 * approved the denominator is real, so the rate is a real 0. The problem is what a 0 MEANS here. With no
 * writer anywhere, `reversed` is structurally zero for every row, so the screen would print "0% reversed"
 * — which reads as "every approval stuck" — when the truth is "nothing in this system can notice that one
 * did not". That is the same lie as a 0% agreement rate, in the flattering direction, and it is the one
 * ADR-0084 says matters MOST (§2.4: for a batch action type, whether the closure stuck is the only thing
 * that proves anything).
 *
 * This is a CONSTANT rather than a setting for the reason `AutonomyLevel` is a union with one member:
 * turning it on must be a source change that arrives WITH the writer and gets reviewed alongside it, not
 * a flag somebody flips. Phase 3 item 6 (recurrence mining) is what writes reversals; that round flips
 * this to `true` in the same diff and deletes this paragraph.
 */
const REVERSAL_HAS_A_WRITER = false;

export type AgreementView = {
  rates: ProposalRates[];
  /** Empty only when at least one rate is actually measurable. */
  blockedBy: AgreementBlocker[];
  /** Proposals recorded, all types, all time. The denominator behind `nothing_proposed`. */
  proposals: number;
};

/**
 * The three rates per proposal type, plus the honest reason when there are none.
 *
 * ⚠️ **CALL THIS OUTSIDE ANY TRANSACTION, AND NEVER FROM INSIDE `controlTowerView`.** `proposalRates`
 * opens its own `withTenant`, and `core/agent-proposal.ts` property 2's corollary is explicit that
 * nesting one inside another holds two pool connections for the duration of the outer one and deadlocks
 * if the outer ever locks a row the inner needs. `controlTowerView` is one big `withTenant`, so this is a
 * SECOND page-level call rather than another field on that view. That separation is deliberate; folding
 * it in later would reintroduce exactly the nesting the ledger warns about.
 *
 * ⚠️ **AND IT NEVER TURNS A NULL RATE INTO A ZERO.** `proposalRates` returns null for every rate whose
 * denominator is zero, and this function preserves that verbatim — the caller renders the null. "0%
 * agreement because nobody has decided anything" is the same class of lie as an implied-operators figure
 * computed from placeholder thresholds, and this file already refuses that one.
 */
export async function agreementView(ctx: SessionContext): Promise<AgreementView> {
  const measured = await proposalRates(ctx);
  // Blank the reversal rate while nothing can write one — see REVERSAL_HAS_A_WRITER. The core arithmetic
  // is left exactly as it is: it is correct, other callers and test/agent-proposal.test.ts depend on it,
  // and bending shared arithmetic to suit one screen is how a number becomes wrong somewhere else.
  const rates: ProposalRates[] = REVERSAL_HAS_A_WRITER
    ? measured
    : measured.map((r) => ({ ...r, reversalRate: null }));
  const proposals = rates.reduce((n, r) => n + r.total, 0);

  // The gates, read from the system rather than assumed — the same sources the agent switchboard reads,
  // so the two screens cannot disagree about whether anything is switched on.
  const aiConfigured = await withTenant(ctx, (tx) => resolveActiveAiConfig(tx, ctx)).then((c) => c != null);
  const anyAgentOn =
    (isModuleEnabled(ctx, 'payroll') && settingEnabled(ctx, 'payroll.anomaly_hypotheses_enabled')) ||
    settingEnabled(ctx, 'notifications.readiness_nudge_enabled') ||
    (isModuleEnabled(ctx, 'claims') && settingEnabled(ctx, 'claims.input_triage_enabled'));

  const blockedBy: AgreementBlocker[] = [];
  if (!aiConfigured) blockedBy.push('no_provider');
  if (!anyAgentOn) blockedBy.push('no_agent_on');
  if (proposals === 0) blockedBy.push('nothing_proposed');
  // Proposals exist but no human verdict has landed on any of them, so `agreementRate` is null across the
  // board. That is a DIFFERENT gap from having no proposals — the proposers are working and the loop is
  // still open — and it is the one Phase 3 items 6 and 7 close, so it gets its own sentence.
  else if (rates.every((r) => r.agreementRate == null)) blockedBy.push('nothing_decided');

  return { rates, blockedBy, proposals };
}
