/**
 * r336 cbfa8b0b · THE EXTENDED-HOURS ARITHMETIC, IN ONE PLACE THE SERVER AND THE BROWSER CAN BOTH READ.
 *
 * ── WHY IT MOVED HERE, AND WHAT DID NOT CHANGE ──────────────────────────────────────────────────────────
 * `extendedHoursCreditDays` is r334's, byte for byte, including its header's reasoning about why the grace
 * period is a subtraction rather than a cut-off. It was in core/toil.ts, which is server-only — it imports
 * db/client. Section B of the Leave Credit request has to show the employee the eligible minutes and the
 * credit as they type, so the same function has to run in the browser, and the only honest way to do that
 * is to move it somewhere neither side owns rather than write a second copy in the component.
 *
 * A SECOND COPY IS THE FAILURE MODE THIS AVOIDS, and it is not hypothetical: the form's figure is the one
 * the employee checks before submitting, and the server's is the one that gets banked. Two implementations
 * of "240 minutes is half a day, rounded down, capped at one" agree until a company changes a threshold,
 * and then the screen promises a credit the approval refuses. core/toil.ts re-exports both names, so every
 * existing importer of `extendedHoursCreditDays` is unaffected.
 *
 * PURE. No imports, no clock, no database. That is what makes it safe on both sides of the boundary.
 */

/** The four policy figures the arithmetic reads (r334's `toil_policy` block, minus the switch). */
export type ExtendedHoursTiers = {
  /** Counted minutes past shift end that earn 0.5 day. */
  extendedHalfDayMinutes: number;
  /** Counted minutes that earn 1.0 day, which is also the per-day cap. */
  extendedFullDayMinutes: number;
  /** Unpaid break taken AFTER shift end, deducted before the tiers are tested. */
  extendedBreakMinutes: number;
  /** The first N minutes past shift end do not count at all. */
  extendedGraceMinutes: number;
};

/**
 * r334 928f0454 · THE TIERS. Rounded DOWN, no partial credit, one day is the cap.
 *
 * `< half` earns nothing at all (not a pro-rata sliver); `>= half and < full` earns 0.5; `>= full` earns 1.0
 * and never more, however long the day ran. The break deduction and the grace period come off BEFORE the
 * thresholds are tested, in that order, because both describe minutes that were never extended work in the
 * first place — subtracting after the test would let a day qualify on minutes the policy says do not exist.
 *
 * THE GRACE PERIOD IS A SUBTRACTION, NOT A CUT-OFF, and that is a decision rather than a reading of the
 * obvious. "Grace period before counting" says the first N minutes do not count, so a 15-minute grace turns
 * 4h15m of extended work into 4h00m of counted work. The alternative reading — "under N minutes, count
 * nothing, at or over N count all of it" — is a threshold, and this policy ALREADY HAS two of those in the
 * half-day and full-day figures; a third would be redundant with them and unreachable in practice (any
 * grace small enough to be called a grace is far below a four-hour half-day threshold, so it could never
 * change an answer). Both defaults are 0, so a company that sets neither gets `counted === extended`.
 *
 * ⚠️ NOT COMPOSED WITH `accrualBasis`. See `extendedWorkdayCreditTx` in core/toil.ts for why the tiers and
 * `premium_equivalent` are two answers to the same question and only one of them may run.
 */
export function extendedHoursCreditDays(
  extendedMinutes: number,
  policy: ExtendedHoursTiers,
): { countedMinutes: number; days: number } {
  const countedMinutes = Math.max(0, Math.round(extendedMinutes) - policy.extendedBreakMinutes - policy.extendedGraceMinutes);
  const days = countedMinutes >= policy.extendedFullDayMinutes ? 1 : countedMinutes >= policy.extendedHalfDayMinutes ? 0.5 : 0;
  return { countedMinutes, days };
}

/** Minutes from midnight for an `HH:MM` or `HH:MM:SS` string; NaN on anything else. */
function timeToMinutes(t: string | null | undefined): number {
  if (!t) return NaN;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

/**
 * r336 cbfa8b0b · HOW MANY OF THE EMPLOYEE'S CLAIMED MINUTES ARE ELIGIBLE — the derived figure the Leave
 * Credit table shows beside every row, and the one the tier ladder is then tested against.
 *
 * ── ⚠️ r353 cbfa8b0b · THE OWNER REVERSED THE RULE: THE ENTERED WINDOW *IS* THE CLAIM ──────────────────
 * Two paragraphs used to sit here arguing FOR two reducers that are now gone. They are REWRITTEN rather
 * than deleted, because the argument was long and explicit and a later reader has to be able to see which
 * way the decision went (CLAUDE.md §8: prose outlives the kernel, and a sentence pinning a decision you are
 * reversing is updated, not removed).
 *
 * WHAT THEY SAID.
 *  (1) "THE CLAIM NARROWS A MEASURED FIGURE; IT NEVER WIDENS ONE." The answer was capped at
 *      `measuredExtendedMinutes` — the attendance engine's `extendedMinutesAfterShiftEnd` over the day's
 *      stored `ot_minutes` — "so the screen cannot mint minutes, so it cannot mint a credit, so it cannot
 *      suppress an hour of overtime pay that was never worked".
 *  (2) "THE WINDOW IS ALSO CLIPPED TO [shift end, actual clock-out] WHEN BOTH ARE KNOWN", so that the
 *      figure on screen matched the two read-only times printed next to it.
 *
 * WHY BOTH ARE GONE. The reporter's own repro on cbfa8b0b — a shift ending 18:00, clocked out at 18:00,
 * nothing measured, and a claimed window of 18:00–23:51 — returned ZERO, and it returned zero TWICE OVER:
 * the clip alone gave 0, and with the clip removed the cap still gave 0. Traced by execution before the
 * plan was written, which is also why the reporter's own proposed fix (drop the clock-out) would not have
 * fixed the reporter's own example. The owner then reversed the rule: the employee's entered window IS the
 * claim. An attendance row is a convenience that is routinely missing or wrong — nobody clocks out after a
 * late release — and a rule that silently answers "no credit" for work that was done is worse than one that
 * asks a human to look.
 *
 * ⚠️ MONEY · WHERE THE SAFETY PROPERTY WENT: TO THE APPROVER, AND THAT IS WHAT `assessExtendedClaim` IS FOR.
 * It did not evaporate, it moved, and moving it is only honest if the approver can actually see the thing
 * the kernel stopped enforcing. So the discrepancy is RETURNED rather than swallowed: one computation
 * yields the minutes AND whether the claimed end runs past the recorded clock-out AND whether there is a
 * clock-out at all, and the request table and the approvals queue render that same result. Replacement
 * leave blocks overtime pay for the same hours (ADR-0033) and converts to cash on expiry, so after this
 * change the line manager is the ONLY check on a claimed window. That is the owner's decision, recorded on
 * cbfa8b0b — not an oversight here.
 *
 * ── WHAT IS KEPT, AND NONE OF IT IS AN OVERSIGHT ───────────────────────────────────────────────────────
 * THE SHIFT-END FLOOR STAYS. Minutes before the scheduled shift end are ordinary rostered work, not
 * extended work, whoever types them: a 17:00–22:00 window on a shift ending 18:00 is 240 eligible minutes,
 * not 300. That is the DEFINITION of the thing being claimed, not a check on the person claiming it.
 * THE CROSS-MIDNIGHT ROLL STAYS. An end BEFORE the start is read as the next day (+1440), which is what
 * extended hours after an evening shift look like. It is NOT read as a typo, because for THIS field a
 * reversed pair is the ordinary case rather than the mistake — unlike `minutesBetween` in
 * core/replacement-request.ts, which is a same-day hours claim and refuses one.
 *
 * ⚠️ r362 58424c7f — THE ROLL'S CONDITION IS NOW A NAMED, EXPORTED PREDICATE (`claimCrossesMidnight`), AND
 * THE ROLL ASKS IT RATHER THAN RE-SPELLING IT. The reporter asked for an end-before-start REFUSAL and did
 * not get one, for the reason above; what they get instead is the Leave Credit row SAYING how the window
 * was read. A screen that decided when to print that by parsing the two times a second time would be a
 * second implementation of this rule, and the note and the minutes printed beside it would disagree the
 * first time either moved. So there is ONE comparison in the codebase and both readers call it. Nothing
 * about the arithmetic changed: the predicate is `end0 < start` on `timeToMinutes`, exactly as it was, so
 * 18:00→18:00 is still zero minutes rather than 1440 (the money fix below) and still not a cross-midnight
 * row.
 *
 * ⚠️ AND THE ROLL NOW TESTS `<` RATHER THAN `<=`, WHICH IS A FIX THE CAP WAS HIDING. `end === start` is
 * ambiguous — zero minutes or twenty-four hours — and this file used to roll it, producing 1440. That was
 * harmless only because the measured cap then cut it back; with the cap gone, 18:00→18:00 typed by mistake
 * became 1440 minutes and, through the tier ladder, A FULL DAY OF CREDIT. Verified by execution before it
 * was changed. A zero-length window reads as zero, which is the conservative reading and the one the
 * paragraph above always claimed: an employee who means a 24-hour claim can type the next day's time.
 * THE TIER LADDER IS STILL THE WHOLE-DAY CAP. `extendedHoursCreditDays` above still rounds down and still
 * stops at 1.0 day, so a 23-hour window cannot become more than one day of credit however it is typed.
 */
export type ExtendedClaimAssessment = {
  /** Eligible minutes: the claimed window, floored at the scheduled shift end, rolled across midnight. */
  minutes: number;
  /**
   * Whether an actual clock-out is on record for the day AT ALL.
   *
   * ⚠️ NAMED FOR WHAT IT CAN ASSERT. The approvals queue derives this from the two times STORED on the
   * claim line (no migration), where a day with an attendance row but no clock-out and a day with no row at
   * all are the same absence — `extendedHoursDayForTx` returns `row?.checkOutAt ?? null` for both. So this
   * says "there is no clock-out to compare with", which is true in either case and checkable from here,
   * rather than "there is no attendance row", which from this input would be a guess.
   */
  hasClockOut: boolean;
  /**
   * The claimed end runs PAST the recorded clock-out — the amber warning both screens print. FALSE when
   * there is no clock-out at all: that case is `hasClockOut` and reads differently to an approver.
   */
  exceedsClockOut: boolean;
};

/**
 * r362 58424c7f · DOES THIS CLAIMED WINDOW RUN PAST MIDNIGHT? — the roll's own condition, named once so a
 * screen can say what the arithmetic did without deriving it a second time.
 *
 * ⚠️ NOT A VALIDATION, AND NOTHING READS IT AS ONE. A reversed pair is the ORDINARY way a night shift is
 * entered (see the header), so this answers "how was it read", never "is it wrong". The Leave Credit row
 * prints a MUTED note off this — not amber, not red — because an amber note here would teach employees
 * that a correctly entered night shift is a problem.
 *
 * `false` for an unparseable time, which matches `assessExtendedClaim` below: it returns zero minutes for
 * the same input, so there is no reading to describe.
 */
export function claimCrossesMidnight(claimStart: string | null | undefined, claimEnd: string | null | undefined): boolean {
  const start = timeToMinutes(claimStart);
  const end0 = timeToMinutes(claimEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end0)) return false;
  // STRICTLY LESS THAN, and the `<`/`<=` distinction is the money fix r353 hand-made: see the header.
  return end0 < start;
}

/**
 * THE ONE COMPUTATION. `eligibleExtendedMinutes` below is a projection of this, so the figure an approver
 * sees and the warning beside it can never come from two different readings of the same row.
 *
 * ⚠️ THE ONE THING THIS CANNOT SEE, stated rather than left to be discovered. `actualClockOut` is a TIME OF
 * DAY with no date on it, so a clock-out EARLIER than the claimed start is read as belonging to the
 * following day (`clockOutRaw < start ⇒ +1440`) — the rule this file already carried, unchanged, because it
 * is what makes an 00:30 clock-out after an 18:00 shift end six and a half hours rather than minus
 * seventeen. The blind spot that rule leaves: an employee who clocked out BEFORE the window they claim
 * (left at 17:00, claims 18:00–23:51) is read as having clocked out at 17:00 the next day, so
 * `exceedsClockOut` stays false and no warning is raised. The approver still has the clock-out printed on
 * the row beside the claimed window, which is the reading that catches it. Fixing it properly needs a
 * dated clock-out from the attendance engine, not a better guess here.
 */
export function assessExtendedClaim(p: {
  claimStart: string;
  claimEnd: string;
  shiftEnd: string | null;
  actualClockOut: string | null;
}): ExtendedClaimAssessment {
  const clockOutRaw = timeToMinutes(p.actualClockOut);
  const hasClockOut = Number.isFinite(clockOutRaw);
  const start = timeToMinutes(p.claimStart);
  const end0 = timeToMinutes(p.claimEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end0)) return { minutes: 0, hasClockOut, exceedsClockOut: false };
  // Cross-midnight: an end BEFORE the start belongs to the following day. `end === start` is zero, not 1440
  // — see the header; the measured cap used to hide that and its removal exposed a full day of free credit.
  // r362 — asked of `claimCrossesMidnight` rather than re-spelled, so the note the Leave Credit row prints
  // and the minutes printed beside it cannot come from two readings of one row. Same comparison, same result.
  const end = claimCrossesMidnight(p.claimStart, p.claimEnd) ? end0 + 1440 : end0;
  const shiftEnd = timeToMinutes(p.shiftEnd);
  // The clock-out is read on the same day-rolled axis as the claim, so a 00:30 clock-out after an 18:00
  // shift end does not read as 30 minutes past midnight ON THE MORNING OF the worked date.
  const clockOut = hasClockOut && clockOutRaw < start ? clockOutRaw + 1440 : clockOutRaw;
  // The floor is the scheduled shift end when there is one (no assigned shift ⇒ no scheduled end, and then
  // the claimed start is the floor). There is deliberately no ceiling any more: see the header.
  const lo = Number.isFinite(shiftEnd) ? Math.max(start, shiftEnd) : start;
  return {
    minutes: Math.max(0, Math.round(end - lo)),
    hasClockOut,
    exceedsClockOut: hasClockOut && end > clockOut,
  };
}

/**
 * The eligible minutes alone, for the two kernel paths that bank the credit (`accrueExtendedWorkdayToilTx`
 * and `submitReplacementLeaveRequest`) — the tier ladder's input.
 *
 * ⚠️ `measuredExtendedMinutes` IS NO LONGER A PARAMETER, and dropping it from the signature is deliberate
 * rather than tidying: it was the cap, the cap is the thing the owner reversed, and a parameter left in
 * place "for later" is how a reducer comes back. Every caller that still believed the measured figure bore
 * on the answer now fails to compile instead of quietly agreeing.
 */
export function eligibleExtendedMinutes(p: {
  claimStart: string;
  claimEnd: string;
  shiftEnd: string | null;
  actualClockOut: string | null;
}): number {
  return assessExtendedClaim(p).minutes;
}

/**
 * r406 952129bb · ONE LEAVE CREDIT ROW'S WINDOW → DAYS. THE ONLY PLACE A CLAIMED WINDOW BECOMES A CREDIT.
 *
 * ⚠️ MONEY. A Leave Credit suppresses the worked day's overtime pay (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS)
 * and, for a First-Schedule employee, converts to cash on expiry. Until r406 the window → days step was
 * written out at FOUR call sites — the screen's `derive`, the employee submit's non-working-day loop, the
 * same submit's ordinary-day loop, and the ordinary-day approval (`accrueExtendedWorkdayToilTx`) — each a
 * pair of calls to the two functions above, each deciding the shift-end floor for itself. HR's + Add Leave
 * Credit (`grantLeaveCreditRows`) is a fifth, and the item is "a day worked earns the same credit whether
 * the employee asks for it or HR enters it". Five copies of a two-line rule agree until one of them is
 * edited; one function cannot disagree with itself.
 *
 * `ordinaryWorkingDay` IS THE ONE THING THE DAY TYPE DECIDES (`flooredByScheduledShiftEnd`): on an ordinary
 * working day the window is floored at the scheduled shift end, because the hours before it were already
 * rostered; on a rest day, off day or public holiday the whole entered window is the claim, so the shift end
 * and clock-out are DROPPED HERE rather than trusted to every caller to pass null. Callers pass the day's
 * facts as they have them and the rule decides what reaches `assessExtendedClaim`.
 *
 * Returns the counted minutes, the tier (0 / 0.5 / 1) and the clock-out warning the screen prints. A tier
 * of 0 is NOT refused here — this file is pure and server and browser both read it; each server caller
 * refuses it with `ToilExtendedHoursBelowThresholdError`, the screen blocks its submit.
 */
export function leaveCreditWindowCredit(p: {
  ordinaryWorkingDay: boolean;
  claimStart: string;
  claimEnd: string;
  shiftEnd: string | null;
  actualClockOut: string | null;
  tiers: ExtendedHoursTiers;
}): { countedMinutes: number; days: number; exceedsClockOut: boolean } {
  const assessed = assessExtendedClaim({
    claimStart: p.claimStart,
    claimEnd: p.claimEnd,
    shiftEnd: p.ordinaryWorkingDay ? p.shiftEnd : null,
    actualClockOut: p.ordinaryWorkingDay ? p.actualClockOut : null,
  });
  const { countedMinutes, days } = extendedHoursCreditDays(assessed.minutes, p.tiers);
  return { countedMinutes, days, exceedsClockOut: assessed.exceedsClockOut };
}
