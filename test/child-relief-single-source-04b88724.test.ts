/**
 * 04b88724 (r340 fix pass) — THERE IS ONE CHILD-RELIEF DERIVATION, AND BOTH READERS CALL IT.
 *
 * WHAT THIS FILE IS DEFENDING, in the words of the approved plan: "Expose the COUNT alongside the AMOUNT
 * from that one function rather than computing units in the view — two call sites that each work out C is
 * exactly the duplicate-source-of-truth problem CLAUDE.md section 1 forbids. Put it where both payroll and
 * the screen read it."
 *
 * The first build did not, and the consequence was not theoretical. The count was worked out in
 * core/dependents.ts AND in components/identity-tax-card.tsx; the card read its own copy; and in 'auto' mode
 * it printed a child-relief figure in ringgit that this repo's own PCB kernel contradicted, on the very
 * screen whose purpose was to stop two child numbers being confused.
 *
 * So the properties below are structural, not arithmetical. Anyone can make two copies of a formula agree
 * today. What has to hold is that there is only one copy:
 *   (1) `childReliefAmountFor` — the function core/payroll.ts and core/payroll-view.ts call — IS one field
 *       of `childReliefFor`'s return value, for every input shape either of them can be handed.
 *   (2) the qualifying COUNT and the RINGGIT come out of that same call, and the count times the rate is
 *       the money, exactly.
 *   (3) the pack the SCREEN reaches through the client seam serves THE SAME FUNCTION OBJECT as the server
 *       pack, not a second implementation that happens to agree.
 *   (4) the halving of a 50%-shared child appears in the pack and nowhere else.
 *
 * test/child-relief-figures-04b88724.test.ts owns the FIGURES (what each category is worth, with its
 * printed-page citation). Nothing here re-proves those.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { childReliefFor, childReliefPrices } from '../localization/my/child-relief';
import { childReliefAmountFor } from '../localization/my/payroll';
import { myPack } from '../localization/my';
import { clientPackFor } from '../localization/registry.client';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';

const root = fileURLToPath(new URL('..', import.meta.url));
const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;

/** Every grid shape the kernel can be handed, including the malformed ones a stored column can hold. */
const GRIDS: [string, unknown][] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'nonsense'],
  ['an array', [{ full: 1 }]],
  ['empty object', {}],
  ['one full child under 18', { under_18: { full: 1, half: 0 } }],
  ['one shared child under 18', { under_18: { full: 0, half: 1 } }],
  ["the reporter's worked example", { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } }],
  ['every category at once', {
    under_18: { full: 2, half: 1 },
    study_preu: { full: 1, half: 1 },
    study_tertiary: { full: 1, half: 0 },
    disabled: { full: 0, half: 3 },
    disabled_study: { full: 1, half: 1 },
  }],
  ['an unknown category', { not_a_category: { full: 9, half: 9 } }],
  ['a non-object cell', { under_18: 'nonsense' }],
  ['fractional and negative counts', { under_18: { full: 2.7, half: -4 } }],
];

describe('(1) the money the KERNEL deducts is one field of the one derivation', () => {
  it.each(GRIDS)('childReliefAmountFor === childReliefFor(...).amountRM — %s', (_name, grid) => {
    const viaKernel = childReliefAmountFor(grid, RELIEFS);
    const viaFigure = childReliefFor({ from: 'table', table: grid, prices: childReliefPrices(RELIEFS) }).amountRM;
    expect(viaFigure).toBe(viaKernel);
  });

  it('…and for a ruleset that predates childByCategory, where both fall back to the pack built-in', () => {
    const legacy = { individual: 9000, spouse: 4000, perChild: 2000, epfReliefCap: 4000 } as StatutoryRuleset['pcb']['reliefs'];
    const grid = { disabled: { full: 1, half: 0 } };
    expect(childReliefFor({ from: 'table', table: grid, prices: childReliefPrices(legacy) }).amountRM).toBe(
      childReliefAmountFor(grid, legacy),
    );
    // Non-vacuity: the fallback really is doing something — this is not comparing 0 with 0.
    expect(childReliefAmountFor(grid, legacy)).toBeGreaterThan(0);
  });
});

describe('(2) the COUNT and the MONEY are the same statement', () => {
  it.each(GRIDS)('units × perChild === amountRM — %s', (_name, grid) => {
    const f = childReliefFor({ from: 'table', table: grid, prices: childReliefPrices(RELIEFS) });
    expect(f.units * RELIEFS.perChild).toBeCloseTo(f.amountRM, 6);
    // The working adds up to the answer, line by line.
    expect(f.rows.reduce((s, r) => s + r.units, 0)).toBeCloseTo(f.units, 6);
    expect(f.rows.reduce((s, r) => s + r.amountRM, 0)).toBeCloseTo(f.amountRM, 6);
  });

  it('a head count is the kernel’s other child leg: `children × perChild`, and QC is the head count', () => {
    for (const children of [0, 1, 3, 71]) {
      const f = childReliefFor({ from: 'headCount', children, perChild: RELIEFS.perChild });
      expect(f.amountRM).toBe(children * RELIEFS.perChild);
      expect(f.units).toBe(children);
      expect(f.rows, 'a flat count has no per-category working, and must not invent one').toEqual([]);
    }
  });

  it('each price is its category’s ringgit AND that ringgit as a count of qualifying children', () => {
    for (const p of childReliefPrices(RELIEFS)) {
      expect(p.amountRM).toBe(RELIEFS.childByCategory![p.key]);
      expect(p.units * RELIEFS.perChild).toBeCloseTo(p.amountRM, 6);
    }
    // A ruleset with no usable per-child rate prices no COUNT rather than dividing by zero.
    const noRate = { ...RELIEFS, perChild: 0 } as StatutoryRuleset['pcb']['reliefs'];
    for (const p of childReliefPrices(noRate)) {
      expect(Number.isFinite(p.units)).toBe(true);
      expect(p.units).toBe(0);
    }
  });
});

describe('(3) the screen and the payroll kernel resolve THE SAME FUNCTION', () => {
  it('the client seam serves the very function object the server pack exposes', () => {
    const client = clientPackFor('MY');
    expect(client, 'the MY client pack must be registered, or the card resolves nothing').toBeTruthy();
    // Identity, not equivalence. Two implementations that agree today are the thing that went wrong.
    expect(client!.payroll.childReliefFor).toBe(myPack.payroll.childReliefFor);
    expect(myPack.payroll.childReliefFor).toBe(childReliefFor);
    expect(myPack.payroll.childReliefPrices).toBe(childReliefPrices);
  });

  it('the pack still exposes the kernel’s own entry point under its own name', () => {
    // core/payroll.ts and core/payroll-view.ts call it by this name; renaming it would move a payslip.
    expect(typeof myPack.payroll.childReliefAmountFor).toBe('function');
    expect(myPack.payroll.childReliefAmountFor!({ under_18: { full: 1, half: 0 } }, RELIEFS)).toBe(
      RELIEFS.childByCategory!.under_18,
    );
  });
});

describe('(4) the 50% halving lives in the pack and nowhere else', () => {
  const card = readFileSync(`${root}components/identity-tax-card.tsx`, 'utf8');

  it('the card reaches the pack through the client seam instead of pricing anything itself', () => {
    expect(card, 'the island must resolve the pack, not import localization/my (ADR-0080 D7)').toContain(
      "from '@/localization/registry.client'",
    );
    expect(card).toContain('childReliefFor');
    expect(card).not.toContain("from '@/localization/my");
  });

  it('no halving, and no ringgit-to-count division, is written in the view', () => {
    // These are the two statutory statements: a shared claim is worth half, and a category's ringgit IS a
    // number of qualifying children. Both belong to the pack. The card holding either is how the screen
    // and the payslip came apart.
    const code = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'halving a category belongs to localization/my/child-relief.ts').not.toMatch(/units\s*\/\s*2/);
    expect(code).not.toMatch(/amountRM\s*\/\s*2/);
    expect(code, 'a count is never re-derived from money in the view').not.toMatch(/\/\s*perChild/);
  });

  it('…and the pack DOES hold them, so the assertions above are not passing because nobody halves anything', () => {
    const pack = readFileSync(`${root}localization/my/child-relief.ts`, 'utf8');
    expect(pack).toMatch(/units\s*\/\s*2/);
    expect(pack).toMatch(/amountRM\s*\/\s*2/);
    const half = childReliefFor({
      from: 'table',
      table: { under_18: { full: 0, half: 1 } },
      prices: childReliefPrices(RELIEFS),
    });
    expect(half.amountRM).toBeCloseTo(RELIEFS.childByCategory!.under_18 / 2, 6);
    expect(half.units).toBeCloseTo(0.5, 6);
  });
});
