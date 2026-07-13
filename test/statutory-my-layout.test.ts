/**
 * Personnel (Admin) → Statutory (Malaysia) screen layout redesign (feedback 7524eda1),
 * updated for R24 40ef71a0: the Statutory (Malaysia) card was relocated into its own dedicated
 * "Bank & Statutory" tab. The card definition (const statutoryCard) is unchanged — only its render
 * location moved from the Payroll tab to the Bank & Statutory tab.
 *
 * The single `setStatutoryAction` form is a FULL-ROW overwrite, so every named input must stay mounted
 * at all times — a field absent from the POST silently wipes stored data.
 *
 * This is a DB-free static-source guard (same style as `test/personnel-links.test.ts`). It fails loudly
 * if a future edit (a) removes statutory from the Bank & Statutory tab, (b) drops one of the required
 * statutory inputs (the full-overwrite wipe trap), or (c) reintroduces a zakat input (undoing 58755260).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const page = read('app/admin/personnel/[employmentId]/page.tsx');
const identityTaxCard = read('components/identity-tax-card.tsx');

describe('Statutory (Malaysia) layout: lives in the Bank & Statutory tab', () => {
  it('renders {bankCard} + {identityTaxCard} + {statutoryCard} in the bankStatutory tab panel', () => {
    // R24 40ef71a0 relocated statutory into its own Bank & Statutory tab. Item ef720d3a split the bank fields
    // into a dedicated Bank Information card. Item 8b5334db then split the tax fields into a dedicated
    // Identification & Tax card (identityTaxCard) rendered alongside on the same tab.
    const start = page.indexOf('bankStatutory: (');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('),', start);
    const panel = page.slice(start, end);
    expect(panel.includes('{bankCard}')).toBe(true);
    expect(panel.includes('{identityTaxCard}')).toBe(true);
    expect(panel.includes('{statutoryCard}')).toBe(true);
  });

  it('keeps the remaining payroll cards in the payroll tab panel', () => {
    const start = page.indexOf('payroll: (');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('),', start);
    const panel = page.slice(start, end);

    for (const token of [
      '{payComponentsCard}',
      '{cp38Card}',
      '{encashmentCard}',
      '{payrollPolicyCard}',
      '{compensationCard}',
    ]) {
      expect(panel.indexOf(token), `${token} should exist in the payroll panel`).toBeGreaterThan(-1);
    }
  });

  it('keeps Compensation as a standalone card (no longer bundled with statutory)', () => {
    expect(page.includes('const statutoryCard')).toBe(true);
    expect(page.includes('const compensationCard')).toBe(true);
    // The old merged const must be gone.
    expect(page.includes('compAndStatutoryCards')).toBe(false);
  });
});

describe('Statutory (Malaysia) layout: every statutory input stays mounted (full-overwrite wipe guard)', () => {
  const requiredInputs = [
    'name="employmentId"',
    'name="personId"',
    'name="epfNumber"',
    'name="socsoNumber"',
    // Item ef720d3a — bankName/bankAccountNo moved OUT of this full-overwrite form into the dedicated Bank
    // Information card. Item 8b5334db — icNumber/taxNumber/taxCategory/numChildren/isResident moved OUT too:
    // IC to its own Profile-tab form (setIcAction) and the tax fields to the dedicated Identification & Tax card
    // (setTaxAction). setStatutoryAction now passes those stored values through unchanged so they can't be wiped.
    // Item a7271737 — the Subject-to-SOCSO and Subject-to-EIS checkboxes were consolidated INTO the
    // SOCSO/EIS category selects (the single per-scheme control); setStatutoryAction derives the legacy
    // subject_to_socso / eis_eligible booleans from these on save, so it's the selects that must stay mounted.
    'name="socsoCategory"',
    'name="eisCategory"',
    'name="epfCitizenship"',
    'name="tp3Year"',
    'name="tp3NetRemuneration"',
    'name="tp3EpfClaimed"',
    'name="tp3PcbPaid"',
  ];

  for (const input of requiredInputs) {
    it(`${input} is still present in the statutory form`, () => {
      expect(page.includes(input)).toBe(true);
    });
  }
});

describe('Identification & Tax card (item 8b5334db): IC relocated to Profile, tax fields in the dedicated card', () => {
  it('IC has its own Profile-tab form (setIcAction) with the icNumber input', () => {
    expect(page.includes('action={setIcAction}')).toBe(true);
    expect(page.includes('name="icNumber"')).toBe(true);
  });

  it('the Identification & Tax card carries the tax inputs (setTaxAction)', () => {
    expect(page.includes('action={setTaxAction}') || identityTaxCard.includes('action={action}')).toBe(true);
    for (const input of ['name="taxNumber"', 'name="taxCategory"', 'name="taxResidency"', 'name="numChildren"', 'name="childReliefMode"', 'name="employerBearsTax"']) {
      expect(identityTaxCard.includes(input), `${input} should exist in identity-tax-card.tsx`).toBe(true);
    }
  });

  it('exposes the four Income Tax Resident options incl. the new REP / Knowledge Worker statuses', () => {
    for (const v of ['value="resident"', 'value="non_resident"', 'value="rep"', 'value="knowledge_worker"']) {
      expect(identityTaxCard.includes(v), `${v} should exist in the residency select`).toBe(true);
    }
  });
});

describe('Statutory (Malaysia) layout: grouped section headers exist', () => {
  // Item 5a461b99 put SOCSO & EIS in its own bordered card (socsoEisCardTitle). Item 8b5334db — the identity/tax
  // group left the statutory form for its own card, so only the SOCSO/EIS header remains on this form.
  for (const key of ['socsoEisCardTitle']) {
    it(`uses the ${key} group label`, () => {
      expect(page.includes(`t('${key}')`)).toBe(true);
    });
  }
});

describe('Statutory (Malaysia) layout: zakat inputs stay relocated (58755260 invariant)', () => {
  for (const zakat of [
    'name="zakatActive"',
    'name="zakatAmount"',
    'name="zakatEffectiveFrom"',
    'name="zakatEffectiveTo"',
  ]) {
    it(`does not reintroduce ${zakat}`, () => {
      expect(page.includes(zakat)).toBe(false);
    });
  }
});
