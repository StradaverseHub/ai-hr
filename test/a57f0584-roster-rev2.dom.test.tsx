/**
 * a57f0584 rev 2 — THE FROZEN COLUMNS, MEASURED ON THE RENDERED GRID.
 *
 * THE FAULT. The reporter saw the pinned columns of the Duty Roster painting on top of each other while
 * scrolling sideways, and it changed with the window size. It was not a scrolling bug. `pinnedLayout`
 * handed out TWO different geometries: `sty(k)` — left + width + minWidth, NO maxWidth — and
 * `styTrunc(k)`, which added the maxWidth. Every `<th>` took the first; only some `<td>`s took the
 * second. The table is `border-collapse` with no `table-layout`, so a heading wider than its declared
 * width GROWS the column, while every sticky `left` after it is still the PINNED_W running sum — and the
 * columns land on top of one another. Same family as f728826a (r322): an offset derived from a width
 * that nothing enforces.
 *
 * WHY THESE ASSERTIONS AND NOT A SOURCE GREP. jsdom applies no CSS and computes no layout, so it cannot
 * be asked whether two columns overlap on screen. What it CAN be asked — and what a grep cannot — is
 * what geometry each rendered cell actually carries, heading and body alike, after every conditional
 * branch in the component has run. That is the property that failed: not "does the source mention
 * maxWidth" but "does the heading of column N carry the same three numbers its body does". A source grep
 * for `styTrunc` would have passed on the broken code, because `styTrunc` was there — on the wrong half.
 *
 * NON-VACUITY, checked by hand and recorded here: with the pinned `<th>`s put back on a maxWidth-less
 * accessor, "every pinned cell is held to its declared width" fails on the first heading it reaches.
 *
 * Scope note, inherited from roster-month-grid.dom.test.tsx: this catches the geometry the component
 * DECLARES. Whether a browser then honours it is the `table-layout: fixed` + `<colgroup>` half, asserted
 * on the source below because jsdom has no layout to measure it with.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { RosterGrid, type GridEmployee, type ShiftLite } from '../components/roster-grid';
import { cellKey, monthDates, type AssignedCell } from '../lib/roster-month';

vi.mock('../app/roster/actions', () => ({
  assignCellAction: async () => ({ ok: true as const }),
  bulkAssignAction: async () => ({ ok: true as const }),
  rowAssignAction: async () => ({ ok: true as const }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

/** The component's CODE with its comments stripped — the same `src` helper the other source-pinning
 *  files use. Stripped because this file's fix is DESCRIBED at length in that header, and an assertion
 *  that "styTrunc does not appear" must be about what the component does, not about what it explains. */
const GRID_SRC = readFileSync(join(__dirname, '..', 'components', 'roster-grid.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const MONTH = '2026-08';
const DATES = monthDates(MONTH);
const TODAY = '2026-08-09';

const SHIFTS: ShiftLite[] = [
  { id: 'sh-mb28', code: 'MB28', name: 'WITH 0.5 OT HOUR ADJ - MORNING FULL (0800 - 1700)', startTime: '08:00:00', endTime: '17:00:00' },
];

/**
 * A NAME AND AN OCCUPATION LONGER THAN THEIR COLUMNS, on purpose. Real production rows look like this,
 * and a fixture of short tidy strings is how a width nothing enforces passes every test ever written
 * for it: nothing is ever wide enough to make the column grow.
 */
const EMPLOYEES: GridEmployee[] = [
  { employmentId: 'e1', name: 'Nur Aisyah binti Mohd Zulkarnain Abdullah', code: 'ISB-00012345', occupation: 'SENIOR EXECUTIVE — GROUP SHARED SERVICES' },
  { employmentId: 'e2', name: 'Lim Wei', code: null, occupation: null },
];

function renderGrid(over?: { isAdmin?: boolean; initial?: Record<string, AssignedCell> }) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RosterGrid
        dates={DATES.map((iso) => ({ iso, dow: 'Mon', day: `${iso.slice(8)} Aug` }))}
        employees={EMPLOYEES}
        shifts={SHIFTS}
        initial={over?.initial ?? {}}
        usual={{}}
        isAdmin={over?.isAdmin ?? true}
        today={TODAY}
        editQuery="month=2026-08&companyId=c1"
      />
    </NextIntlClientProvider>,
  );
}

/** Every frozen cell of the grid, in document order. `sticky` is what freezes them. */
const stickyCells = (root: HTMLElement) =>
  [...root.querySelectorAll('th,td')].filter((c) => c.className.split(/\s+/).includes('sticky')) as HTMLElement[];

const px = (v: string) => Number(v.replace('px', ''));

describe('a57f0584 · the frozen columns cannot overlap', () => {
  /** THE NAMED ASSERTION. Reverting the header half of the fix fails HERE, on the first heading. */
  for (const isAdmin of [true, false]) {
    it(`every pinned cell is held to its declared width — heading and body alike (isAdmin=${isAdmin})`, () => {
      renderGrid({ isAdmin });
      const cells = stickyCells(screen.getByRole('table'));
      expect(cells.length, 'there are frozen cells to check').toBeGreaterThan(0);
      const headings = cells.filter((c) => c.tagName === 'TH');
      expect(headings.length, 'the HEADINGS are the half that was missing a maxWidth').toBeGreaterThan(0);

      for (const c of cells) {
        const where = `${c.tagName} "${(c.textContent ?? '').slice(0, 24)}"`;
        expect(c.style.width, `${where} must declare a width`).not.toBe('');
        expect(c.style.minWidth, `${where} must floor that width`).toBe(c.style.width);
        // The one that was absent on every <th>. Without it the browser grows the column to fit the
        // content and every sticky offset after it points into the middle of its neighbour.
        expect(c.style.maxWidth, `${where} must CAP that width — this is the overlap`).toBe(c.style.width);
      }
    });
  }

  it('the header half and the body half take the same geometry, column by column', () => {
    renderGrid();
    const table = screen.getByRole('table');
    const headRow = table.querySelector('thead tr') as HTMLElement;
    const bodyRow = table.querySelector('tbody tr') as HTMLElement;
    const head = stickyCells(headRow);
    const body = stickyCells(bodyRow);

    expect(head.length, 'same number of frozen columns in both halves').toBe(body.length);
    head.forEach((h, i) => {
      const b = body[i];
      expect(
        { left: b.style.left, width: b.style.width, maxWidth: b.style.maxWidth },
        `frozen column ${i} ("${h.textContent}") must sit and measure the same in both halves`,
      ).toEqual({ left: h.style.left, width: h.style.width, maxWidth: h.style.maxWidth });
    });
  });

  /**
   * THE OVERLAP ITSELF, expressed as arithmetic the way f728826a's does: column N starts exactly where
   * column N-1 ends. If any width were advisory this sum would stop describing the rendered table — and
   * the previous line is what stops a width being advisory.
   */
  it('each frozen column starts exactly where the one before it ends — no gap, no overlap', () => {
    renderGrid();
    const head = stickyCells(screen.getByRole('table').querySelector('thead tr') as HTMLElement);
    let x = 0;
    head.forEach((h, i) => {
      expect(px(h.style.left), `frozen column ${i} ("${h.textContent}") is offset by the widths before it`).toBe(x);
      x += px(h.style.width);
    });
    expect(x, 'and the block has a real width').toBeGreaterThan(0);
  });

  it('a supervisor’s narrower frozen block is placed by the same arithmetic', () => {
    renderGrid({ isAdmin: false });
    const head = stickyCells(screen.getByRole('table').querySelector('thead tr') as HTMLElement);
    expect(head.length, 'the check and Edit columns are gone, not blanked').toBe(2);
    expect(px(head[0].style.left), 'and the first column closes up to zero').toBe(0);
    expect(px(head[1].style.left)).toBe(px(head[0].style.width));
  });

  /** The half jsdom cannot measure: the declared widths must also be the USED widths. */
  it('the table declares a fixed layout and a colgroup built from the same numbers', () => {
    renderGrid();
    const table = screen.getByRole('table') as HTMLTableElement;
    expect(table.style.tableLayout, 'auto layout lets the browser grow a column to fit').toBe('fixed');
    const cols = [...table.querySelectorAll('col')] as HTMLElement[];
    expect(cols.length, 'one <col> per rendered column').toBe(4 + DATES.length);
    const head = [...(table.querySelector('thead tr') as HTMLElement).children] as HTMLElement[];
    cols.forEach((c, i) => {
      expect(c.style.width, `col ${i} must match the cell it sizes`).toBe(head[i].style.width);
    });
  });

  it('the source keeps ONE accessor, so the two halves cannot drift apart again', () => {
    // `sty` / `styTrunc` were the two halves. One `col()` that always returns all four numbers is what
    // makes "the heading took the other one" unrepresentable rather than merely fixed.
    expect(GRID_SRC, 'the maxWidth-less accessor must not come back').not.toMatch(/\bsty:\s/);
    expect(GRID_SRC).not.toMatch(/pinned\.sty\(/);
    expect(GRID_SRC).not.toMatch(/styTrunc/);
    const uses = GRID_SRC.match(/pinned\.col\(/g) ?? [];
    expect(uses.length, 'every pinned cell goes through it').toBeGreaterThanOrEqual(6);
  });
});

describe('a57f0584 · one Employee cell, and two columns gone', () => {
  it('prints the name with the employee number in brackets, in ONE cell', () => {
    renderGrid();
    const row = screen.getByText('Nur Aisyah binti Mohd Zulkarnain Abdullah').closest('tr') as HTMLElement;
    const cell = screen.getByText('Nur Aisyah binti Mohd Zulkarnain Abdullah').closest('td') as HTMLElement;
    expect(within(cell).getByText('ISB-00012345'), 'the code lives in the same cell as the name').toBeInTheDocument();
    expect(cell.textContent).toContain('(ISB-00012345)');
    // ONE frozen identity column, not two: check + employee + occupation + edit.
    expect(stickyCells(row)).toHaveLength(4);
  });

  it('a row with no employee number prints the name alone, not empty brackets', () => {
    renderGrid();
    const cell = screen.getByText('Lim Wei').closest('td') as HTMLElement;
    expect(cell.textContent).toBe('Lim Wei');
  });

  it('the Company and Department headings are gone from the grid', () => {
    renderGrid();
    expect(screen.queryByRole('columnheader', { name: messages.roster.colCompany })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: messages.roster.colDepartment })).toBeNull();
    expect(screen.getByRole('columnheader', { name: messages.roster.colEmployee })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: messages.roster.colOccupation })).toBeInTheDocument();
    // Employee No / Employee Name were the two that merged — neither heading survives on its own.
    expect(screen.queryByRole('columnheader', { name: messages.roster.colEmployeeNo })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: messages.roster.colEmployeeName })).toBeNull();
  });
});

describe('a57f0584 · Edit leaves the page instead of opening a panel on it', () => {
  it('Edit is a LINK to that employee’s own screen, carrying the month and the filters', () => {
    renderGrid();
    const row = screen.getByText('Lim Wei').closest('tr') as HTMLElement;
    const edit = within(row).getByRole('link', { name: messages.roster.colEdit });
    expect(edit).toHaveAttribute('href', '/roster/edit/e2?month=2026-08&companyId=c1');
  });

  it('clicking Edit opens nothing in place — the row editor and its confirm are gone', () => {
    renderGrid();
    const row = screen.getByText('Lim Wei').closest('tr') as HTMLElement;
    within(row).getByRole('link', { name: messages.roster.colEdit }).click();
    // The panel's own controls, which used to appear at the foot of this component.
    expect(screen.queryByText(messages.roster.selectAllDates)).toBeNull();
    expect(screen.queryByText(messages.roster.rowEditClose)).toBeNull();
    expect(GRID_SRC, 'and the row-edit confirm went with it').not.toContain("t('rowConfirm'");
  });

  it('a supervisor is offered no Edit at all', () => {
    renderGrid({ isAdmin: false });
    expect(screen.queryAllByRole('link', { name: messages.roster.colEdit })).toHaveLength(0);
  });
});
