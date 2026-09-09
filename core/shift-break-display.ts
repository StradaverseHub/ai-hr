/**
 * Pure, DB-free break-time display formatter for the Attendance Policy shift summary table
 * (Configurable Multi-Shift Attendance Management). Kept out of core/roster.ts so the client-rendered
 * table cell and its unit test import it without dragging in the DB client.
 *
 * DISPLAY-HONESTY (not a calculation change): core/roster.ts lets breakPeriods and breakMinutes be set
 * independently. breakMinutes is the canonical scalar — it defines the shift's scheduled/normal hours, and
 * b7b886e2 also made it the CAP on the per-window deduction the day derivation now applies. So when the two
 * disagree the scalar still bounds what comes off, which is why we show the period windows but flag the
 * mismatch rather than silently presenting the period span as authoritative.
 *
 * cf21e554 stage 1 — the reference Break tab has three columns ours did not show: Sequence No., Duration
 * and Paid?. All three are DISPLAY here. `rows` carries them structured so the page can render a localized
 * "Paid" badge; `text` stays a single compact string for callers that just want one line. The mismatch rule
 * now compares against the UNPAID sum, because that is what core/roster.ts persists as break_minutes and
 * therefore what the hours engine deducts — comparing against the total would flag every correctly-saved
 * shift that has a paid break.
 */
import type { BreakPeriod } from '../db/schema';

/** One break window, ready to render: its 1-based position, its clock faces, its own length, paid or not. */
export type BreakDisplayRow = {
  seq: number;
  start: string;
  end: string;
  minutes: number;
  paid: boolean;
};

export type BreakDisplay = {
  /** "1. 12:00–13:00 (60m), 2. 15:00–15:15 (15m)" (periods) or "60 min" (scalar fallback) or "" (none). */
  text: string;
  /** The windows, structured. Empty on the scalar / no-break paths. */
  rows: BreakDisplayRow[];
  /** Set only when breakPeriods are present AND their summed UNPAID minutes ≠ breakMinutes. Value = the
   *  scalar (breakMinutes) the hours engine actually deducts, so the caller can surface both figures. */
  mismatchMinutes?: number;
  /** 6340aecb — set only when the shift's FLEXIBLE BREAK is on. Value = the allowance in minutes, which is
   *  what the engine deducts and (core/roster.ts) what breakMinutes was written to on save. The caller
   *  renders its own localized "Flexible · up to Nm" label; this is the number, not the wording. */
  flexibleMinutes?: number;
};

const hhmm = (t: string): string => t.slice(0, 5); // "HH:MM:SS" | "HH:MM" → "HH:MM"

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Format the Break Time column for one shift.
 * @param breakPeriods the stored break windows (may be null/empty)
 * @param breakMinutes the canonical scalar the hours engine deducts (Σ of the UNPAID windows)
 * @param flexible 6340aecb — the shift's flexible-break pair. OPTIONAL: every existing caller omits it and
 *   gets exactly the display it got before, which is also what an uncoloured, non-flexible shift shows.
 */
export function formatBreakDisplay(
  breakPeriods: BreakPeriod[] | null | undefined,
  breakMinutes: number | null | undefined,
  flexible?: { enabled?: boolean | null; minutes?: number | null } | null,
): BreakDisplay {
  const scalar = Math.trunc(breakMinutes ?? 0);
  // 6340aecb — a FLEXIBLE shift's break is an allowance, and core/roster.ts writes that allowance into
  // break_minutes on save. So the window sum and the scalar are EXPECTED to differ here whenever the
  // operator set an allowance that is not the windows' length, and the mismatch badge — which exists to
  // warn about a DRIFTED row — must not fire on a shift that is working exactly as configured.
  const flexibleMinutes = flexible?.enabled === true && flexible.minutes != null ? Math.trunc(flexible.minutes) : undefined;
  if (breakPeriods && breakPeriods.length > 0) {
    const rows: BreakDisplayRow[] = breakPeriods.map((bp, i) => ({
      seq: i + 1,
      start: hhmm(bp.start),
      end: hhmm(bp.end),
      minutes: toMin(bp.end) - toMin(bp.start),
      // Absent means UNPAID — the whole reason the flag is optional (db/schema.ts BreakPeriod).
      paid: bp.paid === true,
    }));
    const text = rows.map((r) => `${r.seq}. ${r.start}–${r.end} (${r.minutes}m)`).join(', ');
    const unpaidSum = rows.filter((r) => !r.paid).reduce((acc, r) => acc + r.minutes, 0);
    if (flexibleMinutes != null) return { text, rows, flexibleMinutes };
    return unpaidSum === scalar ? { text, rows } : { text, rows, mismatchMinutes: scalar };
  }
  if (flexibleMinutes != null) return { text: `${scalar} min`, rows: [], flexibleMinutes };
  if (scalar > 0) return { text: `${scalar} min`, rows: [] };
  return { text: '', rows: [] }; // caller renders its localized "No break" label for the empty case
}
