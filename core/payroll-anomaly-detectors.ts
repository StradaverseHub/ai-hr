/**
 * ADR-0076 — the payroll anomaly detectors. PURE. No I/O, no LLM, no clock.
 *
 * WHY PURITY IS THE LOAD-BEARING PROPERTY, and not a stylistic preference:
 *   • every detector is unit-testable against a literal context object, with no database;
 *   • the classification is REPRODUCIBLE FROM STORED INPUTS during an audit — an auditor can be handed
 *     the context and re-derive the verdict years later;
 *   • and it forces the one invariant the whole ADR-0074 programme rests on: the model never computes
 *     money. A detector cannot call an LLM because it cannot call anything.
 *
 * DISPOSITION IS DERIVED, NOT SCORED (§2.5): any block finding -> block, else any review -> review, else
 * auto-clear. There is deliberately no confidence number in Phase 1a. A "confidence" implies a calibrated
 * probability, and with no payroll history behind it any number emitted here would be decoration — the
 * precise false trust this layer exists to prevent.
 *
 * THE `requires` DECLARATION IS NOT BOOKKEEPING. A statistical detector that silently returns "no
 * findings" on a client with two cycles of history is indistinguishable from "checked and clean". Every
 * detector states what data it needs; the engine runs only those whose need is met and records the rest as
 * SKIPPED WITH A REASON, so a verdict can say "auto-clear, but 2 of 6 detectors could not run yet".
 */

import { netSwingFor, swingThresholdOrDefault, type ComponentIds } from './loops/net-swing';
import type { StoredPayslipRow } from './pay-difference';

export type DataRequirement = {
  /** 0 = works on a brand-new client's very first run, before any history exists. */
  priorCycles: number;
  /** Detector self-disables below this many peers; absent = no cohort requirement. */
  cohortMinSize?: number;
};

export type Severity = 'block' | 'review' | 'info';
export type Disposition = 'auto_clear' | 'review' | 'block';

export type Finding = {
  detectorId: string;
  severity: Severity;
  /** The numbers that triggered it. Every figure the narrative prints is interpolated from HERE. */
  facts: Record<string, string | number>;
  /** Provenance into domain_event. */
  sourceEventIds: string[];
  /** An i18n KEY, never prose — this is rendered in six locales. */
  suggestedAction: string;
};

/** One employee's slice of the cycle, plus the prior cycle when there is one. */
export type DetectorContext = {
  employmentId: string;
  /** This cycle's figures, read straight off the payslip row. */
  current: PayslipFigures;
  /** The immediately prior cycle's figures, or null on cycle 1 / a new joiner. */
  prior: PayslipFigures | null;
  /** Facts about the person that the tripwires need. */
  profile: {
    hasBankProfile: boolean;
    hasTaxProfile: boolean;
    /** employment.payment_method. NULL = unset, which predates migration 0270 and means bank transfer. */
    paymentMethod: 'bank_transfer' | 'cheque' | 'cash' | null;
    hiredOn: string | null;
    terminatedOn: string | null;
    /** Other LIVE employments of the same person paid in this same period. */
    concurrentPaidEmploymentIds: string[];
    /** AI v2 Phase 2 hardening — the pay mode of the compensation in force at the period's end (compensation.pay_mode).
     *  A daily- or hourly-rated person is paid for the days they work, so a partial daysWorked is their normal pay. */
    payMode?: string | null;
  };
  /** Attendance + approved leave day counts for the period. Both zero is what `pay-without-attendance` looks for.
   *  `attendanceExempt` (AI v2 Phase 2 hardening): the person's schedule group is exempt from absence judgments on every
   *  day of the period (the attendance owner's "Enable Exception"), so no attendance is their normal set-up.
   *  `attendanceInUse` (owner rule, 4 November 2026): FALSE when the Attendance module is not enabled for the person's
   *  company (core/entitlements.ts, tenant-wide or company-scoped), so nobody there records attendance and zero days is
   *  the normal set-up, not a ghost. Absent (a context built before this fact existed) or TRUE = attendance applies. */
  activity: { attendanceDays: number; approvedLeaveDays: number; attendanceExempt?: boolean; attendanceInUse?: boolean };
  period: { start: string; end: string; calendarDays: number };
  /** Statutory ceilings resolved from the pack in force for this batch. */
  caps: Record<string, number>;
  /** Event ids gathered for this employee, so findings can cite provenance. */
  eventIds: string[];
  /** Owner, 11 November 2026 — ONE net-swing threshold, and "check the payroll first". What `net-swing` judges by: this
   *  person's payslips at this company for the period and the months before it (core/loops/net-swing.ts swingMonths), and
   *  the company's Salary payroll loop setting, read once for the batch. Absent (a context built without it): the swing
   *  is judged on `current`/`prior` against the 15% default, with nothing explained. */
  swing?: {
    period: string;
    companyId: string;
    /** The run type of the batch under evaluation. A bonus or off-cycle batch is compared like with like (below). */
    runType: string;
    rows: readonly StoredPayslipRow[];
    thresholdBp: number;
    /** FALSE when the evaluator could not read the company's setting (row security: the scheduled sweep, a payroll
     *  partner), so `thresholdBp` is the 15% default and there are no exclusions. Said so on every finding. */
    thresholdReadable: boolean;
    exclusions: readonly string[];
    componentIds?: ComponentIds;
  };
};

export type PayslipFigures = {
  grossPay: number;
  netPay: number;
  basicSalary: number;
  allowance: number;
  overtimePay: number;
  bonus: number;
  totalDeductions: number;
  daysWorked: number | null;
  /** epfEmployee, socsoEmployee, eis, pcb, … as stored on the payslip's statutory blob. */
  statutory: Record<string, number>;
};

export type Detector = {
  id: string;
  requires: DataRequirement;
  /** PURE. No I/O. No LLM. No clock. */
  evaluate(ctx: DetectorContext, params: Record<string, unknown>): Finding[];
};

const num = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PHASE 1a — TRIPWIRES. priorCycles: 0, so every one of these works on a client's first ever cycle.
//
// Chosen on a single criterion: each catches something MATERIALLY EMBARRASSING IN FRONT OF A CLIENT —
// negative pay, paying into an account that does not exist, over-contributing EPF — and none of them
// needs a single day of history to fire.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const negativeNet: Detector = {
  id: 'negative-net',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    ctx.current.netPay < 0
      ? [
          {
            detectorId: 'negative-net',
            severity: 'block',
            facts: { netPay: ctx.current.netPay, grossPay: ctx.current.grossPay, totalDeductions: ctx.current.totalDeductions },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.negativeNet',
          },
        ]
      : [],
};

/**
 * Zero net on positive gross. REVIEW, not block: it is legitimately reachable — a full month of unpaid
 * leave, or deductions that genuinely consume the pay — so refusing to close the batch over it would be
 * wrong. It is flagged because it is far more often a mis-keyed deduction.
 */
const zeroNetWithPay: Detector = {
  id: 'zero-net-with-pay',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    ctx.current.netPay === 0 && ctx.current.grossPay > 0
      ? [
          {
            detectorId: 'zero-net-with-pay',
            severity: 'review',
            facts: { grossPay: ctx.current.grossPay, totalDeductions: ctx.current.totalDeductions },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.zeroNetWithPay',
          },
        ]
      : [],
};

/**
 * Any statutory component above its pack ceiling. BLOCK, and the severity is not negotiable: an
 * over-contribution is filed to KWSP/PERKESO and then has to be unwound with the agency, not just corrected
 * internally. `caps` comes from the versioned pack in force for the batch, never from a constant here —
 * a hardcoded ceiling would silently rot the first time a rate table changed.
 */
const statutoryOverCap: Detector = {
  id: 'statutory-over-cap',
  requires: { priorCycles: 0 },
  evaluate: (ctx) => {
    const hits: Finding[] = [];
    for (const [component, cap] of Object.entries(ctx.caps)) {
      const actual = num(ctx.current.statutory[component]);
      if (cap > 0 && actual > cap) {
        hits.push({
          detectorId: 'statutory-over-cap',
          severity: 'block',
          facts: { component, actual, cap, excess: Math.round((actual - cap) * 100) / 100 },
          sourceEventIds: ctx.eventIds,
          suggestedAction: 'anomaly.action.statutoryOverCap',
        });
      }
    }
    return hits;
  },
};

/**
 * Why `missing-bank-profile` fired, carried as the `reason` fact so a screen can word the two cases differently.
 * `payment-method-not-set`: the employment has no payment method on record (NULL), so it is paid by bank by default
 * and has no bank details. `bank-details-missing`: the payment method is bank transfer and the bank details are missing.
 * ADDITIVE: the `netPay` and `paymentMethod` facts keep their keys and values, so verdicts stored before this fact
 * existed still render (a finding without `reason` reads as before).
 */
export const MISSING_BANK_PROFILE_REASONS = ['payment-method-not-set', 'bank-details-missing'] as const;
export type MissingBankProfileReason = (typeof MISSING_BANK_PROFILE_REASONS)[number];

/**
 * Payable by BANK TRANSFER with nowhere to send it. BLOCK — the disbursement file would carry a row that
 * cannot land.
 *
 * THE PAYMENT METHOD GATE IS NOT OPTIONAL, and leaving it out was the first false positive this detector
 * nearly shipped with. `employment.payment_method` is a three-value enum (bank_transfer | cheque | cash),
 * so a cash-paid site worker legitimately has no bank details. Firing on them would flag a whole deskless
 * workforce as blocked on their first cycle — the single fastest way to teach an operator that this layer
 * cries wolf. Cash and cheque NEVER fire, whatever the bank details.
 *
 * NULL counts as bank transfer. The column is nullable with no default, so every employment predating
 * migration 0270 carries NULL, and those are ordinary bank-transfer employees — treating NULL as "unknown,
 * so stay quiet" would silently exempt most of the existing population from the check. It still BLOCKS
 * (a bank file cannot be made for the row), but its `reason` says the payment method was never set, because
 * the fix is different: set the payment method (cash or cheque needs no bank details) or capture the account.
 */
const missingBankProfile: Detector = {
  id: 'missing-bank-profile',
  requires: { priorCycles: 0 },
  evaluate: (ctx) => {
    const method = ctx.profile.paymentMethod;
    const paidByBank = method === 'bank_transfer' || method === null;
    if (!(ctx.current.netPay > 0 && paidByBank && !ctx.profile.hasBankProfile)) return [];
    const reason: MissingBankProfileReason = method === null ? 'payment-method-not-set' : 'bank-details-missing';
    return [
      {
        detectorId: 'missing-bank-profile',
        severity: 'block',
        facts: { netPay: ctx.current.netPay, paymentMethod: method ?? 'unset', reason },
        sourceEventIds: ctx.eventIds,
        suggestedAction: 'anomaly.action.missingBankProfile',
      },
    ];
  },
};

/**
 * No tax profile. REVIEW rather than block: PCB may still be computed on defaults and be right, and a
 * brand-new client mid-onboarding would otherwise have its whole first batch blocked on paperwork.
 *
 * WHAT IT TESTS (checked 11 November 2026): the person has NO `employee_statutory_my` row at all (ADR-0076 §3 table) —
 * no tax category, no children, no statutory numbers, so PCB ran on defaults. It does NOT test the PCB amount: `pcb` is
 * EVIDENCE only, and a zero PCB (a person below the PCB threshold) neither causes nor prevents a finding.
 */
const missingTaxProfile: Detector = {
  id: 'missing-tax-profile',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    !ctx.profile.hasTaxProfile
      ? [
          {
            detectorId: 'missing-tax-profile',
            severity: 'review',
            facts: { pcb: num(ctx.current.statutory.pcb) },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.missingTaxProfile',
          },
        ]
      : [],
};

/**
 * Paid, but no attendance AND no approved leave. The ghost-employee check.
 *
 * BOTH counts must be zero. Approved leave is attendance for this purpose — flagging someone on a month of
 * approved annual leave would fire on every legitimate long absence and train the operator to dismiss this
 * detector, which is worse than not shipping it.
 *
 * ONLY WHERE ATTENDANCE APPLIES (owner rule, 4 November 2026: a legitimate set-up is not an exception). Not when the
 * Attendance module is off for the person's company (`attendanceInUse === false`), and not when their schedule group
 * is exempt for the whole period (`attendanceExempt`). Someone who is expected to record attendance and has zero days
 * is still flagged.
 */
const payWithoutAttendance: Detector = {
  id: 'pay-without-attendance',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    ctx.current.netPay > 0 && ctx.activity.attendanceDays === 0 && ctx.activity.approvedLeaveDays === 0 && ctx.activity.attendanceExempt !== true
      && ctx.activity.attendanceInUse !== false
      ? [
          {
            detectorId: 'pay-without-attendance',
            severity: 'review',
            facts: { netPay: ctx.current.netPay, attendanceDays: 0, approvedLeaveDays: 0 },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.payWithoutAttendance',
          },
        ]
      : [],
};

/**
 * daysWorked inconsistent with the period and the joiner/leaver dates.
 *
 * Only fires when the employee was employed for the WHOLE period yet carries a partial daysWorked, or was
 * employed for part of it yet carries the full count. A mid-period joiner with a plausible partial figure is
 * left alone — proration arithmetic is the kernel's job and re-deriving it here would be a second,
 * competing implementation of the thing being checked.
 */
const prorationMismatch: Detector = {
  id: 'proration-mismatch',
  requires: { priorCycles: 0 },
  evaluate: (ctx) => {
    const dw = ctx.current.daysWorked;
    if (dw === null) return []; // legacy / full-month slips carry no basis; nothing to contradict.
    // Daily- or hourly-rated: paid for the days actually worked, so a partial count is the normal pay (Phase 2 hardening).
    if (ctx.profile.payMode && ctx.profile.payMode !== 'monthly') return [];
    const joinedMidPeriod = !!ctx.profile.hiredOn && ctx.profile.hiredOn > ctx.period.start;
    const leftMidPeriod = !!ctx.profile.terminatedOn && ctx.profile.terminatedOn < ctx.period.end;
    const partialEmployment = joinedMidPeriod || leftMidPeriod;
    const full = ctx.period.calendarDays;
    if (!partialEmployment && dw < full) {
      return [
        {
          detectorId: 'proration-mismatch',
          severity: 'review',
          facts: { daysWorked: dw, periodDays: full, hiredOn: ctx.profile.hiredOn ?? '', terminatedOn: ctx.profile.terminatedOn ?? '' },
          sourceEventIds: ctx.eventIds,
          suggestedAction: 'anomaly.action.prorationMismatch',
        },
      ];
    }
    if (partialEmployment && dw >= full) {
      return [
        {
          detectorId: 'proration-mismatch',
          severity: 'review',
          facts: { daysWorked: dw, periodDays: full, hiredOn: ctx.profile.hiredOn ?? '', terminatedOn: ctx.profile.terminatedOn ?? '' },
          sourceEventIds: ctx.eventIds,
          suggestedAction: 'anomaly.action.prorationMismatchFull',
        },
      ];
    }
    return [];
  },
};

/**
 * The same PERSON paid under two employments in one period. BLOCK.
 *
 * Concurrent employment is legal and does happen in a 60-entity group (shared-services staff), which is
 * exactly why this blocks rather than warns: when it is intended, someone should say so once and resolve
 * the verdict; when it is not, it is a duplicate salary leaving the building. It is also the case the
 * cross-employer PCB work (ADR-0009) cares about, so a silent duplicate is a tax error as well as a
 * payment one.
 */
const duplicateEmploymentPay: Detector = {
  id: 'duplicate-employment-pay',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    ctx.profile.concurrentPaidEmploymentIds.length > 0 && ctx.current.netPay > 0
      ? [
          {
            detectorId: 'duplicate-employment-pay',
            severity: 'block',
            facts: {
              netPay: ctx.current.netPay,
              otherEmployments: ctx.profile.concurrentPaidEmploymentIds.length,
              otherEmploymentIds: ctx.profile.concurrentPaidEmploymentIds.join(','),
            },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.duplicateEmploymentPay',
          },
        ]
      : [],
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PHASE 1a — PRIOR-PERIOD DELTA. priorCycles: 1, so these SELF-DISABLE on a client's first cycle and are
// recorded as skipped rather than passing vacuously.
//
// ONE THRESHOLD (owner, 11 November 2026). `net-swing` no longer has a threshold of its own (it was a fixed 30%
// placeholder, overridable per tenant through payroll_anomaly_config): it judges by the company's Salary payroll loop
// threshold (15% unless an administrator set another), through the SAME pure function the Salary loop flags with
// (core/loops/net-swing.ts netSwingFor), so the two can never disagree. `params` are ignored here on purpose.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where the threshold a net-swing finding used came from, as a fact on the finding. */
export const NET_SWING_THRESHOLD_SOURCES = ['company', 'default', 'default_company_setting_unreadable'] as const;

const netSwing: Detector = {
  id: 'net-swing',
  requires: { priorCycles: 1 },
  evaluate: (ctx) => {
    const sw = ctx.swing;
    // A regular run with a previous PAID month in the months read is judged on it even when the company's last closed run
    // did not pay this person (the evaluator's gate admits that case); anything else needs the prior cycle.
    if (!ctx.prior && !(sw?.runType === 'regular' && sw.rows.some((r) => r.payPeriod < sw.period))) return [];
    const thresholdBp = swingThresholdOrDefault(sw?.thresholdBp);
    const thresholdSource: (typeof NET_SWING_THRESHOLD_SOURCES)[number] = !sw
      ? 'default'
      : sw.thresholdReadable === false
        ? 'default_company_setting_unreadable'
        : 'company';
    // A REGULAR run is judged on the month, through the one owner the Salary loop uses, with the payroll records checked
    // first. A bonus or off-cycle batch is NOT: an additional run must never explain itself, so it is compared like with
    // like below, against the last closed run of its own type (the pre-11-November behaviour, at the company threshold).
    if (sw && sw.runType === 'regular') {
      const person = netSwingFor(ctx.employmentId, sw.rows, {
        period: sw.period,
        companyId: sw.companyId,
        thresholdBp,
        exclusions: sw.thresholdReadable === false ? [] : sw.exclusions,
        componentIds: sw.componentIds,
      });
      if (person && person.swingBp !== null && person.unexplainedBp !== null) {
        if (!person.flagged) return [];
        const sign = person.direction === 'down' ? -1 : 1;
        return [
          {
            detectorId: 'net-swing',
            severity: 'review',
            facts: {
              netPay: person.netPay,
              priorNetPay: person.previousNetPay,
              movementPct: Math.round((sign * person.swingBp) / 10) / 10,
              thresholdPct: thresholdBp / 100,
              thresholdSource,
              comparedWith: 'previous_paid_month',
              // "Check the payroll first": the records that accounted for part of the change, and how much of it they did
              // not, as a ratio of the whole change (1 = none of it; above 1 when explained and unexplained moves offset).
              explainedCauses: person.explainedBy.join(','),
              unexplainedShare: person.swingBp === 0 ? 1 : Math.round((person.unexplainedBp / person.swingBp) * 1000) / 1000,
            },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.netSwing',
          },
        ];
      }
      // Nothing comparable in the months read (the previous paid month is older than the window, or was not positive):
      // never a vacuous pass. Fall through to the like-for-like comparison with the prior cycle the gate found.
    }
    if (!ctx.prior) return []; // a previous paid month whose net was not positive: a swing from zero (component-appeared)
    const before = ctx.prior.netPay;
    if (before === 0) return []; // a swing from zero is infinite; component-appeared covers that case.
    const movement = ((ctx.current.netPay - before) / Math.abs(before)) * 100;
    return Math.abs(movement) * 100 > thresholdBp
      ? [
          {
            detectorId: 'net-swing',
            severity: 'review',
            facts: {
              netPay: ctx.current.netPay,
              priorNetPay: before,
              movementPct: Math.round(movement * 10) / 10,
              thresholdPct: thresholdBp / 100,
              thresholdSource,
              comparedWith: 'previous_run_of_same_type',
              explainedCauses: '',
              unexplainedShare: 1,
            },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.netSwing',
          },
        ]
      : [];
  },
};

/** Which pay components this cycle carries, for the appeared/vanished pair. */
const componentsOf = (f: PayslipFigures): Record<string, number> => ({
  allowance: f.allowance,
  overtimePay: f.overtimePay,
  bonus: f.bonus,
  ...f.statutory,
});

const componentAppeared: Detector = {
  id: 'component-appeared',
  requires: { priorCycles: 1 },
  evaluate: (ctx) => {
    if (!ctx.prior) return [];
    const now = componentsOf(ctx.current);
    const before = componentsOf(ctx.prior);
    return Object.entries(now)
      .filter(([k, v]) => v !== 0 && num(before[k]) === 0)
      .map(([component, amount]) => ({
        detectorId: 'component-appeared',
        severity: 'review' as const,
        facts: { component, amount },
        sourceEventIds: ctx.eventIds,
        suggestedAction: 'anomaly.action.componentAppeared',
      }));
  },
};

const componentVanished: Detector = {
  id: 'component-vanished',
  requires: { priorCycles: 1 },
  evaluate: (ctx) => {
    if (!ctx.prior) return [];
    const now = componentsOf(ctx.current);
    const before = componentsOf(ctx.prior);
    return Object.entries(before)
      .filter(([k, v]) => v !== 0 && num(now[k]) === 0)
      .map(([component, priorAmount]) => ({
        detectorId: 'component-vanished',
        severity: 'review' as const,
        facts: { component, priorAmount },
        sourceEventIds: ctx.eventIds,
        suggestedAction: 'anomaly.action.componentVanished',
      }));
  },
};

/**
 * THE REGISTRY. Order is display order in the queue, not evaluation order — evaluation is order-independent
 * because every detector is pure and reads only its context.
 */
export const DETECTORS: readonly Detector[] = [
  negativeNet,
  statutoryOverCap,
  missingBankProfile,
  duplicateEmploymentPay,
  zeroNetWithPay,
  missingTaxProfile,
  payWithoutAttendance,
  prorationMismatch,
  netSwing,
  componentAppeared,
  componentVanished,
];

/**
 * ADR-0084 §2.6 — the detector id every AI-proposed hypothesis finding carries.
 *
 * ⚠️ **DELIBERATELY NOT IN `DETECTORS`, and it never can be.** Everything in that registry is PURE — no
 * I/O, no LLM, no clock — which is the property that makes a verdict reproducible from stored inputs
 * during an audit. A hypothesis is produced by a model outside a transaction and adjudicated afterwards,
 * so it lives in `core/payroll-hypothesis.ts` and only borrows the finding shape. The id is declared HERE
 * rather than there so the resolve path can recognise one without importing the layer that writes them.
 *
 * The severity ceiling is `review`, forever, and it is a literal in that file: a model may never raise a
 * `block` (ADR-0084 §2.2), because `resolveDisposition` below is derived and never scored.
 */
export const HYPOTHESIS_DETECTOR_ID = 'hypothesis';

/** §2.5 — derived, never scored. */
export function resolveDisposition(findings: readonly Finding[]): Disposition {
  if (findings.some((f) => f.severity === 'block')) return 'block';
  if (findings.some((f) => f.severity === 'review')) return 'review';
  return 'auto_clear';
}
