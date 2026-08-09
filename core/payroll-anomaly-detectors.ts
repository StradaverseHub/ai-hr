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
  };
  /** Attendance + approved leave day counts for the period. Both zero is what `pay-without-attendance` looks for. */
  activity: { attendanceDays: number; approvedLeaveDays: number };
  period: { start: string; end: string; calendarDays: number };
  /** Statutory ceilings resolved from the pack in force for this batch. */
  caps: Record<string, number>;
  /** Event ids gathered for this employee, so findings can cite provenance. */
  eventIds: string[];
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
 * Payable by BANK TRANSFER with nowhere to send it. BLOCK — the disbursement file would carry a row that
 * cannot land.
 *
 * THE PAYMENT METHOD GATE IS NOT OPTIONAL, and leaving it out was the first false positive this detector
 * nearly shipped with. `employment.payment_method` is a three-value enum (bank_transfer | cheque | cash),
 * so a cash-paid site worker legitimately has no bank details. Firing on them would flag a whole deskless
 * workforce as blocked on their first cycle — the single fastest way to teach an operator that this layer
 * cries wolf.
 *
 * NULL counts as bank transfer. The column is nullable with no default, so every employment predating
 * migration 0270 carries NULL, and those are ordinary bank-transfer employees — treating NULL as "unknown,
 * so stay quiet" would silently exempt most of the existing population from the check.
 */
const missingBankProfile: Detector = {
  id: 'missing-bank-profile',
  requires: { priorCycles: 0 },
  evaluate: (ctx) => {
    const paidByBank = ctx.profile.paymentMethod === 'bank_transfer' || ctx.profile.paymentMethod === null;
    return ctx.current.netPay > 0 && paidByBank && !ctx.profile.hasBankProfile
      ? [
          {
            detectorId: 'missing-bank-profile',
            severity: 'block',
            facts: { netPay: ctx.current.netPay, paymentMethod: ctx.profile.paymentMethod ?? 'unset' },
            sourceEventIds: ctx.eventIds,
            suggestedAction: 'anomaly.action.missingBankProfile',
          },
        ]
      : [];
  },
};

/**
 * No tax profile. REVIEW rather than block: PCB may still be computed on defaults and be right, and a
 * brand-new client mid-onboarding would otherwise have its whole first batch blocked on paperwork.
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
 */
const payWithoutAttendance: Detector = {
  id: 'pay-without-attendance',
  requires: { priorCycles: 0 },
  evaluate: (ctx) =>
    ctx.current.netPay > 0 && ctx.activity.attendanceDays === 0 && ctx.activity.approvedLeaveDays === 0
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
// The defaults below are CONSERVATIVE PLACEHOLDERS, EXPLICITLY UNTUNED. ADR-0076 §6 is blunt that only
// real client history or a shadow run produces defensible thresholds, and the seed config labels them as
// such so nobody mistakes 30% for an empirically derived number.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const netSwing: Detector = {
  id: 'net-swing',
  requires: { priorCycles: 1 },
  evaluate: (ctx, params) => {
    if (!ctx.prior) return [];
    const pct = num(params.netSwingPct) || 30;
    const before = ctx.prior.netPay;
    if (before === 0) return []; // a swing from zero is infinite; component-appeared covers that case.
    const movement = ((ctx.current.netPay - before) / Math.abs(before)) * 100;
    return Math.abs(movement) > pct
      ? [
          {
            detectorId: 'net-swing',
            severity: 'review',
            facts: {
              netPay: ctx.current.netPay,
              priorNetPay: before,
              movementPct: Math.round(movement * 10) / 10,
              thresholdPct: pct,
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

/** §2.5 — derived, never scored. */
export function resolveDisposition(findings: readonly Finding[]): Disposition {
  if (findings.some((f) => f.severity === 'block')) return 'block';
  if (findings.some((f) => f.severity === 'review')) return 'review';
  return 'auto_clear';
}
