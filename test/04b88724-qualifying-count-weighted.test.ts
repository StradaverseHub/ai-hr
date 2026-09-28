/**
 * Item 04b88724 (r347) — THE SCREEN AND THE PAYSLIP AGREE ABOUT WHAT A WEIGHTED CHILD IS WORTH.
 *
 * ═══ THE DEFECT, AND IT WAS r344's — MINE ═══
 *
 * r344 taught the money paths to price the DERIVED s.48 grid on `'auto'` as well as `'auto_table'`:
 *
 *     core/payroll.ts · core/payroll-view.ts · localization/my/multicycle-worksheet.ts
 *       childReliefMode === 'auto_table' || (childReliefMode === 'auto' && childReliefTable != null)
 *
 * It did NOT widen the fourth consumer, `qualifyingChildBreakdown` in core/dependents.ts, which still
 * read `mode === 'auto_table'`. So an `'auto'` employee whose grid IS derived was relieved at the s.48
 * weight on their payslip while the Identification & Tax card that EXPLAINS that figure showed the plain
 * head count. The reporter found it on a named employee: one disabled child, card showing 1 where the
 * payslip used 4.
 *
 * Each of the three kernel sites carried its OWN COPY of the condition, which is exactly why widening
 * three of four looked complete. All four now read one exported predicate,
 * `pricesChildReliefFromGrid`, so a fifth consumer gets it right by construction.
 *
 * ═══ WHAT THIS FILE REFUSES TO LET SLIP ═══
 *
 * The gate itself. `syncChildReliefFromFamily` stores the grid only when EVERY eligible child carries a
 * category, because `childReliefGridFromFamily` skips a child it cannot classify and a partial grid
 * would relieve FEWER children than the employee has. A null grid must keep falling back to the head
 * count in ALL FOUR places — the screen included, which is the half that was missing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pricesChildReliefFromGrid, childReliefGridFromFamily } from '../core/dependents';
import { childReliefAmountFor } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = (p: string) => readFileSync(new URL(p, `file://${root}`), 'utf8');

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const BY_CAT = RELIEFS.childByCategory!;
const PER_CHILD = RELIEFS.perChild;

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

// ─── (a) The reporter's own case ─────────────────────────────────────────────────────────────────────

describe('04b88724 · (a) Daniel Tan: one disabled child is four qualifying children', () => {
  it('a disabled child prices at four, not one — the figure the reporter expected', () => {
    const built = childReliefGridFromFamily([child('disabled')], ASOF);
    expect(built.eligible).toBe(1);
    expect(built.categorised, 'so the grid is stored, and the weighting applies').toBe(1);
    const rm = childReliefAmountFor(built.grid, RELIEFS);
    expect(rm, 'RM8,000 — four qualifying children at RM2,000').toBe(BY_CAT.disabled);
    expect(rm / PER_CHILD, 'expressed as qualifying children').toBe(4);
    expect(rm).not.toBe(PER_CHILD);
  });

  it('a disabled child in qualifying higher education is eight', () => {
    const built = childReliefGridFromFamily([child('disabled_study')], ASOF);
    expect(childReliefAmountFor(built.grid, RELIEFS) / PER_CHILD).toBe(8);
  });

  it('an under-18 child is still one — the case that was right already must not move', () => {
    const built = childReliefGridFromFamily([child('under_18')], ASOF);
    expect(childReliefAmountFor(built.grid, RELIEFS) / PER_CHILD).toBe(1);
  });
});

// ─── (b) ONE predicate, and every consumer reads it ─────────────────────────────────────────────────

describe('04b88724 · (b) the screen cannot disagree with the payslip again', () => {
  it('the predicate admits a derived grid on auto, and auto_table always', () => {
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto_table', childReliefTable: null })).toBe(true);
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: { disabled: { full: 1, half: 0 } } })).toBe(true);
  });

  it('…and refuses a NULL grid on auto, which is the safety gate r344 added', () => {
    // A null grid means "cannot be priced by category yet" — pricing a partial one would relieve fewer
    // children than the employee has. Production held an employee who would have gone RM4,000 → RM2,000.
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: null })).toBe(false);
    expect(pricesChildReliefFromGrid({ childReliefMode: 'auto', childReliefTable: undefined })).toBe(false);
  });

  it('manual and any unrecognised mode price from the head count', () => {
    for (const m of ['manual', '', 'auto_v2', null, undefined]) {
      expect(
        pricesChildReliefFromGrid({ childReliefMode: m as string, childReliefTable: { disabled: { full: 1, half: 0 } } }),
        `mode ${String(m)}`,
      ).toBe(false);
    }
  });

  it('ALL FOUR consumers read the predicate, and none restates the condition', () => {
    const consumers = [
      'core/payroll.ts',
      'core/payroll-view.ts',
      'localization/my/multicycle-worksheet.ts',
      'core/dependents.ts',
    ];
    for (const f of consumers) {
      const s = src(f);
      expect(s, `${f} reads the shared predicate`).toContain('pricesChildReliefFromGrid');
      // The literal condition, restated, is what let r344 widen three of four and look finished.
      expect(s, `${f} restates the condition instead of reading it`).not.toMatch(
        /childReliefMode === 'auto_table' \|\| \(\w*\.?childReliefMode === 'auto' &&/,
      );
    }
  });

  it('the display gate is no longer keyed on the mode alone', () => {
    const s = src('core/dependents.ts');
    // The exact shape of the defect: `mode === 'auto_table' ? priceTable : headCount`.
    expect(s).not.toMatch(/const figure =\s*\n\s*mode === 'auto_table'/);
  });
});

// ─── (c) The card is told which rule produced its figure ────────────────────────────────────────────

describe('04b88724 · (c) the notes under the table branch on what happened, not on the mode', () => {
  it('the breakdown reports whether it was priced from the grid', () => {
    const s = src('core/dependents.ts');
    // ⚠️ REWORDED IN r351, AND THE REASON IS WHAT THE FLAG IS NOW A FLAG ABOUT. It used to be asserted as
    // the literal `pricedFromGrid: pricesChildReliefFromGrid(` in the returned object, because the predicate
    // was called inline there over `statutory.childReliefTable`. r351 prices the auto modes from
    // `pricingTable` — the grid DERIVED from the Family register in 'auto', the stored one in 'auto_table' —
    // so the flag is computed ONCE, beside the figure, from the same table the figure was priced from. That
    // is a stronger property than "the predicate appears in the return", and it is the one that matters: a
    // flag taken from a different table than the money is a screen note that contradicts its own number,
    // which is exactly the r347 defect this case was written for. So it is pinned instead.
    expect(s, 'the flag is returned').toContain('pricedFromGrid,');
    expect(
      s,
      'and it is decided by the SAME table the figure is priced from, not by a second read of the column',
    ).toContain('pricesChildReliefFromGrid({ childReliefMode: mode, childReliefTable: pricingTable })');
    expect(s, 'and declared on the type').toMatch(/pricedFromGrid: boolean;/);
  });

  it('the card renders the head-count note ONLY when the figure really is the head count', () => {
    const s = src('components/identity-tax-card.tsx');
    expect(s).toContain("mode === 'auto' && !childRelief.pricedFromGrid");
    expect(s).toContain("mode === 'auto' && childRelief.pricedFromGrid");
  });

  it('every new and rewritten string resolves in all six locales', () => {
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(src(`messages/${loc}.json`)) as Record<string, any>;
      const d = m.people?.detail;
      for (const k of [
        'childQualifyingAutoUnitsNote',
        'childQualifyingAutoWeightedNote',
        'childQualifyingWeightingGap',
        'childQualifyingWeightingGapOver',
      ]) {
        expect(d?.[k], `${loc}.people.detail.${k}`).toBeTruthy();
      }
    }
  });

  it('no string still claims Auto counts every child as one, or that only auto_table prices categories', () => {
    const en = JSON.parse(src('messages/en.json')) as Record<string, any>;
    const d = en.people.detail as Record<string, string>;
    // Both claims were true before r344 and false after it. The head-count note may still describe
    // counting one each — but only as the consequence of a MISSING CATEGORY, which it now names.
    expect(d.childQualifyingAutoUnitsNote).toMatch(/no relief category/i);
    for (const k of ['childQualifyingWeightingGap', 'childQualifyingWeightingGapOver']) {
      expect(d[k], `${k} still points at auto_table as the only weighted mode`).not.toMatch(
        /Auto \(from table\) is the mode that prices/i,
      );
    }
  });
});

// ─── (d) Physical children and qualifying children stay two figures ─────────────────────────────────

describe('04b88724 · (d) the head count is not replaced by the weighted count', () => {
  it('num_children remains the head count — Form E, CP8D and the EA read it as one', () => {
    const s = src('core/dependents.ts');
    expect(s).toContain('numChildren: state.derived');
    // ⚠️ r351 — THE ARGUMENT LIST GREW AND THE DECISION DID NOT. The sync now passes its own KL `asOf` into
    // the count (it used to take `new Date()` through the parameter default, which is real UTC now and
    // therefore YESTERDAY between 00:00 and 08:00 Kuala Lumpur — a day behind the two screens that already
    // resolve `todayInKualaLumpur()`, on the one day the eligibility rule turns on). Pinning the literal
    // `eligibleChildReliefCount(rows)` would have made that correction look like a regression. What this
    // case is actually for is that the value written to `num_children` is the plain HEAD COUNT and never the
    // weighted one, so that is what is asserted — with the weighted function named, so a swap cannot pass.
    expect(s, 'the head-count function is what feeds the column').toContain('derived: eligibleChildReliefCount(');
    expect(s, 'and the WEIGHTED figure never does — Form E / CP8D / EA would print 8 children for one').not.toContain(
      'derived: eligibleChildReliefUnits(',
    );
  });

  it('one physical disabled child is 1 physical and 4 qualifying — the reporter’s stated requirement', () => {
    const rows = [child('disabled')];
    const built = childReliefGridFromFamily(rows, ASOF);
    expect(built.eligible, 'physical / eligible children').toBe(1);
    expect(childReliefAmountFor(built.grid, RELIEFS) / PER_CHILD, 'qualifying children (PCB)').toBe(4);
  });
});

// ─── (e) r344's completeness gate survives this round ───────────────────────────────────────────────

describe('04b88724 · (e) an incomplete record still falls back, in all four places', () => {
  it('the grid is still stored only when every eligible child carries a category', () => {
    expect(src('core/dependents.ts')).toContain('built.categorised === built.eligible');
    expect(src('core/dependents.ts')).toContain('? built.grid : null');
  });

  it('a family with one uncategorised child yields a grid that prices FEWER children than exist', () => {
    // This is why the gate exists, and why this round does not loosen it.
    const built = childReliefGridFromFamily([child('disabled'), child(null)], ASOF);
    expect(built.eligible).toBe(2);
    expect(built.categorised).toBe(1);
    expect(childReliefAmountFor(built.grid, RELIEFS) / PER_CHILD, 'only the categorised one is priced').toBe(4);
  });
});
