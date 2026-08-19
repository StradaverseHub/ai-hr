/**
 * Identification & Tax card + tax calculation controls (item 8b5334db).
 *
 * The Identification & Tax section was redesigned:
 *   - IC Number relocated to the Profile tab with its own partial save (setIcAction → setIcProfileMY), which
 *     SEEDS the statutory row. The tax fields moved to a dedicated Identification & Tax card with their own
 *     partial save (setTaxAction → setTaxProfileMY), leaving the rest of the statutory row untouched.
 *   - Tax Category expanded to five labels mapping to the LHDN integers 1/2/3/3/1.
 *   - Income Tax Resident drives the PCB method: resident (full MTD), non_resident (flat 30%), and the two new
 *     incentive statuses rep + knowledge_worker (flat 15%).
 *   - Children (PCB relief) gains a manual/auto mode; auto derives an eligible-child suggestion from Family
 *     records (eligibleChildReliefCount) that HR confirms into num_children — never a silent sync.
 *   - Employer bears tax: PCB computed + reported in full, but funded from employer cost (not deducted from net).
 *
 * Guards: (1) statutory() flat-rate branches per residency (pure, golden); (2) setIc seeds + setTax persists +
 * syncs is_resident + fires employee.tax.updated; (3) setTax is a partial update (leaves EPF/SOCSO/bank intact);
 * (4) eligibleChildReliefCount gating; (5) employer-bears-tax payslip plumbing; (6) i18n keys in 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { statutory } from '../localization/my/payroll';
import { eligibleChildReliefCount } from '../core/dependents';
import {
  getStatutoryProfileMY,
  setStatutoryProfileMY,
  setIcProfileMY,
  setTaxProfileMY,
  taxNumberSharedWithMY,
  NoIcYetError,
} from '../localization/my/statutory';
import { setTaxAction, setIcAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ── (1) Pure calculator: the residency → PCB-method branches ─────────────────────────────────────────────
describe('statutory() tax residency branches (item 8b5334db)', () => {
  const wage = 8000; // comfortably taxable so PCB > 0 on every path

  it('non_resident (flatTaxRate 0.30) is byte-identical to the legacy resident:false path', () => {
    const viaFlat = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { flatTaxRate: 0.3 });
    const viaLegacy = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { resident: false });
    expect(viaFlat.pcb).toBe(viaLegacy.pcb);
    // 30% of the cash wage, floored/rounded by the flat-rate rule.
    expect(viaFlat.pcb).toBeGreaterThan(0);
    expect((viaFlat.pcbMeta as { rate: number }).rate).toBe(0.3);
  });

  it('rep + knowledge_worker use a flat 15% — half the non-resident PCB, and identical to each other', () => {
    const rep = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { flatTaxRate: 0.15 });
    const nonRes = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { flatTaxRate: 0.3 });
    expect(rep.pcb).toBeGreaterThan(0);
    // 15% is exactly half of 30% before rounding; the rounded figures stay close to half.
    expect(rep.pcb).toBeLessThan(nonRes.pcb);
    expect((rep.pcbMeta as { flatRate: number }).flatRate).toBe(0.15);
    expect((rep.pcbMeta as { nonResident: boolean }).nonResident).toBe(false);
  });

  it('resident (no flat rate) takes the full computerised-MTD path, not a flat percentage', () => {
    const resident = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { resident: true });
    const flat30 = statutory(wage, { category: 1, children: 0 }, 0, 0, { month: 1 }, { flatTaxRate: 0.3 });
    // Full MTD on a single earner at RM8k is far below a flat 30% withholding.
    expect(resident.pcb).toBeLessThan(flat30.pcb);
    expect((resident.pcbMeta as { rate?: number }).rate).toBeUndefined();
  });
});

// ── (4) Pure helper: eligible child derivation gating ────────────────────────────────────────────────────
describe('eligibleChildReliefCount gating (item 8b5334db)', () => {
  const base = { relationship: 'child' as const, isDeceased: false, archivedAt: null as Date | null };
  const asOf = new Date('2026-07-01T00:00:00Z');

  it('counts under-18 children and 18+ full-time students, excludes adults, deceased, archived, non-children', () => {
    const rows = [
      { ...base, dateOfBirth: '2015-01-01', isStudent: false }, // 11 → eligible
      { ...base, dateOfBirth: '2000-01-01', isStudent: true }, // 26 but student → eligible
      { ...base, dateOfBirth: '2000-01-01', isStudent: false }, // 26 non-student → NOT
      { ...base, dateOfBirth: '2015-01-01', isStudent: false, isDeceased: true }, // deceased → NOT
      { ...base, dateOfBirth: '2015-01-01', isStudent: false, archivedAt: new Date() }, // archived → NOT
      { relationship: 'spouse' as const, dateOfBirth: '2015-01-01', isStudent: false, isDeceased: false, archivedAt: null }, // not a child → NOT
      { ...base, dateOfBirth: null, isStudent: false }, // no DOB, not student → NOT (HR keys it)
    ];
    expect(eligibleChildReliefCount(rows, asOf)).toBe(2);
  });
});

// ── DB-backed behaviour ──────────────────────────────────────────────────────────────────────────────────
describe('Identification & Tax — service + action behaviour (item 8b5334db)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ADMIN = adminCtx(base);
    LAST_REDIRECT = '';
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (a: SessionContext, name: string) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  it('setTax before any IC throws NoIcYetError (the IC seeds the row on the Profile tab)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Tax No Ic');
    await expect(setTaxProfileMY(a, { personId: e.personId, taxCategory: 2 })).rejects.toBeInstanceOf(NoIcYetError);
  });

  it('(2) setIcAction seeds the row; setTaxAction persists tax + syncs is_resident + fires employee.tax.updated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Ic Then Tax');

    // IC seeds the statutory row (Profile tab).
    await expect(setIcAction(fd({ employmentId: e.employmentId, personId: e.personId, icNumber: '900101015030' }))).rejects.toThrow('NEXT_REDIRECT');
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015030');
    // Defaults on the fresh row.
    expect(row?.taxResidency).toBe('resident');
    expect(row?.childReliefMode).toBe('manual');
    expect(row?.employerBearsTax).toBe(false);

    // Tax card save: an incentive residency + auto mode + employer-bears-tax.
    await expect(
      setTaxAction(
        fd({
          employmentId: e.employmentId,
          personId: e.personId,
          taxNumber: 'IG9988776655',
          taxCategory: '3',
          taxResidency: 'rep',
          numChildren: '2',
          childReliefMode: 'auto',
          employerBearsTax: 'on',
        }),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.taxNumber).toBe('IG9988776655');
    expect(row?.taxCategory).toBe(3);
    expect(row?.taxResidency).toBe('rep');
    expect(row?.numChildren).toBe(2);
    expect(row?.childReliefMode).toBe('auto');
    expect(row?.employerBearsTax).toBe(true);
    // is_resident synced: rep is NOT a full-MTD resident.
    expect(row?.isResident).toBe(false);

    const payload = await latestEventPayload(base.tenantId, row!.id, 'employee.tax.updated');
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).after).toMatchObject({
      taxResidency: 'rep',
      taxCategory: 3,
      numChildren: 2,
      childReliefMode: 'auto',
      employerBearsTax: true,
    });
  });

  it('(3) setTax is a PARTIAL update — it leaves EPF / SOCSO / bank columns intact', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Tax Partial');
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015031',
      epfNumber: 'EPF-T',
      socsoNumber: 'SOC-T',
      bankName: 'Maybank',
      bankAccountNo: '123456',
      subjectToSocso: true,
      employerBearsSocso: true,
    });
    await setTaxProfileMY(a, { personId: e.personId, taxCategory: 2, taxResidency: 'non_resident', numChildren: 1 });
    const row = await getStatutoryProfileMY(a, e.personId);
    // Tax columns landed.
    expect(row?.taxCategory).toBe(2);
    expect(row?.taxResidency).toBe('non_resident');
    expect(row?.numChildren).toBe(1);
    expect(row?.isResident).toBe(false);
    // Non-tax columns preserved verbatim.
    expect(row?.epfNumber).toBe('EPF-T');
    expect(row?.socsoNumber).toBe('SOC-T');
    expect(row?.bankName).toBe('Maybank');
    expect(row?.bankAccountNo).toBe('123456');
    expect(row?.employerBearsSocso).toBe(true);
  });

  it('(5) employer-bears-tax: PCB reported in full, removed from the employee net, added to employer cost', async () => {
    const a = adminCtx(base);
    const slip = async (employmentId: string) => {
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
      return ps;
    };
    const baseline = await hire(a, 'TaxBaseline');
    const bears = await hire(a, 'TaxBears');
    for (const emp of [baseline, bears]) {
      await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    }
    await setStatutoryProfileMY(a, { personId: baseline.personId, icNumber: '900101015032' });
    await setStatutoryProfileMY(a, { personId: bears.personId, icNumber: '900101015033' });
    // Turn on employer-bears-tax for `bears` only.
    await setTaxProfileMY(a, { personId: bears.personId, employerBearsTax: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psBase = await slip(baseline.employmentId);
    const psBears = await slip(bears.employmentId);
    const pcb = Number((psBase.statutory as Record<string, number>).pcb);
    expect(pcb).toBeGreaterThan(0);
    // Reported PCB is IDENTICAL (still computed + remitted to LHDN in full).
    expect(Number((psBears.statutory as Record<string, number>).pcb)).toBeCloseTo(pcb, 2);
    // Employee net RISES by exactly the PCB (no longer deducted from the employee).
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBase.netPay) + pcb, 2);
    // Employer cost RISES by exactly the PCB.
    expect(Number(psBears.employerCost)).toBeCloseTo(Number(psBase.employerCost) + pcb, 2);
    // Payslip invariant holds.
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBears.grossPay) - Number(psBears.totalDeductions), 2);
    // Snapshot records the tax bear (absent on the baseline slip ⇒ byte-identical default).
    const eb = psBears.statutory as Record<string, unknown>;
    expect((eb.employerBears as { tax: boolean }).tax).toBe(true);
    expect((eb.employerBorne as { tax: number }).tax).toBeCloseTo(pcb, 2);
    expect((psBase.statutory as Record<string, unknown>).employerBears).toBeUndefined();
  });

  it('rep + knowledge_worker employees withhold a flat 15% PCB on the payslip', async () => {
    const a = adminCtx(base);
    const slip = async (employmentId: string) => {
      const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
      return ps;
    };
    const rep = await hire(a, 'RepWorker');
    const kw = await hire(a, 'KnowledgeWorker');
    const resident = await hire(a, 'ResidentWorker');
    for (const emp of [rep, kw, resident]) {
      await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    }
    await setStatutoryProfileMY(a, { personId: rep.personId, icNumber: '900101015034' });
    await setStatutoryProfileMY(a, { personId: kw.personId, icNumber: '900101015035' });
    await setStatutoryProfileMY(a, { personId: resident.personId, icNumber: '900101015036' });
    await setTaxProfileMY(a, { personId: rep.personId, taxResidency: 'rep' });
    await setTaxProfileMY(a, { personId: kw.personId, taxResidency: 'knowledge_worker' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const repPcb = Number((await slip(rep.employmentId)).statutory ? ((await slip(rep.employmentId)).statutory as Record<string, number>).pcb : 0);
    const kwPcb = Number(((await slip(kw.employmentId)).statutory as Record<string, number>).pcb);
    const resPcb = Number(((await slip(resident.employmentId)).statutory as Record<string, number>).pcb);
    // REP and Knowledge Worker use the same flat 15% ⇒ identical PCB; both differ from the resident MTD figure.
    expect(repPcb).toBeGreaterThan(0);
    expect(kwPcb).toBeCloseTo(repPcb, 2);
    expect(resPcb).not.toBeCloseTo(repPcb, 2);
  });
  // ── r209 7ee14bbc — THE DUPLICATE TAX-NUMBER WARNING AT THE POINT OF ENTRY ─────────────────────────────
  //
  // The approved plan asks for the warning in TWO places: "a warning on the preview screen, before you
  // print, when two employees share a tax reference number" AND "the same warning where the number is
  // entered, so a duplicate is caught at the point of typing rather than at filing time". Only the first
  // shipped, so a duplicate keyed on this card was still discovered on the CP39 at filing time — the
  // failure the second bullet names. On the reporter's own records five numbers are each filed against
  // two or three different people. These live INSIDE this describe because it owns the DB lifecycle.

  const withTax = async (a: SessionContext, name: string, ic: string, taxNumber: string) => {
    const e = await hire(a, name);
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    await setTaxProfileMY(a, { personId: e.personId, taxNumber });
    return e;
  };

  it('(r209) names the OTHER person filed under the number, from either side of the pair', async () => {
    const a = adminCtx(base);
    const aisyah = await withTax(a, 'Aisyah Rahman', '900101015555', 'SG90010101');
    const irwin = await withTax(a, 'Irwin Law', '880808085555', 'SG90010101');
    expect(
      await taxNumberSharedWithMY(a, { personId: aisyah.personId, companyId: base.companyId, taxNumber: 'SG90010101' }),
    ).toEqual(['Irwin Law']);
    expect(
      await taxNumberSharedWithMY(a, { personId: irwin.personId, companyId: base.companyId, taxNumber: 'SG90010101' }),
    ).toEqual(['Aisyah Rahman']);
  });

  it('(r209) never reports somebody against THEMSELVES — including on a second concurrent employment', async () => {
    // This is the guard that makes the warning usable: the tax record is keyed on person_id, so one
    // person holding two employments in this company still has exactly ONE record and nothing to correct.
    const a = adminCtx(base);
    const solo = await withTax(a, 'Ali Bin Abu', '900101015556', 'IG25834425022');
    await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, personId: solo.personId, companyId: base.companyId, hiredOn: '2026-02-01' });
    expect(
      await taxNumberSharedWithMY(a, { personId: solo.personId, companyId: base.companyId, taxNumber: 'IG25834425022' }),
    ).toEqual([]);
  });

  it('(r209) matches trimmed and case-insensitively, the same rule the CP39 banner uses', async () => {
    const a = adminCtx(base);
    await withTax(a, 'Aisyah Rahman', '900101015557', 'SG90010101');
    const other = await withTax(a, 'Irwin Law', '880808085557', 'sg90010101 ');
    expect(
      await taxNumberSharedWithMY(a, { personId: other.personId, companyId: base.companyId, taxNumber: ' Sg90010101' }),
    ).toEqual(['Aisyah Rahman']);
  });

  it('(r209) says nothing when there is no number to share — that is the MISSING-number gate’s business', async () => {
    const a = adminCtx(base);
    const e = await withTax(a, 'No Number', '900101015558', 'IG777');
    expect(await taxNumberSharedWithMY(a, { personId: e.personId, companyId: base.companyId, taxNumber: '' })).toEqual([]);
    expect(await taxNumberSharedWithMY(a, { personId: e.personId, companyId: base.companyId, taxNumber: null })).toEqual(
      [],
    );
    expect(
      await taxNumberSharedWithMY(a, { personId: e.personId, companyId: base.companyId, taxNumber: '   ' }),
    ).toEqual([]);
  });

  it('(r209) is ADVISORY: the save that creates the duplicate still succeeds', async () => {
    // LHDN decides whose number is right, and HR must stay able to record what an employee's own EA form
    // says while that is sorted out. A screen that refused the save would be unusable on the reporter's
    // own data, where five numbers are already shared.
    const a = adminCtx(base);
    await withTax(a, 'First Filer', '900101015559', 'IG25834425030');
    const second = await withTax(a, 'Second Filer', '880808085559', 'IG25834425030');
    expect((await getStatutoryProfileMY(a, second.personId))?.taxNumber).toBe('IG25834425030');
  });
});

// ── (6) i18n coverage ────────────────────────────────────────────────────────────────────────────────────
describe('Identification & Tax — i18n (item 8b5334db)', () => {
  it('exposes every new label in all six locales', () => {
    const keys = [
      'identityTaxCardTitle',
      'taxInfoLegend',
      'taxCategoryLabel',
      'taxCategorySingle',
      'taxCategoryMarriedSpouseNotWorking',
      'taxCategoryMarriedSpouseWorking',
      'taxCategoryDivorcedWithKids',
      'taxCategoryNone',
      'incomeTaxResident',
      'taxResidencyResident',
      'taxResidencyNonResident',
      'taxResidencyRep',
      'taxResidencyKnowledgeWorker',
      'childReliefLegend',
      'childReliefModeLabel',
      'childReliefModeManual',
      'childReliefModeAuto',
      // R46 47146ea3 — childReliefAutoSuggestion / childReliefAutoApply ("Use {count}") are GONE. The
      // manual confirm step they described no longer exists: the count now syncs server-side from the
      // Family register. These three replace them — the explanatory note on the card, plus the two
      // post-save banners (quiet sync, and the open-payroll alert).
      'childReliefAutoSyncNote',
      'childReliefAutoSynced',
      'childReliefAutoSyncedPayrollAlert',
      'employerBearsTax',
      'employerBearsTaxHint',
      'identityTaxSave',
      'icNumberHint',
      'saveIc',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = msg?.people?.detail?.[k];
        expect(typeof v, `messages/${loc}.json missing people.detail.${k}`).toBe('string');
        expect(v.length, `messages/${loc}.json people.detail.${k} empty`).toBeGreaterThan(0);
      }
    }
  });
});

// ── r209 7ee14bbc — the point-of-entry warning is WIRED, across four files and six catalogs ───────────────
describe('r209 — the shared-tax-number warning reaches the field it is about', () => {
  it('is wired from the pack, through the page, into the field itself', () => {
    // The contract lives across four files and a unit test of any one of them passes throughout.
    expect(read('localization/my/index.ts')).toContain('taxNumberSharedWith: taxNumberSharedWithMY');
    expect(read('localization/country-pack.ts')).toContain(
      "taxNumberSharedWith: MyStatutoryModule['taxNumberSharedWithMY']",
    );
    const page = read('app/admin/personnel/[employmentId]/page.tsx');
    expect(page).toContain('countryPack?.statutory.taxNumberSharedWith(s, {');
    expect(page).toContain('taxNumberSharedWith={taxNumberSharedWith}');
    const card = read('components/identity-tax-card.tsx');
    expect(card).toContain("t('taxNumberSharedTitle'");
    // Beside the field it is about, not at the top of the card.
    expect(card.indexOf('taxNumberSharedWith.length > 0')).toBeGreaterThan(card.indexOf('name="taxNumber"'));
  });

  it('resolves the warning in all six locales, and none of them is a copy of English', () => {
    const enMsg = JSON.parse(read('messages/en.json')).people.detail.taxNumberSharedTitle as string;
    expect(enMsg).toContain('{names}');
    for (const loc of LOCALES) {
      const v = JSON.parse(read(`messages/${loc}.json`)).people.detail.taxNumberSharedTitle as string;
      expect(typeof v, `messages/${loc}.json missing people.detail.taxNumberSharedTitle`).toBe('string');
      expect(v).toContain('{names}');
      if (loc !== 'en') expect(v, `${loc} is still English`).not.toBe(enMsg);
    }
  });
});
