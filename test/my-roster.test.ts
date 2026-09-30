/**
 * My Roster (item 6948727a) — the employee's OWN roster, read only.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────────────────────────────
 * One property above all: **an employee sees their own roster and nobody else's**, and the reason that
 * needs a test of its own is that ROW-LEVEL SECURITY DOES NOT PROVIDE IT.
 *
 * `roster_assignment`'s policy (migration 0075) is `app.can_see_employment(employment_id)`, and
 * `can_see_employment` (0109) admits self, the RECURSIVE ADMINISTRATIVE MANAGER CHAIN and the HOD
 * department tree. So a supervisor asking the database for a subordinate's roster is ANSWERED. A
 * refusal test written against an unrelated colleague would therefore pass on RLS alone and prove
 * nothing about this screen; every access case below is written against an ADMINISTRATIVE MANAGER —
 * the identity RLS would let through — and the first one proves the leak is genuinely available by
 * taking it through `rosterForRange` in the same test before showing `myRosterWindow` refusing it.
 *
 * The guard being tested is `myRosterWindow`'s SHAPE: it takes no employment id, and resolves the
 * caller's own from the session. Revert that — key the read on a passed id — and
 * `'the manager gets their OWN roster, not the subordinate's'` fails.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  RosterRangeError,
  assignDefaultShift,
  assignShift,
  createShift,
  myRosterWindow,
  rosterForRange,
  setRestDay,
} from '../core/roster';
import { monthRange } from '../lib/roster-month';
import type { SessionContext } from '../db/client';
import {
  myRosterHref,
  myRosterQuery,
  resolveMyRosterWindow,
  stepMyRosterWindow,
  switchMyRosterView,
} from '../app/attendance/my-roster/view';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
/** Comments stripped, the idiom test/function-access.test.ts uses: a source guard must not be
 *  satisfiable by prose, and this page's header necessarily names the calls it does and does not make. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const PAGE = 'app/attendance/my-roster/page.tsx';

// ── 1 · THE ACCESS BOUNDARY ─────────────────────────────────────────────────────────────────────────

describe('6948727a — My Roster shows the caller their own roster and nobody else’s', () => {
  let b: Base;
  let ctx: SessionContext;
  let managerId = '';
  let managerPersonId = '';
  let subordinateId = '';
  let subordinatePersonId = '';
  let managerShift = '';
  let subordinateShift = '';
  /** A fixed month in the past: no hardcoded FUTURE date, and the window is stable whatever day it is. */
  const MONTH = '2026-03';
  const { from, to } = monthRange(MONTH);

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (name: string) =>
    hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\W+/g, '')}_${randomUUID().slice(0, 6)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    ctx = adminCtx(b);

    // TWO DIFFERENT SHIFTS, so a leak shows up as the WRONG CODE rather than as an empty result. A test
    // that could pass because the subordinate happens to have no roster proves nothing.
    managerShift = (
      await createShift(ctx, { companyId: b.companyId, name: 'Manager mornings', code: 'MGR1', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] })
    ).id;
    subordinateShift = (
      await createShift(ctx, { companyId: b.companyId, name: 'Subordinate nights', code: 'SUB1', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 30, weeklyPattern: [1, 2, 3, 4, 5] })
    ).id;

    const mgr = await hire('Aisyah Manager');
    const sub = await hire('Mei Subordinate');
    managerId = mgr.employmentId;
    managerPersonId = mgr.personId;
    subordinateId = sub.employmentId;
    subordinatePersonId = sub.personId;

    // THE ADMINISTRATIVE LINE — the one `can_see_employment` walks. Without it this whole file would be
    // testing RLS's tenant fence instead of this screen's own.
    await setReportingLine(ctx, {
      subordinateEmploymentId: subordinateId,
      managerEmploymentId: managerId,
      lineType: 'administrative',
      validFrom: '2020-01-01',
    });

    await assignDefaultShift(ctx, { employmentId: managerId, shiftId: managerShift });
    await assignDefaultShift(ctx, { employmentId: subordinateId, shiftId: subordinateShift });
    // Real rostered rows for BOTH, so a leak returns rows rather than nothing.
    await assignShift(ctx, { employmentId: managerId, shiftDate: '2026-03-04', shiftId: managerShift });
    await assignShift(ctx, { employmentId: subordinateId, shiftDate: '2026-03-04', shiftId: subordinateShift });
    await setRestDay(ctx, { employmentId: managerId, shiftDate: '2026-03-05', note: 'Swapped with Tuesday' });
  });

  /** A session for one employment's person, with no admin grant. */
  const sessionFor = async (personId: string): Promise<SessionContext> => {
    const uid = await createAppUser(b.tenantId, personId, 'employee');
    return { tenantId: b.tenantId, userId: uid, personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) } as SessionContext;
  };

  it('THE GUARD: the manager gets their OWN roster, not the subordinate’s — and RLS would have allowed the leak', async () => {
    const manager = await sessionFor(managerPersonId);

    // FIRST, prove the leak is genuinely on offer. This is the same session, the same window and the
    // subordinate's id, through the roster read that DOES take one — and the database answers, because
    // app.can_see_employment admits the administrative manager chain. Without this half, the assertion
    // below could be passing on RLS and nobody would know.
    const throughRls = await rosterForRange(manager, { employmentIds: [subordinateId], from, to });
    expect(
      throughRls.map((r) => r.shiftDate),
      'RLS hands the administrative manager the subordinate’s roster rows — the leak this screen must not take',
    ).toEqual(['2026-03-04']);
    expect(throughRls[0].shiftId, 'and they are the subordinate’s shift, not the manager’s').toBe(subordinateShift);

    // THE SCREEN'S READ. It takes no employment id, so there is nothing to ask it for.
    const view = (await myRosterWindow(manager, { from, to }))!;
    expect(view, 'the manager has an employment, so the screen renders').not.toBeNull();
    expect(view.employmentId, 'the manager gets their OWN roster, not the subordinate’s').toBe(managerId);

    // …and said in terms of what is ON SCREEN, not only whose id it carries: no cell anywhere in the
    // month may show the subordinate's shift code.
    const codes = [...new Set(view.days.map((d) => d.shift?.code).filter(Boolean))];
    expect(codes, 'only the manager’s own shift is drawn').toEqual(['MGR1']);
    expect(codes, 'the subordinate’s shift code appears nowhere on the manager’s roster').not.toContain('SUB1');
  });

  it('the subordinate gets their own roster too — the fence is symmetric, not a manager veto', async () => {
    const sub = await sessionFor(subordinatePersonId);
    const view = (await myRosterWindow(sub, { from, to }))!;
    expect(view.employmentId).toBe(subordinateId);
    expect([...new Set(view.days.map((d) => d.shift?.code).filter(Boolean))]).toEqual(['SUB1']);
  });

  it('a login linked to no active employment gets null, not somebody else’s roster', async () => {
    // The seeded HR administrator is exactly this: a real, named person with no employment.
    const view = await myRosterWindow(ctx, { from, to });
    expect(view, 'no employment ⇒ nothing to show, and nothing borrowed from anyone else').toBeNull();
  });

  // ── 2 · WHAT THE SCREEN SAYS ABOUT A DAY ─────────────────────────────────────────────────────────

  it('resolves rostered, rest, usual and off days by the supervisor roster’s own rule', async () => {
    const manager = await sessionFor(managerPersonId);
    const view = (await myRosterWindow(manager, { from, to }))!;

    const on = (iso: string) => view.days.find((d) => d.date === iso)!;
    // Wednesday 4 March — the supervisor rostered it.
    expect(on('2026-03-04').cell).toEqual({ kind: 'shift', shiftId: managerShift });
    expect(on('2026-03-04').note, 'the supervisor’s note rides the rostered date').toBe('Swapped with Tuesday');
    // Thursday 5 March — an explicit rest day.
    expect(on('2026-03-05').cell).toEqual({ kind: 'rest' });
    // Monday 2 March — nobody rostered it, but it is inside the usual shift's weekly pattern, so it
    // GHOSTS. This is the branch a second resolver would get wrong and the screen would read blank.
    expect(on('2026-03-02').cell).toEqual({ kind: 'usual', shiftId: managerShift });
    // Sunday 1 March — not in the pattern and not rostered: not scheduled.
    expect(on('2026-03-01').cell).toEqual({ kind: 'off' });
  });

  it('counts the four figures the summary tiles print, and never counts OFF as a rest day', async () => {
    const manager = await sessionFor(managerPersonId);
    const view = (await myRosterWindow(manager, { from, to }))!;

    // March 2026 has 22 weekdays. One of them (Thursday 5th) is an explicit rest day, so it is NOT a
    // work day; the other 21 are (20 ghosted from the pattern + the one actually rostered).
    expect(view.workDays, 'Mon–Fri in March 2026, less the one turned into a rest day').toBe(21);
    expect(view.rosteredDays, 'only the date the supervisor actually touched with a shift').toBe(1);
    expect(view.restDays, 'the explicit rest day, and NOT the nine weekend days').toBe(1);
    // 08:00–17:00 less a 60-minute break = 480 minutes a day, over 21 working days.
    expect(view.plannedMinutes).toBe(21 * 480);
    expect(view.legend.map((s) => s.code), 'the legend names only what is on screen').toEqual(['MGR1']);
    expect(view.lastUpdatedAt, 'a rostered window reports when it was last touched').toBeInstanceOf(Date);
  });

  it('reports no Last updated stamp for a window the supervisor has never touched', async () => {
    const manager = await sessionFor(managerPersonId);
    // A month with no roster_assignment rows at all. An absent caption asserts nothing; a stamp here
    // would assert a change that never happened.
    const untouched = monthRange('2026-05');
    const view = (await myRosterWindow(manager, untouched))!;
    expect(view.lastUpdatedAt).toBeNull();
    expect(view.rosteredDays).toBe(0);
  });

  it('refuses an over-wide window in the SERVICE, not merely in the form', async () => {
    const manager = await sessionFor(managerPersonId);
    // A hand-typed year. The screen's own resolver can never produce this, which is exactly why the
    // service has to refuse it: a form is an affordance, not a guard.
    await expect(myRosterWindow(manager, { from: '2026-01-01', to: '2026-12-31' })).rejects.toBeInstanceOf(RosterRangeError);
  });
});

// ── 3 · THE PAGE TAKES NO EMPLOYMENT FROM THE URL ───────────────────────────────────────────────────

describe('6948727a — nobody opens somebody else’s roster by editing the address', () => {
  it('the page reads no employment id, code or name off the query string', () => {
    const src = code(read(PAGE));
    // Not "validated" — never read at all. There is no comparison to get wrong.
    expect(src, 'the URL cannot name an employment').not.toMatch(/sp\.employmentId|searchParams\.get\(['"]employmentId['"]\)/);
    expect(src, 'nor an employee code').not.toMatch(/sp\.employeeCode|searchParams\.get\(['"]employeeCode['"]\)/);
    expect(src, 'nor a person').not.toMatch(/sp\.personId|searchParams\.get\(['"]personId['"]\)/);
    // The three parameters it DOES read, named so that a fourth cannot arrive unnoticed.
    expect(src, 'the query string carries the window and nothing else').toContain(
      'resolveMyRosterWindow({ view: sp.view, month: sp.month, date: sp.date, today })',
    );
    // The read itself takes the SESSION and a pair of dates. No id passes through this call.
    expect(src, 'the session decides whose roster this is').toContain('myRosterWindow(s, { from: w.from, to: w.to })');
  });

  it('the page is authenticated, ungated, and imports no roster write', () => {
    const src = code(read(PAGE));
    // scopedSession is the authentication boundary AND what keeps test/function-access.test.ts's
    // "no stale routes" satisfied for this registered route.
    expect(src, 'authenticated').toContain('scopedSession()');
    // …and NOT admin-gated: an admin gate here would take an employee's own shift times away from them.
    expect(src, 'no admin page guard').not.toMatch(/requireAdmin\(|scopedAdmin\(/);
    // No write reaches this screen, and not merely by hiding a button: a Server Action's id ships in
    // the bundle and is a POST endpoint with or without one on screen. The imports are the guard.
    for (const writer of ['assignShift', 'setRestDay', 'clearRoster', 'generateRosterFromTemplate', 'copyRoster']) {
      expect(src, `${writer} must not be reachable from a read-only screen`).not.toContain(writer);
    }
    expect(src, 'no server action module at all').not.toMatch(/from '\.\/actions'/);
  });

  it('is registered in the access grid with its own column', async () => {
    const { REGISTERED_ROUTES, SCREENS } = await import('../lib/permissions');
    expect(REGISTERED_ROUTES.has('/attendance/my-roster'), 'a guarded page needs a SCREENS column').toBe(true);
    const col = SCREENS.find((s) => s.screenKey === 'myRoster')!;
    expect(col, 'its own column, not a route bolted onto the administrator’s roster').toBeDefined();
    expect(col.guard, 'every authenticated role reaches it; the read is what narrows it').toBe('scopedSession');
    expect(col.routes).toEqual(['/attendance/my-roster']);
    // The administrator's grid of everybody stays a DIFFERENT column with a DIFFERENT guard.
    expect(SCREENS.find((s) => s.screenKey === 'roster')!.routes, 'the admin roster did not absorb it').not.toContain(
      '/attendance/my-roster',
    );
  });
});

// ── 4 · THE THREE VIEWS ─────────────────────────────────────────────────────────────────────────────

describe('6948727a — Daily / Weekly / Monthly are three windows over one read', () => {
  const TODAY = '2026-03-18'; // a Wednesday

  it('defaults to the month containing today, and ignores a query string it cannot read', () => {
    expect(resolveMyRosterWindow({ today: TODAY })).toEqual({ view: 'month', from: '2026-03-01', to: '2026-03-31', month: '2026-03', focus: null });
    // Garbage in the address bar gives the current month rather than a 500.
    expect(resolveMyRosterWindow({ view: 'yearly', month: 'banana', date: 'nope', today: TODAY }).from).toBe('2026-03-01');
  });

  it('snaps the week to Monday and reads a WHOLE week for the day view', () => {
    const week = resolveMyRosterWindow({ view: 'week', date: TODAY, today: TODAY });
    expect([week.from, week.to], 'Monday to Sunday around the Wednesday').toEqual(['2026-03-16', '2026-03-22']);
    expect(week.focus, 'the weekly view describes no single day').toBeNull();

    const day = resolveMyRosterWindow({ view: 'day', date: TODAY, today: TODAY });
    expect([day.from, day.to], 'the day view still reads the week, so the strip and the detail agree').toEqual([
      '2026-03-16',
      '2026-03-22',
    ]);
    expect(day.focus).toBe(TODAY);
  });

  it('steps each view in its own units', () => {
    const month = resolveMyRosterWindow({ view: 'month', month: '2026-03', today: TODAY });
    expect(stepMyRosterWindow(month, -1).month, 'a month steps by a month').toBe('2026-02');
    expect(stepMyRosterWindow(month, 1).month).toBe('2026-04');

    const week = resolveMyRosterWindow({ view: 'week', date: TODAY, today: TODAY });
    expect(stepMyRosterWindow(week, 1).from, 'a week steps by seven days').toBe('2026-03-23');

    const day = resolveMyRosterWindow({ view: 'day', date: TODAY, today: TODAY });
    const next = stepMyRosterWindow(day, 1);
    expect(next.focus, 'a day steps by one day').toBe('2026-03-19');
    expect([next.from, next.to], 'and its week follows it').toEqual(['2026-03-16', '2026-03-22']);
    // …across a week boundary the week follows too, rather than the strip going stale.
    const sunday = resolveMyRosterWindow({ view: 'day', date: '2026-03-22', today: TODAY });
    expect(stepMyRosterWindow(sunday, 1).from).toBe('2026-03-23');
  });

  it('a view switch keeps the reader where they were rather than jumping to today', () => {
    // Looking at January; switching to Daily must land in January, not in March.
    const january = resolveMyRosterWindow({ view: 'month', month: '2026-01', today: TODAY });
    expect(switchMyRosterView(january, 'day', TODAY).focus).toBe('2026-01-01');
    // …but when today IS on screen, today is the day they meant.
    const thisMonth = resolveMyRosterWindow({ view: 'month', month: '2026-03', today: TODAY });
    expect(switchMyRosterView(thisMonth, 'day', TODAY).focus).toBe(TODAY);
    // And back the other way: the month a chosen day is in.
    const day = resolveMyRosterWindow({ view: 'day', date: '2026-01-20', today: TODAY });
    expect(switchMyRosterView(day, 'month', TODAY).month).toBe('2026-01');
  });

  it('encodes ONE spelling per window, carrying only the parameters that view reads', () => {
    const month = resolveMyRosterWindow({ view: 'month', month: '2026-03', today: TODAY });
    expect(myRosterQuery(month)).toEqual({ view: 'month', month: '2026-03' });
    // A `date=` left on a month link would survive a view switch and silently re-anchor it.
    expect(myRosterQuery(month)).not.toHaveProperty('date');
    expect(myRosterQuery(resolveMyRosterWindow({ view: 'week', date: TODAY, today: TODAY }))).toEqual({ view: 'week', date: '2026-03-16' });
    expect(myRosterQuery(resolveMyRosterWindow({ view: 'day', date: TODAY, today: TODAY }))).toEqual({ view: 'day', date: TODAY });
    expect(myRosterHref(month)).toBe('/attendance/my-roster?view=month&month=2026-03');
  });

  it('can never ask the service for a window the service would refuse', () => {
    // Every window this resolver can produce is at most 31 days, well inside ROSTER_MAX_RANGE_DAYS (92).
    for (const view of ['day', 'week', 'month'] as const) {
      for (const m of ['2026-01', '2026-02', '2026-07', '2026-12']) {
        const w = resolveMyRosterWindow({ view, month: m, date: `${m}-15`, today: TODAY });
        const days = (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000 + 1;
        expect(days, `${view} ${m} stays inside the cap`).toBeLessThanOrEqual(31);
      }
    }
  });
});
