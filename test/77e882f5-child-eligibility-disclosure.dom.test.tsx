/**
 * 77e882f5 (r353) — THE COUNT WAS RIGHT AND THE SCREEN WAS THE DEFECT.
 *
 * ═══ WHAT THE PRODUCTION RECORD ACTUALLY SAYS ═══
 *
 * The reporter raised the same child TWICE as an age-check failure. Read off production on 2026-09-28,
 * the ONE non-archived child on that employee is:
 *
 *     full_name 'More than 18Y'   date_of_birth 2004-01-01   is_student f
 *     child_tax_relief TRUE       child_relief_category 'under_18'
 *
 * The child is 22 and `childAgeYears` says so. They are counted because `child_tax_relief` is ticked,
 * and `isChildReliefEligible` honours an explicit per-child decision BEFORE it looks at the date of
 * birth (core/dependents.ts) — deliberately, because that precedence is the only way a disabled child
 * over 18, or one in full-time study, can be claimed at all. So `Qualifying Children = 1` is the correct
 * answer to the data, and unticking the box makes it 0 with no code change.
 *
 * What the screen did was print that 1 and say nothing: no mention that a manual tick produced it, and
 * no mention that a category of "under 18" on a 2004 birth is two facts that cannot both be true. The
 * only reading available to the person looking at it was "the age check is broken" — twice.
 *
 * ═══ WHAT THIS FILE PINS ═══
 *
 * ⚠️ r355 — THE RULE THIS FILE PINNED IS NOW REVERSED, BY THE OWNER, AND THE OLD CLAIM IS QUOTED BELOW
 * RATHER THAN DELETED. r353 asserted "eligible BECAUSE OF THE TICK, not the age" — the tick overrode
 * the age test outright. The owner's contest: "The Claim tax relief checkbox should indicate the user's
 * intention to claim the relief, but it must not override the statutory eligibility validation." So a
 * ticked child is now VALIDATED: under 18, or a student, or a relief category that allows a claim past
 * 18. The production child (born 2004, ticked, category `under_18`) now counts ZERO, which is the
 * outcome the reporter asked for twice.
 *
 * What did NOT change, and both are asserted below: an explicit FALSE still refuses at any age, and a
 * NULL tick still falls through to the pre-77e882f5 inference — because null is most legacy rows and
 * reading it as "not claimed" would drop every one of them in a single nightly resync.
 *
 * That the reason is DERIVED FROM THE SAME LADDER as the decision (a "why" that can disagree with the
 * "whether" is worse than no "why" at all), that only the EXPLICIT case is annotated, and that the
 * contradiction is reported WITHOUT moving a figure. It changes no money and asserts that it does not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';
import { IdentityTaxCard, type ChildReliefPricing } from '../components/identity-tax-card';
import { childCategoryContradictsDob, childEligibilityReason, childReliefEligible as isChildReliefEligible } from '../lib/dependent-vocabulary';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const D = en.people.detail as unknown as Record<string, string>;
const LOCALES = { en, ms, ta, th, vi: vi_, zh } as const;

const CATEGORY_PRICES = (['under_18', 'study_preu', 'study_tertiary', 'disabled', 'disabled_study'] as const).map(
  (key) => ({ key, amountRM: RELIEFS.childByCategory![key], units: RELIEFS.childByCategory![key] / RELIEFS.perChild }),
);

/** The date every age below is taken against, so nothing here depends on the day the suite runs. */
const ASOF = new Date('2026-06-30T00:00:00Z');
/** Daniel Tan's actual row, as production holds it. */
const PROD_ROW = {
  relationship: 'child' as const,
  dateOfBirth: '2004-01-01',
  isStudent: false,
  isDeceased: false,
  archivedAt: null,
  childTaxRelief: true,
  childReliefCategory: 'under_18',
};

afterEach(cleanup);

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE RULE — the reason cannot disagree with the decision
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe('77e882f5 · childEligibilityReason re-walks the same ladder', () => {
  it("the reporter's own child: NOT eligible — the tick is consent, the record must justify it", () => {
    // r353 asserted the opposite here: `toBe(true)` and reason 'explicit', because the tick overrode
    // the age test. r355 reverses that on the owner's instruction. Born 2004, not a student, category
    // `under_18` — which is the one category that cannot justify an over-18 claim.
    expect(isChildReliefEligible(PROD_ROW, ASOF), 'a ticked 22-year-old with no qualifying category').toBe(false);
    expect(childEligibilityReason(PROD_ROW, ASOF), 'not eligible ⇒ no reason to print').toBeNull();
  });

  it('a ticked over-18 child WITH a qualifying category still counts, and says why', () => {
    // The case the old override existed to protect. It must survive the reversal or we have broken the
    // only route by which a disabled or studying child over 18 is claimable at all.
    for (const childReliefCategory of ['disabled', 'disabled_study', 'study_tertiary', 'study_preu']) {
      const row = { ...PROD_ROW, childReliefCategory };
      expect(isChildReliefEligible(row, ASOF), `${childReliefCategory} justifies a claim past 18`).toBe(true);
      expect(childEligibilityReason(row, ASOF)).toBe('category');
    }
  });

  it('a NULL tick keeps the pre-77e882f5 inference — legacy rows do not silently drop out', () => {
    // THE INCIDENT THIS PREVENTS: null is most legacy rows. Reading it as "not claimed" would remove
    // every never-ticked child from relief in one nightly resync.
    const legacyYoung = { ...PROD_ROW, childTaxRelief: null, dateOfBirth: '2015-01-01' };
    const legacyOld = { ...PROD_ROW, childTaxRelief: null };
    expect(isChildReliefEligible(legacyYoung, ASOF), 'under 18, never ticked — unchanged').toBe(true);
    expect(isChildReliefEligible(legacyOld, ASOF), 'over 18, never ticked — unchanged').toBe(false);
    const legacyStudent = { ...PROD_ROW, childTaxRelief: null, isStudent: true };
    expect(isChildReliefEligible(legacyStudent, ASOF), 'student, never ticked — unchanged').toBe(true);
  });

  it('an explicit FALSE is honoured too, and then there is no reason to print', () => {
    const optedOut = { ...PROD_ROW, dateOfBirth: '2015-01-01', childTaxRelief: false };
    expect(isChildReliefEligible(optedOut, ASOF), 'an explicit no wins over being under 18 — unchanged by r355').toBe(false);
    expect(childEligibilityReason(optedOut, ASOF), 'not eligible ⇒ no reason, so nothing can be printed').toBeNull();
  });

  it('a student reports student; a plain under-18 reports under_18', () => {
    const student = { ...PROD_ROW, isStudent: true, childReliefCategory: 'study_tertiary' };
    expect(childEligibilityReason(student, ASOF)).toBe('student');
    const young = { ...PROD_ROW, dateOfBirth: '2015-01-01' };
    expect(childEligibilityReason(young, ASOF)).toBe('under_18');
  });

  it('NEVER returns a reason for a child the predicate refuses — the two cannot drift', () => {
    // The property, over the whole cross-product rather than a chosen case.
    for (const childTaxRelief of [true, false, null]) {
      for (const isStudent of [true, false]) {
        for (const dateOfBirth of ['2004-01-01', '2015-01-01', null]) {
          const row = { ...PROD_ROW, childTaxRelief, isStudent, dateOfBirth, childReliefCategory: null };
          const eligible = isChildReliefEligible(row, ASOF);
          const why = childEligibilityReason(row, ASOF);
          expect(why === null, `eligible=${eligible} must imply a reason is ${eligible ? 'present' : 'absent'}`).toBe(
            !eligible,
          );
        }
      }
    }
  });
});

describe('77e882f5 · the category contradiction is narrow on purpose', () => {
  it("flags 'under 18' on a 22-year-old — the reporter's exact record", () => {
    expect(childCategoryContradictsDob(PROD_ROW, ASOF)).toBe(true);
  });

  it('does NOT flag a category that is legitimately claimable past 18', () => {
    for (const childReliefCategory of ['disabled', 'disabled_study', 'study_tertiary', 'study_preu']) {
      expect(
        childCategoryContradictsDob({ ...PROD_ROW, childReliefCategory }, ASOF),
        `${childReliefCategory} is claimable over 18 and must not be flagged`,
      ).toBe(false);
    }
  });

  it('does NOT flag a genuinely under-18 child, a child with no category, or one with no date of birth', () => {
    expect(childCategoryContradictsDob({ ...PROD_ROW, dateOfBirth: '2015-01-01' }, ASOF)).toBe(false);
    expect(childCategoryContradictsDob({ ...PROD_ROW, childReliefCategory: null }, ASOF)).toBe(false);
    expect(
      childCategoryContradictsDob({ ...PROD_ROW, dateOfBirth: null }, ASOF),
      'an undated child is undatedChildren’s business, not this one',
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE SCREEN — what the reporter would have seen
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const base: ChildReliefPricing = {
  perChild: RELIEFS.perChild,
  categories: CATEGORY_PRICES,
  statutoryVersion: '2026.9',
  mode: 'auto',
  derived: true,
  familyChildren: 1,
  physicalChildren: 1,
  eligibleChildren: 1,
  uncategorisedChildren: 0,
  pricedFromGrid: false,
  qualifyingChildren: 1,
  reliefRM: RELIEFS.perChild,
  storedQualifyingChildren: 1,
  storedReliefRM: RELIEFS.perChild,
  derivedGrid: null,
  undatedChildren: [],
  asOf: '2026-06-30',
  ruleUnits: 1,
  ruleReliefRM: RELIEFS.perChild,
  breakdown: [],
};

/** Daniel Tan as the card receives him. */
const TICKED: ChildReliefPricing = {
  ...base,
  breakdown: [
    {
      kind: 'child',
      name: 'More than 18Y',
      category: 'under_18',
      sharePercent: 100,
      children: 1,
      units: 1,
      amountRM: RELIEFS.perChild,
      why: 'category',
      categoryContradictsDob: true,
    },
  ],
};

/** An ordinary under-18 child: counted for the reason the caption already implies. */
const ORDINARY: ChildReliefPricing = {
  ...base,
  breakdown: [
    {
      kind: 'child',
      name: 'Ain',
      category: 'under_18',
      sharePercent: 100,
      children: 1,
      units: 1,
      amountRM: RELIEFS.perChild,
      why: 'under_18',
      categoryContradictsDob: false,
    },
  ],
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
          numChildren: 1,
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

const q = (sel: string) => document.querySelector(sel);
const txt = (sel: string) => (document.querySelector(sel)?.textContent ?? '').trim();

describe('77e882f5 · the card says WHY, and flags a record that disproves itself', () => {
  it('names the tick as the reason, on the child’s own line', () => {
    renderCard(TICKED);
    expect(q('[data-child-why-category]'), 'the reason must reach the screen').not.toBeNull();
    expect(txt('[data-child-why-category]')).toBe(D.childQualifyingWhyCategory);
  });

  it('flags the category that the date of birth disproves', () => {
    renderCard(TICKED);
    expect(txt('[data-child-category-contradicts]')).toBe(D.childQualifyingCategoryContradictsDob);
  });

  it('CHANGES NO FIGURE — the count and the ringgit are what they were', () => {
    renderCard(TICKED);
    expect(txt('[data-child-breakdown-total-units]'), 'this round is disclosure, not arithmetic').toBe('1');
  });

  // NON-VACUITY: if the labels were unconditional, every case above would pass on any fixture.
  it('an ordinary under-18 child gets NEITHER label', () => {
    renderCard(ORDINARY);
    expect(q('[data-child-why-category]'), 'only an explicit tick is worth a line').toBeNull();
    expect(q('[data-child-category-contradicts]'), 'nothing contradicts anything here').toBeNull();
    expect(txt('[data-child-breakdown-total-units]')).toBe('1');
  });
});

describe('77e882f5 · both sentences are translated, not copied', () => {
  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])('%s carries both keys, non-empty', (loc) => {
    const d = (LOCALES[loc].people.detail as unknown as Record<string, string>);
    for (const k of ['childQualifyingWhyCategory', 'childQualifyingCategoryContradictsDob']) {
      expect(typeof d[k], `${loc}.${k} missing`).toBe('string');
      expect(d[k].length, `${loc}.${k} empty`).toBeGreaterThan(0);
      expect(d[k], `${loc}.${k} must not be marked retired`).not.toMatch(/^\[retired/);
    }
  });

  it('the five other locales are not the English string verbatim', () => {
    for (const loc of ['ms', 'ta', 'th', 'vi', 'zh'] as const) {
      const d = LOCALES[loc].people.detail as unknown as Record<string, string>;
      expect(d.childQualifyingWhyCategory, `${loc} left English in place`).not.toBe(D.childQualifyingWhyCategory);
    }
  });

  it('renders in every locale without an intl error', () => {
    for (const loc of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      cleanup();
      renderCard(TICKED, LOCALES[loc]);
      const body = document.body.textContent ?? '';
      expect(body, `${loc} rendered a missing-message marker`).not.toMatch(/childQualifyingWhy|MISSING_MESSAGE/);
    }
  });
});
