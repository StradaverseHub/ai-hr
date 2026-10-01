/**
 * 04b88724 — PHYSICAL CHILDREN vs QUALIFYING CHILDREN ON THE SCREEN.
 *
 * `qualifyingChildReliefFor` is proved against the kernel's own figure in
 * test/qualifying-child-relief-04b88724.test.ts. This file is about the other half of the item, which only
 * a render can answer: that the Identification & Tax card now shows TWO figures instead of one, says of
 * each whether it was worked out or typed, and gets the read-only rule the right way round.
 *
 * THE RULE, AND WHY IT IS NOT "LOCK THE DERIVED FIELD": read-only applies to the DERIVED modes only. A
 * manual-mode employee has nothing to derive from, so a locked qualifying field would be unfillable — and
 * on production 71 of 75 employees are on manual, so that is the ordinary case, not an edge. The plan is
 * explicit about it and it is the assertion most likely to be got backwards.
 *
 * THE OTHER THING A RENDER IS THE ONLY WAY TO CHECK: the card is INTERACTIVE, so the qualifying count has
 * to track the grid as it is typed. It is priced by the PACK's own `childReliefFor`, reached through the
 * client seam, and if that ever became a figure the server computed once for the saved record, the screen
 * would start contradicting its own boxes. Hence the typing case at the end.
 *
 * ── AND THE ASSERTION THIS FILE WAS MISSING, WHICH IS WHY r340's WORST DEFECT WAS GREEN EVERYWHERE ──────
 * Every figure below is now compared against THE KERNEL'S OWN — `childReliefAmountFor` (the pack call
 * core/payroll.ts ~5625 and core/payroll-view.ts ~1487 make for an 'auto_table' employee) and `children ×
 * perChild` (the expression both of those files use for every other mode). The first build of this item
 * asserted the card against hand-written literals and asserted the kernel only through a function the card
 * did not read, so the card's arithmetic and the kernel's could diverge with 1814 tests green — and they
 * did: in 'auto' mode the card worked the relief out from its own count of ELIGIBLE children while the
 * payslip multiplies the STORED head count, and the screen was RM2,000 short of the payslip with nothing on
 * it saying so. The auto-mode fixture below is deliberately the shape that reproduces that (a stored head
 * count of two, one eligible child on file), and the assertion names both figures so it cannot pass by
 * accident.
 *
 * AND THE POST CONTRACT: there must still be exactly ONE field named `numChildren`. Two boxes showing one
 * stored number is the shape this item creates, and a second `name="numChildren"` would silently make the
 * save read whichever the browser serialised first.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
// r351 — the other five catalogues, for the render check at the end of this file. A key that resolves in
// English and is missing or malformed elsewhere passes tsc and `next build` and fails only on a screen
// (CLAUDE.md §8), and four of the sentences on this card are new this round.
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
import { IdentityTaxCard, type ChildReliefPricing } from '../components/identity-tax-card';
// THE KERNEL'S OWN FIGURES. test/ is not scanned by the country-pack drift guard, so a test may name the
// pack directly — and it must here: the whole point is to compare what the SCREEN prints against what the
// payroll engine computes, not against an arithmetic this file works out for itself.
import { childReliefAmountFor } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
/** The pack call core/payroll.ts makes for an 'auto_table' employee, with the same arguments. */
const kernelTableRM = (grid: unknown) => childReliefAmountFor(grid, RELIEFS);
/** The child leg core/payroll.ts and core/payroll-view.ts use for EVERY OTHER mode: `children × perChild`,
 *  where `children` is the STORED `num_children` — not a count of eligible children taken at render time. */
const kernelFlatRM = (children: number) => children * RELIEFS.perChild;
const rm = (n: number) =>
  new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

// The catalogue holds nested groups (family, leaveSummary, …) alongside the flat captions, so the cast
// goes through `unknown`; every key read below is one of the flat string ones.
const D = en.people.detail as unknown as Record<string, string>;

/**
 * The prices core/dependents.ts hands the card, TAKEN FROM THE RULESET rather than typed out: the ringgit is
 * `childByCategory` and the count is that ringgit ÷ perChild, which is what `childReliefPrices` returns. A
 * future correction to a relief figure moves this fixture with it instead of making the file lie.
 */
const CATEGORY_PRICES = (['under_18', 'study_preu', 'study_tertiary', 'disabled', 'disabled_study'] as const).map(
  (key) => ({ key, amountRM: RELIEFS.childByCategory![key], units: RELIEFS.childByCategory![key] / RELIEFS.perChild }),
);

/** A MANUAL record with nothing keyed: the ordinary case (71 of the reporter's 75 employees). */
const PRICING: ChildReliefPricing = {
  perChild: RELIEFS.perChild,
  categories: CATEGORY_PRICES,
  statutoryVersion: '2026.9',
  familyChildren: 2,
  uncategorisedChildren: 0,
  pricedFromGrid: false,
  mode: 'manual',
  derived: false,
  physicalChildren: 0,
  eligibleChildren: 0,
  qualifyingChildren: 0,
  reliefRM: 0,
  breakdown: [],
  // r351 — what payroll deducts from the STORED columns. Equal to the figure above on an in-step record,
  // which every fixture here is unless it says otherwise; the AGED_OUT one is where they part company.
  storedQualifyingChildren: 0,
  storedReliefRM: 0,
  derivedGrid: null,
  undatedChildren: [],
  asOf: '2026-06-30',
  // r343 04b88724 — the s.48 WEIGHTED figure from the children on file. Zero here because this fixture's
  // Family register carries no relief categories; the gap note is asserted from its own fixture.
  ruleUnits: 0,
  ruleReliefRM: 0,
};

function renderCard(over: {
  mode?: string;
  numChildren?: number;
  grid?: Record<string, { full: number; half: number }> | null;
  pricing?: ChildReliefPricing | null;
  /** r351 — a different catalogue, for the six-locale render check. Defaults to English. */
  messages?: unknown;
} = {}) {
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale="en" messages={(over.messages ?? en) as never}>
      <IdentityTaxCard
        action={() => {}}
        employmentId="emp-1"
        personId="person-1"
        childRelief={over.pricing === undefined ? PRICING : over.pricing}
        defaults={{
          taxNumber: 'IG1',
          taxCategory: 3,
          taxResidency: 'resident',
          numChildren: over.numChildren ?? 0,
          childReliefMode: over.mode ?? 'manual',
          employerBearsTax: false,
          disabledIndividual: false,
          disabledSpouse: false,
          childReliefTable: over.grid ?? null,
        }}
      />
    </NextIntlClientProvider>,
  );
  return { user };
}

const physical = () => document.querySelector('[data-child-physical]') as HTMLInputElement;
const qualifyingInput = () => document.querySelector('[data-child-qualifying-input]') as HTMLInputElement | null;
const qualifyingValue = () => document.querySelector('[data-child-qualifying-value]') as HTMLElement | null;
const qualifyingText = () => (qualifyingInput()?.value ?? qualifyingValue()?.textContent ?? '').trim();
const breakdownRows = () => Array.from(document.querySelectorAll('[data-child-breakdown-row]'));
const text = (sel: string) => (document.querySelector(sel)?.textContent ?? '').trim();

describe('the card shows TWO figures under two captions', () => {
  it('both captions are rendered, and the old single "Children (PCB relief)" FIELD caption is gone', () => {
    renderCard({ numChildren: 2 });
    // The FIELD captions, not any text on the card: the fieldset's own LEGEND still reads "Children (PCB
    // relief)" — `childReliefLegend`, a different key with the same words — and that heading is not what
    // changed. `childrenPcbRelief` is the caption this item removed; it now renders nowhere, and this
    // assertion is what would notice it coming back on a field.
    const fieldCaptions = Array.from(document.querySelectorAll('label > span')).map((s) => s.textContent?.trim());
    expect(fieldCaptions).toContain(D.childrenPhysical);
    expect(fieldCaptions).toContain(D.childrenQualifying);
    expect(
      fieldCaptions,
      'the one caption that implied a head count and a tax figure were the same number',
    ).not.toContain(D.childrenPcbRelief);
  });

  it('exactly ONE field posts numChildren, whatever the mode — the save reads one head count', () => {
    for (const mode of ['manual', 'auto', 'auto_table']) {
      document.body.innerHTML = '';
      renderCard({
        mode,
        numChildren: 2,
        grid: { under_18: { full: 2, half: 0 } },
        pricing: { ...PRICING, mode: 'auto', derived: true, physicalChildren: 2, eligibleChildren: 2 },
      });
      expect(document.querySelectorAll('[name="numChildren"]').length, `${mode}`).toBe(1);
    }
  });
});

it.each(['manual', 'auto_table'] as const)('live %s category changes agree with payroll eligibility', async mode => {
  const { user } = renderCard({ mode, numChildren: 2, grid: { under_18: { full: 2, half: 0 } } });
  const category = document.querySelector<HTMLSelectElement>('select[name="taxCategory"]')!;
  expect(text('[data-child-relief-amount]')).toContain(rm(4000));
  await user.selectOptions(category, '1');
  expect(qualifyingValue()!.textContent).toBe('0');
  expect(text('[data-child-relief-amount]')).toContain(rm(0));
  expect(physical().value).toBe('2');
  await user.selectOptions(category, '3');
  expect(mode === 'manual' ? qualifyingInput()!.value : qualifyingValue()!.textContent).toBe('2');
  expect(text('[data-child-relief-amount]')).toContain(rm(4000));
});

describe('manual — TYPED, and therefore still editable', () => {
  it('the qualifying field is an EDITABLE input, marked as entered, and is not dressed up as a calculation', () => {
    renderCard({ numChildren: 3 });
    const q = qualifyingInput();
    expect(q, 'a manual employee has nothing to derive from: locking this leaves it unfillable').not.toBeNull();
    expect(q!.readOnly).toBe(false);
    expect(text('[data-child-qualifying-provenance]')).toBe(D.childProvenanceEntered);
    expect(text('[data-child-physical-provenance]')).toBe(D.childProvenanceEntered);
    expect(physical().readOnly).toBe(false);
  });

  it('there is NO breakdown table, because nothing was worked out — a sentence says what the figure is instead', () => {
    renderCard({ numChildren: 3 });
    expect(document.querySelector('[data-child-breakdown]'), 'a table under a typed number implies one').toBeNull();
    expect(text('[data-child-manual-note]')).toContain(rm(RELIEFS.perChild));
  });

  it('the two boxes are ONE stored number: typing in either moves both, and the relief follows', async () => {
    const { user } = renderCard({ numChildren: 0 });
    await user.clear(qualifyingInput()!);
    await user.type(qualifyingInput()!, '4');
    expect(physical().value, 'manual mode has one num_children; the screen must not imply two').toBe('4');
    // The kernel's own child leg for a manual employee: four typed children at the ruleset's per-child rate.
    expect(text('[data-child-relief-amount]')).toContain(rm(kernelFlatRM(4)));
  });
});

describe('auto_table — DERIVED from the relief table, and read-only', () => {
  const WORKED_EXAMPLE = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };

  it("the reporter's worked example: two physical children, NINE qualifying children", () => {
    renderCard({ mode: 'auto_table', numChildren: 2, grid: WORKED_EXAMPLE });
    expect(physical().value, 'the head count Form E reads is still two people').toBe('2');
    expect(qualifyingText()).toBe('9');
    // THE KERNEL'S OWN FIGURE for this employee, from the pack call core/payroll.ts makes over the same
    // grid — not the literal 18,000 this file used to carry, which could have agreed with nothing.
    expect(text('[data-child-relief-amount]')).toContain(rm(kernelTableRM(WORKED_EXAMPLE)));
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelTableRM(WORKED_EXAMPLE)));
    // …and the count on screen is that money at the ruleset's own per-child rate. If the two ever came
    // apart, one of them would be a figure nobody could stand behind.
    expect(Number(qualifyingText()) * RELIEFS.perChild).toBeCloseTo(kernelTableRM(WORKED_EXAMPLE), 2);
  });

  it('the qualifying figure is NOT editable, and says what it was worked out from', () => {
    renderCard({ mode: 'auto_table', numChildren: 2, grid: WORKED_EXAMPLE });
    expect(qualifyingInput(), 'the children’s records decide it, so there is nothing to type into').toBeNull();
    expect(qualifyingValue()).not.toBeNull();
    expect(text('[data-child-qualifying-provenance]')).toBe(D.childProvenanceFromTable);
    expect(physical().readOnly, 'the head count is the grid total in this mode').toBe(true);
  });

  it('the breakdown shows one line per category with its share, units and ringgit, and the lines add to the total', () => {
    renderCard({ mode: 'auto_table', numChildren: 3, grid: { under_18: { full: 2, half: 1 } } });
    const rows = breakdownRows();
    // under_18 at 100% (two children) and under_18 at 50% (one) — the share is visible, not averaged.
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain(en.people.detail.family.childReliefPct_100);
    expect(rows[1].textContent).toContain(en.people.detail.family.childReliefPct_50);
    // The Relief category column names the category…
    expect(rows[0].textContent).toContain('Child under 18');
    // …and the Item column says how many children the line stands for, ONCE. It used to print the category
    // name a second time in the same row, which left the reader checking whether the two cells disagreed.
    const cells = Array.from(rows[0].querySelectorAll('td')).map((c) => c.textContent?.trim());
    expect(cells[0]).toBe('2 child(ren)');
    expect(cells[1]).toBe('Child under 18');
    expect(cells[0], 'the two leading columns must not say the same thing').not.toBe(cells[1]);
    // 2 full + half a child = 2.5 qualifying children, RM5,000 — unrounded, because rounding the count
    // would make it disagree with the money beside it.
    expect(text('[data-child-breakdown-total-units]')).toBe('2.5');
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelTableRM({ under_18: { full: 2, half: 1 } })));
    expect(qualifyingText()).toBe('2.5');
    expect(text('[data-child-ruleset-version]')).toContain('2026.9');
  });

  it('an unkeyed grid claims nothing and says so, rather than showing the head count as if it were the figure', () => {
    renderCard({ mode: 'auto_table', numChildren: 3, grid: null });
    expect(qualifyingText()).toBe('0');
    expect(text('[data-child-breakdown-empty]')).toBe(D.childQualifyingBreakdownEmpty);
    expect(breakdownRows().length).toBe(0);
  });

  it('the figure tracks the grid AS IT IS TYPED — it is not a stale number computed for the saved record', async () => {
    const { user } = renderCard({ mode: 'auto_table', numChildren: 0, grid: null });
    expect(qualifyingText()).toBe('0');
    const tertiary = screen.getByLabelText('18+ in diploma/degree study (and above) — 100%');
    await user.clear(tertiary);
    await user.type(tertiary, '2');
    // Two tertiary-study children: 8 qualifying children, RM16,000 — priced from the pack's own figures.
    expect(qualifyingText()).toBe('8');
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelTableRM({ study_tertiary: { full: 2, half: 0 } })));
    expect(physical().value, 'and the head count stays a head count: two children').toBe('2');
  });
});

describe('auto — DERIVED from the Family records, and it is the PAYSLIP\'s figure that is shown', () => {
  /**
   * THE SHAPE THAT BROKE, as a fixture. A child had a birthday: `num_children` still holds 2 (the sync fires
   * on a dependent add / edit / archive and on nothing else, so nothing rewrote it), while the Family
   * register now holds ONE eligible child. Payroll deducts 2 × RM2,000; the records support 1 × RM2,000.
   *
   * ⚠️ r351 — WHICH OF THOSE TWO THE CARD PRINTS IS REVERSED, AND THE RULE BEHIND IT IS NOT. r340 made the
   * card print the stored figure because the card had been printing the eligible-child figure while saying
   * nothing about the payslip. r351 prints the eligible-child figure again — it is the one the caption
   * "Qualifying children (PCB)" claims to describe, and the total has to sum to the rows beneath it — and
   * keeps r340's rule by requiring the stored figure to be NAMED in the same fieldset. `storedReliefRM` is
   * what makes that possible; the assertions below pin BOTH numbers, so the card cannot go back to showing
   * one and hiding the other in either direction.
   *
   * Everything in here is what core/dependents.ts `qualifyingChildReliefFor` returns for that record, with
   * the money taken from the kernel's own expression rather than typed out. The surviving child carries a
   * category, so the derived grid is complete and the figure is priced by category — which for `under_18`
   * is one unit, the same RM2,000 the head-count branch would give it.
   */
  const AGED_OUT: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 2,
    eligibleChildren: 1,
    familyChildren: 2,
    uncategorisedChildren: 0,
    pricedFromGrid: true,
    qualifyingChildren: 1,
    reliefRM: kernelTableRM({ under_18: { full: 1, half: 0 } }),
    storedQualifyingChildren: 2,
    storedReliefRM: kernelFlatRM(2),
    derivedGrid: { under_18: { full: 1, half: 0 } },
    ruleUnits: 1,
    ruleReliefRM: kernelTableRM({ under_18: { full: 1, half: 0 } }),
    breakdown: [
      {
        kind: 'child',
        name: 'Ain',
        category: 'under_18',
        sharePercent: 100,
        children: 1,
        units: 1,
        amountRM: RELIEFS.perChild,
      },
    ],
  };

  /** An in-step 'auto' record: two eligible children, head count two, nothing stale. One child carries no
   *  category, so the register cannot be priced by category and the head-count branch decides — which is
   *  what keeps `pricedFromGrid: false` a reachable state after r351 derives the grid from the register. */
  const FAMILY: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 2,
    eligibleChildren: 2,
    familyChildren: 2,
    uncategorisedChildren: 1,
    pricedFromGrid: false,
    qualifyingChildren: 2,
    reliefRM: kernelFlatRM(2),
    storedQualifyingChildren: 2,
    storedReliefRM: kernelFlatRM(2),
    derivedGrid: null,
    breakdown: [
      { kind: 'child', name: 'Bala', category: 'study_tertiary', sharePercent: 50, children: 1, units: 1, amountRM: RELIEFS.perChild },
      { kind: 'child', name: 'Ain', category: null, sharePercent: 100, children: 1, units: 1, amountRM: RELIEFS.perChild },
    ],
  };

  /**
   * DANIEL TAN, EMP-0002, AS PRODUCTION ACTUALLY HOLDS HIM (r347, item 04b88724).
   *
   * mode 'auto' with the grid STORED: one under-18 child (1 unit) and one disabled child in qualifying
   * higher education (8 units) = 9 qualifying children, RM18,000. Before r347 this card showed the head
   * count — 2 children, RM4,000 — while his payslip already used the weighted figure. The card was the
   * wrong half, and this fixture is the case the reporter raised.
   */
  const WEIGHTED: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 2,
    eligibleChildren: 2,
    familyChildren: 2,
    uncategorisedChildren: 0,
    pricedFromGrid: true,
    qualifyingChildren: 9,
    reliefRM: RELIEFS.childByCategory!.under_18 + RELIEFS.childByCategory!.disabled_study,
    // In step: the grid on file IS the grid the register derives, so payroll and the card agree to the cent.
    storedQualifyingChildren: 9,
    storedReliefRM: RELIEFS.childByCategory!.under_18 + RELIEFS.childByCategory!.disabled_study,
    derivedGrid: { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } },
    ruleUnits: 9,
    ruleReliefRM: RELIEFS.childByCategory!.under_18 + RELIEFS.childByCategory!.disabled_study,
    breakdown: [
      { kind: 'child', name: 'Under 18 Child A', category: 'under_18', sharePercent: 100, children: 1, units: 1, amountRM: RELIEFS.childByCategory!.under_18 },
      { kind: 'child', name: 'D Child Study', category: 'disabled_study', sharePercent: 100, children: 1, units: 8, amountRM: RELIEFS.childByCategory!.disabled_study },
    ],
  };

  it('a weighted register shows the WEIGHTED count, and the note says the category prices it', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: WEIGHTED });
    expect(qualifyingText(), 'nine qualifying children, not the head count of two').toBe('9');
    expect(text('[data-child-breakdown-total-units]')).toBe('9');
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(WEIGHTED.reliefRM));
    // The disabled-in-study child carries its own eight, on its own row.
    const rows = breakdownRows();
    expect(rows[1].textContent).toContain('D Child Study');
    expect(rows[1].textContent).toContain('8');
    // The head-count note must be ABSENT and the weighted one present — before r347 it was the reverse.
    expect(document.querySelector('[data-child-auto-units-note]'), 'the head-count note must not render').toBeNull();
    expect(text('[data-child-auto-weighted-note]')).toBe(D.childQualifyingAutoWeightedNote);
  });

  it('a weighted register carries NO gap warning — the card and the payslip now agree', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: WEIGHTED });
    expect(document.querySelector('[data-child-auto-weighting-gap]')).toBeNull();
    expect(document.querySelector('[data-child-uncategorised]')).toBeNull();
  });

  it('the figure is read-only, marked as worked out from the Family records', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(qualifyingInput()).toBeNull();
    expect(qualifyingText()).toBe('2');
    expect(text('[data-child-qualifying-provenance]')).toBe(D.childProvenanceFromFamily);
  });

  it('one line per eligible child, each worth ONE qualifying child — with a note saying the category prices nothing in this mode', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    const rows = breakdownRows();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Bala');
    expect(rows[1].textContent).toContain('Ain');
    // A tertiary-study child is worth 4 in the category table — but NOT in this mode, where the kernel's
    // child leg is num_children × perChild. Printing 4 here would contradict the payslip.
    expect(text('[data-child-breakdown-total-units]')).toBe('2');
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(kernelFlatRM(2)));
    expect(text('[data-child-auto-units-note]')).toBe(D.childQualifyingAutoUnitsNote);
  });

  it('a child with no relief category is reported, because a category-priced figure would omit them silently', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(text('[data-child-uncategorised]')).toContain('1');
    expect(document.querySelector('[data-child-uncategorised]')).not.toBeNull();
  });

  // ── THE r340 BLOCKING DEFECT, AND THE r351 REVERSAL OF WHICH FIGURE IS PRINTED ─────────────────────
  //
  // ⚠️ THIS CASE USED TO READ: "BLOCKING: the relief on screen is the KERNEL's — the STORED head count ×
  // perChild, not a count of eligible children". That was r340's decision and r351 reverses it, because the
  // stored column is written only by a family edit — nothing fires on the passage of time — so a figure
  // captioned "Qualifying children (PCB)" was describing whatever an unrelated edit last left there, could
  // contradict the Family tab about the same child, and printed a total its own rows did not sum to.
  //
  // WHAT r340 WAS PROTECTING IS NOT REVERSED AND IS ASSERTED HERE, HARDER THAN BEFORE: the card may not
  // print a relief figure without naming what payroll actually deducts. It used to satisfy that by printing
  // only the payslip's figure. It now satisfies it by printing BOTH and labelling each, so this case pins
  // the pair — the register figure in the field, the stored figure in the amber line — and a card that
  // showed either one alone would fail it whichever one it chose.
  it('BLOCKING: the field shows what the REGISTER supports, and the fieldset names what payroll deducts', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: AGED_OUT });
    const payslip = kernelFlatRM(AGED_OUT.physicalChildren); // what core/payroll.ts deducts: 2 × RM2,000
    const records = kernelTableRM({ under_18: { full: 1, half: 0 } }); // what the register supports: RM2,000
    expect(payslip, 'the fixture must actually distinguish the two, or this test proves nothing').not.toBe(records);

    // (a) THE FIGURE IN THE FIELD IS THE REGISTER'S, to the cent, from the pack's own call.
    expect(
      text('[data-child-relief-amount]'),
      'the screen states the relief the Family records support',
    ).toContain(rm(records));
    expect(qualifyingText(), 'QC is that money at the ruleset rate').toBe(String(records / RELIEFS.perChild));
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(records));

    // (b) AND THE WORKING SUMS TO IT. This is the defect the reporter could see: one row worth 1 under a
    // stated total of 2. Both come from one eligible-child list at one date now.
    expect(breakdownRows()).toHaveLength(AGED_OUT.eligibleChildren);
    expect(text('[data-child-breakdown-total-units]')).toBe(String(AGED_OUT.eligibleChildren));

    // (c) r340's RULE, KEPT: the money payroll is still deducting is named in the same fieldset. Without
    // this the reversal would be the r340 defect with the two figures swapped.
    const stale = text('[data-child-stale-figure]');
    expect(stale, 'a screen that prints one figure and hides the other is r340 in either direction').not.toBe('');
    expect(stale, 'it names what payroll deducts until the record is saved').toContain(rm(payslip));
    expect(stale, 'and what the records support, so the reader can see which is which').toContain(rm(records));
  });

  // ── THE r340 FIX-PASS REGRESSION, PINNED ─────────────────────────────────────────────────────────
  // An empty breakdown has TWO causes that say OPPOSITE things about the money, and the first fix pass
  // chose between them on `breakdown.length` alone. A record stored 'auto' whose Family register is
  // empty still has a `num_children` head count, and that is what the payslip multiplies — so relief IS
  // claimed while there is nothing here to itemise it with. The card printed "Child relief: RM 10,000.00"
  // and, four elements below, "Nothing is keyed yet, so no child relief is claimed". One fieldset, two
  // incompatible statements about the same money, on a screen whose whole purpose this round is to stop
  // two child numbers being confused. Production has three employees stored 'auto', so it is reachable.
  /**
   * Stored 'auto', head count 5, Family register EMPTY — relief is claimed, nothing can itemise it.
   *
   * ⚠️ r351 — THE FIGURE THE CARD SHOWS IS NOW NOTHING, AND THE CONTRADICTION ARRIVES FROM THE OTHER SIDE.
   * Before r351 the card printed the stored 5 × RM2,000 and the danger was an empty box saying "no child
   * relief is claimed" under it. Now the card prints what the register supports — RM0 — while `num_children`
   * still has payroll deducting RM10,000, so the same false sentence is reachable by reading the OTHER
   * figure. The card therefore tests the LARGER of the two, and this case is what would notice it going back
   * to testing one.
   */
  const EMPTY_REGISTER: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 5,
    eligibleChildren: 0,
    familyChildren: 0,
    uncategorisedChildren: 0,
    pricedFromGrid: false,
    qualifyingChildren: 0,
    reliefRM: 0,
    storedQualifyingChildren: 5,
    storedReliefRM: kernelFlatRM(5),
    derivedGrid: null,
    breakdown: [],
  };

  it('an empty register whose STORED head count still claims relief never says "no child relief is claimed"', () => {
    renderCard({ mode: 'auto', numChildren: 5, pricing: EMPTY_REGISTER });
    const claimed = kernelFlatRM(EMPTY_REGISTER.physicalChildren);
    expect(claimed, 'the fixture must actually claim money, or this test proves nothing').toBeGreaterThan(0);
    expect(
      EMPTY_REGISTER.reliefRM,
      'and the two figures must differ, or the "larger of the two" rule is not being exercised',
    ).not.toBe(claimed);
    expect(breakdownRows(), 'and there is genuinely nothing to itemise').toHaveLength(0);
    // THE CONTRADICTION ITSELF: the box may not deny money that either figure is spending.
    expect(
      text('[data-child-breakdown-empty]'),
      'one fieldset cannot both claim the relief and deny it',
    ).not.toBe(D.childQualifyingBreakdownEmpty);
    expect(text('[data-child-breakdown-empty]'), 'it names the amount that IS claimed').toContain(rm(claimed));
    // …and the amber line states which figure is which, so "RM0" on screen is never read as "nothing owed".
    expect(text('[data-child-stale-figure]'), 'payroll is behind, and the card says so').toContain(rm(claimed));
  });

  it('…while an unkeyed grid, which really does claim nothing, still says so', () => {
    renderCard({ mode: 'auto_table', numChildren: 0, grid: null, pricing: { ...PRICING, mode: 'auto_table', derived: true, physicalChildren: 0, eligibleChildren: 0, familyChildren: 0, uncategorisedChildren: 0, qualifyingChildren: 0, reliefRM: 0, breakdown: [] } });
    expect(text('[data-child-breakdown-empty]'), 'the original sentence is correct HERE').toBe(
      D.childQualifyingBreakdownEmpty,
    );
  });

  it("…and SAYS what payroll is still deducting, instead of leaving the disagreement silent", () => {
    // ⚠️ REWORDED IN r351: this used to assert the two HEAD COUNTS appeared in the sentence. Head counts
    // cannot see the case that costs the most — a stale relief GRID moves RM2,000 to RM16,000 with the
    // counts unmoved, and since r344 the payslip prices that grid. The sentence, and this case, are about
    // the RINGGIT on both sides, which is what actually lands on a payslip.
    renderCard({ mode: 'auto', numChildren: 2, pricing: AGED_OUT });
    const stale = text('[data-child-stale-figure]');
    expect(stale, 'a screen that prints one figure without a word about the other is the worst option').not.toBe('');
    expect(stale, 'what payroll deducts').toContain(rm(AGED_OUT.storedReliefRM));
    expect(stale, 'and what the records support').toContain(rm(AGED_OUT.reliefRM));
    expect(stale, 'no unsubstituted ICU placeholders').not.toMatch(/\{[a-zA-Z]/);
  });

  it('…and says nothing when the stored figure and the records agree, so the warning means something when it appears', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(document.querySelector('[data-child-stale-figure]')).toBeNull();
  });

  it('⚠️ a stale GRID is caught too, though the head counts are identical — the case r351 widened the test for', () => {
    // Two eligible children either way. The stored grid still says both are under 18 (RM4,000); the register
    // now says one of them is a disabled child in higher education (RM2,000 + RM16,000). The old head-count
    // comparison saw 2 === 2 and said nothing while RM14,000 of relief sat on the wrong side of a save.
    const storedGrid = { under_18: { full: 2, half: 0 } };
    const derived = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };
    const STALE_GRID: ChildReliefPricing = {
      ...PRICING,
      mode: 'auto',
      derived: true,
      physicalChildren: 2,
      eligibleChildren: 2,
      familyChildren: 2,
      uncategorisedChildren: 0,
      pricedFromGrid: true,
      qualifyingChildren: kernelTableRM(derived) / RELIEFS.perChild,
      reliefRM: kernelTableRM(derived),
      storedQualifyingChildren: kernelTableRM(storedGrid) / RELIEFS.perChild,
      storedReliefRM: kernelTableRM(storedGrid),
      derivedGrid: derived,
      ruleUnits: kernelTableRM(derived) / RELIEFS.perChild,
      ruleReliefRM: kernelTableRM(derived),
      breakdown: [
        { kind: 'child', name: 'Ain', category: 'under_18', sharePercent: 100, children: 1, units: 1, amountRM: RELIEFS.childByCategory!.under_18 },
        { kind: 'child', name: 'Bala', category: 'disabled_study', sharePercent: 100, children: 1, units: 8, amountRM: RELIEFS.childByCategory!.disabled_study },
      ],
    };
    expect(
      STALE_GRID.physicalChildren,
      'the head counts MUST be equal, or this case is not testing what it says it tests',
    ).toBe(STALE_GRID.eligibleChildren);
    expect(STALE_GRID.storedReliefRM, 'and the money must differ').not.toBe(STALE_GRID.reliefRM);

    renderCard({ mode: 'auto', numChildren: 2, grid: storedGrid, pricing: STALE_GRID });
    const stale = text('[data-child-stale-figure]');
    expect(stale, 'the gap is real money and must be named').not.toBe('');
    expect(stale).toContain(rm(STALE_GRID.storedReliefRM));
    expect(stale).toContain(rm(STALE_GRID.reliefRM));
  });

  it('in auto mode the hidden grid inputs POST THE DERIVED GRID, so a Save really does bring payroll in step', () => {
    // The amber line promises that saving closes the gap. For the head count that was already true — the
    // Physical children box posts `eligibleChildren`. For a record priced from a GRID it was FALSE: these
    // hidden inputs re-posted the stale grid verbatim out of `defaults.childReliefTable`, so the save wrote
    // the old grid straight back and the payslip did not move. This is the contract between the card and
    // `collectChildReliefTable` in actions.ts, so it is pinned on the posted fields.
    const derived = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };
    renderCard({
      mode: 'auto',
      numChildren: 2,
      grid: { under_18: { full: 2, half: 0 } }, // the STALE stored grid the card was rendered with
      pricing: { ...FAMILY, pricedFromGrid: true, derivedGrid: derived },
    });
    const posted = (key: string, share: 'full' | 'half') =>
      (document.querySelector(`input[name="childRelief_${key}_${share}"]`) as HTMLInputElement | null)?.value;
    expect(posted('under_18', 'full'), 'the DERIVED grid, not the stored 2').toBe('1');
    expect(posted('disabled_study', 'full'), 'the category the register actually holds').toBe('1');
    expect(posted('disabled', 'full'), 'a category the register does not hold posts zero').toBe('0');
    expect(posted('under_18', 'half'), 'and the half column follows the derivation too').toBe('0');
  });

  it('…but MANUAL mode still posts the stored grid verbatim, so a keyed grid is never wiped by a save', () => {
    // 'manual' short-circuits the sync (NO_SYNC('manual_mode')), so nothing there is machine-maintained and
    // the grid must survive a save untouched. Posting a derivation here would silently change somebody's tax.
    renderCard({
      mode: 'manual',
      numChildren: 3,
      grid: { disabled: { full: 2, half: 1 } },
      pricing: { ...PRICING, derivedGrid: { under_18: { full: 9, half: 0 } } },
    });
    const posted = (key: string, share: 'full' | 'half') =>
      (document.querySelector(`input[name="childRelief_${key}_${share}"]`) as HTMLInputElement | null)?.value;
    expect(posted('disabled', 'full')).toBe('2');
    expect(posted('disabled', 'half')).toBe('1');
    expect(posted('under_18', 'full'), 'the derivation must NOT leak into a manual save').toBe('0');
  });

  it('children ARE recorded and none of them qualifies — said in those words, not "the register is empty"', () => {
    // The reporter's exact scenario, and the sentence they were shown was that their Family register held no
    // children, which they could see with their own eyes to be false. `childQualifyingBreakdownUnsupported`
    // is retired for it.
    const NONE_ELIGIBLE: ChildReliefPricing = {
      ...PRICING,
      mode: 'auto',
      derived: true,
      physicalChildren: 2,
      eligibleChildren: 0,
      familyChildren: 2,
      uncategorisedChildren: 0,
      pricedFromGrid: false,
      qualifyingChildren: 0,
      reliefRM: 0,
      storedQualifyingChildren: 2,
      storedReliefRM: kernelFlatRM(2),
      derivedGrid: null,
      breakdown: [],
    };
    renderCard({ mode: 'auto', numChildren: 2, pricing: NONE_ELIGIBLE });
    const said = text('[data-child-none-eligible]');
    expect(said, 'the card must explain why nothing qualifies').not.toBe('');
    expect(said, 'and name how many children ARE on file').toContain(String(NONE_ELIGIBLE.familyChildren));
    expect(said, 'no unsubstituted ICU placeholders').not.toMatch(/\{[a-zA-Z]/);
    expect(said, 'and it must not claim the register is empty').not.toMatch(/no children are recorded/i);
    // The retired sentence must not render anywhere on the card, in any branch.
    expect(document.body.textContent).not.toContain('No children are recorded in the Family register');
    expect(document.body.textContent, 'a retired key must never reach a screen').not.toMatch(/\[retired r351/);
  });

  it('…and says nothing in auto_table, where the keyed grid decides and the register does not', () => {
    // Telling an administrator on the category grid that their children do not qualify would be the next
    // false sentence: in that mode the register is not what is being priced.
    renderCard({
      mode: 'auto_table',
      numChildren: 2,
      grid: { under_18: { full: 2, half: 0 } },
      pricing: { ...PRICING, mode: 'auto_table', derived: true, familyChildren: 2, eligibleChildren: 0, physicalChildren: 2 },
    });
    expect(document.querySelector('[data-child-none-eligible]')).toBeNull();
  });

  it('a child with no date of birth is NAMED, rather than counted zero in silence', () => {
    renderCard({
      mode: 'auto',
      numChildren: 2,
      pricing: { ...FAMILY, undatedChildren: ['Undated Child'] },
    });
    const said = text('[data-child-no-dob]');
    expect(said, 'the name is the actionable part — one field on one child fixes it').toContain('Undated Child');
    expect(said).not.toMatch(/\{[a-zA-Z]/);
  });

  it('…and nothing is said when every child has one, so the line means something when it appears', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(document.querySelector('[data-child-no-dob]')).toBeNull();
  });

  it('a mode the admin has just PICKED and not saved is not called stale — nothing is on file to be stale', () => {
    // Stored as manual with a typed 5; the select is switched to Auto but nothing is saved yet. The stored
    // provenance is `manual`, so the staleness line — which is about a figure ON FILE — must stay away.
    renderCard({
      mode: 'auto',
      numChildren: 5,
      pricing: { ...PRICING, mode: 'manual', derived: false, physicalChildren: 5, eligibleChildren: 1 },
    });
    expect(document.querySelector('[data-child-stale-figure]')).toBeNull();
  });

  it('ONE INSTANT: the head count shown and the breakdown lines come from the same eligible-child list', () => {
    // The two used to be taken at different instants — the rows at Kuala Lumpur "today" and the count at
    // real UTC now — so on a child's 18th birthday the table could hold one more line than the box admitted.
    // There is one count now, and this is what would notice a second one appearing.
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(physical().value).toBe(String(FAMILY.eligibleChildren));
    expect(breakdownRows().length).toBe(FAMILY.eligibleChildren);
    document.body.innerHTML = '';
    renderCard({ mode: 'auto', numChildren: 2, pricing: AGED_OUT });
    expect(physical().value).toBe(String(AGED_OUT.eligibleChildren));
    expect(breakdownRows().length).toBe(AGED_OUT.eligibleChildren);
  });
});

describe('when the Family register and the tax field disagree, the screen says so', () => {
  it('the Family record count is shown beside the head count when the two differ', () => {
    renderCard({ numChildren: 1, pricing: { ...PRICING, familyChildren: 3 } });
    expect(text('[data-child-family-count]')).toContain('3');
  });

  it('…and is not shown when they agree, so the hint means something when it appears', () => {
    renderCard({ numChildren: 3, pricing: { ...PRICING, familyChildren: 3 } });
    expect(document.querySelector('[data-child-family-count]')).toBeNull();
  });
});

describe('no country pack / no PCB reliefs', () => {
  it('names no figure at all rather than inventing a rate, and the head count still works', () => {
    renderCard({ numChildren: 2, pricing: null });
    expect(physical().value).toBe('2');
    expect(document.querySelector('[data-child-relief-amount]')).toBeNull();
    expect(document.querySelector('[data-child-breakdown]')).toBeNull();
    expect(document.querySelector('[data-child-manual-note]')).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * r351 — THE FOUR NEW SENTENCES RENDER, IN ALL SIX LOCALES
 *
 * A message key that resolves in English and is missing, misspelt or malformed in another catalogue passes
 * `tsc`, passes the whole node suite and passes `next build`; it surfaces as `MISSING_MESSAGE` or
 * `FORMATTING_ERROR` on a screen, in a language nobody on this side reads (CLAUDE.md §8). The catalogue
 * guard in test/r351-child-relief-register-truth.test.ts proves the keys EXIST and carry the right
 * placeholders; only a render proves next-intl can actually produce a sentence from them with the arguments
 * this card passes. Four of the sentences here are new this round and one of them carries five arguments.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('r351 · every new line on the card resolves in all six locales', () => {
  /** Stale in BOTH directions at once: payroll behind, no child eligible, and one child undated. It makes
   *  all four new lines render from a single fixture, so one pass per locale covers every one of them. */
  const ALL_LINES: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 3,
    eligibleChildren: 0,
    familyChildren: 3,
    uncategorisedChildren: 0,
    pricedFromGrid: false,
    qualifyingChildren: 0,
    reliefRM: 0,
    storedQualifyingChildren: 3,
    storedReliefRM: kernelFlatRM(3),
    derivedGrid: null,
    undatedChildren: ['Siti', 'Arun'],
    breakdown: [],
  };

  it.each([
    ['en', en],
    ['ms', ms],
    ['ta', ta],
    ['th', th],
    ['vi', vi_],
    ['zh', zh],
  ])('%s renders all four with every argument substituted', (loc, m) => {
    renderCard({ mode: 'auto', numChildren: 3, pricing: ALL_LINES, messages: m });
    for (const sel of [
      '[data-child-stale-figure]', // childQualifyingPayrollBehind — five arguments
      '[data-child-none-eligible]', // childQualifyingNoneEligible
      '[data-child-no-dob]', // childQualifyingNoDob
      '[data-child-breakdown-empty]', // childQualifyingBreakdownUnitemised
    ]) {
      const s = text(sel);
      expect(s, `${loc} ${sel} did not render`).not.toBe('');
      expect(s, `${loc} ${sel} left an ICU placeholder unsubstituted`).not.toMatch(/\{[a-zA-Z]/);
      expect(s, `${loc} ${sel} failed to resolve`).not.toMatch(
        /MISSING_MESSAGE|FORMATTING_ERROR|people\.detail/,
      );
      expect(s, `${loc} ${sel} rendered a RETIRED key`).not.toMatch(/\[retired r/);
    }
    // The figure payroll is deducting must survive the translation: a locale that drops it leaves a reader
    // looking at RM0 with nothing telling them their payslip disagrees. Only this one is asserted here —
    // the register figure on this fixture is 0.00, which is a SUBSTRING of every other amount on the line,
    // so asserting it would pass whatever the sentence said. Both figures are pinned against each other in
    // English, where they are distinguishable, by the BLOCKING and stale-GRID cases above.
    const stale = text('[data-child-stale-figure]');
    expect(stale, `${loc}: what payroll deducts`).toContain(rm(ALL_LINES.storedReliefRM));
    // And the named children must survive the translation, because the name is the actionable part.
    expect(text('[data-child-no-dob]'), `${loc}: the names`).toContain('Siti');
    expect(text('[data-child-no-dob]'), `${loc}: both of them`).toContain('Arun');
  });
});
