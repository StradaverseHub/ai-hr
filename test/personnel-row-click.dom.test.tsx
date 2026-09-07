/**
 * 420ebab5 part one — the employee row is the link, RENDERED. And the DRAFT row above it too.
 *
 * The reported defect was not "the row is missing a feature": the row already highlighted under the
 * pointer, so it ANNOUNCED itself as clickable and then did nothing, and only the person's name opened
 * anything. So the thing worth pinning is the rendered markup — what a browser would actually hand a
 * click to — not a class string in a source file.
 *
 * The listing itself cannot be rendered here: app/admin/personnel/page.tsx is an async server component
 * that reads the database before it emits a row. Each row is therefore its own component, and this file
 * renders THOSE, inside a real <table> so the <tr> is a legal child (the precedent is
 * test/organization-companies-reachable.test.ts, which renders its rows the same way; next/link resolves
 * to a plain <a> under renderToStaticMarkup, which is exactly the element under test).
 *
 * WHAT jsdom CANNOT SAY. There is no layout and no CSS here, so no assertion below claims to have
 * measured a hit area — test/personnel-row-click.browser.test.tsx does that in a real engine. What it can
 * do — and what a source scan of one file cannot — is check the STRUCTURAL conditions the overlay idiom
 * depends on, which is where it breaks silently:
 *   1. the positioning context is the CELL and never the ROW. This is not a style preference: WebKit
 *      computes a table row's `position: relative` as `static` — measured, in the newest Safari
 *      engine this machine has (bug 240961) — so an overlay pinned to a row escapes to the nearest
 *      positioned ancestor, `<main>`, and paints one invisible link over the entire screen.
 *      app/admin/personnel/row-link.tsx records the measurement and its limits. Hence: every cell
 *      positioned, the row not, and nothing in between.
 *   2. every cell carries exactly one anchor to the row's destination — that is what makes the whole row
 *      clickable with no dead cell (the plan names Employee ID and Status as the two it would be worst
 *      for), and nothing else in the row may be positioned, or it would paint above an overlay and become
 *      a dead patch in a row that looks uniformly clickable.
 *   3. only ONE of those anchors reaches the keyboard and the accessibility tree: a row that announced
 *      six links to a screen reader would be a new defect traded for the old one.
 *
 * And the last cases are the "nothing that works today stops working" half: the name is still the link,
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
import { DraftRow, draftRowHref, type DraftRowProps } from '../app/admin/personnel/draft-row';
import type { EmployeeColumnKey } from '../lib/employee-columns';

// jsdom rewrites `import.meta.url` to a non-file URL, so the usual `new URL('..', import.meta.url)`
// idiom this repo's node tests use throws here. Vitest's cwd is the project root, which is the same
// place — see vitest.config.ts, where the `dom` project inherits the root `resolve`.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

const EMPLOYMENT_ID = '11111111-2222-3333-4444-555555555555';
const DRAFT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

const DRAFT_PROPS: DraftRowProps = {
  draftId: DRAFT_ID,
  label: 'Siti (draft)',
  avatarName: 'Siti (draft)',
  subtitle: '3 fields still needed',
  reservedEmployeeCode: 'EMP-0102',
  companyName: 'Acme Sdn Bhd',
  statusLabel: 'Draft',
  columns: COLUMNS,
};

type Rendered = { tr: HTMLTableRowElement; cells: HTMLTableCellElement[] };

/** Render one row inside a real table and hand back the live DOM for it. */
function renderIn(element: ReturnType<typeof createElement>): Rendered {
  const html = renderToStaticMarkup(
    createElement('table', null, createElement('tbody', null, element)),
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  const tr = host.querySelector('tr');
  if (!tr) throw new Error('the row did not render');
  return { tr, cells: [...tr.querySelectorAll('td')] };
}

const renderRow = (overrides: Partial<EmployeeRowProps> = {}) =>
  renderIn(createElement(EmployeeRow, { ...PROPS, ...overrides }));

const renderDraft = (overrides: Partial<DraftRowProps> = {}) =>
  renderIn(createElement(DraftRow, { ...DRAFT_PROPS, ...overrides }));

/** Tailwind's positioning utilities as EXACT class tokens. `after:absolute` is a different token and is
 *  deliberately NOT matched — that one is the name link's own overlay, not an element in the row's flow. */
const POSITIONED = new Set(['relative', 'absolute', 'fixed', 'sticky']);
const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);
const isPositioned = (el: Element) => classesOf(el).some((c) => POSITIONED.has(c));
const describeEl = (el: Element) => `${el.tagName}.${el.getAttribute('class')}`;

/** The row's ONE named link — not just its first anchor, which is whichever column comes first. */
const namedLink = (tr: Element) => tr.querySelector<HTMLAnchorElement>('a:not([aria-hidden="true"])')!;

/**
 * The invariants EVERY clickable row in this table shares, whoever it links to. Both row kinds are put
 * through this: a draft row that only linked from its name is the reported defect, still on screen, on
 * the FIRST rows anyone sees.
 */
function itBehavesLikeAClickableRow(what: string, render: () => Rendered, href: string) {
  describe(what, () => {
    it('every cell carries a link to the row destination — no cell is a dead zone', () => {
      const { cells } = render();
      expect(cells.length).toBe(COLUMNS.length);
      for (const [i, td] of cells.entries()) {
        const links = [...td.querySelectorAll('a')];
        expect(links.map((a) => a.getAttribute('href')), `the ${COLUMNS[i]} cell`).toEqual([href]);
      }
    });

    it('the CELL is the positioning context, and the ROW is not (WebKit drops it on a row)', () => {
      const { tr, cells } = render();
      // Every cell positioned: that is the box each overlay is pinned to.
      for (const [i, td] of cells.entries()) {
        expect(classesOf(td), `the ${COLUMNS[i]} cell is not a positioning context`).toContain('relative');
      }
      // And the row deliberately is NOT. If this ever comes back, the overlays escape the table in
      // Safari and cover the whole page — the failure app/admin/personnel/row-link.tsx measured.
      expect(
        classesOf(tr).filter((c) => POSITIONED.has(c)),
        'the row declares its own positioning, which Safari ignores and Chromium honours',
      ).toEqual([]);
    });

    it('nothing between an overlay and its cell is positioned (or the overlay shrinks to it)', () => {
      const { tr, cells } = render();
      const offenders: string[] = [];
      for (const a of tr.querySelectorAll('a')) {
        const cell = cells.find((td) => td.contains(a));
        for (let el = a.parentElement; el && el !== cell; el = el.parentElement) {
          if (isPositioned(el)) offenders.push(describeEl(el));
        }
      }
      expect(offenders, 'an ancestor of a row link declares its own positioning').toEqual([]);
    });

    it('nothing else in the row paints above the overlays — Employee ID and Status stay clickable', () => {
      const { tr, cells } = render();
      // Every element in the row's own flow except the cells (positioned on purpose, above) and the
      // anchors (the overlays themselves). A positioned one would sit above a transparent overlay and
      // swallow the click for that patch of the row.
      const offenders = [...tr.querySelectorAll('*')]
        .filter((el) => el.tagName !== 'TD' && el.tagName !== 'A' && isPositioned(el))
        .map(describeEl);
      expect(offenders, 'something inside the row would paint above a row link').toEqual([]);

      // …and the two cells the plan names by name are still rendering their own content.
      expect(cells[COLUMNS.indexOf('code')].textContent).not.toBe('');
      expect(cells[COLUMNS.indexOf('status')].textContent).not.toBe('');
    });

    it('exposes exactly ONE link to the keyboard and to assistive technology', () => {
      const { tr } = render();
      const announced = [...tr.querySelectorAll('a')].filter(
        (a) => a.getAttribute('aria-hidden') !== 'true',
      );
      // One per row, not one per cell: a row that announced six links to a screen reader would be a
      // different defect traded for this one.
      expect(announced).toHaveLength(1);
      expect(announced[0].getAttribute('href')).toBe(href);
      // A real href is what makes it focusable, middle-clickable and ⌘-clickable; a tabindex of -1 would
      // take the keyboard away again, which is the reason a bare onClick on the row was refused.
      expect(announced[0].getAttribute('tabindex')).toBeNull();
      // …and every silent overlay is out of the tab order, so a row is ONE stop, not six.
      for (const a of tr.querySelectorAll('a[aria-hidden="true"]')) {
        expect(a.getAttribute('tabindex')).toBe('-1');
        expect(a.textContent).toBe('');
      }
    });

    it('the pointer says so too — the hover tint is no longer the only signal', () => {
      const cls = classesOf(render().tr);
      expect(cls).toContain('cursor-pointer');
      // The tint that made the row look clickable in the first place is kept, not removed.
      expect(cls).toContain('hover:bg-muted/40');
    });
  });
}

itBehavesLikeAClickableRow(
  '420ebab5 · the whole employee row opens the employee',
  renderRow,
  employeeRowHref(EMPLOYMENT_ID),
);

itBehavesLikeAClickableRow(
  '420ebab5 · the draft rows at the top of the same table behave the same way',
  renderDraft,
  draftRowHref(DRAFT_ID),
);

describe('420ebab5 · the employee row, in detail', () => {
  it('the named link is the employee, at the href the helper spells', () => {
    const { tr } = renderRow();
    const a = namedLink(tr);
    expect(a.textContent).toBe('Aisha Rahman');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe(`/admin/personnel/${EMPLOYMENT_ID}?from=personnel`);
    // The href helper and the rendered row agree — the destination is spelled once.
    expect(a.getAttribute('href')).toBe(employeeRowHref(EMPLOYMENT_ID));
  });

  it('the name link carries the overlay for its own cell', () => {
    const { tr } = renderRow();
    const linkCls = namedLink(tr).getAttribute('class') ?? '';
    // The name cell needs no silent overlay of its own: the visible link paints one, which is also what
    // keeps hovering anywhere in that cell tinting the name.
    expect(linkCls).toContain('after:absolute');
    expect(linkCls).toContain('after:inset-0');
    expect(linkCls).toContain("after:content-['']");
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

describe('420ebab5 · the draft row, in detail', () => {
  it('goes to the form that finishes the draft, not to a profile that does not exist', () => {
    const { tr, cells } = renderDraft();
    expect(draftRowHref(DRAFT_ID)).toBe(`/admin/personnel/new?draft=${DRAFT_ID}`);
    expect(namedLink(tr).textContent).toBe('Siti (draft)');
    expect(namedLink(tr).getAttribute('href')).toBe(draftRowHref(DRAFT_ID));
    // It still SAYS it is a draft in two places, which is what makes the different destination honest.
    expect(cells[COLUMNS.indexOf('status')].textContent).toBe('Draft');
    expect(cells[COLUMNS.indexOf('name')].textContent).toContain('3 fields still needed');
  });

  it('keeps its own tint, the held Employee ID, and an em dash for what it has no answer for', () => {
    const { tr, cells } = renderDraft();
    expect(classesOf(tr)).toContain('bg-muted/20');
    expect(cells[COLUMNS.indexOf('code')].textContent).toBe('EMP-0102');
    expect(cells[COLUMNS.indexOf('department')].textContent).toBe('—');
    expect(cells[COLUMNS.indexOf('company')].textContent).toBe('Acme Sdn Bhd');
  });

  it('a draft with no held Employee ID shows an em dash there too', () => {
    const { cells } = renderDraft({ reservedEmployeeCode: null });
    expect(cells[COLUMNS.indexOf('code')].textContent).toBe('—');
  });
});

describe('420ebab5 · the listing renders those rows, and nothing else', () => {
  const LISTING = read('app/admin/personnel/page.tsx');

  it('both kinds of row come from their components, not from a hand-built <tr>', () => {
    expect(LISTING).toContain("import { EmployeeRow } from './employee-row';");
    expect(LISTING).toContain("import { DraftRow } from './draft-row';");
    // The components are what the two maps return — re-inlining a row here is what this catches.
    expect(LISTING).toMatch(/employees\.map\(\(e\) => \{[\s\S]{0,800}<EmployeeRow/);
    expect(LISTING).toMatch(/drafts\.map\(\(d\) => \([\s\S]{0,200}<DraftRow/);
  });

  it('the page still resolves the status, the labels and the column text itself', () => {
    // The rows hold no translator and no clock: if these move into the components, the table and the
    // Excel export stop sharing one projection.
    expect(LISTING).toContain('const st = deriveEmploymentStatus(e, today);');
    expect(LISTING).toContain('statusLabel={tStatus(st)}');
    expect(LISTING).toContain('text[key] = textCell(e, key);');
    // The draft wording is chosen here too, not inside the row.
    expect(LISTING).toContain("statusLabel={t('statusDraft')}");
    expect(LISTING).toContain("t('draftUntitled')");
    expect(LISTING).toContain("t('draftNoCompany')");
  });

  it('no row in this table is hand-built with the padding the row components own', () => {
    // Both components put the cell padding on the SAME box as the positioning (row-link.tsx explains
    // why). A cell written here with that padding and no positioning is a row that has quietly gone
    // back to being dead outside its name — the defect this item reported.
    const tbody = LISTING.slice(LISTING.indexOf('<tbody'), LISTING.indexOf('</tbody>'));
    expect(tbody).not.toContain('className="px-4 py-3"');
  });
});
