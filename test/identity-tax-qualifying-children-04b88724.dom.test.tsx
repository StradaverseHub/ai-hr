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
 * to track the grid as it is typed. It is computed here from the prices the pack hands down (the statutory
 * rule stays in the pack) multiplied by the counts on screen, and if that ever became a figure the server
 * computed once for the saved record, the screen would start contradicting its own boxes. Hence the typing
 * case at the end.
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

const D = en.people.detail as Record<string, string>;

/** The 2026 ruleset's prices, as core/dependents.ts hands them to the card: RM and RM ÷ perChild. */
const PRICING: ChildReliefPricing = {
  perChild: 2000,
  categories: [
    { key: 'under_18', amountRM: 2000, units: 1 },
    { key: 'study_preu', amountRM: 2000, units: 1 },
    { key: 'study_tertiary', amountRM: 8000, units: 4 },
    { key: 'disabled', amountRM: 8000, units: 4 },
    { key: 'disabled_study', amountRM: 16000, units: 8 },
  ],
  statutoryVersion: '2026.9',
  familyChildren: 2,
  uncategorisedChildren: 0,
  familyRows: [],
};

function renderCard(over: {
  mode?: string;
  numChildren?: number;
  grid?: Record<string, { full: number; half: number }> | null;
  derivedChildCount?: number;
  pricing?: ChildReliefPricing | null;
} = {}) {
  const user = userEvent.setup();
  render(
    <NextIntlClientProvider locale="en" messages={en as never}>
      <IdentityTaxCard
        action={() => {}}
        employmentId="emp-1"
        personId="person-1"
        derivedChildCount={over.derivedChildCount ?? 0}
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
    // The FIELD captions, not any text on the card: the fieldset's own legend happens to carry the same
    // words ("Children (PCB relief)") and is the heading of the group, which is not what changed.
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
      renderCard({ mode, numChildren: 2, grid: { under_18: { full: 2, half: 0 } }, derivedChildCount: 2 });
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
    expect(text('[data-child-manual-note]')).toContain('2,000.00');
  });

  it('the two boxes are ONE stored number: typing in either moves both, and the relief follows', async () => {
    const { user } = renderCard({ numChildren: 0 });
    await user.clear(qualifyingInput()!);
    await user.type(qualifyingInput()!, '4');
    expect(physical().value, 'manual mode has one num_children; the screen must not imply two').toBe('4');
    expect(text('[data-child-relief-amount]')).toContain('8,000.00');
  });
});

describe('auto_table — DERIVED from the relief table, and read-only', () => {
  const WORKED_EXAMPLE = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };

  it("the reporter's worked example: two physical children, NINE qualifying children", () => {
    renderCard({ mode: 'auto_table', numChildren: 2, grid: WORKED_EXAMPLE });
    expect(physical().value, 'the head count Form E reads is still two people').toBe('2');
    expect(qualifyingText()).toBe('9');
    expect(text('[data-child-relief-amount]')).toContain('18,000.00');
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
    expect(rows[0].textContent).toContain('Child under 18');
    // 2 full + half a child = 2.5 qualifying children, RM5,000 — unrounded, because rounding the count
    // would make it disagree with the money beside it.
    expect(text('[data-child-breakdown-total-units]')).toBe('2.5');
    expect(text('[data-child-breakdown-total-rm]')).toBe('5,000.00');
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
    expect(text('[data-child-breakdown-total-rm]')).toBe('16,000.00');
    expect(physical().value, 'and the head count stays a head count: two children').toBe('2');
  });
});

describe('auto — DERIVED from the Family records', () => {
  const FAMILY: ChildReliefPricing = {
    ...PRICING,
    familyChildren: 2,
    uncategorisedChildren: 1,
    familyRows: [
      { name: 'Bala', category: 'study_tertiary', sharePercent: 50 },
      { name: 'Ain', category: null, sharePercent: 100 },
    ],
  };

  it('the figure is read-only, marked as worked out from the Family records', () => {
    renderCard({ mode: 'auto', numChildren: 2, derivedChildCount: 2, pricing: FAMILY });
    expect(qualifyingInput()).toBeNull();
    expect(qualifyingText()).toBe('2');
    expect(text('[data-child-qualifying-provenance]')).toBe(D.childProvenanceFromFamily);
  });

  it('one line per eligible child, each worth ONE qualifying child — with a note saying the category prices nothing in this mode', () => {
    renderCard({ mode: 'auto', numChildren: 2, derivedChildCount: 2, pricing: FAMILY });
    const rows = breakdownRows();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Bala');
    expect(rows[1].textContent).toContain('Ain');
    // A tertiary-study child is worth 4 in the category table — but NOT in this mode, where the kernel's
    // child leg is num_children × perChild. Printing 4 here would contradict the payslip.
    expect(text('[data-child-breakdown-total-units]')).toBe('2');
    expect(text('[data-child-breakdown-total-rm]')).toBe('4,000.00');
    expect(text('[data-child-auto-units-note]')).toBe(D.childQualifyingAutoUnitsNote);
  });

  it('a child with no relief category is reported, because a category-priced figure would omit them silently', () => {
    renderCard({ mode: 'auto', numChildren: 2, derivedChildCount: 2, pricing: FAMILY });
    expect(text('[data-child-uncategorised]')).toContain('1');
    expect(document.querySelector('[data-child-uncategorised]')).not.toBeNull();
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
