/**
 * Feedback 026e16b9 — Employee Balances / Employee Details / Employee Leave Record layout.
 *
 * PRESENTATION ONLY. The reporter was explicit that no configuration or rule may change, so this file
 * deliberately asserts nothing about data: it guards the three CSS decisions that made the tables fit, and
 * the property that the three tabs stay consistent with each other.
 *
 * WHAT WAS MEASURED, because this repo has no DOM or interaction test runner and a layout claim cannot be
 * covered by a test here. Verified in a real browser against the live app before and after:
 *
 *   Employee Balances, window 1512px
 *     before — container 1232 (max-w-7xl), rail+gap 248, table area 982 for 1118px of columns
 *              ⇒ 136px of HORIZONTAL SCROLL. LEAVE CODE squeezed to 237px and wrapping
 *              "Hospitalization Leave" over two lines, while ADJUSTMENT held 104px and OVERUTILIZED 112px
 *              for a two-decimal number — the reporter's complaint exactly.
 *     after  — table area 1038 for 1047px of columns ⇒ 9px, i.e. none at any wider viewport, and all
 *              eleven columns visible at once with more rows on screen.
 *   Employee Details (/leave), window 1512px
 *     before — container 1152 (max-w-6xl), tables 902 wide.
 *     after  — container 1232, tables 1038. No overflow either way; the change is the reclaimed blank space.
 *
 * The tests below pin the mechanism behind those numbers so a later edit cannot quietly undo it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BALANCES = '/app/leave/employee-balances/page.tsx';
const RECORDS = '/app/leave/employee-records/page.tsx';
// 388e53c2 REPOINTED THIS, and only this. Employee Details is the same listing with the same width; it
// simply opens from Team Leave Tracker now instead of from My Absence, because the sidebar lights a row by
// path prefix and every /leave/* screen was keeping "My Leave" lit while an administrator read somebody
// else's record. The three assertions this file makes about Employee Details are unchanged in SUBSTANCE —
// they are made against the file that now holds it.
const DETAILS = '/app/leave/tracker/page.tsx';
const NAV = '/components/leave/leave-inquiry-nav.tsx';

/**
 * app/leave/tracker/page.tsx renders ONE of two surfaces: the inquiry listing for an HR administrator, the
 * leave calendar for everybody else. Only the first is an inquiry tab, so every width assertion below is
 * scoped to its branch — otherwise "the three tabs share one cap" would be satisfied, or broken, by a
 * calendar that was never one of the three.
 */
const CALENDAR_BANNER = '  // ── The Leave Calendar';
const inquiryPart = (rel: string) => {
  const src = read(rel);
  if (rel !== DETAILS) return src;
  const at = src.indexOf(CALENDAR_BANNER);
  expect(at, 'the tracker page must still have its calendar branch marker').toBeGreaterThan(-1);
  return src.slice(0, at);
};

/** Source with block and line comments removed, for assertions about what the JSX actually says. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The nav's CODE, never its prose — the reason this file's header already gives about max-w-7xl, now true
 * of the nav too: it records at length that it USED to be an sm:w-44 rail beside a gap-4, and that it is
 * deliberately not a role="tablist". A whole-file search finds every one of those strings in the
 * explanation of why it is gone. Comment-stripping rather than className-matching, because the pill's
 * className is a template literal and a quoted-value regex cannot see inside one.
 */
const navCode = () => codeOnly(read(NAV));

describe('026e16b9 · the three inquiry tabs use the page width, consistently', () => {
  it('all three share ONE container cap, and it is wider than the old max-w-7xl / max-w-6xl', () => {
    // They were 7xl, 7xl and 6xl — three tabs of one screen, three different widths. The shared cap is what
    // stops a wide monitor being half blank, and keeping them equal is what stops the tabs reading as
    // different screens. THAT IS STILL THE CLAIM; 388e53c2 changed which file the third one lives in.
    //
    // Matched against `className="…"` values only, never the whole file: these pages carry prose comments
    // recording the before/after measurement, and a naive substring search finds "max-w-7xl" in the
    // explanation of why it is no longer used.
    const classNames = (src: string) => (src.match(/className="[^"]*"/g) ?? []).join('\n');
    for (const p of [BALANCES, RECORDS, DETAILS]) {
      const cls = classNames(inquiryPart(p));
      expect(cls.includes('mx-auto max-w-[100rem] space-y-6'), `${p} container`).toBe(true);
      expect(cls.includes('max-w-7xl'), `${p} still capped at 7xl`).toBe(false);
      expect(cls.includes('max-w-6xl'), `${p} still capped at 6xl`).toBe(false);
    }
  });

  it('9949f91a — the two tabs mount the SHARED employee panel, and Employee Details does not', () => {
    // The reporter's request, as a property rather than a screenshot: the picker on these two tabs is the same
    // component nine other screens mount, not a tenth slightly different one. Asserted here because this is
    // the file that owns their layout — and asserted NEGATIVELY on the third tab, which the ticket did not
    // cover and which is itself a paged employee listing.
    for (const p of [BALANCES, RECORDS]) {
      const src = read(p);
      expect(src.includes('<CollapsibleEmployeePanel'), `${p} mounts the shared shell`).toBe(true);
      expect(src.includes('<EmployeeScopePanel'), `${p} mounts the shared list`).toBe(true);
      // The shell owns the grid. A page that hand-rolled a two-column grid of its own is the drift this
      // guards — and `sm:flex-row` (the retired rail's mechanism) must still be absent, which the case above
      // asserts for the same two files.
      const cls = (src.match(/className="[^"]*"/g) ?? []).join('\n');
      expect(cls.includes('grid-cols-['), `${p} must not hand-roll the panel grid`).toBe(false);
    }
    expect(read(DETAILS).includes('<CollapsibleEmployeePanel'), 'Employee Details is out of scope').toBe(false);
  });

  it('the calendar keeps its OWN, narrower cap — it is not an inquiry tab', () => {
    // The other half of the same claim, and the reason the assertion above is scoped rather than dropped.
    // A month grid does not want a 100rem line length, and the reporter asked for the entry point to move,
    // not for the calendar to be restyled. So: 6xl below the branch, 100rem above it, and neither leaks.
    const src = read(DETAILS);
    const calendar = src.slice(src.indexOf(CALENDAR_BANNER));
    const classNames = (s: string) => (s.match(/className="[^"]*"/g) ?? []).join('\n');
    expect(classNames(calendar).includes('mx-auto max-w-6xl space-y-6'), 'calendar container').toBe(true);
    expect(classNames(calendar).includes('max-w-[100rem]'), 'the inquiry cap leaked into the calendar').toBe(
      false,
    );
  });

  it('it stays CAPPED rather than full-bleed — an unbounded table is unreadable the other way', () => {
    for (const p of [BALANCES, RECORDS, DETAILS]) {
      expect(read(p).includes('max-w-none'), `${p} must not go full-bleed`).toBe(false);
    }
  });

  /**
   * d990f14a REVERSES THE RAIL, so the two assertions that used to pin its width and its column direction
   * are RE-POINTED at the mechanism that replaces it, not deleted. The claim 026e16b9 made — "the tab list
   * must not cost the table width" — is the same claim; the answer went from "make the column narrow" to
   * "do not have a column". A rail reintroduced by a later edit fails here exactly as a WIDE rail did.
   *
   * The arithmetic that justified it: sm:w-44 is 11rem = 176px, plus the gap-4 beside it = 192px, against
   * the 9px of overflow 026e16b9's own measurement left behind at a 1512px window.
   */
  /**
   * ⚠️ 9949f91a (r369) — READ THIS BEFORE THE CASE BELOW. There IS a left-hand column on the two tabs again,
   * and it is NOT the tab rail this case is about. The reporter asked for Employee Balances and Employee Leave
   * Record to take the shared employee panel every Attendance and Payroll screen already has.
   *
   * THE CLAIM THAT IS NOW FALSE, quoted from the two pages this file reads, so a reader of the assertion
   * below is not misled by it: "NO RAIL. The tab bar is rendered below, between the filters and the table, so
   * the table gets the whole width of THE PAGE instead of the 192px the rail and its gap were taking." The
   * table now gets the whole width of the CONTENT COLUMN, and the whole width of the page only while the panel
   * is folded away — which is the answer to the reporter's own earlier complaint, since the strip they had
   * removed was always-on and could not be put away. Both pages' comments have been reworded to say so.
   *
   * THE CLAIM THAT STANDS, and is what the case below actually pins: the TAB LIST is never a vertical rail
   * again. It is a horizontal strip, rendered between the filters and the table, and it costs the table no
   * width. 026e16b9's complaint was about the tab list, not about an employee picker, and reintroducing an
   * `sm:w-44` column of tabs must still fail here. The panel's own grid classes live in
   * components/collapsible-employee-panel.tsx, which this file does not read — deliberately, because one
   * shared component's layout is not a per-screen decision.
   */
  it('there is NO TAB rail: the tab list carries no width and takes no column', () => {
    // SCOPED TO className VALUES, for the reason this file's header already gives about max-w-7xl: the nav
    // now carries prose recording that it USED to be sm:w-44 beside a gap-4, and a whole-file search finds
    // the width in the explanation of why it is gone.
    const nav = navCode();
    expect(nav.includes('sm:w-44'), 'the rail width is gone, not narrowed again').toBe(false);
    expect(nav.includes('sm:w-56'), 'and certainly not back to the original width').toBe(false);
    expect(nav, 'the tab list is never a vertical column again').not.toMatch(/sm:flex-col/);
    for (const p of [BALANCES, RECORDS, DETAILS]) {
      expect(
        inquiryPart(p).includes('sm:flex-row'),
        `${p} must not put the tab list beside the content again`,
      ).toBe(false);
    }
  });

  it('the tab list is a horizontal strip that scrolls itself rather than wrapping onto a second line', () => {
    // Six locales share this bar. Wrapping it would push the table down instead of costing width, which is
    // the same defect in the other direction; scrolling the BAR keeps the table where it is.
    const nav = navCode();
    expect(nav).toMatch(/flex gap-[\d.]+ overflow-x-auto/);
    expect(nav.includes('whitespace-nowrap'), 'a pill label never breaks mid-word').toBe(true);
  });

  it('it stays a NAV with aria-current — a segmented control that is really three routes', () => {
    // The look is a tab strip; the behaviour is navigation. role="tablist"/aria-selected would tell a screen
    // reader these are panels of one page and that activating one swaps a view, which is false.
    // Comments stripped for the same reason: the component explains AT LENGTH why it is not a tablist, and
    // that explanation necessarily names role="tablist" and aria-selected.
    const nav = navCode();
    expect(nav.includes('<nav aria-label={t(\'navLabel\')}>')).toBe(true);
    expect(nav.includes("aria-current={active === tab.key ? 'page' : undefined}")).toBe(true);
    expect(nav.includes('role="tablist"'), 'these are routes, not tabs').toBe(false);
    expect(nav.includes('aria-selected'), 'these are routes, not tabs').toBe(false);
  });

  it('the tab bar is rendered ABOVE the table on every tab, and the tables still scroll in a wrapper', () => {
    for (const p of [BALANCES, RECORDS, DETAILS]) {
      const src = inquiryPart(p);
      const bar = src.indexOf('<LeaveInquiryNav');
      const table = src.indexOf('<table');
      expect(bar, `${p} still renders the tab bar`).toBeGreaterThan(-1);
      expect(table, `${p} still renders its table`).toBeGreaterThan(-1);
      expect(bar, `${p} must render the tab bar before its table`).toBeLessThan(table);
      // Whatever still cannot fit scrolls the TABLE, never the page.
      expect(src.includes('overflow-x-auto'), `${p} keeps its scroll container`).toBe(true);
    }
  });

  it('on the two tabs with a search bar, the bar sits BELOW the filters (the reporter asked for that order)', () => {
    // Employee Details keeps its filters inside the card header and has nothing above the card, so it is
    // deliberately not part of this assertion — see the note at its call site.
    for (const p of [BALANCES, RECORDS]) {
      const src = inquiryPart(p);
      expect(src.indexOf('<FilterChips'), `${p} still has its filter chips`).toBeGreaterThan(-1);
      expect(
        src.indexOf('<FilterChips'),
        `${p} must render the search bar and its chips above the tab bar`,
      ).toBeLessThan(src.indexOf('<LeaveInquiryNav'));
    }
  });

  it('MY ABSENCE IS NO LONGER ONE OF THE THREE — it kept none of the listing behind', () => {
    // The failure this replaces the old DETAILS entry with. A half-move that leaves the rail, the table or
    // the ed* params on /leave gives an administrator two Employee Details screens, one of which relights
    // "My Leave" — the exact complaint the item was raised about.
    const leavePage = read('/app/leave/page.tsx');
    for (const gone of ['<LeaveInquiryNav', 'listEmployeesPage', 'inquiryPageWindow', 'edPage', 'edStatus']) {
      expect(leavePage.includes(gone), `still on /leave: ${gone}`).toBe(false);
    }
  });
});

describe('026e16b9 · numeric columns compact, the text column gets the room', () => {
  const balances = read(BALANCES);

  it('cells are px-2, not px-3 — nine numeric columns of padding was ~72px of the overflow', () => {
    expect(balances.includes("const th = 'px-2 py-2 font-medium'")).toBe(true);
    expect(balances.includes("px-3 py-2 text-right tabular-nums")).toBe(false);
  });

  it('the VALUES never wrap but the HEADINGS still do — that asymmetry is what keeps the columns narrow', () => {
    // "Pending approval" over two lines holds that column to the width of "approval"; the number below it
    // must not break across lines. Getting this backwards makes every numeric column WIDER, which is the
    // trap worth a test.
    expect(balances.includes("const tdNum = 'whitespace-nowrap px-2 py-2 text-right tabular-nums'")).toBe(true);
    expect(balances.includes("const thNum = `${th} text-right`")).toBe(true);
    expect(balances.includes('const thNum = `${th} whitespace-nowrap'), 'headings must keep wrapping').toBe(false);
  });

  it('the leave-type column takes the recovered slack, with a floor so it cannot collapse', () => {
    expect(balances.includes('w-[26%] min-w-[13rem]')).toBe(true);
  });

  it('the free-text Reason column on the records tab widens rather than staying the narrowest', () => {
    const records = read(RECORDS);
    expect(records.includes('max-w-[24rem] truncate')).toBe(true);
    // Truncation + the full text on hover is preserved — nothing becomes unreadable, it just gets more room.
    expect(records.includes('title={r.reason ?? \'\'}')).toBe(true);
  });

  /**
   * r242 — the Explanation column is the first column added to this table since the widths were measured,
   * and the measurement is only still true if it behaves. Two properties, both cheap to break:
   * it goes LAST (so no numeric column is displaced), and it is not treated as a numeric cell (`tdNum`
   * carries `text-right tabular-nums`, which would right-align a button against the table edge).
   * The panel it opens is a Radix side-sheet fixed to the viewport, so it adds no width of its own.
   */
  it('r242: the Explanation column is last and is not a numeric cell — the measured widths still hold', () => {
    const thead = balances.slice(balances.indexOf('<thead'), balances.indexOf('</thead>'));
    const headings = [...thead.matchAll(/\{t(?:Inq|Me)\('([^']+)'\)\}/g)].map((m) => m[1]);
    expect(headings.at(-1), 'the Explanation heading must be the LAST column').toBe('colExplanation');
    // …and exactly one of them, so a later edit cannot quietly seat it mid-table as well.
    expect(headings.filter((h) => h === 'colExplanation')).toHaveLength(1);
    // The trigger lives in a plain px-2 cell (the table's own padding), never the right-aligned numeric one:
    // `tdNum` carries text-right + tabular-nums, which would shove a button against the table edge and
    // render its caption in figure spacing.
    const before = balances.slice(0, balances.indexOf('<EntitlementBreakdown'));
    const openTd = before.slice(before.lastIndexOf('<td '));
    const openTag = openTd.slice(0, openTd.indexOf('>'));
    expect(openTag, 'the Explanation cell keeps the table padding').toContain('px-2 py-2');
    expect(openTag, 'the Explanation cell is not a figure cell').not.toContain('tabular-nums');
    expect(openTag, 'the Explanation cell is not right-aligned').not.toContain('text-right');
  });

  it('the inquiry table headings drop tracking-wide (measured: 23px across eleven columns)', () => {
    for (const p of [BALANCES, RECORDS]) {
      expect(
        read(p).includes('bg-muted/50 text-left text-xs uppercase text-muted-foreground'),
        `${p} heading row`,
      ).toBe(true);
      // SCOPED TO THE HEADING ROW. The measurement this pins is about <th> tracking, and the assertion
      // above already states the heading row's exact classes. Scanning the WHOLE FILE also caught BODY
      // cells: r86c's #reference column and its cancel-pending badge both use `uppercase tracking-wide`
      // deliberately on small-caps labels, which costs the table nothing. A guard on headings must look
      // at headings.
      const thead = read(p).slice(read(p).indexOf('<thead'), read(p).indexOf('</thead>'));
      expect(thead.includes('uppercase tracking-wide'), `${p} heading still tracking-wide`).toBe(false);
    }
  });
});

describe('026e16b9 · presentation only — no rule, figure or config is touched', () => {
  it('the balances page still derives every figure from the shared reads, unchanged', () => {
    // The reporter's constraint, verbatim: "do not change any other rules of config inside". The row builder
    // is untouched by this item; if a layout change ever starts computing a figure, this fails.
    const rows = read('/app/leave/employee-balances/rows.ts');
    expect(rows.includes('deriveBalanceRow')).toBe(true);
    expect(rows.includes('leaveEntitlementBreakdown')).toBe(true);
    // Every column still renders through the same `num()` formatter — no per-column rounding crept in.
    // REPOINTED by 4a1abc4a: `num` now delegates to the SHARED lib/day-format helper instead of carrying
    // its own toFixed, so this screen and the employee's own balance grid cannot print a figure two ways.
    // The claim being guarded is the same one — one formatter for the whole table, and null is an em dash
    // rather than a "0.00" HR would read as a real zero balance — so it is checked against the new target.
    expect(read(BALANCES).includes('const num = (v: number | null) => formatDays(v)')).toBe(true);
    expect(read(BALANCES).includes("from '@/lib/day-format'")).toBe(true);
    expect(read(BALANCES), 'no per-column rounding beside the shared formatter').not.toContain('toFixed(');
  });

  it('pagination is untouched — the width change does not assume a row count', () => {
    // paginateRows() fetches then slices, so a layout that assumed a fixed number of rows would fight it.
    // Nothing here sets a row-count-dependent height or a fixed table height.
    for (const p of [BALANCES, RECORDS, DETAILS]) {
      expect(inquiryPart(p)).not.toMatch(/h-\[\d+px\]/);
      expect(inquiryPart(p).includes('table-fixed'), `${p} must not fix the table layout`).toBe(false);
    }
  });
});
