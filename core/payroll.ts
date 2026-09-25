/**
 * Payroll kernel — generic, jurisdiction-neutral (ADR-0008). Computes gross→net and delegates
 * every statutory contribution to the company's country pack. Each mutation appends an event.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../db/client';
// ADR-0077 D3 SERVICE GATE (r292). `withTenant` here is `withPayrollTenant` — all 38 exported entry
// points, THE ENGINE included, refuse a tenant without the Payroll module. The `tx`-taking helpers
// (`markBatchNeedsRecalc`, `batchesCoveringAttendanceDates`, `resolveBatchScopeFilter`,
// `resolveBatchCutOffWindow`, `daysInMonth`) are NOT gated, deliberately: core/attendance-recompute.ts,
// core/claims.ts, core/read.ts and core/reporting.ts call them and none of those is payroll-only.
// See core/module-gate.ts.
import { withPayrollTenant as withTenant } from './module-gate';
import { actorOf, appendEvent } from '../db/events';
import {
  PAYROLL_PERMISSION_DEFAULTS,
  decidePayrollPermission,
  type PayrollPermissionKey,
} from '../lib/payroll-permissions';
// e2632276 — absence days (a scheduled working day with no attendance row, or one marked Absent), counted
// by the SAME helper the Attendance month roll-up reads so the screens and the deduction cannot drift.
import { absentDaysByEmployment, deductAbsentDaysByEmployment } from './absence-days';
// 3c88d593 — "which legal entity did this person belong to on this date?", answered from the effective-dated
// assignment spine (migration 0440). Payroll is the FIRST and, as of r197, still the ONLY reader of it:
// the resolver has to be proven on the money before attendance, leave and reporting adopt it, and that
// adoption is deliberately still outstanding (see core/employment-company.ts's header for where it stands).
import {
  companySegmentsForPeriodBulk,
  employedByCompanyDuring,
  entityChangedDuring,
  segmentForCompany,
} from './employment-company';
// 1b0943d5 — stage two's control: do a transferred month's payslips TILE the period, across every
// employer's batch for it? Nothing here fires for an employment whose month is not split.
import {
  PayrollCounterpartClosedError,
  PayrollCoverageIncompleteError,
  segmentedCoverage,
} from './payroll-coverage';
import { encashableDaysForEmployment } from './leave-encashment';
import { packFor } from '../localization/registry';
import {
  anomalyEvaluated,
  evaluateCircuitBreaker,
  openBlockingVerdicts,
  supersedeVerdictsForEmployments,
} from './payroll-anomaly';
import { assertStatutory } from './company-tier';
import { toCsv } from '../lib/csv';
import {
  assignment,
  attendance,
  claimRequest,
  company,
  companyPayrollConfig,
  companyStatutoryMy,
  compensation,
  department,
  domainEvent,
  employeeLoan,
  employeeStatutoryMy,
  employeeTp3,
  employment,
  employmentPayComponent,
  jobGrade,
  loanRepayment,
  payComponent,
  position,
  payrollBatchComponent,
  payrollStatutoryAdjustment,
  leaveLedger,
  leaveRequest,
  leaveRequestDate,
  leaveType,
  payPeriod,
  payrollBatch,
  payrollCycle,
  payrollEmployeeResultHistory,
  payrollIndividualTxn,
  payrollInput,
  payrollPermissionGrant,
  payrollPolicy,
  payrollReprocessJob,
  payrollStatusHistory,
  payrollStepUpChallenge,
  payslip,
  person,
  rosterAssignment,
  shift,
  statutoryReport,
  STATUTORY_FILED_STATUSES,
  tp1Relief,
} from '../db/schema';
// ADR-0085 step 4 — the filed-period predicate and its evidence formatter. IMPORTED, never
// re-implemented: `core/statutory-filed.ts` resolves against `STATUTORY_FILED_STATUSES` (owned by
// db/schema.ts) and refuses rather than answering when a session could not have seen a filing, and a
// second hand-rolled "has this month been filed" here is exactly the drift that comment forbids.
import { describeFiledEvidence, periodFiledTx, type FiledEvidence } from './statutory-filed';
import { setPayrollBatchComponent } from './pay-components';
import { cp38ForPeriod } from './cp38';
// The month-collapse rule for approved TP1 declarations. Imported rather than re-implemented: the
// limit check, the screen's remaining strip, the printed ACCUMULATED column and this feed must all
// agree on which row is the record for a month, and one function is the only way that stays true.
import {
  TP1_COUNTABLE_COLUMNS,
  tp1CountForYear,
  type Tp1Counted,
  type Tp1CountableRow,
} from './tax-relief';
// Item 1bb09a73 — the ONE place the TP3 Section-C → accumulator-seed mapping lives. Imported, never
// re-derived: the pre-processing gate below has to decide whether a run is about to drop a figure the
// employee's own Form TP3 declares, and it must read that figure exactly as the form's screen and
// `saveTp3` read it, or the gate would guard a different number from the one at risk.
import { deriveAccumulatorSeed } from './tp3';
import { applyLoansForBatch } from './loans';
import { warnIfHolidaysIncomplete, holidayDatesFor, type HolidayCompletenessWarning } from './holidays';
import type { ShiftDifferential, PayRule, PayrollPolicyConfig } from '../db/schema';
import {
  payItemFeedsUnpaidLeaveOrp,
  payRuleQuantityAndRate,
  resolvePayComponentSet,
  type PayRuleScope,
} from './pay-rule';
// Feedback 3c473773 — the payslip-box vocabulary. PRESENTATION ONLY: nothing imported here reaches a
// statutory base, a stored payslip column, or any EA/CP39/KWSP/PERKESO grouping.
import { defaultCategoryOfBucket, resolveDisplayCategory, type PayDisplayCategory } from './pay-display-category';
import { resolveAssignedPolicy } from './payroll-policy';
import {
  applyOvertimeCaps,
  applyOvertimeCapsDetailed,
  applyRounding,
  type CompanyCutOffConfig,
  cutOffWindowFor,
  disburseNetAcrossCycles,
  encashmentDivisorDays,
  ENCASHMENT_ORP_DIVISOR,
  leaveDivisorDays,
  unpaidTimeOffDailyRate,
  payrollFrequencyOf,
  payrollScheduleFor,
  payslipReleaseAt,
  prorationDivisorDays,
  resolveProrationSettings,
  usesWorkingDayProration,
  workingDayRoster,
} from './payroll-policy-config';
import type { CutOffType } from '../db/schema';
import {
  ModuleNotEnabledError,
  SettingNotEnabledError,
  isModuleEnabled,
  settingEnabled,
} from './entitlements';

export class BatchNotDraftError extends Error {
  constructor() {
    super('Payslips can only be generated for a draft batch');
    this.name = 'BatchNotDraftError';
  }
}

/**
 * 3a092cf0 — a MONTHLY election may only be stamped onto the month's REGULAR run.
 *
 * The zakat prefill was offered on every draft batch, an additional/off-cycle one included, and the
 * kernel's manual tier then applied the same election a second time. Measured on a branch build: basic
 * 6000 with a 90.00 monthly election, regular run + bonus run, 180.00 deducted.
 *
 * ⚠️ IT WAS HARMLESS UNTIL ZAKAT JOINED THE DEDUCTION TOTAL, which is why nothing had surfaced it: the
 * duplicate stamp moved no money while zakat was excluded from `statDeductions`. Fixing that exclusion
 * turned a dormant bookkeeping duplicate into a real double charge, so the two changes ship together.
 *
 * The screen already hides the control on a non-regular run (`isRegular &&` in adjustments-panel.tsx,
 * as it does for loans and TP1). This is the SERVER half — a hidden control is not a guard, and this one
 * now costs money.
 */
export class AdditionalRunPrefillNotAllowedError extends Error {
  constructor(public readonly what: string) {
    super(`A ${what} election is monthly and can only be prefilled onto the month's regular run`);
    this.name = 'AdditionalRunPrefillNotAllowedError';
  }
}

/**
 * 49e7e0a2 — Close is refused while the run still owes a recalculation.
 *
 * The window that lets a one-off transaction be corrected after a run is processed is only safe because
 * the run cannot be FINALISED on figures that no longer match the transactions behind them. This is the
 * guard that makes it so. It names the employments that are waiting so the message can send the operator
 * straight to the selective reprocess with the right people already picked.
 *
 * ⚠️ CURRENTLY UNREACHABLE ON PRODUCTION, AND BUILT ANYWAY. Every payroll run measured on 2026-08-05 sits
 * at `processed`; not one has ever been closed, so nothing exercises this path today. It is the thing that
 * makes the editing window safe the day someone does close a run, and it is much cheaper to build now than
 * to discover missing then.
 */
export class BatchNeedsRecalculationError extends Error {
  constructor(public readonly employmentIds: string[]) {
    super(
      `This payroll run cannot be closed until ${employmentIds.length} employee${employmentIds.length === 1 ? '' : 's'} ${employmentIds.length === 1 ? 'is' : 'are'} recalculated: its transactions changed after it was processed.`,
    );
    this.name = 'BatchNeedsRecalculationError';
  }
}

/**
 * ADR-0076 slice 3 — the batch carries unresolved BLOCK anomalies (negative net, an over-cap statutory
 * contribution, a payable employee with no bank account, the same person paid twice in one period).
 *
 * WHY THESE BLOCK AND NOTHING STATISTICAL DOES. Every blocking detector is a tripwire with no threshold
 * and no history behind it — each one is an unambiguous bug, not a judgement about whether a figure looks
 * unusual. ADR-0076 open decision 2 settles it that way deliberately: block on the things that are simply
 * wrong, warn on everything that is merely surprising, because an untuned statistical detector that can
 * refuse to close payroll would be a worse failure than the thing it was trying to catch.
 *
 * ADDITIVE BY CONSTRUCTION. A batch with no verdict rows — every batch that predates this layer, and any
 * batch the evaluator has not been run against — behaves EXACTLY as before. The guard can only fire on
 * rows this layer wrote, which is what keeps the golden byte-identical statutory tests untouched.
 *
 * It names the employments so the operator can go straight to them, mirroring BatchNeedsRecalculationError.
 */
export class BatchHasBlockingAnomaliesError extends Error {
  constructor(public readonly employmentIds: string[]) {
    super(
      `This payroll run cannot be closed until ${employmentIds.length} blocking anomal${employmentIds.length === 1 ? 'y is' : 'ies are'} resolved.`,
    );
    this.name = 'BatchHasBlockingAnomaliesError';
  }
}

/**
 * ADR-0076 §4 — the RUN-LEVEL circuit breaker tripped: the batch's total net moved further than the
 * configured percentage against the prior cycle.
 *
 * This is the failure the per-employee detectors are structurally blind to. A global mis-key — wrong pack
 * version, wrong period, a rate applied to everyone — moves EVERY employee together, so each individual
 * movement sits inside `net-swing`'s threshold while the batch total moves by a third. Only the aggregate
 * sees it, which is why this is a separate gate and not another detector.
 *
 * THE ESCAPE HATCH IS THE THRESHOLD, not an override flag. A real bonus month or a group-wide increment
 * legitimately moves the total; the operator raises `batchSwingPct` for that company in
 * payroll_anomaly_config — versioned, audited and deploy-free.
 */
export class BatchSwingTooLargeError extends Error {
  constructor(
    public readonly movementPct: number,
    public readonly thresholdPct: number,
  ) {
    super(
      `This payroll run's total net pay moved ${movementPct}% against the previous cycle, beyond the ${thresholdPct}% limit. Confirm the run is correct, or raise the limit for this company.`,
    );
    this.name = 'BatchSwingTooLargeError';
  }
}

/** Payroll Reset (feedback a03b2d9b): the batch is not in the one state a reset is defined for.
 *  Draft = nothing to reset; Closed = permanently immutable (0011 trigger is the DB backstop). */
export class BatchNotResettableError extends Error {
  constructor() {
    super('Only a processed payroll process can be reset');
    this.name = 'BatchNotResettableError';
  }
}
/**
 * A blank / whitespace-only reason was supplied to resetProcessedBatch (feedback d1ed1e99). Reverting a
 * processed run to draft zeroizes payslips/totals + unwinds loans/claims — a sensitive, audited action, so
 * the reason is MANDATORY, letting the history log always explain WHY a run was reset. Thrown BEFORE any
 * deletion / status change so nothing is mutated. Mirrors UnlockReasonRequiredError. */
export class ResetReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to revert a processed payroll to draft.');
    this.name = 'ResetReasonRequiredError';
  }
}

/** Pre-processing validation (feedback f1564110, Phase 1): one or more in-scope, period-active
 *  employees fail a BLOCKING readiness check. It began as "no current compensation row" (before the
 *  check they were SILENTLY dropped, because the generation employee query inner-joins compensation)
 *  and has since taken on `zeroBasic`, `unpayablePayMode` (ADR-0078) and `tp3YearMismatch` (item
 *  1bb09a73). Generation fails closed until the profiles are completed (or the scope narrowed).
 *
 *  ⚠️ THE MESSAGE NAMES NO CAUSE, and item 1bb09a73 is why it stopped: it used to end "has no current
 *  salary record", which was already untrue for two of the four blockers and would have sent an
 *  operator hunting a salary record over a Form TP3 year mismatch. The per-employee CAUSE is on the
 *  pre-processing checks card and in the screen's own translated message; this class carries the count.
 *
 *  ⚠️ THE PREFIX IS LOAD-BEARING. `reasonForError` in core/payroll-run-group.ts matches
 *  `/^Payroll cannot be processed: \d+ employees? in scope /` to map this to PRE_PROCESS_BLOCKED, so the
 *  text up to and including "in scope " may not change without changing that regex with it. */
export class PreProcessBlockedError extends Error {
  constructor(public readonly count: number) {
    super(
      `Payroll cannot be processed: ${count} employee${count === 1 ? '' : 's'} in scope ${count === 1 ? 'is' : 'are'} not ready — see the pre-processing checks`,
    );
    this.name = 'PreProcessBlockedError';
  }
}

/**
 * fbcf706d — a posted reprocess id that is NEITHER on this run NOR eligible to join it.
 *
 * Until now the selective path only intersected the posted ids with the COMPANY, so a company-mate who
 * had never been part of the run was accepted and then silently dropped by the period/scope filters —
 * the operator saw "N reprocessed" for a person nothing had happened to. Now every posted id must be
 * one of two things (a payslip on this run, or period-eligible with none) and anything else is named.
 */
export class ReprocessNotOnBatchError extends Error {
  constructor(public readonly rows: { employmentId: string; name: string; employeeCode: string | null }[]) {
    const who = rows.map((r) => (r.employeeCode ? `${r.employeeCode} ${r.name}` : r.name)).join(', ');
    super(
      `${who} ${rows.length === 1 ? 'is' : 'are'} not on this payroll run and cannot be added to it: ` +
        'the employment is not active in this pay period (hired after it ended, or terminated before it began).',
    );
    this.name = 'ReprocessNotOnBatchError';
  }
}

/**
 * fbcf706d — someone being ADDED to a processed run is not ready to be paid.
 *
 * An add is a FIRST processing for that person, so it gets the same readiness gate a draft→processed run
 * applies — but run over the added employments ONLY, so a correction to somebody already paid is never
 * blocked by an unrelated gap elsewhere on the run. Before this, an added employment with no open salary
 * record was dropped by the earnings inner join and the run refused with "None of the selected employees
 * are active in this period.", which named nobody and was not true.
 */
export class ReprocessAddBlockedError extends Error {
  constructor(public readonly rows: { employmentId: string; name: string; employeeCode: string | null; gap: string }[]) {
    const who = rows.map((r) => `${r.employeeCode ? `${r.employeeCode} ` : ''}${r.name} (${r.gap})`).join('; ');
    super(
      `Cannot add ${rows.length} employee${rows.length === 1 ? '' : 's'} to this payroll run — ` +
        `their Personnel record is not ready: ${who}. Nothing was changed.`,
    );
    this.name = 'ReprocessAddBlockedError';
  }
}

/**
 * fbcf706d — an ADD whose payslip would pay a claim allowance that no claim on this run accounts for.
 *
 * THE DOUBLE PAYMENT THIS EXISTS TO STOP. `payroll_input.claim_allowance` is written by the claims
 * prefill and by nothing else, and the prefill reserves the claim onto the batch at the same moment.
 * When a full generation then writes no payslip for that employment, it REQUEUES the claim (the link is
 * cleared, the status stays approved) but leaves the prefilled `claim_allowance` row behind. Adding that
 * employment to the processed run later would pay the allowance a second time — once here, out of a
 * payslip that settles nothing, and once again on whichever run picks the requeued claim up.
 *
 * Detecting it is exact rather than heuristic: for an employment being added, the claims still reserved
 * on this batch must account for the allowance its payslip is about to pay, to the cent. Anything else
 * is a state this path cannot settle safely, so the whole add is refused and nothing is written.
 */
export class ReprocessAddLoanUnreconciledError extends Error {
  constructor(public readonly rows: { employmentId: string; deducted: number }[]) {
    super(
      `Cannot add ${rows.length} employee${rows.length === 1 ? '' : 's'} to this payroll run: their payslip would deduct ` +
        rows.map((r) => `a loan instalment of ${r.deducted.toFixed(2)}`).join('; ') +
        ' with no instalment held on this run to settle, so the money would come off their pay without coming off their loan balance. ' +
        'Clear the stale loan deduction on this run first. Nothing was changed.',
    );
    this.name = 'ReprocessAddLoanUnreconciledError';
  }
}

export class ReprocessAddClaimUnreconciledError extends Error {
  constructor(public readonly rows: { employmentId: string; allowance: number; reserved: number }[]) {
    super(
      `Cannot add ${rows.length} employee${rows.length === 1 ? '' : 's'} to this payroll run: their payslip would pay ` +
        rows.map((r) => `a claim allowance of ${r.allowance.toFixed(2)} against ${r.reserved.toFixed(2)} of claims still held on this run`).join('; ') +
        '. Settle or re-approve the claim first — paying it here would leave it payable again on the next run. Nothing was changed.',
    );
    this.name = 'ReprocessAddClaimUnreconciledError';
  }
}

/** A typed pay component that v1 cannot compute correctly (a non-payable/BIK or PCB-only taxable
 *  earning) reached payroll generation. Fail-closed rather than silently under-tax (ADR-0025 §5). */
export class UnsupportedPayComponentError extends Error {
  constructor(code: string) {
    super(`Pay component "${code}" is taxable but not supported in this version (non-payable/PCB-only). Remove it from payroll or wait for a later release.`);
    this.name = 'UnsupportedPayComponentError';
  }
}

/**
 * One line of `statutory.recordLines` — the itemised list a payslip carries beside its totals.
 *
 * f35f758a ADDED `nonPayable`, AND IT IS THE WHOLE POINT OF NAMING THIS TYPE. The array has been a MIXED
 * population since f1564110 phase 3: record-only benefits in kind, which never touch cash, sit in the same
 * list as named provenance for one-off transactions, which were paid. Until now nothing on the line said
 * which it was, so no reader could split them — and guessing from today's `pay_component` flags would
 * answer with today's configuration about a month that has already been paid.
 *
 * STAMPED AT WRITE TIME, NEW PAYSLIPS ONLY. `nonPayable` is optional because every payslip written before
 * this shipped has no flag on any line. An unflagged list must be rendered as ONE list, exactly as it is
 * today — it cannot be separated after the fact and pretending otherwise would print a guess as a fact.
 */
export type PayslipRecordLine = {
  code: string;
  name: string;
  amount: number;
  /** True ⇒ recorded but never paid (a BIK). False ⇒ money that moved. Absent ⇒ written before the stamp. */
  nonPayable?: boolean;
};

/** f1564110 Phase 3 — INDIVIDUAL_TXN_PAY_ENABLED's earning/deduction fold RIDES the typed-pay-component
 *  path (the picked component's statutory flags/rounding drive the treatment). With
 *  TYPED_PAY_COMPONENTS_ENABLED off there is no per-component fold to ride, so a batch that carries
 *  payable one-off rows FAILS CLOSED at generation instead of silently leaving the rows unpaid
 *  (documented dependency — the anchor target and the demo run both flags on). */
export class IndividualTxnRequiresTypedComponentsError extends Error {
  constructor() {
    super('Individual-transaction pay requires typed pay components: this run carries one-off earning/deduction rows but TYPED_PAY_COMPONENTS_ENABLED is off. Enable typed components or remove the rows.');
    this.name = 'IndividualTxnRequiresTypedComponentsError';
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// r226 — WHAT AN ADDITIONAL RUN ACTUALLY PAYS, AS A ROUTING TEST ON ONE PAY ITEM
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// A Bonus / Off-cycle / Adjustment run used to process EVERY employee of the company, so a run where
// five people had a bonus wrote forty-five payslips, forty of them entirely zero. `generatePayslips`
// now skips the people such a run has nothing to do for, and this is the one question that skip cannot
// answer from the raw data alone: EVERY employee has recurring pay items, and no additional run pays a
// single one of them unless it routes to additional remuneration.
//
// AN ADDITIONAL RUN'S GROSS IS THE BONUS BUCKET AND NOTHING ELSE. `grossPay = round2(bonus)`:
// `slipBasic`, `slipAllowance`, `slipOvertime` and `slipUnpaid` are forced to 0, the one-off OT and
// unpaid ledger rows fold to 0 (`txnOt` / `txnUnpaid`), the manual deduction, CP38 and the loan
// instalment are 0, and a prefilled claim rides the allowance line that is zeroed. So "will this item
// be paid by this run" reduces to "does it land in `bonus`", which is what this answers.
//
// IT IS NEVER A COMPUTED ZERO, and that limit is structural rather than careful: this reads a pay
// item's CLASSIFICATION, never a worked-out figure. A full month of unpaid leave legitimately earns
// zero and still has a real payslip with real statutory bases (`wagesExOt`'s Math.max in
// generatePayslips); nothing here can reach that number.
//
// THE BIAS IS ONE-WAY. When it cannot answer with certainty it says PAYS. A false "pays" costs one zero
// payslip — exactly today's behaviour. A false "pays nothing" costs somebody their money. Hence a pay
// item carrying a RULE (its amount is resolved later, against a scope this has no access to) counts as
// paying, and an exemption code that might route the whole amount into the untaxed `reimburse` bucket
// is still treated as reaching the bonus box.

/** The pay-item facts `paysOnAdditionalRun` reads. Structurally satisfied by generatePayslips' CompRow. */
export type AdditionalRunPayRow = {
  code: string;
  kind: string;
  amount: number;
  nonPayable: boolean;
  epf: boolean;
  socso: boolean;
  epfBonus2012: boolean;
  pcbRemunerationType: 'normal' | 'additional' | 'optional_deduction' | null;
  rule: PayRule | null;
};

/**
 * Would this ONE pay-component row put money in the bucket an additional run actually pays (`bonus`)?
 *
 * Term for term the routing `earningsOf` performs, read in the same order, so the two cannot drift:
 *   • BASIC is inert in the engine (the Personnel compensation record is the basic-pay source);
 *   • a deduction never reaches gross, and an additional run's `rawManual` is 0, so it pays nothing;
 *   • an `optional_deduction` classification lands in `lpDeclared` (zeroed on an additional run) and its
 *     cash in `reimburse`/`deduct` (both zeroed) — nothing of it reaches the bonus box;
 *   • a non-payable (BIK) row is a record line and never cash;
 *   • the DECLARED stream then decides: 'additional' (or the epfBonus2012 forcing) rides the bonus box,
 *     'normal' rides the Y1 wage box which an additional run zeroes;
 *   • with no declaration the legacy flag inference applies, and `epf && !socso` is the bonus box.
 */
export function paysOnAdditionalRun(c: AdditionalRunPayRow): boolean {
  if (c.code === 'BASIC') return false;
  if (c.kind === 'deduction') return false;
  if (c.pcbRemunerationType === 'optional_deduction') return false;
  if (c.nonPayable) return false;
  const stream = c.epfBonus2012 ? 'additional' : c.pcbRemunerationType;
  if (stream === 'normal') return false;
  if (stream !== 'additional' && !(c.epf && !c.socso)) return false;
  // It routes to the bonus box. A ruled item's amount is resolved later, against a scope this predicate
  // does not build — so it counts as paying (the one-way bias above). A stored amount speaks for itself.
  return c.rule != null || Math.abs(Number(c.amount)) > 0;
}

/** One employee an additional run did not process, named for the result screen. */
export type SkippedEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  reason: PayrollSkipReason;
};

/**
 * Why an employee was left out of a run. A value rather than a boolean so a second cause can be added
 * without every reader having to change shape — and r227 is that second cause arriving. It is
 * deliberately NOT a member of `RunGroupReasonCode` (core/payroll-run-group.ts): that union is a
 * COMPANY-level FAILURE, rendered in red on the result page, and a skip is neither a failure nor
 * company-level.
 *
 *   • NO_TRANSACTION_FOR_CYCLE   — nothing is keyed for this person on this run, and the draft screen's
 *                                  "what will this run pay" card lists them nowhere either.
 *   • NO_ADDITIONAL_PAY_THIS_RUN — the card DOES list them (a standing monthly pay item), but none of it
 *                                  is additional remuneration, which is all an additional run pays. r227
 *                                  exists because printing the first sentence about this person
 *                                  contradicts the screen the operator just read. See the reason block
 *                                  in `generatePayslips` for why the fix is the sentence, not the skip.
 */
export type PayrollSkipReason = 'NO_TRANSACTION_FOR_CYCLE' | 'NO_ADDITIONAL_PAY_THIS_RUN';

/**
 * ADR-0033 — a worked day already banked as time-in-lieu contributes NO overtime. Cash XOR leave.
 *
 * ONE PREDICATE, TWO READERS, and that is the point of hoisting it (review r2). `attendance.otMinutes`
 * is read twice in this file: once to prefill the OT lines (`prefillOvertime`) and once to weight the
 * cross-cycle net disbursement for weekly/bi-weekly runs (`generatePayslips`). Only the first carried
 * this clause, so on those schedules a TOIL-banked day contributed nothing to the OT total while still
 * pulling the employee's net toward the cycle it fell in — two reads of the same column answering
 * different questions about the same day. Sharing the expression makes them agree by construction.
 *
 * `status <> 'lapsed'` because a lapsed accrual was never compensated as leave, so its day is legitimately
 * back on the cash side.
 *
 * 3fb1a611 (r299) — AND NOT 'reversed'. HR reversing a credit on the Leave Credit screen means the day was
 * never banked: the register row stays (a reversal never deletes) with status 'reversed' beside an offsetting
 * ledger debit, and that day's overtime is payable again. Leaving 'reversed' inside this exclusion would give
 * the balance back while keeping the overtime unpaid forever — the money half of the reversal silently not
 * happening. test/r299-leave-credit-money.test.ts pins both reads.
 *
 * UNCONDITIONAL, i.e. NOT behind the `toil` entitlement (finding F15). The clause used to sit inside the
 * TOIL_ENABLED branch, which made the cash-XOR-TOIL invariant itself a feature flag: bank a day while
 * the gate is on, lose the gate, and the same worked day is also paid as overtime cash. Under a
 * deployment flag that took an operator editing .env; under a per-tenant entitlement it becomes an
 * ordinary commercial event — a lapsed trial, a downgrade — silently double-paying everyone who had
 * banked TOIL. With no `toil_accrual` rows the `not exists` is always true, so this is byte-identical
 * for a tenant that never used TOIL.
 *
 * THE INVARIANT IS ONE-DIRECTIONAL, and saying otherwise would be false. This closes TOIL-then-cash. The
 * reverse ordering — prefill a rest day's OT, then bank the same day as TOIL — is not closed here or in
 * `accrueToilTx`, which reads neither `payroll_input` nor `payslip`; see the note at core/toil.ts's
 * duplicate check, which also records why slice 3 is what makes that ordering REACHABLE (the accrual
 * path used to refuse everyone) and why the mirror guard cannot be a `payroll_input` existence test:
 * `overtime_amount` is a per-batch aggregate with no per-day attribution. Closing it is an ADR-0033
 * question about payroll-run state, not an entitlement one; test/toil.ts pins the current behaviour.
 */
const EXCLUDE_TOIL_BANKED_DAYS = sql`not exists (
  select 1 from toil_accrual ta
   where ta.employment_id = ${attendance.employmentId}
     and ta.worked_date = ${attendance.attendanceDate}
     and ta.status not in ('lapsed', 'reversed'))`;

// Per-component payable-amount rounding (ADR-0035 1A, #15). 'none' keeps exact 2dp (legacy ⇒ the gated
// path stays byte-identical when no component opts in); up/down/nearest round to a whole ringgit. This
// only shapes a component's own cash amount — statutory contribution rounding is untouched.
const roundAmount = (n: number, method?: string | null): number => {
  switch (method) {
    case 'up':
      return Math.ceil(round2(n));
    case 'down':
      return Math.floor(round2(n));
    case 'nearest':
      return Math.round(round2(n));
    default:
      return round2(n);
  }
};

// Wave 2C (ADR-0024): an additional same-month run's statutory contribution is the INCREMENT of the
// cumulative month — re-run the month with/without this run's additional remuneration and take the
// delta (clamped ≥ 0, §6). Non-contribution fields (version, …) carry from `now`.
const DELTA_KEYS = [
  'epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer', 'pcb', 'pcbBonus',
] as const;
/**
 * `before` is deliberately NOT `T`. It is read for the DELTA_KEYS and for `pcb` and nothing else, and
 * ADR-0085 step 5 hands it a bare bag of those keys — "what this month's earlier runs were already
 * charged" — which is not a statutory result and must not have to pretend to be one.
 */
function deltaStat<T extends Record<string, unknown>>(now: T, before: Record<string, unknown>): T {
  const out = { ...now };
  for (const k of DELTA_KEYS) {
    (out as Record<string, unknown>)[k] = Math.max(0, round2(Number(now[k] ?? 0) - Number(before[k] ?? 0)));
  }
  // ── 45df860a — WHAT THE CARRIED-THROUGH PCB WORKING ACTUALLY EXPLAINS ──
  // The loop above rewrites the DELTA_KEYS and nothing else, so `pcb` leaves here as the INCREMENT while
  // `pcbMeta` — riding through `{ ...now }` untouched, because it is not a contribution field — is still
  // the CUMULATIVE month's working: its P, its bracket, its two MTD legs. The two are different numbers,
  // and a screen that printed the one as the derivation of the other would present a complete, correct
  // LHDN formula as the explanation of an amount nobody deducted. That is the same failure a hand-set PCB
  // creates (2961a7ae), so it is recorded the same way: stamp the two figures the delta was taken
  // between, and `core/pcb-explain.ts` reports `pcbSystem` (what the working explains) against `pcb`
  // (what was deducted) with a banner saying which is which. Additive key on a jsonb blob — no DDL, no
  // amount moves, and an older payslip simply has no stamp.
  const meta = now.pcbMeta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    (out as Record<string, unknown>).pcbMeta = {
      ...(meta as Record<string, unknown>),
      delta: {
        /** The whole month's PCB — the figure `pcbMeta` below it is the working for. */
        cumulative: round2(Number(now.pcb ?? 0)),
        /** The month's PCB WITHOUT this run's additional remuneration: what the earlier runs carried. */
        prior: round2(Number(before.pcb ?? 0)),
        /** The month's additional-remuneration leg, so the screen's normal/additional split describes the
         *  same month as the working rather than mixing a cumulative total with an incremental leg. */
        cumulativeBonus: round2(Number(now.pcbBonus ?? 0)),
      },
    };
  }
  return out;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Exported for core/payroll-individual-txn.ts (1.2.2) so the dated-ledger date-in-period check derives the
// same month bounds the kernel uses, rather than replicating drifting calendar math.
export function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month1 - 1];
}

// ─────────── 49e7e0a2 — the recalculation mark (see payroll_batch.needsRecalcAt in db/schema.ts) ───────────

/** What a run owes: the instant it was marked, and the employments whose figures are stale. */
export type BatchRecalcState = { needsRecalcAt: Date | null; employmentIds: string[] };

const asIdArray = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];

/**
 * Mark a PROCESSED run as owing a recalculation for these employments, inside the caller's transaction.
 *
 * Called by the one-off transaction ledger (core/payroll-individual-txn.ts) on every add / change / remove
 * that lands on a run which has already been processed. It is deliberately a no-op for a draft run: a
 * draft has no payslips, so nothing can be stale.
 *
 * The batch row is locked FOR UPDATE first. The employment set is a read-modify-write, and two admins
 * editing two employees on the same run at the same time would otherwise be able to drop one of them —
 * which is precisely the silent loss this whole mechanism exists to prevent.
 *
 * Appends `payroll-batch.recalc-required` so the run's own History says when its inputs moved and for whom
 * (references only — no amounts; ADR-0030 Layer 0).
 */
export async function markBatchNeedsRecalc(
  tx: Tx,
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[] },
): Promise<void> {
  const adding = asIdArray(p.employmentIds);
  if (adding.length === 0) return;
  const [row] = await tx
    .select({ status: payrollBatch.status, ids: payrollBatch.recalcEmploymentIds, at: payrollBatch.needsRecalcAt })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, p.batchId))
    .for('update')
    .limit(1);
  // A draft run recalculates by being generated; a closed run cannot be written at all (the ledger's own
  // guard refuses first, and 0011 is the DB backstop). Neither is a mark.
  if (!row || row.status !== 'processed') return;
  const next = [...new Set([...asIdArray(row.ids), ...adding])];
  await tx
    .update(payrollBatch)
    .set({ needsRecalcAt: row.at ?? new Date(), recalcEmploymentIds: next })
    .where(eq(payrollBatch.id, p.batchId));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'payroll-batch',
    aggregateId: p.batchId,
    eventType: 'payroll-batch.recalc-required',
    actor: actorOf(ctx),
    payload: { employmentIds: next, addedEmploymentIds: adding },
  });
}

/**
 * ── Feedback 017d9c25 (r187) — a Pay Item save marks the runs it makes stale ───────────────────────
 *
 * WHY THIS EXISTS. Keying a one-off transaction against a processed run already marks it (the four
 * calls in core/payroll-individual-txn.ts); recomputing attendance already marks it. Changing a Pay
 * Item's statutory configuration did NOT — which is exactly why the reporter's January figures sat
 * there looking settled after they unticked EPF. The run said nothing, and Close would have accepted
 * it. Now the run says "needs reprocessing", names the employees, and refuses to close (the refusal
 * already exists at closeBatch; app/payroll/[batchId]/page.tsx already renders `needsRecalc`).
 *
 * WHO IS AFFECTED — three signals, unioned, because no single one is complete:
 *   1. the payslip itemises the code in `statutory.componentLines` (the r-862ed0ad provenance). This is
 *      the strongest signal and covers the reporter's case, but it is absent on every payslip written
 *      before that item shipped, and on any run where the component resolved to zero. 6b134681 WIDENS
 *      this signal, deliberately: an additional/off-cycle run now carries a bonus-only stamp, so editing
 *      a pay item marks stale bonus runs it previously missed. Signals (2) and (3) already reached most
 *      of those; the widening only makes the answer complete, and it moves no money;
 *   2. the employment holds a live (non-superseded) `employment_pay_component` row for the component —
 *      covers a recurring item on a run whose slips predate componentLines;
 *   3. a one-off ledger row (`payroll_individual_txn`) on the batch names the component.
 *
 * ONLY PROCESSED, UNCLOSED RUNS. `markBatchNeedsRecalc` itself refuses anything but `processed`, so a
 * draft (nothing to be stale) and a closed run (frozen; 0011 guards it at trigger level) are both
 * no-ops here — the status filter below is a narrowing for cost, not the correctness boundary.
 *
 * ONLY A STATUTORY-RELEVANT EDIT. The caller decides, from the `changed` field-name list the save
 * already computes, via `isStatutoryRelevantChange` — renaming a Pay Item moves no money and must not
 * make every open run in the tenant look stale.
 */
export async function markRunsAffectedByPayComponent(
  ctx: SessionContext,
  p: { componentId: string; code: string },
): Promise<{ batchId: string; employmentIds: string[] }[]> {
  return withTenant(ctx, async (tx) => {
    const open = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.tenantId, ctx.tenantId), eq(payrollBatch.status, 'processed')));
    if (open.length === 0) return [];
    const openIds = open.map((b) => b.id);

    const byBatch = new Map<string, Set<string>>();
    const add = (batchId: string, employmentId: string) => {
      const s = byBatch.get(batchId) ?? new Set<string>();
      s.add(employmentId);
      byBatch.set(batchId, s);
    };

    // (1) the payslip itemises this code. `componentLines` is a jsonb ARRAY of {code,name,amount,buckets},
    // so the containment operator reads it directly — no per-row unnest, and it uses the jsonb index shape.
    const itemised = await tx
      .select({ batchId: payslip.batchId, employmentId: payslip.employmentId })
      .from(payslip)
      .where(
        and(
          inArray(payslip.batchId, openIds),
          sql`${payslip.statutory} -> 'componentLines' @> ${JSON.stringify([{ code: p.code }])}::jsonb`,
        ),
      );
    for (const r of itemised) add(r.batchId, r.employmentId);

    // (2) a live recurring assignment of this component, on an employment that has a slip on the run.
    const recurring = await tx
      .select({ batchId: payslip.batchId, employmentId: payslip.employmentId })
      .from(payslip)
      .innerJoin(employmentPayComponent, eq(employmentPayComponent.employmentId, payslip.employmentId))
      .where(
        and(
          inArray(payslip.batchId, openIds),
          eq(employmentPayComponent.componentId, p.componentId),
          isNull(employmentPayComponent.supersededAt),
        ),
      );
    for (const r of recurring) add(r.batchId, r.employmentId);

    // (3) a one-off ledger row on the run naming this component.
    const oneOff = await tx
      .select({ batchId: payrollIndividualTxn.batchId, employmentId: payrollIndividualTxn.employmentId })
      .from(payrollIndividualTxn)
      .where(
        and(
          inArray(payrollIndividualTxn.batchId, openIds),
          eq(payrollIndividualTxn.componentId, p.componentId),
        ),
      );
    for (const r of oneOff) if (r.batchId) add(r.batchId, r.employmentId);

    const marked: { batchId: string; employmentIds: string[] }[] = [];
    for (const [batchId, set] of byBatch) {
      const employmentIds = [...set];
      await markBatchNeedsRecalc(tx, ctx, { batchId, employmentIds });
      marked.push({ batchId, employmentIds });
    }
    return marked;
  });
}

/**
 * Clear the mark for the employments that have just been recalculated. When nothing is left waiting, the
 * timestamp is cleared with the set — the two are always written together, so "marked but nobody waiting"
 * is not a state this can produce.
 *
 * `employmentIds: null` clears the whole mark, which is what a full regenerate and a reset-to-draft do:
 * both replace or destroy every payslip on the run, so nothing can still be stale afterwards.
 */
export async function clearBatchRecalc(
  tx: Tx,
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[] | null },
): Promise<void> {
  const [row] = await tx
    .select({ ids: payrollBatch.recalcEmploymentIds, at: payrollBatch.needsRecalcAt })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, p.batchId))
    .for('update')
    .limit(1);
  if (!row || row.at == null) return;
  const done = p.employmentIds == null ? null : new Set(asIdArray(p.employmentIds));
  const remaining = done == null ? [] : asIdArray(row.ids).filter((id) => !done.has(id));
  await tx
    .update(payrollBatch)
    .set({
      needsRecalcAt: remaining.length > 0 ? row.at : null,
      recalcEmploymentIds: remaining.length > 0 ? remaining : null,
    })
    .where(eq(payrollBatch.id, p.batchId));
  if (remaining.length === 0) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.recalc-cleared',
      actor: actorOf(ctx),
      payload: {},
    });
  }
}

/**
 * 0db616f3 (0437) — STAMP THE ONE-OFF LINES THIS RUN JUST PAID.
 *
 * Called from `generatePayslips` in the SAME transaction as the payslip inserts, so "there is a payslip"
 * and "the line is marked consumed" can never come apart. What it marks is the run, not a boolean: the
 * fold reads `consumed_batch_id IS NULL OR = this batch`, which keeps every legitimate re-run of THIS
 * run paying exactly what it paid before while refusing a SECOND run the same money.
 *
 * `isNull(consumedBatchId)` in the predicate is why `consumed_at` stays the instant of the FIRST payment:
 * a reset→re-generate cycle, or a selective reprocess, re-pays lines this run already owns and must not
 * re-date them. It also makes the call idempotent, which is what lets it sit on both the full-generation
 * and the subset-reprocess paths without either having to know what the other did.
 *
 * DELIBERATELY NOT GATED ON WHETHER THE ROW'S KIND MOVED CASH. A 'leave' row is record-only and an
 * overtime row on an additional run folds to zero, but both were INCLUDED in the payslip this run wrote —
 * they appear on it as named provenance lines. "Included" is the claim the marker makes, and the marker
 * only ever stops the SAME line being included by a DIFFERENT run, which is never right for any kind.
 *
 * r226 — AND "INCLUDED IN THE PAYSLIP THIS RUN WROTE" IS NOW LOAD-BEARING RATHER THAN DESCRIPTIVE. An
 * additional run skips an employee it has nothing to pay, so `employmentIds` is the list of people who
 * actually got a payslip, NOT the list the run selected. The caller passes `emps` and `emps` has already
 * been narrowed to the paid set — which is the entire reason the skip is implemented as a narrowing of
 * `emps` rather than as a filter at the insert. Pass this a selected-but-unpaid employment and its
 * one-off rows are stamped consumed by a run that paid nothing: the amount then disappears from every
 * future run's fold with no payslip anywhere and no error.
 */
async function markIndividualTxnsConsumed(
  tx: Tx,
  p: { batchId: string; employmentIds: string[] },
): Promise<void> {
  if (p.employmentIds.length === 0) return;
  await tx
    .update(payrollIndividualTxn)
    .set({ consumedBatchId: p.batchId, consumedAt: new Date() })
    .where(
      and(
        eq(payrollIndividualTxn.batchId, p.batchId),
        inArray(payrollIndividualTxn.employmentId, p.employmentIds),
        isNull(payrollIndividualTxn.consumedBatchId),
      ),
    );
}

/**
 * 0db616f3 (0437) — RELEASE the lines a run consumed, because its payslips no longer exist.
 *
 * Called from the two places that destroy a run's payslips: `resetProcessedBatch` (back to draft for a
 * correction) and `teardownDraftChildren` (draft delete, where the rows are detached to survive as
 * keyed-in business records). A line whose payslip has been deleted has NOT been paid, and leaving it
 * marked would strand real money — the row would silently drop out of every future run's fold with no
 * error anywhere.
 *
 * Keyed on `consumed_batch_id`, NOT on `batch_id`, on purpose: after a hand repair re-points a row to
 * another run those two disagree, and it is the run that PAID which has to release it.
 *
 * 9066bd6c — `employmentIds` NARROWS the release to a subset of the run's people, which is what a
 * per-employee removal needs: only the payslips of the selected employments are deleted, so only THEIR
 * one-off lines stop being paid. `null` (the two batch-wide callers: reset and draft teardown) is the
 * original whole-run behaviour, byte-identical. An EMPTY array is honoured as "nobody", never widened
 * to "everybody" — a caller that computed an empty selection must not release the whole run.
 */
async function releaseIndividualTxnsConsumed(
  tx: Tx,
  batchId: string,
  employmentIds: string[] | null = null,
): Promise<void> {
  if (employmentIds != null && employmentIds.length === 0) return;
  await tx
    .update(payrollIndividualTxn)
    .set({ consumedBatchId: null, consumedAt: null })
    .where(
      employmentIds == null
        ? eq(payrollIndividualTxn.consumedBatchId, batchId)
        : and(
            eq(payrollIndividualTxn.consumedBatchId, batchId),
            inArray(payrollIndividualTxn.employmentId, employmentIds),
          ),
    );
}

/**
 * What a run has already sent downstream — a payment file exported, statutory returns recorded.
 *
 * EXTRACTED, NOT REWRITTEN. `unlockClosedBatch` has derived exactly these three facts since 9bc442bc, for
 * exactly this purpose (warn before touching a run whose figures have already left the building). The
 * Individual Transaction screen needs the same warning before it saves an edit onto a processed run, and a
 * second implementation of "has this been paid and filed" is a second answer waiting to disagree with the
 * first. `unlockClosedBatch` now calls this.
 */
export async function batchDownstreamWarnings(
  tx: Tx,
  p: { batchId: string; companyId: string; payPeriod: string },
): Promise<{
  paymentDisbursed: boolean;
  statutoryFiled: boolean;
  statutoryFiledCount: number;
  statutoryReportCount: number;
}> {
  const [{ n: paymentExports } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(domainEvent)
    .where(and(eq(domainEvent.aggregateId, p.batchId), eq(domainEvent.eventType, 'payroll-batch.payment-summary.exported')));
  const statReports = await tx
    .select({ id: statutoryReport.id, status: statutoryReport.status })
    .from(statutoryReport)
    .where(and(eq(statutoryReport.companyId, p.companyId), eq(statutoryReport.periodKey, p.payPeriod)));
  // r292 / readiness 3.2 — `statutoryFiled` NOW MEANS FILED.
  //
  // It used to be `statReports.length > 0` — the existence of ANY artefact — and until r292 every row
  // this table has ever held was 'draft' (all 20 on production), because nothing could set anything
  // else. So the amber "statutory returns have already been filed for this month" banner on Unlock,
  // Reset, Remove-employee and the Individual Transaction screen fired when somebody had pressed
  // "Record generation" on a PREVIEW, and could never fire when a return had really been lodged. It
  // misled in BOTH directions, and the false-positive half is the more expensive one: an operator who
  // learns the banner cries wolf ignores it on the day it is right.
  //
  // `STATUTORY_FILED_STATUSES` is IMPORTED rather than re-listed here. Two copies of "which statuses
  // count as filed" is how a fifth status ships that only half the codebase believes in.
  //
  // ⚠️ `statutoryReportCount` KEEPS ITS OLD MEANING — every artefact recorded for the month — because
  // that is what the `statutoryReportsForPeriod` audit payloads have always recorded and silently
  // re-pointing a historical audit field at a narrower set would make old and new events incomparable.
  // The screens that say the word "filed" read `statutoryFiledCount` instead.
  const filed = statReports.filter((r) => (STATUTORY_FILED_STATUSES as readonly string[]).includes(r.status));
  return {
    paymentDisbursed: Number(paymentExports) > 0,
    statutoryFiled: filed.length > 0,
    statutoryFiledCount: filed.length,
    statutoryReportCount: statReports.length,
  };
}

/**
 * 49e7e0a2 — read a run's recalculation mark together with what it has already sent downstream, for the
 * warning the Individual Transaction screen shows BEFORE a save lands on a processed run.
 *
 * Read-only: no write, no DomainEvent. Returns null for an id this session cannot see (RLS fences the
 * tenant; the caller fences the company scope).
 */
export function batchEditImpact(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<
  | null
  | (BatchRecalcState & {
      companyId: string;
      status: 'draft' | 'processed' | 'closed';
      payPeriod: string;
      paymentDisbursed: boolean;
      /** r292 — TRUE means a return for this month has really been LODGED, not merely generated. */
      statutoryFiled: boolean;
      statutoryFiledCount: number;
      statutoryReportCount: number;
    })
> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        needsRecalcAt: payrollBatch.needsRecalcAt,
        ids: payrollBatch.recalcEmploymentIds,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return null;
    const warnings = await batchDownstreamWarnings(tx, {
      batchId: p.batchId,
      companyId: batch.companyId,
      payPeriod: batch.payPeriod,
    });
    return {
      companyId: batch.companyId,
      status: batch.status,
      payPeriod: batch.payPeriod,
      needsRecalcAt: batch.needsRecalcAt,
      employmentIds: asIdArray(batch.ids),
      ...warnings,
    };
  });
}

/** Payroll Process wizard (1d) — default payment date for a 'YYYY-MM' period from the company's
 *  configured pay day (company_payroll_config.payDay), clamped into the period so e.g. payDay=31 in a
 *  30-day month lands on the 30th. Null payDay ⇒ month-end (same default the pre-wizard '<period>-28'
 *  fallback approximated). Pure/unit-testable — no DB access. */
export function defaultPaymentDate(payPeriod: string, payDay: number | null | undefined): string {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const day = payDay == null ? dim : Math.min(Math.max(1, payDay), dim);
  return `${payPeriod}-${String(day).padStart(2, '0')}`;
}

/**
 * c7fdfcf6 (Payroll Schedule) — the COMPANY-level cut-off schedule for a batch: the company_payroll_config day
 * columns (the fallback tier) plus the company-default payroll policy's config (the policy tier). Loaded ONCE
 * per batch flow; each transaction type's window is then resolved via `cutOffWindowFor`. A company with no
 * config + no default policy resolves every window to the plain calendar month, so the kernel reads that swap
 * their hard-coded `[M-01 … M-end]` for the resolved window stay byte-identical. Derived read ⇒ no DomainEvent.
 */
async function loadBatchCutOffSchedule(
  tx: Tx,
  companyId: string,
): Promise<{ companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null }> {
  const [cpc] = await tx
    .select({
      cutOffDay: companyPayrollConfig.cutOffDay,
      overtimeCutOffDay: companyPayrollConfig.overtimeCutOffDay,
      claimCutOffDay: companyPayrollConfig.claimCutOffDay,
      unpaidLeaveCutOffDay: companyPayrollConfig.unpaidLeaveCutOffDay,
      attendanceCutOffDay: companyPayrollConfig.attendanceCutOffDay,
      defaultPayrollPolicyId: companyPayrollConfig.defaultPayrollPolicyId,
    })
    .from(companyPayrollConfig)
    .where(eq(companyPayrollConfig.companyId, companyId))
    .limit(1);
  const companyCfg: CompanyCutOffConfig | null = cpc
    ? {
        cutOffDay: cpc.cutOffDay,
        overtimeCutOffDay: cpc.overtimeCutOffDay,
        claimCutOffDay: cpc.claimCutOffDay,
        unpaidLeaveCutOffDay: cpc.unpaidLeaveCutOffDay,
        attendanceCutOffDay: cpc.attendanceCutOffDay,
      }
    : null;
  let defaultConfig: PayrollPolicyConfig | null = null;
  if (cpc?.defaultPayrollPolicyId) {
    const [pol] = await tx
      .select({ config: payrollPolicy.config, status: payrollPolicy.status })
      .from(payrollPolicy)
      .where(eq(payrollPolicy.id, cpc.defaultPayrollPolicyId))
      .limit(1);
    if (pol && pol.status === 'active') defaultConfig = (pol.config ?? null) as PayrollPolicyConfig | null;
  }
  return { companyCfg, defaultConfig };
}

/** Resolve the company-level cut-off window for one transaction type of a batch's period, from a loaded
 *  schedule. Byte-identical to `[M-01 … M-end]` when nothing is configured. */
function batchTypeWindow(
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  type: CutOffType,
  payPeriod: string,
): { start: string; end: string } {
  return cutOffWindowFor(type, sched.defaultConfig, sched.companyCfg, payPeriod);
}

/** c7fdfcf6 (Payroll Schedule) — resolve the company-level cut-off window for a transaction TYPE + period in one
 *  call (loads the schedule, then resolves). Exported so sibling prefills (e.g. claims) select transactions by
 *  the same schedule the payroll kernel uses. Calendar month when nothing is configured (byte-identical). */
export async function resolveBatchCutOffWindow(
  tx: Tx,
  companyId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const sched = await loadBatchCutOffSchedule(tx, companyId);
  return batchTypeWindow(sched, type, payPeriod);
}

/**
 * 1c1b321a (Recompute Attendance) — which ALREADY-PROCESSED runs of a company own a given set of
 * (employment, attendance date) pairs, so a recompute can raise those runs' existing needs-recalculation
 * notice instead of quietly editing a payslip that has been paid and filed.
 *
 * A run owns a pair when BOTH hold: the employment has a payslip on that run (the exact test for "this
 * person was in this run", rather than inferring it from the run's scope blob), and the date falls inside
 * that employment's ATTENDANCE cut-off window for the run's pay period — resolved per employment through
 * its assigned policy exactly as the payslip loop does, so a company whose employments sit on different
 * policies gets each person's own window rather than the company default.
 *
 * A thin READ over the private window helpers above, exported deliberately narrowly: the alternative was
 * widening `unionTypeWindow` / `employmentTypeWindow`, and this file is heavily covered — a narrow new
 * export is the smaller blast radius. Derived read ⇒ no DomainEvent (the caller's
 * `markBatchNeedsRecalc` appends the one event that belongs to the mark).
 *
 * Draft and closed runs are not returned at all: a draft recalculates by being generated, and a closed run
 * cannot be written — `markBatchNeedsRecalc` is already a no-op for both, and so is this.
 */
export async function batchesCoveringAttendanceDates(
  tx: Tx,
  p: { companyId: string; entries: { employmentId: string; date: string }[] },
): Promise<{ batchId: string; payPeriod: string; batchDate: string; employmentIds: string[] }[]> {
  if (p.entries.length === 0) return [];
  const batches = await tx
    .select({ id: payrollBatch.id, payPeriod: payrollBatch.payPeriod, batchDate: payrollBatch.batchDate })
    .from(payrollBatch)
    .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.status, 'processed')))
    .orderBy(payrollBatch.payPeriod);
  if (batches.length === 0) return [];
  const batchIds = batches.map((b) => b.id);
  const slips = await tx
    .select({ batchId: payslip.batchId, employmentId: payslip.employmentId })
    .from(payslip)
    .where(inArray(payslip.batchId, batchIds));
  const onRun = new Set(slips.map((s) => `${s.batchId}|${s.employmentId}`));
  const sched = await loadBatchCutOffSchedule(tx, p.companyId);
  // Keyed by employment+period: one employment's window differs BETWEEN periods, so caching on the
  // employment alone would hand January's window to February.
  const windows = new Map<string, { start: string; end: string }>();
  const windowFor = async (employmentId: string, payPeriod: string) => {
    const key = `${employmentId}|${payPeriod}`;
    const hit = windows.get(key);
    if (hit) return hit;
    const cfg = (await resolveAssignedPolicy(tx, employmentId))?.config ?? null;
    const w = cutOffWindowFor('attendance', cfg, sched.companyCfg, payPeriod);
    windows.set(key, w);
    return w;
  };
  const out: { batchId: string; payPeriod: string; batchDate: string; employmentIds: string[] }[] = [];
  for (const b of batches) {
    const hit = new Set<string>();
    for (const e of p.entries) {
      if (hit.has(e.employmentId)) continue;
      if (!onRun.has(`${b.id}|${e.employmentId}`)) continue;
      const w = await windowFor(e.employmentId, b.payPeriod);
      if (e.date >= w.start && e.date <= w.end) hit.add(e.employmentId);
    }
    if (hit.size > 0) {
      out.push({ batchId: b.id, payPeriod: b.payPeriod, batchDate: b.batchDate, employmentIds: [...hit].sort() });
    }
  }
  return out;
}

/**
 * c7fdfcf6 gap-fix (per-employment cut-off) — the UNION of a transaction TYPE's cut-off window across the
 * company-default schedule and EVERY active payroll policy in the company. A prefill query that must bound a
 * single fetch (it discovers which employments have rows only after the fetch) widens to this union, then filters
 * each row down to that employment's OWN policy window. When nothing anywhere shifts the window the union equals
 * the plain calendar month, so an unconfigured company fetches exactly `[M-01 … M-end]` (byte-identical).
 */
async function unionTypeWindow(
  tx: Tx,
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  companyId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const windows = [cutOffWindowFor(type, sched.defaultConfig, sched.companyCfg, payPeriod)];
  const pols = await tx
    .select({ config: payrollPolicy.config })
    .from(payrollPolicy)
    .where(and(eq(payrollPolicy.companyId, companyId), eq(payrollPolicy.status, 'active')));
  for (const pol of pols) {
    windows.push(cutOffWindowFor(type, (pol.config ?? null) as PayrollPolicyConfig | null, sched.companyCfg, payPeriod));
  }
  let start = windows[0].start;
  let end = windows[0].end;
  for (const w of windows) {
    if (w.start < start) start = w.start;
    if (w.end > end) end = w.end;
  }
  return { start, end };
}

/**
 * c7fdfcf6 gap-fix (per-employment cut-off) — resolve one transaction TYPE's cut-off window for a SPECIFIC
 * employment, from its ASSIGNED policy (company-default fallback, via resolveAssignedPolicy) → company column →
 * calendar month. Salary already resolves per-employment in the payslip loop; this extends the SAME per-employee
 * resolution to OT / attendance / leave so employments on different (non-default) policies each get their own
 * window instead of sharing the company default. Cached per employmentId; NEVER throws.
 */
async function employmentTypeWindow(
  tx: Tx,
  sched: { companyCfg: CompanyCutOffConfig | null; defaultConfig: PayrollPolicyConfig | null },
  cache: Map<string, { start: string; end: string }>,
  employmentId: string,
  type: CutOffType,
  payPeriod: string,
): Promise<{ start: string; end: string }> {
  const cached = cache.get(employmentId);
  if (cached) return cached;
  const cfg = (await resolveAssignedPolicy(tx, employmentId))?.config ?? null;
  const w = cutOffWindowFor(type, cfg, sched.companyCfg, payPeriod);
  cache.set(employmentId, w);
  return w;
}

/**
 * EA-1955 incomplete-month proration factor for a 'YYYY-MM' wage period: the employee is paid for
 * the calendar days they were employed within the month, over the number of days in that month
 * (Employment Act 1955 s.18A ordinary-rate basis). Returns 1 for a full month, 0 if not employed
 * during the period. Date strings are ISO ('YYYY-MM-DD'), so lexical comparison is chronological.
 *
 * 2.1.1 (ADR-0064): the DENOMINATOR and the eligible-day COUNT are now policy-configurable:
 *  - `divisorDays` overrides the calendar `daysInMonth` denominator (CustomDays divisor). null ⇒ calendar.
 *  - `workingDayBasis` (when supplied) counts only the employee's working days (Sat/Sun/PH include/exclude),
 *    matching the working-day calendar the leave module uses; absent ⇒ plain calendar days (legacy).
 * With NEITHER supplied this reduces EXACTLY to the legacy formula (proven byte-identical by the golden
 * matrix). The min(1,…) clamp is preserved so a CustomDays divisor < calendar days employed can never pay
 * more than a full month.
 */
function prorationFactor(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  opts?: {
    divisorDays?: number;
    workingDayBasis?: { roster: number[]; holidays: Set<string> };
    // c7fdfcf6 (Payroll Schedule) — the SALARY cut-off window overriding the calendar-month bounds. Absent ⇒
    // the calendar month `[M-01 … M-end]` (byte-identical to the legacy formula). When a policy/company cut-off
    // is configured, the join-date / resignation proration is counted against this window (e.g. anchor 26 ⇒
    // [26 of M-1 … 25 of M]) and the denominator is the window's own length in days — delivering the reporter's
    // "salary cut-off determines Basic Salary / Join-Date / Resignation proration".
    window?: { start: string; end: string };
  },
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = opts?.window?.start ?? `${payPeriod}-01`;
  const periodEnd = opts?.window?.end ?? `${payPeriod}-${String(dim).padStart(2, '0')}`;
  // Inclusive length of the window in days (cross-month safe). For the calendar-month default this equals `dim`.
  const windowDays =
    Math.round((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000) + 1;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  const denom = opts?.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : windowDays;
  if (opts?.workingDayBasis) {
    // Count the employee's WORKING days within [start, end] vs the working days across the whole period.
    const { roster, holidays } = opts.workingDayBasis;
    const isWork = (d: string): boolean => {
      const dt = new Date(`${d}T00:00:00Z`);
      const iso = ((dt.getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
      return roster.includes(iso) && !holidays.has(d);
    };
    let eligibleWork = 0;
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
      if (isWork(new Date(t).toISOString().slice(0, 10))) eligibleWork++;
    }
    // Working-day denominator: the configured CustomDays divisor when set, else the period's own working days.
    let denomWork = opts.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : 0;
    if (denomWork === 0) {
      for (let t = Date.parse(`${periodStart}T00:00:00Z`); t <= Date.parse(`${periodEnd}T00:00:00Z`); t += 86_400_000) {
        if (isWork(new Date(t).toISOString().slice(0, 10))) denomWork++;
      }
    }
    if (denomWork === 0) return 0;
    return Math.min(1, eligibleWork / denomWork);
  }
  // Cross-month-safe eligible-day count (inclusive). For a same-month calendar window this is identical to the
  // legacy `end.day − start.day + 1`.
  const eligibleDays =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return Math.min(1, Math.max(0, eligibleDays) / denom);
}

/**
 * 2.1.2 — Eligible WORKING days for a DAILY-rated employee in a wage period. Counts the employee's working
 * days (Mon–Fri roster) within [hiredOn, terminatedOn] ∩ the calendar month, MINUS public holidays. This is a
 * raw day COUNT (not a proration factor): a daily employee is paid `rate × this count`, so the monthly
 * proration path is bypassed entirely. A fully-out-of-window employment (hired after the period, or terminated
 * before it) yields 0 — the multiply then makes basic = 0, never a divide-by-zero. The Mon–Fri roster mirrors
 * the working-day basis the leave/proration primitives use; Sat/Sun and listed holidays are non-working.
 */
function eligibleWorkingDays(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  holidays: Set<string>,
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  let days = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
    if (iso <= 5 && !holidays.has(d)) days++;
  }
  return days;
}

/**
 * Unpaid-leave days per employment for a wage period, auto-derived from APPROVED requests of an
 * unpaid leave type (leave_type.paid = false) that START within the period. Single source of truth
 * with the leave module — no double entry. (Requests straddling a month boundary are attributed to
 * their start month; cross-month splitting is a documented future refinement.)
 */
/**
 * Approved unpaid-leave days to deduct this period, by employment. Policy: a request is deducted in
 * full in the month it STARTS (filter on startDate ∈ period). Splitting a request that straddles a
 * month boundary across both months would need per-day expansion keyed to each leave type's counting
 * mode (the model stores per-request totals, not per-day) — deliberately deferred as a rare edge case.
 */
/** 2ef69d1e — EXPORTED (was module-private) so core/back-pay.ts can ask, inside its own transaction,
 *  "did this already-paid month carry unpaid leave?". Read-only and behaviour-unchanged: the kernel's
 *  own call sites are untouched. Back pay needs it because `unpaidDeduction` is computed as
 *  `basicRaw / unpaidDivisor × unpaidDays` and is a SEPARATE deduction — it is not netted into
 *  `payslip.basic_salary` — so a backdated salary rise also raises the unpaid deduction. Arrears that
 *  reworked only the basic would therefore OVERPAY such a month, and pass 1 refuses the month instead. */
export async function unpaidDaysByEmployment(
  tx: Tx,
  periodStart: string,
  periodEnd: string,
  // c7fdfcf6 gap-fix (per-employment leave cut-off) — optionally scope to a set of employments so the caller
  // can resolve the LEAVE window PER employment (its assigned policy), then query per window-group. Omitted ⇒
  // tenant-wide (the legacy behaviour); the batch loop only ever reads its own employments' entries either way.
  employmentIds?: string[],
  // f3148da1 Step 5 (R17 gap-fix reinstatement) — when true, count ONLY partial-day unpaid absences (half-day
  // AM/PM + hourly requests, duration_type != 'full_day'): the "unpaid TIME OFF" subset the policy's
  // unpaidTimeOffDivisor values with its own formula. The batch loop queries this subset only for employments
  // whose config sets a distinct time-off divisor, so the default path issues no extra query.
  timeOffOnly = false,
): Promise<Map<string, number>> {
  // ADR-0068 §4A: for a per-date-approval request, deduct only the APPROVED dates, not the raw request span —
  // reading leave_request.days would count a mid-span rejected date as unpaid leave. We keep the current
  // "deduct in the month it STARTS" policy (filter on start_date ∈ period) and, per request, use the sum of
  // APPROVED leave_request_date.days when such rows exist, else the request's own `days` (unchanged path).
  const perDateDays = sql<string>`coalesce(
    (select sum(lrd.days) from leave_request_date lrd
      where lrd.leave_request_id = ${leaveRequest.id} and lrd.status = 'approved'),
    ${leaveRequest.days}
  )`;
  // Allow Unpaid Leave (feedback a7fab30b): a request can now be PARTLY unpaid — a paid leave type where the
  // balance covered only some of the days. Such a request must contribute its unpaid_days and nothing more,
  // whereas a wholly-unpaid request still contributes its whole (per-date-adjusted) span. Expressed as one
  // CASE so a request is counted exactly once whichever branch admitted it: a wholly-unpaid type never has
  // unpaid_days set, and a part-unpaid request is of a PAID type, so the two are disjoint by construction.
  // unpaid_days is NULL on every row that predates this column ⇒ the figure is unchanged for existing data.
  const unpaidDaysExpr = sql<string>`case
    when ${leaveType.paid} = false or ${leaveRequest.allowanceEligible} = false then ${perDateDays}
    else coalesce(${leaveRequest.unpaidDays}, 0)
  end`;
  const rows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      days: sql<string>`coalesce(sum(${unpaidDaysExpr}), 0)`,
    })
    .from(leaveRequest)
    .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
    .where(
      and(
        eq(leaveRequest.status, 'approved'),
        // Unpaid days are: (a) any request of an unpaid leave type, OR (b) Phase-B #13 (ADR-0062) — a
        // MATERNITY request whose s.37 paid ALLOWANCE was withheld (allowance_eligible=false), which keeps
        // the paid MATERNITY leave-type but is unpaid for the period. The per-request override wins over the
        // type default; allowance_eligible TRUE/NULL on a paid type stays paid. Plus (c) a7fab30b — the
        // uncovered portion of a request on a type that allows unpaid leave, which is what this route was
        // always for: the deduction is then worked out exactly as it is for any other unpaid day.
        or(
          eq(leaveType.paid, false),
          eq(leaveRequest.allowanceEligible, false),
          sql`${leaveRequest.unpaidDays} > 0`,
        ),
        gte(leaveRequest.startDate, periodStart),
        lte(leaveRequest.startDate, periodEnd),
        employmentIds && employmentIds.length > 0 ? inArray(leaveRequest.employmentId, employmentIds) : undefined,
        timeOffOnly ? ne(leaveRequest.durationType, 'full_day') : undefined,
      ),
    )
    .groupBy(leaveRequest.employmentId);
  return new Map(rows.map((r) => [r.employmentId, Number(r.days)]));
}

/** ADR-0068 §4A / §8 test #6 — the unpaid-leave days payroll would deduct for a period, by employment. A thin
 *  session wrapper around unpaidDaysByEmployment so the span-consumer correctness test can assert a per-date
 *  request's APPROVED-only days are deducted (2, not the raw 3), without standing up a full payroll batch. */
export function unpaidLeaveDaysForPeriod(
  ctx: SessionContext,
  periodStart: string,
  periodEnd: string,
): Promise<Map<string, number>> {
  return withTenant(ctx, (tx) => unpaidDaysByEmployment(tx, periodStart, periodEnd));
}

/** Optional batch subset (ADR-0035 1E, #23). Empty/absent ⇒ the whole company. */
export type BatchScope = { departmentIds?: string[]; employmentIds?: string[] };

/** Drop empty arrays; null when nothing specific is selected (⇒ whole company). */
function normalizeScope(scope?: BatchScope): BatchScope | null {
  const departmentIds = (scope?.departmentIds ?? []).filter(Boolean);
  const employmentIds = (scope?.employmentIds ?? []).filter(Boolean);
  if (!departmentIds.length && !employmentIds.length) return null;
  return { ...(departmentIds.length ? { departmentIds } : {}), ...(employmentIds.length ? { employmentIds } : {}) };
}

/**
 * Resolve a batch's scope to a concrete employment-id filter, shared by generatePayslips and every
 * prefill (OT/shift-diff/zakat/claims). Selected departments resolve to their CURRENT assignees, unioned
 * with any explicitly-named individuals. Returns `undefined` (no filter ⇒ whole company) when the scope
 * is empty/absent — identical to today's dynamic whole-company behaviour.
 */
export async function resolveBatchScopeFilter(
  tx: Tx,
  scope: BatchScope | null,
): Promise<{ filter: ReturnType<typeof inArray> | undefined; employmentIds: string[] | null }> {
  const scopeDeptIds = scope?.departmentIds ?? [];
  const scopeExplicitIds = scope?.employmentIds ?? [];
  if (!scopeDeptIds.length && !scopeExplicitIds.length) return { filter: undefined, employmentIds: null };
  const deptAssignees = scopeDeptIds.length
    ? await tx
        .select({ id: assignment.employmentId })
        .from(assignment)
        .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
    : [];
  const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
  return {
    filter: inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000']),
    employmentIds: scopeEmploymentIds,
  };
}

/**
 * c11e81aa — WHICH PERIOD-KEYED TRANSACTIONS THIS RUN MAY COLLECT, as cycle identities.
 *
 * ONE RULE, TWO READERS. `generatePayslips` uses it to decide what attach-on-generate stamps onto the
 * batch, and `pendingBatchMoney` (core/payroll-view.ts) uses it to decide what the "what will this run
 * pay?" card promises. Those two must never disagree — a card that promises money the run will not pay is
 * the exact failure the card exists to prevent — so the rule lives once, here, and is imported there.
 *
 * IT MATCHES CYCLE IDS, NOT RUN TYPES, AND THAT IS THE WHOLE POINT. The default catalogue maps THREE
 * cycles onto run_type 'off_cycle' — 'Off-cycle', 'Advance Salary', 'Mid-Month' (DEFAULT_PAYROLL_CYCLES,
 * core/payroll-cycle.ts). Matching on run type would let an "Advance Salary" run collect and pay a row the
 * operator deliberately saved as "Mid-Month": pay-affecting, silent, and indistinguishable on screen from
 * working correctly. So a non-regular run collects the rows that named ITS OWN cycle row and nothing else.
 *
 * REGULAR IS THE ONE CASE WHERE THE TYPE *IS* AN IDENTITY, and it is protected twice over: a company may
 * have at most one ACTIVE regular-mapped cycle (PayrollCycleRegularConflictError) and a pay period may
 * hold at most one regular BATCH (payroll_batch_one_regular_uq). No two runs can therefore compete for a
 * regular-cycle row, so the regular run takes every one of them — including rows naming an ARCHIVED
 * regular cycle, because replacing the company's monthly cycle must not strand money already keyed under
 * the old one. It also takes rows that named NO cycle, which is every row on production today.
 *
 * A NON-REGULAR RUN THAT NAMES NO CYCLE COLLECTS NOTHING, which is precisely today's behaviour (before
 * this change attach-on-generate refused every non-regular run outright). That covers legacy batches and
 * every caller that creates a run without naming its cycle.
 */
export type CollectingRun = { companyId: string; runType: string; payrollCycleId: string | null };

export async function collectableCycleIds(
  tx: Tx,
  batch: CollectingRun,
): Promise<{
  /** Intended-cycle ids this run may claim. Empty for a non-regular run with no cycle of its own. */
  cycleIds: string[];
  /** Does it also claim rows that named NO cycle? True only for the regular run. */
  collectsUnnamed: boolean;
  /** Nothing period-keyed is claimable at all — callers skip the statement rather than issue a false one. */
  collectsNothing: boolean;
}> {
  if (batch.runType !== 'regular') {
    const cycleIds = batch.payrollCycleId ? [batch.payrollCycleId] : [];
    return { cycleIds, collectsUnnamed: false, collectsNothing: cycleIds.length === 0 };
  }
  const regularCycles = await tx
    .select({ id: payrollCycle.id })
    .from(payrollCycle)
    .where(and(eq(payrollCycle.companyId, batch.companyId), eq(payrollCycle.runType, 'regular')));
  return { cycleIds: regularCycles.map((c) => c.id), collectsUnnamed: true, collectsNothing: false };
}

/** The `payroll_individual_txn.intended_cycle_id` predicate for a resolved `collectableCycleIds`. Never
 *  called when `collectsNothing` — there is no honest predicate for "claims nothing", only a skip. */
export function intendedCycleFilter(c: { cycleIds: string[]; collectsUnnamed: boolean }) {
  if (!c.collectsUnnamed) return inArray(payrollIndividualTxn.intendedCycleId, c.cycleIds);
  return c.cycleIds.length > 0
    ? or(isNull(payrollIndividualTxn.intendedCycleId), inArray(payrollIndividualTxn.intendedCycleId, c.cycleIds))
    : isNull(payrollIndividualTxn.intendedCycleId);
}

/** Payroll Process wizard (Step 1) — validate a user-supplied payment date (ISO 'YYYY-MM-DD'). Returns
 *  the date unchanged when valid, else null (caller falls back to the period default). */
function validPaymentDate(paymentDate?: string | null): string | null {
  if (!paymentDate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return null;
  const d = new Date(`${paymentDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : paymentDate;
}

/**
 * 00e28308 — THE RULESET VERSION A STATUTORY MONTH IS OPENED UNDER.
 *
 * `pay_period.statutory_version` has existed since migration 0066 and, outside the payroll-history
 * importer, nothing ever wrote it. 0066 stamped the periods it created from a child payslip's own
 * `statutory.version`; every month opened SINCE — by `createBatch` or `createAdditionalRun` — was
 * inserted with the column null, and no code path UPDATEs it, so it stayed null forever. A month
 * therefore carried no record of which statutory rules it was run under, which is the audit question
 * item 00e28308 asks. The comment that used to sit at the find-or-create below asserted that the
 * snapshot happened "when payslips are first generated (2C-4)"; no code did that, and the sentence is
 * why nobody noticed.
 *
 * STAMPED BY THE INSERT, AND BY NOTHING ELSE. That is what makes the two properties that matter
 * structural rather than merely tested:
 *   - a SECOND run in the same month find-or-creates, finds, and writes nothing — a recorded version
 *     can never move, and a month whose recorded version moved would be worse than one with none;
 *   - a period row that ALREADY EXISTS is reused untouched, so the deliberate absence on every month
 *     created before this change survives. There is no UPDATE here for a backfill to be added to.
 * `pay_period_company_period_uq` makes "the insert" happen exactly once per (company, month), so this
 * needs no definition of "first" that a deleted draft or a re-run could disagree with — which a
 * generation-time stamp would have needed, and which it could only have answered by writing to the
 * months the reporter asked us to leave alone.
 *
 * THE VERSION IS THE PACK'S, NEVER A LITERAL IN THE KERNEL. `loadRuleset(asOf: period end)` is the same
 * resolution `generatePayslips` performs — tenant override, then signed vendor pack, then the verified
 * built-in default, with the per-body overlay on top — and `.version` off it is the same string the
 * payslips stamp into `statutory.version` and the Borang A / CP39 filings report.
 *
 * NULL FOR A NON-STATUTORY COMPANY, and the pack lookup IS that test rather than a proxy for it:
 * `resolveCompanyTier` (core/company-tier.ts) makes "the country has a registered pack" and "the
 * company is statutory" the SAME fact — a packed country cannot be declared non-statutory, a packless
 * one cannot be statutory. A company whose statutory computation is refused by design records no
 * ruleset version, because none applied to it.
 *
 * WHAT IT DOES NOT CLAIM. It says which ruleset resolved for this month AT THE MOMENT THE MONTH WAS
 * OPENED. It is not a claim that every figure in the month was computed under it: `generatePayslips`
 * re-resolves at generation time and stamps each payslip with what it actually used, and the payslip's
 * own stamp remains the authority for a figure. If an administrator activates a ruleset effective
 * inside this month after it was opened, the two disagree — and the disagreement is then the evidence,
 * which is the mid-month change ADR-0024 D7 wanted visible rather than silent.
 */
async function openingStatutoryVersion(tx: Tx, companyId: string, period: string): Promise<string | null> {
  // AN IMPOSSIBLE MONTH RECORDS NOTHING, AND MUST NOT THROW. `pay_period.period` is plain text with no
  // CHECK, `createBatch` does not validate it, and the wizard's only guard is `<input type="month">`,
  // which Firefox and desktop Safari render as a free text box — so a run under '2026-13' is reachable
  // and the suite pins that it commits (test/cp39-form-report.test.ts, "degrades even when a real run
  // EXISTS under an impossible month"). Resolving a ruleset "as of" a date that does not exist would
  // turn a tolerated nonsense month into a failure to open one at all, which is a behaviour change this
  // round has no business making. Nothing is recorded instead: there is no statutory month to resolve a
  // ruleset for, and an absent record is the honest answer to a question that has none.
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return null;
  const [co] = await tx.select({ country: company.country }).from(company).where(eq(company.id, companyId)).limit(1);
  const pack = packFor(co?.country);
  if (!pack) return null;
  const periodEnd = `${period}-${String(daysInMonth(Number(m[1]), Number(m[2]))).padStart(2, '0')}`;
  return (await pack.payroll.loadRuleset(tx, { asOf: periodEnd })).version;
}

export async function createBatch(
  ctx: SessionContext,
  p: {
    companyId: string;
    payPeriod: string;
    scope?: BatchScope;
    paymentDate?: string;
    /** c11e81aa — the CONFIGURED cycle this run is opened under (payroll_cycle.id). Optional, and null is
     *  not a defect: a regular run resolves its collectable rows from the company's regular-mapped cycles
     *  either way (see `collectableCycleIds`). Recorded so the run's identity is a fact on the row rather
     *  than an inference from its type. */
    payrollCycleId?: string | null;
  },
) {
  return withTenant(ctx, async (tx) => {
    // Wave 2C (ADR-0024): this is the REGULAR run for a (company, month), and there is still exactly one
    // of those. What changed for item 23e7dac3 (ADR-0085 step 5) is WHICH runs count as "already there":
    // the test used to be "any batch for this company-month", which also refused the regular run when a
    // BONUS or off-cycle run had legitimately been processed first. It is now the regular run itself.
    // With `multi_cycle_payroll` off no other run can exist, so this is the same test it always was.
    // The message is preserved verbatim — `reasonForError` maps it to PERIOD_ALREADY_PROCESSED.
    const siblings = await tx
      .select({ id: payrollBatch.id, runSeq: payrollBatch.runSeq, runType: payrollBatch.runType })
      .from(payrollBatch)
      .where(and(eq(payrollBatch.companyId, p.companyId), eq(payrollBatch.payPeriod, p.payPeriod)));
    if (siblings.some((b) => b.runType === 'regular')) {
      throw new Error('A payroll process already exists for this period');
    }
    // ADR-0085 step 4 — a regular run landing AFTER other runs restates what they were charged, so the
    // filed-month refusal applies to it exactly as it does to an additional run. A first run (the
    // ordinary case, and every run that exists today) never reaches this.
    if (siblings.length > 0) {
      await refuseIfPeriodFiled(tx, {
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        what: 'Adding the monthly payroll run to a month that already has runs',
      });
    }

    // Every batch belongs to a pay_period parent (the statutory month). Find-or-create it; a period
    // row may already exist (e.g. an earlier draft run was deleted) — reuse it. A month CREATED here
    // records the ruleset version it is opened under; a month that already exists is reused exactly as
    // it stands, recorded version or absence of one included. See `openingStatutoryVersion` (00e28308)
    // — which replaces the claim this comment used to make, that the snapshot happened at first
    // payslip generation. Nothing did that.
    const [existingPeriod] = await tx
      .select({ id: payPeriod.id })
      .from(payPeriod)
      .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, p.payPeriod)))
      .limit(1);
    let periodId = existingPeriod?.id;
    if (!periodId) {
      const [createdPeriod] = await tx
        .insert(payPeriod)
        .values({
          tenantId: ctx.tenantId,
          companyId: p.companyId,
          period: p.payPeriod,
          status: 'open',
          // 00e28308 — recorded HERE, on the one statement that creates the month, and nowhere else.
          statutoryVersion: await openingStatutoryVersion(tx, p.companyId, p.payPeriod),
        })
        .returning({ id: payPeriod.id });
      periodId = createdPeriod.id;
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: periodId,
        eventType: 'pay-period.opened',
        actor: actorOf(ctx),
        payload: { companyId: p.companyId, period: p.payPeriod },
      });
    }

    // Payroll Process wizard (1a/1d): batch_date now carries the USER-SET payment date (previously
    // write-only — no report/export read it). A validated ISO date wins; else fall back to the
    // existing '<period>-28' default (unchanged behaviour for every pre-wizard caller/test).
    const batchDate = validPaymentDate(p.paymentDate) ?? `${p.payPeriod}-28`;
    // ADR-0085 step 5 — the regular run is no longer always run_seq 1. It is 1 whenever it leads the
    // month (every run on production today, and every run when multi-cycle is off), and the next free
    // sequence when a bonus or off-cycle run was processed first. `payroll_batch_period_run_uq` is on
    // (pay_period_id, run_seq), so this is allocated from the sequences actually taken, never counted.
    const nextRegularSeq = siblings.length ? Math.max(...siblings.map((b) => b.runSeq)) + 1 : 1;
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: periodId,
        runSeq: nextRegularSeq,
        runType: 'regular',
        payPeriod: p.payPeriod,
        batchDate,
        status: 'draft',
        scope: normalizeScope(p.scope),
        payrollCycleId: p.payrollCycleId || null,
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.created',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        payPeriodId: periodId,
        runSeq: nextRegularSeq,
        runType: 'regular',
        scope: normalizeScope(p.scope),
        paymentDate: batchDate,
        // c11e81aa — a reference id, so the audit record says which cycle opened the run without carrying
        // any figure (ADR-0030 Layer 0), exactly as `componentId` does on the ledger's own events.
        payrollCycleId: p.payrollCycleId || null,
      },
    });

    // Phase-B #15 — holiday-completeness guard. The payroll period spans a (company-state, year); if fewer
    // than the EA s.60D minimum of 11 gazetted holidays are loaded for it, the rest-day / OT-class day
    // arithmetic may be wrong. Warn LOUDLY (domain event + returned warning) but never block the batch.
    const holidayWarnings = await warnBatchHolidayCompleteness(tx, ctx, p.companyId, p.payPeriod, row.id);
    return { batchId: row.id, ...(holidayWarnings.length ? { holidayWarnings } : {}) };
  });
}

/** Phase-B #15: for a payroll batch, resolve the company's country + default work state and the period's
 *  year, then emit a non-blocking holiday-completeness warning when the loaded gazette is below the s.60D
 *  minimum. Returns the warnings so the payroll screen can surface them. */
async function warnBatchHolidayCompleteness(
  tx: Tx,
  ctx: SessionContext,
  companyId: string,
  payPeriod: string,
  batchId: string,
): Promise<HolidayCompletenessWarning[]> {
  const [co] = await tx
    .select({ country: company.country, state: company.defaultWorkState })
    .from(company)
    .where(eq(company.id, companyId))
    .limit(1);
  if (!co) return [];
  const year = Number(payPeriod.slice(0, 4));
  return warnIfHolidaysIncomplete(tx, ctx, {
    country: co.country,
    state: co.state ?? null,
    years: [year],
    module: 'payroll',
    aggregateType: 'payroll-batch',
    aggregateId: batchId,
    context: { companyId, payPeriod },
  });
}

/**
 * ADR-0085 step 4 — A RUN MAY NOT RESTATE A MONTH THAT HAS ALREADY BEEN FILED.
 *
 * ── WHAT THIS REFUSES, AND WHY EXACTLY THAT ─────────────────────────────────────────────────────────
 * EPF, SOCSO and PCB are worked out on what an employee has been paid SO FAR THIS MONTH, so any run
 * after the first in a month re-enters the tables on a bigger base and can change a figure an earlier
 * run already produced. While nothing has left the building that is arithmetic. Once a return has been
 * lodged or money remitted for that month it is a restatement of a figure an outside party already
 * holds — an amendment to a statutory submission, with the agency's own process and timing, and
 * explicitly out of ADR-0085's scope (§6). So it is refused here, loudly, naming what was filed.
 *
 * ── THE LINE IS `run_seq > 1`, AND IT IS NOT ARBITRARY ──────────────────────────────────────────────
 * "A run that changes a figure an earlier run already produced" IS "a run that is not the first in its
 * month". A lone regular run at seq 1 restates nothing — it is the month's only computation — so it is
 * deliberately NOT refused, and an ordinary single monthly run is byte-identical to before this change.
 * That also keeps r292's judgement intact: `batchDownstreamWarnings` warns rather than blocks on
 * regenerating a filed month precisely so that "a customer who filed a wrong figure could no longer
 * correct it at all" cannot happen. Correcting the month's one run stays possible; adding a SECOND run
 * that silently moves the first one's figures does not.
 *
 * ── PERIOD GRANULARITY IS COARSE ON PURPOSE, AND IT HAS A COST ──────────────────────────────────────
 * `periodFiledTx` answers per PERIOD, not per statutory leg (its header records why: no map from report
 * type to the legs a form asserts exists in this repo, and inventing one would be inventing the scope of
 * somebody else's form). So a filed EPF return bars an out-of-order run that would only have moved PCB.
 * That is ADR-0085 §3.0's recorded UNKNOWN, and it errs toward refusing, which on money is the cheap
 * mistake. The release valve is real and is tested: reverse the filing and the refusal lifts.
 *
 * It throws rather than returning a flag, and it never swallows `PeriodFiledError` — a session that
 * could not have SEEN a filing gets that error, not permission. A money guard must not fail open.
 */
export class PeriodAlreadyFiledError extends Error {
  readonly code = 'PERIOD_ALREADY_FILED' as const;
  constructor(
    message: string,
    readonly companyId: string,
    readonly payPeriod: string,
    readonly evidence: FiledEvidence[],
  ) {
    super(message);
    this.name = 'PeriodAlreadyFiledError';
  }
}

/**
 * Refuse when this company-month carries a filing. `what` names the act being refused so the operator
 * reads a sentence about their own action rather than about the guard.
 */
async function refuseIfPeriodFiled(
  tx: Tx,
  p: { companyId: string; payPeriod: string; what: string },
): Promise<void> {
  const answer = await periodFiledTx(tx, { companyId: p.companyId, periodKey: p.payPeriod });
  if (!answer.filed) return;
  throw new PeriodAlreadyFiledError(
    `${p.what} would change the statutory figures for ${p.payPeriod}, and that month has already been filed: ` +
      `${describeFiledEvidence(answer.evidence)}. Correcting a lodged return is an amendment made with the ` +
      `agency, not a recomputation here. Reverse the filing first if it was recorded in error.`,
    p.companyId,
    p.payPeriod,
    answer.evidence,
  );
}

/**
 * Wave 2C (ADR-0024) — create an ADDITIONAL same-month run (bonus / off-cycle / adjustment). GATED
 * behind the `multi_cycle_payroll` entitlement. The run is computed as additional remuneration (the
 * increment method) at generatePayslips.
 *
 * ⚠️ The regular run NO LONGER has to exist first (ADR-0085 step 5, item 23e7dac3) — see the body.
 */
export async function createAdditionalRun(
  ctx: SessionContext,
  p: {
    companyId: string;
    payPeriod: string;
    runType: 'off_cycle' | 'bonus' | 'adjustment';
    /** Payroll Process wizard (1b): optional payment date (validated, else '<period>-28' default). */
    paymentDate?: string;
    /** Payroll Process wizard (1b): a cycle label for off-cycle presets, e.g. 'Advance Salary' / 'Mid-Month'. */
    remarks?: string;
    /** Payroll Process wizard (1b): optional subset — generatePayslips already resolves batch.scope for
     *  every runType, so an additional run can legitimately be scoped the same way the regular run is. */
    scope?: BatchScope;
    /**
     * c11e81aa — the CONFIGURED cycle this run is opened under (payroll_cycle.id). On a NON-regular run
     * this is load-bearing rather than informational: it is the ONLY thing that tells an "Advance Salary"
     * run apart from a "Mid-Month" one, both of which are run_type 'off_cycle', and it is what decides
     * which period-keyed transactions the run collects. Omitted ⇒ the run names no cycle and collects no
     * period-keyed rows at all, which is exactly what every non-regular run did before this change.
     */
    payrollCycleId?: string | null;
  },
) {
  if (!isModuleEnabled(ctx, 'multi_cycle_payroll')) {
    // Message preserved verbatim: it is user-visible and asserted by existing tests. The TYPE is now
    // ModuleNotEnabledError so a caller can distinguish "not entitled" from any other failure.
    throw new ModuleNotEnabledError('multi_cycle_payroll', 'Multiple payroll runs per month are not enabled.');
  }
  return withTenant(ctx, async (tx) => {
    const [existingPeriod] = await tx
      .select({ id: payPeriod.id, status: payPeriod.status })
      .from(payPeriod)
      .where(and(eq(payPeriod.companyId, p.companyId), eq(payPeriod.period, p.payPeriod)))
      .limit(1);
    if (existingPeriod?.status === 'closed') throw new Error('This pay period is closed.');
    // ADR-0085 step 4 — a run that is not the month's first restates figures an earlier run produced.
    // Refuse at CREATE as well as at generate: the generate-time guard is the one that actually stands
    // between a filing and a moved figure, but learning at the END of the wizard that the month is
    // closed to you is a worse way to find out than learning at the start. Asked BEFORE the pay period
    // is opened, so a refused attempt leaves no row behind.
    await refuseIfPeriodFiled(tx, { companyId: p.companyId, payPeriod: p.payPeriod, what: 'Adding another payroll run' });

    /**
     * ADR-0085 step 5 (item 23e7dac3) — A NON-REGULAR RUN MAY NOW LEAD THE MONTH.
     *
     * ADR-0024 §6 put "standalone off-cycle with no regular run" out of scope for v1 and this function
     * enforced it twice: no pay period meant "create the regular run first", and a period with no
     * regular run in it was refused outright. The reporter's case is exactly that shape — a BONUS, an
     * Off Cycle or an advance salary paid BEFORE the monthly salary — and the statutory arithmetic is
     * now order-independent (the regular run restates the month when it lands; see `restatesMonth` in
     * generatePayslips), so the order is no longer what keeps the figures right. The FILED-month
     * refusal above is: out-of-order runs are bounded to months nothing has been lodged for.
     *
     * The pay period is therefore find-or-created here exactly as `createBatch` does it, including the
     * `pay-period.opened` event — one month, one parent, whichever run opens it.
     */
    let periodId = existingPeriod?.id;
    if (!periodId) {
      const [createdPeriod] = await tx
        .insert(payPeriod)
        .values({
          tenantId: ctx.tenantId,
          companyId: p.companyId,
          period: p.payPeriod,
          status: 'open',
          // 00e28308 — recorded HERE, on the one statement that creates the month, and nowhere else.
          statutoryVersion: await openingStatutoryVersion(tx, p.companyId, p.payPeriod),
        })
        .returning({ id: payPeriod.id });
      periodId = createdPeriod.id;
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: periodId,
        eventType: 'pay-period.opened',
        actor: actorOf(ctx),
        payload: { companyId: p.companyId, period: p.payPeriod },
      });
    }
    const runs = await tx
      .select({ runSeq: payrollBatch.runSeq, runType: payrollBatch.runType })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, periodId));
    // `Math.max()` of an empty list is -Infinity, which would write a nonsense sequence rather than
    // fail — the month's first run takes seq 1 explicitly.
    const nextSeq = runs.length ? Math.max(...runs.map((r) => r.runSeq)) + 1 : 1;
    const batchDate = validPaymentDate(p.paymentDate) ?? `${p.payPeriod}-28`;
    const scope = normalizeScope(p.scope);
    const [row] = await tx
      .insert(payrollBatch)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        payPeriodId: periodId,
        runSeq: nextSeq,
        runType: p.runType,
        payPeriod: p.payPeriod,
        batchDate,
        status: 'draft',
        scope,
        remarks: p.remarks || null,
        payrollCycleId: p.payrollCycleId || null,
      })
      .returning({ id: payrollBatch.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: row.id,
      eventType: 'payroll-batch.run-added',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        payPeriod: p.payPeriod,
        payPeriodId: periodId,
        runSeq: nextSeq,
        runType: p.runType,
        paymentDate: batchDate,
        remarks: p.remarks || null,
        scope,
        // c11e81aa — which cycle opened this run; on a non-regular run it is what routes the money.
        payrollCycleId: p.payrollCycleId || null,
      },
    });
    return { batchId: row.id };
  });
}

/**
 * Payroll Process wizard — resume a DRAFT batch and re-set its employee-selection scope (the "who's in
 * this run" step, formerly bypassed for drafts). Draft-only (mirrors generatePayslips' BatchNotDraftError
 * guard); the status read + the scope write happen inside ONE transaction so a concurrent double-submit
 * cannot both pass a stale "still draft" read before either write lands.
 *
 * `employmentIds` is the resolved explicit selection the wizard posts when the admin narrowed the set
 * (any filter use or manual deselect). It is intersected against the people this batch's company employed
 * DURING ITS PAY PERIOD (`employedByCompanyDuring`) — see the guard below for why this one is dated and
 * `createRunAction`'s is not — so a stale/cross-company id can never widen or silently under-set the run.
 * An empty/absent selection normalises to null scope (whole company), exactly as a fresh run's no-filter
 * default.
 *
 * Cleanup (orphan-data safeguard): any employment present in the PREVIOUS scope but absent from the NEW
 * scope has its payroll_input row deleted, and any loan instalment RESERVED to this batch for them is
 * RELEASED back to 'scheduled' (reservedBatchId cleared) so a stale reservation is never stranded against
 * the loan balance. Nothing is released for an employment that stays in scope.
 */
export async function updateBatchScope(
  ctx: SessionContext,
  p: { batchId: string; scope?: BatchScope },
) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        scope: payrollBatch.scope,
        // 1b0943d5 — read so the membership guard below can ask the DATED question, which needs a window.
        payPeriod: payrollBatch.payPeriod,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    // Cross-company membership guard: keep only submitted ids that belong to this batch's company, so a
    // stale/cross-company id can never reach the persisted scope.
    //
    // ── 1b0943d5, SITE 1 OF 5 — DATED, AND NO LONGER THE SAME GUARD AS createRunAction'S. ─────────────
    // This guard decides which employments an EXISTING run is allowed to be set up for, and it must agree
    // with the kernel that will pay them. `batchInputRows` and `listPayslipLessEligible` already offer a
    // transferred-out employee on this run (stage one widened them), and `generatePayslips` already pays
    // their pre-transfer days here. On the column, this filter would silently DROP that id on save: the
    // screens offer the person, the operator ticks them, the scope quietly loses them, and the run then
    // computes nothing for them — the "silently no-op'd addition" failure fbcf706d exists to remove,
    // reintroduced through a different door. The scope is a chosen list, and it must be able to name
    // everybody the run can pay.
    //
    // ⚠️ AND createRunAction (app/payroll/process/actions.ts) STAYS ON THE COLUMN, deliberately, so the
    // two are no longer "the same intersection" and this file should not claim they are. Its filter
    // validates against `listEmployees`, and the Step-2 list it validates is `listEmployeesForPayrollRun`
    // — column-scoped (`employment.company_id in (…)`). Creation therefore never OFFERS a transferred-out
    // employee, so its filter cannot drop one it offered, and dating only the filter would let a
    // hand-posted id name somebody no screen on that path has ever shown. The asymmetry is real and it is
    // where the adoption stopped: widening the wizard's own creation-time population is a separate change
    // to a separate read, and it is not made here. This site had to move because its screens had already
    // moved; that one has not.
    const [uy, um] = batch.payPeriod.split('-').map(Number);
    const scopePeriodStart = `${batch.payPeriod}-01`;
    const scopePeriodEnd = `${batch.payPeriod}-${String(daysInMonth(uy, um)).padStart(2, '0')}`;
    const submittedEmploymentIds = (p.scope?.employmentIds ?? []).filter(Boolean);
    let validEmploymentIds = submittedEmploymentIds;
    if (submittedEmploymentIds.length) {
      const companyEmps = await tx
        .select({ id: employment.id })
        .from(employment)
        .where(
          and(
            employedByCompanyDuring(batch.companyId, scopePeriodStart, scopePeriodEnd),
            inArray(employment.id, submittedEmploymentIds),
          ),
        );
      const valid = new Set(companyEmps.map((e) => e.id));
      validEmploymentIds = submittedEmploymentIds.filter((id) => valid.has(id));
    }
    // Department ids in the scope carry through unchanged (the wizard's resume path posts explicit
    // employment ids, not department filters, but keep the department dimension intact if present).
    const nextScope = normalizeScope({
      ...(p.scope?.departmentIds?.length ? { departmentIds: p.scope.departmentIds } : {}),
      ...(validEmploymentIds.length ? { employmentIds: validEmploymentIds } : {}),
    });

    const prevScope = (batch.scope ?? null) as BatchScope | null;
    // Resolve the CONCRETE employment-id membership of the previous and next scope so the removed set is
    // computed off actual assignees (department scopes resolve to their current members), not raw arrays.
    const prevResolved = await resolveBatchScopeFilter(tx, prevScope);
    const nextResolved = await resolveBatchScopeFilter(tx, nextScope);
    // A null resolved set means "whole company" (no filter). Removal only makes sense when the PREVIOUS
    // scope was explicit — widening to whole-company removes nobody, and narrowing FROM whole-company can't
    // enumerate a concrete removed set, so we only clean up when the previous scope was a concrete subset.
    const prevIds = prevResolved.employmentIds;
    const nextIds = new Set(nextResolved.employmentIds ?? []);
    const removedEmploymentIds = prevIds ? prevIds.filter((id) => !nextIds.has(id)) : [];

    await tx.update(payrollBatch).set({ scope: nextScope }).where(eq(payrollBatch.id, p.batchId));

    for (const employmentId of removedEmploymentIds) {
      // Release any loan instalment reserved to THIS batch for the removed employment back to 'scheduled'
      // so its reservation is not stranded (the loan balance is untouched — nothing was applied yet).
      const releasedRepayments = await tx
        .update(loanRepayment)
        .set({ status: 'scheduled', reservedBatchId: null })
        .where(
          and(
            eq(loanRepayment.reservedBatchId, p.batchId),
            eq(loanRepayment.employmentId, employmentId),
            eq(loanRepayment.status, 'reserved'),
          ),
        )
        .returning({ id: loanRepayment.id, loanId: loanRepayment.loanId });
      for (const r of releasedRepayments) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'loan-repayment',
          aggregateId: r.id,
          eventType: 'loan.instalment.reservation-released',
          actor: actorOf(ctx),
          subjectEmploymentId: employmentId,
          payload: { batchId: p.batchId, loanId: r.loanId, reason: 'removed-from-batch-scope' },
        });
      }
      // Clear any keyed inputs (OT/bonus/claims/loan-deduction/…) for the removed employment on this batch.
      await tx
        .delete(payrollInput)
        .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, employmentId)));
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.scope.updated',
      actor: actorOf(ctx),
      payload: { before: prevScope, after: nextScope, removedEmploymentIds },
    });
    return { ok: true, removedEmploymentIds };
  });
}

/**
 * Tear down a DRAFT batch's child rows inside the caller's transaction (feedback 4f00d8f0 — draft
 * delete). This is the batch-wide generalisation of the per-removed-employee cleanup updateBatchScope
 * performs:
 *   1. Loan instalments still RESERVED to this batch are RELEASED back to 'scheduled' (reservedBatchId
 *      cleared) so no reservation is stranded against a loan balance — one
 *      `loan.instalment.reservation-released` event per row, same as the scope-removal path. APPLIED
 *      loan state (`appliedBatchId` / status='applied') is deliberately untouched: it only exists on a
 *      processed batch, which every draft-only caller refuses; unwinding it is the processed→draft
 *      Reset's mechanic (sibling feedback a03b2d9b).
 *   2. Draft-stage child rows are deleted: payroll_input, payroll_batch_component, and — defensively —
 *      payslip (expected empty for a draft, since generation flips the batch off 'draft'; deleting-if-any
 *      keeps the teardown total).
 *   3. Claims stamped onto this batch are DETACHED (payroll_batch_id → null), not deleted — the claim
 *      is an approved business record that must survive and become re-queueable; one
 *      `claim-request.unqueued-from-payroll` event per claim (mirrors claim-request.queued-for-payroll).
 *   4. Individual one-off transactions are likewise DETACHED (batch_id → null; f1564110 Phase 2, amending
 *      ADR-0056) — they keep their (company_id, pay_period) home and re-attach automatically when the
 *      month's regular run is next generated; one `payroll.individual-txn.detached` event per row.
 *
 * Shared seam: deleteDraftBatch calls this before removing the batch row, and the processed→draft
 * Reset (a03b2d9b) can reuse it for its final draft-cleanup step. Events are appended HERE so no
 * caller can perform the teardown silently (substrate discipline).
 */
export async function teardownDraftChildren(tx: Tx, ctx: SessionContext, batchId: string) {
  const releasedRepayments = await tx
    .update(loanRepayment)
    .set({ status: 'scheduled', reservedBatchId: null })
    .where(and(eq(loanRepayment.reservedBatchId, batchId), eq(loanRepayment.status, 'reserved')))
    .returning({ id: loanRepayment.id, loanId: loanRepayment.loanId, employmentId: loanRepayment.employmentId });
  for (const r of releasedRepayments) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'loan-repayment',
      aggregateId: r.id,
      eventType: 'loan.instalment.reservation-released',
      actor: actorOf(ctx),
      subjectEmploymentId: r.employmentId,
      payload: { batchId, loanId: r.loanId, reason: 'draft-batch-teardown' },
    });
  }

  const inputs = await tx.delete(payrollInput).where(eq(payrollInput.batchId, batchId)).returning({ id: payrollInput.id });
  // f1564110 Phase 2 (amends ADR-0056): individual one-off transactions are DETACHED (batch_id → NULL),
  // not deleted — like claims, they are keyed-in business records that must survive a draft delete/reset
  // and re-attach automatically when the month's regular run is next generated. Their (company_id,
  // pay_period) home was stamped at write time (backfilled by 0175 for older rows), so the 0175 CHECK
  // holds through the detach. One event per row (cross-aggregate state change, same as the claim detach).
  // Stamp (company, pay month) from the batch during the detach — the service stamps them on every write
  // and 0175 backfilled old rows, but a defensively-inserted row without them must still satisfy the 0175
  // CHECK (batch_id OR company+period) once batch_id goes NULL. The batch row still exists here.
  const [teardownBatch] = await tx
    .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
    .from(payrollBatch)
    .where(eq(payrollBatch.id, batchId))
    .limit(1);
  // 0db616f3 (0437) — release anything this run consumed BEFORE the detach, and keyed on
  // `consumed_batch_id` rather than `batch_id` so a row a hand repair re-pointed elsewhere is released
  // too. The payslips are deleted a few lines below and the batch row itself is deleted by the caller: a
  // line whose payslip no longer exists has not been paid, and leaving it marked would silently drop it
  // out of every future run's fold. (The FK's ON DELETE SET NULL is the backstop, not the mechanism —
  // relying on it would leave the release invisible in the code that causes it.)
  await releaseIndividualTxnsConsumed(tx, batchId);
  const detachedIndividualTxns = await tx
    .update(payrollIndividualTxn)
    .set({ batchId: null, companyId: teardownBatch?.companyId, payPeriod: teardownBatch?.payPeriod })
    .where(eq(payrollIndividualTxn.batchId, batchId))
    .returning({ id: payrollIndividualTxn.id, employmentId: payrollIndividualTxn.employmentId, payPeriod: payrollIndividualTxn.payPeriod });
  for (const t of detachedIndividualTxns) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-individual-txn',
      aggregateId: t.id,
      eventType: 'payroll.individual-txn.detached',
      actor: actorOf(ctx),
      subjectEmploymentId: t.employmentId,
      payload: { batchId, payPeriod: t.payPeriod, reason: 'draft-batch-teardown' },
    });
  }
  const components = await tx
    .delete(payrollBatchComponent)
    .where(eq(payrollBatchComponent.batchId, batchId))
    .returning({ id: payrollBatchComponent.id });
  const payslips = await tx.delete(payslip).where(eq(payslip.batchId, batchId)).returning({ id: payslip.id });

  // ── Batch-keyed audit / control rows (feedback ec3873a6) ──────────────────────────────────────────
  // A hard draft delete must clear EVERY child that FK-references payroll_batch.id, else the final
  // tx.delete(payrollBatch) hits a foreign-key violation and the raw SQL leaks to the UI. A FRESH draft
  // carries none of these, but a draft that was reverted from Processed (resetProcessedBatch) — or that
  // was unlocked/reprocessed on its way there — leaves rows keyed to the batch:
  //   • payroll_status_history   — the 'rollback' (and any 'unlock'/'reprocess') snapshot rows the reset
  //     writes; NO onDelete cascade, so THIS was the reported bug (batch deff8c3c stuck on 2 rollback rows).
  //   • payroll_employee_result_history — per-employee before/after snapshots written by a reprocess.
  //   • payroll_reprocess_job    — the reprocess job queue rows keyed to the batch.
  //   • payroll_step_up_challenge — the step-up (2FA) unlock challenge rows an unlock-before-reset leaves.
  // A hard delete leaves NO trace of the batch, so its audit/control history goes with it — the durable
  // record of the deletion itself is the payroll-batch.deleted DomainEvent the caller appends (which
  // carries these counts). NOT enumerated here because they can never point at a DRAFT: loan_repayment
  // .applied_batch_id (reset NULLs it; only processing sets it) and payslip/input/component/individual-txn/
  // claim (handled above). Prefer this explicit draft-only teardown over ON DELETE CASCADE on the FKs —
  // it stays controlled and needs no migration.
  const statusHistory = await tx
    .delete(payrollStatusHistory)
    .where(eq(payrollStatusHistory.batchId, batchId))
    .returning({ id: payrollStatusHistory.id });
  const resultHistory = await tx
    .delete(payrollEmployeeResultHistory)
    .where(eq(payrollEmployeeResultHistory.batchId, batchId))
    .returning({ id: payrollEmployeeResultHistory.id });
  const reprocessJobs = await tx
    .delete(payrollReprocessJob)
    .where(eq(payrollReprocessJob.batchId, batchId))
    .returning({ id: payrollReprocessJob.id });
  const stepUpChallenges = await tx
    .delete(payrollStepUpChallenge)
    .where(eq(payrollStepUpChallenge.batchId, batchId))
    .returning({ id: payrollStepUpChallenge.id });
  // Note: the child-row deletes above are covered by the batch-level teardown/deleted event the caller
  // appends (their per-row history lives on their own aggregates' earlier events); only the two rows with
  // cross-aggregate state (loan reservation, claim link) get per-row events here.

  const detachedClaims = await tx
    .update(claimRequest)
    .set({ payrollBatchId: null })
    .where(eq(claimRequest.payrollBatchId, batchId))
    .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
  for (const c of detachedClaims) {
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'claim-request',
      aggregateId: c.id,
      eventType: 'claim-request.unqueued-from-payroll',
      actor: actorOf(ctx),
      subjectEmploymentId: c.employmentId,
      payload: { batchId, reason: 'draft-batch-teardown' },
    });
  }

  return {
    releasedLoanRepaymentIds: releasedRepayments.map((r) => r.id),
    detachedClaimIds: detachedClaims.map((c) => c.id),
    detachedIndividualTxnIds: detachedIndividualTxns.map((t) => t.id),
    deletedChildCounts: {
      inputs: inputs.length,
      components: components.length,
      payslips: payslips.length,
      statusHistory: statusHistory.length,
      resultHistory: resultHistory.length,
      reprocessJobs: reprocessJobs.length,
      stepUpChallenges: stepUpChallenges.length,
    },
  };
}

/**
 * Payroll Process listing (feedback 4f00d8f0) — permanently DELETE a DRAFT batch and all its draft-stage
 * child data. DRAFT-ONLY: any other status throws BatchNotDraftError — this is the hard seam that keeps
 * processed/closed runs undeletable from the listing; reversing a PROCESSED run back to draft is the
 * Reset/Zeroize mechanic (sibling feedback a03b2d9b), never this method. The DB additionally freezes
 * 'closed' batches via the 0011 immutability trigger.
 *
 * The status read and every destructive write share ONE transaction (same double-submit rationale as
 * updateBatchScope). RLS scopes the batch lookup — a batch outside this admin's payroll scope resolves
 * to no row ("batch not found"), so a company-scoped admin can never delete another company's draft.
 *
 * Orphan-parent tidy-up: when the deleted run was the LAST batch under its pay_period AND the period is
 * still 'open', the period row is deleted too (createBatch's find-or-reuse already anticipates a period
 * surviving a draft delete, so leaving it would also be safe — removing it just avoids stray open
 * months). A closed period is never touched.
 */
export async function deleteDraftBatch(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriodId: payrollBatch.payPeriodId,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const teardown = await teardownDraftChildren(tx, ctx, p.batchId);

    await tx.delete(payrollBatch).where(eq(payrollBatch.id, p.batchId));

    // Orphan-parent cleanup: delete the pay_period only when NO sibling run still references it and it
    // is still 'open' (guard: never delete a closed statutory month — the 0067 trigger also enforces it).
    const [sibling] = await tx
      .select({ id: payrollBatch.id })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, batch.payPeriodId))
      .limit(1);
    let payPeriodDeleted = false;
    if (!sibling) {
      const deletedPeriods = await tx
        .delete(payPeriod)
        .where(and(eq(payPeriod.id, batch.payPeriodId), eq(payPeriod.status, 'open')))
        .returning({ id: payPeriod.id });
      if (deletedPeriods.length > 0) {
        payPeriodDeleted = true;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'pay-period',
          aggregateId: batch.payPeriodId,
          eventType: 'pay-period.deleted',
          actor: actorOf(ctx),
          payload: { companyId: batch.companyId, period: batch.payPeriod, reason: 'last-run-deleted' },
        });
      }
    }

    // The event log is the durable audit trail for a hard delete — record WHAT was removed (child
    // counts, released reservations, detached claims), not just that it happened.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.deleted',
      actor: actorOf(ctx),
      payload: {
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        payPeriodId: batch.payPeriodId,
        runType: batch.runType,
        runSeq: batch.runSeq,
        payPeriodDeleted,
        ...teardown,
      },
    });
    return { id: p.batchId };
  });
}

/** Upsert a draft batch's manual overtime input for one employee. Draft-only; appends an event. */
export async function setPayrollInput(
  ctx: SessionContext,
  p: {
    batchId: string;
    employmentId: string;
    overtimeAmount: number;
    bonusAmount?: number;
    tp1Deduction?: number;
    zakat?: number;
    /** OT rate-bucket decomposition (RM amounts). The caller has already summed these into
     *  `overtimeAmount` — this is persisted only so the four UI inputs can be re-prefilled; nothing
     *  downstream reads it. Omit to leave the stored decomposition untouched (insert ⇒ NULL). */
    otBreakdown?: { flat: number; normal: number; rest: number; holiday: number };
    /** Fix-5 (M#17) provenance. `setPayrollInput` IS the manual-save path, so it stamps ot_source='manual'
     *  by DEFAULT — a direct call (admin form, importer, test) records that the OT figure was hand-keyed,
     *  so a later attendance prefill (and the editor's clobber warning) can tell. The read-modify-write
     *  callers that merely carry the existing OT forward unchanged — the deduction-only (TP1/zakat) wrapper
     *  and the bonus enact — pass `'preserve'` to leave the stored provenance untouched (NULL on insert).
     */
    otSource?: 'manual' | 'preserve';
    /** ADR-0050 §0.4 TP1 provenance. `setPayrollInput` is the manual-save path, so it stamps
     *  tp1_source=null ('manual') by DEFAULT — a direct call (admin form, importer, test) records that the
     *  TP1 figure is a hand-keyed override, so a later TP1 self-relief prefill leaves it untouched. The
     *  deduction-only wrapper passes `'preserve'` for a ZAKAT-only write (no TP1 edit) so the untouched TP1
     *  keeps its stored provenance ('tp1_self' stays auto-tracked) — mirrors the otSource:'preserve' path. */
    tp1SourceMode?: 'manual' | 'preserve';
  },
  /** Optional caller transaction — pass it so this participates in an enclosing transaction
   *  (the performance bonus enact) and commits/rolls back atomically with it. */
  outerTx?: Tx,
) {
  const run = async (tx: Tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    const overtimeAmount = Math.max(0, Number(p.overtimeAmount) || 0);
    const bonusAmount = Math.max(0, Number(p.bonusAmount) || 0);
    const tp1Deduction = Math.max(0, Number(p.tp1Deduction) || 0);
    const zakat = Math.max(0, Number(p.zakat) || 0);
    // OT rate-bucket decomposition: persist only when the caller supplied it; clamp each bucket >= 0.
    // `undefined` ⇒ leave the stored column untouched on update (do not coalesce to NULL), NULL on insert.
    const otBreakdown =
      p.otBreakdown === undefined
        ? undefined
        : {
            flat: Math.max(0, Number(p.otBreakdown.flat) || 0),
            normal: Math.max(0, Number(p.otBreakdown.normal) || 0),
            rest: Math.max(0, Number(p.otBreakdown.rest) || 0),
            holiday: Math.max(0, Number(p.otBreakdown.holiday) || 0),
          };
    // Fix-5 (M#17): resolve OT provenance. Default 'manual' (this is the manual-save path); 'preserve'
    // (deduction-only / bonus-enact) ⇒ leave the stored column untouched on update, NULL on insert.
    const otSource: 'manual' | undefined = p.otSource === 'preserve' ? undefined : 'manual';
    // ADR-0050 §0.4: resolve TP1 provenance. Default 'manual' (a direct/admin TP1 write resets provenance
    // to a sticky manual override, exactly as today). 'preserve' (a zakat-only deduction write that does NOT
    // touch TP1) ⇒ omit tp1_source from the update .set() so a live 'tp1_self' relief keeps auto-tracking.
    // Mirrors the otSource:'preserve' mechanism above. On INSERT there is no prior TP1, so both modes NULL.
    const stampTp1Source: boolean = p.tp1SourceMode !== 'preserve';
    const [existing] = await tx
      .select({ id: payrollInput.id })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    let payrollInputId: string;
    if (existing) {
      await tx
        .update(payrollInput)
        .set({
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          tp1Deduction: tp1Deduction.toFixed(2),
          // ADR-0050 §0.4: a TP1 write resets provenance to manual (null) → sticky, so a later TP1
          // self-relief prefill leaves this override untouched. A zakat-only write ('preserve') omits the
          // key entirely, leaving a 'tp1_self' relief auto-tracked (same conditional-spread as otSource).
          ...(stampTp1Source ? { tp1Source: null } : {}),
          zakat: zakat.toFixed(2),
          // Persist the OT decomposition only when supplied; omit the key entirely otherwise so a
          // TP1-only / bonus-enact round-trip leaves the existing breakdown untouched (not nulled).
          ...(otBreakdown !== undefined ? { otBreakdown } : {}),
          // Fix-5 (M#17): stamp OT provenance ('manual') unless the caller asked to preserve it; a
          // 'preserve' (deduction-only / bonus-enact) round-trip leaves the existing ot_source untouched.
          ...(otSource !== undefined ? { otSource } : {}),
          // ── a96d320c — A HAND-KEYED OT FIGURE HAS NO STATUTORY DECOMPOSITION ────────────────────────
          // `ot_derivation` (0479) explains the number the attendance engine produced. This is the manual
          // save path, so the number is now the operator's, and a decomposition left behind would caption
          // it with hours and rates that produced a different figure. Cleared on exactly the writes that
          // stamp ot_source='manual'; a 'preserve' round-trip (TP1/zakat only, bonus enact) does not touch
          // the OT figure and so does not touch its derivation either — the same conditional spread, for
          // the same reason.
          //
          // The read side does not DEPEND on this: generatePayslips stamps the payslip only when the
          // derivation's own total still equals the overtime figure being printed, so retyping the same
          // number would be caught there too. Clearing it here means the row itself stops claiming an
          // origin it no longer has, which is what an auditor reads.
          ...(otSource !== undefined ? { otDerivation: null } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(payrollInput.id, existing.id));
      payrollInputId = existing.id;
    } else {
      const [row] = await tx
        .insert(payrollInput)
        .values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId: p.employmentId,
          overtimeAmount: overtimeAmount.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          tp1Deduction: tp1Deduction.toFixed(2),
          // Manual provenance (null is the column default; set explicitly for clarity).
          tp1Source: null,
          zakat: zakat.toFixed(2),
          // NULL when the caller omitted the decomposition (legacy / wrapper paths).
          otBreakdown: otBreakdown ?? null,
          // Fix-5 (M#17): 'manual' by default; NULL when the caller asked to preserve (deduction-only /
          // bonus-enact inserts have no OT figure of their own to attribute).
          otSource: otSource ?? null,
        })
        .returning({ id: payrollInput.id });
      payrollInputId = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.input-set',
      actor: actorOf(ctx),
      // ADR-0030 Layer 0: the figures live on payroll_input[payrollInputId]; reference, not cleartext pay.
      // Only the field NAME 'otBreakdown' is recorded (and only when it was actually written) — never the
      // per-bucket RM amounts.
      payload: {
        employmentId: p.employmentId,
        payrollInputId,
        fieldsChanged: [
          'overtimeAmount',
          'bonusAmount',
          'tp1Deduction',
          'zakat',
          ...(otBreakdown !== undefined ? ['otBreakdown'] : []),
          ...(otSource !== undefined ? ['otSource'] : []),
        ],
      },
    });
    return { ok: true };
  };
  return outerTx ? run(outerTx) : withTenant(ctx, run);
}

/**
 * Feature 1.2 (Transaction sub-module) — set ONLY the statutory deduction scalars (TP1, zakat) on a
 * draft batch input row, preserving the sibling earnings fields. `setPayrollInput` is a full-row
 * overwrite that coalesces any omitted field to 0; a TP1/zakat-only form posting through it would
 * silently zero overtime/bonus. This is a READ-MODIFY-WRITE wrapper: it reads the current row's
 * overtime/bonus, merges the changed deduction fields, and delegates to setPayrollInput so the event
 * shape (payroll-batch.input-set) and the draft-only / clamp rules stay identical. Either field may be
 * left undefined to keep its current value.
 */
export async function setPayrollDeductionInput(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string; tp1Deduction?: number; zakat?: number },
) {
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({
        overtimeAmount: payrollInput.overtimeAmount,
        bonusAmount: payrollInput.bonusAmount,
        tp1Deduction: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        otBreakdown: payrollInput.otBreakdown,
      })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), eq(payrollInput.employmentId, p.employmentId)))
      .limit(1);
    return setPayrollInput(
      ctx,
      {
        batchId: p.batchId,
        employmentId: p.employmentId,
        // Preserve the sibling earnings — do NOT let the full-row overwrite reset them.
        overtimeAmount: Number(existing?.overtimeAmount ?? 0),
        bonusAmount: Number(existing?.bonusAmount ?? 0),
        tp1Deduction: p.tp1Deduction ?? Number(existing?.tp1Deduction ?? 0),
        zakat: p.zakat ?? Number(existing?.zakat ?? 0),
        // Preserve the OT decomposition too (undefined ⇒ leave the column untouched).
        otBreakdown: existing?.otBreakdown ?? undefined,
        // Fix-5 (M#17): a TP1/zakat-only write is NOT an OT change — preserve the existing ot_source
        // (attendance-derived stays attendance-derived).
        otSource: 'preserve',
        // ADR-0050 §0.4: preserve the stored TP1 provenance UNLESS this call actually edits TP1. A TP1 edit
        // (p.tp1Deduction provided) is a real manual override → 'manual' (reset provenance, matches today);
        // a zakat-only write (p.tp1Deduction undefined) must NOT poison a live 'tp1_self' relief → 'preserve'
        // so the untouched TP1 keeps auto-tracking. This also fixes the pre-existing prefillFixedZakat
        // poisoning, which reaches this wrapper with zakat only.
        tp1SourceMode: p.tp1Deduction === undefined ? 'preserve' : 'manual',
      },
      tx,
    );
  });
}

/**
 * ══ HOW MUCH OF THE DECLARED ANNUAL DOES *THIS* MONTH FEED — LP₁, IN ONE PLACE ══════════════════════
 *
 * core/tax-relief's `tp1CountForYear` is THE rule for "which declarations count and what each
 * contributes" (its header carries r209's account of what a second spelling cost). It is deliberately
 * NOT extended here and nothing below re-decides any part of it. It does not answer "what should
 * LP₁ be on this run", and that second question is where item 3fa088fb's money went missing: the answer
 * lived inside `prefillTp1FromSelfRelief` — a MANUAL form action behind a button — so a payroll run that
 * nobody pressed the button for calculated PCB as though nothing had been declared. Of the 88 payslips
 * ever issued on the reporter's system, not one carried a TP1 relief while eight approved declarations
 * sat there for 2026.
 *
 * So the delta lives here, once, in the file that owns the ∑LP replay it is struck against, and BOTH
 * callers in this file reach it:
 *   · `prefillTp1FromSelfRelief` — writes it onto the draft batch so an operator can see and override it;
 *   · `generatePayslips` — DERIVES it at generate time, with no button, exactly as it already auto-applies
 *     the fixed zakat election. That is the fix; the prefill is now a convenience, not the only bridge.
 *
 * ── WHY IT IS A DELTA AND NOT THE ANNUAL (ADR-0050 §0.1) ────────────────────────────────────────────
 * The kernel SUMS each month's `st.lp` into `acc.lpAccumulated`, and PCB consumes `∑LP + LP₁`. Feeding
 * the full declared annual every month would therefore relieve it twelve times over. Feeding
 *   feed = max(0, annual − ∑LP already fed by us this assessment year)
 * makes `∑LP + LP₁` converge on the declared annual, claimed exactly ONCE — and it is self-correcting
 * under mid-year adoption, a re-run, and a mid-year correction, because every one of those only changes
 * what the two inputs are.
 *
 * ── `lpAlreadyFed` IS THE REPLAY OF *OUR* PAYSLIPS, NOT THE KERNEL'S WHOLE ∑LP (item 20837372) ──────
 * Since migration 0488 the kernel OPENS `acc.lpAccumulated` with the Form TP3 Section D balance (a
 * previous employer's accumulated deductions) and replays our own prior payslips on top. Only the REPLAY
 * belongs here. The two are asking different questions: the kernel asks "what deductions has this person
 * had this year, from anywhere"; this asks "how much of the annual they declared TO US is still unfed" —
 * and a relief claimed through a DIFFERENT employer has never been fed by us, so netting it off here
 * would silently shrink a declaration the employee made to this employer. Both callers therefore pass
 * the replay-only figure, and a test pins that they do.
 */
type Tp1FeedInput = {
  /** Every APPROVED declaration of ONE person for the assessment year — unfiltered by month; see below. */
  approvedRows: readonly Tp1CountableRow[];
  /** The payroll month being computed. `tp1EffectiveFromMonth` decides what is in force by then. */
  throughMonth: number;
  /** ∑LP THIS employer has already fed this assessment year (prior payslips' `st.lp`), TP3 excluded. */
  lpAlreadyFed: number;
};

type Tp1Feed = {
  /** The declared annual in force through `throughMonth` — `tp1CountForYear(...).total`. */
  annual: number;
  /** Echoed back so a caller stamping provenance does not have to recompute or re-round it. */
  lpAlreadyFed: number;
  /** LP₁ for this run: `max(0, annual − lpAlreadyFed)`. */
  feed: number;
  /** The full reduction, for provenance: which declarations were counted and what each contributed. */
  counted: Tp1Counted;
};

function resolveTp1Feed(p: Tp1FeedInput): Tp1Feed {
  // ⚠️ NO MONTH PREDICATE HERE AND NONE IN EITHER CALLER'S SQL. `tp1CountForYear` owns "which rows
  // count", and r201 is the record of what a second spelling costs: the payroll feed filtered on
  // `approved_month` in SQL while the limit check filtered on nothing, so a carried-forward declaration
  // counted in FULL on one side and ZERO on the other, and HR keyed each month's increment against a
  // baseline missing it.
  const counted = tp1CountForYear(p.approvedRows, { throughMonth: p.throughMonth });
  const annual = round2(counted.total);
  const lpAlreadyFed = round2(p.lpAlreadyFed);
  // Clamped at 0, not allowed to go negative: a month whose ∑LP already exceeds the annual (a correction
  // that REDUCED a declaration after earlier months had fed the larger figure) must feed nothing further,
  // never claw money back through a negative LP₁ that would INCREASE P and over-deduct.
  return { annual, lpAlreadyFed, feed: Math.max(0, round2(annual - lpAlreadyFed)), counted };
}

/**
 * ══ §0.5 ROUTING — THE RELIEF IS PERSON-KEYED, `payroll_input.tp1_deduction` IS PER-EMPLOYMENT ═══════
 *
 * `tp1_relief` belongs to a PERSON; LP₁ is charged on an EMPLOYMENT. For everyone with one job that is a
 * distinction without a difference, and for a person holding two concurrent employments in one batch it
 * is the difference between claiming a relief once and claiming it twice. So exactly one employment per
 * person carries it:
 *
 *   `person.designated_paymaster_employment_id`  when set AND present in this batch — the person's own
 *                                                nominated paying employment. Always wins.
 *   the single employment in the batch           when no paymaster is nominated and there is only one,
 *                                                which is every ordinary employee.
 *   nobody                                       >1 employment in the batch and no paymaster among them.
 *                                                Genuinely ambiguous — nothing here can know which job
 *                                                should relieve, and guessing spreads or doubles money.
 *
 * ⚠️ IT READS THE BATCH'S WHOLE ACTIVE SET, NOT A NARROWED ONE, and that is a correctness requirement
 * rather than tidiness. `generatePayslips` narrows its employee list for a SELECTIVE REPROCESS (9bc442bc)
 * and for an additional run (r226). Resolve routing off a narrowed list and a reprocess of a single
 * non-paymaster employment sees "one employment for this person" and relieves the WRONG job — the relief
 * would follow whichever employment the operator happened to tick. Resolving it off the full set makes
 * the answer a property of the person and the period, identical on every run of that period.
 *
 * Shared by `prefillTp1FromSelfRelief` (which writes the figure onto the draft) and `generatePayslips`
 * (which derives it), so the two cannot route the same ringgit to two different employments.
 */
async function tp1TargetEmploymentByPerson(
  tx: Tx,
  p: { companyId: string; periodStart: string; periodEnd: string },
): Promise<Map<string, string>> {
  const emps = await tx
    .select({
      employmentId: employment.id,
      personId: employment.personId,
      designatedPaymaster: person.designatedPaymasterEmploymentId,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(
      and(
        // 3c88d593 — the DATED entity question, the same one generatePayslips asks. Reading only the
        // column here and the history there is exactly the drift this helper exists to prevent: an
        // employee the kernel pays on the outgoing entity's run, routed by a screen that cannot see them.
        employedByCompanyDuring(p.companyId, p.periodStart, p.periodEnd),
        lte(employment.hiredOn, p.periodEnd),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, p.periodStart)),
      ),
    );
  const batchEmpIds = new Set(emps.map((e) => e.employmentId));
  const byPerson = new Map<string, typeof emps>();
  for (const e of emps) {
    const list = byPerson.get(e.personId) ?? [];
    list.push(e);
    byPerson.set(e.personId, list);
  }
  const target = new Map<string, string>();
  for (const [personId, list] of byPerson) {
    const paymaster = list[0].designatedPaymaster;
    if (paymaster && batchEmpIds.has(paymaster)) target.set(personId, paymaster);
    else if (list.length === 1) target.set(personId, list[0].employmentId);
    // else: >1 employment in this batch and no paymaster among them → ambiguous, relieve nothing.
  }
  return target;
}

/**
 * The APPROVED declarations of these people for one assessment year, grouped by person, in the shape
 * `resolveTp1Feed` reduces. Shared by the prefill and the kernel for the same reason the routing is.
 *
 * ⚠️ THE GATE IS 'approved', AND THERE IS NO MONTH PREDICATE. Both halves matter:
 *
 *   · APPROVED, not submitted (7ad37961 / ADR-0081). Section F of the official TP1 is the EMPLOYER'S
 *     consent, and consent is what turns an employee's claim into an instruction to payroll. Migration
 *     0449 stamps every declaration that predates that round approved — WITHOUT THAT BACKFILL THIS QUERY
 *     RETURNS NOTHING and every existing employee's relief stops silently, because "no approved
 *     declaration" and "nobody declared anything" are the same empty set. If relief has gone missing on a
 *     run, check the backfill first.
 *
 *   · NO `approved_month <= month` IN SQL (r209). There used to be one here and core/tax-relief's limit
 *     check had no equivalent, so a declaration carried forward from before this form counted in FULL on
 *     one side and ZERO on the other and HR keyed each month's increment against a baseline missing it.
 *     Neither half was wrong alone; the CONTRACT between them was, and two fix passes that patched one
 *     half each moved money the wrong way. `tp1EffectiveFromMonth` is now the only spelling of "when does
 *     this start counting", both halves reach it through `tp1CountForYear`, and a month predicate here
 *     would restore the second spelling that caused the defect.
 */
async function tp1ApprovedRowsByPerson(
  tx: Tx,
  p: { personIds: string[]; assessmentYear: number },
): Promise<Map<string, Tp1CountableRow[]>> {
  const out = new Map<string, Tp1CountableRow[]>();
  if (p.personIds.length === 0) return out;
  const rows = await tx
    .select({ personId: tp1Relief.personId, ...TP1_COUNTABLE_COLUMNS })
    .from(tp1Relief)
    .where(
      and(
        inArray(tp1Relief.personId, p.personIds),
        eq(tp1Relief.assessmentYear, p.assessmentYear),
        eq(tp1Relief.status, 'approved'),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.personId) ?? [];
    list.push(r);
    out.set(r.personId, list);
  }
  return out;
}

/**
 * Prefill a draft batch's TP1 personal-relief deduction from the employee's TP1 declarations
 * (ADR-0050, #1.1.3; ADR-0081). On /me an employee declares for the assessment YEAR; on the HR screen a
 * year holds one declaration per DEDUCTION MONTH, each carrying that month's INCREMENT.
 *
 * ⚠️ THIS IS NO LONGER THE BRIDGE — IT IS A PREVIEW OF IT (item 3fa088fb). Until that item this function
 * was the ONLY writer of `payroll_input.tp1_deduction`, reachable only through a button on the draft batch
 * screen, and nothing called it at batch creation or at generate time. Measured on production: 8 approved
 * 2026 declarations, 88 payslips issued, ZERO carrying a relief — every employee who declared one was
 * over-deducted, every month, silently. `generatePayslips` now DERIVES LP₁ itself from the declaration,
 * with no button, exactly as it already auto-applies the fixed zakat election. This function survives
 * because it still earns its place: it lets an operator see the figure land on a draft, and edit it, before
 * generating. It is not load-bearing any more, and pressing it must never change the outcome — which is
 * why the delta lives in `resolveTp1Feed` and BOTH sides call that one function.
 *
 * `annual` IS `tp1CountForYear(rows, { throughMonth: this batch's month }).total`, reached through
 * `resolveTp1Feed` — core/tax-relief's OWN reduction, not a copy of it: the winning APPROVED declaration
 * per deduction month, over the months already effective for this batch. Not the newest row: with additive
 * per-month declarations, taking the newest would make a second declaration REDUCE the relief. The
 * screen's Accumulated/Remaining strip and the limit check call that SAME function, which is the whole
 * point of r209 — before it, this side and that side each decided for themselves what a carried-forward
 * declaration was worth and disagreed by its full amount, with nothing between them to say so. See
 * `tp1ApprovedRowsByPerson`, and migration 0449's backfill for why the gate is 'approved'.
 *
 * The kernel SUMS each month's `st.lp` into `acc.lpAccumulated` and PCB consumes `∑LP + LP₁`, so feeding
 * the full annual every month over-relieves. Per ADR-0050 §0.1 (delta method) the feed is
 *   feed = max(0, annual − ∑LP_already_accumulated_this_year_for_the_paymaster_employment)
 * reading `∑LP` by replaying this assessment year's prior payslips' `st.lp`, so `∑LP + LP₁` converges to
 * the declared annual, claimed exactly once. Self-correcting under mid-year adoption, re-run/idempotency,
 * and mid-year correction.
 *
 * ⚠️ THE REPLAY IS NO LONGER THE WHOLE OF THE KERNEL'S ∑LP, AND THAT IS DELIBERATE (item 20837372).
 * Since migration 0488 `generatePayslips` OPENS `acc.lpAccumulated` with the Form TP3 Section D balance
 * (`employee_statutory_my.tp3_lp`) and replays prior payslips on top; this function reads the replay
 * ONLY. The two are asking different questions and the difference is not drift:
 *   · the kernel asks "what deductions has this person had THIS YEAR, from anywhere" — the
 *     specification's printed page 11 defines ∑LP as "Accumulated allowable deductions in the current
 *     year, including from previous employment, if any", so the previous employer's reliefs belong in it;
 *   · this function asks "how much of the annual THIS employee declared TO US on their TP1 is still
 *     unfed" — and a relief claimed through a DIFFERENT employer has never been fed by us, so netting it
 *     off here would silently shrink a declaration the employee made to this employer.
 * Subtracting `tp3_lp` here would do exactly that, and is why it is not subtracted.
 *
 * ⚠️ RISK, NAMED RATHER THAN SILENTLY DECIDED: because the two sides are independent, an employee who
 * declares the SAME relief code on their TP3 (already claimed at the previous employer) AND on their
 * TP1 with us now has both counted, and their combined ∑LP can exceed the statutory annual limit for
 * that code. `checkTp1OverClaim` caps a TP1 declaration against our own declarations only; it has never
 * seen a TP3. Before this round Section D contributed nothing, so the stacking was not reachable. It is
 * an employee-declaration correctness problem that LHDN's own design leaves with the employee (each
 * employer is told what to deduct and cannot audit the other), and the year-end assessment settles it —
 * but a cross-form per-code cap is the right follow-up and it is NOT built here, because deciding which
 * of the two declarations yields is policy this repo has no source for.
 *
 * Routing (§0.5): the relief is keyed by person but tp1_deduction is per-employment, so for a person with
 * concurrent employments in the batch it is written ONLY to `designated_paymaster_employment_id` (when set;
 * else the single employment of that person in the batch). Other employments are left untouched. The rule
 * itself lives in `tp1TargetEmploymentByPerson`, shared with the kernel so the two cannot disagree about
 * which employment relieves.
 *
 * Provenance (§0.4): writes/refreshes only a tp1_deduction whose `tp1_source = 'tp1_self'` (or a row that
 * has none yet), and stamps `tp1_source = 'tp1_self'`. A row last set by the admin form (`tp1_source` null)
 * is a manual override and is left untouched. Uses a targeted `.update().set({ tp1Deduction })` that
 * preserves overtime/bonus/zakat/claimAllowance — never `setPayrollInput` (which would zero them).
 * Draft-only; throws `BatchNotDraftError` otherwise.
 */
export async function prefillTp1FromSelfRelief(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number; skipped: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // §0.5 routing, in the ONE shared spelling `generatePayslips` also uses — personId → the single
    // employment that carries this person's relief on this batch. See `tp1TargetEmploymentByPerson`.
    const targetByPerson = await tp1TargetEmploymentByPerson(tx, {
      companyId: batch.companyId,
      periodStart,
      periodEnd,
    });
    if (targetByPerson.size === 0) return { applied: 0, skipped: 0 };

    // The APPROVED declarations for this assessment year (§0.6: payPeriod's year), in the ONE shared
    // query `generatePayslips` also uses. Why the gate is 'approved' and why there is no month predicate
    // in the SQL: see `tp1ApprovedRowsByPerson`.
    const personIds = [...targetByPerson.keys()];
    const rowsByPerson = await tp1ApprovedRowsByPerson(tx, { personIds, assessmentYear: pYear });
    if (rowsByPerson.size === 0) return { applied: 0, skipped: 0 };

    // ∑LP already accumulated this assessment year per target employment — replay prior payslips' st.lp.
    // Prior = earlier pay periods this year. ⚠️ THE TP3 SECTION D OPENING BALANCE IS DELIBERATELY NOT
    // ADDED HERE (item 20837372); the header above says why, and a test pins it.
    const targetEmpIds = personIds.map((pid) => targetByPerson.get(pid)!).filter(Boolean);
    const priorSlips = targetEmpIds.length
      ? await tx
          .select({ employmentId: payslip.employmentId, period: payrollBatch.payPeriod, statutory: payslip.statutory })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, targetEmpIds),
              like(payrollBatch.payPeriod, `${pYear}-%`),
              lt(payrollBatch.payPeriod, batch.payPeriod),
            ),
          )
      : [];
    const lpAccByEmp = new Map<string, number>();
    for (const s of priorSlips) {
      const st = (s.statutory ?? {}) as { lp?: number };
      lpAccByEmp.set(s.employmentId, round2((lpAccByEmp.get(s.employmentId) ?? 0) + Number(st.lp ?? 0)));
    }

    // Existing draft inputs for these target employments — preserve siblings; honour provenance.
    const existingInputs = await tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        tp1Deduction: payrollInput.tp1Deduction,
        tp1Source: payrollInput.tp1Source,
      })
      .from(payrollInput)
      .where(and(eq(payrollInput.batchId, p.batchId), inArray(payrollInput.employmentId, targetEmpIds)));
    const existingByEmp = new Map(existingInputs.map((r) => [r.employmentId, r]));

    let applied = 0;
    let skipped = 0;
    for (const personId of personIds) {
      const employmentId = targetByPerson.get(personId)!;
      const approvedRows = rowsByPerson.get(personId);
      if (!approvedRows) continue; // no approved declaration at all for this year
      // §0.1/0.2 delta, in core/tax-relief's ONE spelling — `generatePayslips` derives the identical
      // figure from the identical function, which is what makes the automatic path and this button agree.
      const { feed } = resolveTp1Feed({
        approvedRows,
        throughMonth: pMonth,
        lpAlreadyFed: lpAccByEmp.get(employmentId) ?? 0,
      });
      const prior = existingByEmp.get(employmentId);
      // §0.4: refresh only a prefill-set row (or one with no row yet). A manual admin override
      // (tp1_source null but a tp1_deduction already keyed) is sticky — skip it.
      if (prior) {
        const manualOverride = prior.tp1Source !== 'tp1_self' && Number(prior.tp1Deduction) > 0;
        if (manualOverride) {
          skipped += 1;
          continue;
        }
        await tx
          .update(payrollInput)
          .set({ tp1Deduction: feed.toFixed(2), tp1Source: 'tp1_self', updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          tp1Deduction: feed.toFixed(2),
          tp1Source: 'tp1_self',
        });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.input-set',
        actor: actorOf(ctx),
        // ADR-0030 Layer 0: figures live on payroll_input; reference, not cleartext.
        payload: { employmentId, source: 'tp1_self', fieldsChanged: ['tp1Deduction'] },
      });
      applied += 1;
    }
    return { applied, skipped };
  });
}

/**
 * 1.2.4 Zakat — prefill a draft batch's `payroll_input.zakat` from each in-scope employee's FIXED zakat
 * election, as a visibility/edit convenience: the kernel already auto-applies the fixed amount at generate
 * time (effectiveZakat resolution), so this only lets an admin see/override the figure on the batch row
 * before generating. The percent_of_pcb path needs none — it is derived live in the kernel.
 *
 * Scope: mirror `generatePayslips` exactly — the batch's company AND its `batch.scope` (departments +
 * explicit individuals). NOT a company-wide select (that would write orphan rows for employees outside the
 * batch's subset). Draft-only is enforced inside `setPayrollDeductionInput` → `setPayrollInput`, which also
 * preserves the sibling earnings/TP1 fields. We DON'T emit a second event: the input-set call already logs
 * it, and the derivation here is a trivial constant (fixedAmount), not an OT-style computation that would
 * warrant a derivation payload. Writes ONLY for active employees; never zeroes others (an employee whose
 * setup became inactive keeps any prior manual zakat — admin must clear it, same as OT/bonus preservation).
 *
 * NOTE (feedback d435673e): the Zakat screen's one-off override section was removed, so this prefill, the
 * batch input grid and the batch import are now the ONLY writers of `payroll_input.zakat`. Kernel precedence
 * is unchanged (manual > fixed > percent_of_pcb) — see the effectiveZakat resolution in generatePayslips.
 */
export async function prefillFixedZakat(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<{ applied: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        scope: payrollBatch.scope,
        runType: payrollBatch.runType,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    // ⚠️ REGULAR RUNS ONLY, AND THIS GATE IS WORTH REAL MONEY SINCE 3a092cf0.
    //
    // A zakat election is a MONTHLY amount. Stamping it onto an additional/off-cycle run as well applies
    // the same election twice in one month: the regular run charges it, then the bonus run charges it
    // again through the manual tier. Measured on a branch build — basic 6000 with a 90.00 election —
    // a regular run plus a bonus run deducted 180.00 against a 90.00 election.
    //
    // It was HARMLESS UNTIL NOW and that is the trap: before zakat joined the deduction total, the
    // duplicate stamp changed no figure anybody was paid, so nothing surfaced it. Putting zakat in the
    // total turned a dormant bookkeeping duplicate into money.
    //
    // `prefillLoans` and `prefillTp1Deductions` are already gated this way, both in this file and on the
    // adjustments panel; this one was the odd one out on both sides.
    if (batch.runType !== 'regular') throw new AdditionalRunPrefillNotAllowedError('zakat');

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Scope resolution identical to generatePayslips: empty/absent scope ⇒ whole company.
    const sc = (batch.scope ?? null) as BatchScope | null;
    const scopeDeptIds = sc?.departmentIds ?? [];
    const scopeExplicitIds = sc?.employmentIds ?? [];
    const deptAssignees = scopeDeptIds.length
      ? await tx
          .select({ id: assignment.employmentId })
          .from(assignment)
          .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
      : [];
    const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
    const scopeFilter =
      scopeDeptIds.length || scopeExplicitIds.length
        ? inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'])
        : undefined;

    // Active employees of the batch's company/scope in the period WITH an active FIXED zakat election.
    const rows = await tx
      .select({ employmentId: employment.id, zakatFixed: employeeStatutoryMy.zakatFixed })
      .from(employment)
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          // 3c88d593 — the DATED entity question, same as generatePayslips. Reading only the column here
          // and the history there is exactly the drift this helper exists to prevent: an employee the
          // kernel pays on the outgoing entity's run, on a screen that cannot see them.
          employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          eq(employeeStatutoryMy.zakatActive, true),
          eq(employeeStatutoryMy.zakatMethod, 'fixed'),
          scopeFilter,
        ),
      );

    let applied = 0;
    for (const r of rows) {
      const amount = round2(Number(r.zakatFixed ?? 0));
      if (amount <= 0) continue;
      await setPayrollDeductionInput(ctx, { batchId: p.batchId, employmentId: r.employmentId, zakat: amount });
      applied += 1;
    }
    return { applied };
  });
}

/**
 * Prefill a draft batch's overtime inputs from classified attendance (ADR-0011 → money).
 * Per employee, the period's per-day OT minutes (workday / rest day / holiday) are
 * monetized by the country pack — ORP = wages/26, 1.5× workday, rest-day ½/1-day rule
 * + 2×, holiday +2 days' ORP + 3×, and the First Schedule RM4,000 eligibility gate
 * (STATUTORY-SOURCES §6). Existing bonus inputs are preserved; the admin can still
 * override any figure. Each applied row appends an input-set event carrying the
 * derivation, so every ringgit is traceable to hours and rates.
 */
export async function prefillOvertimeFromAttendance(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        status: payrollBatch.status,
        country: company.country,
        statutoryTier: company.statutoryTier,
        companyName: company.legalName,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();
    // ADR-0080 D-14 — payroll is a statutory computation and is refused for a non-statutory company,
    // BY TIER rather than by the pack happening to be missing. The distinction matters to whoever reads
    // the error: "No localization pack for country TH" reads as a bug to be fixed, while "this is a
    // non-statutory company" reads as the deliberate arrangement it is. Checked BEFORE the pack lookup
    // so the tier is what speaks.
    assertStatutory(batch.statutoryTier, 'Payroll', batch.companyName);
    const pack = packFor(batch.country);
    if (!pack) throw new Error(`No localization pack for country ${batch.country}`);

    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019): DB override or the verified default. The
    // statutory month stays CALENDAR-bound by law — the cut-off window below moves only which OT transactions
    // land in the run, never the statutory month they contribute in.
    const rules = await pack.payroll.loadRuleset(tx, { asOf: periodEnd });

    // c7fdfcf6 (Payroll Schedule) — resolve the OVERTIME cut-off window for this run: OT transactions are pulled
    // from `[cut-off window]` instead of the fixed calendar month. Absent/calendar config ⇒ the window IS the
    // calendar month, so the query below is byte-identical for an unconfigured company.
    // Gap-fix (per-employment cut-off): the OT window is resolved PER employment (its assigned policy), not only
    // against the company default. The SQL fetch widens to the UNION of every active policy's OT window, then each
    // row is filtered to its own employment's window below. When no policy shifts the window the union equals the
    // calendar month, so the fetch is byte-identical for an unconfigured company.
    const otSched = await loadBatchCutOffSchedule(tx, batch.companyId);
    const otWindow = await unionTypeWindow(tx, otSched, batch.companyId, 'overtime', batch.payPeriod);
    // When the union already IS the calendar month, every per-employment window is the calendar month too, so the
    // per-row filter is a no-op and we skip the per-employment policy resolution entirely (byte-identical path).
    const otPerEmployment = otWindow.start !== periodStart || otWindow.end !== periodEnd;
    const otWindowCache = new Map<string, { start: string; end: string }>();

    // Per-day classified OT minutes within the cut-off window (per-day matters: the
    // rest-day ½/1-day rule cannot be computed from monthly aggregates). A day already banked as
    // time-in-lieu is excluded — see EXCLUDE_TOIL_BANKED_DAYS for why it is unconditional and why the
    // per-cycle read below shares the same expression.
    const excludeToilDays = EXCLUDE_TOIL_BANKED_DAYS;
    const otRowsRaw = await tx
      .select({
        employmentId: attendance.employmentId,
        attendanceDate: attendance.attendanceDate,
        dayType: attendance.dayType,
        otMinutes: attendance.otMinutes,
      })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .where(
        and(
          // 3c88d593 — the same period-wide entity test the generation query uses (see generatePayslips):
          // an employee who transferred out mid-month still worked overtime for the outgoing entity, and
          // reading only today's column meant those hours went to whichever employer they happen to be
          // with now — or nowhere at all. Inert until the entity history exists.
          employedByCompanyDuring(batch.companyId, otWindow.start, otWindow.end),
          gte(attendance.attendanceDate, otWindow.start),
          lte(attendance.attendanceDate, otWindow.end),
          gt(attendance.otMinutes, 0),
          excludeToilDays,
        ),
      );
    // ── 3c88d593 — EACH OVERTIME DAY GOES TO THE ENTITY THAT EMPLOYED THAT DAY ──────────────────────
    // Overtime on 8 August belongs to the company the employee was in on 8 August, and overtime on the
    // 15th to the one they moved to — which is exactly the request's own example. The rows are already
    // fetched per day (the rest-day half/full rule needs per-day granularity), so this is a filter, not a
    // new query. Resolved once per employment, and only for employments the widened predicate returned.
    const otEmpIds = [...new Set(otRowsRaw.map((r) => r.employmentId))];
    const otCurrentCompany = new Map(
      otEmpIds.length
        ? (
            await tx
              .select({ id: employment.id, companyId: employment.companyId })
              .from(employment)
              .where(inArray(employment.id, otEmpIds))
          ).map((r) => [r.id, r.companyId] as const)
        : [],
    );
    const otSegByEmp = await companySegmentsForPeriodBulk(tx, otEmpIds, otWindow.start, otWindow.end, otCurrentCompany);
    /** Did THIS company employ this person on this date? Unsegmented ⇒ always yes ⇒ unchanged behaviour. */
    const ownsDay = (employmentId: string, date: string): boolean => {
      const segs = otSegByEmp.get(employmentId);
      if (!segs || segs.length <= 1) return true;
      return segs.some((s) => s.companyId === batch.companyId && date >= s.from && date <= s.to);
    };
    // Gap-fix: keep only rows inside each employment's OWN overtime window (no-op when otPerEmployment is false).
    const otRows: typeof otRowsRaw = [];
    for (const r of otRowsRaw) {
      if (!ownsDay(r.employmentId, r.attendanceDate)) continue;
      if (!otPerEmployment) {
        otRows.push(r);
        continue;
      }
      const w = await employmentTypeWindow(tx, otSched, otWindowCache, r.employmentId, 'overtime', batch.payPeriod);
      if (r.attendanceDate >= w.start && r.attendanceDate <= w.end) otRows.push(r);
    }
    if (otRows.length === 0) return { applied: 0, ineligible: 0 };
    const empIds = [...new Set(otRows.map((r) => r.employmentId))];

    // Current s.2 wages (basic + fixed allowance) — the ORP basis.
    const comps = await tx
      .select({
        employmentId: compensation.employmentId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, empIds),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      );
    const wagesBy = new Map(
      comps.map((c) => [c.employmentId, round2(Number(c.basic) + Number(c.allowance ?? 0))]),
    );

    // Existing inputs: bonus must survive the prefill.
    const existing = await tx
      .select({
        id: payrollInput.id,
        employmentId: payrollInput.employmentId,
        bonus: payrollInput.bonusAmount,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const existingBy = new Map(existing.map((r) => [r.employmentId, r]));

    const daysBy = new Map<string, { dayType: 'workday' | 'rest_day' | 'holiday'; minutes: number }[]>();
    for (const r of otRows) {
      const arr = daysBy.get(r.employmentId) ?? [];
      arr.push({ dayType: r.dayType ?? 'workday', minutes: r.otMinutes ?? 0 });
      daysBy.set(r.employmentId, arr);
    }

    let applied = 0;
    let ineligible = 0;
    for (const employmentId of empIds) {
      const wages = wagesBy.get(employmentId);
      if (wages == null) continue; // no active compensation — nothing to monetize against
      const result = pack.payroll.overtimePay({
        monthlyWages: wages,
        days: daysBy.get(employmentId) ?? [],
        wageCeiling: rules.ot.wageCeiling,
        restDayExcessMultiplier: rules.ot.restDayExcessMultiplier,
        holidayExcessMultiplier: rules.ot.holidayExcessMultiplier,
      });
      if (!result.eligible) {
        ineligible += 1;
        continue; // > RM4,000 wages: no statutory OT — left for a manual (ex-gratia) entry
      }
      const prior = existingBy.get(employmentId);
      const bonusAmount = prior ? Number(prior.bonus) : 0;
      // ── a96d320c (migration 0479) — THE DECOMPOSITION, STAMPED WHERE IT HAPPENS ────────────────────
      //
      // `result` already carries the ordinary rate of pay, the hourly rate and the five EA legs with their
      // own quantities; every one of those numbers was thrown away here and the RM total alone was kept.
      // The reporter's payslip could therefore not say how many hours it paid for or at what rate, and the
      // hours could not be fetched back at render time without answering with TODAY's attendance about a
      // month already paid (r322 made mid-month correction a one-press action).
      //
      // THE SUM GATE IS THE HONESTY GUARANTEE, not a defensive nicety. Each leg's `amount` is computed from
      // its ROUNDED quantity, so a quantity that rounding moved can make the legs miss `result.total` by a
      // sen. A decomposition that does not add up to the figure it explains is not stamped at all, and the
      // payslip prints the overtime line exactly as it does today. An absent detail asserts nothing.
      const legTotal = round2(result.lines.reduce((s, l) => s + l.amount, 0));
      const otDerivation =
        result.lines.length > 0 && legTotal === round2(result.total)
          ? { version: 1 as const, orp: result.orp, hourly: result.hourly, total: round2(result.total), lines: result.lines }
          : null;
      if (prior) {
        await tx
          .update(payrollInput)
          // Reset any prior manual rate-bucket split: the statutory total is now the source, and a stale
          // decomposition that no longer sums to overtimeAmount would only confuse a later re-edit. Nothing
          // downstream reads ot_breakdown, so NULL is harmless and avoids the mismatch.
          // Fix-5 (M#17): stamp ot_source='attendance' so the editor knows this row is engine-derived and
          // warns before a casual manual Save overwrites it.
          // a96d320c — `otDerivation` is written UNCONDITIONALLY (null included) on this path, unlike
          // `otBreakdown`'s conditional spread elsewhere: this statement is replacing the OT figure, so a
          // decomposition left behind from a previous prefill would explain a number that is no longer
          // there. Null is the correct value when the legs did not add up.
          .set({ overtimeAmount: result.total.toFixed(2), otBreakdown: null, otDerivation, otSource: 'attendance', updatedAt: sql`now()` })
          .where(eq(payrollInput.id, prior.id));
      } else {
        await tx.insert(payrollInput).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId,
          overtimeAmount: result.total.toFixed(2),
          bonusAmount: bonusAmount.toFixed(2),
          // Fix-5 (M#17): attendance-derived provenance.
          otSource: 'attendance',
          // a96d320c — the hours and the rate behind the figure on the line above.
          otDerivation,
        });
      }
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.input-set',
        actor: actorOf(ctx),
        payload: {
          employmentId,
          overtimeAmount: result.total,
          bonusAmount,
          source: 'attendance',
          derivation: {
            orp: result.orp,
            hourly: result.hourly,
            workday: result.workday,
            restDay: result.restDay,
            holiday: result.holiday,
          },
        },
      });
      applied += 1;
    }
    return { applied, ineligible };
  });
}

/**
 * Prefill the SHIFT_DIFFERENTIAL pay-component from worked differential shifts in the period (ADR-0032 C5).
 * A shift's `differential` is a CONFIGURABLE employer premium (NOT statutory): flat_per_shift (RM/shift),
 * flat_hourly (RM/worked hour), or percent (% uplift on the ORP hourly rate × worked hours). Rides the
 * typed-pay-component path: gated by TYPED_PAY_COMPONENTS_ENABLED (off ⇒ no-op, since the kernel wouldn't
 * read the batch component anyway). The component's flags (EPF/SOCSO/PCB yes, HRDF no) drive the statutory
 * treatment when the payslip is generated.
 */
export async function prefillShiftDifferentialFromRoster(ctx: SessionContext, p: { batchId: string }) {
  if (!isModuleEnabled(ctx, 'typed_pay_components')) return { applied: 0, gated: true as const };
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ id: payrollBatch.id, companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    if (batch.status !== 'draft') throw new BatchNotDraftError();

    const [comp] = await tx.select({ id: payComponent.id }).from(payComponent).where(eq(payComponent.code, 'SHIFT_DIFFERENTIAL')).limit(1);
    if (!comp) throw new Error('SHIFT_DIFFERENTIAL pay-component is not seeded — run the catalog seed first');

    // c7fdfcf6 (Payroll Schedule) — shift-differential is derived from ATTENDANCE, so it follows the attendance
    // cut-off window. Absent/calendar config ⇒ the window is the calendar month (byte-identical).
    // Gap-fix (per-employment cut-off): the attendance window is resolved PER employment (its assigned policy).
    // The SQL fetch widens to the UNION of every active policy's attendance window, then each row is filtered to
    // its own employment's window below. Union == calendar month when nothing shifts it ⇒ byte-identical fetch.
    const shiftSched = await loadBatchCutOffSchedule(tx, batch.companyId);
    const attWindow = await unionTypeWindow(tx, shiftSched, batch.companyId, 'attendance', batch.payPeriod);
    const [sy, sm] = batch.payPeriod.split('-').map(Number);
    const shiftPeriodStart = `${batch.payPeriod}-01`;
    const shiftPeriodEnd = `${batch.payPeriod}-${String(daysInMonth(sy, sm)).padStart(2, '0')}`;
    const attPerEmployment = attWindow.start !== shiftPeriodStart || attWindow.end !== shiftPeriodEnd;
    const attWindowCache = new Map<string, { start: string; end: string }>();

    // Worked differential shifts in the cut-off window for this company (the actual attendance row joined to the
    // rostered shift, keeping only shifts that carry a differential).
    const rowsRaw = await tx
      .select({ employmentId: attendance.employmentId, attendanceDate: attendance.attendanceDate, workedMinutes: attendance.workedMinutes, differential: shift.differential })
      .from(attendance)
      .innerJoin(employment, eq(employment.id, attendance.employmentId))
      .innerJoin(
        rosterAssignment,
        and(eq(rosterAssignment.employmentId, attendance.employmentId), eq(rosterAssignment.shiftDate, attendance.attendanceDate)),
      )
      .innerJoin(shift, eq(shift.id, rosterAssignment.shiftId))
      .where(
        and(
          // ── 1b0943d5, SITE 2 OF 5 — DATED, AND CLIPPED PER DAY. ──────────────────────────────────
          // This is the THIRD attendance-derived pay component in this file, and the other two already
          // ask the dated question (the OT prefill, and the per-cycle OT bucketing below). A shift worked
          // on 8 August was worked for the employer of 8 August; on the column, the outgoing entity's run
          // could not see the shift at all AND the incoming entity's run would pay a differential for a
          // night shift worked before it employed the person. Same shape, same fix, same two steps as the
          // OT prefill: widen the fetch to the period's employers, then keep only the days THIS employer
          // owns. Inert until an entity history exists ⇒ byte-identical for every company today.
          employedByCompanyDuring(batch.companyId, attWindow.start, attWindow.end),
          gte(attendance.attendanceDate, attWindow.start),
          lte(attendance.attendanceDate, attWindow.end),
          gt(attendance.workedMinutes, 0),
          isNotNull(shift.differential),
        ),
      );
    // Resolved once per employment, over the SAME window the rows were fetched for — see the OT prefill's
    // note for why this is a filter over already-per-day rows rather than a second query per row.
    const diffEmpIds = [...new Set(rowsRaw.map((r) => r.employmentId))];
    const diffCurrentCompany = new Map(
      diffEmpIds.length
        ? (
            await tx
              .select({ id: employment.id, companyId: employment.companyId })
              .from(employment)
              .where(inArray(employment.id, diffEmpIds))
          ).map((r) => [r.id, r.companyId] as const)
        : [],
    );
    const diffSegByEmp = await companySegmentsForPeriodBulk(
      tx,
      diffEmpIds,
      attWindow.start,
      attWindow.end,
      diffCurrentCompany,
    );
    /** Did THIS company employ this person on this date? Unsegmented ⇒ always yes ⇒ unchanged behaviour. */
    const diffOwnsDay = (employmentId: string, date: string): boolean => {
      const segs = diffSegByEmp.get(employmentId);
      if (!segs || segs.length <= 1) return true;
      return segs.some((s) => s.companyId === batch.companyId && date >= s.from && date <= s.to);
    };
    // Gap-fix: keep only rows inside each employment's OWN attendance window (no-op when attPerEmployment false).
    const rows: typeof rowsRaw = [];
    for (const r of rowsRaw) {
      if (!diffOwnsDay(r.employmentId, r.attendanceDate)) continue;
      if (!attPerEmployment) {
        rows.push(r);
        continue;
      }
      const w = await employmentTypeWindow(tx, shiftSched, attWindowCache, r.employmentId, 'attendance', batch.payPeriod);
      if (r.attendanceDate >= w.start && r.attendanceDate <= w.end) rows.push(r);
    }
    if (rows.length === 0) return { applied: 0 };
    const empIds = [...new Set(rows.map((r) => r.employmentId))];

    // ORP hourly rate (s.2 wages / 26 / 8) — only needed for percent differentials.
    const comps = await tx
      .select({ employmentId: compensation.employmentId, basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
      .from(compensation)
      .where(and(inArray(compensation.employmentId, empIds), isNull(compensation.validTo), isNull(compensation.supersededAt)));
    const hourlyBy = new Map(comps.map((c) => [c.employmentId, (Number(c.basic) + Number(c.allowance ?? 0)) / 26 / 8]));

    const totalBy = new Map<string, number>();
    for (const r of rows) {
      const diff = r.differential as ShiftDifferential | null;
      if (!diff) continue;
      const hours = (r.workedMinutes ?? 0) / 60;
      let amt = 0;
      if (diff.kind === 'flat_per_shift') amt = diff.value;
      else if (diff.kind === 'flat_hourly') amt = diff.value * hours;
      else if (diff.kind === 'percent') amt = (hourlyBy.get(r.employmentId) ?? 0) * hours * (diff.value / 100);
      totalBy.set(r.employmentId, (totalBy.get(r.employmentId) ?? 0) + amt);
    }

    let applied = 0;
    for (const [employmentId, total] of totalBy) {
      if (total <= 0) continue;
      await setPayrollBatchComponent(ctx, { batchId: batch.id, employmentId, componentId: comp.id, amount: round2(total), notes: 'Shift differential (from roster)' }, tx);
      applied += 1;
    }
    return { applied };
  });
}

export async function generatePayslips(
  ctx: SessionContext,
  p: {
    batchId: string;
    /**
     * Selective in-place reprocessing (feedback 9bc442bc, reporter ask #3 + #8). When present, the batch
     * must already be PROCESSED: only these employees' payslips are recomputed, the others stay physically
     * untouched, batch totals/GL are updated BY DELTA (old-subset subtracted, new-subset added), and the
     * batch stays processed. This reuses the whole compute path below for byte-faithful figures; only the
     * employee filter and the final write differ. Loan-ledger apply + claim-paid side-effects run ONLY on
     * the full draft→processed generation, never on a subset reprocess (those were already applied at the
     * original processing and the preserved payroll_input rows reproduce the same loan/claim lines).
     */
    reprocessSubset?: { employmentIds: string[]; reason?: string; actorId?: string };
  },
) {
  const subset = p.reprocessSubset ?? null;
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, p.batchId)).limit(1);
    if (!batch) throw new Error('batch not found');
    if (subset) {
      // Reprocess target must be a processed run (a draft has nothing to reprocess; a closed run is frozen).
      if (batch.status !== 'processed') throw new BatchNotResettableError();
    } else if (batch.status !== 'draft') {
      throw new BatchNotDraftError();
    }

    // ── ADR-0085 step 4 — THE MONEY GUARD. See `refuseIfPeriodFiled` for why the line is `run_seq > 1`.
    // This is the one that matters: `createAdditionalRun` refuses early, but a run created before a
    // filing and generated after it would otherwise walk straight past that check. Placed BEFORE any
    // figure is computed and inside the same transaction, so nothing is written on the refusing path.
    // A run at seq 1 is untouched — an ordinary single monthly run never reaches this.
    if (batch.runSeq > 1) {
      await refuseIfPeriodFiled(tx, {
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        what: subset ? 'Reprocessing this run' : 'Processing this run',
      });
    }

    // Pre-processing validation (feedback f1564110, Phase 1): a full draft→processed generation is
    // BLOCKED while any scoped, period-active employee has no current compensation row — previously
    // those employees were silently dropped by the inner join below. Fails closed BEFORE any write,
    // so there is deliberately no DomainEvent (nothing changed state). Warning-class gaps (missing
    // statutory profile / bank details) do not block here — the operator confirms them explicitly in
    // generateAction. A subset reprocess targets a processed run that already passed this gate.
    if (!subset) {
      const checks = await preProcessChecksTx(tx, { companyId: batch.companyId, payPeriod: batch.payPeriod, scope: batch.scope }, isModuleEnabled(ctx, 'typed_pay_components'));
      // BLOCKER: no compensation row covering the period (a missing open row is silently dropped by the
      // earnings inner-join; an effective date past the period is a salary the period never had) OR a zero
      // basic/rate (feedback 64fb5e48 — the Personnel record would pay nothing). The old BASIC-component
      // existence blocker is GONE (feedback 64fb5e48): the Personnel Basic Salary record is the
      // authoritative pay source, so an internal BASIC pay item is never a processing prerequisite.
      // ADR-0078 adds unpayablePayMode: a custom_period employee has NO calculation and must not be quietly
      // paid their monthly-equivalent basic. staleBasicComponent is a WARNING and never blocks.
      // Item 1bb09a73 adds tp3YearMismatch: a declared previous-employment figure that this run would
      // seed as ZERO. EXACT SET, UPDATED AND NOT LOOSENED — a new blocker that is not added here is a
      // card on the screen that the server never enforces.
      const blocked =
        checks.missingCompensation.length +
        (checks.zeroBasic?.length ?? 0) +
        (checks.unpayablePayMode?.length ?? 0) +
        (checks.tp3YearMismatch?.length ?? 0);
      if (blocked > 0) throw new PreProcessBlockedError(blocked);
    }

    const [co] = await tx
      .select({ country: company.country })
      .from(company)
      .where(eq(company.id, batch.companyId))
      .limit(1);
    const pack = packFor(co?.country);
    if (!pack) throw new Error(`No localization pack for ${co?.country ?? 'company'}`);

    // HRD Corp levy registration band for this employer (Wave 2A). Default not_registered = no levy,
    // so a company that hasn't set its band produces byte-identical payroll to pre-HRDF.
    const [coStat] = await tx
      .select({ hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, batch.companyId))
      .limit(1);
    const hrdfStatus = coStat?.hrdfStatus ?? 'not_registered';

    // Active employees with current compensation.
    const { payPeriod } = batch;
    const [pYear, pMonth] = payPeriod.split('-').map(Number);
    const periodStart = `${payPeriod}-01`;
    const periodEnd = `${payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;

    // Statutory ruleset in effect at period end (ADR-0019 / ADR-0020). Loaded ONCE with its provenance
    // (source + packVersion + signedKeyId) and threaded into the (pure, synchronous) calculators below; the
    // ruleset `version` + pack provenance are snapshotted onto every payslip so a later edit/pack can never
    // alter this batch, and a forged/wrong-pack incident is traceable to the key + packVersion that produced it.
    const resolved = await pack.payroll.loadRulesetResolved(tx, { asOf: periodEnd });
    const rules = resolved.ruleset;
    // #6 (ADR-0037): per-body provenance to stamp on each payslip — but ONLY when a component override
    // is actually in effect, so a tenant with no overrides keeps a byte-identical statutory snapshot.
    const anyComponentOverride = Object.values(resolved.components).some((c) => c.source === 'component');
    const componentVersions = anyComponentOverride
      ? (Object.fromEntries(Object.entries(resolved.components).map(([b, c]) => [b, c.version])) as Record<string, string>)
      : null;
    const statutoryProvenance =
      resolved.source === 'pack' ? { packVersion: resolved.packVersion, signedKeyId: resolved.signedKeyId } : {};

    // Subset selection (1E, #23): narrow the active set to the chosen departments / individuals; an
    // absent/empty scope ⇒ the whole company (unchanged behaviour).
    const sc = (batch.scope ?? null) as BatchScope | null;
    const scopeDeptIds = sc?.departmentIds ?? [];
    const scopeExplicitIds = sc?.employmentIds ?? [];
    // Employment has no department column — the link is the effective-dated assignment. Resolve chosen
    // departments → their current assignees, unioned with any explicitly-named individuals.
    const deptAssignees = scopeDeptIds.length
      ? await tx
          .select({ id: assignment.employmentId })
          .from(assignment)
          .where(and(inArray(assignment.departmentId, scopeDeptIds), isNull(assignment.supersededAt)))
      : [];
    const scopeEmploymentIds = [...new Set([...deptAssignees.map((r) => r.id), ...scopeExplicitIds])];
    const scopeFilter =
      scopeDeptIds.length || scopeExplicitIds.length
        ? inArray(employment.id, scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'])
        : undefined;
    const scopeConstrained = scopeDeptIds.length > 0 || scopeExplicitIds.length > 0;

    // ── fbcf706d — WHAT, EXACTLY, IS IN THIS SUBSET? ───────────────────────────────────────────────
    //
    // The selective path used to know only that a posted employment belonged to the COMPANY. It never
    // asked whether the id was on this RUN, so a company-mate who had never been part of it was accepted
    // and then silently removed by the filters below — reported back as "reprocessed" with nothing done.
    // Now that the screen also offers people who are eligible for the month but have NO payslip here, the
    // same posted list carries two different kinds of work, and they must be told apart before anything
    // is computed. Each posted id is classified once, against two facts that cannot drift:
    //
    //   EXISTING — a payslip for it already exists on this batch. It was therefore in scope when that
    //              payslip was written, so this is a recalculation: version bumps, ledgers stay put.
    //   ADDED    — no payslip here, but the employment is period-active on this company (hired on/before
    //              the period end, not terminated before the period start). This is a FIRST processing
    //              for that person on this run: readiness is gated, and the money-side effects a first
    //              processing performs are performed. The batch SCOPE is deliberately not part of this
    //              test — an explicit add widens a scoped run on purpose (see the widening below).
    //
    // Anything that is neither is refused BY NAME. Note the window here is exactly the one the earnings
    // query below applies (lte hiredOn periodEnd / terminatedOn null-or-≥ periodStart), read off the
    // same columns, so a row can never be classified ADDED and then dropped as ineligible.
    const NO_ROWS_UUID = '00000000-0000-0000-0000-000000000000';
    const postedSubsetIds = subset ? [...new Set(subset.employmentIds.filter(Boolean))] : [];
    let addedEmploymentIds: string[] = [];
    if (subset) {
      const idFilter = postedSubsetIds.length ? postedSubsetIds : [NO_ROWS_UUID];
      const slipRows = await tx
        .select({ employmentId: payslip.employmentId })
        .from(payslip)
        .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, idFilter)));
      const hasSlip = new Set(slipRows.map((r) => r.employmentId));
      const eligibleRows = await tx
        .select({ id: employment.id, name: person.fullName, employeeCode: employment.employeeCode })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(
          and(
            // 3c88d593 — the DATED entity question, and it MUST match the earnings query below. The
            // comment above promises the two windows are read off the same facts so a row can never be
            // classified ADDED and then dropped as ineligible; leaving this one on the column while the
            // kernel asks the history would break that promise in the other direction — an employee the
            // run will pay could never be ADDED to it.
            employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
            lte(employment.hiredOn, periodEnd),
            or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
            inArray(employment.id, idFilter),
          ),
        );
      const eligible = new Map(eligibleRows.map((r) => [r.id, r]));
      // (The EXISTING half needs no list of its own: it is `hasSlip`, and the recalculated count below
      // is taken from what the earnings query actually computed rather than from what was posted.)
      addedEmploymentIds = postedSubsetIds.filter((id) => !hasSlip.has(id) && eligible.has(id));
      const neither = postedSubsetIds.filter((id) => !hasSlip.has(id) && !eligible.has(id));
      if (neither.length > 0) {
        // Name them. The ids reached here through the company intersection, so a person row exists; the
        // fallback covers an id whose employment row vanished between the two statements.
        const named = await tx
          .select({ id: employment.id, name: person.fullName, employeeCode: employment.employeeCode })
          .from(employment)
          .innerJoin(person, eq(person.id, employment.personId))
          .where(inArray(employment.id, neither));
        throw new ReprocessNotOnBatchError(
          neither.map((id) => {
            const row = named.find((n) => n.id === id);
            return { employmentId: id, name: row?.name ?? id, employeeCode: row?.employeeCode ?? null };
          }),
        );
      }

      // READINESS, for the added employments only. preProcessChecksTx is SCOPED to exactly these
      // employments rather than re-implemented, so what blocks an add is verbatim what blocks a first
      // processing — and a pre-existing gap belonging to somebody else on the run still cannot block a
      // correction (which is why the whole-run gate above stays skipped for a subset).
      if (addedEmploymentIds.length > 0) {
        const addChecks = await preProcessChecksTx(
          tx,
          { companyId: batch.companyId, payPeriod: batch.payPeriod, scope: { employmentIds: addedEmploymentIds } },
          isModuleEnabled(ctx, 'typed_pay_components'),
        );
        const blockedRows = [
          ...addChecks.missingCompensation.map((r) => ({ ...r, gap: 'no current salary record' })),
          ...(addChecks.zeroBasic ?? []).map((r) => ({ ...r, gap: 'a salary record that would pay nothing' })),
          ...(addChecks.unpayablePayMode ?? []).map((r) => ({ ...r, gap: 'a pay structure this system cannot calculate' })),
        ];
        if (blockedRows.length > 0) throw new ReprocessAddBlockedError(blockedRows);
      }
    }

    // f1564110 Phase 2 — attach-on-generate (amends ADR-0056). One-off individual transactions keyed in
    // BEFORE this run existed (batch_id NULL, matching company + pay month) are stamped onto this batch now,
    // inside the same transaction, so the ledger they belong to is the run that pays the month. REGULAR run
    // only — AMENDED BY c11e81aa BELOW, which routes a row that NAMED a cycle to that cycle's run instead;
    // a row that named none is still the regular run's and nobody else's. In multi-cycle months the
    // off-cycle/bonus/adjustment runs otherwise keep explicit-batch targeting via the wizard, so an
    // unattached row can never be double-collected by a sibling run. Full draft→processed
    // generation only (a subset reprocess recomputes a processed run whose ledger is already attached).
    // Scope-constrained runs collect only in-scope employees' rows; the rest stay unattached for a later
    // (re)generation or a widened scope. Kernel consumption of the attached rows is Phase 3 (flag-gated);
    // attaching here is the substrate that makes that fold — and the payslip-side audit trail — possible.
    //
    // fbcf706d amends the "full generation only" rule in ONE direction: an ADDED employment is having its
    // first payslip on this run written now, so a one-off already waiting for it (period-keyed, no batch)
    // belongs to this run exactly as it would have at the original processing. The narrowing to the added
    // ids is what keeps that true — an employment being RECALCULATED still collects nothing, because its
    // ledger was attached when it was first paid and re-attaching would pay a later month's row here.
    //
    // c11e81aa AMENDS THE "REGULAR RUN ONLY" RULE — BY THE ROW'S OWN INTENT, NOT BY WIDENING THE RUN.
    // The entry form now offers the CONFIGURED Pay Cycles (Payroll → Settings → Payroll Cycles) rather
    // than the runs that happen to exist, so a row keyed for a future month can name "Bonus". That choice
    // is stored on the row (`intended_cycle_id`, 0441) and this is where it is honoured:
    //
    //   • a row that named NO cycle — every row on production today — is collected by the REGULAR run,
    //     exactly as before, and by nothing else;
    //   • a row that named a cycle is collected ONLY by the run OPENED UNDER THAT VERY CYCLE
    //     (`payroll_batch.payroll_cycle_id`, same migration). So the regular run stops collecting a row
    //     the operator marked "Bonus" (the silent pay-affecting surprise this change exists to prevent),
    //     and the bonus run — which collects nothing today — collects it instead.
    //
    // IDENTITY, NOT RUN TYPE. Three default cycles share run_type 'off_cycle', so a type match would let
    // an "Advance Salary" run pay a row saved as "Mid-Month". `collectableCycleIds` above is the single
    // rule, shared with the pending-money card so the two can never disagree; read its comment for why
    // 'regular' is the one case where the type IS the identity, and why archived cycles still resolve.
    //
    // The double-collection guard the old rule bought by refusing every non-regular run therefore
    // survives: each unattached row is claimable by exactly one CYCLE in the month, at most one run is
    // opened under a given cycle in a period in practice, and the `batch_id IS NULL` predicate makes the
    // first run to generate the only one that can take it in any case.
    const attachForAdded = subset !== null && addedEmploymentIds.length > 0;
    const collectable = await collectableCycleIds(tx, batch);
    // A non-regular run that names no cycle can claim nothing, and `inArray` with an empty list is not a
    // query worth issuing — skip the whole statement, which is exactly today's behaviour.
    if ((!subset || attachForAdded) && !collectable.collectsNothing) {
      const intentFilter = intendedCycleFilter(collectable);
      const attachedTxns = await tx
        .update(payrollIndividualTxn)
        .set({ batchId: p.batchId })
        .where(
          and(
            isNull(payrollIndividualTxn.batchId),
            eq(payrollIndividualTxn.companyId, batch.companyId),
            eq(payrollIndividualTxn.payPeriod, batch.payPeriod),
            intentFilter,
            subset
              ? inArray(payrollIndividualTxn.employmentId, addedEmploymentIds)
              : scopeConstrained
                ? inArray(
                    payrollIndividualTxn.employmentId,
                    scopeEmploymentIds.length ? scopeEmploymentIds : ['00000000-0000-0000-0000-000000000000'],
                  )
                : undefined,
          ),
        )
        .returning({
          id: payrollIndividualTxn.id,
          employmentId: payrollIndividualTxn.employmentId,
          kind: payrollIndividualTxn.kind,
        });
      for (const t of attachedTxns) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-individual-txn',
          aggregateId: t.id,
          eventType: 'payroll.individual-txn.attached',
          actor: actorOf(ctx),
          subjectEmploymentId: t.employmentId,
          payload: { batchId: p.batchId, companyId: batch.companyId, payPeriod: batch.payPeriod, kind: t.kind },
        });
      }
    }

    // Anyone employed for at least part of the period: hired on/before period end AND not
    // terminated before period start. Mid-period joiners/leavers get a prorated (final) payslip.
    //
    // r226 — `let`, not `const`: an ADDITIONAL run narrows this list once the run's money is known (see
    // the skip block just above the payslip loop). Everything downstream that is keyed off `emps` —
    // `markIndividualTxnsConsumed`, the claim-paid set, `employeeCount`, the processed event's `count`
    // and the returned `payslips` — is then keyed off the people this run actually pays, which is the
    // whole money-safety half of the change.
    let emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        // 3c88d593 — TODAY's entity, which is the entity resolver's fallback for any range the dated
        // history does not cover. Selected here so the resolver needs no second query per employee.
        currentCompanyId: employment.companyId,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
        // ADR-0078 (642ecc55) — the employee's OWN salary structure: `basic` stays the monthly-equivalent
        // wage for every statutory/derived read; payMode + rateAmount drive the daily/hourly basic-pay
        // branches below (the rate source moved here from policy.payRule in migration 0290).
        payMode: compensation.payMode,
        rateAmount: compensation.rateAmount,
        taxCategory: employeeStatutoryMy.taxCategory,
        numChildren: employeeStatutoryMy.numChildren,
        // Item d64d0df4 — registered disabled individual (OKU). Drives the FURTHER annual deduction in the
        // PCB projection of P; the amount itself is statutory and comes from the country pack's ruleset.
        disabledIndividual: employeeStatutoryMy.disabledIndividual,
        // Item d64d0df4 — the spouse's OKU status (a further deduction, gated by the pack to tax
        // category 2 exactly as the spouse deduction is), plus the child-relief MODE and the keyed
        // category GRID. The grid is read ONLY when the mode is 'auto_table'; num_children below stays
        // the whole head count for Form E / CP8D / EA regardless of mode.
        disabledSpouse: employeeStatutoryMy.disabledSpouse,
        childReliefMode: employeeStatutoryMy.childReliefMode,
        childReliefTable: employeeStatutoryMy.childReliefTable,
        isResident: employeeStatutoryMy.isResident,
        // Item 8b5334db — tax residency drives the PCB method (resident MTD / non-resident flat 30% / REP +
        // Knowledge Worker flat 15%); employer_bears_tax funds the employee's PCB from employer cost.
        taxResidency: employeeStatutoryMy.taxResidency,
        employerBearsTax: employeeStatutoryMy.employerBearsTax,
        eisEligible: employeeStatutoryMy.eisEligible,
        // SOCSO / EIS contribution-category override (item a7271737) — 'auto' keeps the age/citizenship
        // derivation below; 'first'/'second' pin the SOCSO band; 'none' zeroes the SOCSO/EIS leg respectively.
        socsoCategory: employeeStatutoryMy.socsoCategory,
        eisCategory: employeeStatutoryMy.eisCategory,
        // SOCSO & EIS statutory controls (item 5a461b99) — subject_to_* gate the scheme; employer_bears_*
        // fund the employee's share from employer cost without deducting it from net.
        subjectToSocso: employeeStatutoryMy.subjectToSocso,
        subjectToSkbbk: employeeStatutoryMy.subjectToSkbbk,
        employerBearsSocso: employeeStatutoryMy.employerBearsSocso,
        employerBearsEis: employeeStatutoryMy.employerBearsEis,
        employerBearsSkbbk: employeeStatutoryMy.employerBearsSkbbk,
        // Item 0d9bb2da — employer bears the employee's EPF share (EPF still computed + reported in full;
        // only the funding of the employee leg moves to employer cost). Off by default ⇒ byte-identical.
        employerBearsEpf: employeeStatutoryMy.employerBearsEpf,
        // Feedback 0df0c635 — per-employee "Subject to HRDF" (Others Statutory card). Tri-state: null
        // follows the company registration default (byte-identical); explicit false excludes the
        // employee's base from the HRD Corp levy; explicit true keeps it in.
        subjectToHrdf: employeeStatutoryMy.subjectToHrdf,
        epfCitizenship: employeeStatutoryMy.epfCitizenship,
        epfMode: employeeStatutoryMy.epfMode,
        epfEmployeeRate: employeeStatutoryMy.epfEmployeeRate,
        epfEmployerRate: employeeStatutoryMy.epfEmployerRate,
        dateOfBirth: person.dateOfBirth,
        tp3Year: employeeStatutoryMy.tp3Year,
        tp3Net: employeeStatutoryMy.tp3NetRemuneration,
        tp3Epf: employeeStatutoryMy.tp3EpfClaimed,
        tp3Pcb: employeeStatutoryMy.tp3PcbPaid,
        tp3Zakat: employeeStatutoryMy.tp3ZakatPaid,
        // ∑LP carried in from previous employment — Form TP3 Section D (item 20837372, migration 0488).
        tp3Lp: employeeStatutoryMy.tp3Lp,
        // 1.2.4 Zakat election (per-employee). The current row is read like every other statutory field
        // (this config class is not effective-dated); effective from/to are display-only and not read here.
        zakatActive: employeeStatutoryMy.zakatActive,
        zakatMethod: employeeStatutoryMy.zakatMethod,
        zakatPercent: employeeStatutoryMy.zakatPercent,
        zakatFixed: employeeStatutoryMy.zakatFixed,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(
        and(
          // ── 3c88d593 — WHO BELONGS TO THIS EMPLOYER'S RUN, over the period rather than today ────────
          //
          // This used to be `employment.company_id = batch.company_id` and nothing else, which is why an
          // employee who transferred out on the 11th vanished from their old employer's month entirely:
          // the column had already been overwritten, so the outgoing entity's run could not see the ten
          // days it owed. The question a payroll run has to ask is not "who is in this company NOW" but
          // "who was in this company AT ANY POINT IN THIS PERIOD", and that is exactly the OR below.
          //
          //   • the column — everyone currently here, which is everyone who was here all month, plus
          //     anyone who transferred IN mid-month. Unchanged, and on its own it is the entire answer
          //     for every employment that never moved;
          //   • the dated history — anyone whose `assignment` spine says they belonged to this company
          //     over some part of the period, which picks up whoever transferred OUT.
          //
          // BOTH RUNS THEN SEGMENT. The employee appears on the outgoing entity's run for 1–10 and the
          // incoming entity's run for 11–end (see segmentByEmp below), so nobody is paid twice and nobody
          // is paid for days their employer did not employ them.
          //
          // ⚠️ RLS STILL FENCES IT, and the limitation is real rather than theoretical: `employment_rls`
          // uses `app.can_see_employment(id)`, which resolves through TODAY's `employment.company_id`. An
          // operator scoped to the OUTGOING company only cannot see a transferred-out employment at all,
          // so this widening returns nothing for them. It works for a group-wide operator and for one who
          // administers both entities — which is who performs a transfer. Widening the RLS predicate to
          // the dated history is a separate, security-shaped decision and is deliberately NOT taken here.
          //
          // ⚠️ Pre-backfill this OR is inert: `assignment.company_id` is NULL on every legacy row, so the
          // EXISTS matches nothing and the predicate collapses to the column test it replaced.
          employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          // fbcf706d — the batch scope narrows a FULL generation only. On a subset every posted id has
          // already been classified above as EXISTING (a payslip on this run, so it was in scope when that
          // payslip was written) or ADDED (an explicit, deliberate widening of a chosen-list run — see the
          // scope widening in the subset write block). AND-ing the scope filter on top of that classified
          // set could only delete a row the classification has already authorised, which is precisely the
          // silent no-op this item exists to remove: on a scoped run an addition computed nothing at all.
          subset ? undefined : scopeFilter,
          // Selective reprocess (9bc442bc): narrow the recompute to exactly the picked employees, intersected
          // with the company set above so a stale/cross-company id can never widen the run.
          subset
            ? inArray(
                employment.id,
                subset.employmentIds.length ? subset.employmentIds : ['00000000-0000-0000-0000-000000000000'],
              )
            : undefined,
        ),
      );

    // ── 3c88d593 — THE ENTITY SEGMENT: how much of this period does THIS employer actually own? ──────
    //
    // For everybody who did not move, the answer is "all of it" and nothing below fires. For an employee
    // who transferred mid-month it is the part of the month their entity history says belonged to this
    // company — 1–10 August on the outgoing run, 11–31 on the incoming one — and that narrowed window is
    // then fed to the SAME proration primitives that already handle a mid-month joiner or leaver. A
    // transfer is, to the arithmetic, a leaver on one run and a joiner on the other; the primitives have
    // been right about that shape for years, they were simply never told the entity had changed.
    //
    // THE MAP IS DELIBERATELY SPARSE. An entry is written ONLY when the month is genuinely split, so an
    // employment with a single covering segment reaches the proration call with `undefined` and takes the
    // identical code path it took before this item — no clamping, no rounding, no re-derivation. That is
    // the byte-identical guarantee for the ~100% of payslips this item must not touch, and it is enforced
    // by construction rather than by comparison.
    //
    // WHAT IT DOES *NOT* DO: it does not decide the statutory treatment. Two segments in one month are two
    // INDEPENDENT statutory computations — each employer reports its own EPF/SOCSO/EIS/PCB on its own
    // portion, each ceiling applying to that employer separately — and that falls out of the architecture
    // rather than being coded here: a payroll batch belongs to exactly one company, so the two segments
    // are computed by two different runs, each loading its own company's ruleset, employer registration,
    // HRDF band and policy, and each seeing only its own wage portion. There is no halving anywhere, and
    // there is no way for one company's ceiling to be consumed by the other's wages.
    const currentCompanyById = new Map(emps.map((e) => [e.employmentId, e.currentCompanyId]));
    const segmentsByEmp = await companySegmentsForPeriodBulk(
      tx,
      emps.map((e) => e.employmentId),
      periodStart,
      periodEnd,
      currentCompanyById,
    );
    /** employmentId → the sub-window of [periodStart, periodEnd] this employer owns. Absent = the whole period. */
    const segmentByEmp = new Map<string, { from: string; to: string }>();
    for (const e of emps) {
      const segs = segmentsByEmp.get(e.employmentId) ?? [];
      if (segs.length <= 1) continue; // never moved this month ⇒ no entry ⇒ untouched code path
      const mine = segmentForCompany(segs, batch.companyId);
      // Selected by the widened predicate above but owning no part of the period under THIS company —
      // only reachable if the history changed between the two statements. Skip rather than pay a month
      // the entity did not own.
      if (!mine) continue;
      if (mine.from <= periodStart && mine.to >= periodEnd) continue; // owns the whole month anyway
      segmentByEmp.set(e.employmentId, { from: mine.from, to: mine.to });
    }
    /** The first day of the period this employer pays for: the later of the hire date and the segment start. */
    const segHiredOn = (e: { employmentId: string; hiredOn: string }): string => {
      const seg = segmentByEmp.get(e.employmentId);
      return seg && seg.from > e.hiredOn ? seg.from : e.hiredOn;
    };
    /**
     * The last day of the period this employer pays for, in the shape the proration primitives expect
     * (`terminatedOn`: a last paid day, or null for "not ended"). A segment that runs to the period end
     * yields the stored termination date unchanged — including null — so a full-month employee is passed
     * exactly what they were passed before.
     */
    const segTerminatedOn = (e: { employmentId: string; terminatedOn: string | null }): string | null => {
      const seg = segmentByEmp.get(e.employmentId);
      if (!seg || seg.to >= periodEnd) return e.terminatedOn;
      return e.terminatedOn && e.terminatedOn < seg.to ? e.terminatedOn : seg.to;
    };

    // Per-employee inputs: manual overtime (entered on the draft batch) + auto-derived unpaid days.
    const dim = daysInMonth(pYear, pMonth);
    const inputRows = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        // Item 3fa088fb — the PROVENANCE of that figure, read so the kernel can tell an operator's keyed
        // override from a figure the Prefill button derived. 'tp1_self' ⇒ derived (the kernel re-derives it
        // itself now, so the stored copy is only a draft-screen convenience); anything else with a non-zero
        // amount is a hand-keyed instruction about THIS run and wins. §0.4, the same test the prefill uses.
        tp1Source: payrollInput.tp1Source,
        zakat: payrollInput.zakat,
        claimAllowance: payrollInput.claimAllowance,
        loanDeduction: payrollInput.loanDeduction,
        // Fix-5 (M#17): OT provenance, snapshotted onto each payslip below so an auditor can see whether the
        // overtime figure was attendance-derived (statutory engine) or hand-keyed by the admin.
        otSource: payrollInput.otSource,
        // 2.1.1 (ADR-0064 1e): the OT rate-bucket decomposition — read here so the policy OT-cap wrapper can
        // filter by eligible day type / re-rate the workday leg. NULL ⇒ a flat figure (caps degrade to the
        // total-only ceilings: maxAmount). Nothing else downstream reads it.
        otBreakdown: payrollInput.otBreakdown,
        // a96d320c (migration 0479) — the statutory engine's own decomposition of the OT figure. Read
        // here and copied onto the payslip below, under a total-equality gate; nothing in the run's
        // arithmetic touches it.
        otDerivation: payrollInput.otDerivation,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, p.batchId));
    const overtimeByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.overtime)]));
    // Widened to string: f1564110 Phase 3 stamps 'individual-txn' provenance when one-off OT rows feed the
    // figure (the payslip snapshot is plain jsonb, so the wider type is safe end-to-end).
    const otSourceByEmp = new Map<string, string | null>(inputRows.map((r) => [r.employmentId, r.otSource ?? null]));
    const otBreakdownByEmp = new Map(inputRows.map((r) => [r.employmentId, r.otBreakdown ?? null]));
    const otDerivationByEmp = new Map(inputRows.map((r) => [r.employmentId, r.otDerivation ?? null]));
    const bonusByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1ByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.tp1)]));
    const tp1SourceByEmp = new Map<string, string | null>(inputRows.map((r) => [r.employmentId, r.tp1Source ?? null]));
    const zakatByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.zakat)]));
    // Approved taxable claims prefilled into this batch (ADR-0021): ride the taxable allowance base.
    const claimAllowanceByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.claimAllowance)]));
    // 1.2.8 Loan instalment(s) reserved on this batch (ADR-0060): POST-TAX, read unconditionally, subtracted
    // after statutory like tp1/zakat. The ledger is advanced by applyLoansForBatch AFTER the payslip loop.
    const loanByEmp = new Map(inputRows.map((r) => [r.employmentId, Number(r.loanDeduction)]));
    // ── 2961a7ae — the manual statutory overrides keyed against this run ────────────────────────────
    // Read like any other INPUT, alongside payroll_input above, because that is what it is: the operator's
    // declaration of what a statutory line must FINALLY be. Applied to the computed `st` in the payslip
    // loop below (applyStatutoryAdjustment), before total_deductions / net_pay / employer_cost are
    // composed, so every downstream figure, report and statutory form reads the final number. An empty
    // map ⇒ every payslip is byte-identical to the pre-2961a7ae kernel.
    const statutoryAdjustmentRows = await tx
      .select()
      .from(payrollStatutoryAdjustment)
      .where(eq(payrollStatutoryAdjustment.batchId, p.batchId));
    const statutoryAdjustmentByEmp = new Map(
      statutoryAdjustmentRows.map((r) => [
        r.employmentId,
        { values: valuesOfAdjustmentRow(r as unknown as Record<string, unknown>), reason: r.reason },
      ]),
    );
    // 1.2.8 C1 fix: the ACTUAL loan recovered per employee after the authoritative net≥0 clamp (cents). The
    // payslip loop fills this; applyLoansForBatch advances the ledger by these actuals (NOT the reserved due).
    const appliedLoanCentsByEmp = new Map<string, number>();
    // M#16 (EA s.24 net-floor): per-employee record of any post-tax deduction the period's headroom could
    // not fully recover (manual deduct / CP38 / loan clamped). Surfaced as a batch-level warning event so a
    // clamp is never silent. Empty ⇒ no event (byte-identical no-clamp path).
    const deductionClampsByEmp = new Map<
      string,
      {
        manualRequested: number; manualApplied: number;
        cp38Requested: number; cp38Applied: number;
        loanRequested: number; loanApplied: number;
        // 3a092cf0 — optional so every existing reader and every existing test row is unchanged; a
        // clamped zakat is new and only the paths that set it carry it.
        zakatRequested?: number; zakatApplied?: number;
      }
    >();
    // c7fdfcf6 (Payroll Schedule) — the company-level cut-off schedule (company_payroll_config day columns +
    // the company-default policy's config). Loaded ONCE; each transaction type's window resolves against it,
    // falling back to the plain calendar month when nothing is configured (byte-identical). Per-employment
    // policy overrides for the SALARY window are applied in the loop below (the policy is resolved there).
    const cutOffSchedule = await loadBatchCutOffSchedule(tx, batch.companyId);
    // c7fdfcf6 gap-fix — the run READS the company-default schedule's payroll FREQUENCY and GENERATES the
    // ordered cut-off periods it produces for this statutory month (monthly ⇒ one period; weekly/biweekly ⇒ the
    // tiled 7/14-day cycles). Recorded on the processed event for audit + surfaced to operators; the wages still
    // aggregate into the one calendar month for EPF/SOCSO/EIS/PCB by law.
    const runFrequency = payrollFrequencyOf(cutOffSchedule.defaultConfig);
    const runSchedule = payrollScheduleFor(cutOffSchedule.defaultConfig, cutOffSchedule.companyCfg, payPeriod);
    // Unpaid-leave selection follows the LEAVE cut-off window. Gap-fix (per-employment cut-off): the leave window
    // is resolved PER employment (its assigned policy → company column → calendar), then employments are GROUPED
    // by window and unpaid days are queried per group — so employments on different (non-default) policies each
    // get their own leave window instead of sharing the company default. Populated in the policy loop below, then
    // queried after it. Absent/calendar config ⇒ one group == [M-01 … M-end] (byte-identical to the legacy query).
    const leaveWindowByEmp = new Map<string, { start: string; end: string }>();
    const unpaidByEmp = new Map<string, number>();
    // f3148da1 Step 5 (R17 gap-fix reinstatement) — the PARTIAL-DAY (time-off) subset of unpaidByEmp, populated
    // ONLY for employments whose policy configures a distinct unpaidTimeOffDivisor (see the group query below).
    const unpaidTimeOffByEmp = new Map<string, number>();
    // e2632276 — ABSENCE days, populated ONLY for employments whose assigned PAYROLL POLICY sets
    // `leave.deductAbsentDays` (see the group query below). Empty for every other employment ⇒ absentAmount
    // is 0 ⇒ the payslip is byte-identical to a pre-flag run. It is a POLICY setting, not a company one:
    // resolveAssignedPolicy answers it per employment, so two employees of one company can differ.
    const absentByEmp = new Map<string, number>();

    // ── 2.1.1 (ADR-0064) — Monthly payroll-policy General Settings, resolved at RUN TIME ──
    // The load-bearing new plumbing: for each employment, resolve its assigned policy's config (raw
    // tenant-scoped SQL inside this Tx, under the caller's session). A null/inactive/unassigned policy ⇒
    // null config ⇒ the legacy code path is unchanged (the default-equals-legacy golden matrix proves it).
    // This is a DERIVED READ on every compute — it appends NO DomainEvent (substrate "no event for derived
    // recomputation" rule). Resolved ONCE here, before the loop, so each primitive reads a map not a re-query.
    const policyConfigByEmp = new Map<string, PayrollPolicyConfig | null>();
    // Working-day proration needs the holiday set per employment; resolve it lazily only when a config asks
    // for a working-day basis, so the default (calendar) path issues NO extra query.
    const prorationOptsByEmp = new Map<
      string,
      { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> }; window?: { start: string; end: string } }
    >();
    // c7fdfcf6 (Payroll Schedule) — per-employment SALARY cut-off window day count, feeding the `cutoff_days`
    // leave-divisor fact (activating the already-shipped 'cutoff_days' divisor selector). Absent config ⇒ `dim`.
    const salaryCutoffDaysByEmp = new Map<string, number>();
    // ── 2.1.2 — Daily payroll policy: rate × eligible days worked, NO monthly proration ──
    // For an employment on an ACTIVE policyType='daily' policy carrying a per_day PayRule, basic pay is the
    // per-day rate × the number of eligible working days in the period (Mon–Fri roster minus holidays, clamped
    // to the employment's tenure window) — the monthly-salary proration path is BYPASSED entirely. A null /
    // inactive / monthly / unassigned policy never populates this map, so the legacy monthly path is unchanged
    // (proven byte-identical). Resolved ONCE here so the per-employee loop reads a map, not a re-query.
    const dailyPayByEmp = new Map<string, { rate: number; eligibleDays: number; basic: number }>();
    for (const e of emps) {
      const policy = await resolveAssignedPolicy(tx, e.employmentId);
      const cfg = policy?.config ?? null;
      policyConfigByEmp.set(e.employmentId, cfg);
      // 1b / Step 3 (f3148da1) — proration divisor + working-day basis, resolved once per employee. The formula
      // is PER-EVENT: a resigned partial month uses the "Resigned Employee Basic Salary Formula", a new-hire
      // partial month uses the "New Hire Basic Salary Formula", each falling back to the shared proration. A
      // full month (neither) uses the shared default (inert — the factor is 1 regardless).
      const isHire = e.hiredOn > periodStart;
      const isResign = !!(e.terminatedOn && e.terminatedOn < periodEnd);
      const prorationSettings = resolveProrationSettings(cfg, { isHire, isResign });
      const divisorDays = prorationDivisorDays(prorationSettings, dim);
      const opts: { divisorDays?: number; workingDayBasis?: { roster: number[]; holidays: Set<string> }; window?: { start: string; end: string } } = {};
      if (divisorDays !== dim) opts.divisorDays = divisorDays;
      if (usesWorkingDayProration(prorationSettings)) {
        const holidays = (prorationSettings?.includeHoliday ?? false)
          ? new Set<string>() //              holidays count as worked days ⇒ empty exclusion set
          : await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        opts.workingDayBasis = { roster: workingDayRoster(prorationSettings), holidays };
      }
      // c7fdfcf6 (Payroll Schedule) — the SALARY cut-off window for this employment (policy override → company
      // column → calendar). When it is a real (non-calendar) window, drive the join-date/resignation proration
      // by it and record its length for the cutoff_days leave divisor; a calendar/absent config leaves both at
      // the legacy calendar-month behaviour (byte-identical).
      const salaryWindow = cutOffWindowFor('salary', cfg, cutOffSchedule.companyCfg, payPeriod);
      const salaryWindowDays =
        Math.round((Date.parse(`${salaryWindow.end}T00:00:00Z`) - Date.parse(`${salaryWindow.start}T00:00:00Z`)) / 86_400_000) + 1;
      if (salaryWindow.start !== periodStart || salaryWindow.end !== periodEnd) {
        opts.window = salaryWindow;
        salaryCutoffDaysByEmp.set(e.employmentId, salaryWindowDays);
      }
      if (opts.divisorDays !== undefined || opts.workingDayBasis || opts.window) prorationOptsByEmp.set(e.employmentId, opts);
      // Gap-fix (per-employment cut-off) — this employment's LEAVE cut-off window (policy → company → calendar).
      //
      // ── 3c88d593 — AND IT IS CLIPPED TO THIS EMPLOYER'S ENTITY SEGMENT ────────────────────────────
      // This one line is what stops a transferred month DOUBLE-DEDUCTING unpaid leave and absence. Both
      // counts are queried through this window (see the group query below), and both are valued at a
      // daily rate off the FULL monthly basic — not off the prorated figure. So without the clip, a day
      // of unpaid leave on 5 August would be charged in full by the outgoing entity AND in full by the
      // incoming one, and the employee would lose two days' pay for one day of leave. It has to happen
      // here, on the window, rather than on the counts: the window is the single place both queries and
      // the time-off subset agree on which days belong to this run.
      //
      // Unsegmented ⇒ the window is untouched ⇒ byte-identical.
      const leaveWindow = cutOffWindowFor('leave', cfg, cutOffSchedule.companyCfg, payPeriod);
      const entitySeg = segmentByEmp.get(e.employmentId);
      leaveWindowByEmp.set(
        e.employmentId,
        entitySeg
          ? {
              start: leaveWindow.start > entitySeg.from ? leaveWindow.start : entitySeg.from,
              end: leaveWindow.end < entitySeg.to ? leaveWindow.end : entitySeg.to,
            }
          : leaveWindow,
      );
      // 2.1.2 daily branch — ADR-0078: keyed off the EMPLOYEE'S pay_mode (compensation.pay_mode), with the
      // rate from compensation.rate_amount. The former policy.payRule source (and its fallback) is gone —
      // it could never express one daily employee among monthly colleagues on the same policy (resolveRule
      // accepts a per_day rule only on a daily policy). Eligible days = the employee's working days
      // (Mon–Fri) in the period, less public holidays, within their tenure window. Zero eligible days ⇒
      // basic = 0 (no divide-by-zero: this is a multiply, not a divide).
      if (e.payMode === 'daily' && e.rateAmount != null) {
        const rate = Number(e.rateAmount);
        const dailyHolidays = await holidayDatesFor(tx, { employmentId: e.employmentId, startDate: periodStart, endDate: periodEnd });
        // 3c88d593 — clamped to this employer's entity segment, so a daily-rated employee who transferred
        // on the 11th is paid by the outgoing entity for the working days up to the 10th and by the
        // incoming one for the rest. Unsegmented ⇒ the stored dates ⇒ the identical count as before.
        const eligibleDays = eligibleWorkingDays(payPeriod, segHiredOn(e), segTerminatedOn(e), dailyHolidays);
        dailyPayByEmp.set(e.employmentId, { rate, eligibleDays, basic: round2(rate * eligibleDays) });
      }
    }

    // Gap-fix (per-employment cut-off) — GROUP employments by their resolved LEAVE cut-off window, then query
    // unpaid days once per distinct window. Most companies: a single group == the calendar month, so this is one
    // query with the same result as the legacy tenant-wide call (byte-identical). A company with per-policy leave
    // cut-offs gets each group its own window.
    {
      const groups = new Map<string, string[]>();
      for (const e of emps) {
        const w = leaveWindowByEmp.get(e.employmentId) ?? { start: periodStart, end: periodEnd };
        const key = `${w.start}|${w.end}`;
        const arr = groups.get(key);
        if (arr) arr.push(e.employmentId);
        else groups.set(key, [e.employmentId]);
      }
      for (const [key, ids] of groups) {
        const [start, end] = key.split('|');
        const part = await unpaidDaysByEmployment(tx, start, end, ids);
        for (const [k, v] of part) unpaidByEmp.set(k, v);
      }
      // f3148da1 Step 5 (R17 gap-fix reinstatement) — UNPAID TIME OFF: for employments whose policy configures
      // a DISTINCT unpaidTimeOffDivisor, also count the PARTIAL-DAY unpaid subset (half-day / hourly requests)
      // per the same leave windows. The payslip loop values these days with the time-off formula and the
      // remaining full-day unpaid days with unpaidLeaveDivisor. No distinct divisor anywhere (the default) ⇒
      // this issues NO query and every unpaid day rides the legacy pooled path, byte-identical.
      const utoIds = new Set(
        emps
          .filter((e) => policyConfigByEmp.get(e.employmentId)?.leave?.unpaidTimeOffDivisor)
          .map((e) => e.employmentId),
      );
      if (utoIds.size > 0) {
        for (const [key, ids] of groups) {
          const scoped = ids.filter((id) => utoIds.has(id));
          if (scoped.length === 0) continue;
          const [start, end] = key.split('|');
          const part = await unpaidDaysByEmployment(tx, start, end, scoped, true);
          for (const [k, v] of part) unpaidTimeOffByEmp.set(k, v);
        }
      }
      // e2632276 — ABSENCE days, resolved through the SAME per-employment LEAVE cut-off windows as the
      // unpaid-leave days above, so the two counts can never disagree about which month a day belongs to
      // (they are added at the same daily rate, and a day counted in two different months would be paid
      // for twice). Queried ONLY for employments whose policy switches the deduction on: with the setting
      // off everywhere — which is how it ships, for all nine companies — this issues NO query at all.
      const absIds = new Set(
        emps
          .filter((e) => policyConfigByEmp.get(e.employmentId)?.leave?.deductAbsentDays === true)
          .map((e) => e.employmentId),
      );
      if (absIds.size > 0) {
        for (const [key, ids] of groups) {
          const scoped = ids.filter((id) => absIds.has(id));
          if (scoped.length === 0) continue;
          const [start, end] = key.split('|');
          const part = await absentDaysByEmployment(tx, start, end, scoped);
          for (const [k, v] of part) absentByEmp.set(k, v);
        }
      }
    }

    // c7fdfcf6 gap-fix (functional weekly/bi-weekly) — when the run's frequency is weekly/biweekly the statutory
    // month is split into the ordered cut-off CYCLES (runSchedule.periods). We bucket, PER cycle, each employee's
    // OT minutes (from attendance) and unpaid-leave days (from approved leave) by their transaction dates. The
    // payslip loop then disburses each employee's NET across the cycles proportional to each cycle's operational
    // earnings — turning a weekly employment into N distinct per-cycle pay amounts the employer can actually pay
    // out weekly, instead of one byte-identical monthly figure. Statutory contributions stay computed ONCE on the
    // calendar month by law; the single monthly payslip stays the compliance artifact + carries the cycle
    // breakdown. Monthly frequency (periods.length === 1) skips this whole block ⇒ monthly is byte-identical.
    const perCycle = runFrequency !== 'monthly' && runSchedule.periods.length > 1;
    const cycleOtMinutesByEmp = new Map<string, number[]>();
    const cycleUnpaidDaysByEmp = new Map<string, number[]>();
    if (perCycle) {
      const wStart = runSchedule.periods[0].start;
      const wEnd = runSchedule.periods[runSchedule.periods.length - 1].end;
      const cycleIndexOf = (date: string): number => runSchedule.periods.findIndex((pd) => date >= pd.start && date <= pd.end);
      // EXCLUDE_TOIL_BANKED_DAYS, same as the OT prefill. These are the two reads of
      // `attendance.otMinutes` in this file and they must agree about which days count: a day banked as
      // TOIL contributes no OT to the payslip, so letting it weight the cross-cycle disbursement pulled
      // the employee's net toward a cycle on the strength of minutes that were never paid as cash. It
      // only ever bit weekly/bi-weekly runs, which is why one read carried the clause and the other did
      // not — monthly skips this block entirely.
      // ── 1b0943d5, SITE 3 OF 5 — DATED, AND CLIPPED PER DAY. ────────────────────────────────────
      // The comment directly above promises that the two reads of `attendance.otMinutes` in this file
      // "must agree about which days count". Stage one moved the OTHER one onto the dated entity test and
      // left this one on the column, so the promise was true about TOIL and false about the employer. On
      // a weekly run for a transferred employee that means the disbursement weighting is computed from
      // hours the run never pays — pulling somebody's net toward a cycle on the strength of overtime
      // worked for a different company. Widened and clipped exactly like the OT prefill. Monthly runs skip
      // this whole block, and an unsegmented employment takes the identical path either way.
      const otCycleRows = await tx
        .select({ employmentId: attendance.employmentId, d: attendance.attendanceDate, m: attendance.otMinutes })
        .from(attendance)
        .innerJoin(employment, eq(employment.id, attendance.employmentId))
        .where(and(employedByCompanyDuring(batch.companyId, wStart, wEnd), gte(attendance.attendanceDate, wStart), lte(attendance.attendanceDate, wEnd), gt(attendance.otMinutes, 0), EXCLUDE_TOIL_BANKED_DAYS));
      // Resolved over the CYCLE window, which can reach outside [periodStart, periodEnd] when a cut-off
      // shifts it — so `segmentByEmp` (clamped to the period) cannot answer for those days and is not used.
      const cycleEmpIds = [...new Set(otCycleRows.map((r) => r.employmentId))];
      const cycleCurrentCompany = new Map(
        cycleEmpIds.length
          ? (
              await tx
                .select({ id: employment.id, companyId: employment.companyId })
                .from(employment)
                .where(inArray(employment.id, cycleEmpIds))
            ).map((r) => [r.id, r.companyId] as const)
          : [],
      );
      const cycleSegByEmp = await companySegmentsForPeriodBulk(tx, cycleEmpIds, wStart, wEnd, cycleCurrentCompany);
      /** Did THIS company employ this person on this date? Unsegmented ⇒ always yes ⇒ unchanged behaviour. */
      const cycleOwnsDay = (employmentId: string, date: string): boolean => {
        const segs = cycleSegByEmp.get(employmentId);
        if (!segs || segs.length <= 1) return true;
        return segs.some((s) => s.companyId === batch.companyId && date >= s.from && date <= s.to);
      };
      for (const r of otCycleRows) {
        if (!cycleOwnsDay(r.employmentId, r.d)) continue;
        const ci = cycleIndexOf(r.d);
        if (ci < 0) continue;
        const arr = cycleOtMinutesByEmp.get(r.employmentId) ?? runSchedule.periods.map(() => 0);
        arr[ci] += r.m ?? 0;
        cycleOtMinutesByEmp.set(r.employmentId, arr);
      }
      // Unpaid days are attributed to the cycle the request STARTS in (mirrors unpaidDaysByEmployment's "deduct in
      // the period it starts" policy), using the approved per-date sum when present, else the request's own days.
      const perDateDays = sql<string>`coalesce((select sum(lrd.days) from leave_request_date lrd where lrd.leave_request_id = ${leaveRequest.id} and lrd.status = 'approved'), ${leaveRequest.days})`;
      const lvCycleRows = await tx
        .select({ employmentId: leaveRequest.employmentId, d: leaveRequest.startDate, days: perDateDays })
        .from(leaveRequest)
        .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
        .where(and(eq(leaveRequest.status, 'approved'), or(eq(leaveType.paid, false), eq(leaveRequest.allowanceEligible, false)), gte(leaveRequest.startDate, wStart), lte(leaveRequest.startDate, wEnd)));
      for (const r of lvCycleRows) {
        const ci = cycleIndexOf(r.d);
        if (ci < 0) continue;
        const arr = cycleUnpaidDaysByEmp.get(r.employmentId) ?? runSchedule.periods.map(() => 0);
        arr[ci] += Number(r.days);
        cycleUnpaidDaysByEmp.set(r.employmentId, arr);
      }
    }

    // 1f — working-days-in-period per employment, computed ONLY for employments whose leave config selects a
    // `working_days` divisor (so the default calendar path issues no extra query). Counts the employee's
    // working-day roster minus holidays across the whole period.
    const workingDaysByEmp = new Map<string, number>();
    const wdEmpIds = emps
      .filter((e) => {
        const l = policyConfigByEmp.get(e.employmentId)?.leave;
        return l?.unpaidLeaveDivisor === 'working_days' || l?.unpaidTimeOffDivisor === 'working_days' || l?.encashmentDivisor === 'working_days';
      })
      .map((e) => e.employmentId);
    for (const employmentId of wdEmpIds) {
      const holidays = await holidayDatesFor(tx, { employmentId, startDate: periodStart, endDate: periodEnd });
      const roster = [1, 2, 3, 4, 5]; // Mon–Fri working-day basis for the leave divisor (no Sat/Sun override here)
      let n = 0;
      for (let t = Date.parse(`${periodStart}T00:00:00Z`); t <= Date.parse(`${periodEnd}T00:00:00Z`); t += 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
        if (roster.includes(iso) && !holidays.has(d)) n++;
      }
      workingDaysByEmp.set(employmentId, n);
    }
    const workingDaysInPeriodFor = (employmentId: string): number => workingDaysByEmp.get(employmentId) ?? 0;

    // Step 4 (f3148da1) — OT exceed handling: resolve the "convert excess to pay item" component for every
    // employment whose policy configures `overtime.exceedHandling.action='convert'`. Loaded ONCE here (a
    // component is tenant-scoped, so RLS confines it to this tenant); a missing/archived component falls back
    // to today's cap-and-drop (the map simply has no entry ⇒ excess dropped). Default (no such policy) ⇒ the
    // map is empty and the legacy OT path is byte-identical.
    const otConvertByEmp = new Map<string, { code: string; name: string }>();
    const convertComponentIds = [
      ...new Set(
        emps
          .map((e) => policyConfigByEmp.get(e.employmentId)?.overtime?.exceedHandling)
          .filter((eh): eh is { action: 'convert'; componentId: string } => eh?.action === 'convert')
          .map((eh) => eh.componentId),
      ),
    ];
    if (convertComponentIds.length) {
      const comps = await tx
        .select({ id: payComponent.id, code: payComponent.code, name: payComponent.name, archivedAt: payComponent.archivedAt })
        .from(payComponent)
        .where(inArray(payComponent.id, convertComponentIds));
      const byId = new Map(comps.filter((c) => c.archivedAt == null).map((c) => [c.id, { code: c.code, name: c.name }]));
      for (const e of emps) {
        const eh = policyConfigByEmp.get(e.employmentId)?.overtime?.exceedHandling;
        if (eh?.action === 'convert') {
          const found = byId.get(eh.componentId);
          if (found) otConvertByEmp.set(e.employmentId, found);
        }
      }
    }

    // Step 2 carry_forward (f3148da1) — the outstanding negative-net balance carried from PRIOR CLOSED cycles,
    // DERIVED (no mutable balance table, mirroring the PCB accumulator replay) by summing each employment's
    // closed payslips' carry-forward stamps: balance = Σ(added − applied), positive = the employee still owes.
    // Computed ONLY for employments whose policy sets negativeNet='carry_forward' and ONLY on a regular run (an
    // additional/off-cycle run neither recovers nor defers). A rolled-back batch (status ≠ 'closed') drops out
    // automatically, so the balance always reflects finalized history. Default (no carry_forward policy) ⇒ the
    // map is empty and the legacy net path is byte-identical.
    const carryForwardByEmp = new Map<string, number>();
    if (batch.runType === 'regular') {
      const cfEmpIds = emps
        .filter((e) => policyConfigByEmp.get(e.employmentId)?.negativeNet === 'carry_forward')
        .map((e) => e.employmentId);
      if (cfEmpIds.length) {
        const cfRows = await tx
          .select({ employmentId: payslip.employmentId, statutory: payslip.statutory })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, cfEmpIds),
              eq(payrollBatch.status, 'closed'),
              lt(payrollBatch.payPeriod, payPeriod),
            ),
          );
        for (const r of cfRows) {
          const cf = (r.statutory as { carryForward?: { applied?: number; added?: number } } | null)?.carryForward;
          if (!cf) continue;
          const delta = round2(Number(cf.added ?? 0) - Number(cf.applied ?? 0));
          carryForwardByEmp.set(r.employmentId, round2((carryForwardByEmp.get(r.employmentId) ?? 0) + delta));
        }
      }
    }

    // 1c — salary-increment proration: the two straddling compensation rows (superseded old + open new) for
    // any employment whose policy enables it AND that has a mid-period increment. Resolved once; the loop
    // reads a per-employee blended basic. Default (off / single row) ⇒ the kernel's single open-row read is
    // untouched. Only fires when the new comp row exists at generate time (snapshot immutability, ADR-0036).
    const incrementBasicByEmp = new Map<string, number>();
    const incrementEmpIds = emps
      .filter((e) => policyConfigByEmp.get(e.employmentId)?.salaryIncrementProration)
      .map((e) => e.employmentId);
    if (incrementEmpIds.length) {
      const straddleRows = await tx
        .select({
          employmentId: compensation.employmentId,
          basic: compensation.basicSalary,
          validFrom: compensation.validFrom,
          validTo: compensation.validTo,
        })
        .from(compensation)
        .where(
          and(
            inArray(compensation.employmentId, incrementEmpIds),
            isNull(compensation.supersededAt),
            lte(compensation.validFrom, periodEnd),
            or(isNull(compensation.validTo), gte(compensation.validTo, periodStart)),
          ),
        );
      const byEmp = new Map<string, { basic: number; validFrom: string; validTo: string | null }[]>();
      for (const r of straddleRows) {
        const list = byEmp.get(r.employmentId) ?? [];
        list.push({ basic: Number(r.basic), validFrom: r.validFrom, validTo: r.validTo });
        byEmp.set(r.employmentId, list);
      }
      for (const [employmentId, rows] of byEmp) {
        if (rows.length < 2) continue; // no straddle ⇒ leave the kernel's single-row read alone
        rows.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
        const oldRow = rows[0];
        const newRow = rows[rows.length - 1];
        // The increment takes effect at the new row's validFrom. Blend: old × days-before + new × days-from.
        const incrementDate = newRow.validFrom;
        if (incrementDate <= periodStart || incrementDate > periodEnd) continue; // not a mid-period increment
        const daysBefore = Math.max(0, Number(incrementDate.slice(8, 10)) - 1); // days on the OLD rate
        const daysFrom = dim - daysBefore; //                                      days on the NEW rate
        const blended = round2((oldRow.basic * daysBefore + newRow.basic * daysFrom) / dim);
        incrementBasicByEmp.set(employmentId, blended);
      }
    }

    // ── PCB accumulators (ADR-0014) ──
    // The accumulators (∑(Y−K), K claimed, X) are DERIVED by replaying this tax year's prior
    // payslips per employment, in period order, applying the cumulative EPF relief cap — the
    // payslip history is the ledger; no mutable accumulator state. TP3 / opening balances on the
    // statutory profile seed the replay for mid-year joiners or mid-year system adoption.
    const EPF_RELIEF_CAP = pack.payroll.epfReliefCap; // pack-owned: cap math always matches the calculator
    type Acc = {
      netRemuneration: number;
      epfClaimed: number;
      pcbPaid: number;
      zakatPaid: number;
      lpAccumulated: number;
    };
    const empIds = emps.map((e) => e.employmentId);
    // 1.2.3 CP38 Deduction — the LHDN/court instalment in effect for THIS payroll month, per employment
    // (auto-apply by month). Folded into deductions + stamped onto statutory.cp38 below; an additional run
    // re-charges nothing (handled per-employee with isAdditionalRun, like slipUnpaid/hrdf).
    const cp38ByEmp = await cp38ForPeriod(tx, empIds, payPeriod);
    const priorSlips = empIds.length
      ? await tx
          .select({
            employmentId: payslip.employmentId,
            period: payrollBatch.payPeriod,
            gross: payslip.grossPay,
            statutory: payslip.statutory,
          })
          .from(payslip)
          .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
          .where(
            and(
              inArray(payslip.employmentId, empIds),
              like(payrollBatch.payPeriod, `${pYear}-%`),
              lt(payrollBatch.payPeriod, payPeriod),
            ),
          )
      : [];
    priorSlips.sort((a, b) => a.period.localeCompare(b.period));
    const accByEmp = new Map<string, Acc>();
    for (const e of emps) {
      const tp3Applies = e.tp3Year === pYear;
      accByEmp.set(e.employmentId, {
        netRemuneration: tp3Applies ? Number(e.tp3Net ?? 0) : 0,
        epfClaimed: tp3Applies ? Math.min(Number(e.tp3Epf ?? 0), EPF_RELIEF_CAP) : 0,
        pcbPaid: tp3Applies ? Number(e.tp3Pcb ?? 0) : 0,
        zakatPaid: tp3Applies ? Number(e.tp3Zakat ?? 0) : 0,
        // ∑LP — item 20837372. This was a hard `0` until migration 0488, which is the whole defect: the
        // specification's printed page 22 names ∑LP as one of the FOUR variables a TP3 feeds ("(Y–K*),
        // X, Z and ∑LP") and printed page 11 defines it as "Accumulated allowable deductions in the
        // current year, INCLUDING FROM PREVIOUS EMPLOYMENT, if any". ∑LP is SUBTRACTED inside P, so a
        // zero here made P too high and over-deducted every new joiner who handed in a Section D.
        //
        // The prior-payslip replay below then ADDS this employer's own months on top, exactly as it does
        // for the other four: previous employment opens the balance, this employment accumulates onto it.
        lpAccumulated: tp3Applies ? Number(e.tp3Lp ?? 0) : 0,
      });
    }
    // LHDN PCB 2026 (feedback 09b554e9) — per-code YTD exemption usage, DERIVED like the PCB accumulators:
    // each slip stamps the month's per-code exempt/claimed amounts as statutory.exemptionUsed, and the
    // replay sums them so the annual caps carry across months (no mutable balance table).
    const exemptUsedByEmp = new Map<string, Record<string, number>>();
    /** Item 3fa088fb — ∑LP THIS employer has already fed this assessment year. TP3 opening EXCLUDED. */
    const lpFedByEmp = new Map<string, number>();
    for (const s of priorSlips) {
      const acc = accByEmp.get(s.employmentId);
      if (!acc) continue;
      const st = (s.statutory ?? {}) as { epfEmployee?: number; pcb?: number; lp?: number; zakat?: number; exemptionUsed?: Record<string, number> };
      const claimed = Math.min(Number(st.epfEmployee ?? 0), Math.max(0, EPF_RELIEF_CAP - acc.epfClaimed));
      acc.netRemuneration = round2(acc.netRemuneration + Number(s.gross) - claimed);
      acc.epfClaimed = round2(acc.epfClaimed + claimed);
      acc.pcbPaid = round2(acc.pcbPaid + Number(st.pcb ?? 0));
      acc.zakatPaid = round2(acc.zakatPaid + Number(st.zakat ?? 0)); // §E.5: full zakat accrues to Z
      acc.lpAccumulated = round2(acc.lpAccumulated + Number(st.lp ?? 0));
      // Item 3fa088fb — THE SAME MONEY, COUNTED SEPARATELY, AND THE SEPARATION IS THE POINT. `acc
      // .lpAccumulated` above opens with the TP3 Section D balance (a PREVIOUS employer's accumulated
      // deductions) and is what the PCB formula's ∑LP must be. The TP1 delta below must NOT see that
      // opening balance: it asks "how much of the annual this employee declared TO US is still unfed",
      // and a relief already claimed through a different employer has never been fed by us, so netting it
      // off would silently shrink the declaration they made to this employer. So this map replays OUR
      // payslips only. `resolveTp1Feed`'s header carries the full argument; a test pins the difference.
      lpFedByEmp.set(s.employmentId, round2((lpFedByEmp.get(s.employmentId) ?? 0) + Number(st.lp ?? 0)));
      if (st.exemptionUsed) {
        const used = exemptUsedByEmp.get(s.employmentId) ?? {};
        for (const [code, amt] of Object.entries(st.exemptionUsed)) {
          used[code] = round2((used[code] ?? 0) + Number(amt ?? 0));
        }
        exemptUsedByEmp.set(s.employmentId, used);
      }
    }

    // ── Multi-cycle (Wave 2C, ADR-0024) ──
    // For an ADDITIONAL run (run_type != regular), this run is additional remuneration computed by the
    // increment method (re-run the cumulative month, take the delta). Gather the additional remuneration
    // paid in earlier runs of this period + the month's overtime (carried by the regular run). The normal
    // wage (Y1) is recomputed per employee from compensation below — identical to the regular run's, so
    // the runs sum to the single-batch month by construction.
    const isAdditionalRun = batch.runType !== 'regular';
    /**
     * ADR-0085 step 5 (item 23e7dac3) — THE MONTH IS RESTATED WHEN THE REGULAR RUN LANDS LATE.
     *
     * Until now the earlier-runs read was gated on `isAdditionalRun`, which was the same test as
     * `runSeq > 1` because `createBatch` always wrote run_seq 1. Once a BONUS or off-cycle run may be
     * processed BEFORE the monthly one, the two part company, and the regular run has to see what the
     * month has already been charged — otherwise it recomputes the whole normal-wage month from scratch
     * beside an increment that was taken on a different base, and the month's PCB comes out UNDER the
     * one-batch figure (measured: RM5,000 salary + RM3,000 bonus + RM500 overtime pays RM60 instead of
     * RM100 when the bonus lands first). Gating on `runSeq > 1` is a no-op for every run that exists
     * today; it is what makes the late regular run restate rather than silently under-remit.
     */
    const restatesMonth = !isAdditionalRun && batch.runSeq > 1;
    const earlierRunByEmp = new Map<string, { additional: number; overtime: number }>();
    if (isAdditionalRun || restatesMonth) {
      const earlier = await tx
        .select({
          employmentId: payslip.employmentId,
          bonus: payslip.bonus,
          ot: payslip.overtimePay,
          runType: payrollBatch.runType,
        })
        .from(payslip)
        .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
        .where(and(eq(payrollBatch.payPeriodId, batch.payPeriodId), lt(payrollBatch.runSeq, batch.runSeq)));
      for (const r of earlier) {
        const cur = earlierRunByEmp.get(r.employmentId) ?? { additional: 0, overtime: 0 };
        cur.additional = round2(cur.additional + Number(r.bonus));
        if (r.runType === 'regular') cur.overtime = round2(cur.overtime + Number(r.ot));
        earlierRunByEmp.set(r.employmentId, cur);
      }
    }

    // ══ ITEM 3fa088fb — LP₁ FROM THE EMPLOYEE'S OWN APPROVED TP1, DERIVED HERE AND NOT WAITED FOR ═════
    //
    // THE DEFECT THIS REPLACES. `payroll_input.tp1_deduction` was written by exactly one thing —
    // `prefillTp1FromSelfRelief`, reachable only through a BUTTON on the draft batch screen — and nothing
    // called it at batch creation or at generate time. So an approved TP1 relief reached PCB only if an
    // operator remembered to press Prefill first, and measured on the reporter's production system on
    // 2026-09-25 nobody ever had: 8 approved declarations for 2026 (two for July at RM500.00), 88 payslips
    // issued, ZERO carrying a TP1 deduction. ∑LP and LP₁ are SUBTRACTED inside P, so every employee who
    // declared a relief had P too high, tax too high, and was over-deducted every single month.
    //
    // THE FIX IS THE SHAPE ZAKAT ALREADY HAD, and the contrast was sitting three lines from the bug: the
    // kernel auto-applies the fixed zakat election at generate time and only lets `payroll_input` OVERRIDE
    // it. TP1 now works identically — derived from the declaration, overridable by a keyed figure — so the
    // relief travels on its own and the Prefill button becomes what it should always have been: a way to
    // see the figure land on a draft before generating, not the only bridge that exists.
    //
    // ── WHY THE DERIVED LEG IS REGULAR-RUN ONLY, WHICH THE BUILD NOTE ASKED TO BE DECIDED ────────────
    // The expression this feeds (`lp`, below) zeroed `en.lpDeclared` on an additional run and did NOT zero
    // the TP1 component. Before this item that asymmetry was unreachable — an additional batch only ever
    // carried a TP1 figure if someone pressed Prefill on it, and the panel does not offer the button on a
    // non-regular run — but deriving automatically would have made it live and DOUBLE-CLAIMED the month:
    // a regular run and a bonus run for the same month would each have fed the same relief, and the
    // month's ∑LP replayed into every later month at twice the declared figure. Money in the wrong
    // direction. So the month's declared relief is charged on the REGULAR run only, exactly like
    // `en.lpDeclared`, cp38, hrdf and the zakat election — both legs of the automatic money now agree, and
    // a regular + bonus pair in one month applies the relief ONCE, in whichever ORDER they land (a late
    // regular run is `restatesMonth`, still `!isAdditionalRun`, and still carries it).
    //
    // A month that has ONLY an additional run therefore feeds nothing — and loses nothing: the delta is
    // `annual − ∑LP already fed`, so the next regular run's feed simply grows by what that month skipped.
    //
    // A KEYED figure still applies on any run, like a keyed zakat: an operator override is an instruction
    // about THAT payslip, and silently discarding a number somebody typed is worse than honouring it.
    const tp1TargetByEmp = new Map<string, string>(); // employmentId → personId, for targets only
    const tp1FeedByEmp = new Map<string, Tp1Feed>();
    if (!isAdditionalRun && empIds.length) {
      // §0.5 routing, off the batch's WHOLE active set rather than `emps` — which this run may already
      // have narrowed for a selective reprocess. See `tp1TargetEmploymentByPerson` for why that matters:
      // routed off a narrowed list, a reprocess of one non-paymaster employment would relieve the wrong
      // job. One shared function with the prefill, so the two cannot send the same ringgit to two places.
      const targetByPerson = await tp1TargetEmploymentByPerson(tx, {
        companyId: batch.companyId,
        periodStart,
        periodEnd,
      });
      const inRun = new Set(empIds);
      for (const [personId, employmentId] of targetByPerson) {
        if (inRun.has(employmentId)) tp1TargetByEmp.set(employmentId, personId);
      }
      // §0.6: the assessment year is the PAY PERIOD's year.
      const rowsByPerson = await tp1ApprovedRowsByPerson(tx, {
        personIds: [...new Set(tp1TargetByEmp.values())],
        assessmentYear: pYear,
      });
      for (const [employmentId, personId] of tp1TargetByEmp) {
        const approvedRows = rowsByPerson.get(personId);
        if (!approvedRows) continue; // nothing approved for this year ⇒ LP₁ derives nothing
        tp1FeedByEmp.set(
          employmentId,
          // THE one spelling of the delta, shared with `prefillTp1FromSelfRelief` — so pressing the button
          // and not pressing it produce the identical figure, which is the property that makes the button
          // safe to leave in place.
          resolveTp1Feed({
            approvedRows,
            throughMonth: pMonth,
            lpAlreadyFed: lpFedByEmp.get(employmentId) ?? 0,
          }),
        );
      }
    }

    // ── Typed pay components (Wave 3 #9, ADR-0025) ──
    // GATED: only when TYPED_PAY_COMPONENTS_ENABLED do we read the component tables as the earnings
    // source instead of compensation + payroll_input. The seeded component flags reproduce the legacy
    // agency split exactly, so a back-filled batch is byte-identical (proven by the compat test).
    const typedComponents = isModuleEnabled(ctx, 'typed_pay_components');
    type CompRow = {
      code: string; name: string; kind: string; amount: number; rounding: string;
      epf: boolean; socso: boolean; pcb: boolean; hrdf: boolean; nonPayable: boolean; prorates: boolean;
      // 1.2.1 Fixed Transaction — per-employee override of the catalog `prorates` flag (null = inherit). A
      // one-off batch component has no override, so this is null there too (⇒ catalog flag, unchanged).
      prorateOverride: boolean | null;
      rule: PayRule | null; // Payroll Setup — configurable pay-rule; null ⇒ stored amount (legacy behaviour).
      // 61bf109d — the rank recorded at save time (migration 0330). Components resolve in ascending order so
      // a rule that reads another pay item sees that item's final figure. 0 on every legacy row.
      resolutionOrder: number;
      // r168 verification — TRUE for a BATCH row (individual transaction or synthetic TXN_EARNING /
      // TXN_DEDUCTION). Optional so every recurring-row literal stays valid; absent ⇒ recurring.
      // Read by core/pay-rule.ts's fixed_allowances aggregate, which must NOT total one-offs.
      oneOff?: boolean;
      // 711adcd2 — pay_component.orp_overtime (migration 0456): the tick box that decides whether this item
      // counts towards the fixed_allowances aggregate a tenant's overtime formula reads. It REPLACED the
      // aggregate's kind test, and 0456 backfilled it to exactly that test, so a run is byte-identical
      // until an operator changes a box. It reaches nothing else — in particular it does NOT reach
      // prefillOvertimeFromAttendance, which monetises statutory OT from the Personnel compensation
      // columns and never looks at a pay item.
      orpOvertime: boolean;
      // 711adcd2 — pay_component.orp_unpaid_leave: does this item's amount join basic salary in the base
      // the unpaid-leave (and equal-by-definition absence) daily rate is struck from? 0456 backfilled it
      // FALSE on every row, because measured, that base is `basicRaw` alone today.
      orpUnpaidLeave: boolean;
      // LHDN PCB 2026 classification (feedback 09b554e9). epfBonus2012 routes the amount down the
      // additional-remuneration EPF path regardless of the SOCSO flag; pcbRemunerationType (when declared)
      // overrides the epf/socso stream inference; pcbExemptionCode selects the annual exemption cap.
      // All null/false on legacy rows ⇒ byte-identical legacy fold.
      epfBonus2012: boolean;
      pcbRemunerationType: 'normal' | 'additional' | 'optional_deduction' | null;
      pcbExemptionCode: string | null;
      // Feedback 3c473773 — the DISPLAY box (payroll category), migration 0393. Presentation only: it never
      // reaches a statutory base, never changes the kernel bucket the amount is routed into, and never
      // changes a stored payslip column. null = unclassified ⇒ the box is inferred from the bucket exactly
      // as before. Backfilled to each row's CURRENT box, so a run is byte-identical unless someone has
      // deliberately re-categorised an item.
      displayCategory: string | null;
    };
    const recurringByEmp = new Map<string, CompRow[]>();
    const batchCompByEmp = new Map<string, CompRow[]>();
    if (typedComponents && empIds.length) {
      // Catalog + amount columns shared by both the recurring and the one-off batch query.
      const catCols = {
        amount: employmentPayComponent.amount,
        code: payComponent.code,
        name: payComponent.name,
        kind: payComponent.kind,
        epf: payComponent.includedInEpf,
        socso: payComponent.includedInSocsoEis,
        pcb: payComponent.includedInPcb,
        hrdf: payComponent.includedInHrdfBase,
        nonPayable: payComponent.isNonPayable,
        // 711adcd2 — the two ORP tick boxes (migration 0456). See the CompRow comments.
        orpOvertime: payComponent.orpOvertime,
        orpUnpaidLeave: payComponent.orpUnpaidLeave,
        prorates: payComponent.prorates,
        rounding: payComponent.roundingMethod,
        rule: payComponent.rule, // Payroll Setup — read for the resolver (null on every legacy row).
        resolutionOrder: payComponent.resolutionOrder, // 61bf109d — recorded dependency rank (0 on legacy rows).
        // LHDN PCB 2026 classification (feedback 09b554e9) — null/false on every legacy row.
        epfBonus2012: payComponent.epfBonus2012,
        pcbRemunerationType: payComponent.pcbRemunerationType,
        pcbExemptionCode: payComponent.pcbExemptionCode,
        // Feedback 3c473773 — the declared payslip box (migration 0393). Read-only here; it is applied to
        // the DISPLAY overlay in earningsOf and to nothing else.
        displayCategory: payComponent.displayCategory,
      };
      const push = (map: Map<string, CompRow[]>, r: { employmentId: string; amount: string; prorateOverride?: boolean | null } & Omit<CompRow, 'amount' | 'prorateOverride'>) => {
        const list = map.get(r.employmentId) ?? [];
        list.push({ ...r, amount: Number(r.amount), prorateOverride: r.prorateOverride ?? null });
        map.set(r.employmentId, list);
      };
      const rec = await tx
        .select({
          ...catCols,
          employmentId: employmentPayComponent.employmentId,
          // 1.2.1 Fixed Transaction — per-employee prorate override (null = inherit catalog `prorates`).
          prorateOverride: employmentPayComponent.prorateOverride,
        })
        .from(employmentPayComponent)
        .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
        .where(
          and(
            inArray(employmentPayComponent.employmentId, empIds),
            // 1.2.1 Fixed Transaction — PERIOD-AWARE window, mirroring the employment/compensation filter
            // above (lte(hiredOn, periodEnd) / or(isNull(terminatedOn), gte(terminatedOn, periodStart))):
            //   • valid_from <= periodEnd        → the item has started by the end of this period
            //   • valid_to IS NULL OR >= periodStart → the item has not ended before this period starts
            //   • superseded_at IS NULL          → never apply a row that was replaced by a newer value
            // valid_to is an INCLUSIVE end-date: validTo == periodStart still applies (gte). The lte(valid_from,
            // periodEnd) clause is a no-op for legacy/backfilled rows (their valid_from is a past month, so
            // it is <= periodEnd) — proven by the legacy-window test. The activate/deactivate semantics here
            // are BINARY in/out of window by design: an item active for any part of the period pays its full
            // amount (times the employee tenure `factor`); per-item mid-month day-proration of the item's OWN
            // window is an explicit v1 non-goal (the spec ties prorate to join/resign, not the item window).
            lte(employmentPayComponent.validFrom, periodEnd),
            or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
            isNull(employmentPayComponent.supersededAt),
          ),
        );
      for (const r of rec) push(recurringByEmp, r);
      const bat = await tx
        .select({ ...catCols, employmentId: payrollBatchComponent.employmentId, amount: payrollBatchComponent.amount })
        .from(payrollBatchComponent)
        .innerJoin(payComponent, eq(payComponent.id, payrollBatchComponent.componentId))
        .where(eq(payrollBatchComponent.batchId, p.batchId));
      for (const r of bat) push(batchCompByEmp, r);
    }

    // ── f1564110 Phase 3 — individual (one-off) transaction consumption (amends ADR-0056) ──
    // GATED by INDIVIDUAL_TXN_PAY_ENABLED (default OFF ⇒ the ledger stays record-only and every payslip is
    // byte-identical to the pre-Phase-3 kernel — test/payroll-individual-txn.test.ts's inert test is the
    // flag-off guard). Flag on, the batch's (post-attach-on-generate) ledger rows fold into pay:
    //   • earning/deduction WITH a component → pushed into the existing batchCompByEmp fold as a CompRow, so
    //     the catalog's statutory flags (EPF/SOCSO/PCB/HRDF), rounding, prorates and non-payable treatment
    //     apply IDENTICALLY to a one-off batch component. The keyed amount is authoritative: the catalog
    //     `rule` is deliberately NOT applied (a per_day/percent rule would REPLACE the keyed figure), so
    //     rule=null ⇒ stored-amount behaviour.
    //   • earning/deduction WITHOUT a component (legacy rows keyed before the flag; new writes require a
    //     component, service-enforced) → conservative statutory defaults: an earning is EPF+SOCSO-liable
    //     wages (and thereby in the PCB base via wagesExOt); a deduction is post-statutory (reduces net
    //     only, EA s.24-clamped exactly like a manual deduction). prorates=false — a dated one-off amount
    //     is an actual, not a contractual monthly figure.
    //   • overtime / unpaid kinds fold in the payslip loop below (the OT figure with otSource provenance /
    //     the unpaid deduction); leave is RECORD-ONLY in v1 (documented skip below).
    // DEPENDENCY (documented): the earning/deduction fold rides TYPED_PAY_COMPONENTS_ENABLED — with typed
    // components off there is no per-component fold to ride, so payable rows FAIL CLOSED (typed error)
    // rather than silently staying unpaid. Read-only fold — no DomainEvent (the generated event + payslip
    // rows are the audit record, as for batch components).
    const individualTxnPay = settingEnabled(ctx, 'payroll.individual_txn_pay_enabled');
    const txnOtByEmp = new Map<string, number>();
    const txnUnpaidByEmp = new Map<string, number>();
    // Named payslip provenance for every consumed row (merged into statutory.recordLines below) so the
    // payslip shows the one-off items by name; deductions carry a negative sign.
    //
    // f35f758a — EVERY LINE CARRIES `nonPayable`, STAMPED AT WRITE TIME. `statutory.recordLines` has been a
    // MIXED population since f1564110 phase 3: record-only BIKs (which never touch cash) and named
    // provenance for one-off transactions (which absolutely did reach the employee) land in the same array,
    // and nothing on the row said which was which. Verified on production 2026-08-10: payslip 945d16e9
    // carries COMMISSION 300, HANDPHONE ALLOWANCE 400 and SHORT NOTICE −500 — all PAID — and the entire
    // pay_component catalogue has zero non-payable rows. Printing those three under a "Non-payable" heading
    // would tell an employee their commission never reached them.
    //
    // The flag is stamped HERE, from the row that produced the line, and never re-derived: matching a code
    // back to today's pay_component would report today's answer about last month's pay. Payslips written
    // before this shipped carry no flag at all, and every reader must treat an unflagged list as one list.
    const txnRecordLinesByEmp = new Map<string, PayslipRecordLine[]>();
    if (individualTxnPay) {
      const ledger = await tx
        .select({
          employmentId: payrollIndividualTxn.employmentId,
          kind: payrollIndividualTxn.kind,
          amount: payrollIndividualTxn.amount,
          notes: payrollIndividualTxn.notes,
          componentId: payrollIndividualTxn.componentId,
          compCode: payComponent.code,
          compName: payComponent.name,
          compKind: payComponent.kind,
          compEpf: payComponent.includedInEpf,
          compSocso: payComponent.includedInSocsoEis,
          compPcb: payComponent.includedInPcb,
          compHrdf: payComponent.includedInHrdfBase,
          compNonPayable: payComponent.isNonPayable,
          compProrates: payComponent.prorates,
          compRounding: payComponent.roundingMethod,
          compEpfBonus2012: payComponent.epfBonus2012,
          compPcbRemunerationType: payComponent.pcbRemunerationType,
          compPcbExemptionCode: payComponent.pcbExemptionCode,
          // Feedback 3c473773 — the catalog row's declared payslip box rides the one-off transaction too.
          // This is the reporter's exact path: an Overtime 1.5 one-off landed in Bonus because the box was
          // inferred from the pay code's PCB stream.
          compDisplayCategory: payComponent.displayCategory,
        })
        .from(payrollIndividualTxn)
        .leftJoin(payComponent, eq(payComponent.id, payrollIndividualTxn.componentId))
        // 0db616f3 (0437) — THE CONSUMED MARKER, and this `or` is the whole guard.
        //
        // Before it, this predicate was `batch_id = $1` and nothing else: every row hanging off the run
        // was folded on EVERY generation of it, and a row that moved to a second run was folded there
        // too, with nothing recording that its money had already reached somebody. That is the January
        // 2026 shape — 24 imported bonus lines on the regular run, a bonus run showing nineteen zero
        // payslips, and one `generatePayslips` call between the ledger and paying all 24.
        //
        // "Consumed by NOBODY, or consumed by ME." The second half is not a loophole, it is the three
        // legitimate re-runs: `resetProcessedBatch` destroys this run's payslips so a correction can be
        // re-generated, a selective reprocess rewrites a subset of them, and both must still pay these
        // lines. What the first half refuses is the case with no defence today — a DIFFERENT run paying
        // a line an earlier run already paid.
        .where(
          and(
            eq(payrollIndividualTxn.batchId, p.batchId),
            or(isNull(payrollIndividualTxn.consumedBatchId), eq(payrollIndividualTxn.consumedBatchId, p.batchId)),
          ),
        );
      // `nonPayable: false` is stamped HERE rather than at each call site: every line this helper carries is
      // provenance for money that MOVED (an overtime payment, a one-off earning, a one-off deduction), and
      // a future call site that forgot the flag would silently print a paid item as never paid.
      const pushTxnLine = (empId: string, line: { code: string; name: string; amount: number }) => {
        const list = txnRecordLinesByEmp.get(empId) ?? [];
        list.push({ ...line, nonPayable: false });
        txnRecordLinesByEmp.set(empId, list);
      };
      for (const t of ledger) {
        const amt = round2(Number(t.amount));
        if (t.kind === 'overtime') {
          txnOtByEmp.set(t.employmentId, round2((txnOtByEmp.get(t.employmentId) ?? 0) + amt));
          pushTxnLine(t.employmentId, { code: 'TXN_OVERTIME', name: t.notes ?? 'Overtime (one-off)', amount: amt });
          continue;
        }
        if (t.kind === 'unpaid') {
          txnUnpaidByEmp.set(t.employmentId, round2((txnUnpaidByEmp.get(t.employmentId) ?? 0) + amt));
          pushTxnLine(t.employmentId, { code: 'TXN_UNPAID', name: t.notes ?? 'Unpaid (one-off)', amount: -amt });
          continue;
        }
        if (t.kind === 'leave') {
          // DOCUMENTED SKIP (v1): a 'leave' row is RECORD-ONLY — leave pay flows through the leave module
          // (unpaid-leave derivation / entitlements), so folding a raw leave amount here would double-count.
          // The row still surfaces on the payslip as a named record line (provenance, no cash effect).
          pushTxnLine(t.employmentId, { code: 'TXN_LEAVE', name: t.notes ?? 'Leave (one-off)', amount: amt });
          continue;
        }
        // earning / deduction — the payable classes ride the typed-component fold (dependency above).
        if (!typedComponents) throw new IndividualTxnRequiresTypedComponentsError();
        const row: CompRow =
          t.componentId != null && t.compCode != null
            ? {
                code: t.compCode,
                name: t.compName ?? t.compCode,
                kind: t.compKind ?? t.kind,
                amount: amt,
                rounding: t.compRounding ?? 'none',
                epf: t.compEpf ?? false,
                socso: t.compSocso ?? false,
                pcb: t.compPcb ?? false,
                hrdf: t.compHrdf ?? false,
                nonPayable: t.compNonPayable ?? false,
                // 711adcd2 — a BATCH component is a ONE-OFF, and neither ORP base is a one-off's business:
                // both are monthly rates struck from what the employee is paid every month. `oneOff: true`
                // below already keeps it out of the `fixed_allowances` aggregate (r168's own measurement),
                // and false here keeps it out of the unpaid-leave base for the identical reason. These are
                // deliberately NOT read off the catalog row: an operator ticking a pay item for the monthly
                // ORP must not thereby have a single keyed one-off raise a daily rate for one month.
                orpOvertime: false,
                orpUnpaidLeave: false,
                prorates: t.compProrates ?? false,
                prorateOverride: null,
                rule: null, // keyed amount is authoritative — never re-derive via a catalog rule
                // r168 verification — a BATCH row. Forcing rule:null here is what let it satisfy the
                // fixed_allowances aggregate; this says plainly that it is a one-off, not a recurring
                // catalog allowance, so the aggregate skips it.
                oneOff: true,
                // 61bf109d — a null rule short-circuits to `amount`, so the rank is inert here; 0 keeps the
                // one-off row in the first resolution group, exactly where an unranked row belonged before.
                resolutionOrder: 0,
                // LHDN PCB 2026 classification rides the catalog row (feedback 09b554e9).
                epfBonus2012: t.compEpfBonus2012 ?? false,
                pcbRemunerationType: t.compPcbRemunerationType ?? null,
                pcbExemptionCode: t.compPcbExemptionCode ?? null,
                // Feedback 3c473773 — display box from the catalog row (null ⇒ inferred, as before).
                displayCategory: t.compDisplayCategory ?? null,
              }
            : t.kind === 'earning'
              ? { code: 'TXN_EARNING', name: t.notes ?? 'One-off earning', kind: 'allowance', oneOff: true, amount: amt, rounding: 'none', epf: true, socso: true, pcb: true, hrdf: false, nonPayable: false, orpOvertime: false, orpUnpaidLeave: false, prorates: false, prorateOverride: null, rule: null, resolutionOrder: 0, epfBonus2012: false, pcbRemunerationType: null, pcbExemptionCode: null, displayCategory: null }
              : { code: 'TXN_DEDUCTION', name: t.notes ?? 'One-off deduction', kind: 'deduction', oneOff: true, amount: amt, rounding: 'none', epf: false, socso: false, pcb: false, hrdf: false, nonPayable: false, orpOvertime: false, orpUnpaidLeave: false, prorates: false, prorateOverride: null, rule: null, resolutionOrder: 0, epfBonus2012: false, pcbRemunerationType: null, pcbExemptionCode: null, displayCategory: null };
        const list = batchCompByEmp.get(t.employmentId) ?? [];
        list.push(row);
        batchCompByEmp.set(t.employmentId, list);
        // Provenance: a non-payable (BIK) component row already surfaces via the fold's own record line —
        // skip the duplicate. Every cash row gets a named line (deductions negative).
        if (!row.nonPayable) {
          // Feedback 417d4937 — THE RECORD LINE IS NAMED BY THE PAY ITEM, NOT BY THE REMARK.
          //
          // This read `t.notes ?? row.name`, and the remark won whenever there was one. The entry screen
          // DEFAULTS the remark to the picked item's label (txn-workspace.tsx `resolveItem`), so changing
          // the pay item on a half-typed transaction left the previous item's label behind in a field
          // nobody re-reads — and the payslip then printed that. Measured on production: A0004's 2026-01
          // Meal Allowance (component A0040) carried notes "A0020 — DIRECTOR FEE" and was recorded under
          // that name, which read as a phantom Director Fee transaction the employee never had. The money
          // was always right; only this string was wrong.
          //
          // `row.name` IS the right answer for BOTH populations, which is why this is one expression and
          // not a branch: a componented row was built above with `name: t.compName ?? t.compCode` (the pay
          // item's own description — the same source the Transaction Detail grid reads, which is why that
          // screen was correct all along), and a genuinely UNCOMPONENTED one-off was built with
          // `name: t.notes ?? 'One-off earning' | 'One-off deduction'`, so a free-text remark is still the
          // only name such a line can have. The kind-based OT / UNPAID / LEAVE lines above keep their own
          // `t.notes ?? …` for exactly that reason: they have no pay item to be named from.
          //
          // THE KERNEL IS FORWARD-ONLY, AND THAT IS NO LONGER THE WHOLE STORY — 417d4937 (r199).
          //
          // This write still is what it always was: a payslip keeps the string stamped here, and NOTHING in
          // this kernel ever re-derives a historical line from today's catalogue. That is the rule below
          // (`recordLines` is stored provenance) and it stands.
          //
          // What changed is the READ side, and the sentence that used to sit here said the opposite of what
          // the system now does. Being forward-only meant every payroll already calculated kept the WRONG
          // name forever — the reporter's "A0020 - DIRECTOR FEE" against pay item A0040 — so 417d4937 added
          // `recordLineIdentity` (core/payslip-earning-lines.ts), a READ-TIME repair that shows the
          // catalogue's current description against the stored CODE and keeps the stored words beside it as
          // a remark. Four surfaces apply it: Transaction View History (history-table.tsx), its grid
          // (history-pivot.ts) and Excel file (history-export.ts), Individual Payslip and the ESS payslip.
          //
          // IT IS THE ONE DELIBERATE EXCEPTION TO RULE (a) OF core/payslip-earning-lines.ts, and it is
          // confined to `recordLines` whose `nonPayable` is not `true` — i.e. to the lines THIS call site
          // pushes. The BIK lines pushed by `earningsOf` carry the pay item's own description as genuine
          // provenance and are excluded there by that flag; `componentLines` are never repaired at all.
          // Read `recordLineIdentity`'s docblock before widening any of that.
          pushTxnLine(t.employmentId, { code: row.code, name: row.name, amount: row.kind === 'deduction' ? -amt : amt });
        }
      }
      // OT provenance (feedback plan: otSource='individual-txn'): a slip whose OT includes one-off ledger
      // rows is stamped 'individual-txn' unless a manual/attendance figure also contributes — the earlier
      // provenance then still names the larger origin (the ledger rows remain visible as record lines).
      for (const [empId, v] of txnOtByEmp) {
        if (v <= 0) continue;
        const existingOt = round2(overtimeByEmp.get(empId) ?? 0);
        if (!(existingOt > 0) || !otSourceByEmp.get(empId)) otSourceByEmp.set(empId, 'individual-txn');
      }
    }

    // Payroll Setup — attendance worked HOURS per employment, for `per_hour` rules only. Computed once here
    // (gated on typedComponents) so the per-component resolver reads a map, not a re-query. No attendance
    // rows ⇒ 0 hours, a real, non-erroring outcome (paid by the hour, worked no hours) — there is NO division
    // in the resolver, so a zero-hours employee never aborts the batch.
    // ADR-0078 — an employee whose OWN pay_mode is hourly also needs the worked-hours map (rate × hours),
    // independent of the typed-components flag, so the gate widens when any such employee is in scope. A
    // batch with neither typed components nor an hourly-mode employee issues NO extra query (byte-identical).
    const hourlyModeEmps = emps.filter((e) => e.payMode === 'hourly' && e.rateAmount != null);
    const hoursByEmp = new Map<string, number>();
    if ((typedComponents || hourlyModeEmps.length > 0) && empIds.length) {
      const att = await tx
        .select({ employmentId: attendance.employmentId, minutes: sql<string>`coalesce(sum(${attendance.workedMinutes}), 0)` })
        .from(attendance)
        .where(
          and(
            inArray(attendance.employmentId, empIds),
            gte(attendance.attendanceDate, periodStart),
            lte(attendance.attendanceDate, periodEnd),
          ),
        )
        .groupBy(attendance.employmentId);
      for (const a of att) hoursByEmp.set(a.employmentId, Number(a.minutes) / 60);
    }

    // ── ADR-0078 (642ecc55) — Hourly pay mode: basic = per-hour rate × attendance hours in the period ──
    // With the rate now living on the employee's own compensation row, hourly becomes genuinely usable: one
    // hourly employee can sit among monthly colleagues on the same policy (the catalog per_hour rule could
    // only ever be tenant-wide). Zero worked hours ⇒ basic = 0 — a real outcome, not an error (multiply,
    // never divide). custom_period has NO calculation and is blocked at pre-flight (preProcessChecksTx), so
    // it never reaches this loop through a generated run.
    const hourlyPayByEmp = new Map<string, { rate: number; hours: number; basic: number }>();
    for (const e of hourlyModeEmps) {
      const rate = Number(e.rateAmount);
      const hours = hoursByEmp.get(e.employmentId) ?? 0;
      hourlyPayByEmp.set(e.employmentId, { rate, hours, basic: round2(rate * hours) });
    }

    // LHDN PCB 2026 (feedback 09b554e9) — the exemption tables ride the resolved statutory ruleset (a
    // pack/override predating 2026.5 omits them and falls back to the verified built-ins, mirroring hrdf).
    // Rung 5a (ADR-0080 D6 — the corrected R55 shape): the built-in fallback tables come from the batch's
    // resolved country pack, not a direct MY import.
    const exemptionTables = rules.pcbExemptions ?? pack.payroll.pcbExemptionTables;

    /** Per-employee earnings, from the typed components (flag on) or the legacy comp+input (flag off).
     *  Returns the exact variables the loop already used so the rest of the kernel is unchanged.
     *  Feedback 09b554e9 adds `lpDeclared` (this month's optional-deduction claims, fed into LP₁ beside
     *  TP1) and `exemptionUsed` (per-code exempt/claimed amounts, stamped onto the slip for the YTD replay). */
    /** Which summarised figure on the payslip a component's money landed in (feedback 862ed0ad). */
    type PayComponentBucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';
    type PayComponentLine = {
      code: string;
      name: string;
      /** The whole resolved+prorated amount, before it was split across buckets. */
      amount: number;
      buckets: { bucket: PayComponentBucket; amount: number }[];
      // ── Feedback 2333b7fb / 0253dc7c — the item's four statutory ticks, STAMPED AT GENERATE TIME ──
      // Item 0253dc7c discloses these on Transaction Detail beside the wage bases. Stamping them here,
      // from the catalogue row this run actually folded, is the only version that reports LAST MONTH'S
      // answer about LAST MONTH'S pay — reading today's `pay_component` to caption an old payslip is
      // the same class of mistake as re-deriving `recordLines.nonPayable` (see the note at the
      // txnRecordLinesByEmp declaration, which was written after exactly that bug).
      //
      // Additive jsonb, no migration. Absent on every payslip written before this shipped, and the
      // screen falls back to the live catalogue there and says on screen which it is showing.
      /** included_in_epf on the pay item, as it stood when this run folded it. */
      epf: boolean;
      /** included_in_socso_eis — ONE setting behind the SOCSO, EIS and SKBBK captions on screen. */
      socso: boolean;
      /** included_in_pcb. */
      pcb: boolean;
      /** included_in_hrdf_base. */
      hrdf: boolean;
      /**
       * a96d320c — THE QUANTITY AND THE UNIT RATE THE ITEM'S RULE MULTIPLIED, stamped at generate time.
       *
       * Present ONLY when `round2(qty × rate)` is the `amount` beside it, so the two factors always
       * explain the figure on the same line. Absent on every payslip written before this shipped, on
       * every item with no rule or a `fixed` / `percent_of` / `flat_capped` / `formula` rule, and on any
       * line where proration or a rounding method moved the amount away from the product.
       *
       * `unit` is null for `qty_rate` (a bare count the operator keyed); 'hours' / 'days' name the scope
       * input a `per_hour` / `per_day` rule consumed.
       */
      detail?: { qty: number; rate: number; unit: 'hours' | 'days' | null };
    };

    // ── Feedback 3c473773 — the DISPLAY overlay ────────────────────────────────────────────────────────
    // The buckets above are STATUTORY: `wage` feeds the EPF/SOCSO/EIS/PCB normal-wage base, `ot` feeds the
    // overtime leg (EPF-exempt), `bonus` feeds additional remuneration (EPF + PCB difference method,
    // outside SOCSO/EIS). They are NOT touched by anything below — moving an amount between them would
    // change EPF, SOCSO, EIS and PCB, i.e. change what is filed with KWSP/PERKESO/LHDN for money that is
    // being computed correctly today.
    //
    // What IS new is a second, parallel tally of the same amounts under the box each pay item DECLARES.
    // Same money, same totals, different labels — see core/pay-display-category.ts for why the two
    // questions were ever conflated. `moved` stays false unless someone deliberately re-categorised an
    // item, and a run with moved===false stamps nothing at all, which is what keeps every other payslip
    // byte-identical.
    type DisplayTally = Record<PayDisplayCategory, number>;
    // 711adcd2 — `bik` joins the vocabulary (Benefit in Kind), and stays 0 by construction: a non-payable
    // item never reaches a cash bucket, and resolveDisplayCategory refuses `bik` on one that did. The key
    // exists so DisplayTally stays a total Record over PAY_DISPLAY_CATEGORIES rather than a partial one.
    const emptyTally = (): DisplayTally => ({ basic: 0, overtime: 0, bonus: 0, allowance: 0, claim: 0, deduction: 0, bik: 0 });

    const earningsOf = (
      e: { employmentId: string; basic: unknown; allowance: unknown },
      factor: number,
    ): {
      basicRaw: number; basicGross: number; allowanceApplied: number; hrdfAllowApplied: number;
      overtime: number; bonus: number; reimburse: number; deduct: number;
      // ── Feedback 017d9c25 (r187) — the statutory BASE carve-outs the pay-item ticks demand ──
      // `allowanceApplied` (the Y1 wage stream) and `bonus` (the Yt additional stream) are ROUTING
      // decisions, driven by the item's declared pcb_remuneration_type. They say which PCB stream the
      // money rides and which payslip box it prints in. They do NOT say which agency charges it — the
      // EPF and SOCSO/EIS ticks do, and before r187 a declared remuneration type silently overrode them.
      // These four numbers carry the ticks through to `pack.payroll.statutory` without disturbing the
      // meaning of `wage` / `additional` (see the opts doc in localization/my/payroll.ts).
      /** Of `allowanceApplied`: the part sitting on a 'normal' item ticked NOT subject to EPF. */
      epfWageExcluded: number;
      /** Of `bonus`: the part sitting on an 'additional' item ticked NOT subject to EPF. */
      epfAdditionalExcluded: number;
      /** Of `allowanceApplied`: the part sitting on a 'normal' item ticked NOT subject to SOCSO/EIS. */
      socsoWageExcluded: number;
      /** Of `bonus`: the part sitting on an 'additional' item ticked SUBJECT TO SOCSO/EIS (the OT1_5 leg —
       *  the one carve-out that ADDS a contribution rather than removing one). */
      socsoWageExtra: number;
      // ── Feedback 2333b7fb (r193) — the DEDUCTION side of the same fault ──────────────────────────
      // r187 fixed the EARNING half: a pay item's EPF/SOCSO ticks were overridden by its declared
      // remuneration type. The DEDUCTION half was untouched and is worse — the `kind === 'deduction'`
      // branch below `continue`s before ANY statutory flag is read, so all four boxes on a deduction
      // pay item are dead settings. They render on the Pay Item form, they save, and nothing anywhere
      // reads them. A0006's UNPAID LEAVE is ticked into all four and came off take-home AFTER every
      // contribution had already been charged on wage the employee never received.
      //
      // These four numbers are the amount to take back OUT of each agency's base, one box per agency,
      // judged separately. A deduction with no box ticked contributes 0 to every one of them and is
      // byte-identical to today (MONTHLY PARKING is that case on production and must stay that way).
      /** Deduction money ticked "subject to EPF" — leaves the EPF wage base. */
      epfWageDeduction: number;
      /** Deduction money ticked "subject to SOCSO/EIS" — leaves the SOCSO/EIS/SKBBK base. */
      socsoWageDeduction: number;
      /** Deduction money ticked "subject to PCB" — leaves the taxable remuneration base. */
      pcbWageDeduction: number;
      /** Deduction money ticked "subject to HRDF" — leaves `hrdfBase` (applied in the payslip loop,
       *  not inside `statutory()`: the levy base is built in the kernel, not in the pack). */
      hrdfWageDeduction: number;
      recordLines: PayslipRecordLine[];
      componentLines: PayComponentLine[];
      lpDeclared: number; exemptionUsed: Record<string, number>;
      // Feedback 3c473773 — the same component money tallied under each item's DECLARED payslip box, plus
      // how much left the `ot` bucket for another box (the one direction whose display arithmetic has to be
      // reconciled against the OT caps downstream). `displayMoved` is false whenever nothing was
      // re-categorised, and the kernel then stamps no overlay at all.
      display: DisplayTally; displayMoved: boolean; displayOtOutbound: number;
      // 711adcd2 (migration 0456) — the sum of the recurring pay items TICKED "Add to Unpaid Leave ORP
      // Calculation". UNFACTORED, deliberately: it joins `basicRaw`, which is itself the unfactored monthly
      // basic, so a mid-month joiner's daily rate is not shortened twice. 0 on every path until an operator
      // ticks a box (0456 backfills the column false everywhere), which is what makes this byte-identical.
      orpUnpaidLeaveExtra: number;
    } => {
      if (!typedComponents) {
        const basicRaw = Number(e.basic);
        const allowRaw = Number(e.allowance ?? 0);
        const claim = round2(claimAllowanceByEmp.get(e.employmentId) ?? 0);
        return {
          basicRaw,
          basicGross: round2(basicRaw * factor),
          allowanceApplied: round2(allowRaw * factor + claim),
          hrdfAllowApplied: round2(allowRaw * factor),
          overtime: round2(overtimeByEmp.get(e.employmentId) ?? 0),
          bonus: round2(bonusByEmp.get(e.employmentId) ?? 0),
          reimburse: 0,
          deduct: 0,
          // 017d9c25 — with typed components off there are no pay-item ticks to honour: the figures come
          // from compensation + payroll_input, whose agency treatment is fixed by the legacy contract.
          // All-zero ⇒ the statutory call is byte-identical to the pre-r187 kernel.
          epfWageExcluded: 0,
          epfAdditionalExcluded: 0,
          socsoWageExcluded: 0,
          socsoWageExtra: 0,
          // 2333b7fb — likewise: with typed components off there are no deduction pay items at all (the
          // legacy path has no deduct bucket — `deduct: 0` above), so there is nothing to carve.
          epfWageDeduction: 0,
          socsoWageDeduction: 0,
          pcbWageDeduction: 0,
          hrdfWageDeduction: 0,
          recordLines: [],
          // Nothing to itemise: with typed components off there IS no per-component detail — the figures
          // come from compensation + payroll_input, which is a different shape entirely.
          componentLines: [],
          lpDeclared: 0,
          exemptionUsed: {},
          // Flag off ⇒ there are no typed pay items, so there is no declared box to honour and nothing to
          // re-categorise. The legacy path stays exactly as it was.
          display: emptyTally(),
          displayMoved: false,
          displayOtOutbound: 0,
          // 711adcd2 — the legacy path has no typed pay items at all, so there is nothing to tick and
          // nothing to add: the unpaid-leave base stays `basicRaw`, exactly as it always was.
          orpUnpaidLeaveExtra: 0,
        };
      }
      let basicRaw = 0, basicGross = 0, wageAllow = 0, hrdfAllow = 0, ot = 0, bonusAmt = 0, reimburse = 0, deduct = 0;
      // 017d9c25 — the four base carve-outs, accumulated beside the buckets they carve (see the return type).
      let epfWageExcluded = 0, epfAdditionalExcluded = 0, socsoWageExcluded = 0, socsoWageExtra = 0;
      // 2333b7fb — and the four deduction-side reductions, accumulated in the `kind === 'deduction'` branch.
      let epfWageDeduction = 0, socsoWageDeduction = 0, pcbWageDeduction = 0, hrdfWageDeduction = 0;
      // 711adcd2 — the unpaid-leave ORP base's pay-item half. See the return type.
      let orpUnpaidLeaveExtra = 0;
      const recordLines: PayslipRecordLine[] = [];
      // Feedback 862ed0ad — per-component provenance for the CASH buckets. recordLines already itemises
      // record-only components, which is why one-off items could always be broken down; the PAID recurring
      // ones were summed into wageAllow/ot/bonusAmt/reimburse/deduct with nothing kept, so a summarised
      // figure on Transaction View had no stored detail behind it to disclose.
      //
      // One line per component carrying EVERY bucket it contributed to, so a component that splits — an
      // exempt portion paid untaxed plus a taxable remainder — is represented as it actually behaved
      // rather than flattened into one number against one bucket.
      //
      // INVARIANT, pinned by test: for each bucket, the sum of the lines' contributions equals that
      // bucket's total. That is what makes a breakdown incapable of disagreeing with the figure beside it,
      // which the plan made a precondition of showing one at all.
      const componentLines: PayComponentLine[] = [];
      let currentLine: PayComponentLine | null = null;
      /** Record a component's contribution. Enrolled LAZILY: a component that never moves cash (a
       *  record-only BIK) never appears here — it belongs to recordLines and would otherwise be listed
       *  twice, under a heading about money it does not affect. */
      // Feedback 3c473773 — the display tally, filled at the SAME call sites as the statutory buckets so
      // the two can never see different money. `currentCategory` is the box the component in hand declares
      // (null ⇒ unclassified ⇒ resolveDisplayCategory falls back to the bucket's own box, byte-identical).
      const display = emptyTally();
      let displayMoved = false;
      let displayOtOutbound = 0;
      let currentCategory: string | null = null;
      const contributes = (bucket: PayComponentBucket, amount: number) => {
        if (!currentLine || amount === 0) return;
        if (currentLine.buckets.length === 0) componentLines.push(currentLine);
        currentLine.buckets.push({ bucket, amount });
        const box = resolveDisplayCategory(currentCategory, bucket);
        display[box] = round2(display[box] + amount);
        if (box !== defaultCategoryOfBucket(bucket)) {
          displayMoved = true;
          // Money leaving the `ot` bucket is the one move the overlay cannot always express downstream: the
          // stored overtime figure is the CAPPED one, so subtracting a pre-cap amount from it could go
          // negative. Track it here; the kernel refuses to stamp the overlay if the cap ever bit.
          if (bucket === 'ot') displayOtOutbound = round2(displayOtOutbound + amount);
        }
      };
      // LHDN PCB 2026 (feedback 09b554e9) — this month's optional-deduction (LP) claims and per-code
      // exemption usage. `priorUsed` is the YTD usage replayed from the year's earlier slips; `exemptionUsed`
      // accumulates THIS month's usage (so two components sharing a code share the remaining cap headroom).
      let lpDeclared = 0;
      const exemptionUsed: Record<string, number> = {};
      const priorUsed = exemptUsedByEmp.get(e.employmentId) ?? {};
      /** Remaining annual headroom for a code under `cap` (cap < 0 = fully exempt sentinel ⇒ unlimited). */
      const roomFor = (code: string, cap: number): number =>
        cap < 0 ? Number.POSITIVE_INFINITY : Math.max(0, round2(cap - (priorUsed[code] ?? 0) - (exemptionUsed[code] ?? 0)));
      const useRoom = (code: string, amount: number) => {
        if (amount <= 0) return;
        exemptionUsed[code] = round2((exemptionUsed[code] ?? 0) + amount);
      };
      const comps = [...(recurringByEmp.get(e.employmentId) ?? []), ...(batchCompByEmp.get(e.employmentId) ?? [])];

      // Payroll Setup — pay-rule scope (shared by all components). `daysWorked` reflects the partial period
      // (factor × dim); `hours` is the employee's attendance hours. NOTE: `per_day`/`per_hour` rules require
      // the component to have prorates=false (validatePayRule rejects the combo), so the kernel's `factor`
      // multiplier below does NOT also apply to them — no double-proration. `percent_of basic` reads the
      // Personnel compensation basic (seeded once below, order-independent).
      // r168 VERIFICATION — THIS COMMENT SAID "There is NO division in the resolver". As of 2da9937a
      // there IS: a formula may divide by days, hours or another item. The GUARANTEE it was defending
      // still holds — a zero divisor resolves that component to 0 for that employee rather than
      // producing Infinity — but the reason moved from "there is no division" to "division is guarded
      // at readOperand, the single place a named input becomes a number". Left uncorrected, this is
      // the sentence the next kernel change would have reasoned from.
      // 61bf109d — `components` carries each pay item's resolved amount for rules that read another item.
      // It starts with BASIC PINNED to the authoritative Personnel figure (seeded just below): the BASIC
      // component row is inert in this engine, so a rule reading `component:'BASIC'` must get the same
      // number the `basic` operand gives, never the stale component amount. resolvePayComponentSet does not
      // overwrite a caller-pinned code.
      // e318eaec — `calendarDays` is `dim` itself, NOT `daysWorked`. `daysWorked` is `factor × dim`, the
      // tenure-prorated count; `calendarDays` is the month's own length (31 in August, 30 in September),
      // identical for every employee. They are different numbers, a formula legitimately wants either, and
      // aliasing one to the other is the mistake test/pay-rule-format.test.ts pins against.
      // `proratedBasic` is seeded 0 and set to basicGross immediately below, once the factor is applied.
      const rscope: PayRuleScope = {
        basic: 0,
        daysWorked: factor * dim,
        hours: hoursByEmp.get(e.employmentId) ?? 0,
        components: {},
        calendarDays: dim,
        proratedBasic: 0,
      };
      // ── Feedback 64fb5e48 (supersedes the R37 62e370b0 fallback): Personnel is the ONLY basic source ──
      // The BASIC line always reads the Personnel Basic Salary record (the compensation join, `e.basic`) —
      // exactly what the legacy path reads. A BASIC employment_pay_component never supplies the amount any
      // more (previously a stale one silently OVERRODE the Personnel record — a payment-integrity risk);
      // it is skipped in the loop below and pre-flight surfaces a staleBasicComponent WARNING when its
      // amount disagrees. `rscope.basic` therefore feeds `percent_of basic` rules from the same
      // authoritative figure, and basicRaw/basicGross mirror the legacy path: basicRaw is the unfactored
      // monthly basic; basicGross applies the EA-1955 tenure `factor` (mid-period joiner/leaver
      // proration). Daily/hourly modes override both in the payslip loop, as before.
      const compensationBasic = Number(e.basic ?? 0);
      rscope.basic = compensationBasic;
      rscope.components = { BASIC: compensationBasic }; // pinned — see the rscope comment above
      basicRaw = compensationBasic;
      basicGross = round2(compensationBasic * factor);
      // e318eaec — the `prorated_basic` operand IS basicGross. Assigned from the same expression rather
      // than recomputed, so a formula reading it and the payslip's own basic line can never disagree.
      rscope.proratedBasic = basicGross;
      // A single resolved value per component, substituted at BOTH read sites (the line-868 amount and the
      // line-877 basicRaw accumulator) so the gross AND the statutory base see the same number.
      //
      // 61bf109d — resolution is now a SET operation over the recorded dependency order, not a per-row map.
      // A `percent_of base:'component'` or `formula` rule reads ANOTHER pay item, so the value of that item
      // must already exist when this one is computed; resolvePayComponentSet walks the groups in ascending
      // pay_component.resolution_order (planned and refused-if-cyclic at save time, migration 0330), which
      // is what makes two runs of the same payroll agree. For an all-fixed catalog every rank is 0 and each
      // entry short-circuits to `c.amount` — the exact expression this line used before, hence byte-identical.
      // The SAME function backs the admin preview, so the preview cannot drift from the run.
      const resolvedByIdx = resolvePayComponentSet(comps, rscope);

      for (const [ci, c] of comps.entries()) {
        // Feedback 64fb5e48 — a BASIC component is inert in the engine: the Personnel record above already
        // seeded basicRaw/basicGross/rscope.basic, and a stale component amount must never override pay.
        if (c.code === 'BASIC') continue;
        const resolved = resolvedByIdx[ci];
        // 1.2.1 Fixed Transaction — the per-employee override wins over the catalog `prorates` flag; null
        // (every legacy/backfilled row + every one-off batch component) inherits the catalog flag, so this is
        // byte-identical to the prior `c.prorates` behaviour. `factor` is the EA-1955 join/resign tenure
        // factor (prorate ON = proportional for a mid-period joiner/resigner, OFF = full amount).
        const prorate = c.prorateOverride ?? c.prorates;
        const applied = roundAmount(prorate ? resolved * factor : resolved, c.rounding);
        // 2333b7fb/0253dc7c — the ticks ride the line from the row this run folded (see the type).
        // ── a96d320c — THE RATE AND THE INPUT, WHERE THE RULE ACTUALLY MULTIPLIED THEM ──────────────
        //
        // The reporter's lateness deduction prints one amount, because one amount is all the payslip has
        // ever recorded: `resolvePayRule` multiplies a quantity by a rate and returns the product, and the
        // two factors are gone before `applied` exists. They cannot be recovered afterwards — reading
        // today's `pay_component.rule` to caption an old payslip is the same mistake as re-deriving
        // `recordLines.nonPayable`, and the catalogue's rate is edited precisely when a rate changes.
        //
        // THE EQUALITY IS THE PERMISSION TO PRINT. Stamped only when the rounded quantity times the rate
        // IS the amount on the line, which is the reader's own arithmetic. That single condition rules out
        // every case where the factors would not explain the figure, without enumerating them: a prorated
        // item (`applied` is `resolved × factor`), a component whose rounding method moved it to a whole
        // ringgit, a `per_hour` item on an employee with no attendance hours. No detail ⇒ the line prints
        // as it does today.
        const qr = payRuleQuantityAndRate(c.rule, rscope);
        const qrQty = qr ? round2(qr.qty) : 0;
        const rateDetail =
          qr && qrQty > 0 && round2(qrQty * qr.rate) === applied
            ? { qty: qrQty, rate: qr.rate, unit: qr.unit }
            : null;
        currentLine = { code: c.code, name: c.name, amount: applied, buckets: [], epf: c.epf, socso: c.socso, pcb: c.pcb, hrdf: c.hrdf, ...(rateDetail ? { detail: rateDetail } : {}) };
        // Feedback 3c473773 — the box THIS item declares, read for the display tally only.
        currentCategory = c.displayCategory ?? null;
        // ── 711adcd2 — "Add to Unpaid Leave ORP Calculation" ──────────────────────────────────────
        // Placed HERE, above every branch below, so the base is built from the same set of items on every
        // route through the loop rather than from whichever branches happen to fall through. The amount is
        // the UNFACTORED resolved figure (`resolved`, not `applied`): it joins `basicRaw`, which is the
        // unfactored monthly basic, and prorating one side of a daily rate but not the other would shorten
        // a mid-month joiner's rate twice. The predicate's structural clauses — never BASIC, never a
        // statutory line, never a deduction — are in core/pay-rule.ts beside the overtime one.
        // The `if` is the byte-identity guarantee, not an optimisation: with 0456's backfill no row is
        // ticked, so `roundAmount` is never called here and the accumulator stays exactly 0.
        // `c.nonPayable` / `c.oneOff` are passed EXPLICITLY rather than left to the branches below: the
        // record-only exits at 4552 and 4601 are further down the loop, so a non-payable row reaches this
        // accumulator and would raise the rate out of money nobody is paid. See the predicate's header.
        if (payItemFeedsUnpaidLeaveOrp(c.code, c.kind, c.orpUnpaidLeave, c.nonPayable, c.oneOff)) {
          orpUnpaidLeaveExtra = round2(orpUnpaidLeaveExtra + roundAmount(resolved, c.rounding));
        }
        // ── LHDN PCB 2026 declared classification (feedback 09b554e9) ──
        // Optional Deduction: the amount reduces this month's PCB exactly like an approved TP1 deduction
        // (fed into LP₁ below), capped by the LP code's remaining ANNUAL headroom (YTD replay). Cash-wise
        // the component keeps its kind: a deduction deducts from net (e.g. LP_VOLUNTARY_EPF via salary), a
        // non-payable records only, and any other kind is paid untaxed (it is a relief claim, not remuneration).
        if (c.pcbRemunerationType === 'optional_deduction') {
          const cap = c.pcbExemptionCode != null ? (exemptionTables.lp[c.pcbExemptionCode] ?? 0) : 0;
          const claim = c.pcbExemptionCode != null ? round2(Math.min(applied, roomFor(c.pcbExemptionCode, cap))) : 0;
          if (claim > 0) {
            lpDeclared = round2(lpDeclared + claim);
            useRoom(c.pcbExemptionCode!, claim);
          }
          // 2333b7fb DELIBERATELY DOES NOT CARVE HERE, and this is the one place the two treatments must
          // not be merged. A declared optional_deduction has ALREADY reduced this month's tax through
          // `lpDeclared` → LP₁, exactly like an approved TP1 relief. Carving `pcbWageDeduction` as well
          // would relieve the same ringgit twice. It is a relief CLAIM against income that WAS earned;
          // the branch below is wage that was NOT earned. (No production pay item is in this state —
          // ABSENT / UPL / DB018 all declare 'normal' and fall through to the branch below — so this is
          // a guard against a future setting, not a live case.)
          if (c.kind === 'deduction') { deduct = round2(deduct + applied); contributes('deduct', applied); continue; }
          // `name: c.name` is the pay item's OWN description as this run folded it — provenance, not a
          // remark — and `nonPayable: true` is what tells the read side so: `recordLineIdentity`
          // (core/payslip-earning-lines.ts) repairs a txn-derived record line's label from today's
          // catalogue and must never touch this one. Drop the flag and it would.
          if (c.nonPayable) { recordLines.push({ code: c.code, name: c.name, amount: applied, nonPayable: true }); continue; }
          reimburse = round2(reimburse + applied);
          contributes('reimburse', applied);
          continue;
        }
        // ── Feedback 2333b7fb (r193) — THE FIX. ────────────────────────────────────────────────────
        // This branch used to `continue` before a single statutory flag was read, which made all four
        // boxes on a deduction pay item dead settings. Note where it sits: BEFORE the declared-stream
        // routing below, so a deduction declaring pcbRemunerationType 'normal' (which is what UPL,
        // ABSENT and DB018 do on production) lands here and never reached a flag either.
        //
        // The cash treatment is UNCHANGED — the amount still comes off net through `deduct`, in full,
        // whatever the ticks say. What changes is that each ticked box now also takes the amount out of
        // that agency's base. Untouched by design: `unpaidDeduction` (leave-derived unpaid leave +
        // absence + one-off 'unpaid' ledger rows), which is a SEPARATE pre-statutory path already
        // subtracted from wagesExOt/hrdfBase. A tenant recording the same absence BOTH ways would
        // double-reduce, and that is a data question, not a kernel one — test/deduction-statutory-
        // base-2333b7fb.test.ts pins the two paths as independent so the next change cannot merge them.
        if (c.kind === 'deduction') {
          deduct = round2(deduct + applied);
          contributes('deduct', applied);
          if (c.epf) epfWageDeduction = round2(epfWageDeduction + applied);
          if (c.socso) socsoWageDeduction = round2(socsoWageDeduction + applied);
          if (c.pcb) pcbWageDeduction = round2(pcbWageDeduction + applied);
          if (c.hrdf) hrdfWageDeduction = round2(hrdfWageDeduction + applied);
          continue;
        }
        // FAIL-CLOSED (ADR-0025 §5): a PCB-taxable non-payable/BIK, or a PCB-only earning (not EPF and not
        // SOCSO), would be SILENTLY under-taxed — v1 does not compute the tax, so reject rather than produce
        // a wrong payslip.
        //
        // WHICH WRITE PATHS REJECT IT FIRST, stated exactly — this comment used to claim "write-time guards
        // in core/pay-components.ts now reject the same at entry/import", and that was WRONG about the pay
        // item master save, which is the screen an operator actually uses. `isUnsupportedTaxableComponent`
        // (core/pay-components.ts) is now run by the batch picker, `setPayrollBatchComponent`, the CSV
        // importer AND the master save (app/admin/pay-components/actions.ts, f35f758a note 8). It is still
        // NOT run by `setEmploymentPayComponent`, so a bad row that already exists can still be ASSIGNED to
        // an employee and reach this throw. This guard stays the last line of defence, not a formality.
        // PRECEDENCE: the flag check runs on the resolved value — a rule does not let an unsupported
        // component through (an unsupported-PCB component still throws regardless of what its rule resolves to).
        // Feedback 09b554e9: a DECLARED pcb_remuneration_type makes the code computable (the kernel routes it
        // by the declaration below), so the guard only fires for PCB-ticked codes LACKING classification.
        if (c.pcb && c.pcbRemunerationType == null && (c.nonPayable || (!c.epf && !c.socso))) {
          throw new UnsupportedPayComponentError(c.code);
        }
        // A non-payable, non-taxable component (e.g. a record-only BIK) carries onto the payslip as an
        // INFORMATIONAL record line — it does NOT affect any cash bucket, gross, or net (ADR-0025 §5 / Option A).
        // As above: the stored `name` is the item's own description (provenance), and `nonPayable: true` is
        // the flag that keeps 417d4937's read-time label repair off it.
        if (c.nonPayable) { recordLines.push({ code: c.code, name: c.name, amount: applied, nonPayable: true }); continue; }
        // ── Feedback 09b554e9: declared Normal/Additional remuneration, with per-code annual exemption ──
        // The exempt portion (up to the PCB code's remaining annual headroom; cap -1 = fully exempt,
        // cap 0 = fully taxable) is PAID but stays out of every statutory base (the reimburse bucket);
        // the taxable remainder rides the declared stream: normal → the Y1 wage bucket, additional → the
        // Yt bonus bucket. EPF Bonus 2012 forces the bonus (additional-remuneration EPF) routing regardless
        // of the SOCSO flag — the amount is a bonus payment for EPF purposes (and bonuses sit outside
        // SOCSO/EIS by law). Legacy rows (both null/false) fall through to the flag inference unchanged.
        const stream = c.epfBonus2012 ? 'additional' : c.pcbRemunerationType;
        if (stream === 'normal' || stream === 'additional') {
          let taxable = applied;
          const code = c.pcbExemptionCode; // optional_deduction already consumed above — always a PCB_* code here
          if (code != null) {
            const cap = exemptionTables.pcb[code] ?? 0;
            const exempt = cap === 0 ? 0 : round2(Math.min(applied, roomFor(code, cap)));
            if (exempt > 0) {
              taxable = round2(applied - exempt);
              reimburse = round2(reimburse + exempt);
              contributes('reimburse', exempt);
              useRoom(code, exempt);
            }
          }
          if (stream === 'normal') {
            wageAllow = round2(wageAllow + taxable);
            contributes('wage', taxable);
            if (c.hrdf) hrdfAllow = round2(hrdfAllow + taxable);
            // ── Feedback 017d9c25 (r187) — THE FIX. ──────────────────────────────────────────────────
            // The declaration above chose the STREAM (Y1 vs Yt: a PCB question, and the payslip box).
            // It does NOT get to answer the agency question as well. Before r187 it did — reaching this
            // `continue` skipped the epf/socso flag inference entirely, so an allowance ticked "not
            // subject to EPF" and classified 'normal' was charged EPF anyway (measured on production:
            // A0013's 2026-01 slip charged EPF on 7,552.00 instead of 5,952.00, employee 836 vs 660).
            // The ticks are now carried to the statutory call as base carve-outs; routing is unchanged,
            // so gross, net-before-statutory, the payslip boxes and the PCB stream are all untouched.
            if (!c.epf) epfWageExcluded = round2(epfWageExcluded + taxable);
            if (!c.socso) socsoWageExcluded = round2(socsoWageExcluded + taxable);
          } else {
            bonusAmt = round2(bonusAmt + taxable);
            contributes('bonus', taxable);
            // Same rule on the additional stream. `epfBonus2012` codes are validated to require
            // includedInEpf (core/pay-components.ts `epfBonusRequiresEpf`), so they never carve EPF out.
            if (!c.epf) epfAdditionalExcluded = round2(epfAdditionalExcluded + taxable);
            // The SOCSO leg is the ADDING one, and the only place r187 increases a contribution:
            // Overtime 1.5 on this tenant is ticked "not EPF, yes SOCSO/EIS" but classified
            // 'additional', so before r187 it was charged EPF and left OUT of SOCSO/EIS — the exact
            // opposite of its own settings, in both directions.
            //
            // `epfBonus2012` IS THE EXCEPTION, and deliberately so. Every other flag on a pay item is
            // the operator answering "is this in that agency's base"; epfBonus2012 is the operator
            // saying "this money IS a bonus" (it forces the additional-remuneration EPF rate). SOCSO
            // Act 1969 s.2 excludes a bonus from wages, so a declared bonus stays out of SOCSO/EIS even
            // if its SOCSO box is ticked — honouring the tick there would compute an illegal
            // contribution. The seeded BONUS code carries epfBonus2012, so the ordinary bonus is
            // covered by this without anyone having to know the rule. Pinned by the golden test in
            // test/pcb-classification.test.ts ("EPF Bonus 2012 … routes the amount down the
            // additional-remuneration EPF path"), which asserts the RM4,000-band SOCSO share.
            if (c.socso && !c.epfBonus2012) socsoWageExtra = round2(socsoWageExtra + taxable);
          }
          continue;
        }
        if (c.epf && c.socso) { wageAllow = round2(wageAllow + applied); contributes('wage', applied); if (c.hrdf) hrdfAllow = round2(hrdfAllow + applied); }
        else if (!c.epf && c.socso) { ot = round2(ot + applied); contributes('ot', applied); }
        else if (c.epf && !c.socso) { bonusAmt = round2(bonusAmt + applied); contributes('bonus', applied); }
        else { reimburse = round2(reimburse + applied); contributes('reimburse', applied); } // all-false earning: paid but untaxed
      }
      return { basicRaw, basicGross, allowanceApplied: wageAllow, hrdfAllowApplied: hrdfAllow, overtime: ot, bonus: bonusAmt, reimburse, deduct, epfWageExcluded, epfAdditionalExcluded, socsoWageExcluded, socsoWageExtra, epfWageDeduction, socsoWageDeduction, pcbWageDeduction, hrdfWageDeduction, recordLines, componentLines, lpDeclared, exemptionUsed, display, displayMoved, displayOtOutbound, orpUnpaidLeaveExtra };
    };

    /**
     * Feedback 6b134681 — THE BONUS-ONLY SUBSET OF A RUN'S COMPONENT LINES.
     *
     * An additional/off-cycle run pays ONLY its additional remuneration: `slipBasic`/`slipAllowance`/
     * `slipOvertime` are forced to 0 and `grossPay` is `round2(bonus)` (see the payslip amounts below).
     * But `earningsOf` folds the SAME recurring components on that run as on the regular one, so
     * `componentLines` describes a whole month of pay — which is exactly why stamping the full list on an
     * additional run would list a month's allowances a second time under a payslip that paid none of them.
     *
     * The fix the reporter needs is narrower than that objection: keep only the lines that contributed to
     * the `bonus` bucket, and only their bonus contributions. What survives is precisely the money this run
     * paid, so:
     *
     *   Σ (retained bucket amounts) = `en.bonus` = the payslip's bonus column = its gross.
     *
     * That identity is why the itemised rows can never disagree with the figure above them (the display
     * overlay is regular-run only, so `payslipDisplayEarnings` falls back to the stored column here and
     * `payItemLinesReconcile` passes on all three renderers by construction, not by luck).
     *
     * THE `amount` IS RE-SUMMED, NOT COPIED. A stored line's `amount` is the whole resolved figure BEFORE
     * it was split across buckets, and Transaction View's grid renders `l.amount` rather than the bucket
     * sum (history-pivot.ts item rows). Copying it through would print a split item's FULL month value on
     * a run that paid only its bonus leg — a bigger number than the payslip, on the screen that exists to
     * reconcile them.
     */
    const bonusOnlyComponentLines = (lines: PayComponentLine[]): PayComponentLine[] => {
      const out: PayComponentLine[] = [];
      for (const l of lines) {
        const buckets = l.buckets.filter((b) => b.bucket === 'bonus');
        if (buckets.length === 0) continue;
        out.push({ ...l, amount: round2(buckets.reduce((s, b) => s + b.amount, 0)), buckets });
      }
      return out;
    };

    /** Age at the period end; null when DOB is not captured (treated as < 60). */
    const ageAt = (dob: string | null): number | null => {
      if (!dob) return null;
      const d = new Date(`${dob}T00:00:00Z`);
      const ref = new Date(`${periodEnd}T00:00:00Z`);
      let age = ref.getUTCFullYear() - d.getUTCFullYear();
      if (
        ref.getUTCMonth() < d.getUTCMonth() ||
        (ref.getUTCMonth() === d.getUTCMonth() && ref.getUTCDate() < d.getUTCDate())
      ) {
        age -= 1;
      }
      return age;
    };

    const totals = {
      gross: 0, net: 0, epfEmployee: 0, epfEmployer: 0, socsoEmployee: 0,
      socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0, pcb: 0, hrdfEmployer: 0,
      deductions: 0, employerCost: 0,
    };

    // Selective reprocess (9bc442bc, reporter #5/#6/#8): before recomputing, snapshot + ROW-LOCK the
    // subset's existing payslips (optimistic-concurrency + before/after audit), tally their OLD
    // contribution for the delta-totals update, then delete them so the loop below re-inserts fresh
    // rows. `FOR UPDATE` locks ONLY these rows — unrelated employees' payslips stay unlocked, so a
    // concurrent reprocess of a different subset never blocks (and a concurrent reprocess of the SAME
    // employee serialises and re-reads the bumped version).
    const oldTotals = { ...totals };
    const versionByEmp = new Map<string, number>();
    const beforeByEmp = new Map<string, Record<string, unknown>>();
    if (subset) {
      if (emps.length === 0) throw new Error('None of the selected employees are active in this period.');
      const subsetIds = emps.map((e) => e.employmentId);
      const existing = await tx
        .select()
        .from(payslip)
        .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, subsetIds)))
        .for('update');
      for (const sl of existing) {
        versionByEmp.set(sl.employmentId, sl.version);
        const st = (sl.statutory ?? {}) as Record<string, number>;
        beforeByEmp.set(sl.employmentId, {
          grossPay: sl.grossPay, netPay: sl.netPay, totalDeductions: sl.totalDeductions,
          employerCost: sl.employerCost, statutory: sl.statutory, version: sl.version,
        });
        oldTotals.gross += Number(sl.grossPay);
        oldTotals.net += Number(sl.netPay);
        oldTotals.deductions += Number(sl.totalDeductions);
        oldTotals.employerCost += Number(sl.employerCost);
        oldTotals.epfEmployee += Number(st.epfEmployee ?? 0);
        oldTotals.epfEmployer += Number(st.epfEmployer ?? 0);
        oldTotals.socsoEmployee += Number(st.socsoEmployee ?? 0);
        oldTotals.socsoEmployer += Number(st.socsoEmployer ?? 0);
        oldTotals.eisEmployee += Number(st.eisEmployee ?? 0);
        oldTotals.eisEmployer += Number(st.eisEmployer ?? 0);
        oldTotals.pcb += Number(st.pcb ?? 0);
        oldTotals.hrdfEmployer += Number(st.hrdf ?? 0);
      }
      await tx.delete(payslip).where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, subsetIds)));
    }

    // 1e — apply the policy OT caps to a prefilled OT total. Uses the stored rate-bucket decomposition
    // (otBreakdown) when present so eligible-day-type filtering + multiplier re-rating are exact; when only a
    // flat figure exists, the breakdown is the whole total as a workday leg (so maxAmount still bites and a
    // workday-only restriction is a no-op). Default (no OT config) ⇒ returns `total` unchanged.
    // Returns the capped OT figure AND the excess the HOUR/AMOUNT caps removed (Step 4 f3148da1 reroutes the
    // excess onto a pay item when configured). Default (no OT config) ⇒ { capped: total, excess: 0 }.
    const applyOvertimeCapsForEmp = (cfg: PayrollPolicyConfig | null, employmentId: string, total: number): { capped: number; excess: number } => {
      if (!cfg?.overtime || total <= 0) return { capped: total, excess: 0 };
      const bd = otBreakdownByEmp.get(employmentId) as { flat: number; normal: number; rest: number; holiday: number } | null;
      // Map the stored buckets onto the three OT day types. `flat` (a hand-keyed lump with no day type) rides
      // the workday leg so it is still capped by maxAmount but not zeroed by a rest/holiday-only restriction.
      const parts = bd
        ? { workday: round2(bd.normal + bd.flat), restDay: round2(bd.rest), holiday: round2(bd.holiday), workedOtHours: 0 }
        : { workday: total, restDay: 0, holiday: 0, workedOtHours: 0 };
      const d = applyOvertimeCapsDetailed(cfg, parts);
      return { capped: d.capped, excess: d.excess };
    };

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // r226 — AN ADDITIONAL RUN PROCESSES ONLY THE PEOPLE IT HAS SOMETHING TO DO FOR
    // ══════════════════════════════════════════════════════════════════════════════════════════════
    //
    // THE WHOLE OF THE SKIP IS THIS ONE REASSIGNMENT OF `emps`, and that is the point rather than a
    // shortcut. Everything a run does to a person downstream of here — the payslip insert, the CONSUMED
    // marker on their one-off transactions, the claim-paid set, `employeeCount`, the processed event's
    // `count`, the returned `payslips` — is already keyed off `emps`. Narrowing the list is therefore the
    // only way to skip somebody that cannot leave a side effect behind for a person with no payslip. A
    // filter applied at the insert alone would have stamped their bonus CONSUMED by a run that never paid
    // it, and the amount would have disappeared with no payslip anywhere and no error.
    //
    // WHY IT IS ASKED HERE AND NOWHERE EARLIER: every input this run could pay has now been read — the
    // recurring and batch pay components, the one-off transaction ledger (including the rows
    // attach-on-generate stamped onto this run moments ago), payroll_input, and the manual statutory
    // overrides. Nothing between here and the payslip loop adds money.
    //
    // REGULAR RUNS ARE NEVER ASKED. A salaried employee has zero rows in the transaction tables — their
    // money IS the compensation record — so "skip anyone with no transaction" on a regular run would stop
    // paying almost the whole company. Nor is a SUBSET reprocess asked: it recomputes payslips that
    // already exist on a processed run, and taking somebody OFF a processed run is
    // `removeEmployeesFromBatch`'s job, with its own reason, audit trail and ledger release.
    //
    // ── WHERE THE LINE IS DRAWN, AND WHY IT IS NOT DRAWN AT "WILL THIS RUN PAY A RINGGIT" ──────────
    //
    // An additional run's gross IS the bonus bucket and nothing else (`grossPay = round2(bonus)`; basic,
    // allowance, overtime and the unpaid deduction are forced to 0, the one-off OT and unpaid rows fold to
    // 0, the manual deduction / CP38 / loan are 0, and a prefilled claim rides the allowance line that is
    // zeroed). So the STRICTEST possible predicate is "does anything route to the bonus bucket" — and that
    // is deliberately NOT what is asked of the rows keyed against this run. Two reasons, the second decisive:
    //
    //   • THE REASON WE PRINT HAS TO BE TRUE. A skipped employee is reported as "No transaction entry for
    //     this payroll cycle". Skipping somebody who DOES have a transaction on this run — an operator keys
    //     a one-off earning for the Bonus cycle, and the kernel routes an uncomponented one-off into the
    //     wage bucket that an additional run zeroes — would print that sentence beside a transaction they
    //     can see on the screen they keyed it on. That reads as the system having lost their entry, which
    //     is a worse failure than the zero payslip this change exists to remove.
    //   • THE BIAS MUST POINT AT PROCESSING. A false "has something" costs one zero payslip, which is
    //     exactly today's behaviour. A false "has nothing" costs somebody their money.
    //
    // What IS trimmed is the one door every employee has and no additional run pays: the RECURRING pay
    // components (`employment_pay_component` — the Pending money card's `fixedComponent` door). Those are
    // standing monthly pay, re-folded by every run and paid by the regular one; on an additional run they
    // land in the allowance line that is forced to 0. Counting them would keep every employee in every run
    // and the feature would skip nobody. They count ONLY when they route to the bonus bucket. That single
    // trim is the modification the plan's build note demands — the raw doors OVERSTATE what an additional
    // run pays, and this is the door where the overstatement is total.
    const skippedEmployees: SkippedEmployee[] = [];
    if (!subset && isAdditionalRun) {
      // Rows keyed AGAINST THIS RUN, read from the tables rather than from the flag-gated maps above.
      // Deliberate: "does this person have a transaction on this run" is a fact about the data, not about
      // whether TYPED_PAY_COMPONENTS_ENABLED / INDIVIDUAL_TXN_PAY_ENABLED happen to be on. A row that
      // exists but is inert under today's flags is still a transaction the operator keyed and can see —
      // the pending-money card counts exactly those as `inertRows` — so it must never be answered with
      // "no transaction entry for this payroll cycle".
      const batchCompEmps = await tx
        .select({ employmentId: payrollBatchComponent.employmentId })
        .from(payrollBatchComponent)
        .where(and(eq(payrollBatchComponent.batchId, p.batchId), ne(payrollBatchComponent.amount, '0')));
      const batchTxnEmps = await tx
        .select({ employmentId: payrollIndividualTxn.employmentId })
        .from(payrollIndividualTxn)
        .where(and(eq(payrollIndividualTxn.batchId, p.batchId), ne(payrollIndividualTxn.amount, '0')));
      // A row attach-on-generate stamped onto this batch a few statements ago is ON this batch by the time
      // this reads it, so its owner is always found here and can never be skipped. That is why the attach
      // needs no undo: this run cannot park a period-keyed transaction on itself and then walk away from
      // the person who owns it, leaving a row `batch_id IS NULL` collection can never claim again.
      const hasRunRow = new Set([...batchCompEmps, ...batchTxnEmps].map((r) => r.employmentId));

      /** Does this run have anything at all to do for this employee? */
      const hasWork = (employmentId: string): boolean => {
        // (a) A pay component or a one-off transaction keyed against THIS run.
        if (hasRunRow.has(employmentId)) return true;
        // (b) Any of the six payroll_input doors carrying a figure on this run. Four of them (overtime,
        //     claim, loan, and — with typed components on — bonus) are not paid by an additional run and
        //     are counted anyway, under the "the reason has to be true" rule above. A KEYED tp1/zakat IS
        //     charged on an additional run (an operator override rides `lp` / `effectiveZakat` into the
        //     statutory delta), so those two would have to be here in any case — and since item 3fa088fb
        //     the DERIVED legs are regular-run only, which only ever makes this door count MORE people
        //     than the run pays, never fewer. payroll_input holds one row per employment on the batch, so
        //     these six maps are that whole table.
        if (
          Math.abs(round2(overtimeByEmp.get(employmentId) ?? 0)) > 0 ||
          Math.abs(round2(bonusByEmp.get(employmentId) ?? 0)) > 0 ||
          Math.abs(round2(claimAllowanceByEmp.get(employmentId) ?? 0)) > 0 ||
          Math.abs(round2(loanByEmp.get(employmentId) ?? 0)) > 0 ||
          Math.abs(round2(tp1ByEmp.get(employmentId) ?? 0)) > 0 ||
          Math.abs(round2(zakatByEmp.get(employmentId) ?? 0)) > 0
        ) {
          return true;
        }
        // (c) A RECURRING pay item, and ONLY when it routes to the bucket this run actually pays — the one
        //     trimmed door. `paysOnAdditionalRun` mirrors `earningsOf`'s routing term for term, and is a
        //     shared function precisely so the two cannot drift.
        if ((recurringByEmp.get(employmentId) ?? []).some((c) => paysOnAdditionalRun(c))) return true;
        // (d) A manual statutory override keyed against THIS run is an explicit instruction to it: it
        //     changes a figure on the payslip it is stamped on, so that payslip has to exist.
        if (statutoryAdjustmentByEmp.has(employmentId)) return true;
        return false;
      };

      // ── r227 GATE 2 — WHICH REASON IS TRUE OF THIS PERSON ────────────────────────────────────────
      //
      // r226 printed ONE reason for every skip: "No transaction entry for this payroll cycle". For most
      // of the skipped that is exactly right. For one population it is FALSE ON SCREEN, and the plan the
      // reporter approved promised it could not be.
      //
      // THE POPULATION. `hasWork` counts a RECURRING pay item only when it routes to the bonus bucket
      // (the one door trimmed above — see (c)). So somebody whose only pending money is a standing
      // monthly allowance is skipped. But the draft screen's "what will this run pay" card
      // (`pendingBatchMoney`, core/payroll-view.ts) lists that same allowance BY NAME under its
      // `fixedComponent` door. The operator therefore reads "Ada Lim — Monthly allowance RM400" on the
      // run they are about to process, and then "Ada Lim — No transaction entry for this payroll cycle"
      // on its result. One of those two sentences is a lie, and it is this one.
      //
      // THE FIX IS THE REASON, NOT THE SKIP. Skipping them is correct — an additional run's gross IS the
      // bonus bucket, and a standing allowance lands in the allowance line it forces to 0, so processing
      // them would write back exactly the zero payslip this whole change exists to remove. What has to
      // change is the sentence printed beside their name. `PayrollSkipReason` was made a VALUE rather
      // than a boolean in r226 for precisely this: a second cause costs the readers nothing.
      //
      // MIRRORED ON THE CARD'S OWN GATE, DELIBERATELY. `recurringByEmp` is populated only when
      // TYPED_PAY_COMPONENTS_ENABLED is on, and the card's `fixedComponent` door is gated on the SAME
      // flag — with the flag off it reports those rows as a bare `inertRows` COUNT and names nobody, so
      // there is no named contradiction to answer and the original reason stands. Reading the table
      // directly here (as `hasRunRow` does, and for good reason) would answer a contradiction the screen
      // never made, and would say "not additional remuneration" about a bonus-routing item that only the
      // flag is holding back. The two must agree about what the OPERATOR WAS SHOWN, not about what rows
      // exist — so this reads the same flag-gated map the skip predicate itself reads.
      //
      // A ZERO amount is not on the card either (`push` drops it), hence the same `> 0` filter; a ruled
      // item stored as 0 never reaches here at all, because `paysOnAdditionalRun` already kept its owner.
      const standingPayNotPaidHere = (employmentId: string): boolean =>
        (recurringByEmp.get(employmentId) ?? []).some(
          (c) => c.code !== 'BASIC' && Math.abs(Number(c.amount)) > 0,
        );

      const working = emps.filter((e) => hasWork(e.employmentId));
      if (working.length !== emps.length) {
        const workingIds = new Set(working.map((e) => e.employmentId));
        const skippedIds = emps.filter((e) => !workingIds.has(e.employmentId)).map((e) => e.employmentId);

        // ── r227 — THE FAIL-CLOSED GUARD THE SKIP WAS SWALLOWING ─────────────────────────────────
        //
        // `UnsupportedPayComponentError` (ADR-0025 §5) is the last line of defence against a pay item
        // v1 cannot compute correctly — a PCB-taxable BIK, or a PCB-only earning that is neither EPF nor
        // SOCSO. It is thrown from INSIDE the per-employee component loop, which for a skipped employee
        // no longer runs. And the two unsupported shapes are exactly the shapes `paysOnAdditionalRun`
        // answers "pays nothing" for (a non-payable row is rejected outright; a not-EPF-not-SOCSO row
        // fails the flag inference), so the skip does not merely *sometimes* hide this error — it hides
        // it in every case it can occur. A misconfigured item that used to abort the run would instead
        // produce a quietly short run, which is the precise failure mode the guard exists to prevent.
        //
        // So the classification is checked for everyone about to be dropped, BEFORE `emps` is narrowed
        // and therefore before any payslip is written. The condition below is the throw's own condition
        // read term for term, including the three `continue`s that precede it in the loop (BASIC is
        // inert; an optional_deduction is consumed earlier; a deduction returns earlier), and it reads
        // no amount at all — neither does the throw.
        //
        // BATCH components are checked too even though a non-zero one keeps its owner in the run: a
        // ZERO-amount batch component row is excluded by `hasRunRow`'s `ne(amount, '0')`, so its owner
        // CAN be skipped, and the loop would have validated it.
        const unsupported = (c: {
          code: string;
          kind: string;
          nonPayable: boolean;
          epf: boolean;
          socso: boolean;
          pcb: boolean;
          pcbRemunerationType: 'normal' | 'additional' | 'optional_deduction' | null;
        }): boolean =>
          c.code !== 'BASIC' &&
          c.pcbRemunerationType !== 'optional_deduction' &&
          c.kind !== 'deduction' &&
          c.pcb &&
          c.pcbRemunerationType == null &&
          (c.nonPayable || (!c.epf && !c.socso));
        for (const id of skippedIds) {
          for (const c of [...(recurringByEmp.get(id) ?? []), ...(batchCompByEmp.get(id) ?? [])]) {
            if (unsupported(c)) throw new UnsupportedPayComponentError(c.code);
          }
        }

        emps = working;

        // NAME THEM. A count is not an account of who was left out — the whole ask was to be able to check
        // the absent forty against the five that were expected, by name.
        const named = await tx
          .select({ id: employment.id, name: person.fullName, employeeCode: employment.employeeCode })
          .from(employment)
          .innerJoin(person, eq(person.id, employment.personId))
          .where(inArray(employment.id, skippedIds));
        const nameById = new Map(named.map((r) => [r.id, r]));
        for (const id of skippedIds) {
          const row = nameById.get(id);
          skippedEmployees.push({
            employmentId: id,
            name: row?.name ?? id,
            employeeCode: row?.employeeCode ?? null,
            reason: standingPayNotPaidHere(id) ? 'NO_ADDITIONAL_PAY_THIS_RUN' : 'NO_TRANSACTION_FOR_CYCLE',
          });
        }
        skippedEmployees.sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    for (const e of emps) {
      // 2.1.1 (ADR-0064) — the resolved policy config for this employment (null ⇒ legacy path unchanged).
      const cfg = policyConfigByEmp.get(e.employmentId) ?? null;
      // Prorate contractual pay for mid-period joiners/leavers (full month → factor 1).
      // Allowance prorates with basic — EA-1955 incomplete-month treats fixed monthly wages as a whole.
      // 1b — the divisor + working-day basis come from the policy (default ⇒ EA s.18A calendar daysInMonth).
      // 3c88d593 — the tenure window is narrowed to this employer's entity segment before it reaches the
      // proration formula, and NOTHING ELSE about the formula changes: the divisor, the working-day basis
      // and the cut-off window are still whatever the employee's own policy resolved. Two segments of one
      // calendar month therefore prorate against the SAME denominator and sum to the whole month's pay —
      // which is what makes "1–10 under Fiamma plus 11–31 under ISEDECOR" add up to one August salary
      // rather than to one-and-a-bit, and what would NOT have been true had each run prorated against its
      // own segment length. `prorationSettings` deliberately still reads the REAL hire/termination dates
      // (isHire / isResign above): a transfer is not a resignation, and it must not silently switch an
      // employer onto their "Resigned Employee Basic Salary Formula".
      const factor = prorationFactor(payPeriod, segHiredOn(e), segTerminatedOn(e), prorationOptsByEmp.get(e.employmentId));
      // 2.1.2 — a daily-rated employee is paid rate × eligible days; the monthly proration basis does not apply.
      // Surface the eligible-day count as `daysWorked` (a real day count, not factor×dim) for the daily path.
      const daily = dailyPayByEmp.get(e.employmentId) ?? null;
      // ADR-0078 — hourly pay mode mirrors the daily override: basic = rate × attendance hours; daysWorked
      // keeps the factor-based surface (attendance days are not the proration basis for an hourly worker).
      const hourly = hourlyPayByEmp.get(e.employmentId) ?? null;
      const daysWorked = daily ? daily.eligibleDays : Math.round(factor * dim); // proration basis surfaced on the payslip
      // Earnings come from the typed components (flag on) or compensation + payroll_input (flag off).
      // Either way these reproduce the same variables, so the agency-base math below is unchanged.
      const en = earningsOf(e, factor);
      // 1c — salary-increment proration: when the policy enables it AND a mid-period increment straddles the
      // period, the basic is the two-row blend (already day-weighted across the increment date), NOT
      // basic×factor. Default (off / no straddle) ⇒ undefined ⇒ the kernel's normal basicGross is used.
      // 2.1.2 — for a daily pay mode, basic = per-day rate × eligible days (no proration, no increment
      // blend); hourly = per-hour rate × worked hours. D4's period-boundary rule means a mode never changes
      // mid-period, so these overrides and the increment blend cannot both legitimately fire.
      const incrementBasic = incrementBasicByEmp.get(e.employmentId);
      const basicRaw = daily ? daily.basic : hourly ? hourly.basic : (incrementBasic ?? en.basicRaw);
      const basic = daily
        ? daily.basic
        : hourly
          ? hourly.basic
          : incrementBasic !== undefined
            ? round2(incrementBasic)
            : en.basicGross;
      // 1e — OT caps: wrap the prefilled/keyed OT figure with the policy's caps (eligible day types, max
      // hours, max amount, floored multiplier). Default (no overtime config) ⇒ the figure is unchanged.
      // f1564110 Phase 3 — one-off 'overtime' ledger rows ADD to the OT figure BEFORE the caps (flag off ⇒
      // txnOt is 0 ⇒ byte-identical). Regular run only: an additional/off-cycle run pays no OT (slipOvertime
      // is zeroed and its statutory delta reads the regular run's OT), so folding there would distort nothing
      // but is skipped for clarity.
      const txnOt = isAdditionalRun ? 0 : round2(txnOtByEmp.get(e.employmentId) ?? 0);
      const otCap = applyOvertimeCapsForEmp(cfg, e.employmentId, round2(en.overtime + txnOt));
      const overtime = otCap.capped;
      // Step 4 (f3148da1) — OT exceed handling. When the policy configures "convert excess to pay item" AND a
      // valid component was resolved, the amount the HOUR/AMOUNT caps cut off is redirected to that pay item so
      // it is still paid to the employee (regular run only — an additional/off-cycle run carries no OT).
      // Statutory character: the excess retains OVERTIME's treatment (SOCSO/EIS/PCB base, EPF-exempt) — the
      // legally-correct treatment for overtime remuneration — while the chosen component controls the payslip
      // line label/name. Default (no exceedHandling / no excess) ⇒ 0 ⇒ byte-identical.
      const otConvertComp = otConvertByEmp.get(e.employmentId);
      const otConvertAmount = !isAdditionalRun && otConvertComp ? round2(otCap.excess) : 0;
      // Allowance line: wage-bucket non-basic components (incl. the taxable claim) + any all-false
      // "reimbursement" earning (paid but untaxed) + the converted OT excess (paid; taxed via the OT stat leg).
      const allowance = round2(en.allowanceApplied + en.reimburse + otConvertAmount);
      const bonus = en.bonus;
      // Unpaid leave deducts at the EA-1955 ordinary rate of pay (monthly basic / divisor days). 1f — the
      // divisor is policy-configurable (default calendar_month ⇒ `dim`, byte-identical).
      const unpaidDivisor = leaveDivisorDays(cfg?.leave?.unpaidLeaveDivisor, cfg, {
        calendarDaysInMonth: dim,
        cutoffDays: salaryCutoffDaysByEmp.get(e.employmentId) ?? dim, // c7fdfcf6 — salary cut-off window length; calendar fallback = dim
        workingDays: workingDaysInPeriodFor(e.employmentId),
      });
      // f3148da1 Step 5 (R17 gap-fix reinstatement) — the Unpaid Time Off Deduction Formula. When the policy
      // configures a distinct unpaidTimeOffDivisor, the PARTIAL-DAY unpaid subset (half-day / hourly requests)
      // deducts at its own per-day rate (day divisor, or per-hour/per-minute × the 8h standard day) while the
      // remaining FULL-DAY unpaid days keep the unpaidLeaveDivisor rate. No distinct divisor (the default) ⇒
      // timeOffRate is null and the whole figure stays the single legacy expression, byte-identical.
      const unpaidDaysAll = unpaidByEmp.get(e.employmentId) ?? 0;
      const timeOffDays = Math.min(unpaidTimeOffByEmp.get(e.employmentId) ?? 0, unpaidDaysAll);
      // ── 711adcd2 (migration 0456) — THE UNPAID-LEAVE ORP BASE. ────────────────────────────────────
      // Until now this base was `basicRaw` and nothing else, on every one of the three rates below. It is
      // now `basicRaw` PLUS the pay items an operator has ticked "Add to Unpaid Leave ORP Calculation"
      // (earningsOf accumulates them; core/pay-rule.ts payItemFeedsUnpaidLeaveOrp is the predicate).
      //
      // THE ZERO SHORT-CIRCUIT IS THE BYTE-IDENTITY GUARANTEE, not an optimisation — the same device the
      // `absentDays === 0` line below uses. 0456 backfills the column false on every row, so `extra` is 0
      // on release day and this expression IS `basicRaw`, the identical `number` value, never a `round2`
      // of it that could differ in the last place. Only an operator deliberately ticking a box makes the
      // arithmetic change, which is the promise the approved plan made.
      //
      // WHY IT MATTERS MORE HERE THAN ON THE OVERTIME SIDE: `unpaidDeduction` is PRE-statutory (wagesExOt
      // and hrdfBase subtract it below), so raising this base does not only raise the deduction — it lowers
      // the EPF, SOCSO, EIS, PCB and HRDF bases with it. The screen says so where the box is ticked.
      const orpUnpaidBase =
        en.orpUnpaidLeaveExtra === 0 ? basicRaw : round2(basicRaw + en.orpUnpaidLeaveExtra);
      const timeOffRate =
        timeOffDays > 0
          ? unpaidTimeOffDailyRate(orpUnpaidBase, cfg, {
              calendarDaysInMonth: dim,
              cutoffDays: salaryCutoffDaysByEmp.get(e.employmentId) ?? dim,
              workingDays: workingDaysInPeriodFor(e.employmentId),
            })
          : null;
      // 2.1.2 — a daily wage already pays ONLY eligible worked days, so an unpaid-leave day is simply not a
      // worked day (never counted into `basic`); deducting again off basicRaw/divisor would double-count it.
      // f1564110 Phase 3 — one-off 'unpaid' ledger rows ADD their keyed RM amount to the unpaid deduction
      // (pre-statutory: it reduces wagesExOt/hrdfBase like derived unpaid leave). Flag off ⇒ txnUnpaid is 0 ⇒
      // byte-identical. Regular run only (an additional run charges no unpaid, like cp38/hrdf). Applied even
      // on the daily path — a keyed amount is an explicit instruction, not the derived not-a-worked-day case.
      const txnUnpaid = isAdditionalRun ? 0 : round2(txnUnpaidByEmp.get(e.employmentId) ?? 0);
      const unpaidLeaveAmount = daily
        ? 0
        : timeOffRate !== null
          ? round2((orpUnpaidBase / unpaidDivisor) * (unpaidDaysAll - timeOffDays) + timeOffRate * timeOffDays)
          : round2((orpUnpaidBase / unpaidDivisor) * unpaidDaysAll);
      // e2632276 — ABSENCE, at exactly the unpaid-leave daily rate: the same `basicRaw` (the UNFACTORED
      // monthly basic, so the rate is not shortened for a mid-month joiner or leaver) over the same
      // policy-configured `unpaidDivisor`, rounded ONCE on the amount — the per-day rate is never rounded
      // first. absentByEmp is empty unless the employment's policy sets leave.deductAbsentDays, so this is
      // 0 and the whole expression below is byte-identical to the pre-flag one.
      //
      // The daily/hourly guard is inherited deliberately: a daily wage already pays only worked days, so an
      // absent day is simply not a worked day and deducting off basicRaw/divisor would charge it twice —
      // the identical reasoning the `daily ? 0` unpaid branch has always used.
      // e2632276 — THE SWITCH for this employment, read off the config already resolved above. It gates the
      // count (absentByEmp is only populated for switched-on employments) AND the payslip stamps below.
      const deductAbsentDays = cfg?.leave?.deductAbsentDays === true;
      const absentDays = daily ? 0 : (absentByEmp.get(e.employmentId) ?? 0);
      // The `absentDays === 0` short-circuit is not an optimisation, it is the byte-identity guarantee: it
      // keeps the switched-off path from evaluating `basicRaw / unpaidDivisor` at all, so no divisor value
      // — including a pathological 0, which would make `Infinity * 0` NaN and poison `unpaidDeduction` —
      // can change a figure on a payslip nobody switched this on for.
      // e2632276's ABSENCE rate is "exactly the unpaid-leave daily rate", so 711adcd2's base change rides
      // it deliberately: two different bases for one rate would be a second definition of the same number.
      const absentAmount = daily || absentDays === 0 ? 0 : round2((orpUnpaidBase / unpaidDivisor) * absentDays);
      // Both halves ride INSIDE unpaidDeduction on purpose: wagesExOt and hrdfBase below subtract it, which
      // is what makes the absence deduction PRE-statutory (EPF / SOCSO / EIS / PCB are worked out on the
      // reduced wage) — the treatment a `kind='deduction'` pay code could never have, because a pay code is
      // applied after the statutory calculation. See the item's build note.
      const unpaidDeduction = round2(unpaidLeaveAmount + absentAmount + txnUnpaid);
      const normalWage = round2(basic + allowance + overtime); // regular monthly remuneration
      // Agency bases differ (STATUTORY-SOURCES §6): EPF EXCLUDES overtime, SOCSO/EIS/PCB
      // include it — so the calculator takes wages ex-OT and the OT separately. The all-false
      // reimbursement is paid (in `allowance`/gross) but NOT in any statutory base.
      const wagesExOt = Math.max(0, round2(basic + en.allowanceApplied - unpaidDeduction));
      // Bonus is additional remuneration: EPF + PCB (difference method), excluded from SOCSO/EIS.
      // LP₁ — this month's optional deductions: the approved TP1 amounts PLUS the declared
      // optional-deduction pay codes (feedback 09b554e9; capped per LP code in earningsOf). Charged on the
      // REGULAR run only, like cp38/hrdf — an additional run re-folds the same recurring components and
      // would otherwise double-claim the month's LP.
      // ── Item 3fa088fb — LP₁, in the two tiers zakat already has (precedence §0.4) ──────────────────
      //  1) a KEYED `payroll_input.tp1_deduction` whose provenance is not 'tp1_self' is an operator
      //     override of THIS run and wins outright — on a regular run and on an additional one alike,
      //     because a figure somebody typed against a payslip is an instruction about that payslip.
      //  2) otherwise the employee's OWN approved TP1, derived above from the declaration itself. No
      //     button, nothing to remember. Regular run only; the block above says why, at length.
      // A 'tp1_self' row is NOT tier 1: it is a copy the Prefill button left on the draft, and the
      // derivation reproduces it from the same function — so an operator who prefilled and then had the
      // declaration corrected gets the CORRECTED figure rather than the stale copy.
      const tp1Keyed = round2(tp1ByEmp.get(e.employmentId) ?? 0);
      const tp1IsOverride = tp1SourceByEmp.get(e.employmentId) !== 'tp1_self' && tp1Keyed > 0;
      const tp1Feed = tp1FeedByEmp.get(e.employmentId);
      const tp1 = tp1IsOverride ? tp1Keyed : isAdditionalRun ? 0 : round2(tp1Feed?.feed ?? 0);
      const lp = round2(tp1 + (isAdditionalRun ? 0 : en.lpDeclared));
      const zakat = round2(zakatByEmp.get(e.employmentId) ?? 0);
      const age = ageAt(e.dateOfBirth);
      // HRD Corp levy (Wave 2A) — employer-only. Base = basic + FIXED (HRDF-flagged) allowance net of
      // unpaid leave; NOT the EPF/SOCSO wage (overtime, bonus, and reimbursed claims are excluded).
      const fixedAllowance = en.hrdfAllowApplied;
      // Feedback 2333b7fb — the HRDF leg of the deduction ticks is applied HERE and not inside
      // `statutory()`: the levy base is built by the kernel (basic + HRDF-flagged allowance − unpaid),
      // the pack only turns a base into a levy. `hrdfWageDeduction` is 0 unless a deduction pay item
      // carries "subject to HRDF" (UPL and DB018 do on production; ABSENT and MONTHLY PARKING do not),
      // so this is byte-identical for every run that has no such item.
      const hrdfBase = Math.max(0, round2(basic + fixedAllowance - unpaidDeduction - en.hrdfWageDeduction));
      // Feedback 0df0c635 — per-employee "Subject to HRDF" (Others Statutory card), resolved via the pack
      // (D6 vocabulary — no direct core→localization/my import). Explicit false excludes this employee's
      // base from the levy entirely; explicit true keeps it in (the registration band below still sets the
      // rate — not_registered stays 0); null follows the company default, byte-identical to pre-flag runs.
      const hrdfSubject = pack.payroll.hrdfSubject(e.subjectToHrdf ?? null, hrdfStatus);
      // #6: HRDF rates come from the resolved ruleset (rules.hrdf) when overridden, else the built-in MY_HRDF.
      const hrdf = hrdfSubject ? pack.payroll.hrdfLevy(hrdfBase, hrdfStatus, rules.hrdf) : 0;
      // r79 — the levy above is UNCHANGED (an unregistered employer owes nothing; r75 settled that). What
      // changes is what the SLIP claims: stamping `hrdfSubject: true` next to a levy that can never be
      // anything but zero makes the payslip contradict itself. Suppression is keyed on the REGISTRATION
      // band, not on the computed amount — a subject employee whose base happened to be zero (a fully
      // unpaid month) is genuinely subject and still stamps true.
      const hrdfChargeable = hrdfStatus !== 'not_registered';
      const suppressHrdfSubject = hrdfSubject && !hrdfChargeable;
      // 1.2.3 CP38 — the month's LHDN instalment. Charged on the REGULAR run only: like basic/OT/unpaid/hrdf,
      // an additional (off-cycle/bonus/adjustment) run carries cp38 = 0 (a re-issue re-runs the regular batch,
      // not an adjustment run). So a regular + bonus run in one month charges exactly one instalment.
      const cp38 = isAdditionalRun ? 0 : round2(cp38ByEmp.get(e.employmentId)?.amount ?? 0);
      // Statutory contribution. Regular run: computed directly as today (byte-identical). Additional run
      // (Wave 2C): the INCREMENT of the cumulative month — re-run with/without this run's additional
      // remuneration and take the delta, so the normal wage's SOCSO/EPF (already charged by the regular
      // run) cancels, SOCSO/EIS add 0, and PCB nets against earlier same-month MTD (ADR-0024 §4).
      // Item d64d0df4 — `disabled` is the employee's CIRCUMSTANCE; the deduction it entitles them to is a
      // figure in the pack's ruleset, applied inside pcbMonth. `?? false` keeps a row that predates
      // migration 0341 (or a person with no statutory row at all) computing exactly as it does today.
      // Item d64d0df4 — the CHILD leg. Only an employee in 'auto_table' mode supplies a worked-out
      // amount: the pack turns their keyed category grid into RM using the resolved ruleset's
      // per-category figures (halving any 50%-share child). 'manual' and 'auto' employees supply
      // `undefined`, and pcbMonth then computes `children × perChild` — the identical expression it used
      // before this item, so their projection of P is unchanged to the cent.
      const childReliefAmount =
        e.childReliefMode === 'auto_table' && pack.payroll.childReliefAmountFor
          ? pack.payroll.childReliefAmountFor(e.childReliefTable, rules.pcb?.reliefs)
          : undefined;
      const taxProfile = {
        category: (e.taxCategory ?? 1) as 1 | 2 | 3,
        children: e.numChildren ?? 0,
        disabled: e.disabledIndividual ?? false,
        // `?? false` keeps a row that predates migration 0356 (or a person with no statutory row at all)
        // computing exactly as it does today.
        disabledSpouse: e.disabledSpouse ?? false,
        childReliefAmount,
      };
      // Item a7271737 — persisted SOCSO / EIS category override. 'auto' reproduces the age/citizenship derivation
      // below byte-for-byte; 'first'/'second' pin the SOCSO band; 'none' gates the respective scheme off (exactly
      // like subject_to_socso=false / eis_eligible=false do — the setter also derives those legacy booleans from
      // the category, so this is belt-and-braces and stays correct even for a legacy row that predates the column).
      const socsoCatSel = (e.socsoCategory ?? 'auto') as 'auto' | 'first' | 'second' | 'none';
      const eisCatSel = (e.eisCategory ?? 'auto') as 'auto' | 'none';
      const autoSocsoCategory = ((age != null && age >= 60) || (e.epfCitizenship ?? 'citizen') === 'non_citizen' ? 2 : 1) as 1 | 2;
      const stOpts = {
        // SOCSO Second Category (employer Injury-only) for age 60+ AND foreign workers (#156); both
        // still pay the employee SKBBK leg. EIS (Act 800) is Malaysian 18–60 only — not 60+, not foreign.
        // 'auto' keeps that derivation; 'first'/'second' force the band (item a7271737).
        socsoCategory: (socsoCatSel === 'first' ? 1 : socsoCatSel === 'second' ? 2 : autoSocsoCategory) as 1 | 2,
        eisEligible:
          eisCatSel === 'none'
            ? false
            : (e.eisEligible ?? true) && (age == null || age < 60) && (e.epfCitizenship ?? 'citizen') !== 'non_citizen',
        // Item 5a461b99 — "Subject to SOCSO"/"Subject to SKBBK". Default on (a person with no statutory row
        // keeps today's SOCSO + mandatory SKBBK) so this is byte-identical for every currently-covered
        // employee; unchecking exempts that scheme (zero reported contribution). Item a7271737: SOCSO category
        // 'none' also gates SOCSO off (the two are kept in sync by the setter).
        subjectToSocso: socsoCatSel === 'none' ? false : (e.subjectToSocso ?? true),
        subjectToSkbbk: e.subjectToSkbbk ?? true,
        resident: e.isResident ?? true,
        // Item 8b5334db — resolve the flat PCB rate from tax residency (falling back to isResident for a legacy
        // row with no residency set). resident ⇒ null (full MTD); non_resident ⇒ 0.30 (identical to the old
        // resident:false path); rep / knowledge_worker ⇒ 0.15 (Returning Expert Programme / Knowledge Worker in a
        // specific region — flat incentive rate, no reliefs). Byte-identical for every existing resident/non-res row.
        flatTaxRate: (() => {
          const r = e.taxResidency ?? (e.isResident === false ? 'non_resident' : 'resident');
          if (r === 'non_resident') return 0.3;
          if (r === 'rep' || r === 'knowledge_worker') return 0.15;
          return null;
        })(),
        // EPF rule selection (#95): age + citizenship pick Part A / Part E senior / non-citizen 2%/2%.
        epfAge: age,
        epfCitizenship: e.epfCitizenship ?? 'citizen',
        // EPF contribution mode (Wave 2B): i-Topup excess / exempt. Rates are decimals; null = statutory.
        epfElection: {
          mode: e.epfMode ?? 'auto',
          employeeRate: e.epfEmployeeRate != null ? Number(e.epfEmployeeRate) : null,
          employerRate: e.epfEmployerRate != null ? Number(e.epfEmployerRate) : null,
        },
        // Feedback 017d9c25 (r187) — the pay-item EPF / SOCSO-EIS ticks, carried through as base carve-outs.
        // `wagesExOt` already has `unpaidDeduction` taken off it, so a carve-out can in principle exceed the
        // base it carves; the pack clamps at 0 (Math.max(0, wage - excluded)).
        epfWageExcluded: en.epfWageExcluded,
        epfAdditionalExcluded: en.epfAdditionalExcluded,
        socsoWageExcluded: en.socsoWageExcluded,
        socsoWageExtra: en.socsoWageExtra,
        // Feedback 2333b7fb (r193) — the DEDUCTION pay-item ticks, same mechanism. Same clamping note:
        // `wagesExOt` may already be smaller than the carve-out, and the pack clamps at 0.
        // These three stay on BOTH sides of the additional-run delta below (unlike epfAdditionalExcluded
        // / socsoWageExtra): they describe money the REGULAR run's fold pays, present identically in the
        // baseline and the now-call, so they cancel exactly as the wage-side carve-outs do.
        epfWageDeduction: en.epfWageDeduction,
        socsoWageDeduction: en.socsoWageDeduction,
        pcbWageDeduction: en.pcbWageDeduction,
      };
      // 1.2.4 Zakat — resolve THIS month's zakat at generate time so percent never goes stale (declared up
      // front so `computeMonth`'s default can read it; the percent branch is filled in after the closure):
      //  1) a manual `payroll_input.zakat > 0` (admin override) wins — preserves today's behaviour. NOTE
      //     (feedback d435673e): the Zakat screen no longer writes payroll_input.zakat (its one-off override
      //     section was removed); this manual tier is now fed ONLY by the batch input grid, prefillFixedZakat,
      //     and the batch import. Precedence is unchanged (manual > fixed > percent_of_pcb).
      //  2) else (REGULAR run only) an active 'fixed' election uses its flat amount;
      //  3) else (REGULAR run only) an active 'percent_of_pcb' election multiplies the LIVE pre-offset normal
      //     MTD — derived by a single zero-zakat probe call that reuses this loop's already-built
      //     wages/profile/acc/opts/rules (no shadow re-derivation), so the figure tracks the current PCB;
      //  4) else 0. The figure then drives `applyZakatOffset` (PCB reduction) + the Z accumulator unchanged.
      // The election is gated to the regular run (like CP38/HRDF): an additional/off-cycle run carries ONLY
      // the manual `payroll_input.zakat`, so a one-month regular + bonus pair applies the election ONCE.
      let effectiveZakat =
        zakat > 0
          ? zakat
          : !isAdditionalRun && e.zakatActive && e.zakatMethod === 'fixed'
            ? round2(Number(e.zakatFixed ?? 0))
            : 0;
      // `zakatCurrent` defaults to the resolved figure, but the percent_of_pcb probe passes 0 to read the
      // pre-offset normal MTD without a circular dependency.
      // 017d9c25 — `bases` lets the additional-run BASELINE call drop THIS run's additional-stream
      // carve-outs. The baseline means "the cumulative month WITHOUT this run's additional remuneration",
      // so a carve-out describing money this run is paying must not appear on that side of the delta, or
      // the increment comes out wrong in both directions. The WAGE-side carve-outs stay on both sides:
      // both calls re-fold the same recurring components, so they describe the same money.
      const computeMonth = (additional: number, ot: number, zakatCurrent = effectiveZakat, bases = stOpts) =>
        pack.payroll.statutory(
          wagesExOt,
          taxProfile,
          additional,
          ot,
          { month: pMonth, acc: accByEmp.get(e.employmentId), lpCurrent: lp, zakatCurrent },
          bases,
          rules,
        );
      // Step 4 (f3148da1) — the OT figure fed to the statutory engine INCLUDES the converted excess, so the
      // redirected amount keeps overtime's statutory character (SOCSO/EIS/PCB, EPF-exempt). The DISPLAYED
      // overtime line stays the capped figure; the excess shows under the chosen pay item. Convert=0 ⇒ otStat===overtime.
      const otStat = round2(overtime + otConvertAmount);
      if (zakat <= 0 && !isAdditionalRun && e.zakatActive && e.zakatMethod === 'percent_of_pcb') {
        const probe = computeMonth(bonus, otStat, 0);
        effectiveZakat = round2(Number(e.zakatPercent ?? 0) * (probe.pcbNormalPreZakat ?? 0));
      }
      const earlierRun = earlierRunByEmp.get(e.employmentId) ?? { additional: 0, overtime: 0 };
      // The baseline option bag for either delta: THIS run's additional-stream carve-outs are dropped,
      // because the baseline means "the month WITHOUT this run's additional remuneration" and a carve-out
      // describing money this run is paying must not sit on that side (017d9c25). The wage-side carve-outs
      // stay on both sides — both calls re-fold the same recurring components.
      const additionalBaseline = { ...stOpts, epfAdditionalExcluded: 0, socsoWageExtra: 0 };
      /**
       * ADR-0085 step 5 — WHAT THE MONTH'S EARLIER RUNS HAVE ALREADY BEEN CHARGED.
       *
       * The kernel's model is that the month's NORMAL WAGE is always present in the statutory base — it
       * comes from the employment's compensation record, not from whether the regular run has been
       * processed — and the regular run is the one that pays it. So each run's charge is:
       *
       *     additional run   S(W, A≤, T≤) − S(W, A<, T<)                     (its marginal)
       *     regular run      S(W, A≤, T≤) − S(W, A<, T<)  +  S(W, 0, 0)      (its marginal + the base)
       *
       * which telescopes to S(W, A_total, T_total) — the month as ONE computation — in ANY order the runs
       * land. `chargedByEarlierRuns` is the middle term rearranged into the single `before` bag deltaStat
       * subtracts: (the month as the earlier runs left it) − (the month with no additional at all).
       *
       * At run_seq 1 there are no earlier runs, so this is never reached and the regular run keeps its
       * literal `computeMonth(bonus, otStat)` — byte-identical, not merely arithmetically equal.
       */
      const chargedByEarlierRuns = (
        earlierCum: Record<string, unknown>,
        baseMonth: Record<string, unknown>,
      ): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const k of DELTA_KEYS) out[k] = round2(Number(earlierCum[k] ?? 0) - Number(baseMonth[k] ?? 0));
        return out;
      };
      const stCore = isAdditionalRun
        ? deltaStat(
            computeMonth(earlierRun.additional + bonus, earlierRun.overtime),
            computeMonth(earlierRun.additional, earlierRun.overtime, effectiveZakat, additionalBaseline),
          )
        : restatesMonth
          ? deltaStat(
              computeMonth(earlierRun.additional + bonus, round2(earlierRun.overtime + otStat)),
              chargedByEarlierRuns(
                computeMonth(earlierRun.additional, earlierRun.overtime, effectiveZakat, additionalBaseline),
                computeMonth(0, 0, effectiveZakat, additionalBaseline),
              ),
            )
          : computeMonth(bonus, otStat);
      // ── Feedback 017d9c25 (r187) — THE WORKING BETWEEN the pay items and the answers ──
      // "Today you can see the pay items and you can see the answers, but not the working in between."
      // These are the four figures each agency was actually charged on, for THIS computation (on an
      // additional run that is the cumulative month, matching the `now` side of the delta). Read as
      // absent on every payslip written before r187, which is exactly what the disclosure renders.
      // A restating regular run was charged on the CUMULATIVE month exactly as an additional run is, so
      // the disclosed bases follow the same figures — or `bases` would stop being what the contribution
      // was actually charged on, which is the one property item 0253dc7c's screen relies on.
      const statAdditional = isAdditionalRun || restatesMonth ? round2(earlierRun.additional + bonus) : bonus;
      const statOvertime = isAdditionalRun
        ? earlierRun.overtime
        : restatesMonth
          ? round2(earlierRun.overtime + otStat)
          : otStat;
      // 2333b7fb — the deduction reductions belong here too, or `bases` stops being the figure the
      // contribution was actually charged on, which is the ONE property item 0253dc7c's screen relies
      // on. Each line mirrors the pack's own expression term for term (localization/my/payroll.ts:
      // epfWage / socsoWage / pcbWage), INCLUDING the clamp, so the disclosed base and the charged base
      // cannot disagree — `pcb` gains a Math.max it did not have, matching `pcbWage`'s clamp for the
      // case where a deduction exceeds the month's wage.
      const statBases = {
        epf: Math.max(0, round2(wagesExOt - en.epfWageExcluded - en.epfWageDeduction)),
        epfAdditional: Math.max(0, round2(statAdditional - en.epfAdditionalExcluded)),
        socsoEis: Math.max(
          0,
          round2(wagesExOt + statOvertime - en.socsoWageExcluded + en.socsoWageExtra - en.socsoWageDeduction),
        ),
        pcb: round2(Math.max(0, round2(wagesExOt + statOvertime - en.pcbWageDeduction)) + statAdditional),
        hrdf: isAdditionalRun ? 0 : hrdfBase,
      };
      // Feedback 6b134681 — the per-item stamp this run writes. A regular run stamps every line it folded;
      // an additional run stamps the bonus-bucket subset, which is the only money it actually pays (see
      // `bonusOnlyComponentLines`). Computed here rather than inline in the object below so the stamp and
      // the reconciliation test read the identical expression.
      const stampComponentLines = isAdditionalRun ? bonusOnlyComponentLines(en.componentLines) : en.componentLines;
      const stComputed = {
        ...stCore,
        bases: statBases,
        // Stamped so future months' replay can accumulate Z and ∑LP (spec §E.5 / §D.1).
        lp,
        // ── Item 3fa088fb — WHERE LP₁ CAME FROM ────────────────────────────────────────────────────
        // The reporter asked for the calculation detail to show ∑LP, LP₁, the amount used for each AND
        // "the source of the deduction where appropriate". ∑LP and LP₁ were already on the payslip's PCB
        // trace (core/pcb-explain renders them as ΣLP / LP1) — they were simply both showing 0.00 because
        // nothing fed them. This is the missing third part: whether this month's figure is the employee's
        // OWN approved TP1 or a number an operator keyed, plus the two inputs the delta was struck from,
        // so an employee's query can be answered off the screen without reopening the declaration.
        //
        // KEY PRESENT ONLY WHEN THERE IS A TP1 FIGURE TO EXPLAIN. `statutory` is plain jsonb with no
        // allow-list validator, and it is NOT a DELTA_KEY (adding one would corrupt additional-run delta
        // arithmetic — see DELTA_KEYS). Absent ⇒ a payslip byte-identical to the pre-3fa088fb kernel,
        // which is every payslip ever issued on production, since none of them carried a TP1 at all.
        ...(tp1 > 0
          ? {
              lpDetail: {
                tp1,
                tp1Source: tp1IsOverride ? ('manual' as const) : ('tp1_self' as const),
                // The delta's two inputs, on the derived path only: a keyed override was struck from
                // neither, and printing an annual beside a figure that ignored it would mislead.
                ...(tp1IsOverride || !tp1Feed
                  ? {}
                  : { tp1Annual: tp1Feed.annual, tp1AlreadyFed: tp1Feed.lpAlreadyFed }),
                // The other half of LP₁ — the month's declared optional-deduction pay codes — named
                // separately so the two sources of one figure are never confused for each other.
                ...(!isAdditionalRun && en.lpDeclared > 0 ? { declaredComponents: round2(en.lpDeclared) } : {}),
              },
            }
          : {}),
        zakat: effectiveZakat,
        // HRD Corp levy rides the normal wage (regular run only); a bonus/off-cycle run adds none.
        hrdf: isAdditionalRun ? 0 : hrdf,
        // 1.2.3 CP38 — stamped as the DISTINCT CP39 source (separate from PCB) + its LHDN ref, only when
        // non-zero (regular run). `statutory` is plain jsonb with no allow-list validator, so this is safe;
        // it is NOT a DELTA_KEY (that would corrupt additional-run delta math). The net figure is folded
        // once into otherDeductions below, so net/total reconcile without double-counting.
        ...(cp38 > 0 ? { cp38, cp38Ref: cp38ByEmp.get(e.employmentId)?.cp38Ref } : {}),
        // EPF contribution mode applied (Wave 2B audit) — 'auto' unless an i-Topup/exempt election.
        epfMode: e.epfMode ?? 'auto',
        // Step 4 (f3148da1) — the OT excess redirected to a pay item (regular run, amount>0 only). Drives the
        // dedicated earnings line on the payslip; the amount is already folded into `allowance`/gross above.
        ...(otConvertAmount > 0 && otConvertComp
          ? { otConvert: { code: otConvertComp.code, name: otConvertComp.name, amount: otConvertAmount } }
          : {}),
        // #6 (ADR-0037): per-body version map, present only when a component override is in effect.
        ...(componentVersions ? { componentVersions } : {}),
        // ADR-0025 §5 (Option A): non-payable, non-taxable components recorded for the payslip only — they
        // do NOT affect gross/net (key present only when there is at least one, to preserve byte-identical
        // parity with the legacy path which never produces record lines). Carried on the regular run only —
        // an additional/off-cycle run pays solely its bonus and would otherwise re-list the same record.
        // f1564110 Phase 3 — consumed one-off transactions append NAMED provenance lines (flag off ⇒ the
        // txn list is empty ⇒ byte-identical): the payslip shows each one-off item by name; deductions
        // carry a negative sign; 'leave' rows appear here record-only.
        ...(!isAdditionalRun && (en.recordLines.length || (txnRecordLinesByEmp.get(e.employmentId)?.length ?? 0))
          ? { recordLines: [...en.recordLines, ...(txnRecordLinesByEmp.get(e.employmentId) ?? [])] }
          : {}),
        // Feedback 862ed0ad — the per-component detail behind the summarised earnings/deduction figures.
        // Written from THIS run onward only: the detail was never stored before, so the runs already
        // completed cannot be itemised retrospectively and Transaction View says so on screen rather than
        // rendering an empty breakdown. Key absent when there is nothing to say, which keeps payslips from
        // the flag-off path (and every historical slip) byte-identical.
        //
        // 6b134681 — AND ON AN ADDITIONAL RUN TOO, restricted to what that run pays. This was regular-run
        // only, on the same ground recordLines still is (an additional run re-folds the same recurring
        // components and would list a month's allowances twice). That objection is answered by
        // `bonusOnlyComponentLines` rather than by stamping nothing: a bonus run now stamps its bonus-bucket
        // lines and only those, so the payslip that pays RM500 of ANGPOW says ANGPOW instead of leaving every
        // screen to fall back on the name of the box, which reads "Bonus". Measured before the fix: 19 of 19
        // production bonus payslips carried no stamp at all, which is why 6b134681's read-side work was
        // structurally inert there.
        ...(stampComponentLines.length ? { componentLines: stampComponentLines } : {}),
        // Feedback 09b554e9 — per-code exemption/LP usage this month, replayed by future months' YTD
        // accumulator (like st.lp) and summed into the EA exempt-allowances figure. Regular run only
        // (an additional run re-folds the same recurring components; stamping again would double-count
        // the replay). Key present only when at least one code was used — legacy slips are byte-identical.
        ...(!isAdditionalRun && Object.keys(en.exemptionUsed).length ? { exemptionUsed: en.exemptionUsed } : {}),
      };

      // ── 2961a7ae — THE MANUAL OVERRIDE, applied here and nowhere else ──────────────────────────────
      // Between the computed figures and everything composed FROM them. Downstream — statDeductions, the
      // net-floor clamp, employer_cost, the batch totals, the GL lines, the payslip row, the statutory
      // reports and the r185 forms shelf — all read `st`, so the adjusted figure is the figure everywhere
      // without a second write path. No override ⇒ `st` IS `stComputed`, the same object, byte-identical.
      //
      // NO CASCADE, deliberately: overriding EPF does not re-derive PCB from the new EPF figure. See
      // applyStatutoryAdjustment's doc comment. And note what this placement makes STRUCTURAL rather than
      // a rule to remember — the employer legs are read only by employerCost below and never by
      // statDeductions, so an employer-side override cannot reduce anyone's net pay.
      const st = applyStatutoryAdjustment(stComputed, statutoryAdjustmentByEmp.get(e.employmentId) ?? null);

      // Item 5a461b99 — "Employer bears" reassignment. The contribution is still computed AND reported in
      // full (st.socsoEmployee / st.eisEmployee / st.socsoSkbbk are untouched, so SOCSO/EIS reports + the
      // submitted PERKESO file are unchanged). What changes is WHO funds the employee's share: when a flag is
      // on, that share is NOT deducted from the employee (removed from statDeductions below) and is instead
      // added to employer cost. Off by default ⇒ 0 ⇒ byte-identical. On an additional run the SOCSO/EIS deltas
      // are ~0 (bonus excluded), so employer-borne is naturally ~0 there too.
      const bearsSocso = e.employerBearsSocso ?? false;
      const bearsEis = e.employerBearsEis ?? false;
      const bearsSkbbk = e.employerBearsSkbbk ?? false;
      const employerBorneSocso = bearsSocso ? round2(st.socsoEmployee) : 0;
      const employerBorneEis = bearsEis ? round2(st.eisEmployee) : 0;
      const employerBorneSkbbk = bearsSkbbk ? round2(st.socsoSkbbk) : 0;
      // Item 8b5334db — "Employer bears tax": the PCB is still computed + reported in full (st.pcb untouched, so
      // CP39/PCB reports + the amount remitted to LHDN are unchanged), but the employee's take-home is NOT reduced
      // by it — the employer funds it. Same funding plumbing as the SOCSO/EIS employer-bears flags: subtract from
      // statutory deductions, add to employer cost. Off by default ⇒ 0 ⇒ byte-identical. NOTE (documented
      // follow-up): under LHDN, tax the employer pays on an employee's behalf is itself a taxable benefit, so a
      // fully-correct treatment grosses up (tax-on-tax). This implements the funding/plumbing; gross-up is deferred.
      const bearsTax = e.employerBearsTax ?? false;
      const employerBorneTax = bearsTax ? round2(st.pcb) : 0;
      // Item 0d9bb2da — "Employer bears EPF": the EPF employee + employer contributions are still computed +
      // reported in full (st.epfEmployee / st.epfEmployer untouched, so the KWSP file + EPF report + the amount
      // remitted to KWSP are unchanged), but the employee's EPF share is NOT deducted from take-home — the
      // employer funds it. Same funding plumbing as the SOCSO/EIS/tax employer-bears flags: subtract from
      // statutory deductions, add to employer cost. Off by default ⇒ 0 ⇒ byte-identical. NOTE (documented
      // follow-up, same as the tax control): under LHDN, EPF the employer pays on an employee's behalf is a
      // taxable perquisite; a fully-correct treatment grosses it up. This implements funding/plumbing only.
      const bearsEpf = e.employerBearsEpf ?? false;
      const employerBorneEpf = bearsEpf ? round2(st.epfEmployee) : 0;
      const employerBorneTotal = round2(
        employerBorneSocso + employerBorneEis + employerBorneSkbbk + employerBorneTax + employerBorneEpf,
      );

      // Payslip amounts. An additional run pays ONLY its additional remuneration — the normal wage,
      // allowance and OT were paid by the regular run — so basic/allowance/OT are 0 and gross = the bonus.
      const slipBasic = isAdditionalRun ? 0 : basic;
      const slipAllowance = isAdditionalRun ? 0 : allowance;
      const slipOvertime = isAdditionalRun ? 0 : overtime;
      const slipUnpaid = isAdditionalRun ? 0 : unpaidDeduction;
      const grossPay = isAdditionalRun ? round2(bonus) : round2(normalWage + bonus);
      // Item 5a461b99 — subtract any employer-borne employee shares so they are NOT deducted from net pay
      // (employerBorneTotal is 0 unless an "Employer bears" flag is set ⇒ byte-identical default path).
      //
      // ── 3a092cf0 — `st.zakat` IS A DEDUCTION AND WAS MISSING FROM THIS SUM ──────────────────────────
      // Measured on production 2026-09-08: SIG01's 2026-01 slip carried EPF 410.00 + SOCSO 18.75 +
      // SKBBK 0 + EIS 7.50 + PCB 0.00 = total_deductions 436.25 with a zakat of 30.00 printed beside it.
      // The zakat was shown, never taken, and left in the employee's pay. Because `totalDeductionsRaw`
      // and `net` below are both composed FROM this figure the omission propagated consistently, so
      // every affected payslip reconciled with itself and nothing looked wrong — nine payslips, four
      // employees, seven runs, 2,569.23 never deducted.
      //
      // ⚠️ THIS IS NOT A DOUBLE CHARGE, and the distinction is the whole item. `st.pcb` reaching here is
      // ALREADY NET of this month's zakat: the pack applies the §E.5 offset inside `pcbMonth` and records
      // what survived it as `pcbMeta.trace.zakatLeftover`. So where tax exceeds the zakat the PCB line has
      // already fallen by the full amount and adding it back here leaves the total unchanged to the cent
      // (test/zakat-in-total-deductions-3a092cf0.test.ts runs two identical employees side by side to say
      // so). Where it does not — SIG01's shape, tax of 7.90 zeroed by the §E.3 RM10 REMITTANCE FLOOR
      // rather than by the offset — `zakatLeftover` is the whole election and the whole election is owed.
      // The double charge is prevented by the offset. It was never prevented by this omission; the
      // omission simply did not collect the money.
      //
      // Zakat is never employer-borne (there is no "Employer bears zakat" control), so it is deliberately
      // outside `employerBorneTotal` and cannot be funded away from the employee.
      // ⚠️ ZAKAT IS NOT IN HERE, AND THAT IS THE SECOND HALF OF 3a092cf0. It IS charged — see
      // `slipZakat` below — but it is charged through the s.24 clamp chain rather than beside the
      // legislated legs. Putting it here (the branch's first attempt) had two measured consequences:
      // a 2,000 election against a 1,000 basic produced a NET PAY OF -1,116.65 with no clamp and no
      // warning, because `statDeductions` is never clamped; and it silently consumed headroom AHEAD of
      // a court/LHDN-ordered CP38, re-prioritising an employee's voluntary election above a legal
      // order. Neither was a decision anybody made.
      const statDeductions = round2(
        st.epfEmployee + st.socsoEmployee + st.socsoSkbbk + st.eisEmployee + st.pcb - employerBorneTotal,
      );
      // M#16 (EA s.24 net-floor): clamp EVERY post-tax deduction in priority order so net ≥ 0 BY
      // CONSTRUCTION, never as a downstream patch. Headroom after statutory + unpaid is the cash that
      // remains; manual deduction (en.deduct) takes first claim, then CP38 (court/LHDN order — exempt from
      // the private 50% cap but still cannot produce a negative net), then the loan (ADR-0060, lowest
      // priority). Each clamp is round2()'d. The byte-identical guarantee holds: with no manual deduct, no
      // CP38, and no loan, manual/cp38/loan all clamp to 0 ⇒ slipExtraDeduct=0, slipLoan=0, exactly as
      // before. Statutory: EA 1955 s.24(1)/(8).
      const rawManual = isAdditionalRun ? 0 : round2(en.deduct);
      const rawCp38 = isAdditionalRun ? 0 : round2(cp38);
      // 1.2.8 Loan instalment (ADR-0060) — POST-TAX: only reduces net, touches NO statutory base. An
      // additional/off-cycle run charges no loan (handled like cp38/hrdf).
      const rawLoan = isAdditionalRun ? 0 : round2(loanByEmp.get(e.employmentId) ?? 0);
      const avail = round2(grossPay - statDeductions - slipUnpaid);
      const manualApplied = Math.max(0, Math.min(rawManual, avail));
      const afterManual = round2(avail - manualApplied);
      const cp38Applied = Math.max(0, Math.min(rawCp38, afterManual));
      const afterCp38 = round2(afterManual - cp38Applied);
      // 3a092cf0 — ZAKAT, CLAMPED, AND DELIBERATELY BEHIND CP38.
      //
      // The ORDER is the decision: CP38 is a court/LHDN direction to deduct, zakat is an amount the
      // employee elected, so the election must not displace the order. It sits ahead of the loan for the
      // mirror reason — ADR-0060 already makes the company loan the lowest claim on the cash.
      //
      // Clamped for the same reason every line here is: EA s.24 means net ≥ 0 BY CONSTRUCTION. An
      // election larger than take-home is not a typo-only case — 100815 carries 890.53/911.83 a month,
      // and a month mostly consumed by unpaid leave leaves less than that.
      //
      // ⚠️ A CLAMPED ZAKAT LEAVES THE PCB OFFSET OVER-APPLIED: §E.5 reduced the PCB by the FULL election
      // upstream, so recovering less than that here means the month collected neither the tax nor all of
      // the zakat. That cannot be silently reconciled inside the kernel — it is an operator decision
      // about an election they set — so it is recorded as a clamp and the batch warns, exactly as it
      // does for a clamped CP38 or loan. Never silent.
      const rawZakat = round2(st.zakat);
      const zakatApplied = Math.max(0, Math.min(rawZakat, afterCp38));
      const slipZakat = zakatApplied;
      const afterZakat = round2(afterCp38 - zakatApplied);
      const slipLoan = Math.max(0, Math.min(rawLoan, afterZakat));
      // 1.2.3 CP38 + the manual deduction fold into the SINGLE extra-deduction source: otherDeductions
      // (line below) and totalDeductions/net then reflect them automatically — no separate add-to-total.
      const slipExtraDeduct = round2(manualApplied + cp38Applied);
      // Record any deduction the headroom could not fully recover so the batch warns (M#16) — never silent.
      if (
        manualApplied + 0.005 < rawManual ||
        cp38Applied + 0.005 < rawCp38 ||
        slipLoan + 0.005 < rawLoan ||
        // 3a092cf0 — a zakat the headroom could not fully recover is warned like any other clamp. It
        // matters MORE than the others because the PCB offset upstream already assumed the full amount.
        zakatApplied + 0.005 < rawZakat
      ) {
        deductionClampsByEmp.set(e.employmentId, {
          manualRequested: rawManual, manualApplied,
          cp38Requested: rawCp38, cp38Applied,
          loanRequested: rawLoan, loanApplied: slipLoan,
          zakatRequested: rawZakat, zakatApplied,
        });
      }
      // Record the ACTUAL loan recovered (cents) so applyLoansForBatch advances the ledger by the clamped
      // amount — the reserved due may exceed it; the shortfall re-schedules (C2/H1/H3 fix).
      appliedLoanCentsByEmp.set(e.employmentId, Math.round(slipLoan * 100));
      // 1a — policy rounding (earnings → gross, deductions → total, net → net). Default 'none'/null config ⇒
      // applyRounding === round2 ⇒ byte-identical. Applied as a thin shell so the gross/deductions/net the
      // payslip stores already reflect the policy; net is then re-derived from the rounded components so it
      // reconciles, then net-rounding (if any) applies last.
      const roundedGross = applyRounding(grossPay, cfg?.rounding?.earnings);
      // 3a092cf0 — `slipZakat` is its OWN term rather than folded into `slipExtraDeduct`. That constant
      // becomes `otherDeductions` on the stored row, and Transaction View's pivot subtracts a named zakat
      // out of that residual; folding it in would double-count it there and print a negative
      // "Other deductions". Separate term ⇒ the total counts it once and the residual stays clean.
      const totalDeductionsRaw = round2(
        statDeductions + slipUnpaid + slipExtraDeduct + slipZakat + slipLoan,
      );
      let totalDeductions = applyRounding(totalDeductionsRaw, cfg?.rounding?.deductions);
      let net = applyRounding(round2(roundedGross - totalDeductions), cfg?.rounding?.netPay);
      // 1d — negative-net handling. 'set_zero' floors a negative net at 0; 'retain'/null leaves it (the s.24
      // clamp above already keeps net ≥ 0 on the standard path, so 'retain' is a no-op there — byte-identical).
      // Step 2 'carry_forward' (f3148da1): holds a negative net at 0 THIS cycle and recovers a PRIOR carried
      // balance from this cycle's positive net — the running balance is DERIVED (carryForwardByEmp) from earlier
      // closed cycles and re-stamped below for the next cycle to read. Both adjustments are folded into
      // totalDeductions so the payslip invariant net = gross − totalDeductions still holds.
      let carryForward: { applied: number; added: number; balanceBefore: number } | null = null;
      if (cfg?.negativeNet === 'set_zero' && net < 0) {
        net = 0;
      } else if (cfg?.negativeNet === 'carry_forward' && !isAdditionalRun) {
        const owed = round2(carryForwardByEmp.get(e.employmentId) ?? 0); // >0 ⇒ carried from prior cycle(s)
        let applied = 0;
        let added = 0;
        // Recover the prior balance from this cycle's positive net (never pushing net below 0 in one hit).
        if (owed > 0 && net > 0) {
          applied = Math.min(owed, net);
          net = round2(net - applied);
        }
        // A still-negative net (statutory + unpaid exceeded gross) is deferred: raise it to 0 and carry the
        // shortfall forward. (Mutually exclusive with `applied` — net can't be both > 0 and < 0.)
        if (net < 0) {
          added = round2(-net);
          net = 0;
        }
        if (applied > 0 || added > 0) {
          // Recovery rides deductions (net ↓); a deferred shortfall is a negative deduction (net ↑).
          totalDeductions = round2(totalDeductions + applied - added);
          carryForward = { applied, added, balanceBefore: owed };
        }
      }
      // Item 5a461b99 — any employer-borne employee share is real employer outlay, so it adds to employer
      // cost (employerBorneTotal is 0 unless an "Employer bears" flag is set ⇒ byte-identical default path).
      const employerCost = isAdditionalRun
        ? round2(bonus + st.epfEmployer + st.socsoEmployer + st.eisEmployer + employerBorneTotal)
        // Step 4 (f3148da1) — the converted OT excess is real employer outlay (paid to the employee), so it
        // adds to employer cost alongside the OT it was rerouted from. Default (no convert) ⇒ 0 ⇒ unchanged.
        // 2961a7ae — `st.hrdf`, not the local `hrdf`. On a regular run st.hrdf IS hrdf (st sets
        // `hrdf: isAdditionalRun ? 0 : hrdf`), so this is byte-identical — but it is `st` that carries a
        // manual override, and employer cost must move with an overridden levy rather than with the
        // computed one. The additional-run branch above has no hrdf leg at all, so nothing changes there.
        : round2(wagesExOt + overtime + otConvertAmount + bonus + en.reimburse + st.epfEmployer + st.socsoEmployer + st.eisEmployer + st.hrdf + employerBorneTotal);

      // c7fdfcf6 gap-fix (functional weekly/bi-weekly) — disburse this employee's NET across the run's cut-off
      // CYCLES. Recurring pay (basic + allowance + bonus) prorates by cycle days; OT follows each cycle's OT
      // minutes (from attendance, bucketed by date); the unpaid-leave deduction follows each cycle's unpaid days;
      // each cycle's NET operational earnings then weight the NET split. The per-cycle amounts sum EXACTLY to net
      // (the residual lands on the last cycle). Only produced for weekly/biweekly (perCycle) regular runs; monthly
      // and additional runs produce no schedule ⇒ their payslip statutory blob is byte-identical to before.
      let paymentSchedule: { seq: number; from: string; to: string; amount: number }[] | null = null;
      if (perCycle && !isAdditionalRun) {
        const periods = runSchedule.periods;
        const otMin = cycleOtMinutesByEmp.get(e.employmentId) ?? periods.map(() => 0);
        const upDays = cycleUnpaidDaysByEmp.get(e.employmentId) ?? periods.map(() => 0);
        const cycleDays = periods.map(
          (pd) => Math.round((Date.parse(`${pd.end}T00:00:00Z`) - Date.parse(`${pd.start}T00:00:00Z`)) / 86_400_000) + 1,
        );
        const amounts = disburseNetAcrossCycles({
          net,
          recurring: round2(slipBasic + slipAllowance + bonus),
          overtime: slipOvertime,
          unpaid: slipUnpaid,
          cycleDays,
          otMinutes: otMin,
          unpaidDays: upDays,
        });
        paymentSchedule = periods.map((pd, i) => ({ seq: pd.seq, from: pd.start, to: pd.end, amount: amounts[i] }));
      }

      // ── Feedback 3c473773 — the display overlay, stamped ONLY when it says something ─────────────────
      // The four stored columns keep the kernel's statutory bucketing (and every statutory form keeps
      // reading them). This is the SAME money re-labelled under the boxes the pay items declare, so a
      // payslip screen can print an overtime code under Overtime while LHDN still sees it as additional
      // remuneration. Derived here, where the OT caps, the one-off OT and the converted OT excess are all
      // in scope, so the overlay reconciles with grossPay by construction rather than by a screen's
      // arithmetic (pinned by test/pay-display-category.test.ts).
      //
      //   allowance  keeps otConvertAmount inside it, exactly as the stored column does, so a caller that
      //              subtracts otConvert for its own line keeps the identical expression.
      //   overtime   is the stored (capped) figure, plus what moved in, less what moved out.
      //
      // NOT stamped when: nothing was re-categorised (⇒ every existing payslip and every ordinary run is
      // byte-identical); an additional/off-cycle run (whose basic/allowance/OT columns are all forced to 0,
      // so there are no boxes left to move money between — note this is NO LONGER "the same reason
      // componentLines is regular-run only", because 6b134681 gave the additional run its own bonus-only
      // stamp; and it is that ABSENCE of an overlay here that makes the bonus stamp reconcile against the
      // stored column by construction); or an OT cap clipped an amount that also moved OUT of the overtime
      // box, where subtracting a pre-cap figure from a post-cap one is not well defined. In every one of
      // those cases the screens fall back to the stored columns, which is the correct answer and not a
      // degraded one.
      const otOutbound = Math.min(en.displayOtOutbound, slipOvertime);
      const displayEarnings =
        !isAdditionalRun && en.displayMoved && otOutbound === en.displayOtOutbound
          ? {
              basic: round2(slipBasic + en.display.basic),
              allowance: round2(otConvertAmount + en.display.allowance),
              overtime: round2(slipOvertime - en.overtime + en.display.overtime),
              bonus: round2(bonus - en.bonus + en.display.bonus),
              claim: round2(en.display.claim),
            }
          : null;

      await tx.insert(payslip).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: e.employmentId,
        basicSalary: slipBasic.toFixed(2),
        allowance: slipAllowance.toFixed(2),
        overtimePay: slipOvertime.toFixed(2),
        bonus: bonus.toFixed(2),
        daysWorked: isAdditionalRun ? null : String(daysWorked),
        // ── 1b0943d5 (migration 0446) — WHICH DAYS THIS SLIP COVERS, AS COLUMNS. ────────────────────
        //
        // Stamped on EVERY payslip this kernel writes, split month or not, and that is the point rather
        // than an over-reach: the completeness control has to ask "do this person's payslips tile the
        // month?" across several employers' batches, and a question asked of a column set on only SOME
        // rows cannot be answered — the unstamped ones would read as gaps. So the rule is total and
        // simple: the whole period unless the entity history says this employer owns only part of it.
        //
        // `days_worked` is untouched and still means what it meant: how many days were PAID. These two
        // say which days were OWNED. A mid-month joiner owns the whole period and works part of it; a
        // transferred employee owns part of it. Conflating the two is how a joiner would look like half a
        // transfer to the tiling check.
        //
        // AN ADDITIONAL / OFF-CYCLE RUN STAMPS THE SAME WINDOW ITS REGULAR COUNTERPART WOULD — the whole
        // period for anybody unsegmented, this employer's segment for a transferred employee — because an
        // extra payment covers the same days the regular run does and is made by the same employer. It
        // cannot double-count against the regular run's claim: the tiling check reads REGULAR runs only
        // (at most one per company per period, `payroll_batch_one_regular_uq`). Every payslip written
        // before this migration keeps NULL, which reads as the whole period.
        coverageFrom: segmentByEmp.get(e.employmentId)?.from ?? periodStart,
        coverageTo: segmentByEmp.get(e.employmentId)?.to ?? periodEnd,
        grossPay: roundedGross.toFixed(2),
        // Fix-5 (M#17): carry the OT provenance onto the immutable statutory snapshot so an auditor reading a
        // closed payslip can tell whether the overtime was attendance-derived or manually keyed. Only stamped
        // when this slip actually pays OT and the input row carries a provenance (no misleading flag on a
        // zero-OT slip / additional run, which sets slipOvertime to 0).
        statutory: {
          ...st,
          ...statutoryProvenance,
          // 3a092cf0 — THE STAMP THAT SAYS "THIS SLIP'S TOTAL ALREADY COUNTS THE ZAKAT".
          //
          // Zakat joined `statDeductions` in this round, so a slip written from here reconciles: its
          // deduction lines sum to its stored total. Every slip written BEFORE it does not — its total
          // excludes the zakat that is nonetheless on the blob. A screen or a PDF that simply started
          // printing zakat as a counted deduction would therefore make every historical payslip
          // contradict itself, which is the exact complaint that raised this item, and it would be
          // PERMANENT for the two 2026-01 slips on closed runs that can never be recalculated.
          //
          // So the display asks the PAYSLIP'S OWN BLOB whether its total counts the zakat, exactly as
          // `payslipEmployerBorne` and `payslipAbsenceLines` ask about theirs (core/payslip-employer-borne
          // .ts rule 1: "READ THE PAYSLIP'S OWN BLOB. Never re-derive from the employee's CURRENT flags").
          // Absent ⇒ a pre-3a092cf0 slip ⇒ render exactly as it does today. Present ⇒ count it.
          //
          // Stamped unconditionally rather than only when zakat > 0: "this run counted zakat" is a fact
          // about the ENGINE that wrote the slip, not about the amount. A slip with no zakat and no stamp
          // would otherwise be indistinguishable from a legacy slip, and the first zakat election after an
          // upgrade would look historical.
          zakatInTotal: true,
          ...(slipOvertime > 0 && otSourceByEmp.get(e.employmentId)
            ? { otSource: otSourceByEmp.get(e.employmentId) }
            : {}),
          // ── a96d320c — THE HOURS AND THE RATE BEHIND THIS SLIP'S OVERTIME FIGURE ────────────────────
          //
          // Copied from `payroll_input.ot_derivation` (migration 0479), which the attendance prefill
          // stamped at the moment the statutory engine computed the figure. Copied, not recomputed: the
          // hours live in attendance and attendance is correctable after a run, so deriving them here — or
          // worse, when the payslip is opened — would answer with a later month's attendance about the
          // money this slip paid. The same refusal the non-payable record lines already carry.
          //
          // THE GATE IS AN EQUALITY, AND IT IS THE WHOLE SAFETY PROPERTY. The detail is stamped ONLY when
          // the decomposition's own total is still exactly the overtime figure this payslip prints. That
          // one condition disqualifies every way the two can part company, without needing to enumerate
          // them: a figure an operator re-keyed, an OT cap that clipped the total (2.1.1), a converted OT
          // excess rerouted to a pay item (f3148da1 step 4), a one-off overtime transaction added on top
          // (f1564110 phase 3), and an additional/off-cycle run, whose `slipOvertime` is 0. In every one
          // of those the key is simply absent and the payslip prints the overtime line it prints today —
          // which is the correct answer, not a degraded one. An absent detail asserts nothing; a caption
          // that disagrees with the amount above it asserts something false.
          ...(slipOvertime > 0 &&
          otDerivationByEmp.get(e.employmentId) != null &&
          round2(Number(otDerivationByEmp.get(e.employmentId)!.total)) === round2(slipOvertime)
            ? { otDetail: otDerivationByEmp.get(e.employmentId) }
            : {}),
          // 3c88d593 — THE ENTITY SEGMENT THIS SLIP COVERS, stamped ONLY when the month was split.
          //
          // A payslip has to be able to say what it is: "1–10 August, Fiamma" is not the same document as
          // "August, Fiamma", and a reader looking at two slips for one month must be able to tell which
          // days each one paid without reconstructing the transfer from the event log. It goes on the
          // payslip's own immutable snapshot for the same reason every other stamp here does — a screen
          // must never re-derive a closed slip's period from today's assignment history, which a later
          // correction could change underneath it.
          //
          // Absent on every unsegmented slip ⇒ every existing payslip and every ordinary run is
          // byte-identical.
          //
          // 1b0943d5 — THIS STAMP IS NO LONGER WHAT THE SCREENS READ, and it is kept anyway. The coverage
          // COLUMNS beside it (migration 0446) are now the queryable record, and `payslipSegmentOf` reads
          // those first; a screen decides "is this segmented" by whether the window is narrower than the
          // period, not by whether this key exists. The stamp stays because it is part of the IMMUTABLE
          // SNAPSHOT — the audited record of what the run believed when it computed the slip, alongside the
          // ruleset version, the pack provenance and everything else here — and because it is the only
          // coverage a payslip written by r194 has. Deleting it would silently rewrite those slips' period.
          ...(segmentByEmp.get(e.employmentId)
            ? {
                segment: {
                  companyId: batch.companyId,
                  from: segmentByEmp.get(e.employmentId)!.from,
                  to: segmentByEmp.get(e.employmentId)!.to,
                },
              }
            : {}),
          // Step 2 carry_forward (f3148da1) — the recovered/deferred amounts + the balance before this cycle.
          // Only stamped when non-zero (byte-identical to today for every other path); the NEXT cycle's balance
          // derivation replays these stamps (Σ added − applied) off closed payslips.
          ...(carryForward ? { carryForward } : {}),
          // e2632276 — NAME THE ABSENCE. `slipUnpaid` is merged into `other_deductions` below and recorded
          // nowhere else, so a payslip could never say how much of that one unnamed figure was unpaid leave
          // and how much was absence, nor how many days either was. These two stamps are that record, and
          // they are the only place it exists: history cannot be split retroactively, which is why a slip
          // WITHOUT them still prints the single lumped "Other deductions" row exactly as it does today.
          // Each is stamped only when it has an amount (a zero half prints no line at all), and never on an
          // additional run, which charges no unpaid/absence at all (slipUnpaid is 0 there).
          // A manually-keyed 'unpaid' ledger amount (txnUnpaid) is deliberately NOT folded into either
          // line: it carries no day count, so putting it under a line that prints one would make the days
          // and the ringgit disagree. It stays in the residual, which is what that row is for.
          //
          // BOTH STAMPS ARE BEHIND THE SWITCH, including the unpaid-leave one, which has nothing to do
          // with absence. Naming a line is a visible change to a document: without the gate, the very
          // first run after this deploys would print "Unpaid leave · 2 days · 387.10" in place of the
          // "Other deductions" row every one of the nine companies sees today, for anybody with an unpaid
          // day — un-asked-for, and flatly contrary to "nothing changes until you turn it on". A payslip
          // is also its own record (payslipAbsenceLines reads THIS blob, never today's policy), so a slip
          // stamped now keeps its named lines for ever even if the switch is later turned off — which is
          // correct, and another reason not to stamp before the employer has asked for it.
          ...(deductAbsentDays && !isAdditionalRun && unpaidLeaveAmount > 0
            ? { unpaidLeave: { days: unpaidDaysAll, amount: unpaidLeaveAmount } }
            : {}),
          ...(deductAbsentDays && !isAdditionalRun && absentAmount > 0
            ? { absent: { days: absentDays, amount: absentAmount } }
            : {}),
          // c7fdfcf6 gap-fix — the per-cycle DISBURSEMENT schedule for a weekly/bi-weekly run (present only when
          // the run frequency is weekly/biweekly; absent ⇒ byte-identical monthly slip). The employer pays each
          // cycle's `amount` on its cadence; statutory contributions stay settled monthly on this same payslip.
          ...(paymentSchedule ? { paymentSchedule: { frequency: runFrequency, cycles: paymentSchedule } } : {}),
          // Feedback 3c473773 — the payslip's OWN record of which box each figure belongs in, so a screen
          // never has to re-derive it from today's pay-item setup (which would let a category changed in
          // March silently rewrite January). Absent ⇒ read the stored columns, unchanged.
          ...(displayEarnings ? { displayEarnings } : {}),
          // Feedback 0df0c635 — snapshot the EFFECTIVE per-employee HRDF subjectivity, ONLY when HR set an
          // explicit override (a null/untouched row stays absent ⇒ byte-identical to pre-flag slips). The
          // audited-inputs convention: a closed payslip records the setting as it was when it was computed.
          // r79 — "effective" now means effective, not merely stored: when the employer is not registered no
          // levy can be charged, so the slip records hrdfSubject: false. HR's intent is NOT lost —
          // hrdfSubjectSet carries what was ticked and hrdfSubjectSuppressed carries why it could not take
          // effect, so the audit trail is richer than before while the slip no longer says "subject" beside
          // a structural zero. Registered companies (and every explicit No) are byte-identical to today.
          ...(e.subjectToHrdf != null
            ? suppressHrdfSubject
              ? { hrdfSubject: false, hrdfSubjectSet: true, hrdfSubjectSuppressed: 'company_not_registered' }
              : { hrdfSubject }
            : {}),
          // a96d320c rev 2 — SNAPSHOT THE SKBBK ELECTION, because a payslip could not say whether it had one.
          //
          // `subject_to_skbbk` is a real per-employee boolean (db/schema.ts), and when it is off the engine
          // returns 0 for the leg (localization/my/payroll.ts `skbbkOn`). Every surface that prints the
          // payslip therefore used `socsoSkbbk > 0` to mean "this employee has no SKBBK" — which conflates
          // it with "has SKBBK, contributed 0.00 this run", and on those the zero is the assertion the
          // other four statutory lines are kept for (CLAUDE.md §8). docs/audits/0085-delta-keys-sign-inventory.md
          // records the same defect as Class B, the class that makes a line VANISH from a money document.
          //
          // The answer was nowhere on the slip: only `employerBears.skbbk` was stamped, and that says who
          // FUNDED the leg, not whether there is one. So it is stamped here, from `stOpts.subjectToSkbbk`
          // — the effective election this run actually computed under, not today's row.
          //
          // UNCONDITIONAL, unlike `hrdfSubject` above, and that is the whole point: a reader must be able
          // to tell `false` (this run says the employee is not subject) from ABSENT (this run predates the
          // stamp and cannot answer). A conditional stamp would collapse those two into one silence, and
          // the renderers fall back to the amount test on the second of them.
          skbbkSubject: stOpts.subjectToSkbbk,
          // Item 5a461b99 — snapshot the "Employer bears" decision + the amounts the employer absorbed for
          // provenance, ONLY when at least one flag is set (absent ⇒ byte-identical to today). The reported
          // socso/eis/skbbk figures above are unchanged; this records that their EMPLOYEE share was not deducted.
          ...(bearsSocso || bearsEis || bearsSkbbk || bearsTax || bearsEpf
            ? {
                // Item 8b5334db — `tax` extends the employer-bears snapshot (absent ⇒ byte-identical to the
                // SOCSO/EIS-only snapshot). Records that the employee's PCB share was funded by the employer.
                // Item 0d9bb2da — `epf` extends it again (records the employee's EPF share funded by the
                // employer). The whole block stays absent when EVERY flag is off ⇒ byte-identical default.
                employerBears: { socso: bearsSocso, eis: bearsEis, skbbk: bearsSkbbk, tax: bearsTax, epf: bearsEpf },
                employerBorne: {
                  socso: employerBorneSocso,
                  eis: employerBorneEis,
                  skbbk: employerBorneSkbbk,
                  tax: employerBorneTax,
                  epf: employerBorneEpf,
                  total: employerBorneTotal,
                },
              }
            : {}),
        }, // `version` + (when source=pack) packVersion/signedKeyId snapshot + (when OT paid) otSource
        // Carry-forward recovery/deferral rides otherDeductions too, so the invariant
        // totalDeductions = statDeductions + otherDeductions holds (0 for every non-carry_forward path).
        otherDeductions: round2(
          slipUnpaid + slipExtraDeduct + slipLoan + (carryForward ? carryForward.applied - carryForward.added : 0),
        ).toFixed(2),
        totalDeductions: totalDeductions.toFixed(2),
        netPay: net.toFixed(2),
        employerCost: employerCost.toFixed(2),
        // OCC (9bc442bc): a fresh generation is version 1; a selective reprocess bumps the prior version.
        version: subset ? (versionByEmp.get(e.employmentId) ?? 0) + 1 : 1,
      });

      totals.gross += roundedGross;
      totals.net += net;
      totals.epfEmployee += st.epfEmployee;
      totals.epfEmployer += st.epfEmployer;
      totals.socsoEmployee += st.socsoEmployee;
      totals.socsoEmployer += st.socsoEmployer;
      totals.eisEmployee += st.eisEmployee;
      totals.eisEmployer += st.eisEmployer;
      totals.pcb += st.pcb;
      totals.hrdfEmployer += Number(st.hrdf); // 2961a7ae — st.hrdf is already 0 on an additional run
      totals.deductions += totalDeductions;
      totals.employerCost += employerCost;
    }
    (Object.keys(totals) as (keyof typeof totals)[]).forEach((k) => {
      totals[k] = round2(totals[k]);
    });

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // 1b0943d5 — CROSS-BATCH SEGMENT CREATION: THE OTHER HALF OF A TRANSFERRED MONTH
    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    //
    // THE FAILURE THIS ANSWERS, exactly as it happened on production on 2026-08-14. Employee 100814
    // transferred Fiamma → ISEDECOR BINA on 11 August. Reprocessing their August on the ISEDECOR run
    // produced the 21-day segment correctly — and the Fiamma 1–10 August counterpart, 2,129.03, was never
    // created, because a payroll_batch belongs to ONE company and this function writes into ONE batch.
    // The month lost a third of itself and the only thing that noticed was a human comparing batch totals.
    //
    // A run therefore CANNOT complete a split month by itself, and pretending otherwise is what underpays.
    // What it can do — and now does — is refuse to leave the month in a state that cannot be completed,
    // and make the other half's absence loud instead of silent:
    //
    //   REFUSE, before anything commits, when a counterpart employer's regular run for this period is
    //   already CLOSED without the segment it owes. A closed run is frozen (migration 0011's trigger is
    //   the DB backstop), so those days could never be added to it: the shortfall would be permanent. The
    //   whole transaction rolls back, which is the "refuse rather than commit a partial set" the plan
    //   asks for, applied at the one point where the alternative is unrecoverable.
    //
    //   MARK the counterpart run when it is PROCESSED but owes a segment. That is not a refusal because
    //   it is fixable — and the mark is what makes it get fixed: `payroll_batch.needs_recalc_at` is
    //   rendered on the run screen and `closeBatch` already refuses while it is set. So the other
    //   employer's run cannot be finalised until it has produced its half.
    //
    //   SAY SO otherwise — a counterpart still in draft, or a company with no run for the period at all.
    //   Both are ordinary and neither is refused (refusing a draft counterpart would deadlock the pair:
    //   whichever company ran first would be blocked by the one that had not run yet). They are recorded
    //   as a domain event, and `closeBatch`'s tiling check is the backstop that will not let the month be
    //   finalised while they stand.
    //
    // NOTHING BELOW EXECUTES for a run with no split month on it — `segmentByEmp` is empty for every
    // employment that did not change entity inside this period, which is every payroll run this system
    // has ever performed. No query, no event, no behaviour change.
    if (segmentByEmp.size > 0) {
      const coverage = await segmentedCoverage(tx, {
        payPeriod: batch.payPeriod,
        periodStart,
        periodEnd,
        employmentIds: [...segmentByEmp.keys()],
        currentCompanyById,
      });

      // 1. The unrecoverable case, refused before commit.
      const frozen: { employmentId: string; companyId: string; from: string; to: string }[] = [];
      for (const c of coverage) {
        for (const cp of c.counterparts) {
          if (cp.batchId === p.batchId || cp.status !== 'closed') continue;
          const seg = c.expected.find((s) => s.companyId === cp.companyId);
          const claim = c.claims.find((s) => s.companyId === cp.companyId);
          if (!seg) continue;
          if (claim && claim.from === seg.from && claim.to === seg.to) continue; // already pays exactly it
          frozen.push({ employmentId: c.employmentId, companyId: cp.companyId, from: seg.from, to: seg.to });
        }
      }
      if (frozen.length > 0) throw new PayrollCounterpartClosedError(frozen);

      // 2. The fixable case, marked so the counterpart run cannot be closed until it is dealt with.
      //    PROCESSED counterparts only. `stale` deliberately does not look at the batch's status (a run
      //    that has not paid somebody has not paid them, draft or not), so the status test lives here,
      //    where it decides what to DO about it: a processed run has figures that are now wrong and needs
      //    recalculating; a draft run has no figures to invalidate and marking it would put "needs
      //    recalculation" on a run nobody has generated yet. The draft is not let off — it simply waits
      //    for close, which refuses on `stale` whatever the status (see closeBatch). A closed counterpart
      //    never reaches here: it was refused above.
      const markBy = new Map<string, Set<string>>();
      for (const c of coverage) {
        for (const cp of c.counterparts) {
          if (cp.batchId === p.batchId || cp.status !== 'processed' || !cp.stale) continue;
          const s = markBy.get(cp.batchId) ?? new Set<string>();
          s.add(c.employmentId);
          markBy.set(cp.batchId, s);
        }
      }
      for (const [batchId, empSet] of markBy) {
        await markBatchNeedsRecalc(tx, ctx, { batchId, employmentIds: [...empSet] });
      }

      // 3. The record. One event for the whole run, carrying every split employment's expected segments,
      //    what is issued against them and where the month still does not tile — so the state is
      //    inspectable after the fact rather than reconstructable only by re-deriving it.
      //    "Incomplete" is ONE notion, and it is the same one closeBatch refuses on — including the
      //    counterpart that has issued nothing, or the wrong days, which leaves no gap on the calendar.
      //    An event that recorded a narrower notion than the refusal would describe a month as fine and
      //    then refuse to close it.
      const incomplete = coverage.filter(
        (c) => c.defects.length > 0 || c.missingCompanyIds.length > 0 || c.counterparts.some((cp) => cp.stale),
      );
      if (incomplete.length > 0) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'payroll-batch',
          aggregateId: p.batchId,
          eventType: 'payroll-batch.segment-coverage-incomplete',
          actor: subset?.actorId ? { type: 'user' as const, id: subset.actorId } : actorOf(ctx),
          payload: {
            batchId: p.batchId,
            companyId: batch.companyId,
            payPeriod: batch.payPeriod,
            employments: incomplete.map((c) => ({
              employmentId: c.employmentId,
              // The days somebody owed this person in this period (the period ∩ their tenure) — without it
              // a reader cannot tell a genuine hole from a fortnight before the person was hired.
              window: c.window,
              expected: c.expected,
              claims: c.claims.map((s) => ({ companyId: s.companyId, from: s.from, to: s.to })),
              defects: c.defects,
              missingCompanyIds: c.missingCompanyIds,
              counterparts: c.counterparts,
            })),
          },
        });
      }
    }

    // ── Selective reprocess (9bc442bc, reporter #8): delta-update batch totals/GL, keep status
    //    processed, record OCC + before/after per-employee history + status history, and DO NOT re-run
    //    the loan/claim side-effects for anyone already paid (applied at the original processing).
    //
    //    fbcf706d splits that last rule in two. It holds, unchanged, for a RECALCULATION — the ledgers
    //    moved when that payslip was first written. It never held for an ADDITION: that payslip is being
    //    written for the first time, so its money side-effects have never run, and skipping them is how a
    //    claim stays payable after being paid and a loan instalment is deducted without leaving the
    //    balance. Every side-effect below is therefore narrowed to the ADDED employments and to them
    //    alone; nothing on this branch can touch a row belonging to somebody already on the run. ──
    if (subset) {
      const computedIds = new Set(emps.map((e) => e.employmentId));
      // The additions that actually produced a payslip, and the recalculations. Intersected with `emps`
      // so a classified-ADDED id the earnings query still dropped can never claim a side-effect.
      const addedNow = new Set(addedEmploymentIds.filter((id) => computedIds.has(id)));
      const addedNowIds = [...addedNow];
      const recalculatedCount = emps.length - addedNow.size;

      const stored = (batch.totals ?? {}) as Record<string, number>;
      const deltaTotals = { ...totals };
      (Object.keys(deltaTotals) as (keyof typeof deltaTotals)[]).forEach((k) => {
        deltaTotals[k] = round2((Number(stored[k]) || 0) + totals[k] - oldTotals[k]);
      });
      // HEADCOUNT. `payroll_batch.employee_count` had exactly one writer — the full generation — so a run
      // that gained a person reported its pre-addition number for ever, on the Payroll Process list and on
      // this screen's own result panel. It is RECOUNTED off the payslips rather than incremented by the
      // number of additions, so the stored figure is a fact about the run and not a running total that a
      // failed job could leave one out.
      const [{ n: payslipCount } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payslip)
        .where(eq(payslip.batchId, p.batchId));
      await tx
        .update(payrollBatch)
        .set({ totals: deltaTotals, employeeCount: Number(payslipCount) })
        .where(eq(payrollBatch.id, p.batchId));

      const actor = subset.actorId ? { type: 'user' as const, id: subset.actorId } : actorOf(ctx);

      // ── SCOPE (fbcf706d work item 5). Some runs are deliberately set up for a chosen list of people.
      //    Adding someone to such a run is a deliberate widening of that list, and it has to be RECORDED:
      //    the scope drives every later prefill and re-generation, so an addition that computed a payslip
      //    without widening would silently vanish the next time the run was regenerated. Written here, in
      //    the same transaction as the payslip, and never through updateBatchScope — that one is
      //    draft-only and also deletes payslips outside the new scope, which on a processed run would be
      //    a data-loss bug. A whole-company run has no list to widen and is left exactly as it was.
      if (scopeConstrained && addedNowIds.length > 0) {
        const alreadyInScope = new Set(scopeEmploymentIds);
        const widenedWith = addedNowIds.filter((id) => !alreadyInScope.has(id));
        if (widenedWith.length > 0) {
          const prevScope = (batch.scope ?? null) as BatchScope | null;
          const nextScope: BatchScope = {
            ...(prevScope?.departmentIds?.length ? { departmentIds: prevScope.departmentIds } : {}),
            employmentIds: [...new Set([...(prevScope?.employmentIds ?? []), ...widenedWith])],
          };
          await tx.update(payrollBatch).set({ scope: nextScope }).where(eq(payrollBatch.id, p.batchId));
          await appendEvent(tx, {
            tenantId: ctx.tenantId,
            aggregateType: 'payroll-batch',
            aggregateId: p.batchId,
            eventType: 'payroll-batch.scope-widened',
            actor,
            payload: {
              batchId: p.batchId,
              companyId: batch.companyId,
              payPeriod: batch.payPeriod,
              addedEmploymentIds: widenedWith,
              reason: subset.reason ?? null,
              before: prevScope,
              after: nextScope,
            },
          });
        }
      }

      // ── LOAN LEDGER, for the added employments only. `applyLoansForBatch` is already idempotent by
      //    status (it reads reservations that are still 'reserved' and leaves them 'applied'), and the
      //    narrowing means a recalculation cannot reach a reservation at all — so an instalment can
      //    advance the balance exactly once no matter how often the run is reprocessed afterwards.
      if (addedNowIds.length > 0) {
        const addedLoanCents = new Map(
          [...appliedLoanCentsByEmp.entries()].filter(([employmentId]) => addedNow.has(employmentId)),
        );
        // …but a deduction with nothing to settle is refused rather than taken. `payroll_input.loan_deduction`
        // survives the events that consume the reservation behind it (a scope narrow after prefill leaves the
        // input row while the reservation is spent), so an add can find itself about to take an instalment off
        // someone's pay with no reservation left to apply it against — the exact "deducted but never came off
        // the balance" outcome this item exists to prevent. See ReprocessAddLoanUnreconciledError.
        const loanAddedIds = addedNowIds.filter((id) => (appliedLoanCentsByEmp.get(id) ?? 0) > 0);
        if (loanAddedIds.length > 0) {
          const reservedRows = await tx
            .select({ employmentId: loanRepayment.employmentId })
            .from(loanRepayment)
            .where(
              and(
                eq(loanRepayment.reservedBatchId, p.batchId),
                eq(loanRepayment.status, 'reserved'),
                inArray(loanRepayment.employmentId, loanAddedIds),
              ),
            );
          const backed = new Set(reservedRows.map((r) => r.employmentId));
          const unbacked = loanAddedIds
            .filter((id) => !backed.has(id))
            .map((id) => ({ employmentId: id, deducted: round2((appliedLoanCentsByEmp.get(id) ?? 0) / 100) }));
          if (unbacked.length > 0) throw new ReprocessAddLoanUnreconciledError(unbacked);
        }
        await applyLoansForBatch(tx, ctx, p.batchId, addedLoanCents, addedNowIds);
      }

      // ── CLAIMS, for the added employments only, and MARK-PAID ONLY.
      //
      //    THE REQUEUE ARM IS DELIBERATELY NOT HERE. On a full generation, "reserved on this batch but
      //    got no payslip" means the claim was never disbursed, so unlinking it puts it back in the queue.
      //    On a subset that inference is false: everybody outside the subset also "got no payslip in this
      //    run", and unlinking their claims would strip claims off people the operator never selected —
      //    which is how the same claim gets paid a second time on the next run. A subset therefore only
      //    ever marks paid, and never unlinks.
      //
      //    AND IT MARKS PAID ONLY WHAT THE PAYSLIP ACTUALLY PAID. A claim reaches a payslip through
      //    `payroll_input.claim_allowance`, which is written by the draft-only claims prefill. An
      //    employment added after processing normally has no such row, so its payslip disburses nothing —
      //    marking its claim paid there would settle a claim the employee never received. The full
      //    generation can assume "payslip ⇒ disbursed" because prefill and generation are one workflow;
      //    an add is not, so the disbursement is checked rather than assumed.
      const claimAddedIds = addedNowIds.filter((id) => (claimAllowanceByEmp.get(id) ?? 0) > 0);
      if (claimAddedIds.length > 0) {
        const addedClaims = await tx
          .select({ id: claimRequest.id, employmentId: claimRequest.employmentId, amount: claimRequest.amount })
          .from(claimRequest)
          .where(
            and(
              eq(claimRequest.payrollBatchId, p.batchId),
              eq(claimRequest.status, 'approved'),
              inArray(claimRequest.employmentId, claimAddedIds),
            ),
          );
        // …AND WHAT IT PAYS MUST BE ACCOUNTED FOR. See ReprocessAddClaimUnreconciledError: an allowance
        // with no matching held claim is a claim that was requeued and will be paid again elsewhere.
        const unreconciled = claimAddedIds
          .map((id) => ({
            employmentId: id,
            allowance: round2(claimAllowanceByEmp.get(id) ?? 0),
            reserved: round2(
              addedClaims.filter((c) => c.employmentId === id).reduce((s, c) => s + Number(c.amount), 0),
            ),
          }))
          .filter((r) => r.allowance !== r.reserved);
        if (unreconciled.length > 0) throw new ReprocessAddClaimUnreconciledError(unreconciled);
        if (addedClaims.length > 0) {
          const paidNow = await tx
            .update(claimRequest)
            .set({ status: 'paid', paidAt: new Date(), payoutRef: `payroll:${batch.payPeriod}` })
            .where(inArray(claimRequest.id, addedClaims.map((c) => c.id)))
            .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
          for (const c of paidNow) {
            await appendEvent(tx, {
              tenantId: ctx.tenantId,
              aggregateType: 'claim-request',
              aggregateId: c.id,
              eventType: 'claim-request.paid',
              actor,
              subjectEmploymentId: c.employmentId,
              payload: { via: 'payroll', batchId: p.batchId, added: true },
            });
          }
        }
      }

      // Per-employee before/after result snapshots (dedicated audit table — reporter req.).
      const newSlips = await tx
        .select()
        .from(payslip)
        .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, emps.map((e) => e.employmentId))));
      for (const sl of newSlips) {
        await tx.insert(payrollEmployeeResultHistory).values({
          tenantId: ctx.tenantId,
          batchId: p.batchId,
          employmentId: sl.employmentId,
          // fbcf706d — an ADD is recorded as what it is. `action` is free text and `version_before` is
          // nullable, so this needs no migration; the null pair is exactly what "there was nothing here
          // before" means, and it is what stops the disclosure rendering a phantom rise from 0.00.
          action: addedNow.has(sl.employmentId) ? 'add' : 'reprocess',
          actorType: actor.type,
          actorId: actor.id ?? null,
          reason: subset.reason ?? null,
          versionBefore: versionByEmp.get(sl.employmentId) ?? null,
          versionAfter: sl.version,
          before: beforeByEmp.get(sl.employmentId) ?? null,
          after: {
            grossPay: sl.grossPay, netPay: sl.netPay, totalDeductions: sl.totalDeductions,
            employerCost: sl.employerCost, statutory: sl.statutory, version: sl.version,
          },
        });
      }
      // Status history (status is unchanged processed→processed, but the reprocess IS a status-control
      // event the reporter wants captured with actor/timestamp/reason + before/after totals).
      await tx.insert(payrollStatusHistory).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        action: 'reprocess',
        fromStatus: 'processed',
        toStatus: 'processed',
        actorType: actor.type,
        actorId: actor.id ?? null,
        reason: subset.reason ?? null,
        before: { totals: stored, employeeCount: batch.employeeCount },
        after: {
          totals: deltaTotals,
          employeeCount: Number(payslipCount),
          reprocessedEmploymentIds: emps.map((e) => e.employmentId),
          addedEmploymentIds: addedNowIds,
        },
      });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 'payroll-batch.selective-reprocessed',
        actor,
        payload: {
          batchId: p.batchId,
          companyId: batch.companyId,
          payPeriod: batch.payPeriod,
          // `reprocessedCount` keeps its established meaning — every employment this job wrote — so the
          // existing readers are unmoved. The split beside it is fbcf706d's: how many were corrected and
          // how many joined the run, which is what the result panel and the audit trail have to say.
          reprocessedCount: emps.length,
          recalculatedCount,
          addedCount: addedNow.size,
          addedEmploymentIds: addedNowIds,
          // The headcount AFTER the addition — recounted above. It used to be `batch.employeeCount`, i.e.
          // the figure from before this job ran, which is what made the result panel under-report.
          headcount: Number(payslipCount),
          reason: subset.reason ?? null,
          employmentIds: emps.map((e) => e.employmentId),
        },
      });
      // 49e7e0a2 — these employees' figures now match their transactions again, so the recalculation mark
      // is cleared FOR THEM ONLY. A reprocess that covers some of the waiting employees leaves the rest
      // marked, which is the whole point: Close stays refused until every stale employee is dealt with.
      await clearBatchRecalc(tx, ctx, { batchId: p.batchId, employmentIds: emps.map((e) => e.employmentId) });
      // 0db616f3 — these employees' payslips have just been rewritten from the current ledger, so every
      // one-off row of theirs on this run is now IN a payslip. Marking it here (and not only on the full
      // generation) is what covers the fbcf706d ADDED employment: its first payslip on this run is being
      // written now, and the rows attach-on-generate just stamped onto the run are in it.
      //
      // GATED ON THE SAME FLAG THE FOLD IS, and this is not caution — it is the marker's only claim. With
      // `payroll.individual_txn_pay_enabled` off the ledger is RECORD-ONLY and the fold above never ran,
      // so no row reached a payslip. Marking one consumed would be a lie that permanently strands it the
      // day the tenant turns the flag on. (Production has it on — verified 2026-08-13 — so the guard is
      // armed there; a tenant with it off has no double-pay to prevent because it pays none of these rows.)
      if (individualTxnPay) {
        await markIndividualTxnsConsumed(tx, { batchId: p.batchId, employmentIds: emps.map((e) => e.employmentId) });
      }
      return {
        reprocessed: emps.length,
        recalculated: recalculatedCount,
        added: addedNow.size,
        headcount: Number(payslipCount),
        totals: deltaTotals,
      };
    }

    // r226 — `emps.length` IS THE PAYSLIP COUNT, and after the skip block above that is no longer a
    // restatement of "everyone selected". `employeeCount` is the run's headcount on every screen and in
    // the dashboard timeline, so it has to be what the run actually paid; a skipped employee is reported
    // separately (see `skipped` on the return) and never counted here.
    await tx
      .update(payrollBatch)
      .set({ status: 'processed', employeeCount: emps.length, totals })
      .where(eq(payrollBatch.id, p.batchId));
    // 49e7e0a2 — a full draft→processed generation writes every payslip on the run from the current
    // inputs, so nothing on it can still be stale. (Reaching here means the run was draft, and a draft is
    // never marked; this clears the mark a reset→regenerate cycle would otherwise have to remember to.)
    await clearBatchRecalc(tx, ctx, { batchId: p.batchId, employmentIds: null });
    // 0db616f3 — and every one-off line this run folded is now IN a payslip. Stamped with the run that
    // paid it so a SECOND run cannot pay it again; a re-generation of THIS run still can, which is what
    // keeps reset→correct→re-run working. Same transaction as the payslip inserts above, so "paid" and
    // "marked paid" cannot come apart. Gated on the fold's own flag — see the subset branch's note.
    if (individualTxnPay) {
      await markIndividualTxnsConsumed(tx, { batchId: p.batchId, employmentIds: emps.map((e) => e.employmentId) });
    }

    // 1.2.8 Loan instalments reserved on this batch are now on a finalized payslip → advance the loan ledger
    // (decrement outstanding, increment instalments_paid, mark applied, auto-settle) — ADR-0060 two-phase.
    // Placed beside the claim-paid block so every irreversible loan mutation ties to a written payslip.
    //
    // r226 AUDITED THIS AND DELIBERATELY LEFT IT KEYED OFF THE RESERVATIONS, NOT OFF `emps`. It is the one
    // remaining side effect on this path that is not keyed off the written rows, and it is safe for the
    // skip for an arithmetic reason rather than a hopeful one: `rawLoan` is forced to 0 on EVERY
    // additional run, so `appliedLoanCentsByEmp` is 0 for the skipped and the paid alike and the applied
    // amount is 0 either way — a skipped employee's loan cannot move because there is nothing to move.
    // Narrowing this to the paid set would be strictly WORSE: the reservation would stay 'reserved'
    // against a now-processed batch, and `prefillLoansForBatch` only ever picks up 'scheduled' rows, so
    // it would be stranded until the run was reset. Left alone, the existing shortfall path re-schedules
    // the full due and the instalment survives to the next cycle.
    await applyLoansForBatch(tx, ctx, p.batchId, appliedLoanCentsByEmp);

    // Money-safety fix (Payroll Process wizard plan): taxable claims prefilled into this batch are marked
    // paid ONLY for employments that actually received a payslip in THIS run — not every claim reserved on
    // the batch. Before the filters, an unfiltered run always covered the whole company so `emps` and "every
    // reserved claim" were the same set; a scoped run made that assumption false — a claim reserved for
    // someone outside the run (or comp-less, so no payslip was written) would otherwise be marked paid with
    // nothing actually disbursed. Claims whose employment got no payslip here are UNLINKED (payrollBatchId
    // reset to null, status stays 'approved') so `prefillClaimsForBatch`'s isNull(payrollBatchId) filter
    // re-queues them on the next batch instead of stranding them forever.
    // r226 — and the additional-run skip is the third population this filter now covers: a skipped
    // employee is not in `emps`, so a claim reserved against this batch for them is REQUEUED rather than
    // marked paid, exactly as for a comp-less or out-of-scope employment. No new code — this is the
    // existing money-safety filter continuing to be right because `emps` means "who was paid".
    const paidEmploymentIds = new Set(emps.map((e) => e.employmentId));
    const reservedClaims = await tx
      .select({ id: claimRequest.id, employmentId: claimRequest.employmentId })
      .from(claimRequest)
      .where(and(eq(claimRequest.payrollBatchId, p.batchId), eq(claimRequest.status, 'approved')));
    const toMarkPaid = reservedClaims.filter((c) => paidEmploymentIds.has(c.employmentId)).map((c) => c.id);
    const toRequeue = reservedClaims.filter((c) => !paidEmploymentIds.has(c.employmentId)).map((c) => c.id);
    const paidClaims = toMarkPaid.length
      ? await tx
          .update(claimRequest)
          .set({ status: 'paid', paidAt: new Date(), payoutRef: `payroll:${batch.payPeriod}` })
          .where(inArray(claimRequest.id, toMarkPaid))
          .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId })
      : [];
    if (toRequeue.length) {
      await tx.update(claimRequest).set({ payrollBatchId: null }).where(inArray(claimRequest.id, toRequeue));
    }
    for (const c of paidClaims) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.paid',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { via: 'payroll', batchId: p.batchId },
      });
    }

    // M#16 (EA s.24 net-floor): if the period's headroom could not fully recover a manual deduction, CP38,
    // or loan for any employee, emit a batch-level clamp warning so the reduction is never silent (visible
    // on the batch summary / audit trail). Only the field NAMES + per-employee RM amounts of the clamped
    // deductions are recorded; no other cleartext pay. Omitted entirely when nothing was clamped.
    if (deductionClampsByEmp.size > 0) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-batch',
        aggregateId: p.batchId,
        eventType: 's24.deduction.clamped',
        actor: actorOf(ctx),
        payload: {
          batchId: p.batchId,
          clampedCount: deductionClampsByEmp.size,
          clamps: [...deductionClampsByEmp.entries()].map(([employmentId, c]) => ({ employmentId, ...c })),
        },
      });
    }

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.processed',
      actor: actorOf(ctx),
      payload: {
        // r226 — payslips written, which after the additional-run skip is not the same as employees
        // selected. The people the run left out are named beside it so the durable audit record answers
        // "why are there five payslips and forty-five employees" without the one-shot result payload.
        count: emps.length,
        totalNet: totals.net,
        ...(skippedEmployees.length > 0
          ? {
              skippedCount: skippedEmployees.length,
              skipped: skippedEmployees.map((s) => ({ employmentId: s.employmentId, reason: s.reason })),
            }
          : {}),
        // c7fdfcf6 gap-fix — the resolved payroll frequency + generated cut-off periods for this run. When the
        // frequency is weekly/biweekly (`disbursedPerCycle`), each payslip carries a per-cycle disbursement
        // schedule (statutory.paymentSchedule) so the run is FUNCTIONALLY processed per cycle, not audit-only.
        cutOffSchedule: { frequency: runFrequency, periods: runSchedule.periods, disbursedPerCycle: perCycle },
      },
    });
    // r226 — `payslips` is the number of payslips WRITTEN (it always was; the skip is what made the
    // distinction visible), and `skipped` names everyone this run had nothing to pay. The subset-reprocess
    // branch returns its own shape above and never carries a skip: it recomputes existing payslips.
    return { payslips: emps.length, totalNet: totals.net, skipped: skippedEmployees };
  });
}

export async function closeBatch(ctx: SessionContext, p: { batchId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        payPeriodId: payrollBatch.payPeriodId,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        // Read for the completeness control below, which is a REGULAR-run question — an additional run
        // pays extra money over days the regular run already owns and owns no days of its own.
        runType: payrollBatch.runType,
        needsRecalcAt: payrollBatch.needsRecalcAt,
        recalcEmploymentIds: payrollBatch.recalcEmploymentIds,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    // Granular RBAC (9bc442bc): payroll.close (configurable per company/tenant), not a coarse admin check.
    await assertPayrollPermission(tx, ctx, 'payroll.close', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotCloseableError();
    // 49e7e0a2 — a run whose one-off transactions changed after it was processed is NOT closeable until
    // those employees have been recalculated. Close is the point of no return: it releases payslips to
    // employees and cascades the pay period shut, so finalising figures that no longer match their inputs
    // is the one outcome the post-processing editing window must not be able to produce. Thrown BEFORE any
    // write, so a refused close changes nothing.
    if (batch.needsRecalcAt != null) {
      throw new BatchNeedsRecalculationError(asIdArray(batch.recalcEmploymentIds));
    }
    // ADR-0076 slice 3 — refuse while unresolved BLOCK anomalies stand against this run. Thrown BEFORE any
    // write, for the same reason as the check above: a refused close must change nothing. A batch with no
    // verdict rows returns an empty list here and is unaffected.
    const blocking = await openBlockingVerdicts(tx, p.batchId);
    if (blocking.length > 0) {
      throw new BatchHasBlockingAnomaliesError(blocking.map((b) => b.employmentId));
    }
    // THE CIRCUIT BREAKER ONLY APPLIES ONCE THIS BATCH HAS ACTUALLY BEEN EVALUATED, and that condition is
    // what keeps the whole slice additive. Unlike the per-employee guard above, the breaker is RECOMPUTED
    // from payslip totals rather than read from stored verdicts — so without this gate it would fire on
    // batches that predate the anomaly layer entirely, and a legitimate bonus month on an un-evaluated run
    // would suddenly refuse to close. `anomalyEvaluated` is true only when the evaluator has written
    // verdicts for this batch, i.e. when the operator is deliberately using the layer.
    if (await anomalyEvaluated(tx, p.batchId)) {
      const swing = await evaluateCircuitBreaker(tx, ctx.tenantId, p.batchId);
      if (swing.tripped) throw new BatchSwingTooLargeError(swing.movementPct ?? 0, swing.thresholdPct);
    }

    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    // 1b0943d5 — THE COMPLETENESS CONTROL, AT THE POINT THE MONEY BECOMES FINAL
    // ═══════════════════════════════════════════════════════════════════════════════════════════════
    //
    // "Refuse to finish with only one." Close is what finishing means: it releases payslips to employees
    // and cascades the pay period shut. So this is where a transferred month has to add up — every day of
    // the period claimed by exactly one employer's payslip, no gap and no overlap, across every company's
    // regular run for that period.
    //
    // WHY HERE AND NOT AT GENERATION. Two companies' runs for one month are two separate operations, and
    // one of them necessarily happens first. Refusing the first one because the second has not happened
    // yet would deadlock the pair. Generation therefore marks and records (see generatePayslips); close is
    // the moment by which every excuse has expired.
    //
    // THE CHECK IS THE CALENDAR, NOT THE MONEY, and that distinction is deliberate: two segments are two
    // independent statutory computations under two employers with their own allowances, transactions and
    // ceilings, so their gross figures are under no obligation to sum to anything. What is invariant is
    // that every day of August belongs to exactly one employer. See core/payroll-coverage.ts.
    //
    // ADDITIVE BY CONSTRUCTION: only employments whose entity history SPLITS this period are examined, so
    // a run with no mid-period transfer on it does one cheap indexed predicate and finds nobody to check —
    // which is every payroll run in this system to date.
    //
    // ── THE POPULATION IS WHAT THE PERIOD'S HISTORY SAYS THIS EMPLOYER OWNS, NOT WHAT THE RUN PAID ─────
    //
    // Deriving it from `payslip where batch_id = …` — this run's own slips — is the hole that made the
    // control unable to control. An employment with NO slip on the closing run is exactly the employment
    // that is being underpaid, and it would never have been examined:
    //
    //   the outgoing run is scoped and the mover is left out of it → it closes with no refusal at all;
    //   the incoming run is then refused by PayrollCounterpartClosedError, because the outgoing run is
    //   now frozen; and the operator's natural escape — drop the mover from the incoming scope too —
    //   leaves BOTH runs closed clean with the employee paid NOTHING for August. That state is REACHABLE
    //   today and the control never fires once.
    //
    // So the question asked here is the employer's obligation, not the run's output: who does the
    // `assignment` spine say this company employed during this period? `entityChangedDuring` narrows that
    // to the only people whose month can be split — the ones whose history names some entity other than
    // the one they sit in today — so on an ordinary company this WHERE returns zero rows and nothing
    // further happens. The run's own payslips are unioned in rather than replaced, because an employment
    // the run paid is one this close is finalising whatever the history now says about it.
    //
    // ⚠️ THE RESIDUAL, ON THE RECORD RATHER THAN FIXED HERE: this read is subject to RLS, and
    // `employment_rls` resolves through TODAY'S `employment.company_id` (core/employment-company.ts). An
    // operator scoped ONLY to the OUTGOING company therefore cannot see a transferred-out employment at
    // all, so `closeOwed` returns nothing for them and the outgoing run closes owing the mover its days.
    // It is contained rather than silent — the INCOMING run's close is then refused, because that
    // operator can see the employment — and the intended user of a transfer is an operator scoped to both
    // entities, which is the same population core/payroll-coverage.ts documents for the sibling-batch
    // read. Closing that hole means dating the RLS predicate itself, which is stage two's adoption pass.
    //
    // ── REGULAR RUNS ONLY, AND THIS IS A DECISION RATHER THAN AN INHERITANCE ────────────────────────
    //
    // A period may also hold off-cycle, bonus and adjustment runs (ADR-0024). They pay EXTRA money over
    // days the regular run already owns — they do not own days of their own, and core/payroll-coverage.ts
    // does not count their payslips as claims for exactly that reason (`run_type = 'regular'` on the batch
    // read; at most one regular run per company per period, `payroll_batch_one_regular_uq`, so the regular
    // runs of a period are the partition the tiling is asked about).
    //
    // Ungated, the refusal therefore fires on a run that owes the disputed days NOTHING: a bonus run for
    // August, for a company that happens to have a mid-period mover, could not be closed until every
    // employer's REGULAR August tiled the month. That is a refusal the operator cannot act on from the run
    // in front of them, and no money escapes by allowing it — the additional run's own payslips are not
    // claims, so closing one can neither create a hole nor fill one. The month is decided where the days
    // are paid, on the regular run, whose close still runs every arm below.
    //
    // GENERATION IS DELIBERATELY NOT GATED THE SAME WAY (see generatePayslips): it refuses on a CLOSED
    // counterpart before WRITING slips, which is about not creating an unrecoverable state, not about
    // finalising a month — and in the healthy split it is silent, because the counterpart's slip already
    // claims exactly its segment.
    if (batch.runType === 'regular') {
      const closePeriodStart = `${batch.payPeriod}-01`;
      const [cy, cm] = batch.payPeriod.split('-').map(Number);
      const closePeriodEnd = `${batch.payPeriod}-${String(daysInMonth(cy, cm)).padStart(2, '0')}`;
      // ── AND WHAT THE SLIPS THEMSELVES CLAIM, WHICH IS NOT THE SAME FACT AS TODAY'S HISTORY ──────────
      //
      // Everything above asks the `assignment` spine as it stands RIGHT NOW. A payslip is a claim written
      // at generation time, and the two can be made to disagree by an ordinary correction:
      //
      //   Fiamma → ISEDECOR effective 11 August is recorded; Fiamma's August is generated and X's slip is
      //   written CORRECTLY as 01–10 August; the movement is then CORRECTED — re-dated to 11 September
      //   (a fat-finger fix) or reversed (`reverseLegTx` supersedes the assignment leg and restores
      //   `employment.company_id`). August now resolves to ONE segment, Fiamma[01–31].
      //
      // Every arm below is downstream of the resolver, so an unsplit month never reaches them: X would be
      // dropped before the first one and Fiamma's run would close with ten days paid for a month it
      // employed X all thirty-one of — short 2,129.03, which is the production figure this control exists
      // to prevent, reached by a different road.
      //
      // So a slip NARROWER THAN ITS PERIOD is read as its own claim that the month is split, and it is
      // enough on its own to keep the employment in the examined population (`partialClaimIds`). The
      // arms then do the work: the single segment says Fiamma owns 01–31, the slip says it issued 01–10,
      // so `counterparts[].stale` fires — and the eleventh onward is a gap unless somebody else's slip
      // claims it, in which case that claim belongs to an employer the history no longer names.
      //
      // The predicate is one indexed read of THIS run's own payslips and needs no entity history at all.
      // `statutory -> 'segment'` is the same question asked of a slip written between r194 and migration
      // 0446, whose coverage lives in the jsonb stamp — `payslipCoverage` reads both homes, and a
      // population that read only the columns would drop exactly the slips r194 issued. Every ordinary
      // slip covers its whole period, so on any run without a split month this returns nobody.
      const closeSlips = await tx
        .select({
          employmentId: payslip.employmentId,
          partial: sql<boolean>`coalesce(
            ${payslip.coverageFrom} > ${closePeriodStart}
              or ${payslip.coverageTo} < ${closePeriodEnd}
              or ${payslip.statutory} -> 'segment' is not null,
            false
          )`,
        })
        .from(payslip)
        .where(eq(payslip.batchId, p.batchId));
      const closeOwed = await tx
        .select({ id: employment.id })
        .from(employment)
        .where(
          and(
            employedByCompanyDuring(batch.companyId, closePeriodStart, closePeriodEnd),
            entityChangedDuring(closePeriodStart, closePeriodEnd),
            // The same tenure predicate generatePayslips selects on, so somebody whose employment did not
            // overlap this period at all cannot refuse a close over days nobody owed them.
            lte(employment.hiredOn, closePeriodEnd),
            or(isNull(employment.terminatedOn), gte(employment.terminatedOn, closePeriodStart)),
          ),
        );
      const closeIds = [...new Set([...closeSlips.map((s) => s.employmentId), ...closeOwed.map((e) => e.id)])];
      if (closeIds.length > 0) {
        const closeCurrentCompany = new Map(
          (
            await tx
              .select({ id: employment.id, companyId: employment.companyId })
              .from(employment)
              .where(inArray(employment.id, closeIds))
          ).map((r) => [r.id, r.companyId] as const),
        );
        const closeCoverage = await segmentedCoverage(tx, {
          payPeriod: batch.payPeriod,
          periodStart: closePeriodStart,
          periodEnd: closePeriodEnd,
          employmentIds: closeIds,
          currentCompanyById: closeCurrentCompany,
          partialClaimIds: closeSlips.filter((s) => s.partial).map((s) => s.employmentId),
        });
        // THREE ARMS, BECAUSE THE MONTH CAN FAIL TO ADD UP IN THREE DIFFERENT SHAPES and the calendar test
        // alone sees only two of them:
        //
        //   `defects`            — the days themselves: an unpaid stretch, or one claimed twice.
        //   `missingCompanyIds`  — a segment whose employer has no regular run for the period at all. Its
        //                          days usually show as a gap too, but not when somebody ELSE's slip claims
        //                          them, which is an overlap the gap test alone would be satisfied by.
        //   `counterparts[].stale` — AND THIS IS THE ONE THAT WAS COMPUTED AND NEVER READ. It asks each
        //                          segment's employer "have you issued exactly these days?", which is a
        //                          different question from "is every day of the month claimed by someone".
        //                          The ordinary sequence that closed clean without it: Fiamma's August is
        //                          processed BEFORE the transfer is recorded, so it holds a whole-month
        //                          slip; the transfer to ISEDECOR effective 11 August is then recorded;
        //                          ISEDECOR's run exists as a DRAFT. Every day of August is claimed — by
        //                          Fiamma, for days it does not own — so there is no gap and no overlap,
        //                          and a draft batch is not a missing company. Both surviving arms pass.
        //                          `stale` says what is actually wrong: Fiamma has issued 01–31 where it
        //                          owes 01–10, and ISEDECOR has issued nothing at all.
        const bad = closeCoverage.filter(
          (c) => c.defects.length > 0 || c.missingCompanyIds.length > 0 || c.counterparts.some((cp) => cp.stale),
        );
        if (bad.length > 0) throw new PayrollCoverageIncompleteError(bad);
      }
    }
    // Step 6 (f3148da1) — compute the payslip RELEASE instant NOW, under this admin session (which can read the
    // company release config; the ESS employee session cannot, so the gate must be materialized here, not at
    // read time). We read the company's release config + pay-day and derive releasedAt from the close instant;
    // NULL config ⇒ immediate ⇒ releasedAt = closedAt (today's behaviour). The ESS reads gate on released_at.
    const closedAt = new Date();
    const [cpc] = await tx
      .select({ payDay: companyPayrollConfig.payDay, payslipRelease: companyPayrollConfig.payslipRelease })
      .from(companyPayrollConfig)
      .where(eq(companyPayrollConfig.companyId, batch.companyId))
      .limit(1);
    const releasedAt = payslipReleaseAt(closedAt, batch.payPeriod, cpc?.payDay ?? null, cpc?.payslipRelease ?? null) ?? closedAt;
    await tx
      .update(payrollBatch)
      .set({ status: 'closed', closedAt: sql`now()`, releasedAt })
      .where(eq(payrollBatch.id, p.batchId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.closed',
      actor: actorOf(ctx),
      payload: { releasedAt: releasedAt.toISOString() },
    });

    // Wave 2C (ADR-0024): close the parent pay_period once ALL its runs are closed, so the statutory
    // month becomes immutable. A single-run month closes its period when that run closes.
    const siblings = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.payPeriodId, batch.payPeriodId));
    if (siblings.every((s) => s.status === 'closed')) {
      await tx.update(payPeriod).set({ status: 'closed' }).where(eq(payPeriod.id, batch.payPeriodId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: batch.payPeriodId,
        eventType: 'pay-period.closed',
        actor: actorOf(ctx),
        payload: {},
      });
    }
  });
}

/**
 * UNWIND THE LOAN-LEDGER ADVANCE a processing run made — the mirror image of `applyLoansForBatch`
 * (ADR-0060), and the ONE implementation of it.
 *
 * 9066bd6c EXTRACTED THIS, IT DID NOT REWRITE IT. Every line below is `resetProcessedBatch`'s block
 * verbatim; the only addition is the `employmentIds` narrowing. A per-employee removal has to unwind
 * exactly what a reset unwinds — for one person — and a second copy of the shortfall / reserved-vs-
 * scheduled / auto-settle-reopen reasoning is a second answer waiting to disagree with the first about
 * somebody's loan balance.
 *
 * `employmentIds: null` ⇒ every applied repayment on the run (a reset). A non-empty array narrows to
 * those employments; an EMPTY array unwinds NOTHING (never widened to "all" — see the same rule on
 * `releaseIndividualTxnsConsumed`).
 *
 * `cause` is stamped on the two events as `reason` so the trail says which action reversed the
 * instalment: 'payroll-reset' for the whole-run reset, 'payroll-employee-removed' for a removal.
 */
async function unwindAppliedLoanRepayments(
  tx: Tx,
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[] | null; cause: 'payroll-reset' | 'payroll-employee-removed' },
): Promise<{ reversed: number; loansReopened: number }> {
  if (p.employmentIds != null && p.employmentIds.length === 0) return { reversed: 0, loansReopened: 0 };
  const toC = (v: unknown) => Math.round(Number(v) * 100);
  const fromC = (c: number) => (c / 100).toFixed(2);
  const appliedReps = await tx
    .select()
    .from(loanRepayment)
    .where(
      and(
        eq(loanRepayment.appliedBatchId, p.batchId),
        eq(loanRepayment.status, 'applied'),
        ...(p.employmentIds == null ? [] : [inArray(loanRepayment.employmentId, p.employmentIds)]),
      ),
    );
  let loansReopened = 0;
  for (const rep of appliedReps) {
    const [loan] = await tx.select().from(employeeLoan).where(eq(employeeLoan.id, rep.loanId)).limit(1);
    if (!loan) continue;
    const appliedCents = toC(rep.appliedAmount);
    const dueCents = toC(rep.dueAmount);

    // Apply-time shortfall: when the net≥0 clamp funded less than the reserved due, apply inserted a
    // 'scheduled' remainder row. Remove it and restore the full due on the reservation; if it can no
    // longer be found (amended / re-reserved by a later cycle since processing), fall back to
    // restoring only the actually-recovered amount so the schedule still sums to outstanding exactly.
    let restoredDue = rep.dueAmount;
    if (appliedCents < dueCents) {
      const shortfall = fromC(dueCents - appliedCents);
      const [sfRow] = await tx
        .select({ id: loanRepayment.id })
        .from(loanRepayment)
        .where(
          and(
            eq(loanRepayment.loanId, rep.loanId),
            eq(loanRepayment.status, 'scheduled'),
            eq(loanRepayment.dueAmount, shortfall),
          ),
        )
        .orderBy(desc(loanRepayment.sequenceNo))
        .limit(1);
      if (sfRow) {
        await tx.delete(loanRepayment).where(eq(loanRepayment.id, sfRow.id));
      } else {
        restoredDue = fromC(appliedCents);
      }
    }

    // Back to the exact pre-generation state: RESERVED on this batch (reserved_batch_id was never
    // cleared by apply), applied fields zeroed. If another batch reserved a row for this loan since
    // processing, the one-reserved-per-loan partial unique forbids a second reservation — release to
    // 'scheduled' instead (the next prefill converges).
    const [otherReserved] = await tx
      .select({ id: loanRepayment.id })
      .from(loanRepayment)
      .where(and(eq(loanRepayment.loanId, rep.loanId), eq(loanRepayment.status, 'reserved')))
      .limit(1);
    await tx
      .update(loanRepayment)
      .set({
        ...(otherReserved ? { status: 'scheduled', reservedBatchId: null } : { status: 'reserved' }),
        dueAmount: restoredDue,
        appliedBatchId: null,
        appliedAmount: '0',
        appliedAt: null,
      })
      .where(eq(loanRepayment.id, rep.id));

    // Restore the single authoritative ledger; reopen a loan this apply auto-settled. (A loan
    // manually settled AFTER processing also reopens here — the event trail tells that story.)
    const reopen = loan.status === 'settled' && appliedCents > 0;
    await tx
      .update(employeeLoan)
      .set({
        outstandingBalance: fromC(toC(loan.outstandingBalance) + appliedCents),
        instalmentsPaid: Math.max(0, loan.instalmentsPaid - (appliedCents > 0 ? 1 : 0)),
        ...(reopen ? { status: 'active' as const } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(employeeLoan.id, loan.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'loan-repayment',
      aggregateId: rep.id,
      eventType: 'loan.instalment.reversed',
      actor: actorOf(ctx),
      subjectEmploymentId: rep.employmentId,
      payload: { batchId: p.batchId, loanId: rep.loanId, reason: p.cause },
    });
    if (reopen) {
      loansReopened += 1;
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'employee-loan',
        aggregateId: loan.id,
        eventType: 'loan.reopened',
        actor: actorOf(ctx),
        subjectEmploymentId: loan.employmentId,
        payload: { batchId: p.batchId, reason: p.cause },
      });
    }
  }
  return { reversed: appliedReps.length, loansReopened };
}

/**
 * Payroll Reset / Zeroization (feedback a03b2d9b) — revert a PROCESSED run to DRAFT by reversing
 * exactly what generatePayslips did:
 *   1. loan-ledger advance is unwound (outstanding restored, instalments_paid decremented, the
 *      applied repayment back to 'reserved' on this batch, an apply-time shortfall re-schedule row
 *      removed, an auto-settled loan reopened);
 *   2. claims this batch marked paid go back to 'approved' (paidAt/payoutRef cleared) and STAY
 *      queued on the batch (payroll_batch_id kept) so the re-run re-picks them;
 *   3. the payslips are deleted and the batch's derived results (totals, employee_count) cleared;
 *   4. status returns to 'draft'.
 * The admin's keyed DRAFT inputs (payroll_input, payroll_individual_txn, payroll_batch_component)
 * are deliberately PRESERVED — the approved plan's "return to Draft so they can amend and
 * reprocess" semantics — so an unchanged reset → regenerate is byte-identical. That is also why
 * teardownDraftChildren is NOT called here: it is the draft-DELETE cascade, which wipes the keyed
 * inputs and detaches claims; a reset keeps both. (generatePayslips never touches those tables, so
 * reversing it must not either.)
 *
 * Safety vs 0011_payroll_immutability.sql: the triggers freeze 'closed' batches/payslips ONLY —
 * 'processed' is deliberately not trigger-frozen, which is what makes this reset DB-legal. The
 * status guard below refuses anything but 'processed'; a closed batch stays permanently immutable
 * (the trigger is the hard backstop even if this app-level guard were ever bypassed). The parent
 * pay_period needs no work: it only closes when ALL runs close, so a processed run's period is
 * still 'open'.
 *
 * Event sourcing: history is never deleted — the earlier payroll-batch.processed /
 * claim-request.paid / loan.instalment.applied events stay; this appends reversal events so the
 * log reads processed → reset → (re)processed. Statutory-report artefacts already recorded for
 * this company+period are counted into the reset payload for audit visibility (the approved plan
 * gates reset on batch status only — recorded reports are append-only artefacts, reproducible
 * after the corrected re-run).
 */
export async function resetProcessedBatch(ctx: SessionContext, p: { batchId: string; reason?: string }) {
  // Ships dark behind a flag (approved plan): enable per environment after review.
  if (!settingEnabled(ctx, 'payroll.reset_enabled')) {
    // SettingNotEnabledError, not ModuleNotEnabledError('payroll'): this tenant owns Payroll. What is
    // off is an operator-controlled risk switch, and `ModuleNotEnabledError.moduleCode` exists so a
    // caller can say "not on your plan" — which would be a false billing statement here.
    throw new SettingNotEnabledError('payroll.reset_enabled', 'Payroll reset is not enabled.');
  }
  // Mandatory reason (feedback d1ed1e99): reverting a processed run to draft is a sensitive, audited
  // action (zeroizes payslips/totals + unwinds loans/claims) — reject a blank/whitespace-only reason
  // BEFORE any deletion or status change so nothing is mutated. Mirrors unlockClosedBatch.
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new ResetReasonRequiredError();
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        totals: payrollBatch.totals,
        employeeCount: payrollBatch.employeeCount,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    // Granular RBAC (9bc442bc): payroll.rollback (configurable per company/tenant). Defaults to
    // hr_admin/super_admin — a payroll_partner is refused exactly as before — but now an operator can
    // re-map it. RLS still scopes WHICH batches resolve (a cross-company batch reads as "batch not found").
    await assertPayrollPermission(tx, ctx, 'payroll.rollback', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotResettableError();

    // ── 1. Unwind the loan-ledger advance (mirror-image of applyLoansForBatch, ADR-0060) ──
    // ONE implementation, shared with removeEmployeePayroll — see unwindAppliedLoanRepayments. `null`
    // means the whole run, which is exactly what a reset unwinds.
    const { reversed: loanInstalmentsReversed, loansReopened } = await unwindAppliedLoanRepayments(tx, ctx, {
      batchId: p.batchId,
      employmentIds: null,
      cause: 'payroll-reset',
    });

    // ── 2. Un-mark the claims THIS batch paid (mirror-image of the generate-time paid block) ──
    // They go back to 'approved' but STAY stamped on the batch, exactly the pre-generation queued
    // state, so the corrected re-run re-picks them. (Claims the generation UNLINKED — out-of-scope
    // employments — already have payroll_batch_id null and need no reversal.)
    const revertedClaims = await tx
      .update(claimRequest)
      .set({ status: 'approved', paidAt: null, payoutRef: null })
      .where(and(eq(claimRequest.payrollBatchId, p.batchId), eq(claimRequest.status, 'paid')))
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
    for (const c of revertedClaims) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.payment-reversed',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { batchId: p.batchId, reason: 'payroll-reset' },
      });
    }

    // ── 3. Clear the calculation results; 4. back to draft ──
    // (Per-payslip history lives on the earlier processed-batch events; the batch-level reset event
    // below records the count — same convention as teardownDraftChildren's child deletes.)
    const clearedSlips = await tx.delete(payslip).where(eq(payslip.batchId, p.batchId)).returning({ id: payslip.id });
    // 0db616f3 (0437) — the payslips that justified the consumed marker have just been deleted, so the
    // one-off lines this run paid are unpaid again and the corrected re-run must pay them. Without this
    // the re-run would still pay them (the fold's `OR consumed_batch_id = this batch` half), but the row
    // would read "paid by a run that no longer has a payslip for it" to everything else, and a row
    // re-pointed to another run afterwards would be refused money nobody ever received.
    await releaseIndividualTxnsConsumed(tx, p.batchId);
    // 49e7e0a2 — clear the recalculation mark BEFORE the status goes back to draft. Every payslip on the
    // run has just been deleted, so there is no longer a stale figure for it to describe; leaving it set
    // would block the Close of the run that eventually replaces these payslips for a staleness that no
    // longer exists. (Order matters: clearBatchRecalc appends its event against the batch, and doing it
    // first keeps the history reading processed → recalc-cleared → reset.)
    await clearBatchRecalc(tx, ctx, { batchId: p.batchId, employmentIds: null });
    await tx
      .update(payrollBatch)
      .set({ status: 'draft', totals: null, employeeCount: 0 })
      .where(eq(payrollBatch.id, p.batchId));

    // Audit visibility (not a gate): statutory-report artefacts already recorded for this
    // company+month — the resetting admin's cue that agency files may need regenerating.
    const statReports = await tx
      .select({ id: statutoryReport.id })
      .from(statutoryReport)
      .where(and(eq(statutoryReport.companyId, batch.companyId), eq(statutoryReport.periodKey, batch.payPeriod)));

    // Dedicated status-history row (reporter expected_function: payroll_status_history captures actor,
    // timestamp, reason, and before/after snapshot for every rollback / unlock / reprocess). Mirrors the
    // unlock/reprocess inserts so the rollback path is uniformly queryable, not only via the domain event.
    const resetActor = actorOf(ctx);
    await tx.insert(payrollStatusHistory).values({
      tenantId: ctx.tenantId,
      batchId: p.batchId,
      action: 'rollback',
      fromStatus: 'processed',
      toStatus: 'draft',
      actorType: resetActor.type,
      actorId: resetActor.id ?? null,
      reason,
      before: { status: 'processed', totals: batch.totals, employeeCount: batch.employeeCount },
      after: {
        status: 'draft',
        totals: null,
        employeeCount: 0,
        payslipsCleared: clearedSlips.length,
        loanInstalmentsReversed,
        loansReopened,
        claimsReverted: revertedClaims.length,
      },
    });

    // ONE batch-level reset event summarising every reversal (reporter req. #5: who / when /
    // period / company / optional reason — actor + occurredAt + this payload).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.reset',
      actor: resetActor,
      payload: {
        fromStatus: 'processed',
        toStatus: 'draft',
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        payPeriodId: batch.payPeriodId,
        runType: batch.runType,
        runSeq: batch.runSeq,
        reason,
        payslipsCleared: clearedSlips.length,
        loanInstalmentsReversed,
        loansReopened,
        claimsReverted: revertedClaims.length,
        statutoryReportsForPeriod: statReports.length,
      },
    });
    return {
      payslipsCleared: clearedSlips.length,
      loanInstalmentsReversed,
      claimsReverted: revertedClaims.length,
    };
  });
}

// ─────────────── Granular payroll RBAC (feedback 9bc442bc, reporter expected_function) ───────────────
export class PayrollPermissionDeniedError extends Error {
  constructor(public key: string) {
    super(`You do not have the '${key}' payroll permission.`);
    this.name = 'PayrollPermissionDeniedError';
  }
}
/** Unlock target is not a closed run (nothing to unlock). */
export class BatchNotUnlockableError extends Error {
  constructor() {
    super('Only a closed payroll process can be unlocked');
    this.name = 'BatchNotUnlockableError';
  }
}
/**
 * Close target is not a processed run (feedback ef31d251). Named, rather than the bare Error it replaced,
 * for the same two reasons BatchNotUnlockableError is named: closeAction can map the refusal to translated
 * copy instead of pushing a raw English core string into the URL, and a test can assert the constraint
 * NAME rather than a message string that would also match the wrong throw. Message text is unchanged from
 * the bare Error so anything that logs it reads identically.
 */
export class BatchNotCloseableError extends Error {
  constructor() {
    super('Only a processed batch can be closed');
    this.name = 'BatchNotCloseableError';
  }
}
/**
 * A blank / whitespace-only reason was supplied to unlockClosedBatch (feedback 2108c01f). Reopening a
 * finalised run is a sensitive, audited action — the reason is MANDATORY so the history log always
 * explains WHY a closed run was reopened. Thrown BEFORE the status flip so nothing is mutated.
 */
export class UnlockReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to unlock a closed payroll process.');
    this.name = 'UnlockReasonRequiredError';
  }
}

const callerRolesOf = (ctx: SessionContext): string[] => [
  ...(ctx.roles ?? []),
  ...(ctx.grants ?? []).map((g) => g.role),
];

/**
 * Resolve a granular payroll permission for the caller (reporter req.: payroll.rollback / unlock /
 * reprocess.selective / close, configurable per company/tenant). Company-scoped override rows win over
 * tenant-wide rows, which win over the code defaults (lib/payroll-permissions.ts). Read within the
 * caller's tx (the grant table is tenant-readable under RLS).
 */
export async function resolvePayrollPermission(
  tx: Tx,
  ctx: SessionContext,
  key: PayrollPermissionKey,
  companyId?: string | null,
): Promise<boolean> {
  const rows = await tx
    .select({ role: payrollPermissionGrant.role, allowed: payrollPermissionGrant.allowed, companyId: payrollPermissionGrant.companyId })
    .from(payrollPermissionGrant)
    .where(
      and(
        eq(payrollPermissionGrant.tenantId, ctx.tenantId),
        eq(payrollPermissionGrant.permissionKey, key),
        companyId
          ? or(isNull(payrollPermissionGrant.companyId), eq(payrollPermissionGrant.companyId, companyId))
          : isNull(payrollPermissionGrant.companyId),
      ),
    );
  return decidePayrollPermission({
    key,
    callerRoles: callerRolesOf(ctx),
    overrides: rows.map((r) => ({ role: r.role, allowed: r.allowed, companyScoped: r.companyId != null })),
  });
}

async function assertPayrollPermission(tx: Tx, ctx: SessionContext, key: PayrollPermissionKey, companyId?: string | null) {
  if (!(await resolvePayrollPermission(tx, ctx, key, companyId))) throw new PayrollPermissionDeniedError(key);
}

// Note (feedback 62e85140): the step-up (OTP) confirmation-code flow that used to gate Unlock has been
// removed — the UI now uses a single confirm dialog instead. The `payroll_step_up_challenge` table
// (db/schema.ts, migration 0173) is intentionally LEFT IN PLACE (no destructive migration) and is now
// UNUSED by the unlock path; deleteDraftBatch still cascades its rows on a draft teardown.

/**
 * Unlock a CLOSED payroll run back to PROCESSED (feedback 9bc442bc, reporter ask #2; simplified in
 * 62e85140). This is the controlled, auditable reversal of the 0011 closed-immutability freeze:
 *   • gated on the granular payroll.unlock permission (hr_admin + super_admin by default, per-company configurable);
 *   • a mandatory reason is captured for the audit log (the on-screen step is a single confirm dialog);
 *   • WARNS when the run's payment summary was already exported and/or statutory returns were already
 *     recorded for the month (EPF/SOCSO/EIS/LHDN), so the operator knows an amended filing may be needed;
 *   • flips status via a transaction-local escape hatch the 0011 trigger honours ONLY for this batch id;
 *   • reopens the parent pay_period (it was cascaded closed) so a correction re-run is possible;
 *   • records a payroll_status_history row (before/after + reason + warnings) and appends domain events.
 * Gated behind PAYROLL_UNLOCK_ENABLED so an environment can keep Closed permanently frozen if it prefers
 * the same-month adjustment-run correction path instead.
 */
export async function unlockClosedBatch(ctx: SessionContext, p: { batchId: string; reason?: string }) {
  if (!settingEnabled(ctx, 'payroll.unlock_enabled')) {
    // See resetProcessedBatch — a risk switch being off is not "Payroll is not on your plan".
    throw new SettingNotEnabledError('payroll.unlock_enabled', 'Payroll unlock is not enabled.');
  }
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new UnlockReasonRequiredError();
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    await assertPayrollPermission(tx, ctx, 'payroll.unlock', batch.companyId);
    if (batch.status !== 'closed') throw new BatchNotUnlockableError();

    // Warning flags (reporter req.: warn if payment disbursed or statutory submission filed). 49e7e0a2
    // moved the derivation into `batchDownstreamWarnings` so the Individual Transaction screen can show the
    // SAME facts before it saves an edit onto a processed run — one implementation, one answer.
    const warnings = await batchDownstreamWarnings(tx, {
      batchId: p.batchId,
      companyId: batch.companyId,
      payPeriod: batch.payPeriod,
    });

    // Flip status via the 0011 escape hatch (transaction-local; cleared at COMMIT — see migration 0163).
    await tx.execute(sql`select set_config('app.unlock_batch', ${p.batchId}, true)`);
    await tx.update(payrollBatch).set({ status: 'processed' }).where(eq(payrollBatch.id, p.batchId));

    // Reopen the parent pay_period (closeBatch cascaded it closed once all runs closed).
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    const reopenedPeriod = period?.status === 'closed';
    if (reopenedPeriod) {
      // Reopening a closed period is blocked by the guard_closed_pay_period trigger (migration 0067) unless we
      // signal a controlled unlock via the app.unlock_pay_period escape hatch (migration 0202) — same pattern as
      // the batch guard's app.unlock_batch above. Transaction-local; cleared at COMMIT.
      await tx.execute(sql`select set_config('app.unlock_pay_period', ${batch.payPeriodId}, true)`);
      await tx.update(payPeriod).set({ status: 'open' }).where(eq(payPeriod.id, batch.payPeriodId));
    }

    const actor = actorOf(ctx);
    await tx.insert(payrollStatusHistory).values({
      tenantId: ctx.tenantId,
      batchId: p.batchId,
      action: 'unlock',
      fromStatus: 'closed',
      toStatus: 'processed',
      actorType: actor.type,
      actorId: actor.id ?? null,
      reason,
      before: { status: 'closed', periodReopened: reopenedPeriod },
      after: { status: 'processed', warnings },
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.unlocked',
      actor,
      payload: { companyId: batch.companyId, payPeriod: batch.payPeriod, reason, warnings, reopenedPeriod },
    });
    if (reopenedPeriod) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'pay-period',
        aggregateId: batch.payPeriodId,
        eventType: 'pay-period.reopened',
        actor,
        payload: { batchId: p.batchId, reason },
      });
    }
    return { warnings, reopenedPeriod };
  });
}

/**
 * Selective per-employee reprocessing (feedback 9bc442bc, reporter ask #3 + #8) — QUEUE-BASED.
 *
 * The public entry: validate + permission-check + enqueue an idempotent job, then run it. Enqueue creates
 * ONE `payroll_reprocess_job` row keyed by an idempotency key (a double-clicked/retried submit reuses the
 * same job instead of spawning a duplicate run — the reporter's double-submit guard), whose status the UI
 * polls (getReprocessJob + the /api/payroll/reprocess-job route). Running the job performs a TRUE in-place
 * recompute of exactly the selected employees via generatePayslips' reprocessSubset path: their payslips
 * are recomputed + version-bumped (OCC), everyone else's stay physically untouched, and batch totals/GL
 * are updated BY DELTA — the reporter's ask #8, not a scope substitution.
 */
export async function reprocessSelectedEmployees(
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[]; reason?: string; idempotencyKey?: string },
) {
  if (!isModuleEnabled(ctx, 'multi_cycle_payroll')) {
    throw new ModuleNotEnabledError('multi_cycle_payroll', 'Multiple payroll runs per month are not enabled.');
  }
  const requested = [...new Set(p.employmentIds.filter(Boolean))].sort();
  if (requested.length === 0) throw new Error('Select at least one employee to reprocess.');

  // Phase 1 — validate + permission + enqueue (idempotent). Its own tx so the job row commits before the
  // recompute runs (so a poll can observe 'running', and a crash mid-recompute leaves a re-runnable job).
  const enq = await withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, payPeriodId: payrollBatch.payPeriodId, employeeCount: payrollBatch.employeeCount })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    await assertPayrollPermission(tx, ctx, 'payroll.reprocess.selective', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotResettableError();
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    if (period?.status === 'closed') throw new Error('This pay period is closed.');

    // Cross-company membership intersection (a stale/cross-company id can never widen the run).
    //
    // ── 1b0943d5, SITE 4 OF 5 — DATED, AND THIS ONE IS THE REPORTED BUG. ─────────────────────────────
    // "None of the selected employees belong to this run." is the error the reporter hit trying to
    // reprocess August for employee 100814 on the FIAMMA run — thrown from exactly here, on exactly this
    // predicate. 100814's `employment.company_id` had already moved to ISEDECOR, so the outgoing
    // employer's own run refused to recompute the ten days it owes, which is the run that has to produce
    // the missing counterpart payslip. Every other read on this path was widened in stage one; this one
    // is the gate in front of them, so leaving it on the column made the rest unreachable.
    //
    // It still only NARROWS: the id must have belonged to this company during this period, so a stale or
    // cross-company id cannot widen the run any more than it could before. What changes is that "belonged
    // to" is now a fact about the period rather than about today.
    const [ry, rm] = batch.payPeriod.split('-').map(Number);
    const reprocessPeriodStart = `${batch.payPeriod}-01`;
    const reprocessPeriodEnd = `${batch.payPeriod}-${String(daysInMonth(ry, rm)).padStart(2, '0')}`;
    const companyEmps = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(
        and(
          employedByCompanyDuring(batch.companyId, reprocessPeriodStart, reprocessPeriodEnd),
          inArray(employment.id, requested),
        ),
      );
    const employmentIds = requested.filter((id) => companyEmps.some((e) => e.id === id));
    if (employmentIds.length === 0) throw new Error('None of the selected employees belong to this run.');

    // Idempotency: default key binds batch + exact selection + reason so an identical resubmit dedupes,
    // while a genuinely different request (different pick) enqueues its own job.
    const idempotencyKey =
      p.idempotencyKey?.trim() ||
      createHash('sha256').update(`${p.batchId}:${employmentIds.join(',')}:${p.reason ?? ''}`).digest('hex');

    // ON CONFLICT DO NOTHING → a duplicate submit reuses the existing job row.
    await tx
      .insert(payrollReprocessJob)
      .values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        idempotencyKey,
        status: 'queued',
        employmentIds,
        reason: p.reason ?? null,
        requestedBy: ctx.userId ?? null,
      })
      .onConflictDoNothing({ target: [payrollReprocessJob.tenantId, payrollReprocessJob.idempotencyKey] });
    const [job] = await tx
      .select()
      .from(payrollReprocessJob)
      .where(and(eq(payrollReprocessJob.tenantId, ctx.tenantId), eq(payrollReprocessJob.idempotencyKey, idempotencyKey)))
      .limit(1);
    return { job, employmentIds };
  });

  const job = enq.job;
  // Idempotent replay: a completed job returns its stored result without re-running (double-submit safety).
  if (job.status === 'completed') {
    return { jobId: job.id, status: 'completed' as const, ...(job.result as Record<string, unknown> | null) };
  }
  if (job.status === 'running') {
    return { jobId: job.id, status: 'running' as const };
  }

  // Phase 2 — atomically CLAIM the job (queued→running) so a concurrent duplicate request can never
  // run the recompute twice; if the claim updates no row, another worker already took it → don't re-run.
  const claimed = await withTenant(ctx, (tx) =>
    tx
      .update(payrollReprocessJob)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(payrollReprocessJob.id, job.id), eq(payrollReprocessJob.status, 'queued')))
      .returning({ id: payrollReprocessJob.id }),
  );
  if (claimed.length === 0) {
    return { jobId: job.id, status: 'running' as const };
  }
  try {
    const result = await generatePayslips(ctx, {
      batchId: p.batchId,
      reprocessSubset: { employmentIds: enq.employmentIds, reason: p.reason, actorId: ctx.userId },
    });
    await withTenant(ctx, (tx) =>
      tx
        .update(payrollReprocessJob)
        .set({ status: 'completed', result: result as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(payrollReprocessJob.id, job.id)),
    );
    return { jobId: job.id, status: 'completed' as const, ...result };
  } catch (e) {
    await withTenant(ctx, (tx) =>
      tx
        .update(payrollReprocessJob)
        .set({ status: 'failed', error: (e as Error).message, updatedAt: new Date() })
        .where(eq(payrollReprocessJob.id, job.id)),
    );
    throw e;
  }
}

/** Job-status read for the polling endpoint (reporter req.: a job-status endpoint for the UI). */
export async function getReprocessJob(ctx: SessionContext, jobId: string) {
  return withTenant(ctx, async (tx) => {
    const [job] = await tx
      .select({
        id: payrollReprocessJob.id,
        batchId: payrollReprocessJob.batchId,
        status: payrollReprocessJob.status,
        result: payrollReprocessJob.result,
        error: payrollReprocessJob.error,
        // e440991b — the RESULTS panel on /payroll/<id>/reprocess reads this job back to say what it
        // did. It needs the SELECTION (which employees this job actually ran, after the cross-company
        // intersection narrowed the posted ids) and the instant it was claimed, so it can pick out the
        // payroll_employee_result_history rows THIS job wrote rather than every recomputation the run
        // has ever had. Purely additive to the projection; the polling route JSON-encodes whatever it
        // is handed and both fields are already tenant-fenced by RLS.
        employmentIds: payrollReprocessJob.employmentIds,
        reason: payrollReprocessJob.reason,
        createdAt: payrollReprocessJob.createdAt,
        updatedAt: payrollReprocessJob.updatedAt,
      })
      .from(payrollReprocessJob)
      .where(eq(payrollReprocessJob.id, jobId))
      .limit(1);
    return job ?? null;
  });
}

/**
 * e440991b — CAN THIS RUN BE REPROCESSED, AND BY THIS CALLER? The three refusals
 * `reprocessSelectedEmployees` makes at enqueue time, answered as a read so the dedicated Reprocess
 * screen can refuse with an explanation instead of letting the operator discover it by pressing submit.
 *
 * It is deliberately NOT the authority: every field here is re-asserted inside the service's own
 * transaction (permission → status → period), which is where a race between this read and the submit
 * is decided. What this adds is that the screen and the service refuse for the SAME three reasons,
 * resolved from the same rows — a second surface, not a second rule.
 *
 * Returns null when the batch is not readable (missing, or fenced off by RLS).
 */
export type ReprocessEligibility = {
  /** The caller holds `payroll.reprocess.selective` for this run's company. */
  permitted: boolean;
  /** The run is PROCESSED — never a draft (no payslips) and never a closed run (immutable). */
  processed: boolean;
  /** The parent pay period is closed, so nothing in it may be recomputed. */
  periodClosed: boolean;
};

export async function reprocessEligibility(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<ReprocessEligibility | null> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId, payPeriodId: payrollBatch.payPeriodId })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return null;
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    return {
      permitted: await resolvePayrollPermission(tx, ctx, 'payroll.reprocess.selective', batch.companyId),
      processed: batch.status === 'processed',
      periodClosed: period?.status === 'closed',
    };
  });
}

// ═══════════════ 9066bd6c — REMOVE ONE EMPLOYEE'S PAYROLL FROM A PROCESSED RUN ═══════════════
//
// THE GAP THIS FILLS. When one person's pay comes out wrong on a processed run the only tool that
// existed was Reset, which clears EVERY employee on the run. Production shows the cost: the ISEDECOR
// August run was reset twice at 23 employees each, July once at 22 and January once at 19 — 87
// employee results destroyed inside eighteen minutes to correct a handful of people.
//
// WHAT IT IS, EXACTLY. The per-employee slice of `resetProcessedBatch`'s unwind PLUS the subset
// reprocess path's delta accounting. Neither half alone is right, and that is the whole design:
//   • the SUBSET REPROCESS deliberately does NOT unwind loans/claims — it immediately re-creates the
//     same lines, so reversing them would be a round trip to nowhere. A removal creates nothing.
//   • the RESET unwinds them, but for the WHOLE run, and drops the run back to draft.
// So the money side-effects come from the reset (narrowed to the selected employments, through the
// helpers both callers now share) and the arithmetic comes from the subset path (subtract what those
// payslips contributed; RECOUNT the headcount rather than decrementing it).
//
// THE WAY BACK is not new: a removed employee reappears on the Reprocess screen's New / Pending group
// (`listPayslipLessEligible` finds everyone eligible for the month with no payslip on the run) and
// `reprocessSelectedEmployees` adds them back. That is why the module gate below is
// `multi_cycle_payroll` — removal must never be offered where re-adding is impossible.

/** A blank / whitespace-only reason was supplied. Mirrors ResetReasonRequiredError, and like it is
 *  thrown BEFORE any write so a refused removal mutates nothing. */
export class RemoveReasonRequiredError extends Error {
  constructor() {
    super('A reason is required to remove an employee from a payroll run.');
    this.name = 'RemoveReasonRequiredError';
  }
}

/**
 * Every payslip on the run was selected. THAT IS A RESET, and it must be done as one.
 *
 * Not a nicety: removal leaves the run PROCESSED, so honouring a whole-run selection would leave a
 * processed run with zero payslips, zero headcount and totals of zero — a state nothing else in the
 * system produces or expects, and one no screen would explain. Reset exists, says what it does, and
 * returns the run to draft where it can be regenerated.
 */
export class RemoveWholeRunError extends Error {
  constructor() {
    super('Removing every employee on the run is a Reset — use Reset Payroll instead.');
    this.name = 'RemoveWholeRunError';
  }
}

/** The run's pay period is closed. Reopening a closed month is `unlockClosedBatch`'s deliberate job;
 *  removal is not a second door into a frozen month. */
export class RemovePeriodClosedError extends Error {
  constructor() {
    super('This pay period is closed.');
    this.name = 'RemovePeriodClosedError';
  }
}

/** None of the requested employments actually has a payslip on this run (stale tick, cross-company id,
 *  or a concurrent removal that got there first). */
export class RemoveNoEmployeesError extends Error {
  constructor() {
    super('None of the selected employees have a payslip on this run.');
    this.name = 'RemoveNoEmployeesError';
  }
}

/**
 * Eligibility for the Remove screen — the three facts `reprocessEligibility` reports, read the same way,
 * so the screen can state WHY the door is shut instead of 404-ing a run the operator can plainly see on
 * the list. Every one of them is re-asserted inside `removeEmployeePayroll`'s own transaction on submit,
 * which is where a race with a concurrent close is actually decided.
 *
 * PLUS A FOURTH THAT `reprocessEligibility` HAS NO EQUIVALENT FOR, and it is the reason this type diverges
 * from its sibling: removal rides the `payroll.reset_enabled` risk switch, and `removeEmployeePayroll`
 * throws SettingNotEnabledError for it BEFORE anything else. Both entry points hide their link while it is
 * off, so the only way in is a direct visit — which, without this, rendered the whole selection form and
 * let the operator find out by pressing the button. That is the exact failure the screen's own header
 * promises not to have.
 *
 * THE SETTING IS RESOLVED BY THE CALLER, AND THAT IS THE WHOLE REASON `enabled` IS A PARAMETER.
 * Degrading an entitlements-resolution failure to the catalog default is right for a page that must still
 * render, and it is the app/ idiom — app/payroll/[batchId]/page.tsx does exactly that for the sibling
 * gates. But the degrade-to-default form inside core/ is refused by test/module-catalog-drift.test.ts,
 * and
 * its reasoning is sound: in a service that form swallows an infrastructure failure and answers "off",
 * turning an incident into a silent refusal that reads like a plan change. So the degrade happens in the
 * page, where it belongs, and this reader takes the answer. The MUTATION keeps the strict form and gates
 * itself — nothing here is load-bearing for refusing the action.
 */
export type RemoveEligibility = {
  enabled: boolean;
  permitted: boolean;
  processed: boolean;
  periodClosed: boolean;
};

export async function removeEligibility(
  ctx: SessionContext,
  p: { batchId: string; enabled: boolean },
): Promise<RemoveEligibility | null> {
  const enabled = p.enabled;
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status, companyId: payrollBatch.companyId, payPeriodId: payrollBatch.payPeriodId })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return null;
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    return {
      enabled,
      permitted: await resolvePayrollPermission(tx, ctx, 'payroll.remove.employee', batch.companyId),
      processed: batch.status === 'processed',
      periodClosed: period?.status === 'closed',
    };
  });
}

/** One recorded removal: who, when, why, and the figures that went. */
export type RemovalHistoryRow = {
  id: string;
  employmentId: string;
  employeeCode: string | null;
  employeeName: string;
  at: Date;
  reason: string | null;
  /** The removed payslip's own figures, off the snapshot — never re-derived. There is nothing to
   *  re-derive them from: the payslip row this describes no longer exists. */
  gross: string | null;
  net: string | null;
  versionBefore: number | null;
};

/**
 * Every removal recorded on a run, newest first.
 *
 * A SEPARATE READER FROM `listRecomputeDisclosure` on purpose. That one diffs two payslip snapshots and
 * reports what moved; a removal has no `after` and its `before` is the whole payslip row. Sharing the
 * reader would mean teaching a diff to describe a deletion, which is how a history card starts printing
 * "gross 4,000.00 → 0.00" for something that was not a pay cut.
 */
export function listRemovalHistory(ctx: SessionContext, p: { batchId: string }): Promise<RemovalHistoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: payrollEmployeeResultHistory.id,
        employmentId: payrollEmployeeResultHistory.employmentId,
        employeeCode: employment.employeeCode,
        employeeName: person.fullName,
        at: payrollEmployeeResultHistory.createdAt,
        reason: payrollEmployeeResultHistory.reason,
        before: payrollEmployeeResultHistory.before,
        versionBefore: payrollEmployeeResultHistory.versionBefore,
      })
      .from(payrollEmployeeResultHistory)
      .innerJoin(employment, eq(employment.id, payrollEmployeeResultHistory.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(eq(payrollEmployeeResultHistory.batchId, p.batchId), eq(payrollEmployeeResultHistory.action, 'remove')),
      )
      .orderBy(desc(payrollEmployeeResultHistory.createdAt));
    return rows.map((r) => {
      const snap = ((r.before ?? {}) as { payslip?: Record<string, unknown> }).payslip ?? {};
      return {
        id: r.id,
        employmentId: r.employmentId,
        employeeCode: r.employeeCode,
        employeeName: r.employeeName,
        at: r.at,
        reason: r.reason,
        gross: snap.grossPay == null ? null : String(snap.grossPay),
        net: snap.netPay == null ? null : String(snap.netPay),
        versionBefore: r.versionBefore,
      };
    });
  });
}

/** One row per payslip on the run — the selection list the Remove screen renders. */
export type RemovableEmployee = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  /** The employee's department on their CURRENT assignment, or null when none resolves. */
  department: string | null;
  gross: string;
  net: string;
  /**
   * Later months already PROCESSED or CLOSED for this same employee. PCB is cumulative per employee, so
   * those payslips were computed with this one included in the year to date; removing this month leaves
   * them computed against a month that no longer exists. A WARNING, never a gate — the operator is the
   * one who knows whether the later months will be reprocessed.
   */
  laterPeriods: string[];
};

/**
 * The removal selection list: exactly one row per payslip on the run.
 *
 * THE DEPARTMENT JOIN IS THE HAZARD, and the reason this is a correlated subquery rather than the
 * obvious `left join assignment … where superseded_at is null`. On production batch 368c67fc,
 * employment T100502 carries THREE non-superseded assignment rows and two others carry two each (all
 * naming the same department), so the naive join turns 19 payslips into 23 rows — and an operator can
 * then tick the same person twice, or miss that a row is a duplicate and believe two people are going.
 * The subquery picks ONE row (latest effective, then latest recorded) and can therefore only ever
 * return one value per payslip. test/payroll-remove-employee.test.ts pins rows === payslips.
 */
export function listRemovableEmployees(ctx: SessionContext, p: { batchId: string }): Promise<RemovableEmployee[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return [];
    const rows = await tx
      .select({
        employmentId: payslip.employmentId,
        employeeCode: employment.employeeCode,
        name: person.fullName,
        gross: payslip.grossPay,
        net: payslip.netPay,
        department: sql<string | null>`(
          select d.name
          from ${assignment} a
          join ${department} d on d.id = a.department_id
          where a.employment_id = ${payslip.employmentId}
            and a.superseded_at is null
          order by a.valid_from desc, a.recorded_at desc
          limit 1
        )`,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.batchId, p.batchId))
      .orderBy(person.fullName);
    if (rows.length === 0) return [];

    // The later-month read, ONCE for the whole list rather than per row.
    const later = await tx
      .select({ employmentId: payslip.employmentId, payPeriod: payrollBatch.payPeriod })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          inArray(
            payslip.employmentId,
            rows.map((r) => r.employmentId),
          ),
          gt(payrollBatch.payPeriod, batch.payPeriod),
          inArray(payrollBatch.status, ['processed', 'closed']),
        ),
      );
    const laterByEmp = new Map<string, Set<string>>();
    for (const l of later) {
      const set = laterByEmp.get(l.employmentId) ?? new Set<string>();
      set.add(l.payPeriod);
      laterByEmp.set(l.employmentId, set);
    }
    return rows.map((r) => ({
      ...r,
      laterPeriods: [...(laterByEmp.get(r.employmentId) ?? [])].sort(),
    }));
  });
}

/**
 * Remove the selected employees' calculated results from a PROCESSED run, leaving the run processed and
 * every other payslip physically untouched.
 *
 * ORDERED, ALL IN ONE TRANSACTION:
 *   1. reason (before any write) → gate → permission → processed → period open
 *   2. intersect the request with payslips that actually exist on this run; refuse empty, refuse ALL
 *   3. snapshot each payslip IN FULL — see the note on `before` below
 *   4. unwind, for the selected employments ONLY: loan instalment, claims this run paid, the one-off
 *      transaction consumed markers, the statutory adjustment, and the live anomaly verdicts (an open
 *      BLOCK verdict for a removed employee would otherwise keep refusing the run's Close)
 *   5. delete the payslips; move totals BY DELTA and RECOUNT the headcount
 *   6. clear the recalculation mark for those employments; write the audit rows and the domain event
 *
 * PAYROLL_INPUT ROWS ARE KEPT, exactly as Reset keeps them: they are the keyed figures that make a
 * re-process reproduce what was there. Removing them would turn a correction into a re-keying job.
 */
export async function removeEmployeePayroll(
  ctx: SessionContext,
  p: { batchId: string; employmentIds: string[]; reason?: string },
) {
  // The SAME operator-controlled risk switch Reset rides — deliberately not a new one, so nothing has
  // to be flipped for this to appear wherever Reset already does.
  if (!settingEnabled(ctx, 'payroll.reset_enabled')) {
    throw new SettingNotEnabledError('payroll.reset_enabled', 'Payroll reset is not enabled.');
  }
  // The way BACK from a removal is the Reprocess screen, which only exists with multi-cycle on. Offering
  // removal without it would strand the employee off the run with no way to put them back.
  if (!isModuleEnabled(ctx, 'multi_cycle_payroll')) {
    throw new ModuleNotEnabledError('multi_cycle_payroll', 'Multiple payroll runs per month are not enabled.');
  }
  const reason = (p.reason ?? '').trim();
  if (!reason) throw new RemoveReasonRequiredError();
  const requested = [...new Set(p.employmentIds.filter(Boolean))];
  if (requested.length === 0) throw new RemoveNoEmployeesError();

  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        payPeriodId: payrollBatch.payPeriodId,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        totals: payrollBatch.totals,
        employeeCount: payrollBatch.employeeCount,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new Error('batch not found');
    // Its OWN key, never payroll.rollback — an operator who may take one person off a run is not
    // thereby allowed to zeroize the whole company's month. Defaults to the same roles (lib/payroll-
    // permissions.ts), so nothing widens on the day this ships.
    await assertPayrollPermission(tx, ctx, 'payroll.remove.employee', batch.companyId);
    if (batch.status !== 'processed') throw new BatchNotResettableError();
    const [period] = await tx
      .select({ status: payPeriod.status })
      .from(payPeriod)
      .where(eq(payPeriod.id, batch.payPeriodId))
      .limit(1);
    if (period?.status === 'closed') throw new RemovePeriodClosedError();

    // ── 2 + 3. WHAT IS ACTUALLY ON THIS RUN, AND THE SNAPSHOT, IN ONE READ. ──
    //
    // A bare `select()` (every column), row-locked. Both halves are deliberate:
    //   • FOR UPDATE, so a concurrent removal or reprocess of the same run serialises instead of two
    //     transactions computing a totals delta from the same stale stored figure;
    //   • every column, because these rows ARE the snapshot written to
    //     payroll_employee_result_history.before at step 6b — after the delete there is no other copy
    //     of a removed payslip anywhere, so a narrowed projection here would silently decide what can
    //     never be recovered.
    const onRun = await tx
      .select()
      .from(payslip)
      .where(eq(payslip.batchId, p.batchId))
      .for('update');
    const removing = onRun.filter((sl) => requested.includes(sl.employmentId));
    if (removing.length === 0) throw new RemoveNoEmployeesError();
    if (removing.length === onRun.length) throw new RemoveWholeRunError();
    const removedIds = removing.map((sl) => sl.employmentId);

    // ── 4. THE UNWIND, narrowed to the selected employments and to them alone. ──
    const { reversed: loanInstalmentsReversed, loansReopened } = await unwindAppliedLoanRepayments(tx, ctx, {
      batchId: p.batchId,
      employmentIds: removedIds,
      cause: 'payroll-employee-removed',
    });

    // Claims THIS run paid, for these people only. Back to 'approved' but still STAMPED on the batch —
    // the pre-generation queued state, so re-processing the corrected employee re-picks them. Somebody
    // else's paid claim on the same run is not in the predicate and cannot move.
    const revertedClaims = await tx
      .update(claimRequest)
      .set({ status: 'approved', paidAt: null, payoutRef: null })
      .where(
        and(
          eq(claimRequest.payrollBatchId, p.batchId),
          eq(claimRequest.status, 'paid'),
          inArray(claimRequest.employmentId, removedIds),
        ),
      )
      .returning({ id: claimRequest.id, employmentId: claimRequest.employmentId });
    for (const c of revertedClaims) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'claim-request',
        aggregateId: c.id,
        eventType: 'claim-request.payment-reversed',
        actor: actorOf(ctx),
        subjectEmploymentId: c.employmentId,
        payload: { batchId: p.batchId, reason: 'payroll-employee-removed' },
      });
    }

    // The one-off lines this run paid these people. Their payslips are about to be deleted, so the money
    // has NOT been paid and the corrected re-run must pay it; leaving the marker would strand it.
    await releaseIndividualTxnsConsumed(tx, p.batchId, removedIds);

    // The statutory adjustment describes a payslip that will not exist, so it goes with it — and into
    // the snapshot, because it is not recoverable from anywhere else afterwards. Deliberately NOT via
    // `revertStatutoryAdjustment`: that calls markBatchNeedsRecalc, i.e. it marks the run as owing a
    // recalculation for an employee who is no longer on it, which is the opposite of what step 6 does.
    const adjustments = await tx
      .delete(payrollStatutoryAdjustment)
      .where(
        and(
          eq(payrollStatutoryAdjustment.batchId, p.batchId),
          inArray(payrollStatutoryAdjustment.employmentId, removedIds),
        ),
      )
      .returning();
    const adjustmentByEmp = new Map(adjustments.map((a) => [a.employmentId, a]));

    // The anomaly verdicts standing against these people describe a payslip that is about to stop
    // existing, so they go with it. NOT cosmetic: `openBlockingVerdicts` is keyed on batchId and joins
    // no payslip, so one unresolved BLOCK among them would keep refusing `closeBatch` for an employee
    // who is no longer on the run — and Close is the operator's very next action after a removal. The
    // regeneration paths (reset → draft → process again) never hit this because `evaluateBatchAnomalies`
    // supersedes the whole batch's verdicts before writing the next generation; removal deliberately
    // leaves the run PROCESSED and regenerates nothing. Superseded, never deleted — same idiom, same
    // reason, as a re-evaluation (core/payroll-anomaly.ts).
    const anomalyVerdictsSuperseded = await supersedeVerdictsForEmployments(tx, {
      batchId: p.batchId,
      employmentIds: removedIds,
    });

    // ── 5a. Delete the payslips. ──
    await tx
      .delete(payslip)
      .where(and(eq(payslip.batchId, p.batchId), inArray(payslip.employmentId, removedIds)));

    // ── 5b. Totals BY DELTA, exactly as the subset reprocess path does: subtract what the removed
    //    payslips contributed from the stored figure, rather than re-summing the run. `hrdfEmployer` is
    //    the totals key; the payslip's statutory blob spells the same figure `hrdf`. ──
    const stored = (batch.totals ?? {}) as Record<string, number>;
    const delta = { ...stored } as Record<string, number>;
    const sub = (k: string, v: unknown) => {
      delta[k] = round2((Number(delta[k]) || 0) - (Number(v) || 0));
    };
    for (const sl of removing) {
      const st = (sl.statutory ?? {}) as Record<string, number>;
      sub('gross', sl.grossPay);
      sub('net', sl.netPay);
      sub('deductions', sl.totalDeductions);
      sub('employerCost', sl.employerCost);
      sub('epfEmployee', st.epfEmployee);
      sub('epfEmployer', st.epfEmployer);
      sub('socsoEmployee', st.socsoEmployee);
      sub('socsoEmployer', st.socsoEmployer);
      sub('eisEmployee', st.eisEmployee);
      sub('eisEmployer', st.eisEmployer);
      sub('pcb', st.pcb);
      sub('hrdfEmployer', st.hrdf);
    }
    // RECOUNTED off the payslips, never decremented — the stored figure is then a fact about the run
    // rather than a running total a half-failed operation could leave one out of. Same reasoning as the
    // headcount note on the subset reprocess path.
    const [{ n: payslipCount } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payslip)
      .where(eq(payslip.batchId, p.batchId));
    await tx
      .update(payrollBatch)
      .set({ totals: delta, employeeCount: Number(payslipCount) })
      .where(eq(payrollBatch.id, p.batchId));

    // ── 6a. The removed employees no longer have a figure that could be stale. ──
    await clearBatchRecalc(tx, ctx, { batchId: p.batchId, employmentIds: removedIds });

    // ── 6b. AUDIT. One per-employee row carrying the WHOLE payslip.
    //
    //    `before` is the full row, not the six keys a reprocess records (grossPay / netPay /
    //    totalDeductions / employerCost / version / statutory). The r194 restore attempt is why: those
    //    six are not enough to rebuild a payslip, and after a REPROCESS there is still another copy —
    //    the payslip itself. After a REMOVAL there is no other copy anywhere. This row is it.
    const actor = actorOf(ctx);
    for (const sl of removing) {
      const adj = adjustmentByEmp.get(sl.employmentId) ?? null;
      await tx.insert(payrollEmployeeResultHistory).values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: sl.employmentId,
        action: 'remove',
        actorType: actor.type,
        actorId: actor.id ?? null,
        reason,
        versionBefore: sl.version,
        versionAfter: null,
        before: { payslip: sl, statutoryAdjustment: adj } as Record<string, unknown>,
        after: null,
      });
    }

    // What the run has already sent downstream, and the later months computed with these payslips in
    // the year to date. READ AND RECORDED, never a gate — the screen shows them before the confirm and
    // the history row keeps them, so the record says what was known at the time.
    const downstream = await batchDownstreamWarnings(tx, {
      batchId: p.batchId,
      companyId: batch.companyId,
      payPeriod: batch.payPeriod,
    });
    const laterRows = await tx
      .select({ employmentId: payslip.employmentId, payPeriod: payrollBatch.payPeriod })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .where(
        and(
          inArray(payslip.employmentId, removedIds),
          gt(payrollBatch.payPeriod, batch.payPeriod),
          inArray(payrollBatch.status, ['processed', 'closed']),
        ),
      );
    const laterProcessedPeriods = [...new Set(laterRows.map((r) => r.payPeriod))].sort();

    // ONE run-level status-history row. `from`/`to` are both 'processed' on purpose: the run does NOT
    // change status, and that is the whole point of the feature. Both `action` columns are free text
    // (db/schema.ts) — no migration for any of this.
    await tx.insert(payrollStatusHistory).values({
      tenantId: ctx.tenantId,
      batchId: p.batchId,
      action: 'remove-employee',
      fromStatus: 'processed',
      toStatus: 'processed',
      actorType: actor.type,
      actorId: actor.id ?? null,
      reason,
      before: { status: 'processed', totals: batch.totals, employeeCount: batch.employeeCount },
      after: {
        status: 'processed',
        totals: delta,
        employeeCount: Number(payslipCount),
        employmentIds: removedIds,
        payslipsRemoved: removing.length,
        loanInstalmentsReversed,
        loansReopened,
        claimsReverted: revertedClaims.length,
        statutoryAdjustmentsRemoved: adjustments.length,
        anomalyVerdictsSuperseded,
        paymentDisbursed: downstream.paymentDisbursed,
        statutoryFiled: downstream.statutoryFiled,
        statutoryReturnsFiled: downstream.statutoryFiledCount,
        laterProcessedPeriods,
      },
    });

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.employee-payroll-removed',
      actor,
      payload: {
        companyId: batch.companyId,
        payPeriod: batch.payPeriod,
        payPeriodId: batch.payPeriodId,
        runType: batch.runType,
        runSeq: batch.runSeq,
        reason,
        employmentIds: removedIds,
        payslipsRemoved: removing.length,
        loanInstalmentsReversed,
        loansReopened,
        claimsReverted: revertedClaims.length,
        statutoryAdjustmentsRemoved: adjustments.length,
        anomalyVerdictsSuperseded,
        headcountAfter: Number(payslipCount),
        paymentDisbursed: downstream.paymentDisbursed,
        statutoryFiled: downstream.statutoryFiled,
        // r292 — ADDED beside `statutoryReportsForPeriod`, not instead of it. That field has always meant
        // "artefacts recorded for the month" and re-pointing it at the narrower filed set would make
        // events written before and after this round incomparable.
        statutoryReturnsFiled: downstream.statutoryFiledCount,
        statutoryReportsForPeriod: downstream.statutoryReportCount,
        laterProcessedPeriods,
      },
    });

    return {
      payslipsRemoved: removing.length,
      employmentIds: removedIds,
      loanInstalmentsReversed,
      loansReopened,
      claimsReverted: revertedClaims.length,
      statutoryAdjustmentsRemoved: adjustments.length,
      anomalyVerdictsSuperseded,
      headcountAfter: Number(payslipCount),
      paymentDisbursed: downstream.paymentDisbursed,
      statutoryFiled: downstream.statutoryFiled,
      statutoryFiledCount: downstream.statutoryFiledCount,
      laterProcessedPeriods,
    };
  });
}

// Read-only list (no events.append per the CLAUDE.md skip rule). `payPeriod` is an OPTIONAL
// additive filter: when a non-empty string is passed it is AND-ed onto the existing tenant-RLS +
// companyIds guard, so it can only NARROW the result (Build #10). Omitting it (or passing '')
// reproduces the prior behaviour byte-identically — the three existing callers pass ≤2 args.
//
// 7f6ca478 — it now also accepts a SET of periods. The Payroll Process dashboard shows a whole YEAR
// at once (twelve month cells, each carrying its own run count), so it asks for twelve periods in one
// round trip rather than filtering an unbounded "every batch this tenant ever ran" fetch in JS, which
// is what the single-period signature forced the old list to do. A string still means exactly one
// period; an EMPTY array means "no period can match" and is honoured as such (`inArray(…, [])` ⇒ no
// rows) rather than being quietly widened to "all" — a caller that computed an empty set wants an
// empty result, and silently returning everything is how a filter becomes a data leak.
export function listBatches(
  ctx: SessionContext,
  companyIds?: string[],
  payPeriod?: string | readonly string[],
) {
  const periodFilter = Array.isArray(payPeriod)
    ? inArray(payrollBatch.payPeriod, payPeriod as string[])
    : typeof payPeriod === 'string' && payPeriod
      ? eq(payrollBatch.payPeriod, payPeriod)
      : undefined;
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollBatch.id,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        // 7f6ca478 — the dashboard renders Net Pay through lib/money.formatMoney, which refuses to
        // guess a currency (an unlabelled figure over a claim). The list spans every company in scope,
        // which is exactly where one hard-coded "RM" mislabels somebody's payroll.
        currency: company.currency,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        employeeCount: payrollBatch.employeeCount,
        totals: payrollBatch.totals,
        batchDate: payrollBatch.batchDate,
        // Build #10 follow-up: `remarks` carries the wizard's real cycle selection for advance/midmonth
        // runs (both stored as runType='off_cycle'). Surfaced in the listing's "Payroll Cycle" column so
        // they display distinctly, matching the batch detail page. Read-only; no schema/migration change.
        remarks: payrollBatch.remarks,
        // ef31d251 — the payroll LIST has to say which months have actually reached employees, and it
        // cannot tell 'published' from 'scheduled' without the release instant (lib/payroll-publication.ts).
        // Purely additive: all three callers filter/map explicit fields, and the by-batches context test
        // compares two listBatches results to each other rather than to a literal row shape.
        closedAt: payrollBatch.closedAt,
        releasedAt: payrollBatch.releasedAt,
        // 510f4bd1 — the recalculation mark 49e7e0a2 already writes. Additive for the same reason
        // closedAt/releasedAt were: all callers filter/map explicit fields. It is what lets the Individual
        // Transaction workspace say "Reprocess required" for the SELECTED employee with no second query —
        // and, unlike a per-row derivation, it survives the DELETE of the last transaction on the run,
        // which is the one case that leaves no row to label (request case 4).
        needsRecalcAt: payrollBatch.needsRecalcAt,
        recalcEmploymentIds: payrollBatch.recalcEmploymentIds,
        // c11e81aa — the CONFIGURED cycle this run was opened under. Additive for the same reason the
        // three fields above were. The Individual Transaction workspace needs it to decide whether the run
        // that exists is the one the operator's chosen cycle will be paid by: `remarks` above answers that
        // only for the two off_cycle presets that happen to carry a label, and by string comparison.
        payrollCycleId: payrollBatch.payrollCycleId,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(
        and(
          companyIds && companyIds.length ? inArray(payrollBatch.companyId, companyIds) : undefined,
          periodFilter,
        ),
      )
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq),
  );
}

export type LeaverAdvisoryRow = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  terminatedOn: string;
  basic: number;
  annualBalance: number;
  /** Suggested pay-in-lieu for unused annual leave at ORP (basic / 26 per day, EA 1955). */
  suggested: number;
  /** ADR-0069: where annualBalance came from. 'frozen_snapshot' — a resignation-approval freeze exists,
   *  so annualBalance/suggested derive from the LOCKED (or HR-overridden) day-count, not the live ledger.
   *  'live_balance' — no snapshot (policy off, or the employment was terminated directly, bypassing the
   *  resignation flow) — annualBalance is the live ledger sum, exactly as before this feature. */
  encashmentSource: 'frozen_snapshot' | 'live_balance';
  frozenAsOf?: string;
  overridden?: boolean;
};

/**
 * Final-pay ADVISORY for employees terminating within a draft batch's period: unused annual
 * leave × ORP daily rate, per EA 1955 s.60E pay-in-lieu. Deliberately NO auto-pay — the
 * EPF/PCB treatment of encashment is not yet sourced, so the admin keys the amount into the
 * bonus input consciously (documented in STATUTORY-SOURCES.md). f3148da1 Step 5: the ORP day-divisor
 * used for the `suggested` figure is policy-configurable (`leave.encashmentDivisor`), defaulting to the
 * statutory 26-day divisor — see encashmentDivisorDays.
 */
export function leaverAdvisory(ctx: SessionContext, batchId: string): Promise<LeaverAdvisoryRow[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [y, m] = batch.payPeriod.split('-').map(Number);
    const start = `${batch.payPeriod}-01`;
    const end = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
    const leavers = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        terminatedOn: employment.terminatedOn,
        basic: compensation.basicSalary,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
      )
      .where(
        and(
          // ── 1b0943d5, SITE 5 OF 5 — STAYS ON THE COLUMN, DELIBERATELY. ─────────────────────────────
          // The other four company predicates in this file became dated. This one must not, and it is the
          // reason the plan insisted each of the six be decided on its own rather than replaced together.
          //
          // This is the LEAVERS SWEEP: who is being terminated inside this period, and therefore what
          // final settlement (notice, leave encashment) their employer owes them. It is keyed on
          // `terminated_on`, an event that happens ONCE, to the employment as it stands at that moment,
          // under the entity that holds it then — which is `employment.company_id` by definition.
          //
          // Widening it to the dated history would put a leaver on the advisory of an entity they had
          // ALREADY LEFT before they were terminated: transfer out of Fiamma on 11 August, resign from
          // ISEDECOR on the 20th, and Fiamma's August run would show a final-settlement obligation for
          // somebody who was not its employee on the day they left. Fiamma owes them ten days of salary
          // (which the segmented run pays) and no termination settlement at all. The dated question is
          // the wrong question here; the column is the right answer.
          eq(employment.companyId, batch.companyId),
          gte(employment.terminatedOn, start),
          lte(employment.terminatedOn, end),
        ),
      );
    if (leavers.length === 0) return [];
    const [annual] = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(eq(leaveType.code, 'ANNUAL'))
      .limit(1);
    const out: LeaverAdvisoryRow[] = [];
    for (const l of leavers) {
      let balance = 0;
      if (annual) {
        const [row] = await tx
          .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
          .from(leaveLedger)
          .where(and(eq(leaveLedger.employmentId, l.employmentId), eq(leaveLedger.leaveTypeId, annual.id)));
        balance = Number(row?.bal ?? 0);
      }
      // ADR-0069: a frozen encashment snapshot (resignation-approval freeze), when present, wins over the
      // live ledger balance — that is the point of the feature (a locked/HR-adjusted figure instead of a
      // number that can still drift). No snapshot (policy off, or a direct termination bypassing the
      // resignation flow) falls back to the live balance exactly as before this feature.
      const encashment = await encashableDaysForEmployment(tx, l.employmentId);
      const effectiveBalance = encashment ? encashment.days : balance;
      const basic = Number(l.basic);
      // f3148da1 Step 5 — the leave-encashment ORP day-divisor is policy-configurable (default = the statutory
      // 26-day ordinary-rate divisor, so `basic / 26` is byte-identical when no policy overrides it). Resolve
      // the employment's assigned policy (and, only for a `working_days` divisor, count the pay-month working
      // days) LAZILY — a zero balance keeps the legacy 0 with no extra query.
      let encDivisor = ENCASHMENT_ORP_DIVISOR;
      if (effectiveBalance > 0) {
        const encCfg = (await resolveAssignedPolicy(tx, l.employmentId))?.config ?? null;
        let workingDays = 0;
        if (encCfg?.leave?.encashmentDivisor === 'working_days') {
          const holidays = await holidayDatesFor(tx, { employmentId: l.employmentId, startDate: start, endDate: end });
          for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
            const d = new Date(t).toISOString().slice(0, 10);
            const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
            if (iso <= 5 && !holidays.has(d)) workingDays++; // Mon–Fri working-day basis, less holidays
          }
        }
        encDivisor = encashmentDivisorDays(encCfg, { workingDays });
      }
      out.push({
        employmentId: l.employmentId,
        name: l.name,
        employeeCode: l.employeeCode,
        terminatedOn: l.terminatedOn!,
        basic,
        annualBalance: effectiveBalance,
        suggested: effectiveBalance > 0 ? round2((basic / encDivisor) * effectiveBalance) : 0,
        encashmentSource: encashment ? 'frozen_snapshot' : 'live_balance',
        ...(encashment ? { frozenAsOf: encashment.calculatedAsOf, overridden: encashment.overridden } : {}),
      });
    }
    return out;
  });
}

// ── Pre-processing checks (feedback f1564110, Phase 1; feedback 64fb5e48) ─────────────────────────
// Validates employee master data BEFORE the run is calculated, per the reporter's proposed workflow
// ("maintain employee info → validate → process as the final step"). All salary checks read the
// Personnel Basic Salary record (compensation) — the authoritative source; the internal BASIC pay
// item is NEVER a processing prerequisite (feedback 64fb5e48). Classes:
//   • missingCompensation — BLOCKER. No open compensation row (the generation employee query
//     inner-joins compensation, so these employees were previously dropped from the run with no
//     warning at all), or no salary record covering the pay period. Generation fails closed
//     (PreProcessBlockedError) until fixed.
//   • zeroBasic — BLOCKER. The record would pay nothing: zero basic (monthly/custom) or zero/missing
//     rate (daily/hourly).
//   • staleBasicComponent — WARNING. A leftover BASIC pay item disagrees with the Personnel basic;
//     pay follows Personnel, the item should be cleaned up.
//   • missingStatutory — WARNING. No employee_statutory_my row: EPF/SOCSO/PCB fall back to defaults.
//     The operator must explicitly confirm to proceed (enforced in generateAction).
//   • missingBank — WARNING. Statutory profile exists but bank name/account is incomplete: the
//     payment file cannot carry this employee. Confirm-to-proceed like missingStatutory.
//   • currencyMismatch — WARNING (297ae65a). The employee's salary record carries a currency other
//     than MYR while this run computes under the MY pack (Malaysian statutory maths, MYR figures) —
//     a mixed-currency batch or a wholly non-MYR one. Currency CONVERSION is explicitly a future
//     enhancement, so the run warns instead of calculating something misleading; no math change.
//   • hrdfSubjectUnregistered — WARNING (r79). The employee carries an EXPLICIT "Subject to HRDF = Yes"
//     while their company has no HRD Corp registration band, so hrdfLevy rates them to 0 (correctly —
//     an unregistered employer owes nothing). Before this check the contradiction was visible only on
//     the employee's own Bank & Statutory screen: the run itself said nothing, and one company processed
//     eight payrolls in that state. WARNS rather than blocks — the stored flag is legitimate forward
//     setup (see 57840a6e/efece4ce), the employees still need paying, and the operator often cannot
//     complete the company's HRD Corp registration in the moment. It joins the confirm-to-proceed
//     warnings, so generation requires an explicit acknowledgement rather than passing silently.

export type PreProcessCheckRow = { employmentId: string; name: string; employeeCode: string | null };

export type PreProcessAdvisory = {
  missingCompensation: PreProcessCheckRow[];
  // BLOCKER (ADR-0078 / 642ecc55). The employee's open compensation row carries pay_mode='custom_period',
  // which has NO calculation behind it — letting the run proceed would quietly pay the monthly-equivalent
  // basic for a structure the admin explicitly marked as NOT monthly. Named per employee, blocked at
  // pre-flight (generatePayslips re-asserts fail-closed) rather than thrown inside the engine: the batch
  // is all-or-nothing, so an engine throw would take down the whole company's run. OPTIONAL so pre-0290
  // literals stay valid; absent ⇒ no such employees.
  unpayablePayMode?: PreProcessCheckRow[];
  // BLOCKER (feedback 64fb5e48, replaces the R37 62e370b0 missingBasicComponent check). The employee's
  // authoritative Personnel Basic Salary record (the OPEN compensation row) would pay nothing: monthly /
  // custom modes with basic_salary <= 0, or daily/hourly modes without a positive rate_amount.
  // assertRateForMode (core/comp.ts) only guards NEW writes, so this also catches legacy rows. OPTIONAL so
  // pre-existing advisory literals stay valid; absent ⇒ no such employees.
  zeroBasic?: PreProcessCheckRow[];
  // WARNING (feedback 64fb5e48) — typed path only: a period-active BASIC employment_pay_component exists
  // whose amount disagrees with the Personnel Basic Salary (compensation.basic_salary). The engine now
  // ALWAYS pays basic from the Personnel record (the component never supplies the amount), so this is
  // stale data flagged for cleanup — it never blocks processing. OPTIONAL like unpayablePayMode.
  staleBasicComponent?: PreProcessCheckRow[];
  missingStatutory: PreProcessCheckRow[];
  missingBank: PreProcessCheckRow[];
  // WARNING (297ae65a — Currency on Basic Salary). The employee's OPEN compensation row is denominated in
  // a currency other than MYR while payroll computes under the MY pack: the amount is processed AS ENTERED
  // (recording/reporting first; conversion is a future enhancement), so the operator must explicitly
  // confirm a mixed-currency / non-MYR run instead of it calculating something misleading silently.
  // OPTIONAL so pre-existing advisory literals stay valid; absent ⇒ no such employees.
  currencyMismatch?: PreProcessCheckRow[];
  // WARNING (r79). An explicit per-employee "Subject to HRDF = Yes" at a company with no HRD Corp
  // registration band: the tick is honoured by hrdfSubject() but hrdfLevy() rates `not_registered` to 0,
  // so the run records the employee as subject and charges nothing. Never blocks (see the class notes
  // above) — it is a confirm-to-proceed warning so the contradiction is stated at the moment it has an
  // effect. OPTIONAL so pre-existing advisory literals stay valid; absent ⇒ no such employees.
  hrdfSubjectUnregistered?: PreProcessCheckRow[];
  // BLOCKER (item 1bb09a73) — THE SILENT ZERO ON A STATUTORY FIGURE.
  //
  // The employee has a Form TP3 for THIS pay year declaring previous-employment money, and the four
  // opening-balance columns the PCB kernel actually reads are stamped with a DIFFERENT `tp3_year` (or
  // none). `tp3Applies = e.tp3Year === pYear` then seeds ∑(Y−K), K, X and Z with ZERO — the run does
  // not fail, nothing is reported, and every PCB figure for that employee is computed as though they
  // had earned nothing before joining. Under-deducted PCB on a filed payslip is an employer liability,
  // and it is invisible in the output, so it BLOCKS rather than warns: there is no reading of a payslip
  // that tells an operator this happened.
  //
  // NARROW ON PURPOSE. A TP3 for a DIFFERENT year is not this (last year's opening balances correctly
  // do not seed this year). An all-blank Section C is not this (nothing is being dropped). Columns
  // that hold the pay year but disagree in AMOUNT are not this either — a hand edit on the Payroll tab
  // is still allowed and the TP3 screen's reconciliation strip shows the difference. Only the YEAR,
  // which is the one divergence whose consequence is a silent zero.
  //
  // OPTIONAL so pre-existing advisory literals stay valid; absent ⇒ no such employees.
  tp3YearMismatch?: PreProcessCheckRow[];
};

/** Shared tx-level core: the same scoped, period-active population as generatePayslips' employee
 *  query (hired ≤ period end, not terminated before period start, batch scope applied) but with
 *  compensation/statutory LEFT-joined so the gaps are visible instead of silently dropped. */
async function preProcessChecksTx(
  tx: Tx,
  batch: { companyId: string; payPeriod: string; scope: unknown },
  /**
   * Whether the tenant has the typed-pay-components module (ADR-0077 slice 3).
   *
   * Passed as a BOOLEAN rather than threading a SessionContext into a Tx-level helper: this function
   * is deliberately session-free — it takes a `tx` and plain data — and pulling an entitlement context
   * into it would invert that layering for one predicate. Every caller has a ctx in scope and computes
   * it there.
   */
  typedComponents: boolean,
): Promise<PreProcessAdvisory> {
  const [y, m] = batch.payPeriod.split('-').map(Number);
  const periodStart = `${batch.payPeriod}-01`;
  const periodEnd = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
  const { filter: scopeFilter } = await resolveBatchScopeFilter(tx, (batch.scope ?? null) as BatchScope | null);
  const rows = await tx
    .select({
      employmentId: employment.id,
      name: person.fullName,
      employeeCode: employment.employeeCode,
      compId: compensation.id,
      compPayMode: compensation.payMode,
      // Feedback 64fb5e48 — the fields the strengthened checks read off the Personnel record: effective
      // date (period coverage), basic amount (zeroBasic + stale comparison) and daily/hourly rate.
      compValidFrom: compensation.validFrom,
      compBasic: compensation.basicSalary,
      compRate: compensation.rateAmount,
      // 297ae65a — the record's salary currency, for the non-MYR / mixed-currency warning below.
      compCurrency: compensation.currency,
      // Item 1bb09a73 — the PERSON, because `employee_tp3` is keyed on it (the statutory row is too:
      // `employee_statutory_my_person_uq`). Two employments of one person therefore share one TP3 and
      // one set of opening balances, which is the grain this table has always had.
      personId: employment.personId,
      statPersonId: employeeStatutoryMy.personId,
      // Item 1bb09a73 — the year the kernel matches on (`tp3Applies = e.tp3Year === pYear`).
      statTp3Year: employeeStatutoryMy.tp3Year,
      bankName: employeeStatutoryMy.bankName,
      bankAccountNo: employeeStatutoryMy.bankAccountNo,
      // r79 — the tri-state per-employee HRDF flag. Only an EXPLICIT true can contradict an unregistered
      // employer; null (follow the company default) resolves to "not subject" and is no contradiction at all.
      subjectToHrdf: employeeStatutoryMy.subjectToHrdf,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .leftJoin(
      compensation,
      and(eq(compensation.employmentId, employment.id), isNull(compensation.validTo), isNull(compensation.supersededAt)),
    )
    .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
    .where(
      and(
        // 3c88d593 — the DATED entity question, same as generatePayslips: the readiness gate must cover
        // exactly the set the kernel will compute, or a gap belonging to a transferred-out employee is
        // silently not checked on the run that pays them.
        employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
        lte(employment.hiredOn, periodEnd),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        scopeFilter,
      ),
    )
    .orderBy(person.fullName);
  // Feedback 64fb5e48 — effective-date coverage. The engine reads the OPEN compensation row; when that row
  // only takes effect AFTER the period end, the period itself may still be covered by the (closed, non-
  // superseded) predecessor the revision truncated — a future-dated increment is not a data gap. Only
  // employments whose open row starts after the period need this history lookup, so the common case (open
  // row already in effect) issues NO extra query.
  const futureOnlyIds = rows.filter((r) => r.compId && r.compValidFrom! > periodEnd).map((r) => r.employmentId);
  const coveredEmpIds = new Set<string>();
  if (futureOnlyIds.length > 0) {
    const covRows = await tx
      .selectDistinct({ employmentId: compensation.employmentId })
      .from(compensation)
      .where(
        and(
          inArray(compensation.employmentId, futureOnlyIds),
          isNull(compensation.supersededAt),
          lte(compensation.validFrom, periodEnd),
          or(isNull(compensation.validTo), gte(compensation.validTo, periodStart)),
        ),
      );
    for (const c of covRows) coveredEmpIds.add(c.employmentId);
  }
  // Feedback 64fb5e48 (supersedes the R37 62e370b0 missingBasicComponent blocker) — typed path only: the
  // period-active BASIC employment_pay_component AMOUNTS per in-scope employee. The engine now always pays
  // basic from the Personnel compensation record, so a MISSING BASIC component is no gap at all; a PRESENT
  // one whose amount disagrees with the Personnel basic is stale data, surfaced below as the
  // staleBasicComponent WARNING (pay follows Personnel either way). Gated: with the flag off the legacy
  // path never reads components, so the query is skipped entirely.
  const basicAmountsByEmp = new Map<string, number[]>();
  if (typedComponents && rows.length > 0) {
    const basicRows = await tx
      .select({ employmentId: employmentPayComponent.employmentId, amount: employmentPayComponent.amount })
      .from(employmentPayComponent)
      .innerJoin(payComponent, eq(payComponent.id, employmentPayComponent.componentId))
      .where(
        and(
          inArray(employmentPayComponent.employmentId, rows.map((r) => r.employmentId)),
          eq(payComponent.code, 'BASIC'),
          // Same period-active window as the earnings query (lte valid_from / valid_to open-or-future /
          // not superseded) so the check agrees exactly with what the kernel would read.
          lte(employmentPayComponent.validFrom, periodEnd),
          or(isNull(employmentPayComponent.validTo), gte(employmentPayComponent.validTo, periodStart)),
          isNull(employmentPayComponent.supersededAt),
        ),
      );
    for (const bRow of basicRows) {
      const list = basicAmountsByEmp.get(bRow.employmentId) ?? [];
      list.push(Number(bRow.amount));
      basicAmountsByEmp.set(bRow.employmentId, list);
    }
  }
  // r79 — the employer's HRD Corp registration band, read ONLY when at least one in-scope employee carries
  // an explicit "Subject to HRDF = Yes" (so the overwhelmingly common case issues no extra query, and a
  // company that has genuinely registered simply produces no rows below). Mirrors generatePayslips' own
  // default exactly (`companyStatutoryMy` absent ⇒ not_registered), so what this check reports is what the
  // run will actually do — six of eight live companies have no row at all.
  // Item 1bb09a73 — the Form TP3 records for THIS pay year, for exactly the people on this run. Read
  // here rather than per row so the check costs ONE query, and skipped entirely when the run is empty.
  // `y` is the pay-period year parsed at the top of this function, which is the same value the kernel
  // compares `tp3_year` against, so the gate and the thing it guards cannot drift apart.
  const tp3MoneyPersonIds = new Set<string>();
  if (rows.length > 0) {
    const tp3Rows = await tx
      .select({ personId: employeeTp3.personId, payload: employeeTp3.payload })
      .from(employeeTp3)
      .where(
        and(
          inArray(employeeTp3.personId, [...new Set(rows.map((r) => r.personId))]),
          eq(employeeTp3.assessmentYear, y),
        ),
      );
    for (const t of tp3Rows) {
      const seed = deriveAccumulatorSeed(t.payload);
      // An all-blank Section C AND Section D declares nothing, so nothing can be dropped by not reading
      // it. ⚠️ `lpDeclared` JOINED THIS TEST IN ITEM 20837372: a form whose only money is in Section D
      // now moves the monthly deduction, so a year mismatch on it drops a real figure. Leaving it out
      // would make this gate quietly narrower than the kernel it guards — the exact drift the comment
      // above ("the gate and the thing it guards cannot drift apart") was written to prevent.
      if (
        seed &&
        (seed.netRemuneration !== 0 ||
          seed.epfClaimed !== 0 ||
          seed.pcbPaid !== 0 ||
          seed.zakatPaid !== 0 ||
          seed.lpDeclared !== 0)
      ) {
        tp3MoneyPersonIds.add(t.personId);
      }
    }
  }
  const anyExplicitHrdfYes = rows.some((r) => r.subjectToHrdf === true);
  let hrdfUnregistered = false;
  if (anyExplicitHrdfYes) {
    const [coStat] = await tx
      .select({ hrdfStatus: companyStatutoryMy.hrdfStatus })
      .from(companyStatutoryMy)
      .where(eq(companyStatutoryMy.companyId, batch.companyId))
      .limit(1);
    hrdfUnregistered = (coStat?.hrdfStatus ?? 'not_registered') === 'not_registered';
  }
  const out: PreProcessAdvisory = { missingCompensation: [], unpayablePayMode: [], zeroBasic: [], staleBasicComponent: [], missingStatutory: [], missingBank: [], currencyMismatch: [], hrdfSubjectUnregistered: [], tp3YearMismatch: [] };
  for (const r of rows) {
    const row: PreProcessCheckRow = { employmentId: r.employmentId, name: r.name, employeeCode: r.employeeCode };
    // Feedback 64fb5e48 — the OPEN row must exist (the generation employee query inner-joins it, so a
    // missing one silently drops the employee) AND the pay period must actually be covered by a salary
    // record: an open row already in effect covers it, else a period-overlapping predecessor must exist.
    if (!r.compId || (r.compValidFrom! > periodEnd && !coveredEmpIds.has(r.employmentId))) out.missingCompensation.push(row);
    // ADR-0078 — pay_mode='custom_period' has no calculation: BLOCKER, named per employee. Checked before
    // the zero-amount gap so one row lands in exactly one blocker list (the mode gap subsumes it —
    // there is nothing to compute regardless of amounts).
    else if (r.compPayMode === 'custom_period') out.unpayablePayMode!.push(row);
    // Feedback 64fb5e48 — zeroBasic: the Personnel record would pay nothing. Daily/hourly modes pay
    // rate × time so the RATE must be positive (basic_salary keeps its monthly-equivalent role for
    // statutory reads); every other mode requires basic_salary > 0. assertRateForMode only guards new
    // writes — this covers legacy rows too.
    else if (
      r.compPayMode === 'daily' || r.compPayMode === 'hourly'
        ? !(Number(r.compRate ?? 0) > 0)
        : !(Number(r.compBasic ?? 0) > 0)
    ) out.zeroBasic!.push(row);
    // Feedback 64fb5e48 — WARNING (never blocks): a period-active BASIC component whose amount disagrees
    // with the authoritative Personnel basic. The engine pays the Personnel record regardless; this only
    // flags the stale row for cleanup. Independent of the statutory warnings below (a row can carry both).
    if (r.compId && (basicAmountsByEmp.get(r.employmentId) ?? []).some((amt) => round2(amt) !== round2(Number(r.compBasic)))) {
      out.staleBasicComponent!.push(row);
    }
    // 297ae65a — WARNING (never blocks): the salary record is denominated in a currency other than MYR
    // while this run computes under the MY pack (the only pack today). Covers both a MIXED batch (some
    // non-MYR) and a wholly non-MYR one; the amount is processed as entered — recording/reporting first,
    // conversion is an explicit future enhancement — so the operator confirms rather than the engine
    // silently computing Malaysian statutory maths over a foreign-currency figure.
    if (r.compId && (r.compCurrency ?? 'MYR') !== 'MYR') out.currencyMismatch!.push(row);
    // r79 — WARNING (never blocks): an explicit "Subject to HRDF = Yes" that the employer's registration
    // makes structurally uncollectable. Independent of every check above (a row can carry both) and NOT
    // gated on a compensation row: the contradiction is in the statutory setup, not in the salary record.
    if (hrdfUnregistered && r.subjectToHrdf === true) out.hrdfSubjectUnregistered!.push(row);
    // Item 1bb09a73 — BLOCKER. See the type's own note for why the year alone, and why it blocks.
    // Independent of every check above (a row can carry both) and NOT gated on a compensation row: the
    // contradiction is between two statutory records, not in the salary record.
    if (tp3MoneyPersonIds.has(r.personId) && r.statTp3Year !== y) out.tp3YearMismatch!.push(row);
    if (!r.statPersonId) out.missingStatutory.push(row);
    // Bank readiness is only meaningful once a statutory profile exists (a missing profile already
    // covers the row above — listing it twice would be noise, not signal).
    else if (!r.bankName?.trim() || !r.bankAccountNo?.trim()) out.missingBank.push(row);
  }
  return out;
}

/** Read-only pre-processing advisory for a batch (no events.append per the CLAUDE.md skip rule —
 *  derived read, nothing written). Rendered as the "Pre-processing checks" card on a draft run and
 *  re-asserted server-side in generateAction/generatePayslips before calculation. */
export function preProcessAdvisory(ctx: SessionContext, batchId: string): Promise<PreProcessAdvisory> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, scope: payrollBatch.scope })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return { missingCompensation: [], missingStatutory: [], missingBank: [] };
    return preProcessChecksTx(tx, batch, isModuleEnabled(ctx, 'typed_pay_components'));
  });
}

/* ───────── fbcf706d — eligible for this month, no payslip on this run ───────── */

/**
 * One person who SHOULD be able to be paid on this run and is not on it.
 *
 * Carries the `PreProcessCheckRow` identity plus everything the Reprocess screen has to say about them
 * in a single pass: when the employment was hired, when its record reached the system (the two are
 * different questions and the second is usually the answer to "why is this person only appearing now"),
 * whether the run's own chosen-list scope covers them, and the readiness gaps a first processing would
 * raise — so an added hire who is also missing a bank account renders once, not twice.
 */
export type PayslipLessEligibleRow = PreProcessCheckRow & {
  hiredOn: string;
  /** When the employment record itself was created — a hire back-dated to 2016 can still be new HERE. */
  recordCreatedAt: Date;
  /** The run is scoped to a chosen list and this person is NOT on it, so adding them widens that list. */
  outsideScope: boolean;
  /** Readiness BLOCKERS (no salary record / would pay nothing / uncalculable pay structure). */
  blockers: string[];
  /** Readiness WARNINGS (no statutory profile / no bank details). Never prevent the add. */
  warnings: string[];
};

/**
 * WHO IS ELIGIBLE FOR THIS MONTH AND HAS NO PAYSLIP ON THIS RUN (fbcf706d work item 1).
 *
 * The gap this closes: when a person is added to a company after that month's run has been processed,
 * nothing on any screen says so, and the only way to pay them has been Reset — which throws away the
 * whole month's processing and its record and re-runs the entire company.
 *
 * WHY IT IS BUILT AS A SIBLING OF `preProcessChecksTx` RATHER THAN A NEW QUERY. The list is only useful
 * if pressing the button actually pays the person, so this read has to mean exactly what the engine
 * computes. It therefore reuses the SAME period window as the earnings query (hired on/before the period
 * end, not terminated before the period start) and, for the readiness columns, calls `preProcessChecksTx`
 * itself — scoped to precisely these employments — rather than restating any of its rules. A row appears
 * here if and only if the engine would compute a payslip for it, or would refuse for a reason named on
 * the row.
 *
 * SCOPE IS REPORTED, NOT APPLIED. Ten of twenty-one processed runs on production are set up for a chosen
 * list of people. Filtering those people out would hide exactly the person the operator is looking for;
 * silently including them would widen a deliberately narrow run by accident. So they are listed with
 * `outsideScope` set, the screen leaves them unticked, and ticking one is the deliberate widening the
 * engine then records (`payroll-batch.scope-widened`).
 *
 * Read-only — no event (CLAUDE.md derived-read rule).
 */
export function listPayslipLessEligible(
  ctx: SessionContext,
  p: { batchId: string },
): Promise<PayslipLessEligibleRow[]> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        scope: payrollBatch.scope,
        status: payrollBatch.status,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    // A draft has no payslips at all, so "everyone eligible with no payslip" would be the whole company —
    // a true answer to a question nobody asked. This read exists for a run that has already been processed.
    if (!batch || batch.status !== 'processed') return [];

    const [y, m] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(y, m)).padStart(2, '0')}`;

    const rows = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        hiredOn: employment.hiredOn,
        recordCreatedAt: employment.createdAt,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          // 3c88d593 — the DATED entity question, same as generatePayslips. Reading only the column here
          // and the history there is exactly the drift this helper exists to prevent: an employee the
          // kernel pays on the outgoing entity's run, on a screen that cannot see them.
          employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
          // NOT EXISTS a payslip for this employment on this batch. Correlated rather than a NOT IN over a
          // fetched id list: the id list is unbounded in company size and a NULL in it would swallow the row.
          sql`not exists (select 1 from ${payslip} where ${payslip.batchId} = ${p.batchId} and ${payslip.employmentId} = ${employment.id})`,
        ),
      )
      .orderBy(desc(employment.createdAt), person.fullName);
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.employmentId);
    const checks = await preProcessChecksTx(
      tx,
      { companyId: batch.companyId, payPeriod: batch.payPeriod, scope: { employmentIds: ids } },
      isModuleEnabled(ctx, 'typed_pay_components'),
    );
    const flagsOf = (list: PreProcessCheckRow[] | undefined, label: string) =>
      (list ?? []).map((r) => [r.employmentId, label] as const);
    const blockerBy = new Map<string, string[]>();
    const warningBy = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, pairs: readonly (readonly [string, string])[]) => {
      for (const [id, label] of pairs) map.set(id, [...(map.get(id) ?? []), label]);
    };
    push(blockerBy, flagsOf(checks.missingCompensation, 'missingCompensation'));
    push(blockerBy, flagsOf(checks.zeroBasic, 'zeroBasic'));
    push(blockerBy, flagsOf(checks.unpayablePayMode, 'unpayablePayMode'));
    // Item 1bb09a73 — a declared Form TP3 figure this run would seed as zero blocks the ADD too, for
    // the same reason it blocks the run: the person would be paid with a wrong PCB and nothing would say so.
    push(blockerBy, flagsOf(checks.tp3YearMismatch, 'tp3YearMismatch'));
    push(warningBy, flagsOf(checks.missingStatutory, 'missingStatutory'));
    push(warningBy, flagsOf(checks.missingBank, 'missingBank'));

    const { employmentIds: scopeIds } = await resolveBatchScopeFilter(tx, (batch.scope ?? null) as BatchScope | null);
    const inScope = scopeIds ? new Set(scopeIds) : null;

    return rows.map((r) => ({
      employmentId: r.employmentId,
      name: r.name,
      employeeCode: r.employeeCode,
      hiredOn: r.hiredOn,
      recordCreatedAt: r.recordCreatedAt,
      outsideScope: inScope ? !inScope.has(r.employmentId) : false,
      blockers: blockerBy.get(r.employmentId) ?? [],
      warnings: warningBy.get(r.employmentId) ?? [],
    }));
  });
}

/** Read-only pre-processing advisory for a PROSPECTIVE run that has no batch yet (R37 70764928 — the
 *  Payroll Process wizard's Validation step, which runs BEFORE the batch is created). Reuses the exact
 *  same `preProcessChecksTx` core as the batch-scoped `preProcessAdvisory` above (no duplicate check
 *  logic), evaluating the same period/scope population the terminal Process action will run over. Multi-
 *  company runs are checked per company and merged. `employmentIds` mirrors the wizard's touched-selection
 *  scope: present ⇒ only those employees; absent/empty ⇒ the whole-company default. No events.append per
 *  the CLAUDE.md skip rule — derived read, nothing written. */
export function preProcessAdvisoryForSelection(
  ctx: SessionContext,
  input: { companyIds: string[]; payPeriod: string; employmentIds?: string[] },
): Promise<PreProcessAdvisory> {
  return withTenant(ctx, async (tx) => {
    const scope: BatchScope | null =
      input.employmentIds && input.employmentIds.length ? { employmentIds: input.employmentIds } : null;
    const merged: PreProcessAdvisory = {
      missingCompensation: [],
      unpayablePayMode: [],
      zeroBasic: [],
      staleBasicComponent: [],
      missingStatutory: [],
      missingBank: [],
      // r79 — the wizard renders exactly the same groups as the batch card, so every optional list the
      // per-company core produces must be initialised AND merged here. `currencyMismatch` was declared on
      // the type and rendered by the wizard but never merged, so the non-MYR warning could not reach the
      // Validation step at all; merging it restores the parity this function's contract claims.
      currencyMismatch: [],
      hrdfSubjectUnregistered: [],
      // Item 1bb09a73 — a BLOCKER, so a missing merge here would let the wizard's Validation step show
      // all-clear for a run the terminal Process action then refuses. Same parity trap the note above
      // records for currencyMismatch.
      tp3YearMismatch: [],
    };
    for (const companyId of input.companyIds) {
      const a = await preProcessChecksTx(tx, { companyId, payPeriod: input.payPeriod, scope }, isModuleEnabled(ctx, 'typed_pay_components'));
      merged.missingCompensation.push(...a.missingCompensation);
      merged.unpayablePayMode!.push(...(a.unpayablePayMode ?? []));
      merged.zeroBasic!.push(...(a.zeroBasic ?? []));
      merged.staleBasicComponent!.push(...(a.staleBasicComponent ?? []));
      merged.missingStatutory.push(...a.missingStatutory);
      merged.missingBank.push(...a.missingBank);
      merged.currencyMismatch!.push(...(a.currencyMismatch ?? []));
      merged.hrdfSubjectUnregistered!.push(...(a.hrdfSubjectUnregistered ?? []));
      merged.tp3YearMismatch!.push(...(a.tp3YearMismatch ?? []));
    }
    return merged;
  });
}

export function batchDetail(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx.select().from(payrollBatch).where(eq(payrollBatch.id, batchId)).limit(1);
    if (!batch) return null;
    const slips = await tx
      .select({
        id: payslip.id,
        employmentId: payslip.employmentId,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        basic: payslip.basicSalary,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
        // 97a9b0ab — the revision counter (1 = as first generated, >1 = selectively reprocessed).
        // It has always been stored and never shown, which is why a moved figure looked unexplainable.
        // The RULESET version rides `statutory.version` (already selected above) — no column, no DDL.
        version: payslip.version,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    return { batch, slips };
  });
}

export class PaymentSummaryNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentSummaryNotReadyError';
  }
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';

/**
 * Batch payment summary for manual bank upload. A plain, neutral CSV — employee, bank, account,
 * net pay — deliberately NOT a byte-exact bank giro / IBG file: every bank's bulk-payment format
 * differs and must be verified against that bank's own portal (tracked separately as Layer-B).
 * Available once the batch is processed/closed (payslips exist). Logs an export event on the
 * batch so this egress of bank + net-pay data is auditable.
 */
export function paymentSummaryForBatch(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        payPeriod: payrollBatch.payPeriod,
        company: company.legalName,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) throw new PaymentSummaryNotReadyError('Payroll batch not found.');
    if (batch.status === 'draft') {
      throw new PaymentSummaryNotReadyError(
        'Process the batch before exporting a payment summary — a draft has no payslips yet.',
      );
    }

    const rows = await tx
      .select({
        name: person.fullName,
        code: employment.employeeCode,
        ic: employeeStatutoryMy.icNumber,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        // Custom payment holder (item ef720d3a): where a banking restriction requires salary to be paid into a
        // third party's account, the payee NAME / ID resolve to the custom holder instead of the employee. The
        // bank + account number remain the statutory-row values (the receiving account is still that row).
        enableCustomHolderName: employeeStatutoryMy.enableCustomHolderName,
        customHolderName: employeeStatutoryMy.customHolderName,
        enableCustomHolderId: employeeStatutoryMy.enableCustomHolderId,
        customHolderId: employeeStatutoryMy.customHolderId,
        // R46 79eb7151 — HOW this employee is paid. The bank-upload file is only meaningful for the rows
        // that are actually paid BY bank transfer; cheque and cash rows have to be settled another way.
        // Emitting the method turns a flat list into something the payment run can be split on, instead of
        // whoever opens the CSV having to remember who is not on transfer.
        paymentMethod: employment.paymentMethod,
        net: payslip.netPay,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.batchId, batchId))
      .orderBy(person.fullName);
    if (rows.length === 0) throw new PaymentSummaryNotReadyError('This batch has no payslips to export.');

    // Resolve the payee identity per row: custom holder when its switch is on (+ has a value), else the
    // employee. This changes ONLY who is named as the account holder — never the bank, account, or amount.
    const payeeFor = (r: (typeof rows)[number]) => ({
      holderName: r.enableCustomHolderName && r.customHolderName?.trim() ? r.customHolderName : r.name,
      holderId: r.enableCustomHolderId && r.customHolderId?.trim() ? r.customHolderId : (r.ic ?? ''),
    });

    const header = [
      'No',
      'Employee',
      'Employee Code',
      'IC',
      'Payment Holder Name',
      'Payment Holder ID',
      'Bank',
      'Account No',
      'Net Pay (RM)',
      // R46 79eb7151 — appended strictly LAST so every pre-existing column keeps its INDEX (0..8 unchanged).
      // A row with no method set emits an empty cell, so the data in every existing column is byte-identical
      // to before. Note the one thing that does change: Net Pay is no longer the final cell, so a consumer
      // reading "the last column" rather than a fixed index or the header sees the method instead. That is
      // unavoidable when widening a CSV; last-position is still the least disruptive placement, and the
      // header row names every column for anything parsing by name.
      'Payment Method',
    ];
    const body = rows.map((r, i) => {
      const payee = payeeFor(r);
      return [
        i + 1,
        r.name,
        r.code ?? '',
        r.ic ?? '',
        payee.holderName,
        payee.holderId,
        r.bankName ?? '',
        r.bankAccountNo ?? '',
        Number(r.net).toFixed(2),
        r.paymentMethod ?? '',
      ];
    });
    const content = toCsv([header, ...body]);
    const netTotalCents = rows.reduce((sum, r) => sum + Math.round(Number(r.net) * 100), 0);
    const missingBank = rows.filter((r) => !r.bankName || !r.bankAccountNo).length;
    const filename = `payment-summary_${slugify(batch.company)}_${batch.payPeriod}.csv`;

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: batchId,
      eventType: 'payroll-batch.payment-summary.exported',
      actor: actorOf(ctx),
      payload: { payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod },
    });

    return { content, filename, payeeCount: rows.length, netTotalCents, missingBank, payPeriod: batch.payPeriod };
  });
}

/** A single payslip's full breakdown for the employee detail/print view. RLS scopes it to
 *  what the caller may see (the employee sees their own via can_see_employment).
 *
 *  5c198931 WIDENED IT so the employee's own downloaded payslip is the SAME document as the admin review
 *  copy — it was a thin half page carrying neither the employee's identity and statutory numbers, nor
 *  their employment info, nor bank details, nor the company's currency or payment date. Everything added
 *  rides LEFT joins: an employee with no current assignment, no grade or no Malaysian statutory row must
 *  still get their payslip, and an inner join here would make it disappear entirely.
 *
 *  THE RELEASE GATE BELOW IS UNCHANGED. Widening the select does not widen who may read the row. */
export function payslipDetail(ctx: SessionContext, payslipId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: payslip.id,
        employmentId: payslip.employmentId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: payrollBatch.companyId,
        company: company.legalName,
        companyReg: company.registrationNo,
        currency: company.currency,
        payPeriod: payrollBatch.payPeriod,
        payDate: payrollBatch.batchDate,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        status: payrollBatch.status,
        basic: payslip.basicSalary,
        allowance: payslip.allowance,
        overtime: payslip.overtimePay,
        bonus: payslip.bonus,
        daysWorked: payslip.daysWorked,
        // 1b0943d5 (0446) — the coverage window this slip claims, read through `payslipSegmentOf` so the
        // document and the completeness control cannot disagree about which days it paid.
        coverageFrom: payslip.coverageFrom,
        coverageTo: payslip.coverageTo,
        gross: payslip.grossPay,
        statutory: payslip.statutory,
        otherDeductions: payslip.otherDeductions,
        totalDeductions: payslip.totalDeductions,
        net: payslip.netPay,
        employerCost: payslip.employerCost,
        // 97a9b0ab — revision counter for the payslip's own provenance footer (the ruleset version it
        // sits beside is already in `statutory`). Read-side only; both values predate this change.
        version: payslip.version,
        // Step 6 (f3148da1) — the release instant, materialized at close time (RLS-safe: readable by the
        // employee via their own payslip's batch, unlike the admin-only company_payroll_config).
        releasedAt: payrollBatch.releasedAt,
        // 5c198931 — the employment + identity context the official document prints. Same columns
        // core/payroll-view.ts `payslipForReview` already returns to the admin screen.
        department: department.name,
        position: position.title,
        jobGrade: jobGrade.name,
        employmentType: assignment.employmentType,
        paymentMethod: employment.paymentMethod,
        bankName: employeeStatutoryMy.bankName,
        bankAccountNo: employeeStatutoryMy.bankAccountNo,
        icNumber: employeeStatutoryMy.icNumber,
        passportNumber: employeeStatutoryMy.passportNumber,
        epfNumber: employeeStatutoryMy.epfNumber,
        socsoNumber: employeeStatutoryMy.socsoNumber,
        taxNumber: employeeStatutoryMy.taxNumber,
      })
      .from(payslip)
      .innerJoin(payrollBatch, eq(payrollBatch.id, payslip.batchId))
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      // LEFT, every one of them. An employee with no current assignment, no grade or no MY statutory row
      // would lose their payslip entirely behind an inner join — the one real risk in widening this read.
      .leftJoin(
        assignment,
        and(
          eq(assignment.employmentId, employment.id),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .leftJoin(department, eq(department.id, assignment.departmentId))
      .leftJoin(position, eq(position.id, assignment.positionId))
      .leftJoin(jobGrade, eq(jobGrade.id, employment.gradeId))
      .leftJoin(employeeStatutoryMy, eq(employeeStatutoryMy.personId, employment.personId))
      .where(eq(payslip.id, payslipId))
      .limit(1);
    if (!row) return null;
    // Step 6 — hide a payslip whose batch is not yet closed OR whose release instant has not passed, so the ESS
    // detail page + PDF route (which both call this) return notFound/404 until release. Admin surfaces use
    // different reads (payroll-view.ts) and are unaffected. A closed batch with a NULL releasedAt is a legacy
    // batch (backfilled to created_at by migration 0164), treated as released.
    const released = row.status === 'closed' && (row.releasedAt == null || row.releasedAt.getTime() <= Date.now());
    if (!released) return null;
    const { releasedAt: _r, bankAccountNo, icNumber, passportNumber, ...rest } = row;
    // The bank account is returned in BOTH forms here, exactly as `payslipForReview` returns it.
    //
    // f35f758a REPLACED THE COMMENT THAT USED TO SIT HERE. It said `employee_statutory_my.bank_account_no`
    // is PDPA-scoped financial data (core/pdpa.ts) and that the full number "must never leave the server,
    // not even to the account's own owner's browser". That was a build-time judgement in 5c198931, never an
    // ADR, and the approved plan overturns it for the DOCUMENT: this read serves the employee's own payslip,
    // and their own account number is theirs to read. The masked form stays for screens; the PDF route
    // takes the full one. Leaving the old comment in place would have left a rule that contradicts the code.
    const acct = (bankAccountNo ?? '').trim();
    return {
      ...rest,
      /** Last four only — what a SCREEN prints. */
      bankAccountMasked: acct ? (acct.length > 4 ? `••••${acct.slice(-4)}` : acct) : null,
      /** The whole number — printed on the payslip DOCUMENT, which this read also feeds. */
      bankAccountFull: acct || null,
      // IC first; a non-Malaysian employee carries a passport instead (icNumber has been nullable since
      // migration 0212). The document labels which one it is showing rather than calling a passport an IC.
      identityNumber: icNumber?.trim() || passportNumber?.trim() || null,
      identityIsPassport: !icNumber?.trim() && !!passportNumber?.trim(),
    };
  });
}

/**
 * Rows for the draft-batch input editor: each active-in-period employee with their current manual
 * overtime and the auto-derived unpaid-leave days (read-only preview of what generation will apply).
 */
export function batchInputRows(ctx: SessionContext, batchId: string) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ companyId: payrollBatch.companyId, payPeriod: payrollBatch.payPeriod, country: company.country })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(eq(payrollBatch.id, batchId))
      .limit(1);
    if (!batch) return [];
    const [pYear, pMonth] = batch.payPeriod.split('-').map(Number);
    const periodStart = `${batch.payPeriod}-01`;
    const periodEnd = `${batch.payPeriod}-${String(daysInMonth(pYear, pMonth)).padStart(2, '0')}`;
    // Fix-5 (#4/#29): resolve the OT engine + statutory ruleset so we can surface each employee's
    // s.60I(1A) ORP (wages/26) + hourly (ORP/8) basis and the RM4,000 eligibility — READ-ONLY, computed
    // from the same overtimePay/compensation source the kernel uses. Pack may be absent (non-MY) ⇒ skip.
    const pack = packFor(batch.country);
    const otRules = pack ? (await pack.payroll.loadRuleset(tx, { asOf: periodEnd })).ot : undefined;
    const otCeiling = otRules?.wageCeiling;
    const emps = await tx
      .select({
        employmentId: employment.id,
        name: person.fullName,
        employeeCode: employment.employeeCode,
        basic: compensation.basicSalary,
        allowance: compensation.monthlyAllowance,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(
        compensation,
        and(
          eq(compensation.employmentId, employment.id),
          isNull(compensation.validTo),
          isNull(compensation.supersededAt),
        ),
      )
      .where(
        and(
          // 3c88d593 — the DATED entity question, same as generatePayslips. Reading only the column here
          // and the history there is exactly the drift this helper exists to prevent: an employee the
          // kernel pays on the outgoing entity's run, on a screen that cannot see them.
          employedByCompanyDuring(batch.companyId, periodStart, periodEnd),
          lte(employment.hiredOn, periodEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, periodStart)),
        ),
      )
      .orderBy(person.fullName);
    const inputs = await tx
      .select({
        employmentId: payrollInput.employmentId,
        overtime: payrollInput.overtimeAmount,
        bonus: payrollInput.bonusAmount,
        tp1: payrollInput.tp1Deduction,
        zakat: payrollInput.zakat,
        loanDeduction: payrollInput.loanDeduction,
        otBreakdown: payrollInput.otBreakdown,
        otSource: payrollInput.otSource,
      })
      .from(payrollInput)
      .where(eq(payrollInput.batchId, batchId));
    const otMap = new Map(inputs.map((r) => [r.employmentId, Number(r.overtime)]));
    const bonusMap = new Map(inputs.map((r) => [r.employmentId, Number(r.bonus)]));
    const tp1Map = new Map(inputs.map((r) => [r.employmentId, Number(r.tp1)]));
    const zakatMap = new Map(inputs.map((r) => [r.employmentId, Number(r.zakat)]));
    // 1.2.8 (ADR-0060): surface the reserved loan deduction so the admin's pre-generation net preview
    // matches the generated payslip (omitting it would create a silent reconciliation gap).
    const loanMap = new Map(inputs.map((r) => [r.employmentId, Number(r.loanDeduction)]));
    const otBreakdownMap = new Map(inputs.map((r) => [r.employmentId, r.otBreakdown ?? null]));
    const otSourceMap = new Map(inputs.map((r) => [r.employmentId, r.otSource ?? null]));
    const unpaid = await unpaidDaysByEmployment(tx, periodStart, periodEnd);
    // e2632276 — the ABSENT-days preview beside the unpaid-days one, so the count can be checked BEFORE
    // the run is processed. GATED, and the gate is a performance property as much as a safety one: the
    // count costs a holiday resolution and a roster scan, and this runs on every draft-batch page load.
    // Computing it for an employment whose policy will not deduct for it would be N round trips to fill a
    // column that prints "—". So resolve the switch first (three set-based queries) and ask only for the
    // employments it is on for; with it off everywhere — the shipped state, all nine companies — this
    // issues no absence query at all and every cell reads "—", which is the honest preview of a deduction
    // that is not running.
    const deductAbsence = await deductAbsentDaysByEmployment(
      tx,
      emps.map((e) => e.employmentId),
    );
    const absent =
      deductAbsence.size > 0
        ? await absentDaysByEmployment(tx, periodStart, periodEnd, [...deductAbsence])
        : new Map<string, number>();
    return emps.map((e) => {
      const wages = round2(Number(e.basic) + Number(e.allowance ?? 0));
      // s.60I(1A): ORP = wages/26, hourly = ORP/8. Run the engine with no days to get just the basis +
      // eligibility against the statutory wage ceiling — the SAME computation that monetizes a prefill.
      const basis = pack
        ? pack.payroll.overtimePay({
            monthlyWages: wages,
            days: [],
            wageCeiling: otCeiling,
            restDayExcessMultiplier: otRules?.restDayExcessMultiplier,
            holidayExcessMultiplier: otRules?.holidayExcessMultiplier,
          })
        : null;
      return {
        employmentId: e.employmentId,
        name: e.name,
        employeeCode: e.employeeCode,
        basic: Number(e.basic),
        overtimeAmount: otMap.get(e.employmentId) ?? 0,
        // Per-bucket rate split for prefilling the four OT inputs; null ⇒ inputs default to 0 each.
        otBreakdown: otBreakdownMap.get(e.employmentId) ?? null,
        // Fix-5 (M#17): provenance of the current OT figure ('attendance' | 'manual' | null) — drives the
        // editor's clobber warning before a manual Save overwrites an attendance-derived row.
        otSource: otSourceMap.get(e.employmentId) ?? null,
        // Fix-5 (#4): read-only s.60I(1A) basis surfaced beside the manual OT inputs so the admin keys
        // against the correct ORP/hourly. orp/hourly null when no pack resolves (non-MY).
        orp: basis ? basis.orp : null,
        hourly: basis ? basis.hourly : null,
        // Fix-5 (#29): false ⇒ wages above the s.60A RM4,000 ceiling, statutory OT not mandated (any OT
        // here is contractual). null ⇒ no pack/ceiling to assess against.
        otEligible: basis ? basis.eligible : null,
        otWageCeiling: otCeiling ?? null,
        bonusAmount: bonusMap.get(e.employmentId) ?? 0,
        tp1Deduction: tp1Map.get(e.employmentId) ?? 0,
        zakat: zakatMap.get(e.employmentId) ?? 0,
        loanDeduction: loanMap.get(e.employmentId) ?? 0,
        unpaidDays: unpaid.get(e.employmentId) ?? 0,
        // e2632276 — scheduled working days with no attendance record, or one marked Absent. Never
        // approved leave, never a public holiday, never a rest day (the roster wins over the company
        // calendar). See core/absence-days.ts.
        absentDays: absent.get(e.employmentId) ?? 0,
      };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// 2961a7ae — STATUTORY ADJUSTMENT: the manual override of a computed statutory figure
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//
// There was nowhere in the system to overrule a statutory figure. Overtime, bonus, TP1 relief, zakat and
// claim allowances can all be keyed against a run (payroll_input); EPF, SOCSO, EIS, SKBBK, PCB and the HRD
// levy came out of the calculation and that was the end of it. When an agency confirms a different figure,
// the only ways out were to change something upstream and reprocess, or leave the payslip wrong.
//
// STORED AS AN INPUT, NOT AS A STAMPED RESULT (migration 0430, db/schema.ts payrollStatutoryAdjustment).
// Reprocessing recomputes a payslip from scratch and bumps payslip.version, so an override written ONTO
// the payslip row would be destroyed by the next reprocess — and this reporter reprocesses constantly. As
// an input the generator reads, it is idempotent across reprocesses and Revert is a row delete.
//
// NINE LINES, NOT THE TEN THE REQUEST LISTS. SKBBK / Lindung 24 Jam exists only as an EMPLOYEE-paid leg
// (localization/my/payroll.ts socso() → { employer, employee, skbbk }); there is no employer SKBBK figure
// in the engine, so the screen shows nine lines rather than inventing an always-zero tenth.

/** The nine overridable statutory lines, employee side first, in the order the screen renders them. */
export const STATUTORY_ADJUSTMENT_LINES = [
  'pcb',
  'epfEmployee',
  'socsoEmployee',
  'socsoSkbbk',
  'eisEmployee',
  'hrdf',
  'epfEmployer',
  'socsoEmployer',
  'eisEmployer',
] as const;
export type StatutoryAdjustmentLine = (typeof STATUTORY_ADJUSTMENT_LINES)[number];

/** The employer-funded legs. These move employer cost and can never reduce the employee's net pay —
 *  structural, because net_pay is composed from the EMPLOYEE legs and employer_cost from these. */
export const STATUTORY_ADJUSTMENT_EMPLOYER_LINES: readonly StatutoryAdjustmentLine[] = [
  'hrdf',
  'epfEmployer',
  'socsoEmployer',
  'eisEmployer',
];
const isEmployerLine = (k: StatutoryAdjustmentLine) => STATUTORY_ADJUSTMENT_EMPLOYER_LINES.includes(k);

/**
 * One override set. `null` on a line means NO override (use the system figure); `0` means override to
 * zero. That distinction IS the requirement — never collapse an absent value and a zero into one.
 */
export type StatutoryAdjustmentValues = Partial<Record<StatutoryAdjustmentLine, number | null>>;

/** What the payslip carries about an override: the system figure, the applied figure, and the reason. */
export type StatutoryAdjustmentStamp = {
  reason: string;
  lines: Partial<Record<StatutoryAdjustmentLine, { system: number; applied: number }>>;
};

export class StatutoryAdjustmentBatchNotOpenError extends Error {
  constructor() {
    super('statutory-adjustment-batch-not-open');
    this.name = 'StatutoryAdjustmentBatchNotOpenError';
  }
}
export class StatutoryAdjustmentReasonRequiredError extends Error {
  constructor() {
    super('statutory-adjustment-reason-required');
    this.name = 'StatutoryAdjustmentReasonRequiredError';
  }
}
export class StatutoryAdjustmentAmountInvalidError extends Error {
  constructor(public readonly line: string) {
    super('statutory-adjustment-amount-invalid');
    this.name = 'StatutoryAdjustmentAmountInvalidError';
  }
}
export class StatutoryAdjustmentNotFoundError extends Error {
  constructor() {
    super('statutory-adjustment-not-found');
    this.name = 'StatutoryAdjustmentNotFoundError';
  }
}

/** Read a stored numeric column into an override value: NULL stays null, '0.00' becomes 0. */
const adjNum = (v: string | null): number | null => (v == null ? null : round2(Number(v)));

/** The stored row's nine columns as a values object. */
function valuesOfAdjustmentRow(r: Record<string, unknown>): StatutoryAdjustmentValues {
  const out: StatutoryAdjustmentValues = {};
  for (const k of STATUTORY_ADJUSTMENT_LINES) out[k] = adjNum((r[k] ?? null) as string | null);
  return out;
}

/**
 * THE ENGINE HOOK, pure. Applies an override set to the computed statutory object and stamps the three
 * values the reporter asks to retain (system → adjustment → final).
 *
 * `adj === null` returns the computed object UNCHANGED — not a copy with extra keys, the same object —
 * so every payslip on every run without an override is byte-identical to the pre-2961a7ae kernel.
 *
 * DELIBERATELY NO CASCADE. Overriding EPF does NOT re-derive PCB from the new EPF figure, even though
 * pcbMonth normally takes epfClaimed from the computed EPF. An override is a declaration about the FINAL
 * line; quietly moving a figure the operator did not touch is how a screen like this loses trust. PCB has
 * its own line and its own box — override both if both should move. (Stated in the plan's GOOD TO KNOW.)
 *
 * The stamp is a SEPARATE member (`statutory.adjustment`), not new statutory line keys, so
 * diffPayslipVersions / STATUTORY_LINE_KEYS keep reporting exactly the nine money lines and never start
 * reporting the stamp itself as a movement.
 */
export function applyStatutoryAdjustment<T extends Record<string, unknown>>(
  computed: T,
  adj: { values: StatutoryAdjustmentValues; reason: string } | null,
): T & { adjustment?: StatutoryAdjustmentStamp } {
  if (!adj) return computed;
  const lines: StatutoryAdjustmentStamp['lines'] = {};
  const patch: Record<string, number> = {};
  for (const k of STATUTORY_ADJUSTMENT_LINES) {
    const applied = adj.values[k];
    if (applied == null) continue; // blank ⇒ keep the system figure
    const system = round2(Number(computed[k] ?? 0));
    patch[k] = round2(applied);
    lines[k] = { system, applied: round2(applied) };
  }
  if (Object.keys(patch).length === 0) return computed;
  const stamp: StatutoryAdjustmentStamp = { reason: adj.reason, lines };
  return { ...computed, ...patch, adjustment: stamp } as T & { adjustment: StatutoryAdjustmentStamp };
}

/**
 * The before/after the Review step shows, computed as a DELTA off the stored payslip rather than by
 * re-deriving gross→net. Re-deriving would be a second implementation of the kernel's composition and
 * would drift from it; a delta cannot, because it starts from the figure the kernel actually produced.
 *
 * Gross NEVER moves — a statutory line is not a gross-pay component (the reporter's rule 8).
 *
 * `employerBears` matters and is not cosmetic: when an employee's SOCSO / EIS / SKBBK / PCB / EPF share
 * is employer-funded, that share is subtracted from their deductions and added to employer cost, so
 * overriding it moves EMPLOYER cost and leaves net pay alone. Passing the flags keeps the preview honest
 * for those employees instead of promising a net-pay change that will not happen.
 *
 * CAVEAT, stated rather than hidden: the kernel clamps post-tax deductions so net ≥ 0 (EA s.24 net
 * floor). An override large enough to drive net below zero will be clamped at generation and the applied
 * result will differ from this preview. `netFloorReached` reports exactly that case.
 */
export function previewStatutoryAdjustment(p: {
  statutory: Record<string, unknown>;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  employerCost: number;
  values: StatutoryAdjustmentValues;
  employerBears?: { socso?: boolean; eis?: boolean; skbbk?: boolean; tax?: boolean; epf?: boolean };
}): {
  lines: { line: StatutoryAdjustmentLine; system: number; applied: number; delta: number }[];
  grossBefore: number; grossAfter: number;
  deductionsBefore: number; deductionsAfter: number;
  netBefore: number; netAfter: number;
  employerCostBefore: number; employerCostAfter: number;
  netFloorReached: boolean;
} {
  const bears = p.employerBears ?? {};
  // Which employee-side lines the employer funds. A funded line's movement lands on employer cost, not
  // on the employee's deductions — the same reassignment the kernel performs (employerBorneTotal).
  const funded: Partial<Record<StatutoryAdjustmentLine, boolean>> = {
    socsoEmployee: bears.socso === true,
    eisEmployee: bears.eis === true,
    socsoSkbbk: bears.skbbk === true,
    pcb: bears.tax === true,
    epfEmployee: bears.epf === true,
  };

  const lines: { line: StatutoryAdjustmentLine; system: number; applied: number; delta: number }[] = [];
  let employeeDelta = 0; // change to what the employee actually pays
  let employerDelta = 0; // change to employer cost
  for (const k of STATUTORY_ADJUSTMENT_LINES) {
    const applied = p.values[k];
    if (applied == null) continue;
    const system = round2(Number(p.statutory[k] ?? 0));
    const delta = round2(round2(applied) - system);
    lines.push({ line: k, system, applied: round2(applied), delta });
    if (isEmployerLine(k)) employerDelta = round2(employerDelta + delta);
    else if (funded[k]) employerDelta = round2(employerDelta + delta); // employer-funded employee share
    else employeeDelta = round2(employeeDelta + delta);
  }

  const deductionsBefore = round2(p.totalDeductions);
  const netBefore = round2(p.netPay);
  const deductionsAfter = round2(deductionsBefore + employeeDelta);
  const netAfter = round2(netBefore - employeeDelta);
  return {
    lines,
    grossBefore: round2(p.grossPay),
    grossAfter: round2(p.grossPay), // never moves
    deductionsBefore,
    deductionsAfter,
    netBefore,
    netAfter,
    employerCostBefore: round2(p.employerCost),
    employerCostAfter: round2(round2(p.employerCost) + employerDelta),
    netFloorReached: netAfter < 0,
  };
}

/**
 * Payroll runs an adjustment may be entered against: PROCESSED and not closed, newest period first.
 *
 * "Payroll Cycle" on the reporter's mock-up is `payroll_batch.run_type` here — regular / additional /
 * off_cycle. payroll_cycle is a per-company CATALOG (name + code + run type) with no foreign key from a
 * batch, so the run's own run_type is the only cycle fact a batch actually carries; filtering on the
 * catalog would be filtering on something the run is not stamped with.
 */
export function listAdjustableBatches(
  ctx: SessionContext,
  p: { companyId?: string; year?: string; month?: string; runType?: string } = {},
) {
  return withTenant(ctx, async (tx) => {
    const conds = [eq(payrollBatch.tenantId, ctx.tenantId), eq(payrollBatch.status, 'processed')];
    if (p.companyId) conds.push(eq(payrollBatch.companyId, p.companyId));
    if (p.year && p.month) conds.push(eq(payrollBatch.payPeriod, `${p.year}-${p.month}`));
    else if (p.year) conds.push(like(payrollBatch.payPeriod, `${p.year}-%`));
    if (p.runType) conds.push(eq(payrollBatch.runType, p.runType as 'regular'));
    return tx
      .select({
        batchId: payrollBatch.id,
        companyId: payrollBatch.companyId,
        companyName: company.legalName,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
        runSeq: payrollBatch.runSeq,
        needsRecalcAt: payrollBatch.needsRecalcAt,
      })
      .from(payrollBatch)
      .innerJoin(company, eq(company.id, payrollBatch.companyId))
      .where(and(...conds))
      .orderBy(desc(payrollBatch.payPeriod), payrollBatch.runSeq);
  });
}

/** The employees on a run, with whether each already carries an override. `q` matches code or name. */
export function listAdjustmentEmployees(ctx: SessionContext, p: { batchId: string; q?: string }) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        employmentId: payslip.employmentId,
        employeeCode: employment.employeeCode,
        name: person.fullName,
        netPay: payslip.netPay,
        adjustedAt: payrollStatutoryAdjustment.updatedAt,
      })
      .from(payslip)
      .innerJoin(employment, eq(employment.id, payslip.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .leftJoin(
        payrollStatutoryAdjustment,
        and(
          eq(payrollStatutoryAdjustment.batchId, payslip.batchId),
          eq(payrollStatutoryAdjustment.employmentId, payslip.employmentId),
        ),
      )
      .where(eq(payslip.batchId, p.batchId))
      .orderBy(employment.employeeCode);
    const q = (p.q ?? '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => (r.employeeCode ?? '').toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q),
    );
  });
}

/**
 * Everything the adjustment screen needs for ONE employee on ONE run: the system figures from the stored
 * payslip, any override already saved, the payslip totals the preview works off, the employer-bears flags
 * and the downstream warnings (already filed / already paid out).
 *
 * `batchDownstreamWarnings` is REUSED, not re-derived — it is the same derivation unlockClosedBatch and
 * the Individual Transaction screen show, so the three screens cannot disagree about whether a figure has
 * already left the building.
 */
export function getStatutoryAdjustmentDetail(ctx: SessionContext, p: { batchId: string; employmentId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        status: payrollBatch.status,
        companyId: payrollBatch.companyId,
        payPeriod: payrollBatch.payPeriod,
        runType: payrollBatch.runType,
      })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch) return null;
    const [slip] = await tx
      .select()
      .from(payslip)
      .where(and(eq(payslip.batchId, p.batchId), eq(payslip.employmentId, p.employmentId)))
      .limit(1);
    if (!slip) return null;
    const [emp] = await tx
      .select({ code: employment.employeeCode, name: person.fullName })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const [bears] = await tx
      .select({
        socso: employeeStatutoryMy.employerBearsSocso,
        eis: employeeStatutoryMy.employerBearsEis,
        skbbk: employeeStatutoryMy.employerBearsSkbbk,
        tax: employeeStatutoryMy.employerBearsTax,
        epf: employeeStatutoryMy.employerBearsEpf,
      })
      .from(employeeStatutoryMy)
      .innerJoin(employment, eq(employment.personId, employeeStatutoryMy.personId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    const [existing] = await tx
      .select()
      .from(payrollStatutoryAdjustment)
      .where(
        and(
          eq(payrollStatutoryAdjustment.batchId, p.batchId),
          eq(payrollStatutoryAdjustment.employmentId, p.employmentId),
        ),
      )
      .limit(1);
    const warnings = await batchDownstreamWarnings(tx, {
      batchId: p.batchId,
      companyId: batch.companyId,
      payPeriod: batch.payPeriod,
    });
    const stored = (slip.statutory ?? {}) as Record<string, unknown>;
    // The SYSTEM figure is the computed one, which is NOT the stored line once an override is applied —
    // the stamp keeps the original, so "System Amount" survives every reprocess. Falls back to the stored
    // line for a slip with no stamp (no override has ever been applied).
    const stamp = (stored.adjustment ?? null) as StatutoryAdjustmentStamp | null;
    const system: Record<StatutoryAdjustmentLine, number> = {} as Record<StatutoryAdjustmentLine, number>;
    for (const k of STATUTORY_ADJUSTMENT_LINES) {
      system[k] = round2(Number(stamp?.lines?.[k]?.system ?? stored[k] ?? 0));
    }
    return {
      batchId: p.batchId,
      employmentId: p.employmentId,
      status: batch.status as 'draft' | 'processed' | 'closed',
      payPeriod: batch.payPeriod,
      companyId: batch.companyId,
      employeeCode: emp?.code ?? null,
      employeeName: emp?.name ?? null,
      system,
      current: existing ? valuesOfAdjustmentRow(existing as unknown as Record<string, unknown>) : null,
      reason: existing?.reason ?? '',
      grossPay: round2(Number(slip.grossPay)),
      totalDeductions: round2(Number(slip.totalDeductions)),
      netPay: round2(Number(slip.netPay)),
      employerCost: round2(Number(slip.employerCost)),
      employerBears: {
        socso: bears?.socso ?? false,
        eis: bears?.eis ?? false,
        skbbk: bears?.skbbk ?? false,
        tax: bears?.tax ?? false,
        epf: bears?.epf ?? false,
      },
      ...warnings,
    };
  });
}

/** Validate one keyed amount. '' ⇒ null (no override). '0' ⇒ 0 (override to zero). Negative ⇒ refused. */
export function parseAdjustmentAmount(raw: string | null | undefined, line: string): number | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new StatutoryAdjustmentAmountInvalidError(line);
  return round2(n);
}

/**
 * Save (or replace) the override set for one employee on one run.
 *
 * REFUSED unless the run is PROCESSED — a draft has no result to override and a closed run is frozen
 * (0011_payroll_immutability.sql freezes its payslips at trigger level, so an app that permitted this
 * would be offering an edit the database rejects). Refused HERE, before any write, with a named error,
 * rather than letting the trigger raise a Postgres message onto the screen.
 *
 * Marks the run for recalculation and names the employee, so Close refuses until the result is caught up
 * (the refusal already exists in closeBatch). Emits payroll-batch.statutory-adjusted carrying the line,
 * system amount, applied amount and the reason — the "who typed what" half; the MONEY trail is already
 * free, because payroll_employee_result_history records the before/after blobs on every regeneration.
 */
export function saveStatutoryAdjustment(
  ctx: SessionContext,
  p: { batchId: string; employmentId: string; values: StatutoryAdjustmentValues; reason: string },
) {
  return withTenant(ctx, async (tx) => {
    const reason = (p.reason ?? '').trim();
    if (!reason) throw new StatutoryAdjustmentReasonRequiredError();
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch || batch.status !== 'processed') throw new StatutoryAdjustmentBatchNotOpenError();
    const [slip] = await tx
      .select({ statutory: payslip.statutory })
      .from(payslip)
      .where(and(eq(payslip.batchId, p.batchId), eq(payslip.employmentId, p.employmentId)))
      .limit(1);
    if (!slip) throw new StatutoryAdjustmentNotFoundError();

    const cols: Record<string, string | null> = {};
    const changed: { line: StatutoryAdjustmentLine; system: number; applied: number }[] = [];
    const stored = (slip.statutory ?? {}) as Record<string, unknown>;
    const stamp = (stored.adjustment ?? null) as StatutoryAdjustmentStamp | null;
    for (const k of STATUTORY_ADJUSTMENT_LINES) {
      const v = p.values[k];
      if (v != null && v < 0) throw new StatutoryAdjustmentAmountInvalidError(k);
      // NULL and 0.00 are DIFFERENT values and are written as such — the whole blank-vs-zero requirement.
      cols[k] = v == null ? null : v.toFixed(2);
      if (v != null) {
        changed.push({ line: k, system: round2(Number(stamp?.lines?.[k]?.system ?? stored[k] ?? 0)), applied: round2(v) });
      }
    }

    const [row] = await tx
      .insert(payrollStatutoryAdjustment)
      .values({
        tenantId: ctx.tenantId,
        batchId: p.batchId,
        employmentId: p.employmentId,
        ...cols,
        reason,
        createdByUserId: ctx.userId ?? null,
      } as typeof payrollStatutoryAdjustment.$inferInsert)
      .onConflictDoUpdate({
        target: [payrollStatutoryAdjustment.batchId, payrollStatutoryAdjustment.employmentId],
        set: { ...cols, reason, createdByUserId: ctx.userId ?? null, updatedAt: new Date() },
      })
      .returning({ id: payrollStatutoryAdjustment.id });

    await markBatchNeedsRecalc(tx, ctx, { batchId: p.batchId, employmentIds: [p.employmentId] });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.statutory-adjusted',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, reason, lines: changed },
    });
    return { id: row.id, lines: changed };
  });
}

/** Remove the override entirely and mark the run so the computed figures come back on the next run. */
export function revertStatutoryAdjustment(ctx: SessionContext, p: { batchId: string; employmentId: string }) {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({ status: payrollBatch.status })
      .from(payrollBatch)
      .where(eq(payrollBatch.id, p.batchId))
      .limit(1);
    if (!batch || batch.status !== 'processed') throw new StatutoryAdjustmentBatchNotOpenError();
    const [existing] = await tx
      .select()
      .from(payrollStatutoryAdjustment)
      .where(
        and(
          eq(payrollStatutoryAdjustment.batchId, p.batchId),
          eq(payrollStatutoryAdjustment.employmentId, p.employmentId),
        ),
      )
      .limit(1);
    if (!existing) throw new StatutoryAdjustmentNotFoundError();
    await tx
      .delete(payrollStatutoryAdjustment)
      .where(eq(payrollStatutoryAdjustment.id, existing.id));
    await markBatchNeedsRecalc(tx, ctx, { batchId: p.batchId, employmentIds: [p.employmentId] });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: p.batchId,
      eventType: 'payroll-batch.statutory-adjustment-reverted',
      actor: actorOf(ctx),
      payload: { employmentId: p.employmentId, reason: existing.reason },
    });
    return { reverted: true as const };
  });
}
