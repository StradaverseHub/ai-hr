/**
 * a57f0584 rev 2 — MONTH, WEEK AND A CUSTOM RANGE: three windows over ONE read.
 *
 * THE BINDING CONSTRAINT is the plan's own sentence to the reporter: "The Week and Custom range views
 * read the same roster the Month view does, so a date cannot show one shift in one view and another in
 * another." That is not a UI promise, it is an architecture one — it forbids a second, view-specific
 * read — so the load-bearing case here compares the CELLS two different views resolve for the same date
 * against the real database, rather than asserting that two functions look alike.
 *
 * THE CAP, AND WHY IT IS TESTED IN THE SERVICE. The plan left "cap the range or paginate" open; the
 * answer is cap, because rows are already paged (`paginateRows`/`ClientPager`) and it is COLUMNS that
 * are unbounded. A form that refuses 400 days is an affordance, not a guard: `/roster/export?from=…&to=…`
 * takes its window off a query string, so `assertRosterWindow` refuses in `core/roster.ts` before any
 * query runs and the cases below call it there, not through a form.
 *
 * WHAT IS DELIBERATELY NOT HERE: the pinned-column geometry (test/a57f0584-roster-rev2.dom.test.tsx,
 * which measures the rendered table) and everything else about the redesign
 * (test/a57f0584-roster-rev2.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { assertRosterWindow, assignShift, createShift, RosterRangeError, rosterMonthView, rosterWindowView, setRestDay } from '../core/roster';
import {
  ROSTER_MAX_RANGE_DAYS,
  datesBetween,
  daysInWindow,
  monthRange,
  resolveRosterWindow,
  rosterDateLocale,
  stepRosterWindow,
  weekRangeOf,
} from '../lib/roster-month';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = src('app/roster/page.tsx');
const EXPORT = src('app/roster/export/route.ts');
const EXCEPTIONS = src('app/roster/exceptions/page.tsx');
const EDIT = src('app/roster/edit/[employmentId]/page.tsx');
const CORE = src('core/roster.ts');

/** A fixed "today" — never the clock, so a case cannot change meaning overnight. 2026-08-12 is a
 *  Wednesday, which is what makes the week-snapping cases mean anything. */
const TODAY = '2026-08-12';

// ── 1. THE RESOLVER ──────────────────────────────────────────────────────────────────────────────

describe('a57f0584 · one resolver, three views', () => {
  it('defaults to the month containing today when nothing is asked for', () => {
    const r = resolveRosterWindow({ today: TODAY });
    expect(r.ok).toBe(true);
    expect(r.window).toEqual({ kind: 'month', from: '2026-08-01', to: '2026-08-31', month: '2026-08' });
  });

  /** EVERY LINK WRITTEN BEFORE THIS ROUND carried `month=` and nothing else. They must all still mean
   *  the month view — a bookmark that silently became a week would be a change nobody asked for. */
  it('a bare month= is still the month view, exactly as every existing link means it', () => {
    expect(resolveRosterWindow({ month: '2026-02', today: TODAY }).window).toEqual({
      kind: 'month',
      from: '2026-02-01',
      to: '2026-02-28',
      month: '2026-02',
    });
  });

  it('a week is Monday to Sunday, snapped from ANY date inside it', () => {
    // 2026-08-12 is a Wednesday; 08-10 is its Monday and 08-16 its Sunday.
    expect(weekRangeOf('2026-08-12')).toEqual({ from: '2026-08-10', to: '2026-08-16' });
    for (const anchor of ['2026-08-10', '2026-08-12', '2026-08-16']) {
      const w = resolveRosterWindow({ view: 'week', from: anchor, today: TODAY }).window;
      expect(w, `anchored on ${anchor}`).toEqual({ kind: 'week', from: '2026-08-10', to: '2026-08-16', month: '2026-08' });
    }
    expect(datesBetween('2026-08-10', '2026-08-16'), 'seven columns, not six or eight').toHaveLength(7);
  });

  it('a week straddling a month end keeps both halves and reports the month it STARTS in', () => {
    // 2026-08-31 is a Monday, so its week runs into September.
    const w = resolveRosterWindow({ view: 'week', from: '2026-09-02', today: TODAY }).window;
    expect(w.from).toBe('2026-08-31');
    expect(w.to).toBe('2026-09-06');
    expect(w.month, 'the month picker needs ONE answer, and it is where the window begins').toBe('2026-08');
    expect(datesBetween(w.from, w.to)).toContain('2026-09-01');
  });

  it('a custom range with no dates yet opens on the month, inside the cap', () => {
    const w = resolveRosterWindow({ view: 'custom', month: '2026-08', today: TODAY }).window;
    expect(w.kind, 'still Custom — switching view must not bounce the operator back to Month').toBe('custom');
    expect({ from: w.from, to: w.to }).toEqual(monthRange('2026-08'));
  });

  it('a custom range inside the cap is taken exactly as typed', () => {
    const r = resolveRosterWindow({ view: 'custom', from: '2026-08-03', to: '2026-08-16', today: TODAY });
    expect(r.ok).toBe(true);
    expect(r.window).toEqual({ kind: 'custom', from: '2026-08-03', to: '2026-08-16', month: '2026-08' });
  });
});

// ── 2. THE CAP ───────────────────────────────────────────────────────────────────────────────────

describe('a57f0584 · the range is capped, and says so', () => {
  it('counts a window inclusively — one day is one day, not zero', () => {
    expect(daysInWindow('2026-08-03', '2026-08-03')).toBe(1);
    expect(daysInWindow('2026-08-01', '2026-08-31')).toBe(31);
    expect(daysInWindow('2026-08-03', '2026-08-09')).toBe(7);
  });

  it('accepts EXACTLY the cap and refuses one day more', () => {
    const last = datesBetween('2026-01-01', '2026-12-31')[ROSTER_MAX_RANGE_DAYS - 1];
    expect(daysInWindow('2026-01-01', last)).toBe(ROSTER_MAX_RANGE_DAYS);
    expect(resolveRosterWindow({ view: 'custom', from: '2026-01-01', to: last, today: TODAY }).ok).toBe(true);
    const oneMore = datesBetween('2026-01-01', '2026-12-31')[ROSTER_MAX_RANGE_DAYS];
    expect(resolveRosterWindow({ view: 'custom', from: '2026-01-01', to: oneMore, today: TODAY }).ok).toBe(false);
  });

  /** CLAMPED FORWARD FROM THE DATE THEY TYPED, not snapped to a month boundary: the first day on screen
   *  is the first day they asked for, which is the least surprising thing a refusal can do. */
  it('clamps a too-wide range from its own From date, and reports what was asked', () => {
    const r = resolveRosterWindow({ view: 'custom', from: '2026-03-01', to: '2026-12-31', today: TODAY });
    // Narrowed by a throw rather than by an expect: `askedDays` exists only on the too_wide arm, and a
    // runtime assertion does not tell the compiler which arm this is.
    if (r.ok || r.reason !== 'too_wide') throw new Error(`expected a too_wide refusal, got ${JSON.stringify(r)}`);
    expect(r.askedDays, 'the message names the size of the request').toBe(daysInWindow('2026-03-01', '2026-12-31'));
    expect(r.window.from, 'the From the operator typed is honoured').toBe('2026-03-01');
    expect(daysInWindow(r.window.from, r.window.to)).toBe(ROSTER_MAX_RANGE_DAYS);
    expect(r.window.kind, 'and they are still on the Custom view').toBe('custom');
  });

  it('a backwards range shows the From date alone rather than silently swapping the two', () => {
    const r = resolveRosterWindow({ view: 'custom', from: '2026-08-20', to: '2026-08-01', today: TODAY });
    if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    expect(r.reason).toBe('backwards');
    expect(r.window, 'swapping them would show a window nobody typed').toEqual({
      kind: 'custom',
      from: '2026-08-20',
      to: '2026-08-20',
      month: '2026-08',
    });
  });

  /**
   * THE GUARD, NOT THE AFFORDANCE. The screen clamps; this refuses. `/roster/export?from=&to=` takes a
   * window straight off a query string, so a hand-crafted year must die in the service before it asks
   * for 365 columns × every employee — a form cannot be the thing that stops it.
   */
  it('the SERVICE refuses an out-of-range window before any query runs', () => {
    expect(() => assertRosterWindow('2026-08-01', '2026-08-31')).not.toThrow();
    expect(() => assertRosterWindow('2026-01-01', '2026-12-31')).toThrow(RosterRangeError);
    expect(() => assertRosterWindow('2026-08-31', '2026-08-01')).toThrow(RosterRangeError);
    expect(() => assertRosterWindow('not-a-date', '2026-08-01')).toThrow(RosterRangeError);
    // The refusal names the numbers, because it reaches the export caller as the response body.
    expect(() => assertRosterWindow('2026-01-01', '2026-12-31')).toThrow(new RegExp(`${ROSTER_MAX_RANGE_DAYS}`));
  });

  it('the cap is written once and read everywhere', () => {
    // Not re-typed in a page, a route or the core: one constant, or the form and the guard drift apart.
    expect(PAGE).toContain('ROSTER_MAX_RANGE_DAYS');
    expect(CORE).toContain('ROSTER_MAX_RANGE_DAYS');
    for (const [name, s] of [['page', PAGE], ['export', EXPORT], ['core', CORE]] as const) {
      expect(s, `${name} must not hardcode the number`).not.toMatch(/\b92\b/);
    }
  });
});

// ── 3. THE STEPPER ───────────────────────────────────────────────────────────────────────────────

describe('a57f0584 · ‹ and › move the window in its own units', () => {
  it('a month by a month, across a year boundary', () => {
    const dec = resolveRosterWindow({ month: '2026-12', today: TODAY }).window;
    expect(stepRosterWindow(dec, 1)).toEqual({ kind: 'month', from: '2027-01-01', to: '2027-01-31', month: '2027-01' });
    expect(stepRosterWindow(dec, -1).month).toBe('2026-11');
  });

  it('a week by seven days, staying Monday-to-Sunday', () => {
    const w = resolveRosterWindow({ view: 'week', from: '2026-08-12', today: TODAY }).window;
    expect(stepRosterWindow(w, 1)).toEqual({ kind: 'week', from: '2026-08-17', to: '2026-08-23', month: '2026-08' });
    expect(stepRosterWindow(w, -1)).toEqual({ kind: 'week', from: '2026-08-03', to: '2026-08-09', month: '2026-08' });
  });

  /** A custom range steps by its OWN length — ‹ on a fortnight is the previous fortnight. A fixed step
   *  would make the two arrows mean something different from the window they sit beside. */
  it('a custom range by its own length, with no gap and no overlap', () => {
    const w = resolveRosterWindow({ view: 'custom', from: '2026-08-03', to: '2026-08-16', today: TODAY }).window;
    const next = stepRosterWindow(w, 1);
    expect(daysInWindow(next.from, next.to)).toBe(daysInWindow(w.from, w.to));
    expect(next.from, 'the next window starts the day after this one ends').toBe('2026-08-17');
    const back = stepRosterWindow(w, -1);
    expect(back.to, 'and the previous one ends the day before it starts').toBe('2026-08-02');
    expect(stepRosterWindow(next, -1)).toEqual(w);
  });

  it('every step it can produce is still inside the cap', () => {
    const widest = resolveRosterWindow({
      view: 'custom',
      from: '2026-01-01',
      to: datesBetween('2026-01-01', '2026-12-31')[ROSTER_MAX_RANGE_DAYS - 1],
      today: TODAY,
    }).window;
    for (const d of [1, -1] as const) {
      const stepped = stepRosterWindow(widest, d);
      expect(() => assertRosterWindow(stepped.from, stepped.to), `step ${d}`).not.toThrow();
    }
  });
});

// ── 4. THE DATE FORMAT ───────────────────────────────────────────────────────────────────────────

describe('a57f0584 · the roster writes dates day-first in English', () => {
  /**
   * `en` in this app resolves to en-US, which orders a short date MONTH-first ("Sep 01"). Malaysia
   * writes dates day-first and the approved plan's example is "01 Sept". This pins the ONE formatter
   * mapping that fixes it — and pins that the other five locales are NOT touched.
   */
  it('maps only `en`, and only to en-GB', () => {
    expect(rosterDateLocale('en')).toBe('en-GB');
    for (const l of ['ms', 'ta', 'th', 'vi', 'zh']) expect(rosterDateLocale(l), l).toBe(l);
  });

  it('produces the day-first short date the reporter asked for', () => {
    const d = new Date('2026-09-01T00:00:00Z');
    const fmt = (l: string) => new Intl.DateTimeFormat(rosterDateLocale(l), { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(d);
    expect(fmt('en'), 'the plan says "01 Sept", never "Sep 01"').toBe('01 Sept');
    // Still Intl choosing the words in every other locale — no month table anywhere.
    for (const l of ['ms', 'ta', 'th', 'vi', 'zh']) {
      expect(fmt(l), `${l} must still carry the day`).toMatch(/01/);
      expect(fmt(l), `${l} must not be two numbers`).not.toMatch(/^\d{2}[/\-.]\d{2}$/);
    }
  });

  it('every roster screen formats through the shared mapping, so four screens cannot print four ways', () => {
    for (const [name, s] of [['page', PAGE], ['export-less screens: exceptions', EXCEPTIONS], ['edit', EDIT]] as const) {
      expect(s, `${name} must use rosterDateLocale`).toContain('rosterDateLocale(locale)');
      expect(s, `${name} must not format against the raw locale`).not.toMatch(/Intl\.DateTimeFormat\(locale,/);
    }
  });
});

// ── 5. THE WINDOW RIDES EVERY LINK ───────────────────────────────────────────────────────────────

describe('a57f0584 · the window survives every way off the screen', () => {
  it('the roster puts the RESOLVED window on every outbound link', () => {
    expect(PAGE, 'the query-string builder carries the view').toContain("new URLSearchParams({ view: win.kind, month: win.month })");
    expect(PAGE, 'and the dates, for the two views that need them').toContain("p.set('from', win.from)");
    // Resolved, never as typed: a clamped range must not be handed on as the range that was refused.
    expect(PAGE).toContain('const win = resolved.window;');
    expect(PAGE, 'the grid, export, exceptions and Edit all take the same string').toContain('editQuery={qs({})}');
    expect(PAGE).toContain('`/roster/exceptions?${qs({})}`');
  });

  it('the three downstream screens resolve the window through the SAME function', () => {
    for (const [name, s] of [['export', EXPORT], ['exceptions', EXCEPTIONS], ['edit', EDIT]] as const) {
      expect(s, `${name} must not re-derive a window`).toContain('resolveRosterWindow(');
    }
    expect(EXCEPTIONS, 'the exceptions read is the window, not a month').toContain('const { from, to } = win;');
    expect(EDIT, 'the editor edits the dates that were on screen').toContain('from: win.from, to: win.to');
  });

  /** A DOWNLOAD HAS NO BANNER. The screen can clamp and explain; a file cannot, so the route refuses. */
  it('the export refuses an out-of-range window with a 400, not a clamped file', () => {
    expect(EXPORT).toContain('if (!resolved.ok)');
    expect(EXPORT).toMatch(/status: 400/);
    expect(EXPORT, 'and the service guard keeps its 400 rather than reading as a server fault').toContain(
      'if (e instanceof RosterRangeError) return new Response(e.message, { status: 400 });',
    );
  });
});

// ── 6. ONE READ — THE PROMISE, AGAINST THE DATABASE ──────────────────────────────────────────────

let b: Base;
let ctx: ReturnType<typeof adminCtx>;
let shiftId: string;
let emp: string;

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `v_${randomUUID().slice(0, 8)}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
  shiftId = (
    await createShift(ctx, { companyId: b.companyId, name: 'Day', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 })
  ).id;
  emp = await makeEmp('Windowed Person');
  await assignShift(ctx, { employmentId: emp, shiftDate: '2026-08-12', shiftId });
  await setRestDay(ctx, { employmentId: emp, shiftDate: '2026-08-16' });
});

describe('a57f0584 · a date cannot show one shift in one view and another in another', () => {
  /**
   * THE PLAN'S OWN SENTENCE, tested. Three views over the same dates must return the SAME cells — not
   * similar ones. Asserted on the raw `cells` map rather than on rendered text, because that map is what
   * every view hands the grid, the export and the editor.
   */
  it('month, week and custom return byte-identical cells for the dates they share', async () => {
    const month = await rosterWindowView(ctx, { companyIds: [b.companyId], ...monthRange('2026-08') });
    const week = await rosterWindowView(ctx, { companyIds: [b.companyId], from: '2026-08-10', to: '2026-08-16' });
    const custom = await rosterWindowView(ctx, { companyIds: [b.companyId], from: '2026-08-05', to: '2026-08-20' });

    for (const iso of ['2026-08-12', '2026-08-16']) {
      const key = `${emp}|${iso}`;
      expect(month.cells[key], `${iso} must be present in the month`).toBeDefined();
      expect(week.cells[key], `${iso} in the week view`).toEqual(month.cells[key]);
      expect(custom.cells[key], `${iso} in the custom view`).toEqual(month.cells[key]);
    }
    // And the stored shapes are the two different ones, so the comparison above is not comparing nulls.
    expect(month.cells[`${emp}|2026-08-12`]).toEqual({ kind: 'shift', shiftId });
    expect(month.cells[`${emp}|2026-08-16`]).toEqual({ kind: 'rest' });
  });

  it('each view returns exactly its own columns, and nothing outside them', async () => {
    const week = await rosterWindowView(ctx, { companyIds: [b.companyId], from: '2026-08-10', to: '2026-08-16' });
    expect(week.dates).toEqual(datesBetween('2026-08-10', '2026-08-16'));
    expect(week.from).toBe('2026-08-10');
    expect(week.to).toBe('2026-08-16');
    // The rest day on the 16th is the LAST column; a window must include both of its own ends.
    expect(week.cells[`${emp}|2026-08-16`]).toEqual({ kind: 'rest' });
    // A day outside the window is not carried, or the payload grows without the screen growing.
    expect(week.cells[`${emp}|2026-08-31`]).toBeUndefined();
  });

  /** `rosterMonthView` is the MONTH HELPER over the window read — not a second reader that could drift. */
  it('the month helper returns exactly what the window read returns for that month', async () => {
    const viaMonth = await rosterMonthView(ctx, { companyIds: [b.companyId], month: '2026-08' });
    const viaWindow = await rosterWindowView(ctx, { companyIds: [b.companyId], ...monthRange('2026-08') });
    expect(viaMonth.dates).toEqual(viaWindow.dates);
    expect(viaMonth.cells).toEqual(viaWindow.cells);
    expect(viaMonth.usual).toEqual(viaWindow.usual);
    expect(viaMonth.employees.map((e) => e.employmentId)).toEqual(viaWindow.employees.map((e) => e.employmentId));
  });

  it('the read refuses an over-wide window itself, whatever a caller believes it resolved', async () => {
    await expect(rosterWindowView(ctx, { companyIds: [b.companyId], from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow(
      RosterRangeError,
    );
  });

  it('a single-day window is legal — it is what a backwards range falls back to', async () => {
    const one = await rosterWindowView(ctx, { companyIds: [b.companyId], from: '2026-08-12', to: '2026-08-12' });
    expect(one.dates).toEqual(['2026-08-12']);
    expect(one.cells[`${emp}|2026-08-12`]).toEqual({ kind: 'shift', shiftId });
  });
});
