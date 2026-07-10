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

describe('Statutory (Malaysia) layout: lives in the Bank & Statutory tab', () => {
  it('renders {statutoryCard} in the bankStatutory tab panel', () => {
    // R24 40ef71a0 relocated statutory into its own Bank & Statutory tab.
    expect(page.includes('bankStatutory: statutoryCard')).toBe(true);
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
    'name="icNumber"',
    'name="epfNumber"',
    'name="socsoNumber"',
    'name="taxNumber"',
    'name="taxCategory"',
    'name="numChildren"',
    'name="bankName"',
    'name="bankAccountNo"',
    'name="eisEligible"',
    'name="isResident"',
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

describe('Statutory (Malaysia) layout: grouped section headers exist', () => {
  for (const key of ['statutoryGroupIdentity', 'statutoryGroupSocsoEis', 'statutoryGroupBank']) {
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
