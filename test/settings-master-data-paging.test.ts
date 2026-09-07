/**
 * 9da61c86 — every System Settings master-data LIST pages, through the ONE pager.
 *
 * The reporter's request was "System Settings screens should be divided into pages", named nine kinds of
 * master data, and asked for the same treatment on "other applicable master data". In this product those
 * nine are not nine screens (Company is /admin/organization, already paged; Job Grade is the grade grid;
 * the rest are categories inside System Labels / Profile Options), so the promise made back was: the three
 * grids, plus any other master-data list found in the same state. This file is that promise as a ratchet.
 *
 * SOURCE ASSERTIONS, and what they are for. They cannot see whether the right rows render — that is
 * test/settings-grid-paging.dom.test.tsx, which draws the grids and reads the page. What they catch is
 * DRIFT: a screen quietly dropping its pager, or the next one growing a fourth hand-rolled pager beside
 * the three that exist. Comments are stripped before matching, because several of these files discuss
 * pagination in prose and a guard that reads its own documentation proves nothing (standing order 27).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
/** Block and line comments removed — these files SAY "pagination" in prose all over the place. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The three editable grids the item named. Each is a 'use client' spreadsheet, so each takes the CLIENT
 *  pager — components/pager.tsx is async and cannot be awaited inside one. */
const GRIDS = [
  'components/system-labels-grid.tsx',
  'components/profile-options-grid.tsx',
  'components/grade-labels-grid.tsx',
] as const;

/** The sweep: every other admin master-data list that was rendering every row with no pager. All seven are
 *  server-rendered, so all seven take the SERVER pager and the same ?page=&size= contract. */
const SWEPT_PAGES = [
  'app/admin/settings/movement/page.tsx',
  'app/admin/settings/hiring-defaults/page.tsx',
  'app/admin/settings/dashboard/page.tsx',
  'app/admin/settings/employee-id/page.tsx',
  'app/admin/pay-components/page.tsx',
  'app/admin/holidays/page.tsx',
  'app/admin/holidays/groups/page.tsx',
] as const;

describe('the master-data grids page in the browser', () => {
  it.each(GRIDS)('%s slices its rows and renders the shared client pager', (file) => {
    const src = code(read(file));
    expect(src).toContain("from '@/lib/pagination'");
    expect(src).toMatch(/useClientPageQuery\(\)/);
    expect(src).toMatch(/paginateRows\(view, pq\)/);
    expect(src).toMatch(/<ClientPager state=\{pgState\}/);
    // Not a fourth pager: the page lives in the address, never in a private page-size constant or a
    // local useState the address cannot see (which is what makes it survive the save round trip).
    expect(src).not.toMatch(/const PAGE_SIZE\b/);
    expect(src).not.toMatch(/useState[^\n]*\bpage\b/i);
  });

  // The ordering that makes a column header mean what it says. Filter and sort must order the WHOLE
  // category and paging must slice the result; do it the other way and clicking a header reorders
  // twenty-five rows while leaving the other three hundred where they were, which looks like sorting.
  it.each(GRIDS)('%s sorts before it pages, never within the page', (file) => {
    const src = code(read(file));
    expect(src.indexOf('const applyView')).toBeGreaterThan(0);
    expect(src.indexOf('const applyView')).toBeLessThan(src.indexOf('paginateRows('));
    expect(src).toMatch(/const view = useMemo\(\(\) => applyView\(rows\)/);
  });

  // The reporter asked to keep the page size "so you do not reset it every time you open the screen".
  it.each(GRIDS)('%s remembers its own rows-per-page rather than sharing one setting', (file) => {
    expect(code(read(file))).toMatch(/rememberAs="[a-z-]+"/);
  });
  it('and each grid remembers under its OWN key', () => {
    const keys = GRIDS.map((f) => code(read(f)).match(/rememberAs="([a-z-]+)"/)?.[1]);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(GRIDS.length);
  });

  // Narrowing the list while standing on page 5 would otherwise show an empty table and no sign that the
  // rows it matched exist one click away.
  it.each(GRIDS)('%s restarts at page one when the filters change', (file) => {
    expect(code(read(file))).toContain('useResetPageOnFilterChange(');
  });

  // A draft is appended and then sorted, so it lands wherever the ordering puts it — on a paged list,
  // usually a page nobody is looking at.
  it.each(GRIDS)('%s follows a newly added row to the page it landed on', (file) => {
    expect(code(read(file))).toContain('pageOfIndex(');
  });
});

describe('the sweep — every other admin master-data list', () => {
  it.each(SWEPT_PAGES)('%s pages through the shared helper and the shared pager', (file) => {
    const src = code(read(file));
    expect(src).toContain("from '@/lib/pagination'");
    expect(src).toContain('parsePageQuery(sp)');
    expect(src).toContain('paginateRows(');
    expect(src).toContain('<Pager');
  });

  it.each(SWEPT_PAGES)('%s accepts ?size= so a shared link opens the same view', (file) => {
    // Written inline on some pages and one-per-line on others; what matters is that the param is declared.
    expect(code(read(file))).toMatch(/size\?: string/);
    expect(code(read(file))).toMatch(/page\?: string/);
  });

  // Movement Settings shipped with "NO PAGINATION, deliberately" written into its header. That decision is
  // reversed here, and the file must SAY so rather than silently disagreeing with its own documentation.
  it('Movement Settings records that its no-pagination decision was reversed, not forgotten', () => {
    const src = read('app/admin/settings/movement/page.tsx');
    expect(src).toContain('PAGED SINCE 9da61c86');
    expect(src, 'the old reasoning is quoted, not deleted').toContain('NO PAGINATION, deliberately');
  });

  /**
   * The SECOND reversal, and the one that cost this round a defect: lib/pagination's module header is the
   * product-wide statement of which surfaces page, and it named the grade-labels grid as one that must
   * not. A file that contradicts the contract it documents is worse than an undocumented one — the next
   * reader follows the header and reverts the screen.
   */
  it('lib/pagination no longer names grade labels among the surfaces paging is kept off', () => {
    const src = read('lib/pagination.ts');
    const header = src.slice(0, src.indexOf('export const PAGE_SIZE_OPTIONS'));
    const exclusions = header.match(/Deliberately NOT applied to:[\s\S]*?import previews\./)?.[0];
    expect(exclusions, 'the exclusion sentence must still exist — it governs the other surfaces').toBeTruthy();
    expect(exclusions!.toLowerCase()).not.toContain('grade label');
    // Reversed, not silently edited: the header still carries WHY the old classification was wrong, and
    // the test that decides future cases (whole-artifact, not merely editable).
    expect(header).toContain('GRADE LABELS LEFT THAT LIST');
    expect(header).toContain('9da61c86');
  });
});

/**
 * The Holiday master's edit round trip, pinned across BOTH files that make it work.
 *
 * A server action reads the FORM, never the address it was posted from, so the page has to send the page
 * number in the form and holidaysPath has to read it back out. Each half is silently useless without the
 * other and a unit test of either one passes throughout — the class of defect standing order 17 names.
 */
describe('editing a holiday returns to the page you were on', () => {
  it('the page posts the page and size with every row action', () => {
    const src = code(read('app/admin/holidays/page.tsx'));
    expect(src).toContain('name="filterPage"');
    expect(src).toContain('name="filterSize"');
    // …and they are the values actually in use, not a hard-coded first page.
    expect(src).toMatch(/name="filterPage" value=\{String\(pq\.page\)\}/);
    expect(src).toMatch(/name="filterSize" value=\{String\(pq\.size\)\}/);
    // Both maps must slice the SAME page: the detached edit forms and the rows that attach to them by
    // `form=`. A form rendered for a row that is not on screen is a Save that does nothing.
    expect([...src.matchAll(/pageRows\.map\(/g)]).toHaveLength(2);
    expect(src).not.toMatch(/\{holidays\.map\(/);
  });

  it('the action reads them back and rebuilds the address', () => {
    const src = code(read('app/admin/actions.ts'));
    expect(src).toContain("formData.get('filterPage')");
    expect(src).toContain("formData.get('filterSize')");
    expect(src).toMatch(/sp\.set\('page', page\)/);
    expect(src).toMatch(/sp\.set\('size', size\)/);
  });

  // The SIZE rides only when the reader actually chose one. pq.size resolves to the default whether or not
  // the address says anything, so an unconditional hidden field turned a bare /admin/holidays into
  // ?size=25 on the first Save — an address claiming a choice nobody made.
  it('the page posts a size only when the address carries one', () => {
    const src = code(read('app/admin/holidays/page.tsx'));
    expect(src).toMatch(/\{sp\.size && <input type="hidden" name="filterSize"/);
  });
});

/**
 * ROWS-PER-PAGE IS A PREFERENCE, NOT A POSITION IN A LIST (9da61c86 fix pass).
 *
 * The swept screens deliberately drop ?page= when a filter, a status or a sort changes — page 4 of the
 * active items is not page 4 of the inactive ones. Their link helpers dropped ?size= with it, silently
 * resetting a reader who had chosen 100 rows back to 25, and on two of the three the SEARCH form beside
 * those links carried the size through — so the two controls next to each other behaved differently.
 */
describe('a filter or status switch keeps the rows-per-page', () => {
  it.each([
    ['app/admin/pay-components/page.tsx', /sp\.size \? `&size=\$\{pq\.size\}` : ''/],
    ['app/admin/settings/movement/page.tsx', /if \(sp\.size\) usp\.set\('size', String\(pq\.size\)\)/],
    ['app/admin/settings/hiring-defaults/page.tsx', /if \(sp\.size\) usp\.set\('size', String\(pq\.size\)\)/],
  ] as const)('%s carries the size through its own link helper', (file, shape) => {
    expect(code(read(file))).toMatch(shape);
  });
});

/**
 * "KEEP YOUR SEARCH, FILTER AND PAGE POSITION WHEN YOU ADD OR EDIT A RECORD AND COME BACK" — the plan's
 * third bullet, on the two swept screens that edit through the address rather than a separate route.
 *
 * Both minted an Edit link that dropped the page, and both ran every write through a `run()` that
 * redirected to a bare `${PAGE}?toast=`. On the Dashboard that also dropped section=library, so saving a
 * card left the library view entirely. It is the cross-file class of defect standing order 17 names — the
 * page sends the position, the action reads it back, and a unit test of either half passes throughout —
 * so both halves are pinned here.
 *
 * (Pay Items and Hiring Defaults edit on their own maintenance ROUTES and are not covered: their round
 * trip discards the search and status filter too, and predates this round. Declared, not forgotten.)
 */
describe('editing a record returns you to the list you were on', () => {
  it.each([
    // The Edit link's exact shape, per screen: the row id ALONE is the defect — it opens the editor on a
    // list that has forgotten which page (and on the Dashboard, which filters) the row was found under.
    ['app/admin/settings/employee-id', /href=\{keepingPlace\(`\$\{PAGE\}\?edit=\$\{c\.id\}`\)\}/],
    ['app/admin/settings/dashboard', /href=\{`\$\{PAGE\}\?\$\{listQs\}&edit=\$\{c\.id\}`\}/],
  ] as const)('%s carries the view into the form and back out of the action', (dir, editLink) => {
    const page = code(read(`${dir}/page.tsx`));
    // The list's own address, minted once and hung on the links AND on a hidden field in every row form.
    expect(page).toContain('const listQs = listAddress.toString()');
    expect(page).toContain('name="returnTo"');
    expect(page, 'the Edit link must carry the list position, not just the row id').toMatch(editLink);

    const actions = code(read(`${dir}/actions.ts`));
    expect(actions).toContain("formData.get('returnTo')");
    // Every redirect goes through the rebuilt address; none goes back to a bare first page.
    expect(actions).toContain('listAddress(formData, { toast:');
    expect(actions).toContain('listAddress(formData, { error:');
    expect(actions, 'a bare ?toast= is the bug this pins').not.toMatch(/\$\{PAGE\}\?toast=/);
    expect(actions, 'a bare ?error= drops the position on a failure too').not.toMatch(/\$\{PAGE\}\?error=/);
  });

  // Only the keys the screen owns survive the round trip, so a hand-edited returnTo cannot put anything
  // else into the redirect.
  it('the Card Library carries its filters as well as its page', () => {
    const actions = code(read('app/admin/settings/dashboard/actions.ts'));
    expect(actions).toContain("const RETURN_KEYS = ['section', 'q', 'type', 'status', 'page', 'size']");
  });
});

/**
 * ONE pager, two renderings. components/pager.tsx draws <Link>s on the server and
 * components/client-pager.tsx draws <button>s in the browser, because the server one awaits
 * getTranslations and a 'use client' grid cannot render it. They must not drift into two DESIGNS: both
 * take their numbers from the same pure helper and their look from the same class constants.
 */
describe('the two pagers stay one design', () => {
  it.each(['components/pager.tsx', 'components/client-pager.tsx'])('%s offers first, numbers and last', (file) => {
    const src = code(read(file));
    expect(src).toContain("t('first')");
    expect(src).toContain("t('last')");
    expect(src).toContain("t('pageNumber'");
    // The window comes from lib/pagination, so neither file can invent its own idea of which pages to show.
    expect(src).toContain('pageNumbers(state)');
    expect(src).toContain('lastPage(state)');
    expect(src).toContain('aria-current="page"');
  });

  it('and take their look from the shared constants rather than copying the class strings', () => {
    for (const file of ['components/pager.tsx', 'components/client-pager.tsx']) {
      expect(code(read(file))).toMatch(/pagerPageNumCls|pagerPageNumCurrentCls/);
      expect(code(read(file)), `${file} must not inline the page-number classes`).not.toContain(
        'inline-flex h-7 min-w-7 items-center',
      );
    }
  });
});
