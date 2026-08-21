/**
 * EA (C.P.8A) PDF renderer — a pure function over the employeeEaStatement read + localized labels. We
 * assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null fields +
 * non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded per ADR-0036) and on a
 * tax category outside the 1/2/3 map (the renderer's String(category) fallback).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { renderEaPdf, type EaPdfData, type EaPdfLabels } from '../lib/ea-pdf';

/**
 * 6036dab7 — READ THE DRAWN TEXT BACK OUT OF THE PDF, WITH ITS COORDINATES.
 *
 * Byte-length and "starts with %PDF-" cannot see the failure this file now guards: pdf-lib accepts a
 * NEGATIVE y and simply places the text outside the media box, so a form that has silently lost its
 * bottom half is a valid, openable, larger-than-1000-byte PDF. Every `drawText` lands in the page's
 * content stream as `1 0 0 1 <x> <y> Tm <hex> Tj`, and the stream decodes with pdf-lib's own
 * `decodePDFRawStream` — so both the position AND the string are recoverable here without a PDF parser.
 */
type DrawnText = { page: number; x: number; y: number; text: string };
async function drawnText(bytes: Uint8Array): Promise<{ items: DrawnText[]; pageHeights: number[] }> {
  const doc = await PDFDocument.load(bytes);
  const items: DrawnText[] = [];
  const pageHeights: number[] = [];
  doc.getPages().forEach((page, index) => {
    pageHeights.push(page.getHeight());
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => page.node.context.lookup(ref))
        : [contents];
    let raw = '';
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    for (const m of raw.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)) {
      items.push({ page: index, x: Number(m[1]), y: Number(m[2]), text: Buffer.from(m[3], 'hex').toString('latin1') });
    }
  });
  return { items, pageHeights };
}

const labels: EaPdfLabels = {
  title: 'Statement of Remuneration · EA (C.P.8A)',
  yearEnded: 'Year ended 31 December 2026 · Acme Sdn Bhd',
  category1: 'Category 1 — Single',
  category2: 'Category 2 — Married, spouse not working',
  category3: 'Category 3 — Married, spouse working',
  sectionAEmployeeParticulars: 'A · Employee particulars',
  name: 'Name',
  jobTitle: 'Job title',
  employeeNo: 'Employee no.',
  incomeTaxNo: 'Income tax no. (TIN)',
  icNo: 'IC no.',
  passportNo: 'Passport no.',
  epfNo: 'EPF no.',
  socsoNo: 'SOCSO no.',
  mtdCategory: 'MTD category',
  childrenTaxRelief: 'Children (tax relief)',
  employmentPeriod: 'Employment period',
  present: 'present',
  sectionBEmploymentIncome: 'B · Employment income (cash)',
  grossSalary: '1(a) Gross salary / wages (incl. overtime)',
  bonus: '1(b) Bonus',
  directorFee: "Fees (incl. director's fees) / commission",
  allowancesPerquisites: '1(c) Allowances / perquisites',
  tipsPerquisites: 'Tips, perquisites and other cash payments',
  taxBorneByEmployer: 'Income tax borne by the employer',
  esos: 'ESOS / share scheme benefit',
  gratuity: 'Gratuity',
  arrears: 'Arrears and other income for earlier years',
  benefitsInKind: '3 Benefits in kind',
  livingAccommodation: '4 Value of living accommodation',
  unapprovedFundRefund: 'Refund from an unapproved provident / pension fund',
  compensation: 'Compensation for loss of employment',
  totalGrossRemuneration: 'Total gross remuneration',
  sectionCPensionOther: 'C · Pension and other payments',
  pension: '1 Pension',
  annuity: '2 Annuity or other periodical payment',
  totalPensionOther: 'Total pension and other payments',
  sectionDTotalDeductions: 'D · Total deductions',
  monthlyTaxDeduction: '1 Monthly tax deduction (MTD / PCB)',
  cp38Deductions: '2 CP38 deductions',
  zakatViaSalary: '3 Zakat via salary deduction',
  donations: '4 Approved donations through salary',
  tp1Relief: '5(a) Relief claimed on Form TP1',
  zakatOther: '5(b) Zakat other than through salary',
  childRelief: '6 Total child relief',
  sectionFExemptAllowances: 'F. Total tax-exempt allowances',
  fundName: 'Name of fund',
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
    employeeNo: 'EMP-0001',
    jobTitle: 'Executive',
    passport: null,
  },
  partB: {
    grossSalary: 60000,
    bonus: 5000,
    allowances: 6000,
    gross: 71000,
    directorFee: 0,
    tipsPerquisites: 0,
    taxBorneByEmployer: 0,
    esos: 0,
    gratuity: 0,
    arrears: 0,
    benefitsInKind: 0,
    livingAccommodation: 0,
    unapprovedFundRefund: 0,
    compensation: 0,
  },
  partC: { pension: 0, annuity: 0, total: 0 },
  partD: { mtd: 4200, cp38: 0, zakat: 0 , tp1Relief: 0, donations: 0, zakatOther: 0, childRelief: 0 },
  partE: { epf: 7810, socso: 297, eis: 118.8 , fundName: 'KWSP' },
  statutoryVersion: '2026.3',
};

/** 6036dab7 — one employee with EVERY box the customer's field mapping names filled in. */
const fullForm: EaPdfData = {
  ...data,
  employee: { ...data.employee, passport: 'A12345678', terminatedOn: '2026-11-30' },
  partB: {
    grossSalary: 60000,
    bonus: 5000,
    allowances: 6000,
    gross: 91000,
    exemptAllowances: 1200,
    directorFee: 4000,
    tipsPerquisites: 1500,
    taxBorneByEmployer: 900,
    esos: 3000,
    gratuity: 7000,
    arrears: 2500,
    benefitsInKind: 3600,
    livingAccommodation: 4800,
    unapprovedFundRefund: 1200,
    compensation: 1500,
  },
  partC: { pension: 12000, annuity: 3000, total: 15000 },
  // da4fc817 — ALL FOUR Section D boxes SET, because this fixture's whole job is to be the tallest
  // document the renderer can produce and the four new lines print only when non-zero. Leaving them at 0
  // would have let the one-page guard pass over a form that grows two lines the moment an employee has a
  // TP1 relief and a zakat payment — which is an ordinary employee, not an edge case.
  partD: { mtd: 4200, cp38: 600, zakat: 240, tp1Relief: 5200, donations: 350, zakatOther: 800, childRelief: 4000 },
  overrides: [{ field: 'gratuity', original: 0, amended: 7000, reason: 'ex-gratia on cessation' }],
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
      partB: { ...data.partB, grossSalary: 60000, bonus: 5000, allowances: 8000, gross: 73000 },
      overrides: [{ field: 'allowances', original: 6000, amended: 8000, reason: 'arrears' }],
    };
    expect(amended.partB.gross).toBe(amended.partB.grossSalary + amended.partB.bonus + amended.partB.allowances);
    const withMarker = await renderEaPdf(amended, labels);
    const without = await renderEaPdf({ ...amended, overrides: [] }, labels);
    expect(head(withMarker)).toBe('%PDF-');
    // The amended-note marker adds content, so the marked PDF is at least as large as the unmarked one.
    expect(withMarker.length).toBeGreaterThanOrEqual(without.length);
  });

  /**
   * 6036dab7 — EVERY LINE LANDS INSIDE A PAGE, AND pdf-lib WILL NOT TELL YOU OTHERWISE.
   *
   * HONEST SCOPE: this case uses the SHORT fixture disclaimer above and passes with or without the
   * renderer's pagination guard — which is exactly how r209's two-page regression got past it. The two
   * cases below (`the real message bundle` / `a disclaimer taller than the band`) are the ones that fail
   * when the guard is wrong in either direction; this one stays because drawing at a NEGATIVE y is not an
   * error in pdf-lib — the text is placed outside the media box, and the result is a valid, openable,
   * bigger PDF that has silently lost its deduction and contribution sections. Every other assertion in
   * this file (`%PDF-`, byte length, no throw) passes that document.
   */
  it('draws every line INSIDE a page — no row falls off the bottom as the form grows', async () => {
    const { items, pageHeights } = await drawnText(await renderEaPdf(fullForm, labels));
    expect(items.length).toBeGreaterThan(40); // sanity: the whole form was drawn, not an early return

    const offPage = items.filter((it) => it.y < 0 || it.y > pageHeights[it.page]);
    expect(
      offPage.map((it) => `p${it.page} y=${it.y} ${it.text}`),
      'every drawn line must land inside its page',
    ).toEqual([]);
  });

  /**
   * 6036dab7 — the boxes the customer's mapping named, asserted as TEXT ON THE DOCUMENT.
   *
   * Section C did not exist on this form at all; CP38 printed the words "not tracked" long after payroll
   * started stamping the figure; job title, employee number and passport were absent from Part A. Each of
   * those is a label-plus-figure that has to reach the page, and a renderer that accepts the data and
   * quietly declines to draw it satisfies every other assertion in this file.
   */
  it('prints Part A’s added particulars, the Part C section, and the CP38 and zakat figures', async () => {
    const { items } = await drawnText(await renderEaPdf(fullForm, labels));
    const printed = items.map((it) => it.text);
    // Part A — the three particulars the mapping asked for.
    expect(printed).toContain('Executive'); // job title
    expect(printed).toContain('EMP-0001'); // employee no.
    expect(printed).toContain('A12345678'); // passport no.
    // Part C — the section that did not exist. `sectionHeader` upper-cases its label.
    expect(printed).toContain(labels.sectionCPensionOther.toUpperCase());
    expect(printed).toContain(labels.pension);
    expect(printed).toContain('RM 12,000.00'); // the pension figure
    expect(printed).toContain('RM 15,000.00'); // …and the section total
    // Part D — CP38 and zakat as figures, NOT as the words "not tracked".
    expect(printed).toContain('RM 600.00'); // cp38
    expect(printed).toContain('RM 240.00'); // zakat
    // Nothing on the PDF says "not tracked" any more — the label is gone from the bundle entirely, so a
    // renderer that reintroduced the placeholder could not even compile against it.
    expect(printed).not.toContain('not tracked');
  });
});

/**
 * r209 fix — THE FORM IS ONE PAGE, AND THE FIXTURE ABOVE CANNOT SEE THAT.
 *
 * The fixture `disclaimer` in this file is one short sentence. The REAL one — `payroll.ea.disclaimer` in
 * `messages/*.json`, which is what the route hands the renderer — wraps to four or five lines, and that is
 * the difference between a form that fits and a form whose footnote band was measured against the CONTENT
 * floor that exists to reserve room for it. The result was a two-page EA on 100% of downloads, page two
 * holding nothing but the orphaned disclaimer (and the "amended" marker, when there was one).
 *
 * So this case renders with the shipped label bundle, in every locale the app has, and asserts the page
 * COUNT. Reading a plausible-looking PDF back is not enough: the two-page document decoded perfectly.
 */
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The renderer's WinAnsi degrade (lib/ea-pdf.ts `safe`), replicated so a label from a non-Latin bundle
 *  can be matched against the bytes actually DRAWN — 'Beberapa' survives, '由' is drawn as '?'. */
const winAnsi = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

const interp = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** The label bundle EXACTLY as app/me/ea/[employmentId]/pdf/route.ts builds it, minus next-intl. */
function bundleFor(locale: string): EaPdfLabels {
  const msgs = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
  const ea = msgs.payroll.ea as Record<string, string> & { override: Record<string, string> };
  const L = (k: string) => {
    const v = ea[k];
    if (typeof v !== 'string') throw new Error(`messages/${locale}.json is missing payroll.ea.${k}`);
    return v;
  };
  return {
    title: L('title'),
    yearEnded: interp(L('yearEnded'), { year: '2026', employer: 'Acme Sdn Bhd' }),
    category1: L('category1'),
    category2: L('category2'),
    category3: L('category3'),
    sectionAEmployeeParticulars: L('sectionAEmployeeParticulars'),
    name: L('name'),
    jobTitle: L('jobTitle'),
    employeeNo: L('employeeNo'),
    incomeTaxNo: L('incomeTaxNo'),
    icNo: L('icNo'),
    passportNo: L('passportNo'),
    epfNo: L('epfNo'),
    socsoNo: L('socsoNo'),
    mtdCategory: L('mtdCategory'),
    childrenTaxRelief: L('childrenTaxRelief'),
    employmentPeriod: L('employmentPeriod'),
    present: L('present'),
    sectionBEmploymentIncome: L('sectionBEmploymentIncome'),
    grossSalary: L('grossSalary'),
    bonus: L('bonus'),
    directorFee: L('directorFee'),
    allowancesPerquisites: L('allowancesPerquisites'),
    tipsPerquisites: L('tipsPerquisites'),
    taxBorneByEmployer: L('taxBorneByEmployer'),
    esos: L('esos'),
    gratuity: L('gratuity'),
    arrears: L('arrears'),
    benefitsInKind: L('benefitsInKind'),
    livingAccommodation: L('livingAccommodation'),
    unapprovedFundRefund: L('unapprovedFundRefund'),
    compensation: L('compensation'),
    totalGrossRemuneration: L('totalGrossRemuneration'),
    sectionCPensionOther: L('sectionCPensionOther'),
    pension: L('pension'),
    annuity: L('annuity'),
    totalPensionOther: L('totalPensionOther'),
    sectionDTotalDeductions: L('sectionDTotalDeductions'),
    monthlyTaxDeduction: L('monthlyTaxDeduction'),
    cp38Deductions: L('cp38Deductions'),
    zakatViaSalary: L('zakatViaSalary'),
    donations: L('donations'),
    tp1Relief: L('tp1Relief'),
    zakatOther: L('zakatOther'),
    childRelief: L('childRelief'),
    sectionFExemptAllowances: L('sectionFExemptAllowances'),
    fundName: L('fundName'),
    sectionEContributions: L('sectionEContributions'),
    epfKwsp: L('epfKwsp'),
    socso: L('socso'),
    eisSip: L('eisSip'),
    disclaimer: interp(L('disclaimer'), { year: '2026', version: '2026.3' }),
    amendedNote: ea.override.amendedNote,
  };
}

describe('EA PDF renderer — the real message bundle', () => {
  it.each(LOCALES)('%s: the whole form is ONE page, with every line inside it', async (locale) => {
    const real = bundleFor(locale);
    // The fully-populated form WITH an amendment marker — the tallest document this renderer can produce.
    const { items, pageHeights } = await drawnText(await renderEaPdf(fullForm, real));

    expect(items.length).toBeGreaterThan(40); // the whole form was drawn, not an early return
    expect(pageHeights.length, `${locale}: the EA must be a single page`).toBe(1);

    const off = items.filter((it) => it.y < 0 || it.y > pageHeights[it.page]);
    expect(off.map((it) => `p${it.page} y=${it.y} ${it.text}`), `${locale}: every line inside its page`).toEqual([]);

    // The three blocks that orphaned onto page two: Part E's last figure, the "amended" marker and the
    // wrapped disclaimer. Named individually so a regression says WHICH one left, not just "2 pages".
    expect(items.find((it) => it.text.includes('RM 118.80'))?.page, `${locale}: the EIS figure`).toBe(0);
    expect(items.find((it) => it.text === winAnsi(real.amendedNote))?.page, `${locale}: the amended marker`).toBe(0);
    expect(items[items.length - 1].page, `${locale}: the last disclaimer line`).toBe(0);
  });

  it('a disclaimer taller than the band still lands INSIDE the pages it spills onto', async () => {
    // The pathological input the band's own page break exists for: no real bundle string is this long, so
    // this is the only way to exercise it. Every line must still be on a page, and the spill must carry
    // content — an empty trailing page is the failure mode the r209 fix removed from the normal path.
    const longWinded = { ...bundleFor('en'), disclaimer: Array.from({ length: 400 }, (_, i) => `clause-${i}`).join(' ') };
    const { items, pageHeights } = await drawnText(await renderEaPdf(fullForm, longWinded));

    expect(pageHeights.length).toBeGreaterThan(1);
    const off = items.filter((it) => it.y < 0 || it.y > pageHeights[it.page]);
    expect(off.map((it) => `p${it.page} y=${it.y} ${it.text}`), 'every line inside its page').toEqual([]);
    // Every page carries drawn text — no page is created and left blank.
    for (let p = 0; p < pageHeights.length; p++) {
      expect(items.some((it) => it.page === p), `page ${p} must carry text`).toBe(true);
    }
  });
});
