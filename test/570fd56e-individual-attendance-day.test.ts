/**
 * 570fd56e — Individual Attendance: eight calculation columns move off the list onto a per-day screen.
 *
 * PRESENTATION ONLY. No figure may move, so this file asserts nothing about attendance arithmetic. It pins
 * the three properties that are cheap to break and expensive to notice:
 *
 *   1. the eight columns left the LIST and arrived on the DAY SCREEN — "removed" and "deleted" are
 *      different claims, and the reporter was promised the first;
 *   2. the day screen is not a SECOND source of figures;
 *   3. "Edit" is a link into the existing correction workflow, not a second write path to attendance.
 *
 * NOT COVERED HERE: the rendered date string. `fmtDayDate` delegates to `toLocaleDateString`, whose output
 * is ICU's, not ours — asserting "18 Sep 2026" would be testing Node's bundled locale data. What IS pinned
 * is that the locale is passed rather than hardcoded, which is the defect that was actually there.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const LIST = '/app/attendance/individual/page.tsx';
const DAY = '/app/attendance/individual/[date]/page.tsx';
const FORMAT = '/components/attendance-format.ts';
const PERMISSIONS = '/lib/permissions.ts';

/** Source with comments stripped — both files explain at length what they no longer render. */
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const EIGHT = ['colLateness', 'colEarlyOut', 'colOtFlat', 'colOt00', 'colOt10', 'colOt15', 'colOt20', 'colOt30'];

describe('570fd56e · the eight calculation columns moved, and did not vanish', () => {
  it('none of the eight is a column of the LIST any more', () => {
    const list = codeOnly(read(LIST));
    for (const key of EIGHT) {
      expect(list.includes(`t('${key}')`), `${key} is still rendered on the list`).toBe(false);
    }
  });

  it('all eight ARE on the day screen — the reporter was promised moved, not deleted', () => {
    const day = codeOnly(read(DAY));
    for (const key of EIGHT) {
      expect(day.includes(`t('${key}')`), `${key} did not arrive on the day screen`).toBe(true);
    }
  });

  it('the list keeps the columns it is FOR, and gains the action', () => {
    const list = codeOnly(read(LIST));
    for (const key of ['colDate', 'colDay', 'colShiftCode', 'colCheckIn', 'colCheckOut', 'colShiftHours', 'colActualHours', 'colStatus', 'colFlag', 'colAction']) {
      expect(list.includes(`t('${key}')`), `the list lost ${key}`).toBe(true);
    }
  });

  /**
   * THE ONE THAT SILENTLY BREAKS. Two rows span the whole table — the multi-punch trail and the empty
   * state. They were `colSpan={17}` for the eighteen-column layout; the list is ten columns now. A stale
   * colSpan does not fail anything, it just draws a cell wider than the table, so it is pinned by counting
   * the headings rather than by quoting a number.
   */
  it('every full-width row spans exactly the number of columns the list actually has', () => {
    const list = read(LIST);
    const thead = list.slice(list.indexOf('<thead'), list.indexOf('</thead>'));
    const columns = (thead.match(/<th\b/g) ?? []).length;
    expect(columns, 'the list should be ten columns after the eight moved').toBe(10);
    const spans = [...list.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
    expect(spans.length, 'the trail row and the empty state both span the table').toBeGreaterThan(0);
    for (const span of spans) expect(span, 'a colSpan is stale').toBe(columns);
  });
});

describe('570fd56e · the day screen is not a second source of anything', () => {
  it('renders the figures through the SAME island and the SAME working as the list did', () => {
    const day = read(DAY);
    expect(day.includes("from '@/components/attendance-figure-cells'")).toBe(true);
    expect(day.includes('explanation={explainAttendanceDay(row.calcTrace)}')).toBe(true);
    // The same range read, for one date — not a new per-day read that could resolve a day differently.
    expect(day.includes('attendanceForEmploymentRange(s, selected.employmentId, date, date)')).toBe(true);
  });

  it('formats minutes through the shared formatter, never its own', () => {
    const day = codeOnly(read(DAY));
    expect(day.includes("from '@/components/attendance-format'")).toBe(true);
    expect(day.includes('toFixed('), 'the day screen must not format a figure itself').toBe(false);
  });

  /**
   * EDIT IS A LINK. A second write path to an attendance record would bypass the correction workflow's
   * approval and attachment, which is how overtime changes with no trail.
   */
  it('has no write path of its own — no server action, no form post', () => {
    const day = codeOnly(read(DAY));
    expect(day.includes("'use server'")).toBe(false);
    expect(day.includes('<form'), 'the day screen submits nothing').toBe(false);
    expect(day.includes('/attendance/requests'), 'Edit points at the existing correction flow').toBe(true);
  });

  it('is registered as a guarded route, so the access grid covers it', () => {
    expect(read(PERMISSIONS).includes("'/attendance/individual/[date]'")).toBe(true);
  });
});

describe('570fd56e · the date is locale-formatted, not an English template', () => {
  it('the helpers take a locale and never hardcode one', () => {
    const fmt = read(FORMAT);
    expect(fmt.includes('export const fmtDayDate = (iso: string, locale: string)')).toBe(true);
    expect(fmt.includes('export const fmtDayName = (iso: string, locale: string)')).toBe(true);
    // The weekday used to be built with a hardcoded 'en-GB' inline on the list.
    expect(codeOnly(read(LIST)).includes("'en-GB'"), 'a locale is hardcoded again').toBe(false);
  });

  it('an attendance date is rendered in UTC — a plain calendar date is not an instant', () => {
    const fmt = read(FORMAT);
    const block = fmt.slice(fmt.indexOf('export const fmtDayDate'));
    expect(block.includes("timeZone: 'UTC'")).toBe(true);
  });

  it('both callers pass the viewer locale through', () => {
    for (const p of [LIST, DAY]) {
      expect(read(p).includes('const locale = await getLocale();'), `${p} resolves the locale`).toBe(true);
    }
  });
});
