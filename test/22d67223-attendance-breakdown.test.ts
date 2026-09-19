/**
 * 22d67223 — ATTENDANCE BREAKDOWN DETAIL: the audit surface. Every figure the engine recorded for one
 * employee, day by day, across a range.
 *
 * READ-ONLY AND PRESENTATION ONLY. It computes nothing: no figure may move because this screen exists, so
 * this file asserts nothing about attendance arithmetic. It pins the four things that are cheap to break
 * and expensive to notice.
 *
 * ⚠️ 1. THE GUARD IS THE LOAD-BEARING ASSERTION, and it is here because the screen was written wrong
 * first. It shipped as `scopedSession` to match '/attendance' next door. That was a LEAK, not a style
 * choice: `scopedSession` resolves a COMPANY scope, and the employee picker is `listEmployees`, which is
 * tenant-scoped and filtered only by those company ids with no narrowing by role. A plain employee who
 * typed the URL would have been offered every colleague in their company and served any one of their full
 * calculation audit. The `adminOnly` flag on the nav row hides the LINK and protects nothing — the exact
 * failure test/attendance-menu-relocation.test.ts exists to catch. '/attendance' may be scopedSession
 * because it is genuinely self-service and its service narrows the reading; this screen has no
 * self-service entry point anywhere, so it refuses at the door instead.
 *
 * 2. SIX-LOCALE RESOLUTION, derived from the SOURCE rather than from a list kept by hand. A missing key
 * renders as MISSING_MESSAGE at request time: tsc, the suite and `next build` are all green over it
 * (CLAUDE.md section 8). Twenty-nine columns went in at once, so the keys are read back OUT of the page.
 *
 * 3. THE COLUMN COUNT, because a stale colSpan does not fail anything — it just draws a cell the wrong
 * width. The same defect reached main in r306 on a table that went from 13 columns to 15.
 *
 * 4. THE COLUMNS WITH NO SOURCE STAY UNBUILT. About a third of the requested columns have nothing behind
 * them in the data, and the plan put them to the reporter rather than inventing them. A key appearing for
 * one of those names means somebody guessed; it must arrive with its source instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const SCREEN = '/app/attendance/breakdown/page.tsx';
const PERMISSIONS = '/lib/permissions.ts';
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** Source with comments stripped: this page explains at length what it does NOT render, and every one of
 *  those explanations quotes the specifier a whole-file grep would trip on. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const messages = (loc: string) => JSON.parse(read(`/messages/${loc}.json`)) as Record<string, unknown>;
const lookup = (bag: Record<string, unknown>, path: string) =>
  path.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], bag);

describe('22d67223 · the screen refuses, it does not merely hide its link', () => {
  it('calls scopedAdmin in its own page body — and never scopedSession', () => {
    const src = codeOnly(read(SCREEN));
    expect(src.includes('await scopedAdmin()'), 'the screen must resolve an ADMIN session').toBe(true);
    // THE NON-VACUITY ARM. This is the state the screen was actually in, so it is asserted directly
    // rather than implied by the line above: both can be present at once and the weaker one would win.
    expect(src.includes('scopedSession'), 'scopedSession is the leak — see this file header').toBe(false);
  });

  /**
   * The reason the guard has to be refusal rather than scoping, stated as an assertion so that changing
   * the picker forces this decision to be re-made rather than quietly invalidating it.
   */
  it('still feeds its picker from listEmployees, which is why scoping alone would not do', () => {
    const src = codeOnly(read(SCREEN));
    expect(src.includes('listEmployees(s, scopeIds)')).toBe(true);
  });

  it('is its OWN column in the access grid, guarded scopedAdmin', () => {
    const perms = read(PERMISSIONS);
    const col = perms.slice(perms.indexOf("screenKey: 'attendanceBreakdown'"));
    expect(col.length, 'the column is missing entirely').toBeGreaterThan(0);
    const body = col.slice(0, col.indexOf('},'));
    expect(body.includes("guard: 'scopedAdmin'")).toBe(true);
    expect(body.includes("routes: ['/attendance/breakdown']")).toBe(true);
    // NOT a route on the 'attendance' column: that column is scopedSession, and listing it there would
    // tell every reader of the access grid that ordinary staff reach a screen they are refused.
    const attendanceCol = perms.slice(perms.indexOf("screenKey: 'attendance'"));
    expect(
      attendanceCol.slice(0, attendanceCol.indexOf('hasScopeNote')).includes('/attendance/breakdown'),
      'the breakdown is back on the scopedSession column',
    ).toBe(false);
  });

  it('has no write path of its own — the only form is the GET filter', () => {
    const src = codeOnly(read(SCREEN));
    expect(src.includes("'use server'"), 'an audit view writes nothing').toBe(false);
    expect(src.includes('method="get"'), 'the filter form is a GET').toBe(true);
    expect(src.includes('method="post"')).toBe(false);
  });
});

describe('22d67223 · every column it renders has a label in all six locales', () => {
  /** Read back out of the page, so a column added later without a key fails here rather than at runtime. */
  const keys = [...new Set([...codeOnly(read(SCREEN)).matchAll(/\bt\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]))];

  it('found the keys to check (the extraction itself is not vacuous)', () => {
    expect(keys.length, 'no t() calls found — the regex has stopped matching the page').toBeGreaterThan(40);
    expect(keys).toContain('breakdownTitle');
  });

  it.each(LOCALES)('%s resolves every one of them to a non-empty string', (loc) => {
    const bag = messages(loc).attendance as Record<string, unknown>;
    for (const key of keys) {
      const v = lookup(bag, key);
      expect(typeof v, `${loc}: attendance.${key} is missing`).toBe('string');
      expect(v, `${loc}: attendance.${key} is blank`).not.toBe('');
    }
  });

  it('the nav row label resolves too, in all six', () => {
    for (const loc of LOCALES) {
      const v = (messages(loc).nav as Record<string, unknown>).attendanceBreakdown;
      expect(typeof v, `${loc}: nav.attendanceBreakdown`).toBe('string');
      expect(v, `${loc}: nav.attendanceBreakdown is blank`).not.toBe('');
    }
  });
});

describe('22d67223 · the table is internally consistent', () => {
  it('every full-width row spans exactly the number of columns the header has', () => {
    const src = read(SCREEN);
    const thead = src.slice(src.indexOf('<thead'), src.indexOf('</thead>'));
    const columns = (thead.match(/<th\b/g) ?? []).length;
    expect(columns, 'the breakdown is a wide table by design').toBeGreaterThan(20);
    const spans = [...src.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length, 'the empty state spans the table').toBeGreaterThan(0);
    for (const span of spans) expect(span, `a colSpan is stale — the header has ${columns}`).toBe(columns);
  });

  /**
   * NOT A SECOND SOURCE OF FIGURES. `calcTrace` is typed loosely; reading a field off it directly is how
   * two screens come to disagree about the same day. Everything goes through the kernel's own explainer
   * and the shared minute formatter.
   */
  it('reads the trace through explainAttendanceDay and formats through the shared helper', () => {
    const src = codeOnly(read(SCREEN));
    expect(src.includes('explainAttendanceDay(r.calcTrace)')).toBe(true);
    expect(src.includes("from '@/components/attendance-format'")).toBe(true);
    expect(src.includes('toFixed('), 'the screen must not format a figure itself').toBe(false);
  });
});

describe('22d67223 · the columns with no source were asked about, not invented', () => {
  /**
   * These were in the reporter's list and have nothing behind them in the data — half-day splits, break-
   * level lateness, Shift Group ID, Day Code, Schedule vs Approved overtime. The plan says so in writing.
   * If one of these names turns up as a key, somebody has guessed at a figure on an AUDIT screen, which is
   * the one screen where a guessed figure is worst.
   */
  const UNSOURCED = ['colDayCode', 'colShiftGroupId', 'colHalfDayAm', 'colHalfDayPm', 'colScheduleOt', 'colApprovedOt', 'colBreakLate', 'colEarlyInShift', 'colLateInShift'];

  it.each(UNSOURCED)('%s is not rendered, and not authored', (key) => {
    expect(codeOnly(read(SCREEN)).includes(`t('${key}')`), `${key} appeared with no source`).toBe(false);
    expect(lookup(messages('en').attendance as Record<string, unknown>, key), `${key} was authored`).toBeUndefined();
  });

  it('and the screen says out loud which ones it left, so the next reader does not rebuild the guess', () => {
    const header = read(SCREEN).slice(0, read(SCREEN).indexOf('export default'));
    expect(header.includes('UNKNOWN'), 'the unsourced columns must be named in the header').toBe(true);
  });
});
