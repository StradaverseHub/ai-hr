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
