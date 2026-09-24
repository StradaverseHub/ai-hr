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
 * r336 cbfa8b0b · HOW MANY OF THE EMPLOYEE'S CLAIMED MINUTES ARE ELIGIBLE — the derived figure Section B
 * shows beside every row, and the one the tier ladder is then tested against.
 *
 * ── THE CLAIM NARROWS A MEASURED FIGURE; IT NEVER WIDENS ONE ────────────────────────────────────────────
 * `measuredExtendedMinutes` is r334's `extendedMinutesAfterShiftEnd` over the day's stored `ot_minutes` —
 * the authoritative record of how long this person actually worked past their scheduled shift end, owned by
 * the attendance engine and already the basis payroll pays from. The employee's window can only take AWAY
 * from it: someone who stayed until 23:00 but only wants to claim to 22:00 gets 22:00, and someone who
 * types 02:00 on a day the engine measured two hours of extended work gets two hours. That asymmetry is the
 * entire safety property here — the screen cannot mint minutes, so it cannot mint a credit, so it cannot
 * suppress an hour of overtime pay that was never worked.
 *
 * ── THE WINDOW IS ALSO CLIPPED TO [shift end, actual clock-out] WHEN BOTH ARE KNOWN ──────────────────────
 * Not as a second measurement — the cap above already bounds the answer — but so the FIGURE ON SCREEN
 * matches the two read-only times printed next to it. A row that says "shift ended 18:00, clocked out
 * 22:00, claimed 17:00–22:00, eligible 300" is a row an approver has to reconcile by hand; clipping makes
 * it say 240. Each clip is skipped when its time is unknown (no assigned shift ⇒ no scheduled end; an
 * unclosed day ⇒ no clock-out), which is a narrower answer, never a wider one, because the cap still holds.
 *
 * ── CROSS-MIDNIGHT ─────────────────────────────────────────────────────────────────────────────────────
 * An end at or before the start is read as the next day (+1440), which is what extended hours after an
 * evening shift look like. It is NOT read as a typo, because for THIS field a reversed pair is the ordinary
 * case rather than the mistake — unlike `minutesBetween` in core/replacement-request.ts, which is a
 * same-day hours claim and refuses one. A zero-length window still yields zero minutes and no credit.
 */
export function eligibleExtendedMinutes(p: {
  claimStart: string;
  claimEnd: string;
  shiftEnd: string | null;
  actualClockOut: string | null;
  measuredExtendedMinutes: number;
}): number {
  const start = timeToMinutes(p.claimStart);
  const end0 = timeToMinutes(p.claimEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end0)) return 0;
  // Cross-midnight: an end at or before the start belongs to the following day.
  const end = end0 <= start ? end0 + 1440 : end0;
  const shiftEnd = timeToMinutes(p.shiftEnd);
  const clockOutRaw = timeToMinutes(p.actualClockOut);
  // The clock-out is clipped on the same day-rolled axis as the claim, so a 00:30 clock-out after an 18:00
  // shift end does not read as 30 minutes past midnight ON THE MORNING OF the worked date.
  const clockOut = Number.isFinite(clockOutRaw) && clockOutRaw < start ? clockOutRaw + 1440 : clockOutRaw;
  const lo = Number.isFinite(shiftEnd) ? Math.max(start, shiftEnd) : start;
  const hi = Number.isFinite(clockOut) ? Math.min(end, clockOut) : end;
  const claimed = Math.max(0, hi - lo);
  return Math.max(0, Math.min(Math.round(claimed), Math.max(0, Math.round(p.measuredExtendedMinutes))));
}
