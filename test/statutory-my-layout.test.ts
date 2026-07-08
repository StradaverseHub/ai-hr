/**
 * Personnel (Admin) → Payroll tab: Statutory (Malaysia) screen layout redesign (feedback 7524eda1).
 *
 * The Statutory (Malaysia) card was relocated to the TOP of the Payroll tab and redesigned as a
 * full-width, grouped layout. The single `setStatutoryAction` form is a FULL-ROW overwrite, so every
 * named input must stay mounted at all times — a field absent from the POST silently wipes stored data.
 *
 * This is a DB-free static-source guard (same style as `test/personnel-links.test.ts`). It fails loudly
 * if a future edit (a) moves statutory back down the tab, (b) drops one of the required statutory inputs
 * (the full-overwrite wipe trap), or (c) reintroduces a zakat input (undoing the 58755260 relocation).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const page = read('app/admin/personnel/[employmentId]/page.tsx');

describe('Statutory (Malaysia) layout: pinned to the top of the Payroll tab', () => {
  it('renders {statutoryCard} before every other payroll card in the payroll panel', () => {
    // Isolate the payroll panel fragment so we compare positions within it, not across the whole file.
    const start = page.indexOf('payroll: (');
    expect(start).toBeGreaterThan(-1);
    const end = page.indexOf('),', start);
    const panel = page.slice(start, end);

    const statutoryPos = panel.indexOf('{statutoryCard}');
    expect(statutoryPos).toBeGreaterThan(-1);

    for (const token of [
      '{payComponentsCard}',
      '{cp38Card}',
      '{encashmentCard}',
      '{payrollPolicyCard}',
      '{compensationCard}',
    ]) {
      const pos = panel.indexOf(token);
      expect(pos, `${token} should exist in the payroll panel`).toBeGreaterThan(-1);
      expect(statutoryPos, `statutoryCard must precede ${token}`).toBeLessThan(pos);
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
