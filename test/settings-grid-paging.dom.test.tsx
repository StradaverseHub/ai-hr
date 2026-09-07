/**
 * 9da61c86 — the three System Settings master-data grids page, and paging survives an edit.
 *
 * WHY A RENDER TEST. The claim is about what a reader SEES: that a list of 328 positions opens on
 * twenty-five rows with "1–25 of 328" beside them, and that editing a row on page 3 leaves you on page 3
 * with your search still applied. Neither is a statement about a pure function — the arithmetic is already
 * covered by test/pagination.test.ts — and neither is visible to a source assertion, which can only see
 * that `paginateRows(` appears somewhere in the file. These grids are also the FIRST editable ones to
 * page: rows are held in component state, drafts are appended, and a save is a server round trip that
 * must not cost the reader their place.
 *
 * The address bar is stubbed the way test/client-pager.dom.test.tsx stubs it: `replace()` is recorded
 * rather than performed, and the "current" address is a module-level string a test sets before rendering.
 * So a test asserting a PAGE renders sets the address and reads the rows; a test asserting a page CHANGE
 * reads what the component asked the router for.
 *
 * `onError` THROWS on a missing translation, so the three new pager keys (first / last / pageNumber) are
 * proved to resolve in every locale rather than painting MISSING_MESSAGE on a screen that returns 200.
 *
 * Scope, inherited from every dom test here: jsdom applies no CSS and computes no layout. What this
 * proves is rendering and interaction logic, not pixels.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { ProfileOptionsGrid, type ProfileGridRecord } from '../components/profile-options-grid';
import { GradeLabelsGrid, type GradeGridRecord } from '../components/grade-labels-grid';
import { SystemLabelsGrid, type GridRecord } from '../components/system-labels-grid';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

// The corner toast is a portal with its own store; nothing here asserts on it and a real one would have to
// be torn down between tests.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  replace.mockClear();
  search = '';
  // A remembered rows-per-page would rewrite the address under a test that pins a page's contents.
  window.localStorage.clear();
});

function wrap(node: ReactNode, locale = 'en', messages: Record<string, unknown> = en) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

/** 328 sections — one of the categories the reporter named, at the size they quoted. */
const N = 328;

const profileRows: ProfileGridRecord[] = Array.from({ length: N }, (_, i) => ({
  id: `po-${i}`,
  category: 'section',
  value: `SEC${String(i).padStart(3, '0')}`,
  label: `Section ${i}`,
  description: '',
  sortOrder: i,
  isActive: true,
}));

const profileSave = vi.fn(async () => ({ ok: true as const, created: 0, updated: 1, createdIds: [] }));
const profileActions = { save: profileSave, remove: vi.fn(async () => ({ ok: true as const })) };

function renderProfileGrid() {
  return wrap(
    <ProfileOptionsGrid categories={['section']} data={{ section: profileRows }} actions={profileActions} />,
  );
}

/** The Code cells actually drawn, in order. A saved Profile Option renders its code as text, not an input. */
const codeCells = (c: HTMLElement) =>
  [...c.querySelectorAll('tbody tr td:first-child')].map((td) => td.textContent ?? '');

describe('9da61c86 — the master-data grids render one page at a time', () => {
  it('opens on the first 25 of 328, and says so', () => {
    const { container } = renderProfileGrid();
    const codes = codeCells(container);
    expect(codes).toHaveLength(25);
    expect(codes[0]).toBe('SEC000');
    expect(codes[24]).toBe('SEC024');
    expect(screen.getByText('1–25 of 328')).toBeInTheDocument();
  });

  // The claim the reporter cares about: page 3 is page 3's rows, not the whole list scrolled.
  it('renders only page 3 when the address asks for page 3, with the true total beside it', () => {
    search = 'page=2';
    const { container } = renderProfileGrid();
    const codes = codeCells(container);
    expect(codes).toHaveLength(25);
    expect(codes[0]).toBe('SEC050');
    expect(codes[24]).toBe('SEC074');
    // Never the whole list, and never a total derived from the page.
    expect(codes).not.toContain('SEC000');
    expect(screen.getByText('51–75 of 328')).toBeInTheDocument();
  });

  it('honours the chosen rows-per-page', () => {
    search = 'size=100&page=3';
    const { container } = renderProfileGrid();
    const codes = codeCells(container);
    expect(codes).toHaveLength(28); // 328 = three full pages of 100, then 28
    expect(codes[0]).toBe('SEC300');
    expect(screen.getByText('301–328 of 328')).toBeInTheDocument();
  });

  // A deep link — or the return from a save — must open where it says. The reset-on-filter-change effect
  // runs on the same commit as the first render, so it has to know not to fire; otherwise every arrival on
  // a page other than the first is rewritten to page one before the reader sees it.
  it('a link to page 3 survives the first render — nothing rewrites the address on mount', () => {
    search = 'page=2';
    renderProfileGrid();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('51–75 of 328')).toBeInTheDocument();
  });

  it('offers first / previous / numbered pages / next / last', () => {
    search = 'page=6';
    renderProfileGrid();
    for (const name of [/First/, /Previous/, /Next/, /Last/]) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    // A WINDOW centred on the current page (7 of 14), not one button per page.
    expect(screen.getByRole('button', { name: 'Page 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Page 9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page 1' })).not.toBeInTheDocument();
    // The page you are on is not a link to itself.
    expect(screen.getByText('7', { selector: '[aria-current="page"]' })).toBeInTheDocument();
  });

  it('Last goes to the final page, and a page number goes to that page', async () => {
    search = 'page=2';
    renderProfileGrid();
    await userEvent.click(screen.getByRole('button', { name: /Last/ }));
    expect(replace.mock.calls[0][0]).toContain('page=13'); // 328 / 25 = 14 pages, last index 13
    replace.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'Page 1' }));
    // Page one drops out of the address entirely — the first page is the bare screen.
    expect(replace.mock.calls[0][0]).not.toContain('page=');
  });
});

describe('9da61c86 — editing on page 3 keeps your place', () => {
  it('a row edited and saved on page 3 leaves the reader on page 3, with the search still applied', async () => {
    search = 'page=2';
    const { container } = renderProfileGrid();

    // Narrow to a set that still spans several pages, the way an admin hunting for one position does.
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'Section 1');
    // Typing a search restarts at page one: the rows it matches are a different list.
    expect(replace).toHaveBeenCalled();
    expect(replace.mock.calls.at(-1)?.[0]).not.toContain('page=');
    // 111 matches: Section 1, 10–19, 100–199. The address still says page 3, so that is what is drawn.
    expect(screen.getByText('51–75 of 111')).toBeInTheDocument();

    // Now edit a row ON THAT PAGE and save it.
    replace.mockClear();
    const cell = container.querySelector('[data-cell="description:0"]') as HTMLInputElement;
    await userEvent.type(cell, 'note');
    await userEvent.click(screen.getByRole('button', { name: 'Save all' }));
    expect(profileSave).toHaveBeenCalled();

    // The save does not move the reader: nothing navigates, the search box still holds the search, and the
    // rows on screen are still that page's.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Search values…')).toHaveValue('Section 1');
    expect(screen.getByText('51–75 of 111')).toBeInTheDocument();
    // Sorted by sort order, the 111 matches run 1, 10–19, 100–199 — so index 50 is Section 139.
    expect(codeCells(container)[0]).toBe('SEC139');
  });

  /**
   * SEARCHING MUST NOT NAVIGATE ONCE PER CHARACTER.
   *
   * The reset-to-page-one effect is keyed on the filter signature, and `search` is a plain controlled
   * input, so it fires on every keystroke. On the first page there is nothing to reset — every one of
   * those was a client navigation to the address already on screen, which on System Labels means an RSC
   * render of a route that loads four label categories, the companies, the grades and every profile-option
   * category. Nine characters, nine renders of a screen the reader was already looking at.
   */
  it('typing in the search box does not navigate at all on the first page', async () => {
    renderProfileGrid();
    await userEvent.click(screen.getByRole('button', { name: 'Filter' }));
    await userEvent.type(screen.getByPlaceholderText('Search values…'), 'Section 1');
    expect(replace).not.toHaveBeenCalled();
    // …and the search still narrows the list, which is the whole point of the box.
    expect(screen.getByText('1–25 of 111')).toBeInTheDocument();
  });

  /**
   * A page past the end drew a table body with NOTHING in it — not even the "no rows" line, which the
   * grids guard on the filtered set rather than on the rows actually drawn — while the counter beside it
   * said the records were there. Reachable from a stale bookmark, or by deleting the last rows off the
   * last page.
   */
  it('an address past the end of the list lands the reader on the last page that has rows', () => {
    search = 'page=40';
    renderProfileGrid();
    // 328 rows at 25 a page is 14 pages, last index 13 — one navigation, and it goes to rows.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain('page=13');
  });

  // A draft is appended to the end and then sorted, so on a paged list it lands on a page the reader is not
  // looking at — Add Row would appear to have done nothing at all.
  it('Add Row follows the new draft to the page it landed on', async () => {
    search = 'page=2';
    renderProfileGrid();
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    // 329 rows in sort order put the draft last: index 328 ⇒ page 13.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toContain('page=13');
  });
});

describe('9da61c86 — the sibling grids page the same way', () => {
  it('Job Grades renders one page and the true total', () => {
    search = 'page=1';
    const grades: GradeGridRecord[] = Array.from({ length: 90 }, (_, i) => ({
      id: `g-${i}`,
      code: `G${String(i).padStart(2, '0')}`,
      name: `Grade ${i}`,
      description: '',
      rank: i,
      archivedAt: null,
      inUse: false,
    }));
    const { container } = wrap(
      <GradeLabelsGrid
        data={grades}
        actions={{
          save: vi.fn(async () => ({ ok: true as const, created: 0, updated: 0, createdIds: [] })),
          remove: vi.fn(async () => ({ ok: true as const })),
          restore: vi.fn(async () => ({ ok: true as const, row: grades[0] })),
        }}
      />,
    );
    const codes = [...container.querySelectorAll('[data-cell^="code:"]')].map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(codes).toHaveLength(25);
    expect(codes[0]).toBe('G25');
    expect(screen.getByText('26–50 of 90')).toBeInTheDocument();
  });

  it('System Labels renders one page and the true total', () => {
    search = 'page=1';
    const labels: GridRecord[] = Array.from({ length: 70 }, (_, i) => ({
      id: `l-${i}`,
      companyId: 'c1',
      code: `D${String(i).padStart(2, '0')}`,
      name: `Department ${i}`,
      title: '',
      jobFamily: '',
      label: '',
      businessUnitId: null,
      headEmploymentId: null,
      description: '',
      isGlobal: false,
      archived: false,
      inUse: false,
      assignedCompanyIds: ['c1'],
      createdAt: null,
      lastUpdatedAt: null,
      lastUpdatedBy: null,
    }));
    const { container } = wrap(
      <SystemLabelsGrid
        data={{ department: labels, position: [], cost_center: [], business_unit: [] }}
        companies={[{ id: 'c1', name: 'Acme', sharedSystemLabels: false }]}
        isGroupAdmin={false}
        actions={{
          save: vi.fn(async () => ({ ok: true as const, created: 0, updated: 0, createdIds: [] })),
          setGlobal: vi.fn(async () => ({ ok: true as const })),
          assign: vi.fn(async () => ({ ok: true as const })),
          unassign: vi.fn(async () => ({ ok: true as const })),
          copyToCompanies: vi.fn(async () => ({ ok: true as const })),
          setCompanyShared: vi.fn(async () => ({ ok: true as const })),
        }}
      />,
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25);
    // A department's Code column binds to `name` (dafd475a), so the first cell of the first row on page 2
    // is department 25's name.
    const first = [...container.querySelectorAll('[data-cell^="name:"]')].map(
      (el) => (el as HTMLInputElement).value,
    );
    expect(first).toHaveLength(25);
    expect(first[0]).toBe('Department 25');
    expect(screen.getByText('26–50 of 70')).toBeInTheDocument();
  });
});

/** The pager's own words, in every language the product ships. */
describe('9da61c86 — the pager speaks every locale', () => {
  it.each([
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ] as const)('%s resolves first / last / the page numbers', (locale, messages) => {
    search = 'page=6';
    wrap(
      <ProfileOptionsGrid categories={['section']} data={{ section: profileRows }} actions={profileActions} />,
      locale,
      messages as unknown as Record<string, unknown>,
    );
    const bar = screen.getByText('7', { selector: '[aria-current="page"]' }).parentElement!;
    // Four steps and four reachable numbers, whatever the words are.
    expect(within(bar).getAllByRole('button')).toHaveLength(8);
  });
});
