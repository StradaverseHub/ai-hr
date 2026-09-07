/**
 * 420ebab5 part one — does a click on the far side of the row actually reach THAT employee?
 *
 * test/personnel-row-click.dom.test.tsx pins the STRUCTURE of the stretched link, and that is as far as
 * jsdom can go: it applies no stylesheet and computes no layout, so it cannot say whether the overlay
 * covers anything. The whole fix rests on one CSS fact a source scan cannot settle — `position: relative`
 * on a `<tr>` making the ROW the containing block for the link's `::after`. Browsers ignored that for
 * years (CSS 2.1 left it undefined), so it is worth measuring rather than assuming.
 *
 * WHAT THIS FILE LEARNED THE HARD WAY, and why it renders TWO rows. A first draft rendered one row and
 * hit-tested its cells; every probe found the link, and it still found the link after `relative` was
 * stripped from the row. An overlay with no positioned ancestor does not vanish — it stretches to the
 * INITIAL containing block, i.e. the whole page, so it covers the one row under test and everything else
 * besides. That is a far worse bug than the one being fixed (every click anywhere opens one employee) and
 * a single-row fixture is structurally blind to it.
 *
 * So the assertions here are about CONFINEMENT as much as coverage: row one's link answers everywhere in
 * row one and NOWHERE in row two, row two's link answers in row two, and the space below the table
 * belongs to neither. All three fail the moment the overlay is not pinned to its own row.
 *
 * Real Chromium, real Tailwind, real hit-testing. In the BROWSER project (`pnpm test:browser`),
 * deliberately outside the default gate — see vitest.browser.config.ts for why.
 *
 * The rows are rendered to static markup rather than mounted through React, because `next/link` wants an
 * app-router context that none of this needs: what is under test is the anchor a browser lays out, and
 * renderToStaticMarkup emits exactly that.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EmployeeRow, type EmployeeRowProps } from '../app/admin/personnel/employee-row';
import type { EmployeeColumnKey } from '../lib/employee-columns';
import '../app/globals.css';

// THREE columns and short values on purpose. Vitest's browser project runs in a small default viewport,
// and `document.elementFromPoint` answers null for anything outside it — a probe that fell off the right
// edge would read exactly like a dead zone, and this file would be lying in the reassuring direction.
// Employee ID, Full Name and Status are the three the plan names anyway.
const COLUMNS: EmployeeColumnKey[] = ['code', 'name', 'status'];

const ROW_ONE = '11111111-2222-3333-4444-555555555555';
const ROW_TWO = '99999999-8888-7777-6666-555555555555';

const row = (employmentId: string, name: string, code: string): EmployeeRowProps => ({
  employmentId,
  name,
  email: 'someone@demo.local',
  employeeCode: code,
  status: 'active',
  statusLabel: 'Active',
  columns: COLUMNS,
  text: { code, name, status: 'Active' },
});

/** Narrow enough to sit inside the browser project's viewport whole, so no probe can fall off it. */
const ROW_WIDTH_PX = 320;

let host: HTMLElement | null = null;

type Mounted = {
  rows: HTMLTableRowElement[];
  links: HTMLAnchorElement[];
  cellsOf: (i: number) => HTMLTableCellElement[];
  below: HTMLElement;
};

/** Two employee rows in one table, plus a marker block under it — the listing's own shape, minimised. */
function mount(): Mounted {
  host = document.createElement('div');
  host.style.width = `${ROW_WIDTH_PX}px`;
  host.innerHTML = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(
        'table',
        { className: 'w-full text-sm' },
        createElement(
          'tbody',
          null,
          createElement(EmployeeRow, { key: 'a', ...row(ROW_ONE, 'Aisha Rahman', 'EMP-0008') }),
          createElement(EmployeeRow, { key: 'b', ...row(ROW_TWO, 'Bala Krishnan', 'EMP-0081') }),
        ),
      ),
      createElement('p', { id: 'below', className: 'p-4' }, 'not part of any row'),
    ),
  );
  document.body.appendChild(host);
  const rows = [...host.querySelectorAll('tr')] as HTMLTableRowElement[];
  return {
    rows,
    links: [...host.querySelectorAll('a')] as HTMLAnchorElement[],
    cellsOf: (i) => [...rows[i].querySelectorAll('td')] as HTMLTableCellElement[],
    below: host.querySelector('#below') as HTMLElement,
  };
}

/** What a click at this point would hit. Refuses to answer for a point outside the viewport, where
 *  `elementFromPoint` returns null for a reason that has nothing to do with the row. */
function hit(x: number, y: number): Element | null {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  if (x < 0 || y < 0 || x > w || y > h) {
    throw new Error(`probe (${Math.round(x)}, ${Math.round(y)}) is outside the ${w}x${h} viewport`);
  }
  return document.elementFromPoint(x, y);
}

/** The middle of an element, in viewport coordinates. */
function centre(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

beforeAll(() => {
  document.body.style.margin = '0';
});

afterEach(() => {
  host?.remove();
  host = null;
});

describe('420ebab5 · the employee row, hit-tested in a real engine', () => {
  it('the stylesheet reached the page (guards the harness, not the product)', () => {
    // Without this, every assertion below could pass or fail for reasons that have nothing to do with the
    // row: an uncompiled stylesheet leaves `relative` and the overlay as inert class names.
    const probe = document.createElement('div');
    probe.className = 'w-28';
    document.body.appendChild(probe);
    expect(Number.parseFloat(getComputedStyle(probe).width)).toBeCloseTo(112, 0);
    probe.remove();
  });

  it('the ROW is the containing block — `position: relative` on a <tr> is honoured', () => {
    const { rows } = mount();
    expect(getComputedStyle(rows[0]).position).toBe('relative');
    // …and the row has real height, so "covers the row" is a claim about something.
    expect(rows[0].getBoundingClientRect().height).toBeGreaterThan(20);
  });

  it('the link paints an absolutely positioned overlay with a box to click', () => {
    const { links } = mount();
    const after = getComputedStyle(links[0], '::after');
    expect(after.position).toBe('absolute');
    // Without a content value the pseudo-element generates no box at all, and nothing is clickable.
    expect(after.content).toBe('""');
  });

  it('a click on the Employee ID cell or the Status chip opens THAT employee', () => {
    const { links, cellsOf } = mount();
    const cells = cellsOf(0);
    expect(hit(...centre(cells[COLUMNS.indexOf('code')]))).toBe(links[0]);
    expect(hit(...centre(cells[COLUMNS.indexOf('status')]))).toBe(links[0]);
  });

  it('so does every cell of the row, and its far right edge', () => {
    const { rows, links, cellsOf } = mount();
    const cells = cellsOf(0);
    for (const key of COLUMNS) {
      expect(hit(...centre(cells[COLUMNS.indexOf(key)])), `the ${key} cell is a dead zone`).toBe(links[0]);
    }
    // The last pixels of the row, past the final cell's text — the part a per-cell link would miss.
    const r = rows[0].getBoundingClientRect();
    expect(hit(r.right - 2, r.top + r.height / 2)).toBe(links[0]);
  });

  it('the overlay reaches past the name cell, which is all that used to be clickable', () => {
    const { rows, links, cellsOf } = mount();
    const rowRect = rows[0].getBoundingClientRect();
    const nameRect = cellsOf(0)[COLUMNS.indexOf('name')].getBoundingClientRect();
    // There IS a right-hand end beyond the name cell — otherwise the probe below proves nothing.
    expect(rowRect.right - nameRect.right).toBeGreaterThan(20);
    const x = nameRect.right + (rowRect.right - nameRect.right) / 2;
    expect(hit(x, rowRect.top + rowRect.height / 2)).toBe(links[0]);
  });

  it('EACH overlay is confined to its OWN row — the second employee is not the first', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. An overlay that is not pinned to its row stretches to the page
    // and the last one painted answers for everything, so every click anywhere opens one employee. Two
    // rows is the smallest fixture that can see it; one row cannot.
    const { links, cellsOf } = mount();
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toContain(ROW_ONE);
    expect(links[1].getAttribute('href')).toContain(ROW_TWO);

    expect(hit(...centre(cellsOf(0)[COLUMNS.indexOf('status')])), 'row 1 opened the wrong employee').toBe(
      links[0],
    );
    expect(hit(...centre(cellsOf(1)[COLUMNS.indexOf('status')])), 'row 2 opened the wrong employee').toBe(
      links[1],
    );
    expect(hit(...centre(cellsOf(1)[COLUMNS.indexOf('code')]))).toBe(links[1]);
  });

  it('and it stops at the table — the space below belongs to nobody', () => {
    const { links, below } = mount();
    const under = hit(...centre(below));
    expect(under).not.toBe(links[0]);
    expect(under).not.toBe(links[1]);
    expect(under?.closest('a')).toBeNull();
  });
});
