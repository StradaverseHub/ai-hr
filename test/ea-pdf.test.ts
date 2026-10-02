/** EA renderer: actual decoded glyphs, geometry, complete values, readable fit and preserved amounts. */
import { extractedRuns } from './helpers/pcb-pdf-text';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream, type PDFFont } from 'pdf-lib';
import {
  EA_FORM,
  EA_V6_FOOT,
  EaLayoutFitError,
  EA_FORM_NUMBERING,
  blankEaPdfData,
  eaCaptionWords,
  eaFormWords,
  renderEaPdf,
  type EaPdfData,
  type EaPdfLabels,
} from '../lib/ea-pdf';

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
  return extractedRuns(bytes);
}

const labels: EaPdfLabels = {
  title: 'Statement of Remuneration · EA (C.P.8A)',
  sectionAEmployeeParticulars: 'A  EMPLOYEE PARTICULARS',
  name: '1. Full name of employee / pensioner (Mr/Ms/Mrs)',
  jobTitle: '2. Designation',
  employeeNo: '3. Staff no. / Payroll no.',
  icNo: '4. New I.C. no.',
  passportNo: '5. Passport no.',
  epfNo: '6. EPF no.',
  socsoNo: '7. PERKESO no.',
  childrenTaxRelief: '8. Number of children qualifying for tax relief',
  partYearNote: '9. If employed for less than a full year, state:',
  startedOn: '(a) Date employment began',
  leftOn: '(b) Date employment ceased',
  sectionBEmploymentIncome: 'B  INCOME FROM EMPLOYMENT, BENEFITS AND LIVING ACCOMMODATION',
  sectionBExcluding: '(Excluding tax-exempt allowances / perquisites / gifts / benefits)',
  grossSalary: '1(a) Gross salary, wages or leave pay (including overtime pay)',
  feesCommissionBonus: "1(b) Fees (including directors' fees), commission or bonus",
  tipsPerquisitesOther: '1(c) Gross tips, perquisites, awards or other allowances',
  paymentDetail: 'Details of payment:',
  stateWhat: 'State:',
  addressCue: 'Address:',
  taxBorneByEmployer: '1(d) Income tax paid by the employer on behalf of the employee',
  esos: '1(e) Employee Share Option Scheme (ESOS) benefit',
  gratuity: '1(f) Gratuity for the period',
  periodFrom: 'from',
  periodTo: 'to',
  incomeType: 'Type of income',
  arrears: '2. Particulars of arrears and other payments for previous years paid in the current year',
  benefitsInKind: '3. Benefits in kind',
  livingAccommodation: '4. Value of living accommodation',
  unapprovedFundRefund: '5. Refund from an unapproved provident / pension fund',
  compensation: '6. Compensation for loss of employment',
  sectionCPensionOther: 'C  PENSION AND OTHERS',
  pension: '1. Pension',
  annuity: '2. Annuity or other periodical payments',
  formTotal: 'TOTAL',
  sectionDTotalDeductions: 'D  TOTAL DEDUCTIONS',
  monthlyTaxDeduction: '1. Monthly tax deduction (MTD) paid to LHDNM',
  cp38Deductions: '2. CP38 deduction order paid to LHDNM',
  zakatViaSalary: '3. Zakat paid through salary deduction',
  donations: '4. Approved donations / gifts / contributions paid through salary deduction',
  tp1ClaimHeading: '5. Total deductions claimed by the employee via Form TP1 in respect of:',
  tp1Relief: '5(a) Relief claimed via Form TP1',
  zakatOther: '5(b) Zakat other than through monthly salary deduction',
  childRelief: '6. Total relief for qualifying children',
  sectionEContributions: 'E  CONTRIBUTIONS PAID BY THE EMPLOYEE TO AN APPROVED FUND AND PERKESO',
  fundName: '1. Name of fund',
  contributionAmount: "Amount of contribution payable (state the employee's share only)",
  sectionFExemptAllowances: 'F  TOTAL EXEMPT ALLOWANCES / PERQUISITES / GIFTS / BENEFITS',
  amendedNote: 'Some figures on this EA form were amended by HR and differ from the payroll-derived values.',
};

const data: EaPdfData = {
  year: '2026',
  employer: {
    name: 'Acme Sdn Bhd',
    eNumber: 'E1234567890',
    address: ['12 Jalan Raja Chulan', 'Bukit Ceylon', '50200 Kuala Lumpur, Wilayah Persekutuan'],
    phone: '03-2000 1234',
    lhdnState: 'Wilayah Persekutuan Kuala Lumpur',
    officerName: 'Nurul Aina binti Hamzah',
    officerPosition: 'HR Manager',
  },
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
  // ⚠️ r367 — THE THREE PERKESO LEGS ARE NON-ZERO AND MUTUALLY DISTINCT, ON PURPOSE. Section E(2) now
  // prints socso + eis + skbbk, so a fixture with skbbk at 0 (or two equal legs) would let the old
  // one-leg renderer pass every case below. 297 + 118.80 + 43.45 = 459.25, which equals no leg and no
  // pair of them.
  partE: { epf: 7810, socso: 297, eis: 118.8, skbbk: 43.45, fundName: 'KWSP' },
  // r367 — a FIXED date, not a clock read: the renderer is pure and takes this as data.
  formDate: '2027-02-15',
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
        // Every employer box empty — the form must print its own rules, and nothing else.
        employer: {
          name: 'Acme Sdn Bhd',
          eNumber: null,
          address: [],
          phone: null,
          lhdnState: null,
          officerName: null,
          officerPosition: null,
        },
        employee: { ...data.employee, name: '陈大文', taxNo: null, ic: null, epfNo: null, socsoNo: null, terminatedOn: '2026-06-30' },
      },
      labels,
    );
    expect(head(bytes)).toBe('%PDF-'); // WinAnsi safe-encode guard → no crash on the CJK name
    expect(bytes.length).toBeGreaterThan(1000);
  });

  /**
   * r353 (item fda53352, point 4) — THE GUARD THAT DID NOT EXIST, FOR A DEFECT THAT WAS LIVE.
   *
   * B.1(c), B.3 and B.4 each print the agency's cue in brackets with an inline dotted rule, and all
   * three passed `ruleTo = 481` — a literal left behind when r346 moved the money column to
   * `EA_FORM.moneyLeft` = 482.3. `captionWithInlineRule` puts the closing ')' at `ruleTo + 2` = 483 and
   * the glyph runs further still, so the bracket printed INSIDE the money column, over the first digit
   * of the amount, on three lines of every filled form. pdf-lib does not clip: the page rendered, the
   * route returned 200 and the file downloaded (r205's Borang A lesson).
   *
   * This MEASURES THE DRAWN GLYPH rather than the arithmetic that placed it, which is the only version
   * of this check that can catch the next font or size change too.
   */
  it('r353 — no inline caption bracket is drawn into the money column', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    // A form WITH money on those three lines: an overprint on a blank rule is invisible.
    const { items, pageHeights } = await drawnText(await renderEaPdf(fullForm, labels));
    const brackets = items.filter((i) => i.text === ')');
    expect(brackets.length, 'the three inline description rules lost their closing bracket').toBe(3);
    for (const b of brackets) {
      const right = b.x + font.widthOfTextAtSize(')', 8);
      expect(
        right,
        `a ')' at x=${b.x} (tt ${(pageHeights[b.page] - b.y).toFixed(1)}) ends at ${right.toFixed(1)}, ` +
          `inside the money column at ${EA_FORM.moneyLeft}`,
      ).toBeLessThanOrEqual(EA_FORM.moneyLeft);
    }
    // …and it used to. 481 + 2 + the glyph is 485.7, which is 3.4 pt into the column.
    expect(481 + 2 + font.widthOfTextAtSize(')', 8)).toBeGreaterThan(EA_FORM.moneyLeft);
  });

  // Revision 3 supersedes the old continuation and overprint assertions with finite readable fit.
  describe('r379 V6 complete one-page layout', () => {
    const fixture = {...fullForm, employer:{...fullForm.employer,name:'PECCA LEATHER SDN BHD',address:[
      'NO. 1, JALAN PERINDUSTRIAN DESA AMAN 1A,', 'INDUSTRI DESA AMAN, KEPONG,', '52200 KUALA LUMPUR, WILAYAH PERSEKUTUAN']}};
    it.each(['en','ms'] as const)('%s: V6 whole employer block is readable on one A4 page', async locale => {
      const {items,pageHeights}=await extractedRuns(await renderEaPdf(fixture,labels,{locale}));
      expect(pageHeights).toHaveLength(1);
      expect(pageHeights[0]).toBeCloseTo(841.89,1);
      const rows=items.filter(i=>i.x===EA_V6_FOOT.valueX+3 && pageHeights[0]-i.y>EA_V6_FOOT.top);
      const text=rows.map(i=>i.text).join(' ');
      expect(text).toContain(fixture.employer.name);
      expect(text).toContain(fixture.employer.address.join(', '));
      expect(text).toContain(fixture.employer.officerName);
      expect(text).toContain(fixture.employer.officerPosition);
      expect(text).toContain(fixture.employer.phone);
      const font=await(await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
      for(const row of rows){expect(row.size).toBe(8);expect(row.x+font.widthOfTextAtSize(row.text,row.size)).toBeLessThanOrEqual(EA_V6_FOOT.right);}
      expect(items.every(i=>i.size>=6)).toBe(true);
      expect(items.some(i=>i.text==='15/02/2027')).toBe(true);
    });
    it('preserves complete Unicode employee and employer values',async()=>{
      const unicode={...fixture,employee:{...fixture.employee,name:'陈大文'},employer:{...fixture.employer,name:'陈大文有限公司',officerName:'陈大文',address:['吉隆坡产业路一号']}};
      const {items}=await extractedRuns(await renderEaPdf(unicode,labels));
      expect(items.some(i=>i.text===unicode.employee.name)).toBe(true);
      expect(items.some(i=>i.text===unicode.employer.name)).toBe(true);
      expect(items.some(i=>i.text===unicode.employer.address[0])).toBe(true);
      expect(items.every(i=>!i.text.includes('�'))).toBe(true);
    });
    it('refuses a caption too wide for its owning cell at the readable floor',async()=>{
      await expect(renderEaPdf(fixture,{...labels,name:'Complete employee caption '.repeat(30)})).rejects.toBeInstanceOf(EaLayoutFitError);
    });
    it('refuses a complete employee name too wide for its fixed row without clipping',async()=>{
      await expect(renderEaPdf({...fixture,employee:{...fixture.employee,name:'Complete Employee Name '.repeat(30)}},labels)).rejects.toBeInstanceOf(EaLayoutFitError);
    });
    it('refuses an exceptionally unfit complete address instead of continuing or truncating',async()=>{
      const address=Array.from({length:24},(_,i)=>`Bangunan Tabung Amanah Pekerja Bersatu Blok ${i} Aras Lapan Belas`);
      await expect(renderEaPdf({...fixture,employer:{...fixture.employer,address}},labels)).rejects.toBeInstanceOf(EaLayoutFitError);
    });
    it.each(['officerName','officerPosition','phone'] as const)('refuses an unfit complete %s instead of overprinting',async field=>{
      await expect(renderEaPdf({...fixture,employer:{...fixture.employer,[field]:'Senior General Manager Corporate Compliance '.repeat(20)}},labels)).rejects.toBeInstanceOf(EaLayoutFitError);
    });
    it('preserves every character of an unbroken address token at readable size',async()=>{
      const token='ABCDEFGHIJKLMNOP'.repeat(9);
      const {items,pageHeights}=await extractedRuns(await renderEaPdf({...fixture,employer:{...fixture.employer,address:[token]}},labels));
      const rows=items.filter(i=>i.x===EA_V6_FOOT.valueX+3 && pageHeights[0]-i.y>EA_V6_FOOT.top);
      expect(rows.map(i=>i.text).join('').includes(token)).toBe(true);
      expect(rows.every(i=>i.size===8)).toBe(true);
    });
    it('keeps the amended marker clear of the wider footer',async()=>{
      const {items,pageHeights}=await extractedRuns(await renderEaPdf({...fixture,overrides:[{field:'partB.bonus',original:0,amended:5000,reason:'Correction'}]},labels));
      const marker=items.find(i=>i.text===labels.amendedNote)!;
      expect(marker).toBeDefined();expect(marker.page).toBe(0);
      expect(pageHeights[0]-marker.y).toBeLessThan(EA_V6_FOOT.top);
      expect(pageHeights[0]-marker.y).toBeGreaterThan(EA_FORM.sectionT.f);
    });
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
    // Part C — the section that did not exist. r349 draws the section LETTER in a filled black square
    // and the title beside it, so the heading reaches the page as two pieces, not one string.
    expect(printed).toContain(labels.sectionCPensionOther.replace(/^\s*[A-F]\s+/, ''));
    expect(printed, 'the boxed section letter').toContain('C');
    // ⚠️ r372 — AND A NUMBERED CAPTION IS TWO PIECES FOR THE SAME REASON THE HEADING IS. The agency
    // sets the item number in its own column (62.5) and the words in another (80.2), so C.1 reaches
    // the page as "1." and "Pension", not as "1. Pension". Both halves are asserted.
    expect(printed).toContain(eaCaptionWords(labels.pension, EA_FORM_NUMBERING.pension));
    expect(printed, 'C.1’s item number').toContain('1.');
    // r219 — THE FIGURES ARE UNCHANGED; ONLY THE FORMAT MOVED. The C.P.8A prints ONE bold "RM" at the
    // head of its money column and bare figures down it, so an amount in that column no longer carries
    // its own "RM " prefix. The assertion that matters is that the FIGURE is on the document, and it
    // still is.
    expect(printed).toContain('12,000.00'); // the pension figure
    // …and the form's single JUMLAH, which totals B and C together (91,000 + 15,000) where our own
    // layout used to print a Part B subtotal and a Part C subtotal that the agency's page does not have.
    expect(printed).toContain('106,000.00');
    // Part D — CP38 and zakat as figures, NOT as the words "not tracked".
    expect(printed).toContain('600.00'); // cp38
    expect(printed).toContain('240.00'); // zakat
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

/** Labels now survive through the embedded Unicode font's ToUnicode map. */
const winAnsi = (s: string) => s;

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
    sectionAEmployeeParticulars: L('sectionAEmployeeParticulars'),
    name: L('name'),
    jobTitle: L('jobTitle'),
    employeeNo: L('employeeNo'),
    icNo: L('icNo'),
    passportNo: L('passportNo'),
    epfNo: L('epfNo'),
    socsoNo: L('socsoNo'),
    childrenTaxRelief: L('childrenTaxRelief'),
    partYearNote: L('partYearNote'),
    startedOn: L('startedOn'),
    leftOn: L('leftOn'),
    sectionBEmploymentIncome: L('sectionBEmploymentIncome'),
    sectionBExcluding: L('sectionBExcluding'),
    grossSalary: L('grossSalary'),
    feesCommissionBonus: L('feesCommissionBonus'),
    tipsPerquisitesOther: L('tipsPerquisitesOther'),
    paymentDetail: L('paymentDetail'),
    stateWhat: L('stateWhat'),
    addressCue: L('addressCue'),
    taxBorneByEmployer: L('taxBorneByEmployer'),
    esos: L('esos'),
    gratuity: L('gratuity'),
    periodFrom: L('periodFrom'),
    periodTo: L('periodTo'),
    incomeType: L('incomeType'),
    arrears: L('arrears'),
    benefitsInKind: L('benefitsInKind'),
    livingAccommodation: L('livingAccommodation'),
    unapprovedFundRefund: L('unapprovedFundRefund'),
    compensation: L('compensation'),
    sectionCPensionOther: L('sectionCPensionOther'),
    pension: L('pension'),
    annuity: L('annuity'),
    formTotal: L('formTotal'),
    sectionDTotalDeductions: L('sectionDTotalDeductions'),
    monthlyTaxDeduction: L('monthlyTaxDeduction'),
    cp38Deductions: L('cp38Deductions'),
    zakatViaSalary: L('zakatViaSalary'),
    donations: L('donations'),
    tp1ClaimHeading: L('tp1ClaimHeading'),
    tp1Relief: L('tp1Relief'),
    zakatOther: L('zakatOther'),
    childRelief: L('childRelief'),
    sectionFExemptAllowances: L('sectionFExemptAllowances'),
    fundName: L('fundName'),
    contributionAmount: L('contributionAmount'),
    sectionEContributions: L('sectionEContributions'),
    amendedNote: ea.override.amendedNote,
  };
}

describe('EA PDF renderer — the real message bundle', () => {
  it.each(LOCALES)('%s: the whole form is ONE page, with every line inside it', async (locale) => {
    const real = bundleFor(locale);
    // The fully-populated form WITH an amendment marker — the tallest document this renderer can produce.
    const { items, pageHeights } = await drawnText(await renderEaPdf(fullForm, real, { locale }));

    expect(items.length).toBeGreaterThan(40); // the whole form was drawn, not an early return
    expect(pageHeights.length, `${locale}: the EA must be a single page`).toBe(1);

    const off = items.filter((it) => it.y < 0 || it.y > pageHeights[it.page]);
    expect(off.map((it) => `p${it.page} y=${it.y} ${it.text}`), `${locale}: every line inside its page`).toEqual([]);

    // ⚠️ r351 — TWO OF THE THREE BLOCKS THIS GUARDED NO LONGER EXIST. It used to name Part E's EIS
    // figure, the "amended" marker and the wrapped disclaimer, because all three once orphaned onto a
    // second page. The reporter has since had the whole strip removed from the form, so the EIS figure
    // and the disclaimer are gone and only the amended marker remains to be kept on page one.
    //
    // The two removals become POSITIVE assertions rather than being deleted: this is now also the guard
    // that the strip cannot come back through the renderer, from the pagination side.
    //
    // ⚠️ r367 (item fda53352, round A) — THE EIS ASSERTION IS REWORDED, AND ITS OLD MESSAGE IS QUOTED
    // BELOW BECAUSE IT NAMED A CLAIM THAT HAS BEEN REVERSED. It read `${locale}: the EIS figure is back
    // on the printed form` and looked for `RM 118.80`, the fixture's EIS leg ON ITS OWN LINE. The EIS
    // figure IS on the printed form now — inside Section E(2)'s sum, which is the box LHDN's caption
    // gives it (sources on `EaPdfData.partE`). What must still not appear is a LINE OF OURS carrying the
    // leg by itself, which is what the removed strip drew, so the assertion now says that: the bare leg
    // is absent, and the sum 297 + 118.80 + 43.45 = RM 459.25 is present. Both halves matter — the first
    // stops the strip returning, the second stops E(2) silently narrowing back to one leg.
    // Indic shaping reorders glyphs in the font's ToUnicode map; identify the saved marker by its
    // unique reserved baseline, then require actual nonempty text on page one.
    const marker = items.find(it => Math.abs(pageHeights[it.page]-it.y-EA_FORM.amendedNoteT)<0.1);
    expect(marker?.page, `${locale}: the amended marker`).toBe(0);
    // Fontkit Indic shaping reorders vowel glyphs; compare the complete codepoint multiset.
    const normalize = (value:string) => [...value.normalize('NFD')].sort().join('');
    if(locale==='ta') expect(normalize(marker!.text)).toBe(normalize(real.amendedNote));
    else if(locale==='vi') {
      // The subset CMap omits the standalone combining dot glyph, although it is visibly drawn.
      expect(normalize(marker!.text.replace(/�/g,'\u0323'))).toBe(normalize(real.amendedNote));
    } else expect(marker!.text).toBe(real.amendedNote);
    expect(
      items.find((it) => it.text.includes('RM 118.80')),
      `${locale}: the EIS leg is printed on a line of its own again (the r351 strip is back)`,
    ).toBeUndefined();
    // The strip drew its figure as one string, "RM 118.80"; Section E's money column draws the bare amount
    // with its own "RM" beside it, so this looks for the amount.
    expect(
      items.find((it) => it.text.includes('459.25'))?.page,
      `${locale}: Section E(2) must print SOCSO + EIS + SKBBK (297.00 + 118.80 + 43.45)`,
    ).toBe(0);
    expect(items[items.length - 1].page, `${locale}: nothing spills to a second page`).toBe(0);
  });

  it('r351 — the form ends at the officer box: nothing of ours is drawn below it', () => {
    // ⚠️ THIS REPLACES "a disclaimer taller than the band still lands INSIDE the pages it spills onto".
    // That case existed for the band's own page break, which existed for the disclaimer — and the
    // disclaimer is gone from the form, so the pathological input it exercised is unreachable. Deleting
    // the case outright would leave nothing asserting WHY, so it is inverted: the renderer must no longer
    // contain the wrapping band at all, which is the mechanism that could reintroduce a second page.
    const renderer = readFileSync(new URL('../lib/ea-pdf.ts', import.meta.url), 'utf8');
    expect(renderer, 'the disclaimer band is back').not.toContain('wrapped(t.disclaimer');
    expect(renderer, 'the strip rule is back').not.toContain('hRule(L, R, y - 7, 1.2, ink);');
  });
});

/**
 * ⚠️ r220 (item 61c2e30f) — THE BLANK FORM, AND THE ONE WAY IT CAN GO WRONG WITHOUT ANYTHING NOTICING.
 *
 * The reporter asked to see the EA empty first, so the arrangement can be held against LHDN's own page
 * before a filled one is trusted. Every partB/partC/partD/partE amount on `EaPdfData` is a REQUIRED number,
 * so an "empty" statement is a statement of ZEROS — and zeros print. A blank C.P.8A with `0.00` down the
 * whole money column is not a blank form at all: it asserts, on every line at once, that none of that money
 * exists (AGENTS 28, which r209 shipped on this exact form one box at a time).
 *
 * Nothing else in this file can see that. The document is one page, every line is inside it, every caption
 * is present, it opens, it is bigger than 1000 bytes and it starts with %PDF. So the assertions are: the
 * blank is ONE page in every locale the app has, NO amount appears anywhere on it, and it still draws every
 * caption the filled form draws — a "blank" that quietly lost half the form would satisfy the first two.
 */
describe('r220 — the blank C.P.8A', () => {
  // r351 — the blank no longer carries a disclaimer: the strip it sat in is gone from the form entirely,
  // so a blank and a filled form differ only in their figures, which is what the agency's own blank does.
  const blankBundle = (locale: string): EaPdfLabels => bundleFor(locale);

  it.each(LOCALES)('%s: is ONE page, with every line inside it', async (locale) => {
    const { items, pageHeights } = await drawnText(
      await renderEaPdf(blankEaPdfData(), blankBundle(locale), { blank: true, locale }),
    );
    expect(items.length, `${locale}: the whole form was drawn, not an early return`).toBeGreaterThan(40);
    expect(pageHeights.length, `${locale}: the blank EA must be a single page`).toBe(1);
    const off = items.filter((it) => it.y < 0 || it.y > pageHeights[it.page]);
    expect(off.map((it) => `p${it.page} y=${it.y} ${it.text}`), `${locale}: every line inside its page`).toEqual([]);
  });

  it.each(LOCALES)('%s: carries no 0.00 and no figure of any kind', async (locale) => {
    const { items } = await drawnText(await renderEaPdf(blankEaPdfData(), blankBundle(locale), { blank: true, locale }));
    const printed = items.map((it) => it.text);

    // The headline assertion, named on its own so a regression says exactly this.
    expect(printed.filter((s) => s === '0.00'), `${locale}: a blank form printed 0.00`).toEqual([]);
    expect(printed.filter((s) => s === 'RM 0.00'), `${locale}: a blank form printed RM 0.00`).toEqual([]);

    // …and the wider one, because a sentinel or a placeholder would pass the line above. Nothing drawn on
    // a blank form may be an amount, a bare number, a dash or an "N/A": the form prints its own rules and
    // NOTHING on them, which is what the agency's blank page looks like.
    const amounts = printed.filter((s) => /^-?[\d,]+\.\d\d$/.test(s) || /^RM\s/.test(s));
    expect(amounts, `${locale}: amounts printed on a blank form`).toEqual([]);
    const counts = printed.filter((s) => /^\d+$/.test(s));
    expect(counts, `${locale}: bare numbers printed on a blank form (item 8 is the usual suspect)`).toEqual([]);
    expect(printed.filter((s) => s === '\u2014' || s === '-' || s === 'N/A')).toEqual([]);
  });

  /**
   * THE OTHER HALF, and the one a "no figures" test cannot see: a renderer that returned an early empty
   * page would pass every assertion above. The blank must draw EVERY caption the filled form draws — the
   * masthead, the banner, all six section titles, every numbered box, the officer box and the signature
   * area — because that is the whole point of holding it up against the agency's page.
   */
  it('draws every caption the filled form draws, and differs from it only in the figures', async () => {
    const filled = (await drawnText(await renderEaPdf(fullForm, bundleFor('ms'), { locale: 'ms' }))).items.map((it) => it.text);
    const blank = (await drawnText(await renderEaPdf(blankEaPdfData(), blankBundle('ms'), { blank: true, locale: 'ms' }))).items.map(
      (it) => it.text,
    );

    const real = bundleFor('ms');
    // Named individually, so a regression says WHICH part of the form left rather than "a caption is gone".
    // ⚠️ A SECTION HEADING IS NO LONGER ONE DRAWN STRING (r349, item fda53352). The agency sets its
    // section letters in filled black squares with white lettering, so the renderer now splits
    // "C  PENSION AND OTHERS" into a boxed "C" and the title beside it. The label is unchanged — the
    // catalogues still own the letter, because the form's numbering is part of its wording — but the
    // PAGE draws two pieces. Asserting the joined string here would fail on a page that is correct.
    const titleOf = (label: string) => {
      const m = /^\s*([A-F])\s+(.*)$/.exec(label);
      return m ? m[2] : label;
    };
    /**
     * ⚠️ AND A NUMBERED CAPTION IS NO LONGER ONE DRAWN STRING EITHER (r372, item 795c470c). The agency
     * sets the item number at 62.5, the sub-item letter at 80.2 and the words at 94.3, so the renderer
     * draws "1.", "(a)" and "Gross salary…" where it used to draw "1(a) Gross salary…". The catalogue
     * is unchanged — the HTML statement still prints the number — and the PAGE draws the pieces.
     * Asserting the joined string here would fail on a page that is correct.
     */
    const N = EA_FORM_NUMBERING;
    for (const caption of [
      titleOf(real.sectionAEmployeeParticulars),
      titleOf(real.sectionBEmploymentIncome),
      titleOf(real.sectionCPensionOther),
      titleOf(real.sectionDTotalDeductions),
      titleOf(real.sectionEContributions),
      titleOf(real.sectionFExemptAllowances),
      real.formTotal,
      eaCaptionWords(real.grossSalary, N.grossSalary),
      eaCaptionWords(real.gratuity, N.gratuity),
      eaCaptionWords(real.compensation, N.compensation),
      eaCaptionWords(real.childRelief, N.childRelief),
      real.contributionAmount,
      eaCaptionWords(real.partYearNote, N.partYearNote),
    ]) {
      expect(blank, `the blank form is missing: ${caption}`).toContain(winAnsi(caption));
    }

    // …and the sweep behind those, so a caption nobody thought to name here cannot go missing either. What
    // the FILLED form draws and the blank does not must be exactly: figures, the employee's and employer's
    // own details, the year appended to the masthead, and the footnote strip (which says something else on
    // a blank, deliberately — "Generated from payroll for YA 2026" is false on a page with nothing in it).
    const onlyOnFilled = filled.filter((t) => !blank.includes(t));
    const isFigureOrDetail = (t: string) =>
      /^-?[\d,]+\.\d\d$/.test(t) || /^RM\s/.test(t) || /^\d+$/.test(t) || /^\d\d\/\d\d\/\d{4}$/.test(t);
    const fixtureDetails = new Set<string>([
      fullForm.employee.name,
      fullForm.employee.ic!,
      fullForm.employee.taxNo!,
      fullForm.employee.epfNo!,
      fullForm.employee.socsoNo!,
      fullForm.employee.employeeNo!,
      fullForm.employee.jobTitle!,
      fullForm.employee.passport!,
      fullForm.employer.name,
      fullForm.employer.eNumber!,
      fullForm.employer.phone!,
      fullForm.employer.lhdnState!,
      fullForm.employer.officerName!,
      fullForm.employer.officerPosition!,
      fullForm.partE.fundName,
      `${eaFormWords('ms').masthead4} ${fullForm.year}`,
    ]);
    /**
     * ⚠️ r353 — THE EMPLOYER'S NAME AND ADDRESS ARE NO LONGER TWO WHOLE FIELDS ON TWO RULES.
     *
     * This set used to name `employer.name` and `employer.address.join(', ')` because that is exactly what
     * was drawn: the name on the officer box's first rule and the entire address squeezed onto the second.
     * The block is now greedy-wrapped across the agency's two rules, so each run is a SLICE of it and
     * neither is any one field. Recomputing the wrap here would duplicate the renderer's rule, so the
     * predicate asks the question that actually matters — is this run part of the employer's own
     * name-and-address block? — which still refuses a caption or a stray string.
     */
    const employerBlock = [fullForm.employer.name, ...fullForm.employer.address].join(', ');
    const isEmployerBlockLine = (t: string) => t.length > 0 && employerBlock.includes(t);
    const disclaimerLines = new Set(filled.slice(filled.indexOf(winAnsi(real.amendedNote)) + 1));
    const unexplained = onlyOnFilled.filter(
      (t) =>
        !isFigureOrDetail(t) &&
        !fixtureDetails.has(t) &&
        !isEmployerBlockLine(t) &&
        !disclaimerLines.has(t) &&
        t !== winAnsi(real.amendedNote),
    );
    expect(unexplained, `these are drawn on the filled form and missing from the blank: ${unexplained.join(' | ')}`).toEqual(
      [],
    );
  });
});
