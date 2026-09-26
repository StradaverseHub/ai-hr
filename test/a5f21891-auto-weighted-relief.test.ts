/**
 * Item a5f21891 (r344) — 'auto' MODE RELIEVES A CHILD AT ITS s.48 WEIGHT, ALL THE WAY TO THE PAYSLIP.
 *
 * ═══ WHAT r343 LEFT UNDONE, AND WHY THIS EXISTS ═══
 *
 * r343 (04b88724) made the Identification & Tax card DISPLAY the weighted figure beside the one the
 * payslip uses. It did not make the payslip use it: `childReliefAmount` reached the kernel only for
 * 'auto_table', so an 'auto' employee was relieved `num_children × perChild` and a disabled child in
 * higher education — worth 8 units, RM16,000 — was relieved RM2,000. The screen said so; the money did
 * not move. This is the other half, and it was raised as its own item precisely because it touches three
 * money-path consumers and CLAUDE.md §8 keeps money out of the tail of someone else's round.
 *
 * ═══ THE GATE THAT MAKES IT SAFE, WHICH IS THE PART WORTH READING ═══
 *
 * `childReliefGridFromFamily` SKIPS a child with no `child_relief_category` — it cannot price what it
 * cannot classify — while that same child DOES count towards the head count. So deriving the grid
 * unconditionally would relieve FEWER children than the employee has. Measured on production 2026-09-26:
 * one 'auto' employee has 2 eligible children and only 1 categorised, and would have gone from RM4,000
 * of relief to RM2,000 the moment this shipped — an over-deduction, caused by a change whose whole
 * purpose is to stop over-deducting.
 *
 * So the grid is derived ONLY when every eligible child carries a category. Otherwise it is NULLED — not
 * carried forward, because a grid that no longer describes the family is worse than no grid — and all
 * three kernel consumers fall back to `num_children × perChild`, which is exactly today's behaviour.
 * Nobody loses relief while a category is missing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { childReliefGridFromFamily, pricesChildReliefFromGrid } from '../core/dependents';
import { childReliefAmountFor } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');
/** ALL FOUR. core/dependents.ts is the one r344 left behind; naming it here is the point. */
const KERNEL_CONSUMERS = [
  'core/payroll.ts',
  'core/payroll-view.ts',
  'localization/my/multicycle-worksheet.ts',
  'core/dependents.ts',
] as const;

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
/** `childByCategory` is OPTIONAL on the ruleset (a pack predating 2026.7 omits it) — asserted present
 *  once here rather than non-null-asserted at every use, so a pack that dropped it fails loudly. */
const BY_CAT = RELIEFS.childByCategory!;
const PER_CHILD = RELIEFS.perChild;

/** One eligible child, categorised. `asOf` is fixed so no case depends on the clock. */
const ASOF = new Date('2026-06-30T00:00:00.000Z');
const child = (category: string | null, sharePercent: number | null = 100) => ({
  relationship: 'child' as const,
  dateOfBirth: '2015-01-01',
  isStudent: false,
  isDeceased: false,
  archivedAt: null,
  childTaxRelief: true,
  childReliefCategory: category,
  childReliefPercentage: sharePercent,
});

const priceOf = (rows: Parameters<typeof childReliefGridFromFamily>[0]) =>
  childReliefAmountFor(childReliefGridFromFamily(rows, ASOF).grid, RELIEFS);

// ─── (a) The money this item exists to move ──────────────────────────────────────────────────────────

describe('a5f21891 · (a) a weighted child is relieved at its weight, not as one child', () => {
  it('a disabled child in higher education prices at RM16,000, not RM2,000 — the reporter’s own case', () => {
    const weighted = priceOf([child('disabled_study')]);
    expect(weighted, 'the s.48 weight, from the pack').toBe(BY_CAT.disabled_study);
    expect(weighted, 'and it is NOT the flat head-count figure this used to give').not.toBe(PER_CHILD);
    expect(weighted).toBeGreaterThan(PER_CHILD);
  });

  it('a disabled child prices at its own weight, and a tertiary student at theirs', () => {
    expect(priceOf([child('disabled')])).toBe(BY_CAT.disabled);
    expect(priceOf([child('study_tertiary')])).toBe(BY_CAT.study_tertiary);
  });

  it('an under-18 child is UNCHANGED at one unit — the case that was right by accident must not regress', () => {
    expect(priceOf([child('under_18')])).toBe(PER_CHILD);
  });

  it('a 50% share counts half, by the same call that already halves a keyed grid', () => {
    expect(priceOf([child('disabled_study', 50)])).toBe(BY_CAT.disabled_study / 2);
  });

  it('a mixed family adds up — one under-18 plus one disabled student', () => {
    expect(priceOf([child('under_18'), child('disabled_study')])).toBe(
      PER_CHILD + BY_CAT.disabled_study,
    );
  });
});

// ─── (b) THE SAFETY GATE — the part that protects a real employee ────────────────────────────────────

describe('a5f21891 · (b) an incomplete family never prices from a partial grid', () => {
  it('a child with NO category is skipped by the grid — which is exactly why the gate is needed', () => {
    const built = childReliefGridFromFamily([child('under_18'), child(null)], ASOF);
    expect(built.eligible, 'both children are eligible').toBe(2);
    expect(built.categorised, 'but only one can be classified').toBe(1);
    // Pricing THIS grid would relieve one child where the employee has two.
    expect(childReliefAmountFor(built.grid, RELIEFS)).toBe(PER_CHILD);
  });

  it('the sync therefore stores NULL when a category is missing, rather than a partial or stale grid', () => {
    const s = src('core/dependents.ts');
    expect(s, 'completeness is what decides').toContain('built.categorised === built.eligible');
    expect(s, 'and an incomplete family clears the grid').toContain('? built.grid : null');
  });

  it('and every kernel consumer falls back to the head count when the grid is absent', () => {
    // ⚠️ THIS USED TO GREP FOR THE LITERAL CONDITION IN THREE FILES, AND THAT IS HOW r344's DEFECT
    // SURVIVED IT (r347, item 04b88724). Each consumer carried its own COPY of
    // `childReliefMode === 'auto' && x.childReliefTable != null`, so a fourth consumer —
    // `qualifyingChildBreakdown` in core/dependents.ts — could go on reading `mode === 'auto_table'`
    // while this case stayed green. The payslip relieved a disabled child at four and the card that
    // explains the figure showed one.
    //
    // There is now ONE predicate and the rule is asserted on IT. A restated copy is a defect, not a pass.
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: null }), 'a null grid never prices').toBe(false);
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: { under_18: { full: 1, half: 0 } } })).toBe(true);
    for (const f of KERNEL_CONSUMERS) {
      expect(src(f), `${f} requires a grid before pricing one`).toContain('pricesChildReliefFromGrid');
    }
  });
});

// ─── (c) All three consumers moved together ──────────────────────────────────────────────────────────

describe('a5f21891 · (c) the payslip, the preview and the worksheet widened together', () => {
  it('each consumer admits a derived grid as well as a keyed one, through the one predicate', () => {
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto_table', childReliefTable: null }), 'a keyed grid').toBe(true);
    expect(
      pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: { disabled: { full: 1, half: 0 } } }),
      'a derived grid',
    ).toBe(true);
    for (const f of KERNEL_CONSUMERS) {
      expect(src(f), `${f} reads the shared predicate`).toContain('pricesChildReliefFromGrid');
      expect(src(f), `${f} restates the condition instead of reading it`).not.toMatch(
        /childReliefMode === 'auto_table' \|\| \(\w*\.?childReliefMode === 'auto' &&/,
      );
    }
  });

  it('num_children is STILL the head count — Form E, CP8D and EA read it as one', () => {
    const s = src('core/dependents.ts');
    // The sync writes the head count, never the weighting, into that column.
    expect(s).toContain('numChildren: state.derived');
    expect(s, 'and `derived` is the plain count').toContain('derived: eligibleChildReliefCount(rows)');
  });
});

// ─── (d) The rail that would have silently skipped a category change ─────────────────────────────────

describe('a5f21891 · (d) a category change moves the figure even when the head count does not', () => {
  it('rail (b) compares the GRID as well as the count', () => {
    const s = src('core/dependents.ts');
    expect(s, 'the grid is part of "moved"').toContain('gridMoved');
    expect(s, 'and the count alone no longer short-circuits').toContain(
      'state.statutory.numChildren === state.derived && !gridMoved',
    );
  });

  it('the comparison is canonical, so JSONB key order cannot report a phantom move', () => {
    // A plain JSON.stringify compared unequal on identical grids read back from JSONB, and the sync then
    // fired on every family edit. Three existing guards caught it; this keeps it caught.
    expect(src('core/dependents.ts')).toContain('canonicalGrid');
  });
});
