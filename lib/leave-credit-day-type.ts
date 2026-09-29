/**
 * r343 cbfa8b0b · THE DAY TYPE VOCABULARY AND ITS ADJUDICATION, IN ONE PLACE THE SERVER AND THE BROWSER
 * CAN BOTH READ.
 *
 * ── WHY IT IS IN lib/ AND NOT IN THE SERVICE ────────────────────────────────────────────────────────────
 * The contest makes Day Type an INPUT on a single table, and the screen has to mark a row whose chosen type
 * is not what the roster holds AS THE EMPLOYEE PICKS IT — so the comparison has to run in the browser. The
 * service that enforces it (core/leave-credit-request.ts) imports db/client and is server-only. This is the
 * arrangement lib/extended-hours.ts already established for the credit tiers, for the identical reason its
 * header gives: the alternative is a second copy in the component, and two implementations of a rule agree
 * only until one of them is changed.
 *
 * PURE. No imports, no clock, no database. That is what makes it safe on both sides of the boundary.
 */

/**
 * The four options of the Day Type dropdown, in the order the reporter listed them: Rest Day, Off Day,
 * Public Holiday, Ordinary Day.
 *
 * Deliberately the SAME vocabulary as `ToilWorkedDayKind` (db/schema) rather than a parallel one — the
 * roster answers in that vocabulary and the adjudication below compares the two directly, so a mapping
 * table (which is where a fifth day type gets silently dropped) is never needed. core/leave-credit-request
 * pins the two sets equal IN BOTH DIRECTIONS (a pair of `Exclude`s that must both be `never`; a lone
 * `satisfies` would not have caught a WIDENED roster), and the suite pins the same equality at runtime
 * against `toilWorkedDayKindEnum.enumValues`.
 */
export const LEAVE_CREDIT_DAY_TYPES = ['rest_day', 'off_day', 'holiday', 'workday'] as const;
export type LeaveCreditDayType = (typeof LEAVE_CREDIT_DAY_TYPES)[number];

/** Narrows a posted string. Anything else is a tampered or stale form field, never a day type. */
export function isLeaveCreditDayType(v: unknown): v is LeaveCreditDayType {
  return typeof v === 'string' && (LEAVE_CREDIT_DAY_TYPES as readonly string[]).includes(v);
}

/**
 * Does this day type claim a time window? EVERY ONE OF THEM DOES, since r358.
 *
 * ⚠️ REVERSED BY THE OWNER, IN WRITING, AND THE OLD RULE IS QUOTED HERE BECAUSE IT WAS ARGUED FOR AT
 * LENGTH (CLAUDE.md §8: a sentence pinning a decision you are reversing is updated, not deleted). This
 * function used to return `dayType === 'workday'` under this reasoning:
 *
 *     "ONLY AN ORDINARY DAY DOES, and that asymmetry is the one thing the single table has to express. A
 *      rest day, off day or public holiday is claimed as a whole day or half of one; an ordinary day earns
 *      a credit only for the hours worked AFTER the scheduled shift end, so it needs the claimed start and
 *      end."
 *
 * The owner's answer on item 70294f7a (2026-09-29, released from the block) replaces it:
 *
 *     "Whether the employee works on a Normal Working Day, Rest Day, Off Day, or Public Holiday, the Leave
 *      Credit calculation rule is the same. 4 hours of eligible work = 0.5 day … The system should
 *      calculate the credit based on the actual eligible hours worked, regardless of the Day Type. … Day
 *      Type is only for identifying whether the employee worked on a Normal Working Day / Rest Day / Off
 *      Day / Public Holiday. It must not change the 4-hour = 0.5 day and 8-hour = 1 day calculation rule."
 *
 * So the asymmetry the old rule expressed is gone: the declared "1 or 0.5 days" dropdown is gone with it,
 * and every row is claimed as a window. WHAT STILL DIFFERS PER DAY TYPE IS ONE THING ONLY, and it is
 * `flooredByScheduledShiftEnd` below — not this.
 *
 * KEPT AS A FUNCTION RATHER THAN DELETED even though it now answers the same for every input: it is the
 * name the screen, the service and their guards all reach for, and a reader who greps it has to land on
 * this reversal rather than on nothing. It will read as dead weight to someone who does not know that.
 */
export function claimsTimeWindow(_dayType: LeaveCreditDayType): boolean {
  return true;
}

/**
 * Does the SCHEDULED SHIFT END floor the claimed window? Only on an ordinary working day.
 *
 * THIS IS WHAT THE DAY TYPE STILL DECIDES, and it is the honest remainder of the rule reversed above. On a
 * working day the employee was already being paid to be there until the shift ended, so only the hours
 * AFTER it are extra — `assessExtendedClaim` floors the window at `max(claimStart, shiftEnd)`. On a rest
 * day, an off day or a public holiday there is no scheduled work at all, so there is nothing to be "after":
 * the whole entered window is the claim, which is exactly what the owner asked for —
 * "Extended End – Extended Start = Eligible Hours".
 *
 * ⚠️ IT IS DECIDED HERE AND NOT BY "the roster happens to hold no shift end". A roster CAN carry a shift on
 * a rest day (a swapped day, a correction, a pattern that was edited after the fact), and if it does, the
 * floor would silently eat the first hours of a rest-day claim — the one day type where the employee was
 * never scheduled to be there. Passing `shiftEnd: null` on those three types is a statement of the rule,
 * not a convenience.
 */
export function flooredByScheduledShiftEnd(dayType: LeaveCreditDayType): boolean {
  return dayType === 'workday';
}

/** One row whose chosen day type is not what the roster holds for that date. */
export type LeaveCreditDayTypeMismatch = {
  workedDate: string;
  chosen: LeaveCreditDayType;
  /** What the employee's own work calendar / roster actually holds. Named in the refusal on purpose. */
  roster: LeaveCreditDayType;
};

/**
 * THE ADJUDICATION — pure, so the rule is testable without a roster and cannot differ between the screen's
 * preview and the submission's refusal.
 *
 * ⚠️ THIS IS THE ONLY THING IN THE SYSTEM THAT CATCHES A REST-DAY / OFF-DAY / PUBLIC-HOLIDAY MIX-UP, and
 * that is easy to miss by assuming the layer below already does it. `submitReplacementLeaveRequest` refuses
 * a working-day row claimed as a non-working day and vice versa, because those two land in different code
 * paths — but all three non-working kinds produce the same claim path, so a row typed "Public Holiday" on a
 * date the roster calls a rest day sails straight through it. The contest asks for exactly that to be
 * caught: "validate that the selected date and Day Type are consistent with the employee's work
 * calendar/roster".
 *
 * A date the roster has not answered for is NOT a mismatch. The caller resolves every date it was given, so
 * a missing entry means the read did not answer, and refusing a row on the strength of an answer nobody gave
 * would fail closed against the employee for a reason they cannot act on.
 */
export function adjudicateDayTypes(
  rows: readonly { workedDate: string; dayType: LeaveCreditDayType }[],
  rosterKinds: ReadonlyMap<string, LeaveCreditDayType>,
): LeaveCreditDayTypeMismatch[] {
  const out: LeaveCreditDayTypeMismatch[] = [];
  for (const r of rows) {
    const roster = rosterKinds.get(r.workedDate);
    if (roster === undefined) continue;
    if (roster !== r.dayType) out.push({ workedDate: r.workedDate, chosen: r.dayType, roster });
  }
  return out;
}

/**
 * The day-type names the SERVICE's refusal uses. Plain English, like every other error string in these
 * modules (`ToilOrdinaryWorkingDayError`, `SECTION_A_WORKING_DAY_MESSAGE`); the SCREEN composes its own
 * labels from the `replacementRequest.dayKind` keys, which exist translated in all six locales.
 */
export const LEAVE_CREDIT_DAY_TYPE_LABEL: Record<LeaveCreditDayType, string> = {
  rest_day: 'Rest day',
  off_day: 'Off day',
  holiday: 'Public holiday',
  workday: 'Ordinary working day',
};

/**
 * The refusal, naming WHAT THE ROSTER HOLDS for every offending date.
 *
 * "This does not match your roster" is useless advice: the employee cannot see the roster from this screen,
 * so they have nothing to correct the row to. Every message here therefore carries both halves — what was
 * chosen and what the roster has — and all offending rows are listed at once rather than one per round trip.
 */
export function dayTypeMismatchMessage(rows: readonly LeaveCreditDayTypeMismatch[]): string {
  return rows
    .map(
      (r) =>
        `${r.workedDate}: you chose ${LEAVE_CREDIT_DAY_TYPE_LABEL[r.chosen]}, but your roster has ${LEAVE_CREDIT_DAY_TYPE_LABEL[r.roster]} for that date.`,
    )
    .join(' ');
}
