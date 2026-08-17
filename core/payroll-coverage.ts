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
 * of a split month must TILE the period — start on the first day, end on the last, each one beginning the
 * calendar day after the previous ends — with no gap (someone is underpaid) and no overlap (someone is
 * paid twice, or two employers each claim the same day).
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
 * SPLIT MONTHS ONLY. An employment whose entity history resolves to ONE segment over the period is not
 * examined at all: there is nothing to tile, its single payslip covers the whole month by definition, and
 * every run in this system before an entity transfer existed is untouched by this file. That is the
 * additive guarantee, and it is by construction rather than by comparison.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { payrollBatch, payslip } from '../db/schema';
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
 * Claims are CLAMPED to the period first: a payslip's coverage is always inside its own pay period, but
 * clamping means a legacy row read as "the whole period" and a future off-by-one can never make the walk
 * step outside the month it is checking.
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
  /** What the entity history says the month is made of. Tiles the period by construction (the resolver). */
  expected: CompanySegment[];
  /** What has actually been issued, across every company's REGULAR batch for this period. */
  claims: CoverageClaim[];
  /** Where the issued set fails to tile the period. Empty ⇒ the month adds up. */
  defects: CoverageDefect[];
  /** Segment companies with NO regular batch at all for this period — nothing exists that could pay them. */
  missingCompanyIds: string[];
  /**
   * Counterpart regular batches — another employer's run for the same period that owes, or has issued,
   * part of this month. `stale` means it is PROCESSED and its coverage no longer agrees with the entity
   * history, so it must be reprocessed before the month can be closed.
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
  const splitIds = ids.filter((id) => (segmentsByEmp.get(id)?.length ?? 0) > 1);
  if (splitIds.length === 0) return [];

  // Every REGULAR batch of this period, whatever company it belongs to. RLS fences the tenant; the
  // period string is the join key because `pay_period` rows are per company and a cross-company read
  // cannot go through one of them.
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
            inArray(payslip.employmentId, splitIds),
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

  return splitIds.map((employmentId) => {
    const expected = segmentsByEmp.get(employmentId) ?? [];
    const claims = claimsByEmp.get(employmentId) ?? [];
    const claimByCompany = new Map(claims.map((c) => [c.companyId, c]));
    const missingCompanyIds: string[] = [];
    const counterparts: EmploymentCoverage['counterparts'] = [];
    for (const seg of expected) {
      const batch = regularBatchByCompany.get(seg.companyId);
      if (!batch) {
        missingCompanyIds.push(seg.companyId);
        continue;
      }
      const claim = claimByCompany.get(seg.companyId);
      // Stale means "processed, and what it issued is not what the history now says it owes" — either no
      // payslip for this person at all, or one whose window has moved. A DRAFT run owes nothing yet: it
      // recalculates by being generated, and marking it would be noise on a run with no figures in it.
      const stale = batch.status === 'processed' && (!claim || claim.from !== seg.from || claim.to !== seg.to);
      counterparts.push({ batchId: batch.id, companyId: seg.companyId, status: batch.status, stale });
    }
    return {
      employmentId,
      expected,
      claims,
      defects: coverageDefects({ from: p.periodStart, to: p.periodEnd }, claims),
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
    super(
      `This payroll run cannot be closed: ${problems.length} employee${problems.length === 1 ? '' : 's'} ` +
        `changed company inside this period and their payslips do not cover the month exactly ` +
        `(${gaps} unpaid stretch${gaps === 1 ? '' : 'es'}, ${overlaps} paid twice). ` +
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
 * All three are caught by `PayrollCoverageIncompleteError` at close, which is where the money is final.
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
