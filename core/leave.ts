/**
 * Leave services. Balance is the signed sum of the append-only leave_ledger
 * (accrual +, debit −, adjustment ±). Approval checks projected balance and writes
 * the debit + status flip + event atomically in one transaction.
 */
// `isNotNull` and `ne` left with the expireAgedLeave sweep (c459bff9) — it was the only caller of either.
import { aliasedTable, and, asc, desc, eq, gt, gte, inArray, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { assertCanDecide } from './approvals';
import { scopeOf } from '../lib/delegation-scope';
import { isAdmin, isGroupAdmin, hasGrantFor, withEffectiveGrants } from '../lib/authz';
// 5206539f — the pure "does this caller hold this key" decision (defaults ∘ tenant overrides ∘ company
// overrides). Taken from the lib/ leaf rather than from core/payroll.ts's resolvePayrollPermission, which
// is the same decision wrapped in a query: importing it would pull the whole payroll kernel into every
// leave request path for fifteen lines of SELECT.
import { decidePayrollPermission } from '../lib/payroll-permissions';
import {
  approversOf,
  resolveApprovalDecision,
  sanitizeApprovalLevels,
  type ApprovalApprover,
  type ApprovalDecisionSource,
  type ApprovalLevel,
} from './leave-approval-policy';
// r293 phase 3 — "no longer an active employment" is the SAME predicate every screen's status badge
// derives from; a fixed-approver warning that used its own rule would disagree with the profile it points at.
import { isEmploymentEnded } from './employment-status';
import { todayInKualaLumpur } from '../lib/hr-date';
// 35b7af0a group 3 — the whole-year calendar counters, defined in a CLIENT-SAFE module and re-exported
// below (see the note beside that export). Imported here so every use INSIDE this file keeps binding the
// same function, and so `@/core/leave` stays their public server-side door.
import { serviceYearsAt, completedYearsAt } from '../lib/completed-years';
// 46afcc48 — the shared group's CYCLE, stated once. The window below used to be spelled inline here; the
// Leave tab's new group figure must count over exactly the same one, and two spellings of "the group's
// year" is how a displayed number and an enforcement verdict start disagreeing. Behaviour is unchanged:
// the helper returns the same calendar-year pair this function has always built.
import { sharedGroupCycleWindow } from '../lib/leave-groups';
import { consumeReplacementLeaveTx } from './toil';
import {
  holidayDatesFor,
  effectiveHolidayState,
  warnIfHolidaysIncomplete,
  yearsSpanned,
  type HolidayCompletenessWarning,
} from './holidays';
import { isoWeekday } from './attendance';
import { packFor } from '../localization/registry';
import { ORG_ASSIGNMENT_CRITERIA } from './leave-org-criteria';
// 6e9a126e RELEASE TWO — the entitlement TEMPLATE layer. No import cycle: core/entitlement-template.ts
// imports only db/, ./leave-compute and ./org-criteria, and never this module.
import {
  buildTemplateEntitlementResolver,
  earliestTemplateYear,
  leaveTypeIdsWithTemplatesAt,
  templateStartsWithinWindow,
} from './entitlement-template';
import {
  applyLeaveTypeRules,
  applyMaxBalance,
  applyRounding,
  bandFor,
  bandCarryExpiry,
  bandCarryMax,
  bandMaxBalance,
  carryAllowanceFrom,
  carryConfigured,
  carryEnabled,
  resolveCarryAllowance,
  // 6e9a126e — THE SINGLE COMPOSITION HOOK. Every granting engine and the projection kernel in this file
  // resolve an employee's entitlement through this one function; nothing here composes layers by hand.
  // Release three left it with ONE layer (the entitlement template's band) — see composeEntitlement.
  composeEntitlement,
  policyFromTemplateBand,
  policyForDatedReader,
  // 6e9a126e — "nothing configured is not zero days". Read inside composeEntitlement.
  noEntitlementOpinion,
  hasAnyLeaveTypeRule,
  isEngineRoundingMethod,
  // 8fec719e — the custom rounding table: the two choosable methods, the shared validator and the
  // evaluator. Re-exported below so server callers/tests keep importing them from '@/core/leave'.
  isUserRoundingMethod,
  applyRoundingBands,
  checkRoundingBands,
  isWellFormedRoundingBands,
  roundingBandErrors,
  USER_ROUNDING_METHODS,
  LEGACY_ROUNDING_METHODS,
  type RoundingBand,
  type RoundingBandProblem,
  type UserRoundingMethod,
  isValidMonthDay,
  isWellFormedBands,
  // 6e9a126e — the band ceiling and the shared write-time band validator, so core/admin.ts and
  // core/entitlement-template.ts hold ONE definition between them instead of a literal each.
  MAX_SERVICE_BANDS,
  validateServiceBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  DEFAULT_ROUNDING_THRESHOLD,
  ENGINE_ROUNDING_METHODS,
  resolveRoundingThreshold,
  roundingThresholdRanges,
  type AccrualConfig,
  type EngineRoundingMethod,
  type CarryExpiry,
  type LeaveRoundingMethod,
  type LeaveTypeRules,
  type ResolvedPolicy,
  type ServiceBand,
} from './leave-compute';
// Override Leave Application (56910869) — the rule vocabulary. Pure (no db), so the engine, the write
// validator and the admin panel all read ONE definition of what a rule is and when it engages.
import {
  leaveOverrideConsentToken,
  leaveOverrideNeedsConsent,
  normalizeLeaveOverrideRules,
  parseLeaveOverrideConsent,
  resolveLeaveOverrideRule,
  type LeaveOverrideAction,
  type LeaveOverrideRule,
  type LeaveOverrideTrigger,
} from './leave-override';
export {
  leaveOverrideConsentToken,
  leaveOverrideNeedsConsent,
  normalizeLeaveOverrideRules,
  parseLeaveOverrideConsent,
  resolveLeaveOverrideRule,
  type LeaveOverrideAction,
  type LeaveOverrideRule,
  type LeaveOverrideTrigger,
} from './leave-override';
// Re-export the pure module's surface so every existing caller/test keeps importing these from '@/core/leave'.
export {
  applyLeaveTypeRules,
  applyMaxBalance,
  applyRounding,
  bandFor,
  bandCarryExpiry,
  bandCarryMax,
  bandMaxBalance,
  carryEnabled,
  // 6e9a126e — the single composition hook and the template band's carrier, re-exported like the rest of
  // the pure module so tests and server callers can pin them from '@/core/leave'.
  composeEntitlement,
  policyFromTemplateBand,
  policyForDatedReader,
  // 6e9a126e — re-exported like the rest of the pure module so tests and server callers can pin the
  // guard's predicate directly from '@/core/leave'.
  noEntitlementOpinion,
  hasAnyLeaveTypeRule,
  isEngineRoundingMethod,
  // 8fec719e — the custom rounding table surface, re-exported like the rest of the pure module.
  isUserRoundingMethod,
  applyRoundingBands,
  checkRoundingBands,
  isWellFormedRoundingBands,
  roundingBandErrors,
  USER_ROUNDING_METHODS,
  LEGACY_ROUNDING_METHODS,
  type RoundingBand,
  type RoundingBandProblem,
  type UserRoundingMethod,
  isValidMonthDay,
  isWellFormedBands,
  // 6e9a126e — the band ceiling and the shared write-time band validator, so core/admin.ts and
  // core/entitlement-template.ts hold ONE definition between them instead of a literal each.
  MAX_SERVICE_BANDS,
  validateServiceBands,
  lastRealDayOfMonth,
  parseCarryExpiry,
  DEFAULT_ROUNDING_THRESHOLD,
  ENGINE_ROUNDING_METHODS,
  resolveRoundingThreshold,
  roundingThresholdRanges,
  type AccrualConfig,
  type EngineRoundingMethod,
  type CarryExpiry,
  type LeaveRoundingMethod,
  type LeaveTypeRules,
  type ResolvedPolicy,
  type ServiceBand,
};
import {
  assignment,
  attendancePolicy,
  businessUnit,
  company,
  department,
  employment,
  // feedback cf9dcb98 — read ONLY on the empty-preview path, to answer "when does this type's entitlement
  // table actually start" with the date rather than with silence. Never on a path that produces figures.
  entitlementTemplate,
  gradeGroupMember,
  jobGrade,
  leaveApprovalStep,
  leaveCancellationRequest,
  leaveEncashmentSnapshot,
  leaveEntitlementRecalcAudit,
  leaveLedger,
  leaveRequest,
  leaveRequestAttachment,
  leaveRequestDate,
  leaveType,
  payrollBatch,
  // 5206539f — the (key, role) override rows behind `leave.apply_on_behalf`. Its table name says "payroll"
  // for historical reasons only; see the note in lib/payroll-permissions.ts.
  payrollPermissionGrant,
  payslip,
  person,
  reportingLine,
  leaveSharedGroup,
  leaveSharedGroupMember,
} from '../db/schema';

/** ADR-0069: the set of "employmentId|leaveTypeId" keys with an ACTIVE frozen encashment snapshot, for the
 *  year-boundary sweeps (openLeaveYear, accrueEarnedLeave, expireCarriedLeave) to skip — the ad-hoc/festive
 *  grant was a fourth until 38f1fd40 retired it; any future grant path must join this skip list —
 *  the DB trigger would reject the write anyway; skipping here avoids aborting the whole batch on one
 *  frozen employee. Read-only, no events.append (CLAUDE.md skip rule). */
/** 491c499f — the same set, exported for core/leave-adjustment.ts. Re-implementing it there would give the
 *  bulk-adjustment writer a second opinion about which balances are frozen, and two opinions about an
 *  ADR-0069 freeze is how a paid-out figure gets written through. One definition, two callers. */
export async function frozenAdjustmentKeys(tx: Tx, empIds: string[], typeIds: string[]): Promise<Set<string>> {
  return frozenSnapshotKeySet(tx, empIds, typeIds);
}

async function frozenSnapshotKeySet(tx: Tx, empIds: string[], typeIds: string[]): Promise<Set<string>> {
  if (empIds.length === 0 || typeIds.length === 0) return new Set();
  const rows = await tx
    .select({ employmentId: leaveEncashmentSnapshot.employmentId, leaveTypeId: leaveEncashmentSnapshot.leaveTypeId })
    .from(leaveEncashmentSnapshot)
    .where(
      and(
        inArray(leaveEncashmentSnapshot.employmentId, empIds),
        inArray(leaveEncashmentSnapshot.leaveTypeId, typeIds),
        eq(leaveEncashmentSnapshot.status, 'frozen'),
      ),
    );
  return new Set(rows.map((r) => `${r.employmentId}|${r.leaveTypeId}`));
}

/** The engine default working-day roster (ISO weekday 1=Mon … 7=Sun) — Mon–Fri. Mirrors core/attendance.ts
 *  DEFAULTS.workingDays so leave classifies rest days the same way attendance does (audit H#3). */
const DEFAULT_WORKING_DAYS_ISO = [1, 2, 3, 4, 5];

export class InsufficientLeaveBalanceError extends Error {
  constructor() {
    super('Leave rejected: insufficient balance');
    this.name = 'InsufficientLeaveBalanceError';
  }
}

// Configurable Negative Leave Balance Validation (0ef0defd): the SUBMIT/EDIT-time balance guard — thrown by
// requestLeave + editLeaveRequest when the leave type has allow_negative_balance=false and the requested days
// exceed the employee's available balance (ledger sum MINUS other pending requests of the same type). Distinct
// from InsufficientLeaveBalanceError (the pre-existing APPROVAL-time guard) so the two surfaces localize to
// their own messages; this one maps to the reporter's requested wording (leave.errors.insufficientBalance).
export class InsufficientLeaveBalanceOnSubmitError extends Error {
  constructor() {
    super('Insufficient leave balance for this application');
    this.name = 'InsufficientLeaveBalanceOnSubmitError';
  }
}

/**
 * 6aee1d91 — WHY IS THIS BALANCE ZERO? Asked ONLY after the refusal above has already been thrown.
 *
 * A bare "Insufficient leave balance" collapses three situations an employee cannot tell apart, and only
 * one of them is theirs to fix by applying for fewer days:
 *   - `covered`   — a benefit scheme (or a sole table) reaches them and the days are genuinely spent;
 *   - `no_scheme` — the leave type HAS entitlement tables and NO benefit scheme in force covers this
 *                   employee, so nothing was ever granted (r209's "second zero");
 *   - `no_table`  — the leave type has no entitlement table at all, so there was never a number to grant.
 *
 * 76ffdcf2 adds the fourth, and it is NOT a fourth refusal reason — it is the state that USED to be
 * `no_scheme` and is now a normal, covered employee:
 *   - `covered_by_default` — no benefit scheme reaches them, and the leave type's DEFAULT entitlement
 *                   table does. Days WERE granted from a table a human named, so the remedy is the same
 *                   as `covered` (the days are spent) and the refusal sentence is the plain one. It is
 *                   reported separately only so a screen can say WHICH table answered.
 *
 * This is a READ AFTER THE DECISION, not part of it: the refusal in `requestLeave` / `editLeaveRequest`
 * is unchanged, and this function cannot make an application succeed or fail. It asks the ONE batched
 * matcher the engines use (`buildTemplateEntitlementResolver`) for the pair and reads `hasTemplatesFor`
 * and `winnerFor` — the same two facts core/read.ts separates the two zeroes with. No second matcher
 * (core/entitlement-template.ts header).
 *
 * Measured on the RESOLVED BALANCE SOURCE (cdf9ca48), for the same reason `availableLeaveBalance` is: a
 * type that spends another type's balance was refused over THAT balance, and telling the employee their
 * own type "has no entitlement table" would send HR to create one nobody would ever spend.
 */
export type EntitlementCoverage = 'covered' | 'covered_by_default' | 'no_scheme' | 'no_table';

export async function entitlementCoverageFor(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string; asOf: string },
): Promise<EntitlementCoverage> {
  return withTenant(ctx, async (tx) => {
    const sourceTypeId = await resolveBalanceSourceTypeId(tx, p.leaveTypeId);
    const resolver = await buildTemplateEntitlementResolver(tx, {
      employmentIds: [p.employmentId],
      leaveTypeIds: [sourceTypeId],
      asOf: p.asOf,
    });
    if (!resolver.hasTemplatesFor(sourceTypeId)) return 'no_table';
    const won = resolver.winnerFor(p.employmentId, sourceTypeId);
    if (!won) return 'no_scheme';
    // 76ffdcf2 — a default-table answer IS coverage. Reported under its own name so the profile card can
    // say which table answered; every refusal path treats it exactly as `covered`.
    return won.viaDefaultTemplate ? 'covered_by_default' : 'covered';
  });
}

/**
 * Maximum Negative Balance (feedback bc512dc3, migration 0352) — the type permits a negative balance, but
 * this application would take the employee past the configured floor.
 *
 * DISTINCT FROM InsufficientLeaveBalanceOnSubmitError, which means "you may not go negative at all". These
 * are different refusals with different remedies: one says the answer is never yes, the other says the
 * answer is yes for a smaller number of days. Collapsing them into one error is how an employee ends up
 * asking HR what the number is.
 *
 * CARRIES THE FIGURES, and that is the requirement rather than a nicety — the reporter's plan says the
 * message must state the limit and how far past it the request goes. A bare "insufficient balance" is
 * exactly what sends someone to HR.
 */
export class NegativeLeaveBalanceLimitExceededError extends Error {
  readonly leaveTypeName: string;
  /** The configured floor as a POSITIVE magnitude — 2.5 means the balance may not pass -2.5. */
  readonly maxNegativeBalance: number;
  /** Balance available before this application. May itself already be negative. */
  readonly availableDays: number;
  readonly requestedDays: number;
  /** Where the balance would land: availableDays - requestedDays, always negative when this throws. */
  readonly resultingBalance: number;
  /** How far past the floor, positive. resultingBalance = -(maxNegativeBalance + overshootDays). */
  readonly overshootDays: number;
  constructor(p: {
    leaveTypeName: string;
    maxNegativeBalance: number;
    availableDays: number;
    requestedDays: number;
  }) {
    const resultingBalance = Math.round((p.availableDays - p.requestedDays) * 100) / 100;
    const overshootDays = Math.round((-resultingBalance - p.maxNegativeBalance) * 100) / 100;
    super(
      `Leave type "${p.leaveTypeName}" may not go further negative than ${p.maxNegativeBalance} days; ` +
        `this application would leave a balance of ${resultingBalance}, ${overshootDays} past the limit`,
    );
    this.name = 'NegativeLeaveBalanceLimitExceededError';
    this.leaveTypeName = p.leaveTypeName;
    this.maxNegativeBalance = p.maxNegativeBalance;
    this.availableDays = p.availableDays;
    this.requestedDays = p.requestedDays;
    this.resultingBalance = resultingBalance;
    this.overshootDays = overshootDays;
  }
}

// Combined Leave Type Limit (R44 4c48fd1f, Stage 2): the requested leave type belongs to a benefit-scheme
// combined-limit pool (e.g. "Compassionate + Marriage + Paternity = 5 days/year") and this application would
// push the employee's per-cycle usage ACROSS ALL pooled types over the shared total. Carries the pool name +
// total for a readable, re-localizable error. Fires for admins too — it's a data cap, like the balance gate.
export class CombinedLeaveLimitExceededError extends Error {
  readonly poolName: string;
  readonly totalLimitDays: number;
  constructor(poolName: string, totalLimitDays: number) {
    super(`Combined leave limit "${poolName}" (${totalLimitDays} days) would be exceeded`);
    this.name = 'CombinedLeaveLimitExceededError';
    this.poolName = poolName;
    this.totalLimitDays = totalLimitDays;
  }
}

// Shared Leave Group per-application cap (r82a 1ef1cf95, migration 0327): the requested leave type belongs
// to a group that sets max_days_per_application, and THIS ONE APPLICATION spans more days than the group
// allows — "no single application may exceed 3 days, whichever of the seven types is chosen".
//
// A DIFFERENT REFUSAL FROM CombinedLeaveLimitExceededError, deliberately so. That one means "the year's
// shared pool is spent"; this one means "this application is too long", and it fires even with the whole
// pool untouched. An employee told the wrong one would change the wrong thing about their application — so
// the two carry their own names, their own payloads and their own localized messages, and the group cap is
// checked FIRST (it is a property of the application alone, independent of any history).
//
// The request is REFUSED, never silently shortened: truncating somebody's leave to fit a cap would approve
// dates they did not ask for and leave the rest unrequested.
export class CombinedLeaveApplicationTooLongError extends Error {
  readonly poolName: string;
  readonly maxDaysPerApplication: number;
  /** The span the refused application actually covered, in the units applicationSpanDays() measures. */
  readonly requestedSpanDays: number;
  constructor(poolName: string, maxDaysPerApplication: number, requestedSpanDays: number) {
    super(
      `Shared leave group "${poolName}" allows at most ${maxDaysPerApplication} days per application; this one covers ${requestedSpanDays}`,
    );
    this.name = 'CombinedLeaveApplicationTooLongError';
    this.poolName = poolName;
    this.maxDaysPerApplication = maxDaysPerApplication;
    this.requestedSpanDays = requestedSpanDays;
  }
}

/** Maximum Consecutive Leave (c6ffa725 rev 2, migration 0343) — the UNIT a per-application cap is read in.
 *
 *  'calendar_days' counts every day the application SPANS (weekends and public holidays included);
 *  'working_days' counts only the days it actually CHARGES as leave. A Friday→Monday application is 4 of
 *  the first and 2 of the second. Stored as TEXT + CHECK rather than a pgEnum (the 0338 lesson) and given
 *  its reading in exactly one function, applicationSpanDays(). */
export type ConsecutiveLeaveUnit = 'calendar_days' | 'working_days';

/** One candidate per-application length limit, already measured against the application in its own unit.
 *  The input shape of bindingApplicationLengthLimit — see that function for the composition rule. */
export type ApplicationLengthLimit = {
  /** Which configuration the limit came from — the narrower scope wins a tie. */
  scope: 'leave_type' | 'shared_group';
  /** The leave type's name, or the shared group's — whatever the refusal must NAME. */
  name: string;
  cap: number;
  unit: ConsecutiveLeaveUnit;
  /** The application measured in `unit` (applicationSpanDays). */
  measured: number;
};

// Maximum Consecutive Leave (feedback c6ffa725 revision 2, migration 0343): this LEAVE TYPE sets a maximum
// length for a single application — the reporter's "how much in one go", as against
// max_days_per_leave_year's "how much in a year" — and this application is longer than it allows.
//
// A FOURTH, DISTINCT REFUSAL, and specifically NOT CombinedLeaveApplicationTooLongError. That one names a
// SHARED LEAVE GROUP and the administrator fixes it on the group; this one names a LEAVE TYPE and is fixed
// on the type. They can both be configured at once — see bindingApplicationLengthLimit, which decides which
// one binds — so an employee handed the wrong one would go and change a rule that was not refusing them.
// Asserted by class AND payload, and `not.toBeInstanceOf` its neighbours, per this area's convention: a
// bare rejects.toThrow() passes on any throw and this repo has been bitten by that.
//
// It carries the UNIT because the number alone is ambiguous: "at most 3 days, this one covers 4" reads as a
// mistake to an employee who counted 2 working days. The localized message says which reading was used.
//
// The request is REFUSED, never silently shortened — the same rule both caps beside it follow. Clipping an
// application to fit would approve dates the employee did not ask for and leave the rest unrequested.
export class LeaveTypeApplicationTooLongError extends Error {
  readonly leaveTypeName: string;
  readonly maxConsecutiveDays: number;
  readonly unit: ConsecutiveLeaveUnit;
  /** The refused application measured in `unit` — the figure the employee must bring under the cap. */
  readonly requestedSpanDays: number;
  constructor(p: {
    leaveTypeName: string;
    maxConsecutiveDays: number;
    unit: ConsecutiveLeaveUnit;
    requestedSpanDays: number;
  }) {
    super(
      `Leave type "${p.leaveTypeName}" allows at most ${p.maxConsecutiveDays} consecutive ${p.unit === 'working_days' ? 'working' : 'calendar'} days per application; this one covers ${p.requestedSpanDays}`,
    );
    this.name = 'LeaveTypeApplicationTooLongError';
    this.leaveTypeName = p.leaveTypeName;
    this.maxConsecutiveDays = p.maxConsecutiveDays;
    this.unit = p.unit;
    this.requestedSpanDays = p.requestedSpanDays;
  }
}

// Application Limits (feedback c6ffa725, migration 0335): this leave TYPE sets a maximum number of days an
// employee may apply for within one leave year, and this application would push them past it.
//
// A THIRD, DISTINCT REFUSAL — deliberately not merged into either combined-pool error above. Those two are
// properties of a SHARED POOL configured on a benefit scheme and they name the pool; this one is a property
// of ONE leave type and names the type. An employee told "the shared pool is spent" when what is actually
// full is Unpaid Leave's own annual ceiling would go and look at the wrong configuration. The three carry
// their own names, their own payloads and their own localized messages
// (test/leave-application-limit.test.ts asserts each by class AND payload, and `not.toBeInstanceOf` its
// neighbours — a bare rejects.toThrow() passes on any throw, and this repo has been bitten by that twice).
//
// The reason it exists at all is that entitlement and application eligibility were tightly coupled: every
// cap on how much leave may be taken worked by checking a BALANCE, and the reporter's cases (Unpaid Leave,
// Prolonged Illness Leave) have no balance by design. Their Leave Summary must keep reading 0 available.
//
// The request is REFUSED, never silently shortened — the same rule the shared-group cap follows. Clipping an
// application to the remaining allowance would approve dates the employee did not ask for.
export class LeaveYearApplicationLimitExceededError extends Error {
  readonly leaveTypeName: string;
  readonly maxDaysPerLeaveYear: number;
  /** Days of this type already applied for (pending + approved) inside the same leave year. */
  readonly usedDays: number;
  /** Days this application would add. */
  readonly requestedDays: number;
  /** The leave-year window the usage was measured over, ISO yyyy-mm-dd, inclusive of both ends. Carried so
   *  an operator reading the error can tell WHICH year filled up — an anniversary-cycle type's year is not
   *  the calendar year, and "you have used 14 of 14 days" is unanswerable without it. */
  readonly yearStart: string;
  readonly yearEnd: string;
  /** ad9cb5c5 — WHICH period filled up. Carried because the refusal is otherwise ambiguous the moment more
   *  than one period is configurable: "you have used 1 of 1" reads identically for a once-per-employment
   *  limit and a once-per-year one, and only one of those is worth waiting until January for. Absent ⇒
   *  'leave_year', so an error constructed by older code still describes itself correctly. */
  readonly period: ApplicationLimitPeriod;
  constructor(p: {
    leaveTypeName: string;
    maxDaysPerLeaveYear: number;
    usedDays: number;
    requestedDays: number;
    yearStart: string;
    yearEnd: string;
    period?: ApplicationLimitPeriod;
  }) {
    const period = p.period ?? 'leave_year';
    const window =
      period === 'employment'
        ? 'per employment'
        : period === 'calendar_year'
          ? 'per calendar year'
          : 'per leave year';
    super(
      `Leave type "${p.leaveTypeName}" allows at most ${p.maxDaysPerLeaveYear} days ${window} (${p.yearStart}..${p.yearEnd}); ${p.usedDays} already applied for and this application adds ${p.requestedDays}`,
    );
    this.name = 'LeaveYearApplicationLimitExceededError';
    this.leaveTypeName = p.leaveTypeName;
    this.maxDaysPerLeaveYear = p.maxDaysPerLeaveYear;
    this.usedDays = p.usedDays;
    this.requestedDays = p.requestedDays;
    this.yearStart = p.yearStart;
    this.yearEnd = p.yearEnd;
    this.period = period;
  }
}

// Leave Year Configuration (9aa894a4, re-based by 4b0e76ae): a non-HR employee tried to apply for a leave
// year strictly later than the tenant-local current year. The reason used to be a lookup — no managed
// leave_year_config row for that year, a status other than 'open', or a date before its
// employeeApplicationStartDate — and is now the flat standing rule that replaced it. The ERROR, its `year`,
// its localiser and its message key are all unchanged, because the refusal HR's employees see is unchanged.
// Carries `year` so the action layer can re-localize via getTranslations('leave.errors') before redirecting
// with ?error=. HR admins (isAdmin) bypass this in requestLeave (the override path, stamped for audit), so
// it only throws for ordinary employees. Models InsufficientLeaveBalanceError (a plain typed rejection).
export class LeaveYearNotOpenError extends Error {
  readonly year: number;
  constructor(year: number) {
    super(`Leave year ${year} is not yet open for applications.`);
    this.name = 'LeaveYearNotOpenError';
    this.year = year;
  }
}

// ── Partial Leave Approval (0131) ────────────────────────────────────────────────────────────────────
// A manager may approve some dates and reject others within one multi-day request (the request is split at
// submission into per-working-date children sharing a parent_group_id — see the per_date_approval gate in
// requestLeave). Rejecting ANY date requires a reason, so the employee knows WHY that date was declined. This
// applies uniformly to the existing decideLeave path (single-day, half, hourly, and per-date child), so a
// blank reject reason is refused BEFORE any write — nothing is persisted.
export class MissingRejectReasonError extends Error {
  constructor() {
    super('A reason is required to reject a leave request');
    this.name = 'MissingRejectReasonError';
  }
}

/**
 * 5206539f — the caller tried to submit leave for SOMEBODY ELSE without holding `leave.apply_on_behalf`.
 *
 * TYPED, for the same reason LeaveCancellationNotAllowedError is: a refusal has to reach the employee in
 * their own language. The message below is the English fallback an unlocalized logger sees; the screen maps
 * the error NAME to leave.errors.applyOnBehalfNotAllowed (app/leave/actions.ts) rather than painting this
 * sentence onto the page.
 */
export class LeaveOnBehalfNotAllowedError extends Error {
  constructor() {
    super('You do not have permission to apply for leave on behalf of another employee.');
    this.name = 'LeaveOnBehalfNotAllowedError';
  }
}

// ── Partial Leave Cancellation (ADR-0065) ────────────────────────────────────────────────────────────
// After a leave is approved, the employee can give back a SUBSET of the approved dates. The gates below are
// hard service-layer rejections (typed so the UI can localize and so the affordance can be hidden, not just
// throw). None of these persist anything — they run BEFORE any write.
export class LeaveCancellationNotAllowedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Leave date(s) cannot be cancelled: ${reason}` : 'Leave date(s) cannot be cancelled.');
    this.name = 'LeaveCancellationNotAllowedError';
  }
}
/** A requested cancel date is on/before "today" (tenant working-day frame) — too late to give back. */
export class LeaveCancellationTooLateError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `Leave for ${date} can no longer be cancelled (it has started or passed).` : 'Leave can no longer be cancelled.');
    this.name = 'LeaveCancellationTooLateError';
    this.date = date;
  }
}
/** A requested cancel date is outside the request span, or is not a working day inside it. */
export class LeaveCancellationDateInvalidError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `${date} is not a cancellable working day in this leave.` : 'An invalid cancellation date was supplied.');
    this.name = 'LeaveCancellationDateInvalidError';
    this.date = date;
  }
}
/** A requested cancel date falls in a payroll period whose batch is already closed — the deduction was
 *  already taken and there is no reversal path, so the finalised payslip must not be retroactively altered. */
export class LeaveCancellationPeriodClosedError extends Error {
  readonly date?: string;
  constructor(date?: string) {
    super(date ? `${date} falls in a closed payroll period and can no longer be cancelled.` : 'A cancellation date falls in a closed payroll period.');
    this.name = 'LeaveCancellationPeriodClosedError';
    this.date = date;
  }
}

/** Edit-by-status self-service (item c9a19e34) — an employee tried to EDIT a leave that is not in an
 *  editable state (only a PENDING, plain single-request row is editable) or the new details fail re-validation.
 *  A distinct type from the cancellation errors so the action-layer localizer renders a clear "can't edit"
 *  message (the underlying validation errors — backdating, eligibility, etc. — keep their own typed errors). */
export class LeaveEditNotAllowedError extends Error {
  constructor(reason?: string) {
    super(reason ? `This leave cannot be edited: ${reason}` : 'This leave cannot be edited.');
    this.name = 'LeaveEditNotAllowedError';
  }
}

// ── Emergency-Leave unpaid consent (Phase-B #12, ADR-0061) ─────────────────────────────────────────
// An Emergency-Leave application whose paid balances (Annual, and Sick for illness) fall short would have
// the remainder taken as UNPAID (no-work-no-pay). That conversion is lawful only if the employee elects it,
// so requestEmergencyLeave throws this when the cascade would create an UNPAID child and unpaidConsent was
// not supplied — and persists nothing. The frontend surfaces the computed split + an acknowledgement
// checkbox so the consent is informed.
export class UnpaidConsentRequiredError extends Error {
  /** The unpaid days the employee must consent to (informational; the EL form shows the full split). */
  readonly unpaidDays?: number;
  constructor(unpaidDays?: number) {
    super(
      unpaidDays != null
        ? `This emergency leave would take ${unpaidDays} day(s) as unpaid leave. Your acknowledgement of the unpaid days is required.`
        : 'This emergency leave would take some days as unpaid leave. Your acknowledgement of the unpaid days is required.',
    );
    this.name = 'UnpaidConsentRequiredError';
    this.unpaidDays = unpaidDays;
  }
}

// ── Override Leave Application — the CONSENT GATE (feedback 56910869) ──────────────────────────────
//
// CONFIRMATION IS A SERVICE CONCERN, NOT ONLY A DIALOG. An override rule that CHANGES an application (it
// converts it to another leave type, or takes part of it unpaid) may not be applied unless the employee has
// explicitly agreed to that exact change — so this is thrown BEFORE anything is persisted, and a client that
// skips the confirmation simply cannot submit a silently-converted application. Exactly the
// UnpaidConsentRequiredError precedent above, generalised: consent names the RULE, not a bare boolean,
// because two different rules can fire on one application (convert on short notice AND split on
// insufficient balance) and consent to one is not consent to the other.
//
// Everything the confirmation needs to be INFORMED rides on the error: which rule, the leave type it came
// from, the one it is going to, and the day figures. The action layer localizes it; the form renders the
// pop-out and posts back the token(s).
export class LeaveOverrideConsentRequiredError extends Error {
  readonly trigger: LeaveOverrideTrigger;
  readonly action: LeaveOverrideAction;
  /** The token the client must post back to consent to THIS rule. */
  readonly consentToken: string;
  /** The type the employee applied for (the one the rule is configured on). */
  readonly fromTypeName?: string;
  /** Where a converting action sends it (absent for a split, which stays on the same type). */
  readonly toTypeName?: string;
  /** Advance-notice trigger: the notice actually given, and what the type requires. */
  readonly daysInAdvance?: number;
  readonly minAdvanceDays?: number | null;
  /** Insufficient-balance trigger: how the application would be split. */
  readonly paidDays?: number;
  readonly unpaidDays?: number;
  constructor(
    trigger: LeaveOverrideTrigger,
    action: LeaveOverrideAction,
    detail: {
      fromTypeName?: string;
      toTypeName?: string;
      daysInAdvance?: number;
      minAdvanceDays?: number | null;
      paidDays?: number;
      unpaidDays?: number;
    } = {},
  ) {
    super(
      action === 'convert_to_emergency'
        ? `This application does not meet the notice period and would be submitted as ${detail.toTypeName ?? 'Emergency Leave'} instead. Your confirmation is required.`
        : `Your balance does not cover this application; ${detail.unpaidDays ?? 0} day(s) would be taken as unpaid leave. Your confirmation is required.`,
    );
    this.name = 'LeaveOverrideConsentRequiredError';
    this.trigger = trigger;
    this.action = action;
    this.consentToken = leaveOverrideConsentToken(trigger, action);
    this.fromTypeName = detail.fromTypeName;
    this.toTypeName = detail.toTypeName;
    this.daysInAdvance = detail.daysInAdvance;
    this.minAdvanceDays = detail.minAdvanceDays;
    this.paidDays = detail.paidDays;
    this.unpaidDays = detail.unpaidDays;
  }
}

/** Override Leave Application: a `convert_to_emergency` rule is enabled but the tenant has no Emergency
 *  Leave type to convert TO. Refusing loudly is the only safe answer — quietly falling back to the ordinary
 *  refusal would leave HR looking at a rule that is on and doing nothing, which is the config-trap this
 *  panel goes out of its way to avoid elsewhere (the hidden backdating / advance-notice fields for EL). */
export class LeaveOverrideTargetMissingError extends Error {
  constructor(targetCode: string) {
    super(`This leave type's override rule converts to ${targetCode}, but no such leave type is configured.`);
    this.name = 'LeaveOverrideTargetMissingError';
  }
}

// Reason category for an Emergency-Leave application (Phase-B #12). 'illness' routes the cascade through the
// employee's paid SICK balance first (EA s.60F) before Annual/Unpaid; 'personal'/'other' keep Annual→Unpaid.
export type EmergencyReasonCategory = 'illness' | 'personal' | 'other';
export const EMERGENCY_REASON_CATEGORIES: readonly EmergencyReasonCategory[] = [
  'illness',
  'personal',
  'other',
] as const;
export function isEmergencyReasonCategory(v: unknown): v is EmergencyReasonCategory {
  return typeof v === 'string' && (EMERGENCY_REASON_CATEGORIES as readonly string[]).includes(v);
}

// ── Duration types (ADR-0048) ──────────────────────────────────────────────────────────────────────
// A request can be a full day, a half-day (AM or PM), or a number of hours. The deduction is full=1,
// half=0.5, hourly = round(hours / DEFAULT_STANDARD_HOURS, 2). The denominator "hours in a workday" is a
// company-wide constant (matches core/toil.ts STD_DAY_MINUTES = 480 = 8h), not a per-type column.
export type LeaveDurationType = 'full_day' | 'half_day_am' | 'half_day_pm' | 'hourly';
export const LEAVE_DURATION_TYPES: readonly LeaveDurationType[] = [
  'full_day',
  'half_day_am',
  'half_day_pm',
  'hourly',
] as const;
export const DEFAULT_STANDARD_HOURS = 8;
export function isLeaveDurationType(v: unknown): v is LeaveDurationType {
  return typeof v === 'string' && (LEAVE_DURATION_TYPES as readonly string[]).includes(v);
}

// ── Hourly-leave time window (0129) ────────────────────────────────────────────────────────────────
// For a duration_type='hourly' request the applicant picks a From/To time; the deducted `hours` is derived
// from the elapsed span, not typed by hand. Thrown when the window is malformed (missing, or to <= from).
export class HourlyLeaveTimeRangeError extends Error {
  constructor(message = 'Hourly leave requires a From time and a To time, and To must be after From') {
    super(message);
    this.name = 'HourlyLeaveTimeRangeError';
  }
}

/**
 * Elapsed hours between two HH:MM (or HH:MM:SS) times, rounded to 2 dp. Pure + DB-free + unit-testable.
 *
 * Seconds-format hazard: a Postgres `time` column reads back as 'HH:MM:SS', while an <input type="time">
 * emits 'HH:MM'. Both inputs are normalized to 'HH:MM' first (slice(0, 5)) so a stored '09:00:00' parses
 * identically to a form '09:00'. Throws HourlyLeaveTimeRangeError when either input is empty or the span is
 * <= 0. The window is ELAPSED wall time (09:00–18:00 = 9h including a lunch break), NOT a net-work figure —
 * so callers must NOT cap it at DEFAULT_STANDARD_HOURS (see the hourly branch of requestLeave).
 */
export function hoursBetween(fromTime: string, toTime: string): number {
  const toMinutes = (s: string): number => {
    const hhmm = (s ?? '').slice(0, 5);
    const [h, m] = hhmm.split(':').map((x) => Number(x));
    if (!Number.isFinite(h) || !Number.isFinite(m)) throw new HourlyLeaveTimeRangeError();
    return h * 60 + m;
  };
  if (!fromTime || !toTime) throw new HourlyLeaveTimeRangeError();
  const span = toMinutes(toTime) - toMinutes(fromTime);
  if (span <= 0) throw new HourlyLeaveTimeRangeError();
  return Math.round((span / 60) * 100) / 100;
}

export class LeaveDurationNotAllowedError extends Error {
  constructor() {
    super('This leave type does not allow the selected duration (full day / half day / hourly)');
    this.name = 'LeaveDurationNotAllowedError';
  }
}

// ── Eligibility (ADR-0038 2A-1, #25) ──────────────────────────────────────────────────────────────
// A lawful gate that mirrors what the Act restricts (maternity female-only EA s.37; paternity married-
// male ≥12mo EA s.60FA). It NEVER blocks a statutory entitlement — types with no restriction carry no
// eligibility, so everyone can request them.
// gender / maritalStatus accept EITHER a scalar (legacy rows written before multi-select, #badc5966) OR an
// array (multi-select: qualify if the employee matches ANY selected value). Reads normalize via asList() so
// no backfill/migration is needed — a pre-existing scalar row behaves exactly as before.
export type LeaveEligibility = {
  gender?: string | string[];
  maritalStatus?: string | string[];
  minServiceMonths?: number;
  // Min-service unit (#f88f0a63): the number in minServiceMonths is measured in this unit — 'months' (whole
  // completed months, the legacy behaviour) or 'days' (elapsed whole days). ABSENT ⇒ 'months', so every row
  // written before this field existed keeps its exact old meaning without a migration/backfill. Only carried
  // when a positive minServiceMonths survives cleaning (a lone unit is never stored).
  minServiceUnit?: 'months' | 'days';
  // Probation eligibility (d6bdbd55): whether the type is restricted by the employee's probation status.
  // 'confirmed_only' ⇒ only employees past probation may apply; 'probation_only' ⇒ only employees still on
  // probation may apply; ABSENT/undefined ⇒ no restriction. Stored in leave_type.probation_eligibility (its
  // own column, migration 0225) and merged into this object at the enforcement chokepoints so it rides the
  // same assertEligible / isLeaveEligible gate as the other rules.
  probation?: 'confirmed_only' | 'probation_only';
  // Organisation Assignment criteria (Enhance Leave Criteria Configuration): the eight catalogue-backed org
  // fields, each keyed by its `employment` column name (see ORG_ASSIGNMENT_CRITERIA in core/leave-org-criteria).
  // Each accepts a scalar (legacy shape) OR an array (multi-select, match-ANY) exactly like gender/marital, so
  // asList() normalizes both without a migration. ABSENT key ⇒ no restriction, so every existing stored row is
  // unchanged and existing saved conditions keep working.
  orgDivision?: string | string[];
  orgBranch?: string | string[];
  orgRegion?: string | string[];
  orgLine?: string | string[];
  orgSection?: string | string[];
  orgTeam?: string | string[];
  orgBase?: string | string[];
  employmentCategory?: string | string[];
};

/** The closed set of probation eligibility values (mirrors the DB CHECK on leave_type.probation_eligibility). */
export const PROBATION_ELIGIBILITY_VALUES = ['confirmed_only', 'probation_only'] as const;
export type ProbationEligibility = (typeof PROBATION_ELIGIBILITY_VALUES)[number];

/** Elapsed service in a rule's chosen unit, from an employee's hire date to `asOf`. unit==='days' counts
 *  whole elapsed days (daysBetween); anything else — including an absent unit on a legacy row — counts whole
 *  completed months (monthsBetween). Central so assertEligible + isLeaveEligible resolve service identically. */
function servedFor(unit: LeaveEligibility['minServiceUnit'], hiredOn: string, asOf: string): number {
  return unit === 'days' ? daysBetween(hiredOn, asOf) : monthsBetween(hiredOn, asOf);
}

/** Normalize a scalar-or-array eligibility field to a de-blanked list. null/undefined → []; scalar → [scalar];
 *  array → itself (blanks dropped). Used at every chokepoint so legacy scalar rows and new array rows match
 *  identically without a data migration. */
export function asList(v: string | string[] | null | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== '');
}

// ── Day Type Inclusion (feedback ef6d7146) ───────────────────────────────────────────────────────
// A per-leave-type vector of five INDEPENDENT booleans deciding whether each day type is COUNTED when
// calculating a leave's duration. It REFINES leave_type.counting: a calendar_days type already counts every
// day (the vector is moot); a working_days type today skips weekends/rest days AND public holidays, and this
// vector lets it selectively RE-INCLUDE specific day types (e.g. "skip weekends but DO count public
// holidays" — impossible before). Persisted as leave_type.day_type_inclusion JSONB.
export type DayTypeInclusion = {
  offDay: boolean;
  restDay: boolean;
  publicHoliday: boolean;
  companyHoliday: boolean;
  shutdownDay: boolean;
};
/** The closed camelCase allow-list of day-type keys (the order the admin UI renders them). */
export const DAY_TYPE_INCLUSION_KEYS = [
  'offDay',
  'restDay',
  'publicHoliday',
  'companyHoliday',
  'shutdownDay',
] as const;

/** Normalize a stored day_type_inclusion JSONB to a strict DayTypeInclusion, or `undefined` when it should
 *  be treated as INERT — i.e. take the byte-identical legacy counting path. `undefined` is returned for:
 *  a null/non-object column (every existing row), AND an all-false vector (which is exactly today's
 *  working_days behaviour, so nothing re-includes). Any non-boolean/absent key coerces to false. This is the
 *  single guard that guarantees old data + all-off config count identically to before the feature. */
export function normalizeDayTypeInclusion(v: unknown): DayTypeInclusion | undefined {
  if (v == null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const r: DayTypeInclusion = {
    offDay: o.offDay === true,
    restDay: o.restDay === true,
    publicHoliday: o.publicHoliday === true,
    companyHoliday: o.companyHoliday === true,
    shutdownDay: o.shutdownDay === true,
  };
  if (!r.offDay && !r.restDay && !r.publicHoliday && !r.companyHoliday && !r.shutdownDay) return undefined;
  return r;
}

export class LeaveIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveIneligibleError';
  }
}

// Leave Type Employee Visibility (feedback 7b11f1c1): thrown by requestLeave when the leave type has
// employee_can_apply === false and the caller is an ordinary employee. This is the SERVER-SIDE authority for
// the "can look but can't apply" switch — defense-in-depth behind the apply-dropdown filter, so the rule
// holds even if the UI is bypassed. HR admins (isAdmin) bypass it via the existing override path (like
// backdating / min-advance), so HR can still book this leave on an employee's behalf. Carries the (localized)
// leave-type name so the action layer can re-localize via getTranslations('leave.errors') before redirecting.
export class LeaveApplyNotAllowedError extends Error {
  readonly typeName?: string;
  constructor(typeName?: string) {
    super(`Employees cannot apply for ${typeName ?? 'this leave type'}. Please contact HR.`);
    this.name = 'LeaveApplyNotAllowedError';
    this.typeName = typeName;
  }
}

// Leave Type Employee Visibility (feedback 7b11f1c1): the closed set of leave-type codes that carry a
// Malaysian statutory entitlement an employee must always be able to exercise — Annual & Sick (EA 1955
// s.60E / s.60F), Hospitalization (s.60F), Maternity (s.37), Paternity (s.60FA). updateLeaveType refuses to
// set employee_can_apply=false on any of these so a well-meant configuration can never deny a lawful
// entitlement. visible_to_employee=false is NOT blocked on these (HR can still grant the leave directly), but
// closing off the ability to APPLY would breach the statutory right.
export const STATUTORY_APPLY_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION', 'MATERNITY', 'PATERNITY'] as const;

// ── Mandatory documents (ADR-0038 2A-2, #25) ─────────────────────────────────────────────────────
// Some leave types need a supporting document (e.g. an MC for sick leave). When leave_type.requires_
// document is set, requestLeave rejects a request that arrives without an attachment.
//
// Supporting-document config: these errors carry STRUCTURED fields (typeName, afterDays, ...) so the
// action layer can re-localize via getTranslations('leave.errors') before redirecting with ?error=.
// The English `message` stays as a fallback for tests/logs.
export class LeaveDocumentRequiredError extends Error {
  /** The (localized) leave-type name and, when the rule is conditioned on duration, the threshold. */
  readonly typeName?: string;
  readonly afterDays?: number;
  constructor(typeName?: string, afterDays?: number) {
    super(
      afterDays != null
        ? `A supporting document is required for ${typeName ?? 'this leave type'} exceeding ${afterDays} days.`
        : `A supporting document is required for ${typeName ?? 'this leave type'} (e.g. a medical certificate).`,
    );
    this.name = 'LeaveDocumentRequiredError';
    this.typeName = typeName;
    this.afterDays = afterDays;
  }
}

// Configurable backdated-leave restriction (0133): a non-HR request whose start date is older than the
// leave type's backdatingLimitDays window. Carries STRUCTURED fields (typeName, limitDays) so the action
// layer can re-localize via getTranslations('leave.errors') before redirecting with ?error=. HR admins
// (isAdmin) bypass this in requestLeave (the override path), so this only throws for ordinary employees.
export class LeaveBackdatingNotAllowedError extends Error {
  readonly typeName?: string;
  readonly limitDays: number;
  // Custom validation messages (custom-messages migration): when the leave type has an admin-authored
  // customMessages.backdatingLimitDays override, it is passed here and used VERBATIM as the Error message
  // instead of the interpolated default. The action-layer localizer (localizeLeaveError) detects a present
  // customMessage and renders it as-is — it does NOT re-localize or interpolate an admin-authored string.
  // Absent ⇒ the built-in localized default is shown (existing behaviour).
  readonly customMessage?: string;
  constructor(limitDays: number, typeName?: string, customMessage?: string) {
    super(customMessage ?? `${typeName ?? 'This leave type'} cannot be backdated more than ${limitDays} day(s).`);
    this.name = 'LeaveBackdatingNotAllowedError';
    this.typeName = typeName;
    this.limitDays = limitDays;
    this.customMessage = customMessage;
  }
}

// Minimum advance-notice rule (0159 / feedback 0b0fb6c3): a non-HR request submitted with less notice than
// the leave type's minAdvanceDays requires ("Annual Leave must be submitted at least 7 days before the leave
// start date"). Carries STRUCTURED fields (typeName, minDays) so the action layer can re-localize via
// getTranslations('leave.errors') before redirecting with ?error=. HR admins (isAdmin) bypass this in
// requestLeave (the override path, stamped for audit), so this only throws for ordinary employees. Mirrors
// LeaveBackdatingNotAllowedError above end-to-end.
export class LeaveAdvanceNoticeRequiredError extends Error {
  readonly typeName?: string;
  readonly minDays: number;
  // Custom validation messages (0147): when the leave type has an admin-authored customMessages.minAdvanceDays
  // override, it is passed here and used VERBATIM as the Error message instead of the interpolated default.
  // The action-layer localizer (localizeLeaveError) detects a present customMessage and renders it as-is —
  // it does NOT re-localize or interpolate an admin-authored string. Absent ⇒ the built-in localized default.
  readonly customMessage?: string;
  // Advance Notice — calendar days or working days (7daac043): WHICH READING refused this application, so
  // the localizer can say "7 working day(s)" rather than "7 day(s)" and the employee is not left counting
  // the wrong kind of day. Defaults to 'calendar_days' — the reading every leave type had before 0447 and
  // still has unless an administrator changed it — so a caller that omits it gets today's message exactly.
  // A CUSTOM message still wins over both: an admin-authored string is rendered verbatim, never re-worded.
  readonly dayType: AdvanceNoticeDayType;
  constructor(
    minDays: number,
    typeName?: string,
    customMessage?: string,
    dayType: AdvanceNoticeDayType = 'calendar_days',
  ) {
    super(
      customMessage ??
        `${typeName ?? 'This leave type'} must be submitted at least ${minDays} ${
          dayType === 'working_days' ? 'working ' : ''
        }day(s) before the leave start date.`,
    );
    this.name = 'LeaveAdvanceNoticeRequiredError';
    this.typeName = typeName;
    this.minDays = minDays;
    this.customMessage = customMessage;
    this.dayType = dayType;
  }
}

// R5 Build #3 (backdating diagnose-first): a request that resolves to zero leave days — the range is empty
// (end before start) or every day in it is a non-working day (weekend/holiday) for a working_days type. This
// fires for admins AND ordinary employees, and is a common outcome of a BACKDATED single-day request that
// happens to land on a weekend/holiday. Previously thrown as a raw English `Error`, so a non-English-locale
// user (or an HR admin filing a backdated leave for someone) saw untranslated technical text via the
// localizeLeaveError fallback. Typed here so the action layer re-localizes it into the viewer's language.
export class LeaveNoDaysInRangeError extends Error {
  constructor() {
    super('No leave days in range (end before start, or all non-working)');
    this.name = 'LeaveNoDaysInRangeError';
  }
}

// Duplicate Leave Application Restriction (feedback d5e51c34): the leave type's duplicate_application_policy
// ('restrict_same' | 'restrict_any') blocked this submission/edit because a pending/approved application
// already overlaps the requested date range. Fires for BOTH ordinary employees and HR admins (double-booking
// is a data-integrity rule, not a permission the admin overrides). Typed so the action layer re-localizes it
// into the viewer's language via localizeLeaveError; the message text matches the reporter's requested copy.
export class DuplicateLeaveApplicationError extends Error {
  constructor() {
    super(
      'A leave application already exists for the selected date. Multiple leave applications on the same date are not allowed.',
    );
    this.name = 'DuplicateLeaveApplicationError';
  }
}


// Supporting-document config: the applicant must supply a remark when the type sets employeeRemarkRequired.
export class LeaveRemarkRequiredError extends Error {
  readonly typeName?: string;
  constructor(typeName?: string) {
    super(`An employee remark is required for ${typeName ?? 'this leave type'}.`);
    this.name = 'LeaveRemarkRequiredError';
    this.typeName = typeName;
  }
}

// Supporting-document config: file type / size validation. Thrown at the /me action boundary BEFORE
// requestLeave commits (so a bad file never leaves an orphan pending request), and again as defence-in-
// depth inside addLeaveAttachment for any other caller.
const DOC_MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
};
export class LeaveDocumentTypeError extends Error {
  readonly allowed: string[];
  constructor(allowed: string[]) {
    const labels = allowed.map((m) => DOC_MIME_LABELS[m] ?? m).join(', ');
    super(`File type not allowed — accepted: ${labels}`);
    this.name = 'LeaveDocumentTypeError';
    this.allowed = allowed;
  }
}
export class LeaveDocumentSizeError extends Error {
  readonly maxMb: number;
  constructor(maxBytes: number) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    super(`File exceeds the ${maxMb} MB limit`);
    this.name = 'LeaveDocumentSizeError';
    this.maxMb = maxMb;
  }
}

/** A type's supporting-document rule, as needed by the pure validator. */
export type LeaveDocumentRule = { allowedMimeTypes?: string[] | null; maxDocBytes?: number | null };

/**
 * Pure file-type / size gate for a leave attachment. Empty/null allowedMimeTypes ⇒ no type restriction
 * (backward-compat). maxDocBytes null ⇒ fall back to the prior 10 MB ceiling. Called at the submission
 * boundary BEFORE the request commits, and inside addLeaveAttachment as defence-in-depth.
 */
export function validateLeaveDocument(
  rule: LeaveDocumentRule,
  file: { mimeType: string; sizeBytes: number },
): void {
  const allowed = rule.allowedMimeTypes ?? [];
  if (allowed.length > 0 && !allowed.includes(file.mimeType)) {
    throw new LeaveDocumentTypeError(allowed);
  }
  const max = rule.maxDocBytes ?? 10 * 1024 * 1024;
  if (file.sizeBytes > max) throw new LeaveDocumentSizeError(max);
}

/** Whole completed months from `start` to `asOf` (both ISO yyyy-mm-dd). */
function monthsBetween(start: string, asOf: string): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = asOf.split('-').map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1; // the day-of-month hasn't come round yet
  return Math.max(0, months);
}

/** Confirmation date an employee's probation status is derived from: finalConfirmationDate (canonical — it
 *  already folds in any probation extension) falling back to confirmationDate, else null. `asOf < date` ⇒ on
 *  probation; `asOf >= date` or a null date ⇒ NOT on probation (a legacy row with no confirmation date is
 *  treated as confirmed rather than blocked from a confirmed_only type). */
type ProbationEmp = { confirmationDate?: string | null; finalConfirmationDate?: string | null };
function onProbationAsOf(emp: ProbationEmp | undefined, asOf: string): boolean {
  const confDate = emp?.finalConfirmationDate ?? emp?.confirmationDate ?? null;
  return confDate != null && asOf < confDate;
}

/** The employee facts the two eligibility gates read. The eight org-assignment columns are OPTIONAL so a
 *  chokepoint that doesn't fetch them (or an employment with them all NULL) simply carries no org restriction —
 *  the value the gate compares against is `emp[key] ?? ''`, which no non-empty configured list ever matches. */
type EligibilityEmp = {
  gender: string | null;
  marital: string | null;
  hiredOn: string;
  confirmationDate?: string | null;
  finalConfirmationDate?: string | null;
  orgDivision?: string | null;
  orgBranch?: string | null;
  orgRegion?: string | null;
  orgLine?: string | null;
  orgSection?: string | null;
  orgTeam?: string | null;
  orgBase?: string | null;
  employmentCategory?: string | null;
};

/** True when `elig` carries ANY restriction — gender / marital / min-service / probation OR one of the eight
 *  org-assignment criteria. The chokepoints guard on this so the employee fetch is skipped only when the type
 *  is genuinely open to all, and so a newly-added criterion is picked up here rather than at each call site. */
export function hasAnyEligibilityRestriction(elig: LeaveEligibility | null | undefined): boolean {
  if (!elig) return false;
  if (asList(elig.gender).length > 0) return true;
  if (asList(elig.maritalStatus).length > 0) return true;
  if (elig.minServiceMonths) return true;
  if (elig.probation) return true;
  for (const c of ORG_ASSIGNMENT_CRITERIA) {
    if (asList(elig[c.key]).length > 0) return true;
  }
  return false;
}

function assertEligible(
  elig: LeaveEligibility,
  emp: EligibilityEmp | undefined,
  asOf: string,
): void {
  // Multi-select (#badc5966): qualify if the employee's attribute matches ANY selected value (OR within a
  // field, AND across fields). An empty list carries no restriction. asList() normalizes legacy scalar rows.
  const genders = asList(elig.gender);
  if (genders.length > 0 && !genders.includes(emp?.gender ?? '')) {
    throw new LeaveIneligibleError(`This leave type is available to ${genders.join(' or ')} employees only.`);
  }
  const maritals = asList(elig.maritalStatus);
  if (maritals.length > 0 && !maritals.includes(emp?.marital ?? '')) {
    throw new LeaveIneligibleError(`This leave type requires marital status “${maritals.join(' or ')}”.`);
  }
  if (elig.minServiceMonths && (!emp || servedFor(elig.minServiceUnit, emp.hiredOn, asOf) < elig.minServiceMonths)) {
    // Unit-aware message (#f88f0a63): 'days' rules read as "N days", months (incl. absent unit) as "N months".
    const unitWord = elig.minServiceUnit === 'days' ? 'days' : 'months';
    throw new LeaveIneligibleError(`This leave type requires at least ${elig.minServiceMonths} ${unitWord} of service.`);
  }
  // Probation gate (d6bdbd55): confirmed_only blocks employees still on probation; probation_only blocks
  // employees who are already confirmed. A null confirmation date ⇒ not-on-probation (see onProbationAsOf).
  if (elig.probation) {
    const onProbation = onProbationAsOf(emp, asOf);
    if (elig.probation === 'confirmed_only' && onProbation) {
      throw new LeaveIneligibleError('This leave type is available to confirmed employees only (after probation).');
    }
    if (elig.probation === 'probation_only' && !onProbation) {
      throw new LeaveIneligibleError('This leave type is available to employees on probation only.');
    }
  }
  // Organisation Assignment criteria: OR within a field, AND across fields (identical to gender/marital). An
  // empty/absent list carries no restriction; a configured list requires the employee's stored org value to be
  // one of the chosen values. asList() normalizes a legacy scalar the same way it does for gender/marital.
  for (const c of ORG_ASSIGNMENT_CRITERIA) {
    const allowed = asList(elig[c.key]);
    if (allowed.length > 0 && !allowed.includes(emp?.[c.key] ?? '')) {
      throw new LeaveIneligibleError(`This leave type is available to employees in ${allowed.join(' or ')} only.`);
    }
  }
}

// ── Maternity paid-allowance eligibility (EA s.37, Phase-B #13 / ADR-0062) ────────────────────────────
// The 98-day maternity LEAVE is unconditional (the female-only gate above is the only check on the leave).
// The paid maternity ALLOWANCE is a SEPARATE entitlement that EA-1955 s.37 withholds when EITHER:
//   1. qualifying-service fails — she must have been employed at ANY time in the 4 months immediately before
//      confinement AND for a total of ≥90 days in the 9 months immediately before confinement, OR
//   2. she already has ≥5 surviving children at confinement (the 5th-child proviso).
// When withheld, the leave is still granted but UNPAID (allowance_eligible=false + a reason), which drives
// the existing leave_type.paid=false → unpaidDaysByEmployment payroll path.
export const MATERNITY_LEAVE_CODE = 'MATERNITY';
/** EA s.37: the maximum number of surviving children for which the paid allowance is still payable (the 5th+
 *  child is excluded). */
const MATERNITY_MAX_SURVIVING_CHILDREN = 5;

export type MaternityAllowanceReason = 'qualifying_service' | 'fifth_child';
export type MaternityAllowanceDecision = {
  eligible: boolean;
  reason?: MaternityAllowanceReason;
  /** Whether the s.37 qualifying-service test passed (independent of the 5th-child proviso). */
  qualifyingService: boolean;
};

/** Whole days from `start` (inclusive) to `end` (exclusive), both ISO yyyy-mm-dd. Negative if end < start. */
function daysBetween(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.round((e - s) / 86_400_000);
}

/** "Today" in the tenant's local (Asia/Kuala_Lumpur) calendar as ISO yyyy-mm-dd. Used so the backdating
 *  boundary is not UTC-skewed for a late-night request near MYT midnight (this is a Malaysia product). The
 *  action layer computes this and passes it into requestLeave; core defaults to it when a caller omits it.
 *  Canonical implementation lives in lib/hr-date.ts (shared with employment-status); re-exported here so
 *  the many existing importers keep their import path. */
export { todayInKualaLumpur };

/** Configurable backdated-leave restriction (0133). True when `startDate` is backdated beyond `limitDays`
 *  from `today` (both ISO yyyy-mm-dd). limitDays null ⇒ never blocked (existing behaviour). limitDays 0 ⇒
 *  any past date is blocked (start must be today or later). daysBetween(start, today) is positive when start
 *  is before today and negative for a future date, so future dates are never blocked. Pure + `today`-
 *  injectable for deterministic tests. */
export function exceedsBackdatingLimit(startDate: string, today: string, limitDays: number | null): boolean {
  if (limitDays == null) return false;
  return daysBetween(startDate, today) > limitDays;
}

/** Advance Notice — calendar days or working days (feedback 7daac043, migration 0447). The UNIT a leave
 *  type's minimum advance-notice requirement is read in. 'calendar_days' counts every day on the wall
 *  calendar; 'working_days' counts only the days the employee is actually rostered to work. Stored as TEXT
 *  + CHECK rather than a pgEnum (the 0338 lesson, see the schema comment) and given its reading in exactly
 *  one function, resolveAdvanceNoticeDayType() below. */
export type AdvanceNoticeDayType = 'calendar_days' | 'working_days';

/** THE ONE PLACE the stored column is turned into a reading. NULL — which is every leave_type row in every
 *  existing database, since 0447 backfills nothing — means calendar days, and so does anything unrecognised
 *  (a hand-edited row must not leave the engine guessing). Mirrors how maxConsecutiveUnit is resolved in
 *  resolveApplicationLengthLimit. */
export function resolveAdvanceNoticeDayType(stored: string | null | undefined): AdvanceNoticeDayType {
  return stored === 'working_days' ? 'working_days' : 'calendar_days';
}

/** How much notice a request submitted on `today` actually GIVES for a leave starting on `startDate`,
 *  measured in `dayType`'s unit (both ISO yyyy-mm-dd). Pure + `today`-injectable, like every other rule
 *  helper in this file.
 *
 *  THE WINDOW IS HALF-OPEN, [today, startDate) — and that is what makes the two units agree at the
 *  boundary. Calendar 7 has always meant "7 whole days before the start date" (daysBetween is exclusive of
 *  the end), so the start date itself must not be counted in EITHER unit; counting it in the working-days
 *  branch would quietly make "7 working days" one day laxer than "7 calendar days" on a week with no
 *  weekend in it.
 *
 *  calendar_days ⇒ daysBetween(today, startDate): positive for a future start, NEGATIVE for a backdated
 *  one, which is exactly the pre-0447 arithmetic and why a backdated request has always lacked notice.
 *  working_days ⇒ the number of dates in that window the employee is rostered to work and that are not
 *  holidays (isWorkingDay, the same membership test the deduction engine uses). A backdated start yields
 *  an EMPTY window and therefore 0, which still lacks any positive requirement — the semantics are
 *  preserved, not the sign.
 *
 *  `workingDaysIso` / `holidays` are only consulted on the working-days branch; callers on the calendar
 *  branch pass neither and issue no extra queries at all. Omitted on the working branch they fall back to
 *  the Mon–Fri default and no holidays, the same fallback resolveSchedule takes for a company with no
 *  attendance policy. */
export function noticeDaysGiven(
  today: string,
  startDate: string,
  dayType: AdvanceNoticeDayType,
  workingDaysIso?: number[],
  holidays?: Set<string>,
): number {
  if (dayType !== 'working_days') return daysBetween(today, startDate);
  const roster = workingDaysIso ?? DEFAULT_WORKING_DAYS_ISO;
  const hols = holidays ?? new Set<string>();
  const end = Date.parse(`${startDate}T00:00:00Z`);
  let n = 0;
  for (let t = Date.parse(`${today}T00:00:00Z`); t < end; t += 86_400_000) {
    if (isWorkingDay(new Date(t).toISOString().slice(0, 10), roster, hols)) n++;
  }
  return n;
}

/** Minimum advance-notice rule (0159), read in a configurable unit since 7daac043 / migration 0447. True
 *  when `startDate` arrives with fewer than `minDays` days of notice from `today`, counted in `dayType`.
 *  minDays null ⇒ never blocked (existing behaviour). Exactly minDays of notice is allowed ("at least N
 *  days before"). A backdated start always lacks notice — consistent with "must be submitted at least N
 *  days before the start date" (the separate backdating gate may fire first; both are checked before any
 *  write). minDays 0 ⇒ only past start dates lack notice on the calendar reading (start must be today or
 *  later). Pure + `today`-injectable for deterministic tests, mirroring exceedsBackdatingLimit. */
export function lacksMinAdvanceNoticeIn(
  startDate: string,
  today: string,
  minDays: number | null,
  dayType: AdvanceNoticeDayType,
  workingDaysIso?: number[],
  holidays?: Set<string>,
): boolean {
  if (minDays == null) return false;
  return noticeDaysGiven(today, startDate, dayType, workingDaysIso, holidays) < minDays;
}

/** The CALENDAR-basis reading of the rule, kept at its original 3-argument signature so every pre-0447
 *  importer (and the tests that pin the pre-0447 arithmetic) keeps working unchanged. A thin wrapper, not a
 *  second implementation: there is one rule and one place it is computed. */
export function lacksMinAdvanceNotice(startDate: string, today: string, minDays: number | null): boolean {
  return lacksMinAdvanceNoticeIn(startDate, today, minDays, 'calendar_days');
}

/**
 * 4b0e76ae — THE ONE year list every entitlement-year picker offers: a COMPUTED RANGE, three years back
 * through six years forward, oldest first. Pure + `currentYear`-injectable for deterministic tests.
 *
 * WHY IT IS COMPUTED AND NOT READ. Both pickers (the Generate Entitlement page and the Run Earned Accrual
 * selector) used to derive their years from the managed `leave_year_config` records. That module is gone —
 * its screen, all five writers and every row — so a table-backed dropdown would render permanently empty
 * with nothing able to fill it. A computed range needs no setup and nothing to maintain.
 *
 * WHY IT REACHES BACK THREE YEARS, which is the part not to trim. The Run Earned Accrual selector previously
 * built `currentYear .. currentYear + 6` and leaned on the configured records for anything earlier, so a
 * forward-only range would silently REMOVE the ability to run earned accrual for a past year. Reaching back
 * three years is what makes the "nothing is lost" promise true. The one accepted difference, stated to the
 * reporter in plain words, is that the selector now opens on the CURRENT year rather than the newest
 * configured one.
 */
export const ENTITLEMENT_YEARS_BACK = 3;
export const ENTITLEMENT_YEARS_FORWARD = 6;
export function entitlementYearOptions(currentYear: number): number[] {
  const span = ENTITLEMENT_YEARS_BACK + ENTITLEMENT_YEARS_FORWARD + 1;
  return Array.from({ length: span }, (_, i) => currentYear - ENTITLEMENT_YEARS_BACK + i);
}

/** Subtract whole calendar months from an ISO date, clamping the day to the target month's length. */
function subtractMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1 - months, 1));
  const ty = base.getUTCFullYear();
  const tm = base.getUTCMonth(); // 0-based
  const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(d, dim);
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * EA s.37 maternity paid-ALLOWANCE eligibility. Pure (no DB), unit-testable. Returns the decision the
 * service applies as a per-request OVERRIDE of the maternity leave-type paid default:
 *   - qualifying service met AND survivingChildren < 5 → { eligible: true }
 *   - qualifying service FAILS                          → { eligible: false, reason: 'qualifying_service' }
 *   - qualifying met but survivingChildren ≥ 5          → { eligible: false, reason: 'fifth_child' }
 * Qualifying-service precedence: when BOTH fail, 'qualifying_service' is reported (it is the threshold check).
 * Qualifying service = employed at any time in the 4 months immediately before confinement AND for ≥90 days
 * in the 9 months immediately before confinement (computed from hiredOn vs the confinement date).
 */
export function maternityAllowanceEligibility(
  hiredOn: string,
  confinementDate: string,
  survivingChildren: number,
): MaternityAllowanceDecision {
  // Employed at any time in the 4 months immediately before confinement: the employment [hiredOn, …)
  // overlaps the window [conf−4mo, conf) iff she was hired strictly before confinement (hiredOn ≥ conf would
  // mean she was not yet employed at confinement at all).
  const employedInFourMonthWindow = hiredOn < confinementDate;
  // ≥90 days in the 9 months immediately before confinement: days employed inside [conf−9mo, conf).
  const nineMonthsBefore = subtractMonths(confinementDate, 9);
  const windowStart = hiredOn > nineMonthsBefore ? hiredOn : nineMonthsBefore;
  const daysInNineMonthWindow = Math.max(0, daysBetween(windowStart, confinementDate));
  const qualifyingService = employedInFourMonthWindow && daysInNineMonthWindow >= 90;

  if (!qualifyingService) {
    return { eligible: false, reason: 'qualifying_service', qualifyingService: false };
  }
  if (survivingChildren >= MATERNITY_MAX_SURVIVING_CHILDREN) {
    return { eligible: false, reason: 'fifth_child', qualifyingService: true };
  }
  return { eligible: true, qualifyingService: true };
}

/** Boolean form of the eligibility gate (assertEligible throws; this just answers). Used by reads to
 *  show an employee only the leave types they could actually take (2F-1 / R18). */
export function isLeaveEligible(
  elig: LeaveEligibility | null | undefined,
  emp: EligibilityEmp | undefined,
  asOf: string,
): boolean {
  if (!elig) return true;
  const genders = asList(elig.gender);
  if (genders.length > 0 && !genders.includes(emp?.gender ?? '')) return false;
  const maritals = asList(elig.maritalStatus);
  if (maritals.length > 0 && !maritals.includes(emp?.marital ?? '')) return false;
  if (elig.minServiceMonths && (!emp || servedFor(elig.minServiceUnit, emp.hiredOn, asOf) < elig.minServiceMonths))
    return false;
  // Probation gate (d6bdbd55) — mirrors assertEligible so reads hide a type the employee can't take.
  if (elig.probation) {
    const onProbation = onProbationAsOf(emp, asOf);
    if (elig.probation === 'confirmed_only' && onProbation) return false;
    if (elig.probation === 'probation_only' && !onProbation) return false;
  }
  // Organisation Assignment criteria — mirrors assertEligible (OR within a field, AND across fields).
  for (const c of ORG_ASSIGNMENT_CRITERIA) {
    const allowed = asList(elig[c.key]);
    if (allowed.length > 0 && !allowed.includes(emp?.[c.key] ?? '')) return false;
  }
  return true;
}

export async function leaveBalance(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
}

/** Balance Deduction Source (feedback cdf9ca48) — the leave type whose BALANCE an application of
 *  `leaveTypeId` is checked against and debited from. Returns `leaveTypeId` itself when the type has no
 *  configured source, which is every type until an administrator changes one, so every existing caller keeps
 *  reading the same ledger it always did.
 *
 *  ONE read, no walk: updateLeaveType refuses a source that itself has a source, so the graph is at most one
 *  hop deep and cycles cannot exist. Resolving here rather than at each call site matters because the
 *  submit-time guard and the approval-time debit MUST agree on which ledger they are talking about — if they
 *  ever disagreed, an application could clear submission and then be refused at approval, or debit a balance
 *  nobody had checked. substrate: read-only, no event. */
export async function resolveBalanceSourceTypeId(tx: Tx, leaveTypeId: string): Promise<string> {
  const [row] = await tx
    .select({ src: leaveType.balanceSourceTypeId })
    .from(leaveType)
    .where(eq(leaveType.id, leaveTypeId))
    .limit(1);
  return row?.src ?? leaveTypeId;
}

/** Every leave type that SPENDS `sourceTypeId`'s balance — the source itself plus each type configured to
 *  deduct from it. The pending reservation has to cover all of them: once Emergency Leave draws on Annual,
 *  a pending Emergency application reserves Annual days just as surely as a pending Annual one does, and
 *  counting only one of the two would let a stack of applications collectively overshoot the balance.
 *  Returns just [sourceTypeId] when nothing borrows (today's shape). */
async function balanceSpenderTypeIds(tx: Tx, sourceTypeId: string): Promise<string[]> {
  const borrowers = await tx
    .select({ id: leaveType.id })
    .from(leaveType)
    .where(eq(leaveType.balanceSourceTypeId, sourceTypeId));
  return [sourceTypeId, ...borrowers.map((b) => b.id)];
}

// Configurable Negative Leave Balance Validation (0ef0defd): the "available" balance for the SUBMIT/EDIT-time
// guard = leaveBalance (approved ledger only) MINUS the sum of this employee's OTHER PENDING requests of the
// same leave type (days already reserved but not yet approved, so they post no ledger entry). Subtracting the
// pending reservation stops an employee stacking several pending applications that individually pass but
// collectively overshoot. `excludeRequestId` drops the request being edited from its own pending sum (the edit
// path re-checks the NEW days against everything else). Rounded to 2dp to match the rest of the leave math.
//
// Balance Deduction Source (cdf9ca48): the ledger read and the pending reservation both move to the RESOLVED
// source type, so a borrowing type is measured against the balance it will actually spend. With no source
// configured anywhere this resolves to leaveTypeId and one spender, i.e. exactly the query it ran before.
export async function availableLeaveBalance(
  tx: Tx,
  employmentId: string,
  leaveTypeId: string,
  excludeRequestId?: string,
): Promise<number> {
  const sourceTypeId = await resolveBalanceSourceTypeId(tx, leaveTypeId);
  const bal = await leaveBalance(tx, employmentId, sourceTypeId);
  const spenders = await balanceSpenderTypeIds(tx, sourceTypeId);
  return round2(bal - (await pendingLeaveDays(tx, employmentId, spenders, excludeRequestId)));
}

/** The days already RESERVED by this employee's other PENDING requests of the given leave type(s) — extracted
 *  verbatim from availableLeaveBalance (no behaviour change) so the apply-popup summary's "Pending" figure is
 *  byte-identical to what the submit-time negative-balance guard reserves. substrate: read-only, no event.
 *
 *  Allow Unpaid Leave (a7fab30b): a request reserves days - unpaid_days, not days. Its unpaid portion was
 *  never going to touch the balance, so reserving it would understate what is still available and refuse a
 *  later application that in fact fits. unpaid_days is NULL on every pre-existing row ⇒ the sum is unchanged. */
async function pendingLeaveDays(
  tx: Tx,
  employmentId: string,
  leaveTypeIds: string | string[],
  excludeRequestId?: string,
): Promise<number> {
  const ids = Array.isArray(leaveTypeIds) ? leaveTypeIds : [leaveTypeIds];
  const [row] = await tx
    .select({
      pending: sql<string>`coalesce(sum(${leaveRequest.days} - coalesce(${leaveRequest.unpaidDays}, 0)), 0)`,
    })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, employmentId),
        inArray(leaveRequest.leaveTypeId, ids),
        eq(leaveRequest.status, 'pending'),
        ...(excludeRequestId ? [sql`${leaveRequest.id} <> ${excludeRequestId}`] : []),
      ),
    );
  return Number(row?.pending ?? 0);
}

/**
 * Employee apply-popup entitlement summary (Pending / Taken / Balance / Available) for ONE
 * (employment, leave type) pair.
 *
 * Deliberately NOT routed through core/read.ts leaveBalances: that function drops visible_to_employee=false
 * types and filters its no-activity tail through isLeaveEligible, while the apply dropdown renders the
 * unfiltered listLeaveTypes — so a selectable type could have no row at all there. Aggregating over one pair
 * means a type with no ledger and no pending rows returns 0 / 0 / 0 rather than nothing.
 *
 * `balance` is the RAW ledger balance, GROSS of pending — the same figure the balance table surfaces as
 * Balance (6574c6b4) and the same leaveBalance() call previewLeaveDeduction assigns to balanceAvailable.
 *
 * `available` is that balance MINUS the pending reservation — feedback 082fa566's re-fix. r74 renamed the
 * popup's third column from Balance to Available and left the value alone, so the popup read 13.5 where the
 * leave type's own Leave Summary card read 8.5; the 5.0 difference was the employee's own submitted-but-
 * undecided request, which the word "Available" promises has already been taken off. It is computed from the
 * SAME `balance` and the SAME pendingLeaveDays() the guard uses, so it is availableLeaveBalance() by
 * construction rather than by coincidence — the r72 (cdf9ca48) invariant that the popup and the submit-time
 * guard cannot diverge now covers the figure the employee actually reads, not just the Pending line. Both are
 * returned so the popup can show the subtraction (Balance − Pending Approval = Available) rather than a bare
 * result the reporter had no way to check.
 *
 * ESS gating is NOT applied here: essViewConfig is returned raw and the caller decides (app/leave/actions.ts),
 * because the admin on-behalf path must never be gated. substrate: read-only, no event.
 */
export async function leaveTypeApplySummary(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string },
): Promise<{
  pending: number;
  taken: number;
  balance: number;
  available: number;
  essViewConfig: Record<string, boolean> | null;
}> {
  return withTenant(ctx, async (tx) => {
    // Balance Deduction Source (cdf9ca48): report the balance the employee will actually spend. A borrowing
    // type has no ledger of its own, so reading its own would show a flat 0.0 Available directly above a real
    // day count — the same "0.0 / 0.0 / 0.0" nonsense the panel already suppresses for Emergency Leave.
    const sourceTypeId = await resolveBalanceSourceTypeId(tx, p.leaveTypeId);
    const balance = await leaveBalance(tx, p.employmentId, sourceTypeId);
    const pending = await pendingLeaveDays(tx, p.employmentId, await balanceSpenderTypeIds(tx, sourceTypeId));
    // Same expression core/read.ts leaveBalances uses for `taken`, so the two never disagree.
    const [tk] = await tx
      .select({
        taken: sql<string>`coalesce(-sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} = 'debit'), 0)`,
      })
      .from(leaveLedger)
      .where(and(eq(leaveLedger.employmentId, p.employmentId), eq(leaveLedger.leaveTypeId, sourceTypeId)));
    const [lt] = await tx
      .select({ essViewConfig: leaveType.essViewConfig })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    return {
      pending: round2(pending),
      taken: round2(Number(tk?.taken ?? 0)),
      balance: round2(balance),
      // Not clamped at zero: an overdrawn type must read the same negative figure the guard measures, or the
      // popup would understate how far the employee is already committed.
      available: round2(balance - pending),
      essViewConfig: (lt?.essViewConfig ?? null) as Record<string, boolean> | null,
    };
  });
}

// ── Shared Leave Group enforcement (r88, feedback 1ef1cf95; the rules themselves R44 4c48fd1f + r82a) ──
// The two rules are unchanged and both enforcement points are unchanged — APPLY and APPROVAL. What moved is
// WHERE the group is looked up: a group is now tenant-level with leave-type members (leave_shared_group /
// _member, migration 0342), so resolving one no longer starts from the employee's benefit scheme.
//
// The scheme resolution that used to open this section (resolveSchemeIdForEmployment) is gone with it. It
// existed solely to answer "which scheme's pools apply to this employee", and there is no such question any
// more: the group applies to the leave TYPE, for everyone. The scheme-based ENTITLEMENT resolution is a
// different thing and lives on untouched in buildSchemeEntitlementResolver.

/** THE SINGLE PLACE "consecutive days" is given units (r82a 1ef1cf95; made SELECTABLE by c6ffa725 rev 2).
 *
 *  The reporter's rule is "each application is capped at N consecutive days". r82a read that as CALENDAR
 *  days spanned by the application — start..end inclusive, weekends and public holidays counted — and the
 *  approved plan explicitly invited a rejection if working days were meant. The reporter came back and
 *  asked for the CHOICE, per leave type, which is what `unit` now is. This function is still the whole
 *  change: it is the only place either reading is produced, and there is deliberately no second span
 *  helper anywhere.
 *
 *    'calendar_days' — the span, start..end inclusive. Both dates are ISO yyyy-mm-dd and are read as UTC
 *      midnights, so no timezone can shift it. Friday→Monday is 4.
 *    'working_days'  — `chargedDays`, i.e. the days the application ACTUALLY COSTS, already computed by the
 *      caller with the leave type's own counting mode, day-type inclusion and duration. It is not
 *      recomputed here: a second working-day count beside the one that charges the ledger is exactly the
 *      silent disagreement this area exists to avoid. Friday→Monday is 2.
 *
 *  The shared-leave-group cap has no unit column and is always read as 'calendar_days' — that is the
 *  reading r82a shipped and test/shared-leave-group-max-days.test.ts pins it. */
function applicationSpanDays(p: {
  startDate: string;
  endDate: string;
  /** Days this application charges as leave — requestLeave's `days`. Only read for 'working_days'. */
  chargedDays: number;
  unit: ConsecutiveLeaveUnit;
}): number {
  if (p.unit === 'working_days') return round2(Math.max(0, p.chargedDays));
  const start = Date.parse(`${p.startDate}T00:00:00Z`);
  const end = Date.parse(`${p.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * ONE COMPOSITION, NOT ONE SOURCE — the per-application length rule (c6ffa725 rev 2).
 *
 * TWO configured limits can cap the length of a single application:
 *
 *   1. the LEAVE TYPE's own Maximum Consecutive Leave (leave_type.max_consecutive_days + _unit, 0343), and
 *   2. the SHARED LEAVE GROUP's max_days_per_application (leave_shared_group, 1ef1cf95), which applies to
 *      every member type of the group and is always read in calendar days.
 *
 * Two independent caps on the same application CAN disagree, and a silent disagreement is unanswerable for
 * the employee who was refused — which is precisely why test/shared-leave-group-single-mechanism.test.ts
 * exists. The answer is not to forbid the second scope; it is to refuse to let them be independent. This
 * function is the ONLY place either cap is compared with an application, exactly as entitledDays is the
 * only place three entitlement sources are composed into one day figure.
 *
 * THE RULE: the STRICTER limit binds — it can only ever tighten, never loosen what the group already
 * promised. "Stricter" is the SMALLEST SLACK, slack = cap − measured in that limit's own unit. When both
 * limits read calendar days (the common case) `measured` is identical for both, so smallest slack is
 * literally MIN(typeCap, groupCap) — the rule stated in the approved plan. When the type's unit is working
 * days the two figures are not commensurable as bare numbers, and slack is the one comparison that stays
 * meaningful: it asks "how close is this application to each limit", which is the question a cap answers.
 *
 * Returns the binding limit, or null when the application is within every configured cap. The TIE-BREAK is
 * the leave type, the narrower scope: if both bind by exactly the same margin, the employee is told about
 * the rule attached to the type they actually chose.
 */
export function bindingApplicationLengthLimit(
  candidates: readonly ApplicationLengthLimit[],
): ApplicationLengthLimit | null {
  const breached = candidates.filter((c) => c.cap > 0 && c.measured > c.cap);
  if (breached.length === 0) return null;
  const slack = (c: ApplicationLengthLimit) => c.cap - c.measured;
  const rank = (c: ApplicationLengthLimit) => (c.scope === 'leave_type' ? 0 : 1);
  return [...breached].sort((a, bb) => slack(a) - slack(bb) || rank(a) - rank(bb))[0];
}

/**
 * THE ONE PLACE a per-application length cap is compared with an application (c6ffa725 rev 2).
 *
 * Gathers every configured cap on how long a SINGLE application may be, measures the application in each
 * cap's own unit, hands them to bindingApplicationLengthLimit, and throws the refusal that NAMES the limit
 * which bound. Two caps exist:
 *
 *   - the LEAVE TYPE's Maximum Consecutive Leave (0343) — calendar OR working days, the administrator's
 *     choice, because "3 days" means different things over a weekend and the reporter asked to say which;
 *   - the SHARED LEAVE GROUP's max_days_per_application (1ef1cf95) — always calendar days, the reading
 *     r82a shipped, unchanged.
 *
 * Both NULL is the state of every database that has not been configured, so this is a query-and-return
 * no-op until an administrator sets one. The STRICTER binds; see bindingApplicationLengthLimit for why
 * "one composition" is what the single-mechanism invariant actually asks for, and why two SOURCES with one
 * composition is not the thing that guard forbids.
 *
 * CALLED AT BOTH SUBMISSION AND APPROVAL, for the reason every rule in this file is: a submit-only check is
 * walked straight through by anything already pending when the cap is set or tightened, and an
 * approval-only check lets an employee file applications that will all be refused later.
 */
async function enforceApplicationLengthLimit(
  tx: Tx,
  p: {
    leaveTypeId: string;
    startDate: string;
    /** The application's last date — a calendar-unit cap measures this span. */
    endDate: string;
    /** Days this application CHARGES — what a working-days cap measures. Already computed by the caller
     *  with the type's counting mode; never recomputed here (one working-day count, not two). */
    chargedDays: number;
  },
): Promise<void> {
  if (p.chargedDays <= 0) return;
  const [lt] = await tx
    .select({
      name: leaveType.name,
      maxConsecutiveDays: leaveType.maxConsecutiveDays,
      maxConsecutiveUnit: leaveType.maxConsecutiveUnit,
    })
    .from(leaveType)
    .where(eq(leaveType.id, p.leaveTypeId))
    .limit(1);
  // The group (if any) this leave type belongs to. The unique index on (tenant, leave_type) means there is
  // at most one, so no ordering or tie-break is needed to make this deterministic.
  const [group] = await tx
    .select({ name: leaveSharedGroup.name, maxDaysPerApplication: leaveSharedGroup.maxDaysPerApplication })
    .from(leaveSharedGroupMember)
    .innerJoin(leaveSharedGroup, eq(leaveSharedGroup.id, leaveSharedGroupMember.groupId))
    .where(eq(leaveSharedGroupMember.leaveTypeId, p.leaveTypeId))
    .limit(1);

  const candidates: ApplicationLengthLimit[] = [];
  if (lt?.maxConsecutiveDays != null) {
    const cap = Number(lt.maxConsecutiveDays);
    // The DB CHECK and the write-time validator both refuse a non-positive cap and a missing unit, but the
    // guards are restated so a hand-edited row cannot refuse every application of a type or leave the unit
    // to be guessed at. An unrecognised unit falls back to the calendar reading r82a shipped.
    if (Number.isFinite(cap) && cap > 0) {
      const unit: ConsecutiveLeaveUnit = lt.maxConsecutiveUnit === 'working_days' ? 'working_days' : 'calendar_days';
      candidates.push({
        scope: 'leave_type',
        name: lt.name,
        cap,
        unit,
        measured: applicationSpanDays({ ...p, unit }),
      });
    }
  }
  if (group?.maxDaysPerApplication != null) {
    const cap = Number(group.maxDaysPerApplication);
    if (Number.isFinite(cap) && cap > 0) {
      candidates.push({
        scope: 'shared_group',
        name: group.name,
        cap,
        unit: 'calendar_days',
        measured: applicationSpanDays({ ...p, unit: 'calendar_days' }),
      });
    }
  }

  const bound = bindingApplicationLengthLimit(candidates);
  if (!bound) return;
  // The refusal NAMES the limit that bound and the configuration to change. Two classes, because the fix is
  // in two different screens: the leave type, or the shared leave group.
  if (bound.scope === 'leave_type') {
    throw new LeaveTypeApplicationTooLongError({
      leaveTypeName: bound.name,
      maxConsecutiveDays: bound.cap,
      unit: bound.unit,
      requestedSpanDays: bound.measured,
    });
  }
  throw new CombinedLeaveApplicationTooLongError(bound.name, bound.cap, bound.measured);
}

/** Shared-leave-group guard: if the requested leave type belongs to a group, enforce the group's SHARED
 *  ANNUAL TOTAL (R44 4c48fd1f) — sum the employee's per-cycle usage ACROSS ALL member types (pending +
 *  approved, minus the request being re-evaluated) and reject when adding `requestedDays` would breach the
 *  group's shared total. The cycle is the calendar leave year of `startDate` (mirrors the tenant's
 *  calendar-year leave_year_config keying). A no-op when the type is in no group, so tenants with no groups
 *  are unchanged.
 *
 *  THE GROUP'S OTHER RULE, its per-application cap (r82a 1ef1cf95), USED TO LIVE HERE and moved out in
 *  c6ffa725 rev 2 — see enforceApplicationLengthLimit above, which every caller of this function calls
 *  first. It moved because the leave type gained a cap of its own and two places deciding how long one
 *  application may be is the disagreement this whole area is built to prevent. The rule itself, its error
 *  and its calendar-days reading are all unchanged.
 *
 *  The two rules refuse with DIFFERENT named errors — "your year is spent" is not "this one is too long".
 *
 *  r88 1ef1cf95: the lookup is now `leaveTypeId -> group`, with no benefit-scheme dimension. That REMOVES a
 *  per-employee dimension: two employees on different schemes can no longer be subject to different shared
 *  limits over the same leave types. Intended, and the reason the tables were renamed rather than patched.
 *  Both call sites (requestLeave, the approval path) are unchanged — this is a re-point, not a rewrite. */
async function enforceSharedLeaveGroupLimit(
  tx: Tx,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    requestedDays: number;
    excludeRequestId?: string;
  },
): Promise<void> {
  if (p.requestedDays <= 0) return;
  // The group (if any) this leave type belongs to. The unique index on (tenant, leave_type) means there is
  // at most one, so no ordering or tie-break is needed to make this deterministic.
  const [group] = await tx
    .select({
      id: leaveSharedGroup.id,
      name: leaveSharedGroup.name,
      totalLimitDays: leaveSharedGroup.totalLimitDays,
      maxDaysPerApplication: leaveSharedGroup.maxDaysPerApplication,
    })
    .from(leaveSharedGroupMember)
    .innerJoin(leaveSharedGroup, eq(leaveSharedGroup.id, leaveSharedGroupMember.groupId))
    .where(eq(leaveSharedGroupMember.leaveTypeId, p.leaveTypeId))
    .limit(1);
  if (!group) return;
  // The shared annual total. (The group's per-application cap was checked before this function ran — see
  // enforceApplicationLengthLimit; leaving a copy of it here would recreate the two-places-decide problem
  // that composition exists to prevent.)
  const total = Number(group.totalLimitDays);
  // All member leave types of the group.
  const members = await tx
    .select({ leaveTypeId: leaveSharedGroupMember.leaveTypeId })
    .from(leaveSharedGroupMember)
    .where(eq(leaveSharedGroupMember.groupId, group.id));
  const memberTypeIds = members.map((m) => m.leaveTypeId);
  if (memberTypeIds.length === 0) return;
  // Per-cycle usage across all member types = pending + approved requests whose start falls in the same
  // calendar year, minus the request being re-evaluated (avoids double-counting on the approval path).
  // 46afcc48: the window comes from `sharedGroupCycleWindow` so the figure the employee reads on their
  // Leave tab is summed over the identical cycle. Same dates, one definition.
  //
  // NOTE WHAT IS *NOT* HERE, because 46afcc48 is a display request and this is the enforcement: no member
  // type's visibility, and no group placement, is consulted anywhere in this function. Hiding a member —
  // or the whole group — cannot move this verdict, and a test pins exactly that.
  const { start: windowStart, end: windowEnd } = sharedGroupCycleWindow(p.startDate);
  const [used] = await tx
    .select({ total: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, p.employmentId),
        inArray(leaveRequest.leaveTypeId, memberTypeIds),
        inArray(leaveRequest.status, ['pending', 'approved']),
        gte(leaveRequest.startDate, windowStart),
        lte(leaveRequest.startDate, windowEnd),
        ...(p.excludeRequestId ? [sql`${leaveRequest.id} <> ${p.excludeRequestId}`] : []),
      ),
    );
  const usedDays = Number(used?.total ?? 0);
  if (round2(usedDays + p.requestedDays) > total) {
    throw new CombinedLeaveLimitExceededError(group.name, total);
  }
}

/**
 * Application Limits (feedback c6ffa725) — THE LEAVE-YEAR WINDOW the annual application limit is measured
 * over, as an inclusive [start, end] ISO pair.
 *
 * The boundary is read from the CYCLE, which `resolveLeaveYearCycle` resolves from the leave TYPE's own
 * `year_cycle_override` falling back to the company's `leave_cycle`. That is the settled home for the
 * question after 9816a5ad — `leave_policy` is deliberately not consulted, and neither is any second notion
 * of "the year" invented here.
 *
 * `earnedCycleStart` is REUSED rather than restated. It is the existing, engine-wide definition of where an
 * employee's anniversary cycle begins (hire-MONTH granularity, yyyy-mm-01), and the accrual engine already
 * measures the year that way. A limit that counted over a subtly different window from the one the accrual
 * engine grants over would be a second, quietly-disagreeing definition of the leave year — which is exactly
 * the duplication the consolidation removed. A calendar cycle (including 'a2c', which resolves to calendar)
 * is 1 Jan → 31 Dec, matching the combined-pool window and `leave_year_config`'s calendar keying.
 *
 * The end is computed by UTC date arithmetic on the date-only string, the convention the rest of this file
 * uses: date-only maths in UTC is exact, and no instant is being converted, so no timezone is involved.
 */
export function leaveYearWindow(
  hiredOn: string,
  onDate: string,
  cycle: string | null | undefined,
): { start: string; end: string } {
  const start = earnedCycleStart(hiredOn, onDate, cycle);
  const [sy, sm, sd] = start.split('-').map(Number);
  // One year on, minus one day — Date.UTC normalises the 29-Feb case (2024-02-29 + 1y ⇒ 2025-03-01, minus a
  // day ⇒ 2025-02-28) rather than producing an impossible date.
  const end = new Date(Date.UTC(sy + 1, sm - 1, sd) - 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

/**
 * ad9cb5c5 — the periods an application ceiling can be measured over.
 *
 * 'leave_year'    the employee's own leave year (hire-date or calendar-anchored per the company cycle)
 * 'calendar_year' 1 January to 31 December, which equals the leave year ONLY when the leave year starts
 *                 in January — the whole reason both are offered
 * 'employment'    the entire employment. A rehire is a new employment and legitimately starts fresh.
 */
export const APPLICATION_LIMIT_PERIODS = ['leave_year', 'calendar_year', 'employment'] as const;
export type ApplicationLimitPeriod = (typeof APPLICATION_LIMIT_PERIODS)[number];

/** NULL / unknown ⇒ 'leave_year', which is what every row written before migration 0352 means. Unknown is
 *  folded into the default rather than thrown on: a hand-edited row must not make every application of a
 *  type unanswerable, the same reasoning as the non-positive-limit guard below. */
export function resolveApplicationLimitPeriod(raw: string | null | undefined): ApplicationLimitPeriod {
  return (APPLICATION_LIMIT_PERIODS as readonly string[]).includes(raw ?? '')
    ? (raw as ApplicationLimitPeriod)
    : 'leave_year';
}

/**
 * The [start, end] window an application ceiling counts over. Pure — no database — so the period arithmetic
 * is testable without a fixture, which is the part most likely to be got wrong.
 *
 * 'employment' returns the hire date to the application date rather than an open-ended range, because the
 * usage query filters on `start_date BETWEEN start AND end`: an unbounded end would need a different query
 * shape, and a far-future sentinel would silently include applications dated beyond the one being judged.
 * Counting up to and including the application's own start date is what "how many have you had so far"
 * means, and it makes the rule independent of when it is evaluated.
 */
export function applicationLimitWindow(p: {
  period: ApplicationLimitPeriod;
  hiredOn: string;
  startDate: string;
  cycle: string | null | undefined;
}): { start: string; end: string } {
  if (p.period === 'calendar_year') {
    const year = p.startDate.slice(0, 4);
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  if (p.period === 'employment') {
    // An application dated BEFORE the hire date would invert the range and match nothing; clamp so the
    // window is always well-formed and such a request is judged against its own day.
    const start = p.hiredOn <= p.startDate ? p.hiredOn : p.startDate;
    return { start, end: p.startDate };
  }
  return leaveYearWindow(p.hiredOn, p.startDate, p.cycle);
}

/**
 * bc512dc3 — the floor check, shared by requestLeave and editLeaveRequest so the two cannot drift.
 *
 * Only meaningful when allow_negative_balance is ON: with it off, the caller has already refused any
 * negative at all, and migration 0352's CHECK makes "floor without permission" unrepresentable anyway.
 *
 * `available` is passed in rather than re-read, because the callers resolve it against the BALANCE SOURCE
 * (cdf9ca48) and, on the edit path, excluding the request's own reservation. Re-reading it here would
 * quietly measure a different balance from the one the caller just gated on.
 */
async function enforceMaxNegativeBalance(
  tx: Tx,
  p: { leaveTypeId: string; available: number; requestedDays: number },
): Promise<void> {
  const [lt] = await tx
    .select({ name: leaveType.name, maxNegativeBalance: leaveType.maxNegativeBalance })
    .from(leaveType)
    .where(eq(leaveType.id, p.leaveTypeId))
    .limit(1);
  if (!lt || lt.maxNegativeBalance == null) return; // NULL ⇒ unbounded, today's behaviour
  const floor = Number(lt.maxNegativeBalance);
  // A non-positive floor is refused by the DB CHECK, but restate it: a hand-edited row must not start
  // refusing every application of the type (the same reasoning as the application-limit guard).
  if (!Number.isFinite(floor) || floor <= 0) return;
  if (round2(p.available - p.requestedDays) < -floor) {
    throw new NegativeLeaveBalanceLimitExceededError({
      leaveTypeName: lt.name,
      maxNegativeBalance: floor,
      availableDays: round2(p.available),
      requestedDays: p.requestedDays,
    });
  }
}

/**
 * Application Limits (feedback c6ffa725, migration 0335) — refuse an application that would push the
 * employee past this leave TYPE's maximum days per leave year.
 *
 * NULL ⇒ no limit, and that is the state of every leave type in every existing database, so this is a no-op
 * until an administrator deliberately types a figure in. There is no default (see migration 0335).
 *
 * WHAT IT COUNTS: days APPLIED FOR — every pending and approved request of this type whose start date falls
 * inside the same leave year, minus the request being re-evaluated. Not the balance, not the ledger: the
 * whole point of the setting is that it works for types with NO balance. It therefore reads exactly the same
 * shape of usage the combined-pool rule already reads, over a window resolved from the leave type's own
 * Leave Year Type instead of a hardcoded calendar year.
 *
 * WHAT IT DOES NOT TOUCH: entitlement, accrual, earning method, carry-forward, rounding, the ledger and the
 * balance shown in Leave Summary. Nothing below writes.
 *
 * CALLED AT BOTH SUBMISSION AND APPROVAL, for the reason the shared-group cap is: a submit-only check is
 * bypassed by anything already pending when the limit is set or tightened, and an approval-only check lets
 * an employee file applications that will all be refused later. Neither alone is enforcement.
 */
async function enforceLeaveYearApplicationLimit(
  tx: Tx,
  p: {
    employmentId: string;
    leaveTypeId: string;
    /** The application's FIRST date — the leave year it falls in is the year that is charged. */
    startDate: string;
    requestedDays: number;
    excludeRequestId?: string;
  },
): Promise<void> {
  if (p.requestedDays <= 0) return;
  const [lt] = await tx
    .select({
      name: leaveType.name,
      maxDaysPerLeaveYear: leaveType.maxDaysPerLeaveYear,
      maxDaysPeriod: leaveType.maxDaysPeriod,
      yearCycleOverride: leaveType.yearCycleOverride,
    })
    .from(leaveType)
    .where(eq(leaveType.id, p.leaveTypeId))
    .limit(1);
  // NULL ⇒ unlimited. A non-positive figure is refused by the DB CHECK and by the write-time validator, but
  // the guard is restated here so a hand-edited row cannot refuse every application of a type.
  if (!lt || lt.maxDaysPerLeaveYear == null) return;
  const limit = Number(lt.maxDaysPerLeaveYear);
  if (!Number.isFinite(limit) || limit <= 0) return;

  const [emp] = await tx
    .select({ companyId: employment.companyId, hiredOn: employment.hiredOn })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  if (!emp) return;
  const [co] = await tx
    .select({ leaveCycle: company.leaveCycle })
    .from(company)
    .where(eq(company.id, emp.companyId))
    .limit(1);
  // ad9cb5c5 — the window the ceiling is counted over. NULL ⇒ 'leave_year', so every type configured before
  // this existed keeps counting exactly as it did.
  //
  // Each branch resolves a real window; none of them takes the year off the date. 'calendar_year' is the
  // only one that legitimately can, and it is written out explicitly so the difference from 'leave_year' is
  // visible at the call site rather than hidden in a helper — the two coincide ONLY when the leave year
  // starts in January, and reading one as the other is the whole reason this option was asked for.
  const period = resolveApplicationLimitPeriod(lt.maxDaysPeriod);
  const { start, end } = applicationLimitWindow({
    period,
    hiredOn: String(emp.hiredOn),
    startDate: p.startDate,
    cycle: resolveLeaveYearCycle(lt.yearCycleOverride, co?.leaveCycle ?? null),
  });

  const [used] = await tx
    .select({ total: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, p.employmentId),
        eq(leaveRequest.leaveTypeId, p.leaveTypeId),
        inArray(leaveRequest.status, ['pending', 'approved']),
        gte(leaveRequest.startDate, start),
        lte(leaveRequest.startDate, end),
        ...(p.excludeRequestId ? [sql`${leaveRequest.id} <> ${p.excludeRequestId}`] : []),
      ),
    );
  const usedDays = round2(Number(used?.total ?? 0));
  if (round2(usedDays + p.requestedDays) > limit) {
    throw new LeaveYearApplicationLimitExceededError({
      leaveTypeName: lt.name,
      maxDaysPerLeaveYear: limit,
      usedDays,
      requestedDays: p.requestedDays,
      yearStart: start,
      yearEnd: end,
      period,
    });
  }
}

// ── Emergency Leave (0106) ─────────────────────────────────────────────────────────────────────────
// EL is an APPLICATION TYPE ONLY (no balance, no ledger). On submission requestLeave decomposes it into
// up to two ordinary child requests over the same dates: an ANNUAL request for the AL-covered portion and
// an UNPAID request for the remainder, linked by a shared parent_group_id. Everything downstream
// (approval chain, balance gate, ledger debit, payroll, history) reuses the existing code paths unchanged.
export const EMERGENCY_LEAVE_CODE = 'EMERGENCY';

/**
 * 65f466e2 — THE ROLE MARKER, and why every comparison above should now go through it.
 *
 * `EMERGENCY_LEAVE_CODE` and `STATUTORY_APPLY_CODES` are the codes the PACK SEEDS. They are kept, because
 * the seed still writes them and the backfill still matches on them — but they were never safe to compare
 * a tenant's catalogue against. Production's catalogue was not seeded: its codes are EL, RL, MTL, PTL, so
 * every `code === 'EMERGENCY'` comparison in this file was silently false and the behaviour behind it never
 * ran. `leave_type.role` is the tenant-independent answer to "what IS this type".
 *
 * NULL role = unclassified = pre-65f466e2 behaviour. Every reader below therefore asks the role FIRST and
 * falls back to the code, which is what keeps a tenant nobody has classified working exactly as before.
 */
export const LEAVE_TYPE_ROLES = [
  'annual',
  'sick',
  'hospitalization',
  'maternity',
  'paternity',
  'emergency',
  'replacement',
] as const;
export type LeaveTypeRole = (typeof LEAVE_TYPE_ROLES)[number];

/** The roles whose right to APPLY is statutory (EA 1955 s.60E/s.60F/s.37/s.60FA) — the role-side twin of
 *  STATUTORY_APPLY_CODES. Emergency is NOT here: it is locked against editing, not statutorily applicable. */
export const STATUTORY_APPLY_ROLES: readonly LeaveTypeRole[] = [
  'annual',
  'sick',
  'hospitalization',
  'maternity',
  'paternity',
];

/** Does this leave type play `role`? Role wins; an unclassified row falls back to the seeded code, so
 *  nothing changes for a tenant whose rows the backfill could not classify. */
export function leaveTypeIs(
  lt: { role?: string | null; code?: string | null } | null | undefined,
  role: LeaveTypeRole,
): boolean {
  if (lt == null) return false;
  if (lt.role != null && lt.role !== '') return lt.role === role;
  const code = (lt.code ?? '').toUpperCase();
  return code === role.toUpperCase();
}

/** Is this type one whose right to apply is statutory? Role first, seeded codes as the fallback. */
export function isStatutoryApplyType(lt: { role?: string | null; code?: string | null } | null | undefined): boolean {
  if (lt == null) return false;
  if (lt.role != null && lt.role !== '') return STATUTORY_APPLY_ROLES.includes(lt.role as LeaveTypeRole);
  return (STATUTORY_APPLY_CODES as readonly string[]).includes((lt.code ?? '').toUpperCase());
}

/** Round to 2 dp (mirrors the rest of the leave math). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure AL→UPL split resolver. Given the Annual balance and the span counted in Annual's own
 * (working-days) unit, cover as much as the balance allows from Annual and take the remainder as Unpaid.
 *   alCovered   = max(0, min(alBalance, alWorkingDays))
 *   alShortfall = round2(alWorkingDays − alCovered)  (the days that fall to Unpaid)
 * No DB, unit-testable. A negative balance yields alCovered 0 (everything to Unpaid).
 */
export function resolveEmergencyCascade(
  alBalance: number,
  alWorkingDays: number,
): { alCovered: number; alShortfall: number } {
  const alCovered = round2(Math.max(0, Math.min(alBalance, alWorkingDays)));
  const alShortfall = round2(alWorkingDays - alCovered);
  return { alCovered, alShortfall };
}

/**
 * Pure SICK→ANNUAL→UPL cascade for an illness-driven emergency (Phase-B #12, ADR-0061). Cover as much of
 * the working-days span as the paid SICK balance allows FIRST (EA s.60F is paid), then Annual, then the
 * remainder as Unpaid. `sickCovered` + `alCovered` + `alShortfall` always sum to the span (within 2 dp).
 * Negative balances clamp to 0. No DB — unit-testable. When sickBalance ≤ 0 this degrades to exactly the
 * AL→UPL split (sickCovered 0), so the non-illness path can reuse the same shape.
 */
export function resolveEmergencyIllnessCascade(
  sickBalance: number,
  alBalance: number,
  workingDays: number,
): { sickCovered: number; alCovered: number; alShortfall: number } {
  const sickCovered = round2(Math.max(0, Math.min(sickBalance, workingDays)));
  const afterSick = round2(workingDays - sickCovered);
  const alCovered = round2(Math.max(0, Math.min(alBalance, afterSick)));
  const alShortfall = round2(afterSick - alCovered);
  return { sickCovered, alCovered, alShortfall };
}

/** Inclusive whole-day count between two ISO dates (Slice 0 — no public-holiday logic yet). */
function dayCount(start: string, end: string): number {
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  return Math.floor((e - s) / 86_400_000) + 1;
}

function eachDate(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** True when `date` is a working day (Full OR Half) for the given ISO working-day roster (1=Mon … 7=Sun) and
 *  is not a holiday. Resolves rest days from the SAME source the attendance engine uses (audit H#3), never a
 *  hardcoded Sat/Sun. List/membership semantics only — for the DEDUCTED AMOUNT on a date use dayWeight. */
export function isWorkingDay(date: string, workingDaysIso: number[], holidays: Set<string>): boolean {
  return workingDaysIso.includes(isoWeekday(date)) && !holidays.has(date);
}

/** Working days in [start, end]: counts only days on the employee's configured working-day roster (ISO
 *  weekdays, default Mon–Fri, Full ∪ Half) that are not holidays. List/membership semantics — for the
 *  WEIGHTED (fractional half-day) total use workingDaysWeighted. */
export function workingDays(start: string, end: string, holidays: Set<string>, workingDaysIso: number[]): number {
  let n = 0;
  for (const d of eachDate(start, end)) {
    if (isWorkingDay(d, workingDaysIso, holidays)) n++;
  }
  return n;
}

/** The company's configured working-day roster for an employment (ISO weekday array, 1=Mon … 7=Sun),
 *  resolved from attendance_policy.workingDays — the SAME source core/attendance.ts uses. Falls back to the
 *  Mon–Fri default when no policy row exists, so existing single-company behaviour is unchanged (audit H#3).
 *  Kept as a thin wrapper over resolveSchedule for callers that only need list/membership semantics
 *  (Full ∪ Half, no weighting). */
export async function resolveWorkingDaysIso(tx: Tx, employmentId: string): Promise<number[]> {
  const sched = await resolveSchedule(tx, employmentId);
  return [...new Set([...sched.workingDaysIso, ...sched.halfDaysIso])];
}

/** Feedback 31474452 (4a): one query resolving an employment's full schedule — the company's configured
 *  Full working days, Half working days, and the company's half-day-deduction toggle. Falls back to
 *  Mon-Fri / no-half-days / toggle-off so existing single-company behaviour is byte-identical when no policy
 *  row or half-day marker exists (D2/back-compat). */
async function resolveSchedule(
  tx: Tx,
  employmentId: string,
): Promise<{ workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean }> {
  const [row] = await tx
    .select({
      workingDays: attendancePolicy.workingDays,
      halfWorkingDays: attendancePolicy.halfWorkingDays,
      halfCountsFull: company.leaveHalfDayFullDeduction,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return {
    workingDaysIso: row?.workingDays ?? DEFAULT_WORKING_DAYS_ISO,
    halfDaysIso: row?.halfWorkingDays ?? [],
    halfCountsFull: row?.halfCountsFull ?? false,
  };
}

/** Feedback 31474452 (4b): the leave-deduction WEIGHT of a single date — 0 for a holiday or a date on
 *  neither roster (rest day), 1 for a Full working day, and either 1.0 (toggle ON) or 0.5 (toggle OFF, the
 *  default) for a Half working day. No rounding — weights are exactly 0 / 0.5 / 1 so sums stay exact
 *  (rounding is only ever applied on the pre-existing hourly path). */
function dayWeight(
  date: string,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  holidays: Set<string>,
  // Day Type Inclusion (feedback ef6d7146): optional per-leave-type re-inclusion vector. When ABSENT
  // (undefined — every existing type / an all-off config, via normalizeDayTypeInclusion) this takes the
  // byte-identical legacy early-return path below, so nothing about today's counting changes. When present
  // it refines the working_days weighting: a public holiday counts 1 if inclusion.publicHoliday, and a
  // non-roster weekday (rest/off day) counts 1 if inclusion.restDay OR inclusion.offDay.
  inclusion?: DayTypeInclusion,
): number {
  if (inclusion === undefined) {
    // ── Legacy path (unchanged) — the golden-test guarantee. ──
    if (holidays.has(date)) return 0;
    const dowL = isoWeekday(date);
    if (sched.workingDaysIso.includes(dowL)) return 1;
    if (sched.halfDaysIso.includes(dowL)) return sched.halfCountsFull ? 1 : 0.5;
    return 0;
  }
  // ── Inclusion-aware refinement of working_days ──
  const dow = isoWeekday(date);
  if (holidays.has(date)) {
    // Phase A: every holiday is treated as a PUBLIC holiday for inclusion. companyHoliday/shutdownDay are
    // stored-but-inert (the public-vs-company scope split + the shutdown concept are Phase B), so a holiday
    // is re-included iff publicHoliday is on.
    return inclusion.publicHoliday ? 1 : 0;
  }
  if (sched.workingDaysIso.includes(dow)) return 1;
  if (sched.halfDaysIso.includes(dow)) return sched.halfCountsFull ? 1 : 0.5;
  // A non-roster weekday is a rest/off day. Phase A collapses restDay + offDay into this single bucket (the
  // statutory rest-vs-off weekday designation is Phase B), so it re-includes if EITHER toggle is on.
  return inclusion.restDay || inclusion.offDay ? 1 : 0;
}

/** True when `date` carries a non-zero leave DEDUCTION weight for the given schedule/holiday set and optional
 *  inclusion vector — i.e. it is a day this leave type actually deducts. When `inclusion` is undefined this is
 *  BYTE-IDENTICAL to isWorkingDay (a Full day weighs 1, a Half day 0.5 — both > 0 — and a holiday/rest day 0),
 *  so the membership set is unchanged for every existing type. With an inclusion vector it additionally admits
 *  re-included public-holiday / rest-day dates, keeping the cancellable/per-date set in agreement with the
 *  weighted total (workingDaysWeighted) so submission, per-date, preview and cancellation never drift. */
function isDeductibleDay(
  date: string,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  holidays: Set<string>,
  inclusion?: DayTypeInclusion,
): boolean {
  return dayWeight(date, sched, holidays, inclusion) > 0;
}

/** Feedback 31474452 (4c): the WEIGHTED sum of dayWeight over [start, end] — the real deducted-days total for
 *  a working_days-counted span, honouring Half-day markers + the company toggle. Degrades to workingDays()
 *  exactly when there are no half-day markers (empty halfDaysIso ⇒ every date weighs 0 or 1). */
function workingDaysWeighted(
  start: string,
  end: string,
  holidays: Set<string>,
  sched: { workingDaysIso: number[]; halfDaysIso: number[]; halfCountsFull: boolean },
  // Day Type Inclusion (feedback ef6d7146): threaded straight into dayWeight — undefined ⇒ byte-identical.
  inclusion?: DayTypeInclusion,
): number {
  let total = 0;
  for (const d of eachDate(start, end)) total += dayWeight(d, sched, holidays, inclusion);
  return round2(total);
}

/** The set of holiday dates in [start, end] for an employment, resolved business-group → state →
 *  national (ADR-0055; org-based override over ADR-0038 2C). Delegates to the unified resolver so leave
 *  and the Emergency-Leave path count a working-days span the same way attendance will. */
async function resolveHolidaySet(
  tx: Tx,
  employmentId: string,
  start: string,
  end: string,
): Promise<Set<string>> {
  return holidayDatesFor(tx, { employmentId, startDate: start, endDate: end });
}

/**
 * Shared insert+event+approval-step body for a single leave_request. Both the ordinary requestLeave path
 * and the Emergency-Leave children funnel through here so the event/approval-step wiring is never
 * duplicated. The caller has already computed `days` in the type's own counting mode and run every gate.
 */
async function insertLeaveRequest(
  tx: Tx,
  ctx: SessionContext,
  v: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    days: number;
    durationType: LeaveDurationType;
    hours: number | null;
    // Hourly-leave time window (0129): the From/To window for an hourly request (HH:MM). Optional — null for
    // full_day / half_day rows and for the Emergency-Leave children (which are always full-day).
    fromTime?: string | null;
    toTime?: string | null;
    reason: string | null;
    employeeRemark: string | null;
    parentGroupId: string | null;
    mandatoryAfterDays: number | null;
    // Phase-B #12 (ADR-0061): set on the UNPAID child of a consented Emergency-Leave submission only.
    unpaidConsentAt?: Date | null;
    unpaidConsentBy?: string | null;
    // Allow Unpaid Leave (a7fab30b): the part of `days` the balance could not cover. Absent/0 ⇒ stored NULL
    // (fully paid), which is every request of a type that has not opted in.
    unpaidDays?: number | null;
    // Phase-B #13 (ADR-0062): EA s.37 maternity paid-allowance facts + per-request override. Non-null only
    // for a MATERNITY request; maternityAllowanceEvent carries the decision onto the submitted event.
    survivingChildren?: number | null;
    confinementDate?: string | null;
    allowanceEligible?: boolean | null;
    maternityAllowanceEvent?: Record<string, unknown> | null;
    // Configurable backdated-leave restriction (0133): set only when an HR admin SUCCESSFULLY overrode the
    // limit (the request is backdated beyond the type's window but isAdmin let it through). Stamps the
    // override onto the submitted event payload for the audit trail (CLAUDE.md substrate discipline: an admin
    // bypassing a configured control must be captured). null/absent ⇒ normal in-window request; payload
    // unchanged so existing assertions stay green.
    backdatingAudit?: { daysBackdated: number; backdatingLimitDays: number | null } | null;
    // Minimum advance-notice rule (0159): set only when an HR admin SUCCESSFULLY overrode the rule (the
    // request lacks the type's required notice but isAdmin let it through). Stamps the override onto the
    // submitted event payload for the audit trail (CLAUDE.md substrate discipline: an admin bypassing a
    // configured control must be captured). null/absent ⇒ normal in-notice request; payload unchanged so
    // existing assertions stay green. Mirrors backdatingAudit above.
    // 7daac043 — `daysInAdvance` is measured in `dayType`'s unit, so the unit is stamped WITH it. Without it
    // "5" on a working-days type and "5" on a calendar-days type are the same number describing different
    // amounts of notice, and the history stops being readable the moment a tenant configures both.
    minAdvanceAudit?: {
      daysInAdvance: number;
      minAdvanceDays: number | null;
      dayType: AdvanceNoticeDayType;
    } | null;
    // Leave Year Configuration (9aa894a4): set only when an HR admin SUCCESSFULLY overrode the not-yet-open
    // gate (the request is for a future leave year that is not open, but isAdmin let it through). Stamps the
    // override onto the submitted event payload for the audit trail. null/absent ⇒ normal request; payload
    // unchanged. Mirrors backdatingAudit / minAdvanceAudit above.
    leaveYearAudit?: { targetYear: number } | null;
    // Override Leave Application (56910869): set only when an HR-configured override rule actually CHANGED
    // this application (converted it to another type, or split part of it unpaid) with the employee's
    // explicit confirmation. Stamped on the submitted event so an auditor can tell a converted application
    // from one filed directly as Emergency Leave, and from an HR-side advance-notice override. null/absent
    // ⇒ nothing extra on the payload, so every existing assertion stays green.
    overrideAudit?: LeaveOverrideAudit | null;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(leaveRequest)
    .values({
      tenantId: ctx.tenantId,
      employmentId: v.employmentId,
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      days: v.days.toFixed(2),
      durationType: v.durationType,
      hours: v.hours != null ? v.hours.toFixed(2) : null,
      // Hourly-leave time window (0129): persisted only for hourly rows; null otherwise.
      fromTime: v.fromTime ?? null,
      toTime: v.toTime ?? null,
      status: 'pending',
      reason: v.reason,
      employeeRemark: v.employeeRemark,
      parentGroupId: v.parentGroupId,
      unpaidConsentAt: v.unpaidConsentAt ?? null,
      unpaidConsentBy: v.unpaidConsentBy ?? null,
      unpaidDays: v.unpaidDays ? v.unpaidDays.toFixed(2) : null,
      survivingChildren: v.survivingChildren ?? null,
      confinementDate: v.confinementDate ?? null,
      allowanceEligible: v.allowanceEligible ?? null,
    })
    .returning({ id: leaveRequest.id });
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: row.id,
    eventType: 'leave-request.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: v.employmentId,
    payload: {
      employmentId: v.employmentId,
      leaveTypeId: v.leaveTypeId,
      startDate: v.startDate,
      endDate: v.endDate,
      days: v.days,
      durationType: v.durationType,
      hours: v.hours,
      // Hourly-leave time window (0129): carry the From/To window onto the submitted event for the audit
      // trail / approver view. Present only for hourly rows. The decision (approve/reject) event deliberately
      // does NOT re-stamp the window — it is immutable on the row and queryable, so re-stamping is redundant.
      ...(v.fromTime ? { fromTime: v.fromTime } : {}),
      ...(v.toTime ? { toTime: v.toTime } : {}),
      mandatoryAfterDays: v.mandatoryAfterDays,
      hasRemark: !!v.employeeRemark,
      // Allow Unpaid Leave (a7fab30b): stamp the paid/unpaid split so an auditor can see what the balance
      // covered AT SUBMISSION — the balance moves afterwards, so the figure cannot be recomputed later. Only
      // present when some days are unpaid ⇒ the ordinary payload is byte-identical to before.
      ...(v.unpaidDays ? { unpaidDays: v.unpaidDays, paidDays: round2(v.days - v.unpaidDays) } : {}),
      ...(v.parentGroupId ? { parentGroupId: v.parentGroupId } : {}),
      // Phase-B #13 (ADR-0062): the s.37 paid-allowance decision for the audit trail / approver view.
      ...(v.maternityAllowanceEvent ? { maternityAllowance: v.maternityAllowanceEvent } : {}),
      // Configurable backdated-leave restriction (0133): when an HR admin overrode the type's backdating
      // limit, stamp it so an auditor can see this was a backdated override (vs an in-window request). Only
      // present on the override path — the normal-path payload is byte-identical to before.
      ...(v.backdatingAudit
        ? {
            backdatedOverride: true,
            daysBackdated: v.backdatingAudit.daysBackdated,
            backdatingLimitDays: v.backdatingAudit.backdatingLimitDays,
          }
        : {}),
      // Minimum advance-notice rule (0159): when an HR admin overrode the type's required notice, stamp it so
      // an auditor can see this was a short-notice override (vs an in-notice request). Only present on the
      // override path — the normal-path payload is byte-identical to before. Mirrors backdatedOverride above.
      ...(v.minAdvanceAudit
        ? {
            advanceNoticeOverride: true,
            daysInAdvance: v.minAdvanceAudit.daysInAdvance,
            minAdvanceDays: v.minAdvanceAudit.minAdvanceDays,
            // 7daac043: the UNIT both figures above are in. Stamped always (not only for working days) so
            // an auditor never has to infer it from the leave type's CURRENT configuration, which may have
            // been changed since.
            advanceNoticeDayType: v.minAdvanceAudit.dayType,
          }
        : {}),
      // Leave Year Configuration (9aa894a4): when an HR admin applied for a future leave year that is not yet
      // open, stamp it so an auditor sees this was an override (vs a normal in-window request). Only present
      // on the override path — the normal-path payload is byte-identical to before.
      ...(v.leaveYearAudit
        ? { leaveYearNotOpenOverride: true, targetLeaveYear: v.leaveYearAudit.targetYear }
        : {}),
      // Override Leave Application (56910869) — THE AUDIT STAMP, and the reason it looks like this.
      //
      // A converted application re-stamps the SAME advanceNoticeOverride / daysInAdvance / minAdvanceDays
      // trio the HR-side override writes above, because it IS an override of that same rule and an auditor
      // querying "which applications went through despite the notice period" must find both. What tells the
      // two apart — and tells a CONVERTED application apart from one the employee filed as Emergency Leave
      // in the first place, which was the whole point — is `leaveOverrideApplied` plus the rule that fired
      // and the type it came FROM. A natively-Emergency application carries none of these keys.
      ...(v.overrideAudit
        ? {
            leaveOverrideApplied: true,
            overrideTrigger: v.overrideAudit.trigger,
            overrideAction: v.overrideAudit.action,
            overrideConsentAt: v.overrideAudit.consentAt,
            ...(v.overrideAudit.fromLeaveTypeId
              ? {
                  convertedFromLeaveTypeId: v.overrideAudit.fromLeaveTypeId,
                  convertedFromLeaveTypeName: v.overrideAudit.fromLeaveTypeName,
                }
              : {}),
            ...(v.overrideAudit.trigger === 'advance_notice_not_met'
              ? {
                  advanceNoticeOverride: true,
                  daysInAdvance: v.overrideAudit.daysInAdvance,
                  minAdvanceDays: v.overrideAudit.minAdvanceDays,
                  // 7daac043: same reason as the HR-side stamp above — the unit the two figures are in.
                  ...(v.overrideAudit.dayType ? { advanceNoticeDayType: v.overrideAudit.dayType } : {}),
                }
              : {}),
            ...(v.overrideAudit.alsoSplitUnpaid ? { overrideAlsoSplitUnpaid: true } : {}),
            ...(v.overrideAudit.unpaidDays != null
              ? { overridePaidDays: v.overrideAudit.paidDays, overrideUnpaidDays: v.overrideAudit.unpaidDays }
              : {}),
          }
        : {}),
    },
  });
  // 2B-1/2B-2/ADR-0071: if the company runs a multi-step chain, generate the instance approval steps,
  // resolving the scoped rule matrix against this request's day count (fractional for hourly/partial).
  await generateApprovalSteps(tx, ctx.tenantId, row.id, v.employmentId, v.leaveTypeId, v.days);
  return { id: row.id };
}

/** requestLeave's result. `leaveRequestId` is the created request (the AL child, else the UPL child, for
 *  an EL submission). `parentGroupId` is non-null only for an Emergency-Leave submission; `children` lists
 *  every created request (one for an ordinary request; one or two for EL). */
export type RequestLeaveResult = {
  leaveRequestId: string;
  days: number;
  parentGroupId: string | null;
  children: { id: string; code: string; days: number }[];
  // Phase-B #13 (ADR-0062): set true when a MATERNITY request was submitted WITHOUT the s.37 inputs
  // (surviving-children + confinement date), so the allowance eligibility could not be confirmed. The leave
  // is still granted PAID (the conservative default), but HR is warned the paid-allowance is unconfirmed.
  maternityAllowanceWarning?: boolean;
  // Phase-B #15: NON-BLOCKING holiday-completeness warning(s) — present when the request's (state, year)
  // has fewer than the EA s.60D minimum of 11 gazetted holidays loaded, so the working-day count may be
  // wrong until HR finishes loading the state gazette. The request is still created.
  holidayWarnings?: HolidayCompletenessWarning[];
};

/**
 * Every `leave_type` column a submission needs, as ONE drizzle select shape.
 *
 * Extracted (56910869) because a submission can now read a type row TWICE: once for the type the employee
 * chose, and — when an Override Leave Application rule converts the application — once for the type it
 * becomes. Two hand-copied column lists is how the converted application ends up judged by a different set
 * of rules than the original would have been (the same failure `leaveTypeRuleColumns` exists to prevent one
 * layer down). One list, both reads.
 */
const leaveTypeRequestColumns = {
  id: leaveType.id,
  code: leaveType.code,
  // 65f466e2 — selected on every request path because the special-treatment gates below (Emergency's
  // advance-notice exemption, the balance-source guards, the conversion) now ask the ROLE, not the code.
  // Omitting it here would make every one of those gates read `undefined` and silently fall back to the
  // code comparison that was already dead on this tenant.
  role: leaveType.role,
  name: leaveType.name,
  counting: leaveType.counting,
  eligibility: leaveType.eligibility,
  // Probation eligibility (d6bdbd55): merged into the eligibility object below so the probation gate
  // rides the same assertEligible check as gender/marital/min-service.
  probationEligibility: leaveType.probationEligibility,
  // Day Type Inclusion (feedback ef6d7146): the re-inclusion vector — threaded into the working_days
  // counting below so the deducted `days` honours which day types this type counts.
  dayTypeInclusion: leaveType.dayTypeInclusion,
  requiresDocument: leaveType.requiresDocument,
  mandatoryAfterDays: leaveType.mandatoryAfterDays,
  employeeRemarkRequired: leaveType.employeeRemarkRequired,
  durations: leaveType.durations,
  perDateApproval: leaveType.perDateApproval,
  backdatingLimitDays: leaveType.backdatingLimitDays,
  // Minimum advance-notice rule (0159): required days of notice before the start date.
  minAdvanceDays: leaveType.minAdvanceDays,
  // Advance Notice — calendar days or working days (7daac043, migration 0447): the UNIT that requirement is
  // read in. MUST be selected here or every request path reads `undefined`, resolveAdvanceNoticeDayType
  // falls back to calendar days, and a type configured for working days would be silently judged on the
  // wall calendar — the rule would look configured and do nothing.
  minAdvanceDayType: leaveType.minAdvanceDayType,
  // Custom validation messages (custom-messages migration): the admin-authored override map, keyed by
  // rule config field. Passed through the typed error so the localizer shows it verbatim.
  customMessages: leaveType.customMessages,
  // Leave Type Employee Visibility (7b11f1c1): the can-apply switch. false ⇒ an ordinary employee may
  // not apply for this type (rejected below); NULL ⇒ can apply (today's behaviour). isAdmin bypasses.
  employeeCanApply: leaveType.employeeCanApply,
  // Duplicate Leave Application Restriction (d5e51c34): the same-date double-booking policy, enforced
  // below AFTER the AM/PM slot-clash guard. null ⇒ 'allow' (no extra check).
  duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
  // Configurable Negative Leave Balance Validation (0ef0defd): false ⇒ reject a submit that would take
  // the balance negative (enforced below, after `days` is known); true ⇒ skip the submit-time check.
  allowNegativeBalance: leaveType.allowNegativeBalance,
  // Balance Deduction Source (cdf9ca48) / Allow Unpaid Leave (a7fab30b): the two settings that decide
  // WHICH balance this application is measured against and what happens to the part it cannot cover.
  // Both are read here and used together below — see the balance guard.
  balanceSourceTypeId: leaveType.balanceSourceTypeId,
  allowUnpaidLeave: leaveType.allowUnpaidLeave,
  // Override Leave Application (56910869): what HR has configured to happen when one of the rules above is
  // not met. NULL / empty ⇒ nothing at all changes — the refusals below stand exactly as they do today.
  overrideRules: leaveType.overrideRules,
} as const;

/**
 * What an applied Override rule stamps on the submitted event (56910869).
 *
 * WHY IT EXISTS AT ALL: the HR-side advance-notice override already writes `advanceNoticeOverride` +
 * `daysInAdvance` + `minAdvanceDays` onto the submitted event, and without an equivalent here an auditor
 * looking at a converted application could not tell it from one the employee filed as Emergency Leave in
 * the first place. So a conversion stamps that SAME trio (an override of the same rule is an override of
 * the same rule) PLUS the fields that say it was the EMPLOYEE's confirmed election under a configured rule
 * rather than HR acting on their behalf: which rule fired, and which type the application came FROM.
 */
type LeaveOverrideAudit = {
  trigger: LeaveOverrideTrigger;
  action: LeaveOverrideAction;
  /** The type the employee originally applied for (absent for a rule that does not convert). */
  fromLeaveTypeId?: string;
  fromLeaveTypeName?: string;
  /** Advance-notice trigger — the same pair the HR override stamps, plus (7daac043) the unit
   *  `daysInAdvance` is measured in, without which the figure is ambiguous. */
  daysInAdvance?: number;
  minAdvanceDays?: number | null;
  dayType?: AdvanceNoticeDayType;
  /** Insufficient-balance trigger — the split as it was measured at submission. */
  paidDays?: number;
  unpaidDays?: number;
  /** Set when a SECOND rule also fired on the same application: the notice-period conversion is the
   *  headline (`trigger`/`action` name it) and the balance split rode along on the converted application.
   *  Both facts are kept because either one alone misdescribes what the employee agreed to. */
  alsoSplitUnpaid?: boolean;
  /** When the employee confirmed. The confirmation is the record that protects both sides. */
  consentAt: string;
};

// ── Apply-on-behalf permission (5206539f) ────────────────────────────────────────────────────────────
/**
 * Does this caller hold `leave.apply_on_behalf` — the named permission to submit leave for an employee who
 * is not them? Company-scoped override rows win over tenant-wide rows, which win over the code defaults in
 * lib/payroll-permissions.ts (hr_admin + super_admin, and nobody else, on the day this ships).
 *
 * WHAT IT REPLACES. Nothing checked this before. The Leave screen offered an Employee selector to anyone
 * with a direct report, and the submission accepted whatever employmentId the form posted, so "does anyone
 * report to you" was the de-facto permission — an accident of the org chart, and one that RLS could never
 * fence because RLS here is SYMMETRIC: a manager can legitimately SEE a subordinate's employment, which
 * makes the write pass every policy on the table.
 *
 * Read inside the caller's own tx: the grant table is tenant-readable under RLS.
 */
async function resolveApplyOnBehalfTx(tx: Tx, ctx: SessionContext, companyId: string | null): Promise<boolean> {
  const rows = await tx
    .select({
      role: payrollPermissionGrant.role,
      allowed: payrollPermissionGrant.allowed,
      companyId: payrollPermissionGrant.companyId,
    })
    .from(payrollPermissionGrant)
    .where(
      and(
        eq(payrollPermissionGrant.tenantId, ctx.tenantId),
        eq(payrollPermissionGrant.permissionKey, 'leave.apply_on_behalf'),
        companyId
          ? or(isNull(payrollPermissionGrant.companyId), eq(payrollPermissionGrant.companyId, companyId))
          : isNull(payrollPermissionGrant.companyId),
      ),
    );
  return decidePayrollPermission({
    key: 'leave.apply_on_behalf',
    // Delegated grants count exactly as directly-assigned roles do, mirroring core/payroll.ts's callerRolesOf.
    callerRoles: [...(ctx.roles ?? []), ...(ctx.grants ?? []).map((g) => g.role)],
    overrides: rows.map((r) => ({ role: r.role, allowed: r.allowed, companyScoped: r.companyId != null })),
  });
}

/**
 * The SAME question, asked by the screen (app/leave/page.tsx) so the Employee selector is rendered only for
 * a holder. Exported deliberately: the selector's visibility and the submission's refusal must be one
 * decision resolved in one place, or they drift the moment either side is edited. Hiding the selector is
 * the courtesy; the throw inside requestLeave below is the control.
 *
 * `companyId` narrows to a company-scoped override when the caller's own company is known.
 */
export function canApplyLeaveOnBehalf(ctx: SessionContext, companyId?: string | null): Promise<boolean> {
  return withTenant(ctx, (tx) => resolveApplyOnBehalfTx(tx, ctx, companyId ?? null));
}

export async function requestLeave(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    hasDocument?: boolean; // 2A-2: asserts a supporting document accompanies this request
    employeeRemark?: string; // doc-config: required when the type sets employeeRemarkRequired
    durationType?: LeaveDurationType; // ADR-0048: defaults to 'full_day'
    hours?: number; // ADR-0048: legacy/importer hourly figure — used only when fromTime/toTime are absent
    // Hourly-leave time window (0129): when durationType==='hourly' these are MANDATORY; `hours` is derived
    // from (toTime - fromTime). The raw `hours` path above is the back-compat fallback for importer/legacy
    // callers that don't supply a window.
    fromTime?: string;
    toTime?: string;
    // Phase-B #12 (ADR-0061) — Emergency-Leave only:
    reasonCategory?: EmergencyReasonCategory; // 'illness' routes through paid SICK first
    unpaidConsent?: boolean; // the employee's acknowledgement of the unpaid days (gates UNPAID children)
    // Phase-B #13 (ADR-0062) — MATERNITY only: the s.37 paid-allowance facts at confinement. When both are
    // supplied the per-request allowance eligibility is computed and OVERRIDES the leave-type paid default
    // (withheld ⇒ leave granted UNPAID). When absent the leave stays paid + a maternityAllowanceWarning fires.
    survivingChildren?: number;
    confinementDate?: string;
    // Configurable backdated-leave restriction (0133): the tenant-local "today" (ISO yyyy-mm-dd) against
    // which the backdating window is judged. The action layer computes it in Asia/Kuala_Lumpur and passes it
    // in; core defaults to todayInKualaLumpur() so importer/legacy callers still work.
    today?: string;
    // Override Leave Application (56910869): the employee's EXPLICIT confirmation of the rule(s) that will
    // change this application, as `trigger:action` tokens (leaveOverrideConsentToken). Absent ⇒ no consent,
    // and any converting rule that fires throws LeaveOverrideConsentRequiredError BEFORE anything is
    // persisted. One token per rule rather than a single boolean, because two rules can fire on ONE
    // application (convert on short notice AND split on insufficient balance) and agreeing to one is not
    // agreeing to the other.
    overrideConsent?: string | readonly string[];
  },
): Promise<RequestLeaveResult> {
  return withTenant(ctx, async (tx) => {
    // ── On-behalf gate (5206539f) — THE FIRST THING THIS FUNCTION DOES, and deliberately ────────────────
    // Submitting leave for an employment that is not the caller's own requires `leave.apply_on_behalf`.
    //
    // ENFORCED HERE RATHER THAN IN THE ACTION, because the action is only one door: requestLeaveAction
    // passed the posted employmentId straight through, and any future caller (an importer, a chatbot, a
    // second screen) would have inherited the same hole. Mirrors requestLeaveCancellation's §6(1)
    // subject-only check, which is enforced in code for the same reason: RLS here is SYMMETRIC — a manager
    // may legitimately SEE a subordinate's employment, so every row policy passes and the write is allowed.
    // Hiding the Employee selector (app/leave/page.tsx) is the courtesy; this throw is the control.
    //
    // ABOVE the Emergency-Leave short-circuit below, which returns into a whole separate submission path,
    // and above every other gate: nothing is read or written on behalf of someone the caller may not act for.
    const [subject] = await tx
      .select({ personId: employment.personId, companyId: employment.companyId })
      .from(employment)
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    // Self is decided by PERSON, not by employment id: one person can hold several employments (multi-company
    // groups), and all of them are still their own leave. A caller with no personId (a service/admin context
    // not tied to an employee) can never satisfy this, and falls to the permission below — which is where an
    // HR administrator has always passed.
    const isSelfSubject = ctx.personId != null && subject?.personId != null && ctx.personId === subject.personId;
    // AN EMPLOYMENT THE CALLER CANNOT SEE IS REFUSED HERE, not thirty gates later by a policy violation. The
    // select above runs under the caller's own RLS, so `subject` is undefined for an employment outside their
    // scope — a company-scoped hr_admin naming another company's employee, say — and for one that does not
    // exist at all. Both used to fall through: `companyId ?? null` judged the permission against tenant-wide
    // overrides only, the holder passed, and the request was costed, counted and validated before the final
    // INSERT tripped `app.can_see_employment` and threw a raw Postgres error no locale owns. Refusing now
    // makes the paragraph above true (nothing is read or written for someone the caller may not act for),
    // gives the screen the same translated sentence it gives a line manager, and stops the two outcomes
    // being distinguishable — "not visible" and "does not exist" are one answer, so this is no existence
    // oracle. Note the knock-on: `subject.companyId` below is now the REAL company, never a null stand-in,
    // so a company-scoped grant is resolved in the company the leave is actually being filed in.
    if (!isSelfSubject && !(subject && (await resolveApplyOnBehalfTx(tx, ctx, subject.companyId)))) {
      throw new LeaveOnBehalfNotAllowedError();
    }

    // Day count depends on the leave type: working-days (excl weekends + holidays) vs calendar.
    const [lt0] = await tx
      .select(leaveTypeRequestColumns)
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    // 56910869 — `lt` and `p` are REASSIGNABLE from here on because an Override Leave Application rule can
    // convert this application to another leave type mid-flight (see the advance-notice gate below). The
    // conversion re-points BOTH so every gate after it is judged against the type the application actually
    // becomes, rather than a second submission path re-implementing them. Nothing else reassigns either.
    let lt = lt0;
    let overrideAudit: LeaveOverrideAudit | null = null;

    // Emergency Leave (0106): an application type only — decompose into ANNUAL + UNPAID children over the
    // same dates before the normal single-request path. No EMERGENCY row is ever persisted.
    //
    // Balance Deduction Source (cdf9ca48): UNLESS an administrator has given EL an explicit balance source.
    // The reporter's whole ask is that Emergency Leave draw down Annual Leave and still appear in the leave
    // history AS Emergency Leave — which is precisely what the hardcoded decomposition cannot do, since it
    // persists ANNUAL + UNPAID rows and no EMERGENCY row at all. Offering the setting on EL and then ignoring
    // it would be the config-trap this panel already goes out of its way to avoid (see the hidden backdating /
    // advance-notice fields for EL). So: no source configured ⇒ the decomposition, byte-identical to today and
    // still the default; a source configured ⇒ EL takes the ordinary single-request path like any other type.
    if (leaveTypeIs(lt, 'emergency') && lt.balanceSourceTypeId == null) {
      return requestEmergencyLeave(tx, ctx, p);
    }

    // Doc-config: the mandatory-document gate moved BELOW day-counting (it now depends on `days` vs
    // mandatoryAfterDays). The eligibility gate stays here — it does not depend on `days`.

    // Eligibility gate (2A-1, #25) — fail fast before anything is created. Probation (d6bdbd55) is stored in
    // its own column; merge it into the eligibility object so the one gate covers every rule.
    const baseElig = (lt?.eligibility ?? null) as LeaveEligibility | null;
    const probation = (lt?.probationEligibility ?? null) as ProbationEligibility | null;
    const elig: LeaveEligibility | null =
      baseElig || probation ? { ...(baseElig ?? {}), ...(probation ? { probation } : {}) } : null;
    if (elig && hasAnyEligibilityRestriction(elig)) {
      const [emp] = await tx
        .select({
          gender: person.gender,
          marital: person.maritalStatus,
          hiredOn: employment.hiredOn,
          confirmationDate: employment.confirmationDate,
          finalConfirmationDate: employment.finalConfirmationDate,
          // Organisation Assignment criteria: the eight org columns live ON employment (already the FROM root),
          // so widening this existing SELECT is sufficient — no new join, no as-of choice.
          orgDivision: employment.orgDivision,
          orgBranch: employment.orgBranch,
          orgRegion: employment.orgRegion,
          orgLine: employment.orgLine,
          orgSection: employment.orgSection,
          orgTeam: employment.orgTeam,
          orgBase: employment.orgBase,
          employmentCategory: employment.employmentCategory,
        })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, p.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
    }

    // Leave Type Employee Visibility (7b11f1c1) — can-apply gate. When HR has set employee_can_apply=false,
    // an ordinary employee may not submit a request for this type ("can look but can't apply"). This is the
    // SERVER-SIDE authority behind the apply-dropdown filter (listEligibleLeaveTypesFor), so the rule holds
    // even if the UI is bypassed. HR admins (isAdmin) bypass it — like backdating / min-advance below — so HR
    // can still book this leave on the employee's behalf. NULL ⇒ can apply (backward compatible). The
    // statutory guard in updateLeaveType prevents this ever being set on a lawful-entitlement code, so this
    // gate can never block a statutory leave. Fails fast before any write, like the eligibility gate above.
    if (!isAdmin(ctx) && lt?.employeeCanApply === false) {
      throw new LeaveApplyNotAllowedError(lt?.name);
    }

    // Configurable backdated-leave restriction (0133). Non-HR users are blocked when the request's start date
    // (the earliest, most-backdated day of the request) is older than the type's window; HR admins (isAdmin)
    // bypass for exceptional cases (the override path). `today` is judged in the tenant's local (MYT) calendar
    // — supplied by the action layer, defaulting to todayInKualaLumpur() — so the boundary is not UTC-skewed.
    // It does not depend on `days`, so it fails fast like the eligibility gate. Emergency Leave already
    // returned above (it is inherently retroactive and the field is hidden for it in the admin UI).
    const today = p.today ?? todayInKualaLumpur();
    const limit = lt?.backdatingLimitDays ?? null;
    const backdatedOverride = isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, limit);
    if (!isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, limit)) {
      // Custom validation messages (custom-messages migration): pass the admin-authored override for THIS
      // rule (keyed by its config field name) through the typed error so the localizer renders it verbatim;
      // absent ⇒ the built-in localized default. A future rule follows the same look-up-then-pass-through
      // pattern (customMessages[ruleKey]) plus a branch in the action-layer localizer.
      throw new LeaveBackdatingNotAllowedError(limit!, lt?.name, lt?.customMessages?.backdatingLimitDays || undefined);
    }

    // Minimum advance-notice rule (0159 / feedback 0b0fb6c3). Non-HR users are blocked when the request's
    // start date arrives with fewer than the type's minAdvanceDays days of notice ("Annual Leave must be
    // submitted at least 7 days before the leave start date"); HR admins (isAdmin) bypass for exceptional
    // cases (the override path, stamped onto the submitted event below). Judged against the same tenant-
    // local (MYT) `today` as the backdating gate and fails fast BEFORE any write. Emergency Leave already
    // returned above — it exists precisely for short-notice absence (the reporter's custom message points
    // employees to it) and the field is hidden for EL in the admin UI.
    //
    // Advance Notice — calendar days or working days (7daac043, migration 0447). The requirement is now
    // read in a configurable UNIT. The two extra reads the working-days unit needs (the roster and the
    // holiday set) are GUARDED so the calendar path — every leave type until an administrator changes one,
    // and the only path any existing tenant takes — issues no new query at all. The third condition,
    // `p.startDate > today`, is not an optimisation for its own sake: a backdated start makes the notice
    // window EMPTY, so the count is 0 whatever the roster says, and querying for it would be asking a
    // question whose answer cannot matter.
    const minAdvance = lt?.minAdvanceDays ?? null;
    const minAdvanceDayType = resolveAdvanceNoticeDayType(lt?.minAdvanceDayType);
    let noticeRoster: number[] | undefined;
    let noticeHolidays: Set<string> | undefined;
    if (minAdvance != null && minAdvanceDayType === 'working_days' && p.startDate > today) {
      // The SAME sources the deduction engine uses — attendance_policy.working_days (Full ∪ Half) and the
      // business-group → state → national holiday resolution — so "working day" means one thing in this
      // product, not two.
      noticeRoster = await resolveWorkingDaysIso(tx, p.employmentId);
      noticeHolidays = await resolveHolidaySet(tx, p.employmentId, today, p.startDate);
    }
    // Computed ONCE and reused: the gate below, the HR-override audit stamp, and the Override-rule
    // conversion payload must all quote the same figure, in the same unit.
    const noticeGiven = noticeDaysGiven(today, p.startDate, minAdvanceDayType, noticeRoster, noticeHolidays);
    const lacksNotice = minAdvance != null && noticeGiven < minAdvance;
    const advanceOverride = isAdmin(ctx) && lacksNotice;
    const consent = parseLeaveOverrideConsent(p.overrideConsent);
    if (!isAdmin(ctx) && lacksNotice) {
      // ── Override Leave Application (56910869) · TRIGGER 1: advance notice not met ──────────────────
      //
      // THIS IS 65f466e2, SHIPPED AS A RULE RATHER THAN A BRANCH. Absent a rule — which is every leave type
      // until HR enables one — nothing below this block runs and the refusal is byte-identical to today's.
      // An enabled `block` rule also lands on that same refusal, deliberately: HR having decided to refuse
      // and nobody having decided yet must produce the same answer for the employee, and differ only in
      // what the configuration screen can say about it.
      const rule = resolveLeaveOverrideRule(normalizeLeaveOverrideRules(lt?.overrideRules), 'advance_notice_not_met');
      // A conversion out of Emergency Leave is meaningless (it is where conversions GO), and a type
      // converting to itself would loop. Both are refused by the vocabulary, but the guard is cheap and the
      // failure would be an infinite re-entry rather than a wrong answer.
      //
      // 65f466e2 — the SELF-CONVERSION guard is now identity-based, not code-based. `lt.code !== 'EMERGENCY'`
      // was never true on this tenant (its code is `EL`), so it protected nothing here; and with a
      // configurable target, "converts to itself" can only be answered by comparing ids. A rule whose
      // target IS this very type is treated as no rule at all — the ordinary refusal — which is the same
      // safe landing normalizeLeaveOverrideRules takes for anything it cannot make sense of.
      const convertsToSelf = rule?.targetLeaveTypeId != null && rule.targetLeaveTypeId === p.leaveTypeId;
      if (rule?.action === 'convert_to_emergency' && !convertsToSelf && !leaveTypeIs(lt, 'emergency')) {
        // ROUTE THROUGH THE EXISTING ENGINE. The target type is read with the SAME column shape, so every
        // rule the ordinary path applies is applied to the converted application too — including, crucially,
        // Emergency Leave's own BALANCE DEDUCTION SOURCE. That is the point of 65f466e2 and the reason the
        // conversion must not invent a second path: Emergency is a CATEGORY, not an entitlement, so a
        // converted application still deducts from whatever source HR pointed Emergency Leave at (Annual),
        // exactly as a directly-filed Emergency application does.
        // 65f466e2 — THE TARGET IS CONFIGURATION, NOT A CODE THE SOFTWARE ASSUMES.
        //
        // This used to look up `code = 'EMERGENCY'` unconditionally. Production's Emergency Leave type is
        // coded `EL`, so the query returned nothing, this threw LeaveOverrideTargetMissingError, and every
        // employee who clicked "Yes" to the conversion prompt was refused — before any entitlement was
        // consulted. The reporter read that refusal as "it is demanding an Emergency Leave entitlement";
        // it never got that far. Any tenant who names their codes differently hit the same wall.
        //
        // Precedence: the rule's chosen target wins; absent one, fall back to the code lookup so rules
        // written before this field existed behave exactly as they do today rather than changing on deploy.
        // THREE STEPS, IN THIS ORDER — and step 2 is what actually fixes production on deploy day.
        //   1. the target HR chose on the rule;
        //   2. failing that, the type whose ROLE is 'emergency' — 0387 classified production's `EL` row,
        //      so the conversion starts working with NO configuration change by the tenant. Without this
        //      step the fix would require HR to first open a rule editor and pick a target, which is not
        //      a fix, it is a workaround with extra steps;
        //   3. failing that, the seeded code, which is the pre-65f466e2 behaviour for an unclassified
        //      tenant and must stay reachable so nothing changes underneath them.
        // Ordered by id so a tenant that somehow carries two 'emergency' rows resolves deterministically
        // rather than by whatever the planner returned first (0387 raises a WARNING in that case).
        // Ordered by id so a tenant carrying two candidate rows resolves deterministically rather than by
        // whatever the planner happened to return first (0387 raises a WARNING if it finds such a pair).
        const findTarget = (where: SQL | undefined) =>
          tx.select(leaveTypeRequestColumns).from(leaveType).where(where).orderBy(leaveType.id).limit(1);

        let target: Awaited<ReturnType<typeof findTarget>>[number] | undefined;
        if (rule.targetLeaveTypeId) {
          // 1. What HR chose. If it has since been archived we do NOT silently fall through to another
          //    type — converting into something the tenant did not pick would be worse than refusing.
          [target] = await findTarget(and(eq(leaveType.id, rule.targetLeaveTypeId), isNull(leaveType.archivedAt)));
        } else {
          // 2. The type whose ROLE is emergency. 0387 classified production's `EL` row, so the conversion
          //    starts working on deploy with NO configuration change by the tenant.
          [target] = await findTarget(and(eq(leaveType.role, 'emergency'), isNull(leaveType.archivedAt)));
          // 3. The seeded code — pre-65f466e2 behaviour, kept reachable for an unclassified tenant.
          if (!target) {
            [target] = await findTarget(and(eq(leaveType.code, EMERGENCY_LEAVE_CODE), isNull(leaveType.archivedAt)));
          }
        }
        // Still a real state, and still loud: the chosen type can be archived after the rule was written.
        // The message names what was CHOSEN, so HR can see which configuration to repair.
        if (!target) throw new LeaveOverrideTargetMissingError(rule.targetLeaveTypeId ?? EMERGENCY_LEAVE_CODE);
        // 7daac043: the notice actually given, in the unit the rule was judged in — the same figure the gate
        // above used. Recomputing it on the calendar basis here would tell the employee they gave 5 days'
        // notice while the rule that fired counted 3 working ones.
        const daysInAdvance = noticeGiven;
        // CONFIRMATION IS A SERVICE CONCERN. Nothing is persisted without the employee's explicit
        // agreement to THIS rule — a client that skips the pop-out cannot submit a converted application.
        if (!consent.has(leaveOverrideConsentToken('advance_notice_not_met', 'convert_to_emergency'))) {
          throw new LeaveOverrideConsentRequiredError('advance_notice_not_met', 'convert_to_emergency', {
            fromTypeName: lt?.name,
            toTypeName: target.name,
            daysInAdvance,
            minAdvanceDays: minAdvance,
          });
        }
        overrideAudit = {
          trigger: 'advance_notice_not_met',
          action: 'convert_to_emergency',
          fromLeaveTypeId: p.leaveTypeId,
          fromLeaveTypeName: lt?.name,
          daysInAdvance,
          minAdvanceDays: minAdvance,
          dayType: minAdvanceDayType,
          consentAt: new Date().toISOString(),
        };
        // Re-point the application. Everything from here on — the duplicate-application policy, the balance
        // guard (and therefore trigger 2), the length/pool/year limits, the approval chain and the persisted
        // row — is judged against Emergency Leave, because that is what this application now IS. Everything
        // ABOVE was judged against the type the employee chose, which is also right: they must be entitled
        // to apply for it, and it must be inside its backdating window, before a rule on it can fire.
        p = { ...p, leaveTypeId: target.id };
        lt = target;
        // Emergency Leave with no configured balance source still DECOMPOSES (0106) — SICK-first for an
        // illness absence under EA s.60F, then Annual, then Unpaid on consent. That cascade IS the split
        // behaviour, and re-entering it here rather than around it is what keeps the converted application
        // on one deduction path.
        if (lt.balanceSourceTypeId == null) {
          return requestEmergencyLeave(tx, ctx, { ...p, leaveTypeId: target.id }, overrideAudit);
        }
      } else {
        // Custom validation messages (0147): pass the admin-authored override for THIS rule (keyed by its
        // config field name) through the typed error so the localizer renders it verbatim; absent ⇒ the
        // built-in localized default. Same look-up-then-pass-through pattern as the backdating gate above.
        throw new LeaveAdvanceNoticeRequiredError(
          minAdvance!,
          lt?.name,
          lt?.customMessages?.minAdvanceDays || undefined,
          // 7daac043: which reading refused them, so the standard message says "working day(s)" when that is
          // what was counted. A custom message still wins — it is rendered verbatim, never re-worded.
          minAdvanceDayType,
        );
      }
    }

    // Future leave-year application gate (9aa894a4, re-based by 4b0e76ae). "Employees can only apply leave for
    // a FUTURE leave year after HR has opened it." Derive the target year from the request's START date. Only a
    // FUTURE year (strictly after today's tenant-local calendar year) is gated — a current/past year keeps
    // today's EXACT behaviour. HR admins (isAdmin) bypass for exceptional cases (the override path, stamped
    // onto the submitted event below); ordinary employees get a typed LeaveYearNotOpenError BEFORE any write.
    // Emergency Leave already returned above (it exists for urgent, current absence).
    //
    // 4b0e76ae — THE BEHAVIOUR STAYED, THE READ WENT. This used to SELECT the managed leave_year_config row for
    // the target year and ask the pure helper `leaveYearOpenForApplication` whether it was open. That module is
    // gone (its screen, its five writers and its rows), so the gate is now a FLAT standing rule with no read at
    // all. Byte-identical to the old code for any tenant with no OPEN future-year record — which, after
    // migration 0385 emptied the table, is every tenant.
    //
    // ⚠️ DO NOT "SIMPLIFY" THIS AWAY NOW THAT NOTHING IS READ. Dropping the gate would let an ordinary employee
    // book NEXT-year dates against THIS year's balance. The approval debit is stamped effectiveOn =
    // req.startDate, while openLeaveYear's `before` balance is an UNBOUNDED ledger read with no effectiveOn
    // bound, feeding BOTH resolveCarryAllowance(pol, before) and forfeit = max(0, before - carry). So that
    // booking would silently REDUCE the days an employee carries forward and INCREASE the days they forfeit at
    // the next year opening. The gate is what keeps those figures honest.
    const targetLeaveYear = Number(p.startDate.slice(0, 4));
    const currentLeaveYear = Number(today.slice(0, 4));
    const futureLeaveYear = Number.isInteger(targetLeaveYear) && targetLeaveYear > currentLeaveYear;
    const leaveYearOverride = futureLeaveYear && isAdmin(ctx);
    if (futureLeaveYear && !isAdmin(ctx)) throw new LeaveYearNotOpenError(targetLeaveYear);

    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    // Hourly-leave time window (0129): for an hourly request prefer the From/To window — the window is
    // MANDATORY at this service boundary (mirrors LeaveDurationNotAllowedError) and `hours` is derived from
    // it. The raw `p.hours` path remains a back-compat fallback for importer/legacy callers that don't supply
    // a window. fromTime/toTime are persisted (hourly only) so the approver + history can render the window.
    let fromTime: string | null = null;
    let toTime: string | null = null;
    let hours: number | null = null;
    if (durationType === 'hourly') {
      if (p.fromTime || p.toTime) {
        // A window was supplied: both halves are required and hours is derived from the elapsed span.
        hours = hoursBetween(p.fromTime ?? '', p.toTime ?? '');
        fromTime = (p.fromTime ?? '').slice(0, 5);
        toTime = (p.toTime ?? '').slice(0, 5);
      } else if (p.hours != null) {
        // Back-compat: importer/legacy caller passed a raw hours figure with no window.
        hours = p.hours;
      } else {
        // Neither a window nor a raw figure — the mandatory window is missing.
        throw new HourlyLeaveTimeRangeError();
      }
    }

    // ADR-0048: a non-full-day duration must be enabled on the leave type's allow-list, and confined to a
    // single day. (full_day is always allowed and keeps the original range path unchanged.)
    if (durationType !== 'full_day') {
      const allow = (lt?.durations as string[] | null) ?? [];
      if (!allow.includes(durationType)) throw new LeaveDurationNotAllowedError();
      if (p.startDate !== p.endDate) {
        throw new Error('Half-day and hourly leave must be a single day (start and end dates must match)');
      }
    }

    // For working_days types the leave must land on an actual working day — for full_day ranges this is the
    // existing count; for half/hourly it is the panel-fix guard so a half-day on a weekend/holiday is
    // rejected rather than silently deducted at 0.5. Run the holiday query once and reuse it for both.
    // workingDayCount is the LIST count (Full ∪ Half, unweighted) — used only for the "any working day in
    // range?" rejection guard below. workingDayWeight (4b/4c) is the actual DEDUCTED amount, which is what
    // `days` is set from for full_day — it differs from workingDayCount only when a Half marker + the
    // company's leaveHalfDayFullDeduction toggle apply (D2/Feedback 31474452).
    let workingDayCount: number | null = null;
    let workingDayWeight: number | null = null;
    if (lt?.counting === 'working_days') {
      // 2C (ADR-0038) + holiday grouping: holidays apply per the employee's effective set of states —
      // national (state null) ∪ those states, resolved holiday_group → work_state →
      // company.default_work_state → national-only (see resolveHolidaySet).
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, p.employmentId);
      // Day Type Inclusion (feedback ef6d7146): the type's re-inclusion vector (undefined ⇒ inert legacy
      // path). Both the deducted WEIGHT and the "any deductible day in range?" guard honour it so a type
      // configured to count e.g. public holidays deducts them and a half/hourly guard sees them as valid.
      const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
      // workingDayCount is the LIST count of deductible days — byte-identical to workingDays() when incl is
      // undefined (a Full/Half day weighs > 0, a holiday/rest day 0), and additionally counts re-included
      // day types when a vector is set.
      workingDayCount = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl)).length;
      workingDayWeight = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt?.counting === 'working_days' ? workingDayWeight! : dayCount(p.startDate, p.endDate);
    } else {
      // Single day already enforced. Working-day guard: reject a half/hourly request that falls on a
      // weekend/holiday for working_days types (workingDayCount === 0) — same error as an empty range.
      if (lt?.counting === 'working_days' && workingDayCount === 0) {
        throw new LeaveNoDaysInRangeError();
      }
      if (durationType === 'hourly') {
        const h = hours ?? 0;
        // Semantic shift (0129): the old guard capped at DEFAULT_STANDARD_HOURS (8) because the legacy input
        // was a NET-work figure. A From/To window is ELAPSED wall time — 09:00–18:00 is 9 elapsed hours (8
        // work + 1 lunch) and is a legitimate request — so we must NOT cap at 8. Lower bound (> 0) is already
        // enforced by hoursBetween for the window path; keep it for the back-compat raw-hours path too. Sanity
        // cap at 24h: hourly leave is single-day (the startDate === endDate guard above), so a single calendar
        // day cannot exceed 24 elapsed hours.
        if (!(h > 0 && h <= 24)) {
          throw new Error('Hourly leave must be more than 0 and at most 24 hours');
        }
        days = Math.round((h / DEFAULT_STANDARD_HOURS) * 100) / 100;
      } else {
        days = 0.5; // half_day_am / half_day_pm
      }

      // AM/PM same-date conflict (ADR-0048): a non-rejected request already covering this slot blocks a new
      // one. Complementary AM + PM on the same date is allowed; everything else (same slot, a full_day, or
      // an hourly) conflicts. This is the only overlap logic — general range overlap stays out of scope.
      const existing = await tx
        .select({ durationType: leaveRequest.durationType })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, p.employmentId),
            eq(leaveRequest.startDate, p.startDate),
            eq(leaveRequest.endDate, p.endDate),
            inArray(leaveRequest.status, ['pending', 'approved']),
          ),
        );
      for (const e of existing) {
        const conflicts =
          e.durationType === durationType || // same slot (or hourly vs hourly)
          e.durationType === 'full_day' ||
          e.durationType === 'hourly' ||
          durationType === 'hourly';
        if (conflicts) throw new Error('This date already has a conflicting leave request');
      }
    }

    // Duplicate Leave Application Restriction (d5e51c34): AFTER the narrow AM/PM same-slot clash above, apply
    // the leave type's same-DATE double-booking policy. Runs for ALL durations (full-day included), unlike the
    // slot clash which only lives in the non-full-day branch. Extends the comparison from same-slot to same-
    // DATE range overlap: a pending/approved application whose [startDate, endDate] intersects the requested
    // [startDate, endDate]. 'restrict_same' scopes the check to the SAME leave type; 'restrict_any' matches any
    // type. 'allow'/null ⇒ no extra check (today's behaviour). Fires for admins too — double-booking is a data
    // rule, not a permission (unlike backdating/advance-notice, which isAdmin bypasses).
    const dupPolicy = lt?.duplicateApplicationPolicy ?? 'allow';
    if (dupPolicy === 'restrict_same' || dupPolicy === 'restrict_any') {
      const overlap = await tx
        .select({ id: leaveRequest.id })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, p.employmentId),
            inArray(leaveRequest.status, ['pending', 'approved']),
            lte(leaveRequest.startDate, p.endDate),
            gte(leaveRequest.endDate, p.startDate),
            ...(dupPolicy === 'restrict_same' ? [eq(leaveRequest.leaveTypeId, p.leaveTypeId)] : []),
          ),
        )
        .limit(1);
      if (overlap.length > 0) throw new DuplicateLeaveApplicationError();
    }

    if (days <= 0) throw new LeaveNoDaysInRangeError();

    // Configurable Negative Leave Balance Validation (0ef0defd): submit-time balance guard. When the leave type
    // has allow_negative_balance=false (the default), reject an application whose days exceed the employee's
    // AVAILABLE balance — the approved-ledger balance MINUS days already reserved by other pending requests of
    // the same type (availableLeaveBalance). allow_negative_balance=true skips this (employees may go negative;
    // the pre-existing approval-time guard is unaffected). Fires for admins too — this is a data rule about the
    // balance, mirroring the duplicate-application gate above. round2 matches the leave math (leavePreview).
    //
    // Allow Unpaid Leave (a7fab30b) takes precedence over this gate when it is on. The point of the setting is
    // that the application PROCEEDS past the balance, so refusing it here and then converting the excess would
    // be self-contradictory; instead the uncovered part is measured and carried on the request as unpaid days.
    // The measurement is against the resolved BALANCE SOURCE (cdf9ca48) — availableLeaveBalance now resolves
    // it — so a type that both borrows and allows unpaid leave overflows the borrowed balance, not its own.
    //
    // PART-COVERED IS THE CASE THAT MATTERS: 3 days requested with 1 day of balance splits 1 paid + 2 unpaid.
    // Math.max(0, available) rather than `available` itself so an already-negative balance (permitted earlier
    // under allow_negative_balance) makes the whole request unpaid rather than manufacturing extra paid days.
    let unpaidDays = 0;
    // ── Override Leave Application (56910869) · TRIGGER 2: the balance does not cover the application ──
    //
    // THIS IS fef49b9a, SHIPPED AS A RULE. It sits AHEAD of the three legacy branches below rather than
    // inside them because an enabled rule is HR's explicit answer to this exact situation and must not be
    // second-guessed by a setting they did not touch. With no rule configured — every leave type until HR
    // enables one — this whole block is skipped and the chain below runs byte-identically to today.
    //
    // `split_unpaid` writes NO new arithmetic: it reuses the same `unpaid_days` measurement a7fab30b
    // already ships (available balance, resolved through the BALANCE SOURCE, subtracted from the charged
    // days), so there is exactly one splitter and the preview and the outcome cannot drift. What the rule
    // adds is (a) it works without `allow_unpaid_leave` being on, because HR configured the exception here
    // instead, and (b) it requires the employee's explicit confirmation first.
    const balanceRule = resolveLeaveOverrideRule(
      normalizeLeaveOverrideRules(lt?.overrideRules),
      'insufficient_balance',
    );
    if (balanceRule) {
      const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
      const shortfall = round2(Math.max(0, days - Math.max(0, available)));
      if (shortfall > 0) {
        // A `block` rule refuses with the SAME error the unconfigured path would — see trigger 1's note on
        // why "HR decided to refuse" and "nobody decided" must read identically to the employee. Note this
        // is STRICTER than allow_negative_balance + a floor: an explicit block is an explicit block.
        if (balanceRule.action === 'block') throw new InsufficientLeaveBalanceOnSubmitError();
        if (!consent.has(leaveOverrideConsentToken('insufficient_balance', 'split_unpaid'))) {
          throw new LeaveOverrideConsentRequiredError('insufficient_balance', 'split_unpaid', {
            fromTypeName: lt?.name,
            paidDays: round2(days - shortfall),
            unpaidDays: shortfall,
          });
        }
        unpaidDays = shortfall;
        // TWO RULES ON ONE LEAVE TYPE BOTH APPLY. When this application was already converted by trigger 1,
        // the conversion's stamp is kept and the split is recorded ALONGSIDE it — an auditor must be able to
        // see both facts, and overwriting would erase the one that explains why the type changed.
        overrideAudit = {
          ...(overrideAudit ?? {
            trigger: 'insufficient_balance',
            action: 'split_unpaid',
            consentAt: new Date().toISOString(),
          }),
          ...(overrideAudit ? { alsoSplitUnpaid: true } : {}),
          paidDays: round2(days - shortfall),
          unpaidDays: shortfall,
        };
      }
    } else if (lt?.allowUnpaidLeave === true) {
      const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
      unpaidDays = round2(Math.max(0, days - Math.max(0, available)));
    } else if (lt?.allowNegativeBalance === false) {
      const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
      if (round2(available - days) < 0) throw new InsufficientLeaveBalanceOnSubmitError();
    } else if (lt?.allowNegativeBalance === true) {
      // bc512dc3 — going negative is permitted, but not without end. Same balance the branch above reads,
      // resolved through the BALANCE SOURCE, so the two gates never talk about different ledgers.
      const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
      await enforceMaxNegativeBalance(tx, { leaveTypeId: p.leaveTypeId, available, requestedDays: days });
    }

    // Shared Leave Group (R44 4c48fd1f, re-pointed to leave-type level by r88 1ef1cf95): reject when this
    // application would push the employee's per-cycle usage across the group's members over its shared
    // total. No-op when the type is in no group, so tenants with no groups are unaffected.
    //
    // Maximum Consecutive Leave (c6ffa725 rev 2) + the shared group's per-application cap (r82a 1ef1cf95),
    // composed: how long may ONE application be. Runs FIRST of the two because it is a property of the
    // application ALONE — an employee whose whole year is untouched is still refused a too-long
    // application, and telling them "your allowance is spent" would be a lie. Both dates AND the charged
    // days are passed: a calendar-unit cap measures the span, a working-days cap measures what it charges.
    await enforceApplicationLengthLimit(tx, {
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      chargedDays: days,
    });
    await enforceSharedLeaveGroupLimit(tx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      requestedDays: days,
    });

    // Application Limits (c6ffa725): the leave TYPE's own maximum days per leave year — the rule that works
    // for types with NO entitlement balance (Unpaid Leave, Prolonged Illness Leave). Runs AFTER the balance
    // gate and the pool gate, deliberately: those are the rules an employee is most likely to be hitting,
    // and an unconfigured limit (every existing type) makes this a no-op query-and-return.
    await enforceLeaveYearApplicationLimit(tx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      requestedDays: days,
    });

    // ADR-0069: a friendly UX pre-check — the DB trigger (guard_frozen_leave_balance) is the real
    // enforcement at approval time, but failing fast here gives the employee a readable error immediately
    // instead of only at approval. Import is deferred (function-scope) to avoid a load-time circular
    // dependency: leave-encashment.ts never imports from leave.ts.
    {
      const { frozenSnapshotFor, LeaveBalanceFrozenError } = await import('./leave-encashment');
      const frozen = await frozenSnapshotFor(tx, p.employmentId, p.leaveTypeId);
      if (frozen) throw new LeaveBalanceFrozenError();
    }

    // Doc-config: now that `days` is known, enforce the conditional document gate. `days` is fractional
    // (half-day / hourly), so use strict `>` against the integer config: mandatoryAfterDays:N means "more
    // than N days" (a 2.0-day request with N=2 needs no doc; 2.5 days does). null/0 ⇒ always require.
    if (lt?.requiresDocument && !p.hasDocument) {
      const after = lt.mandatoryAfterDays;
      if (after == null || after === 0 || days > after) {
        throw new LeaveDocumentRequiredError(lt.name, after ?? undefined);
      }
    }

    // Doc-config: mandatory employee remark.
    const employeeRemark = p.employeeRemark?.trim() || null;
    if (lt?.employeeRemarkRequired && !employeeRemark) {
      throw new LeaveRemarkRequiredError(lt.name);
    }

    // Phase-B #13 (ADR-0062): EA s.37 maternity paid-ALLOWANCE eligibility. The 98-day LEAVE is granted
    // regardless; the paid ALLOWANCE is a separate entitlement. When the s.37 facts (surviving-children +
    // confinement date) are supplied, compute the decision — it OVERRIDES the maternity leave-type paid
    // default: withheld ⇒ allowance_eligible=false ⇒ unpaidDaysByEmployment treats the days as unpaid. When
    // the inputs are absent (legacy/UI-not-updated), default conservatively to PAID (allowance_eligible left
    // NULL) and surface a "paid-allowance unconfirmed" warning so HR can confirm — never silently wrong.
    let maternity: {
      survivingChildren: number | null;
      confinementDate: string | null;
      allowanceEligible: boolean | null;
      event: Record<string, unknown>;
    } | null = null;
    let maternityAllowanceWarning = false;
    if (lt?.code === MATERNITY_LEAVE_CODE) {
      const hasInputs = p.confinementDate != null && p.survivingChildren != null;
      if (hasInputs) {
        const [emp] = await tx
          .select({ hiredOn: employment.hiredOn })
          .from(employment)
          .where(eq(employment.id, p.employmentId))
          .limit(1);
        const decision = maternityAllowanceEligibility(emp!.hiredOn, p.confinementDate!, p.survivingChildren!);
        maternity = {
          survivingChildren: p.survivingChildren!,
          confinementDate: p.confinementDate!,
          allowanceEligible: decision.eligible,
          event: {
            allowanceEligible: decision.eligible,
            reason: decision.reason ?? null,
            qualifyingService: decision.qualifyingService,
            survivingChildren: p.survivingChildren!,
            confinementDate: p.confinementDate!,
            unconfirmed: false,
          },
        };
      } else {
        // Belt-and-braces: inputs unconfirmed → keep the leave paid (allowance_eligible NULL) + warn.
        maternityAllowanceWarning = true;
        maternity = {
          survivingChildren: p.survivingChildren ?? null,
          confinementDate: p.confinementDate ?? null,
          allowanceEligible: null,
          event: {
            allowanceEligible: null,
            reason: null,
            qualifyingService: null,
            survivingChildren: p.survivingChildren ?? null,
            confinementDate: p.confinementDate ?? null,
            unconfirmed: true,
          },
        };
      }
    }

    // Partial Leave Approval — single-request model (ADR-0068, supersedes 0131's child-row split). When the
    // type opts into per-date approval AND the request is single-approver, a multi-day FULL-DAY WORKING-DAYS
    // request stays ONE leave_request row and gets one leave_request_date sub-row per working date (below,
    // after the single insert). The approver then decides each date via decideLeaveDate in the request detail
    // view — one inbox row, not one-per-day. The gate (§4C) excludes: calendar-counted types (kept as a whole
    // span), half/hourly (single-day, forced start===end above), REPLACEMENT (TOIL consume-on-approve
    // interaction), and — critically — MULTI-STEP requests (per-date × the manager→HR chain is deferred;
    // such a request falls through to today's whole-request decideLeave chain with NO per-date rows, so
    // deployed multi-step data is never stranded). "route by whether leave_request_date rows exist" is safe
    // precisely because rows are only ever created for single-approver requests. EL was already routed above.
    //
    // r79 0322 — "single-step" is no longer a COMPANY flag, it is this request's RESOLVED CHAIN having at
    // most one level: the same gate generateApprovalSteps uses (isMultiStepChain), resolved from the same
    // helper with the same day count, so the per-date rows and the step rows can never disagree about the
    // request's shape. An unresolvable employment stays ineligible, exactly as `multi === false` did.
    const resolvedChain = await resolveRequestApprovalChain(tx, p.employmentId, p.leaveTypeId, days);
    const perDateEligible =
      durationType === 'full_day' &&
      lt?.counting === 'working_days' &&
      !!lt?.perDateApproval &&
      !leaveTypeIs(lt, 'replacement') &&
      p.startDate !== p.endDate &&
      resolvedChain !== null &&
      !isMultiStepChain(resolvedChain.chain) &&
      // Allow Unpaid Leave (a7fab30b): a part-unpaid request is excluded, for the same reason REPLACEMENT is —
      // the two features have no agreed answer between them. The paid/unpaid boundary is a QUANTITY of days,
      // not an attribution to particular dates, so "approve Tuesday, reject Wednesday" cannot say which of the
      // two was the unpaid one, and any rule we invented would silently change what the employee is paid.
      // The request still goes through normally, just as one whole-span decision.
      unpaidDays === 0;

    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId,
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      days,
      durationType,
      hours,
      fromTime,
      toTime,
      reason: p.reason ?? null,
      employeeRemark,
      parentGroupId: null,
      mandatoryAfterDays: lt?.mandatoryAfterDays ?? null,
      // Allow Unpaid Leave (a7fab30b): the uncovered portion measured at the balance guard above. 0 ⇒ stored
      // as NULL (fully paid), so a type with the setting off writes exactly what it writes today.
      unpaidDays,
      survivingChildren: maternity?.survivingChildren ?? null,
      confinementDate: maternity?.confinementDate ?? null,
      allowanceEligible: maternity?.allowanceEligible ?? null,
      maternityAllowanceEvent: maternity?.event ?? null,
      // Configurable backdated-leave restriction (0133): stamp the override onto the submitted event only when
      // an HR admin actually bypassed the type's limit (computed at the guard above).
      backdatingAudit: backdatedOverride
        ? { daysBackdated: daysBetween(p.startDate, today), backdatingLimitDays: limit }
        : null,
      // Minimum advance-notice rule (0159): stamp the override onto the submitted event only when an HR admin
      // actually bypassed the type's required notice (computed at the guard above).
      minAdvanceAudit: advanceOverride
        ? // 7daac043 — the notice given in the unit the rule was JUDGED in (noticeGiven, computed once at the
          // gate), not a fresh calendar count. An override record that says "5 days of notice against a
          // requirement of 7" while the rule counted 3 working days describes an override that never happened.
          { daysInAdvance: noticeGiven, minAdvanceDays: minAdvance, dayType: minAdvanceDayType }
        : null,
      // Leave Year Configuration (9aa894a4): stamp the override onto the submitted event only when an HR admin
      // actually applied for a not-yet-open future leave year (computed at the gate above).
      leaveYearAudit: leaveYearOverride ? { targetYear: targetLeaveYear } : null,
      // Override Leave Application (56910869): null on every application no rule changed, which is every
      // application until HR enables a rule — so the ordinary payload is byte-identical to before.
      overrideAudit,
    });

    // Partial Leave Approval — single-request model (ADR-0068 §4B). When the type is opted-in (§4C gate above)
    // and the span has >1 working date, insert one leave_request_date sub-row per working date (status
    // 'pending') IN THE SAME TRANSACTION as the single request. These are the per-date decision handles the
    // approver flips in the detail view via decideLeaveDate; the span consumers (§4A) read them so only the
    // approved dates count as leave. The submitted event's payload carries perDate so the whole submission is
    // captured on ONE aggregate event. Substrate: the per-date INSERTs are sub-rows of a single aggregate whose
    // lifecycle is captured by the aggregate's submitted (with perDate) + per-date-decided events — no separate
    // event per sub-row insert.
    let perDate: { date: string; days: number }[] = [];
    if (perDateEligible) {
      const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, p.employmentId);
      // Day Type Inclusion (feedback ef6d7146): the per-date sub-rows must span exactly the DEDUCTIBLE dates
      // (re-included day types included) and carry each date's inclusion-aware weight, so sum(perDate.days)
      // still equals the request's weighted `days` and no re-included day is stranded outside per-date approval.
      const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
      const dates = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl));
      if (dates.length > 1) {
        // Feedback 31474452: each date carries ITS OWN weight (1 for Full, 0.5/1.0 for Half per the company
        // toggle) rather than always-1 "one whole working day by construction" — so sum(perDate.days) equals
        // the request's WEIGHTED total (days, set above from workingDayWeight), not merely its date count.
        perDate = dates.map((d) => ({ date: d, days: dayWeight(d, sched, hols, incl) }));
        await tx.insert(leaveRequestDate).values(
          perDate.map((pd) => ({
            tenantId: ctx.tenantId,
            leaveRequestId: id,
            subjectEmploymentId: p.employmentId,
            leaveDate: pd.date,
            days: pd.days.toFixed(2),
            status: 'pending' as const,
          })),
        );
        // Extend the already-appended submitted event with the per-date breakdown (append a companion command
        // event on the same aggregate so the submitted fact + its date breakdown are both queryable).
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: id,
          eventType: 'leave-request.per-date.initialized',
          actor: actorOf(ctx),
          subjectEmploymentId: p.employmentId,
          payload: { perDate },
        });
      }
    }

    // Phase-B #15 — holiday-completeness guard. A working_days request's day count depends on the gazetted
    // holidays loaded for the employee's (state, year). If fewer than the s.60D minimum of 11 are loaded,
    // warn LOUDLY (domain event + returned warning) but do NOT block — the count may be wrong until HR loads
    // the rest of the state gazette. Only meaningful for working_days types (calendar types ignore holidays).
    const holidayWarnings = lt?.counting === 'working_days'
      ? await warnLeaveHolidayCompleteness(tx, ctx, p.employmentId, p.startDate, p.endDate, id)
      : [];

    return {
      leaveRequestId: id,
      days,
      parentGroupId: null,
      children: [{ id, code: lt?.code ?? '', days }],
      ...(maternityAllowanceWarning ? { maternityAllowanceWarning: true } : {}),
      ...(holidayWarnings.length ? { holidayWarnings } : {}),
    };
  });
}

/** Feedback 31474452 (Step 5): pre-submission preview — "this will deduct X day(s), balance before/after" —
 *  for the day-based durations only (full_day, half_day_am, half_day_pm; hourly keeps its existing
 *  client-side display, see components/leave-duration-fields.tsx hourlyTotal). Read-only: no domain event, no
 *  write. Mirrors (but does not duplicate) requestLeave's day-counting math so the preview and the actual
 *  submission can never drift on the FULL-DAY figure — both read the same resolveSchedule/dayWeight/
 *  workingDaysWeighted helpers. Runs under the caller's own session (RLS on leave_ledger/leave_type already
 *  scopes what is readable) and validates employmentId is real/visible exactly like requestLeave does (a
 *  bogus or out-of-scope id simply yields no leave-type match / RLS-empty balance, never a throw here — the
 *  UI's own employment <select> is the real gate, same trust boundary as requestLeave itself).
 *  Emergency Leave: returns the weighted span total as `days` with `isEmergencySplit: true` — the actual
 *  sick/annual/unpaid split (and the unpaid-consent gate) is only resolved authoritatively at submission. */
export async function previewLeaveDeduction(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    durationType?: LeaveDurationType;
    /** Employee apply-popup day-by-day panel: when set (and only for a full_day span) the SAME computation
     *  that produced `days` also returns its per-date detail as `dayRows`. Absent ⇒ byte-identical work, so
     *  every existing caller (notably app/me/actions.ts myPreviewLeaveDeduction) is untouched. */
    includeDayRows?: boolean;
    /** Override Leave Application (56910869): the tenant-local "today" the advance-notice trigger is judged
     *  against — the same value the action layer passes to requestLeave, so the pop-out the employee is
     *  shown and the rule the submission applies can never describe different days. Defaults as requestLeave
     *  does, so every existing caller is untouched. */
    today?: string;
  },
): Promise<{
  days: number;
  balanceAvailable: number;
  balanceAfter: number;
  hasHalfScheduleDate: boolean;
  isEmergencySplit: boolean;
  dayRows?: LeaveApplyDayRow[];
  /** Allow Unpaid Leave (a7fab30b): how many of `days` the balance will NOT cover, so the employee is told
   *  BEFORE submitting rather than discovering it on a payslip. 0 (and absent on every type that has not
   *  opted in) ⇒ the whole request is paid. Computed from the same availableLeaveBalance the submit-time
   *  guard uses, so the warning and the outcome agree. */
  unpaidDays?: number;
  /** Override Leave Application (56910869): the rule(s) that WOULD change this application if it were
   *  submitted now, so the form can tell the employee what will happen and collect the confirmation the
   *  service requires. Absent (never an empty array) when no rule fires — which is every leave type until
   *  HR enables one, so no other type gains a line.
   *
   *  ADVISORY ONLY. The service re-evaluates every trigger at submission and refuses a converting rule
   *  without its token; this exists so the employee is ASKED, not so the client can decide. `block` rules
   *  are reported too — the form shows why the application will be refused rather than letting the employee
   *  fill the whole thing in first. */
  overrides?: LeaveOverridePreview[];
}> {
  return withTenant(ctx, async (tx) => {
    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    const [lt] = await tx
      // Day Type Inclusion (feedback ef6d7146): projected so the preview's day-count matches what submission
      // will deduct (both run through workingDaysWeighted with the same inclusion vector — no preview drift).
      .select({
        code: leaveType.code,
        counting: leaveType.counting,
        dayTypeInclusion: leaveType.dayTypeInclusion,
        // Balance Deduction Source (cdf9ca48) / Allow Unpaid Leave (a7fab30b): the preview must read the same
        // two settings requestLeave does, or the "balance before/after" line describes a ledger the
        // application will not touch.
        balanceSourceTypeId: leaveType.balanceSourceTypeId,
        allowUnpaidLeave: leaveType.allowUnpaidLeave,
        // Override Leave Application (56910869): the configured exceptions + the notice rule trigger 1 fires
        // on + the name the pop-out says. Read here so the preview evaluates the SAME rules the submission
        // will, rather than the form guessing from what it happens to know.
        name: leaveType.name,
        minAdvanceDays: leaveType.minAdvanceDays,
        // 7daac043: the unit that requirement is read in — projected so the pop-out evaluates the notice rule
        // exactly as the submission will. Unprojected, the preview would judge a working-days type on the
        // wall calendar and stay silent about a conversion the submission is about to demand consent for.
        minAdvanceDayType: leaveType.minAdvanceDayType,
        overrideRules: leaveType.overrideRules,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    // Balance Deduction Source (cdf9ca48): EL only decomposes while it has NO configured source — the same
    // condition requestLeave branches on, so the preview never promises a split the submission will not make.
    const isEmergencySplit = leaveTypeIs(lt, 'emergency') && lt.balanceSourceTypeId == null;
    const balanceAvailable = await leaveBalance(tx, p.employmentId, lt?.balanceSourceTypeId ?? p.leaveTypeId);

    let days = 0;
    let hasHalfScheduleDate = false;
    // Resolved lazily on the working_days branch below; the day-rows path re-uses them when present and
    // resolves them itself on the calendar_days branch (rows still need a SCHEDULE LABEL there).
    let hols: Set<string> | null = null;
    let sched: Awaited<ReturnType<typeof resolveSchedule>> | null = null;
    if (lt?.counting === 'working_days') {
      hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
      sched = await resolveSchedule(tx, p.employmentId);
      hasHalfScheduleDate = eachDate(p.startDate, p.endDate).some((d) => sched!.halfDaysIso.includes(isoWeekday(d)));
      if (durationType === 'full_day' || isEmergencySplit) {
        const incl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);
        days = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
      } else {
        days = 0.5; // half_day_am / half_day_pm — D4: unaffected by the half-schedule toggle
      }
    } else if (durationType === 'full_day' || isEmergencySplit) {
      days = dayCount(p.startDate, p.endDate);
    } else {
      days = 0.5;
    }

    // ── Employee apply-popup day-by-day rows (opt-in) ────────────────────────────────────────────────
    // Folded into THIS call rather than a second action so the per-date "Leave applied" column can never
    // contradict `days` above: one computation, one snapshot, one transaction. Half/hourly durations are
    // always a single date and carry no real range, so rows are full_day-only.
    let dayRows: LeaveApplyDayRow[] | undefined;
    if (p.includeDayRows && durationType === 'full_day' && lt) {
      dayRows = await resolveApplyDayRows(tx, {
        employmentId: p.employmentId,
        startDate: p.startDate,
        endDate: p.endDate,
        counting: lt.counting,
        inclusion: normalizeDayTypeInclusion(lt.dayTypeInclusion),
        hols,
        sched,
      });
    }

    // Allow Unpaid Leave (a7fab30b): the same measurement requestLeave will make — availableLeaveBalance
    // (ledger minus everything already reserved), not the raw ledger balance above, because a pending
    // application the employee already filed is a day they no longer have. Only computed for an opted-in
    // type, so no extra query on any other type.
    const unpaidDays =
      lt?.allowUnpaidLeave === true
        ? round2(Math.max(0, days - Math.max(0, await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId))))
        : 0;

    // ── Override Leave Application (56910869): what the employee is about to be asked ────────────────
    //
    // The rules are re-evaluated here rather than mirrored client-side, and against the same helpers the
    // submission uses (lacksMinAdvanceNotice, availableLeaveBalance), so the pop-out cannot promise a
    // conversion the submission will not make or stay silent about one it will.
    //
    // HR admins are excluded, exactly as the underlying gates exclude them: an admin applying on someone's
    // behalf bypasses the notice rule outright (the HR-side override), so offering them a conversion to
    // consent to would be offering them an exception they do not need.
    const overrides: LeaveOverridePreview[] = [];
    if (!isAdmin(ctx) && lt) {
      const rules = normalizeLeaveOverrideRules(lt.overrideRules);
      const today = p.today ?? todayInKualaLumpur();
      const advance = resolveLeaveOverrideRule(rules, 'advance_notice_not_met');
      const noticeMin = lt.minAdvanceDays ?? null;
      if (advance && !leaveTypeIs(lt, 'emergency') && noticeMin != null) {
        // 7daac043 — the SAME unit-aware measurement requestLeave makes, from the SAME two sources, behind
        // the SAME guards: no extra query on the calendar reading (every type until an administrator
        // changes one), and none for a backdated start whose notice window is empty either way. `hols` /
        // `sched` resolved further up CANNOT be reused — they cover the LEAVE span [startDate, endDate],
        // and the notice window is [today, startDate), a different range entirely.
        const noticeDayType = resolveAdvanceNoticeDayType(lt.minAdvanceDayType);
        let noticeRoster: number[] | undefined;
        let noticeHolidays: Set<string> | undefined;
        if (noticeDayType === 'working_days' && p.startDate > today) {
          noticeRoster = await resolveWorkingDaysIso(tx, p.employmentId);
          noticeHolidays = await resolveHolidaySet(tx, p.employmentId, today, p.startDate);
        }
        const noticeGiven = noticeDaysGiven(today, p.startDate, noticeDayType, noticeRoster, noticeHolidays);
        if (noticeGiven < noticeMin) {
          overrides.push({
            trigger: 'advance_notice_not_met',
            action: advance.action,
            consentToken: leaveOverrideConsentToken('advance_notice_not_met', advance.action),
            needsConsent: leaveOverrideNeedsConsent(advance.action),
            fromTypeName: lt.name ?? null,
            daysInAdvance: noticeGiven,
            minAdvanceDays: noticeMin,
            minAdvanceDayType: noticeDayType,
          });
        }
      }
      const balanceRule = resolveLeaveOverrideRule(rules, 'insufficient_balance');
      if (balanceRule) {
        const available = await availableLeaveBalance(tx, p.employmentId, p.leaveTypeId);
        const shortfall = round2(Math.max(0, days - Math.max(0, available)));
        if (shortfall > 0) {
          overrides.push({
            trigger: 'insufficient_balance',
            action: balanceRule.action,
            consentToken: leaveOverrideConsentToken('insufficient_balance', balanceRule.action),
            needsConsent: leaveOverrideNeedsConsent(balanceRule.action),
            fromTypeName: lt.name ?? null,
            paidDays: round2(days - shortfall),
            unpaidDays: shortfall,
          });
        }
      }
    }

    return {
      days,
      balanceAvailable,
      // Only the covered part comes off the balance (a7fab30b) — subtracting the unpaid days too would show
      // the employee a balance the approval will never produce. unpaidDays is 0 for every other type.
      balanceAfter: round2(balanceAvailable - (days - unpaidDays)),
      hasHalfScheduleDate,
      isEmergencySplit,
      ...(dayRows ? { dayRows } : {}),
      ...(unpaidDays > 0 ? { unpaidDays } : {}),
      ...(overrides.length ? { overrides } : {}),
    };
  });
}

/** One rule the apply form must tell the employee about before they submit. Flat + serialisable: it crosses
 *  the server/client boundary as a plain object on a server action's return value. */
export type LeaveOverridePreview = {
  trigger: LeaveOverrideTrigger;
  action: LeaveOverrideAction;
  /** What the form posts back as `overrideConsent` when the employee says Yes. */
  consentToken: string;
  /** false for `block` — there is nothing to agree to, only a refusal to explain. */
  needsConsent: boolean;
  fromTypeName: string | null;
  daysInAdvance?: number;
  minAdvanceDays?: number | null;
  /** 7daac043 — the unit BOTH figures above are measured in, carried so the form is never left describing a
   *  working-days rule with a calendar-days number. */
  minAdvanceDayType?: AdvanceNoticeDayType;
  paidDays?: number;
  unpaidDays?: number;
};

/** Employee apply-popup day-by-day panel: what ONE date is on the employee's LEAVE schedule. Rest and Off
 *  day are ONE bucket ('rest_day'), matching dayWeight's Phase-A collapse — splitting them here would let the
 *  panel disagree with the deducted-days figure right above it. */
export type LeaveApplyDayStatus = 'working_day' | 'half_working_day' | 'rest_day' | 'public_holiday';

/** One row of the apply-popup day-by-day panel. `days` is the EXACT dayWeight this date contributes, so the
 *  rows always sum to previewLeaveDeduction's reported `days`. */
export type LeaveApplyDayRow = { date: string; status: LeaveApplyDayStatus; days: number };

/** Longest span the day-by-day panel will materialise. Beyond this the panel simply does not appear (the
 *  link is hidden) rather than shipping thousands of rows into the popup. */
const APPLY_DAY_ROWS_MAX_SPAN = 400;

/** Per-date detail for the apply popup. Classification order MIRRORS dayWeight (holiday → Full → Half → rest)
 *  so the label and the weight can never describe different things. substrate: read-only, no event. */
async function resolveApplyDayRows(
  tx: Tx,
  p: {
    employmentId: string;
    startDate: string;
    endDate: string;
    counting: string | null;
    inclusion: DayTypeInclusion | undefined;
    hols: Set<string> | null;
    sched: Awaited<ReturnType<typeof resolveSchedule>> | null;
  },
): Promise<LeaveApplyDayRow[] | undefined> {
  if (p.endDate < p.startDate) return undefined;
  if (dayCount(p.startDate, p.endDate) > APPLY_DAY_ROWS_MAX_SPAN) return undefined;
  // resolveSchedule falls back to Mon-Fri when its employment join is empty (the deduction math depends on
  // that fallback and is NOT changed). For the ROWS we must not render a confident invented calendar for an
  // employment this session cannot see under RLS, so gate on the employment actually resolving.
  const [emp] = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(eq(employment.id, p.employmentId))
    .limit(1);
  if (!emp) return undefined;
  const hols = p.hols ?? (await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate));
  const sched = p.sched ?? (await resolveSchedule(tx, p.employmentId));
  return eachDate(p.startDate, p.endDate).map((date) => {
    const dow = isoWeekday(date);
    const status: LeaveApplyDayStatus = hols.has(date)
      ? 'public_holiday'
      : sched.workingDaysIso.includes(dow)
        ? 'working_day'
        : sched.halfDaysIso.includes(dow)
          ? 'half_working_day'
          : 'rest_day';
    // A calendar_days type deducts every date in the span, whatever the schedule says — the label still
    // reflects the schedule, so the rows keep summing to the reported total in both counting modes.
    const days = p.counting === 'working_days' ? dayWeight(date, sched, hols, p.inclusion) : 1;
    return { date, status, days };
  });
}

/** Phase-B #15: resolve the request's effective (country, state) and span years, then emit a non-blocking
 *  holiday-completeness warning event for any (state, year) below the s.60D minimum. Returns the warnings so
 *  the leave screen can surface them. Threaded onto the leave-request aggregate for the audit trail. */
async function warnLeaveHolidayCompleteness(
  tx: Tx,
  ctx: SessionContext,
  employmentId: string,
  startDate: string,
  endDate: string,
  leaveRequestId: string,
): Promise<HolidayCompletenessWarning[]> {
  const eff = await effectiveHolidayState(tx, employmentId);
  if (!eff) return [];
  // ADR-0067: a Custom location-calendar deliberately ignores the public gazette, so the s.60D "<11" guard
  // is false noise — suppress it entirely (no event, no returned warning) for those employees.
  if (eff.skipCompleteness) return [];
  return warnIfHolidaysIncomplete(tx, ctx, {
    country: eff.country,
    state: eff.state,
    years: yearsSpanned(startDate, endDate),
    module: 'leave',
    aggregateType: 'leave-request',
    aggregateId: leaveRequestId,
    subjectEmploymentId: employmentId,
    context: { leaveRequestId, startDate, endDate },
  });
}

/**
 * Emergency-Leave decomposition (0106 + Phase-B #12 / ADR-0061). EL is an application type only: this resolves
 * the paid→UPL split at submission against the employee's balances and creates up to three ordinary child
 * requests over the same dates, linked by one parent_group_id. Each child is a full-day request of its own
 * type, so it counts in its own mode natively (ANNUAL/SICK = their own counting, UNPAID = calendar-days).
 *
 * Cascade (frozen at submit):
 *   - reasonCategory 'illness' → paid SICK FIRST (EA s.60F), then ANNUAL, then UNPAID(consent). (Phase-B #12B)
 *   - otherwise               → ANNUAL, then UNPAID(consent). (the original 0106 behaviour, unchanged)
 *
 * Boundary policy (earliest-working-days-to-paid): each paid segment carves the earliest WHOLE working-days
 * (its day count floored to ≤ its real balance, H4) off the front of the span; the UNPAID child takes the
 * remaining calendar-day suffix. The split is frozen at submission; each child still gates its own balance at
 * its own approval (InsufficientLeaveBalanceError if drained meanwhile — predictable, already-tested).
 *
 * Consent gate (Phase-B #12A): when the cascade would create an UNPAID child, `unpaidConsent` MUST be true —
 * else UnpaidConsentRequiredError is thrown BEFORE any insert (nothing persisted). With consent the UNPAID
 * child is stamped with unpaid_consent_at/by and the EL event records the consent.
 */
async function requestEmergencyLeave(
  tx: Tx,
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    durationType?: LeaveDurationType;
    reasonCategory?: EmergencyReasonCategory;
    unpaidConsent?: boolean;
  },
  /** Override Leave Application (56910869): present when this EL submission is the result of an
   *  advance-notice conversion rather than the employee choosing Emergency Leave. Stamped on EVERY child's
   *  submitted event AND on the EL command event, because the decomposition means there is no single row an
   *  auditor can look at — the conversion has to be findable from any of them. */
  overrideAudit?: LeaveOverrideAudit | null,
): Promise<RequestLeaveResult> {
  // EL is full-day-range only (no durations allow-list) — reject a non-full-day request explicitly.
  if (p.durationType && p.durationType !== 'full_day') {
    throw new LeaveDurationNotAllowedError();
  }
  const isIllness = p.reasonCategory === 'illness';
  // Resolve ANNUAL + UNPAID (+ SICK for illness) type ids for the tenant. ANNUAL + UNPAID are required for the
  // decomposition; SICK is only needed (and only used) for the illness path.
  const childTypes = await tx
    .select({ id: leaveType.id, code: leaveType.code })
    .from(leaveType)
    .where(inArray(leaveType.code, ['ANNUAL', 'UNPAID', 'SICK']));
  const annualId = childTypes.find((t) => t.code === 'ANNUAL')?.id;
  const unpaidId = childTypes.find((t) => t.code === 'UNPAID')?.id;
  const sickId = childTypes.find((t) => t.code === 'SICK')?.id;
  if (!annualId || !unpaidId) {
    throw new Error('Emergency Leave requires Annual and Unpaid leave types to be configured');
  }

  // Count the span as the working-days (paid) children would (honouring the employee's holidays/state +
  // configured rest-day roster + Half-day markers) and as the UNPAID child would (calendar-days).
  // Day Type Inclusion (feedback ef6d7146): DELIBERATELY NOT applied here. Emergency Leave decomposes into
  // ANNUAL (+ SICK) + UNPAID children; EA-1955 s.60E forbids counting rest days / public holidays inside paid
  // ANNUAL leave, so re-including them via a day-type vector would be unlawful. EL therefore always counts its
  // paid portion in the byte-identical legacy working-days frame (no inclusion vector passed below).
  const hols = await resolveHolidaySet(tx, p.employmentId, p.startDate, p.endDate);
  const sched = await resolveSchedule(tx, p.employmentId);
  const workingDaysIso = [...new Set([...sched.workingDaysIso, ...sched.halfDaysIso])];
  // spanWorkingDays is the WEIGHTED total (Feedback 31474452 4d) — the balance-cover math below must consume
  // the same weighted figure a half-day-aware span would deduct, not a plain date count.
  const spanWorkingDays = workingDaysWeighted(p.startDate, p.endDate, hols, sched);
  const uplSpanDays = dayCount(p.startDate, p.endDate);
  if (uplSpanDays <= 0) throw new LeaveNoDaysInRangeError();

  // The span's working-day dates in order — paid segments cut at boundary working-days off the front. Rest
  // days come from the SAME configured roster as the count above (audit H#3), not a hardcoded Sat/Sun.
  const workingDates = eachDate(p.startDate, p.endDate).filter((d) => isWorkingDay(d, workingDaysIso, hols));

  // Build the ordered list of PAID segments and the unpaid remainder. SICK is prepended only for an illness
  // emergency with a real SICK type + positive balance; ANNUAL always follows. Each segment's `cover` is its
  // balance-limited WEIGHTED working-day count from resolveEmergencyIllnessCascade (sickCovered then
  // alCovered) — which degrades to exactly the AL→UPL split when there is no sick component, so the
  // non-illness path is unchanged.
  const sickBalance = isIllness && sickId ? await leaveBalance(tx, p.employmentId, sickId) : 0;
  const alBalance = await leaveBalance(tx, p.employmentId, annualId);
  const { sickCovered, alCovered, alShortfall } = resolveEmergencyIllnessCascade(
    sickBalance,
    alBalance,
    spanWorkingDays,
  );

  // Each paid segment carves working-dates off the front, in order, up to its balance-limited WEIGHT.
  const paidSegments: { typeId: string; code: string; cover: number }[] = [];
  if (isIllness && sickId && sickCovered > 0) paidSegments.push({ typeId: sickId, code: 'SICK', cover: sickCovered });
  if (alCovered > 0) paidSegments.push({ typeId: annualId, code: 'ANNUAL', cover: alCovered });

  // Feedback 31474452 (4d): date-boundary WEIGHT WALK, not a naive floor/index whole-day carve — a Half-day
  // date with the toggle ON weighs 1.0 (so it consumes like a Full day) but with the toggle OFF weighs only
  // 0.5, and a Half date can only ever be consumed WHOLE (never split across two paid segments or split
  // paid/unpaid mid-date). datesConsumed (an index into workingDates) and weightConsumed are tracked
  // SEPARATELY: hasUnpaid must compare datesConsumed to workingDates.length (a date count), never a weight
  // sum to a date count — that mismatch is exactly what would spuriously manufacture an unpaid child on a
  // span with a half date and ample balance (the panel's Fri-Mon / Sat=half scenario).
  let datesConsumed = 0;
  const plannedPaid: { typeId: string; code: string; dateCount: number; segDays: number }[] = [];
  for (const seg of paidSegments) {
    let segDates = 0;
    let segWeight = 0;
    // Consume leading unconsumed working dates while the segment's remaining cover can absorb the NEXT
    // date's weight whole (a date is never partially consumed across segments).
    while (datesConsumed + segDates < workingDates.length) {
      const nextDate = workingDates[datesConsumed + segDates];
      const nextWeight = dayWeight(nextDate, sched, hols);
      if (segWeight + nextWeight > seg.cover + 1e-9) break; // would exceed this segment's balance-limited cover
      segWeight += nextWeight;
      segDates += 1;
    }
    if (segDates > 0) {
      plannedPaid.push({ typeId: seg.typeId, code: seg.code, dateCount: segDates, segDays: round2(segWeight) });
      datesConsumed += segDates;
    }
  }
  // The unpaid remainder is every calendar day after the last paid working-DATE (or the whole span if no
  // paid dates were carved) — a DATE-COUNT compare (datesConsumed < workingDates.length), never a weight
  // compare, so a half-weighted-but-fully-consumed span never manufactures a spurious unpaid child.
  const hasUnpaid = datesConsumed < workingDates.length;

  // Consent gate (Phase-B #12A): an UNPAID child requires explicit consent — throw BEFORE any insert so a
  // missing acknowledgement leaves nothing persisted.
  if (hasUnpaid && !p.unpaidConsent) {
    // The unpaid remainder in calendar-days, for the error message (the form shows the full split itself).
    const lastPaidWorkingDay = datesConsumed > 0 ? workingDates[datesConsumed - 1] : null;
    const uplStart = lastPaidWorkingDay ? eachDate(lastPaidWorkingDay, p.endDate)[1] : p.startDate;
    const uplDays = dayCount(uplStart, p.endDate);
    throw new UnpaidConsentRequiredError(uplDays);
  }

  const parentGroupId = randomUUID();
  const consentAt = hasUnpaid ? new Date() : null;
  const children: { id: string; code: string; days: number }[] = [];

  // Insert each paid segment as a contiguous full-day child [segStart, boundaryWorkingDay]. segDays is the
  // segment's WEIGHTED total (asserted in tests to equal workingDaysWeighted(segStart, boundary)).
  let cursor = 0; // index into workingDates of the next un-assigned working-date
  for (const seg of plannedPaid) {
    const segStart = cursor === 0 ? p.startDate : eachDate(workingDates[cursor - 1], p.endDate)[1];
    const boundaryWorkingDay = workingDates[cursor + seg.dateCount - 1];
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: seg.typeId, startDate: segStart, endDate: boundaryWorkingDay,
      days: seg.segDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
      overrideAudit: overrideAudit ?? null,
    });
    children.push({ id, code: seg.code, days: seg.segDays });
    cursor += seg.dateCount;
  }

  // Insert the UNPAID remainder child (consent-stamped), if any.
  if (hasUnpaid) {
    const uplStart = cursor > 0 ? eachDate(workingDates[cursor - 1], p.endDate)[1] : p.startDate;
    const uplDays = dayCount(uplStart, p.endDate);
    const { id } = await insertLeaveRequest(tx, ctx, {
      employmentId: p.employmentId, leaveTypeId: unpaidId, startDate: uplStart, endDate: p.endDate,
      days: uplDays, durationType: 'full_day', hours: null, reason: p.reason ?? null,
      employeeRemark: null, parentGroupId, mandatoryAfterDays: null,
      unpaidConsentAt: consentAt, unpaidConsentBy: ctx.userId ?? null,
      overrideAudit: overrideAudit ?? null,
    });
    children.push({ id, code: 'UNPAID', days: uplDays });
  }

  const sickChild = children.find((c) => c.code === 'SICK');
  const alChild = children.find((c) => c.code === 'ANNUAL');
  const uplChild = children.find((c) => c.code === 'UNPAID');
  // A single EL command event keyed on parentGroupId, alongside each child's own leave-request.submitted —
  // gives the audit trail / substrate one traceable EL submission. The day counts report the ACTUAL child
  // counts (paid segments floored to whole working-days, UNPAID carries the rest — H4). The consent stamp is
  // recorded here so the audit trail proves the unpaid days were elected.
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: parentGroupId,
    eventType: 'leave-request.emergency.submitted',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      employmentId: p.employmentId,
      reasonCategory: p.reasonCategory ?? 'other',
      ...(sickChild ? { sickChildId: sickChild.id } : {}),
      ...(alChild ? { alChildId: alChild.id } : {}),
      ...(uplChild ? { uplChildId: uplChild.id } : {}),
      sickDays: sickChild?.days ?? 0,
      alDays: alChild?.days ?? 0,
      uplDays: uplChild?.days ?? 0,
      startDate: p.startDate,
      endDate: p.endDate,
      ...(hasUnpaid ? { unpaidConsent: true, unpaidConsentAt: consentAt!.toISOString() } : {}),
      // Override Leave Application (56910869): this EL submission was CONVERTED from another leave type by
      // an advance-notice rule, not chosen by the employee. Only present on the conversion path, so the
      // ordinary EL payload is byte-identical to before.
      ...(overrideAudit
        ? {
            leaveOverrideApplied: true,
            overrideTrigger: overrideAudit.trigger,
            overrideAction: overrideAudit.action,
            overrideConsentAt: overrideAudit.consentAt,
            convertedFromLeaveTypeId: overrideAudit.fromLeaveTypeId,
            convertedFromLeaveTypeName: overrideAudit.fromLeaveTypeName,
            advanceNoticeOverride: true,
            daysInAdvance: overrideAudit.daysInAdvance,
            minAdvanceDays: overrideAudit.minAdvanceDays,
            // 7daac043: the UNIT the two figures above are in — the same stamp every child's submitted event
            // carries. This is the ONE event the doc comment above promises an auditor can start from, so it
            // is exactly the event that must not leave "5" ambiguous between five calendar days and five
            // working ones. Conditional only so a pre-7daac043 audit object (no dayType) writes the payload
            // it always wrote.
            ...(overrideAudit.dayType ? { advanceNoticeDayType: overrideAudit.dayType } : {}),
          }
        : {}),
    },
  });

  // Keep `leaveRequestId` populated (the first paid child when present, else the UPL child) so the existing
  // action layer's destructure stays valid; `days` is the total covered span for parity with the ordinary path.
  const firstChildId = (sickChild ?? alChild ?? uplChild)!.id;
  return {
    leaveRequestId: firstChildId,
    days: round2(sickCovered + alCovered + alShortfall),
    parentGroupId,
    children,
  };
}

/**
 * r79 0322 — resolve the approval chain a request WOULD run, from the assignment/template matrix ALONE.
 *
 * This is the single place that answers "is this request multi-step?". Until r79 that answer came from
 * `company.leave_multi_approval`: a template assignment only fired when the company flag was on, so the
 * flag and the assigned template could disagree and the flag always won. The flag is gone (the column
 * survives, unread — no migration); the resolved chain decides, exactly as the assignment screen implies.
 *
 * Returns the chain as resolved (`resolveApprovalChain` — most-specific matching active rule, else the
 * tenant-default template, else the built-in direct_manager → hr_admin fallback) TOGETHER with the
 * requester's scoping attributes, so the one resolution serves both callers (the per-date-approval gate in
 * requestLeave and generateApprovalSteps below) and the two can never disagree about a request's shape.
 * Null only when the employment row is not visible.
 */
async function resolveRequestApprovalChain(tx: Tx, employmentId: string, leaveTypeId: string, days: number) {
  const [co] = await tx
    .select({ companyId: company.id })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!co) return null;

  // ADR-0071: gather the requester's OWN current-assignment attributes (validTo/supersededAt null — the
  // same currentAssignment predicate used across the read layer) plus grade (on the employment row) and
  // the department's business unit (nullable — a BU-scoped rule simply fails to match when unset, never
  // errors). Scoped strictly to THIS employmentId — never a concurrent employment at another company
  // (ADR-0071 1(f)).
  const [attr] = await tx
    .select({
      gradeId: employment.gradeId,
      departmentId: assignment.departmentId,
      positionId: assignment.positionId,
      employmentType: assignment.employmentType,
      businessUnitId: department.businessUnitId,
    })
    .from(employment)
    .leftJoin(
      assignment,
      and(
        eq(assignment.employmentId, employment.id),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .leftJoin(department, eq(department.id, assignment.departmentId))
    .where(eq(employment.id, employmentId))
    .limit(1);

  // R41 72800eda: map the requester's individual grade → its GRADE GROUP (grade_group_member) so a
  // grade-group-scoped approval rule can match. A grade belongs to at most one group (unique index); an
  // ungrouped/ungraded requester resolves to null and simply never matches a group-scoped rule.
  let gradeGroupId: string | null = null;
  if (attr?.gradeId) {
    const [gm] = await tx
      .select({ gradeGroupId: gradeGroupMember.gradeGroupId })
      .from(gradeGroupMember)
      .where(eq(gradeGroupMember.gradeId, attr.gradeId))
      .limit(1);
    gradeGroupId = gm?.gradeGroupId ?? null;
  }

  // 2B-2 / ADR-0071: the chain is data — resolve the most-specific matching rule for this request.
  //
  // r293 — `resolveApprovalDecision` rather than its `resolveApprovalChain` wrapper, because the admin
  // PREVIEW has to name WHERE the chain came from (a scoped rule, the org-wide default, or the built-in
  // fallback) and re-resolving to find that out would be a second ranking of the same rows over a
  // different attribute set. The chain below is that decision's own `levels` — the wrapper's whole body.
  const decision = await resolveApprovalDecision(tx, co.companyId, leaveTypeId, {
    gradeId: attr?.gradeId ?? null,
    gradeGroupId,
    departmentId: attr?.departmentId ?? null,
    positionId: attr?.positionId ?? null,
    employmentType: attr?.employmentType ?? null,
    businessUnitId: attr?.businessUnitId ?? null,
    days,
  });
  return { companyId: co.companyId, chain: decision.levels, decision, attr: attr ?? null };
}

/** r79 0322 — a request is MULTI-STEP when its resolved chain has two or more levels. One level is a
 *  single-approver request: it produces NO leave_approval_step rows, i.e. the existing whole-request
 *  decideLeave path (`/approvals` and the decide path route on `steps.length > 0`), NOT a one-element
 *  chain. Assigning a one-step template is therefore how a company keeps plain single-step approval. */
export function isMultiStepChain(chain: readonly string[]): boolean {
  return chain.length > 1;
}

/** r293 — the org facts the chain's DROP RULES consult, read once per request. Nothing else decides
 *  whether a level survives: `applyChainDropRules` is pure over this. */
export type ChainResolutionFacts = {
  /** The subject has a current ADMINISTRATIVE reporting line (direct_manager resolves to somebody). */
  hasManager: boolean;
  /** r293 phase 2 — the SECOND hop up the same administrative line (the direct manager's own manager),
   *  or null when either hop is missing. Null too when the second hop resolves back to the SUBJECT: a
   *  two-person reporting cycle would otherwise route the request to the person who raised it, and a
   *  level whose only approver is the requester is worse than a level that is skipped. */
  managerManager: string | null;
  /** The subject's department's head employment id, or null when the department has no head set. */
  deptHead: string | null;
  /** The subject's business unit's head employment id, or null when the BU has no head set. */
  buHead: string | null;
  /**
   * r293 phase 3 — the FIXED approvers named by this chain that are no longer an ACTIVE employment,
   * by employment id. It is NOT a drop rule: a fixed level is never dropped (see applyChainDropRules),
   * and the plan promises the reporter a WARNING rather than a silent skip — dropping would quietly
   * weaken the chain an administrator deliberately configured. This is what the builder and the preview
   * warn from, and `isEmploymentEnded` (core/employment-status.ts) is the predicate, not a new rule.
   */
  endedFixedApprovers: readonly string[];
};

/** Why a level was dropped: the relationship that resolved to nobody. */
export type DropReason = 'no_manager' | 'no_manager_manager' | 'no_department_head' | 'no_business_unit_head';

/** r293 — one level of a resolved chain and whether it survives generation. `kept: false` is the DROP:
 *  the step is never written, and the request carries on to the next level rather than stalling. */
export type ResolvedChainLevel = {
  kind: string;
  /** r293 phase 3 — the NAMED approver for a fixed level; null for every relationship-resolved kind. */
  employmentId: string | null;
  /** r293 phase 3 — true when this level names a person who is no longer an active employment. The level
   *  is still KEPT: a fixed approver cannot be dropped, which is exactly why this has to be said out loud. */
  fixedApproverEnded: boolean;
  /** r293 phase 4 — the OTHER approvers who may clear this level, any ONE of whom is enough. Empty on a
   *  single-approver level, which is every level that existed before phase 4. */
  alternates: ApprovalApprover[];
  kept: boolean;
  /** Why it was dropped: the relationship that resolved to nobody. Null when kept. */
  droppedBecause: DropReason | null;
};

/** Read the subject's org facts. Runs in the caller's transaction, under the caller's RLS. */
async function resolveChainFacts(
  tx: Tx,
  employmentId: string,
  attr: { departmentId?: string | null; businessUnitId?: string | null } | null,
  /** The chain being resolved — needed only to check the FIXED approvers it names. */
  levels: readonly ApprovalLevel[] = [],
): Promise<ChainResolutionFacts> {
  // Include a manager step only when the employee has a current administrative reporting line;
  // otherwise direct_manager levels are dropped (no dead step that nobody can clear).
  const [mgr] = await tx
    .select({ id: reportingLine.id, managerEmploymentId: reportingLine.managerEmploymentId })
    .from(reportingLine)
    .where(
      and(
        eq(reportingLine.subordinateEmploymentId, employmentId),
        eq(reportingLine.lineType, 'administrative'),
        lte(reportingLine.validFrom, sql`current_date`),
        or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
      ),
    )
    .limit(1);

  // r293 phase 2 — the SECOND hop, resolved with the SAME predicate as the first so the two levels cannot
  // disagree about what "current administrative line" means. Null when the first hop is missing, when the
  // manager has no manager of their own, or when the second hop points back at the subject.
  let managerManager: string | null = null;
  if (mgr?.managerEmploymentId) {
    const [grand] = await tx
      .select({ managerEmploymentId: reportingLine.managerEmploymentId })
      .from(reportingLine)
      .where(
        and(
          eq(reportingLine.subordinateEmploymentId, mgr.managerEmploymentId),
          eq(reportingLine.lineType, 'administrative'),
          lte(reportingLine.validFrom, sql`current_date`),
          or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
        ),
      )
      .limit(1);
    const candidate = grand?.managerEmploymentId ?? null;
    managerManager = candidate && candidate !== employmentId ? candidate : null;
  }

  // 6fadb036 (gap-close): head-kind steps route to an org-chart head. Resolve the subject's department and
  // business-unit heads once; a head step is DROPPED when its head is unset, mirroring the direct_manager
  // drop (no dead step nobody can clear). HR / HR Manager / Payroll / Custom Role steps are role-based and
  // are never dropped here — they resolve to role authority at decision time.
  let deptHead: string | null = null;
  if (attr?.departmentId) {
    const [d] = await tx
      .select({ head: department.headEmploymentId })
      .from(department)
      .where(eq(department.id, attr.departmentId))
      .limit(1);
    deptHead = d?.head ?? null;
  }
  let buHead: string | null = null;
  if (attr?.businessUnitId) {
    const [b] = await tx
      .select({ head: businessUnit.headEmploymentId })
      .from(businessUnit)
      .where(eq(businessUnit.id, attr.businessUnitId))
      .limit(1);
    buHead = b?.head ?? null;
  }
  // r293 phase 3 — which of the chain's NAMED approvers have left. Read once for the whole chain, and
  // through `isEmploymentEnded` so the warning agrees with the status every screen shows rather than
  // inventing a second definition of "gone".
  const named = [
    ...new Set(
      levels
        .flatMap((l) => approversOf(l))
        .filter((a) => a.employmentId)
        .map((a) => a.employmentId as string),
    ),
  ];
  let endedFixedApprovers: string[] = [];
  if (named.length) {
    const rows = await tx
      .select({
        id: employment.id,
        terminatedOn: employment.terminatedOn,
        resignationDate: employment.resignationDate,
        lastWorkingDate: employment.lastWorkingDate,
        blacklistedAt: employment.blacklistedAt,
      })
      .from(employment)
      .where(inArray(employment.id, named));
    const seen = new Set(rows.map((r) => r.id));
    endedFixedApprovers = [
      // An id this transaction cannot see AT ALL is treated as ended: the approver either no longer
      // exists or is outside the reader's tenant, and in both cases the chain is pointing at nobody.
      ...named.filter((id) => !seen.has(id)),
      ...rows.filter((r) => isEmploymentEnded(r)).map((r) => r.id),
    ];
  }
  return { hasManager: !!mgr, managerManager, deptHead, buHead, endedFixedApprovers };
}

/**
 * r293 — THE DROP RULE, extracted so generation and the admin PREVIEW cannot disagree.
 *
 * This filter used to live inline in `generateApprovalSteps`, which is why nothing could show an
 * administrator that a level would be skipped. r285 is what that costs: `department_head` and
 * `business_unit_head` silently skipped for every request on the customer's tenant because no department
 * or BU had a head set, and no screen said so. The preview on the Approval Workflow screen runs THIS
 * function over THESE facts — not a sketch of them.
 *
 * Pure. The kinds it can drop are `DROPPABLE_LEVEL_KINDS` (core/leave-approval-policy.ts) and
 * `test/r293-approval-builder.test.ts` pins the two in step across the files.
 */
/** Does this ONE approver resolve to somebody? The kind-by-kind drop rule, over a single approver. */
function approverResolves(a: ApprovalApprover, facts: ChainResolutionFacts): DropReason | null {
  if (a.kind === 'direct_manager' && !facts.hasManager) return 'no_manager';
  if (a.kind === 'manager_manager' && !facts.managerManager) return 'no_manager_manager';
  if (a.kind === 'department_head' && !facts.deptHead) return 'no_department_head';
  if (a.kind === 'business_unit_head' && !facts.buHead) return 'no_business_unit_head';
  return null;
}

export function applyChainDropRules(
  chain: readonly ApprovalLevel[],
  facts: ChainResolutionFacts,
): ResolvedChainLevel[] {
  return chain.map((level) => {
    const { kind, employmentId } = level;
    // r293 phase 3 — THE ASYMMETRY, stated once and in the only place that can act on it. A FIXED level
    // is returned KEPT unconditionally, even when the person it names has left: there is no relationship
    // to resolve to nobody, so there is nothing to drop. The flag below is what the builder and the
    // preview warn from. Dropping instead would silently remove an approval an administrator deliberately
    // put in the chain, and the plan promises the reporter a warning, not a skip.
    const fixedApproverEnded = !!employmentId && facts.endedFixedApprovers.includes(employmentId);
    const base = {
      kind,
      employmentId: employmentId ?? null,
      alternates: level.alternates,
      fixedApproverEnded,
    };
    // r293 phase 4 — an ANY-ONE level is dropped only when EVERY one of its approvers resolves to
    // nobody. One surviving approver is the whole point: "Direct manager OR Sarah" must still run for an
    // employee with no manager, because Sarah is there. The drop reason reported is the PRIMARY
    // approver's, which is the one the level is named after on every screen.
    const reasons = approversOf(level).map((a) => approverResolves(a, facts));
    if (reasons.every((r) => r !== null)) {
      return { ...base, kept: false, droppedBecause: reasons[0] };
    }
    return { ...base, kept: true, droppedBecause: null };
  });
}

/** r293 — what the Approval Workflow builder's PREVIEW shows: the chain a real employee's request would
 *  actually run, resolved against today's org chart, with the dropped levels named rather than hidden. */
export type ApprovalChainPreview = {
  /** Every level of the RESOLVED template chain, in order, kept or dropped. */
  levels: ResolvedChainLevel[];
  /** Where the chain came from: a scoped rule, the org-wide default template, or the built-in fallback. */
  source: ApprovalDecisionSource;
  /** The winning rule's id when `source === 'rule'`. */
  ruleId: string | null;
  /** True when the surviving chain is multi-step and so writes leave_approval_step rows. A one-level
   *  survivor is the single-approver path (no step rows) — see isMultiStepChain. */
  multiStep: boolean;
  facts: ChainResolutionFacts;
};

/**
 * r293 — resolve, for a REAL employee and leave type, the approval chain their request would take today.
 *
 * Deliberately built from the same two pieces the submission path uses — `resolveRequestApprovalChain`
 * (the one matcher) and `applyChainDropRules` (the one drop rule) — so the preview cannot drift from what
 * `generateApprovalSteps` will actually write. A preview with a ranking or a drop rule of its own would be
 * a second source of truth about who approves, which is the exact defect this screen exists to expose.
 *
 * Read-only: no rows are written, nothing is snapshotted. `days` defaults to 1 so a day-range-scoped rule
 * participates the way a one-day request would; callers that care pass the span they mean.
 */
export async function previewApprovalChain(
  ctx: SessionContext,
  p: { employmentId: string; leaveTypeId: string; days?: number },
): Promise<ApprovalChainPreview | null> {
  return withTenant(ctx, async (tx) => {
    const days = p.days ?? 1;
    const resolved = await resolveRequestApprovalChain(tx, p.employmentId, p.leaveTypeId, days);
    if (!resolved) return null;
    const facts = await resolveChainFacts(tx, p.employmentId, resolved.attr, resolved.decision.resolvedLevels);
    const levels = applyChainDropRules(resolved.decision.resolvedLevels, facts);
    return {
      levels,
      source: resolved.decision.source,
      ruleId: resolved.decision.ruleId,
      // The gate generateApprovalSteps applies: it branches on the RESOLVED chain BEFORE the drop rules,
      // so a two-level template whose manager level is dropped still takes the multi-step path (one step
      // row) rather than collapsing to the single-approver path.
      multiStep: isMultiStepChain(resolved.chain),
      facts,
    };
  });
}

/** Generate the approval chain for a new request whose resolved chain is multi-step (r79 0322 — the
 *  resolved chain's own step count is the gate; `company.leave_multi_approval` no longer takes part).
 *  2B-1 chain is fixed: direct manager (when one exists) then HR. 2B-2 made it configurable per
 *  company/leave-type; ADR-0071 makes it a SCOPED RULE MATRIX resolved against the requester's CURRENT
 *  assignment attributes + day count. `days` is the request's leave-day count — the fractional
 *  day-equivalent for hourly/partial requests (ADR-0071 1(h)), so an hourly request still participates in
 *  day-range matching. The generated steps are snapshotted here at submission time and NEVER re-resolved
 *  (ADR-0071 1(g)) — editing/archiving a rule later cannot change a pending request's routing. */
async function generateApprovalSteps(
  tx: Tx,
  tenantId: string,
  leaveRequestId: string,
  employmentId: string,
  leaveTypeId: string,
  days: number,
) {
  const resolved = await resolveRequestApprovalChain(tx, employmentId, leaveTypeId, days);
  if (!resolved) return;
  const { chain, attr } = resolved;
  // The gate. Branching on the chain BEFORE the drop rules below is deliberate: a two-step template whose
  // manager step is dropped (no reporting line) has always produced ONE step row, and still does. Only a
  // chain that is one level BY CONFIGURATION collapses to the single-approver path.
  if (!isMultiStepChain(chain)) return;

  const facts = await resolveChainFacts(tx, employmentId, attr, resolved.decision.resolvedLevels);
  const kept = applyChainDropRules(resolved.decision.resolvedLevels, facts).filter((l) => l.kept);
  if (kept.length === 0) return;
  await tx.insert(leaveApprovalStep).values(
    // r293 phase 3 — the kind and the named approver are written TOGETHER, from one sanitised level.
    // That pairing is the invariant migration 0467 deliberately does not put in a check constraint, and
    // this is the single writer it is enforced in.
    kept.map((level, stepIndex) => ({
      tenantId,
      leaveRequestId,
      subjectEmploymentId: employmentId,
      stepIndex,
      approverKind: level.kind,
      approverEmploymentId: level.employmentId,
      // r293 phase 4 — NULL, not [], when the level has one approver: "no alternates" and "an empty list
      // of alternates" must not be two different values in the column, and NULL is what every row written
      // before this migration holds.
      approverAlternates: level.alternates.length
        ? level.alternates.map((a) => (a.employmentId ? { kind: a.kind, employmentId: a.employmentId } : a.kind))
        : null,
    })),
  );
}

/** Attach a supporting document to a pending leave request (2A-2). employment_id is denormalized from
 *  the request so the attachment's RLS matches the request (subject + manager + admin). */
export async function addLeaveAttachment(
  ctx: SessionContext,
  p: { leaveRequestId: string; fileName: string; mimeType: string; content: Buffer },
): Promise<{ id: string }> {
  if (p.content.byteLength === 0) throw new Error('Empty file');
  return withTenant(ctx, async (tx) => {
    // Doc-config: join the type to read its mime/size rule. The /me flow already validated upstream (so
    // a bad file never created an orphan request); this is defence-in-depth for any other caller and
    // replaces the previously hard-coded 10 MB ceiling with the type's configured limit.
    const [req] = await tx
      .select({
        employmentId: leaveRequest.employmentId,
        status: leaveRequest.status,
        allowedMimeTypes: leaveType.allowedMimeTypes,
        maxDocBytes: leaveType.maxDocBytes,
      })
      .from(leaveRequest)
      .innerJoin(leaveType, eq(leaveType.id, leaveRequest.leaveTypeId))
      .where(eq(leaveRequest.id, p.leaveRequestId))
      .limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error('Documents can only be added while the request is pending');
    validateLeaveDocument(
      { allowedMimeTypes: req.allowedMimeTypes, maxDocBytes: req.maxDocBytes },
      { mimeType: p.mimeType, sizeBytes: p.content.byteLength },
    );
    const [row] = await tx
      .insert(leaveRequestAttachment)
      .values({
        tenantId: ctx.tenantId,
        leaveRequestId: p.leaveRequestId,
        employmentId: req.employmentId,
        content: p.content,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.content.byteLength,
        uploadedByUserId: ctx.userId ?? null,
      })
      .returning({ id: leaveRequestAttachment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: p.leaveRequestId,
      eventType: 'leave-request.document.attached',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { fileName: p.fileName, sizeBytes: p.content.byteLength },
    });
    return { id: row.id };
  });
}

/** Stream a leave request's supporting document. Runs under RLS (subject + manager + admin). */
export async function getLeaveAttachment(
  ctx: SessionContext,
  leaveRequestId: string,
): Promise<{ content: Buffer; fileName: string; mimeType: string } | null> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        content: leaveRequestAttachment.content,
        fileName: leaveRequestAttachment.fileName,
        mimeType: leaveRequestAttachment.mimeType,
      })
      .from(leaveRequestAttachment)
      .where(eq(leaveRequestAttachment.leaveRequestId, leaveRequestId))
      .orderBy(desc(leaveRequestAttachment.createdAt))
      .limit(1);
    return row ? { content: row.content as Buffer, fileName: row.fileName, mimeType: row.mimeType } : null;
  });
}

/** Only HR (hr_admin / super_admin) may clear an hr_admin step; an HR admin still cannot decide their
 *  own request (mirrors assertCanDecide's self-ban). */
async function assertIsHrAdmin(tx: Tx, ctx: SessionContext, subjectEmploymentId: string, label: string) {
  const roles = ctx.roles ?? [];
  const isSuper = roles.includes('super_admin');
  if (!(isSuper || roles.includes('hr_admin'))) throw new Error(`Only HR can decide this ${label}`);
  if (!isSuper && ctx.personId != null) {
    const [subj] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, subjectEmploymentId))
      .limit(1);
    if (subj?.personId === ctx.personId) throw new Error(`You cannot decide your own ${label}`);
  }
}

/** 6fadb036 (gap-close) — dispatch a leave approval step to the right decider-authority check for its kind.
 *  Each kind's semantics are documented on LEVEL_KINDS (core/leave-approval-policy.ts). The self-approval
 *  ban applies to every kind (super_admin keeps the sole-admin escape hatch), matching assertCanDecide. */
/**
 * r293 phase 4 — THE ONE ENGINE CHANGE OF THE WHOLE ITEM: when does a step count as satisfied?
 *
 * A step is satisfied when the caller passes the gate for ANY ONE of its approvers. On a level with a
 * single approver — every level that existed before phase 4 — that is byte-for-byte the old behaviour,
 * because the loop runs once.
 *
 * ⚠️ WHAT THE LOOP MUST NOT DO, and the reason it is written this way. Each per-approver gate REFUSES BY
 * THROWING, so "try the next one" means catching. Catching indiscriminately would swallow a database
 * error and then quietly accept the request under a different approver, so the refusals are collected and
 * the FIRST one is re-thrown when every approver refuses — the caller sees a real reason, not a generic
 * one, and nothing is ever approved because an error was mistaken for a refusal.
 *
 * ⚠️ THE SELF-APPROVAL BAN SURVIVES INTACT, and that is the property most worth stating. Every gate
 * carries its own ban against the SUBJECT, so a requester who is one of the alternates is refused on that
 * alternate — and any OTHER alternate may still clear the step, which is exactly right: "Sarah or Ahmad"
 * with Sarah requesting means Ahmad approves, not that the level is skipped and not that Sarah approves
 * her own leave.
 */
async function assertCanDecideLeaveStep(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  kind: string,
  label: string,
  /** r293 phase 3 — the step's OWN named approver, for FIXED kinds. Read off the snapshot row, never
   *  re-resolved from the template: the snapshot is what makes a template edit safe for leave in flight,
   *  and a decider check that went back to the template would undo exactly that. */
  approverEmploymentId?: string | null,
  /** r293 phase 4 — the step's OWN alternates snapshot (the raw jsonb column). */
  approverAlternates?: unknown,
) {
  const alternates = sanitizeApprovalLevels(Array.isArray(approverAlternates) ? approverAlternates : []);
  const approvers: ApprovalApprover[] = [
    { kind: kind as ApprovalApprover['kind'], employmentId: approverEmploymentId ?? null },
    ...alternates.map((l) => ({ kind: l.kind, employmentId: l.employmentId })),
  ];
  const refusals: unknown[] = [];
  for (const approver of approvers) {
    try {
      await assertCanDecideAsApprover(tx, ctx, subjectEmploymentId, approver.kind, label, approver.employmentId);
      return;
    } catch (e) {
      refusals.push(e);
    }
  }
  throw refusals[0];
}

/** The gate for ONE approver of a step — the per-kind decider authority. Unchanged by phase 4 except
 *  that it is now called once per approver instead of once per step. */
async function assertCanDecideAsApprover(
  tx: Tx,
  ctx: SessionContext,
  subjectEmploymentId: string,
  kind: string,
  label: string,
  approverEmploymentId?: string | null,
) {
  const roles = ctx.roles ?? [];
  const isSuper = roles.includes('super_admin');
  // HR admins hold full leave visibility + authority, so they can clear ANY step — this guarantees every
  // chain completes even when the designated role-holder/head lacks RLS visibility to the request (a payroll
  // partner or a dept/BU head who is not also the subject's admin manager cannot see it). The designated
  // decider still clears their own step when they DO have access (checked below). Documented in the
  // approver-vocabulary note (ADR-0071 §i follow-up: dedicated approver-role visibility).
  const isAdminRole = isSuper || roles.includes('hr_admin');
  // Shared self-approval ban (skipped for super_admin, like assertCanDecide / assertIsHrAdmin).
  const banSelf = async () => {
    if (isSuper || ctx.personId == null) return;
    const [subj] = await tx
      .select({ personId: employment.personId })
      .from(employment)
      .where(eq(employment.id, subjectEmploymentId))
      .limit(1);
    if (subj?.personId === ctx.personId) throw new Error(`You cannot decide your own ${label}`);
  };

  switch (kind) {
    case 'direct_manager':
      // The direct-manager chain step is a leave APPLICATION decision — a scoped delegation must cover it.
      return assertCanDecide(tx, ctx, subjectEmploymentId, label, scopeOf('leave.application'));
    case 'manager_manager': {
      // r293 phase 2 — THE SECOND HOP, and it mirrors direct_manager by RE-ASKING THE SAME QUESTION ONE
      // LEVEL UP rather than by re-implementing the reporting-line walk. `assertCanDecide` answers "may
      // this caller decide FOR that employment" — so asking it about the subject's MANAGER is exactly
      // "is this caller the manager's manager", and the delegation branch, the effective-window predicate
      // and the org-scope gate inside it all come along unchanged. A copy of that walk here would be a
      // second authorization rule to keep in step with the first.
      //
      // TWO SELF-BANS, NOT ONE, because the shifted subject shifts the ban with it:
      //   · assertCanDecide's own ban stops the DIRECT MANAGER clearing this step — which is the whole
      //     point of a second hop, and would be a silent single-approval if it were allowed;
      //   · banSelf() below stops the SUBJECT clearing it, which assertCanDecide can no longer see
      //     because it is now looking at the manager. A two-person reporting cycle is dropped at
      //     generation time (resolveChainFacts), so this is the belt to that braces — an org change
      //     BETWEEN submission and decision can create the cycle the generated step predates.
      await banSelf();
      if (isAdminRole) return; // HR/super clears any step (guaranteed visibility), as everywhere here.
      const [mgr] = await tx
        .select({ managerEmploymentId: reportingLine.managerEmploymentId })
        .from(reportingLine)
        .where(
          and(
            eq(reportingLine.subordinateEmploymentId, subjectEmploymentId),
            eq(reportingLine.lineType, 'administrative'),
            lte(reportingLine.validFrom, sql`current_date`),
            or(isNull(reportingLine.validTo), sql`${reportingLine.validTo} > current_date`),
          ),
        )
        .limit(1);
      if (!mgr?.managerEmploymentId) {
        throw new Error(`No manager's manager is recorded for this employee — an admin must decide`);
      }
      // ⚠️ SAY WHAT IS ACTUALLY WRONG. Delegating to assertCanDecide about the MANAGER means its own
      // self-ban fires when the caller IS that manager — the correct refusal (a second hop the first hop
      // can clear is not a second hop), but its message reads "You cannot decide your own leave request",
      // which is not true and which a reader would believe. Found by driving the refusal on a dev server.
      const [mgrPerson] = await tx
        .select({ personId: employment.personId })
        .from(employment)
        .where(eq(employment.id, mgr.managerEmploymentId))
        .limit(1);
      if (ctx.personId != null && mgrPerson?.personId === ctx.personId) {
        throw new Error(`Only the manager's manager or HR can decide this ${label}`);
      }
      return assertCanDecide(tx, ctx, mgr.managerEmploymentId, label, scopeOf('leave.application'));
    }
    // HR-tier / generic-admin gates. hr_manager and custom_role are cleared by HR/admins today; a distinct
    // ranked hr_manager role and a per-step bound custom role are documented follow-ups (ADR-0071 §i).
    case 'hr_admin':
    case 'hr_manager':
    case 'custom_role':
      return assertIsHrAdmin(tx, ctx, subjectEmploymentId, label);
    case 'payroll': {
      await banSelf();
      if (isAdminRole) return; // HR/super clears it (guaranteed visibility)
      const [subj] = await tx
        .select({ companyId: employment.companyId })
        .from(employment)
        .where(eq(employment.id, subjectEmploymentId))
        .limit(1);
      const ok = (ctx.grants ?? []).some(
        (g) => g.role === 'payroll_partner' && (g.companyId == null || g.companyId === subj?.companyId),
      );
      if (!ok) throw new Error(`Only Payroll or HR can decide this ${label}`);
      return;
    }
    case 'specific_employee': {
      // r293 phase 3 — THE ONLY KIND THAT ROUTES TO A PERSON. No relationship is consulted: the step
      // carries the employment id it was generated with, and the person holding that employment decides.
      await banSelf();
      if (!approverEmploymentId) {
        // A fixed step with nobody named cannot exist (sanitizeApprovalLevels drops such a level, and
        // generation writes the pair together) — so reaching here means a hand-written row. Refuse
        // rather than fall through to an admin-only gate that would read as if the step were role-based.
        throw new Error(`This ${label} step names no approver — an admin must correct the template`);
      }
      if (ctx.personId != null) {
        const [named] = await tx
          .select({ personId: employment.personId })
          .from(employment)
          .where(eq(employment.id, approverEmploymentId))
          .limit(1);
        if (named?.personId === ctx.personId) return;
      }
      // HR/super clears it LAST, not first: unlike every other kind, this step has a specific human whose
      // decision is the point, so the named person is offered the step before the admin override applies.
      // The override still exists — it is what stops a fixed approver who has left stalling the chain
      // forever, which is the risk the builder warns about.
      if (isAdminRole) return;
      throw new Error(`Only the named approver or HR can decide this ${label}`);
    }
    case 'department_head':
    case 'business_unit_head': {
      await banSelf();
      if (isAdminRole) return; // HR/super clears it (guaranteed visibility)
      const head = await resolveSubjectHead(tx, subjectEmploymentId, kind);
      const roleLabel = kind === 'department_head' ? 'department head' : 'business unit head';
      if (head != null) {
        const [h] = await tx
          .select({ personId: employment.personId })
          .from(employment)
          .where(eq(employment.id, head))
          .limit(1);
        if (ctx.personId != null && h?.personId === ctx.personId) return;
      }
      // R51 (baf56348, migration 0286) — head-step HANDOVER: an active delegate OF THE RESOLVED HEAD may
      // clear the head's step. This is the piece that actually transfers head-level authority — the
      // admin-manager-anchored delegation branch (assertCanDecide) never reaches these branches, so before
      // this a HOD-to-HOD delegation handed over nothing at head steps. The head is re-resolved INSIDE the
      // definer boundary (app.subject_head): RLS hides the subject's assignment from a delegate, so the
      // RLS-scoped resolveSubjectHead above returns null under the delegate's session. The definer helper
      // re-validates window / live delegator / module scope / org scope at decision time; the self-ban
      // above still applies to the delegate.
      if (ctx.personId != null) {
        const res = await tx.execute(
          sql`SELECT app.can_decide_via_delegation_from(app.subject_head(${subjectEmploymentId}, ${kind}), ${subjectEmploymentId}, 'leave', 'leave.application') AS ok`,
        );
        if ((res as unknown as { ok: boolean }[])[0]?.ok) return;
      }
      if (head == null) throw new Error(`No ${roleLabel} is set for this employee — an admin must decide or assign one`);
      throw new Error(`Only the ${roleLabel} or HR can decide this ${label}`);
    }
    default:
      throw new Error(`Unknown approver step for this ${label}`);
  }
}

/** Resolve the subject's current department-head or business-unit-head employment id (null when unset).
 *  Uses the subject's CURRENT assignment (validTo/supersededAt null), the same predicate as elsewhere. */
export async function resolveSubjectHead(
  tx: Tx,
  subjectEmploymentId: string,
  kind: 'department_head' | 'business_unit_head',
): Promise<string | null> {
  if (kind === 'department_head') {
    const [row] = await tx
      .select({ head: department.headEmploymentId })
      .from(assignment)
      .innerJoin(department, eq(department.id, assignment.departmentId))
      .where(
        and(
          eq(assignment.employmentId, subjectEmploymentId),
          isNull(assignment.validTo),
          isNull(assignment.supersededAt),
        ),
      )
      .limit(1);
    return row?.head ?? null;
  }
  const [row] = await tx
    .select({ head: businessUnit.headEmploymentId })
    .from(assignment)
    .innerJoin(department, eq(department.id, assignment.departmentId))
    .innerJoin(businessUnit, eq(businessUnit.id, department.businessUnitId))
    .where(
      and(
        eq(assignment.employmentId, subjectEmploymentId),
        isNull(assignment.validTo),
        isNull(assignment.supersededAt),
      ),
    )
    .limit(1);
  return row?.head ?? null;
}

// endDate is widened in (alongside days/startDate) for the on-approval payroll-impact enrichment below. At
// runtime decideLeave passes the full leave_request row, so endDate is always present; the type just exposes it.
// unpaidDays (a7fab30b) is widened in for the same reason: at runtime every caller passes the full
// leave_request row, so it is always present; the type just exposes it. Optional so a hand-built test row
// (or a caller predating the column) still type-checks as fully paid.
type DecidableLeave = { id: string; employmentId: string; leaveTypeId: string; days: string; startDate: string; endDate: string; unpaidDays?: string | null };

/** Final approval: balance gate + ledger debit + status flip + event. daysOverride (ADR-0068 §4E) lets the
 *  per-date finalization debit only the sum of APPROVED dates instead of the whole request span; it defaults
 *  to req.days for every non-per-date caller (byte-identical behaviour). Guard: since §4C excludes REPLACEMENT
 *  from per-date approval, the daysOverride path never reaches the consumeReplacementLeaveTx branch with a
 *  partial `need`; we assert that invariant so the TOIL consume-on-approve register is never under-consumed.
 *  `mixed` (Partial Leave Approval notification fix): the sole caller that sets it is decideLeaveDate's
 *  finalization when ≥1 date was approved AND ≥1 was rejected — it tags the approved-event payload so the
 *  notification renderer emits the honest "partially approved — see the breakdown" body instead of a flat
 *  "approved". It defaults to false/omitted so every non-per-date call site's event payload is byte-identical
 *  to today (the multi-step chain finalization and the single-step whole-request approval never pass it). */
/** The per-date outcome carried into a MIXED approval event so the notification renderer can list which
 *  dates were approved / rejected (and why) instead of a generic "see the breakdown". Only populated for the
 *  mixed case; omitted for every whole-request / all-approved caller so their payload stays byte-identical. */
type PerDateOutcome = { approved: string[]; rejected: { date: string; reason: string | null }[] };

async function finalizeLeaveApproval(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  daysOverride?: number,
  mixed = false,
  perDateOutcome?: PerDateOutcome,
) {
  // Unpaid-leave payroll-impact: fetch the type's code + payroll-signal gate once — plus (cdf9ca48) the
  // balance source, which the gate and the debit below both need. Both approval paths (multi-step final
  // clearance and single-step) funnel through this function, so the enrichment fires exactly once at terminal
  // approval and never at intermediate leave-request.step.approved.
  const [lt] = await tx
    .select({
      code: leaveType.code,
      paid: leaveType.paid,
      sendToPayroll: leaveType.sendToPayroll,
      balanceSourceTypeId: leaveType.balanceSourceTypeId,
      // 9861b8a4 — the approval gate below now consults these. See its comment for why the pair, and not
      // the switch alone, is what unlocks it.
      allowNegativeBalance: leaveType.allowNegativeBalance,
      maxNegativeBalance: leaveType.maxNegativeBalance,
    })
    .from(leaveType)
    .where(eq(leaveType.id, req.leaveTypeId))
    .limit(1);
  // Balance Deduction Source (cdf9ca48): the ledger this approval actually moves. Resolved from the SAME
  // column availableLeaveBalance read at submission, so the gate below and the guard the employee already
  // passed are talking about one balance. NULL ⇒ the request's own type (every type until one is switched).
  const balanceTypeId = lt?.balanceSourceTypeId ?? req.leaveTypeId;
  const balance = await leaveBalance(tx, req.employmentId, balanceTypeId);
  // Allow Unpaid Leave (a7fab30b): only the covered part is a balance movement. The unpaid excess was
  // measured against the balance at submission and is settled through payroll, so debiting it here would
  // charge the employee twice — once in days, once in pay. NULL/absent ⇒ the full span, as before.
  const unpaid = Number(req.unpaidDays ?? 0);
  // approvedDays = the days actually being approved (the whole span, or the per-date subset). `need` is the
  // subset of THOSE that draws on the balance. They differ only for a part-unpaid request; keeping them
  // separate matters because the combined-pool limit and the payroll advisory below count leave TAKEN, which
  // includes the unpaid days, while the ledger counts only what was paid for out of the balance.
  const approvedDays = daysOverride ?? Number(req.days);
  const need = round2(Math.max(0, approvedDays - unpaid));
  // 9861b8a4 — THE APPROVAL GATE FINALLY CONSULTS allow_negative_balance, and it is OPT-IN PER TYPE.
  //
  // Until now this refused ANY below-zero result without ever reading the flag, so a type set to "Yes"
  // let an employee SUBMIT leave they had not earned and then refused it at approval. A balance could not
  // fall below zero through the ordinary apply-and-approve route at all; every negative balance in the
  // system arrived via an adjustment or an expiry sweep. bc512dc3's floor was therefore capping how far a
  // SUBMITTED application could reach, not how far an approved balance could fall.
  //
  // ⚠️ THE SWITCH ALONE IS NOT ENOUGH, DELIBERATELY. Loosening on `allowNegativeBalance` by itself would
  // have changed behaviour immediately for every type that already carries it — on production that is a
  // set nobody chose with this consequence in mind, because the flag has never meant what it said here.
  // The unlock is the PAIR: the switch on AND a floor typed in. A type set to Yes with no floor keeps
  // today's behaviour exactly, so this ships inert and turns on one leave type at a time, as its
  // administrator decides. The leave-type screen lists the Yes-without-a-figure types so that decision is
  // visible rather than buried.
  //
  // The floor is enforced against the SAME balance this gate reads (the resolved balance source), so the
  // submit-time check and this one can never be talking about different ledgers.
  const negativeFloor = lt?.allowNegativeBalance === true ? Number(lt.maxNegativeBalance ?? Number.NaN) : Number.NaN;
  const negativeAllowed = Number.isFinite(negativeFloor) && negativeFloor > 0;
  if (negativeAllowed) {
    if (round2(balance - need) < -negativeFloor) {
      throw new NegativeLeaveBalanceLimitExceededError({
        leaveTypeName: lt?.code ?? 'leave',
        maxNegativeBalance: negativeFloor,
        availableDays: round2(balance),
        requestedDays: need,
      });
    }
  } else if (balance - need < 0) {
    throw new InsufficientLeaveBalanceError();
  }
  // Combined Leave Type Limit (R44 4c48fd1f, Stage 2): re-check the shared pool at approval time (a second
  // approver / stale pending set could otherwise breach it). Exclude THIS request from the usage sum and add
  // its days back, so the pending row it represents is counted exactly once. Counts the days TAKEN
  // (approvedDays), unpaid ones included — a combined-limit pool caps absence, not balance spend.
  //
  // Per-application LENGTH — the leave type's Maximum Consecutive Leave (c6ffa725 rev 2) composed with the
  // group's per-application cap (r82a 1ef1cf95) — re-checked at approval for the same reason: a cap set or
  // tightened between submission and approval must not be approvable through.
  //
  // MEASURED ON THE APPLICATION, not the per-date subset, in BOTH units: the span is startDate..endDate and
  // the charged days are the request's own `days`, NOT `approvedDays`. Partial approval narrows which dates
  // are granted; it does not turn a 5-day application into a 3-day one, and approving 3 of 5 days must not
  // slip a 5-day application past a 3-day cap.
  await enforceApplicationLengthLimit(tx, {
    leaveTypeId: req.leaveTypeId,
    startDate: req.startDate,
    endDate: req.endDate,
    chargedDays: Number(req.days),
  });
  await enforceSharedLeaveGroupLimit(tx, {
    employmentId: req.employmentId,
    leaveTypeId: req.leaveTypeId,
    startDate: req.startDate,
    requestedDays: approvedDays,
    excludeRequestId: req.id,
  });
  // Application Limits (c6ffa725): re-check the TYPE's annual application ceiling at approval, for the same
  // reason the pool limit is re-checked — a limit set or tightened after submission, or a second approver
  // clearing a stale pending set, must not be approvable through. THIS request is excluded from the usage
  // sum and its days added back, so the pending row it represents is counted exactly once. Counts the days
  // TAKEN (approvedDays), unpaid ones included: this caps absence, not balance spend.
  await enforceLeaveYearApplicationLimit(tx, {
    employmentId: req.employmentId,
    leaveTypeId: req.leaveTypeId,
    startDate: req.startDate,
    requestedDays: approvedDays,
    excludeRequestId: req.id,
  });
  await tx.insert(leaveLedger).values({
    tenantId: ctx.tenantId,
    employmentId: req.employmentId,
    // Balance Deduction Source (cdf9ca48): the SOURCE type's ledger — the borrowing type keeps none of its
    // own. The leave_request row is untouched, so leave history still reads as the type applied for.
    leaveTypeId: balanceTypeId,
    entryType: 'debit',
    days: (-need).toFixed(2),
    sourceRequestId: req.id,
    effectiveOn: req.startDate,
  });
  await tx
    .update(leaveRequest)
    .set({ status: 'approved', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  // RL Control Engine (0113): when the consumed type is REPLACEMENT, decrement the toil_accrual register
  // FIFO-by-expiry so the active/expired split stays authoritative and the year-end close never double-debits
  // already-spent credits. The ledger debit above is the balance authority; this only updates the register.
  // NOT gated by TOIL_ENABLED (bug #21): if a register row exists it MUST be consumed on approval, else a
  // later expiry/close re-debits the full credit (negative balance + spurious convert-to-pay). The flag
  // gates accrual/UI, not this consume-on-approve invariant — consumeReplacementLeaveTx is a safe no-op
  // when there is no active accrual to decrement.
  if (leaveTypeIs(lt, 'replacement')) {
    // ADR-0068 §4E guard: a partial (per-date) debit must never reach REPLACEMENT — §4C excludes REPLACEMENT
    // from per-date approval, so daysOverride is always undefined here. Assert it so a future regression that
    // wires per-date approval to a REPLACEMENT type fails loudly instead of under-consuming the TOIL register.
    if (daysOverride !== undefined) {
      throw new Error('per-date (partial) approval is not supported for REPLACEMENT leave');
    }
    await consumeReplacementLeaveTx(tx, ctx, {
      employmentId: req.employmentId,
      requestId: req.id,
      need,
      effectiveOn: req.startDate,
    });
  }
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.approved',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: {
      decision: 'approved',
      deciderEmploymentId: deciderEmploymentId ?? null,
      // Partial Leave Approval notification fix (ADR-0068 follow-up): only the mixed per-date outcome
      // (≥1 approved + ≥1 rejected) sets this. It is the single minimal signal the notification renderer
      // reads to emit the "partially approved" body. Omitted (not `mixed: false`) for every other caller so
      // the whole-request / all-approved payload shape stays byte-identical to today.
      ...(mixed ? { mixed: true } : {}),
      // Partial Leave Approval (R17 600be8ac): when mixed, carry the per-date breakdown into the payload so
      // the notification renderer emits a self-contained body listing the approved + rejected dates and the
      // rejection reason — the reporter's ask #5. Only spread when present ⇒ byte-identical for every other caller.
      ...(mixed && perDateOutcome ? { perDateOutcome } : {}),
      // When the type opts in (sendToPayroll), attach an ADVISORY payroll-impact contract for a future
      // payroll integration to consume. It is telemetry, NOT a deduction source: the authoritative deduction
      // remains unpaidDaysByEmployment()'s live status='approved' re-query (which auto-corrects on any future
      // cancellation/reversal). No payPeriod is emitted — the consumer derives it with its own cutoff rule.
      ...(lt?.sendToPayroll
        ? {
            payrollImpact: {
              employmentId: req.employmentId,
              leaveTypeId: req.leaveTypeId,
              leaveTypeCode: lt.code,
              // ADR-0068 §4E: for a per-date request the payroll-impact advisory reflects the APPROVED days,
              // not the raw request span (approvedDays === sum of approved dates when daysOverride is passed).
              days: daysOverride !== undefined ? approvedDays : req.days,
              startDate: req.startDate,
              endDate: req.endDate,
              approvalStatus: 'approved' as const,
            },
          }
        : {}),
    },
  });
}

/** Terminal rejection: status flip + event (no ledger write). */
async function finalizeLeaveRejection(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
  extra?: Record<string, unknown>,
) {
  await tx
    .update(leaveRequest)
    .set({ status: 'rejected', decidedByEmploymentId: deciderEmploymentId ?? null, decidedAt: sql`now()` })
    .where(eq(leaveRequest.id, req.id));
  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-request',
    aggregateId: req.id,
    eventType: 'leave-request.rejected',
    actor: actorOf(ctx),
    subjectEmploymentId: req.employmentId,
    payload: { decision: 'rejected', deciderEmploymentId: deciderEmploymentId ?? null, ...(extra ?? {}) },
  });
}

/** Decide a leave request. With a multi-step chain (2B-1) this advances the current step and only
 *  finalizes when the last step clears; a rejection at any step is terminal. Without a chain it is a
 *  single approval (the original behavior). */
export async function decideLeave(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    // Partial Leave Approval (0131): a reason is MANDATORY whenever a date is rejected (so the employee knows
    // why). Enforced uniformly here for whole-request, single-day, half/hourly, and per-date-child rejections.
    rejectReason?: string;
  },
) {
  // Partial Leave Approval (0131): refuse a blank reject reason BEFORE opening the transaction, so a missing
  // reason persists nothing (no status flip, no ledger row, no event). Trim to reject whitespace-only input.
  const rejectReason = p.rejectReason?.trim() || null;
  if (p.decision === 'rejected' && !rejectReason) throw new MissingRejectReasonError();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);

    const steps = await tx
      .select()
      .from(leaveApprovalStep)
      .where(eq(leaveApprovalStep.leaveRequestId, req.id))
      .orderBy(asc(leaveApprovalStep.stepIndex));
    const current = steps.find((s) => s.status === 'pending');

    // Multi-step chain: decide the current step.
    if (steps.length > 0 && current) {
      // 6fadb036 (gap-close): dispatch to the right decider-authority for the step's kind. r293 added
      // manager_manager (a second hop up the reporting line) and specific_employee (the one FIXED kind);
      // each kind's resolver lives in assertCanDecideLeaveStep, and the step's OWN `approverEmploymentId`
      // — the snapshot, not the template — is what a fixed step routes on.
      await assertCanDecideLeaveStep(
        tx,
        ctx,
        req.employmentId,
        current.approverKind,
        'leave request',
        current.approverEmploymentId,
        current.approverAlternates,
      );
      await tx
        .update(leaveApprovalStep)
        .set({ status: p.decision, decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
        .where(eq(leaveApprovalStep.id, current.id));
      if (p.decision === 'rejected') {
        // Partial Leave Approval (0131): stamp the mandatory reject reason onto the rejected event payload.
        await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { step: current.stepIndex, kind: current.approverKind, rejectReason });
        return { status: 'rejected' as const };
      }
      const next = steps.find((s) => s.stepIndex > current.stepIndex && s.status === 'pending');
      if (next) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: req.id,
          eventType: 'leave-request.step.approved',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { step: current.stepIndex, kind: current.approverKind, nextKind: next.approverKind },
        });
        return { status: 'pending' as const, advancedTo: next.approverKind };
      }
      await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
      return { status: 'approved' as const };
    }

    // Single-step (no chain) — original behavior.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));
    if (p.decision === 'approved') await finalizeLeaveApproval(tx, ctx, req, p.deciderEmploymentId);
    // Partial Leave Approval (0131): stamp the mandatory reject reason onto the rejected event payload.
    else await finalizeLeaveRejection(tx, ctx, req, p.deciderEmploymentId, { rejectReason });
    return { status: p.decision };
  });
}

// ═════════════ Partial Leave Approval — single-request per-date decision (ADR-0068) ═════════════

/** ADR-0068 §4A — the set of EFFECTIVELY-APPROVED leave dates per employment in [from, to]. This is the ONE
 *  authority every span consumer (attendance daily+monthly, roster onLeave, plannedAbsences, unpaid payroll)
 *  reads so a per-date request's interior REJECTED dates never count as leave anywhere. Semantics:
 *   - a request WITHOUT leave_request_date rows → expand [start,end] where the REQUEST status='approved'
 *     (the unchanged, cheap whole-span behaviour — full_day only, mirroring the consumers' existing filter);
 *   - a request WITH leave_request_date rows → the individual leave_dates whose ROW status='approved'.
 *  One SQL: LEFT JOIN leave_request_date and COALESCE(row status, request status). generate_series expands
 *  the whole-span (no-child) case to individual dates so the caller always gets a flat Set<date> per emp.
 *  full_day filter matches the consumers (half/hourly are worked partial days, never "on leave"). */
async function approvedLeaveDates(
  tx: Tx,
  empIds: string[],
  from: string,
  to: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (empIds.length === 0) return out;
  const add = (emp: string, d: string) => {
    let s = out.get(emp);
    if (!s) out.set(emp, (s = new Set()));
    s.add(d);
  };

  // (a) per-date requests: every APPROVED sub-row in the window is one on-leave date.
  const dateRows = await tx
    .select({ employmentId: leaveRequest.employmentId, d: leaveRequestDate.leaveDate })
    .from(leaveRequestDate)
    .innerJoin(leaveRequest, eq(leaveRequest.id, leaveRequestDate.leaveRequestId))
    .where(
      and(
        inArray(leaveRequest.employmentId, empIds),
        eq(leaveRequest.durationType, 'full_day'),
        eq(leaveRequestDate.status, 'approved'),
        gte(leaveRequestDate.leaveDate, from),
        lte(leaveRequestDate.leaveDate, to),
      ),
    );
  for (const r of dateRows) add(r.employmentId, r.d);

  // (b) whole-span requests (no per-date rows): expand [start,end] ∩ [from,to] where the REQUEST is approved.
  const spanRows = await tx
    .select({
      employmentId: leaveRequest.employmentId,
      startDate: leaveRequest.startDate,
      endDate: leaveRequest.endDate,
    })
    .from(leaveRequest)
    .where(
      and(
        inArray(leaveRequest.employmentId, empIds),
        eq(leaveRequest.durationType, 'full_day'),
        eq(leaveRequest.status, 'approved'),
        lte(leaveRequest.startDate, to),
        gte(leaveRequest.endDate, from),
        sql`NOT EXISTS (SELECT 1 FROM leave_request_date x WHERE x.leave_request_id = ${leaveRequest.id})`,
      ),
    );
  for (const r of spanRows) {
    const lo = r.startDate < from ? from : r.startDate;
    const hi = r.endDate > to ? to : r.endDate;
    for (const d of eachDate(lo, hi)) add(r.employmentId, d);
  }
  return out;
}

/** ADR-0068 §4A (exported for the span consumers in attendance/roster/read). See approvedLeaveDates. */
export { approvedLeaveDates };

/** ADR-0068 §4D — decide ONE requested date of a per-date-approval request in the request detail view. The
 *  request itself stays a single inbox row; each date is approved/rejected here. Reject requires a reason
 *  (MissingRejectReasonError, enforced before the transaction). No ledger effect per date — the balance gate +
 *  single ledger debit run once at finalization (§4E) when no pending dates remain. Single-step only (reuses
 *  assertCanDecide), which §4C guarantees because per-date rows are only created for single-step companies. */
export async function decideLeaveDate(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    leaveDate: string;
    decision: 'approved' | 'rejected';
    deciderEmploymentId?: string;
    rejectReason?: string;
  },
) {
  const rejectReason = p.rejectReason?.trim() || null;
  if (p.decision === 'rejected' && !rejectReason) throw new MissingRejectReasonError();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);
    // Single-step authority (§4C): per-date rows only exist for single-step companies, so the whole-request
    // assertCanDecide (manager/admin, no self-approval) is the correct gate — no chain-step logic here.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));

    const [row] = await tx
      .select()
      .from(leaveRequestDate)
      .where(and(eq(leaveRequestDate.leaveRequestId, req.id), eq(leaveRequestDate.leaveDate, p.leaveDate)))
      .limit(1);
    if (!row) throw new Error('leave date not found on this request');
    if (row.status !== 'pending') throw new Error(`leave date is already ${row.status}`);

    await tx
      .update(leaveRequestDate)
      .set({
        status: p.decision,
        rejectReason: p.decision === 'rejected' ? rejectReason : null,
        decidedByEmploymentId: p.deciderEmploymentId ?? null,
        decidedAt: sql`now()`,
      })
      .where(eq(leaveRequestDate.id, row.id));
    // Substrate: the per-date write is audited by this event on the leave-request aggregate.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.date.decided',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveDate: p.leaveDate, decision: p.decision, ...(rejectReason ? { rejectReason } : {}) },
    });

    // §4E finalization: only when NO pending dates remain (shared with the batch decideLeaveDates path).
    return finalizePerDateIfComplete(tx, ctx, req, p.deciderEmploymentId);
  });
}

/** §4E finalization tail, shared by the single-date decideLeaveDate and the batch decideLeaveDates. Re-reads
 *  every leave_request_date row: while any is still pending the request stays pending; once none are pending it
 *  finalizes exactly once — all-rejected ⇒ terminal rejection (no debit, per-date reasons captured);
 *  ≥1 approved ⇒ single ledger debit = sum(approved weighted days) + status='approved'. A MIXED outcome
 *  (≥1 approved AND ≥1 rejected) tags the approved event (mixed + perDateOutcome) so the employee's
 *  notification honestly reads "partially approved" and lists the approved/rejected dates + reason. */
async function finalizePerDateIfComplete(
  tx: Tx,
  ctx: SessionContext,
  req: DecidableLeave,
  deciderEmploymentId?: string,
): Promise<{ status: 'pending' | 'approved' | 'rejected' }> {
  const remaining = await tx
    .select()
    .from(leaveRequestDate)
    .where(eq(leaveRequestDate.leaveRequestId, req.id));
  const stillPending = remaining.filter((d) => d.status === 'pending');
  if (stillPending.length > 0) return { status: 'pending' as const };

  const approved = remaining.filter((d) => d.status === 'approved');
  const rejected = remaining.filter((d) => d.status === 'rejected');
  if (approved.length === 0) {
    // All rejected → terminal rejection, no debit. Collect the per-date reasons for the audit trail.
    await finalizeLeaveRejection(tx, ctx, req, deciderEmploymentId, {
      rejectReason: rejected.map((d) => `${d.leaveDate}: ${d.rejectReason ?? ''}`).join('; '),
      perDate: rejected.map((d) => ({ date: d.leaveDate, rejectReason: d.rejectReason })),
    });
    return { status: 'rejected' as const };
  }
  // All-approved OR mixed (≥1 approved) → single ledger debit for sum(approved days) + status='approved'.
  // §4A makes balance/calendar/attendance/payroll count ONLY the approved dates regardless of top-level
  // status, so a mixed outcome uses 'approved' + per-date truth (no new "partially_approved" enum this round).
  const approvedDays = approved.reduce((s, d) => s + Number(d.days), 0);
  const mixed = rejected.length > 0;
  const perDateOutcome: PerDateOutcome | undefined = mixed
    ? {
        approved: approved.map((d) => d.leaveDate),
        rejected: rejected.map((d) => ({ date: d.leaveDate, reason: d.rejectReason })),
      }
    : undefined;
  await finalizeLeaveApproval(tx, ctx, req, deciderEmploymentId, approvedDays, mixed, perDateOutcome);
  return { status: 'approved' as const };
}

/** ADR-0068 §4D (R17 600be8ac) — decide MANY requested dates of a per-date-approval request in ONE submit.
 *  The approver fills the decision table (one row per requested date, Approve/Reject + a reason for each
 *  rejected date) and submits once. Same guards as decideLeaveDate: pending request, assertCanDecide, each
 *  date exists & is pending, every rejected date carries a non-blank reason (all validated BEFORE the write so
 *  a bad batch persists nothing). Applies every row update, appends one leave-request.date.decided event PER
 *  date (uniform audit stream), then runs the shared finalization once. Single-step only (§4C). */
export async function decideLeaveDates(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    decisions: { leaveDate: string; decision: 'approved' | 'rejected'; rejectReason?: string }[];
    deciderEmploymentId?: string;
  },
) {
  // Normalize + validate reject reasons BEFORE opening the transaction — a blank reason on any rejected date
  // aborts the whole batch and persists nothing (no status flip, no ledger row, no event).
  const decisions = p.decisions.map((d) => ({
    leaveDate: d.leaveDate,
    decision: d.decision,
    rejectReason: d.rejectReason?.trim() || null,
  }));
  if (decisions.length === 0) throw new Error('no decisions provided');
  for (const d of decisions) {
    if (d.decision === 'rejected' && !d.rejectReason) throw new MissingRejectReasonError();
  }
  // Reject a batch that names the same date twice (ambiguous decision).
  if (new Set(decisions.map((d) => d.leaveDate)).size !== decisions.length) {
    throw new Error('duplicate leave date in batch');
  }
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');
    if (req.status !== 'pending') throw new Error(`leave request is already ${req.status}`);
    // Single-step authority (§4C): per-date rows only exist for single-step companies.
    await assertCanDecide(tx, ctx, req.employmentId, 'leave request', scopeOf('leave.application'));

    for (const d of decisions) {
      const [row] = await tx
        .select()
        .from(leaveRequestDate)
        .where(and(eq(leaveRequestDate.leaveRequestId, req.id), eq(leaveRequestDate.leaveDate, d.leaveDate)))
        .limit(1);
      if (!row) throw new Error('leave date not found on this request');
      if (row.status !== 'pending') throw new Error(`leave date is already ${row.status}`);
      await tx
        .update(leaveRequestDate)
        .set({
          status: d.decision,
          rejectReason: d.decision === 'rejected' ? d.rejectReason : null,
          decidedByEmploymentId: p.deciderEmploymentId ?? null,
          decidedAt: sql`now()`,
        })
        .where(eq(leaveRequestDate.id, row.id));
      // Substrate: one event per date keeps the audit stream identical to the single-date path.
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-request',
        aggregateId: req.id,
        eventType: 'leave-request.date.decided',
        actor: actorOf(ctx),
        subjectEmploymentId: req.employmentId,
        payload: { leaveDate: d.leaveDate, decision: d.decision, ...(d.rejectReason ? { rejectReason: d.rejectReason } : {}) },
      });
    }
    return finalizePerDateIfComplete(tx, ctx, req, p.deciderEmploymentId);
  });
}

// ═════════════════════ Partial Leave Cancellation (ADR-0065) ═════════════════════
// After a leave is approved, the employee can give back a SUBSET of the approved dates. The approval splits
// the approved span into contiguous sibling leave_request rows (the Emergency-Leave parent_group_id model),
// each with its own ledger debit, then flips the cancelled segment(s) to status='cancelled' and reverses
// their debit. Because every span consumer (payroll unpaidDaysByEmployment, attendance onLeave,
// plannedAbsences) filters status='approved', a cancelled segment disappears from balance/calendar/payroll
// for free — no read-layer span math. See ADR-0065.

/** A working date paired with its leave-deduction weight (Feedback 31474452 4e) — 1 for a Full working day,
 *  0.5/1.0 for a Half day per the company toggle. */
export type WeightedDate = { date: string; weight: number };

/** Pure date math (no DB) so the service and tests share one implementation. Given the request's full ordered
 *  list of WORKING dates (each optionally carrying its deduction WEIGHT — Feedback 31474452 4e) and the set of
 *  dates to cancel, partition the working dates into maximal contiguous runs such that every cancelled date
 *  sits in its own single-date segment. Returns the segments (each `{ from, to, days }`, days = the SUM of the
 *  run's weights — 1 per date when no weights are supplied, so callers passing a plain `string[]` see exactly
 *  today's behaviour) in date order, plus the indexes of the segments that are fully cancelled. Cancelling ALL
 *  working dates yields every segment cancelled — the "cancel-all == cancel request" case falls out with no
 *  special path.
 *
 *  Accepts either a plain `string[]` (back-compat — every date weighs 1) or `WeightedDate[]` (the caller
 *  supplies each date's real weight, e.g. from dayWeight/resolveSchedule). */
export function splitSpanForCancellation(
  allWorkingDates: string[] | WeightedDate[],
  cancelDates: string[],
): { segments: { from: string; to: string; days: number }[]; cancelledSegmentIndexes: number[] } {
  const weighted: WeightedDate[] = allWorkingDates.map((d) =>
    typeof d === 'string' ? { date: d, weight: 1 } : d,
  );
  const cancelSet = new Set(cancelDates);
  const ordered = [...weighted].sort((a, b) => a.date.localeCompare(b.date));
  const segments: { from: string; to: string; days: number }[] = [];
  const cancelledSegmentIndexes: number[] = [];
  let run: WeightedDate[] = [];
  let runCancelled: boolean | null = null;
  const flush = () => {
    if (run.length === 0) return;
    const idx = segments.length;
    const days = round2(run.reduce((s, r) => s + r.weight, 0));
    segments.push({ from: run[0].date, to: run[run.length - 1].date, days });
    if (runCancelled) cancelledSegmentIndexes.push(idx);
    run = [];
    runCancelled = null;
  };
  for (const wd of ordered) {
    const isCancelled = cancelSet.has(wd.date);
    // A cancelled date is always its own single-date segment; a surviving date extends the current surviving
    // run. So flush whenever the cancelled-ness flips OR the current date is cancelled (force a new segment).
    if (run.length > 0 && (isCancelled || runCancelled !== isCancelled)) flush();
    run.push(wd);
    runCancelled = isCancelled;
    if (isCancelled) flush(); // a cancelled date never merges with a following date
  }
  flush();
  return { segments, cancelledSegmentIndexes };
}

/** ADR-0065 §4 — the request's real WORKING dates in [start, end] (roster + holiday aware, the SAME frame the
 *  service splits/validates against). Exported so the read layer can surface the exact cancellable candidates
 *  to the UI instead of a Mon–Fri heuristic that disagrees with the service (offering a holiday it rejects or
 *  hiding a working Saturday). This is a read of already-tx-bound calendar data — no mutation surface. */
export async function workingDatesForSpan(
  tx: Tx,
  employmentId: string,
  start: string,
  end: string,
  // Day Type Inclusion (feedback ef6d7146): the leave type's re-inclusion vector. When ABSENT (undefined ⇒
  // every existing type / all-off config) this is byte-identical to before (roster + holiday-aware working
  // dates). When present the cancellable candidate set additionally admits the re-included day types, so the
  // cancellation gate + give-back stay in agreement with how the leave was originally deducted.
  inclusion?: DayTypeInclusion,
): Promise<string[]> {
  const hols = await resolveHolidaySet(tx, employmentId, start, end);
  if (inclusion === undefined) {
    const workingDaysIso = await resolveWorkingDaysIso(tx, employmentId);
    return eachDate(start, end).filter((d) => isWorkingDay(d, workingDaysIso, hols));
  }
  const sched = await resolveSchedule(tx, employmentId);
  return eachDate(start, end).filter((d) => isDeductibleDay(d, sched, hols, inclusion));
}

/**
 * Batched sibling of workingDatesForSpan (item ee55f5fe — the Month View N+1 fix). Resolves the
 * employment's working-day roster ONCE and its holiday set ONCE over the UNION range (min start, max end)
 * of all spans, then computes each span's working dates in memory — 2 round-trip groups per DISTINCT
 * employment instead of 2 per LEAVE. Returned map is keyed `${start}|${end}`. The per-span result is
 * byte-identical to workingDatesForSpan(tx, employmentId, start, end) with no inclusion vector (holidays
 * inside a span are a subset of the union range's set), and the union range is the LEAVES' own spans —
 * never the visible calendar window — so a leave straddling the window edge is never clipped.
 * workingDatesForSpan itself is untouched: the service validation paths still call it per request.
 */
export async function workingDatesForSpans(
  tx: Tx,
  employmentId: string,
  spans: { start: string; end: string }[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (spans.length === 0) return out;
  let minStart = spans[0].start;
  let maxEnd = spans[0].end;
  for (const s of spans) {
    if (s.start < minStart) minStart = s.start;
    if (s.end > maxEnd) maxEnd = s.end;
  }
  const hols = await resolveHolidaySet(tx, employmentId, minStart, maxEnd);
  const workingDaysIso = await resolveWorkingDaysIso(tx, employmentId);
  for (const s of spans) {
    out.set(`${s.start}|${s.end}`, eachDate(s.start, s.end).filter((d) => isWorkingDay(d, workingDaysIso, hols)));
  }
  return out;
}

/** ADR-0065 (R5 Build #2 — iterative cancellation). True when the parent_group_id names a CANCELLATION-SPLIT
 *  group (produced by decideLeaveCancellation), as opposed to an Emergency-Leave / per-date-approval group.
 *  A cancellation split ALWAYS leaves ≥1 sibling row with status='cancelled' sharing the group; an EL /
 *  per-date group never has a 'cancelled' sibling. So a surviving cancellation-split row (which now carries a
 *  parentGroupId) can still be cancelled again — the reporter's "give back Wednesday now, Thursday later"
 *  scenario — while genuine EL children stay blocked by the same gate. No discriminator column, no migration. */
async function isCancellationSplitGroup(tx: Tx, parentGroupId: string): Promise<boolean> {
  const [sib] = await tx
    .select({ id: leaveRequest.id })
    .from(leaveRequest)
    .where(and(eq(leaveRequest.parentGroupId, parentGroupId), eq(leaveRequest.status, 'cancelled')))
    .limit(1);
  return !!sib;
}

/** Resolve the person behind an employment (for the subject-only assertion). */
async function personIdForEmployment(tx: Tx, employmentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ personId: employment.personId })
    .from(employment)
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.personId ?? null;
}

/** True when the cancel date's payroll period (YYYY-MM by start date) has a CLOSED batch that already produced
 *  THIS employee's payslip — the deduction was finalised, so the day can't be retroactively given back
 *  (ADR-0065 §2). We join payroll_batch → payslip on the employee so the check works under the employee's own
 *  RLS session (an employee can see their own payslip, and therefore the batch it belongs to). Checking the
 *  employee's OWN finalised payslip is also more precise than "any closed batch in the period". */
async function cancelDatePeriodClosed(tx: Tx, employmentId: string, cancelDate: string): Promise<boolean> {
  const period = cancelDate.slice(0, 7); // YYYY-MM
  const [closed] = await tx
    .select({ id: payrollBatch.id })
    .from(payrollBatch)
    .innerJoin(payslip, eq(payslip.batchId, payrollBatch.id))
    .where(
      and(
        eq(payrollBatch.payPeriod, period),
        eq(payrollBatch.status, 'closed'),
        eq(payslip.employmentId, employmentId),
      ),
    )
    .limit(1);
  return !!closed;
}

/**
 * Employee-initiated request to cancel a SUBSET of an approved leave's dates. Runs every §2 gate + the §6
 * subject check + the §3 pending-overlap guard, then inserts a pending leave_cancellation_request and
 * appends `leave-cancellation.requested`. No ledger / leave_request change here — the give-back happens only
 * on manager approval (decideLeaveCancellation).
 */
export async function requestLeaveCancellation(
  ctx: SessionContext,
  // R5 Build #2 (Fix B — MYT boundary): `today` is injectable (default MYT, mirroring requestLeave) so the
  // "hasn't started yet" per-date gate uses Malaysia time, not a UTC-skewed global clock near midnight.
  p: { leaveRequestId: string; cancelDates: string[]; reason?: string; today?: string },
) {
  const today = p.today ?? todayInKualaLumpur();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // §6(1): subject-only. RLS is symmetric (a manager can SEE a subordinate's leave) so the "employee-
    // initiated" rule is enforced here in code, not by RLS. Resolve the person behind the leave's employment
    // and require the caller is that person.
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveCancellationNotAllowedError('only the employee can cancel their own leave');
    }

    // §2 gates against the request itself.
    if (req.status !== 'approved') throw new LeaveCancellationNotAllowedError('the leave is not approved');
    if (req.durationType !== 'full_day') {
      throw new LeaveCancellationNotAllowedError('only full-day leave can be partially cancelled');
    }
    if (req.parentGroupId != null && !(await isCancellationSplitGroup(tx, req.parentGroupId))) {
      // Blocks Emergency-Leave / per-date-approval child rows (each already a single date under a group), but
      // ADMITS a surviving row of a prior CANCELLATION split so the employee can give back more days later
      // (R5 Build #2 — iterative cancellation; ADR-0065). A cancellation-split group is detected by a
      // 'cancelled' sibling; an EL / per-date group never has one.
      throw new LeaveCancellationNotAllowedError('this leave cannot be partially cancelled');
    }
    const [lt] = await tx
      // Day Type Inclusion (feedback ef6d7146): the type's re-inclusion vector — cancellation must offer + give
      // back exactly the day types the original deduction counted, or the ledger reversal/re-debit drifts.
      .select({ code: leaveType.code, dayTypeInclusion: leaveType.dayTypeInclusion })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);
    if (leaveTypeIs(lt, 'replacement')) {
      // Restoring a REPLACEMENT day via the ledger without re-crediting the toil_accrual register would
      // reintroduce the ghost-credit / negative-balance bug — and there is no inverse of consumeReplacementLeaveTx.
      throw new LeaveCancellationNotAllowedError('replacement (time-off-in-lieu) leave cannot be cancelled');
    }
    const cancelIncl = normalizeDayTypeInclusion(lt?.dayTypeInclusion);

    // The request's working dates (the only cancellable dates), in the tenant calendar frame. Shared helper so
    // the read layer (UI candidate list) and this gate agree exactly (R5 Build #2 — Fix C, no Mon–Fri drift).
    let workingDates = await workingDatesForSpan(tx, req.employmentId, req.startDate, req.endDate, cancelIncl);
    // ADR-0068 §6: a per-date-approval request is now a single parentGroupId=NULL row, so it reaches here.
    // Its interior REJECTED dates are NOT approved leave — exclude them from the cancellable set so an employee
    // can only give back a date that was actually approved (mirrors §4A's effectively-approved-dates rule).
    const dateRows = await tx
      .select({ leaveDate: leaveRequestDate.leaveDate, status: leaveRequestDate.status })
      .from(leaveRequestDate)
      .where(eq(leaveRequestDate.leaveRequestId, req.id));
    if (dateRows.length > 0) {
      const approvedSet = new Set(dateRows.filter((d) => d.status === 'approved').map((d) => d.leaveDate));
      workingDates = workingDates.filter((d) => approvedSet.has(d));
    }
    const workingSet = new Set(workingDates);
    // Per-date future check: each cancelDate must be strictly after `today` (MYT — resolved at the top of this
    // function, injectable for tests). R5 Build #2 Fix B: was a UTC clock, wrong near KL midnight.
    const cancelDates = [...new Set(p.cancelDates.map((d) => d.trim()))].sort();
    if (cancelDates.length === 0) throw new LeaveCancellationDateInvalidError();
    for (const d of cancelDates) {
      if (!workingSet.has(d)) throw new LeaveCancellationDateInvalidError(d); // outside span or non-working day
      if (d <= today) throw new LeaveCancellationTooLateError(d); // per-date future gate
      if (await cancelDatePeriodClosed(tx, req.employmentId, d)) throw new LeaveCancellationPeriodClosedError(d);
    }

    // §3: another PENDING cancellation request on the same leave may already target one of these dates.
    // Reject the overlap so two pending requests can't both approve and double-restore.
    const pendings = await tx
      .select({ cancelDates: leaveCancellationRequest.cancelDates })
      .from(leaveCancellationRequest)
      .where(
        and(
          eq(leaveCancellationRequest.leaveRequestId, req.id),
          eq(leaveCancellationRequest.status, 'pending'),
        ),
      );
    const pendingSet = new Set(pendings.flatMap((r) => (r.cancelDates as string[]) ?? []));
    if (cancelDates.some((d) => pendingSet.has(d))) {
      throw new LeaveCancellationNotAllowedError('a pending cancellation already covers one of these dates');
    }

    // requestedDays = the WEIGHTED total of the cancel dates (Feedback 31474452 4e) — each is a working date
    // by the check above; a Half date contributes 0.5 (toggle OFF) or 1.0 (toggle ON) rather than always 1,
    // so the manager's approval screen previews the real give-back amount decideLeaveCancellation will apply.
    const hols = await resolveHolidaySet(tx, req.employmentId, req.startDate, req.endDate);
    const sched = await resolveSchedule(tx, req.employmentId);
    // Day Type Inclusion (feedback ef6d7146): weigh each cancel date through the SAME vector the leave was
    // deducted under (cancelIncl above), so a re-included public-holiday/rest date previews its real weight.
    const requestedDays = round2(cancelDates.reduce((s, d) => s + dayWeight(d, sched, hols, cancelIncl), 0));
    const [row] = await tx
      .insert(leaveCancellationRequest)
      .values({
        tenantId: ctx.tenantId,
        leaveRequestId: req.id,
        employmentId: req.employmentId,
        cancelDates,
        requestedDays: requestedDays.toFixed(2),
        reason: p.reason?.trim() || null,
        status: 'pending',
      })
      .returning({ id: leaveCancellationRequest.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-cancellation-request',
      aggregateId: row.id,
      eventType: 'leave-cancellation.requested',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveRequestId: req.id, cancelDates, requestedDays },
    });
    return { cancellationRequestId: row.id, requestedDays };
  });
}

/**
 * Manager decision on a cancellation request (single step). Reject ⇒ flip to 'rejected', nothing else. Approve
 * ⇒ in one transaction: split the approved span into contiguous sibling rows (each with its own debit), flip
 * the cancelled segment(s) to 'cancelled' and reverse their debit, and append events on BOTH aggregates.
 */
export async function decideLeaveCancellation(
  ctx: SessionContext,
  p: { cancellationRequestId: string; decision: 'approved' | 'rejected'; deciderEmploymentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [cr] = await tx
      .select()
      .from(leaveCancellationRequest)
      .where(eq(leaveCancellationRequest.id, p.cancellationRequestId))
      .limit(1);
    if (!cr) throw new Error('cancellation request not found (or not visible)');
    if (cr.status !== 'pending') throw new Error(`cancellation request is already ${cr.status}`);

    // Self-approval ban + manager/admin authorization — service-layer (RLS is symmetric, §6(2)).
    await assertCanDecide(tx, ctx, cr.employmentId, 'leave cancellation', scopeOf('leave.cancellation'));

    if (p.decision === 'rejected') {
      await tx
        .update(leaveCancellationRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
        .where(eq(leaveCancellationRequest.id, cr.id));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-cancellation-request',
        aggregateId: cr.id,
        eventType: 'leave-cancellation.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: cr.employmentId,
        payload: { leaveRequestId: cr.leaveRequestId, cancelDates: cr.cancelDates },
      });
      return { status: 'rejected' as const };
    }

    // ── Approved ──────────────────────────────────────────────────────────────────────────────────────
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, cr.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found');
    // Re-assert the request is still a cancellable approved row. A prior cancellation may have split it (giving
    // it a parentGroupId) — that survivor is STILL cancellable (R5 Build #2 — iterative cancellation), so admit
    // a cancellation-split group here as well; only genuine EL / per-date children stay blocked.
    if (
      req.status !== 'approved' ||
      (req.parentGroupId != null && !(await isCancellationSplitGroup(tx, req.parentGroupId)))
    ) {
      throw new LeaveCancellationNotAllowedError('the leave is no longer in a cancellable state');
    }
    // Allow Unpaid Leave (a7fab30b): a part-unpaid request cannot go through the give-back SPLIT. This path
    // works by reversing the whole-span debit and re-debiting each surviving segment — which only balances
    // because sum(segment days) === req.days. On a part-unpaid request the original debit was smaller than
    // req.days, and there is no fact on the row saying WHICH dates were the unpaid ones, so any split would
    // restore days the employee was never charged for. Refused rather than silently mis-restored; whole-request
    // cancellation (which reverses the actual net ledger movement) still works and is the correct route.
    if (Number(req.unpaidDays ?? 0) > 0) {
      throw new LeaveCancellationNotAllowedError('leave with unpaid days cannot be partially cancelled');
    }

    const cancelDates = (cr.cancelDates as string[]) ?? [];
    const hols = await resolveHolidaySet(tx, req.employmentId, req.startDate, req.endDate);
    // Day Type Inclusion (feedback ef6d7146): resolve the type's re-inclusion vector so the give-back split
    // spans exactly the day types the original debit counted. Without this a re-included rest/PH date would be
    // absent from workingDates, so sum(segment days) < req.days and the whole-span reversal below would
    // over-restore. undefined ⇒ byte-identical legacy split.
    const [decLt] = await tx
      .select({ dayTypeInclusion: leaveType.dayTypeInclusion })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);
    const decIncl = normalizeDayTypeInclusion(decLt?.dayTypeInclusion);
    // Feedback 31474452 (4e): resolve the CURRENT schedule/toggle config (as today — a pre-existing property,
    // not a new behaviour) and thread each working date's real WEIGHT through the split, so a cancelled Half
    // date gives back exactly the configured amount (0.5 OFF / 1.0 ON) instead of always 1.
    const sched = await resolveSchedule(tx, req.employmentId);
    const workingDates = eachDate(req.startDate, req.endDate)
      .filter((d) => isDeductibleDay(d, sched, hols, decIncl))
      .map((date) => ({ date, weight: dayWeight(date, sched, hols, decIncl) }));
    const { segments, cancelledSegmentIndexes } = splitSpanForCancellation(workingDates, cancelDates);

    // Split-and-cancel. We REUSE the original row id for the first segment (preserving attachments / FKs) and
    // create new sibling rows for the rest, all sharing a fresh parent_group_id. The original carried ONE
    // debit over the whole span (finalizeLeaveApproval), so we first reverse that whole-span debit, then give
    // each segment its own debit — net zero for survivors, net +1×cancelled-days restored for cancelled ones.
    const parentGroupId = randomUUID();
    // Balance Deduction Source (cdf9ca48): the reversal and the per-segment re-debits below must land on the
    // SAME ledger finalizeLeaveApproval debited, or a give-back would credit a balance that was never charged
    // and leave the borrowed one permanently short. Resolved once for the whole split.
    const cancelBalanceTypeId = await resolveBalanceSourceTypeId(tx, req.leaveTypeId);
    // 1) Reverse the original whole-span debit (inverse of finalizeLeaveApproval's single debit).
    await tx.insert(leaveLedger).values({
      tenantId: ctx.tenantId,
      employmentId: req.employmentId,
      leaveTypeId: cancelBalanceTypeId,
      entryType: 'debit',
      days: Number(req.days).toFixed(2), // positive = reversal of the original negative debit
      sourceRequestId: req.id,
      effectiveOn: req.startDate, // same cycle/carry window as the original debit (window-consistent, §1 caveat)
    });

    const cancelledRowIds: string[] = [];
    const remainingDates: string[] = [];
    // R5 Build #2: surviving NEW sibling rows (i>0, approved). The attachment(s) live on the reused segment[0]
    // row only; when segment[0] is itself cancelled (the employee gave back the FIRST date), a survivor that is
    // NOT segment[0] would show no MC. So we copy the original attachment(s) onto these survivors after the loop.
    const survivingNewRowIds: string[] = [];
    let restoredDays = 0;
    let remainingDays = 0;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isCancelled = cancelledSegmentIndexes.includes(i);
      const segDays = seg.days;
      let rowId: string;
      if (i === 0) {
        // Reuse the original row for the first segment (preserve its attachments / approval-step FKs).
        rowId = req.id;
        await tx
          .update(leaveRequest)
          .set({
            startDate: seg.from,
            endDate: seg.to,
            days: segDays.toFixed(2),
            parentGroupId,
            status: isCancelled ? 'cancelled' : 'approved',
          })
          .where(eq(leaveRequest.id, req.id));
      } else {
        const [created] = await tx
          .insert(leaveRequest)
          .values({
            tenantId: ctx.tenantId,
            employmentId: req.employmentId,
            leaveTypeId: req.leaveTypeId,
            startDate: seg.from,
            endDate: seg.to,
            days: segDays.toFixed(2),
            durationType: 'full_day',
            status: isCancelled ? 'cancelled' : 'approved',
            reason: req.reason,
            parentGroupId,
            decidedByEmploymentId: req.decidedByEmploymentId,
            decidedAt: req.decidedAt,
          })
          .returning({ id: leaveRequest.id });
        rowId = created.id;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: rowId,
          eventType: 'leave-request.split',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { parentGroupId, from: seg.from, to: seg.to, days: segDays },
        });
      }

      // Each segment gets its OWN debit sourced to its own row (mirrors the EL per-row sourcing). A cancelled
      // segment is NOT debited (its days were restored by the whole-span reversal above), so the net effect is
      // exactly: balance up + taken down by the cancelled days, survivors unchanged.
      if (!isCancelled) {
        await tx.insert(leaveLedger).values({
          tenantId: ctx.tenantId,
          employmentId: req.employmentId,
          leaveTypeId: cancelBalanceTypeId,
          entryType: 'debit',
          days: (-segDays).toFixed(2),
          sourceRequestId: rowId,
          effectiveOn: seg.from,
        });
        remainingDates.push(...eachDate(seg.from, seg.to).filter((d) => isDeductibleDay(d, sched, hols, decIncl)));
        remainingDays += segDays;
        if (i > 0) survivingNewRowIds.push(rowId); // a survivor that is NOT the reused segment[0] row
      } else {
        cancelledRowIds.push(rowId);
        restoredDays += segDays;
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-request',
          aggregateId: rowId,
          eventType: 'leave-request.cancelled',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { cancelDate: seg.from, restoredDays: segDays, parentGroupId },
        });
      }
    }

    // R5 Build #2: copy the original request's attachment(s) onto surviving NEW sibling rows so the MC stays
    // visible on whichever survivor the employee holds — including when they gave back the FIRST date (segment[0]
    // is reused for that cancelled date, so its survivors are all new rows). The attachment rows live on req.id;
    // duplicating the (small) MC bytes onto each survivor keeps getLeaveAttachment(survivorId) truthful without a
    // schema change. Only runs when there IS at least one attachment AND at least one new-row survivor.
    if (survivingNewRowIds.length > 0) {
      const atts = await tx
        .select({
          content: leaveRequestAttachment.content,
          fileName: leaveRequestAttachment.fileName,
          mimeType: leaveRequestAttachment.mimeType,
          sizeBytes: leaveRequestAttachment.sizeBytes,
          uploadedByUserId: leaveRequestAttachment.uploadedByUserId,
        })
        .from(leaveRequestAttachment)
        .where(eq(leaveRequestAttachment.leaveRequestId, req.id));
      if (atts.length > 0) {
        await tx.insert(leaveRequestAttachment).values(
          survivingNewRowIds.flatMap((survivorId) =>
            atts.map((a) => ({
              tenantId: ctx.tenantId,
              leaveRequestId: survivorId,
              employmentId: req.employmentId,
              content: a.content as Buffer,
              fileName: a.fileName,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              uploadedByUserId: a.uploadedByUserId,
            })),
          ),
        );
      }
    }

    await tx
      .update(leaveCancellationRequest)
      .set({ status: 'approved', decidedByEmploymentId: p.deciderEmploymentId ?? null, decidedAt: sql`now()` })
      .where(eq(leaveCancellationRequest.id, cr.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-cancellation-request',
      aggregateId: cr.id,
      eventType: 'leave-cancellation.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { leaveRequestId: req.id, parentGroupId, cancelledRowIds, restoredDays, remainingDays, remainingDates },
    });
    return { status: 'approved' as const, restoredDays, remainingDays, remainingDates };
  });
}

/**
 * HR-initiated cancellation of an employee's WHOLE leave request, on their behalf (feedback 22e68ff0).
 *
 * Unlike the employee-driven partial give-back (requestLeaveCancellation → decideLeaveCancellation), this is
 * an immediate, no-approval-workflow HR power: an HR admin cancels a PENDING or APPROVED leave for another
 * employee for operational/payroll/audit reasons. It flips the request to 'cancelled', restores the entitlement
 * balance (by reversing the net ledger debit), supersedes any open give-back on the same leave, and appends a
 * distinct `leave-request.admin-cancelled` event carrying the REAL HR actor (the audit must show HR did it,
 * not the employee) plus the display fields the employee notification needs.
 *
 * Deliberately NOT `assertCanDecide` (which admits managers) — immediate on-behalf cancellation is HR-only.
 * A manager keeps the existing decide paths. Company scope is free: the row is loaded under RLS, so a
 * company-scoped hr_admin can't see (⇒ can't cancel) another company's request.
 */
export async function adminCancelLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string; reason?: string; cancelledByEmploymentId?: string },
): Promise<{ previousStatus: 'pending' | 'approved'; restoredDays: number }> {
  return withTenant(ctx, async (tx) => {
    // HR-only. isAdmin() = hr_admin OR super_admin; a manager (or any other role) is refused here.
    if (!isAdmin(ctx)) {
      throw new LeaveCancellationNotAllowedError('only an HR administrator can cancel leave on behalf of an employee');
    }
    const isSuper = ctx.roles?.includes('super_admin') ?? false;

    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Self-ban: an HR admin's own leave goes through the normal employee flow, not this on-behalf power
    // (mirrors assertCanDecide's self-approval ban). super_admin keeps the sole-admin escape hatch.
    if (!isSuper) {
      const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
      if (ctx.personId && ctx.personId === subjectPersonId) {
        throw new LeaveCancellationNotAllowedError('an HR administrator cannot cancel their own leave here');
      }
    }

    // Status gate: only pending | approved are cancellable. Already-cancelled / rejected → refuse, naming the
    // current status (localizeLeaveError maps the typed error to the localized cancellationNotAllowed message).
    if (req.status !== 'pending' && req.status !== 'approved') {
      throw new LeaveCancellationNotAllowedError(`the leave is already ${req.status}`);
    }
    const previousStatus = req.status as 'pending' | 'approved';

    const [lt] = await tx
      .select({ code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);

    // An APPROVED REPLACEMENT (time-off-in-lieu) leave already consumed the toil_accrual register at approval,
    // and there is no inverse of consumeReplacementLeaveTx — restoring it via the ledger would reintroduce the
    // ghost-credit bug. A PENDING replacement never consumed the register, so it cancels cleanly.
    if (previousStatus === 'approved' && leaveTypeIs(lt, 'replacement')) {
      throw new LeaveCancellationNotAllowedError('replacement (time-off-in-lieu) leave cannot be cancelled');
    }

    // Closed-payroll gate: never retroactively alter a period whose payslip was finalised. For each DISTINCT
    // month spanned by the leave, reject if that employee's batch is closed. (HR may cancel past/started leave —
    // the admin override vs. the employee's future-only rule — but never a finalised payroll month.)
    const months = [...new Set(eachDate(req.startDate, req.endDate).map((d) => d.slice(0, 7)))];
    for (const m of months) {
      if (await cancelDatePeriodClosed(tx, req.employmentId, `${m}-01`)) {
        throw new LeaveCancellationPeriodClosedError(`${m}-01`);
      }
    }

    // ── Effect ──────────────────────────────────────────────────────────────────────────────────────────
    // 1) Restore the balance by reversing the NET ledger debit sourced to this request. Net-sum (not req.days)
    //    is robust to per-date partial approvals, survivors of a prior cancellation split (whose rows net to
    //    the survivor's current debit), half-day/hourly fractions, and unpaid types that never debited (net 0
    //    ⇒ nothing to reverse). Pending leave has no debit ⇒ net 0 ⇒ restoredDays 0.
    const [netRow] = await tx
      .select({ net: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
      .from(leaveLedger)
      .where(eq(leaveLedger.sourceRequestId, req.id));
    const net = Number(netRow?.net ?? 0);
    let restoredDays = 0;
    if (net < 0) {
      restoredDays = round2(-net);
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: req.employmentId,
        // Balance Deduction Source (cdf9ca48): give the days back to the ledger they came out of. The net
        // above already covers the unpaid split correctly — it reverses what was actually debited.
        leaveTypeId: await resolveBalanceSourceTypeId(tx, req.leaveTypeId),
        entryType: 'debit',
        days: restoredDays.toFixed(2), // positive = reversal of the original negative debit
        sourceRequestId: req.id,
        effectiveOn: req.startDate, // same cycle/carry window as the original debit
      });
    }

    // 2) Flip the request to cancelled. decidedByEmploymentId/decidedAt are left untouched (they record the
    //    ORIGINAL approval decision; the cancellation's who/when lives in the event below).
    await tx.update(leaveRequest).set({ status: 'cancelled' }).where(eq(leaveRequest.id, req.id));

    // 3) Supersede any open employee give-back on this leave, so no dangling pending card sits in /approvals
    //    (decideLeaveCancellation would then error on it). The column CHECK is pending|approved|rejected, so a
    //    superseded row becomes 'rejected' with HR as decider, plus a per-row rejected event.
    const openGiveBacks = await tx
      .select({ id: leaveCancellationRequest.id })
      .from(leaveCancellationRequest)
      .where(
        and(
          eq(leaveCancellationRequest.leaveRequestId, req.id),
          eq(leaveCancellationRequest.status, 'pending'),
        ),
      );
    if (openGiveBacks.length > 0) {
      await tx
        .update(leaveCancellationRequest)
        .set({ status: 'rejected', decidedByEmploymentId: p.cancelledByEmploymentId ?? null, decidedAt: sql`now()` })
        .where(
          and(
            eq(leaveCancellationRequest.leaveRequestId, req.id),
            eq(leaveCancellationRequest.status, 'pending'),
          ),
        );
      for (const gb of openGiveBacks) {
        await appendEvent(tx, {
          tenantId: ctx.tenantId,
          aggregateType: 'leave-cancellation-request',
          aggregateId: gb.id,
          eventType: 'leave-cancellation.rejected',
          actor: actorOf(ctx),
          subjectEmploymentId: req.employmentId,
          payload: { leaveRequestId: req.id, supersededByAdminCancellation: true },
        });
      }
    }

    // 4) Substrate discipline — the audit trail for this HR action. A DISTINCT event type (not the split
    //    machinery's leave-request.cancelled) so the notification registry keys the employee notice without
    //    also firing on a manager approving an employee's own give-back. Payload carries the display fields
    //    (type/dates) the notification renderer needs (renderers are payload-only) + the full audit facts.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.admin-cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: {
        previousStatus,
        newStatus: 'cancelled',
        restoredDays,
        reason: p.reason?.trim() || null,
        cancelledByEmploymentId: p.cancelledByEmploymentId ?? null,
        leaveTypeCode: lt?.code ?? null,
        leaveTypeName: lt?.name ?? null,
        startDate: req.startDate,
        endDate: req.endDate,
      },
    });

    return { previousStatus, restoredDays };
  });
}

// ═════════════════════ Edit / cancel own leave by status (item c9a19e34) ═════════════════════
// Employee self-service on their OWN leave, status-gated:
//   • PENDING  → editLeaveRequest (modify details, stays pending) + cancelOwnLeave (immediate self-withdraw).
//   • APPROVED → cancellation is routed through the manager-approved give-back flow (requestLeaveCancellation),
//                NOT an immediate unilateral self-cancel — that preserves the balance invariant + ADR-0065's
//                deliberate "a manager confirms giving back approved leave" rule. So cancelOwnLeave refuses a
//                non-pending row (the action layer sends approved rows to requestLeaveCancellation instead).
//   • REJECTED → view-only (no write path).
// The "creator-only" rule lives in the SERVICE (RLS is symmetric — a manager can SEE a subordinate's leave —
// so the subject assertion is enforced in code, mirroring requestLeaveCancellation :2614-2620). v1 restricts
// both edit and self-withdraw to PLAIN single-request rows (parentGroupId null, no per-date sub-rows, not an
// EL/REPLACEMENT type): an Emergency-Leave submission is two coupled child rows and a per-date-approval span
// carries its own decision sub-rows, so editing/withdrawing just one half would strand the other. Those groups
// keep the existing give-back / admin-cancel paths and are deferred to a later pass.

/**
 * Edit a PENDING leave request in place, keeping it pending. Subject-only (the creator). Re-runs the same
 * validation gates requestLeave applies (eligibility, backdating 0133, min-advance 0159, duration allow-list,
 * document/remark, day recompute) against the NEW details, updates the row, and regenerates the approval-step
 * chain (day count / type may have changed the scoped chain). Pending leave has NO ledger debit (the debit
 * posts only at final approval :1915) so there is nothing to reverse. Appends `leave-request.edited`
 * {before, after, diff} for the audit trail (CLAUDE.md substrate discipline).
 */
export async function editLeaveRequest(
  ctx: SessionContext,
  p: {
    leaveRequestId: string;
    leaveTypeId: string;
    startDate: string;
    endDate: string;
    reason?: string;
    employeeRemark?: string;
    durationType?: LeaveDurationType;
    fromTime?: string;
    toTime?: string;
    today?: string;
  },
): Promise<{ leaveRequestId: string; days: number }> {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Subject-only: RLS is symmetric so the creator-only rule is enforced here (mirrors requestLeaveCancellation).
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveEditNotAllowedError('only the employee who applied can edit their leave');
    }

    // Status gate: only a PENDING request is editable (expected_function 3.i — "available only for pending").
    if (req.status !== 'pending') throw new LeaveEditNotAllowedError(`the leave is already ${req.status}`);

    // v1 edge-case exclusions: plain single-request rows only.
    if (req.parentGroupId != null) {
      throw new LeaveEditNotAllowedError('grouped (emergency / split) leave cannot be edited here');
    }
    const [hasDateRows] = await tx
      .select({ id: leaveRequestDate.id })
      .from(leaveRequestDate)
      .where(eq(leaveRequestDate.leaveRequestId, req.id))
      .limit(1);
    if (hasDateRows) {
      throw new LeaveEditNotAllowedError('per-date-approval leave cannot be edited here');
    }

    const [lt] = await tx
      .select({
        code: leaveType.code,
        name: leaveType.name,
        counting: leaveType.counting,
        eligibility: leaveType.eligibility,
        // Probation eligibility (d6bdbd55): merged into the eligibility object below (same as requestLeave).
        probationEligibility: leaveType.probationEligibility,
        dayTypeInclusion: leaveType.dayTypeInclusion,
        requiresDocument: leaveType.requiresDocument,
        mandatoryAfterDays: leaveType.mandatoryAfterDays,
        employeeRemarkRequired: leaveType.employeeRemarkRequired,
        durations: leaveType.durations,
        backdatingLimitDays: leaveType.backdatingLimitDays,
        minAdvanceDays: leaveType.minAdvanceDays,
        // 7daac043: the unit the notice requirement is read in. An edit re-runs the SAME gate as submission,
        // so it must read the same column or an edit could rescue an application the submission refused.
        minAdvanceDayType: leaveType.minAdvanceDayType,
        customMessages: leaveType.customMessages,
        // Duplicate Leave Application Restriction (d5e51c34): same-date double-booking policy — enforced below
        // after the AM/PM slot-clash guard, EXCLUDING this very request. null ⇒ 'allow'.
        duplicateApplicationPolicy: leaveType.duplicateApplicationPolicy,
        // Configurable Negative Leave Balance Validation (0ef0defd): submit/edit-time balance guard flag —
        // enforced below (excluding this very request from its own pending reservation). false ⇒ block.
        allowNegativeBalance: leaveType.allowNegativeBalance,
        // Allow Unpaid Leave (a7fab30b): the edit re-splits paid/unpaid from scratch. An edit can change the
        // type, the dates, or the duration, any of which moves the boundary — carrying the old split forward
        // would leave the request claiming unpaid days it no longer has (or paying for days it cannot cover).
        allowUnpaidLeave: leaveType.allowUnpaidLeave,
      })
      .from(leaveType)
      .where(eq(leaveType.id, p.leaveTypeId))
      .limit(1);
    if (!lt) throw new Error('leave type not found');
    // EMERGENCY / REPLACEMENT decompose or consume registers — never edited in place (v1).
    if (leaveTypeIs(lt, 'emergency') || leaveTypeIs(lt, 'replacement')) {
      throw new LeaveEditNotAllowedError('this leave type cannot be edited here');
    }

    // ── Re-validate the NEW details (fail fast, same gates + errors as requestLeave) ─────────────────────
    const baseElig = (lt.eligibility ?? null) as LeaveEligibility | null;
    const probation = (lt.probationEligibility ?? null) as ProbationEligibility | null;
    const elig: LeaveEligibility | null =
      baseElig || probation ? { ...(baseElig ?? {}), ...(probation ? { probation } : {}) } : null;
    if (elig && hasAnyEligibilityRestriction(elig)) {
      const [emp] = await tx
        .select({
          gender: person.gender,
          marital: person.maritalStatus,
          hiredOn: employment.hiredOn,
          confirmationDate: employment.confirmationDate,
          finalConfirmationDate: employment.finalConfirmationDate,
          // Organisation Assignment criteria: the eight org columns live ON employment (already the FROM root),
          // so widening this existing SELECT is sufficient — no new join, no as-of choice.
          orgDivision: employment.orgDivision,
          orgBranch: employment.orgBranch,
          orgRegion: employment.orgRegion,
          orgLine: employment.orgLine,
          orgSection: employment.orgSection,
          orgTeam: employment.orgTeam,
          orgBase: employment.orgBase,
          employmentCategory: employment.employmentCategory,
        })
        .from(employment)
        .innerJoin(person, eq(person.id, employment.personId))
        .where(eq(employment.id, req.employmentId))
        .limit(1);
      assertEligible(elig, emp, p.startDate);
    }

    const today = p.today ?? todayInKualaLumpur();
    if (!isAdmin(ctx) && exceedsBackdatingLimit(p.startDate, today, lt.backdatingLimitDays ?? null)) {
      throw new LeaveBackdatingNotAllowedError(
        lt.backdatingLimitDays!,
        lt.name,
        lt.customMessages?.backdatingLimitDays || undefined,
      );
    }
    // 7daac043 — the notice gate reads its configured UNIT here too, with the same guarded resolution as
    // requestLeave: no extra query on the calendar path, and none for a backdated start whose notice window
    // is empty either way.
    const editMinAdvance = lt.minAdvanceDays ?? null;
    const editDayType = resolveAdvanceNoticeDayType(lt.minAdvanceDayType);
    let editNoticeRoster: number[] | undefined;
    let editNoticeHolidays: Set<string> | undefined;
    if (!isAdmin(ctx) && editMinAdvance != null && editDayType === 'working_days' && p.startDate > today) {
      editNoticeRoster = await resolveWorkingDaysIso(tx, req.employmentId);
      editNoticeHolidays = await resolveHolidaySet(tx, req.employmentId, today, p.startDate);
    }
    if (
      !isAdmin(ctx) &&
      lacksMinAdvanceNoticeIn(p.startDate, today, editMinAdvance, editDayType, editNoticeRoster, editNoticeHolidays)
    ) {
      throw new LeaveAdvanceNoticeRequiredError(
        lt.minAdvanceDays!,
        lt.name,
        lt.customMessages?.minAdvanceDays || undefined,
        editDayType,
      );
    }

    const durationType: LeaveDurationType = p.durationType ?? 'full_day';
    let fromTime: string | null = null;
    let toTime: string | null = null;
    let hours: number | null = null;
    if (durationType === 'hourly') {
      if (p.fromTime || p.toTime) {
        hours = hoursBetween(p.fromTime ?? '', p.toTime ?? '');
        fromTime = (p.fromTime ?? '').slice(0, 5);
        toTime = (p.toTime ?? '').slice(0, 5);
      } else {
        throw new HourlyLeaveTimeRangeError();
      }
    }
    if (durationType !== 'full_day') {
      const allow = (lt.durations as string[] | null) ?? [];
      if (!allow.includes(durationType)) throw new LeaveDurationNotAllowedError();
      if (p.startDate !== p.endDate) {
        throw new Error('Half-day and hourly leave must be a single day (start and end dates must match)');
      }
    }

    let workingDayCount: number | null = null;
    let workingDayWeight: number | null = null;
    if (lt.counting === 'working_days') {
      const hols = await resolveHolidaySet(tx, req.employmentId, p.startDate, p.endDate);
      const sched = await resolveSchedule(tx, req.employmentId);
      const incl = normalizeDayTypeInclusion(lt.dayTypeInclusion);
      workingDayCount = eachDate(p.startDate, p.endDate).filter((d) => isDeductibleDay(d, sched, hols, incl)).length;
      workingDayWeight = workingDaysWeighted(p.startDate, p.endDate, hols, sched, incl);
    }

    let days: number;
    if (durationType === 'full_day') {
      days = lt.counting === 'working_days' ? workingDayWeight! : dayCount(p.startDate, p.endDate);
    } else {
      if (lt.counting === 'working_days' && workingDayCount === 0) throw new LeaveNoDaysInRangeError();
      if (durationType === 'hourly') {
        const h = hours ?? 0;
        if (!(h > 0 && h <= 24)) throw new Error('Hourly leave must be more than 0 and at most 24 hours');
        days = Math.round((h / DEFAULT_STANDARD_HOURS) * 100) / 100;
      } else {
        days = 0.5;
      }
      // AM/PM same-date conflict guard, EXCLUDING this very request (an edit must not clash with itself).
      const existing = await tx
        .select({ durationType: leaveRequest.durationType })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, req.employmentId),
            eq(leaveRequest.startDate, p.startDate),
            eq(leaveRequest.endDate, p.endDate),
            inArray(leaveRequest.status, ['pending', 'approved']),
            sql`${leaveRequest.id} <> ${req.id}`,
          ),
        );
      for (const e of existing) {
        const conflicts =
          e.durationType === durationType ||
          e.durationType === 'full_day' ||
          e.durationType === 'hourly' ||
          durationType === 'hourly';
        if (conflicts) throw new Error('This date already has a conflicting leave request');
      }
    }

    // Duplicate Leave Application Restriction (d5e51c34): mirror of the requestLeave guard, EXCLUDING this very
    // request (an edit must not clash with itself). Runs for ALL durations. Range-overlap (not same-slot) of a
    // pending/approved application; 'restrict_same' scopes to the SAME type, 'restrict_any' matches any type.
    // 'allow'/null ⇒ no extra check. Fires for admins too (data-integrity rule, not a permission).
    const dupPolicy = lt.duplicateApplicationPolicy ?? 'allow';
    if (dupPolicy === 'restrict_same' || dupPolicy === 'restrict_any') {
      const overlap = await tx
        .select({ id: leaveRequest.id })
        .from(leaveRequest)
        .where(
          and(
            eq(leaveRequest.employmentId, req.employmentId),
            inArray(leaveRequest.status, ['pending', 'approved']),
            lte(leaveRequest.startDate, p.endDate),
            gte(leaveRequest.endDate, p.startDate),
            sql`${leaveRequest.id} <> ${req.id}`,
            ...(dupPolicy === 'restrict_same' ? [eq(leaveRequest.leaveTypeId, p.leaveTypeId)] : []),
          ),
        )
        .limit(1);
      if (overlap.length > 0) throw new DuplicateLeaveApplicationError();
    }

    if (days <= 0) throw new LeaveNoDaysInRangeError();

    // Configurable Negative Leave Balance Validation (0ef0defd): submit/edit-time balance guard, mirroring the
    // requestLeave check. availableLeaveBalance EXCLUDES this very request (req.id) from its own pending
    // reservation, so the NEW days are re-checked against everything else. allow_negative_balance=false ⇒ block
    // an edit that would take the balance negative; =true ⇒ skip. round2 matches the leave math.
    // Allow Unpaid Leave (a7fab30b) mirrors requestLeave: when on it supersedes the block and re-measures the
    // uncovered part instead, against the resolved balance source (cdf9ca48) and excluding this request's own
    // reservation. Recomputed rather than carried, since the edit may have changed the days or the type.
    let unpaidDays = 0;
    if (lt.allowUnpaidLeave === true) {
      const available = await availableLeaveBalance(tx, req.employmentId, p.leaveTypeId, req.id);
      unpaidDays = round2(Math.max(0, days - Math.max(0, available)));
    } else if (lt.allowNegativeBalance === false) {
      const available = await availableLeaveBalance(tx, req.employmentId, p.leaveTypeId, req.id);
      if (round2(available - days) < 0) throw new InsufficientLeaveBalanceOnSubmitError();
    } else if (lt.allowNegativeBalance === true) {
      // bc512dc3 — the floor applies to an EDIT too, or an application refused at submission could be
      // resubmitted as an edit and land past the limit. Excludes this request's own reservation, exactly
      // as the branch above does.
      const available = await availableLeaveBalance(tx, req.employmentId, p.leaveTypeId, req.id);
      await enforceMaxNegativeBalance(tx, { leaveTypeId: p.leaveTypeId, available, requestedDays: days });
    }

    // Document + remark gates (identical to requestLeave). hasDocument = an attachment already exists on this
    // request (edit does not re-upload; changing to a doc-required type with no attachment is refused).
    const [att] = await tx
      .select({ id: leaveRequestAttachment.id })
      .from(leaveRequestAttachment)
      .where(eq(leaveRequestAttachment.leaveRequestId, req.id))
      .limit(1);
    const hasDocument = !!att;
    if (lt.requiresDocument && !hasDocument) {
      const after = lt.mandatoryAfterDays;
      if (after == null || after === 0 || days > after) {
        throw new LeaveDocumentRequiredError(lt.name, after ?? undefined);
      }
    }
    const employeeRemark = p.employeeRemark?.trim() || null;
    if (lt.employeeRemarkRequired && !employeeRemark) throw new LeaveRemarkRequiredError(lt.name);

    // ── Apply the edit ───────────────────────────────────────────────────────────────────────────────────
    const before = {
      leaveTypeId: req.leaveTypeId,
      startDate: req.startDate,
      endDate: req.endDate,
      days: Number(req.days),
      durationType: req.durationType,
      reason: req.reason,
      employeeRemark: req.employeeRemark,
    };
    await tx
      .update(leaveRequest)
      .set({
        leaveTypeId: p.leaveTypeId,
        startDate: p.startDate,
        endDate: p.endDate,
        days: days.toFixed(2),
        durationType,
        hours: hours != null ? hours.toFixed(2) : null,
        fromTime,
        toTime,
        reason: p.reason?.trim() || null,
        employeeRemark,
        // Allow Unpaid Leave (a7fab30b): the re-measured split. Written unconditionally (0 ⇒ NULL) so an edit
        // that moves the request onto a type without the setting, or back inside the balance, CLEARS a stale
        // unpaid portion rather than leaving it to be honoured at approval.
        unpaidDays: unpaidDays ? unpaidDays.toFixed(2) : null,
      })
      .where(eq(leaveRequest.id, req.id));

    // Regenerate the approval-step chain from scratch — the day count / leave type may now resolve a different
    // scoped chain. Only pending steps existed (the request is pending), so deleting + regenerating is safe.
    await tx.delete(leaveApprovalStep).where(eq(leaveApprovalStep.leaveRequestId, req.id));
    await generateApprovalSteps(tx, ctx.tenantId, req.id, req.employmentId, p.leaveTypeId, days);

    const after = {
      leaveTypeId: p.leaveTypeId,
      startDate: p.startDate,
      endDate: p.endDate,
      days,
      durationType,
      reason: p.reason?.trim() || null,
      employeeRemark,
    };
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of Object.keys(after) as (keyof typeof after)[]) {
      if ((before as Record<string, unknown>)[k] !== (after as Record<string, unknown>)[k]) {
        diff[k] = { before: (before as Record<string, unknown>)[k], after: (after as Record<string, unknown>)[k] };
      }
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.edited',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { before, after, diff },
    });

    return { leaveRequestId: req.id, days };
  });
}

/**
 * Employee self-withdrawal of their OWN PENDING leave — an immediate cancel (no approval workflow), because a
 * pending request was never approved so there is nothing for a manager to confirm giving back. Subject-only.
 * Restricted to PENDING (an approved row must go through requestLeaveCancellation's manager-approved give-back,
 * per Option A / ADR-0065). Pending leave has no ledger debit (net 0 ⇒ nothing to restore); the net-sum
 * reversal is kept for defense-in-depth. Appends a DISTINCT `leave-request.self-cancelled` event (separate
 * from admin-cancelled + give-back) so the notification registry can key "notify approver + HR" (req 4.v).
 */
export async function cancelOwnLeave(
  ctx: SessionContext,
  p: { leaveRequestId: string },
): Promise<{ previousStatus: 'pending'; restoredDays: number }> {
  return withTenant(ctx, async (tx) => {
    const [req] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, p.leaveRequestId)).limit(1);
    if (!req) throw new Error('leave request not found (or not visible)');

    // Subject-only (creator). Enforced in code (RLS is symmetric).
    const subjectPersonId = await personIdForEmployment(tx, req.employmentId);
    if (!ctx.personId || ctx.personId !== subjectPersonId) {
      throw new LeaveCancellationNotAllowedError('only the employee can cancel their own leave');
    }

    // Status gate: PENDING only. An approved row is routed to the give-back flow at the action layer.
    if (req.status !== 'pending') {
      throw new LeaveCancellationNotAllowedError(
        req.status === 'approved'
          ? 'approved leave must be cancelled through the give-back flow'
          : `the leave is already ${req.status}`,
      );
    }
    // v1: plain single-request rows only (an EL child would strand its sibling).
    if (req.parentGroupId != null) {
      throw new LeaveCancellationNotAllowedError('grouped (emergency / split) leave cannot be cancelled here');
    }

    const [lt] = await tx
      .select({ code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.id, req.leaveTypeId))
      .limit(1);

    // Reverse the NET ledger debit (net 0 for pending ⇒ restoredDays 0; kept robust for defense-in-depth).
    const [netRow] = await tx
      .select({ net: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
      .from(leaveLedger)
      .where(eq(leaveLedger.sourceRequestId, req.id));
    const net = Number(netRow?.net ?? 0);
    let restoredDays = 0;
    if (net < 0) {
      restoredDays = round2(-net);
      await tx.insert(leaveLedger).values({
        tenantId: ctx.tenantId,
        employmentId: req.employmentId,
        // Balance Deduction Source (cdf9ca48): same ledger the approval debited (see the give-back path).
        leaveTypeId: await resolveBalanceSourceTypeId(tx, req.leaveTypeId),
        entryType: 'debit',
        days: restoredDays.toFixed(2),
        sourceRequestId: req.id,
        effectiveOn: req.startDate,
      });
    }

    await tx.update(leaveRequest).set({ status: 'cancelled' }).where(eq(leaveRequest.id, req.id));

    // Substrate: distinct self-cancelled event (audit + notification key). Carries the display fields the
    // approver/HR notification renderer needs (payload-only renderers).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.self-cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: {
        previousStatus: 'pending',
        newStatus: 'cancelled',
        restoredDays,
        leaveTypeCode: lt?.code ?? null,
        leaveTypeName: lt?.name ?? null,
        startDate: req.startDate,
        endDate: req.endDate,
      },
    });

    return { previousStatus: 'pending', restoredDays };
  });
}

// ───────────────────── Leave-year boundary (STATUTORY-SOURCES §5) ─────────────────────

/** Types granted as standing yearly entitlements; situational types are claimed per event.
 *  r299 (3de1453a): the EARNED ACCRUAL sweep no longer reads this — it covers Annual Leave only, through
 *  `isEarnedAccrualType`. `openLeaveYear` still does, deliberately; see that predicate's header. */
export const STANDING_LEAVE_CODES = ['ANNUAL', 'SICK', 'HOSPITALIZATION'] as const;

/**
 * Carry-forward-report feature — reason codes stamped on the AUTOMATIC negative `adjustment` rows the
 * carry-forward engine posts (openLeaveYear cap-excess, accrueEarnedLeave 2D-3 cap-excess, and
 * expireCarriedLeave's later expiry forfeit). Prefixed `sys:` — no human would type this, and
 * grantAdHocLeave only ever writes POSITIVE days (validated `days <= 0` throws), so a machine-forfeit
 * reason can never collide with a human festive-grant reason under the (leaveTypeId, effectiveOn,
 * reason) idempotency key — the shape grantAdHocLeave used before 38f1fd40 retired it, and the one any
 * future grant path should reuse. Purely additive tagging — no behaviour
 * change to any forfeit amount, timing, or idempotency check (all of which stay reason-blind).
 */
export const CARRY_FORFEIT_REASON_CAP = 'sys:carry_forward_cap';
export const CARRY_FORFEIT_REASON_EXPIRY = 'sys:carry_forward_expiry';
/**
 * LEGACY / READ-ONLY — DO NOT DELETE. NOTHING WRITES THIS ANY MORE, AND THAT IS NOT A REASON TO REMOVE IT.
 *
 * Leave Type Expiry Field (fec49317) — the reason stamped on the automatic negative `adjustment` the
 * expireAgedLeave sweep used to post when an earned portion lapsed `leave_type.expiry_value expiry_unit`
 * after the date it was earned. c459bff9 REMOVED the writer (the sweep, the columns, the screen) as an
 * intentional reset ahead of a new expiry framework. The constant and its READERS stay, because rows
 * carrying this reason are transactions employees have already seen and deleting the constant would
 * silently rewrite that history:
 *   - core/read.ts classifyLedgerAdjustment would fall through to 'config', so every past AUTOMATIC forfeit
 *     would render as a MANUAL HR adjustment;
 *   - core/read.ts agedForfeited would drop out of the `forfeited` fold and the reconciliation identity
 *     `entitlement + carried + otherAdjustments - taken - forfeited = balance` would stop balancing;
 *   - a2cSupersededReasonCond would stop superseding those rows in the first-year Anniversary-to-Calendar
 *     correction, changing first-year entitlement figures.
 * A new expiry framework MUST mint its own reason code rather than reusing this one — that is what keeps
 * old and new forfeits distinguishable. Reason-blind readers (leaveBalance, leaveEntitlementBreakdown)
 * treat it exactly like any other negative adjustment: the day left the balance but stays a real ledger
 * row, so it remains visible in reports.
 */
export const AGED_FORFEIT_REASON = 'sys:leave_type_expiry';
/**
 * Configurable Earned Leave Entitlement Rules (feedback 49809272) — reason PREFIX stamped on the
 * compensating `adjustment` rows `reprojectEntitlementForPolicy` posts when an admin corrects an
 * entitlement policy IN PLACE (updateLeavePolicy). The full reason is `sys:policy_recalc:<policyId>` so
 * the audit trail names the exact policy version that drove the correction. `sys:`-prefixed like the
 * forfeit codes above, so it can never collide with a human festive-grant reason. Rows carrying this
 * prefix count as "already granted this cycle" in BOTH the recalc's own delta (idempotency — a re-saved
 * identical correction computes delta 0) and accrueEarnedLeave's top-up sum (so the monthly cron never
 * re-grants a delta the recalc already posted).
 */
export const POLICY_RECALC_REASON_PREFIX = 'sys:policy_recalc';

/** R45 7527ea5f — reason prefix for the PROFILE-triggered recalc (reprojectEntitlementForEmployment): when
 *  an employee's grade / grade group / employment type / confirmation status / hire date changes, the current
 *  cycle is re-projected and a compensating `adjustment` (reason `sys:profile_recalc:<employmentId>`) is
 *  posted. Same `sys:` family as the policy prefix — counts as "already granted this cycle" everywhere the
 *  policy prefix does, so the two recalc paths (and the accrual cron) stay mutually idempotent. */
export const PROFILE_RECALC_REASON_PREFIX = 'sys:profile_recalc';

/** Drizzle predicate: a `leave_ledger.reason` stamped by EITHER recalc path (policy or profile). Both count
 *  as already-materialized entitlement, so the delta math sees them and never double-posts. */
const recalcAdjustmentReasonCond = () =>
  or(
    like(leaveLedger.reason, `${POLICY_RECALC_REASON_PREFIX}:%`),
    like(leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
  );

/**
 * 35b7af0a group 3 — `serviceYearsAt` and `completedYearsAt` are DEFINED in `lib/completed-years.ts` and
 * only re-exported here. The Create New Employee wizard is a client component and cannot import this module
 * (it pulls in the database), so the Age figure the reporter asked for could not exist there at all; moving
 * the two-line calendar math to a client-safe module is what lets ONE counter serve both screens instead of
 * a browser-side copy that drifts. Re-exported rather than redefined so every existing
 * `import { serviceYearsAt } from '@/core/leave'` — core/read.ts, core/analytics.ts, the entitlement engine
 * below, and four test files — keeps working against the SAME function identity. See lib/person-vocabulary.ts
 * for the same move, made for the same reason.
 */
export { serviceYearsAt, completedYearsAt };

/**
 * Length of service between `hiredOn` and `asOf` broken into whole years + residual whole months. Pure +
 * UTC-correct calendar math, consistent with serviceYearsAt (its `.years` equals serviceYearsAt for the
 * same inputs). A future `asOf` before `hiredOn` clamps to { years: 0, months: 0 }. Display-only; drives no
 * entitlement.
 *
 * It USED to render the "XX Years XX Months" figures on the Employment tab (feedback 24c4d02e); 4ea70bb7
 * repointed those at the day-precise serviceYearsMonthsDaysAt below, so nothing in app/ calls this any
 * more. It is kept on purpose, not left behind: it is the whole-month reference the day-precise function is
 * pinned against (test/personnel-year-of-service.test.ts asserts .years/.months are equal for the same
 * inputs, over serviceYearsAt's own equality with .years). That chain is what keeps a service figure on
 * screen and a leave service band computed from the same dates in agreement. Deleting it would remove the
 * only thing that checks the arithmetic they share.
 */
export const serviceYearsMonthsAt = (
  hiredOn: string,
  asOf: string,
): { years: number; months: number } => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  let months =
    (a.getUTCFullYear() - h.getUTCFullYear()) * 12 + (a.getUTCMonth() - h.getUTCMonth());
  if (a.getUTCDate() < h.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12 };
};

/**
 * Length of service between `hiredOn` and `asOf` to full day precision — every service figure the Personnel
 * profile shows: "Year of Service" on the summary card (feedback cc681bd5) and, since 4ea70bb7, the
 * Employment tab's Group Service and Current Company Service (each from its OWN date — this function is
 * called once per date, it does not know which is which). Same UTC whole-month math as serviceYearsMonthsAt
 * (its `.years`/`.months` ALWAYS equal serviceYearsMonthsAt for the same inputs — this only appends the
 * residual-day tail), so the card figure can never disagree with the leave service bands. Day borrowing:
 * when asOf's day-of-month is below hiredOn's, one month is borrowed and the residual days count from the
 * anchor — hiredOn advanced by the whole-month total, its day-of-month clamped to the anchor month's
 * length (31 Jan + 1 month anchors at 28/29 Feb, so 31-Jan → 1-Mar = 1 Month 1 Day; a 29-Feb hire anchors
 * at 28-Feb in common years). An `asOf` before `hiredOn` clamps to all zeros. Display-only; drives no
 * entitlement — the leave service bands read serviceYearsAt, and this function's `.years` equals it.
 */
export const serviceYearsMonthsDaysAt = (
  hiredOn: string,
  asOf: string,
): { years: number; months: number; days: number } => {
  const h = new Date(`${hiredOn}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  if (a.getTime() < h.getTime()) return { years: 0, months: 0, days: 0 };
  let months =
    (a.getUTCFullYear() - h.getUTCFullYear()) * 12 + (a.getUTCMonth() - h.getUTCMonth());
  if (a.getUTCDate() < h.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  const anchorMonthIndex = h.getUTCMonth() + months;
  const anchorYear = h.getUTCFullYear() + Math.floor(anchorMonthIndex / 12);
  const anchorMonth = anchorMonthIndex % 12;
  // Day 0 of month N+1 is the last day of month N — the clamp target for month-end hires.
  const daysInAnchorMonth = new Date(Date.UTC(anchorYear, anchorMonth + 1, 0)).getUTCDate();
  const anchor = Date.UTC(anchorYear, anchorMonth, Math.min(h.getUTCDate(), daysInAnchorMonth));
  const days = Math.round((a.getTime() - anchor) / 86_400_000);
  return { years: Math.floor(months / 12), months: months % 12, days };
};

/**
 * Feedback 9816a5ad step 2 — the ten type-level rule columns as a drizzle select shape.
 *
 * ONE definition, spread into every repointed `select({...})`, so no call site can read a different
 * subset of the rules than another. That matters more than it looks: the granting engines (the hire
 * grant, openLeaveYear, accrueEarnedLeave) and the projection kernel (projectExpectedEntitlement, via
 * the three reproject entry points) must agree to the DAY, or a reproject compares its own projection
 * against a ledger the grant engine wrote under a different rule and posts a permanent oscillating
 * delta. That failure mode is already documented inline at the rounding call sites; a hand-copied
 * column list at eight sites is exactly how it would come back.
 */
export const leaveTypeRuleColumns = {
  accrualMethod: leaveType.accrualMethod,
  // bc36c768 (0375): the fourteenth column — which day of the month Monthly Accrual credits on. Here for
  // the reason the header gives: an accrual day the accrual engine honours but the projection kernel does
  // not is, precisely, the permanent oscillating delta this map exists to prevent (on the 10th with a
  // credit day of 15, one side counts N-1 periods and the other counts N, on every profile edit forever).
  accrualDay: leaveType.accrualDay,
  // bc36c768 (0375/0376): the fifteenth column — THE NOT-CONFIGURED MARKER. It is in this map so it rides
  // every existing select and each gate can read it off the type row it already has; without it the hire
  // grant at core/org.ts has nothing to read. It is deliberately NOT in `hasAnyLeaveTypeRule` and NOT in
  // `applyLeaveTypeRules` — a column may be in the select map without being in the engagement test, and
  // for this one that gap is the whole design (see the note on hasAnyLeaveTypeRule).
  accrualUnconfigured: leaveType.accrualUnconfigured,
  carryForwardMax: leaveType.carryForwardMax,
  // 7cd914b1 — the twelfth rule column. It belongs HERE and only here for the reason in the header: eight
  // hand-copied column lists is how the grant engine and the projection kernel come to read different rules.
  carryForwardPercent: leaveType.carryForwardPercent,
  carryForwardEnabled: leaveType.carryForwardEnabled,
  carryForwardExpiryMode: leaveType.carryForwardExpiryMode,
  carryForwardExpiryMonths: leaveType.carryForwardExpiryMonths,
  carryForwardExpiryMonth: leaveType.carryForwardExpiryMonth,
  carryForwardExpiryDay: leaveType.carryForwardExpiryDay,
  carryForwardIncludeEarned: leaveType.carryForwardIncludeEarned,
  roundingMethod: leaveType.roundingMethod,
  // 9f5164d8 (0335): the eleventh column. Added HERE rather than at any call site for exactly the reason
  // the header gives — a rounding threshold read by the grant engine but not by the projection kernel
  // would post a permanent oscillating delta on every reproject.
  roundingThreshold: leaveType.roundingThreshold,
  // 8fec719e (0358): the thirteenth column, the custom rounding table. Added HERE for the reason the
  // header gives and 7cd914b1 proved twice: a band table the grant engine reads but the projection kernel
  // does not would make every reproject post a permanent oscillating delta against a ledger written under
  // a rule the kernel cannot see.
  roundingBands: leaveType.roundingBands,
  maxBalanceDays: leaveType.maxBalanceDays,
} as const;

/**
 * An employment a leave sweep could NOT compute, and why (ADR-0077 slice 6).
 *
 * Every one of these loops used to say `if (!pack) continue` — the employee was skipped and NOBODY was
 * told. `createCompany`'s own comment names the consequence: "LEAVE fails SILENT — the engines
 * `continue` past a packless employee and the holiday resolver yields an empty calendar, so the employee
 * accrues nothing and nobody is told."
 *
 * The skip itself is correct and stays: statutory entitlement cannot be computed without a jurisdiction,
 * and inventing one would be worse. What changes is that it is REPORTED. A sweep does not throw, because
 * one packless employee must not abort accrual for everyone else — `requirePackFor` is the right shape
 * for a single operation and the wrong shape for a batch.
 *
 * Unreachable today (every company is MY and the pack resolves), and deliberately landed BEFORE slice 6's
 * non-statutory tier makes it reachable: introducing companies without packs while this still failed
 * silently would manufacture zero-accrual employees nobody could see.
 */
export type PackBlockedEmployment = {
  employmentId: string;
  country: string | null;
  reason: 'country_pack_inactive';
};

/**
 * 93249794 — WHAT THIS SWEEP DECIDED ABOUT ONE (employment, leave type) PAIR.
 *
 * ⚠️ EVERY VALUE HERE IS A LABEL ON A BRANCH THAT ALREADY EXISTED. Not one of them changes what the sweep
 * does, and that is the entire design: the Generate Entitlement screen's "Validation & Preview" step is a
 * DRY RUN OF THIS FUNCTION, so its verdict for an employee is — by construction, not by agreement — the
 * verdict the real run will reach. The plan's own words: "build it as a DRY RUN over the same resolver the
 * real run uses, not a separate list of checks. Anything else drifts."
 *
 * That is why there is no `validateLeaveGeneration` anywhere in this codebase. A second function asking
 * "would this employee get days?" is a second definition of entitlement, which the item's build notes name
 * as "the single worst outcome available here". The outcomes below are read off the ONE pass.
 *
 * The reporter's requested validation list maps onto them honestly, and where it does not, the mapping is
 * stated rather than faked:
 *   • "Missing Service Based Entitlement" / "Missing Leave Balance" / "Missing required Leave Type
 *     configuration" ⇒ `no_entitlement` — the composition (`entitledDays`) resolved 0 days or less.
 *   • "Missing Earning Method"                             ⇒ `unconfigured_method` (bc36c768's marker).
 *   • "Duplicate entitlement records"                      ⇒ `already_open` (the idempotency marker row).
 *   • "Invalid employee configuration"                     ⇒ `pack_blocked` (no active country pack).
 *   • "Missing Company assignment" is not reachable: `employment.company_id` is NOT NULL and the sweep
 *     INNER JOINs company, so an employment without one is not a row this loop can see.
 *   • "Missing Leave Year Type" is not an error for THIS sweep: openLeaveYear is calendar-anchored by
 *     definition (it grants at 1 January), so a company's leave_cycle cannot make it fail.
 *   • "Missing Grade" is not an error either — `resolveGradePolicy` accepts a null grade and matches the
 *     company/default rows. Reporting it as a failure would tell HR to fix something that is not broken.
 */
export type LeaveYearGrantOutcome =
  /** An accrual row was (or would be) written for this pair, at `days`. */
  | 'granted'
  /** bc36c768: the type carries the not-configured marker, so the grant is forced to 0. The marker row is
   *  still written — carry-forward and expiry depend on it. `granted` counts it, exactly as before. */
  | 'unconfigured_method'
  /** This pair already has an accrual row somewhere in this leave year — a re-run, not a duplicate.
   *  Counted in `skipped`. r193 re-keyed this from "a row dated exactly 1 January"; see
   *  `yearOpenMarkerCond`. */
  | 'already_open'
  /** ADR-0069: an active frozen encashment snapshot locks the balance. Counted in `skipped`. */
  | 'frozen'
  /** ADR-0040: an earned method accrues through the year via accrueEarnedLeave, not this lump grant. */
  | 'earned_method'
  /** The composition resolved 0 days or fewer, so nothing is owed and no row is written. */
  | 'no_entitlement'
  /** ADR-0077 slice 6: the company's country pack is not active, so nothing can be computed. */
  | 'pack_blocked';

/** One line of the per-employee generation log — the same row the preview shows and the CSV downloads. */
export type LeaveYearGrantRow = {
  employmentId: string;
  leaveTypeId: string;
  outcome: LeaveYearGrantOutcome;
  /** The accrual days posted (or that would be posted). 0 on every non-granting outcome. */
  days: number;
  /** Carry brought into the new year after the cap and the max-balance clamp. */
  carry: number;
  /** Prior-year balance above the carry allowance, forfeited at the boundary. */
  forfeit: number;
  /** fa3f4ccb: advisory only — the resolved figure is under the statutory minimum for the type. */
  belowStatutoryFloor: boolean;
};

export type OpenLeaveYearResult = {
  granted: number;
  skipped: number;
  forfeits: number;
  packBlocked: PackBlockedEmployment[];
  /** 93249794 — the per-pair log, accumulated in the SAME pass that writes. See LeaveYearGrantOutcome. */
  rows: LeaveYearGrantRow[];
};

/**
 * r193 — THE ONE DEFINITION OF "WHEN DOES THIS LEAVE YEAR START FOR THIS EMPLOYMENT AND THIS TYPE".
 *
 * Two faults in `openLeaveYear` have the same shape, so they get one answer rather than two:
 *
 *   FAULT 1  the entitlement table itself was not in force on 1 January — it was written in August.
 *   FAULT 2  the EMPLOYEE was not there on 1 January — they joined in March.
 *
 * In both cases 1 January is a date at which the grant has no meaning, and in both cases the honest start
 * is the LATER date: the year opens for this pair when BOTH the table and the person exist. Hence
 *
 *     effectiveGrantStart = max(yearStart, templateStart, hiredOn)
 *
 * and everything about the answer is then dated at that one instant — which template version is in force,
 * which eligibility rule is, which department the employee sat in, and how many completed years of service
 * they had. That is the same "one date for every part of the answer" discipline `buildTemplateEntitlementResolver`
 * already documents; r193 only moves the date off a constant.
 *
 * `templateStart` is null for a type with no entitlement table (the statutory standing types), which
 * simply drops out of the max — an employee hired before the year still starts at 1 January, exactly as
 * they always did. Pure, exported and unit-tested: the date arithmetic is the whole change, and a helper
 * nobody can call is a helper nobody can pin.
 */
export function effectiveGrantStart(
  yearStart: string,
  templateStart: string | null | undefined,
  hiredOn: string,
): string {
  let out = yearStart;
  if (templateStart != null && templateStart > out) out = templateStart;
  if (hiredOn > out) out = hiredOn;
  return out;
}

/**
 * r193 — THE YEAR-OPEN IDEMPOTENCY MARKER, AS ONE PREDICATE TWO ENGINES SHARE.
 *
 * ⚠️ THIS IS THE MOST DANGEROUS LINE IN THE WHOLE CHANGE, so it is stated once and imported, never
 * re-typed. Until r193 the marker was `entryType = 'accrual' AND effective_on = <year>-01-01`, which was
 * exact only because the grant was ALWAYS written on 1 January. `effectiveGrantStart` above moves that
 * date to the table's start or the employee's join date — and a marker still looking for a 1-January row
 * WOULD NOT MATCH THE ROW THE PREVIOUS RUN WROTE. Pressing Generate Entitlement twice would then grant the
 * same year twice, with no error and no way to tell from the screen which figure was right.
 *
 * So the key is now (employment, leave type, LEAVE YEAR): any accrual-class row dated inside the year.
 * That is strictly WIDER than the old key, which is the safe direction — the old 1-January rows on
 * production are inside the year and still match, so nothing already granted is re-granted.
 *
 * IT DELIBERATELY ALSO MATCHES THE HIRE GRANT (core/org.ts posts `accrual` at the join date). A March
 * joiner whose hire grant already ran must NOT be granted a second time by a year-open that now reaches
 * them — under the old key the hire row was invisible and fault 2's fix would have double-granted every
 * joiner the moment it shipped. Reading the hire grant AS the year-open marker for that employee's first
 * year is what makes fault 2 safe, and it is why this predicate does not filter on `reason`.
 *
 * TWO CONSUMERS, and they must agree: `openLeaveYear` (do not grant twice) and `expireCarriedLeave` (only
 * sweep a year that was actually opened — see its own note). If they disagree, carried leave silently
 * stops expiring in exactly the tenants this change unblocks.
 */
function yearOpenMarkerCond(yearStart: string, yearEnd: string) {
  return and(
    eq(leaveLedger.entryType, 'accrual'),
    gte(leaveLedger.effectiveOn, yearStart),
    lte(leaveLedger.effectiveOn, yearEnd),
  );
}

/**
 * Post a leave year's entitlement for every eligible employment: grant, cap the carry-forward and forfeit
 * the excess. Idempotent on its own `openedSet`, which is read from the LEDGER rather than from any
 * configuration table — so a second run grants nothing twice.
 *
 * 93249794 ADDED THREE OPTIONAL PARAMETERS AND NO NEW ARITHMETIC. They are the same three the Run Earned
 * Accrual button's scope+preview (2c7c6385) added to `accrueEarnedLeave`, in the same shape and for the
 * same reason — a preview that does not share the commit's pass is a preview that can lie:
 *
 *   • `leaveTypeIds`   — narrow WHICH types this run grants. Applied AFTER the "which types this sweep
 *                        grants" set is computed, so it can only ever narrow that set, never widen it.
 *   • `employmentIds`  — narrow WHO it reaches. Resolved by the CALLER through
 *                        `resolveOrgCriteriaTargets` (core/org-criteria.ts) — this function deliberately
 *                        knows nothing about criteria, because "who does this apply to" already has one
 *                        answer in this codebase and a second one here would be the duplicate-maintenance
 *                        defect item 6e9a126e exists to remove.
 *   • `dryRun`         — compute everything, write NOTHING (no ledger rows, no event). The returned
 *                        counters and `rows` are exactly what a real run would produce.
 *
 * ABSENT ⇒ NO RESTRICTION ON THAT AXIS, so the bare `openLeaveYear(s, { year })` call is byte-identical to
 * what it was before this item.
 */
export async function openLeaveYear(
  ctx: SessionContext,
  p: { year: number; leaveTypeIds?: string[]; employmentIds?: string[]; dryRun?: boolean },
): Promise<OpenLeaveYearResult> {
  const scopeTypeIds = (p.leaveTypeIds ?? []).filter(Boolean);
  const scopeEmpIds = (p.employmentIds ?? []).filter(Boolean);
  const dryRun = p.dryRun === true;
  return withTenant(ctx, async (tx): Promise<OpenLeaveYearResult> => {
    const yearStart = `${p.year}-01-01`;
    // r193 — the leave year is a WINDOW now, not the instant at its left edge. See `effectiveGrantStart`.
    const yearEnd = `${p.year}-12-31`;

    // WHICH TYPES THIS SWEEP GRANTS — items 783bf55a and baea8e5b.
    //
    // This used to be `code IN STANDING_LEAVE_CODES` and nothing else, so ANNUAL, SICK and
    // HOSPITALIZATION were the only leave types a year-open could ever grant. Any other type was
    // never visited, which meant an administrator could configure a Service-Based Entitlement or a
    // grade policy on (say) Caregiver Leave, watch it save successfully, and never see a day of it
    // reach an employee. Worse, once someone took that leave the ledger had no grant to draw down,
    // so the balance went BELOW zero — the negative Medical / Hospitalisation / Special figures
    // reported on My Leave.
    //
    // The allowlist itself was not wrong, only the question it asked. ADR-0066 keeps FESTIVE and
    // one-off grant types out of the accrual / carry-cap / forfeit engines on purpose (see
    // grantAdHocLeave's header), and that must not change. But "is this code one of three hardcoded
    // strings" is not the same question as "did an administrator configure entitlement days for
    // this type", and it is the second one that decides whether a year-open owes the employee days.
    //
    // So the set is now: the statutory standing types, PLUS any non-archived type that carries a
    // real configuration — since 6e9a126e release three, an entitlement_template version in force at the
    // year boundary, and nothing else. A festive type has none, so it is still untouched here and still
    // escapes carry-cap and forfeit exactly as ADR-0066 intends.
    //
    // Nothing downstream needed widening to match: the statutory floor returns 0 for an unrecognised
    // code (localization/my/leave.ts entitlement default), the carry cap is already ANNUAL-only so a
    // newly-granted custom type resets each year rather than accruing a carry it has no rule for,
    // and earned-method types still divert to accrueEarnedLeave. A type configured at 0 days is
    // skipped by the existing `days <= 0` guard, so this widens what CAN be granted without granting
    // anything that was not configured.
    const allTypes = await tx
      // 9816a5ad step 2: the type's own rules ride along with the type row that is already being read —
      // no extra round-trip, and the rules are in scope wherever `t` is.
      // r193: `yearCycleOverride` rides along too — the sweep now reaches employments hired during the
      // year and `hireYearGrantDays` needs it to spot an a2c ANNUAL type. It is deliberately NOT added to
      // `leaveTypeRuleColumns`: that map is the ENGINE RULES contract and the cycle override is not one.
      .select({
        id: leaveType.id,
        code: leaveType.code,
        yearCycleOverride: leaveType.yearCycleOverride,
        ...leaveTypeRuleColumns,
      })
      .from(leaveType)
      .where(isNull(leaveType.archivedAt));
    // 6e9a126e — THE ONLY LIMB LEFT. "Did an administrator configure entitlement days for this type" had
    // three true answers (an active grade policy at the year boundary, a benefit-scheme entitlement, or an
    // entitlement_template version in force); release three removed the first two with the tables behind
    // them. Without this limb, a type configured through the new layer is never visited by a year-open —
    // HR writes a table, watches it save, and never sees a day of it reach an employee, which is verbatim
    // the defect 783bf55a / baea8e5b were raised for.
    //
    // ⚠️ r193 FAULT 1 — THIS LINE WAS `leaveTypeIdsWithTemplatesAt(tx, yearStart)`. It asked "which tables
    // were in force ON 1 JANUARY", so a tenant who built their entitlement tables in August had none of
    // them counted and every type configured ONLY that way was never visited by a year-open. On the
    // reporting account that is the eight custom leave types (Compassionate, Marriage, Study, Examination,
    // …), each with tables dated 2026-08-01 and each granted nothing all year. The question is a WINDOW:
    // which types have a table in force at any point in this leave year, and from when. See
    // `templateStartsWithinWindow`.
    //
    // BE PRECISE ABOUT WHAT THIS DID *NOT* CAUSE, because the round's plan overstated it and a wrong story
    // here invites the wrong fix next time. The union with `standing` below means ANNUAL, SICK and
    // HOSPITALIZATION are ALWAYS in `types` whatever this reader returns — they were visited every run.
    // They granted nothing for their own reasons: ANNUAL is an earned method (accrueEarnedLeave's
    // business, not this sweep's), and SICK and HOSPITALIZATION were stopped by the eligibility
    // short-circuit fault 3 fixes. "The type list filtered to nothing" was never true.
    const templateStarts = await templateStartsWithinWindow(tx, {
      windowStart: yearStart,
      windowEnd: yearEnd,
    });
    // Filtered in memory rather than as a SQL subquery: leave_type is a small per-tenant table, and
    // an empty configured set is a normal state that several drizzle `inArray` forms handle badly.
    const configuredIds = new Set(templateStarts.keys());
    const standing = new Set<string>([...STANDING_LEAVE_CODES]);
    // 93249794 — the Leave Type scope is applied HERE, on top of the set above, and never in place of it.
    // A type the sweep would not have granted anyway does not become grantable by being picked on a form;
    // the wizard can only ever ask for LESS than the unscoped run. Empty ⇒ every type this sweep grants.
    const types = allTypes.filter(
      (t) =>
        (standing.has(t.code) || configuredIds.has(t.id)) &&
        (scopeTypeIds.length === 0 || scopeTypeIds.includes(t.id)),
    );
    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        // r193: a first-year LEAVER's up-front a2c figure is capped at their last day of service
        // (adcdf215). The sweep never saw a first-year employment before, so it never needed this.
        terminatedOn: employment.terminatedOn,
        country: company.country,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          // ⚠️ r193 FAULT 2 — THIS WAS `lt(employment.hiredOn, yearStart)`, STRICTLY BEFORE THE YEAR.
          // On the reporting account 18 of 40 active employments joined during 2026 and were skipped
          // before any entitlement question was asked — verbatim the reporter's "people who joined this
          // year get nothing". A mid-year joiner is a member of this leave year; `effectiveGrantStart`
          // below starts their grant at their JOIN DATE rather than pretending they were here in January,
          // and `yearOpenMarkerCond` reads their hire grant as this year's marker so the two engines
          // cannot both pay them. Anyone hired after the year ends is still not in it.
          lte(employment.hiredOn, yearEnd),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
          // 93249794 — the employee scope, already resolved by the caller through
          // resolveOrgCriteriaTargets. A RESTRICTION, never a widening: an employment that is not active
          // at the year boundary is still excluded by the two conditions above, whatever the form asked
          // for. Empty ⇒ every eligible employment (the pre-existing unscoped sweep).
          scopeEmpIds.length ? inArray(employment.id, scopeEmpIds) : undefined,
        ),
      );
    const rows: LeaveYearGrantRow[] = [];
    if (types.length === 0 || emps.length === 0) {
      return { granted: 0, skipped: 0, forfeits: 0, packBlocked: [], rows };
    }
    const empIds = emps.map((e) => e.employmentId);
    const typeIds = types.map((t) => t.id);

    // ⚠️ r193 — THE IDEMPOTENCY KEY. It used to be `effectiveOn = yearStart`; it is now the whole leave
    // year, because the grant is no longer always written on 1 January. Read `yearOpenMarkerCond`'s header
    // before touching this: a marker that misses the row the last run wrote double-grants entitlement.
    const already = await tx
      .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, typeIds),
          yearOpenMarkerCond(yearStart, yearEnd),
        ),
      );
    const openedSet = new Set(already.map((r) => `${r.employmentId}|${r.leaveTypeId}`));

    // ADR-0069: skip any (employment, leave type) with an ACTIVE frozen encashment snapshot — the balance
    // is locked, so this sweep must not touch it. The DB trigger would reject the write anyway; skipping
    // here avoids aborting the whole batch on one frozen employee.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, typeIds);

    // 6e9a126e — the entitlement TEMPLATE layer. ONE date dates every part of the answer at the same
    // instant: which template version was in force, which eligibility rule was in force, and which
    // department / position / employment type the employee held THEN. Release three removed the two reads
    // that used to sit here (the grade `leave_policy` rows and the benefit-scheme resolver), so this is
    // the only entitlement read the sweep makes.
    //
    // ⚠️ r193 — THAT DATE IS NO LONGER A CONSTANT. It was `yearStart`, and both faults this round fixes
    // are consequences of that: a table written in August is not in force on 1 January, and a March joiner
    // does not exist on 1 January — `resolveOrgCriteriaTargets` excludes anyone with `hired_on > asOf`, so
    // resolving a joiner at 1 January matches them against no eligibility rule at all and hands them a
    // template band of null however well configured they are. The date is now `effectiveGrantStart` for
    // the pair, and the resolvers are MEMOISED BY DATE so the batching this function depends on survives.
    //
    // HOW MANY RESOLVERS THAT IS, stated honestly because the batched resolver's own header warns against
    // per-employee resolution: one per DISTINCT effective start. In a calendar year that is one per
    // distinct table start date (a handful — the production account has three across eleven leave types)
    // plus one per employee hired AFTER a table start (joiners before it share the table's date). Each is
    // built with only the employments that need it, so the per-rule membership queries narrow with it.
    const resolverByDate = new Map<string, Awaited<ReturnType<typeof buildTemplateEntitlementResolver>>>();
    const templatesAt = async (asOf: string, forEmploymentIds: string[]) => {
      const hit = resolverByDate.get(asOf);
      if (hit) return hit;
      const built = await buildTemplateEntitlementResolver(tx, {
        employmentIds: forEmploymentIds,
        leaveTypeIds: typeIds,
        asOf,
      });
      resolverByDate.set(asOf, built);
      return built;
    };
    // Bucketed up front so each resolver is built ONCE with every employment that shares its date, rather
    // than once per employment as the loop happens to reach them. `effectiveGrantStart` is pure, so this
    // pass and the loop below cannot disagree about which date a pair belongs to.
    const empIdsByDate = new Map<string, Set<string>>();
    for (const e of emps) {
      for (const t of types) {
        const d = effectiveGrantStart(yearStart, templateStarts.get(t.id), e.hiredOn);
        const set = empIdsByDate.get(d);
        if (set) set.add(e.employmentId);
        else empIdsByDate.set(d, new Set([e.employmentId]));
      }
    }

    const balances = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
      })
      .from(leaveLedger)
      .where(and(inArray(leaveLedger.employmentId, empIds), inArray(leaveLedger.leaveTypeId, typeIds)))
      .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
    const balanceBy = new Map(balances.map((b) => [`${b.employmentId}|${b.leaveTypeId}`, Number(b.balance)]));

    let granted = 0;
    let skipped = 0;
    let forfeits = 0;
    const packBlocked: PackBlockedEmployment[] = [];
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) {
        packBlocked.push({ employmentId: e.employmentId, country: e.country ?? null, reason: 'country_pack_inactive' });
        // 93249794: log it PER TYPE as well, so the preview's per-employee error table can name what the
        // employee is missing for each leave type they were selected for. `packBlocked` above is unchanged
        // — this is an additional record of the same skip, not a second decision about it.
        for (const t of types) rows.push(logRow(e.employmentId, t.id, 'pack_blocked'));
        continue;
      }
      for (const t of types) {
        const key = `${e.employmentId}|${t.id}`;
        // r193 — WHEN THIS LEAVE YEAR STARTS FOR THIS PAIR: the later of 1 January, the date this type's
        // entitlement table starts applying, and the employee's join date. Everything below is dated at
        // THAT instant — the template version, the eligibility rule, the employee's department, their
        // completed years of service, and the ledger rows themselves. `years` used to be hoisted out of
        // this loop against `yearStart`; it cannot be, now that the date varies per type.
        const effectiveOn = effectiveGrantStart(yearStart, templateStarts.get(t.id), e.hiredOn);
        const years = serviceYearsAt(e.hiredOn, effectiveOn);
        if (openedSet.has(key)) {
          skipped += 1;
          rows.push(logRow(e.employmentId, t.id, 'already_open'));
          continue;
        }
        if (frozenSet.has(key)) {
          skipped += 1; // ADR-0069: leave balance frozen for encashment
          rows.push(logRow(e.employmentId, t.id, 'frozen'));
          continue;
        }
        // Leave Entitlement Rules Engine: `years` (service at year-open) drives band upgrades here, same
        // as the statutory floor's own 2y/5y band upgrades.
        // 9816a5ad step 2: the winning entitlement template's band decides the DAYS; the LEAVE TYPE decides
        // every rule (earning method / carry forward / rounding / maximum balance).
        // ONE shared composition (composeEntitlement) so this can never drift from the recalc kernel.
        // fa3f4ccb: the statutory floor is passed for the below-minimum SIGNAL only — it no longer clamps.
        const templates = await templatesAt(effectiveOn, [...(empIdsByDate.get(effectiveOn) ?? [])]);
        const { days: fullYearDays, belowStatutoryFloor, policy: pol } = composeEntitlement({
          floorDays: pack.leave.entitlement(t.code, years),
          templateBand: templates.bandFor(e.employmentId, t.id, years),
          rules: t,
        });
        // r193 FAULT 2 — an employment hired DURING this leave year gets the SAME first-year shape the
        // hire grant gives (ANNUAL pro-rated by whole months remaining, a2c ANNUAL its full part-year up
        // front, s.60F types in full). One function, shared — see `hireYearGrantDays`. Anyone hired before
        // the year is untouched by this branch and takes the full-year figure exactly as they always did.
        const days =
          e.hiredOn >= yearStart
            ? hireYearGrantDays({
                days: fullYearDays,
                typeCode: t.code,
                yearCycleOverride: t.yearCycleOverride,
                hiredOn: e.hiredOn,
                serviceEnd: e.terminatedOn,
              })
            : fullYearDays;
        // 2D (ADR-0040): earned types accrue through the year via accrueEarnedLeave, not this lump grant.
        if (isEarnedMethod(pol?.method)) {
          rows.push(logRow(e.employmentId, t.id, 'earned_method'));
          continue;
        }
        if (days <= 0) {
          rows.push(logRow(e.employmentId, t.id, 'no_entitlement'));
          continue;
        }
        const before = balanceBy.get(key) ?? 0;
        // Carry forward, for EVERY leave type (7cd914b1). This used to read
        // `t.code === 'ANNUAL' && carryEnabled(pol)`, which meant a non-annual type could not carry
        // anything no matter how it was configured — and the editor reinforced that by posting a hidden
        // carryForwardMax=0 for those types. The code gate is gone; CONFIGURATION now decides.
        //
        // NOTHING CHANGES FOR ANYONE UNTIL A SETTING CHANGES. Every non-annual type carries
        // carryForwardEnabled=false / NULL and carryForwardMax 0 today, so carryEnabled() is false and the
        // allowance is 0 — a full forfeit, byte-identical to the old branch. SICK and HOSPITALIZATION
        // included: their statutory annual reset (EA s.60F) is now expressed as their configuration rather
        // than as a hardcoded exception, which is the fa3f4ccb rev 5 precedent — the configured figure
        // wins and the statutory position is a warning, not a silent override.
        //
        // resolveCarryAllowance is the SINGLE definition of how much carries, shared with the projection
        // kernel. It handles the percentage mode and clamps it with carryForwardMax as a ceiling.
        const rawCarry = resolveCarryAllowance(pol, before);
        // Feedback b81d3c52 — Rounding Method: tidy the CALCULATED entitlement to a whole day BEFORE the
        // max-balance clamp, at the identical point every other engine rounds (hire grant / earned accrual
        // / the recalc kernel's projection) so the ledger and the kernel can never disagree. The carry-in
        // (`rawCarry`) is deliberately NOT rounded — a fractional carry-over plus a whole-day grant still
        // yields a fractional balance; rounding shapes the ENTITLEMENT, not every balance.
        const grantRoundedRaw = applyRounding(days, pol?.roundingMethod, pol?.roundingThreshold, pol?.roundingBands);
        // bc36c768 — THE NOT-CONFIGURED GATE HERE IS A ZEROED GRANT, NOT A `continue`, and the distinction
        // is the whole reason this gate reads differently from the other four.
        //
        // A `continue` at the `isEarnedMethod` line above would skip TWO more things below it:
        //   (a) the carry-forward cap forfeit — the NEGATIVE row that removes prior-year balance above the
        //       carry allowance. Skipping it leaves excess balance sitting untouched forever.
        //   (b) the grant row itself, which is ALWAYS written even at 0 days because it is openLeaveYear's
        //       own idempotency open-marker (openedSet) AND the expiry sweep's "year was opened" marker.
        //       expireCarriedLeave short-circuits on the missing marker (`openMarker.n === 0 ⇒ continue`),
        //       so carried leave for this type would never expire that year either.
        //
        // So the type is resolved exactly as it always was and only the GRANT is forced to zero, here,
        // BEFORE applyMaxBalance. The forfeit computation and the always-written 0-day marker row survive
        // intact, which is what keeps carry-forward and expiry working through an unconfigured year.
        //
        // ONE DISCLOSED CONSEQUENCE, pinned by a test: with the grant at 0 the max-balance clamp has more
        // headroom, so `carry` can come out HIGHER — and the forfeit correspondingly SMALLER — than a
        // configured year would produce. That is real and small and upward, and it is the price of keeping
        // carry and expiry running at all. The alternative (switching the carry rules off for the year)
        // would leave excess balances untouched and carried leave never expiring, which is worse.
        const grantRounded = isAccrualUnconfigured(t) ? 0 : grantRoundedRaw;
        // Feedback 9d8cf621 — Maximum Balance Days: clamp the carry-in AND this year's grant so the
        // resulting balance (carry + grant) never exceeds the resolved band's cap. Reducing the carry
        // increases the forfeit below by construction (forfeit = before − carry). No cap ⇒ pass-through.
        const { carry, grant: grantDays } = applyMaxBalance(rawCarry, grantRounded, pol?.maxBalanceDays);
        const forfeit = Math.max(0, before - carry);
        if (forfeit > 0) {
          // 93249794 dryRun: compute the identical forfeit and write NOTHING. The counter still moves, so
          // the preview reports the same `forfeits` the commit will — preview-must-not-lie (2c7c6385).
          if (!dryRun) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: e.employmentId,
              leaveTypeId: t.id,
              entryType: 'adjustment',
              days: (-forfeit).toFixed(2),
              // r193: the cap forfeit is dated with the grant it pairs with, never separately. Dating the
              // forfeit at 1 January while the grant lands in August would leave the employee stripped of
              // their carry for seven months before the replacement days arrived.
              effectiveOn,
              reason: CARRY_FORFEIT_REASON_CAP,
            });
          }
          forfeits += 1;
        }
        // Feedback 9d8cf621: post the (possibly Maximum-Balance-clamped) grant. The row is ALWAYS written —
        // even at 0 days when the cap is already reached — because it is openLeaveYear's own idempotency
        // open-marker (openedSet) and the expiry sweep's "year was opened" marker.
        if (!dryRun) {
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'accrual',
            // ⚠️ r193: `effectiveOn`, not `yearStart` — the date this pair's leave year actually starts.
            // This row is also the idempotency marker AND the expiry sweep's "year was opened" marker,
            // which is why BOTH of those now match on the year rather than on 1 January
            // (`yearOpenMarkerCond`). Moving this line without moving those double-grants entitlement.
            days: grantDays.toFixed(2),
            effectiveOn,
          });
        }
        granted += 1;
        rows.push({
          employmentId: e.employmentId,
          leaveTypeId: t.id,
          // The bc36c768 marker is reported as its OWN outcome rather than as "granted 0 days", because
          // "HR has not chosen an earning method" and "the configuration says zero" are different facts
          // and only the first is something HR can go and fix. The behaviour is identical either way —
          // the row is written and `granted` counts it, exactly as before this item.
          outcome: isAccrualUnconfigured(t) ? 'unconfigured_method' : 'granted',
          days: grantDays,
          carry,
          forfeit,
          belowStatutoryFloor,
        });
      }
    }

    // One summary event; the ledger rows are the per-item audit (high-volume per-item
    // writes with their own append-only table — deliberate substrate skip).
    //
    // 93249794 dryRun: a PREVIEW MUST LEAVE NO TRACE, so the event is skipped entirely — the same rule
    // accrueEarnedLeave's preview follows. The Generate Entitlement screen appends its OWN
    // `leave-generation.run` event on the commit path (core/leave-generation.ts), carrying the scope this
    // event has no field for.
    if (!dryRun) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-year',
        aggregateId: ctx.tenantId,
        eventType: 'leave-year.opened',
        actor: actorOf(ctx),
        payload: { year: p.year, granted, skipped, forfeits },
      });
    }
    return { granted, skipped, forfeits, packBlocked, rows };
  });
}

/** A non-granting log line — every one of these outcomes moves no days, so the four numbers are fixed. */
function logRow(employmentId: string, leaveTypeId: string, outcome: LeaveYearGrantOutcome): LeaveYearGrantRow {
  return { employmentId, leaveTypeId, outcome, days: 0, carry: 0, forfeit: 0, belowStatutoryFloor: false };
}

// ── Earned accrual (ADR-0040 / 2D-1) ──────────────────────────────────────────────────────────────
/** Lump-sum policies (the default) grant at hire + year-open; these earn through the year instead.
 *
 *  bc36c768 added 'earned_daily' and KEPT 'earned_quarterly'. The reporter's list is three choices — None,
 *  Monthly Accrual, Daily Accrual — and quarterly is gone from the dropdown; but a value the open contract
 *  still permits (db/schema.ts leave_type.accrual_method carries no DB CHECK) must keep computing what it
 *  always computed. Retiring a CHOICE and re-interpreting every value already stored under it are two
 *  different changes and only the first was asked for. Deleting the recognition here would collapse a
 *  stored 'earned_quarterly' onto the LUMP path, i.e. hand its holders a full year up front — the exact
 *  silent-downgrade class eee43966 already cost this codebase once. */
export const EARNED_METHODS = ['earned_monthly', 'earned_quarterly', 'earned_daily'] as const;
export function isEarnedMethod(m: unknown): m is (typeof EARNED_METHODS)[number] {
  return m === 'earned_monthly' || m === 'earned_quarterly' || m === 'earned_daily';
}

/**
 * r299 (3de1453a) — WHICH LEAVE TYPES THE EARNED ACCRUAL CONCEPT APPLIES TO, AS ONE PREDICATE.
 *
 * THE REPORTER'S RULE, verbatim: "Only Annual Leave (*Annual Leave) is subject to the Earned Accrual
 * concept. All other leave types are managed based on entitlement and should not be included in the
 * Earned Accrual process."
 *
 * It REPLACES `STANDING_LEAVE_CODES` wherever the earned sweep, or a screen describing that sweep, decides
 * coverage — and it was wrong twice over. The constant let SICK and HOSPITALIZATION be earned (the
 * reporter's rule forbids it), and it asked the CODE, so a tenant's own Annual Leave on a code the pack
 * never seeded (production's `AL` "*Annual Leave") could never accrue a day. `leave_type.role` (65f466e2)
 * is the tenant-independent answer to "what IS this type", and `leaveTypeIs` asks it first, falling back to
 * the seeded code `ANNUAL` only for a row nobody has classified — which keeps every unclassified tenant's
 * Annual Leave accruing exactly as before.
 *
 * ⚠️ `STANDING_LEAVE_CODES` ITSELF IS DELIBERATELY UNTOUCHED. `openLeaveYear` still enters its three codes
 * whatever the configuration says, and the carry-expiry sweep, `isA2cFirstYear`, `hireYearGrantDays` and
 * the pack's statutory floor still key on the code `ANNUAL`. Those decide HOW MANY days people receive;
 * moving them to the role moves day counts and is a separate, recorded change (see the r299 round entry).
 *
 * Pure and DB-free, but it lives in this module because `leaveTypeIs` does; screens receive its RESULT as
 * a boolean decided on the server, never the function (a client island cannot import this file).
 */
export function isEarnedAccrualType(lt: { role?: string | null; code?: string | null } | null | undefined): boolean {
  return leaveTypeIs(lt, 'annual');
}

/**
 * r299 (3de1453a) — where the "This is our Annual Leave" switch stands for one row, for the leave type editor.
 * `on` — recorded as Annual Leave by role (switchable off) · `off` — unclassified, not Annual Leave
 * (switchable on) · `by_code` — unclassified, Annual Leave by its seeded code (no role to clear, locked) ·
 * `other_role` — recorded as a different kind of leave (locked). It agrees with `isEarnedAccrualType` by
 * construction: `on` and `by_code` are exactly the rows that predicate accepts. `core/admin.ts`'s
 * `resolveAnnualLeaveSwitch` refuses the same transitions this marks as locked.
 */
export type AnnualLeaveSwitchState = 'on' | 'off' | 'by_code' | 'other_role';
export function annualLeaveSwitchState(lt: { role?: string | null; code?: string | null }): AnnualLeaveSwitchState {
  const role = lt.role ?? '';
  if (role === 'annual') return 'on';
  if (role !== '') return 'other_role';
  return isEarnedAccrualType(lt) ? 'by_code' : 'off';
}

/**
 * bc36c768 — THE NOT-CONFIGURED GATE, as one predicate every granting and projecting path asks.
 *
 * A leave type carrying `accrual_unconfigured` grants nothing and earns nothing until HR saves an earning
 * method. It is ONE function rather than five inline `!= null` tests because the five call sites must
 * agree exactly: a path that forgets the gate resolves the cleared type as LUMP and hands out a full
 * year's entitlement that nothing in this system can take back.
 *
 * Deliberately a null test on the marker alone — NOT "the method is absent". Those are different states
 * and only this one is safe: an absent method has always meant the lump path, and every leave type in
 * production read that way for years.
 */
export function isAccrualUnconfigured(rules: { accrualUnconfigured?: Date | string | null } | null | undefined): boolean {
  return rules?.accrualUnconfigured != null;
}
/** Accrual periods from `start` through `asOf`, inclusive of the current period (month or quarter). */
function accrualPeriods(start: string, asOf: string, method: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ay, am] = asOf.split('-').map(Number);
  if (method === 'earned_quarterly') {
    return Math.max(0, (ay - sy) * 4 + (Math.floor((am - 1) / 3) - Math.floor((sm - 1) / 3)) + 1);
  }
  return Math.max(0, (ay - sy) * 12 + (am - sm) + 1);
}

/** ADR-0040 2D-2: the start of an employee's current earned-accrual cycle as of `asOf`.
 *  calendar → 1 Jan of asOf's year. anniversary → the most-recent hire-month anniversary on/before
 *  asOf (so each employee's cycle is anchored to their hire month; a joiner's first cycle starts at
 *  hire). Returns ISO yyyy-mm-01. */
export function earnedCycleStart(hiredOn: string, asOf: string, cycle: string | null | undefined): string {
  if (cycle !== 'anniversary') return `${asOf.slice(0, 4)}-01-01`;
  const hireMonth = hiredOn.slice(5, 7);
  const [ay, am] = asOf.split('-').map(Number);
  const cycleYear = am >= Number(hireMonth) ? ay : ay - 1;
  return `${cycleYear}-${hireMonth}-01`;
}

/**
 * c8052ae3 — THE LAST DAY OF THE CYCLE THAT OPENS AT `cycleStart`, inclusive.
 *
 * ⚠️ THIS EXISTS BECAUSE A CYCLE HAD A START AND NO END, AND THAT COST A CUSTOMER 147 LEDGER ROWS.
 * Every "how much has this cycle already granted" sum in this file filtered ledger rows on
 * `effectiveOn >= cycleStart` with NO UPPER BOUND. A tenant that had opened the 2027 and 2028 leave
 * years ahead therefore had those years' 1-January grants counted as "already granted THIS cycle": the
 * profile recalc read 180.00 posted against a single-year expectation of 60.00 and clawed back −120.00,
 * driving Hospitalization Leave to −60.00 on an ordinary profile save. The recalc audit says so in its
 * own words (previous 180.00 → new 60.00).
 *
 * Calendar cycle (`YYYY-01-01`) ⇒ `YYYY-12-31`. Anniversary cycle (`YYYY-MM-01`) ⇒ the day before the
 * next anniversary. Pure UTC calendar arithmetic on a date-only string — it derives nothing from an
 * instant, so no tenant-timezone question arises (the DATES rule is about `new Date()`, not about
 * adding a year to a stored ISO date).
 *
 * INCLUSIVE, because ledger comparisons here are `<=`: a 31-December accrual belongs to its own year.
 */
export function leaveCycleEnd(cycleStart: string): string {
  const [y, m, d] = cycleStart.split('-').map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`, INCLUSIVE of both ends. UTC arithmetic on date-only strings, so no
 *  timezone or DST offset can shorten a day. Negative windows clamp to 0 at the call sites that care. */
function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

/** The ACTUAL length of the leave-year window that opens at `cycleStart` — 365, or 366 across a leap day.
 *  The reporter's "Days in Leave Year": a 20-day entitlement divides by 365 in an ordinary year and by 366
 *  in a leap one, so the daily slice is right in both.
 *
 *  Deliberately NOT the hardcoded /365 of `a2cFirstYearEntitledToDate`. That divisor is fixed on purpose —
 *  it pins the 19.73 reference figure of a DIFFERENT model (an up-front part-year grant whose value does
 *  not move with asOf). Only the arithmetic SHAPE is similar; reusing it here would be wrong in a leap
 *  year and would couple two settings that have no reason to move together. */
function leaveYearLength(cycleStart: string): number {
  const [y, m, d] = cycleStart.split('-').map(Number);
  return Math.round((Date.UTC(y + 1, m - 1, d) - Date.UTC(y, m - 1, d)) / 86400000);
}

/**
 * bc36c768 — THE CONFIGURED CREDIT DAY, CLAMPED TO A DAY THAT EXISTS IN `asOf`'s MONTH.
 *
 * The reporter asked for any day from 1 to 31, and named the awkward case themselves: day 31 must credit
 * on 28 February in an ordinary year and on 29 February in a leap one. A month that never reaches the
 * configured day would be SKIPPED ENTIRELY, and a skipped month is a permanent hole in a cumulative
 * to-date model — the accrual engine only ever tops UP (`toGrant > 0`), so nothing later fills it in.
 *
 * Absent ⇒ 1, which makes every comparison below vacuously true and the whole gate byte-identical to the
 * behaviour every existing configuration has today.
 */
export function effectiveAccrualDay(asOf: string, accrualDay?: number | null): number {
  const wanted = accrualDay == null ? 1 : Math.min(31, Math.max(1, Math.trunc(accrualDay)));
  const [y, m] = asOf.split('-').map(Number);
  // Day 0 of the NEXT month is the last day of this one — leap-correct without a leap-year branch.
  const lastDayOfMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(wanted, lastDayOfMonth);
}

/**
 * bc36c768 — THE ONE EARNED-TO-DATE KERNEL. Returns the RAW cumulative an employee has earned in the
 * current cycle as of `asOf`, BEFORE rounding and before any max-balance room cap.
 *
 * ⚠️ WHY THIS FUNCTION EXISTS AT ALL, and it is the single most important change in the item.
 * `accrueEarnedLeave` (the engine that credits) and `projectExpectedEntitlement` (the kernel that
 * reprojects) carried TWO INDEPENDENT COPIES of this arithmetic — `const totalPeriods = method ===
 * 'earned_quarterly' ? 4 : 12` and then `(days / totalPeriods) * elapsed`, written out twice. Adding the
 * earned_daily branch or the accrual-day gate to only one of them would make the recalc kernel project
 * the monthly figure while the accrual engine credits the daily one, and the file's own comment beside
 * the projection names the consequence verbatim: "a permanent oscillating delta" posted on every profile
 * edit, forever, in both directions. Both call sites now call THIS, and there is no second copy to drift.
 *
 * THE THREE BRANCHES:
 *
 *  - earned_monthly — 1/12 per whole month elapsed, inclusive of the current month, EXCEPT that the
 *    current month counts only once its configured credit day has been reached (see effectiveAccrualDay).
 *    An absent accrualDay makes that gate vacuous, so an unconfigured day is byte-identical to today.
 *
 *  - earned_quarterly — untouched, and kept for the reason `isEarnedMethod` still recognises it.
 *
 *  - earned_daily — `min((annualDays / leaveYearDays) * daysElapsedInclusive, annualDays)`, where
 *    leaveYearDays is the ACTUAL length of the resolved cycle (365 or 366). The reporter's worked example
 *    holds exactly: 20 / 365 × 182 = 9.97.
 *
 * ⚠️ THE JOINER GUARD, and why earned_daily does NOT anchor on cycleStart. The monthly engine anchors a
 * calendar-cycle mid-year joiner at their HIRE MONTH START, never at the cycle start. Carrying that
 * "cycleStart → asOf" window into a DAILY model would let an employee hired 2026-06-15 accrue from
 * 2026-01-01 — roughly five and a half months of leave they never worked — and because the engine only
 * ever posts a POSITIVE top-up (`toGrant > 0`) it could never claw a penny of it back. So for
 * earned_daily the anchor is the HIRE DATE ITSELF, not the hire month start. earned_monthly keeps its
 * existing month-start rule exactly as it was.
 *
 * (An ANNIVERSARY-cycle employee still anchors at cycleStart on BOTH branches, because their cycle start
 * IS their hire-month anniversary. For a mid-month joiner that grants them the part-month before their
 * hire date, which is the behaviour monthly accrual has always had; matching it was chosen over silently
 * giving anniversary employees a different first cycle than the one they have today.)
 */
export function earnedToDateFor(p: {
  /** The RESOLVED accrual method. Anything not in EARNED_METHODS yields 0 — this kernel is only ever
   *  reached behind an `isEarnedMethod` guard, and returning 0 for a lump method is the honest answer
   *  rather than a silent 1/12. */
  method: string | null | undefined;
  /** bc36c768 — the configured credit day, 1..31. null/absent ⇒ 1 (today's behaviour). Monthly only. */
  accrualDay?: number | null;
  /** The FULLY RESOLVED annual entitlement (statutory floor ∨ benefit-scheme band ∨ policy days). */
  annualDays: number;
  /** The current cycle's window start (earnedCycleStart over the EFFECTIVE per-type cycle). */
  cycleStart: string;
  /** The employee's hire date — the joiner anchor on both branches. */
  hiredOn: string;
  /** The EFFECTIVE cycle for this (type, company) pair: 'anniversary' or anything else (⇒ calendar). */
  leaveCycle: string | null | undefined;
  asOf: string;
}): number {
  const { method, annualDays, cycleStart, hiredOn, leaveCycle, asOf } = p;
  if (!isEarnedMethod(method)) return 0;
  if (!(annualDays > 0)) return 0;

  if (method === 'earned_daily') {
    const accrualStart = leaveCycle === 'anniversary' || hiredOn <= cycleStart ? cycleStart : hiredOn;
    const leaveYearDays = leaveYearLength(cycleStart);
    const elapsed = Math.max(0, daysInclusive(accrualStart, asOf));
    return round2(Math.min((annualDays / leaveYearDays) * elapsed, annualDays));
  }

  const totalPeriods = method === 'earned_quarterly' ? 4 : 12;
  const accrualStart =
    leaveCycle === 'anniversary' || hiredOn <= cycleStart ? cycleStart : `${hiredOn.slice(0, 7)}-01`;
  let periods = accrualPeriods(accrualStart, asOf, method);
  // The accrual-day gate, monthly only. The CURRENT period counts only once its credit day has arrived;
  // before that, this month's slice has not been earned. Applied to the RAW period count and clamped
  // afterwards, so a configured day still withholds December's slice at the very end of a full cycle.
  if (method === 'earned_monthly' && Number(asOf.slice(8, 10)) < effectiveAccrualDay(asOf, p.accrualDay)) {
    periods -= 1;
  }
  const elapsed = Math.max(0, Math.min(totalPeriods, periods));
  return round2((annualDays / totalPeriods) * elapsed);
}

/** Leave Year Type override (feedback e1a51aea, extended by f3a64d90 → adcdf215): the LIVE per-type override
 *  values. 'a2a' and 'c2c' reuse the existing anniversary/calendar semantics; 'a2c' (Anniversary to Calendar)
 *  went live with f3a64d90 — its leave YEAR is the calendar year (see resolveLeaveYearCycle), and the ONLY
 *  novel behaviour is the HIRE-year ANNUAL up-front part-year entitlement (a2cFirstYearEntitledToDate).
 *  Migration 0310 widened the DB CHECK to match this set (defence-in-depth). */
export const LEAVE_YEAR_CYCLE_OVERRIDES = ['a2a', 'c2c', 'a2c'] as const;
export type LeaveYearCycleOverride = (typeof LEAVE_YEAR_CYCLE_OVERRIDES)[number];

/** Anniversary to Calendar (feedback f3a64d90): the raw stored override string. Deliberately NOT a third
 *  cycle token — a2c's leave YEAR is calendar (Jan-1 boundary, calendar carry/forfeit anchoring, full
 *  calendar grant from year two). Only the first-year ANNUAL proration rides this raw value. */
export const A2C_OVERRIDE = 'a2c';

/**
 * Leave Year Type override (feedback e1a51aea): resolve the EFFECTIVE cycle for one (leave type, company)
 * pair. A per-type override wins where set — 'a2a' maps to the existing 'anniversary' semantics, 'c2c' to
 * 'calendar' — and null/undefined (every pre-existing type) falls back to the company cycle exactly as
 * today, so behaviour is byte-identical until HR makes an explicit per-type choice. Every engine consumer
 * of company.leave_cycle in a per-type computation resolves through this ONE function (accrueEarnedLeave,
 * the two recalc kernels' callers, leaveEntitlementBreakdown) so the override cannot half-apply.
 *
 * Anniversary to Calendar (f3a64d90 → adcdf215) maps to 'calendar' — NOT a new third cycle. Its year runs
 * 1 Jan → 31 Dec like any calendar type; only the employee's FIRST (hire) year is prorated (join → 31 Dec)
 * and granted UP FRONT from the join date. Mapping it here keeps earnedCycleStart, the carry/forfeit
 * anchoring, openLeaveYear's year-two grant and every resolve call-site byte-identical, and gets
 * year-two-onward behaviour for free.
 */
export function resolveLeaveYearCycle(
  override: string | null | undefined,
  companyCycle: string | null | undefined,
): string | null | undefined {
  if (override === 'a2a') return 'anniversary';
  if (override === 'c2c' || override === A2C_OVERRIDE) return 'calendar';
  return companyCycle;
}

/**
 * Anniversary to Calendar — the ONE shared first-year kernel (feedback f3a64d90 → adcdf215). An employee
 * hired part-way through a year gets their full prorated part-year ANNUAL entitlement UP FRONT, available
 * from their join date, across their first, partial leave year (join date → 31 Dec of the hire year):
 *
 *     (annual entitlement ÷ 365) × days from join to 31 Dec     — the reporter's stated formula
 *
 * UP-FRONT (adcdf215): the value is INDEPENDENT of `asOf` for an active employee — the window end is
 * 31 Dec of the HIRE year, so a 2026-01-06 joiner sees 20/365 × 360 = 19.73 days immediately at hire,
 * not a sliver that builds day by day. `daysWorked` is INCLUSIVE of both endpoints (daysBetween is
 * exclusive-end, hence the +1). Year two onward is a plain calendar grant (see resolveLeaveYearCycle).
 *
 * `asOf` is STILL load-bearing, not vestigial: a pre-hire `asOf` floors the figure at 0 (the explicit
 * guard below — previously this floor was implemented THROUGH the window end, which the up-front switch
 * removed), and the upstream isA2cFirstYear check gates entry to this kernel by the hire-year window.
 *
 * LEAVER CAP (adcdf215): for a first-year employee who has LEFT, pass `serviceEnd` (their termination
 * date). The window end is then the EARLIER of 31 Dec and `serviceEnd`, so the figure prorates only to
 * their last working day and never inflates encashment / final pay with days they never served. When
 * `serviceEnd` is absent (a fresh, active hire) the end is 31 Dec — the full up-front figure.
 *
 * The min() CLAMP is mandatory, not cosmetic: a 366-day first year (a 1-Jan hire in a leap year) would
 * otherwise yield 20/365 × 366 = 20.05 — overshooting the annual entitlement. The /365 divisor stays per
 * the reporter's spec (it pins the 19.73 reference; a 6-Jan c2c/calendar joiner month-prorates to 20.00
 * instead — the divergence is intentional), and the clamp guarantees the cap holds.
 *
 * `entitledDays` MUST be the FULLY RESOLVED entitlement (EA-1955 floor ∨ benefit-scheme band ∨ policy days
 * — i.e. the shared `entitledDays()` composition), never a raw policy number, so this path respects the
 * statutory floor and auto-linked scheme bands exactly like every other granting pathway. ONE helper is
 * consumed by the hire grant, the projection kernel and the a2c correction, so preview == commit.
 */
export function a2cFirstYearEntitledToDate(
  hiredOn: string,
  asOf: string,
  entitledDays: number,
  serviceEnd?: string | null,
): number {
  if (entitledDays <= 0) return 0;
  // Pre-hire floor (adcdf215): the up-front figure is only available from the join date onward. This is an
  // EXPLICIT guard now — the old build-up floored pre-hire implicitly, via a window end that tracked asOf
  // (asOf < dec31 ? asOf : dec31) so a pre-hire asOf produced daysWorked ≤ 0. The up-front window end no
  // longer tracks asOf, so the floor must be stated here.
  if (asOf < hiredOn) return 0;
  const dec31 = `${hiredOn.slice(0, 4)}-12-31`;
  // Active first-year employee ⇒ full part-year (join → 31 Dec) up front. A first-year LEAVER is capped at
  // their last day of service so the figure never over-grants days they never served.
  const end = serviceEnd != null && serviceEnd < dec31 ? serviceEnd : dec31;
  const daysWorked = daysBetween(hiredOn, end) + 1; // inclusive of both endpoints
  if (daysWorked <= 0) return 0;
  return round2(Math.min((entitledDays / 365) * daysWorked, entitledDays));
}

/** Anniversary to Calendar (f3a64d90): is this (type, employee, asOf) inside the ONE window where a2c
 *  behaves differently from a plain calendar type — the employee's HIRE year, on ANNUAL only?
 *
 *  The ANNUAL-only guard is statutory, not stylistic: SICK and HOSPITALIZATION (STANDING_LEAVE_CODES) are
 *  per-calendar-year entitlements under EA-1955 s.60F and must be granted IN FULL to a mid-year joiner —
 *  they are never day-sliced, even when a2c is configured on them. From the next 1 Jan the employee is on
 *  the ordinary calendar year (full grant at year-open), so the window is bounded to the hire year. */
export function isA2cFirstYear(
  override: string | null | undefined,
  typeCode: string,
  hiredOn: string,
  asOf: string,
): boolean {
  return (
    override === A2C_OVERRIDE &&
    typeCode === 'ANNUAL' &&
    hiredOn <= asOf &&
    hiredOn.slice(0, 4) === asOf.slice(0, 4)
  );
}

/**
 * r193 — HOW A GRANT IS SHAPED IN THE EMPLOYEE'S HIRE YEAR, as ONE function two engines share.
 *
 * ⚠️ THIS EXISTS BECAUSE FAULT 2'S FIX WOULD OTHERWISE BREAK THE ONE-COMPOSITION INVARIANT. `openLeaveYear`
 * now reaches employments hired DURING the leave year (previously it could only ever see people hired
 * before it, so it never needed a first-year rule). The hire grant has always shaped a joiner's first year
 * — ANNUAL pro-rated by whole months remaining under s.60E practice, an a2c ANNUAL type granted its full
 * part-year up front, SICK / HOSPITALIZATION granted IN FULL because s.60F is a per-calendar-year
 * entitlement that is never day-sliced. Had the year-open handed a March joiner a full twelve months while
 * the hire grant and `projectExpectedEntitlement` both say ten, the very next profile save would post a
 * compensating adjustment clawing the difference back, and the employee would watch their balance drop for
 * no reason they could see. That is exactly the drift core/leave-generation.ts's header calls "the single
 * worst outcome available here".
 *
 * So the shaping was LIFTED out of `hireEmployee` verbatim and is called from both. Everything about it —
 * the months-remaining formula, the ANNUAL-only guard, the a2c branch — is unchanged; it simply has one
 * home now instead of one home and a copy waiting to be written.
 *
 * ANCHORED ON `hiredOn`, NEVER ON THE GRANT DATE. An employee hired in February whose entitlement table
 * only starts in August is granted ON 1 August but still shaped as an eleven-month first year, because
 * that is what the hire grant would have given them and what the recalc kernel projects for them. The
 * table's start date decides WHEN the days are posted; the join date decides HOW MANY.
 *
 * `serviceEnd` caps a first-year LEAVER's a2c figure at their last day of service (adcdf215). The hire
 * grant passes nothing (a fresh hire has not left); the year-open passes `terminatedOn`.
 */
export function hireYearGrantDays(p: {
  days: number;
  typeCode: string;
  yearCycleOverride: string | null | undefined;
  hiredOn: string;
  serviceEnd?: string | null;
}): number {
  if (isA2cFirstYear(p.yearCycleOverride, p.typeCode, p.hiredOn, p.hiredOn)) {
    return a2cFirstYearEntitledToDate(p.hiredOn, p.hiredOn, p.days, p.serviceEnd ?? null);
  }
  // s.60E practice: whole months remaining in the hire year, INCLUDING the month of hire.
  if (p.typeCode === 'ANNUAL') {
    const month = Number(p.hiredOn.slice(5, 7));
    return Math.round(((p.days * (12 - (month - 1))) / 12) * 100) / 100;
  }
  // SICK / HOSPITALIZATION and every custom type: full grant. s.60F is per calendar year.
  return p.days;
}

/** Anniversary to Calendar (f3a64d90): reason PREFIX stamped on the ledger rows reprojectA2cEntitlement
 *  posts. Two classes ride it — an ACCRUAL-class top-up/claw-down (so "YTD Entitled", which counts only
 *  entryType in ('accrual','in_lieu_accrual'), actually moves) and a compensating ADJUSTMENT that reverses
 *  the superseded system rows so Balance/Available net to the same figure. Both are read back on the next
 *  run, which is exactly what makes the correction idempotent. */
export const A2C_RECALC_REASON_PREFIX = 'sys:a2c_recalc';

// ── Grade-based policy resolution (ADR-0041 / 2E) — extracted to ./leave-compute (RSC-safe pure module,
// see its header) and re-exported below via the `export {` block near the top of this file's imports so
// every existing caller/test keeps importing GradePolicyRow / resolveGradePolicy / carryEnabled / etc. from
// '@/core/leave' unchanged. Leave Entitlement Rules Engine (feedback a0228655) added serviceBands +
// bandDaysFor + previewEntitlement there and made resolveGradePolicy's serviceYears param required.

// ── Run Earned Accrual — scope + preview (feedback 2c7c6385) ────────────────────────────────────────
/** One grouped row of the "Run Earned Accrual" preview/summary table — Company × Grade × Leave Type.
 *  `entitlementGenerated` is the Σ of the actual per-employee top-ups (`toGrant`) for the group, so the
 *  preview (dryRun) and the real commit produce IDENTICAL numbers (they share one computation pass). */
export type EarnedAccrualGroup = {
  companyId: string;
  companyName: string;
  gradeId: string | null;
  gradeName: string | null;
  leaveTypeId: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  /** Distinct active employees in this Company×Grade whose resolved policy for the type is earned. */
  employeeCount: number;
  /** The accrual leave year (asOf's year) — the "Accrual Period" column. */
  accrualPeriod: number;
  /** 'earned_monthly' | 'earned_quarterly' — the resolved accrual method for the group. */
  method: string;
  /** Σ of per-employee `toGrant` (days) for the group. */
  entitlementGenerated: number;
};
/**
 * feedback cf9dcb98 (r285) — WHY THE PREVIEW CAME BACK WITH NOTHING, NAMED.
 *
 * ⚠️ THE MESSAGE IT REPLACES WAS TRUE AND USELESS. "No earned-accrual entitlement to generate for this
 * scope" is what HR saw after picking `AL` "*Annual Leave" on production; it cost them a day, because the
 * sentence is compatible with a broken engine, a mis-set date, a half-built configuration and an archived
 * leave type, and says which of the four it is for none of them. Every variant below NAMES the thing —
 * the type, the date, the country, the grade — for the same reason `lib/leave-config-health.ts` findings
 * do: a count tells an administrator that something is wrong, a name tells them where to go.
 *
 * ⚠️ IT IS COMPUTED HERE, IN THE ENGINE, AT THE EXIT IT EXPLAINS — never re-derived by a screen. Each
 * variant is emitted at the `return` whose condition produced it, out of the values that condition was
 * decided on, so a filter cannot be changed without the sentence that explains it moving too. A second
 * derivation in the page would be free to drift from the engine and would eventually describe a run the
 * engine did not do.
 *
 * ⚠️ AND IT NEVER MOVES A FIGURE. Every variant is reached only on a path that already returned an empty
 * breakdown; the counters feeding them are accumulators beside the engine's own branches. `granted`,
 * `forfeits` and every `entitlementGenerated` are byte-identical to what this engine produced before.
 *
 * In the order the engine decides them:
 *  • `type_not_swept`          the chosen type is NOT ANNUAL LEAVE (`isEarnedAccrualType` — role first,
 *                              code `ANNUAL` for an unclassified row). r299 (3de1453a): the earned sweep
 *                              covers Annual Leave and nothing else, whatever another type's accrual
 *                              method says; every other leave type is entitlement-based. It used to mean
 *                              "not one of STANDING_LEAVE_CODES", which let SICK / HOSPITALIZATION accrue
 *                              and declined the reporter's own `AL` "*Annual Leave". `sweptLeaveTypeNames`
 *                              is now the tenant's ACTIVE Annual Leave type name(s).
 *  • `type_archived`           the chosen type is archived (reachable only from a stale screen — the
 *                              picker does not offer archived types, and deliberately must not).
 *  • `table_not_yet_in_force`  the type's entitlement table starts AFTER the as-at date. Names the date.
 *  • `no_entitlement_table`    the type has no entitlement table in force at the as-at date at all.
 *  • `type_not_earned`         the type grants its days rather than earning them (or its accrual method
 *                              has never been set), so an accrual run has nothing to post for it.
 *  • `no_employment_in_scope`  nobody in the chosen companies/grades was on the books at the as-at date.
 *  • `no_eligibility_match`    r209's second zero: tables exist for the type and NO eligibility rule points
 *                              any of these employees at one. A half-built configuration, not an empty one.
 *  • `country_pack_inactive`   every employment in scope sits in a country with no active localization pack.
 *  • `balance_frozen`          every (employee, type) pair is frozen for encashment (ADR-0069).
 */
export type EarnedAccrualEmptyReason =
  | { kind: 'type_not_swept'; leaveTypeNames: string[]; sweptLeaveTypeNames: string[] }
  | { kind: 'type_archived'; leaveTypeNames: string[] }
  | { kind: 'table_not_yet_in_force'; leaveTypeName: string; validFrom: string; asOf: string }
  | { kind: 'no_entitlement_table'; leaveTypeNames: string[]; asOf: string }
  | { kind: 'type_not_earned'; leaveTypeNames: string[] }
  | { kind: 'no_employment_in_scope'; asOf: string; scopeNames: string[] }
  | { kind: 'no_eligibility_match'; leaveTypeNames: string[] }
  | { kind: 'country_pack_inactive'; countries: string[] }
  | { kind: 'balance_frozen'; leaveTypeNames: string[] };

/**
 * An archived leave type the empty preview owes the reader a word about (feedback cf9dcb98, reason (d)).
 *
 * ⚠️ THIS IS THE CASE THAT COST A DAY. Archiving hides a leave type from every picker in the product,
 * including this one — correctly, because running an accrual into a type no other screen shows would be
 * worse — so an archived type is indistinguishable from a missing feature. Two shapes are reported:
 * an archived type whose NAME collides with one the scope asked for ("Annual Leave" vs "*Annual Leave"),
 * and an archived STANDING type with an earned method, which is a type this sweep would have covered had
 * it been active. Both are facts about the tenant, not guesses about intent: the sentence says the type is
 * archived and where to unarchive it, and proposes nothing about the data sitting under it.
 */
export type ArchivedLeaveTypeHint = { id: string; code: string; name: string };

export type EarnedAccrualResult = {
  granted: number;
  forfeits: number;
  breakdown: EarnedAccrualGroup[];
  /** Employments this sweep could not compute, and why — never a silent skip (slice 6). */
  packBlocked: PackBlockedEmployment[];
  /** feedback cf9dcb98 — the named reason, present ONLY when `breakdown` is empty. `null` when the engine
   *  cannot name one (e.g. the scope pointed at leave types that do not exist), and the screen then falls
   *  back to the flat sentence this type exists to replace. */
  emptyReason: EarnedAccrualEmptyReason | null;
  /** feedback cf9dcb98 — archived types worth naming beside an empty result. Computed ONLY on the empty
   *  path: it answers a question nobody asks about a preview that found something. */
  archivedHint: ArchivedLeaveTypeHint[];
  /** feedback cf9dcb98 — Σ of the accrual EARNED to `asOf` across the breakdown. `entitlementGenerated` is
   *  the OUTSTANDING REMAINDER of this figure, so `earnedToDateTotal > 0` with a zero total generated is
   *  the idempotency case (reason (c)): the accrual is already posted, and a re-run adds nothing. Without
   *  it a screen cannot tell that apart from "these employees have earned nothing yet". */
  earnedToDateTotal: number;
};

/**
 * feedback cf9dcb98 — "*Annual Leave" and "Annual Leave" are the same name to the person reading the
 * screen, and the whole point of the archived-twin hint is to connect the two. Case is folded and
 * punctuation, symbols and separators are dropped; letters and digits in ANY script survive, so a
 * Chinese or Tamil type name normalises to itself rather than to the empty string. An empty result never
 * matches anything — a type named only in punctuation must not collide with every other type.
 */
export function normaliseLeaveTypeName(name: string): string {
  return name.toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]+/gu, '');
}

/**
 * Leave Year → asOf mapping for the "Run Earned Accrual" scope selector (feedback 2c7c6385, product
 * decision 1). The engine derives the accrual cycle from `asOf.slice(0,4)`, so the chosen Leave Year must
 * map to an asOf INSIDE that year:
 *  • current year  → today (progressive, to-date accrual — identical to the bare button / monthly cron).
 *  • past year     → that year's 31-Dec (full historical cycle; idempotent, harmless if already run).
 *  • future year   → that year's 31-Dec (full-year projection — this is the "600 days = 50×12" case in the
 *                    spec: HR opens next year and generates its full entitlement ahead of time).
 * A naive min(today, {year}-12-31) would collapse a FUTURE year to today (→ the wrong year's cycle), so the
 * branch is by year comparison, not a numeric min. Exported for the scope test.
 */
export function asOfForLeaveYear(year: number, today: string): string {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  if (today < yearStart) return yearEnd; // future year → full-year projection
  if (today > yearEnd) return yearEnd; // past year → full cycle
  return today; // current year → to-date
}

/** ADR-0040: top every earned policy up to the amount accrued by `asOf`. Idempotent — only the
 *  shortfall is written — so it is safe to run repeatedly (admin button + monthly cron, 2D-2).
 *  The cycle is per company (`leave_cycle`): calendar (1 Jan, joiners pro-rate from their join month)
 *  or anniversary (each employee's cycle anchored to their hire-month anniversary). Leave Year Type
 *  override (e1a51aea): a per-TYPE `year_cycle_override` ('a2a'/'c2c') wins over the company cycle for
 *  that type (resolveLeaveYearCycle); null keeps the company cycle. The full-cycle
 *  total equals max(EA-floor, policy days), so the statutory floor still holds.
 *
 *  Feedback 2c7c6385 (Run Earned Accrual button): the manual admin trigger now carries an optional SCOPE
 *  ({companyIds, gradeIds, leaveTypeIds}) and a `dryRun` flag, and returns a GROUPED breakdown accumulated
 *  in the SAME pass as the commit. When `dryRun` is set NOTHING is written (no ledger inserts, no event) —
 *  the returned breakdown/counters are exactly what a real run would produce, so the HR preview can never
 *  lie. Absent scope filters ⇒ "all" on that axis (byte-identical to the cron's unscoped run). */
export async function accrueEarnedLeave(
  ctx: SessionContext,
  p: {
    asOf: string;
    companyIds?: string[];
    gradeIds?: string[];
    leaveTypeIds?: string[];
    dryRun?: boolean;
  },
): Promise<EarnedAccrualResult> {
  const scopeCompanyIds = (p.companyIds ?? []).filter(Boolean);
  const scopeGradeIds = (p.gradeIds ?? []).filter(Boolean);
  const scopeTypeIds = (p.leaveTypeIds ?? []).filter(Boolean);
  const dryRun = p.dryRun === true;
  const accrualPeriod = Number(p.asOf.slice(0, 4));
  return withTenant(ctx, async (tx): Promise<EarnedAccrualResult> => {
    const yearStart = `${p.asOf.slice(0, 4)}-01-01`;

    // ── feedback cf9dcb98 — the empty-preview explanation. Everything below this comment runs ONLY where
    //    the engine is already returning nothing, and reads only what that exit decided on.
    //
    // ⚠️ THE ARCHIVED HINT IS TWO FACTS, NOT A GUESS. (1) an archived type whose NAME collides with one the
    // scope asked for — "Annual Leave" against the "*Annual Leave" HR could pick — and (2) an archived
    // ANNUAL LEAVE type carrying an earned method, which is a type this sweep would have covered were it not
    // archived. On the reporting account both point at the same row, which is the point: an archived leave
    // type is invisible on every screen in the product, so an empty result has to say the word out loud.
    // r299 (3de1453a): (2) asks `isEarnedAccrualType`, the same predicate as the filter below. `role` is
    // selected for exactly that reason — without it every row reads as unclassified and falls back to code.
    const archivedHintFor = async (scopedNames: string[]): Promise<ArchivedLeaveTypeHint[]> => {
      const archived = await tx
        .select({
          id: leaveType.id,
          code: leaveType.code,
          role: leaveType.role,
          name: leaveType.name,
          accrualMethod: leaveType.accrualMethod,
        })
        .from(leaveType)
        .where(sql`${leaveType.archivedAt} is not null`);
      const wanted = new Set(scopedNames.map(normaliseLeaveTypeName).filter(Boolean));
      return archived
        .filter(
          (a) =>
            wanted.has(normaliseLeaveTypeName(a.name)) ||
            (isEarnedAccrualType(a) && isEarnedMethod(a.accrualMethod)),
        )
        .map((a) => ({ id: a.id, code: a.code, name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    };
    /** Every empty return goes through here, so a new exit cannot ship without deciding what it says. */
    const emptyResult = async (
      emptyReason: EarnedAccrualEmptyReason | null,
      scopedNames: string[],
    ): Promise<EarnedAccrualResult> => ({
      granted: 0,
      forfeits: 0,
      breakdown: [],
      packBlocked: [],
      emptyReason,
      archivedHint: await archivedHintFor(scopedNames),
      earnedToDateTotal: 0,
    });

    // r299 (3de1453a) — WHICH TYPES THIS SWEEP TOUCHES AT ALL: ANNUAL LEAVE, AND NOTHING ELSE.
    //
    // This was `code IN STANDING_LEAVE_CODES`, in SQL. It is now `isEarnedAccrualType` over the active (and
    // scoped) rows, in memory, for one reason: the predicate is ONE function shared with every screen that
    // describes this sweep, and a second spelling of it in SQL is the drift r288 and r293 each paid for.
    // `leave_type` is a small per-tenant table, so reading its active rows costs nothing measurable.
    //
    // `role` MUST ride in the select. Without it every row is unclassified to `leaveTypeIs`, the predicate
    // silently falls back to the code, and the reporter's `AL` "*Annual Leave" — switched on by role — is
    // declined exactly as before. Nothing would fail; the sweep would just stay wrong.
    const activeTypes = await tx
      // Leave Year Type override (e1a51aea): yearCycleOverride is selected so the per-type effective cycle
      // can be resolved below (resolveLeaveYearCycle) — null on every pre-existing row ⇒ company cycle.
      // 9816a5ad step 2: the type's own rules ride along (see leaveTypeRuleColumns).
      .select({ id: leaveType.id, code: leaveType.code, role: leaveType.role, name: leaveType.name, yearCycleOverride: leaveType.yearCycleOverride, ...leaveTypeRuleColumns })
      .from(leaveType)
      .where(
        and(
          isNull(leaveType.archivedAt),
          // Leave-Type scope filter (feedback 2c7c6385). Empty ⇒ every active type, narrowed below.
          scopeTypeIds.length ? inArray(leaveType.id, scopeTypeIds) : undefined,
        ),
      );
    const types = activeTypes.filter((t) => isEarnedAccrualType(t));
    const typeIds = types.map((t) => t.id);
    if (typeIds.length === 0) {
      // feedback cf9dcb98 — EXIT 1, AND THE ONE THE REPORTER HIT. Nothing the scope asked for survived the
      // `isEarnedAccrualType AND archived_at IS NULL` filter above, so this run was over before it read an
      // employment. Re-ask for the SAME rows without that filter — the only way to name what was declined —
      // and say which half of the filter declined it. Unscoped, "the same rows" are the Annual Leave types,
      // archived ones included, which is what lets an archived Annual Leave be named.
      const declined = (
        await tx
          .select({
            id: leaveType.id,
            code: leaveType.code,
            role: leaveType.role,
            name: leaveType.name,
            archivedAt: leaveType.archivedAt,
          })
          .from(leaveType)
          .where(scopeTypeIds.length ? inArray(leaveType.id, scopeTypeIds) : undefined)
      ).filter((d) => scopeTypeIds.length > 0 || isEarnedAccrualType(d));
      const scopedNames = declined.map((d) => d.name);
      const notSwept = declined.filter((d) => !d.archivedAt && !isEarnedAccrualType(d));
      const archivedPick = declined.filter((d) => d.archivedAt);
      if (notSwept.length) {
        // ⚠️ NAME WHAT *IS* SWEPT TOO. "Medical Leave is not accrued here" leaves the reader asking what is;
        // "Earned Accrual applies only to Annual Leave (*Annual Leave)" is the sentence that ends the search.
        // Read from the tenant's own rows, never hardcoded — Annual Leave carries whatever name the tenant
        // gave it. Same predicate, same active-only filter as the sweep itself.
        const swept = (
          await tx
            .select({ name: leaveType.name, code: leaveType.code, role: leaveType.role })
            .from(leaveType)
            .where(isNull(leaveType.archivedAt))
        ).filter((s) => isEarnedAccrualType(s));
        return emptyResult(
          {
            kind: 'type_not_swept',
            leaveTypeNames: notSwept.map((d) => d.name).sort((a, b) => a.localeCompare(b)),
            sweptLeaveTypeNames: swept.map((s) => s.name).sort((a, b) => a.localeCompare(b)),
          },
          scopedNames,
        );
      }
      if (archivedPick.length) {
        return emptyResult(
          { kind: 'type_archived', leaveTypeNames: archivedPick.map((d) => d.name).sort((a, b) => a.localeCompare(b)) },
          scopedNames,
        );
      }
      // Nothing to name — a scope pointing at ids this tenant does not have. The flat sentence is the
      // honest answer here, and it is why `emptyReason` is nullable rather than exhaustive.
      return emptyResult(null, scopedNames);
    }

    // WHICH TYPES DOES THIS SWEEP TOUCH — configuration first, then earning method.
    //
    // 6e9a126e release three replaced the configuration half. It used to be "the type has an ACTIVE
    // leave_policy row at `asOf`", and the earning method was read from that row for a type step 1
    // (9816a5ad) had never backfilled. Neither survives: there are no policy rows, so a type's earning
    // method now comes from the LEAVE TYPE and from nowhere else, and "is anything configured" is answered
    // by an entitlement_template version in force at `asOf`.
    //
    // The membership test is deliberately KEPT — a type with nothing configured has no days to accrue and
    // was never swept here. It also decides which ledger rows are read back as "already accrued", so
    // widening it would have this sweep reasoning about a type it must not touch.
    const templateConfigured = await leaveTypeIdsWithTemplatesAt(tx, p.asOf);
    const earnedTypeIds = types
      .filter((t) => {
        if (!templateConfigured.has(t.id)) return false;
        // bc36c768 — THE NOT-CONFIGURED GATE, ahead of method resolution. An unconfigured type is not an
        // earned type and is not a lump type; it is a type that grants nothing until HR configures it.
        if (isAccrualUnconfigured(t)) return false;
        return isEarnedMethod(t.accrualMethod);
      })
      .map((t) => t.id);
    if (earnedTypeIds.length === 0) {
      // feedback cf9dcb98 — EXIT 2, partitioned by the SAME three conditions the filter above applies, in
      // the same order, so the sentence and the gate can never disagree about which one bit.
      const scopedNames = types.map((t) => t.name);
      const noTable = types.filter((t) => !templateConfigured.has(t.id));
      const notEarned = types.filter(
        (t) => templateConfigured.has(t.id) && (isAccrualUnconfigured(t) || !isEarnedMethod(t.accrualMethod)),
      );
      if (noTable.length) {
        // ⚠️ THE DATE IS THE ANSWER, WHEN THERE IS ONE. A table written on 14 September is not in force on
        // an as-at date in a past leave year, and "no entitlement table" would send HR to build a second
        // one on top of the table they already wrote. Ask for the earliest version that starts AFTER the
        // as-at date and name that day instead; only where there is no such version is the table genuinely
        // absent. Half-open [validFrom, validTo) throughout, as everywhere else in the template layer.
        const upcoming = await tx
          .select({ leaveTypeId: entitlementTemplate.leaveTypeId, validFrom: entitlementTemplate.validFrom })
          .from(entitlementTemplate)
          .where(
            and(
              inArray(entitlementTemplate.leaveTypeId, noTable.map((t) => t.id)),
              gt(entitlementTemplate.validFrom, p.asOf),
            ),
          )
          .orderBy(asc(entitlementTemplate.validFrom), asc(entitlementTemplate.leaveTypeId));
        const first = upcoming[0];
        if (first) {
          return emptyResult(
            {
              kind: 'table_not_yet_in_force',
              leaveTypeName: types.find((t) => t.id === first.leaveTypeId)!.name,
              validFrom: first.validFrom,
              asOf: p.asOf,
            },
            scopedNames,
          );
        }
        return emptyResult(
          {
            kind: 'no_entitlement_table',
            leaveTypeNames: noTable.map((t) => t.name).sort((a, b) => a.localeCompare(b)),
            asOf: p.asOf,
          },
          scopedNames,
        );
      }
      return emptyResult(
        notEarned.length
          ? { kind: 'type_not_earned', leaveTypeNames: notEarned.map((t) => t.name).sort((a, b) => a.localeCompare(b)) }
          : null,
        scopedNames,
      );
    }
    /** The scoped types by their own names — the archived-twin hint's left-hand side at every later exit. */
    const scopedTypeNames = types.map((t) => t.name);

    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        country: company.country,
        leaveCycle: company.leaveCycle,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        companyName: company.legalName,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(
        and(
          lte(employment.hiredOn, p.asOf),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
          // Scope filters (feedback 2c7c6385). Empty axis ⇒ all (matches countEmployeesInScope).
          scopeCompanyIds.length ? inArray(employment.companyId, scopeCompanyIds) : undefined,
          scopeGradeIds.length ? inArray(employment.gradeId, scopeGradeIds) : undefined,
        ),
      );
    if (emps.length === 0) {
      // feedback cf9dcb98 — EXIT 3. The configuration is fine and the POPULATION is empty: nobody the
      // company/grade scope names was on the books at the as-at date. Name the companies and grades that
      // were asked for, because "this scope" is precisely the thing the old sentence would not say.
      const scopeNames: string[] = [];
      if (scopeCompanyIds.length) {
        const rows = await tx
          .select({ name: company.legalName })
          .from(company)
          .where(inArray(company.id, scopeCompanyIds));
        scopeNames.push(...rows.map((r) => r.name));
      }
      if (scopeGradeIds.length) {
        const rows = await tx
          .select({ name: jobGrade.name })
          .from(jobGrade)
          .where(inArray(jobGrade.id, scopeGradeIds));
        scopeNames.push(...rows.map((r) => r.name));
      }
      return emptyResult(
        { kind: 'no_employment_in_scope', asOf: p.asOf, scopeNames: scopeNames.sort((a, b) => a.localeCompare(b)) },
        scopedTypeNames,
      );
    }
    const empIds = emps.map((e) => e.employmentId);

    // 6e9a126e — the entitlement TEMPLATE layer for the earned types, resolved at the RUN date. `p.asOf`
    // dates the same question `templateConfigured` above asked, so both answer for the same moment. The
    // BAND is still picked per (employee, type) at that pair's own cycle-start service length, below —
    // dating the eligibility and dating the band are different questions and only the first one is `asOf`.
    const templates = await buildTemplateEntitlementResolver(tx, {
      employmentIds: empIds,
      leaveTypeIds: earnedTypeIds,
      asOf: p.asOf,
    });

    // Grade-name lookup for the grouped preview breakdown (feedback 2c7c6385). A null gradeId row is the
    // ungraded/company-default bucket — no jobGrade name.
    const gradeNameById = new Map<string, string>();
    const distinctGradeIds = [...new Set(emps.map((e) => e.gradeId).filter((g): g is string => !!g))];
    if (distinctGradeIds.length) {
      const gradeRows = await tx
        .select({ id: jobGrade.id, name: jobGrade.name })
        .from(jobGrade)
        .where(inArray(jobGrade.id, distinctGradeIds));
      for (const g of gradeRows) gradeNameById.set(g.id, g.name);
    }
    // Grouped breakdown accumulator, keyed company|grade|type — filled in the SAME pass as the commit so
    // the dryRun preview and the real run are guaranteed to report identical numbers (preview-must-not-lie).
    const groupBy = new Map<
      string,
      { companyId: string; companyName: string; gradeId: string | null; leaveTypeId: string; method: string; count: number; entitlementGenerated: number }
    >();

    // 2D-2: the cycle start varies per employee (calendar = yearStart; anniversary = their hire-month
    // anniversary), so we can't sum "already accrued this cycle" in SQL with one bound. Fetch the
    // trailing ~12 months of accrual rows (covers any cycle start) and sum per employee in JS below.
    //
    // c8052ae3 — BOUNDED AT THE TOP TOO, the exact mirror of `accrualFrom`, for the same reason the
    // profile recalc now is (see `leaveCycleEnd`): the current cycle can end no later than one year
    // after asOf's month-start, so anything beyond `accrualTo` is a FUTURE leave year's grant and was
    // never this cycle's business. Here the defect is quiet rather than loud — `toGrant > 0` means a
    // future-dated grant could only ever SUPPRESS the monthly top-up, so an employee with next year's
    // entitlement already written would silently stop earning this year rather than go negative.
    const accrualFrom = `${Number(p.asOf.slice(0, 4)) - 1}-${p.asOf.slice(5, 7)}-01`;
    const accrualTo = `${Number(p.asOf.slice(0, 4)) + 1}-${p.asOf.slice(5, 7)}-01`;
    const accrualRows = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
      })
      .from(leaveLedger)
      .where(
        and(
          inArray(leaveLedger.employmentId, empIds),
          inArray(leaveLedger.leaveTypeId, earnedTypeIds),
          // Feedback 49809272 + R45 7527ea5f: the `already` sum must ALSO see the compensating
          // `sys:policy_recalc:*` / `sys:profile_recalc:*` adjustments a policy correction or a profile-change
          // recalc posts mid-cycle (reprojectEntitlementForPolicy / reprojectEntitlementForEmployment) —
          // otherwise this top-up would re-grant the same delta on top of the recalc credit. No pre-existing
          // row carries either reason, so behaviour is byte-identical for tenants that never recalc'd.
          or(
            eq(leaveLedger.entryType, 'accrual'),
            and(
              eq(leaveLedger.entryType, 'adjustment'),
              recalcAdjustmentReasonCond(),
            ),
          ),
          gte(leaveLedger.effectiveOn, accrualFrom),
          lte(leaveLedger.effectiveOn, accrualTo),
        ),
      );
    const accrualRowsBy = new Map<string, { days: number; effectiveOn: string }[]>();
    for (const r of accrualRows) {
      const k = `${r.employmentId}|${r.leaveTypeId}`;
      const row = { days: Number(r.days), effectiveOn: r.effectiveOn };
      const arr = accrualRowsBy.get(k);
      if (arr) arr.push(row);
      else accrualRowsBy.set(k, [row]);
    }

    // 2D-3 (ADR-0040): cap carried-forward earned leave at the cycle boundary. openLeaveYear skips earned
    // types, so this is where their carry-forward cap lands. Group employees by their cycle start (≤12
    // distinct month-starts for anniversary, 1 for calendar) so the prior-cycle balance + the "already
    // forfeited this cycle" guard stay bounded queries, not one-per-employee.
    // Leave Year Type override (e1a51aea): the cycle start is now per (employee, TYPE) — a type-level
    // 'a2a'/'c2c' override wins over the company cycle (resolveLeaveYearCycle). An employee therefore
    // joins the group of EVERY distinct cycle start their earned types resolve to (at most two: the
    // calendar year-open + their hire-month anniversary), and the prior-balance / boundary-forfeit maps
    // are keyed cs|emp|type so two windows for the same (emp, type-set) can never clobber each other.
    // Types without an override keep resolving to the company cycle — byte-identical grouping to before.
    const earnedTypes = types.filter((t) => earnedTypeIds.includes(t.id));
    const cycleFor = (typeId: string, companyCycle: string | null) =>
      resolveLeaveYearCycle(earnedTypes.find((t) => t.id === typeId)?.yearCycleOverride, companyCycle);
    const byCycleStart = new Map<string, string[]>();
    for (const e of emps) {
      const csSet = new Set(
        earnedTypes.map((t) => earnedCycleStart(e.hiredOn, p.asOf, resolveLeaveYearCycle(t.yearCycleOverride, e.leaveCycle))),
      );
      for (const cs of csSet) {
        const arr = byCycleStart.get(cs);
        if (arr) arr.push(e.employmentId);
        else byCycleStart.set(cs, [e.employmentId]);
      }
    }
    const priorBalanceBy = new Map<string, number>(); // cs|emp|type -> balance carried into that cycle window
    const forfeited = new Set<string>(); // cs|emp|type that already has a boundary forfeit at that cycle start
    for (const [cs, ids] of byCycleStart) {
      const prior = await tx
        .select({
          employmentId: leaveLedger.employmentId,
          leaveTypeId: leaveLedger.leaveTypeId,
          sum: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            lt(leaveLedger.effectiveOn, cs),
          ),
        )
        .groupBy(leaveLedger.employmentId, leaveLedger.leaveTypeId);
      for (const r of prior) priorBalanceBy.set(`${cs}|${r.employmentId}|${r.leaveTypeId}`, Number(r.sum));
      // A boundary forfeit is an adjustment dated exactly at the cycle start; its presence means we've
      // already rolled this (emp, type) over (idempotency — also skips if a manual adjustment lands there).
      const adj = await tx
        .select({ employmentId: leaveLedger.employmentId, leaveTypeId: leaveLedger.leaveTypeId })
        .from(leaveLedger)
        .where(
          and(
            inArray(leaveLedger.employmentId, ids),
            inArray(leaveLedger.leaveTypeId, earnedTypeIds),
            eq(leaveLedger.entryType, 'adjustment'),
            eq(leaveLedger.effectiveOn, cs),
          ),
        );
      for (const r of adj) forfeited.add(`${cs}|${r.employmentId}|${r.leaveTypeId}`);
    }

    // ADR-0069: skip (employment, leave type) pairs with an ACTIVE frozen encashment snapshot.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, earnedTypeIds);

    let granted = 0;
    let forfeits = 0;
    const packBlocked: PackBlockedEmployment[] = [];
    // feedback cf9dcb98 — WHY EACH (employee, type) PAIR WAS PASSED OVER, tallied ON the engine's own
    // branches rather than re-derived after the fact. They are read only where the breakdown comes out
    // empty, and they are what separates "this configuration reaches nobody" from "every balance is
    // frozen for encashment" — two states the one flat sentence described identically.
    let skipNoEntitlement = 0;
    let skipFrozen = 0;
    let earnedToDateTotal = 0;
    for (const e of emps) {
      const pack = packFor(e.country);
      if (!pack) {
        packBlocked.push({ employmentId: e.employmentId, country: e.country ?? null, reason: 'country_pack_inactive' });
        continue;
      }
      for (const typeId of earnedTypeIds) {
        const type = types.find((t) => t.id === typeId);
        if (!type) continue;
        // bc36c768 — the NOT-CONFIGURED gate, FIRST, before any method resolution. `earnedTypeIds` above
        // already excludes such a type, so this is belt-and-braces; it is here anyway because the two
        // filters are reached by different call shapes and a scoped manual run must not be one refactor
        // away from crediting a type the reporter was told grants nothing.
        if (isAccrualUnconfigured(type)) continue;
        // 2D-2: the cycle start anchors both the entitlement band (service years measured at it) and the
        // accrual window. Calendar joiners still pro-rate from their join month; anniversary employees
        // accrue from their own cycle start (which, for a joiner, is their hire month).
        // Leave Year Type override (e1a51aea): the effective cycle is per (employee, type) — a type-level
        // 'a2a'/'c2c' override wins over the company cycle; null keeps the company cycle (byte-identical).
        const cyc = cycleFor(typeId, e.leaveCycle);
        const cycleStart = earnedCycleStart(e.hiredOn, p.asOf, cyc);
        const years = serviceYearsAt(e.hiredOn, cycleStart);
        // This employee may resolve NO entitlement template even when the type is configured for somebody
        // else — accrue only when THEIR resolution yields an earned policy. A null carrier makes
        // `pol?.method` undefined and the gate below skips them, which is the same shape the grade-policy
        // resolution had and is why the guard needs no separate `noOpinion` branch here: `accrueEarnedLeave`
        // only ever grants a POSITIVE shortfall, so an unconfigured employee accrues nothing rather than
        // being clawed back.
        // Leave Entitlement Rules Engine: service measured at cycleStart (same as the 2D-2 comment above).
        // 9816a5ad step 2: the template band decides the DAYS, the leave type decides every RULE — so the
        // earning METHOD is untouched by the entitlement layer and the `isEarnedMethod` gate below decides
        // on exactly what it decided on before.
        const composed = composeEntitlement({
          floorDays: pack.leave.entitlement(type.code, years),
          templateBand: templates.bandFor(e.employmentId, typeId, years),
          rules: type,
        });
        const pol = composed.policy;
        if (!isEarnedMethod(pol?.method)) {
          skipNoEntitlement += 1; // cf9dcb98: no entitlement table resolved for THIS employee (r209's 2nd zero)
          continue;
        }
        if (frozenSet.has(`${e.employmentId}|${typeId}`)) {
          skipFrozen += 1; // cf9dcb98 — ADR-0069, and it is not the same silence as the line above
          continue;
        } // ADR-0069: balance frozen for encashment
        // Grouped preview accumulator (feedback 2c7c6385): this (employee, type) resolves an earned policy,
        // so it belongs to the Company×Grade×Type group. Count it here (regardless of `toGrant`) — the
        // "Employee Count" column is the eligible population, not only those with a non-zero top-up.
        const groupKey = `${e.companyId}|${e.gradeId ?? ''}|${typeId}`;
        let group = groupBy.get(groupKey);
        if (!group) {
          group = {
            companyId: e.companyId,
            companyName: e.companyName,
            gradeId: e.gradeId ?? null,
            leaveTypeId: typeId,
            method: pol!.method!,
            count: 0,
            entitlementGenerated: 0,
          };
          groupBy.set(groupKey, group);
        }
        group.count += 1;
        // 2D-3: cap what carries into the new cycle. Posted once per cycle, dated at the cycle start
        // (guarded by `forfeited`). Leave Year Type override (e1a51aea): the maps are keyed cs|emp|type —
        // this (emp, type)'s window.
        //
        // 7cd914b1: this used to be `type.code === 'ANNUAL' ? pol!.carryMax : 0`, the same Annual-only gate
        // openLeaveYear carried. It now asks resolveCarryAllowance, the SAME function openLeaveYear asks —
        // an earned type and a lump-sum type must not disagree about how much carries, and two hand-written
        // copies of `min(balance, cap)` are exactly how they would come to.
        const carryKey = `${cycleStart}|${e.employmentId}|${typeId}`;
        const priorBalance = priorBalanceBy.get(carryKey) ?? 0;
        const baseCarry = resolveCarryAllowance(pol, priorBalance);
        // Feedback 9d8cf621 — Maximum Balance Days also bounds the earned carry: nothing more than the cap
        // can be retained into the new cycle. null ⇒ pass-through.
        const retainedCarry =
          pol!.maxBalanceDays != null ? Math.min(baseCarry, Math.max(0, pol!.maxBalanceDays)) : baseCarry;
        if (!forfeited.has(carryKey)) {
          const forfeit = Math.round((priorBalance - retainedCarry) * 100) / 100;
          if (forfeit > 0) {
            // dryRun (feedback 2c7c6385): compute the same forfeit but write NOTHING — preview == commit.
            if (!dryRun) {
              await tx.insert(leaveLedger).values({
                tenantId: ctx.tenantId,
                employmentId: e.employmentId,
                leaveTypeId: typeId,
                entryType: 'adjustment',
                days: (-forfeit).toFixed(2),
                effectiveOn: cycleStart,
                reason: CARRY_FORFEIT_REASON_CAP,
              });
            }
            forfeited.add(carryKey);
            forfeits += 1;
          }
        }
        // Benefit Scheme (b83c6a3b): scheme band days supersede pol.days as the annual target. 6e9a126e:
        // a template supersedes both. Composed ONCE above, beside the policy resolution it belongs to —
        // identical to openLeaveYear / the hire grant / the recalc kernel. fa3f4ccb: the EA floor no longer
        // clamps here (or anywhere) — it is passed only so the shared helper can flag a below-minimum figure.
        const entitlement = composed.days;
        if (entitlement <= 0) continue;
        // bc36c768 — THE SHARED KERNEL. This used to be four lines of period arithmetic written out here
        // and again inside projectExpectedEntitlement. One function now, called from both, because the two
        // must agree to the day or every profile edit posts an oscillating delta (see earnedToDateFor).
        let earnedToDate = earnedToDateFor({
          method: pol!.method,
          accrualDay: pol!.accrualDay ?? null,
          annualDays: entitlement,
          cycleStart,
          hiredOn: e.hiredOn,
          leaveCycle: cyc,
          asOf: p.asOf,
        });
        // Feedback b81d3c52 — Rounding Method (the Accrual Process surface). The CUMULATIVE-to-date figure
        // is tidied every period, before the room-cap, so the running balance the Accrual Process credits
        // is itself a whole day: 'up' shows whole days as they build, 'down' floors a small early
        // cumulative to 0 (no row is written — see the `toGrant > 0` guard) and then builds. Because that
        // guard never posts a NEGATIVE top-up, switching to 'down' mid-cycle cannot claw back what is
        // already credited — only forward periods accrue less (the forward-only contract; the save-time
        // recalc kernel deliberately does not reproject on a rounding-only edit either).
        earnedToDate = applyRounding(earnedToDate, pol!.roundingMethod, pol!.roundingThreshold, pol!.roundingBands);
        // Feedback 9d8cf621 — Maximum Balance Days: cap the cumulative earned so retainedCarry + earned
        // never exceeds the cap (i.e. the running balance stays ≤ cap across the cycle). null ⇒ no cap.
        if (pol!.maxBalanceDays != null) {
          const room = Math.max(0, Math.round((Math.max(0, pol!.maxBalanceDays) - retainedCarry) * 100) / 100);
          earnedToDate = Math.min(earnedToDate, room);
        }
        // feedback cf9dcb98 — reason (c), and it is accumulated HERE because this is the only line that
        // knows the figure. `toGrant` below is `earnedToDate - already`: a preview whose every group reads
        // 0.00 means either "nothing has been earned yet at this date" or "everything earned is already on
        // the ledger", and the two want opposite actions from HR. Σ earnedToDate is what tells them apart.
        earnedToDateTotal = Math.round((earnedToDateTotal + earnedToDate) * 100) / 100;
        const rows = accrualRowsBy.get(`${e.employmentId}|${typeId}`) ?? [];
        // c8052ae3 — the SAME closed interval the profile recalc uses. This sum had a start and no end,
        // so a grant already written for the NEXT leave year counted as this cycle's accrual and the
        // monthly top-up went quiet for the rest of the year. `leaveCycleEnd` is the one definition of
        // where a cycle stops, shared with `projectExpectedEntitlement`, so the engine that CREDITS and
        // the kernel that PROJECTS cannot disagree about which rows belong to the window.
        const cycleEnd = leaveCycleEnd(cycleStart);
        const already = rows.reduce(
          (s, r) => (r.effectiveOn >= cycleStart && r.effectiveOn <= cycleEnd ? s + r.days : s),
          0,
        );
        const toGrant = Math.round((earnedToDate - already) * 100) / 100;
        if (toGrant > 0) {
          // dryRun (feedback 2c7c6385): compute the same top-up but write NOTHING — preview == commit.
          if (!dryRun) {
            await tx.insert(leaveLedger).values({
              tenantId: ctx.tenantId,
              employmentId: e.employmentId,
              leaveTypeId: typeId,
              entryType: 'accrual',
              days: toGrant.toFixed(2),
              effectiveOn: p.asOf,
            });
          }
          granted += 1;
          group.entitlementGenerated = Math.round((group.entitlementGenerated + toGrant) * 100) / 100;
        }
      }
    }
    // Materialise the grouped breakdown for the preview/summary table (feedback 2c7c6385).
    const breakdown: EarnedAccrualGroup[] = [...groupBy.values()]
      .map((g) => {
        const type = types.find((t) => t.id === g.leaveTypeId)!;
        return {
          companyId: g.companyId,
          companyName: g.companyName,
          gradeId: g.gradeId,
          gradeName: g.gradeId ? (gradeNameById.get(g.gradeId) ?? null) : null,
          leaveTypeId: g.leaveTypeId,
          leaveTypeCode: type.code,
          leaveTypeName: type.name,
          employeeCount: g.count,
          accrualPeriod,
          method: g.method,
          entitlementGenerated: g.entitlementGenerated,
        };
      })
      .sort(
        (a, b) =>
          a.companyName.localeCompare(b.companyName) ||
          (a.gradeName ?? '').localeCompare(b.gradeName ?? '') ||
          a.leaveTypeName.localeCompare(b.leaveTypeName),
      );

    // dryRun (feedback 2c7c6385): a PREVIEW must leave no trace — skip the audit event entirely. A real
    // run appends ONE summary event; the ledger rows are the per-item audit (deliberate skip, as openLeaveYear).
    if (!dryRun) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-year',
        aggregateId: ctx.tenantId,
        eventType: 'leave.earned-accrual.run',
        actor: actorOf(ctx),
        // feedback 2c7c6385 (product decision 4): stamp the scope so a manual scoped run is distinguishable
        // from the unscoped monthly cron in the audit log. Empty arrays ⇒ "all" on that axis. IDs only (no
        // PII — see test/event-payload-pii-guard.test.ts).
        payload: {
          asOf: p.asOf,
          granted,
          forfeits,
          companyIds: scopeCompanyIds,
          gradeIds: scopeGradeIds,
          leaveTypeIds: scopeTypeIds,
        },
      });
    }
    // feedback cf9dcb98 — EXIT 4, the last one: the configuration is present, the population is present,
    // and not one (employee, type) pair reached an earned entitlement. Three different states arrive here
    // and the old sentence described all three identically; the counters above, tallied on the engine's own
    // branches, are what separates them.
    let emptyReason: EarnedAccrualEmptyReason | null = null;
    let archivedHint: ArchivedLeaveTypeHint[] = [];
    if (breakdown.length === 0) {
      const earnedTypeRows = types.filter((t) => earnedTypeIds.includes(t.id));
      const earnedTypeNames = earnedTypeRows.map((t) => t.name).sort((a, b) => a.localeCompare(b));
      if (packBlocked.length === emps.length) {
        // Every employment sits in a country with no active pack — nothing was even attempted.
        emptyReason = {
          kind: 'country_pack_inactive',
          countries: [...new Set(packBlocked.map((b) => b.country).filter((c): c is string => !!c))].sort(),
        };
      } else if (skipFrozen > 0 && skipNoEntitlement === 0) {
        // ADR-0069: the balances are deliberately held for encashment. Not a configuration fault at all.
        emptyReason = { kind: 'balance_frozen', leaveTypeNames: earnedTypeNames };
      } else {
        // r209's SECOND ZERO, and the one worth a sentence: the type HAS entitlement tables (it had to, to
        // reach `earnedTypeIds`) and no eligibility rule points any of these employees at one. A
        // half-built configuration, which reads on screen exactly like an empty one until it is named.
        //
        // `hasTemplatesFor` is r209's free reader over the SAME `activeTemplatesAt` map the resolution was
        // built from; it is asked rather than assumed so that if the two datings ever diverge, this names
        // the types the resolver actually saw tables for, not the ones an earlier filter believed in.
        const withTables = earnedTypeRows.filter((t) => templates.hasTemplatesFor(t.id)).map((t) => t.name);
        emptyReason = {
          kind: 'no_eligibility_match',
          leaveTypeNames: (withTables.length ? withTables : earnedTypeNames).sort((a, b) => a.localeCompare(b)),
        };
      }
      archivedHint = await archivedHintFor(scopedTypeNames);
    }
    return { granted, forfeits, breakdown, packBlocked, emptyReason, archivedHint, earnedToDateTotal };
  });
}

// ── Entitlement-correction recalculation (feedback 49809272) ───────────────────────────────────────
/**
 * Pure per-employee current-cycle entitlement projection — the shared kernel used by BOTH recalc paths:
 * the configuration-triggered `reprojectEntitlementForLeaveType` (49809272) and the profile-triggered
 * `reprojectEntitlementForEmployment` (R45 7527ea5f). Given the employee's service facts + their winning
 * entitlement-template band for one leave type, it returns the entitlement that SHOULD be materialized to
 * `asOf` for the current cycle, plus that cycle's window start. Byte-identical to the granting engines
 * (openLeaveYear / the hire grant / accrueEarnedLeave): resolve the band, apply the leave type's rules,
 * then project upfront (calendar-year, hire-month prorate for ANNUAL) or earned (elapsed periods only).
 *
 * Returns null to signal a defensive SKIP — three different reasons, all meaning "leave this employee and
 * type completely alone": the type is not configured (bc36c768), NOTHING resolves for this employee
 * (`noOpinion`, the 6e9a126e guard), or an anniversary company's calendar-year re-resolution flips the
 * winner to an earned method (mixing windows).
 *
 * ⚠️ c8052ae3 — IT RETURNS THE CYCLE AS A CLOSED INTERVAL, `windowStart` AND `windowEnd`, AND `windowEnd`
 * IS NOT OPTIONAL GARNISH. Callers subtract "already granted inside the window" from `expected`. Before
 * `windowEnd` existed they had only a start, so a grant already written ahead for the NEXT leave year fell
 * inside every caller's filter and was counted as this cycle's — and the difference came back as a large
 * negative clawback on an ordinary profile save (production: 180.00 read against 60.00, −120.00 posted).
 * A caller that uses `windowStart` without `windowEnd` is reintroducing that defect. See `leaveCycleEnd`.
 */
export function projectExpectedEntitlement(
  // Leave Year Type override (e1a51aea): `leaveCycle` is the EFFECTIVE cycle for the (type, company) pair —
  // callers resolve it via resolveLeaveYearCycle(type.yearCycleOverride, company.leaveCycle) before calling.
  // `terminatedOn` (adcdf215): a first-year a2c LEAVER's last day of service — passed as the serviceEnd cap
  // into the up-front kernel so the figure prorates to their exit, not the full year. Absent/null ⇒ active
  // employee ⇒ full up-front figure. Ignored on every non-a2c branch (byte-identical for other callers).
  emp: {
    hiredOn: string;
    leaveCycle: string | null;
    gradeId: string | null;
    companyId: string;
    terminatedOn?: string | null;
  },
  typeCode: string,
  floor: (code: string, years: number) => number,
  asOf: string,
  /** Anniversary to Calendar (f3a64d90): the RAW `leave_type.year_cycle_override` string — NOT the resolved
   *  cycle above (a2c resolves to 'calendar', which is deliberately indistinguishable from c2c). Only 'a2c'
   *  is load-bearing here, and only for ANNUAL in the employee's hire year. Absent ⇒ byte-identical
   *  pre-existing behaviour for every other caller. */
  yearCycleOverride?: string | null,
  /** Feedback 9816a5ad step 2 — the leave TYPE's own rule columns. The template band supplies the DAYS;
   *  every rule (earning method / carry forward / rounding / maximum balance) comes from here. Absent
   *  (undefined) ⇒ no rules at all (see `applyLeaveTypeRules`).
   *
   *  This kernel is the reason the parameter exists rather than the callers overlaying afterwards: it
   *  re-resolves the entitlement internally (the anniversary/upfront branch below), so an overlay applied
   *  by the caller could only ever cover the FIRST resolution and the second would silently lose the
   *  type's rules. */
  typeRules?: LeaveTypeRules | null,
  /** 6e9a126e — the employee's winning ENTITLEMENT TEMPLATE band at a given service length
   *  (`buildTemplateEntitlementResolver(...).bandFor`, partially applied by the caller). null = nothing
   *  resolves for this employee, which is `noOpinion` and a SKIP. Absent (undefined) ⇒ the same, which is
   *  what the pure unit tests of the non-entitlement branches of this kernel rely on.
   *
   *  A FUNCTION OF `years`, not a resolved band, for exactly the reason `typeRules` is a parameter rather
   *  than a caller-side overlay: this kernel RE-RESOLVES internally (the anniversary/upfront branch below),
   *  and a band resolved once by the caller would pin the first resolution while the second silently used
   *  the wrong service length. */
  templateBandForYears?: (years: number) => ServiceBand | null,
): { expected: number; windowStart: string; windowEnd: string } | null {
  // bc36c768 — THE NOT-CONFIGURED GATE, first, before any method resolution.
  //
  // ⚠️ IT MUST RETURN null (SKIP THE TYPE), NOT 0. All three callers treat null as "leave this
  // employee/type completely alone" (`if (!projected) continue`), so no ledger row is written and the
  // delta is exactly 0.00. Returning 0 would instead make each caller compute `0 − alreadyPosted` and post
  // a NEGATIVE compensating adjustment clawing back every day already credited — the precise inversion of
  // the risk this gate exists to remove, on a reset the reporter was promised moves no balance.
  if (isAccrualUnconfigured(typeRules)) return null;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const cycleStartEarned = earnedCycleStart(emp.hiredOn, asOf, emp.leaveCycle);
  let years = serviceYearsAt(emp.hiredOn, cycleStartEarned);
  // ⚠️ THE ENTITLEMENT IS RESOLVED TWICE AND COMPOSED ONCE. The anniversary branch below re-anchors the
  // band to the calendar year-open, and the earned/upfront probe has to ask the SECOND resolution's rules,
  // not the first's — so `resolveEntitlement` is a function of `years` rather than a value. The DAYS are
  // then composed exactly once, at the final years, by the single shared `composeEntitlement`.
  const resolveEntitlement = (y: number) => {
    const templateBand = templateBandForYears?.(y) ?? null;
    return { templateBand, pol: applyLeaveTypeRules(policyFromTemplateBand(templateBand), typeRules) };
  };
  let resolved = resolveEntitlement(years);
  const earnedMethod = isEarnedMethod(resolved.pol?.method);
  if (!earnedMethod && cycleStartEarned !== yearStart) {
    // Anniversary company whose winner is upfront: re-resolve with service measured at the calendar
    // year-open (openLeaveYear's own band anchor). If a banded config flips the winner to an earned
    // method under these years, skip defensively rather than mix windows.
    years = serviceYearsAt(emp.hiredOn, yearStart);
    resolved = resolveEntitlement(years);
    if (isEarnedMethod(resolved.pol?.method)) return null;
  }
  // Anniversary to Calendar (f3a64d90): the first-year window is the CALENDAR year, whatever the resolved
  // policy method says — a2c resolves to 'calendar' so cycleStartEarned already equals yearStart, but
  // stating it here keeps the invariant explicit rather than incidental.
  const a2cFirstYear = isA2cFirstYear(yearCycleOverride, typeCode, emp.hiredOn, asOf);
  const windowStart = !a2cFirstYear && earnedMethod ? cycleStartEarned : yearStart;

  // ⚠️ ONE-COMPOSITION INVARIANT — identical to openLeaveYear / the hire grant / accrueEarnedLeave: the
  // resolved entitlement comes from the one shared composition (`composeEntitlement`), at the FINAL years
  // (post-re-resolution above), matching the sweeps' own band anchor.
  // fa3f4ccb: the statutory floor no longer clamps, so a correction can now claw back BELOW the EA minimum
  // when that is what the configuration says — which is the requested behaviour, not a defect. `floor` is
  // still resolved and still passed, purely to feed the below-minimum flag.

  // 6e9a126e — THE "NO OPINION" GUARD. NOTHING CONFIGURED IS NOT ZERO DAYS.
  //
  // ⚠️ SAME CONTRACT AS THE bc36c768 GATE ABOVE: return null (SKIP), never 0. All three callers read null
  // as "leave this employee/type completely alone" (`if (!projected) continue`), so no ledger row is
  // written and the delta is exactly 0.00. Returning 0 would make each caller compute `0 − alreadyPosted`
  // and post a NEGATIVE compensating adjustment clawing back days already credited — driving live
  // balances toward zero on an ordinary profile save.
  //
  // THIS SHIPS IN THE RELEASE THAT CLEARS NOTHING, ON PURPOSE. Release three empties the entitlement
  // configuration the reporter asked to reset; from that moment every unconfigured employee/type pair
  // takes this branch. A safety property that lands in the same change as the hazard it guards has never
  // once been observed working without it.
  //
  // The predicate is on the RESOLUTION, not the composed number: no band at all and a band saying 0 days
  // (somebody typed zero) are different facts that `days ?? 0` flattens into the same 0. See
  // `noEntitlementOpinion` for the full argument.
  //
  // RELEASE THREE MADE THIS THE ONLY THING STANDING BETWEEN AN EMPTY CONFIGURATION AND A CLAWBACK. Both
  // old layers are gone and both new tables are empty until the reporter retypes, so from the moment this
  // ships EVERY employee/type pair takes this branch — and takes it on an ordinary profile save.
  //
  // ONE composition, at the FINAL years — the same `composeEntitlement` openLeaveYear, the hire grant and
  // accrueEarnedLeave call. `pol` below is its carrier, identical by construction to the probe's above.
  const composed = composeEntitlement({
    floorDays: floor(typeCode, years),
    templateBand: resolved.templateBand,
    rules: typeRules,
  });
  if (composed.noOpinion) return null;

  const pol = composed.policy;
  const days = composed.days;
  let expected: number;
  if (a2cFirstYear) {
    // ⚠️ bc36c768 — THE a2c DIVERGENCE IS SCOPED HERE, NOT FIXED, AND THIS ITEM DOES NOT CLOSE IT. This
    // branch is tested BEFORE the earned branch below, while accrueEarnedLeave contains zero a2c handling
    // at all. So for an ANNUAL type with yearCycleOverride 'a2c' in an employee's HIRE year, the accrual
    // engine credits period slices while this kernel projects the up-front a2c figure — and those two
    // disagree TODAY, for earned_monthly, before any of this. earned_daily inherits that divergence
    // unchanged; extracting `earnedToDateFor` does NOT close it, because the two sides never reach the
    // shared function on the same input. The engine/kernel cross-check test excludes this combination BY
    // ASSERTION rather than by silent omission. Closing it — teaching accrueEarnedLeave about a2c, or
    // deciding that an a2c first year simply overrides any earned method — is a separate item.
    // Anniversary to Calendar (f3a64d90 → adcdf215), FIRST (hire) year only: the entitlement is the full
    // prorated part-year (join → 31 Dec) UP FRONT at (resolved entitlement ÷ 365) — the ONE shared kernel,
    // so the hire grant, this projection and the a2c correction can never disagree. A first-year LEAVER is
    // capped at their last day of service via `terminatedOn` (serviceEnd) so the figure never over-grants
    // days they never served. The window is the CALENDAR year (a2c resolves to 'calendar'), so carry/forfeit
    // anchoring and the year-two grant stay untouched. Every other a2c case — a non-ANNUAL type, or ANNUAL
    // in year two onward — falls through to the branches below and behaves like an ordinary calendar type.
    expected = a2cFirstYearEntitledToDate(emp.hiredOn, asOf, days, emp.terminatedOn ?? null);
  } else if (earnedMethod) {
    // bc36c768 — THE SHARED KERNEL, the same call the accrual engine makes. This was the second of the
    // two independent copies of the period arithmetic; the copy is gone and cannot come back by halves.
    expected = earnedToDateFor({
      method: pol!.method,
      accrualDay: pol!.accrualDay ?? null,
      annualDays: days,
      cycleStart: windowStart,
      hiredOn: emp.hiredOn,
      leaveCycle: emp.leaveCycle,
      asOf,
    });
  } else if (emp.hiredOn >= windowStart && typeCode === 'ANNUAL') {
    // Joiner during the current leave year: ANNUAL pro-rates by hire month (core/org.ts formula).
    const month = Number(emp.hiredOn.slice(5, 7));
    expected = round2((days * (12 - (month - 1))) / 12);
  } else {
    // Existing employee (year-open grant) or a non-prorating type: the full resolved amount.
    expected = days;
  }
  // Feedback b81d3c52 mirrored into the kernel — round the projection at the SAME point and in the SAME
  // order (rounding, THEN the max-balance clamp) the three granting engines do, on EVERY branch (earned,
  // joiner pro-ration, full grant). REQUIRED for ledger agreement: without it, any reproject triggered by
  // an unrelated days/method change would compare a raw projection against a rounded ledger and post a
  // permanent oscillating delta. `pol` null (floor-only / scheme-only) ⇒ no method ⇒ pass-through.
  expected = applyRounding(expected, pol?.roundingMethod, pol?.roundingThreshold, pol?.roundingBands);
  // Feedback 9d8cf621 mirrored into the kernel (ae5b84d5): the winning band's Maximum Balance cap bounds
  // what the granting engines will ever materialize this cycle (applyMaxBalance at year-open/hire; the
  // earned room-cap in accrueEarnedLeave), so the projection must not exceed it either — on BOTH the
  // upfront and earned paths. Documented approximation: a carried-in prior-year balance is not re-derived
  // here — the year-open already capped carry+grant, and this clamp guarantees the in-cycle granted total
  // never exceeds the cap. No cap (null/undefined) ⇒ pass-through.
  if (pol?.maxBalanceDays != null) {
    expected = Math.min(expected, round2(Math.max(0, pol.maxBalanceDays)));
  }
  // c8052ae3: the cycle is a CLOSED interval now — [windowStart, windowEnd] — and both ends travel
  // together so no caller can accidentally use one without the other.
  return { expected, windowStart, windowEnd: leaveCycleEnd(windowStart) };
}

/** Anniversary to Calendar (f3a64d90 → adcdf215): the SYSTEM-generated adjustment reasons the a2c first-year
 *  model SUPERSEDES. Under a2c a first-year employee's entitlement is exactly the up-front part-year figure —
 *  there is no prior cycle to carry from (so no cap/expiry forfeit belongs in the window), and any earlier
 *  policy-/profile-recalc adjustment was computed under the model a2c replaces. A human festive-grant or
 *  a manual HR adjustment carries NO `sys:` reason and is therefore never touched. */
const a2cSupersededReasonCond = () =>
  or(
    recalcAdjustmentReasonCond(),
    like(leaveLedger.reason, `${A2C_RECALC_REASON_PREFIX}:%`),
    inArray(leaveLedger.reason, [
      CARRY_FORFEIT_REASON_CAP,
      CARRY_FORFEIT_REASON_EXPIRY,
      AGED_FORFEIT_REASON,
    ]),
  );

/**
 * Anniversary to Calendar — the dedicated first-year correction (feedback f3a64d90).
 *
 * WHY ITS OWN PATH, and not one more `adjustment` in the two existing recalc kernels: the "YTD Entitled"
 * figure on every leave summary is `accrued`, and `accrued` sums ONLY entryType in ('accrual',
 * 'in_lieu_accrual') (core/read.ts leaveBalances). An `adjustment` moves Balance and Available but is
 * INVISIBLE to YTD Entitled — so a plain adjustment could never lift a to-date figure to the up-front
 * target. This path therefore posts an ACCRUAL-CLASS row for the entitlement delta, which is what makes all
 * four surfaces (YTD Entitled, Available, Balance, and the Entitlement breakdown's cycleAccrual) move
 * together. adcdf215: this same accrual delta is what TOPS UP an already-in-flight build-up employee
 * (to-date → up-front, e.g. 10.90 → 19.73) on the next correction sweep — up-front ≥ to-date for a mid-year
 * first-year employee, so that top-up is never a claw-down.
 *
 * Two rows, both stamped `sys:a2c_recalc:<leaveTypeId>`:
 *  1. ACCRUAL delta — brings the window's accrual-class total to exactly the a2c target
 *     (a2cFirstYearEntitledToDate over the FULLY resolved entitlement: EA-1955 floor ∨ benefit-scheme band
 *     ∨ policy days). For a first-year LEAVER the target is capped at their last day of service (the
 *     candidate's `terminatedOn`, threaded through as the kernel's serviceEnd) so the correction never
 *     over-grants encashment / final pay. Signed: an employee whose ledger EXCEEDS the target is clawed
 *     DOWN, which the grant-only engines can never do.
 *  2. ADJUSTMENT reversal — cancels the superseded system rows in the window (see
 *     a2cSupersededReasonCond). Without it a pure accrual top-up would fix YTD Entitled and leave Balance
 *     wrong, which is precisely the defect reported (accrued 7.00, taken 3.50, balance −6.00: about −9.50
 *     of stale system rows). After both rows the ledger nets to target − debits, so
 *     Available = Balance = YTD Entitled − Taken − Pending.
 *
 * IDEMPOTENT by construction: both classes of row are read back into the next run's sums, so a re-run
 * computes delta 0 and reversal 0 and writes nothing.
 *
 * SCOPE: the HIRE year only (isA2cFirstYear). From the next 1 Jan a2c resolves to 'calendar' and
 * openLeaveYear owns the full grant like any calendar type — one engine, no double-grant, no new
 * idempotency marker. Non-ANNUAL a2c types are never touched (EA s.60F full grant).
 *
 * Runs INSIDE the caller's transaction (takes the live `tx`), so HR's leave-type save and the correction
 * commit together. Frozen encashment snapshots are skipped (ADR-0069 — the DB trigger would abort the tx).
 * Substrate: one `leave.entitlement.recalculated` DomainEvent per corrected employment.
 */
export async function reprojectA2cEntitlement(
  tx: Tx,
  ctx: SessionContext,
  p: {
    leaveTypeId: string;
    /** Restrict to these employments; absent ⇒ every live employment the type can reach. */
    employmentIds?: string[];
    /** Tenant-local (MYT) "today" — the correction date. adcdf215: the active up-front figure is asOf-
     *  independent, but asOf still bounds the ledger window read below and gates the hire-year check. */
    asOf: string;
    /** Recorded on the event payload: what triggered the correction (e.g. 'year_cycle_override'). */
    trigger: string;
    /** 9e2a89e9 — the grade pair and the change's own effective date, threaded from
     *  `reprojectEntitlementForEmployment` so an a2c first-year employee's promotion leaves the SAME
     *  history row as everybody else's. Absent on every other caller, which writes no grades. See the
     *  notes on that function's parameters for why presence, not nullness, is the signal. */
    gradeBefore?: { gradeId: string | null };
    newGradeId?: string | null;
    changeEffectiveOn?: string | null;
  },
): Promise<{ affected: number; totalDelta: number; packBlocked: PackBlockedEmployment[] }> {
  const none = { affected: 0, totalDelta: 0, packBlocked: [] as PackBlockedEmployment[] };

  const [type] = await tx
    // 9816a5ad step 2: the type's own rules ride along and are handed to the projection kernel below.
    .select({ id: leaveType.id, code: leaveType.code, yearCycleOverride: leaveType.yearCycleOverride, ...leaveTypeRuleColumns })
    .from(leaveType)
    .where(and(eq(leaveType.id, p.leaveTypeId), isNull(leaveType.archivedAt)))
    .limit(1);
  // No-op unless the type is actually on a2c today. Callers fire this on any move TO or FROM a2c; a move
  // AWAY simply hands the type back to the ordinary calendar engines from the next year-open.
  if (!type || type.yearCycleOverride !== A2C_OVERRIDE) return none;

  const yearStart = `${p.asOf.slice(0, 4)}-01-01`;
  const scopeIds = (p.employmentIds ?? []).filter(Boolean);
  const candidates = await tx
    .select({
      employmentId: employment.id,
      hiredOn: employment.hiredOn,
      // adcdf215: a first-year LEAVER's last day of service — threaded into the up-front kernel as the
      // serviceEnd cap so the correction prorates to their exit, never over-granting encashment / final pay.
      terminatedOn: employment.terminatedOn,
      country: company.country,
      leaveCycle: company.leaveCycle,
      gradeId: employment.gradeId,
      companyId: employment.companyId,
    })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(
      and(
        lte(employment.hiredOn, p.asOf),
        or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        scopeIds.length > 0 ? inArray(employment.id, scopeIds) : undefined,
      ),
    );
  // The ONE window where a2c differs from a plain calendar type: the employee's hire year, ANNUAL only.
  const emps = candidates.filter((e) => isA2cFirstYear(type.yearCycleOverride, type.code, e.hiredOn, p.asOf));
  if (emps.length === 0) return none;
  const empIds = emps.map((e) => e.employmentId);

  // 6e9a126e — the entitlement TEMPLATE layer, resolved at `asOf`, so the a2c slice is taken off the SAME
  // resolved entitlement the grant engines would use. Release three removed the two reads that stood here
  // (the type's active `leave_policy` rows and the benefit-scheme resolver).
  const templates = await buildTemplateEntitlementResolver(tx, {
    employmentIds: empIds,
    leaveTypeIds: [p.leaveTypeId],
    asOf: p.asOf,
  });

  // The calendar window [yearStart, asOf]: accrual-class rows (what YTD Entitled shows) and the superseded
  // system adjustments (what Balance must be freed of), in one round-trip.
  const ledgerRows = await tx
    .select({
      employmentId: leaveLedger.employmentId,
      entryType: leaveLedger.entryType,
      days: leaveLedger.days,
    })
    .from(leaveLedger)
    .where(
      and(
        inArray(leaveLedger.employmentId, empIds),
        eq(leaveLedger.leaveTypeId, p.leaveTypeId),
        gte(leaveLedger.effectiveOn, yearStart),
        lte(leaveLedger.effectiveOn, p.asOf),
        or(
          inArray(leaveLedger.entryType, ['accrual', 'in_lieu_accrual']),
          and(eq(leaveLedger.entryType, 'adjustment'), a2cSupersededReasonCond()),
        ),
      ),
    );
  const accruedBy = new Map<string, number>();
  const supersededBy = new Map<string, number>();
  for (const r of ledgerRows) {
    const target = r.entryType === 'adjustment' ? supersededBy : accruedBy;
    target.set(r.employmentId, round2((target.get(r.employmentId) ?? 0) + Number(r.days)));
  }

  const frozenSet = await frozenSnapshotKeySet(tx, empIds, [p.leaveTypeId]);

  const reason = `${A2C_RECALC_REASON_PREFIX}:${p.leaveTypeId}`;
  let affected = 0;
  let totalDelta = 0;
  const packBlocked: PackBlockedEmployment[] = [];
  for (const e of emps) {
    const pack = packFor(e.country);
    if (!pack) {
      packBlocked.push({ employmentId: e.employmentId, country: e.country ?? null, reason: 'country_pack_inactive' });
      continue;
    }
    if (frozenSet.has(`${e.employmentId}|${p.leaveTypeId}`)) continue;

    const projected = projectExpectedEntitlement(
      {
        hiredOn: e.hiredOn,
        leaveCycle: resolveLeaveYearCycle(type.yearCycleOverride, e.leaveCycle) ?? null,
        gradeId: e.gradeId,
        companyId: e.companyId,
        // adcdf215: cap a first-year leaver's up-front figure at their last day of service.
        terminatedOn: e.terminatedOn,
      },
      type.code,
      (c, y) => pack.leave.entitlement(c, y),
      p.asOf,
      type.yearCycleOverride,
      // 9816a5ad step 2: every RULE comes from the leave TYPE; the template band supplies the DAYS.
      type,
      // 6e9a126e: this employee's winning template band — the only source of days there is.
      (years) => templates.bandFor(e.employmentId, p.leaveTypeId, years),
    );
    if (!projected) continue;
    // 9e2a89e9 — the window rides along so the audit row's quoted date can be judged against the cycle
    // this projection is actually about (a per-type `yearCycleOverride` moves it).
    const { expected, windowStart, windowEnd } = projected;

    const accrued = accruedBy.get(e.employmentId) ?? 0;
    const superseded = supersededBy.get(e.employmentId) ?? 0;
    const accrualDelta = round2(expected - accrued);
    const reversal = round2(-superseded);
    if (accrualDelta === 0 && reversal === 0) continue;

    let anchorRowId: string | null = null;
    if (accrualDelta !== 0) {
      const [row] = await tx
        .insert(leaveLedger)
        .values({
          tenantId: ctx.tenantId,
          employmentId: e.employmentId,
          leaveTypeId: p.leaveTypeId,
          // ACCRUAL-class — the whole point: `accrued` (YTD Entitled) counts only these entry types.
          entryType: 'accrual',
          days: accrualDelta.toFixed(2),
          effectiveOn: p.asOf,
          reason,
        })
        .returning({ id: leaveLedger.id });
      anchorRowId = row.id;
    }
    if (reversal !== 0) {
      const [row] = await tx
        .insert(leaveLedger)
        .values({
          tenantId: ctx.tenantId,
          employmentId: e.employmentId,
          leaveTypeId: p.leaveTypeId,
          entryType: 'adjustment',
          days: reversal.toFixed(2),
          effectiveOn: p.asOf,
          reason,
        })
        .returning({ id: leaveLedger.id });
      anchorRowId ??= row.id;
    }

    await tx.insert(leaveEntitlementRecalcAudit).values({
      tenantId: ctx.tenantId,
      employmentId: e.employmentId,
      leaveTypeId: p.leaveTypeId,
      previousEntitlement: accrued.toFixed(2),
      newEntitlement: expected.toFixed(2),
      delta: accrualDelta.toFixed(2),
      reason: p.trigger,
      effectiveOn: p.asOf,
      // Same rule as the profile-recalc kernel next door: a date outside the cycle these figures describe
      // is dropped, never clamped.
      changeEffectiveOn: changeDateWithinCycle(p.changeEffectiveOn, windowStart, windowEnd),
      previousGradeId: p.gradeBefore ? (p.gradeBefore.gradeId ?? null) : null,
      newGradeId: p.gradeBefore ? (p.newGradeId ?? null) : null,
      ledgerId: anchorRowId,
    });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-ledger',
      aggregateId: anchorRowId!,
      eventType: 'leave.entitlement.recalculated',
      actor: actorOf(ctx),
      subjectEmploymentId: e.employmentId,
      payload: {
        employmentId: e.employmentId,
        leaveTypeId: p.leaveTypeId,
        before: accrued,
        after: expected,
        delta: accrualDelta,
        supersededReversal: reversal,
        cycleStart: yearStart,
        reason: 'a2c_recalc',
        trigger: p.trigger,
      },
    });
    affected += 1;
    totalDelta = round2(totalDelta + accrualDelta + reversal);
  }
  return { affected, totalDelta, packBlocked };
}

/**
 * 9e2a89e9 — THE DATE A HISTORY ROW IS ALLOWED TO QUOTE, and why it is sometimes none.
 *
 * A recalc row carries four facts about ONE leave cycle: the entitlement before, the entitlement after,
 * the difference, and — new in this item — the date the underlying change took effect. The first three
 * always describe the cycle the recalc actually re-projected. The fourth comes from the caller and can
 * describe a DIFFERENT one.
 *
 * ⚠️ THE CASE THIS EXISTS FOR, MEASURED: a promotion effective 2025-12-15 recorded on 2026-09-11. The
 * recalc re-projects the CURRENT cycle — 2026 — and posts prev 14.00 / new 16.00 / delta +2.00 into it.
 * 2025 is closed and is never rewritten (every `projectExpectedEntitlement` caller's first invariant). So
 * a row reading "Took effect 15 Dec 2025" beside 2026's figures invites exactly one conclusion, that the
 * +2 landed in 2025, and it did not.
 *
 * SO AN OUT-OF-WINDOW DATE IS DROPPED, NOT CLAMPED. Clamping to `windowStart` would print "1 January
 * 2026", which is a date the change did not take effect on — a wrong value asserts something false, an
 * absent one asserts nothing (CLAUDE.md §8). With null the screen falls back to `effective_on` and reads
 * "Took effect 11 Sep 2026", which is precisely what happened: on that day we corrected the 2026 cycle.
 * The backdated effective date is NOT lost — it is the movement's own fact and Employment History carries
 * it; this column only ever spoke about the cycle these figures describe.
 *
 * Pure and exported so the rule has one definition and a test can reach it without a database.
 */
export function changeDateWithinCycle(
  changeEffectiveOn: string | null | undefined,
  windowStart: string,
  windowEnd: string,
): string | null {
  if (!changeEffectiveOn) return null;
  // ISO dates compare lexicographically, the same comparison the cycle window itself is filtered with.
  return changeEffectiveOn >= windowStart && changeEffectiveOn <= windowEnd ? changeEffectiveOn : null;
}

// ── Profile-change recalculation (R45 7527ea5f) ────────────────────────────────────────────────────
/**
 * Automatic Leave Entitlement Recalculation on profile / eligibility change (R45 7527ea5f).
 *
 * The counterpart to `reprojectEntitlementForLeaveTypeCohort`: that path fires when the CONFIGURATION
 * moves; THIS path fires when the EMPLOYEE's own profile moves — grade, department, position, employment
 * type, confirmation status, or hire date — any of which can change which eligibility rule matches them
 * (a promotion into a grade a different table covers, passing probation, a corrected hire date shifting
 * the service band). For the ONE changed employment
 * it re-projects the current cycle across every active leave type and posts a compensating `adjustment`
 * (reason `sys:profile_recalc:<employmentId>`) for the delta between what the corrected profile SHOULD have
 * materialized to `asOf` and what the ledger already holds — then records an audit-history row and appends
 * one `leave.entitlement.recalculated` DomainEvent per corrected type.
 *
 * Same invariants as every other `projectExpectedEntitlement` caller:
 *  - CURRENT cycle only (closed prior years, governed by their year-open version, are never rewritten).
 *  - MATERIALIZED-only: a type with no `accrual` row this cycle is skipped (the grant engines will grant
 *    from the new profile when they next run; posting here would double-grant).
 *  - NO OPINION IS NOT ZERO: a type for which nothing resolves is SKIPPED, never clawed back to 0.
 *  - IDEMPOTENT: prior `sys:policy_recalc:*` AND `sys:profile_recalc:*` adjustments count into
 *    `alreadyPosted`, so re-running after a no-op profile save computes delta 0 and posts nothing.
 *  - FROZEN encashment snapshots are skipped (the DB trigger would abort the tx).
 *
 * Runs in its OWN transaction AFTER the profile write has committed (called best-effort from the personnel
 * actions), so a recalc hiccup never blocks the profile edit — the correction is idempotent and self-heals
 * on the next trigger. `trigger` names the profile field that moved (recorded on the audit row + event).
 */
export async function reprojectEntitlementForEmployment(
  ctx: SessionContext,
  p: {
    employmentId: string;
    asOf?: string;
    trigger: string;
    /**
     * 9e2a89e9 — WHAT THE GRADE WAS BEFORE, declared by the caller, so the history row can name both
     * grades instead of only the machine trigger.
     *
     * ⚠️ ITS PRESENCE IS THE SIGNAL, which is why it is an object rather than a bare nullable id: "no
     * grade before" and "this caller is not telling me about a grade change" are different statements,
     * and only the first should put grades on the row. A configuration-triggered cohort recalc omits it,
     * so its rows carry no grades — writing today's grade into `new_grade_id` there would read as a
     * promotion that never happened.
     *
     * The caller has it and this function does not: by the time a recalc runs the profile write has
     * already committed, so `employment.grade_id` read here is the NEW grade. Re-deriving the old one
     * from the event trail would be a second reader of the movement history to keep in step with
     * corrections and reversals.
     */
    gradeBefore?: { gradeId: string | null };
    /**
     * 9e2a89e9 — THE DATE THE CHANGE TOOK EFFECT, when the caller knows it (a movement's effective date).
     * Recorded on the AUDIT row only.
     *
     * ⚠️ IT IS NOT `asOf` AND MUST NOT BECOME IT. `asOf` decides WHAT IS PROJECTED — the cycle, the
     * service band, the window the already-posted days are summed over. Passing a backdated effective
     * date there would change the arithmetic, which is money and is not what the approved plan promises.
     * The ledger row's own `effectiveOn` stays at `asOf` for the same reason.
     */
    changeEffectiveOn?: string | null;
  },
): Promise<{ affected: number; totalDelta: number }> {
  const asOf = p.asOf ?? todayInKualaLumpur();
  const none = { affected: 0, totalDelta: 0 };
  return withTenant(ctx, async (tx) => {
    // 1. Resolve the employment + its company's country/leave-cycle context.
    const [emp] = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        terminatedOn: employment.terminatedOn,
        country: company.country,
        leaveCycle: company.leaveCycle,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(eq(employment.id, p.employmentId))
      .limit(1);
    if (!emp) return none;
    const pack = packFor(emp.country);
    if (!pack) return none;
    // Same live-in-cycle window guard the granting engines use: pre-hire or terminated-before-this-year
    // employments have nothing to correct in the current cycle.
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    if (emp.hiredOn > asOf) return none;
    if (emp.terminatedOn != null && emp.terminatedOn < yearStart) return none;

    // 2. Active leave types (a type with no accrual row this cycle is skipped by the materialized guard).
    // Leave Year Type override (e1a51aea): yearCycleOverride resolves each type's effective cycle below.
    const types = await tx
      // 9816a5ad step 2: the type's own rules ride along and are handed to the projection kernel below.
      .select({ id: leaveType.id, code: leaveType.code, yearCycleOverride: leaveType.yearCycleOverride, ...leaveTypeRuleColumns })
      .from(leaveType)
      .where(and(eq(leaveType.tenantId, ctx.tenantId), isNull(leaveType.archivedAt)));
    if (types.length === 0) return none;
    const typeIds = types.map((t) => t.id);

    // 3. THE ENTITLEMENT TEMPLATE LAYER for this ONE employment, resolved at `asOf`. Release three removed
    //    the two reads that stood here (every type's active `leave_policy` rows, and this employment's
    //    effective benefit scheme), so this is the whole entitlement resolution now.
    //
    //    This is the path an ordinary profile save triggers, so it is the path the "no opinion" guard has
    //    to be right on: a template that resolves is an OPINION and its days are what the projection
    //    expects; NOTHING resolving means post nothing at all, never zero.
    const templates = await buildTemplateEntitlementResolver(tx, {
      employmentIds: [p.employmentId],
      leaveTypeIds: typeIds,
      asOf,
    });

    // 4. This employment's ledger across all types (accrual grants + prior recalc adjustments) — the
    //    trailing ~12 months covers every possible cycle start (calendar Jan-1 and any anniversary month).
    //
    //    c8052ae3 — THE FETCH IS BOUNDED AT BOTH ENDS NOW, and `accrualTo` is the exact mirror of
    //    `accrualFrom`. The current cycle can start no later than asOf's own month-start (anniversary,
    //    hire month ≤ asOf month), so it can end no later than one year after that — which is precisely
    //    `accrualTo`. Every possible current cycle is inside [accrualFrom, accrualTo]; a grant written
    //    ahead for a LATER leave year is not, and can no longer be read as "already granted this cycle".
    //    The per-type `[windowStart, windowEnd]` filter below is the load-bearing bound; this one keeps
    //    the query from dragging years of future-dated rows into memory to be discarded in JS.
    const accrualFrom = `${Number(asOf.slice(0, 4)) - 1}-${asOf.slice(5, 7)}-01`;
    const accrualTo = `${Number(asOf.slice(0, 4)) + 1}-${asOf.slice(5, 7)}-01`;
    const ledgerRows = await tx
      .select({
        leaveTypeId: leaveLedger.leaveTypeId,
        entryType: leaveLedger.entryType,
        days: leaveLedger.days,
        effectiveOn: leaveLedger.effectiveOn,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.employmentId, p.employmentId),
          inArray(leaveLedger.leaveTypeId, typeIds),
          gte(leaveLedger.effectiveOn, accrualFrom),
          lte(leaveLedger.effectiveOn, accrualTo),
          or(
            eq(leaveLedger.entryType, 'accrual'),
            and(eq(leaveLedger.entryType, 'adjustment'), recalcAdjustmentReasonCond()),
          ),
        ),
      );
    const ledgerByType = new Map<string, { entryType: string; days: number; effectiveOn: string }[]>();
    for (const r of ledgerRows) {
      const row = { entryType: r.entryType, days: Number(r.days), effectiveOn: r.effectiveOn };
      const arr = ledgerByType.get(r.leaveTypeId);
      if (arr) arr.push(row);
      else ledgerByType.set(r.leaveTypeId, [row]);
    }

    // ADR-0069: never touch a balance frozen for encashment (the DB trigger would abort the whole tx).
    const frozenSet = await frozenSnapshotKeySet(tx, [p.employmentId], typeIds);

    let affected = 0;
    let totalDelta = 0;
    for (const type of types) {
      if (frozenSet.has(`${p.employmentId}|${type.id}`)) continue;
      // Leave Year Type override (e1a51aea): the kernel receives the EFFECTIVE cycle for this type — a
      // per-type 'a2a'/'c2c' override wins; null falls back to the company cycle (byte-identical).
      const projected = projectExpectedEntitlement(
        {
          hiredOn: emp.hiredOn,
          leaveCycle: resolveLeaveYearCycle(type.yearCycleOverride, emp.leaveCycle) ?? null,
          gradeId: emp.gradeId,
          companyId: emp.companyId,
        },
        type.code,
        (c, y) => pack.leave.entitlement(c, y),
        asOf,
        // f3a64d90: the RAW override — 'a2c' day-slices the hire-year ANNUAL projection.
        type.yearCycleOverride,
        // 9816a5ad step 2: every RULE comes from the leave TYPE; the template band supplies the DAYS.
        type,
        // 6e9a126e: this employee's winning template band — the only source of days there is.
        (years) => templates.bandFor(emp.employmentId, type.id, years),
      );
      if (!projected) continue;
      const { expected, windowStart, windowEnd } = projected;

      // f3a64d90: DELEGATE a2c's first ANNUAL year to reprojectA2cEntitlement — it posts ACCRUAL-class rows
      // (this path's `adjustment` never moves YTD Entitled) and reconciles the superseded system rows.
      if (isA2cFirstYear(type.yearCycleOverride, type.code, emp.hiredOn, asOf)) {
        const a2c = await reprojectA2cEntitlement(tx, ctx, {
          leaveTypeId: type.id,
          employmentIds: [p.employmentId],
          asOf,
          trigger: p.trigger,
          // 9e2a89e9 — the same record, whichever kernel posts the correction. `newGradeId` is passed
          // explicitly because that function sweeps a cohort and cannot read one employment's grade.
          gradeBefore: p.gradeBefore,
          newGradeId: emp.gradeId ?? null,
          changeEffectiveOn: p.changeEffectiveOn ?? null,
        });
        affected += a2c.affected;
        totalDelta = round2(totalDelta + a2c.totalDelta);
        continue;
      }

      // ⚠️ c8052ae3 — THE CLOSED INTERVAL. This filter read `>= windowStart` ONLY, and that single
      // missing bound is the whole of the reported fault: a tenant with the 2027 and 2028 leave years
      // already opened had those years' 1-January accruals summed into `alreadyPosted` as though they
      // were this cycle's, so `expected − alreadyPosted` came out as a large NEGATIVE and every ordinary
      // profile save (grade, employment details, confirmation) posted a clawback. Measured on production:
      // Hospitalization read 180.00 already-granted against a 60.00 expectation and posted −120.00.
      // Both ends, always — a row dated outside this cycle belongs to the cycle that owns it.
      const inWindow = (ledgerByType.get(type.id) ?? []).filter(
        (r) => r.effectiveOn >= windowStart && r.effectiveOn <= windowEnd,
      );
      // Materialized-only guard: no `accrual` row this cycle ⇒ nothing granted yet ⇒ nothing to correct.
      if (!inWindow.some((r) => r.entryType === 'accrual')) continue;
      const alreadyPosted = round2(inWindow.reduce((s, r) => s + r.days, 0));
      const delta = round2(expected - alreadyPosted);
      if (delta === 0) continue;

      const [row] = await tx
        .insert(leaveLedger)
        .values({
          tenantId: ctx.tenantId,
          employmentId: p.employmentId,
          leaveTypeId: type.id,
          entryType: 'adjustment',
          days: delta.toFixed(2),
          effectiveOn: asOf,
          reason: `${PROFILE_RECALC_REASON_PREFIX}:${p.employmentId}`,
        })
        .returning({ id: leaveLedger.id });
      // Audit-history row (the human-readable trail: previous → new entitlement, why, effective date).
      // 9e2a89e9 — plus the two GRADES the change moved between and the date it TOOK EFFECT, when the
      // caller declared them. `effectiveOn` keeps its meaning (when the correction was posted);
      // `changeEffectiveOn` carries the other date, and the screen prints the second falling back to the
      // first. The grades are written as a PAIR or not at all — see `gradeBefore` on the signature.
      await tx.insert(leaveEntitlementRecalcAudit).values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        leaveTypeId: type.id,
        previousEntitlement: alreadyPosted.toFixed(2),
        newEntitlement: expected.toFixed(2),
        delta: delta.toFixed(2),
        reason: p.trigger,
        effectiveOn: asOf,
        // Only when it describes the cycle these figures describe — see `changeDateWithinCycle`.
        changeEffectiveOn: changeDateWithinCycle(p.changeEffectiveOn, windowStart, windowEnd),
        previousGradeId: p.gradeBefore ? (p.gradeBefore.gradeId ?? null) : null,
        newGradeId: p.gradeBefore ? (emp.gradeId ?? null) : null,
        ledgerId: row.id,
      });
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'leave-ledger',
        aggregateId: row.id,
        eventType: 'leave.entitlement.recalculated',
        actor: actorOf(ctx),
        subjectEmploymentId: p.employmentId,
        payload: {
          employmentId: p.employmentId,
          leaveTypeId: type.id,
          before: alreadyPosted,
          after: expected,
          delta,
          cycleStart: windowStart,
          reason: 'profile_recalc',
          trigger: p.trigger,
        },
      });
      affected += 1;
      totalDelta = round2(totalDelta + delta);
    }
    return { affected, totalDelta };
  });
}

/**
 * bc36c768 — THE CATCH-UP TRIGGER, fired when a leave type's earning method is saved and the
 * NOT-CONFIGURED marker is cleared, and (6e9a126e release three) when an entitlement TEMPLATE or an
 * ELIGIBILITY RULE for the type is written. It is the only configuration-side cohort recalc left: the
 * scheme-side one (`reprojectEntitlementForSchemeCohort`) and the policy-side one
 * (`reprojectEntitlementForPolicy`) went with the tables that triggered them.
 *
 * WHY IT HAD TO BE BUILT RATHER THAN ASSUMED. The reporter is promised that an employee hired while a
 * type is unconfigured is credited +0.00 and loses nothing, because configuring the type "then runs a
 * one-off correction across everyone on it, there and then". No code provided that: `setLeaveTypeRules`
 * did `tx.update` + `appendEvent` and returned, with no reprojection anywhere. A type set back to None
 * would therefore have sat at +0.00 for every affected joiner until some unrelated event happened to fire
 * `reprojectEntitlementForEmployment` for them. The whole safety argument for the NOT-CONFIGURED state is
 * that its under-credit CORRECTS ITSELF; this is what makes that sentence true.
 *
 * COHORT RESOLUTION IS A DELIBERATE SUPERSET — every live employment, not only those an eligibility rule
 * for this type matches. An unaffected employee computes delta 0 and posts nothing, whereas a cohort
 * filter that got the resolution order subtly wrong would silently leave someone at +0.00 with no signal. (It is also the honest shape:
 * `reprojectEntitlementForEmployment` recalculates ALL of an employment's types in one pass, so there is
 * no per-type narrowing to be had inside it either. `leaveTypeId` is carried for the audit trigger and
 * because a future narrowing belongs behind this signature, not beside it.)
 *
 * MUST BE CALLED AFTER THE CONFIG-WRITE TRANSACTION HAS COMMITTED, never inside it — each per-employee
 * recalc opens its OWN transaction and reads the committed configuration, so calling it inside the write
 * would have every employee reproject against the PRE-save rules. The action does this, and a test
 * asserts the ordering rather than trusting the call site.
 *
 * BLAST RADIUS, stated to the reporter in plain words: this posts `sys:profile_recalc:` rows for everyone
 * on that leave type at the moment the method is saved. That is the moment balances move, and it is
 * deliberate — configure a leave type when you are ready for balances to change, not mid-pay-run.
 *
 * ⚠️ WHAT IT DOES NOT REACH, and this is a real gap rather than a caveat. `reprojectEntitlementForEmployment`
 * carries a MATERIALIZED-ONLY guard ("no accrual row this cycle ⇒ nothing granted yet ⇒ nothing to
 * correct"), so an employee hired DURING the unconfigured window — who by construction has no accrual row
 * on that type — is skipped by this catch-up. Precisely who that affects: a joiner during the window on a
 * type later configured as NONE (the lump path). An EARNED type catches them up on the very next accrual
 * run, which has no such guard and grants from zero; a lump joiner waits for the next year-open. The
 * EXISTING workforce, which is who the reset is really about, is trued up correctly.
 *
 * Removing the materialized-only guard is NOT the fix to reach for: it is shared by both recalc kernels,
 * it is what stops a reproject fabricating grants for cycles no engine ever materialised, and 49809272's
 * tests pin it. Closing this properly means re-running the HIRE GRANT for the affected joiners, which is a
 * new writer and its own item. test/leave-earning-method-simplified.test.ts pins the gap so it cannot be
 * quietly forgotten or quietly "fixed" by loosening the guard.
 *
 * Sequential + best-effort per employee (log and continue): a rare admin operation, and one frozen or
 * hiccuping employment must never abort the rest of the cohort.
 */
export async function reprojectEntitlementForLeaveTypeCohort(
  ctx: SessionContext,
  p: { leaveTypeId: string; trigger: string; asOf?: string },
): Promise<{ employees: number; affected: number; totalDelta: number }> {
  const asOf = p.asOf ?? todayInKualaLumpur();
  // Read-only candidate resolution (no events — CLAUDE.md skip rule). The SAME live-in-cycle window guard
  // the granting engines use; reprojectEntitlementForEmployment re-checks it per employment anyway.
  const empIds = await withTenant(ctx, async (tx) => {
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    const rows = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(
        and(
          lte(employment.hiredOn, asOf),
          or(isNull(employment.terminatedOn), gte(employment.terminatedOn, yearStart)),
        ),
      );
    return rows.map((r) => r.id);
  });

  let affected = 0;
  let totalDelta = 0;
  for (const employmentId of empIds) {
    try {
      const res = await reprojectEntitlementForEmployment(ctx, { employmentId, asOf, trigger: p.trigger });
      affected += res.affected;
      totalDelta = round2(totalDelta + res.totalDelta);
    } catch (e) {
      // Best-effort per employee: the recalc is idempotent and self-heals on the next trigger — one
      // failing employment must not abort the rest of the cohort.
      console.error(`leave-type-cohort recalc failed for employment ${employmentId} (type ${p.leaveTypeId}):`, e);
    }
  }
  return { employees: empIds.length, affected, totalDelta };
}

/**
 * R45 7527ea5f — the profile-change recalculation history for one employment (newest first), joined to
 * the leave-type name for display. Read-only (RLS: tenant-read), no events.
 *
 * 9e2a89e9 — it now also answers WHICH GRADES the change moved between and WHEN THAT CHANGE TOOK EFFECT.
 * Both grade joins are LEFT joins and the id is returned beside the name: the audit row carries no
 * foreign key (a grade may be archived or deleted, and a history that tidying the catalogue can erase is
 * not a history), so "the grade is gone" must render as an em dash rather than dropping the whole row —
 * which an inner join would do, silently, to exactly the oldest records.
 *
 * `tookEffectOn` is the one date a screen should print: the change's own effective date where the writer
 * knew it, otherwise the date the correction was posted. Both are returned so a reader can tell which it
 * got, and `effectiveOn` keeps its original meaning for every row ever written.
 */
export async function listEntitlementRecalcAudit(
  ctx: SessionContext,
  employmentId: string,
): Promise<
  {
    id: string;
    leaveTypeId: string;
    leaveTypeName: string;
    previousEntitlement: number;
    newEntitlement: number;
    delta: number;
    reason: string;
    effectiveOn: string;
    /** 9e2a89e9 — when the underlying change took effect, or null where the writer had no such date. */
    changeEffectiveOn: string | null;
    /** `changeEffectiveOn ?? effectiveOn` — what the "Took effect" column prints. */
    tookEffectOn: string;
    previousGradeId: string | null;
    newGradeId: string | null;
    /** Null when no grade pair was recorded, AND when the grade has since left the catalogue. */
    previousGradeName: string | null;
    newGradeName: string | null;
    /** True when this row records a grade change at all — the two names may still be null (deleted). */
    gradeChanged: boolean;
    createdAt: string;
  }[]
> {
  return withTenant(ctx, async (tx) => {
    const previousGrade = aliasedTable(jobGrade, 'previous_grade');
    const newGrade = aliasedTable(jobGrade, 'new_grade');
    const rows = await tx
      .select({
        id: leaveEntitlementRecalcAudit.id,
        leaveTypeId: leaveEntitlementRecalcAudit.leaveTypeId,
        leaveTypeName: leaveType.name,
        previousEntitlement: leaveEntitlementRecalcAudit.previousEntitlement,
        newEntitlement: leaveEntitlementRecalcAudit.newEntitlement,
        delta: leaveEntitlementRecalcAudit.delta,
        reason: leaveEntitlementRecalcAudit.reason,
        effectiveOn: leaveEntitlementRecalcAudit.effectiveOn,
        changeEffectiveOn: leaveEntitlementRecalcAudit.changeEffectiveOn,
        previousGradeId: leaveEntitlementRecalcAudit.previousGradeId,
        newGradeId: leaveEntitlementRecalcAudit.newGradeId,
        previousGradeName: previousGrade.name,
        newGradeName: newGrade.name,
        createdAt: leaveEntitlementRecalcAudit.createdAt,
      })
      .from(leaveEntitlementRecalcAudit)
      .innerJoin(leaveType, eq(leaveType.id, leaveEntitlementRecalcAudit.leaveTypeId))
      .leftJoin(previousGrade, eq(previousGrade.id, leaveEntitlementRecalcAudit.previousGradeId))
      .leftJoin(newGrade, eq(newGrade.id, leaveEntitlementRecalcAudit.newGradeId))
      .where(
        and(
          eq(leaveEntitlementRecalcAudit.tenantId, ctx.tenantId),
          eq(leaveEntitlementRecalcAudit.employmentId, employmentId),
        ),
      )
      .orderBy(desc(leaveEntitlementRecalcAudit.createdAt));
    return rows.map((r) => ({
      id: r.id,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: r.leaveTypeName,
      previousEntitlement: Number(r.previousEntitlement),
      newEntitlement: Number(r.newEntitlement),
      delta: Number(r.delta),
      reason: r.reason,
      effectiveOn: r.effectiveOn,
      changeEffectiveOn: r.changeEffectiveOn ?? null,
      tookEffectOn: r.changeEffectiveOn ?? r.effectiveOn,
      previousGradeId: r.previousGradeId ?? null,
      newGradeId: r.newGradeId ?? null,
      previousGradeName: r.previousGradeName ?? null,
      newGradeName: r.newGradeName ?? null,
      // A grade CHANGE was recorded when either id is present. "From no grade to GRADE 16" is a real
      // change and its `previousGradeId` is legitimately null, so presence of either is the test.
      gradeChanged: r.previousGradeId != null || r.newGradeId != null,
      createdAt: r.createdAt.toISOString(),
    }));
  });
}

// ── Carry reconstruction (shared by expireCarriedLeave + the read-only breakdown view) ─────────────
/**
 * Pure reconstruction of the carried-forward ANNUAL quantity for one leave year, derived ENTIRELY from
 * the flat signed ledger — no tags, no new schema (ADR-0038). Inputs:
 *  - priorYearEndBalance — the signed ledger balance immediately before the year's Jan-1 open.
 *  - carryMax            — the policy's carryForwardMax cap.
 *  - debitsInWindow      — total ANNUAL days TAKEN inside [yearStart, expiryDate] (a positive number).
 *  - currentBalance      — the signed ledger balance as at the point being evaluated.
 * Returns:
 *  - carried          = min(max(priorYearEndBalance, 0), carryMax)  — what openLeaveYear posted at open.
 *  - unconsumedCarry  = max(0, round2(carried − debitsInWindow))     — carry still un-eaten in the window.
 *  - forfeitable      = round2(min(unconsumedCarry, max(0, currentBalance))) — never taxes fresh
 *    entitlement, never double-forfeits already-taken days (the WEAKER, balance-based forfeit rule).
 * This is the single source of truth for both the cron sweep and the read; keeping the arithmetic here
 * guarantees the breakdown can never diverge from what expireCarriedLeave actually forfeits.
 */
export function reconstructCarry(p: {
  priorYearEndBalance: number;
  carryMax: number;
  /** 7cd914b1 — the percentage rule, when the type carries by percentage rather than a flat cap. Absent ⇒
   *  the cap alone decides, which is every pre-7cd914b1 caller and every pre-7cd914b1 leave year. */
  carryPercent?: number | null;
  debitsInWindow: number;
  currentBalance: number;
}): { carried: number; unconsumedCarry: number; forfeitable: number } {
  // Shared with openLeaveYear through carryAllowanceFrom: this reconstruction exists to say what the
  // engine POSTED, so it must not be a second opinion about it.
  const carried = carryAllowanceFrom({
    balance: p.priorYearEndBalance,
    carryMax: p.carryMax,
    carryPercent: p.carryPercent,
  });
  const unconsumedCarry = Math.max(0, round2(carried - p.debitsInWindow));
  const forfeitable = round2(Math.min(unconsumedCarry, Math.max(0, p.currentBalance)));
  return { carried, unconsumedCarry, forfeitable };
}

/**
 * Carry-forward-report feature — the per-employment carry/expiry/forfeit computation shared by
 * `leaveEntitlementBreakdown` (core/read.ts) and the new `carryForwardReport` (core/analytics.ts).
 * Extracted verbatim from `leaveEntitlementBreakdown` so its output is byte-identical to before the
 * extraction (existing 363-line breakdown test suite is the regression gate — see ORDERED STEPS #2 in
 * the approved plan). Pure — no DB access; callers resolve the cycle start, the winning policy, and the
 * ledger aggregates (prior balance / debits-in-window / current balance) and pass them in here.
 *
 * `carryMax`/`expiry` should already be zeroed/nulled by the caller for non-ANNUAL types (only ANNUAL
 * carries — see openLeaveYear/expireCarriedLeave), so this helper does not re-check the leave-type code.
 */
export function resolveCarryBreakdown(p: {
  cycleStart: string;
  carryMax: number;
  /** 7cd914b1 — the percentage rule, resolved from the same winning policy as carryMax. */
  carryPercent?: number | null;
  /** {month, day} OFFSET, or null (never expires). Already resolved from the winning policy. */
  expiry: CarryExpiry | null;
  priorBalanceAtCycleStart: number;
  debitsInWindow: number;
  currentBalance: number;
  /** The date this reconstruction is evaluated as-at (drives whether the expiry has "passed"). */
  asOf: string;
}): {
  /** {cycleYear}-{expiry.month}-{expiry.day} (clamped to a real calendar day), or null. */
  carryForwardExpiryDate: string | null;
  /** min(max(priorBalance,0), carryMax) — what openLeaveYear posted at this cycle's open. */
  carried: number;
  /** Cap-excess forfeited AT OPEN: max(0, priorBalance − carried). */
  capExcess: number;
  /** How much of `carried` is still un-consumed as at `asOf` (0 once the expiry has passed). */
  unconsumedCarry: number;
  /** Realised expiry forfeit — 0 until the expiry date has arrived (≤ asOf), else the reconstructed
   *  forfeitable amount (min(unconsumedCarry, max(0, currentBalance))). */
  expiryForfeit: number;
  /** capExcess + expiryForfeit, rounded to 2dp. */
  forfeited: number;
} {
  const cycleYear = p.cycleStart.slice(0, 4);
  // 7cd914b1: `carryMax > 0` was the "does this type carry at all" test. A percentage-only type has no cap
  // and must still get an expiry date, or what it carried would never expire.
  const carryForwardExpiryDate =
    carryConfigured({ carryMax: p.carryMax, carryPercent: p.carryPercent }) && p.expiry
      ? `${cycleYear}-${String(p.expiry.month).padStart(2, '0')}-${String(
          Math.min(p.expiry.day, lastRealDayOfMonth(Number(cycleYear), p.expiry.month)),
        ).padStart(2, '0')}`
      : null;
  const { carried, unconsumedCarry: unconsumedRaw, forfeitable } = reconstructCarry({
    priorYearEndBalance: p.priorBalanceAtCycleStart,
    carryMax: p.carryMax,
    carryPercent: p.carryPercent,
    debitsInWindow: p.debitsInWindow,
    currentBalance: p.currentBalance,
  });
  const capExcess = Math.max(0, round2(Math.max(p.priorBalanceAtCycleStart, 0) - carried));
  const expiryPassed = carryForwardExpiryDate != null && carryForwardExpiryDate <= p.asOf;
  const expiryForfeit = expiryPassed ? forfeitable : 0;
  const forfeited = round2(capExcess + expiryForfeit);
  const unconsumedCarry = expiryPassed ? 0 : unconsumedRaw;
  return { carryForwardExpiryDate, carried, capExcess, unconsumedCarry, expiryForfeit, forfeited };
}

// ── Carry-forward expiry / auto-forfeit (ADR-0038 carry-forward enhancement) ───────────────────────
/**
 * Forfeit the still-unused carried-forward ANNUAL days whose configured expiry date has arrived.
 *
 * Design rationale (the panel-refined model — read before changing):
 *  - "Maximum Carry Forward Days" already exists: openLeaveYear (and the earned path) cap the carry at
 *    `carryForwardMax` at year-open and forfeit the excess. This function adds the SECOND, later forfeit
 *    of whatever survived the cap but stayed UNUSED past the policy's expiry date.
 *  - Expiry is configured as a month+day OFFSET on the policy JSONB (carryForwardExpiryMonth/Day), not a
 *    hardcoded date — so it holds for any leave-year start. The carry posted at year-open Y expires on
 *    {Y}-{month}-{day} (e.g. carry into 2026 expires 2026-03-31).
 *  - NO new schema / enum value / tagged "carry lot" row. The carried days stay folded into the plain
 *    `accrual` row that openLeaveYear already posts, so read aggregates (accrued/taken) and the earned
 *    path's `already`-sum are untouched. We RECONSTRUCT the carried quantity the same way openLeaveYear
 *    computed it: carriedAmount = min(max(priorYearEndBalance, 0), carryForwardMax).
 *  - WEAKER (correct) forfeit rule — NO consumption-ordering claim: there is no debit→accrual tag in the
 *    flat signed ledger, so we cannot say "the carry was consumed first/last". We forfeit only what is
 *    *still in the balance*: forfeit = min(unconsumedCarry, max(0, currentBalance)). This never taxes the
 *    fresh entitlement and never double-forfeits already-taken days.
 *  - Back-compat: only carry whose origin year-open is on/after the policy's validFrom year is swept;
 *    the reconstruction window is bounded to [yearStart, expiryDate] of the cycle being expired, so prior
 *    years are not retroactively swept. No backfill of legacy carry.
 *
 * Idempotency: the forfeit `adjustment` is dated at the YEAR-QUALIFIED expiry date of the cycle being
 * swept (not just month/day) so consecutive years (each ending e.g. 03-31) forfeit independently. We
 * compute the intended forfeit first and only treat an existing adjustment at that exact date as the
 * prior sweep when there would otherwise be something to forfeit — so a manual unrelated adjustment on
 * the same date does not suppress the real sweep.
 *
 * SYSTEM context (cron path): the negative-adjustment ledger inserts follow the deliberate-skip
 * convention in openLeaveYear/accrueEarnedLeave (ledger rows are the per-item audit). One summary
 * DomainEvent is appended below.
 */
export async function expireCarriedLeave(ctx: SessionContext, p: { today: string }) {
  return withTenant(ctx, async (tx) => {
    const todayYear = Number(p.today.slice(0, 4));
    const annualTypes = await tx
      // 9816a5ad step 2: the type's own carry-forward rules drive both the sweepable-year boundary and the
      // per-year expiry decision below.
      .select({ id: leaveType.id, code: leaveType.code, ...leaveTypeRuleColumns })
      .from(leaveType)
      .where(and(eq(leaveType.code, 'ANNUAL'), isNull(leaveType.archivedAt)));
    if (annualTypes.length === 0) return { swept: 0, forfeited: 0 };
    const typeIds = annualTypes.map((t) => t.id);

    const emps = await tx
      .select({
        employmentId: employment.id,
        hiredOn: employment.hiredOn,
        gradeId: employment.gradeId,
        companyId: employment.companyId,
        terminatedOn: employment.terminatedOn,
      })
      .from(employment)
      .innerJoin(company, eq(company.id, employment.companyId))
      .where(and(lte(employment.hiredOn, p.today), or(isNull(employment.terminatedOn), gte(employment.terminatedOn, `${todayYear}-01-01`))));
    if (emps.length === 0) return { swept: 0, forfeited: 0 };
    const empIds = emps.map((e) => e.employmentId);

    // HOW FAR BACK MAY THIS SWEEP REACH — the back-compat boundary, and the "is anything configured at
    // all" gate rolled into one.
    //
    // ⚠️ THIS IS A WRITER, NOT A READER, and an early return here means the sweep SILENTLY STOPS SWEEPING:
    // days that should have expired sit in balances forever, with no error and no log line. Release two
    // added the entitlement_template limb beside the two leave_policy ones for exactly that reason;
    // release three removed the leave_policy ones with the table, leaving the template version as the only
    // boundary candidate there is.
    const earliestTemplate = await earliestTemplateYear(tx, typeIds);
    if (earliestTemplate == null) return { swept: 0, forfeited: 0 };

    // 9816a5ad step 2: the carry expiry lives on the leave TYPE. Routed through the same overlay the sweep
    // itself uses, so the boundary and the per-year decision can never disagree about whether an expiry
    // exists. Whether it actually applies is still decided per swept year by `pol?.carryExpiry` inside the
    // loop, so this only widens the window the loop is allowed to look at, never what it forfeits. A
    // template adds no second carry definition (see db/schema.ts's entitlement_template note), so the type
    // is the only thing to ask.
    const typeCarriesExpiry = (t: (typeof annualTypes)[number]): boolean =>
      applyLeaveTypeRules({ days: 0, carryMax: 0 }, t)?.carryExpiry != null;
    if (!annualTypes.some(typeCarriesExpiry)) return { swept: 0, forfeited: 0 };
    const earliestYear = earliestTemplate;

    // ADR-0069: skip (employment, ANNUAL type) pairs with an ACTIVE frozen encashment snapshot.
    const frozenSet = await frozenSnapshotKeySet(tx, empIds, typeIds);

    // 6e9a126e — ONE template resolver PER SWEPT LEAVE YEAR, memoised. The sweep walks
    // employments x types x years, and the year is the only axis the resolution depends on: which template
    // version and which eligibility rule were in force at `${y}-01-01`, and which department / position the
    // employee held THEN. Building it inside the innermost loop would rebuild it per employee; hoisting it
    // out of the year loop would answer every closed year with the current year's configuration, which is
    // precisely the capability this item was told to keep. A tenant with no templates pays one indexed
    // query per year and gets the `isEmpty` short-circuit.
    const templateByYear = new Map<string, Awaited<ReturnType<typeof buildTemplateEntitlementResolver>>>();
    const templatesAt = async (yearOpen: string) => {
      const hit = templateByYear.get(yearOpen);
      if (hit) return hit;
      const built = await buildTemplateEntitlementResolver(tx, {
        employmentIds: empIds,
        leaveTypeIds: typeIds,
        asOf: yearOpen,
      });
      templateByYear.set(yearOpen, built);
      return built;
    };

    let swept = 0;
    let forfeitedTotal = 0;
    for (const e of emps) {
      for (const t of annualTypes) {
        if (frozenSet.has(`${e.employmentId}|${t.id}`)) continue; // ADR-0069: balance frozen for encashment
        // Sweep each candidate leave year Y from the back-compat boundary up to today whose expiry date has
        // arrived. Each year is independently reconstructed + idempotent on its own year-qualified date.
        for (let y = earliestYear; y <= todayYear; y++) {
          const yearStart = `${y}-01-01`;
          // Leave Entitlement Rules Engine: service length AS OF THIS SWEPT YEAR's open (not today) — a
          // band-vs-flat winner flip is only reachable when the employee's service band differed at that
          // year's open, so this must be computed per-y inside the loop, not hoisted.
          // 9816a5ad step 2: carry cap, enable flag and expiry all come from the leave TYPE now.
          // 6e9a126e: the ENTITLEMENT TEMPLATE version in force at THAT year's open, resolved with that
          // year's eligibility (department / position / employment type as at then, not today's) —
          // `templatesAt` above is memoised per swept year for exactly that reason. It is laid under the
          // type's rules through the same one composition every engine uses.
          const pol = applyLeaveTypeRules(
            policyFromTemplateBand(
              (await templatesAt(yearStart)).bandFor(e.employmentId, t.id, serviceYearsAt(e.hiredOn, yearStart)),
            ),
            t,
          );
          // Carry-forward enhancement: a policy whose carry rule is explicitly disabled never carries
          // anything (openLeaveYear forfeits the whole prior balance at open), so there is nothing for
          // the later expiry sweep to forfeit — skip even if a stale expiry offset is still populated.
          if (!carryEnabled(pol)) continue;
          const expiry = pol?.carryExpiry ?? null;
          if (!expiry) continue;
          // R4 Build #1 crash fix: clamp the offset `day` to the real last day of `expiry.month` in THIS
          // leave-year so the emitted date is always a real calendar day. This covers months-mode (day=31
          // sentinel ⇒ the month's true last day), a date-mode 29-Feb in a common year (⇒ 28 Feb), and any
          // legacy garbage that survives `parseCarryExpiry`. Without it, an impossible date (e.g. 2027-02-29)
          // would insert into a `date` column and abort the whole tenant sweep.
          const dd = Math.min(expiry.day, lastRealDayOfMonth(y, expiry.month));
          const expiryDate = `${y}-${String(expiry.month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          if (expiryDate > p.today) continue; // not yet due
          // Only sweep a year whose leave-year was actually OPENED: openLeaveYear posts the year's grant
          // as an accrual row (its own open-marker). Without that marker no carry was ever posted for this
          // year, so there is nothing to expire (back-compat: a year never run is never retroactively
          // swept).
          //
          // ⚠️ r193 — THIS WAS `effectiveOn = yearStart` AND IT WAS A SECOND, SILENT LANDMINE. The plan for
          // this round named the idempotency guard in openLeaveYear and missed this one, which keys on the
          // SAME row. Once a grant can land on the table's start date or the employee's join date instead
          // of 1 January, a marker looking for a 1-January row finds nothing — and this sweep would have
          // stopped expiring carried leave for exactly the tenants the round unblocks, with no error and
          // no log line (the comment above says so: an early return here means days sit in balances
          // forever). Shared predicate, so the two engines cannot drift apart again.
          const [openMarker] = await tx
            .select({ n: sql<string>`count(*)` })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                yearOpenMarkerCond(yearStart, `${y}-12-31`),
              ),
            );
          if (Number(openMarker?.n ?? 0) === 0) continue;
          // The carried amount openLeaveYear posted at this year-open: prior-year-end balance, capped.
          // 7cd914b1: `carryMax <= 0` was the "nothing could have carried" short-circuit. A percentage-only
          // type has no cap and DOES carry, so the question is now whether carry is configured at all —
          // otherwise the sweep would skip exactly the types this item introduced and their carry would
          // never expire.
          const carryMax = pol!.carryMax;
          const carryPercent = pol!.carryPercent ?? null;
          if (!carryConfigured({ carryMax, carryPercent })) continue; // nothing could have carried
          const [priorRow] = await tx
            .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
            .from(leaveLedger)
            .where(and(eq(leaveLedger.employmentId, e.employmentId), eq(leaveLedger.leaveTypeId, t.id), lt(leaveLedger.effectiveOn, yearStart)));
          const priorYearEndBalance = Number(priorRow?.bal ?? 0);
          if (carryAllowanceFrom({ balance: priorYearEndBalance, carryMax, carryPercent }) <= 0) continue;
          // Annual debits inside [yearStart, expiryDate] reduce the still-unconsumed carry. (Weaker rule:
          // no ordering claim — just "how much of the window's leave could have eaten the carry".)
          const [debitRow] = await tx
            .select({ taken: sql<string>`coalesce(-sum(${leaveLedger.days}), 0)` })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                eq(leaveLedger.entryType, 'debit'),
                gte(leaveLedger.effectiveOn, yearStart),
                lte(leaveLedger.effectiveOn, expiryDate),
              ),
            );
          const debitsInWindow = Number(debitRow?.taken ?? 0);
          // Cap at what is actually still in the balance now — never tax fresh entitlement / re-forfeit.
          const currentBalance = await leaveBalance(tx, e.employmentId, t.id);
          const { unconsumedCarry, forfeitable: forfeit } = reconstructCarry({
            priorYearEndBalance,
            carryMax,
            carryPercent,
            debitsInWindow,
            currentBalance,
          });
          if (unconsumedCarry <= 0) continue;
          if (forfeit <= 0) continue;
          // Idempotency (year-qualified): if a forfeit adjustment of this magnitude already sits at exactly
          // this expiry date, this year was already swept — skip. A manual unrelated adjustment of a
          // DIFFERENT amount does not match, so the real sweep still fires.
          const priorSweeps = await tx
            .select({ days: leaveLedger.days })
            .from(leaveLedger)
            .where(
              and(
                eq(leaveLedger.employmentId, e.employmentId),
                eq(leaveLedger.leaveTypeId, t.id),
                eq(leaveLedger.entryType, 'adjustment'),
                eq(leaveLedger.effectiveOn, expiryDate),
              ),
            );
          if (priorSweeps.some((r) => Number(r.days) === -forfeit)) continue;
          await tx.insert(leaveLedger).values({
            tenantId: ctx.tenantId,
            employmentId: e.employmentId,
            leaveTypeId: t.id,
            entryType: 'adjustment',
            days: (-forfeit).toFixed(2),
            effectiveOn: expiryDate,
            reason: CARRY_FORFEIT_REASON_EXPIRY,
          });
          swept += 1;
          forfeitedTotal = Math.round((forfeitedTotal + forfeit) * 100) / 100;
        }
      }
    }

    // One summary event; the ledger rows are the per-item audit (deliberate substrate skip, as
    // openLeaveYear / accrueEarnedLeave).
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-year',
      aggregateId: ctx.tenantId,
      eventType: 'leave.carry-forward.swept',
      actor: actorOf(ctx),
      payload: { today: p.today, swept, forfeited: forfeitedTotal },
    });
    return { swept, forfeited: forfeitedTotal };
  });
}

// ═════════════════════ Festive / one-off leave grant (ADR-0066, Model 3) ═════════════════════
// A festive grant credits N extra days to EVERY active employee in a chosen (company, leave_type) on a chosen
// date, with a human reason (e.g. "CNY 2026"). No new table: each grant is one `leaveLedger` `adjustment`
// (+days) per targeted employment + ONE summary DomainEvent. Festive leave types are expected to live OUTSIDE
// STANDING_LEAVE_CODES (and, since r299, outside Annual Leave, the only type the earned sweep covers) so the
// accrual / openLeaveYear / expiry engines never touch them (deliberate — see
// ADR-0066: this is why festive days escape annual carry-cap/forfeit). Expiry clawback is DEFERRED; `expiresOn`
// is accepted and stored only as a payload/reason note (no sweep this pass).



