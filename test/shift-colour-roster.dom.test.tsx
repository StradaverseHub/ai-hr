/**
 * 6340aecb request point 7 — the shift's colour has to reach the DUTY ROSTER, and a shift with NO colour
 * has to look exactly as it does today.
 *
 * THE HALF THAT A SOURCE GREP COULD NOT PROVE is the second one. components/roster-grid.tsx has always
 * tinted a shift cell from a rotating six-entry palette keyed on the shift's POSITION in the list. Adding
 * a per-shift colour on top of that is one `??` away from replacing the automatic palette for everybody —
 * a change nobody asked for, on a screen every supervisor reads — and the resulting code still compiles,
 * still passes tsc and still returns 200. So this renders the real grid in jsdom and reads the classes off
 * two cells: a coloured shift and an uncoloured one, side by side in one month.
 *
 * Scope note, inherited from roster-month-grid.dom.test.tsx: jsdom applies no CSS and computes no layout,
 * so this catches which classes are chosen, not how they paint.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { RosterGrid, type GridEmployee, type ShiftLite } from '../components/roster-grid';
import { cellKey, monthDates, type AssignedCell } from '../lib/roster-month';
import { SHIFT_COLORS } from '../lib/shift-visual';

vi.mock('../app/roster/actions', () => ({
  assignCellAction: async () => ({ ok: true as const }),
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

/** Position 0 in the list — so its AUTOMATIC colour would be the first palette entry (indigo). Giving it
 *  the RED token is what makes the first assertion below able to fail: an implementation that ignored the
 *  stored colour would still paint this cell indigo. */
const RED_SHIFT: ShiftLite = {
  id: 'sh-red',
  code: 'RED',
  name: 'Coloured shift',
  startTime: '08:00:00',
  endTime: '17:00:00',
  color: 'red',
};
/** Position 1 — no colour, so it must keep the SECOND automatic palette entry, exactly as today. */
const PLAIN_SHIFT: ShiftLite = {
  id: 'sh-plain',
  code: 'PLN',
  name: 'Uncoloured shift',
  startTime: '09:00:00',
  endTime: '18:00:00',
  color: null,
};
const AUTO_SECOND = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300';

const EMPLOYEES: GridEmployee[] = [
  { employmentId: 'e1', name: 'Ahmad Zulkifli', code: 'A0001', department: 'Site Operations', occupation: 'EXECUTIVE' },
];

function renderGrid(initial: Record<string, AssignedCell>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RosterGrid
        dates={DATES.map((iso) => ({ iso, dow: 'Mon', day: iso.slice(8) }))}
        employees={EMPLOYEES}
        shifts={[RED_SHIFT, PLAIN_SHIFT]}
        initial={initial}
        usual={{}}
        isAdmin
        today={TODAY}
        companyName="ISEDECOR BINA SDN BHD"
      />
    </NextIntlClientProvider>,
  );
}

/** The cell control printing this code inside the month grid (the legend chips are not in a row). */
const cellWithCode = (code: string) =>
  screen.getAllByText(code).find((el) => el.closest('tr') != null) as HTMLElement;

describe('6340aecb — the shift colour on the Duty Roster', () => {
  it('paints a coloured shift’s cell with ITS colour, not the automatic position palette', () => {
    renderGrid({ [cellKey('e1', '2026-08-03')]: { kind: 'shift', shiftId: 'sh-red' } });
    const cell = cellWithCode('RED');
    expect(cell.className).toContain(SHIFT_COLORS.red);
    // The automatic first-position colour must NOT be what it got.
    expect(cell.className).not.toContain('bg-indigo-100');
  });

  it('leaves an UNCOLOURED shift on the automatic palette — today’s exact appearance', () => {
    renderGrid({ [cellKey('e1', '2026-08-04')]: { kind: 'shift', shiftId: 'sh-plain' } });
    const cell = cellWithCode('PLN');
    expect(cell.className).toContain(AUTO_SECOND);
  });

  it('the legend chip carries the same colour as the cell, so the key and the grid agree', () => {
    const { container } = renderGrid({});
    const chips = Array.from(container.querySelectorAll('button')).filter((el) => el.textContent?.startsWith('RED'));
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].className).toContain(SHIFT_COLORS.red);
  });
});
