/**
 * Feedback c4014f5a — Leave Entitlement table: sort moved into the Leave Type column header.
 *
 * The R44 8d422204 A–Z/Z–A sort worked, but its control was a standalone Sort dropdown above the table.
 * This item deletes the dropdown and puts the toggle on the Leave Type column heading itself — the same
 * sortable-header pattern as components/leave/leave-balance-table.tsx (scope="col", aria-sort, a button
 * with the interpolated sortBy aria-label, and the ↑/↓ text caret). Display-order only: the entSort state
 * and sortedEnts memo stay in the parent, default asc, so the table still opens A–Z.
 *
 * DB-free static-source guard (repo convention, cf. test/benefit-scheme-tier-labels.test.ts): greps the
 * component for the removed dropdown's i18n keys (NOT for select markup — the scheme-picker select
 * legitimately remains in the same toolbar) and pins the sortable-header wiring + the 6-locale i18n swap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const src = fs.readFileSync(path.join(ROOT, 'components/benefit-scheme-config.tsx'), 'utf8');

describe('standalone Sort dropdown removed', () => {
  it('no longer references the dropdown i18n keys', () => {
    expect(src).not.toContain('entSortLabel');
    expect(src).not.toContain('entSortAsc');
    expect(src).not.toContain('entSortDesc');
  });
});

describe('Leave Type column header is the sort control (leave-balance-table pattern)', () => {
  it('the header th carries scope="col" and a two-state aria-sort (never none)', () => {
    expect(src).toMatch(/<th\s+scope="col"\s+aria-sort=\{sortDir === 'asc' \? 'ascending' : 'descending'\}/);
    // This table is always sorted by leave type, so an aria-sort 'none' state must never appear.
    const ariaSortExpr = src.match(/aria-sort=\{[^}]*\}/)?.[0] ?? '';
    expect(ariaSortExpr).not.toContain("'none'");
  });

  it('the header button is wired to the toggle with the interpolated sortBy aria-label', () => {
    expect(src).toContain('onClick={onToggleSort}');
    expect(src).toContain("aria-label={t('sortBy', { column: t('colLeaveType') })}");
    // The parent threads the flip down — an unwired button is at least name-detectable.
    expect(src).toContain('onToggleSort={()');
    expect(src).toMatch(/setEntSort\(\(d\) => \(d === 'asc' \? 'desc' : 'asc'\)\)/);
  });

  it('shows the ↑/↓ caret for the current direction (same carets as the balance table)', () => {
    expect(src).toMatch(/sortDir === 'asc' \? ' ↑' : ' ↓'/);
  });
});

describe('i18n: dropdown keys dropped, sortBy added in all 6 locales', () => {
  for (const loc of LOCALES) {
    it(`${loc}.json admin.benefitScheme swaps entSort* for sortBy {column}`, () => {
      const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${loc}.json`), 'utf8')) as {
        admin: { benefitScheme: Record<string, string> };
      };
      const ns = dict.admin.benefitScheme;
      expect(ns.entSortLabel, `${loc}.entSortLabel must be removed`).toBeUndefined();
      expect(ns.entSortAsc, `${loc}.entSortAsc must be removed`).toBeUndefined();
      expect(ns.entSortDesc, `${loc}.entSortDesc must be removed`).toBeUndefined();
      expect(ns.sortBy, `${loc}.sortBy`).toBeTruthy();
      expect(ns.sortBy).toContain('{column}');
    });
  }
});
