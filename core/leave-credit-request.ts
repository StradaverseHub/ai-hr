/**
 * r343 cbfa8b0b · THE LEAVE CREDIT REQUEST AS ONE TABLE, WITH THE DAY TYPE AS AN INPUT.
 *
 * ── WHY THIS MODULE EXISTS: THE REPORTER REVERSED THE DESIGN ────────────────────────────────────────────
 * r336 built the screen the reporter had approved then: ONE modal holding TWO SECTIONS — Section A for a
 * rest day / off day / public holiday that was worked, Section B for extended hours past the shift end of
 * an ordinary working day. The contest that reopened this item says the opposite, in as many words: "Do not
 * create separate sections/screens for these day types. All four types must be submitted from the same
 * screen and displayed in the same request table."
 *
 * So the section is no longer something the employee picks by choosing where to type. It is DERIVED from a
 * four-option Day Type — Rest Day, Off Day, Public Holiday, Ordinary Day — on a single row of a single
 * table. `sourceTypeForDayType` is that derivation and it is the whole of it: three of the four day types
 * are the old Section A, the fourth is the old Section B. Nothing below the wire changed, which is why this
 * module composes `submitReplacementLeaveRequest` rather than replacing it — the four controls that file's
 * header enumerates (the module, the employee-request switch, eligibility, the First Schedule gate) are the
 * reason a self-service credit is safe at all, and a second submit path would be a second place to forget
 * one of them.
 *
 * ── THE SECOND REVERSAL: DAY TYPE IS AN INPUT NOW, NOT A DERIVED FIELD ──────────────────────────────────
 * ⚠️ DELIBERATE CHANGE FROM THE EARLIER DESIGN, recorded here because it looks like a regression to anyone
 * who reads r336 first. In r336 the day type was READ-ONLY: resolved from the employee's roster and shown
 * beside the date, on the argument that "the kind of day a date is is not the employee's to assert". The
 * contest makes it a dropdown the employee fills in AND asks the system to "validate that the selected date
 * and Day Type are consistent with the employee's work calendar/roster". Both halves matter: the employee
 * chooses, and the roster adjudicates. A mismatch is a ROW-LEVEL refusal naming what the roster actually
 * holds, never a silent correction — a form that quietly rewrote "Rest Day" to "Off Day" would be banking a
 * claim the employee never made.
 *
 * ── AND THE ADJUDICATION IS LOAD-BEARING, NOT A COURTESY ────────────────────────────────────────────────
 * This is the part that is easy to get wrong by assuming the layer below already does it. It does NOT.
 * `submitReplacementLeaveRequest` refuses a WORKING-day row tagged as a non-working-day claim and a
 * NON-working-day row tagged as extended hours, because those two land in different code paths. It cannot
 * tell Rest Day from Off Day from Public Holiday: all three produce `sourceType: 'non_working_day'`, so a
 * row the employee typed as "Public Holiday" on a date the roster calls a rest day sails straight through
 * and is stored with `worked_day_kind: 'rest_day'`. That is exactly the inconsistency the contest asks to
 * catch, and `adjudicateDayTypes` below is the ONLY thing in the system that catches it. It therefore lives
 * in a SERVICE and runs on every submission — not in the component, where a `curl` skips it.
 *
 * ── WHAT IS NOT HERE, AND WHY ───────────────────────────────────────────────────────────────────────────
 * No new table and no new column. Every fact the contest's row carries is already stored per claim line by
 * migrations 0381 and 0487: the date, the day type resolved from the roster (`worked_day_kind`), the
 * scheduled shift end, the actual clock-out, the claimed window (`from_time`/`to_time`), the eligible
 * minutes, the credit in days — plus the status, the approver and the approval instant on the header. The
 * employee's CHOSEN day type is not stored separately because a stored row can only ever have passed the
 * adjudication above, which is the statement that the choice and `worked_day_kind` are equal; a second
 * column holding the same fact would be a second owner of it (CLAUDE.md §1).
 */
import { withTenant, type SessionContext } from '../db/client';
import { LEGACY_CLAIM_SOURCE_TYPE, type ReplacementClaimSourceType, type ToilWorkedDayKind } from '../db/schema';
import { resolveWorkedDayKindTx } from './toil';
import {
  ReplacementRequestInvalidError,
  submitReplacementLeaveRequest,
  type ReplacementRequestLineInput,
  type SubmitReplacementRequestResult,
} from './replacement-request';
// The pure half — the four-option vocabulary, the per-row conditional and the adjudication itself — lives in
// lib/ because the screen has to run the same comparison as the employee types and this file is server-only
// (db/client). lib/extended-hours.ts's precedent, same reasoning. Re-exported below so the pack facade
// carries one Leave Credit surface rather than two.
import {
  adjudicateDayTypes,
  dayTypeMismatchMessage,
  isLeaveCreditDayType,
  type LeaveCreditDayType,
  type LeaveCreditDayTypeMismatch,
} from '../lib/leave-credit-day-type';
export {
  LEAVE_CREDIT_DAY_TYPES,
  LEAVE_CREDIT_DAY_TYPE_LABEL,
  adjudicateDayTypes,
  claimsTimeWindow,
  flooredByScheduledShiftEnd,
  dayTypeMismatchMessage,
  isLeaveCreditDayType,
  type LeaveCreditDayType,
  type LeaveCreditDayTypeMismatch,
} from '../lib/leave-credit-day-type';

/**
 * THE TWO VOCABULARIES ARE PINNED EQUAL HERE, IN BOTH DIRECTIONS, and this pair of `Exclude`s is the whole
 * reason lib/ may hold a day-type list of its own. `LeaveCreditDayType` is the screen's four options;
 * `ToilWorkedDayKind` is what the roster answers, and the adjudication compares them directly.
 *
 * ⚠️ CORRECTED IN r343's FIX PASS, AND THE CORRECTION IS THE POINT. This was a single
 * `LEAVE_CREDIT_DAY_TYPES satisfies readonly ToilWorkedDayKind[]` under a comment claiming that widening
 * either vocabulary stopped compiling here. It did not: `satisfies` is ONE-DIRECTIONAL — it checks every
 * member of the array is assignable to the element type, so adding a FIFTH kind to `ToilWorkedDayKind`
 * satisfied it unchanged, and the screen would have gone on offering four options for a roster that answers
 * five. A comment asserting a property the code does not have is itself the defect (CLAUDE.md §8), so the
 * property was made true rather than the sentence softened.
 *
 * `_NOT_ON_THE_SCREEN` is every roster kind the dropdown cannot offer; `_NOT_ON_THE_ROSTER` is every option
 * the roster cannot answer. Both must be `never`, or the assignment below has type `never` and this file
 * stops compiling. test/r343-leave-credit-single-table.test.ts pins the same equality AT RUNTIME against
 * `toilWorkedDayKindEnum.enumValues`, so the day someone widens the pg enum the suite says so too — a type
 * error is invisible to `vitest`, and the enum is what the column actually accepts.
 */
type _NOT_ON_THE_SCREEN = Exclude<ToilWorkedDayKind, LeaveCreditDayType>;
type _NOT_ON_THE_ROSTER = Exclude<LeaveCreditDayType, ToilWorkedDayKind>;
const _DAY_TYPES_MATCH_THE_ROSTER_VOCABULARY: [_NOT_ON_THE_SCREEN, _NOT_ON_THE_ROSTER] extends [never, never]
  ? true
  : never = true;
void _DAY_TYPES_MATCH_THE_ROSTER_VOCABULARY;

/**
 * The claim path a chosen day type implies — the whole of what used to be "which section is this row in".
 *
 * `LEGACY_CLAIM_SOURCE_TYPE` is referenced rather than spelled as a literal so the three non-working kinds
 * and every pre-r336 stored row keep answering the same way if that constant ever moves.
 *
 * ⚠️ r358 — THIS NOW TESTS THE DAY TYPE DIRECTLY, AND THE CHANGE IS THE WHOLE POINT OF WRITING IT OUT. It
 * read `claimsTimeWindow(dayType) ? …`, which was the same answer while only a workday claimed a window.
 * r358 made every day type claim one, so leaving it keyed on that predicate would have routed a rest-day
 * claim into `accrueExtendedWorkdayToilTx` — a function that refuses anything whose day kind is not
 * `workday` (its Gate 2), banks `workedDayKind: 'workday'` unconditionally, and is gated on the
 * extended-hours company switch. A rest day would have been refused at approval, or worse, banked as a
 * working day.
 *
 * THE SOURCE TYPE IS THE CREDITING ROUTE, NOT THE SHAPE OF THE CLAIM. That distinction did not exist while
 * the two coincided; it does now. The route still splits on "was this an ordinary working day, whose credit
 * is re-derived from the attendance record" versus "was this a non-working day the employee declared".
 */
export function sourceTypeForDayType(dayType: LeaveCreditDayType): ReplacementClaimSourceType {
  return dayType === 'workday' ? 'extended_hours' : LEGACY_CLAIM_SOURCE_TYPE;
}

/** One row of the single table, exactly as the screen posts it. */
export type LeaveCreditRowInput = {
  workedDate: string;
  dayType: LeaveCreditDayType;
  /**
   * ⚠️ r358 — `days` IS GONE FROM THE POSTED ROW, and its absence is the item. It carried the employee's
   * chosen "1 or 0.5" on a rest day, off day or public holiday. The owner's answer on 70294f7a replaced
   * the choice with the arithmetic: "4 hours of eligible work = 0.5 day. 8 hours of eligible work = 1.0
   * day … regardless of the Day Type." A field the form no longer offers is removed rather than left
   * optional, so a caller that still sends one fails to compile instead of being quietly ignored.
   */
  /** The claimed window. EVERY day type carries one since r358. */
  claimStart?: string;
  claimEnd?: string;
};

/**
 * A submission refused because a chosen Day Type is not what the roster holds. Carries the rows so the
 * screen can mark the offending ones rather than the whole form — the same shape
 * `LeaveCreditSectionMismatchError` uses, for the same reason.
 */
export class LeaveCreditDayTypeMismatchError extends Error {
  readonly rows: readonly LeaveCreditDayTypeMismatch[];
  constructor(rows: readonly LeaveCreditDayTypeMismatch[]) {
    super(dayTypeMismatchMessage(rows));
    this.name = 'LeaveCreditDayTypeMismatchError';
    this.rows = rows;
  }
}

/**
 * What the roster holds for each of these dates, for the signed-in employee. RLS-scoped (an employee may
 * resolve their own schedule), and the same `resolveWorkedDayKindTx` the attendance engine, the roster
 * election and both accrual paths use — there is one answer to "what kind of day is this" in this system.
 */
export async function leaveCreditRosterKinds(
  ctx: SessionContext,
  employmentId: string,
  dates: readonly string[],
): Promise<Map<string, ToilWorkedDayKind>> {
  const distinct = [...new Set(dates)];
  return withTenant(ctx, async (tx) => {
    const out = new Map<string, ToilWorkedDayKind>();
    for (const d of distinct) out.set(d, await resolveWorkedDayKindTx(tx, employmentId, d));
    return out;
  });
}

/**
 * Submit the single-table Leave Credit request.
 *
 * ── ORDER OF OPERATIONS, AND WHY THE ADJUDICATION IS FIRST ──────────────────────────────────────────────
 * The shape checks and the roster adjudication run BEFORE `submitReplacementLeaveRequest`, so an employee
 * who typed the wrong day type is told which rows and what the roster holds — rather than getting the layer
 * below's working/non-working sentence, which is true but does not name the day the roster has, and which
 * never fires at all for a rest-day / off-day mix-up. Everything the layer below enforces it still enforces:
 * this function adds a refusal, it removes none.
 *
 * TWO TRANSACTIONS, ON PURPOSE. The roster read is its own; the write is the one inside
 * `submitReplacementLeaveRequest`. A roster that changed in between is caught by that function's own
 * re-resolution for a working/non-working crossover, and by `accrueSelfDeclaredToilTx` /
 * `accrueExtendedWorkdayToilTx` at approval, which is the binding moment for every one of these facts.
 * Reaching inside that function for a shared `tx` would mean copying its four controls out here.
 */
export async function submitLeaveCreditRequest(
  ctx: SessionContext,
  p: {
    employmentId: string;
    leaveTypeId?: string | null;
    rows: readonly LeaveCreditRowInput[];
    reason?: string;
    firstScheduleConsent?: boolean;
    today: string;
  },
): Promise<SubmitReplacementRequestResult> {
  if (p.rows.length === 0) throw new ReplacementRequestInvalidError('Add at least one worked date.');
  for (const r of p.rows) {
    if (!isLeaveCreditDayType(r.dayType)) throw new ReplacementRequestInvalidError('Choose a day type for every date worked.');
    // r358 — EVERY day type, not just an ordinary one. The message no longer says "after your scheduled
    // shift end", because on the other three there is no scheduled end to be after: the whole entered
    // window is the claim.
    if (!r.claimStart || !r.claimEnd)
      throw new ReplacementRequestInvalidError(`Enter the start and end time claimed for ${r.workedDate}.`);
    // The owner's validation rule, and the one place it can be stated for all four types. An EMPTY window
    // is refused here; a window whose end reads earlier than its start is NOT, because that is how a shift
    // across midnight is entered and `assessExtendedClaim` has rolled it to the following day since r353.
    // Refusing it would delete the night-shift claim this item exists to make possible. Reported back on
    // the item as a deviation from the letter of "if Extended End is earlier than Extended Start, display
    // an error", with this reason.
    if (r.claimStart === r.claimEnd)
      throw new ReplacementRequestInvalidError(`The start and end time claimed for ${r.workedDate} are the same.`);
  }

  const mismatches = adjudicateDayTypes(
    p.rows.map((r) => ({ workedDate: r.workedDate, dayType: r.dayType })),
    await leaveCreditRosterKinds(ctx, p.employmentId, p.rows.map((r) => r.workedDate)),
  );
  if (mismatches.length > 0) throw new LeaveCreditDayTypeMismatchError(mismatches);

  // The unit is DERIVED and always 'day'. Both halves of the table credit in days — a non-working day
  // because it is claimed as a day, an ordinary day because r334's tier ladder answers 0.5 or 1.0 and never
  // a proportion — so there is nothing left for an Hour request to mean. r336's reasoning, unchanged.
  // r358 — ONE SHAPE FOR ALL FOUR TYPES: a window, and no declared days. The credit for a non-working day
  // is derived from the window by the same tier ladder an ordinary day uses, inside
  // `submitReplacementLeaveRequest`, which is where the company's thresholds are already in hand. The day
  // type still picks the crediting ROUTE through `sourceTypeForDayType` — see its header for why those are
  // two different questions now.
  const lines: ReplacementRequestLineInput[] = p.rows.map((r) => ({
    workedDate: r.workedDate,
    sourceType: sourceTypeForDayType(r.dayType),
    workedDayKind: r.dayType,
    fromTime: r.claimStart,
    toTime: r.claimEnd,
  }));

  return submitReplacementLeaveRequest(ctx, {
    employmentId: p.employmentId,
    leaveTypeId: p.leaveTypeId ?? null,
    unit: 'day',
    lines,
    reason: p.reason,
    firstScheduleConsent: p.firstScheduleConsent,
    today: p.today,
  });
}
