/**
 * Item 9653472a (r345) — THE CHILDREN WITH NO RELIEF CATEGORY, WHICH IS WHAT HOLDS THE WEIGHTING SHUT.
 *
 * ═══ WHY THIS LIST EXISTS ═══
 *
 * r344 made an 'auto' employee's relief price from the Family register's s.48 categories. It gated the
 * derived grid on `built.categorised === built.eligible` — every eligible child must carry a category or
 * the grid is NULLED and all three consumers fall back to `num_children × perChild`.
 *
 * That gate is CORRECT and this item does not touch it. `childReliefGridFromFamily` SKIPS a child it
 * cannot classify, so pricing a partial grid relieves FEWER children than the employee has: production
 * held one 'auto' employee who would have gone from RM4,000 to RM2,000 the moment r344 shipped without
 * it. The gate's consequence, though, is that the weighting reaches NOBODY until the categories are
 * filled in — and nothing on any screen said so. This is that list.
 *
 * ═══ THE CORRECTION THIS ITEM CARRIES ═══
 *
 * The `a5f21891` raise said "three employees on Auto, two children counted where the rules count five,
 * RM6,000 not given". Wrong twice: it filtered dependents on `child_tax_relief = true`, which DROPS a
 * child whose flag is NULL but who is eligible anyway, and it weighted UNCATEGORISED children as one
 * unit, which the grid cannot do at all. The eligibility rule is `isChildReliefEligible` and this module
 * reuses it rather than re-expressing it in SQL — which is the mistake being corrected.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isChildReliefEligible, childReliefGridFromFamily } from '../core/dependents';
import { hasCategoryGap } from '../core/child-relief-review';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
const REVIEW = 'core/child-relief-review.ts';
const TABLE = 'components/child-relief-review-table.tsx';
const PAGE = 'app/admin/personnel/child-relief/page.tsx';

/** `people`-shaped rows, only the fields the subset filter reads. */
const person = (mode: string, eligible: number, categorised: number) => ({
  mode,
  familyEligible: eligible,
  familyCategorised: categorised,
});
/** THE PRODUCTION PREDICATE ITSELF — never a local restatement of it. See `hasCategoryGap`'s own note:
 *  the first cut of this file re-stated the rule here, and loosening the real filter left every case
 *  below green. */
const gapped = <T extends { mode: string; familyEligible: number; familyCategorised: number }>(rows: T[]) =>
  rows.filter(hasCategoryGap);

const ASOF = new Date('2026-06-30T00:00:00.000Z');
const child = (category: string | null, over18 = false) => ({
  relationship: 'child' as const,
  dateOfBirth: over18 ? '2000-01-01' : '2015-01-01',
  isStudent: false,
  isDeceased: false,
  archivedAt: null,
  childTaxRelief: null,
  childReliefCategory: category,
  childReliefPercentage: 100,
});

// ─── (a) Who appears, and who does not ───────────────────────────────────────────────────────────────

describe('9653472a · (a) the list carries exactly the rows that can act on it', () => {
  it('an auto employee with an uncategorised eligible child appears', () => {
    expect(gapped([person('auto', 3, 1)])).toHaveLength(1);
  });

  it('one whose every eligible child is categorised does NOT — there is no gap to report', () => {
    expect(gapped([person('auto', 3, 3)])).toHaveLength(0);
    expect(gapped([person('auto_table', 2, 2)])).toHaveLength(0);
  });

  it('auto_table is carried as well as auto — both price from the grid', () => {
    expect(gapped([person('auto_table', 2, 0)])).toHaveLength(1);
  });

  it('a MANUAL employee is absent, even with every category missing', () => {
    // On 'manual' the typed figure decides and a category changes nothing, so listing them would put an
    // action on screen that has no effect. `recordDisagreement` is the list that covers typed figures.
    expect(gapped([person('manual', 5, 0)])).toHaveLength(0);
  });

  it('an unrecognised stored mode is absent too — the filter names the two it trusts', () => {
    expect(gapped([person('', 2, 0)])).toHaveLength(0);
    expect(gapped([person('auto_v2', 2, 0)])).toHaveLength(0);
  });

  it('an employee with no children on file is absent', () => {
    expect(gapped([person('auto', 0, 0)])).toHaveLength(0);
  });
});

// ─── (b) The count is the eligibility rule's, not a SQL re-expression ────────────────────────────────

describe('9653472a · (b) eligibility is core/dependents’ own rule — the thing a5f21891 got wrong', () => {
  it('a child whose relief FLAG is null but who is under 18 IS eligible', () => {
    // This is the exact row the a5f21891 raise dropped with `where child_tax_relief = true`.
    expect(isChildReliefEligible({ ...child(null) }, ASOF)).toBe(true);
  });

  it('an uncategorised child counts as ELIGIBLE but NOT as categorised — which is the whole gap', () => {
    const built = childReliefGridFromFamily([child('under_18'), child(null)], ASOF);
    expect(built.eligible, 'both are eligible').toBe(2);
    expect(built.categorised, 'only one can be classified').toBe(1);
    expect(built.eligible).toBeGreaterThan(built.categorised);
  });

  it('the review module reuses the rule rather than re-expressing it in SQL', () => {
    const s = src(REVIEW);
    expect(s, 'the subset is built from the exported predicate').toContain('people.filter(hasCategoryGap)');
    expect(s, 'which compares the counts the single walk already produced').toContain(
      'p.familyEligible > p.familyCategorised',
    );
  });
});

// ─── (c) The total, and that it is a subset of the same objects ─────────────────────────────────────

describe('9653472a · (c) the headline count is the children, not the employees', () => {
  it('uncategorised children sum across employees', () => {
    const rows = [person('auto', 3, 1), person('auto_table', 2, 0), person('auto', 1, 1)];
    const g = gapped(rows);
    expect(g).toHaveLength(2);
    expect(g.reduce((n, x) => n + (x.familyEligible - x.familyCategorised), 0)).toBe(2 + 2);
  });

  it('it is a SUBSET of `people`, so there is no second walk and no second arithmetic', () => {
    const s = src(REVIEW);
    expect(s, 'built by filtering the people already walked').toContain('const gapped = people.filter(');
    expect(s).toContain('categoryGap: {');
  });
});

// ─── (d) What the screen must NOT say ───────────────────────────────────────────────────────────────

describe('9653472a · (d) the screen states a gap, never a fault, and never a figure it cannot stand behind', () => {
  it('no "you could be relieving RM x" column — an uncategorised child’s weight is unknowable', () => {
    const s = src(TABLE);
    // The whole point: a child nobody has categorised could be worth 1 unit or 8. A "potential relief"
    // column would be a number this repo cannot stand behind, which CLAUDE.md §8 forbids on exactly
    // this kind of screen. Only checkable facts are printed.
    expect(s).toContain('ChildReliefCategoryGapTable');
    expect(s, 'the gap row prints no projected or potential amount').not.toMatch(
      /gapCol(Potential|Could|Forgone|Missed)RM/,
    );
  });

  it('there is no bulk action anywhere near it', () => {
    const s = src(TABLE);
    const gap = s.slice(s.indexOf('export function ChildReliefCategoryGapTable'));
    for (const forbidden of ['<form', '<button', 'onClick', 'checkbox']) {
      expect(gap, `the gap table has no ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the wording calls it a gap and explicitly not a mistake, in every locale', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>;
      const cr = m.people?.childRelief;
      for (const k of [
        'gapTitle',
        'gapDescription',
        'gapStatPeople',
        'gapStatChildren',
        'gapColEligible',
        'gapColCategorised',
        'gapColMissing',
        'gapColTodayRM',
        'gapOpenFamily',
        'gapWhyNote',
        'gapNotAnErrorNote',
        'gapNoBulkNote',
        'gapManualNote',
      ]) {
        expect(cr?.[k], `${loc}.people.childRelief.${k}`).toBeTruthy();
      }
    }
  });

  it('the page renders the card only when there is something in it', () => {
    expect(src(PAGE)).toContain('view.categoryGap.people.length > 0');
  });
});

// ─── (e) r344's gate is NOT loosened by this item ────────────────────────────────────────────────────

describe('9653472a · (e) the gate that makes the gap matter is untouched', () => {
  it('the grid is still stored only when every eligible child carries a category', () => {
    // If a later round "fixes" the gap by deriving a partial grid, this list stops meaning anything and
    // the employee it was meant to help loses relief. That is the near miss r344 recorded.
    expect(src('core/dependents.ts')).toContain('built.categorised === built.eligible');
    expect(src('core/dependents.ts')).toContain('? built.grid : null');
  });
});
