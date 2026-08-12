/**
 * Back Pay (Arrears) — item 2ef69d1e, pass 1.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE: A CLOSED PAYSLIP IS NEVER RECOMPUTED.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Back pay is a NEW payable difference that rides the CURRENT run — not an edit to history. Nothing in
 * this file writes `payslip`, reopens a batch, or asks `generatePayslips` for a preview: its
 * `reprocessSubset` path REPLACES payslips and the golden tests demand byte-identical payroll output, so
 * borrowing it would rewrite months employees have already seen. What this file does instead is a
 * READ-ONLY difference engine, and the only employee-visible write the whole feature performs is ordinary
 * `payroll_individual_txn` rows on the TARGET (current) period — which is also why the arrears attract
 * EPF/SOCSO/PCB in the month they are actually paid.
 *
 * ── HOW DETECTION WORKS, AND WHY THE OBVIOUS QUERY IS WRONG ───────────────────────────────────────────
 *
 * The obvious query is "a compensation row whose valid_from precedes the last payslip". On production
 * that returns 41 rows across 36 employees, and it is WRONG: it is just a restatement of "everyone has a
 * salary", because every open salary record predates the payroll that paid it.
 *
 * The question is not when the revision TAKES EFFECT, it is when it was KEYED. `compensation.recorded_at`
 * against `payslip.created_at` answers exactly that: a row recorded AFTER the run that should have used
 * it is a row the run could not possibly have seen. Measured on production 2026-08-06 that is **26
 * compensation rows across 22 employees and 3 periods**, 9 of them carrying a real salary difference —
 * which is the number this detector is calibrated against.
 *
 * Detection watches the COMPENSATION ROW, not the Movement module, because a movement is only one of five
 * writers (`setCompensationAction` on the Basic Salary card, `core/movement.ts`, merit enactment in
 * `core/performance.ts`, hire via `core/employee-draft.ts`, and `core/import.ts`). Keying detection to
 * Movement would miss four of the five paths.
 *
 * ── HOW THE DIFFERENCE IS COMPUTED, AND WHY THE PAYSLIP IS THE ANCHOR ─────────────────────────────────
 *
 * The stored payslip keeps TOTALS, not a breakdown: basic_salary, allowance, overtime_pay, bonus,
 * days_worked, gross, statutory, net. Item-level originals exist only for typed items in
 * `payroll_batch_component`. So the engine never claims a breakdown it does not have — it anchors on the
 * figure that was actually paid:
 *
 *   oldBasic  = the monthly basic of the compensation row the run could SEE (recorded_at <= the payslip's
 *               created_at, greatest valid_from — the row that was open then, which is what the kernel
 *               reads: `validTo IS NULL AND supersededAt IS NULL`).
 *   paidBasic = payslip.basic_salary — what the run actually paid. Authoritative; never re-derived.
 *   factor    = paidBasic / oldBasic. This reproduces WHATEVER the run did to the monthly figure (the
 *               EA-1955 join/resign tenure factor, a working-day divisor, a cut-off window) without
 *               re-deriving any of it. That is the whole trick, and it is why this engine cannot drift
 *               from the kernel's proration rules: it never computes them.
 *   newBasic  = the day-weighted average monthly basic actually in force across the period under the
 *               CURRENT history. Day-weighted so a rise effective the 15th pays 17/31 of the increase,
 *               and weighted over the days a salary record COVERS (not over days-in-month), so a
 *               mid-month hire is not prorated twice — `factor` already carries the tenure part.
 *
 * Every pay item then follows for free, because `resolvePayRule` / `resolvePayComponentSet`
 * (core/pay-rule.ts) are PURE and their scope is { basic, daysWorked, hours, components }. "Any item you
 * have set up as a calculation off basic salary follows the new figure automatically" is therefore a
 * difference of two calls to the SAME evaluator the payroll run uses — no second formula engine, and no
 * chance of the two disagreeing. Transitive dependencies and the `fixed_allowances` aggregate come along
 * because it is the whole SET that is resolved twice, not one rule at a time.
 *
 * ── WHAT THIS ENGINE HONESTLY CANNOT DO, AND SAYS SO ──────────────────────────────────────────────────
 *
 * A needs-review line carries a stable reason code, asserts NO figure, and is EXCLUDED from the posted
 * total. Each reason names the STORED FACT that forces it:
 *  - `manualOvertime`   — `payroll_input.overtime_amount` is RM, "not hours" (db/schema.ts). Only a money
 *                         amount was ever kept, so there is nothing to re-price at the new wage basis.
 *  - `overtimeDeferred` — attendance-sourced OT IS re-priceable, but the approved plan sequences overtime
 *                         arrears into pass 2, after the Attendance Calculation Engine item that changes
 *                         how OT is categorised. Computing it now would mean verifying it twice.
 *  - `hoursNotStored`   — a pay item whose rule reads `hours`. days_worked is on the payslip; hours are not.
 *  - `blendedOriginal`  — more than one salary record was visible to the run for that period (the kernel's
 *                         mid-period increment blend), so `paidBasic / oldBasic` is not a proration factor
 *                         and the anchor does not hold. Refusing beats guessing.
 *  - `nonMonthlyPayMode`— a daily/hourly employee is paid rate × days/hours, so a basic-salary revision is
 *                         not what moved their pay. Out of scope for pass 1 rather than silently wrong.
 *  - `nonPayableItem`   — a BIK/record-only item. The kernel records it and never pays it, so a difference
 *                         on it is not money.
 *  - `unpaidLeaveInPeriod` — THE MONTH IS REFUSED WHOLE. The kernel's unpaid-leave deduction is
 *                         `basicRaw / unpaidDivisor × unpaidDays`, a SEPARATE figure that is not netted
 *                         into `payslip.basic_salary`, so a backdated rise raises it too. Reworking only
 *                         the basic would OVERPAY such a month. Pass 2 owns unpaid-leave arrears; pass 1
 *                         will not guess, and under-paying with an explanation beats overpaying quietly.
 *
 * ── SIGN ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `difference` is SIGNED and money moves BOTH ways: production carries a 6000 → 5500 revision. A positive
 * total posts as an `earning`, a negative one as a `deduction` — `payroll_individual_txn` amounts are
 * MAGNITUDES and the `kind` carries the sign (createIndividualTxn* rejects a non-positive amount). Any
 * test that assumes arrears are owed to the employee is wrong about this data.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  appUser,
  backPayLine,
  backPayRun,
  company,
  compensation,
  employment,
  employmentPayComponent,
  payComponent,
  payrollBatch,
  payrollBatchComponent,
  payrollIndividualTxn,
  payrollInput,
  payslip,
  person,
  type PayRule,
} from '../db/schema';
import {
  BASIC_PAY_CODE,
  payRuleDependencies,
  resolvePayComponentSet,
  type ResolvablePayComponent,
} from './pay-rule';
import { unpaidDaysByEmployment } from './payroll';
import { insertIndividualTxnsTx } from './payroll-individual-txn';

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number): string => n.toFixed(2);

/** Pay codes seeded on first use so a posting is labelled on the payslip rather than arriving as an
 *  unnamed one-off. Two, not one: a NEGATIVE run posts as a deduction and a deduction row must name a
 *  `deduction`-kind item (core/payroll-individual-txn.ts COMPONENT_KIND_TO_TXN_KIND). */
export const BACK_PAY_EARNING_CODE = 'BACKPAY';
export const BACK_PAY_DEDUCTION_CODE = 'BACKPAY_RECOVERY';

export const BACK_PAY_STATUSES = ['draft', 'verified', 'posted', 'cancelled'] as const;
export type BackPayStatus = (typeof BACK_PAY_STATUSES)[number];

/** Stable reason codes — the UI maps these to localised strings; no raw English leaves this module. */
export const BACK_PAY_REVIEW_REASONS = [
  'manualOvertime',
  'overtimeDeferred',
  'hoursNotStored',
  'blendedOriginal',
  'nonMonthlyPayMode',
  'nonPayableItem',
  'noBaselineSalary',
  'unpaidLeaveInPeriod',
] as const;
export type BackPayReviewReason = (typeof BACK_PAY_REVIEW_REASONS)[number];

export class BackPayRunNotFoundError extends Error {
  constructor() {
    super('back-pay-run-not-found');
    this.name = 'BackPayRunNotFoundError';
  }
}
/** Thrown when a transition is asked of a run that is not in the state it needs to be in. */
export class BackPayStatusError extends Error {
  constructor(public readonly status: string, public readonly wanted: string) {
    super(`back-pay-status:${status}:${wanted}`);
    this.name = 'BackPayStatusError';
  }
}
/** Thrown when the TARGET period's payroll run is already processed or closed. Posting into it would
 *  make its figures disagree with its inputs, and cancelling out of it would silently unpay somebody. */
export class BackPayTargetRunNotDraftError extends Error {
  constructor(public readonly status: string) {
    super(`back-pay-target-run-not-draft:${status}`);
    this.name = 'BackPayTargetRunNotDraftError';
  }
}
/** Thrown when calculate finds nothing to pay — a run with no lines is not a run. */
export class BackPayNothingToCalculateError extends Error {
  constructor() {
    super('back-pay-nothing-to-calculate');
    this.name = 'BackPayNothingToCalculateError';
  }
}

// ───────────────────────────────── period arithmetic ─────────────────────────────────

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isBackPayPeriod = (v: unknown): v is string => typeof v === 'string' && PERIOD_RE.test(v);

const daysInMonth = (y: number, m1: number): number => new Date(Date.UTC(y, m1, 0)).getUTCDate();

/** [first day, last day] of a 'YYYY-MM' period, as ISO date strings. */
export function periodBounds(period: string): { start: string; end: string; dim: number } {
  const [y, m] = period.split('-').map(Number);
  const dim = daysInMonth(y, m);
  return { start: `${period}-01`, end: `${period}-${String(dim).padStart(2, '0')}`, dim };
}

/** Day index within the month, 1-based, clamped into [1, dim]. */
const dayOf = (iso: string): number => Number(iso.slice(8, 10));

// ───────────────────────────────── detection ─────────────────────────────────

/** One backdated salary revision that a closed payroll never saw. */
export type ArrearsCandidate = {
  compensationId: string;
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  /** The revision's effective date and the salary it sets. */
  validFrom: string;
  newBasic: number;
  recordedAt: Date;
  /** 'YYYY-MM' periods already paid that this revision should have affected, oldest first. */
  affectedPeriods: string[];
};

/**
 * Every OPEN, non-superseded compensation row that was RECORDED AFTER a processed/closed payroll it
 * should have affected — minus any already carried by a live (non-cancelled) back pay run.
 *
 * The `recorded_at > payslip.created_at` clause is the whole detector. See the file header for why the
 * effective-date form of this query is wrong.
 */
export function detectArrears(ctx: SessionContext, p: { companyId: string }): Promise<ArrearsCandidate[]> {
  return withTenant(ctx, (tx) => detectArrearsTx(tx, p));
}

/**
 * The tx-level detector. `calculateBackPay` calls THIS rather than `detectArrears` so detection and
 * computation share one transaction — a revision that becomes covered by another run in between would
 * otherwise be paid twice, which is the exact failure the duplicate guard exists to prevent.
 */
async function detectArrearsTx(tx: Tx, p: { companyId: string }): Promise<ArrearsCandidate[]> {
  const rows = await tx
    .select({
      compensationId: compensation.id,
      employmentId: compensation.employmentId,
      employeeName: person.fullName,
      employeeCode: employment.employeeCode,
      validFrom: compensation.validFrom,
      basicSalary: compensation.basicSalary,
      recordedAt: compensation.recordedAt,
      payPeriod: payrollBatch.payPeriod,
    })
    .from(compensation)
    .innerJoin(employment, eq(employment.id, compensation.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .innerJoin(payslip, eq(payslip.employmentId, compensation.employmentId))
    .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
    .where(
      and(
        eq(employment.companyId, p.companyId),
        isNull(compensation.supersededAt),
        inArray(payrollBatch.status, ['processed', 'closed']),
        // The revision should have affected that month: it takes effect on or before its last day.
        sql`${compensation.validFrom} < ((${payrollBatch.payPeriod} || '-01')::date + interval '1 month')`,
        // …but the run could not see it. THIS is the detector; the clause above alone is just
        // "everyone has a salary" (41/36 on production, versus the true 26/22).
        sql`${compensation.recordedAt} > ${payslip.createdAt}`,
        // The duplicate guard: a revision already carried by a live run is not detectable again until
        // that run is cancelled.
        sql`not exists (
          select 1 from ${backPayLine} bl
          join ${backPayRun} br on br.id = bl.run_id
          where bl.source_compensation_id = ${compensation.id} and br.status <> 'cancelled'
        )`,
      ),
    );

  const byComp = new Map<string, ArrearsCandidate>();
  for (const r of rows) {
    const hit = byComp.get(r.compensationId);
    if (hit) {
      if (!hit.affectedPeriods.includes(r.payPeriod)) hit.affectedPeriods.push(r.payPeriod);
      continue;
    }
    byComp.set(r.compensationId, {
      compensationId: r.compensationId,
      employmentId: r.employmentId,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
      validFrom: r.validFrom,
      newBasic: Number(r.basicSalary),
      recordedAt: r.recordedAt,
      affectedPeriods: [r.payPeriod],
    });
  }
  const out = [...byComp.values()];
  for (const c of out) c.affectedPeriods.sort();
  out.sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.validFrom.localeCompare(b.validFrom));
  return out;
}

// ───────────────────────────────── the difference engine ─────────────────────────────────

/** One computed line, before it is persisted. */
type ComputedLine = {
  employmentId: string;
  sourceCompensationId: string;
  affectedPeriod: string;
  payCode: string;
  payItemName: string;
  oldAmount: number;
  newAmount: number | null;
  difference: number;
  needsReview: boolean;
  reviewReason: BackPayReviewReason | null;
};

type CompRowLite = { basic: number; validFrom: string; validTo: string | null; recordedAt: Date; payMode: string };

/**
 * The day-weighted average monthly basic in force across [start, end], over the rows given.
 *
 * Weighted by the days each record COVERS within the period and divided by the covered day count — NOT
 * by days-in-month. That distinction is load-bearing: dividing by days-in-month would prorate a
 * mid-month hire a second time, on top of the `factor` this figure is later multiplied by. Returns null
 * when no record covers any day of the period.
 */
export function weightedMonthlyBasic(rows: readonly CompRowLite[], period: string): number | null {
  const { start, end, dim } = periodBounds(period);
  let weighted = 0;
  let covered = 0;
  for (const r of rows) {
    const from = r.validFrom > start ? r.validFrom : start;
    const to = r.validTo != null && r.validTo <= end ? r.validTo : null; // validTo is EXCLUSIVE on compensation
    const lastDay = to != null ? dayOf(to) - 1 : dim;
    const firstDay = dayOf(from);
    if (r.validFrom > end) continue;
    if (r.validTo != null && r.validTo <= start) continue;
    const days = Math.min(lastDay, dim) - firstDay + 1;
    if (days <= 0) continue;
    weighted += r.basic * days;
    covered += days;
  }
  return covered > 0 ? weighted / covered : null;
}

/** Does this rule read `hours`, directly or through another pay item? Hours are not stored on a payslip,
 *  so anything that reads them cannot be reworked and must say so instead of quietly reading 0. */
export function ruleReadsHours(
  code: string,
  byCode: ReadonlyMap<string, PayRule | null>,
  seen = new Set<string>(),
): boolean {
  const key = code.trim().toUpperCase();
  if (seen.has(key)) return false; // a cycle is impossible (planResolutionOrder refuses them); be safe anyway
  seen.add(key);
  const rule = byCode.get(key) ?? null;
  if (rule == null) return false;
  if (rule.kind === 'per_hour') return true;
  if (rule.kind === 'formula') {
    const operands = [rule.start, ...(Array.isArray(rule.terms) ? rule.terms.map((t) => t?.operand) : [])];
    if (operands.some((o) => o != null && o.ref === 'hours')) return true;
  }
  return payRuleDependencies(rule).some((dep) => ruleReadsHours(dep, byCode, seen));
}

/**
 * Compute every arrears line for one company, for the given compensation revisions.
 *
 * Read-only: it opens no batch, writes no payslip and touches nothing the payroll engine owns.
 */
async function computeLinesTx(tx: Tx, p: { candidates: ArrearsCandidate[] }): Promise<ComputedLine[]> {
  const out: ComputedLine[] = [];
  const empIds = [...new Set(p.candidates.map((c) => c.employmentId))];
  if (empIds.length === 0) return out;

  // The whole (non-superseded) salary history of every affected employee, once.
  const histRows = await tx
    .select({
      employmentId: compensation.employmentId,
      basic: compensation.basicSalary,
      validFrom: compensation.validFrom,
      validTo: compensation.validTo,
      recordedAt: compensation.recordedAt,
      payMode: compensation.payMode,
    })
    .from(compensation)
    .where(and(inArray(compensation.employmentId, empIds), isNull(compensation.supersededAt)));
  const historyByEmp = new Map<string, CompRowLite[]>();
  for (const r of histRows) {
    const list = historyByEmp.get(r.employmentId) ?? [];
    list.push({ basic: Number(r.basic), validFrom: r.validFrom, validTo: r.validTo, recordedAt: r.recordedAt, payMode: r.payMode });
    historyByEmp.set(r.employmentId, list);
  }

  // The catalog, once — rule + rank + flags, exactly the columns the kernel reads.
  const catalog = await tx
    .select({
      id: payComponent.id,
      code: payComponent.code,
      name: payComponent.name,
      kind: payComponent.kind,
      rule: payComponent.rule,
      resolutionOrder: payComponent.resolutionOrder,
      prorates: payComponent.prorates,
      rounding: payComponent.roundingMethod,
      nonPayable: payComponent.isNonPayable,
    })
    .from(payComponent);
  const ruleByCode = new Map<string, PayRule | null>(catalog.map((c) => [c.code.trim().toUpperCase(), c.rule]));
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  for (const cand of p.candidates) {
    const history = historyByEmp.get(cand.employmentId) ?? [];
    for (const period of cand.affectedPeriods) {
      const { start: periodStart, end: periodEnd, dim } = periodBounds(period);
      // The payslip that PAID this period for this employee. Newest first: a period can carry more than
      // one run (an additional-remuneration run), and the REGULAR run is the one that paid basic.
      const slips = await tx
        .select({
          id: payslip.id,
          batchId: payslip.batchId,
          basicSalary: payslip.basicSalary,
          daysWorked: payslip.daysWorked,
          createdAt: payslip.createdAt,
          runType: payrollBatch.runType,
        })
        .from(payslip)
        .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
        .where(
          and(
            eq(payslip.employmentId, cand.employmentId),
            eq(payrollBatch.payPeriod, period),
            inArray(payrollBatch.status, ['processed', 'closed']),
          ),
        );
      const slip = slips.find((s) => s.runType === 'regular') ?? slips[0];
      if (!slip) continue;

      const line = (over: Partial<ComputedLine> & Pick<ComputedLine, 'payCode' | 'payItemName'>): ComputedLine => ({
        employmentId: cand.employmentId,
        sourceCompensationId: cand.compensationId,
        affectedPeriod: period,
        oldAmount: 0,
        newAmount: null,
        difference: 0,
        needsReview: false,
        reviewReason: null,
        ...over,
      });

      // What the run could SEE. `recorded_at <= the payslip's created_at` is the same test detection uses,
      // read the other way round.
      const visible = history.filter((h) => h.recordedAt.getTime() <= slip.createdAt.getTime());
      const overlapping = visible.filter(
        (h) => h.validFrom <= periodEnd && (h.validTo == null || h.validTo > periodStart),
      );
      const baseline = [...visible].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0];

      if (!baseline) {
        out.push(line({ payCode: BASIC_PAY_CODE, payItemName: 'Basic Salary', needsReview: true, reviewReason: 'noBaselineSalary' }));
        continue;
      }
      if (baseline.payMode !== 'monthly' && baseline.payMode !== 'custom_period') {
        out.push(line({ payCode: BASIC_PAY_CODE, payItemName: 'Basic Salary', needsReview: true, reviewReason: 'nonMonthlyPayMode' }));
        continue;
      }
      // ── UNPAID LEAVE IN THE MONTH ⇒ REFUSE THE MONTH ──────────────────────────────────────────────
      // The kernel deducts unpaid leave as `basicRaw / unpaidDivisor × unpaidDays`, a SEPARATE figure
      // that is NOT netted into `payslip.basic_salary`. So a backdated rise raises that deduction too,
      // and arrears that reworked only the basic would OVERPAY this month by
      // `(newBasic − oldBasic) / divisor × unpaidDays`. Recomputing the divisor here would mean
      // re-deriving proration settings, cut-off windows and working-day bases — exactly the drift the
      // payslip-as-anchor design exists to avoid — and the approved plan sequences unpaid-leave arrears
      // into pass 2 regardless. So the month is REFUSED with its reason rather than silently overpaid.
      const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd, [cand.employmentId]);
      if ((unpaid.get(cand.employmentId) ?? 0) > 0) {
        out.push(line({ payCode: 'UNPAID', payItemName: 'Unpaid leave', needsReview: true, reviewReason: 'unpaidLeaveInPeriod' }));
        continue;
      }
      if (overlapping.length > 1) {
        // The run blended two straddling records itself, so paidBasic / oldBasic is not a proration
        // factor and the anchor does not hold. Refuse rather than guess.
        out.push(line({ payCode: BASIC_PAY_CODE, payItemName: 'Basic Salary', needsReview: true, reviewReason: 'blendedOriginal' }));
        continue;
      }

      const oldBasic = baseline.basic;
      const paidBasic = Number(slip.basicSalary);
      if (!(oldBasic > 0)) {
        out.push(line({ payCode: BASIC_PAY_CODE, payItemName: 'Basic Salary', needsReview: true, reviewReason: 'noBaselineSalary' }));
        continue;
      }
      // See the file header: this reproduces whatever the run did to the monthly figure without
      // re-deriving any of it.
      const factor = paidBasic / oldBasic;
      const newBasic = weightedMonthlyBasic(history, period);
      if (newBasic == null) continue;

      const reworkedBasic = round2(newBasic * factor);
      const basicDiff = round2(reworkedBasic - paidBasic);
      if (Math.abs(basicDiff) >= 0.01) {
        out.push(
          line({
            payCode: BASIC_PAY_CODE,
            payItemName: 'Basic Salary',
            oldAmount: paidBasic,
            newAmount: reworkedBasic,
            difference: basicDiff,
          }),
        );
      }

      // ── Every pay item calculated off basic salary, for free ──────────────────────────────────────
      // The recurring items in force in this period (the SAME window the kernel filters on) plus the
      // one-offs actually recorded on that batch, resolved TWICE through the kernel's own evaluator.
      const recurring = await tx
        .select({
          componentId: employmentPayComponent.componentId,
          amount: employmentPayComponent.amount,
          prorateOverride: employmentPayComponent.prorateOverride,
        })
        .from(employmentPayComponent)
        .where(
          and(
            eq(employmentPayComponent.employmentId, cand.employmentId),
            lte(employmentPayComponent.validFrom, periodEnd),
            or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
            isNull(employmentPayComponent.supersededAt),
          ),
        );
      const batchComps = await tx
        .select({ componentId: payrollBatchComponent.componentId, amount: payrollBatchComponent.amount })
        .from(payrollBatchComponent)
        .where(
          and(
            eq(payrollBatchComponent.batchId, slip.batchId),
            eq(payrollBatchComponent.employmentId, cand.employmentId),
          ),
        );

      type Entry = ResolvablePayComponent & {
        name: string;
        catalogKind: string;
        prorate: boolean;
        rounding: string;
        isNonPayable: boolean;
      };
      const entries: Entry[] = [];
      for (const r of recurring) {
        const c = catalogById.get(r.componentId);
        if (!c) continue;
        entries.push({
          code: c.code,
          name: c.name,
          rule: c.rule,
          amount: Number(r.amount),
          resolutionOrder: c.resolutionOrder,
          kind: c.kind,
          catalogKind: c.kind,
          nonPayable: c.nonPayable,
          isNonPayable: c.nonPayable,
          prorate: r.prorateOverride ?? c.prorates,
          rounding: c.rounding,
        });
      }
      for (const r of batchComps) {
        const c = catalogById.get(r.componentId);
        if (!c) continue;
        entries.push({
          code: c.code,
          name: c.name,
          rule: c.rule,
          amount: Number(r.amount),
          resolutionOrder: c.resolutionOrder,
          kind: c.kind,
          catalogKind: c.kind,
          nonPayable: c.nonPayable,
          isNonPayable: c.nonPayable,
          // r168 — a BATCH row is a one-off and must NOT count towards the fixed_allowances aggregate.
          oneOff: true,
          prorate: c.prorates,
          rounding: c.rounding,
        });
      }

      if (entries.length > 0) {
        // days_worked is stored; hours are not (see the header) — so `hours: 0` here is only ever read by
        // rules that are flagged needs-review below and whose figures are therefore never used.
        const daysWorked = slip.daysWorked != null ? Number(slip.daysWorked) : dim;
        // e318eaec — `calendarDays` is the month's own length, which this recompute already has as `dim`;
        // it is NOT `daysWorked` (that one carries the tenure factor). Supplying it matters even though no
        // rule here is new: an absent scope input reads as 0, and 0 as a divisor would make an arrears line
        // silently pay nothing rather than reproduce what the run did.
        const base = { daysWorked, hours: 0, calendarDays: dim } as const;
        // `paidBasic` and `reworkedBasic` ARE basic × the run's own factor — the same quantity the kernel
        // calls basicGross and exposes as `prorated_basic` — so the two recomputes read the figure this
        // batch actually paid, and the one it would now pay, rather than a second derivation of either.
        const oldResolved = resolvePayComponentSet(entries, {
          ...base, basic: oldBasic, proratedBasic: paidBasic, components: { [BASIC_PAY_CODE]: oldBasic },
        });
        const newResolved = resolvePayComponentSet(entries, {
          ...base, basic: newBasic, proratedBasic: reworkedBasic, components: { [BASIC_PAY_CODE]: newBasic },
        });
        for (const [i, e] of entries.entries()) {
          if (e.code.trim().toUpperCase() === BASIC_PAY_CODE) continue; // inert in the kernel; already paid above
          const oldVal = round2(applyProration(oldResolved[i], e.prorate, factor, e.rounding));
          const newVal = round2(applyProration(newResolved[i], e.prorate, factor, e.rounding));
          if (Math.abs(newVal - oldVal) < 0.01) continue; // this item does not follow basic — nothing to pay
          if (ruleReadsHours(e.code, ruleByCode)) {
            out.push(line({ payCode: e.code, payItemName: e.name, oldAmount: oldVal, needsReview: true, reviewReason: 'hoursNotStored' }));
            continue;
          }
          if (e.isNonPayable) {
            out.push(line({ payCode: e.code, payItemName: e.name, oldAmount: oldVal, needsReview: true, reviewReason: 'nonPayableItem' }));
            continue;
          }
          // A deduction that grows takes MORE pay away, so its arrears sign is inverted.
          const signed = e.catalogKind === 'deduction' ? round2(oldVal - newVal) : round2(newVal - oldVal);
          out.push(line({ payCode: e.code, payItemName: e.name, oldAmount: oldVal, newAmount: newVal, difference: signed }));
        }
      }

      // ── Overtime: surfaced, never guessed ─────────────────────────────────────────────────────────
      const [input] = await tx
        .select({ overtimeAmount: payrollInput.overtimeAmount, otSource: payrollInput.otSource })
        .from(payrollInput)
        .where(and(eq(payrollInput.batchId, slip.batchId), eq(payrollInput.employmentId, cand.employmentId)))
        .limit(1);
      const ot = input ? Number(input.overtimeAmount) : 0;
      if (ot > 0) {
        out.push(
          line({
            payCode: 'OVERTIME',
            payItemName: 'Overtime',
            oldAmount: ot,
            needsReview: true,
            // Manual OT can NEVER be reworked (only RM was kept). Attendance OT can, but the plan
            // sequences it after the Attendance Calculation Engine item — a different, honest reason.
            reviewReason: input?.otSource === 'manual' ? 'manualOvertime' : 'overtimeDeferred',
          }),
        );
      }
    }
  }
  return out;
}

/** The kernel's own post-resolution shaping: the per-employee prorate override wins over the catalog
 *  flag, then the component's rounding method. Mirrors core/payroll.ts's `roundAmount(prorate ? resolved
 *  * factor : resolved, c.rounding)` so a reworked figure is shaped exactly like the paid one. */
function applyProration(resolved: number, prorate: boolean, factor: number, rounding: string): number {
  const v = prorate ? resolved * factor : resolved;
  switch (rounding) {
    case 'up':
      return Math.ceil(v);
    case 'down':
      return Math.floor(v);
    case 'nearest':
      return Math.round(v);
    default:
      return round2(v);
  }
}

// ───────────────────────────────── run lifecycle ─────────────────────────────────

export type BackPayRunSummary = {
  id: string;
  companyId: string;
  companyName: string;
  targetPayPeriod: string;
  status: BackPayStatus;
  employeeCount: number;
  periodCount: number;
  total: number;
  needsReviewCount: number;
  createdByName: string | null;
  createdAt: Date;
  approvedByName: string | null;
  approvedAt: Date | null;
  postedAt: Date | null;
  cancelledAt: Date | null;
};

/**
 * Calculate a DRAFT run: detect, compute, persist the evidence. Writes nothing but `back_pay_run` /
 * `back_pay_line`, and pays nothing — Approve and Post is the only thing that moves money.
 */
export function calculateBackPay(
  ctx: SessionContext,
  p: { companyId: string; targetPayPeriod: string; compensationIds?: string[]; remarks?: string },
): Promise<{ runId: string; lineCount: number; total: number }> {
  if (!isBackPayPeriod(p.targetPayPeriod)) throw new Error('back-pay-invalid-period');
  return withTenant(ctx, async (tx) => {
    const candidates = await detectArrearsTx(tx, { companyId: p.companyId });
    const wanted = p.compensationIds && p.compensationIds.length > 0 ? new Set(p.compensationIds) : null;
    const selected = wanted ? candidates.filter((c) => wanted.has(c.compensationId)) : candidates;
    const lines = await computeLinesTx(tx, { candidates: selected });
    if (lines.length === 0) throw new BackPayNothingToCalculateError();

    const [run] = await tx
      .insert(backPayRun)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        targetPayPeriod: p.targetPayPeriod,
        status: 'draft',
        createdByUserId: ctx.userId ?? null,
        remarks: p.remarks ?? null,
      })
      .returning({ id: backPayRun.id });

    for (const l of lines) {
      await tx.insert(backPayLine).values({
        tenantId: ctx.tenantId,
        runId: run.id,
        employmentId: l.employmentId,
        sourceCompensationId: l.sourceCompensationId,
        affectedPeriod: l.affectedPeriod,
        payCode: l.payCode,
        payItemName: l.payItemName,
        oldAmount: money(l.oldAmount),
        newAmount: l.newAmount == null ? null : money(l.newAmount),
        difference: money(l.difference),
        needsReview: l.needsReview,
        reviewReason: l.reviewReason,
      });
    }
    const total = round2(lines.reduce((s, l) => s + (l.needsReview ? 0 : l.difference), 0));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'back-pay-run',
      aggregateId: run.id,
      eventType: 'back-pay.calculated',
      actor: actorOf(ctx),
      // ADR-0030 redact-to-reference: counts and references, never a salary difference in the
      // append-only log. The amounts live on back_pay_line, which is RLS-gated to admins.
      payload: {
        companyId: p.companyId,
        targetPayPeriod: p.targetPayPeriod,
        lines: lines.length,
        employees: new Set(lines.map((l) => l.employmentId)).size,
        needsReview: lines.filter((l) => l.needsReview).length,
      },
    });
    return { runId: run.id, lineCount: lines.length, total };
  });
}

// ───────────────────────────────── the verification read model ─────────────────────────────────

export type BackPayGridRow = {
  employmentId: string;
  employeeName: string;
  employeeCode: string | null;
  payCode: string;
  payItemName: string;
  /** period → { old, new, diff } — the "one line per pay item, one column per affected month" grid. */
  byPeriod: Record<string, { old: number; new: number | null; diff: number }>;
  total: number;
  needsReview: boolean;
  reviewReason: BackPayReviewReason | null;
};

export type BackPayRunDetail = {
  run: BackPayRunSummary;
  /** Every affected month, oldest first — the grid's columns. */
  periods: string[];
  rows: BackPayGridRow[];
  /** Signed per-employee totals, which is what actually posts. */
  perEmployee: Array<{ employmentId: string; employeeName: string; employeeCode: string | null; total: number }>;
  total: number;
  /** True while the target period's run is still writable (draft, or not created yet). */
  targetWritable: boolean;
  targetRunStatus: string | null;
};

export function backPayRunDetail(ctx: SessionContext, runId: string): Promise<BackPayRunDetail | null> {
  return withTenant(ctx, async (tx) => {
    const [run] = await tx
      .select({
        id: backPayRun.id,
        companyId: backPayRun.companyId,
        companyName: company.legalName,
        targetPayPeriod: backPayRun.targetPayPeriod,
        status: backPayRun.status,
        createdAt: backPayRun.createdAt,
        approvedAt: backPayRun.approvedAt,
        postedAt: backPayRun.postedAt,
        cancelledAt: backPayRun.cancelledAt,
        createdByUserId: backPayRun.createdByUserId,
        approvedByUserId: backPayRun.approvedByUserId,
      })
      .from(backPayRun)
      .innerJoin(company, eq(company.id, backPayRun.companyId))
      .where(eq(backPayRun.id, runId))
      .limit(1);
    if (!run) return null;

    const lines = await tx
      .select({
        employmentId: backPayLine.employmentId,
        employeeName: person.fullName,
        employeeCode: employment.employeeCode,
        affectedPeriod: backPayLine.affectedPeriod,
        payCode: backPayLine.payCode,
        payItemName: backPayLine.payItemName,
        oldAmount: backPayLine.oldAmount,
        newAmount: backPayLine.newAmount,
        difference: backPayLine.difference,
        needsReview: backPayLine.needsReview,
        reviewReason: backPayLine.reviewReason,
      })
      .from(backPayLine)
      .innerJoin(employment, eq(employment.id, backPayLine.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(backPayLine.runId, runId));

    const periods = [...new Set(lines.map((l) => l.affectedPeriod))].sort();
    const rowByKey = new Map<string, BackPayGridRow>();
    for (const l of lines) {
      const key = `${l.employmentId}|${l.payCode}`;
      const row =
        rowByKey.get(key) ??
        ({
          employmentId: l.employmentId,
          employeeName: l.employeeName,
          employeeCode: l.employeeCode,
          payCode: l.payCode,
          payItemName: l.payItemName,
          byPeriod: {},
          total: 0,
          needsReview: false,
          reviewReason: null,
        } satisfies BackPayGridRow);
      row.byPeriod[l.affectedPeriod] = {
        old: Number(l.oldAmount),
        new: l.newAmount == null ? null : Number(l.newAmount),
        diff: Number(l.difference),
      };
      row.total = round2(row.total + Number(l.difference));
      if (l.needsReview) {
        row.needsReview = true;
        row.reviewReason = (l.reviewReason as BackPayReviewReason | null) ?? row.reviewReason;
      }
      rowByKey.set(key, row);
    }
    const rows = [...rowByKey.values()].sort(
      (a, b) => a.employeeName.localeCompare(b.employeeName) || a.payCode.localeCompare(b.payCode),
    );

    const perEmpMap = new Map<string, { employmentId: string; employeeName: string; employeeCode: string | null; total: number }>();
    for (const r of rows) {
      if (r.needsReview) continue; // asserts no figure — excluded from what posts
      const hit = perEmpMap.get(r.employmentId) ?? {
        employmentId: r.employmentId,
        employeeName: r.employeeName,
        employeeCode: r.employeeCode,
        total: 0,
      };
      hit.total = round2(hit.total + r.total);
      perEmpMap.set(r.employmentId, hit);
    }
    const perEmployee = [...perEmpMap.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    const total = round2(perEmployee.reduce((s, e) => s + e.total, 0));

    const [targetBatch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(
          eq(payrollBatch.companyId, run.companyId),
          eq(payrollBatch.payPeriod, run.targetPayPeriod),
          eq(payrollBatch.runType, 'regular'),
        ),
      )
      .limit(1);

    const names = await actorNames(tx, [run.createdByUserId, run.approvedByUserId]);
    return {
      run: {
        id: run.id,
        companyId: run.companyId,
        companyName: run.companyName,
        targetPayPeriod: run.targetPayPeriod,
        status: run.status as BackPayStatus,
        employeeCount: new Set(lines.map((l) => l.employmentId)).size,
        periodCount: periods.length,
        total,
        needsReviewCount: rows.filter((r) => r.needsReview).length,
        createdByName: names.get(run.createdByUserId ?? '') ?? null,
        createdAt: run.createdAt,
        approvedByName: names.get(run.approvedByUserId ?? '') ?? null,
        approvedAt: run.approvedAt,
        postedAt: run.postedAt,
        cancelledAt: run.cancelledAt,
      },
      periods,
      rows,
      perEmployee,
      total,
      targetWritable: targetBatch == null || targetBatch.status === 'draft',
      targetRunStatus: targetBatch?.status ?? null,
    };
  });
}

async function actorNames(tx: Tx, ids: Array<string | null>): Promise<Map<string, string>> {
  const real = [...new Set(ids.filter((v): v is string => !!v))];
  if (real.length === 0) return new Map();
  const rows = await tx
    .select({ id: appUser.id, name: person.fullName })
    .from(appUser)
    .leftJoin(person, eq(person.id, appUser.personId))
    .where(inArray(appUser.id, real));
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
}

/** Every run for a company, newest first — the screen's history list. */
export function listBackPayRuns(ctx: SessionContext, p: { companyIds: string[] }): Promise<BackPayRunSummary[]> {
  return withTenant(ctx, async (tx) => {
    if (p.companyIds.length === 0) return [];
    const runs = await tx
      .select({
        id: backPayRun.id,
        companyId: backPayRun.companyId,
        companyName: company.legalName,
        targetPayPeriod: backPayRun.targetPayPeriod,
        status: backPayRun.status,
        createdAt: backPayRun.createdAt,
        approvedAt: backPayRun.approvedAt,
        postedAt: backPayRun.postedAt,
        cancelledAt: backPayRun.cancelledAt,
        createdByUserId: backPayRun.createdByUserId,
        approvedByUserId: backPayRun.approvedByUserId,
      })
      .from(backPayRun)
      .innerJoin(company, eq(company.id, backPayRun.companyId))
      .where(inArray(backPayRun.companyId, p.companyIds));
    if (runs.length === 0) return [];
    const lines = await tx
      .select({
        runId: backPayLine.runId,
        employmentId: backPayLine.employmentId,
        affectedPeriod: backPayLine.affectedPeriod,
        difference: backPayLine.difference,
        needsReview: backPayLine.needsReview,
      })
      .from(backPayLine)
      .where(inArray(backPayLine.runId, runs.map((r) => r.id)));
    const agg = new Map<string, { emps: Set<string>; periods: Set<string>; total: number; review: number }>();
    for (const l of lines) {
      const a = agg.get(l.runId) ?? { emps: new Set<string>(), periods: new Set<string>(), total: 0, review: 0 };
      a.emps.add(l.employmentId);
      a.periods.add(l.affectedPeriod);
      if (l.needsReview) a.review += 1;
      else a.total = round2(a.total + Number(l.difference));
      agg.set(l.runId, a);
    }
    const names = await actorNames(tx, runs.flatMap((r) => [r.createdByUserId, r.approvedByUserId]));
    return runs
      .map((r) => {
        const a = agg.get(r.id);
        return {
          id: r.id,
          companyId: r.companyId,
          companyName: r.companyName,
          targetPayPeriod: r.targetPayPeriod,
          status: r.status as BackPayStatus,
          employeeCount: a?.emps.size ?? 0,
          periodCount: a?.periods.size ?? 0,
          total: a?.total ?? 0,
          needsReviewCount: a?.review ?? 0,
          createdByName: names.get(r.createdByUserId ?? '') ?? null,
          createdAt: r.createdAt,
          approvedByName: names.get(r.approvedByUserId ?? '') ?? null,
          approvedAt: r.approvedAt,
          postedAt: r.postedAt,
          cancelledAt: r.cancelledAt,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  });
}

/** Mark a draft run verified — the operator has read the grid (and, usually, exported it for sign-off).
 *  A separate step from posting on purpose: "verified" is what a manager signs, "posted" is what pays. */
export function verifyBackPayRun(ctx: SessionContext, p: { runId: string }): Promise<{ runId: string }> {
  return withTenant(ctx, async (tx) => {
    const run = await loadRunTx(tx, p.runId);
    if (run.status !== 'draft') throw new BackPayStatusError(run.status, 'draft');
    await tx.update(backPayRun).set({ status: 'verified', updatedAt: new Date() }).where(eq(backPayRun.id, run.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'back-pay-run',
      aggregateId: run.id,
      eventType: 'back-pay.verified',
      actor: actorOf(ctx),
      payload: { companyId: run.companyId, targetPayPeriod: run.targetPayPeriod },
    });
    return { runId: run.id };
  });
}

async function loadRunTx(tx: Tx, runId: string) {
  const [run] = await tx.select().from(backPayRun).where(eq(backPayRun.id, runId)).limit(1);
  if (!run) throw new BackPayRunNotFoundError();
  return run;
}

/**
 * APPROVE AND POST — the only thing here that moves money, and it moves it exactly one way: new one-off
 * transactions on the TARGET (current) period.
 *
 * The whole posting happens in ONE transaction. That matters more than it might look: 22 employees is a
 * realistic run, and `createIndividualTxnsBulk` cannot express "a different amount per employee" in a
 * single transaction (it writes the same grid to every payee), so looping it would open N transactions
 * with no cross-employee rollback and could leave a run half paid. `insertIndividualTxnsTx` is the same
 * insert + event, taking the caller's transaction.
 *
 * NETTED PER (employee, affected month) so the payslip carries one legible arrears line per covered
 * month. A positive net posts as an `earning`, a negative one as a `deduction` — amounts on
 * payroll_individual_txn are MAGNITUDES and the kind carries the sign.
 */
export function approveAndPostBackPay(
  ctx: SessionContext,
  p: { runId: string },
): Promise<{ runId: string; postedCount: number; total: number }> {
  return withTenant(ctx, async (tx) => {
    const run = await loadRunTx(tx, p.runId);
    if (run.status !== 'draft' && run.status !== 'verified') throw new BackPayStatusError(run.status, 'verified');

    const [target] = await tx
      .select({ id: payrollBatch.id, status: payrollBatch.status })
      .from(payrollBatch)
      .where(
        and(
          eq(payrollBatch.companyId, run.companyId),
          eq(payrollBatch.payPeriod, run.targetPayPeriod),
          eq(payrollBatch.runType, 'regular'),
        ),
      )
      .limit(1);
    // Posting into a run that is already processed or closed would make its figures disagree with its
    // inputs. Refuse rather than mark it for recalculation behind the operator's back.
    if (target && target.status !== 'draft') throw new BackPayTargetRunNotDraftError(target.status);

    const lines = await tx
      .select({
        id: backPayLine.id,
        employmentId: backPayLine.employmentId,
        affectedPeriod: backPayLine.affectedPeriod,
        difference: backPayLine.difference,
        needsReview: backPayLine.needsReview,
      })
      .from(backPayLine)
      .where(and(eq(backPayLine.runId, run.id), eq(backPayLine.needsReview, false)));

    // Net per (employee, affected month).
    const netted = new Map<string, { employmentId: string; period: string; amount: number; lineIds: string[] }>();
    for (const l of lines) {
      const key = `${l.employmentId}|${l.affectedPeriod}`;
      const hit = netted.get(key) ?? { employmentId: l.employmentId, period: l.affectedPeriod, amount: 0, lineIds: [] };
      hit.amount = round2(hit.amount + Number(l.difference));
      hit.lineIds.push(l.id);
      netted.set(key, hit);
    }
    const payable = [...netted.values()].filter((n) => Math.abs(n.amount) >= 0.01);

    const earningId = await ensureBackPayComponentTx(tx, ctx, 'earning');
    const deductionId = await ensureBackPayComponentTx(tx, ctx, 'deduction');
    // The transaction date is the FIRST day of the target period: the arrears belong to the month they
    // are paid in, and assertDateInPeriod requires the date to fall inside it.
    const txnDate = `${run.targetPayPeriod}-01`;

    const rows = payable.map((n) => ({
      employmentId: n.employmentId,
      kind: (n.amount >= 0 ? 'earning' : 'deduction') as 'earning' | 'deduction',
      componentId: n.amount >= 0 ? earningId : deductionId,
      txnDate,
      amount: Math.abs(n.amount),
      notes: `Back pay ${n.period} (run ${run.id.slice(0, 8)})`,
    }));
    const ids = await insertIndividualTxnsTx(tx, ctx, {
      batchId: target?.id ?? null,
      companyId: run.companyId,
      payPeriod: run.targetPayPeriod,
      rows,
    });
    for (const [i, n] of payable.entries()) {
      await tx.update(backPayLine).set({ postedTxnId: ids[i] }).where(inArray(backPayLine.id, n.lineIds));
    }

    const now = new Date();
    await tx
      .update(backPayRun)
      .set({ status: 'posted', approvedByUserId: ctx.userId ?? null, approvedAt: now, postedAt: now, updatedAt: now })
      .where(eq(backPayRun.id, run.id));
    const total = round2(payable.reduce((s, n) => s + n.amount, 0));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'back-pay-run',
      aggregateId: run.id,
      eventType: 'back-pay.posted',
      actor: actorOf(ctx),
      // Counts and references only — the amounts stay on the RLS-gated lines (ADR-0030 Layer 0).
      payload: {
        companyId: run.companyId,
        targetPayPeriod: run.targetPayPeriod,
        postings: ids.length,
        employees: new Set(payable.map((n) => n.employmentId)).size,
      },
    });
    return { runId: run.id, postedCount: ids.length, total };
  });
}

/**
 * CANCEL — withdraw a run and, if it had posted, remove the one-off transactions it created.
 *
 * Only while the target run is still DRAFT. Once it is processed the money has been calculated into
 * somebody's payslip, and silently pulling it back out is exactly the kind of quiet edit this feature
 * exists to avoid. The run and its lines are KEPT: a cancelled run is the record of what was calculated
 * and withdrawn, and cancelling is what releases its salary revisions back to detection.
 */
export function cancelBackPayRun(ctx: SessionContext, p: { runId: string }): Promise<{ runId: string; removed: number }> {
  return withTenant(ctx, async (tx) => {
    const run = await loadRunTx(tx, p.runId);
    if (run.status === 'cancelled') throw new BackPayStatusError(run.status, 'draft|verified|posted');

    let removed = 0;
    if (run.status === 'posted') {
      const [target] = await tx
        .select({ status: payrollBatch.status })
        .from(payrollBatch)
        .where(
          and(
            eq(payrollBatch.companyId, run.companyId),
            eq(payrollBatch.payPeriod, run.targetPayPeriod),
            eq(payrollBatch.runType, 'regular'),
          ),
        )
        .limit(1);
      if (target && target.status !== 'draft') throw new BackPayTargetRunNotDraftError(target.status);

      const posted = await tx
        .select({ txnId: backPayLine.postedTxnId })
        .from(backPayLine)
        .where(and(eq(backPayLine.runId, run.id), isNotNull(backPayLine.postedTxnId)));
      const txnIds = [...new Set(posted.map((r) => r.txnId).filter((v): v is string => v != null))];
      if (txnIds.length > 0) {
        await tx.update(backPayLine).set({ postedTxnId: null }).where(eq(backPayLine.runId, run.id));
        await tx.delete(payrollIndividualTxn).where(inArray(payrollIndividualTxn.id, txnIds));
        removed = txnIds.length;
      }
    }

    const now = new Date();
    await tx
      .update(backPayRun)
      .set({ status: 'cancelled', cancelledByUserId: ctx.userId ?? null, cancelledAt: now, updatedAt: now })
      .where(eq(backPayRun.id, run.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'back-pay-run',
      aggregateId: run.id,
      eventType: 'back-pay.cancelled',
      actor: actorOf(ctx),
      payload: { companyId: run.companyId, targetPayPeriod: run.targetPayPeriod, removedPostings: removed },
    });
    return { runId: run.id, removed };
  });
}

/**
 * The Back Pay pay items, created on FIRST USE rather than at install: a tenant that never has arrears
 * should not carry two items it did not ask for. Required because a payable one-off row must name a
 * master item (core/payroll-individual-txn.ts ComponentRequiredError).
 *
 * Statutory treatment: arrears ARE wages. EPF/SOCSO/EIS and PCB all apply in the month of payment, which
 * is precisely why back pay rides the ordinary one-off path instead of rewriting a closed month. HR can
 * rename them and adjust the treatment afterwards — this only seeds a sane default, and re-running it
 * never overwrites an existing row's configuration.
 */
async function ensureBackPayComponentTx(tx: Tx, ctx: SessionContext, kind: 'earning' | 'deduction'): Promise<string> {
  const code = kind === 'earning' ? BACK_PAY_EARNING_CODE : BACK_PAY_DEDUCTION_CODE;
  const [existing] = await tx
    .select({ id: payComponent.id })
    .from(payComponent)
    .where(and(eq(payComponent.tenantId, ctx.tenantId), eq(payComponent.code, code)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await tx
    .insert(payComponent)
    .values({
      tenantId: ctx.tenantId,
      code,
      name: kind === 'earning' ? 'Back Pay (Arrears)' : 'Back Pay Recovery',
      kind: kind === 'earning' ? 'allowance' : 'deduction',
      includedInEpf: true,
      includedInSocsoEis: true,
      includedInPcb: true,
      includedInHrdfBase: true,
      isNonPayable: false,
      // Arrears are a settled figure for months already worked — proration would scale a debt that has
      // already been sized. Never prorate.
      prorates: false,
      // ── WHY THE PCB CLASSIFICATION IS LEFT UNDECLARED, WHICH IS A DELIBERATE CHOICE ────────────────
      // The first draft declared `pcbRemunerationType: 'additional'` on the reasoning that an arrears
      // lump sum is additional remuneration under the LHDN computerised calculation. Tracing it through
      // the kernel showed that routes the amount into the BONUS bucket — and the kernel's own comment
      // there reads "Bonus is additional remuneration: EPF + PCB (difference method), EXCLUDED from
      // SOCSO/EIS". Arrears of WAGES are not excluded from SOCSO/EIS, and the approved plan promises in
      // as many words that the arrears "attract EPF, SOCSO and PCB in the month they are actually paid".
      // Leaving it null makes the kernel infer the stream from the flags exactly as it does for every
      // item the default catalog seeds (none of which declares one either): epf + socso ⇒ ordinary wage,
      // which is EPF, SOCSO, EIS and PCB. That is the promise, and it is the conservative reading. HR can
      // reclassify afterwards — the plan says so — but the default must not quietly drop two contributions.
      pcbRemunerationType: null,
      pcbExemptionCode: null,
      displayCategory: kind === 'earning' ? 'allowance' : 'deduction',
    })
    .returning({ id: payComponent.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'pay-component',
    aggregateId: row.id,
    eventType: 'pay-component.created',
    actor: actorOf(ctx),
    payload: { code, reason: 'back-pay-first-use' },
  });
  return row.id;
}
