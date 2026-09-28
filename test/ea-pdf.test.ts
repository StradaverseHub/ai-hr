/**
 * EA (C.P.8A) PDF renderer — a pure function over the employeeEaStatement read + localized labels. We
 * assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null fields +
 * non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded per ADR-0036) and on a
 * tax category outside the 1/2/3 map (the renderer's String(category) fallback).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { blankEaPdfData, renderEaPdf, type EaPdfData, type EaPdfLabels, eaFormWords } from '../lib/ea-pdf';

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
    expect(printed).toContain(labels.pension);
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
    expect(items.find((it) => it.text === winAnsi(real.amendedNote))?.page, `${locale}: the amended marker`).toBe(0);
    expect(
      items.find((it) => it.text.includes('RM 118.80')),
      `${locale}: the EIS figure is back on the printed form`,
    ).toBeUndefined();
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
    for (const caption of [
      titleOf(real.sectionAEmployeeParticulars),
      titleOf(real.sectionBEmploymentIncome),
      titleOf(real.sectionCPensionOther),
      titleOf(real.sectionDTotalDeductions),
      titleOf(real.sectionEContributions),
      titleOf(real.sectionFExemptAllowances),
      real.formTotal,
      real.grossSalary,
      real.gratuity,
      real.compensation,
      real.childRelief,
      real.contributionAmount,
      real.partYearNote,
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
      fullForm.employer.address.join(', '),
      fullForm.partE.fundName,
      `${eaFormWords('ms').masthead4} ${fullForm.year}`,
    ]);
    const disclaimerLines = new Set(filled.slice(filled.indexOf(winAnsi(real.amendedNote)) + 1));
    const unexplained = onlyOnFilled.filter(
      (t) => !isFigureOrDetail(t) && !fixtureDetails.has(t) && !disclaimerLines.has(t) && t !== winAnsi(real.amendedNote),
    );
    expect(unexplained, `these are drawn on the filled form and missing from the blank: ${unexplained.join(' | ')}`).toEqual(
      [],
    );
  });
});
