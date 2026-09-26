/**
 * r343 · item 03f89c0f — TYPED CHILD COUNTS ABOVE THE FAMILY RECORD.
 *
 * MEASURED ON PRODUCTION 2026-09-26: of the employees on 'manual' with a child count, 22 typed a figure
 * ABOVE the eligible children on file, 0 below, 5 agree. 52 children appear in no Family record, each
 * carrying RM2,000 of relief — RM104,000 the records do not support — and 7 of the 22 have been paid. Relief
 * reduces chargeable income, so too much relief means too little PCB deducted every month.
 *
 * ⚠️ WHAT THIS IS NOT. 'manual' is not a defect and this report does not treat it as one. A typed figure is
 * legitimate; an employee may genuinely have children who were never entered, in which case the figure is
 * right and the RECORD is incomplete. The finding is only that the two DISAGREE, and the assertions below
 * are written in those terms.
 *
 * ⚠️ HEAD COUNT AGAINST HEAD COUNT. `num_children` is a head count (Form E / CP8D / EA) and the record side
 * counts child ROWS. The s.48 1/4/8 weighting is deliberately absent from both, and the last describe block
 * pins that: if either side ever became weighted, the difference column would stop meaning anything.
 *
 * Every ringgit expectation is `MY_RELIEFS.perChild` from the pack, never a literal 2000.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MY_STATUTORY, CHILD_RELIEF_CATEGORY_KEYS } from '../localization/my/statutory-tables';
import { childReliefRecordDisagreement } from '../core/child-relief-review';
import { childReliefGridFromFamily, type ChildReliefCategorisedRow } from '../core/dependents';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const PER_CHILD = RELIEFS.perChild;
const ASOF = new Date('2026-06-01T00:00:00Z');

const child = (over: Partial<ChildReliefCategorisedRow> = {}): ChildReliefCategorisedRow =>
  ({
    relationship: 'child',
    dateOfBirth: '2016-01-01',
    isStudent: false,
    isDeceased: false,
    archivedAt: null,
    childTaxRelief: null,
    childReliefCategory: 'under_18',
    childReliefPercentage: 100,
    ...over,
  }) as ChildReliefCategorisedRow;

/** The record side of the comparison, by the SAME walk the screen uses. */
const onFile = (rows: ChildReliefCategorisedRow[]) => childReliefGridFromFamily(rows, ASOF).eligible;

describe('03f89c0f · (a) a typed figure ABOVE the record is reported, with the difference', () => {
  it('A00001’s shape: 9 typed, one child on file ⇒ 8 over, priced at the pack’s per-child figure', () => {
    const familyEligible = onFile([child()]);
    expect(familyEligible).toBe(1);
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 9,
      familyEligible,
      perChild: PER_CHILD,
    });
    expect(d.typedFigure).toBe(true);
    expect(d.typedExcess).toBe(8);
    expect(d.recordRM).toBeCloseTo(1 * PER_CHILD, 2);
    expect(d.excessRM).toBeCloseTo(8 * PER_CHILD, 2);
  });

  it('the whole production finding adds up from the same function', () => {
    // 52 excess children across the 22 — the relief total the plan quotes, from the pack's own rate.
    const total = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 52,
      familyEligible: 0,
      perChild: PER_CHILD,
    });
    expect(total.excessRM).toBeCloseTo(52 * PER_CHILD, 2);
  });
});

describe('03f89c0f · (b) a figure that AGREES with the record is not a finding', () => {
  it('typed 2 against 2 on file ⇒ no excess and nothing unsupported', () => {
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 2,
      familyEligible: onFile([child(), child({ dateOfBirth: '2018-05-05' })]),
      perChild: PER_CHILD,
    });
    expect(d.typedExcess).toBe(0);
    expect(d.excessRM).toBe(0);
  });

  it('a figure typed BELOW the record is not on this list either — it under-claims, a different question', () => {
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 1,
      familyEligible: 3,
      perChild: PER_CHILD,
    });
    expect(d.typedExcess).toBe(-2);
    expect(d.excessRM).toBe(0);
  });
});

describe('03f89c0f · (c) the two AUTO modes are not on this screen at all', () => {
  it.each(['auto', 'auto_table'] as const)('%s ⇒ nothing was typed, so nothing can disagree', (mode) => {
    const d = childReliefRecordDisagreement({ mode, numChildren: 9, familyEligible: 1, perChild: PER_CHILD });
    expect(d.typedFigure).toBe(false);
    expect(d.typedExcess).toBeNull();
    expect(d.excessRM).toBe(0);
  });

  it('an unrecognised stored mode is treated as typed — a hand-edited row is not silently exonerated', () => {
    const d = childReliefRecordDisagreement({
      mode: 'something_else',
      numChildren: 4,
      familyEligible: 1,
      perChild: PER_CHILD,
    });
    expect(d.typedFigure).toBe(true);
    expect(d.typedExcess).toBe(3);
  });
});

describe('03f89c0f · (d) an archived, deceased or unclaimed child does not count towards the record', () => {
  it.each([
    ['archived', { archivedAt: new Date() }],
    ['deceased', { isDeceased: true }],
    ['explicitly not claimed for relief', { childTaxRelief: false }],
    ['not a child at all', { relationship: 'spouse' }],
  ] as const)('%s ⇒ the record side stays 0 and the whole typed figure is unsupported', (_l, over) => {
    const familyEligible = onFile([child(over as Partial<ChildReliefCategorisedRow>)]);
    expect(familyEligible).toBe(0);
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 1,
      familyEligible,
      perChild: PER_CHILD,
    });
    expect(d.typedExcess).toBe(1);
    expect(d.excessRM).toBeCloseTo(PER_CHILD, 2);
  });
});

describe('03f89c0f · (e) the figures come from the PACK, and the comparison is HEAD against HEAD', () => {
  it('a different per-child rate moves the ringgit — nothing here is a hard-coded 2000', () => {
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 3,
      familyEligible: 1,
      perChild: PER_CHILD + 500,
    });
    expect(d.excessRM).toBeCloseTo(2 * (PER_CHILD + 500), 2);
    expect(d.recordRM).toBeCloseTo(PER_CHILD + 500, 2);
  });

  it('the record side is CATEGORY-BLIND: one child is one child, whatever it is worth in relief', () => {
    // If the record side were ever weighted, a disabled higher-education child would count as eight and
    // this employee's "difference" would flip sign for no reason the reader could see.
    for (const key of CHILD_RELIEF_CATEGORY_KEYS) {
      expect(onFile([child({ childReliefCategory: key, isStudent: true })]), key).toBe(1);
    }
    const d = childReliefRecordDisagreement({
      mode: 'manual',
      numChildren: 2,
      familyEligible: onFile([child({ childReliefCategory: 'disabled_study', isStudent: true })]),
      perChild: PER_CHILD,
    });
    expect(d.typedExcess).toBe(1);
  });
});
