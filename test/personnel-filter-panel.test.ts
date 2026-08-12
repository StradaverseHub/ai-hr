/**
 * Consolidated filter panel (feedback 3542ed4a) — static-source guard.
 *
 * The Personnel list pages (/personnel and /admin/personnel) replaced their inline 5-control filter
 * row with one top-right Filter button opening a floating panel (components/filter-panel.tsx), plus
 * removable active-filter chips. This was a PURE UI reskin: the searchParams contract
 * ({ q, company, dept, status, type, page }) and the listEmployeesPage query path are unchanged —
 * test/people-filters.test.ts continues to prove the data layer independently.
 *
 * This guard fails loudly if a future edit (a) half-reverts a page back to the inline select row,
 * (b) drops a URL param from the contract, (c) strips the client/GET/a11y fundamentals from the
 * panel component, or (d) removes one of the panel's i18n keys from en.json. It is intentionally
 * DB-free and jsdom-free (the suite has no DOM test runner) so it runs fast and deterministically.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const PAGES = [
  { file: 'app/personnel/page.tsx', action: '/personnel' },
  { file: 'app/admin/personnel/page.tsx', action: '/admin/personnel' },
] as const;

describe('Personnel filter panel: both pages use the consolidated component', () => {
  for (const { file, action } of PAGES) {
    const src = read(file);

    it(`${file} imports FilterPanel + FilterChips from @/components/filter-panel`, () => {
      expect(src).toMatch(/import\s*\{[^}]*FilterPanel[^}]*\}\s*from\s*'@\/components\/filter-panel'/);
      expect(src).toMatch(/FilterChips/);
      // Mounted with the page's own base path so Apply/Clear/chips stay on the right route.
      expect(src.includes(`action="${action}"`)).toBe(true);
    });

    it(`${file} no longer renders the old inline filter row`, () => {
      // The retired flat row rendered raw <select name="company">…</select> etc. directly in the page.
      // (The admin hire form's selects use different names — companyId, departmentId — so this stays
      // specific to the filter row.)
      expect(src.includes('<select name="company"')).toBe(false);
      expect(src.includes('<select name="dept"')).toBe(false);
      expect(src.includes('<select name="status"')).toBe(false);
      expect(src.includes('<select name="type"')).toBe(false);
    });

    it(`${file} preserves the searchParams URL contract (q, company, dept, status, type, page)`, () => {
      // 579255c3 — the ADMIN listing's params and their translation into listEmployeesPage arguments moved
      // out of the page and into app/admin/personnel/list-query.ts, so that the Excel export can be built
      // from the SAME parse the screen uses (point 9: "the export should respect the selected filters").
      // The contract is asserted where it now lives rather than dropped: a param that disappears from the
      // shared module, or a page that stops feeding it through, still fails here.
      const contract = file.startsWith('app/admin/') ? read('app/admin/personnel/list-query.ts') : src;
      for (const param of ['q?: string', 'page?: string', 'company?: string', 'dept?: string', 'status?: string', 'type?: string']) {
        expect(contract.includes(param), `${param} in the ${file} contract`).toBe(true);
      }
      for (const arg of ['companyId: company', 'departmentId: dept', 'employmentType: type']) {
        expect(contract.includes(arg), `${arg} in the ${file} contract`).toBe(true);
      }
      // The lifecycle `status` narrowing is still HONOURED — nothing writes it any more, but an existing
      // bookmark must keep narrowing exactly as it did.
      expect(contract.includes(file.startsWith('app/admin/') ? 'status: legacyStatus' : 'status: statusFilter')).toBe(true);
      if (file.startsWith('app/admin/')) {
        // …and the page must actually feed the parsed filters through, not re-derive its own.
        expect(src).toContain('parsePersonnelListQuery(sp)');
        expect(src).toContain('...query.filters');
      }
    });
  }

  it('the onboarding tour anchor people-search survives on the admin page (moved onto the Filter button)', () => {
    const src = read('app/admin/personnel/page.tsx');
    expect(src.includes('dataTour="people-search"') || src.includes('data-tour="people-search"')).toBe(true);
  });
});

describe('Personnel filter panel: component fundamentals', () => {
  const src = read('components/filter-panel.tsx');

  it('is a client island', () => {
    expect(src.startsWith("'use client'")).toBe(true);
  });

  it('keeps the GET-form semantics (no-JS submit, URL-carried filters)', () => {
    expect(src.includes('method="get"')).toBe(true);
    expect(src).toMatch(/action=\{action\}/);
    // Apply is a real submit; Clear all is a plain link back to the page's own base path. Feedback
    // 650b6eb8 gave that base an optional set of FOREIGN params (`hidden`) so a page carrying two
    // independently filtered listings can clear one without clearing the other — hence the helper rather
    // than the bare `action` this used to assert. A page that passes no `hidden` still links to `action`.
    expect(src.includes('type="submit"')).toBe(true);
    expect(src).toMatch(/href=\{baseHref\(action, hidden\)\}/);
    expect(src).toContain('return s ? `${action}?${s}` : action;');
  });

  it('has the popover a11y hooks (mirrors company-switcher pattern)', () => {
    expect(src.includes('aria-expanded={open}')).toBe(true);
    expect(src.includes('aria-haspopup="dialog"')).toBe(true);
    expect(src.includes('role="dialog"')).toBe(true);
    expect(src.includes("e.key === 'Escape'")).toBe(true);
  });

  it('chips remove exactly one param and expose a removable ✕ link', () => {
    expect(src.includes('hrefWithout')).toBe(true);
    expect(src.includes('removeAriaLabel')).toBe(true);
  });
});

describe('Personnel filter panel: i18n keys exist in en.json', () => {
  it('people.list carries the panel strings', () => {
    const en = JSON.parse(read('messages/en.json')) as {
      people: { list: Record<string, string> };
    };
    for (const key of ['filter', 'applyFilters', 'clearAllFilters', 'activeFilters', 'removeFilter']) {
      expect(en.people.list[key], `people.list.${key}`).toBeTruthy();
    }
    // Locale completeness for these keys (all 6 files) is enforced by test/i18n-coverage.test.ts check A.
  });
});
