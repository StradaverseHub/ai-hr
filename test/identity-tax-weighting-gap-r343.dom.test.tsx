/**
 * r343 · item 04b88724 — THE GAP BETWEEN WHAT s.48 CALLS FOR AND WHAT 'AUTO' GIVES, ON THE SCREEN.
 *
 * The reporter is right about the rule and wrong about nothing else: s.48 counts a child 18+ in
 * diploma-or-above study, and a disabled child, as FOUR qualifying children, and a disabled child in that
 * study as EIGHT. In 'auto' mode this repo's kernel child leg is `num_children × perChild`, so each of those
 * children is relieved as ONE and the employee's PCB is over-deducted every month.
 *
 * ⚠️ WHY THIS IS A SENTENCE AND NOT A DIFFERENT TOTAL, AND WHY THAT MATTERS ENOUGH TO PIN. The total the card
 * prints is what the PAYSLIP deducts. Printing the weighted figure there instead would print an amount this
 * repo's own kernel contradicts — the exact r340 defect the card was rebuilt to stop (CLAUDE.md §8). So the
 * weighted figure appears BESIDE it, labelled as what the categories call for, and the two totals below are
 * asserted to stay the kernel's.
 *
 * ⚠️ AND IT MUST BE ABSENT WHEN THERE IS NOTHING TO SAY. On a register of whole-claim under-18 children the
 * weighted figure and the head count AGREE, and an amber warning on an employee whose figure is correct is
 * noise that teaches the reader to ignore the warning on the employee whose figure is not.
 *
 * ⚠️ BOTH DIRECTIONS (r343 FIX PASS). The first version of this note fired only on `ruleUnits > qualifying`,
 * i.e. only where the employee is UNDER-relieved, while its own comment claimed it fired whenever the two
 * differ. The other direction is reachable and costs the employee nothing but costs the revenue: a child
 * recorded at a 50% CLAIM SHARE is half a qualifying child to the rules and a whole child to the head count,
 * so an 'auto' employee with one such child is relieved RM2,000 where the categories support RM1,000 and
 * their monthly PCB is UNDER-deducted. The screen said nothing at all. The two directions get DIFFERENT
 * sentences, because printing "your tax is over-deducted" on an under-deduction is worse than silence, and
 * the last two describe blocks pin exactly that.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
import { IdentityTaxCard, type ChildReliefPricing } from '../components/identity-tax-card';
import { childReliefAmountFor } from '../localization/my/payroll';
import { childReliefPrices } from '../localization/my/child-relief';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const PRICES = childReliefPrices(RELIEFS);
const unitsOf = (k: string) => PRICES.find((p) => p.key === k)!.units;
/** The child leg core/payroll.ts uses for an 'auto' employee — the STORED head count × perChild. */
const kernelFlatRM = (children: number) => children * RELIEFS.perChild;
const rm = (n: number) =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

/**
 * ONE employee stored 'auto' with ONE disabled child in higher education. The head count is 1, so the kernel
 * relieves one child; s.48 prices that child at EIGHT. Every figure is taken from the PACK — a literal here
 * would drift the day a relief figure is corrected, as two of the five were in r339.
 */
const GAP_PRICING: ChildReliefPricing = {
  perChild: RELIEFS.perChild,
  categories: PRICES,
  statutoryVersion: '2026.9',
  familyChildren: 1,
  uncategorisedChildren: 0,
  pricedFromGrid: false,
  mode: 'auto',
  derived: true,
  physicalChildren: 1,
  eligibleChildren: 1,
  qualifyingChildren: 1,
  reliefRM: kernelFlatRM(1),
  breakdown: [
    {
      kind: 'child',
      name: 'Nurul',
      category: 'disabled_study',
      sharePercent: 100,
      children: 1,
      units: 1,
      amountRM: kernelFlatRM(1),
    },
  ],
  ruleUnits: unitsOf('disabled_study'),
  ruleReliefRM: childReliefAmountFor({ disabled_study: { full: 1, half: 0 } }, RELIEFS),
};

/** The same employee with an under-18 child: the rule and the head count AGREE, so there is no gap. */
const NO_GAP_PRICING: ChildReliefPricing = {
  ...GAP_PRICING,
  breakdown: [{ ...GAP_PRICING.breakdown[0], category: 'under_18' }],
  ruleUnits: unitsOf('under_18'),
  ruleReliefRM: childReliefAmountFor({ under_18: { full: 1, half: 0 } }, RELIEFS),
};

/**
 * THE OTHER DIRECTION. The same 'auto' employee with ONE under-18 child recorded at a 50% CLAIM SHARE — the
 * other parent claims the other half. The head count is still 1, so the kernel relieves a whole child; the
 * categories support HALF a qualifying child. This employee is OVER-relieved and their PCB UNDER-deducted,
 * and until the r343 fix pass the card printed nothing. Every figure is the pack's: the half share is priced
 * by `childReliefAmountFor` through the grid's own `half` column, not by dividing a literal here.
 */
const OVER_PRICING: ChildReliefPricing = {
  ...GAP_PRICING,
  breakdown: [{ ...GAP_PRICING.breakdown[0], category: 'under_18', sharePercent: 50 }],
  ruleUnits: unitsOf('under_18') / 2,
  ruleReliefRM: childReliefAmountFor({ under_18: { full: 0, half: 1 } }, RELIEFS),
};

function renderCard(pricing: ChildReliefPricing, messages: unknown = en) {
  render(
    <NextIntlClientProvider locale="en" messages={messages as never}>
      <IdentityTaxCard
        action={() => {}}
        employmentId="emp-1"
        personId="person-1"
        childRelief={pricing}
        defaults={{
          taxNumber: 'IG1',
          taxCategory: 1,
          taxResidency: 'resident',
          numChildren: pricing.physicalChildren,
          childReliefMode: 'auto',
          employerBearsTax: false,
          disabledIndividual: false,
          disabledSpouse: false,
          childReliefTable: null,
        }}
      />
    </NextIntlClientProvider>,
  );
}

const gap = () => document.querySelector('[data-child-auto-weighting-gap]');
/** Which direction the card says the gap runs in — 'under' (PCB over-deducted) or 'over' (under-deducted). */
const direction = () => gap()?.getAttribute('data-child-auto-weighting-gap-direction') ?? null;
const text = (sel: string) => (document.querySelector(sel)?.textContent ?? '').trim();

describe('04b88724 · the weighting gap is named in Auto mode', () => {
  it('a disabled higher-education child on Auto shows the gap, with BOTH figures', () => {
    renderCard(GAP_PRICING);
    const t = gap()?.textContent ?? '';
    expect(gap(), 'the gap note must render').not.toBeNull();
    // What s.48 calls for: eight qualifying children, priced by the pack.
    expect(t).toContain(String(unitsOf('disabled_study')));
    expect(t).toContain(rm(GAP_PRICING.ruleReliefRM));
    // And what the calculation actually gives, so nobody can read the first figure as the amount deducted.
    expect(t).toContain(rm(kernelFlatRM(1)));
    expect(t).not.toMatch(/\{[a-zA-Z]/);
  });

  it('the TOTAL the card prints is still the kernel’s own — the gap note did not move the money', () => {
    renderCard(GAP_PRICING);
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelFlatRM(1)));
    expect(text('[data-child-breakdown-total-units]')).toBe('1');
  });

  it('an under-18 register shows NO gap note: the rule and the head count agree', () => {
    renderCard(NO_GAP_PRICING);
    expect(gap(), 'no warning where the figure is already right').toBeNull();
  });

  it.each([
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ])('resolves against the %s catalogue with both ICU amounts substituted', (_loc, m) => {
    renderCard(GAP_PRICING, m);
    const t = gap()?.textContent ?? '';
    expect(t.trim()).not.toBe('');
    expect(t).not.toMatch(/\{[a-zA-Z]/);
    expect(t).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR|people\.detail/);
  });
});

describe('04b88724 · the gap is disclosed in BOTH directions, with a different sentence for each', () => {
  it('⚠️ a 50%-shared child on Auto is OVER-relieved, and the card says so — the case that was silent', () => {
    renderCard(OVER_PRICING);
    expect(gap(), 'the over-relief note must render').not.toBeNull();
    expect(direction()).toBe('over');
    const t = gap()?.textContent ?? '';
    // What the categories support (half a child), and what the calculation actually gives (a whole one).
    expect(t).toContain(rm(OVER_PRICING.ruleReliefRM));
    expect(t).toContain(rm(kernelFlatRM(1)));
    expect(t).not.toMatch(/\{[a-zA-Z]/);
    // The money on the card is STILL the kernel's — this direction discloses, it does not deduct either.
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelFlatRM(1)));
  });

  it('the two directions are not the same sentence, and neither states the other’s conclusion', () => {
    renderCard(OVER_PRICING);
    const over = gap()?.textContent ?? '';
    cleanup();
    renderCard(GAP_PRICING);
    const under = gap()?.textContent ?? '';
    expect(over).not.toBe(under);
    // English, from the real catalogue: the direction of the tax error is the whole point of the note.
    expect(under, 'under-relieved ⇒ too much tax deducted').toContain('over-deducted');
    expect(over, 'over-relieved ⇒ too little tax deducted').toContain('under-deducted');
    // ⚠️ AND NEITHER SENTENCE MAY CARRY THE OTHER'S CONCLUSION. This is the assertion that makes the two
    // keys worth having: one message reused for both directions would tell an over-relieved employee's
    // reader that the tax is over-deducted, which is the opposite of the truth.
    expect(over, 'the over-relief sentence must not claim an over-deduction').not.toContain('over-deducted');
    expect(under, 'the under-relief sentence must not claim an under-deduction').not.toContain('under-deducted');
  });

  it('the under-relief case is labelled as such, and an agreeing register carries no direction at all', () => {
    renderCard(GAP_PRICING);
    expect(direction()).toBe('under');
    cleanup();
    renderCard(NO_GAP_PRICING);
    expect(gap(), 'no note where the two agree').toBeNull();
    expect(direction()).toBeNull();
  });

  it.each([
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ])('the over-relief sentence resolves against the %s catalogue with every amount substituted', (_loc, m) => {
    renderCard(OVER_PRICING, m);
    const t = gap()?.textContent ?? '';
    expect(t.trim()).not.toBe('');
    expect(t).not.toMatch(/\{[a-zA-Z]/);
    expect(t).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR|people\.detail/);
  });
});
