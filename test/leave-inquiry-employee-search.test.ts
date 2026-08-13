/**
 * Searchable Employee Dropdown on the two Leave Inquiry pickers — feedback 38b94df7.
 *
 * WHAT IS ACTUALLY BEING ASSERTED, and why it is a SOURCE-shape test rather than a DOM one.
 *
 * The behaviour of the control (partial name, partial Employee ID, "emp0003" finding "EMP-0003", ranking,
 * the eight-row cap, the hidden input, Enter-to-pick) is already pinned twice over, by
 * test/employee-search-shared.test.ts (the rule) and test/employee-search-field.dom.test.tsx (the field).
 * Re-testing it here would pin the same code a third time and prove nothing about this change.
 *
 * What this change IS, is a swap of one control for another inside a GET form whose QUERY CONTRACT must not
 * move — `?emp=<employmentId>` is read back by `pickInquiryEmployee`, by both export routes and by the
 * FilterChips base action, and the "clearing filters must not clear the employee" rule depends on it. That
 * contract lives in the wiring BETWEEN two files, so a unit test of either half passes throughout (rule 17).
 * Hence: assert the composition on both pages, and assert the select is gone — a `<select name="emp">` left
 * behind on either page is the half-migration this item exists to prevent.
 *
 * The RSC pages cannot render in this suite (precedent: test/leave-inquiry-surfaces.test.ts), so the
 * composition is read from source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const PAGES = {
  'app/leave/employee-balances/page.tsx': 'balances-emp',
  'app/leave/employee-records/page.tsx': 'records-emp',
} as const;

describe('38b94df7: both Leave Inquiry employee pickers are the searchable field', () => {
  it.each(Object.keys(PAGES) as (keyof typeof PAGES)[])('%s mounts EmployeeSearchField under name="emp"', (rel) => {
    const src = read(rel);
    expect(src).toContain("import { EmployeeSearchField } from '@/components/employee-search-field';");
    expect(src).toContain('<EmployeeSearchField');
    expect(src).toMatch(/<EmployeeSearchField[\s\S]{0,400}?name="emp"/);
    // The field's `id` is what the caption's htmlFor points at — the control is a div wrapping two inputs,
    // so a <label> wrapping it would be labelling whichever input happens to come first.
    expect(src).toContain(`id="${PAGES[rel]}"`);
    expect(src).toContain(`htmlFor="${PAGES[rel]}"`);
  });

  it.each(Object.keys(PAGES) as (keyof typeof PAGES)[])('%s no longer renders a <select name="emp">', (rel) => {
    const src = read(rel);
    expect(src.includes('<select name="emp"')).toBe(false);
    // The old option label was `${e.company} · ${e.name} (${e.employeeCode})`. Its absence is the proof the
    // whole-list render is gone, not merely hidden behind the new control.
    expect(src.includes('{e.employeeCode ? ` (${e.employeeCode})` : \'\'}')).toBe(false);
  });

  it('the query contract is UNCHANGED: ?emp= is still what both pages read and write', () => {
    for (const rel of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const src = read(rel);
      // Read back the same way as before the swap.
      expect(src).toContain('pickInquiryEmployee(employees, sp.emp)');
      // And written the same way into every outgoing link.
      expect(src).toContain("p.set('emp', selected.employmentId)");
    }
    // "Clearing filters must not clear the employee" (the chip base action) still carries the selection.
    expect(read('app/leave/employee-balances/page.tsx')).toContain(
      "const chipAction = `/leave/employee-balances${selected ? `?emp=${selected.employmentId}` : ''}`",
    );
  });

  it('every option row carries name, Employee ID and company — the two-people-same-name case', () => {
    for (const rel of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const src = read(rel);
      for (const field of ['value: e.employmentId,', 'name: e.name,', 'employeeCode: e.employeeCode,', 'secondary: e.company,']) {
        expect(src.includes(field), `${rel} ${field}`).toBe(true);
      }
    }
  });

  it('captions are resolved on the page and passed as PLAIN STRINGS (no closure over the RSC boundary)', () => {
    for (const rel of Object.keys(PAGES) as (keyof typeof PAGES)[]) {
      const src = read(rel);
      for (const k of ['empSearchPlaceholder', 'empSearchAriaLabel', 'empSearchResultsLabel', 'empSearchNoMatches', 'empSearchClear']) {
        expect(src.includes(`tInq('${k}')`), `${rel} ${k}`).toBe(true);
      }
      // A server component handing a client island a function is a 500 on every request that tsc, the whole
      // suite and `next build` stay green through (r123). `labels={t}` / `labels={tInq}` is that mistake.
      expect(src).toMatch(/labels=\{empSearchLabels\}/);
      expect(src.includes('labels={tInq}')).toBe(false);
    }
  });

  it('the five captions exist in all six catalogues and take no ICU argument', () => {
    for (const loc of LOCALES) {
      const inq = (
        JSON.parse(read(`messages/${loc}.json`)) as { leave: { inquiry: Record<string, string> } }
      ).leave.inquiry;
      for (const k of ['empSearchPlaceholder', 'empSearchAriaLabel', 'empSearchResultsLabel', 'empSearchNoMatches', 'empSearchClear']) {
        expect(inq[k], `leave.inquiry.${k} in ${loc}`).toBeTruthy();
        // Resolved with a bare t(...), so a {brace} here would THROW at render and paint the key path.
        expect(inq[k], `leave.inquiry.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
      // The leave-CODE search box beside it keeps its OWN caption. These are two different controls and the
      // item explicitly does not merge them, so `searchPlaceholder` must survive the addition.
      expect(inq.searchPlaceholder, `leave.inquiry.searchPlaceholder in ${loc}`).toBeTruthy();
      expect(inq.empSearchPlaceholder).not.toBe(inq.searchPlaceholder);
    }
  });
});
