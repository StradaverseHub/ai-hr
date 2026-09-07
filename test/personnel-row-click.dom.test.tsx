/**
 * 420ebab5 part one — the employee row is the link, RENDERED.
 *
 * The reported defect was not "the row is missing a feature": the row already highlighted under the
 * pointer, so it ANNOUNCED itself as clickable and then did nothing, and only the person's name opened
 * anything. So the thing worth pinning is the rendered markup — what a browser would actually hand a
 * click to — not a class string in a source file.
 *
 * The listing itself cannot be rendered here: app/admin/personnel/page.tsx is an async server component
 * that reads the database before it emits a row. The row is therefore its own component, and this file
 * renders THAT, inside a real <table> so the <tr> is a legal child (the precedent is
 * test/organization-companies-reachable.test.ts, which renders its rows the same way; next/link resolves
 * to a plain <a> under renderToStaticMarkup, which is exactly the element under test).
 *
 * WHAT jsdom CANNOT SAY. There is no layout and no CSS here, so no assertion below claims to have
 * measured a hit area — test/personnel-row-click.browser.test.tsx does that in real Chromium. What it can do — and what a source scan of one file cannot — is check the two
 * STRUCTURAL conditions the stretched-link idiom actually depends on, which is where it silently breaks:
 *   1. the overlay's containing block is the ROW, so nothing between the anchor and the <tr> may be
 *      positioned — an ancestor with `relative` shrinks the overlay to that element and the rest of the
 *      row goes quietly back to being dead;
 *   2. nothing else in the row is positioned either — a positioned sibling paints ABOVE the overlay and
 *      becomes a dead zone in the middle of a row that looks uniformly clickable. The plan names the two
 *      cells this would be worst for, Employee ID and Status, so both are asserted by name.
 *
 * And the last case is the "nothing that works today stops working" half: the name is still the link,
 * still an anchor, still keyboard-focusable, still resolving to the same href it did before.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EmployeeRow,
  employeeRowHref,
  type EmployeeRowProps,
} from '../app/admin/personnel/employee-row';
import type { EmployeeColumnKey } from '../lib/employee-columns';

// jsdom rewrites `import.meta.url` to a non-file URL, so the usual `new URL('..', import.meta.url)`
// idiom this repo's node tests use throws here. Vitest's cwd is the project root, which is the same
// place — see vitest.config.ts, where the `dom` project inherits the root `resolve`.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const EMPLOYMENT_ID = '11111111-2222-3333-4444-555555555555';

const COLUMNS: EmployeeColumnKey[] = ['code', 'name', 'company', 'department', 'position', 'status'];

const PROPS: EmployeeRowProps = {
  employmentId: EMPLOYMENT_ID,
  name: 'Aisha Rahman',
  email: 'aisha@demo.local',
  employeeCode: 'EMP-0008',
  status: 'active',
  statusLabel: 'Active',
  columns: COLUMNS,
  text: {
    code: 'EMP-0008',
    name: 'Aisha Rahman',
    company: 'Acme Sdn Bhd',
    department: 'Finance',
    position: 'Manager',
    status: 'Active',
  },
};

/** Render one row inside a real table and hand back the live DOM for it. */
function renderRow(overrides: Partial<EmployeeRowProps> = {}) {
  const html = renderToStaticMarkup(
    createElement(
      'table',
      null,
      createElement('tbody', null, createElement(EmployeeRow, { ...PROPS, ...overrides })),
    ),
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  const tr = host.querySelector('tr');
  if (!tr) throw new Error('the row did not render');
  return { host, tr, cells: [...tr.querySelectorAll('td')] };
}

/** Tailwind's positioning utilities as EXACT class tokens. `after:absolute` is a different token and is
 *  deliberately NOT matched — that one is the overlay itself, not an element in the row's own flow. */
const POSITIONED = new Set(['relative', 'absolute', 'fixed', 'sticky']);
const isPositioned = (el: Element) =>
  (el.getAttribute('class') ?? '').split(/\s+/).some((c) => POSITIONED.has(c));

describe('420ebab5 · the whole employee row opens the employee', () => {
  it('exposes exactly ONE link, and it is the employee', () => {
    const { tr } = renderRow();
    const links = [...tr.querySelectorAll('a')];
    // One per row, not one per cell: a row that announced six links to a screen reader would be a
    // different defect traded for this one.
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(`/admin/personnel/${EMPLOYMENT_ID}?from=personnel`);
    // The href helper and the rendered row agree — the destination is spelled once.
    expect(links[0].getAttribute('href')).toBe(employeeRowHref(EMPLOYMENT_ID));
  });

  it('that link still is the name, still an anchor, still keyboard-reachable', () => {
    const { tr } = renderRow();
    const a = tr.querySelector('a')!;
    // The pre-existing behaviour, unchanged: the name is the link and its text is the accessible name.
    expect(a.textContent).toBe('Aisha Rahman');
    expect(a.tagName).toBe('A');
    // A real href is what makes it focusable, middle-clickable and ⌘-clickable; a tabindex of -1 would
    // take the keyboard away again, which is the reason a bare onClick on the row was refused.
    expect(a.getAttribute('href')).toBeTruthy();
    expect(a.getAttribute('tabindex')).toBeNull();
  });

  it('the row is the positioning context and the link stretches across it', () => {
    const { tr } = renderRow();
    const rowCls = tr.getAttribute('class') ?? '';
    const linkCls = tr.querySelector('a')!.getAttribute('class') ?? '';
    // The two halves of the idiom. Either one alone is inert: `relative` with no overlay changes nothing,
    // and an overlay with no positioned row stretches to whatever ancestor happens to be positioned.
    expect(rowCls.split(/\s+/)).toContain('relative');
    expect(linkCls).toContain('after:absolute');
    expect(linkCls).toContain('after:inset-0');
    // The overlay must be on the ANCHOR — an overlay painted by any other element is not a link.
    expect(tr.querySelector('a')!.getAttribute('class')).toContain('after:inset-0');
  });

  it('the pointer says so too — the hover tint is no longer the only signal', () => {
    const { tr } = renderRow();
    const cls = (tr.getAttribute('class') ?? '').split(/\s+/);
    expect(cls).toContain('cursor-pointer');
    // The tint that made the row look clickable in the first place is kept, not removed.
    expect(cls).toContain('hover:bg-muted/40');
  });

  it('nothing between the anchor and the row is positioned (or the overlay shrinks to it)', () => {
    const { tr } = renderRow();
    const a = tr.querySelector('a')!;
    const offenders: string[] = [];
    for (let el = a.parentElement; el && el !== tr; el = el.parentElement) {
      if (isPositioned(el)) offenders.push(`${el.tagName}.${el.getAttribute('class')}`);
    }
    expect(offenders, 'an ancestor of the row link declares its own positioning').toEqual([]);
  });

  it('no cell content paints above the overlay — Employee ID and Status are not dead zones', () => {
    const { tr, cells } = renderRow();
    // Every element in the row's own flow, the anchor included. A positioned one would sit above the
    // transparent overlay and swallow the click for that patch of the row.
    const offenders = [...tr.querySelectorAll('*')]
      .filter((el) => isPositioned(el))
      .map((el) => `${el.tagName}.${el.getAttribute('class')}`);
    expect(offenders, 'something inside the row would paint above the row link').toEqual([]);

    // …and the two cells the plan names are still rendering their content, inside that same row.
    const code = cells[COLUMNS.indexOf('code')];
    const status = cells[COLUMNS.indexOf('status')];
    expect(code.textContent).toBe('EMP-0008');
    expect(status.textContent).toBe('Active');
    expect(tr.contains(code)).toBe(true);
    expect(tr.contains(status)).toBe(true);
  });

  it('renders one cell per chosen column, with the text the export prints', () => {
    const { cells } = renderRow();
    expect(cells).toHaveLength(COLUMNS.length);
    expect(cells.map((td) => td.textContent)).toEqual([
      'EMP-0008',
      'ARAisha Rahmanaisha@demo.local', // initials avatar + name link + email, as before
      'Acme Sdn Bhd',
      'Finance',
      'Manager',
      'Active',
    ]);
  });

  it('a column with no value shows an em dash rather than an empty cell', () => {
    const { cells } = renderRow({
      columns: ['name', 'jobGrade'],
      text: { name: 'Aisha Rahman', jobGrade: null },
    });
    expect(cells[1].textContent).toBe('—');
  });
});

describe('420ebab5 · the listing renders that row, and nothing else', () => {
  const LISTING = read('app/admin/personnel/page.tsx');

  it('the employee rows come from <EmployeeRow>, not from a hand-built <tr>', () => {
    expect(LISTING).toContain("import { EmployeeRow } from './employee-row';");
    // The component is what `employees.map` returns — re-inlining a row here is what this catches.
    expect(LISTING).toMatch(/employees\.map\(\(e\) => \{[\s\S]{0,800}<EmployeeRow/);
  });

  it('the page still resolves the status, the labels and the column text itself', () => {
    // The row holds no translator and no clock: if these move into the component, the table and the
    // Excel export stop sharing one projection.
    expect(LISTING).toContain('const st = deriveEmploymentStatus(e, today);');
    expect(LISTING).toContain('statusLabel={tStatus(st)}');
    expect(LISTING).toContain('text[key] = textCell(e, key);');
  });

  it('the draft rows above the employees are untouched by this change', () => {
    // The plan fences them off: a draft row links to the continue-the-draft form, not to a profile that
    // does not exist yet, so it is NOT a clickable-employee row.
    expect(LISTING).toContain('/admin/personnel/new?draft=${d.id}');
    expect(LISTING).toContain('<StatusBadge status="draft"');
  });
});
