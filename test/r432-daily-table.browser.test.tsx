/**
 * r432 (e721a355) — THE DAILY ATTENDANCE LIST, MEASURED IN A REAL ENGINE at 390 and 1280. jsdom computes no
 * layout, so only Chromium with the app's compiled Tailwind can say whether a ten-column list with sticky
 * identity columns and a full-width clockings row stays inside the page. It mounts the REAL shared cells
 * (components/attendance-day-cells.tsx) in the same wrapper the page uses (`overflow-x-auto` around a
 * `w-max min-w-full` table, sticky Code + Name from lib/sticky-columns), with a long name, an Absent row and
 * a multi-clocking row. The promise: the PAGE never scrolls sideways; at 390 the table scrolls inside its own
 * wrapper; at 1280 it fits without scrolling; the trail row spans the table.
 */
import { Fragment } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '../app/globals.css';
import en from '../messages/en.json';
import { AttendanceDayCells, AttendanceTrailRow, dayCellLabels } from '../components/attendance-day-cells';
import { placeStickyColumns } from '../lib/sticky-columns';

afterEach(() => cleanup());

const a = en.attendance as unknown as Record<string, string>;
const labels = dayCellLabels(((k: string) => a[k]) as never);
const STICKY = placeStickyColumns([
  { key: 'employeeCode', rem: 7 },
  { key: 'employeeName', rem: 14 },
]);
const stick = (head: boolean) => `sticky z-10 whitespace-nowrap px-3 ${head ? 'py-2 font-medium bg-muted' : 'py-2.5 bg-card'}`;

const base = { shiftCode: 'AM01', checkInAt: '08:02:00', checkOutAt: '17:05:00', scheduledMinutes: 480, workedMinutes: 485 };

function Screen() {
  return (
    <div data-testid="page" style={{ boxSizing: 'border-box', padding: '0 16px' }}>
      <div data-testid="wrap" className="overflow-x-auto">
        <table className="w-max min-w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className={stick(true)} style={STICKY[0].style}>{a.colEmployeeCode}</th>
              <th className={stick(true)} style={STICKY[1].style}>{a.colEmployeeName}</th>
              {['colShiftCode', 'colCheckIn', 'colCheckOut', 'colShiftHours', 'colActualHours', 'colStatus', 'colFlag', 'colAction'].map((k) => (
                <th key={k} className="px-3 py-2 font-medium">{a[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { code: 'E0012', name: 'Aisha Rahman', status: 'present' as const, flag: null, punches: [] },
              { code: 'E0047', name: 'Priya Nair-Subramaniam Wickramasinghe the Third of Penang', status: 'present' as const, flag: 'odd' as const, punches: [
                { punchAt: '13:00:00', direction: 'in' as const }, { punchAt: '13:02:00', direction: 'in' as const }, { punchAt: '13:05:00', direction: 'out' as const },
              ] },
              { code: 'E0058', name: 'Wei Jie Tan', status: 'absent' as const, flag: null, punches: [] },
            ].map((r) => (
              <Fragment key={r.code}>
                <tr>
                  <td className={`${stick(false)} tabular-nums`} style={STICKY[0].style}>{r.code}</td>
                  <td className={`${stick(false)} overflow-hidden`} style={STICKY[1].style} title={r.name}>
                    <span className="truncate font-medium">{r.name}</span>
                  </td>
                  <AttendanceDayCells row={base} status={r.status} flag={r.flag} labels={labels} />
                  <td className="px-3 py-2.5"><a href="#x" className="font-medium text-primary">{a.dayViewEdit}</a></td>
                </tr>
                <AttendanceTrailRow punches={r.punches} colSpan={10} labels={labels} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function mount(width: number) {
  document.body.style.margin = '0';
  document.body.style.width = `${width}px`;
  render(<Screen />);
  return { page: screen.getByTestId('page'), wrap: screen.getByTestId('wrap') };
}

for (const width of [390, 1280]) {
  describe(`Daily Attendance list at ${width}px`, () => {
    it('the page never scrolls sideways; the table scrolls inside its wrapper only when it must', () => {
      const { wrap } = mount(width);
      expect(document.body.scrollWidth, 'document does not scroll sideways').toBeLessThanOrEqual(width);
      expect(wrap.getBoundingClientRect().right).toBeLessThanOrEqual(width - 16 + 0.5);
      const table = wrap.querySelector('table')!;
      expect(table.getBoundingClientRect().width, 'table is at least the wrapper (min-w-full)').toBeGreaterThanOrEqual(
        wrap.clientWidth - 1,
      );
      if (width === 390) expect(wrap.scrollWidth, 'ten columns scroll inside the wrapper on a phone').toBeGreaterThan(wrap.clientWidth);
    });

    it('has exactly ten header cells and the trail row spans the whole table', () => {
      const { wrap } = mount(width);
      expect(wrap.querySelectorAll('thead th').length).toBe(10);
      const trail = wrap.querySelector('[data-row="trail"] td')!;
      expect(trail).toBeTruthy();
      const table = wrap.querySelector('table')!;
      expect(Math.abs(trail.getBoundingClientRect().width - table.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    });

    it('a long name is clipped inside its sticky cell and does not push the next column', () => {
      const { wrap } = mount(width);
      const nameCells = [...wrap.querySelectorAll('tbody td[title]')];
      expect(nameCells.length).toBe(3);
      for (const c of nameCells) expect(Math.round(c.getBoundingClientRect().width)).toBe(Math.round(14 * 16));
      const long = nameCells.find((c) => (c.getAttribute('title') ?? '').length > 40)!;
      expect(long.scrollWidth, 'the name overflows its cell, and the cell clips it').toBeGreaterThanOrEqual(long.clientWidth);
      expect(getComputedStyle(long).position).toBe('sticky');
    });

    it('Absent is red and Odd shows as a flag; the others are not red', () => {
      const { wrap } = mount(width);
      const status = [...wrap.querySelectorAll('td[data-col="status"] span')];
      expect(status.map((s) => s.textContent?.toLowerCase())).toEqual(['present', 'present', 'absent']);
      expect(status[2].className).toContain('rose');
      expect(status[0].className).not.toContain('rose');
      const flags = [...wrap.querySelectorAll('td[data-col="flag"]')].map((c) => c.textContent);
      expect(flags).toEqual(['—', a.flagOdd, '—']);
    });
  });
}
