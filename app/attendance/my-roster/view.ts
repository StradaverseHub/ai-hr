/**
 * My Roster's three views (item 6948727a) — Daily, Weekly, Monthly.
 *
 * ── WHY THIS IS NOT `lib/roster-month#resolveRosterWindow` ───────────────────────────────────────────
 * That resolver serves the SUPERVISOR's roster and its three views are month / week / CUSTOM RANGE — an
 * operator picking an arbitrary From and To. This screen's third view is a single DAY, which is not a
 * member of `RosterViewKind` and must not be bolted onto it: widening that union would change the
 * admin roster's query-string contract, its stepper and its export filename for a screen they do not
 * share. So the WINDOW ARITHMETIC is local and the DATE ARITHMETIC is shared — every function this file
 * computes with comes from `lib/roster-month`, so the two screens land on the same Monday, the same
 * month length and the same cell rule. Nothing about a date is re-implemented here.
 *
 * The day view still resolves a WHOLE WEEK: the picture the plan approved puts a seven-day strip above
 * the day's detail, and reading the week once means the strip and the detail cannot disagree about what
 * Wednesday is. `focus` is the day the detail panel describes.
 *
 * Every window this file can produce is at most 31 days, so it is structurally inside
 * `ROSTER_MAX_RANGE_DAYS` (92) and `assertRosterWindow` can never fire for a window that came from here.
 * The service asserts anyway — a form is an affordance, not a guard — which is what covers a hand-typed
 * query string that this resolver has already rejected back to a default.
 */
import { addDaysIso, addMonths, isIsoDate, isMonthParam, monthOf, monthRange, weekRangeOf } from '@/lib/roster-month';

/** Daily · Weekly · Monthly, exactly the three the approved picture draws, in its own order. */
export type MyRosterViewKind = 'day' | 'week' | 'month';
export const MY_ROSTER_VIEWS = ['day', 'week', 'month'] as const;
export const isMyRosterView = (v: string | undefined | null): v is MyRosterViewKind =>
  v === 'day' || v === 'week' || v === 'month';

export type MyRosterWindow = {
  view: MyRosterViewKind;
  /** First and last date READ, inclusive. For `day` this is the whole week around `focus`. */
  from: string;
  to: string;
  /** The month the window starts in — what the Monthly stepper and the month caption name. */
  month: string;
  /** The date the Daily panel describes. Null for the week and month views. */
  focus: string | null;
};

/**
 * Resolve the query string into a window. It ALWAYS yields a usable one: an employee who edits the
 * address bar gets the current month rather than a 500, and nothing here can produce a window the
 * service would refuse.
 *
 * `today` is passed in and never read from the clock (lib/hr-date owns that), so the resolver is pure
 * and its tests do not depend on the day they run.
 */
export function resolveMyRosterWindow(p: {
  view?: string | null;
  month?: string | null;
  date?: string | null;
  today: string;
}): MyRosterWindow {
  const view: MyRosterViewKind = isMyRosterView(p.view) ? p.view : 'month';

  if (view === 'month') {
    const month = isMonthParam(p.month) ? p.month : monthOf(p.today);
    const r = monthRange(month);
    return { view, from: r.from, to: r.to, month, focus: null };
  }

  // Any date inside the week identifies it; weekRangeOf snaps to Monday. `<input type="week">` is
  // deliberately not used here for the same reason the supervisor's roster refuses it — it posts an ISO
  // week-numbering year that disagrees with the calendar year across New Year.
  const anchor = isIsoDate(p.date ?? '') ? p.date! : p.today;
  const r = weekRangeOf(anchor);
  return { view, from: r.from, to: r.to, month: monthOf(r.from), focus: view === 'day' ? anchor : null };
}

/**
 * The window moved one step in its OWN units — a month by a month, a week by seven days, a day by one.
 * One stepper for three views, because three steppers is three chances to disagree.
 */
export function stepMyRosterWindow(w: MyRosterWindow, direction: 1 | -1): MyRosterWindow {
  if (w.view === 'month') {
    const month = addMonths(w.month, direction);
    const r = monthRange(month);
    return { view: 'month', from: r.from, to: r.to, month, focus: null };
  }
  if (w.view === 'week') {
    const from = addDaysIso(w.from, direction * 7);
    return { view: 'week', from, to: addDaysIso(from, 6), month: monthOf(from), focus: null };
  }
  const focus = addDaysIso(w.focus ?? w.from, direction);
  const r = weekRangeOf(focus);
  return { view: 'day', from: r.from, to: r.to, month: monthOf(r.from), focus };
}

/**
 * The query string for a window — ONE spelling, so a link, its stepper and the "today" shortcut can
 * never encode the same window three ways. Only the parameters that view actually reads are emitted;
 * a `date=` left on a month link would survive a view switch and silently re-anchor it.
 */
export function myRosterQuery(w: MyRosterWindow): Record<string, string> {
  if (w.view === 'month') return { view: 'month', month: w.month };
  if (w.view === 'week') return { view: 'week', date: w.from };
  return { view: 'day', date: w.focus ?? w.from };
}

/** `?a=b&c=d` for a window, ready to append to the screen's own path. */
export const myRosterHref = (w: MyRosterWindow): string =>
  `/attendance/my-roster?${new URLSearchParams(myRosterQuery(w)).toString()}`;

/**
 * The window a view switch lands on, keeping the reader where they were.
 *
 * Switching Monthly → Daily must not jump to today when the reader is looking at March: it lands on the
 * FIRST DAY of the window they can see, unless today is already inside it, in which case today is the
 * day they meant. The same rule makes Daily → Monthly open the month the chosen day is in.
 */
export function switchMyRosterView(w: MyRosterWindow, to: MyRosterViewKind, today: string): MyRosterWindow {
  const inside = today >= w.from && today <= w.to;
  const anchor = w.focus ?? (inside ? today : w.from);
  if (to === 'month') return resolveMyRosterWindow({ view: 'month', month: monthOf(anchor), today });
  return resolveMyRosterWindow({ view: to, date: anchor, today });
}
