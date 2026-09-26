/**
 * r343 · item 04b88724 — THE s.48 WEIGHTING, AND THE HEAD COUNT THAT MUST NOT MOVE WITH IT.
 *
 * WHAT WAS WRONG. `core/dependents.ts eligibleChildReliefCount` is a plain head count; the 'auto' sync
 * writes it to `employee_statutory_my.num_children`; and for every mode but 'auto_table' the kernel's child
 * leg is `num_children × perChild` (core/payroll.ts and core/payroll-view.ts both gate the worked amount on
 * `childReliefMode === 'auto_table'`). So an 'auto' employee is relieved HEADS × RM2,000: a child 18+ in
 * diploma-or-above study, and a disabled child, are each worth FOUR qualifying children under s.48 and
 * receive one; a disabled child in that study is worth EIGHT and receives one. Under-relieving
 * OVER-deducts PCB every month.
 *
 * WHAT THIS FILE PINS. `eligibleChildReliefUnits` — the weighted figure — and the fact that
 * `eligibleChildReliefCount` STAYED a head count, which is the decision the item turned on: `num_children`
 * is read as a head count by Form E and CP8D (localization/my/reports.ts, printed by `CP8D_COLS`) and by the
 * EA statement (the same select in `eaStatement`, printed into EA item 8 by lib/ea-pdf.ts) — the r343 fix
 * pass corrected this citation, which used to point at db/schema.ts, where no such note exists. A weighted
 * figure written to that column would declare an employee with one disabled higher-education child as
 * having eight children.
 *
 * ⚠️ NOT ONE UNIT IS TYPED OUT BELOW. Every expected weight is `childReliefPrices(RELIEFS)`'s own `units`
 * for that category, and every expected ringgit is the PAYROLL KERNEL's own `childReliefAmountFor` over the
 * same derived grid. r339 corrected two of the five figures against the specification's printed p.27; a
 * literal here would have to be corrected a second time and would silently disagree in between.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MY_STATUTORY, CHILD_RELIEF_CATEGORY_KEYS } from '../localization/my/statutory-tables';
import { childReliefAmountFor } from '../localization/my/payroll';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import {
  childReliefGridFromFamily as gridFromReviewModule,
} from '../core/child-relief-review';
import {
  childReliefGridFromFamily,
  eligibleChildReliefCount,
  eligibleChildReliefUnits,
  type ChildReliefCategorisedRow,
} from '../core/dependents';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const PRICES = childReliefPrices(RELIEFS);
/** The pack's own price for a category, as a qualifying-children count. Never a literal. */
const unitsOf = (key: string) => PRICES.find((p) => p.key === key)!.units;
const ASOF = new Date('2026-06-01T00:00:00Z');

const child = (over: Partial<ChildReliefCategorisedRow> = {}): ChildReliefCategorisedRow =>
  ({
    relationship: 'child',
    // Comfortably under 18 at ASOF, so eligibility never depends on a birthday.
    dateOfBirth: '2016-01-01',
    isStudent: false,
    isDeceased: false,
    archivedAt: null,
    childTaxRelief: null,
    childReliefCategory: 'under_18',
    childReliefPercentage: 100,
    ...over,
  }) as ChildReliefCategorisedRow;

/** The one call under test, bound to the pack exactly as core/dependents.ts binds it in production. */
const unitsFor = (rows: ChildReliefCategorisedRow[]) =>
  eligibleChildReliefUnits(rows, { prices: PRICES, childReliefFor, asOf: ASOF });

describe('04b88724 · (a) one child under 18 is still worth ONE — the reporter’s own case', () => {
  it('weighs 1 unit, and 1 is what the pack prices that category at', () => {
    const f = unitsFor([child({ childReliefCategory: 'under_18' })]);
    expect(f.units).toBe(unitsOf('under_18'));
    expect(f.units).toBe(1);
    expect(f.eligible).toBe(1);
    expect(f.categorised).toBe(1);
  });

  it('agrees with the head count for an under-18 register, which is why "auto" looked right', () => {
    const rows = [child(), child({ dateOfBirth: '2018-03-03' })];
    expect(unitsFor(rows).units).toBe(eligibleChildReliefCount(rows, ASOF));
  });
});

describe('04b88724 · (b) every s.48 category weighs what the PACK prices it at', () => {
  it.each(CHILD_RELIEF_CATEGORY_KEYS)('one %s child weighs that category’s own units', (key) => {
    const f = unitsFor([child({ childReliefCategory: key, isStudent: true })]);
    expect(f.units).toBe(unitsOf(key));
    // And the money is the KERNEL's own for the same derived grid — one derivation, two fields.
    expect(f.amountRM).toBeCloseTo(childReliefAmountFor({ [key]: { full: 1, half: 0 } }, RELIEFS), 2);
  });

  it('the three categories the head count under-relieves are worth MORE than one', () => {
    for (const key of ['study_tertiary', 'disabled', 'disabled_study'] as const) {
      expect(unitsOf(key), `${key} must weigh more than a flat head`).toBeGreaterThan(1);
      expect(unitsFor([child({ childReliefCategory: key, isStudent: true })]).units).toBe(unitsOf(key));
    }
  });

  it('a mixed register sums the categories, not the heads', () => {
    const rows = [
      child({ childReliefCategory: 'under_18' }),
      child({ childReliefCategory: 'disabled_study', isStudent: true }),
    ];
    const f = unitsFor(rows);
    expect(f.units).toBe(unitsOf('under_18') + unitsOf('disabled_study'));
    // The head count is 2 for the same two children. That difference IS the defect.
    expect(eligibleChildReliefCount(rows, ASOF)).toBe(2);
    expect(f.units).toBeGreaterThan(eligibleChildReliefCount(rows, ASOF));
  });
});

describe('04b88724 · (c) a 50%-shared child counts for HALF a unit', () => {
  it('halves the units and the ringgit together, with no rounding', () => {
    const f = unitsFor([child({ childReliefCategory: 'disabled', childReliefPercentage: 50 })]);
    expect(f.units).toBeCloseTo(unitsOf('disabled') / 2, 6);
    expect(f.amountRM).toBeCloseTo(childReliefAmountFor({ disabled: { full: 0, half: 1 } }, RELIEFS), 2);
  });

  it('an unrecorded share is the FULL claim — the LHDN default, not an invention', () => {
    expect(unitsFor([child({ childReliefPercentage: null })]).units).toBe(unitsOf('under_18'));
  });
});

describe('04b88724 · (d) an ineligible or uncategorised child weighs nothing', () => {
  it.each([
    ['deceased', { isDeceased: true }],
    ['archived', { archivedAt: new Date() }],
    ['not a child', { relationship: 'spouse' }],
    ['explicitly not claimed', { childTaxRelief: false }],
  ] as const)('%s ⇒ 0 units', (_label, over) => {
    const f = unitsFor([child(over as Partial<ChildReliefCategorisedRow>)]);
    expect(f.units).toBe(0);
    expect(f.amountRM).toBe(0);
  });

  it('an eligible child with NO category is counted but priced at nothing, and reported as such', () => {
    const f = unitsFor([child({ childReliefCategory: null })]);
    expect(f.eligible).toBe(1);
    expect(f.categorised).toBe(0);
    expect(f.units).toBe(0);
  });
});

describe('04b88724 · (e) num_children STAYS a head count — Form E / CP8D / EA read it as one', () => {
  it('eligibleChildReliefCount weighs every eligible child as exactly one, whatever the category', () => {
    const rows = CHILD_RELIEF_CATEGORY_KEYS.map((key) =>
      child({ childReliefCategory: key, isStudent: true }),
    );
    // Five children ⇒ head count 5. The weighted figure for the same five is strictly larger, which is
    // precisely why it must not be written to the same column.
    expect(eligibleChildReliefCount(rows, ASOF)).toBe(rows.length);
    expect(unitsFor(rows).units).toBeGreaterThan(rows.length);
  });

  it('the head count is category-BLIND: swapping categories cannot move it', () => {
    const one = [child({ childReliefCategory: 'under_18' })];
    const other = [child({ childReliefCategory: 'disabled_study', isStudent: true })];
    expect(eligibleChildReliefCount(one, ASOF)).toBe(eligibleChildReliefCount(other, ASOF));
  });
});

describe('04b88724 · (f) ONE derivation — the ringgit is the kernel’s own', () => {
  it('amountRM equals childReliefAmountFor over the same derived grid, for a mixed register', () => {
    const rows = [
      child({ childReliefCategory: 'under_18' }),
      child({ childReliefCategory: 'study_tertiary', isStudent: true }),
      child({ childReliefCategory: 'disabled', childReliefPercentage: 50 }),
      child({ childReliefCategory: null }),
    ];
    const { grid } = childReliefGridFromFamily(rows, ASOF);
    expect(unitsFor(rows).amountRM).toBeCloseTo(childReliefAmountFor(grid, RELIEFS), 2);
  });

  it('the grid builder is still reachable from core/child-relief-review — the re-export is intact', () => {
    expect(gridFromReviewModule).toBe(childReliefGridFromFamily);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (g) THE THREE 'auto_table' GATES MOVE TOGETHER OR NOT AT ALL.
//
// The weighted figure above does NOT reach a payslip yet: the worked child-relief amount is supplied only
// for 'auto_table'. THREE places decide that, and the round that wrote the weighting named only two of them
// in its handoff — the third was found by adversarial verification:
//
//   1. core/payroll.ts                            the PAYSLIP
//   2. core/payroll-view.ts                       the PCB DRILL-DOWN read model
//   3. localization/my/multicycle-worksheet.ts    the MULTICYCLE SIGN-OFF WORKSHEET, whose own header says
//                                                 it mirrors core/payroll.ts "term for term"
//
// A follow-up that widens one or two of them ships a system that disagrees with itself: the worksheet
// replays a period and prints the difference against the filed payslips, so a payslip priced by category
// against a replay priced by head count prints a fabricated ringgit difference on a sign-off document.
//
// ⚠️ THIS GUARD ASSERTS AGREEMENT, NOT TODAY'S ANSWER. It reads the mode literals each gate admits and
// requires all three sets to be EQUAL. It therefore passes today (all three narrow), passes after a correct
// widening of all three, and FAILS on a partial one — which is the only outcome anybody needs to be told
// about. If it fires, widen the others; do not narrow it back and do not delete it.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const GATE_FILES = [
  'core/payroll.ts',
  'core/payroll-view.ts',
  'localization/my/multicycle-worksheet.ts',
] as const;

/** The mode literals the child-relief-amount gate in one file admits, read out of its source. */
function gateModes(rel: string): string[] {
  const src = readFileSync(resolve(process.cwd(), rel), 'utf8');
  const lines = src.split('\n');
  const modes = new Set<string>();
  lines.forEach((line, i) => {
    if (!line.includes('childReliefMode ===') && !line.includes('childReliefMode !==')) return;
    // The gate's own statement, not the whole file: the conditional line plus the two lines on either side,
    // which is where the amount call and any added mode sit.
    const raw = lines.slice(Math.max(0, i - 2), i + 3);
    // ⚠️ COMMENTS ARE STRIPPED BEFORE THE SCAN, AND THAT IS NOT A DETAIL. The loose literal pattern
    // below deliberately catches a mode added in a nearby EXPRESSION, but it cannot tell an expression
    // from prose: a comment reading "a 'manual' figure is priced by num_children" beside the gate made
    // this file's set read ['auto_table', 'manual'] and failed the agreement test below with text
    // telling the reader three gates had diverged when nothing had been widened. A guard that
    // false-positives with a misdirecting message is worse than no guard, and the next round's own
    // hand-fix is expected to add exactly such comments here.
    const window = raw
      .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/(^|[^:])\/\/.*$/, '$1'))
      .filter((l) => !/^\s*(\*|\/\*)/.test(l))
      .join('\n');
    if (!/childReliefAmount/.test(window)) return;
    for (const m of window.matchAll(/childReliefMode\s*[!=]==\s*'([a-z_]+)'/g)) modes.add(m[1]);
    for (const m of window.matchAll(/'(auto|auto_table|manual)'/g)) modes.add(m[1]);
  });
  return [...modes].sort();
}

describe('04b88724 · (g) there is ONE child-relief gate, and every consumer reads it', () => {
  /**
   * ⚠️ THIS GUARD CHANGED SHAPE IN r347, AND THE REASON IS THE DEFECT IT FAILED TO CATCH.
   *
   * It used to read the mode literals out of THREE files and require the three sets to be equal —
   * "widening one without the others is the failure this catches". That was a real failure and it did
   * catch it. But it could only compare the files it was given, and there was a FOURTH consumer:
   * `qualifyingChildBreakdown` in core/dependents.ts, which prices the figure the Identification & Tax
   * card shows. r344 widened the three on this list, left the fourth reading `mode === 'auto_table'`,
   * and this guard stayed green while the card and the payslip disagreed about a disabled child by
   * RM14,000 on a real employee.
   *
   * Comparing copies can only ever find the copies you list. So there is now ONE exported predicate,
   * `pricesChildReliefFromGrid`, and this asserts the property that makes divergence IMPOSSIBLE rather
   * than merely detectable: no consumer carries its own mode gate, and all of them read the predicate.
   *
   * `gateModes` is kept — it is now the proof that no file has grown a private gate again.
   */
  it('no consumer carries its own childReliefMode gate beside a child-relief amount', () => {
    for (const f of GATE_FILES) {
      expect(
        gateModes(f),
        `${f} has grown its own mode gate again. The rule lives in pricesChildReliefFromGrid ` +
          `(core/dependents.ts); a private copy here is how r344's defect reached production.`,
      ).toEqual([]);
    }
  });

  it('⚠️ and EVERY consumer reads the one predicate — including the card, which r344 missed', () => {
    const why =
      'the payslip, the PCB drill-down, the multicycle sign-off worksheet AND the Identification & Tax ' +
      'card must price child relief by the same rule. When they did not, the payslip relieved a disabled ' +
      'child at four while the card that explains the figure showed one.';
    for (const f of [...GATE_FILES, 'core/dependents.ts']) {
      expect(readFileSync(resolve(process.cwd(), f), 'utf8'), `${f}: ${why}`).toContain(
        'pricesChildReliefFromGrid',
      );
    }
  });
});
