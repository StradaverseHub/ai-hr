/**
 * r429 (f6819e19) — THE BREAK ROW RULES, as one leaf module with NO imports, so the Shift form's client
 * island (components/shift-time-fields.tsx) and the service (core/roster.ts) ask the SAME question about
 * the SAME row instead of carrying two hand-written copies that drift apart — the exact failure
 * core/week-pattern.ts's own header exists to prevent for the working-week row, applied here to breaks.
 *
 * ONE WAY TO SET A BREAK, PER ROW (the plan's point 4). Start and End define the window; ticking Flexible
 * (with its own minutes) replaces the window as an ALLOWANCE for the engine (core/attendance.ts
 * perRowBreakMinutes) — the whole-shift switch this round retires from the screen did the same thing at a
 * different scale, and nothing here changes what the engine does with either shape.
 *
 * WRAPPED BREAKS. A break on a shift that itself CROSSES MIDNIGHT may now cross midnight too — "23:45 to
 * 00:15" — because the shift already has somewhere on its own timeline for both ends to sit. On a shift
 * that does NOT cross midnight the same times are simply backwards and are refused as that, not silently
 * reinterpreted as a wrap. `breakRowMinutes` is the one wrap-aware duration: every reader of a break
 * window's length (core/roster.ts, core/shift-break-display.ts, the client preview) must use it rather
 * than the plain `end − start`, which goes negative the moment a row wraps.
 *
 * `checkBreakRow` classifies ONE row against its shift; `findBreakOverlaps` sweeps every row that passed
 * (paid rows INCLUDED — two breaks sharing a minute is nonsense whether or not either is paid) using the
 * SAME anchor-to-shift-start rule core/roster.ts `replaceShiftOtWindows` already uses for the overtime
 * grid, so "22:00–02:00" and "01:00–03:00" are seen overlapping on a night shift exactly as two overtime
 * windows are. Two rows with IDENTICAL times anchor to the same point and a positive length makes them
 * overlap by construction, so "two identical breaks count as overlapping" falls out for free rather than
 * needing its own special case.
 */

/** The three facts about a shift a break row is judged against. Times are 'HH:MM' or 'HH:MM:SS' — only
 *  lexicographic comparison and the first five characters are used, so either shape works unmodified. */
export type BreakRuleShift = { startTime: string; endTime: string; crossesMidnight: boolean };

/** One row's classification. `ok` is the only shape that carries a usable duration. */
export type BreakRowCheck =
  | { kind: 'blank' } // neither time typed — the row saves nothing
  | { kind: 'half'; missing: 'start' | 'end' } // one time typed, not the other
  | { kind: 'zero' } // start === end
  | { kind: 'reversed' } // end < start on a shift that does NOT cross midnight
  | { kind: 'outside' } // end < start is a valid wrap, or end > start, but falls outside the shift span
  | { kind: 'ok'; wrapped: boolean; minutes: number };

const toMin = (t: string): number => {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
};

/** Wrap-aware duration: the plain difference, or +1440 minutes when that difference is negative (the row
 *  crosses midnight). `((d % 1440) + 1440) % 1440` rather than `d < 0 ? d + 1440 : d` only because it also
 *  gives the right answer (0) for the degenerate start === end case a caller might feed it directly. */
export const breakRowMinutes = (start: string, end: string): number => {
  const d = toMin(end) - toMin(start);
  return ((d % 1440) + 1440) % 1440;
};

/**
 * ONE ROW, checked against its shift.
 *
 * A row with NEITHER time is `blank` — the shape a brand-new shift's first row opens in, and the shape
 * that is dropped rather than posted (a blank row saves nothing, per the plan). A row with exactly ONE
 * time is `half` and is REFUSED, never silently dropped — the plan's own correction of today's behaviour.
 */
export function checkBreakRow(row: { start: string; end: string }, shift: BreakRuleShift): BreakRowCheck {
  const hasStart = row.start.trim() !== '';
  const hasEnd = row.end.trim() !== '';
  if (!hasStart && !hasEnd) return { kind: 'blank' };
  if (hasStart !== hasEnd) return { kind: 'half', missing: hasStart ? 'end' : 'start' };
  const start = row.start.slice(0, 5);
  const end = row.end.slice(0, 5);
  if (start === end) return { kind: 'zero' };
  const wrapped = end < start;
  if (wrapped && !shift.crossesMidnight) return { kind: 'reversed' };
  const shiftStart = shift.startTime.slice(0, 5);
  const shiftEnd = shift.endTime.slice(0, 5);
  // Wrapped: both ends must sit on the shift's OWN side of midnight — start at/after the shift opens, end
  // at/before it closes. Not wrapped on a crossing shift: either half alone places the row (a break can sit
  // wholly before OR wholly after the shift's own midnight crossing), which is the OR this project has used
  // since b8aa3466 for the same reason. Not wrapped on a non-crossing shift: the ordinary AND.
  const inside = wrapped
    ? start >= shiftStart && end <= shiftEnd
    : shift.crossesMidnight
      ? start >= shiftStart || end <= shiftEnd
      : start >= shiftStart && end <= shiftEnd;
  if (!inside) return { kind: 'outside' };
  return { kind: 'ok', wrapped, minutes: breakRowMinutes(start, end) };
}

/**
 * Every pair of rows that share a minute, among the rows that passed `checkBreakRow` (paid rows included).
 * Returns the ORIGINAL indices of each overlapping pair, in the order `rows` was given — enough to name
 * both rows in a refusal ("Break 2 overlaps Break 1"). Only ADJACENT pairs after sorting by anchored start
 * are reported, the same depth `replaceShiftOtWindows` reports at for the overtime grid: if any two
 * intervals in a set overlap, at least one adjacent pair in start order does too, so nothing real is missed.
 */
export function findBreakOverlaps(
  rows: readonly { start: string; end: string }[],
  shift: BreakRuleShift,
): Array<[number, number]> {
  const startAbs = toMin(shift.startTime);
  const anchored = rows
    .map((r, i) => {
      const check = checkBreakRow(r, shift);
      if (check.kind !== 'ok') return null;
      let s = toMin(r.start);
      if (s < startAbs - 720) s += 1440;
      return { i, s, e: s + check.minutes };
    })
    .filter((x): x is { i: number; s: number; e: number } => x != null)
    .sort((a, b) => a.s - b.s);
  const pairs: Array<[number, number]> = [];
  for (let k = 1; k < anchored.length; k++) {
    if (anchored[k].s < anchored[k - 1].e) pairs.push([anchored[k - 1].i, anchored[k].i]);
  }
  return pairs;
}

/** A flexible row's allowed minutes, checked against its OWN window — 1 up to the window's own (wrap-aware)
 *  length, mirroring the shift-level allowance's bound against the whole shift span. */
export function flexibleMinutesInRange(minutes: number, windowMinutes: number): boolean {
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= windowMinutes;
}

/**
 * ONE ISSUE PER ROW, for the screen's live preview (the service is still the authority — see
 * core/roster.ts normalizeShiftInput, which runs the same checks and refuses on the first one it meets).
 * Priority, highest first: half-filled, zero-length, reversed, outside the shift, overlapping another row,
 * a missing/out-of-range flexible duration. A row with no issue is not in the returned map at all.
 */
export type BreakRowIssue =
  | { code: 'half'; missing: 'start' | 'end' }
  | { code: 'zero' }
  | { code: 'reversed' }
  | { code: 'outside' }
  | { code: 'overlap'; otherIndex: number; otherStart: string; otherEnd: string }
  | { code: 'flexibleMinutesRequired' }
  | { code: 'flexibleMinutesRange'; max: number };

export function breakRowIssues(
  rows: readonly { start: string; end: string; paid?: boolean; flexible?: boolean; flexibleMinutes?: number | null }[],
  shift: BreakRuleShift,
): Map<number, BreakRowIssue> {
  const out = new Map<number, BreakRowIssue>();
  const checks = rows.map((r) => checkBreakRow(r, shift));
  checks.forEach((c, i) => {
    if (c.kind === 'blank' || c.kind === 'ok') return;
    if (c.kind === 'half') out.set(i, { code: 'half', missing: c.missing });
    else out.set(i, { code: c.kind });
  });
  // Named on the LATER row only (anchored order), matching core/roster.ts's refusal — one overlapping
  // pair is one sentence, on the row the operator added second, not a complaint printed twice.
  for (const [a, c] of findBreakOverlaps(rows, shift)) {
    if (!out.has(c)) out.set(c, { code: 'overlap', otherIndex: a, otherStart: rows[a].start, otherEnd: rows[a].end });
  }
  rows.forEach((r, i) => {
    if (out.has(i)) return;
    const c = checks[i];
    if (c.kind !== 'ok' || r.paid === true || r.flexible !== true) return;
    if (r.flexibleMinutes == null) {
      out.set(i, { code: 'flexibleMinutesRequired' });
    } else if (!flexibleMinutesInRange(r.flexibleMinutes, c.minutes)) {
      out.set(i, { code: 'flexibleMinutesRange', max: c.minutes });
    }
  });
  return out;
}
