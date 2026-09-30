/**
 * EA (C.P.8A) PDF renderer — a pure function over the employeeEaStatement read + localized labels. We
 * assert it produces a real (%PDF) document of non-trivial size and degrades gracefully on null fields +
 * non-Latin names (the WinAnsi safe-encode guard, until a Unicode font is embedded per ADR-0036) and on a
 * tax category outside the 1/2/3 map (the renderer's String(category) fallback).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream, type PDFFont } from 'pdf-lib';
import { EA_FORM, blankEaPdfData, renderEaPdf, type EaPdfData, type EaPdfLabels, eaFormWords } from '../lib/ea-pdf';

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

  /**
   * r353 (item fda53352, point 5) — A LONG EMPLOYER ADDRESS USES BOTH OF THE AGENCY'S RULES AT FULL SIZE.
   *
   * The officer box gives "Name and Address of Employer" TWO writing lines. Measured off the agency's own
   * file with `node --import tsx scripts/measure-ea-official-pdf.ts --rects`: five rows of 13.2 pt at
   * tt 739.8 / 753 / 766.2 / 779.4 / 792.6 — Name of Officer, Designation, the captioned name-and-address
   * row, ONE unlabelled continuation rule, and Telephone No. Two lines, which is what this box has.
   *
   * ⚠️ THE DEFECT WAS NEVER THE RULE COUNT — THE SECOND RULE WAS BEING WASTED. The employer's name took
   * all of rule one and the WHOLE address was pushed onto rule two through `fitSize`, which shrinks
   * instead of wrapping and is floored at 1 pt. This fixture's address is 340 pt of 8 pt Helvetica against
   * a 269 pt rule, so it printed at about 6.3 pt — and with a longer one, smaller still, silently: no
   * overflow, no error, a valid downloadable PDF (r205's Borang A lesson).
   *
   * ⚠️ MEASURED, NOT EYEBALLED, AND IN BOTH EDITIONS — the officer box's captions are per-edition and the
   * English ones are the wider. The property asserted is the one that decides whether a printed form is
   * readable: every run drawn on those two rules FITS its rule at the full 8 pt, which is true only if the
   * text was wrapped rather than squeezed.
   */
  it.each(['en', 'ms'] as const)(
    'r353 — %s: a four-part employer address wraps across both officer rules instead of shrinking',
    async (locale) => {
      const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
      const address = [
        'Unit 27-3A, Menara Perdana',
        'No. 8, Jalan Tun Razak',
        '50400 Kuala Lumpur',
        'Wilayah Persekutuan',
      ];
      const long: EaPdfData = {
        ...fullForm,
        employer: { ...fullForm.employer, name: 'Isedecor Bina Konstruksi Sdn Bhd', address },
      };
      const { items, pageHeights } = await drawnText(await renderEaPdf(long, labels, { locale }));
      const O = EA_FORM.officerBox;
      const ruleW = O.ruleX[1] - O.ruleX[0] - 6; // what valueOrRule actually writes into
      // The runs written ON the two employer rules. `valueOrRule` writes at ruleX[0] + 3.
      const onRule = items.filter(
        (i) =>
          Math.abs(i.x - (O.ruleX[0] + 3)) < 0.5 &&
          [689, 706].some((tt) => Math.abs(pageHeights[i.page] - i.y - tt) < 0.5),
      );
      expect(onRule.length, 'the employer name/address block is not on the officer box\'s two rules').toBe(2);
      for (const run of onRule) {
        expect(
          font.widthOfTextAtSize(run.text, 8),
          `"${run.text}" is ${font.widthOfTextAtSize(run.text, 8).toFixed(0)}pt on a ${ruleW}pt rule, so it was SHRUNK`,
        ).toBeLessThanOrEqual(ruleW);
      }
      // Nothing was dropped on the way: every part of the address reached one of the two rules.
      const printed = onRule.map((r) => r.text).join(' ');
      for (const part of ['Menara Perdana', 'Jalan Tun Razak', '50400 Kuala Lumpur', 'Wilayah Persekutuan']) {
        expect(printed, `${part} is missing from the officer box`).toContain(part);
      }
      // …AND THE OLD SHAPE WOULD HAVE FAILED IT. The address alone, joined onto the second rule the way it
      // was until r353, is wider than that rule — which is precisely the shrink this case forbids.
      expect(font.widthOfTextAtSize(address.join(', '), 8)).toBeGreaterThan(ruleW);
    },
  );

  /**
   * ── r371 (item 450f443f) — r353 FIXED THE ONE-RULE CASE AND LEFT A TWO-RULE CEILING ────────────────
   *
   * The case above is the no-regression pin and it stays exactly as it is: an employer block that fits
   * the agency's two writing lines is drawn the way it has been since r353, at a full 8 pt on both.
   *
   * ⚠️ WHAT IT CANNOT SEE is the same failure one rule further along. Past about 130 characters the
   * remainder no longer fits rule two either, and `fitSize` — which shrinks rather than wraps, and used
   * to clamp at 1 pt — silently set it smaller and smaller. Measured on forms this renderer produced,
   * against the 269 pt rule, before this round:
   *
   *      block length      140     160     180     200     225     250     300     340     380
   *      smallest type    6.9pt   5.6pt   4.6pt   4.0pt   3.4pt   2.9pt   2.3pt   2.0pt   1.7pt
   *
   * Every one of those is a valid one-page PDF that opens, downloads, passes tsc and satisfies every
   * other case in this file. A 3.4 pt line is gone on paper — and this is the document the employee
   * signs and files. So the box grows a rule at a time instead, and the properties below are the ones
   * that decide whether the printed form is readable:
   *
   *   (a) NOTHING is set below `EA_FORM.officerBox.minSize`, anywhere in the box, at any length;
   *   (b) the rule count is the WRAPPED LINE COUNT, not a fixed two — the fix is wrapping, not shrinking;
   *   (c) the whole block still reaches the page, in order, with nothing dropped at the join;
   *   (d) the box's own foot row (telephone + date) moves down by exactly the growth, and stays inside
   *       `EA_FORM.bottom` — pdf-lib does not clip, so "off the page" here means "printed over the edge".
   */
  describe('r371 — the employer name and address wraps onto as many rules as it needs', () => {
    /** The same content-stream read as `drawnText`, keeping the `Tf` size that precedes each `Tm`. */
    async function drawnSized(bytes: Uint8Array) {
      const doc = await PDFDocument.load(bytes);
      const out: { page: number; x: number; tt: number; size: number; text: string }[] = [];
      doc.getPages().forEach((page, index) => {
        const h = page.getHeight();
        const contents = page.node.Contents();
        const streams =
          contents instanceof PDFArray
            ? contents.asArray().map((ref) => page.node.context.lookup(ref))
            : [contents];
        let raw = '';
        for (const s of streams) {
          if (s instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(s).decode()).toString('latin1');
        }
        // pdf-lib writes, per drawText: `/Helvetica-<id> <size> Tf` … `1 0 0 1 x y Tm` … `<hex> Tj`.
        const re = /\/[A-Za-z0-9-]+ ([\d.]+) Tf[\s\S]{0,120}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,120}?<([0-9A-Fa-f]*)> Tj/g;
        for (const m of raw.matchAll(re)) {
          out.push({
            page: index,
            size: Number(m[1]),
            x: Number(m[2]),
            tt: Math.round((h - Number(m[3])) * 100) / 100,
            text: Buffer.from(m[4], 'hex').toString('latin1'),
          });
        }
      });
      return out;
    }

    const O = EA_FORM.officerBox;
    const ruleW = O.ruleX[1] - O.ruleX[0] - 6;
    const writeX = O.ruleX[0] + 3;
    /** Greedy word-wrap at 8 pt into `ruleW` — the renderer's own `wrapped`, re-derived here. */
    const wrapAt8 = (s: string, font: PDFFont) => {
      const out: string[] = [];
      let line = '';
      for (const w of s.split(/\s+/).filter(Boolean)) {
        const trial = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(trial, 8) > ruleW && line) {
          out.push(line);
          line = w;
        } else line = trial;
      }
      if (line) out.push(line);
      return out;
    };

    // Long enough to need four rules, and a real Malaysian name-and-address rather than filler: it is
    // the shape the reporter's own attachment shows (item 450f443f, "EA Form design V1.png").
    const LONG_NAME = 'Perbadanan Pembangunan Infrastruktur dan Teknologi Maklumat Semenanjung Malaysia Berhad';
    const LONG_ADDRESS = [
      'Aras 27, Menara Tabung Haji, Jalan Tun Razak',
      'Kawasan Perindustrian Desa Aman Fasa 3, Lot 88-A',
      '52200 Kuala Lumpur, Wilayah Persekutuan',
    ];

    it.each(['en', 'ms'] as const)(
      '%s: a four-rule employer block is set at full size on four rules, and the box grows to hold them',
      async (locale) => {
        const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
        const block = [LONG_NAME, ...LONG_ADDRESS].join(', ');
        const expected = wrapAt8(block, font);
        expect(expected.length, 'the fixture no longer needs more than the agency’s two rules').toBeGreaterThan(2);

        const long: EaPdfData = { ...fullForm, employer: { ...fullForm.employer, name: LONG_NAME, address: LONG_ADDRESS } };
        const items = await drawnSized(await renderEaPdf(long, labels, { locale }));

        // (b) one rule per wrapped line — not the two the ceiling gave, and not a rule per address part.
        // The employer's rules are the box's third row onwards; the telephone writes at the SAME x one
        // row further down, so the baselines are named rather than taken as "everything below 689".
        const employerRows = expected.map((_, k) => 689 + k * O.rowPitch);
        const employerRuns = items.filter(
          (i) => Math.abs(i.x - writeX) < 0.5 && employerRows.some((tt) => Math.abs(i.tt - tt) < 0.5),
        );
        expect(
          employerRuns.map((i) => i.text),
          'the employer block was not given one rule per wrapped line',
        ).toEqual(expected);

        // (a) and the point of the whole round: nothing was shrunk to fit. Full size, every line.
        for (const run of employerRuns) {
          expect(run.size, `"${run.text}" was set at ${run.size}pt, not 8pt`).toBe(8);
          expect(
            font.widthOfTextAtSize(run.text, run.size),
            `"${run.text}" is wider than its ${ruleW}pt rule, so it overprints`,
          ).toBeLessThanOrEqual(ruleW);
        }

        // (c) nothing lost at the joins — the rules, read in order, are the block itself.
        expect(employerRuns.map((i) => i.text).join(' ')).toBe(block);

        // (d) the foot row followed the box down by exactly the growth, and the two halves of that row
        // (the telephone inside the box, the date outside it) are still on ONE baseline, which is how
        // LHDN prints them: --rects puts both on tt 802.
        const growth = (expected.length - O.employerRules) * O.rowPitch;
        const phone = items.find((i) => i.text === fullForm.employer.phone);
        const date = items.find((i) => /^\d{2}\/\d{2}\/\d{4}$/.test(i.text) && i.x < 200);
        expect(phone, 'the telephone number left the page').toBeDefined();
        expect(phone!.tt, 'the telephone row did not follow the box down').toBeCloseTo(723 + growth, 2);
        if (date) expect(date.tt, 'the date came off the telephone’s row').toBeCloseTo(phone!.tt, 2);

        // …and everything is still on the paper. pdf-lib does not clip.
        for (const i of items) {
          expect(i.tt, `"${i.text}" is drawn below the page floor`).toBeLessThanOrEqual(EA_FORM.bottom);
        }
        expect(new Set(items.map((i) => i.page)).size, 'the growth spilled onto a second page').toBe(1);
      },
    );

    /**
     * THE FLOOR, AT AN ADDRESS LONG ENOUGH TO EXHAUST THE PAPER.
     *
     * The box may only grow until its bottom edge would cross `EA_FORM.bottom`. Past that the leftover
     * is joined onto the last rule and shrink-to-fit applies again — but clamped at `O.minSize`, so the
     * failure mode is an OVERPRINT somebody queries rather than a 2 pt line nobody can see. That is
     * r205's Borang A trade taken deliberately, and `minSize` is not round two's to lower.
     */
    it('an address longer than the page can hold stops at the floor instead of vanishing', async () => {
      const absurd = Array.from({ length: 24 }, (_, i) => `Bangunan Tabung Amanah Pekerja Bersatu Blok ${i} Aras Lapan Belas`);
      const items = await drawnSized(
        await renderEaPdf({ ...fullForm, employer: { ...fullForm.employer, name: 'Koperasi', address: absurd } }, labels),
      );
      // The cap, re-derived from the page rather than read off the renderer: however many rules fit
      // between the ungrown box's foot and `bottom`. At the cap the telephone sits one row lower still,
      // so naming the rows keeps it out of the set.
      const maxRules = O.employerRules + Math.floor((EA_FORM.bottom - O.t1) / O.rowPitch);
      const rows = Array.from({ length: maxRules }, (_, k) => 689 + k * O.rowPitch);
      const onRules = items.filter(
        (i) => Math.abs(i.x - writeX) < 0.5 && rows.some((tt) => Math.abs(i.tt - tt) < 0.5),
      );
      expect(onRules.length, 'the box did not grow past the agency’s two rules at all').toBeGreaterThan(2);
      expect(onRules.length, 'the box grew past the page floor').toBeLessThanOrEqual(maxRules);
      for (const run of onRules) {
        expect(run.size, `"${run.text.slice(0, 40)}…" was set at ${run.size}pt`).toBeGreaterThanOrEqual(O.minSize);
      }
      // The whole block is still printed: a truncated address reads as a complete one, which is the
      // failure this renderer refuses for captions (r219) and refuses here for values.
      expect(onRules.map((i) => i.text).join(' ')).toContain('Blok 23 Aras Lapan Belas');
      // …and the box's own foot is still on the paper.
      const phone = items.find((i) => i.text === fullForm.employer.phone);
      expect(phone!.tt, 'the telephone row was pushed off the page').toBeLessThanOrEqual(EA_FORM.bottom);
    });

    /**
     * THE FLOOR COVERS THE THREE SINGLE-VALUE ROWS TOO, AND THEY CANNOT WRAP TO MEET IT.
     *
     * Name of Officer, Designation and Employer's Telephone No. are one value on one rule with no
     * continuation, so the box cannot grow for them: past 8 pt they shrink, and at `O.minSize` they
     * overprint instead of shrinking further. Smaller exposure than the employer block (one field each
     * rather than four concatenated) and the SAME defect class, which is the only thing that matters on
     * a form somebody signs and files.
     *
     * ⚠️ AND `fitSize`'s 1 pt CLAMP WAS NEVER EVEN BUYING A FIT. Measured on HEAD, a 599-character
     * designation was set at 1.0 pt AND still ran 288 pt over a 269 pt rule — illegible and out of its
     * box at the same time. The clamp is not a floor, it is the absence of one; it just stops dividing.
     */
    it.each([
      ['officerName' as const, 655],
      ['officerPosition' as const, 672],
      ['phone' as const, 723],
    ])('a very long %s is never set below the floor', async (field, tt) => {
      // ~600 characters: far past anything real, and past the point where even 1 pt would fit.
      const absurd = Array(6).fill('Senior General Manager, Group Human Resources, Corporate Services and Statutory Compliance Division').join('; ');
      const items = await drawnSized(
        await renderEaPdf({ ...fullForm, employer: { ...fullForm.employer, [field]: absurd } }, labels),
      );
      const run = items.find((i) => Math.abs(i.x - writeX) < 0.5 && Math.abs(i.tt - tt) < 0.5);
      expect(run, `nothing was drawn on the ${field} rule`).toBeDefined();
      expect(run!.text, 'the value was truncated rather than printed').toBe(absurd);
      expect(run!.size, `${field} was set at ${run!.size}pt`).toBeGreaterThanOrEqual(O.minSize);
      // …and an ordinary value is untouched by the floor: it still sets at a full 8 pt.
      const ordinary = await drawnSized(await renderEaPdf(fullForm, labels));
      const plain = ordinary.find((i) => Math.abs(i.x - writeX) < 0.5 && Math.abs(i.tt - tt) < 0.5);
      expect(plain!.size, `an ordinary ${field} stopped printing at full size`).toBe(8);
    });

    /**
     * THE AMENDED MARKER FOLLOWS THE BOX. It draws at `EA_FORM.footStripT` (742), which is only 11.4 pt
     * below the UNGROWN box — so a grown box would print straight through it, and pdf-lib does not clip.
     * This is the case that will matter most to round two (item 795c470c), which drops this box 99 pt.
     */
    it('the amended marker is never drawn inside the officer box', async () => {
      const long: EaPdfData = {
        ...fullForm,
        employer: { ...fullForm.employer, name: LONG_NAME, address: LONG_ADDRESS },
        overrides: [{ field: 'partB.bonus', original: 0, amended: 5000, reason: 'HR correction' }],
      };
      const items = await drawnSized(await renderEaPdf(long, labels));
      const marker = items.find((i) => i.text === labels.amendedNote);
      expect(marker, 'the amended marker is not on the document').toBeDefined();
      const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
      const growth = (wrapAt8([LONG_NAME, ...LONG_ADDRESS].join(', '), font).length - O.employerRules) * O.rowPitch;
      // On page 0 it must clear the box's own bottom edge; the renderer may also have moved it to a new
      // page, which is the existing overflow path and equally not-inside-the-box.
      if (marker!.page === 0) expect(marker!.tt).toBeGreaterThan(O.t1 + growth);
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
    //
    // ⚠️ r367 (item fda53352, round A) — THE EIS ASSERTION IS REWORDED, AND ITS OLD MESSAGE IS QUOTED
    // BELOW BECAUSE IT NAMED A CLAIM THAT HAS BEEN REVERSED. It read `${locale}: the EIS figure is back
    // on the printed form` and looked for `RM 118.80`, the fixture's EIS leg ON ITS OWN LINE. The EIS
    // figure IS on the printed form now — inside Section E(2)'s sum, which is the box LHDN's caption
    // gives it (sources on `EaPdfData.partE`). What must still not appear is a LINE OF OURS carrying the
    // leg by itself, which is what the removed strip drew, so the assertion now says that: the bare leg
    // is absent, and the sum 297 + 118.80 + 43.45 = RM 459.25 is present. Both halves matter — the first
    // stops the strip returning, the second stops E(2) silently narrowing back to one leg.
    expect(items.find((it) => it.text === winAnsi(real.amendedNote))?.page, `${locale}: the amended marker`).toBe(0);
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
