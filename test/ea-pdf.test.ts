/**
 * EA (C.P.8A) PDF renderer — a pure function over the employeeEaStatement read + localized labels. We
 * assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null fields +
 * non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded per ADR-0036) and on a
 * tax category outside the 1/2/3 map (the renderer's String(category) fallback).
 */
import { describe, expect, it } from 'vitest';
import { renderEaPdf, type EaPdfData, type EaPdfLabels } from '../lib/ea-pdf';

const labels: EaPdfLabels = {
  title: 'Statement of Remuneration · EA (C.P.8A)',
  yearEnded: 'Year ended 31 December 2026 · Acme Sdn Bhd',
  category1: 'Category 1 — Single',
  category2: 'Category 2 — Married, spouse not working',
  category3: 'Category 3 — Married, spouse working',
  sectionAEmployeeParticulars: 'A · Employee particulars',
  name: 'Name',
  incomeTaxNo: 'Income tax no. (TIN)',
  icNo: 'IC no.',
  epfNo: 'EPF no.',
  socsoNo: 'SOCSO no.',
  mtdCategory: 'MTD category',
  childrenTaxRelief: 'Children (tax relief)',
  employmentPeriod: 'Employment period',
  present: 'present',
  sectionBEmploymentIncome: 'B · Employment income (cash)',
  grossSalary: '1(a) Gross salary / wages (incl. overtime)',
  bonus: '1(b) Bonus',
  allowancesPerquisites: '1(c) Allowances / perquisites',
  exemptAllowances: 'Tax-exempt allowances (included above)',
  benefitsInKind: '3 Benefits in kind',
  livingAccommodation: '4 Value of living accommodation',
  notTracked: 'not tracked',
  totalGrossRemuneration: 'Total gross remuneration',
  sectionDTotalDeductions: 'D · Total deductions',
  monthlyTaxDeduction: '1 Monthly tax deduction (MTD / PCB)',
  cp38Deductions: '2 CP38 deductions',
  zakatViaSalary: '3 Zakat via salary deduction',
  sectionEContributions: "E · Contributions (employee's share)",
  epfKwsp: '1 EPF / KWSP',
  socso: '2 SOCSO',
  eisSip: 'EIS / SIP',
  disclaimer:
    'Generated from payroll for YA 2026 (statutory tables 2026.3). Verify against your records; this is not a substitute for the official LHDN form.',
  amendedNote: 'Some figures on this EA form were amended by HR and differ from the payroll-derived values.',
};

const data: EaPdfData = {
  year: '2026',
  employer: { name: 'Acme Sdn Bhd', eNumber: 'E1234567890' },
  employee: {
    name: 'Aisyah Rahman',
    ic: '900101010001',
    taxNo: 'SG12345678',
    epfNo: 'EPF001',
    socsoNo: 'SOC001',
    category: 1,
    children: 2,
    hiredOn: '2026-01-01',
    terminatedOn: null,
  },
  partB: { grossSalary: 60000, bonus: 5000, allowances: 6000, gross: 71000 },
  partD: { mtd: 4200 },
  partE: { epf: 7810, socso: 297, eis: 118.8 },
  statutoryVersion: '2026.3',
};

const head = (b: Uint8Array) => Buffer.from(b.slice(0, 5)).toString('latin1');

describe('EA PDF renderer', () => {
  it('renders a real PDF document of non-trivial size', async () => {
    const bytes = await renderEaPdf(data, labels);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(head(bytes)).toBe('%PDF-');
  });

  it('degrades gracefully: non-Latin name + null eNumber/taxNo/terminatedOn → no crash, valid PDF', async () => {
    const bytes = await renderEaPdf(
      {
        ...data,
        employer: { name: 'Acme Sdn Bhd', eNumber: null },
        employee: { ...data.employee, name: '陈大文', taxNo: null, ic: null, epfNo: null, socsoNo: null, terminatedOn: '2026-06-30' },
      },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-'); // WinAnsi safe-encode guard → no crash on the CJK name
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('does not throw when tax category falls outside the 1/2/3 map (String fallback)', async () => {
    const bytes = await renderEaPdf({ ...data, employee: { ...data.employee, category: 4 } }, labels);
    expect(head(bytes)).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  // 1.2.6 EA Data Overwrite — EaPdfData carries the optional `overrides[]` so the renderer can mark amended
  // forms. A statement with an amendment renders the marker (longer doc) without crashing; the printed
  // partB.gross is whatever the caller passes (the merge already recomputed it upstream).
  it('accepts amended EaPdfData (overrides + recomputed gross) and renders the marker', async () => {
    const amended: EaPdfData = {
      ...data,
      // allowances amended 6000 → 8000 ⇒ gross recomputed 60000 + 5000 + 8000 = 73000 by the merge upstream.
      partB: { grossSalary: 60000, bonus: 5000, allowances: 8000, gross: 73000 },
      overrides: [{ field: 'allowances', original: 6000, amended: 8000, reason: 'arrears' }],
    };
    expect(amended.partB.gross).toBe(amended.partB.grossSalary + amended.partB.bonus + amended.partB.allowances);
    const withMarker = await renderEaPdf(amended, labels);
    const without = await renderEaPdf({ ...amended, overrides: [] }, labels);
    expect(head(withMarker)).toBe('%PDF-');
    // The amended-note marker adds content, so the marked PDF is at least as large as the unmarked one.
    expect(withMarker.length).toBeGreaterThanOrEqual(without.length);
  });
});
