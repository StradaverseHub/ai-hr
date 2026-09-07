/**
 * 420ebab5 part one — does a click on the far side of the row actually reach THAT row's destination?
 *
 * test/personnel-row-click.dom.test.tsx pins the STRUCTURE of the overlay idiom, and that is as far as
 * jsdom can go: it applies no stylesheet and computes no layout, so it cannot say whether an overlay
 * covers anything. Everything below is a claim about a hit area, so everything below is measured — real
 * Chromium, real compiled Tailwind, real `elementFromPoint`. In the BROWSER project
 * (`pnpm test:browser`), deliberately outside the default gate — see vitest.browser.config.ts for why.
 *
 * WHAT THIS FILE LEARNED THE HARD WAY, twice.
 *
 * FIRST: it renders more than one row. A draft rendered one row and hit-tested its cells; every probe
 * found the link, and it still found the link after the positioning was stripped. An overlay with no
 * positioned ancestor does not vanish — it stretches to the initial containing block, i.e. the whole
 * page, covering the row under test and everything else besides. A single-row fixture is structurally
 * blind to the worse bug. So the fixture is three rows inside a `relative` wrapper standing in for
 * `<main className="relative …">` in app/layout.tsx, with a paragraph below the table: the escape route
 * an unpinned overlay would actually take in this app, so a leak has somewhere to be caught.
 *
 * SECOND, and this is the one that matters: THE ENGINE THIS RUNS IN IS NOT THE ENGINE THAT BREAKS. The
 * first shape of this change made the `<tr>` the positioning context, and Chromium honours that happily —
 * eight green assertions here said so. WebKit does not: `position: relative` on a table row computes as
 * `static` (bug 240961, fixed on trunk only in April 2026 — after the newest Safari this machine can
 * run — and every browser on iOS is WebKit). That is measured, on the real row markup in this machine's
 * own WebKit; app/admin/personnel/row-link.tsx records what was probed and what each probe answered.
 * So the last case here re-runs every confinement probe with the rows forced to `position: static`,
 * which is the shape WebKit hands us whatever the stylesheet says. Nothing in the row may depend on a
 * row being a containing block, and that case is what proves it. A Chromium pass alone would not have.
 *
 * The rows are rendered to static markup rather than mounted through React, because `next/link` wants an
 * app-router context that none of this needs: what is under test is the anchor a browser lays out, and
 * renderToStaticMarkup emits exactly that.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { EmployeeRow, employeeRowHref, type EmployeeRowProps } from '../app/admin/personnel/employee-row';
import { DraftRow, draftRowHref, type DraftRowProps } from '../app/admin/personnel/draft-row';
import type { EmployeeColumnKey } from '../lib/employee-columns';
import '../app/globals.css';

// THREE columns and short values on purpose. Vitest's browser project runs in a small default viewport,
// and `document.elementFromPoint` answers null for anything outside it — a probe that fell off the right
// edge would read exactly like a dead zone, and this file would be lying in the reassuring direction.
// Employee ID, Full Name and Status are the three the plan names anyway.
const COLUMNS: EmployeeColumnKey[] = ['code', 'name', 'status'];

const ROW_ONE = '11111111-2222-3333-4444-555555555555';
const ROW_TWO = '99999999-8888-7777-6666-555555555555';
const DRAFT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Row 0 is a draft, rows 1 and 2 are employees — the listing's own order. */
const HREFS = [draftRowHref(DRAFT), employeeRowHref(ROW_ONE), employeeRowHref(ROW_TWO)];

const employee = (employmentId: string, name: string, code: string): EmployeeRowProps => ({
  employmentId,
  name,
  email: 'someone@demo.local',
  employeeCode: code,
  status: 'active',
  statusLabel: 'Active',
  columns: COLUMNS,
  text: { code, name, status: 'Active' },
});

const draft: DraftRowProps = {
  draftId: DRAFT,
  label: 'Siti',
  avatarName: 'Siti',
  subtitle: '3 needed',
  reservedEmployeeCode: 'EMP-0102',
  companyName: 'Acme',
  statusLabel: 'Draft',
  columns: COLUMNS,
};

/** Narrow enough to sit inside the browser project's viewport whole, so no probe can fall off it. */
const ROW_WIDTH_PX = 320;

let host: HTMLElement | null = null;

type Mounted = {
  rows: HTMLTableRowElement[];
  cellsOf: (i: number) => HTMLTableCellElement[];
  below: HTMLElement;
  wrapper: HTMLElement;
};

/** The listing's own shape, minimised: a positioned wrapper (the escape route), three rows, a paragraph. */
function mount(): Mounted {
  host = document.createElement('div');
  host.style.width = `${ROW_WIDTH_PX}px`;
  host.innerHTML = renderToStaticMarkup(
    createElement(
      'div',
      { className: 'relative py-4', id: 'wrapper' },
      createElement(
        'table',
        { className: 'w-full text-sm' },
        createElement(
          'tbody',
          null,
          createElement(DraftRow, { key: 'd', ...draft }),
          createElement(EmployeeRow, { key: 'a', ...employee(ROW_ONE, 'Aisha Rahman', 'EMP-0008') }),
          createElement(EmployeeRow, { key: 'b', ...employee(ROW_TWO, 'Bala Krishnan', 'EMP-0081') }),
        ),
      ),
      createElement('p', { id: 'below', className: 'p-4' }, 'not part of any row'),
    ),
  );
  document.body.appendChild(host);
  const rows = [...host.querySelectorAll('tr')] as HTMLTableRowElement[];
  return {
    rows,
    cellsOf: (i) => [...rows[i].querySelectorAll('td')] as HTMLTableCellElement[],
    below: host.querySelector('#below') as HTMLElement,
    wrapper: host.querySelector('#wrapper') as HTMLElement,
  };
}

/** Where a click at this point would go: the href of the link under it, or null for no link at all.
 *  Refuses to answer for a point outside the viewport, where `elementFromPoint` returns null for a reason
 *  that has nothing to do with the row. */
function hrefAt(x: number, y: number): string | null {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  if (x < 0 || y < 0 || x > w || y > h) {
    throw new Error(`probe (${Math.round(x)}, ${Math.round(y)}) is outside the ${w}x${h} viewport`);
  }
  return document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href') ?? null;
}

/** A point inside an element, given as fractions of its box. */
function at(el: Element, fx: number, fy: number): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + fx * r.width, r.top + fy * r.height];
}

const centre = (el: Element): [number, number] => at(el, 0.5, 0.5);

/** Every claim about coverage and confinement, run over the whole fixture. Called twice: as the browser
 *  lays the rows out, and again with the rows forced static the way WebKit forces them. */
function expectEveryRowConfined(m: Mounted) {
  for (const [i, href] of HREFS.entries()) {
    const cells = m.cellsOf(i);
    expect(cells).toHaveLength(COLUMNS.length);
    for (const [c, key] of COLUMNS.entries()) {
      expect(hrefAt(...centre(cells[c])), `row ${i}: the ${key} cell went somewhere else`).toBe(href);
    }
    // The SHORT cell, top and bottom. The name cell is two lines tall and sets the row's height; a
    // containing block that was the cell's CONTENT rather than the cell would leave dead bands here.
    const code = cells[COLUMNS.indexOf('code')];
    expect(hrefAt(...at(code, 0.5, 0.08)), `row ${i}: dead band above the Employee ID`).toBe(href);
    expect(hrefAt(...at(code, 0.5, 0.92)), `row ${i}: dead band below the Employee ID`).toBe(href);
    // The last pixels of the row, past the final cell's text — the part a link around the text misses.
    const r = m.rows[i].getBoundingClientRect();
    expect(hrefAt(r.right - 2, r.top + r.height / 2), `row ${i}: the far right edge is dead`).toBe(href);
  }
  // …and nothing outside the table belongs to any row. This is where a leaked overlay is caught: it
  // would answer with the LAST row's href for every point on the page.
  expect(hrefAt(...centre(m.below)), 'the space below the table belongs to a row').toBeNull();
  expect(hrefAt(...at(m.wrapper, 0.5, 0.01)), 'the top of the content area belongs to a row').toBeNull();
}

beforeAll(() => {
  document.body.style.margin = '0';
});

afterEach(() => {
  host?.remove();
  host = null;
});

describe('420ebab5 · the personnel rows, hit-tested in a real engine', () => {
  it('the stylesheet reached the page (guards the harness, not the product)', () => {
    // Without this, every assertion below could pass or fail for reasons that have nothing to do with the
    // row: an uncompiled stylesheet leaves the positioning and the overlays as inert class names.
    const probe = document.createElement('div');
    probe.className = 'w-28';
    document.body.appendChild(probe);
    expect(Number.parseFloat(getComputedStyle(probe).width)).toBeCloseTo(112, 0);
    probe.remove();
  });

  it('the CELL is the containing block — and the ROW is deliberately not one', () => {
    const { rows, cellsOf } = mount();
    for (const [i] of HREFS.entries()) {
      for (const td of cellsOf(i)) expect(getComputedStyle(td).position).toBe('relative');
      // THE WEBKIT INVARIANT. Chromium would honour `relative` here, which is exactly why it has to be
      // asserted rather than trusted: Safari would not, and the overlays would escape to <main>.
      expect(getComputedStyle(rows[i]).position, `row ${i} declares its own positioning`).toBe('static');
      // …and the row has real height, so "covers the row" is a claim about something.
      expect(rows[i].getBoundingClientRect().height).toBeGreaterThan(20);
    }
  });

  it('the name link paints an absolutely positioned overlay with a box to click', () => {
    const { cellsOf } = mount();
    const nameLink = cellsOf(1)[COLUMNS.indexOf('name')].querySelector('a')!;
    const after = getComputedStyle(nameLink, '::after');
    expect(after.position).toBe('absolute');
    // Without a content value the pseudo-element generates no box at all, and nothing is clickable.
    expect(after.content).toBe('""');
  });

  it('the silent overlays are anchors a browser can open, not decoration', () => {
    const { cellsOf } = mount();
    const overlay = cellsOf(1)[COLUMNS.indexOf('status')].querySelector('a')!;
    // A real href is what makes middle-click and ⌘-click open a tab; the row would still "work" for a
    // plain click without one, and quietly stop being a link.
    expect(overlay.getAttribute('href')).toBe(employeeRowHref(ROW_ONE));
    const box = overlay.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(20);
    expect(box.height).toBeGreaterThan(20);
  });

  it('every cell of every row opens THAT row, and the space around them opens nothing', () => {
    expectEveryRowConfined(mount());
  });

  it('and it still holds with the rows forced static — the shape WebKit gives a <tr>', () => {
    // THE CASE THIS FILE EXISTS FOR. WebKit computes a row's position as `static` however the stylesheet
    // declares it, so this reproduces that engine's shape here. Under the previous design every probe
    // below would answer with the LAST row's href — including the paragraph under the table — because the
    // overlay would resolve to the positioned wrapper standing in for <main>.
    const m = mount();
    for (const row of m.rows) row.style.position = 'static';
    for (const row of m.rows) expect(getComputedStyle(row).position).toBe('static');
    expectEveryRowConfined(m);
  });

  it('the draft row at the top is as clickable as the employees, and goes somewhere else', () => {
    // The reported defect survived on these rows when they were left out: same tint, same look, and only
    // the name opened anything — directly above rows that behaved the opposite way.
    const { cellsOf } = mount();
    const cells = cellsOf(0);
    expect(hrefAt(...centre(cells[COLUMNS.indexOf('status')]))).toBe(draftRowHref(DRAFT));
    expect(hrefAt(...centre(cells[COLUMNS.indexOf('code')]))).toBe(draftRowHref(DRAFT));
    // …and it is NOT an employee profile: a draft has none yet.
    expect(draftRowHref(DRAFT)).not.toContain('?from=personnel');
  });
});
