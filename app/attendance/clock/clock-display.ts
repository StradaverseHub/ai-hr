/**
 * Clock In/Out screen redesign (feedback af552c5d) — PURE display derivations, deliberately db-free so
 * the RSC page, the client island and the vitest suite all import the SAME math (no server/client fork,
 * no React Server Component boundary problem).
 *
 * Everything here is cosmetic-only: the elapsed counter, ring state and session counts are DERIVED from
 * the server-recorded punches for display. Payroll/OT math stays server-side in core/attendance.ts —
 * nothing computed here is ever written back.
 */

export type ClockPunch = { time: string; direction: 'in' | 'out' };

/** The circular button's three visual states: grey before the first clock-in of the day, red while
 *  clocked in (action = Clock Out), green while clocked out (action = Clock In). */
export type ClockRingState = 'idle' | 'in' | 'out';

/** State from today's ordered punch trail: no punches → idle; last punch in → 'in'; else 'out'. */
export function ringState(events: ClockPunch[]): ClockRingState {
  const last = events[events.length - 1];
  if (!last) return 'idle';
  return last.direction === 'in' ? 'in' : 'out';
}

/**
 * The circular button's state-driven classes (drift-guarded by test/clock-redesign.test.ts).
 * Feedback af552c5d: red/dark-red gradient when the action is Clock Out (currently IN), green gradient
 * when the action is Clock In (currently OUT), grey/idle before the first clock-in of the day — plus a
 * subtle outer glow ring per state. Static strings (never template-built) so Tailwind's scanner sees them.
 */
export const RING_CLASSES: Record<ClockRingState, string> = {
  idle: 'bg-gradient-to-br from-slate-400 to-slate-600 shadow-xl shadow-slate-400/30 ring-8 ring-slate-400/15 dark:from-slate-500 dark:to-slate-700 dark:shadow-slate-900/40 dark:ring-slate-500/15',
  in: 'bg-gradient-to-br from-red-500 to-red-800 shadow-xl shadow-red-500/30 ring-8 ring-red-500/15 dark:from-red-600 dark:to-red-900 dark:shadow-red-950/50 dark:ring-red-500/20',
  out: 'bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-xl shadow-emerald-500/30 ring-8 ring-emerald-500/15 dark:from-emerald-600 dark:to-emerald-800 dark:shadow-emerald-950/50 dark:ring-emerald-500/20',
};

/** 'HH:MM' or 'HH:MM:SS' → seconds since midnight. */
export function secondsOf(t: string): number {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/**
 * CUMULATIVE seconds worked today (the reporter's clarified timer semantics): the sum of every completed
 * in→out pair plus — when the trail ends on an open 'in' — the running span from that clock-in to the
 * SERVER's now. Punches are server times (minute granularity); `serverNowSeconds` is the server clock at
 * render, so a page refresh never resets the counter. Stray/duplicate punches are tolerated: a second
 * 'in' while one is open is ignored (first-in anchors the pair), an 'out' with no open 'in' is ignored,
 * and a negative span (cross-midnight open session) clamps to 0.
 */
export function cumulativeWorkedSeconds(events: ClockPunch[], serverNowSeconds: number): number {
  let total = 0;
  let openIn: number | null = null;
  for (const ev of events) {
    if (ev.direction === 'in') {
      if (openIn == null) openIn = secondsOf(ev.time);
    } else if (openIn != null) {
      total += Math.max(0, secondsOf(ev.time) - openIn);
      openIn = null;
    }
  }
  if (openIn != null) total += Math.max(0, serverNowSeconds - openIn);
  return total;
}

/** Completed in→out pairs today — the status row's numbered badge (increments per completed session). */
export function completedSessions(events: ClockPunch[]): number {
  let count = 0;
  let open = false;
  for (const ev of events) {
    if (ev.direction === 'in') open = true;
    else if (open) {
      count += 1;
      open = false;
    }
  }
  return count;
}

/** The MOST RECENT session's clock-in time ('HH:MM'), open or closed — the "Clocked in at 08:36" line. */
export function latestSessionStart(events: ClockPunch[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].direction === 'in') return events[i].time.slice(0, 5);
  }
  return null;
}

/**
 * Client-tick elapsed display, SKEW-TOLERANT: the server-computed base (cumulativeWorkedSeconds at
 * render) plus — only while clocked in — the seconds elapsed since the island MOUNTED, measured as a
 * DIFFERENCE of the client's own clock (mountMs → nowMs). Because only client-clock deltas are used, an
 * absolutely wrong client clock cannot shift the counter; the server base is the anchor. Never negative.
 */
export function elapsedDisplaySeconds(
  baseSeconds: number,
  ticking: boolean,
  mountMs: number,
  nowMs: number,
): number {
  return baseSeconds + (ticking ? Math.max(0, Math.floor((nowMs - mountMs) / 1000)) : 0);
}

/** Seconds → the big counter's "07h 20m 29s" form (each unit zero-padded to two digits). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}h ${pad(Math.floor((s % 3600) / 60))}m ${pad(s % 60)}s`;
}

// r430 — ShiftOption and showShiftSwitch RETIRED here. The Switch link (and the shiftOptions list it
// cycled through) is removed entirely: the Current Shift shown is always the one actually assigned to the
// employee through their Shift or Schedule Group, read-only, with nothing on this screen to pick a
// different one. showShiftSwitch(optionCount) was already dead code outside its own test before this
// round (clock-client.tsx inlined the same >1 check rather than calling it).
