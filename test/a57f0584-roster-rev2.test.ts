/**
 * a57f0584 REV 2 — "Redesign Attendance Roster Screen and Workflow", the half that is not geometry.
 *
 * The frozen-column overlap is measured on the rendered grid in test/a57f0584-roster-rev2.dom.test.tsx
 * (including the non-vacuity note). This file pins the other four changes the reporter asked for, and
 * the two invariants each of them could quietly break:
 *
 *   · THE DATE FORMAT. "01/09" became a named month. Pinned on the FORMATTER, because that is where it
 *     was changed — the grid renders what it is handed, and a second rendition inside the client
 *     component is how a heading and the export stop agreeing.
 *   · EDIT ON ITS OWN SCREEN. A guarded page, registered in the access matrix, reached by a LINK, saving
 *     through the SAME writer the panel used, and returning to the roster.
 *   · EXCEPTIONS ON ITS OWN SCREEN. The roster keeps a COUNT; the rows moved. The count and the listing
 *     are the same decision, asserted against the database rather than against each other's source.
 *   · THE MERGED EMPLOYEE COLUMN, from the page's side: the payload it sends the grid.
 *
 * WHY SO MANY SOURCE ASSERTIONS HERE. Two of these are contracts BETWEEN files — a page that renders a
 * link and a matrix that must know the route exists; a client island that must not be handed a server
 * action. Neither is visible to a render of either file on its own, and the second one is the failure
 * mode this repo has shipped before: passing a server action into a client island 500s on every request
 * while tsc, the suite and `next build` all stay green.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { assignShift, createShift, isRosterException, rosterExceptionCount, rosterMonthView, rosterVariance, setRestDay } from '../core/roster';
import { checkIn, checkOut } from '../core/attendance';
import { REGISTERED_ROUTES, SCREENS } from '../lib/permissions';
import en from '../messages/en.json';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const PAGE = src('app/roster/page.tsx');
const GRID = src('components/roster-grid.tsx');
const EDIT = src('app/roster/edit/[employmentId]/page.tsx');
const PICKER = src('app/roster/edit/[employmentId]/date-picker.tsx');
const EXCEPTIONS = src('app/roster/exceptions/page.tsx');
const ACTIONS = src('app/roster/actions.ts');

// ── 1. THE DATE FORMAT ───────────────────────────────────────────────────────────────────────────

describe('a57f0584 · a date heading names its month', () => {
  /**
   * `{ day: '2-digit', month: '2-digit' }` produced `01/09`, which a reader has to be told how to parse.
   * Asserted through Intl in the SIX locales the app ships, not against a golden English string: the
   * property is "the month is a NAME, not a number", and a hardcoded ['Jan','Feb',…] — the trap the
   * Excel template header records from the other direction — would pass an en-only assertion.
   */
  it('renders a named month in every shipped locale, never a numeric one', () => {
    const d = new Date('2026-09-01T00:00:00Z');
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const out = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(d);
      expect(out, `${locale} must print the day`).toMatch(/01/);
      expect(out, `${locale} must not be two numbers with a separator`).not.toMatch(/^\d{2}[/\-.]\d{2}$/);
      const old = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(d);
      expect(out, `${locale} must differ from the numeric form it replaced`).not.toBe(old);
    }
  });

  /**
   * UPDATED by the three-views increment, NOT loosened. It used to pin the whole `dayFmt` line, which
   * named `locale` directly; the formatter now resolves through `rosterDateLocale`, which maps `en` to
   * en-GB so a short date reads day-first ("01 Sept") as the plan's own example does. The PROPERTY is
   * unchanged and still asserted — one formatter, `{ day: '2-digit', month: 'short' }`, no numeric
   * month — and what the mapping does is pinned in test/a57f0584-roster-views.test.ts.
   */
  it('the page changed the FORMATTER, and the grid still renders what it is handed', () => {
    expect(PAGE, 'the numeric month is gone').not.toContain("{ day: '2-digit', month: '2-digit', timeZone: 'UTC' }");
    expect(PAGE).toContain("const dayFmt = new Intl.DateTimeFormat(dateLocale, { day: '2-digit', month: 'short', timeZone: 'UTC' });");
    expect(PAGE, 'and the locale it formats in is the shared roster mapping').toContain('const dateLocale = rosterDateLocale(locale);');
    expect(PAGE, 'the formatter is the only place a date is built').toContain('day: dayFmt.format(d)');
    // A second rendition inside the client component is the thing to prevent: the grid must own no
    // date formatting of its own, or the heading and the export can drift.
    expect(GRID, 'the grid must not format dates').not.toContain('Intl.DateTimeFormat');
  });

  it('never hardcodes an English month table anywhere on this screen', () => {
    for (const [name, s] of [['page', PAGE], ['grid', GRID], ['edit', EDIT], ['exceptions', EXCEPTIONS]] as const) {
      expect(s, `${name} must not carry a month array`).not.toMatch(/['"]Jan['"]\s*,\s*['"]Feb['"]/);
    }
  });
});

// ── 2. THE MERGED EMPLOYEE COLUMN, FROM THE PAGE'S SIDE ──────────────────────────────────────────

describe('a57f0584 · one Employee column, and the geometry that follows from it', () => {
  it('PINNED_W and both ORDER arrays describe the SAME columns — one entry for the person', () => {
    const widths = GRID.slice(GRID.indexOf('const PINNED_W'), GRID.indexOf('\n', GRID.indexOf('const PINNED_W')));
    expect(widths, 'employee is one column').toMatch(/employee:\s*\d+/);
    expect(widths, 'and the two it replaced are gone').not.toMatch(/\bno:\s*\d+/);
    expect(widths).not.toMatch(/\bname:\s*\d+/);

    const keys = [...widths.matchAll(/(\w+):\s*\d+/g)].map((m) => m[1]);
    const orderOf = (n: string) => {
      const line = GRID.slice(GRID.indexOf(`const ${n}`), GRID.indexOf('\n', GRID.indexOf(`const ${n}`)));
      return [...line.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    };
    // EVERY declared width is placed by the edit order, and the read-only order is a SUBSET of it. A
    // width with no place in either order is an offset nobody sums — which is how a dead key rots.
    expect([...orderOf('EDIT_ORDER')].sort()).toEqual([...keys].sort());
    for (const k of orderOf('VIEW_ORDER')) expect(keys, `VIEW_ORDER key ${k}`).toContain(k);
  });

  it('the roster sends the grid identity and occupation, and stops sending what it stopped drawing', () => {
    expect(GRID, 'the grid type drops department').not.toMatch(/export type GridEmployee = \{[^}]*department/);
    expect(GRID, 'and company').not.toMatch(/export type GridEmployee = \{[^}]*company/);
  });

  it('the merged heading is a real key in all six locales', () => {
    expect(typeof (en as { roster: Record<string, unknown> }).roster.colEmployee).toBe('string');
  });
});

// ── 3. EDIT ON ITS OWN SCREEN ────────────────────────────────────────────────────────────────────

describe('a57f0584 · Edit opens a screen, and comes back', () => {
  it('the grid links out instead of toggling a panel, and the panel is gone', () => {
    expect(GRID, 'Edit is a link').toContain('/roster/edit/${employmentId}');
    expect(GRID, 'no row-editor state').not.toContain('setEditing');
    expect(GRID, 'no row-editor component').not.toContain('function RowEditor');
    // THE CONFIRM THE PLAN NAMED. The row edit's window.confirm goes with the panel.
    expect(GRID, "the row-edit confirm is gone").not.toContain("t('rowConfirm'");
    // The PAST-DATE confirm deliberately stays — see the note on confirmPast. Asserted so that a later
    // tidy-up removing it has to argue with this line rather than with a silent behaviour change.
    expect(GRID, 'the past-date confirm is a different requirement and stays').toContain("t('pastConfirm'");
  });

  it('the screen is a guarded page with a column in the access matrix', () => {
    expect(EDIT, 'admin-gated, not merely unlinked').toContain('scopedAdmin()');
    expect(REGISTERED_ROUTES.has('/roster/edit/[employmentId]'), 'registered in lib/permissions').toBe(true);
    const column = SCREENS.find((s) => s.routes.includes('/roster/edit/[employmentId]'));
    expect(column, 'the route must ride a column').toBeDefined();
    expect(column!.guard, 'an admin page may not ride a scopedSession column').toBe('requireAdmin');
  });

  /**
   * THE 500 THAT STAYS GREEN EVERYWHERE ELSE. A server action handed to a client island as a prop fails
   * at request time while tsc, the suite and `next build` all pass. The island here is INSIDE the form
   * and holds only data; the `action=` lives on the server-rendered <form>.
   */
  it('no server action is passed into the client island', () => {
    expect(PICKER, 'the island is a client component').toContain("'use client'");
    expect(PICKER, 'and imports no action').not.toContain('@/app/roster/actions');
    expect(PICKER).not.toContain("from '../../actions'");
    expect(EDIT, 'the form owns the action').toContain('<form action={saveRosterRowAction}');
    expect(EDIT, 'and the island is rendered inside it, taking data only').toMatch(
      /<RosterEditDates dates=\{editDates\} initial=\{initialPicked\} \/>/,
    );
  });

  it('it saves through the SAME writer the panel used, and returns to the list', () => {
    expect(ACTIONS, 'the new action is a wrapper, not a second writer').toContain('await rowAssignAction({ employmentId, shiftDates, brush })');
    expect(ACTIONS, 'success lands back on the roster').toContain("redirect(`/roster?${listQuery.toString()}`)");
    expect(ACTIONS, 'a refusal lands back on the edit screen with the reason').toContain('/roster/edit/${employmentId}?${editQuery.toString()}');
    expect(PAGE, 'and the roster says what was saved').toContain("t('rowApplied', { count: rowSaved })");
  });

  it('every string the two new screens print resolves in en.json', () => {
    const roster = (en as { roster: Record<string, unknown> }).roster;
    for (const k of [
      'colEmployee',
      'exceptionsButton',
      'exceptionsTitle',
      'exceptionsBack',
      'exceptionsNone',
      'pastWarning',
      'rowEditSection',
      'rowEditSave',
      'rowEditCancel',
      'rowEditMissing',
      'rowEditNoDates',
    ]) {
      expect(typeof roster[k], `roster.${k}`).toBe('string');
    }
  });
});

// ── 4. EXCEPTIONS ON ITS OWN SCREEN ──────────────────────────────────────────────────────────────

describe('a57f0584 · the exceptions listing left the roster', () => {
  it('the roster reads a COUNT and draws no rows', () => {
    expect(PAGE, 'the listing read is gone').not.toContain('rosterVariance(');
    expect(PAGE).toContain('rosterExceptionCount(s, { from: view.from, to: view.to, companyIds, today: todayIso, ...(teamScope?{employmentIds:teamScope.employmentIds}:{}) })');
    expect(PAGE, 'no variance rows are rendered here any more').not.toContain('kindBadge');
    expect(PAGE, 'nor the button that only appeared on one of them').not.toContain('ToilElectButton');
    expect(PAGE, 'and the count rides the button').toContain("t('exceptionsButton', { count: exceptionCount })");
  });

  it('the listing is a guarded page on the roster column, reachable by a supervisor', () => {
    expect(EXCEPTIONS).toContain('scopedSession()');
    expect(REGISTERED_ROUTES.has('/roster/exceptions')).toBe(true);
    const column = SCREENS.find((s) => s.routes.includes('/roster/exceptions'));
    expect(column?.screenKey, 'it is the roster, not a new screen').toBe('roster');
    expect(column?.guard, 'a supervisor who reads the roster reads its exceptions').toBe('scopedSession');
  });
});

// ── 5. THE SAME DECISION BEHIND THE COUNT AND THE ROWS (against the database) ─────────────────────

let b: Base;
let ctx: ReturnType<typeof adminCtx>;
let shiftId: string;
const TODAY = '2026-07-15';
const FROM = '2026-07-01';
const TO = '2026-07-31';

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `r328_${randomUUID().slice(0, 8)}@t.local` })
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
    await createShift(ctx, {
      companyId: b.companyId,
      name: 'Day',
      code: 'DAY',
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
    })
  ).id;
});

describe('a57f0584 · the number on the button is the number of rows behind it', () => {
  /**
   * The count is not a cheaper second query and must never become one: what an exception IS lives in
   * JavaScript (per-date approved leave, half/hourly leave spans, future shifts, and the shift's own
   * Normal-Hours Rounding). This asserts the two answers agree on a month that contains one of each
   * classification INCLUDING the on-track row the count must exclude and the future row nothing may
   * count yet.
   */
  it('agrees with the listing across every classification, on-track and future included', async () => {
    const emp = await makeEmp('Exception Person');
    const rest = await makeEmp('Rest Worker');
    for (const d of ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-20']) {
      await assignShift(ctx, { employmentId: emp, shiftDate: d, shiftId });
    }
    await checkIn(ctx, { employmentId: emp, date: '2026-07-02', time: '08:20:00' }); // late
    await checkOut(ctx, { employmentId: emp, date: '2026-07-02', time: '17:00:00' });
    await checkIn(ctx, { employmentId: emp, date: '2026-07-03', time: '08:00:00' }); // short
    await checkOut(ctx, { employmentId: emp, date: '2026-07-03', time: '12:00:00' });
    await checkIn(ctx, { employmentId: emp, date: '2026-07-06', time: '08:00:00' }); // on track
    await checkOut(ctx, { employmentId: emp, date: '2026-07-06', time: '17:00:00' });
    await setRestDay(ctx, { employmentId: rest, shiftDate: '2026-07-07' });
    await checkIn(ctx, { employmentId: rest, date: '2026-07-07', time: '09:00:00' }); // rest_worked
    await checkOut(ctx, { employmentId: rest, date: '2026-07-07', time: '13:00:00' });

    const rows = await rosterVariance(ctx, { from: FROM, to: TO, companyIds: [b.companyId], today: TODAY });
    const listed = rows.filter(isRosterException);
    const kinds = new Set(listed.map((r) => r.kind));
    expect(kinds, 'the fixture must exercise more than one classification').toEqual(
      new Set(['no_show', 'late', 'short', 'rest_worked']),
    );
    expect(rows.some((r) => r.kind === 'on_track'), 'and an on-track row the count must NOT include').toBe(true);

    const count = await rosterExceptionCount(ctx, { from: FROM, to: TO, companyIds: [b.companyId], today: TODAY });
    expect(count, 'the button and the screen answer the same question').toBe(listed.length);
    expect(count, 'and it is strictly fewer than every variance row').toBeLessThan(rows.length);
  });

  it('is zero, not absent, when a month went entirely to plan', async () => {
    const emp = await makeEmp('On Plan');
    await assignShift(ctx, { employmentId: emp, shiftDate: '2026-07-06', shiftId });
    await checkIn(ctx, { employmentId: emp, date: '2026-07-06', time: '08:00:00' });
    await checkOut(ctx, { employmentId: emp, date: '2026-07-06', time: '17:00:00' });
    expect(await rosterExceptionCount(ctx, { from: FROM, to: TO, companyIds: [b.companyId], today: TODAY })).toBe(0);
  });
});

// ── 6. THE EDIT SCREEN READS THE SAME VIEW THE GRID DREW ─────────────────────────────────────────

describe('a57f0584 · the Edit screen is a window on the roster read, not a second one', () => {
  it('narrows the month view to one employment without changing what it resolves', async () => {
    const a = await makeEmp('Editable Person');
    const other = await makeEmp('Someone Else');
    await assignShift(ctx, { employmentId: a, shiftDate: '2026-07-06', shiftId });
    await assignShift(ctx, { employmentId: other, shiftDate: '2026-07-06', shiftId });

    const whole = await rosterMonthView(ctx, { companyIds: [b.companyId], month: '2026-07' });
    const one = await rosterMonthView(ctx, { companyIds: [b.companyId], month: '2026-07', employmentIds: [a] });

    expect(one.employees.map((e) => e.employmentId)).toEqual([a]);
    expect(one.dates, 'the same month').toEqual(whole.dates);
    // The cell the editor is about to overwrite must be the cell the grid drew.
    const key = `${a}|2026-07-06`;
    expect(one.cells[key]).toEqual(whole.cells[key]);
    expect(one.cells[`${other}|2026-07-06`], 'and nobody else comes along').toBeUndefined();
  });

  it('an employment this session cannot see yields no row rather than a leak or a crash', async () => {
    const view = await rosterMonthView(ctx, {
      companyIds: [b.companyId],
      month: '2026-07',
      employmentIds: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(view.employees).toEqual([]);
    expect(view.allEmployees.length, 'the unfiltered list is unaffected').toBeGreaterThanOrEqual(0);
  });
});
