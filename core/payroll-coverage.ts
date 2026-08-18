/**
 * 1b0943d5 — THE COMPLETENESS CONTROL: does a transferred month actually add up?
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * THIS IS A DELIVERABLE, NOT A SAFETY NET BOLTED ONTO ONE
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-14 employee 100814's August was reprocessed on production. The run produced ONE payslip for
 * 21 days (6,600 ÷ 31 × 21 = 4,470.97) and the Fiamma counterpart for 1–10 August (2,129.03) was never
 * created — because every company has its OWN batch for a period and `reprocessSelectedEmployees`
 * recomputes strictly within the ONE batch it is given. The employee was short 2,129.03.
 *
 * IT WAS CAUGHT ONLY BECAUSE THE BATCH TOTAL FELL BY EXACTLY THE MISSING AMOUNT and somebody was looking.
 * That is luck. This module is what turns it into something the system says out loud: the entity segments
 * of a split month must TILE the days the person was employed for — start on the first such day, end on
 * the last, each one beginning the calendar day after the previous ends — with no gap (someone is
 * underpaid) and no overlap (someone is paid twice, or two employers each claim the same day).
 *
 * "The days the person was employed for" is the pay period intersected with the employment's own tenure,
 * and for ~every employment that IS the pay period. It matters for the one who was hired or terminated
 * inside the month it split: demanding that their payslips tile all of August would report the fortnight
 * before they were hired as an unpaid stretch. See `EmploymentCoverage.window`.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY IT IS A TILING CHECK AND NOT A SUM
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * "Do the two payslips add up to a month's salary?" is the obvious check and it is the wrong one. The two
 * halves are two INDEPENDENT statutory computations under two employers, each with its own allowances,
 * its own one-off transactions, its own unpaid days and its own ceilings — so their gross figures are not
 * required to sum to anything in particular, and a control that demanded it would fire constantly on
 * correct payroll. What IS invariant, always, is the CALENDAR: every day of the period belongs to exactly
 * one employer. Tiling tests that, it needs no money at all, and it would have caught the r194 shortfall
 * on its first assertion.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS AND IS NOT COUNTED
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * REGULAR RUNS ONLY. A period may also hold off-cycle, bonus and adjustment runs (`payroll_batch.run_type`,
 * ADR-0024); those are supplementary payments over the SAME days the regular run already covers, so
 * counting them would report an overlap on every correctly-run month that ever paid a bonus. At most one
 * regular batch exists per (company, period) — `payroll_batch_one_regular_uq` — so the regular runs of a
 * period form exactly the partition this check needs.
 *
 * SPLIT MONTHS ONLY, AND A MONTH IS SPLIT IF EITHER THE HISTORY OR A PAYSLIP SAYS SO. The usual answer is
 * the resolver's: an employment whose entity history resolves to ONE segment over the period is not
 * examined at all — there is nothing to tile, its single payslip covers the whole month by definition, and
 * every run in this system before an entity transfer existed is untouched by this file. That is the
 * additive guarantee, and it is by construction rather than by comparison.
 *
 * The second answer exists because the first is asked of TODAY'S history, which a correction can move
 * after the payslips are written: re-date a recorded transfer, or reverse it, and a month that was split
 * when the slip was issued is not split any more. The slip is still there claiming ten days of it. So a
 * caller may name employments whose slip covers less than its period (`partialClaimIds`) and they are
 * examined whatever the resolver now says — see that field. Nothing else changes: the resolver still
 * supplies `expected`, and it is the arms that report the disagreement.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { employment, payrollBatch, payslip } from '../db/schema';
import type { Tx } from '../db/client';
import { companySegmentsForPeriodBulk, dayAfter, dayBefore, type CompanySegment } from './employment-company';
import { payslipCoverage } from './payslip-segment';

/** One employer's claim on part of a pay period, read off an issued payslip. Inclusive on both ends. */
export type CoverageClaim = {
  batchId: string;
  companyId: string;
  batchStatus: string;
  from: string;
  to: string;
};

/** A day range of the period that no payslip claims (`gap`) or that more than one claims (`overlap`). */
export type CoverageDefect = { kind: 'gap' | 'overlap'; from: string; to: string };

const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

/**
 * THE TILING ARITHMETIC. Pure, and deliberately the only place it exists.
 *
 * Walks the period one claim at a time in date order, holding a cursor on the first day nothing has yet
 * claimed. A claim that starts after the cursor leaves a GAP; one that starts before it OVERLAPS what has
 * already been counted; one that starts exactly on it tiles cleanly and moves the cursor to the day after
 * it ends. Anything left when the claims run out is a trailing gap.
 *
 * Claims are CLAMPED to `period` first: a payslip's coverage is always inside its own pay period, but
 * clamping means a legacy row read as "the whole period" and a future off-by-one can never make the walk
 * step outside the range it is checking.
 *
 * `period` is the range that must be tiled — the pay period for a whole-month employment, the employment's
 * own tenure inside it for someone hired or terminated mid-month (`EmploymentCoverage.window`). Clamping
 * is what lets a whole-month slip satisfy a mid-month joiner's shorter window without a special case.
 */
export function coverageDefects(
  period: { from: string; to: string },
  claims: { from: string; to: string }[],
): CoverageDefect[] {
  if (period.from > period.to) return [];
  const defects: CoverageDefect[] = [];
  const sorted = [...claims]
    .map((c) => ({ from: maxDate(c.from, period.from), to: minDate(c.to, period.to) }))
    .filter((c) => c.from <= c.to)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  let cursor = period.from; // the first day of the period nothing has claimed yet
  for (const c of sorted) {
    if (c.from > cursor) defects.push({ kind: 'gap', from: cursor, to: dayBefore(c.from) });
    else if (c.from < cursor) defects.push({ kind: 'overlap', from: c.from, to: minDate(c.to, dayBefore(cursor)) });
    cursor = maxDate(cursor, dayAfter(c.to));
  }
  if (cursor <= period.to) defects.push({ kind: 'gap', from: cursor, to: period.to });
  return defects;
}

/** Everything the control knows about one employment's split month. */
export type EmploymentCoverage = {
  employmentId: string;
  /**
   * The days of the period this employment must be paid for by SOMEBODY: the pay period intersected with
   * the employment's own tenure (`hired_on` … `terminated_on`). For ~every employment that is the whole
   * period; for one hired or terminated inside it, it is the part they were employed for. The tiling is
   * tested over THIS, not over the bare calendar month — otherwise somebody hired on the 15th and
   * transferred on the 25th would be reported as unpaid for the first fortnight, which is not a defect,
   * it is a fortnight they did not work here.
   */
  window: { from: string; to: string };
  /** What the entity history says the month is made of. Tiles `window` by construction (the resolver). */
  expected: CompanySegment[];
  /** What has actually been issued, across every company's REGULAR batch for this period. */
  claims: CoverageClaim[];
  /** Where the issued set fails to tile `window`. Empty ⇒ every day of it is claimed exactly once. */
  defects: CoverageDefect[];
  /** Segment companies with NO regular batch at all for this period — nothing exists that could pay them. */
  missingCompanyIds: string[];
  /**
   * Counterpart regular batches — another employer's run for the same period that owes, or has issued,
   * part of this month, plus this run's own entry so the control can check the batch in front of it by
   * the same rule.
   *
   * `stale` means "this employer's run has NOT issued exactly the days the entity history says it owes" —
   * either no payslip for this person on it at all, or one whose window has moved since. It is
   * deliberately INDEPENDENT of the batch's status; what makes a segment paid is a payslip, never a
   * batch's existence. See `segmentedCoverage` for why a DRAFT counterpart is stale rather than excused.
   */
  counterparts: { batchId: string; companyId: string; status: string; stale: boolean }[];
};

/**
 * The coverage picture for every SPLIT employment in a set, across every employer's regular batch for the
 * period. Employments whose month is not split are omitted entirely — see the module note.
 *
 * `currentCompanyById` feeds the resolver's fallback (an employment absent from it is skipped rather than
 * guessed at), exactly as `companySegmentsForPeriodBulk` documents.
 *
 * ⚠️ RLS FENCES THE SIBLING BATCHES, AND THE CONSEQUENCE IS A REFUSAL RATHER THAN A WRONG ANSWER. The
 * batch read below is subject to the caller's company scope, so an operator who administers ONLY the
 * incoming entity cannot see the outgoing entity's run for the period. Its segment then reports as
 * `missingCompanyIds` and the close is refused. That is the deliberate bias: what this control exists to
 * prevent is somebody being paid for two thirds of a month, and an operator who cannot see the other
 * employer's run also cannot confirm it has paid. The way out is a group-wide operator, or one scoped to
 * both entities — which is who performs an entity transfer in the first place, and the same population
 * `employedByCompanyDuring` documents for the widened membership predicate.
 */
export async function segmentedCoverage(
  tx: Tx,
  p: {
    payPeriod: string;
    periodStart: string;
    periodEnd: string;
    employmentIds: string[];
    currentCompanyById: Map<string, string>;
    /**
     * EMPLOYMENTS TO EXAMINE EVEN WHEN TODAY'S HISTORY RESOLVES THEIR MONTH TO ONE SEGMENT — the ones
     * whose payslip on the run in front of the caller claims LESS than the pay period.
     *
     * The split test below asks the entity spine AS IT STANDS NOW, and that is a different fact from what
     * the payslips claim. An ordinary correction makes the two disagree: a transfer effective 11 August is
     * recorded, the outgoing employer's run writes a correct 01–10 August slip, and the movement is then
     * re-dated to September or reversed (`reverseLegTx` supersedes the assignment leg and restores
     * `employment.company_id`). August now resolves to a SINGLE segment, and without this the employment
     * is dropped here — before any arm is evaluated — leaving a run that paid ten days of a month it owns
     * all thirty-one of, with nothing to refuse the close.
     *
     * So a slip narrower than its period is itself a claim that the month was split, and it is read as
     * one. It changes nothing else: `expected` is still whatever the resolver says (one segment ⇒ that
     * employer owns the whole window), so `counterparts[].stale` reports the slip that no longer matches
     * it and `defects` reports the days it left behind. A slip covering its whole period says nothing
     * about a split and never appears in this set, which is every payslip on every ordinary run.
     */
    partialClaimIds?: string[];
  },
): Promise<EmploymentCoverage[]> {
  const ids = [...new Set(p.employmentIds)];
  if (ids.length === 0) return [];
  const segmentsByEmp = await companySegmentsForPeriodBulk(
    tx,
    ids,
    p.periodStart,
    p.periodEnd,
    p.currentCompanyById,
  );
  const partialClaim = new Set(p.partialClaimIds ?? []);
  const examineIds = ids.filter((id) => (segmentsByEmp.get(id)?.length ?? 0) > 1 || partialClaim.has(id));
  if (examineIds.length === 0) return [];

  // The employment's own tenure inside the period — see `EmploymentCoverage.window`. Read for the
  // EXAMINED employments only, which is a handful on the rare run that has any.
  const tenureRows = await tx
    .select({ id: employment.id, hiredOn: employment.hiredOn, terminatedOn: employment.terminatedOn })
    .from(employment)
    .where(inArray(employment.id, examineIds));
  const tenureById = new Map(tenureRows.map((r) => [r.id, r] as const));

  // Every REGULAR batch of this period, whatever company it belongs to. RLS fences the tenant; the
  // period string is the join key because `pay_period` rows are per company and a cross-company read
  // cannot go through one of them.
  //
  // ── NO STATUS FILTER, AND A DRAFT COUNTERPART SATISFIES NOTHING. Those two statements go together and
  // both are deliberate.
  //
  // The read is unfiltered because a batch's status is not what makes a segment paid — a PAYSLIP is —
  // and because `generatePayslips` calls this from INSIDE its own transaction, where its slips are
  // already written and its own batch is still `draft` for a few more statements. A status filter here
  // would blind the control to the very run it is checking.
  //
  // What must NOT happen is the opposite error, and it is the one that shipped: treating the mere
  // EXISTENCE of a counterpart batch as covering the days it names. A draft run has issued nothing, can
  // still be deleted, and may never be generated at all — so an August where Fiamma's slip was written
  // before the transfer was recorded, and ISEDECOR's run sits in draft, would close with the whole month
  // claimed by the wrong employer and the right one never paid. That is why `stale` below asks about the
  // PAYSLIP and not about the status: a draft counterpart is stale exactly like a missing one, and close
  // refuses on it. Generation still does not refuse on a draft counterpart (that would deadlock the pair
  // — whichever company ran first would be blocked by the one that had not run yet); close is where every
  // excuse has expired, and there is no deadlock there because closing A only needs B to have PROCESSED,
  // not to have closed.
  const batches = await tx
    .select({
      id: payrollBatch.id,
      companyId: payrollBatch.companyId,
      status: payrollBatch.status,
    })
    .from(payrollBatch)
    .where(and(eq(payrollBatch.payPeriod, p.payPeriod), eq(payrollBatch.runType, 'regular')));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const regularBatchByCompany = new Map(batches.map((b) => [b.companyId, b]));

  const slipRows = batches.length
    ? await tx
        .select({
          batchId: payslip.batchId,
          employmentId: payslip.employmentId,
          coverageFrom: payslip.coverageFrom,
          coverageTo: payslip.coverageTo,
          statutory: payslip.statutory,
        })
        .from(payslip)
        .where(
          and(
            inArray(payslip.employmentId, examineIds),
            inArray(
              payslip.batchId,
              batches.map((b) => b.id),
            ),
          ),
        )
    : [];

  const claimsByEmp = new Map<string, CoverageClaim[]>();
  for (const r of slipRows) {
    const b = batchById.get(r.batchId);
    if (!b) continue;
    const window = payslipCoverage(r, { from: p.periodStart, to: p.periodEnd });
    const list = claimsByEmp.get(r.employmentId) ?? [];
    list.push({ batchId: r.batchId, companyId: b.companyId, batchStatus: b.status, ...window });
    claimsByEmp.set(r.employmentId, list);
  }

  return examineIds.map((employmentId) => {
    const expected = segmentsByEmp.get(employmentId) ?? [];
    const claims = claimsByEmp.get(employmentId) ?? [];
    const claimByCompany = new Map(claims.map((c) => [c.companyId, c]));
    const tenure = tenureById.get(employmentId);
    const window = {
      from: tenure?.hiredOn ? maxDate(p.periodStart, tenure.hiredOn) : p.periodStart,
      to: tenure?.terminatedOn ? minDate(p.periodEnd, tenure.terminatedOn) : p.periodEnd,
    };
    const missingCompanyIds: string[] = [];
    const counterparts: EmploymentCoverage['counterparts'] = [];
    for (const seg of expected) {
      const batch = regularBatchByCompany.get(seg.companyId);
      if (!batch) {
        missingCompanyIds.push(seg.companyId);
        continue;
      }
      const claim = claimByCompany.get(seg.companyId);
      // "This employer's run has not issued exactly the days the history says it owes." No payslip for
      // this person on it, or one whose window has moved — and the batch's STATUS is deliberately not
      // part of the test, because a run that has not paid somebody has not paid them whatever colour its
      // status is. A caller that needs to treat the statuses differently reads `status` beside this (as
      // `generatePayslips` does: it REFUSES on a closed counterpart, MARKS a processed one, and leaves a
      // draft one alone until close).
      const stale = !claim || claim.from !== seg.from || claim.to !== seg.to;
      counterparts.push({ batchId: batch.id, companyId: seg.companyId, status: batch.status, stale });
    }
    return {
      employmentId,
      window,
      expected,
      claims,
      defects: coverageDefects(window, claims),
      missingCompanyIds,
      counterparts,
    };
  });
}

/**
 * A transferred month that does not add up, refused at the point the figures become final.
 *
 * It names the employments so the operator can go straight to them, mirroring
 * BatchNeedsRecalculationError and BatchHasBlockingAnomaliesError, and carries the defects so a screen (or
 * a support engineer reading a log) can say WHICH days are unpaid or double-paid rather than only that
 * something is wrong.
 */
export class PayrollCoverageIncompleteError extends Error {
  constructor(public readonly problems: EmploymentCoverage[]) {
    const gaps = problems.reduce((n, e) => n + e.defects.filter((d) => d.kind === 'gap').length, 0);
    const overlaps = problems.reduce((n, e) => n + e.defects.filter((d) => d.kind === 'overlap').length, 0);
    // The third count is NOT a third kind of defect — it is the same month failing to add up, seen from
    // the run that owes rather than from the calendar. A counterpart whose slip still claims the whole
    // month leaves no gap at all (its days ARE claimed, by the wrong employer), so a message that only
    // counted gaps and overlaps would read "0 unpaid stretches, 0 paid twice" on a refusal.
    const owed = problems.reduce((n, e) => n + e.counterparts.filter((c) => c.stale).length, 0);
    super(
      `This payroll run cannot be closed: ${problems.length} employee${problems.length === 1 ? '' : 's'} ` +
        `changed company inside this period and their payslips do not cover the month exactly ` +
        `(${gaps} unpaid stretch${gaps === 1 ? '' : 'es'}, ${overlaps} paid twice, ` +
        `${owed} run${owed === 1 ? '' : 's'} that has not issued the days it owes). ` +
        `Process or reprocess the other company's run for the same period first.`,
    );
    this.name = 'PayrollCoverageIncompleteError';
  }
  get employmentIds(): string[] {
    return this.problems.map((p) => p.employmentId);
  }
}

/**
 * A run that would leave part of a transferred month permanently unpayable, refused BEFORE it commits.
 *
 * This is the one refusal that fires while payslips are being WRITTEN rather than closed, and it is
 * deliberately narrow: the counterpart employer's run for this period is CLOSED. A closed run is frozen
 * (migration 0011's trigger is the DB backstop), so the days it owes cannot be added to it by any
 * ordinary operation — the shortfall would be permanent and silent, which is exactly the r194 outcome.
 *
 * WHY THE OTHER SHAPES ARE NOT REFUSED HERE, each for its own reason:
 *   • counterpart batch is DRAFT — it has not been run yet. Refusing would deadlock the pair: neither
 *     company could ever go first;
 *   • counterpart batch is PROCESSED but owes a segment — recoverable, and it is MARKED (needsRecalc) so
 *     the operator is told, and Close on that run is already refused until it is dealt with;
 *   • counterpart batch does not EXIST — recoverable by creating it, and Close refuses meanwhile.
 * All three are caught by `PayrollCoverageIncompleteError` at close, which is where the money is final:
 * the draft and the processed-but-owing counterpart both report `stale` (they have issued no payslip for
 * these days), and the absent one reports `missingCompanyIds`. Creating an empty draft run for the other
 * company therefore does NOT unblock a close — only issuing the payslip does.
 */
export class PayrollCounterpartClosedError extends Error {
  constructor(public readonly details: { employmentId: string; companyId: string; from: string; to: string }[]) {
    super(
      `This run would leave ${details.length} employee${details.length === 1 ? '' : 's'} short: they changed ` +
        `company inside this period, and the other company's run for the same period is already CLOSED, so ` +
        `the days it owes can no longer be paid on it. Unlock that run before processing this one.`,
    );
    this.name = 'PayrollCounterpartClosedError';
  }
  get employmentIds(): string[] {
    return this.details.map((d) => d.employmentId);
  }
}
