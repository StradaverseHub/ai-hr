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
  mode: 'manual',
  derived: false,
  physicalChildren: 0,
  eligibleChildren: 0,
  qualifyingChildren: 0,
  reliefRM: 0,
  breakdown: [],
};

function renderCard(over: {
  mode?: string;
  numChildren?: number;
  grid?: Record<string, { full: number; half: number }> | null;
  pricing?: ChildReliefPricing | null;
} = {}) {
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale="en" messages={en as never}>
      <IdentityTaxCard
        action={() => {}}
        employmentId="emp-1"
        personId="person-1"
        childRelief={over.pricing === undefined ? PRICING : over.pricing}
        defaults={{
          taxNumber: 'IG1',
          taxCategory: 1,
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
   * THE SHAPE THAT BROKE, as a fixture. A child had a birthday: `num_children` still holds 2 (the sync only
   * fires on a dependent add / edit / archive, so nothing rewrote it), while the Family register now holds
   * ONE eligible child. The payslip deducts 2 × RM2,000. The card used to print the ONE, in ringgit.
   *
   * Everything in here is what core/dependents.ts `qualifyingChildReliefFor` returns for that record, with
   * the money taken from the kernel's own expression rather than typed out.
   */
  const AGED_OUT: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 2,
    eligibleChildren: 1,
    familyChildren: 2,
    uncategorisedChildren: 0,
    qualifyingChildren: 2,
    reliefRM: kernelFlatRM(2),
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

  /** An in-step 'auto' record: two eligible children, head count two, nothing stale. */
  const FAMILY: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 2,
    eligibleChildren: 2,
    familyChildren: 2,
    uncategorisedChildren: 1,
    qualifyingChildren: 2,
    reliefRM: kernelFlatRM(2),
    breakdown: [
      { kind: 'child', name: 'Bala', category: 'study_tertiary', sharePercent: 50, children: 1, units: 1, amountRM: RELIEFS.perChild },
      { kind: 'child', name: 'Ain', category: null, sharePercent: 100, children: 1, units: 1, amountRM: RELIEFS.perChild },
    ],
  };

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

  // ── THE r340 BLOCKING DEFECT, PINNED ───────────────────────────────────────────────────────────────
  it("BLOCKING: the relief on screen is the KERNEL's — the STORED head count × perChild, not a count of eligible children", () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: AGED_OUT });
    const payslip = kernelFlatRM(AGED_OUT.physicalChildren); // what core/payroll.ts deducts: 2 × RM2,000
    const wrong = kernelFlatRM(AGED_OUT.eligibleChildren); // what the card used to print: 1 × RM2,000
    expect(payslip, 'the fixture must actually distinguish the two, or this test proves nothing').not.toBe(wrong);
    expect(
      text('[data-child-relief-amount]'),
      'the screen must state the relief the payslip deducts, to the cent',
    ).toContain(rm(payslip));
    expect(
      text('[data-child-relief-amount]'),
      'and must NOT state the figure a render-time count of eligible children would give',
    ).not.toContain(rm(wrong));
    expect(qualifyingText(), 'QC is that money at the ruleset rate').toBe(String(payslip / RELIEFS.perChild));
    expect(text('[data-child-breakdown-total-rm]')).toBe(rm(payslip));
  });

  // ── THE r340 FIX-PASS REGRESSION, PINNED ─────────────────────────────────────────────────────────
  // An empty breakdown has TWO causes that say OPPOSITE things about the money, and the first fix pass
  // chose between them on `breakdown.length` alone. A record stored 'auto' whose Family register is
  // empty still has a `num_children` head count, and that is what the payslip multiplies — so relief IS
  // claimed while there is nothing here to itemise it with. The card printed "Child relief: RM 10,000.00"
  // and, four elements below, "Nothing is keyed yet, so no child relief is claimed". One fieldset, two
  // incompatible statements about the same money, on a screen whose whole purpose this round is to stop
  // two child numbers being confused. Production has three employees stored 'auto', so it is reachable.
  /** Stored 'auto', head count 5, Family register EMPTY — relief is claimed, nothing can itemise it. */
  const EMPTY_REGISTER: ChildReliefPricing = {
    ...PRICING,
    mode: 'auto',
    derived: true,
    physicalChildren: 5,
    eligibleChildren: 0,
    familyChildren: 0,
    uncategorisedChildren: 0,
    qualifyingChildren: 5,
    reliefRM: kernelFlatRM(5),
    breakdown: [],
  };

  it('an empty register under a CLAIMED relief never says "no child relief is claimed"', () => {
    renderCard({ mode: 'auto', numChildren: 5, pricing: EMPTY_REGISTER });
    const claimed = kernelFlatRM(EMPTY_REGISTER.physicalChildren);
    expect(claimed, 'the fixture must actually claim money, or this test proves nothing').toBeGreaterThan(0);
    expect(text('[data-child-relief-amount]'), 'the payslip deducts it').toContain(rm(claimed));
    expect(breakdownRows(), 'and there is genuinely nothing to itemise').toHaveLength(0);
    // THE CONTRADICTION ITSELF: the box may not deny the money the line above it states.
    expect(
      text('[data-child-breakdown-empty]'),
      'one fieldset cannot both claim the relief and deny it',
    ).not.toBe(D.childQualifyingBreakdownEmpty);
    expect(text('[data-child-breakdown-empty]'), 'it names the amount that IS claimed').toContain(rm(claimed));
  });

  it('…while an unkeyed grid, which really does claim nothing, still says so', () => {
    renderCard({ mode: 'auto_table', numChildren: 0, grid: null, pricing: { ...PRICING, mode: 'auto_table', derived: true, physicalChildren: 0, eligibleChildren: 0, familyChildren: 0, uncategorisedChildren: 0, qualifyingChildren: 0, reliefRM: 0, breakdown: [] } });
    expect(text('[data-child-breakdown-empty]'), 'the original sentence is correct HERE').toBe(
      D.childQualifyingBreakdownEmpty,
    );
  });

  it("…and SAYS the Family records no longer support it, instead of leaving the disagreement silent", () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: AGED_OUT });
    const stale = text('[data-child-stale-figure]');
    expect(stale, 'a screen that prints the stale figure without a word is the worst of the options').not.toBe('');
    expect(stale).toContain(String(AGED_OUT.physicalChildren));
    expect(stale).toContain(String(AGED_OUT.eligibleChildren));
  });

  it('…and says nothing when the stored figure and the records agree, so the warning means something when it appears', () => {
    renderCard({ mode: 'auto', numChildren: 2, pricing: FAMILY });
    expect(document.querySelector('[data-child-stale-figure]')).toBeNull();
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
