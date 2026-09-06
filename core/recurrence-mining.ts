/**
 * ADR-0084 §2.4 / Phase 3 item 6 — RECURRENCE MINING: THE SYSTEM CATCHING ITS OWN ERROR.
 *
 * ═══ THE ONE SENTENCE THIS FILE IMPLEMENTS ═══
 *
 * §2.4: *"a verdict closed as `fixed_upstream` whose finding re-fires next cycle proves the fix did not
 * hold."* That is the system detecting its own error without anybody reporting it, and it is the only
 * writer of `agent_proposal.reversed_at` in the product.
 *
 * ═══ WHY THIS COLUMN IS THE ONE THAT MATTERS ═══
 *
 * `core/agent-proposal.ts` says it plainly: a high agreement rate ALONGSIDE a high reversal rate means
 * the humans are rubber-stamping, and that reads as success in every other metric. For
 * `close_fixed_upstream` it is not merely valuable, it is THE metric — agreement is structurally 1.0 for
 * a batch action nobody can decline observably, so *whether the closure stuck* is the only thing that
 * proves anything. Until this file existed, `core/control-tower.ts` had to blank the reversal column
 * (`REVERSAL_HAS_A_WRITER`) because a 0 would have meant "every approval stuck" when it really meant
 * "nothing can notice that one did not".
 *
 * ═══ ⚠️ WHAT A RECURRENCE DOES **NOT** FALSIFY — THE LOAD-BEARING DECISION HERE ═══
 *
 * A recurrence reverses a CLOSURE. It must never reverse a `anomaly_hypothesis`, and the distinction is
 * not a detail:
 *
 *   • `close_fixed_upstream` proposed *"the record fact that caused this finding is no longer missing"*.
 *     The same detector firing again for the same employee falsifies exactly that claim. REVERSAL.
 *   • `anomaly_hypothesis` proposed *"there may be a real problem here"*. A human agreed, and the problem
 *     then recurred — which CONFIRMS the model was right and says the remediation failed. Reversing it
 *     would record a correct model as wrong, and because §2.8 reads these rates to decide autonomy, it
 *     would teach the system to stop raising hypotheses that were true. NEVER.
 *   • `readiness_nudge` already writes its own decision (`core/readiness-nudge.ts`) from whether the gap
 *     closed by the deadline. A re-opened gap later is a new nudge, not a reversal of the old one.
 *
 * So this file filters on `proposal_type = 'close_fixed_upstream'` and nothing else, and the test pins
 * that a recurring hypothesis is left alone.
 *
 * ═══ ⚠️ "NEXT CYCLE" MEANS THE EMPLOYEE'S NEXT APPEARANCE, NOT ANY LATER ONE ═══
 *
 * The tempting reading is "the detector ever fires again". That conflates two different facts. A fix that
 * held for five clean cycles and broke in the sixth is a REGRESSION; a fix that was gone by the very next
 * payroll never worked. Only the second falsifies the closure, so recurrence is judged against the
 * EARLIEST later pay period in which that employment has a live verdict at all. If the next appearance is
 * clean, the closure HELD and nothing is written — silence is the correct record of a fix that worked.
 *
 * ═══ NO TENANT SWITCH, AND THAT IS DELIBERATE ═══
 *
 * The three unattended agents (§2.5/§2.6/§2.7) each carry a `tenant_setting` because each DOES something
 * to the tenant: sends a notification, raises a finding, questions a claimant. This one writes a single
 * timestamp to a telemetry table about OUR OWN accuracy. Nothing employee-facing changes, no money moves,
 * and no notification is sent. Gating self-measurement behind a switch is how a product ends up unable to
 * answer whether it works — the exact question ADR-0084 §1 was written to answer.
 */
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { recordReversal } from './agent-proposal';

/** One closure's verdict on itself. `pending` is NOT a success — see below. */
export type ClosureOutcome = {
  proposalId: string;
  verdictId: string;
  employmentId: string;
  /** The cycle the closure was made in. */
  payPeriod: string;
  status: 'recurred' | 'held' | 'pending';
  /** The employee's next appearance, or null when there has not been one. */
  nextPeriod: string | null;
  /** The detectors that came back. Empty unless `recurred`. */
  recurred: string[];
};

export type RecurrenceMiningResult = {
  /** Approved, not-yet-reversed closures examined. */
  checked: number;
  /** Closures whose finding re-fired at the employee's next appearance — reversals written. */
  reversed: number;
  /** Closures whose next appearance was clean. The fix held; nothing is written. */
  held: number;
  /** Closures whose employee has not been run since. Not yet knowable, and NOT counted as held. */
  pending: number;
};

/**
 * ⚠️ **THE SHARED PREDICATE. READS ONLY — IT WRITES NOTHING.**
 *
 * Two callers need "did this closure hold?" and they must never answer it differently: the sweep below
 * writes reversals from it, and `agreementView` (core/control-tower.ts) uses it to know whether the
 * reversal rate has a TESTED denominator at all. r235's action-layer note states the rule this follows —
 * *share the predicate, never re-write it* — and a second private copy of "next appearance" is exactly
 * the defect wearing the fix's clothes.
 *
 * Returns only proposals not already reversed; an already-reversed one needs no re-judging and its
 * outcome is a fact in the ledger.
 */
export async function classifyClosures(ctx: SessionContext): Promise<ClosureOutcome[]> {
  // ── 1. The candidates, with the verdict they closed and the cycle it belonged to. ───────────────────
  //
  // `superseded_at IS NULL` on the closed verdict matters: a re-run supersedes the verdict, which makes
  // the closure moot rather than wrong. Reversing on a superseded row would blame the model for a payroll
  // somebody re-ran.
  const candidates = await withTenant(ctx, (tx) =>
    tx
      .select({
        proposalId: schema.agentProposal.id,
        verdictId: schema.payrollAnomalyVerdict.id,
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        payPeriod: schema.payrollBatch.payPeriod,
      })
      .from(schema.agentProposal)
      .innerJoin(
        schema.payrollAnomalyVerdict,
        eq(schema.payrollAnomalyVerdict.id, schema.agentProposal.subjectId),
      )
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payrollAnomalyVerdict.batchId))
      .where(
        and(
          eq(schema.agentProposal.proposalType, 'close_fixed_upstream'),
          eq(schema.agentProposal.subjectType, 'payroll_anomaly_verdict'),
          eq(schema.agentProposal.decision, 'approved'),
          isNull(schema.agentProposal.reversedAt),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
        ),
      ),
  );

  if (candidates.length === 0) return [];

  // ── 2. What each closed verdict was actually about. ─────────────────────────────────────────────────
  const closedFindings = await withTenant(ctx, (tx) =>
    tx
      .select({
        verdictId: schema.payrollAnomalyFinding.verdictId,
        detectorId: schema.payrollAnomalyFinding.detectorId,
      })
      .from(schema.payrollAnomalyFinding)
      .where(
        inArray(
          schema.payrollAnomalyFinding.verdictId,
          candidates.map((c) => c.verdictId),
        ),
      ),
  );
  const detectorsOf = new Map<string, Set<string>>();
  for (const f of closedFindings) {
    if (!detectorsOf.has(f.verdictId)) detectorsOf.set(f.verdictId, new Set());
    detectorsOf.get(f.verdictId)!.add(f.detectorId);
  }

  // ── 3. Every LATER live verdict for the employees involved, with the detectors that fired on it. ────
  //
  // Fetched in one pass and narrowed in memory rather than one query per candidate: the candidate set is
  // small (a closure requires an operator pressing a button) and a per-row query inside a sweep is how a
  // nightly job quietly becomes an hour long.
  const earliest = candidates.reduce((m, c) => (c.payPeriod < m ? c.payPeriod : m), candidates[0].payPeriod);
  const later = await withTenant(ctx, (tx) =>
    tx
      .select({
        employmentId: schema.payrollAnomalyVerdict.employmentId,
        payPeriod: schema.payrollBatch.payPeriod,
        detectorId: schema.payrollAnomalyFinding.detectorId,
      })
      .from(schema.payrollAnomalyVerdict)
      .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payrollAnomalyVerdict.batchId))
      // LEFT join: a clean later run has NO findings, and it is the most important row in this query —
      // it is what proves a fix held. An inner join would silently drop every success.
      .leftJoin(
        schema.payrollAnomalyFinding,
        eq(schema.payrollAnomalyFinding.verdictId, schema.payrollAnomalyVerdict.id),
      )
      .where(
        and(
          inArray(
            schema.payrollAnomalyVerdict.employmentId,
            [...new Set(candidates.map((c) => c.employmentId))],
          ),
          isNull(schema.payrollAnomalyVerdict.supersededAt),
          gt(schema.payrollBatch.payPeriod, earliest),
        ),
      ),
  );

  /** employmentId → payPeriod → the detectors that fired there (empty set = a clean run). */
  const byEmployment = new Map<string, Map<string, Set<string>>>();
  for (const r of later) {
    if (!byEmployment.has(r.employmentId)) byEmployment.set(r.employmentId, new Map());
    const periods = byEmployment.get(r.employmentId)!;
    if (!periods.has(r.payPeriod)) periods.set(r.payPeriod, new Set());
    if (r.detectorId) periods.get(r.payPeriod)!.add(r.detectorId);
  }

  // ── 4. Judge each closure against the employee's NEXT appearance only. ──────────────────────────────
  return candidates.map((c) => {
    const periods = byEmployment.get(c.employmentId);
    const next = periods ? [...periods.keys()].filter((p) => p > c.payPeriod).sort()[0] : undefined;

    // Never run since. Unknowable, and deliberately NOT counted as "held" — a fix nobody has tested is
    // not a fix that worked, and rolling it into the success column is the flattering direction. This
    // distinction is the whole reason `agreementView` can tell "no closure has failed" from "no closure
    // has been tried yet"; collapsing the two would put the fabricated 0% straight back on the screen.
    if (next === undefined) {
      return { ...c, status: 'pending' as const, nextPeriod: null, recurred: [] };
    }

    const closedDetectors = detectorsOf.get(c.verdictId) ?? new Set<string>();
    const recurred = [...(periods!.get(next) ?? new Set<string>())]
      .filter((d) => closedDetectors.has(d))
      .sort();

    return recurred.length === 0
      ? { ...c, status: 'held' as const, nextPeriod: next, recurred: [] }
      : { ...c, status: 'recurred' as const, nextPeriod: next, recurred };
  });
}

/**
 * Write the reversals `classifyClosures` found. The only writer of `agent_proposal.reversed_at`.
 *
 * Idempotent: a reversed proposal is filtered out of the candidate set on the next pass, so running this
 * twice in one night writes nothing the second time.
 */
export async function mineClosureRecurrences(ctx: SessionContext): Promise<RecurrenceMiningResult> {
  const outcomes = await classifyClosures(ctx);
  const out: RecurrenceMiningResult = { checked: outcomes.length, reversed: 0, held: 0, pending: 0 };

  for (const o of outcomes) {
    if (o.status === 'pending') {
      out.pending += 1;
    } else if (o.status === 'held') {
      out.held += 1;
    } else {
      // The reason is stored because the rate alone cannot be acted on: an operator reading "reversed"
      // needs to know WHICH check came back and WHEN before they can do anything about it.
      await recordReversal(ctx, {
        proposalId: o.proposalId,
        reason: `recurred_at_${o.nextPeriod}:${o.recurred.join(',')}`,
      });
      out.reversed += 1;
    }
  }

  return out;
}
