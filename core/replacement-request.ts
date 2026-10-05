/**
 * 296fc027 · THE EMPLOYEE REPLACEMENT-LEAVE REQUEST — submit, decide, and grant on approval.
 *
 * WHAT THIS ADDS THAT DID NOT EXIST. Until now a replacement-leave credit could only be created by a
 * MANAGER: elected off the roster (`accrueToil`), or banked automatically when a rest-day attendance
 * correction was approved (`maybeAutoAccrueOnApprovalTx`). An employee could not ask for one at all. This
 * module is the employee's path in: they declare the dates they worked, a line manager approves, and the
 * credit is minted at that moment with its expiry counted from THE APPROVAL.
 *
 * FOUR CONTROLS, AND WHERE EACH ONE LIVES — because the whole risk of a self-service button is that it
 * becomes a way around a control the manager route enforces.
 *
 *  1. THE MODULE. Replacement leave is a chargeable add-on. `assertModuleEnabled` refuses a submission
 *     without it, so the page stays visible and read-only and no new credits are granted.
 *
 *  2. THE EMPLOYEE-REQUEST SWITCH. Off by default. Checked HERE, in the service, not only in the UI —
 *     hiding the button is a courtesy, refusing the POST is the control, and a server action is one
 *     `curl` away from the hidden button being irrelevant.
 *
 *  3. ELIGIBILITY. Resolved through core/replacement-eligibility.ts AS OF the submission date, so an
 *     employee who transferred out of a qualifying department last week is judged on the assignment they
 *     actually held. Checked at submit AND re-checked at approval against the SAME date — never against
 *     the org chart as it stands on approval day, which would let a transfer invalidate a request the
 *     employee already made correctly.
 *
 *  4. THE FIRST SCHEDULE GATE, which is a LEGAL one and the reason this file is careful. An employee at
 *     or below the statutory overtime protection threshold is entitled to overtime CASH, not banked time.
 *     They may bank it only where the company has switched the override on AND their own agreement is
 *     recorded. It is checked at SUBMIT so the employee is told immediately rather than after a manager's
 *     approval, and — this is the part that matters — it is checked AGAIN at approval, inside
 *     `bankToilCreditTx`, which is shared verbatim with the manager route. The submit-time check is a
 *     courtesy; the accrual-time one is the guarantee, and it cannot be bypassed by any caller because it
 *     sits below the fork where both paths meet.
 *
 * NOT MODELLED AS A `leave_request`. See migration 0381's header: `leave_request` means TIME TAKEN in the
 * balance check, the calendar and payroll's unpaid days, and this is a claim for time already worked.
 *
 * APPROVAL IS `assertCanDecide`, NOT THE MULTI-LEVEL TEMPLATE CHAIN. The approved plan states the
 * reporter asked for line-manager approval only, and `assertCanDecide` (core/approvals.ts) is exactly
 * that — admin-or-active-administrative-manager with a self-grant ban — already shared between leave and
 * attendance corrections. `core/leave-approval-template.ts`'s workflow chain is deliberately not used;
 * if that is ever wanted it is a different ticket with a different answer for what a partial approval of
 * a multi-date request would even mean.
 */
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { assertCanDecide } from './approvals';
import {
  company,
  compensation,
  employment,
  person,
  replacementLeaveRequest,
  replacementLeaveRequestDate,
  toilAccrual,
  toilPolicy,
  LEGACY_CLAIM_SOURCE_TYPE,
  type ReplacementClaimSourceType,
  type ReplacementLeaveRequestStatus,
  type ReplacementLeaveRequestUnit,
  type ToilWorkedDayKind,
} from '../db/schema';
import { packFor } from '../localization/registry';
import { assertModuleEnabled, isModuleEnabled } from './entitlements';
import { isReplacementRequestEligibleTx } from './replacement-eligibility';
import {
  accrueExtendedWorkdayToilTx,
  accrueSelfDeclaredToilTx,
  eligibleExtendedMinutes,
  extendedHoursCreditDays,
  extendedHoursDayForEmploymentTx,
  extendedHoursPolicyForCompanyTx,
  LeaveCreditSectionMismatchError,
  resolveWorkedDayKindTx,
  ToilAlreadyAccruedError,
  ToilExtendedHoursBelowThresholdError,
  ToilOrdinaryWorkingDayError,
} from './toil';
// r336 cbfa8b0b — DIRECTION 1 of the double-claim check, from the ONE module that also serves direction 2
// (core/attendance.ts's overtime request). See core/credit-ot-overlap.ts for why it is not two queries.
import {
  approvedOvertimeForDateTx,
  assertNoOvertimeClaimForDatesTx,
  type ApprovedOvertimeOnDate,
} from './credit-ot-overlap';
// r219 — the reason union lives in lib/ so the service and the screens that EXPLAIN it share one list. A
// reason this file can return that the notice map has no entry for fails to typecheck; see that file's
// header for why that mattered enough to move the type out. Same arrangement as lib/entitlement-status.ts.
import type { ReplacementUnavailableReason } from '../lib/replacement-availability';
import type { ExtendedHoursTiers } from '../lib/extended-hours';

const STD_DAY_MINUTES = 480; // 8h — the same standard-day convention core/toil.ts and payroll use
const round2 = (n: number) => Math.round(n * 100) / 100;

export class ReplacementRequestDisabledError extends Error {
  constructor(msg = 'Employee-submitted replacement leave requests are not switched on for this company.') {
    super(msg);
    this.name = 'ReplacementRequestDisabledError';
  }
}
export class ReplacementRequestNotEligibleError extends Error {
  constructor(msg = 'You are not eligible to submit a replacement leave request.') {
    super(msg);
    this.name = 'ReplacementRequestNotEligibleError';
  }
}
export class ReplacementRequestInvalidError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ReplacementRequestInvalidError';
  }
}
export class ReplacementRequestNotPendingError extends Error {
  constructor(msg = 'That replacement leave request has already been decided.') {
    super(msg);
    this.name = 'ReplacementRequestNotPendingError';
  }
}

/**
 * One worked-date row as the employee typed it. `days` for a Day request; `fromTime`/`toTime` for Hour.
 *
 * ── r336 cbfa8b0b · `sourceType` IS WHICH SECTION OF THE SCREEN THE ROW CAME FROM ───────────────────────
 * The Leave Credit request is one modal holding two different claims, and they are not two flavours of one
 * thing — they are validated against opposite facts (Section A requires a NON-working day, Section B
 * requires a working day) and produce the credit by opposite routes (A is declared, B is derived from
 * measured minutes and can never be typed).
 *
 * ABSENT MEANS SECTION A, and that is a compatibility decision with teeth: every row already in production
 * and every existing caller of this function omits it, and all of them are non-working-day claims, because
 * Section B did not exist. `LEGACY_CLAIM_SOURCE_TYPE` names that mapping once so no reader re-decides it.
 *
 * On a Section B row `fromTime`/`toTime` are the CLAIMED EXTENDED WINDOW — the "Extended start" and
 * "Extended end" the employee types — and `days` is ignored on input entirely. The credit for such a row is
 * derived server-side from the attendance record through r334's tier ladder; a client that posted a days
 * figure would be posting a number nothing reads.
 */
export type ReplacementRequestLineInput = {
  workedDate: string;
  days?: number;
  fromTime?: string;
  toTime?: string;
  sourceType?: ReplacementClaimSourceType;
};

/**
 * Minutes between two HH:MM(:SS) times on the same day. Refuses a non-positive span rather than silently
 * producing zero hours — an employee who typed 17:00 to 08:00 made a mistake and should be told, not given
 * a credit of nothing.
 */
export function minutesBetween(fromTime: string, toTime: string): number {
  const parse = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
  };
  const a = parse(fromTime);
  const b = parse(toTime);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ReplacementRequestInvalidError('Enter a valid from and to time.');
  const mins = b - a;
  if (mins <= 0) throw new ReplacementRequestInvalidError('The "to" time must be later than the "from" time.');
  return mins;
}

/**
 * The totals shown at the bottom of the worked-date table. Pure, and exported so the same arithmetic backs
 * the form preview, the stored totals and the tests — three places that would otherwise drift.
 *
 * The DAYS figure is what actually gets banked. For an Hour request it is the claimed hours over the
 * standard 8-hour day, which is the same conversion `accrueToilTx` applies to measured overtime minutes.
 */
export function totalsFor(
  unit: ReplacementLeaveRequestUnit,
  lines: ReplacementRequestLineInput[],
): { totalDays: number; totalHours: number; perLine: { workedDate: string; days: number; minutes: number }[] } {
  const perLine = lines.map((l) => {
    if (unit === 'hour') {
      const minutes = minutesBetween(l.fromTime ?? '', l.toTime ?? '');
      return { workedDate: l.workedDate, days: round2(minutes / STD_DAY_MINUTES), minutes };
    }
    const days = Number(l.days ?? 0);
    if (!Number.isFinite(days) || days <= 0)
      throw new ReplacementRequestInvalidError('Enter a number of days greater than zero for every worked date.');
    return { workedDate: l.workedDate, days: round2(days), minutes: Math.round(days * STD_DAY_MINUTES) };
  });
  const totalDays = round2(perLine.reduce((s, l) => s + l.days, 0));
  const totalHours = round2(perLine.reduce((s, l) => s + l.minutes, 0) / 60);
  return { totalDays, totalHours, perLine };
}

/**
 * What the employee's My Leave surface needs to decide whether to render the request button at all.
 *
 * Returns `allowed: false` with a REASON rather than a bare boolean, because the reasons are genuinely
 * different things to tell someone: the add-on is not bought, the company has not switched employee
 * requests on, this particular employee is outside the criteria, or the statutory overtime floor protects
 * them and their company has not recorded that it may be traded for banked time. Each one names a
 * DIFFERENT thing to go and change, and several of them are not changeable on the same screen — or on any
 * screen at all.
 *
 * ⚠️ r219 (7966ee35) — AND EVERY CALLER MUST SAY WHICH. The reporter's tenant had this function returning
 * `module_off` for every employee in every company, and `app/leave/page.tsx` rendered the boolean and threw
 * the reason away, so the screen was silent and the customer spent a round turning Leave Config switches on
 * and off. That is the third time a surface in this repo computed a precise cause and rendered nothing
 * (`no_eligibility_match`, 8ebf77ae, was the second). `components/leave/replacement-availability-notice.tsx`
 * is the one place the reasons are put into words; a NEW reason added here without an entry in that map
 * fails `test/r219-replacement-availability-reason.test.ts` rather than rendering silence.
 *
 * THIS IS NOT THE ENFORCEMENT. `submitReplacementLeaveRequest` re-derives all of them server-side; this
 * exists so the UI does not offer a button that would be refused.
 */
export type ReplacementRequestAvailability = {
  allowed: boolean;
  /**
   * `first_schedule_protected` is SEPARATE from `not_eligible` (r219) and the split is the point: an
   * employee outside the company's eligibility criteria is a configuration choice someone can widen, while
   * an employee at or below the statutory overtime wage ceiling is protected by law and the only lawful
   * remedy is the company's own recorded override plus that employee's agreement. Collapsing them told
   * an administrator to go and edit a criteria list that was never the cause.
   */
  reason?: ReplacementUnavailableReason;
  /**
   * The employee is within the First Schedule AND their company allows banking, so the form must ASK for
   * their agreement. False when they are above the wage ceiling (no statutory floor to protect) — and note
   * that a First-Schedule employee whose company has NOT switched the override on comes back
   * `allowed: false`, never `allowed: true` with a checkbox that could not help them.
   */
  requiresFirstScheduleConsent?: boolean;
};

export async function replacementRequestAvailability(
  ctx: SessionContext,
  employmentId: string,
  asOf: string,
): Promise<ReplacementRequestAvailability> {
  if (!isModuleEnabled(ctx, 'toil')) return { allowed: false, reason: 'module_off' };
  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, employmentId);
    if (!resolved) return { allowed: false, reason: 'no_employment' as const };
    const { policy } = resolved;
    // r219 — THE TWO COMPANY SWITCHES ARE TWO REASONS, not one. The approved plan enumerates them
    // separately to the reporter ("not enabled for this company" and "employee submission switched off")
    // and they genuinely are: with the first off nothing about replacement leave works at all, while with
    // only the second off the company banks credits off the roster and merely does not let employees ask.
    // Collapsed, a screen could only name both switches and say one of them was off, which is the same
    // guess the reporter was already making by hand.
    if (!policy || !policy.enabled) return { allowed: false, reason: 'not_enabled' as const };
    if (!policy.employeeRequestEnabled) return { allowed: false, reason: 'employee_requests_off' as const };
    const eligible = await isReplacementRequestEligibleTx(tx, {
      employmentId,
      asOf,
      eligibility: policy.requestEligibility,
    });
    if (!eligible) return { allowed: false, reason: 'not_eligible' as const };
    // The statutory floor decides whether the form shows a consent box — and, when the company has not
    // switched the override on, whether the button appears at all. Asking here rather than letting the
    // employee fill in a form that submit would refuse.
    const firstSchedule = await isFirstScheduleTx(tx, { employmentId, country: resolved.country, asOf });
    // r219 — its OWN reason, not `not_eligible`. `assertFirstScheduleSubmissionAllowedTx` below already
    // throws a distinct message for this at submit time; the availability read was the half that flattened
    // it, so a screen explaining the absence would have sent an administrator to the criteria list.
    if (firstSchedule && !policy.allowFirstScheduleEligible)
      return { allowed: false, reason: 'first_schedule_protected' as const };
    return { allowed: true, requiresFirstScheduleConsent: firstSchedule };
  });
}

/**
 * Is this employee within the First Schedule (s.2 wages at or below the pack's overtime wage ceiling)?
 *
 * The same comparison `bankToilCreditTx` makes at accrual time. Shared by the availability read and the
 * submit-time gate so the button, the consent checkbox and the refusal cannot disagree about who is
 * protected — the ACCRUAL-time check remains the binding one.
 */
async function isFirstScheduleTx(
  tx: Tx,
  p: { employmentId: string; country: string | null; asOf: string },
): Promise<boolean> {
  const [comp] = await tx
    .select({ basic: compensation.basicSalary, allowance: compensation.monthlyAllowance })
    .from(compensation)
    .where(and(eq(compensation.employmentId, p.employmentId), isNull(compensation.validTo), isNull(compensation.supersededAt)))
    .limit(1);
  const wages = comp ? round2(Number(comp.basic) + Number(comp.allowance ?? 0)) : null;
  const pack = packFor(p.country);
  const ceiling = pack ? (await pack.payroll.loadRuleset(tx, { asOf: p.asOf })).ot.wageCeiling : 4000;
  return wages != null && wages <= ceiling;
}

/** The employee's company policy, or null when the employment cannot be resolved. */
async function resolvePolicyForTx(tx: Tx, employmentId: string) {
  const [emp] = await tx
    .select({ companyId: employment.companyId, country: company.country })
    .from(employment)
    .innerJoin(company, eq(company.id, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  if (!emp) return null;
  const [policy] = await tx.select().from(toilPolicy).where(eq(toilPolicy.companyId, emp.companyId)).limit(1);
  return { companyId: emp.companyId, country: emp.country, policy: policy ?? null };
}

/**
 * 3fb1a611 (r299) · the kind of day one date is for one employment — what the Leave Credit request form shows
 * beside each date worked ("Rest day", "Off day", "Public holiday", or that an ordinary working day cannot
 * earn a credit). Read-only, RLS-scoped (an employee can resolve their own schedule), and NOT the control:
 * submission and approval re-resolve it and refuse a working day.
 */
export function workedDayKindForEmployment(ctx: SessionContext, employmentId: string, date: string) {
  return withTenant(ctx, (tx) => resolveWorkedDayKindTx(tx, employmentId, date));
}

/**
 * r336 cbfa8b0b · SECTION B'S READ-ONLY ROW, for one date — the scheduled shift end, the actual clock-out
 * and the measured extended minutes the credit will be derived from. Read-only, RLS-scoped (an employee can
 * resolve their own schedule and their own attendance), and NOT the control: submission and approval both
 * re-resolve every one of these and refuse a date that no longer qualifies.
 */
/**
 * ⚠️ r365 cbfa8b0b — THIS IS THE **SCREEN's** READ, AND IT IS WIDER THAN THE KERNEL's ON PURPOSE.
 *
 * `extendedHoursDayForEmploymentTx` (core/toil.ts → the attendance pack) is on the SUBMIT and ACCRUAL
 * paths, once per row. This function is on neither: its only callers are the two server actions that feed
 * the Leave Credit request table. So the approved-overtime lookup — one extra indexed query per date the
 * employee picks — is added HERE rather than inside the shared kernel read, where it would have cost a
 * query per row on every submission to answer a question no kernel path asks.
 *
 * Nothing this returns is an input to any figure. `shiftStart`, `actualClockIn` and `approvedOtPlan` are
 * what the row's Attendance panel prints; the credit is still derived from `shiftEnd` and
 * `actualClockOut` through `assessExtendedClaim`, with NULL passed for both on the three non-working day
 * types. Read-only and RLS-scoped, and NOT the control: submission and approval re-resolve all of it.
 */
export type LeaveCreditExtendedDayView = {
  kind: ToilWorkedDayKind;
  /** Display only — the shift WINDOW's start. Null on the company-policy branch (no assigned shift). */
  scheduleName: string | null;
  shiftCode: string | null;
  shiftName: string | null;
  attendanceRecordPresent: boolean;
  shiftStart: string | null;
  shiftEnd: string | null;
  /** Display only — the clock-IN. Null when the day has no attendance row or was never clocked in. */
  actualClockIn: string | null;
  actualClockOut: string | null;
  measuredExtendedMinutes: number;
  /**
   * The APPROVED overtime already on this date, or null. It pre-explains the refusal
   * `assertNoOvertimeClaimForDatesTx` hands this employee at submit; see core/credit-ot-overlap.ts for
   * why the pending half of that block is deliberately not shown here.
   */
  approvedOtPlan: ApprovedOvertimeOnDate | null;
};

export function extendedHoursDayForEmployment(
  ctx: SessionContext,
  employmentId: string,
  date: string,
): Promise<LeaveCreditExtendedDayView> {
  return withTenant(ctx, async (tx) => {
    const day = await extendedHoursDayForEmploymentTx(tx, employmentId, date);
    return { ...day, approvedOtPlan: await approvedOvertimeForDateTx(tx, employmentId, date) };
  });
}

/**
 * r336 · WHETHER SECTION B IS OFFERED TO THIS EMPLOYEE AT ALL, and on what figures.
 *
 * Returns null when the company has not switched extended hours on, which is every company on release
 * (r334 shipped the switch defaulting to false). The page draws no Section B for a null, and the service
 * refuses an extended-hours line for the same company regardless — the hidden section is the courtesy and
 * the refusal is the control, the same arrangement the employee-request switch already uses.
 *
 * The TIERS come back with it because the form has to show the employee the credit their window earns as
 * they type it, and a form that used r334's defaults while the company had moved a threshold would promise
 * a credit the approval refuses.
 */
export function extendedHoursOfferForEmployment(
  ctx: SessionContext,
  employmentId: string,
): Promise<ExtendedHoursTiers | null> {
  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, employmentId);
    if (!resolved) return null;
    const policy = await extendedHoursPolicyForCompanyTx(tx, resolved.companyId);
    if (!policy.extendedHoursEnabled) return null;
    return {
      extendedHalfDayMinutes: policy.extendedHalfDayMinutes,
      extendedFullDayMinutes: policy.extendedFullDayMinutes,
      extendedBreakMinutes: policy.extendedBreakMinutes,
      extendedGraceMinutes: policy.extendedGraceMinutes,
    };
  });
}

/** What the Leave Credit table needs to draw itself: the ladder, and whether an ordinary day may claim. */
export type LeaveCreditOffer = {
  /**
   * The tier ladder. ALWAYS PRESENT since r358, for every day type — "4 hours … 0.5 day, 8 hours … 1.0
   * day, regardless of the Day Type". The company's own thresholds, so a company that moved them moves
   * the figure the employee is shown and the figure the approval banks together.
   */
  tiers: ExtendedHoursTiers;
  /**
   * Whether an ORDINARY WORKING DAY may earn a credit at all — the extended-hours switch, which is what
   * its name always said and, after r358, the whole of what it governs.
   *
   * ⚠️ THIS SEPARATION IS THE ITEM. `extendedHoursOfferForEmployment` above returns null when the switch
   * is off, and the Leave Credit table read that null as "no tiers exist", which made every row that
   * claimed a window unsubmittable. The switch is off on every company, so building the approved rule on
   * top of it would have switched Leave Credit off for all of them — which is why 70294f7a was parked
   * rather than shipped. Two facts, two fields.
   */
  ordinaryDayAllowed: boolean;
};

/**
 * r358 — the tiers AND the ordinary-day switch, as two separate facts.
 *
 * Null only when there is no resolved policy for the employment at all, which is the one case in which
 * the table cannot be drawn.
 */
export function leaveCreditOfferForEmployment(ctx: SessionContext, employmentId: string): Promise<LeaveCreditOffer | null> {
  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, employmentId);
    if (!resolved) return null;
    const policy = await extendedHoursPolicyForCompanyTx(tx, resolved.companyId);
    return {
      tiers: {
        extendedHalfDayMinutes: policy.extendedHalfDayMinutes,
        extendedFullDayMinutes: policy.extendedFullDayMinutes,
        extendedBreakMinutes: policy.extendedBreakMinutes,
        extendedGraceMinutes: policy.extendedGraceMinutes,
      },
      ordinaryDayAllowed: policy.extendedHoursEnabled,
    };
  });
}

export type SubmitReplacementRequestResult = { requestId: string; totalDays: number; totalHours: number };

/**
 * Submit a replacement-leave request. Writes the header + one line per worked date. GRANTS NOTHING — the
 * credit is minted only when a line manager approves (`decideReplacementLeaveRequest`), which is what
 * makes the approval date the honest anchor for the expiry period.
 */
export async function submitReplacementLeaveRequest(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId?: string | null;
    unit: ReplacementLeaveRequestUnit;
    lines: ReplacementRequestLineInput[];
    reason?: string;
    /** The employee's recorded agreement to bank time instead of the statutory overtime cash. */
    firstScheduleConsent?: boolean;
    /** Injected for deterministic tests; the submission date and the eligibility as-of date. */
    today: string;
  },
): Promise<SubmitReplacementRequestResult> {
  // Control 1 — the chargeable add-on. No module, no new credits, and no request that would mint one.
  assertModuleEnabled(ctx, 'toil');

  if (p.lines.length === 0) throw new ReplacementRequestInvalidError('Add at least one worked date.');
  const seen = new Set<string>();
  for (const l of p.lines) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.workedDate)) throw new ReplacementRequestInvalidError('Enter a valid worked date.');
    if (l.workedDate > p.today)
      throw new ReplacementRequestInvalidError('You cannot claim replacement leave for a date in the future.');
    if (seen.has(l.workedDate))
      throw new ReplacementRequestInvalidError('The same worked date appears more than once.');
    seen.add(l.workedDate);
  }

  // ── r336 cbfa8b0b · THE TWO SECTIONS, SPLIT BEFORE ANYTHING IS TOTALLED ────────────────────────────────
  // A row's section decides which facts it is validated against and how its credit is produced, so nothing
  // downstream may treat the list as homogeneous. An untagged row is Section A, which is what every row
  // written before this round is (migration 0487's header).
  const sectionOf = (l: ReplacementRequestLineInput): ReplacementClaimSourceType => l.sourceType ?? LEGACY_CLAIM_SOURCE_TYPE;
  const aAll = p.lines.filter((l) => sectionOf(l) === 'non_working_day');
  const bLines = p.lines.filter((l) => sectionOf(l) === 'extended_hours');
  // ── r358 70294f7a · A NON-WORKING DAY IS CLAIMED AS A WINDOW NOW, AND BOTH SHAPES REACH THIS FUNCTION ──
  //
  // The owner's answer: "Whether the employee works on a Normal Working Day, Rest Day, Off Day, or Public
  // Holiday, the Leave Credit calculation rule is the same. 4 hours of eligible work = 0.5 day. 8 hours of
  // eligible work = 1.0 day … regardless of the Day Type." So the Leave Credit form no longer offers the
  // "1 or 0.5" dropdown on those three types; it posts the same start and end it posts for a working day.
  //
  // THE DECLARED SHAPE IS NOT REMOVED, because this function has callers the form does not own: the
  // HR-side paths and every row written before this round, all of which carry `days` and no window. A line
  // is read as declared or as a window by WHAT IT CARRIES, never by a flag, so neither caller has to be
  // taught about the other.
  //
  // ⚠️ TIMES ALONE DO NOT MAKE A WINDOW LINE, AND THE SUITE CAUGHT ME ASSUMING THEY DID. An HOUR-unit
  // Section A claim has carried `fromTime`/`toTime` since long before this round — the header of
  // `ReplacementClaimLineView` says so in as many words ("not inferable anyway, because an Hour-unit
  // Section A claim also carries times"). Reading those as r358 windows refused three existing
  // behaviours outright. A window line is a DAY-unit line with times and no declared figure; everything
  // else is the shape this function already had.
  const isWindow = (l: ReplacementRequestLineInput) =>
    p.unit === 'day' && l.days == null && l.fromTime != null && l.toTime != null;
  const aWindowLines = aAll.filter(isWindow);
  const aLines = aAll.filter((l) => !isWindow(l));

  // "Unit is always Day and is derived, not selectable" — r333's precedent for the leave TYPE, applied to
  // the unit. Enforced HERE rather than only by the form, because an Hour-unit request carrying a Section B
  // row would have two different answers for what that row credits: the claimed hours over a standard day,
  // and the tier the minutes actually earn. There is no honest total to put at the bottom of that form.
  if (bLines.length > 0 && p.unit !== 'day')
    throw new ReplacementRequestInvalidError('Extended ordinary-day work is always credited in days.');
  for (const l of bLines) {
    if (!l.fromTime || !l.toTime)
      throw new ReplacementRequestInvalidError('Enter the extended start and end time for every date in Extended ordinary-day work.');
  }
  // A Section A row the NEW screen tagged is a whole non-working day or half of one, which is what the
  // approved plan specifies and what the form offers. Deliberately NOT applied to an UNTAGGED row: that is
  // the pre-r336 contract (any figure above zero), it is what production rows carry, and tightening it here
  // would refuse a claim the HR-side paths still create. A tagged row can only come from this round's form.
  // ⚠️ r358 — REVERSED FOR A WINDOW LINE, AND THE OLD CLAIM IS QUOTED BECAUSE IT WAS THE RULE. This read
  // `l.sourceType === 'non_working_day' && l.days !== 1 && l.days !== 0.5` over EVERY line, under the
  // comment "A Section A row the NEW screen tagged is a whole non-working day or half of one, which is
  // what the approved plan specifies and what the form offers." The owner replaced the choice with the
  // arithmetic, so the form offers no such figure any more. It still holds for a DECLARED line — the
  // HR-side callers that post `days` — which is why the test moved onto `aLines` rather than being dropped.
  for (const l of aLines) {
    if (l.sourceType === 'non_working_day' && l.days !== 1 && l.days !== 0.5)
      throw new ReplacementRequestInvalidError('A rest day, off day or public holiday earns either 1 day or 0.5 day.');
  }
  // `isWindow` already requires the day unit, so this cannot fire from the form; it is here for a caller
  // that builds lines by hand, and it says which of the two shapes it thinks it is sending.
  if (aWindowLines.length > 0 && p.unit !== 'day')
    throw new ReplacementRequestInvalidError('A claimed window is always credited in days.');

  // Throws on a bad row (zero days, reversed times) before anything is written. Section B rows are absent
  // from this call on purpose: their credit is not a figure the employee typed, so there is nothing here to
  // validate — it is derived inside the transaction below, from the attendance record.
  const aTotals = totalsFor(p.unit, aLines);

  return withTenant(ctx, async (tx) => {
    const resolved = await resolvePolicyForTx(tx, p.employmentId);
    if (!resolved) throw new ReplacementRequestInvalidError('No employment on record for this request.');
    const { policy } = resolved;
    if (!policy || !policy.enabled) throw new ReplacementRequestDisabledError('Replacement leave is not enabled for this company.');

    // Control 2 — the employee-request switch, enforced SERVER-SIDE. The hidden button is not the control.
    if (!policy.employeeRequestEnabled) throw new ReplacementRequestDisabledError();

    // Control 3 — eligibility, as of the SUBMISSION date.
    const eligible = await isReplacementRequestEligibleTx(tx, {
      employmentId: p.employmentId,
      asOf: p.today,
      eligibility: policy.requestEligibility,
    });
    if (!eligible) throw new ReplacementRequestNotEligibleError();

    // Control 4 (submit-time half) — the First Schedule gate, so the employee finds out NOW rather than
    // after a manager has approved something that cannot legally be granted. The binding half runs inside
    // bankToilCreditTx at approval; this one only saves a wasted round trip.
    await assertFirstScheduleSubmissionAllowedTx(tx, {
      employmentId: p.employmentId,
      country: resolved.country,
      asOf: p.today,
      allowFirstScheduleEligible: policy.allowFirstScheduleEligible,
      consent: p.firstScheduleConsent === true,
    });

    // ── r336 · SECTION B, DERIVED — never read off the form ─────────────────────────────────────────────
    // The employee types a window; everything else on the row is a fact the system already owns. The same
    // four gates run again at approval (`accrueExtendedWorkdayToilTx`), which is the binding moment; this
    // half exists so the employee is told at submit rather than after a manager has approved nothing.
    type DerivedB = {
      workedDate: string;
      claimStart: string;
      claimEnd: string;
      days: number;
      eligibleMinutes: number;
      shiftEnd: string | null;
      actualClockOut: string | null;
    };
    const bDerived: DerivedB[] = [];
    /**
     * r358 — THE SAME DERIVATION FOR A NON-WORKING DAY, THROUGH THE SAME TWO FUNCTIONS.
     *
     * `eligibleExtendedMinutes` and `extendedHoursCreditDays` are the ladder the owner described
     * ("4 hours … 0.5 day, 8 hours … 1.0 day"), and running a second copy of it here is what the whole of
     * lib/extended-hours.ts exists to prevent.
     *
     * ⚠️ `shiftEnd: null` AND `actualClockOut: null` ARE THE RULE, NOT MISSING DATA. On these three day
     * types the employee was never scheduled to be there, so there is nothing for the window to be "after"
     * — the whole of it is the claim, which is exactly what was asked for: "Extended End – Extended Start
     * = Eligible Hours". `flooredByScheduledShiftEnd` in lib/leave-credit-day-type.ts is where that is
     * stated, and its header explains why this is decided by the day type rather than left to whether the
     * roster happens to hold a shift: a roster CAN carry one on a rest day, and the floor would then
     * silently eat the first hours of the claim.
     *
     * NO `extendedHoursEnabled` GATE. That switch decides whether an ORDINARY working day can earn a
     * credit at all — which is what its name says and, after this round, all it governs. Gating a rest-day
     * claim on it is what made the approved rule unbuildable as written and is why the item was parked.
     * The thresholds still come from the company's own policy, so a company that moved them moves both.
     */
    type DerivedA = { workedDate: string; claimStart: string; claimEnd: string; days: number; eligibleMinutes: number };
    const aDerived: DerivedA[] = [];
    if (aWindowLines.length > 0) {
      const tiers = await extendedHoursPolicyForCompanyTx(tx, resolved.companyId);
      for (const l of aWindowLines) {
        const minutes = eligibleExtendedMinutes({
          claimStart: l.fromTime!,
          claimEnd: l.toTime!,
          shiftEnd: null,
          actualClockOut: null,
        });
        const { countedMinutes, days } = extendedHoursCreditDays(minutes, tiers);
        if (days <= 0)
          throw new ToilExtendedHoursBelowThresholdError(l.workedDate, countedMinutes, tiers.extendedHalfDayMinutes);
        aDerived.push({
          workedDate: l.workedDate,
          claimStart: l.fromTime!,
          claimEnd: l.toTime!,
          days,
          eligibleMinutes: countedMinutes,
        });
      }
    }
    if (bLines.length > 0) {
      const extended = await extendedHoursPolicyForCompanyTx(tx, resolved.companyId);
      if (!extended.extendedHoursEnabled)
        throw new ReplacementRequestDisabledError('Extended hours on an ordinary working day are not switched on for this company.');
      for (const l of bLines) {
        const day = await extendedHoursDayForEmploymentTx(tx, p.employmentId, l.workedDate);
        // A rest day, off day or public holiday belongs in Section A, and the message says which.
        if (day.kind !== 'workday') throw new LeaveCreditSectionMismatchError('B', [l.workedDate]);
        // r353 cbfa8b0b — NO CAP OF ITS OWN, and that is checked rather than assumed: the shared function
        // is the whole of the arithmetic now that the owner has reversed the measured cap and the clock-out
        // clip, so anything this file added on top would make the submit screen and the approval disagree
        // about the same window. The two stored times below are the approver's reference, not a ceiling.
        const minutes = eligibleExtendedMinutes({
          claimStart: l.fromTime!,
          claimEnd: l.toTime!,
          shiftEnd: day.shiftEnd,
          actualClockOut: day.actualClockOut,
        });
        const { countedMinutes, days } = extendedHoursCreditDays(minutes, extended);
        if (days <= 0)
          throw new ToilExtendedHoursBelowThresholdError(l.workedDate, countedMinutes, extended.extendedHalfDayMinutes);
        bDerived.push({
          workedDate: l.workedDate,
          claimStart: l.fromTime!,
          claimEnd: l.toTime!,
          days,
          eligibleMinutes: countedMinutes,
          shiftEnd: day.shiftEnd,
          actualClockOut: day.actualClockOut,
        });
      }
    }

    // The grand total the employee saw: both sections summed, in days. `totalHours` stays the same
    // convention it has always had (minutes over 60) so the stored pair cannot disagree with itself.
    const bMinutes = bDerived.reduce((s, b) => s + b.eligibleMinutes, 0);
    // r358 — three terms now: declared Section A lines, DERIVED Section A windows, and Section B.
    const aWindowMinutes = aDerived.reduce((s, a) => s + a.eligibleMinutes, 0);
    const totalDays = round2(
      aTotals.totalDays + aDerived.reduce((s, a) => s + a.days, 0) + bDerived.reduce((s, b) => s + b.days, 0),
    );
    const totalHours = round2(aTotals.totalHours + (aWindowMinutes + bMinutes) / 60);
    if (totalDays <= 0) throw new ReplacementRequestInvalidError('The total must be greater than zero.');

    // The double-bank guard, applied EARLY as a courtesy. `toil_accrual`'s unique index is the real one and
    // it is re-checked at approval — a manager could bank one of these dates off the roster in between —
    // but refusing at submit is a much better experience than an approval that half-fails.
    const dates = p.lines.map((l) => l.workedDate);
    const already = await tx
      .select({ workedDate: toilAccrual.workedDate })
      .from(toilAccrual)
      .where(
        and(
          eq(toilAccrual.employmentId, p.employmentId),
          inArray(toilAccrual.workedDate, dates),
          // 3fb1a611: a REVERSED credit was never banked (migration 0469), so it does not block a new claim.
          ne(toilAccrual.status, 'reversed'),
        ),
      );
    if (already.length > 0) {
      throw new ToilAlreadyAccruedError(
        `Replacement leave has already been banked for ${already.map((a) => a.workedDate).join(', ')}.`,
      );
    }

    // 3fb1a611 (r299) — ONLY A REST DAY, OFF DAY OR PUBLIC HOLIDAY EARNS A LEAVE CREDIT. Until this round the
    // request path accepted any date: the roster and auto paths refused an ordinary working day, this one did
    // not. Checked per line, through the same schedule the attendance engine uses, and every offending date is
    // named at once. This is the courtesy half — the binding check runs again at approval, inside
    // accrueSelfDeclaredToilTx, because a roster can change in between.
    //
    // r336 — SECTION A ONLY, and the kinds are KEPT. Section B's dates are ordinary working days by
    // definition and were checked against the opposite fact above; running this loop over them would refuse
    // every extended-hours claim ever made. The resolved kind is stored on each Section A line so an
    // approver reads the day the employee was shown rather than re-deriving it against a moved roster.
    const aKinds = new Map<string, ToilWorkedDayKind>();
    const taggedWorkingDays: string[] = [];
    const untaggedWorkingDays: string[] = [];
    // r358 — BOTH SHAPES. A window-claimed rest day still has to be resolved and still has to be refused
    // if the roster calls it a working day: that check is not about how the credit is worked out, and
    // leaving the new shape out of it would have let an ordinary day in through the non-working route
    // with no attendance behind it. The stored `workedDayKind` comes from the same map.
    for (const l of [...aLines, ...aWindowLines]) {
      const kind = await resolveWorkedDayKindTx(tx, p.employmentId, l.workedDate);
      aKinds.set(l.workedDate, kind);
      if (kind === 'workday') (l.sourceType ? taggedWorkingDays : untaggedWorkingDays).push(l.workedDate);
    }
    // A row the new screen tagged gets the screen's own sentence, which tells the employee WHICH SECTION the
    // date belongs in — the only useful thing to say inside a modal that holds both. An untagged row keeps
    // r299's message verbatim, because nothing about the callers that send untagged rows has changed.
    if (taggedWorkingDays.length > 0) throw new LeaveCreditSectionMismatchError('A', taggedWorkingDays);
    if (untaggedWorkingDays.length > 0) throw new ToilOrdinaryWorkingDayError(untaggedWorkingDays);

    // ── r336 · DIRECTION 1 OF THE DOUBLE-CLAIM CHECK ────────────────────────────────────────────────────
    // The same worked day is cash XOR time in lieu (ADR-0033). An overtime claim already open for one of
    // these dates refuses the credit; rejecting or cancelling it releases the block. The mirror question —
    // an overtime claim filed on a date whose credit is open — is asked by core/attendance.ts through the
    // SAME predicate, which is the only reason the two can never disagree about what "open" means.
    await assertNoOvertimeClaimForDatesTx(tx, p.employmentId, dates);

    const [header] = await tx
      .insert(replacementLeaveRequest)
      .values({
        tenantId: ctx.tenantId,
        employmentId: p.employmentId,
        leaveTypeId: p.leaveTypeId ?? null,
        unit: p.unit,
        totalDays: totalDays.toFixed(2),
        totalHours: totalHours.toFixed(2),
        reason: p.reason?.trim() || null,
        submittedOn: p.today,
        status: 'pending',
        firstScheduleConsent: p.firstScheduleConsent === true ? true : null,
      })
      .returning({ id: replacementLeaveRequest.id });

    const aPerLine = new Map(aTotals.perLine.map((l) => [l.workedDate, l]));
    const aDerivedByDate = new Map(aDerived.map((a) => [a.workedDate, a]));
    const bByDate = new Map(bDerived.map((b) => [b.workedDate, b]));
    await tx.insert(replacementLeaveRequestDate).values(
      p.lines.map((l) => {
        const base = { tenantId: ctx.tenantId, requestId: header.id, subjectEmploymentId: p.employmentId, workedDate: l.workedDate };
        const b = bByDate.get(l.workedDate);
        if (sectionOf(l) === 'extended_hours' && b) {
          return {
            ...base,
            days: b.days.toFixed(2),
            // The claimed window IS `from_time`/`to_time` — the columns 0381 already added for a time
            // claim. A second pair named claim_start/claim_end would have been the same two facts twice.
            fromTime: b.claimStart,
            toTime: b.claimEnd,
            hours: round2(b.eligibleMinutes / 60).toFixed(2),
            sourceType: 'extended_hours' as const,
            workedDayKind: 'workday' as const,
            shiftEnd: b.shiftEnd,
            actualClockOut: b.actualClockOut,
            eligibleMinutes: b.eligibleMinutes,
          };
        }
        // r358 — a non-working day claimed as a WINDOW stores the window, the eligible minutes and the
        // derived credit, exactly as a Section B line does. The approver was asked for this by name:
        // "The employee's submitted Extended Start and Extended End should be shown to the manager for
        // verification." `workedDayKind` still comes from the roster below, so the row says WHICH kind of
        // non-working day it was as well as what was claimed on it.
        const aw = aDerivedByDate.get(l.workedDate);
        if (aw) {
          return {
            ...base,
            days: aw.days.toFixed(2),
            fromTime: aw.claimStart,
            toTime: aw.claimEnd,
            hours: round2(aw.eligibleMinutes / 60).toFixed(2),
            sourceType: l.sourceType ?? null,
            workedDayKind: aKinds.get(l.workedDate) ?? null,
            // No scheduled shift and no attendance row to compare against — see the derivation above.
            shiftEnd: null,
            actualClockOut: null,
            eligibleMinutes: aw.eligibleMinutes,
          };
        }
        const a = aPerLine.get(l.workedDate);
        return {
          ...base,
          days: (a?.days ?? 0).toFixed(2),
          fromTime: p.unit === 'hour' ? (l.fromTime ?? null) : null,
          toTime: p.unit === 'hour' ? (l.toTime ?? null) : null,
          hours: p.unit === 'hour' ? round2((a?.minutes ?? 0) / 60).toFixed(2) : null,
          // NULL for an untagged legacy row, on purpose: the column's documented meaning is "written before
          // r336 ⇒ Section A", and writing a value onto a caller that never said one would erase that.
          sourceType: l.sourceType ?? null,
          workedDayKind: aKinds.get(l.workedDate) ?? null,
          shiftEnd: null,
          actualClockOut: null,
          eligibleMinutes: null,
        };
      }),
    );

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-request',
      aggregateId: header.id,
      eventType: 'replacement-leave-request.submitted',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: {
        unit: p.unit,
        totalDays,
        totalHours,
        dates,
        submittedOn: p.today,
        // r336 — the two sections named on the audit event, so a reader of the log can tell an
        // extended-hours claim from a rest-day one without joining back to the lines.
        nonWorkingDayDates: aLines.map((l) => l.workedDate),
        extendedHoursDates: bDerived.map((b) => ({ workedDate: b.workedDate, eligibleMinutes: b.eligibleMinutes, days: b.days })),
      },
    });

    return { requestId: header.id, totalDays, totalHours };
  });
}

/**
 * The submit-time First Schedule check.
 *
 * Deliberately a SEPARATE function from the one inside `bankToilCreditTx` rather than a shared helper, and
 * that is worth being explicit about: the accrual-time gate reads the policy row it is already holding and
 * throws the canonical `ToilNotEligibleError` / `ToilFirstScheduleConsentRequiredError`. Sharing one
 * implementation would mean the submit path pulling the whole accrual context in just to reuse two
 * comparisons. What must not diverge is the RULE, and the rule is asserted in both places by the same
 * test — a First-Schedule employee refused without the override plus recorded consent, at submit AND at
 * approval.
 */
async function assertFirstScheduleSubmissionAllowedTx(
  tx: Tx,
  p: { employmentId: string; country: string | null; asOf: string; allowFirstScheduleEligible: boolean; consent: boolean },
): Promise<void> {
  const eligible = await isFirstScheduleTx(tx, p);
  if (!eligible) return; // above the ceiling: overtime comp is contractual, no statutory floor to protect
  if (!p.allowFirstScheduleEligible) {
    throw new ReplacementRequestNotEligibleError(
      'Statutory overtime pay applies to you (within the First Schedule), so replacement leave is not permitted under your company’s current policy.',
    );
  }
  if (!p.consent) {
    throw new ReplacementRequestNotEligibleError(
      'Statutory overtime pay applies to you (within the First Schedule). Banking time in lieu instead of the statutory cash premium requires your explicit agreement — confirm it to proceed.',
    );
  }
}

export type DecideReplacementRequestResult = {
  status: ReplacementLeaveRequestStatus;
  /** Credits minted (0 on a rejection). */
  granted: number;
  daysCredited: number;
  /** The expiry frozen onto every credit this approval minted — counted from the APPROVAL date. */
  expiresOn?: string;
};

/**
 * Decide a replacement-leave request. On approval, mints ONE credit per worked-date line in the SAME
 * transaction, with the expiry counted from THIS DECISION.
 *
 * `decidedAt` is injected (defaulting to now) for the same reason every other date in this engine is: so
 * the suite can assert an expiry rather than recompute one, and so "the approval instant" is a single
 * value shared by the header, every credit, and the event — rather than three `new Date()` calls that
 * disagree by milliseconds across a midnight boundary.
 */
export async function decideReplacementLeaveRequest(
  ctx: SessionContext,
  p: { requestId: string; decision: 'approved' | 'rejected'; note?: string; decidedAt?: Date },
): Promise<DecideReplacementRequestResult> {
  // The module gate applies to APPROVAL too, because approval is what mints the credit. Rejection is left
  // reachable on purpose — refusing to let an admin clear a pending queue after the module lapses would
  // strand the request, and a rejection grants nothing.
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select()
      .from(replacementLeaveRequest)
      .where(eq(replacementLeaveRequest.id, p.requestId))
      .limit(1);
    if (!req) throw new ReplacementRequestInvalidError('Replacement leave request not found.');
    if (req.status !== 'pending') throw new ReplacementRequestNotPendingError();

    // Line-manager-or-admin, with the self-grant ban. The plan is explicit that this is the whole approval
    // model — NOT core/leave-approval-template.ts's multi-level chain.
    await assertCanDecide(tx, ctx, req.employmentId, 'replacement leave request');

    const decidedAt = p.decidedAt ?? new Date();

    if (p.decision === 'rejected') {
      await tx
        .update(replacementLeaveRequest)
        .set({ status: 'rejected', decidedAt, decidedByUserId: ctx.userId ?? null, decisionNote: p.note?.trim() || null })
        .where(eq(replacementLeaveRequest.id, p.requestId));
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'replacement-leave-request',
        aggregateId: p.requestId,
        eventType: 'replacement-leave-request.rejected',
        actor: actorOf(ctx),
        subjectEmploymentId: req.employmentId,
        payload: { note: p.note ?? null },
      });
      return { status: 'rejected' as const, granted: 0, daysCredited: 0 };
    }

    // Approving MINTS credits, so the add-on must be live for this half.
    assertModuleEnabled(ctx, 'toil');

    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(eq(replacementLeaveRequestDate.requestId, p.requestId))
      .orderBy(replacementLeaveRequestDate.workedDate);

    let granted = 0;
    let daysCredited = 0;
    /** r336 — the minutes actually banked across both sections, so the header's hours total follows too. */
    let creditedMinutes = 0;
    let expiresOn: string | undefined;
    for (const line of lines) {
      const days = Number(line.days ?? 0);
      const minutes = line.hours != null ? Math.round(Number(line.hours) * 60) : Math.round(days * STD_DAY_MINUTES);
      // ── r336 cbfa8b0b · THE LINE'S SECTION CHOOSES ITS EXECUTOR ────────────────────────────────────────
      // Section B is not a variant of the self-declared path: it requires the OPPOSITE day fact (an
      // ordinary working day, which `accrueSelfDeclaredToilTx` refuses outright and must keep refusing),
      // and its credit is DERIVED from the live attendance record through r334's tiers rather than taken
      // from what was stored at submission. So it has its own entry point rather than a flag that would
      // turn r299's day-type gate off.
      //
      // The stored `days`/`hours` on a Section B line are NOT read here, deliberately. They are what the
      // employee was shown and what the totals were built from; a corrected clock-out between submission
      // and approval must change the credit, and it does, because `accrueExtendedWorkdayToilTx` re-reads
      // the day. Trusting the stored figure would make the claim line a second owner of the measurement.
      //
      // Either way a refusal (a date banked in the meantime, a First-Schedule employee whose company
      // override was switched off between submission and approval, a roster that moved) rolls the WHOLE
      // approval back — a request is approved as a unit, and a half-granted one would leave the employee
      // unable to tell what they had been given.
      const extendedLine = line.sourceType === 'extended_hours';
      const banked = extendedLine
        ? await accrueExtendedWorkdayToilTx(tx, ctx, {
            employmentId: req.employmentId,
            workedDate: line.workedDate,
            claimStart: line.fromTime ?? '',
            claimEnd: line.toTime ?? '',
            approvedOn: decidedAt,
            requestedOn: req.submittedOn,
            firstScheduleConsent: req.firstScheduleConsent === true,
          })
        : null;
      // The shared executor: skips the attendance lookup and the rest-day/holiday restriction, KEEPS the
      // double-bank guard, the First Schedule gate, the ledger credit and the register row.
      const res =
        banked ??
        (await accrueSelfDeclaredToilTx(tx, ctx, {
          employmentId: req.employmentId,
          workedDate: line.workedDate,
          declaredDays: days,
          declaredMinutes: minutes,
          // THE ANCHOR. Not the submission date, not the date worked — the moment of this decision.
          approvedOn: decidedAt,
          // The employee's own request date, so the register can show both without guessing either.
          requestedOn: req.submittedOn,
          firstScheduleConsent: req.firstScheduleConsent === true,
        }));
      await tx
        .update(replacementLeaveRequestDate)
        .set(
          // r336 — a Section B line records WHAT WAS ACTUALLY BANKED, not what was projected at
          // submission. The approval re-reads the attendance row, so a clock-out corrected in between
          // moves the eligible minutes and therefore the credit; writing the re-derived figures back is
          // what stops the line telling an approver one number while the ledger holds another. A
          // Section A line has nothing to re-derive and is untouched, byte-identical to before.
          banked
            ? {
                accrualId: banked.accrualId,
                days: banked.daysCredited.toFixed(2),
                hours: round2(banked.eligibleMinutes / 60).toFixed(2),
                eligibleMinutes: banked.eligibleMinutes,
                shiftEnd: banked.shiftEnd,
                actualClockOut: banked.actualClockOut,
              }
            : { accrualId: res.accrualId },
        )
        .where(eq(replacementLeaveRequestDate.id, line.id));
      granted += 1;
      daysCredited = round2(daysCredited + res.daysCredited);
      creditedMinutes += banked ? banked.eligibleMinutes : minutes;
      expiresOn = res.expiresOn;
    }

    await tx
      .update(replacementLeaveRequest)
      .set({
        status: 'approved',
        decidedAt,
        decidedByUserId: ctx.userId ?? null,
        decisionNote: p.note?.trim() || null,
        // r336 — the header totals follow the lines for the same reason the lines follow the ledger: after
        // a re-derivation the stored grand total is the only figure left that could disagree with what was
        // credited, and the employee's own Replacement Leave table reads it.
        totalDays: daysCredited.toFixed(2),
        totalHours: round2(creditedMinutes / 60).toFixed(2),
      })
      .where(eq(replacementLeaveRequest.id, p.requestId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-request',
      aggregateId: p.requestId,
      eventType: 'replacement-leave-request.approved',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { granted, daysCredited, expiresOn, decidedAt: decidedAt.toISOString(), submittedOn: req.submittedOn },
    });

    return { status: 'approved' as const, granted, daysCredited, expiresOn };
  });
}

/**
 * r389 bc3e203d · THE EMPLOYEE WITHDRAWS THEIR OWN PENDING LEAVE CREDIT REQUEST.
 *
 * The status enum has carried 'cancelled' since migration 0381 and nothing wrote it until this function. A
 * cancelled request leaves the approver's list because that list reads `status = 'pending'`
 * (`listPendingReplacementLeaveRequests`), and it stops blocking its dates because the double-claim check
 * counts only pending and approved requests (core/credit-ot-overlap.ts BLOCKING_STATUSES).
 *
 * ── RLS IS NOT THE CONTROL HERE, AND THAT WAS VERIFIED RATHER THAN ASSUMED ─────────────────────────────
 * `replacement_leave_request_rls` (migration 0381) is a FOR ALL policy on `app.can_see_employment(employment_id)
 * OR app.can_decide_via_delegation(employment_id)`. It admits an UPDATE by the employee on their own row in ANY
 * status, and by their administrative line manager, a routed delegate and a company administrator on the
 * employee's row. It has no status predicate and no ownership predicate beyond visibility. So the two rules
 * this action exists to keep are enforced HERE, in the statement itself:
 *   1. OWN: the request's employment belongs to the session's person (`employment.person_id = ctx.personId`).
 *      A manager who can see a report's pending request through RLS is refused as "not found", exactly like
 *      a stranger, so the action cannot be used to probe which ids exist.
 *   2. PENDING: the UPDATE carries `status = 'pending'` in its WHERE and must return exactly one row, so a
 *      decision that lands between the read and the write (an approver approving in another tab) wins, and
 *      the employee is told the request has already been decided rather than silently un-approving it.
 * test/r389-leave-credit-history.test.ts drives both, with the manager's refusal as the non-vacuity case: that
 * manager CAN read the row through RLS, so the refusal can only be this guard's.
 *
 * Not gated on the `toil` module: withdrawing grants nothing, and refusing it after the module lapsed would
 * strand a request in the approver's list (the same reasoning `decideReplacementLeaveRequest` gives for
 * leaving rejection reachable).
 */
export async function cancelOwnReplacementLeaveRequest(
  ctx: SessionContext,
  p: { requestId: string },
): Promise<{ requestId: string; status: 'cancelled' }> {
  const notFound = () => new ReplacementRequestInvalidError('Leave Credit request not found.');
  const personId = ctx.personId;
  if (!personId || !/^[0-9a-f-]{36}$/i.test(p.requestId)) throw notFound();
  return withTenant(ctx, async (tx) => {
    const [req] = await tx
      .select({ id: replacementLeaveRequest.id, status: replacementLeaveRequest.status, employmentId: replacementLeaveRequest.employmentId })
      .from(replacementLeaveRequest)
      .innerJoin(employment, eq(employment.id, replacementLeaveRequest.employmentId))
      .where(and(eq(replacementLeaveRequest.id, p.requestId), eq(employment.personId, personId)))
      .limit(1);
    if (!req) throw notFound();
    if (req.status !== 'pending') {
      throw new ReplacementRequestNotPendingError('Only a pending Leave Credit request can be cancelled. This one has already been decided or cancelled.');
    }
    const updated = await tx
      .update(replacementLeaveRequest)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(replacementLeaveRequest.id, req.id),
          eq(replacementLeaveRequest.employmentId, req.employmentId),
          eq(replacementLeaveRequest.status, 'pending'),
        ),
      )
      .returning({ id: replacementLeaveRequest.id });
    if (updated.length !== 1) {
      throw new ReplacementRequestNotPendingError('Only a pending Leave Credit request can be cancelled. This one has already been decided or cancelled.');
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'replacement-leave-request',
      aggregateId: req.id,
      eventType: 'replacement-leave-request.cancelled',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { by: 'employee' },
    });
    return { requestId: req.id, status: 'cancelled' as const };
  });
}

/**
 * 5ff7daff · THE APPROVER'S QUEUE — one pending replacement-leave request per row, with the employee's
 * name and every worked-date line.
 *
 * WHY THIS DID NOT EXIST UNTIL NOW, which is the whole defect this round fixes. `decideReplacementLeaveRequest`
 * above was written, tested and deployed with NO CALLER: no screen anywhere reached it, so a request could
 * be submitted and then simply sat, seen by nobody. Production had 0 rows in `toil_accrual`,
 * `replacement_leave_request` and `replacement_leave_request_date` for exactly that reason — the employee's
 * half worked, and the manager's half did not exist. A unit test of either half passes throughout; the
 * missing thing was the EDGE between them (AGENTS.md rule 17), which is why this round also adds a
 * source-shape guard that /approvals mounts the section and posts to the decide action.
 *
 * SCOPED LIKE ITS SIBLINGS. `companyIds` is the same reporting-line scope /approvals already computes for
 * leave, corrections and travel, and RLS remains the row-visibility authority beneath it. The SELF-GRANT
 * BAN is NOT applied here: `assertCanDecide` refuses the viewer's own request at decide time, and the
 * approvals page renders it (like the leave queue does) with the buttons replaced by "Your request" — a row
 * hidden from its own subject reads as a lost request, which is the failure this whole round is about.
 */
/**
 * r336 · the one place a stored claim line becomes the view both screens render. A second copy of this
 * mapping is how the approver's queue and the employee's own list would start describing the same row
 * differently — the exact split 5ff7daff's header records for the approve path itself.
 */
function claimLineView(l: {
  workedDate: string;
  days: string | null;
  fromTime: string | null;
  toTime: string | null;
  hours: string | null;
  sourceType: ReplacementClaimSourceType | null;
  workedDayKind: ToilWorkedDayKind | null;
  shiftEnd: string | null;
  actualClockOut: string | null;
  eligibleMinutes: number | null;
}): ReplacementClaimLineView {
  return {
    workedDate: l.workedDate,
    days: l.days != null ? Number(l.days) : null,
    fromTime: l.fromTime ?? null,
    toTime: l.toTime ?? null,
    hours: l.hours != null ? Number(l.hours) : null,
    sourceType: l.sourceType ?? LEGACY_CLAIM_SOURCE_TYPE,
    workedDayKind: l.workedDayKind ?? null,
    shiftEnd: l.shiftEnd ?? null,
    actualClockOut: l.actualClockOut ?? null,
    eligibleMinutes: l.eligibleMinutes ?? null,
  };
}

export type PendingReplacementRequestRow = {
  id: string;
  employmentId: string;
  personId: string;
  employee: string;
  employeeCode: string | null;
  unit: ReplacementLeaveRequestUnit;
  totalDays: number;
  totalHours: number;
  submittedOn: string;
  createdAt: Date;
  reason: string | null;
  dates: ReplacementClaimLineView[];
};

/**
 * r336 cbfa8b0b · ONE CLAIM LINE AS A SCREEN READS IT — the shape both the approver's queue and the
 * employee's own list return.
 *
 * `sourceType` is what the APPROVER needs before anything else: a Section A row is "you worked a rest day,
 * here is the day you are claiming", and a Section B row is "you stayed late on a working day, here is the
 * shift end, the clock-out, the window you claimed and the minutes that earned it". Those are different
 * decisions and the approved plan asks for the credit source to be shown per row rather than inferred from
 * whether a time happens to be filled in — which is not inferable anyway, because an Hour-unit Section A
 * claim also carries times.
 *
 * NULL `sourceType` is a line written before r336. It is mapped to `LEGACY_CLAIM_SOURCE_TYPE` on the way
 * out rather than left null, so no screen has to carry a third case that means the same as the first.
 */
export type ReplacementClaimLineView = {
  workedDate: string;
  days: number | null;
  fromTime: string | null;
  toTime: string | null;
  hours: number | null;
  sourceType: ReplacementClaimSourceType;
  workedDayKind: ToilWorkedDayKind | null;
  shiftEnd: string | null;
  actualClockOut: string | null;
  eligibleMinutes: number | null;
};

export async function listPendingReplacementLeaveRequests(
  ctx: SessionContext,
  opts: { companyIds?: string[] } = {},
): Promise<PendingReplacementRequestRow[]> {
  return withTenant(ctx, async (tx) => {
    const heads = await tx
      .select({
        id: replacementLeaveRequest.id,
        employmentId: replacementLeaveRequest.employmentId,
        personId: employment.personId,
        employee: person.fullName,
        employeeCode: employment.employeeCode, // Employee ID left-of-name (feedback 38668d9b)
        unit: replacementLeaveRequest.unit,
        totalDays: replacementLeaveRequest.totalDays,
        totalHours: replacementLeaveRequest.totalHours,
        submittedOn: replacementLeaveRequest.submittedOn,
        createdAt: replacementLeaveRequest.createdAt,
        reason: replacementLeaveRequest.reason,
      })
      .from(replacementLeaveRequest)
      .innerJoin(employment, eq(employment.id, replacementLeaveRequest.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(
        and(
          eq(replacementLeaveRequest.status, 'pending'),
          opts.companyIds && opts.companyIds.length ? inArray(employment.companyId, opts.companyIds) : undefined,
        ),
      )
      .orderBy(desc(replacementLeaveRequest.createdAt))
      .limit(200);
    if (heads.length === 0) return [];
    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(inArray(replacementLeaveRequestDate.requestId, heads.map((h) => h.id)))
      .orderBy(replacementLeaveRequestDate.workedDate);
    const byRequest = new Map<string, ReplacementClaimLineView[]>();
    for (const l of lines) {
      const arr = byRequest.get(l.requestId) ?? [];
      arr.push(claimLineView(l));
      byRequest.set(l.requestId, arr);
    }
    return heads.map((h) => ({
      ...h,
      totalDays: Number(h.totalDays),
      totalHours: Number(h.totalHours),
      reason: h.reason ?? null,
      dates: byRequest.get(h.id) ?? [],
    }));
  });
}

export type ReplacementRequestRow = {
  id: string;
  unit: ReplacementLeaveRequestUnit;
  totalDays: number;
  totalHours: number;
  status: ReplacementLeaveRequestStatus;
  submittedOn: string;
  decidedAt: string | null;
  reason: string | null;
  dates: ReplacementClaimLineView[];
};

/** One employee's replacement-leave requests, newest first, with their worked-date lines. */
export async function listReplacementLeaveRequests(
  ctx: SessionContext,
  employmentId: string,
): Promise<ReplacementRequestRow[]> {
  return withTenant(ctx, async (tx) => {
    const heads = await tx
      .select()
      .from(replacementLeaveRequest)
      .where(eq(replacementLeaveRequest.employmentId, employmentId))
      .orderBy(desc(replacementLeaveRequest.submittedOn), desc(replacementLeaveRequest.createdAt));
    if (heads.length === 0) return [];
    const lines = await tx
      .select()
      .from(replacementLeaveRequestDate)
      .where(inArray(replacementLeaveRequestDate.requestId, heads.map((h) => h.id)))
      .orderBy(replacementLeaveRequestDate.workedDate);
    const byRequest = new Map<string, ReplacementClaimLineView[]>();
    for (const l of lines) {
      const arr = byRequest.get(l.requestId) ?? [];
      arr.push(claimLineView(l));
      byRequest.set(l.requestId, arr);
    }
    return heads.map((h) => ({
      id: h.id,
      unit: h.unit,
      totalDays: Number(h.totalDays),
      totalHours: Number(h.totalHours),
      status: h.status,
      submittedOn: h.submittedOn,
      decidedAt: h.decidedAt ? h.decidedAt.toISOString() : null,
      reason: h.reason ?? null,
      dates: byRequest.get(h.id) ?? [],
    }));
  });
}
