/**
 * The monthly roster grid, rendered (item 23390097).
 *
 * THE ONE THING A SOURCE GREP COULD NOT HAVE PROVED. The weekly grid's EA 1955 s.59 warning asked "does
 * EVERY visible day carry a shift?". Widening the screen from 7 columns to 31 would have left that line
 * compiling, passing tsc and returning 200 while never firing again, because almost nobody works all 31
 * days of a month. The fix is a rolling any-seven-consecutive-days check, and the only honest assertion
 * is that a reader SEES the badge on a month view — so this renders the real component in jsdom.
 *
 * It also pins the three things the reporter will look at first: the cell prints the shift CODE (not the
 * long name that used to be cut off mid-word), an un-rostered date shows the person's USUAL shift instead
 * of a dash, and a supervisor cannot click a date that is today or earlier.
 *
 * Scope note, inherited from client-pager.dom.test.tsx: jsdom applies no CSS and computes no layout, so
 * this catches rendering and interaction logic — not the sticky columns or the weekend tint.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { RosterGrid, type GridEmployee, type ShiftLite } from '../components/roster-grid';
import {
  addMonths,
  breachesRestDayRule,
  cellKey,
  isMonthParam,
  monthDates,
  monthRange,
  resolveRosterCell,
  shiftCodeOf,
  type AssignedCell,
  type UsualShift,
} from '../lib/roster-month';

// The server actions are the boundary this component talks over; the grid's own logic is what is under
// test, so they are stubbed rather than reached for (they would drag next/cache and a database in).
const assign = vi.fn(async () => ({ ok: true as const }));
vi.mock('../app/roster/actions', () => ({
  assignCellAction: (...a: unknown[]) => assign(...(a as [])),
  bulkAssignAction: async () => ({ ok: true as const }),
  rowAssignAction: async () => ({ ok: true as const }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const MONTH = '2026-08';
const DATES = monthDates(MONTH);
const TODAY = '2026-08-09';

const SHIFTS: ShiftLite[] = [
  { id: 'sh-mb28', code: 'MB28', name: 'WITH 0.5 OT HOUR ADJ - MORNING FULL (0800 - 1700)', startTime: '08:00:00', endTime: '17:00:00' },
  { id: 'sh-wfo', code: 'WFO-HQ-FWH', name: 'Work from office HQ', startTime: '09:00:00', endTime: '18:00:00' },
];

const EMPLOYEES: GridEmployee[] = [
  { employmentId: 'e1', name: 'Ahmad Zulkifli', code: 'A0001', department: 'Site Operations', occupation: 'DEPARTMENT HEAD' },
  { employmentId: 'e2', name: 'Nurul Ain', code: 'A0002', department: 'Finance', occupation: 'EXECUTIVE' },
  { employmentId: 'e3', name: 'Wan Nurhaliza', code: 'A0008', department: 'Site Operations', occupation: 'EXECUTIVE' },
];

function renderGrid(over?: {
  initial?: Record<string, AssignedCell>;
  usual?: Record<string, UsualShift>;
  isAdmin?: boolean;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RosterGrid
        dates={DATES.map((iso) => ({ iso, dow: 'Mon', day: iso.slice(8) }))}
        employees={EMPLOYEES}
        shifts={SHIFTS}
        initial={over?.initial ?? {}}
        usual={over?.usual ?? {}}
        isAdmin={over?.isAdmin ?? true}
        today={TODAY}
        month={MONTH}
        companyName="ISEDECOR BINA SDN BHD"
      />
    </NextIntlClientProvider>,
  );
}

/** The row of the grid table belonging to one employee. */
const rowFor = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

describe('monthly roster grid (23390097)', () => {
  it('prints the shift CODE in a cell, not the long shift name', () => {
    renderGrid({ initial: { [cellKey('e1', '2026-08-03')]: { kind: 'shift', shiftId: 'sh-mb28' } } });
    const row = rowFor('Ahmad Zulkifli');
    expect(within(row).getAllByText('MB28').length).toBeGreaterThan(0);
    expect(within(row).queryByText(/MORNING FULL/)).toBeNull();
  });

  it('ghosts the usual shift on an un-rostered date, and prints OFF on its pattern rest day', () => {
    // Mon–Fri pattern: 2026-08-03 is a Monday (working), 2026-08-08 a Saturday (OFF).
    renderGrid({ usual: { e1: { shiftId: 'sh-wfo', pattern: [1, 2, 3, 4, 5] } } });
    const row = rowFor('Ahmad Zulkifli');
    expect(within(row).getAllByText('WFO-HQ-FWH').length).toBe(21); // every weekday of August 2026
    expect(within(row).getAllByText('OFF').length).toBe(10); // every Sat/Sun
  });

  it('leaves the month blank for somebody with no usual shift at all', () => {
    renderGrid({ usual: { e1: { shiftId: 'sh-wfo', pattern: [1, 2, 3, 4, 5] } } });
    const row = rowFor('Wan Nurhaliza');
    expect(within(row).queryByText('OFF')).toBeNull();
    expect(within(row).getAllByText('—').length).toBe(DATES.length);
  });

  // THE REGRESSION THIS FILE EXISTS FOR.
  it('the s.59 rest-day warning still fires on a 31-column month (rolling seven days)', () => {
    const initial: Record<string, AssignedCell> = {};
    for (const iso of DATES.slice(0, 8)) initial[cellKey('e2', iso)] = { kind: 'shift', shiftId: 'sh-mb28' };
    renderGrid({ initial });
    expect(within(rowFor('Nurul Ain')).getByText('No rest')).toBeInTheDocument();
  });

  it('…and does NOT fire when a rest day breaks the run at six days', () => {
    const initial: Record<string, AssignedCell> = {};
    for (const iso of DATES.slice(0, 6)) initial[cellKey('e2', iso)] = { kind: 'shift', shiftId: 'sh-mb28' };
    initial[cellKey('e2', DATES[6])] = { kind: 'rest' };
    for (const iso of DATES.slice(7, 13)) initial[cellKey('e2', iso)] = { kind: 'shift', shiftId: 'sh-mb28' };
    renderGrid({ initial });
    expect(within(rowFor('Nurul Ain')).queryByText('No rest')).toBeNull();
  });

  it('a ghosted seven-day usual shift also breaches s.59 — the ghost is a real schedule', () => {
    renderGrid({ usual: { e2: { shiftId: 'sh-mb28', pattern: [1, 2, 3, 4, 5, 6, 7] } } });
    expect(within(rowFor('Nurul Ain')).getByText('No rest')).toBeInTheDocument();
  });

  it('a supervisor cannot click a date that is today or earlier; tomorrow onward stays clickable', () => {
    renderGrid({ isAdmin: false });
    const cells = within(rowFor('Ahmad Zulkifli')).getAllByRole('button');
    // One Edit button precedes the date cells in the row.
    const dateCells = cells.slice(1);
    expect(dateCells).toHaveLength(DATES.length);
    const idxToday = DATES.indexOf(TODAY);
    expect(dateCells[idxToday]).toBeDisabled();
    expect(dateCells[idxToday - 1]).toBeDisabled();
    expect(dateCells[idxToday + 1]).toBeEnabled();
  });

  it('an HR administrator may click those same dates', () => {
    renderGrid({ isAdmin: true });
    const dateCells = within(rowFor('Ahmad Zulkifli')).getAllByRole('button').slice(1);
    expect(dateCells[DATES.indexOf(TODAY)]).toBeEnabled();
  });

  it('shows every date of the chosen month as a column', () => {
    renderGrid();
    expect(DATES).toHaveLength(31);
    expect(within(rowFor('Ahmad Zulkifli')).getAllByRole('button').slice(1)).toHaveLength(31);
  });
});

/**
 * The pure half (lib/roster-month) — the precedence the grid, the export and the uploader all share.
 * It lives in the DOM project because it needs no database; putting it in the node suite would make a
 * pure function pay for a Postgres worker.
 */
describe('lib/roster-month', () => {
  it('knows how long a month is, including February in a leap year', () => {
    expect(monthDates('2026-02')).toHaveLength(28);
    expect(monthDates('2028-02')).toHaveLength(29);
    expect(monthDates('2026-08')).toHaveLength(31);
    expect(monthRange('2026-08')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('steps across a year boundary in both directions', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('accepts only a real YYYY-MM as the month parameter', () => {
    expect(isMonthParam('2026-08')).toBe(true);
    expect(isMonthParam('2026-13')).toBe(false);
    expect(isMonthParam('2026-8')).toBe(false);
    expect(isMonthParam(undefined)).toBe(false);
  });

  it('resolves a cell in scheduleFor order: rostered → rostered rest → usual → OFF → blank', () => {
    const usual: UsualShift = { shiftId: 'u', pattern: [1, 2, 3, 4, 5] };
    expect(resolveRosterCell('2026-08-03', { kind: 'shift', shiftId: 's' }, usual)).toEqual({ kind: 'shift', shiftId: 's' });
    expect(resolveRosterCell('2026-08-03', { kind: 'rest' }, usual)).toEqual({ kind: 'rest' });
    expect(resolveRosterCell('2026-08-03', null, usual)).toEqual({ kind: 'usual', shiftId: 'u' }); // Monday
    expect(resolveRosterCell('2026-08-08', null, usual)).toEqual({ kind: 'off' }); // Saturday
    expect(resolveRosterCell('2026-08-03', null, null)).toEqual({ kind: 'none' });
    // A usual shift with NO weekly pattern schedules nothing — same as core/attendance's resolveShiftDisplay.
    expect(resolveRosterCell('2026-08-03', null, { shiftId: 'u', pattern: null })).toEqual({ kind: 'off' });
  });

  it('breachesRestDayRule is a ROLLING seven, not "every visible day"', () => {
    const dates = monthDates('2026-08');
    const working = (set: Set<string>) => (iso: string) => (set.has(iso) ? ({ kind: 'shift', shiftId: 's' } as const) : ({ kind: 'rest' } as const));
    expect(breachesRestDayRule(dates, working(new Set(dates.slice(0, 7))))).toBe(true);
    expect(breachesRestDayRule(dates, working(new Set(dates.slice(0, 6))))).toBe(false);
    // The old weekly question ("every visible day") would answer false here; the rolling one answers true.
    expect(breachesRestDayRule(dates, working(new Set(dates.slice(10, 20))))).toBe(true);
    expect(breachesRestDayRule(dates.slice(0, 5), () => ({ kind: 'shift', shiftId: 's' }))).toBe(false);
  });

  it('falls back to the shift NAME when a legacy shift carries no code', () => {
    expect(shiftCodeOf({ code: 'MB28', name: 'Morning' })).toBe('MB28');
    expect(shiftCodeOf({ code: null, name: 'Morning' })).toBe('Morning');
    expect(shiftCodeOf({ code: '  ', name: 'Morning' })).toBe('Morning');
    expect(shiftCodeOf(undefined)).toBe('?');
  });
});
