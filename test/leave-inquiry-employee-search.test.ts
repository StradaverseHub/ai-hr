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
  'app/(app)/leave/employee-balances/page.tsx': 'leave-balances-panel',
  'app/(app)/leave/employee-records/page.tsx': 'leave-records-panel',
} as const;
type Page = keyof typeof PAGES;
const REL = Object.keys(PAGES) as Page[];

/** 38b94df7's own `id`s, kept here as the names being retired so their absence is asserted by name. */
const RETIRED_FIELD_IDS = {
  'app/(app)/leave/employee-balances/page.tsx': 'balances-emp',
  'app/(app)/leave/employee-records/page.tsx': 'records-emp',
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
      expect(src).toContain('await leaveInquiryContext(session, scopeIds, query)');
      expect(src.includes('pickInquiryEmployee('), `${rel} must not fall back to the first employee`).toBe(false);
      // And the selection is written the same way into every outgoing link.
      expect(src).toContain("p.set('emp', selected.employmentId)");
      // The employee still rides the screen's own GET form, so submitting a date or a search cannot clear it.
      expect(src).toContain('<input type="hidden" name="emp" value={selected.employmentId} />');
    }
    // 23e87eef: chips carry the employee and date through their foreign hidden parameters.
    expect(read('app/(app)/leave/employee-balances/page.tsx')).toContain(
      "const chipAction = '/leave/employee-balances';",
    );
  });

  it('23e87eef: BOTH exports use the same explicit All/single authorization and complete filtered query', () => {
    for (const rel of ['app/(app)/leave/employee-balances/export/route.ts', 'app/(app)/leave/employee-records/export/route.ts']) {
      const src = code(read(rel));
      // 934ec5a8c deliberately moved authorization AND every chunk into one read-only snapshot.
      // Pin the stronger contract, including the Tx handed into each canonical row reader.
      expect(src).toContain("if (!isAdmin(session)) return new Response('Forbidden', { status: 403 })");
      expect(src).toContain('await leaveInquirySnapshot(session, scopeIds, query, async (tx, inquiry) => ({');
      expect(src).toContain('selected: inquiry.selected');
      expect(src).toContain('collectInquiryExport(');
      expect(src).toContain(rel.includes('employee-balances')
        ? 'inquiryBalancePage(session, inquiry, query, locale, window, tx)'
        : 'leaveInquiryRecordsPageTx(tx, session, inquiry, query, window)');
      expect(src).not.toContain('pickInquiryEmployee(');
    }
    for (const rel of REL) {
      const src = code(read(rel));
      expect(src).toContain('allowAll'); expect(src).toContain('resetToAll');
      expect(src).not.toMatch(/\{selected && \(\s*<div className="flex items-center gap-1 rounded-md/);
    }
    const owner = code(read('core/leave-inquiry.ts'));
    const from = owner.indexOf('export function leaveInquirySnapshot<T>(');
    const to = owner.indexOf('export function leaveInquiryRecordsPage(', from);
    expect(from, 'shared snapshot wrapper exists').toBeGreaterThan(-1);
    expect(to, 'shared snapshot wrapper closes').toBeGreaterThan(from);
    expect(owner.slice(from, to)).toContain('read(tx, await leaveInquiryContextTx(tx, ctx, companyIds, query))');
    expect(owner.slice(from, to)).toContain('{ readOnlySnapshot: true }');
  });

  it('the panel is fed a `.map` of the page’s OWN employee read, never a second wider one', () => {
    for (const rel of REL) {
      const src = read(rel);
      // The page and panel consume the same authorized context. The context's one Tx membership read
      // is bounded by adminCompanies AND the selected-company fence, and [] never means unrestricted.
      expect(code(src)).toContain('const employees = sortInquiryEmployees(inquiry.employees, locale)');
      expect(code(src).match(/await leaveInquiryContext\(session, scopeIds, query\)/g)).toHaveLength(1);
      expect(code(src)).not.toMatch(/\blistEmployees(?:Tx)?\(/);
      const owner = code(read('core/leave-inquiry.ts'));
      const from = owner.indexOf('async function leaveInquiryContextTx(');
      const to = owner.indexOf('function authorizedScope(', from);
      expect(from, 'canonical membership reader exists').toBeGreaterThan(-1);
      expect(to, 'canonical membership reader closes').toBeGreaterThan(from);
      const membership = owner.slice(from, to);
      expect(membership).toContain("if (!isAdmin(ctx)) throw new InquiryQueryError('Forbidden')");
      expect(membership).toContain('const companies = (await adminCompaniesTx(tx)).filter(c => selectedCompanyIds.includes(c.id))');
      expect(membership).toContain('const companyIds = companies.map(c => c.id)');
      expect(membership).toContain('const employees = companyIds.length ? await listEmployeesTx(tx, companyIds) : []');
      expect(membership.match(/\blistEmployeesTx\(/g)).toHaveLength(1);
      expect(membership).toContain('employees.find(e => e.employmentId === query.emp)');
      expect(membership).toContain("if (query.emp && !selected) throw new InquiryQueryError('Employee is unavailable in the selected companies')");
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
    expect(read('app/(app)/leave/employee-balances/page.tsx')).toContain("tInq('allEmployeesHeader'");
    expect(read('app/(app)/leave/employee-records/page.tsx')).toContain("tInq('allEmployeesHeader'");
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
