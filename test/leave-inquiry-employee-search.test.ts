/**
 * The EMPLOYEE PICKER on the two Leave Inquiry tabs — feedback 38b94df7, REVERSED BY 9949f91a (r369).
 *
 * ── THE CLAIM THIS FILE USED TO MAKE, QUOTED, BECAUSE THE PROSE IS WHAT OUTLIVES THE KERNEL ─────────
 * Its title was "Searchable Employee Dropdown on the two Leave Inquiry pickers", its describe block read
 * "38b94df7: both Leave Inquiry employee pickers are the searchable field", and its load-bearing sentence
 * was:
 *
 *     "Hence: assert the composition on both pages, and assert the select is gone — a `<select name="emp">`
 *      left behind on either page is the half-migration this item exists to prevent."
 *
 * 38b94df7 replaced a `<select>` listing all forty employments with `EmployeeSearchField` inside the filter
 * row. 9949f91a replaces THAT with the shared `CollapsibleEmployeePanel` down the left-hand side — the same
 * panel nine other screens already mount — so the reporter learns one way of finding a person and uses it
 * everywhere. The filter-row field is REMOVED rather than kept beside the panel: two pickers for one value is
 * how they come to disagree, which is the attendance screens' own note and the reason this file is REWRITTEN
 * rather than deleted.
 *
 * ── WHAT IS ACTUALLY BEING ASSERTED, and why it is still a SOURCE-shape test ────────────────────────
 * The panel's own behaviour is pinned twice over already, by test/employee-scope-panel.dom.test.tsx (the
 * control) and test/employee-scope-panel-guard.test.ts (what each consumer HANDS it, including these two
 * screens as of r369). What this file owns is the WIRING, which lives between files and which a unit test of
 * either half passes throughout: the query contract `?emp=<employmentId>` must not move, because it is read
 * back by the screens, by BOTH export routes and by the FilterChips base action, and "clearing filters must
 * not clear the employee" depends on it.
 *
 * So: assert the panel is mounted on both pages under `selectParam="emp"`, assert BOTH retired controls are
 * gone (the original `<select>` AND 38b94df7's field), and assert the query contract is untouched.
 *
 * The RSC pages cannot render in this suite (precedent: test/leave-inquiry-surfaces.test.ts), so the
 * composition is read from source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** Source with comments removed: a guard that counts a call must not count a comment naming it. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The two tabs, and the cookie each remembers its own collapse state in. ONE KEY PER SCREEN. */
const PAGES = {
  'app/leave/employee-balances/page.tsx': 'leave-balances-panel',
  'app/leave/employee-records/page.tsx': 'leave-records-panel',
} as const;
type Page = keyof typeof PAGES;
const REL = Object.keys(PAGES) as Page[];

/** 38b94df7's own `id`s, kept here as the names being retired so their absence is asserted by name. */
const RETIRED_FIELD_IDS = {
  'app/leave/employee-balances/page.tsx': 'balances-emp',
  'app/leave/employee-records/page.tsx': 'records-emp',
} as const;

describe('9949f91a: both Leave Inquiry tabs pick an employee in the SHARED PANEL', () => {
  it.each(REL)('%s mounts the shared panel under selectParam="emp"', (rel) => {
    const src = read(rel);
    expect(src).toContain("} from '@/components/collapsible-employee-panel';");
    expect(src).toContain('<CollapsibleEmployeePanel');
    expect(src).toContain('<EmployeeScopePanel');
    // The panel navigates by writing this param — the SAME one every link, bookmark and export already uses.
    expect(src).toMatch(/<EmployeeScopePanel[\s\S]{0,400}?selectParam="emp"/);
    expect(src).toMatch(/<EmployeeScopePanel[\s\S]{0,400}?basePath="\/leave\/employee-(balances|records)"/);
  });

  it.each(REL)('%s remembers its OWN collapse state, never the other tab’s', (rel) => {
    expect(read(rel)).toContain(`const PANEL_COOKIE = '${PAGES[rel]}'`);
    // Two mounts sharing a key means every move between the tabs undoes the last answer.
    for (const other of REL.filter((r) => r !== rel)) {
      expect(read(rel).includes(`'${PAGES[other]}'`), `${rel} must not read ${other}'s key`).toBe(false);
    }
  });

  it.each(REL)('%s renders NEITHER retired control — not the <select>, not the search field', (rel) => {
    const src = read(rel);
    // 026e16b9's original: a whole-list combobox. Its option label was
    // `${e.company} · ${e.name} (${e.employeeCode})`, and that literal's absence is the proof the whole-list
    // render is gone rather than hidden.
    expect(src.includes('<select name="emp"')).toBe(false);
    expect(src.includes('{e.employeeCode ? ` (${e.employeeCode})` : \'\'}')).toBe(false);
    // 38b94df7's replacement, now retired in its turn. Asserted on the IMPORT as well as the tag: a page that
    // kept the import is a page one edit away from mounting it again beside the panel.
    expect(src.includes("from '@/components/employee-search-field'")).toBe(false);
    expect(src.includes('<EmployeeSearchField')).toBe(false);
    expect(src.includes(`id="${RETIRED_FIELD_IDS[rel]}"`)).toBe(false);
    expect(src.includes(`htmlFor="${RETIRED_FIELD_IDS[rel]}"`)).toBe(false);
    expect(src.includes('labels={empSearchLabels}')).toBe(false);
  });

  it('the query contract is UNCHANGED: ?emp= is still what both pages read and write', () => {
    for (const rel of REL) {
      const src = read(rel);
      /**
       * ⚠️ THE ONE HALF OF THE CONTRACT THAT DID MOVE, and it moved on purpose. This read
       *     expect(src).toContain('pickInquiryEmployee(employees, sp.emp)');
       * and `pickInquiryEmployee` falls back to the FIRST employee when `?emp=` is absent (20c699f8 §1), so
       * the screen opened on somebody nobody had chosen — which, beside a panel marking nobody Selected, is
       * two halves of one screen disagreeing about who is being looked at. The reporter asked for
       * "Select an employee to view their leave balances" instead. SCREENS ONLY: `pickInquiryEmployee` keeps
       * the fallback and both export route handlers keep calling it (asserted below), because a route has no
       * screen to prompt on.
       */
      expect(src).toContain('selectInquiryEmployee(employees, sp.emp)');
      expect(src.includes('pickInquiryEmployee('), `${rel} must not fall back to the first employee`).toBe(false);
      // And the selection is written the same way into every outgoing link.
      expect(src).toContain("p.set('emp', selected.employmentId)");
      // The employee still rides the screen's own GET form, so submitting a date or a search cannot clear it.
      expect(src).toContain('<input type="hidden" name="emp" value={selected.employmentId} />');
    }
    // "Clearing filters must not clear the employee" (the chip base action) still carries the selection.
    expect(read('app/leave/employee-balances/page.tsx')).toContain(
      "const chipAction = `/leave/employee-balances${selected ? `?emp=${selected.employmentId}` : ''}`",
    );
  });

  it('the EXPORT ROUTES are untouched and keep the first-employee fallback', () => {
    // The behaviour change is the SCREENS'. A route that lost the fallback would answer 500 or an empty
    // workbook for a link somebody had bookmarked without `?emp=`.
    for (const rel of [
      'app/leave/employee-balances/export/route.ts',
      'app/leave/employee-records/export/route.ts',
    ]) {
      const src = read(rel);
      expect(src, `${rel} still resolves its employee the way it always did`).toContain('pickInquiryEmployee(');
      expect(src.includes('selectInquiryEmployee('), `${rel} must NOT adopt the screens' rule`).toBe(false);
    }
  });

  it('each screen offers the export only when somebody IS selected', () => {
    // The route's fallback is why: a pill clicked with nobody chosen would hand back a workbook about the
    // first employee in the list. The route keeps its rule; the link is simply not drawn.
    for (const rel of REL) {
      const src = read(rel);
      expect(src).toMatch(/\{selected && \(\s*<div className="flex items-center gap-1 rounded-md/);
    }
  });

  it('the panel is fed a `.map` of the page’s OWN employee read, never a second wider one', () => {
    for (const rel of REL) {
      const src = read(rel);
      // The fence must stay the panel's fence: one `listEmployees` call per page, mapped to ScopeEmployee.
      // Counted over CODE, not prose — a comment naming the call reads to a plain match as the call itself.
      expect((code(src).match(/listEmployees\(/g) ?? []).length, `${rel} reads employees exactly once`).toBe(1);
      expect(src).toContain('const panelEmployees: ScopeEmployee[] = employees.map((e) => ({');
      // The DERIVED status is computed on the SERVER — in the browser it is wrong by a day across MYT midnight.
      expect(src).toContain("status: e.terminatedOn == null ? 'active' : 'ended',");
      // POST-GUARD, never the raw query param: `selected` has already been re-checked against that list.
      expect(src).toContain('selectedId={selected?.employmentId ?? null}');
      expect(src.includes('selectedId={sp.emp'), `${rel} must not hand the panel the raw param`).toBe(false);
    }
  });

  it('every caption the two mounts pass is PRE-TRANSLATED, never a closure', () => {
    for (const rel of REL) {
      const src = read(rel);
      for (const k of ['panelHeading', 'panelHint', 'panelHide', 'panelShow']) {
        expect(src.includes(`tInq('${k}')`), `${rel} ${k}`).toBe(true);
      }
      // A server component handing a client island a function is a 500 on every request that tsc, the whole
      // suite and `next build` stay green through (r123).
      expect(src.includes('hideLabel={tInq}')).toBe(false);
      expect(src.includes('title={tInq}')).toBe(false);
    }
    // The prompt the reporter asked for, one per screen — and they are DIFFERENT sentences.
    expect(read('app/leave/employee-balances/page.tsx')).toContain("tInq('pickEmployeeBalances')");
    expect(read('app/leave/employee-records/page.tsx')).toContain("tInq('pickEmployeeRecords')");
  });

  it('the new captions exist in all six catalogues, and the retired ones are RETIRED not deleted', () => {
    for (const loc of LOCALES) {
      const inq = (
        JSON.parse(read(`messages/${loc}.json`)) as { leave: { inquiry: Record<string, string> } }
      ).leave.inquiry;
      for (const k of ['panelHeading', 'panelHint', 'panelHide', 'panelShow', 'pickEmployeeBalances', 'pickEmployeeRecords']) {
        expect(inq[k], `leave.inquiry.${k} in ${loc}`).toBeTruthy();
        // Resolved with a bare t(...), so a {brace} here would THROW at render and paint the key path.
        expect(inq[k], `leave.inquiry.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
      /**
       * 38b94df7's five captions are RETIRED IN PLACE, never deleted. i18n/request.ts deep-merges each locale
       * over English, so a key dropped from `en` but left in `ms` still renders — absence would have to be
       * asserted in all six, and the cheaper, safer move is to leave a retired key alone. Their presence is
       * asserted here so a later tidy-up has to read this note first.
       */
      for (const k of ['empSearchPlaceholder', 'empSearchAriaLabel', 'empSearchResultsLabel', 'empSearchNoMatches', 'empSearchClear']) {
        expect(inq[k], `retired leave.inquiry.${k} must stay in ${loc}`).toBeTruthy();
      }
      // The leave-CODE search box on Balances and the RECORD search box on Records are different controls and
      // both survive the panel: only the EMPLOYEE picker moved.
      expect(inq.searchPlaceholder, `leave.inquiry.searchPlaceholder in ${loc}`).toBeTruthy();
      expect(inq.recordsSearchPlaceholder, `leave.inquiry.recordsSearchPlaceholder in ${loc}`).toBeTruthy();
      expect(inq.empSearchPlaceholder).not.toBe(inq.searchPlaceholder);
    }
  });
});
