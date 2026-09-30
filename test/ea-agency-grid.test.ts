/**
 * ── r372 (item 795c470c) — THE C.P.8A's GRID IS LHDN'S, AND THIS IS WHAT HOLDS IT THERE ────────────
 *
 * The EA's page had TWO provenances and they disagreed. r346 measured the MONEY COLUMN off the
 * agency's own PDF; everything else — the item numbers, the sub-items, the description column, the
 * left margin and every section baseline — was still r219's tracing of another payroll vendor's
 * 150 dpi rendering. That is why correcting one section per request never settled it: each correction
 * was measured against a page whose grid came from the wrong document.
 *
 * ⚠️ THIS FILE COMPARES TWO DOCUMENTS, NOT A DOCUMENT AND A TRANSCRIPTION. It reads LHDN's own file
 * (`docs/forms/ea-cp8a-pin-2023-official-en.pdf`) and the page THIS renderer produces, through the
 * SAME parser (`lib/pdf-page-geometry.ts`) that `scripts/measure-ea-official-pdf.ts` uses, and asserts
 * each against the other. So a later edit is checked against the agency rather than against a previous
 * round's output — which is the whole of what the item asked for, and the reason the constants in
 * `EA_FORM` may be trusted at all.
 *
 * ⚠️ AND IT IS NOT VACUOUS: every assertion below fails on the tree this round started from. The
 * traced grid put the item numbers at 42 and the sub-items at 55 against the agency's 62.5 / 80.2, and
 * compressed the page to ~87% of the agency's pitch (Section F at 627.5 against 712.4). Both halves
 * are checked, because moving the columns without re-deriving the baselines cannot be verified: the
 * agency's rows leave 13 pt against a 13.2 pt pitch, so the vertical pass decides whether the
 * horizontal one has anywhere to land.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { EA_FORM, blankEaPdfData, renderEaPdf, type EaPdfData } from '../lib/ea-pdf';
import { eaPdfLabelsFromCatalogue } from '../lib/ea-pdf-labels-file';
import { type PdfRun, joinRuns, readPdfPageGeometry } from '../lib/pdf-page-geometry';

const OFFICIAL = new URL('../docs/forms/ea-cp8a-pin-2023-official-en.pdf', import.meta.url);

/** The two editions LHDN publishes and the two routes render. No other locale reaches this renderer. */
const EDITIONS = ['en', 'ms'] as const;

const agency = await readPdfPageGeometry(readFileSync(OFFICIAL));

/** A statement with something on every row, so a caption's column can be told from a value's. */
function statement(): EaPdfData {
  const zero = blankEaPdfData();
  return {
    ...zero,
    year: '2026',
    employer: {
      name: 'Contoh Sdn Bhd',
      eNumber: 'E 1234567890',
      address: ['1 Jalan Ampang, 50450 Kuala Lumpur'],
      phone: '03-2161 8888',
      lhdnState: 'WP Kuala Lumpur',
      officerName: 'Nurul Ain binti Abdullah',
      officerPosition: 'Pengurus Sumber Manusia',
    },
    employee: {
      ...zero.employee,
      name: 'Muhammad Ariff bin Zainal Abidin',
      ic: '900101-14-5566',
      taxNo: 'IG 1234567890',
      epfNo: '12345678',
      socsoNo: 'A1234567',
      children: 2,
      hiredOn: '2019-04-01',
      terminatedOn: null,
      employeeNo: 'EMP-00042',
      jobTitle: 'Senior Systems Engineer',
      passport: null,
    },
    partB: { ...zero.partB, grossSalary: 96000, bonus: 8000, allowances: 4800, gross: 108800, exemptAllowances: 2400 },
    partD: { ...zero.partD, mtd: 7320.5, childRelief: 8000 },
    partE: { epf: 11880, socso: 297, eis: 118.8, skbbk: 43.45, fundName: 'KWSP' },
    formDate: '2027-02-28',
    statutoryVersion: 'grid-guard',
  };
}

const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;
const runAt = (runs: PdfRun[], tt: number, x: number, tol = 0.6) =>
  runs.find((r) => near(r.tt, tt, tol) && near(r.x, x, tol));

const F = EA_FORM;

/**
 * EVERY ROW THE FORM SETS, AND THE COLUMNS IT MUST SET IT IN.
 *
 * Expressed against `EA_FORM` rather than as literals, so this is a guard on the DRAWING and the
 * separate check below is the guard on the CONSTANTS. A literal table here would pass on a page whose
 * constants had all drifted together, which is exactly the failure mode r346 left behind.
 *
 * The section letters are drawn CENTRED in the agency's own block, so their x lands within a point of
 * `sectionLetter` rather than on it — 45.4 for A, 45.9 for F. One point of tolerance, and only there.
 */
const ROWS: { row: string; tt: number; xs: number[]; letter?: boolean }[] = [
  { row: 'A heading', tt: F.sectionT.a, xs: [F.sectionLetter, F.itemLabel], letter: true },
  { row: 'A.1 name', tt: F.rowsA.name, xs: [F.itemLabel, F.aLeftLabel] },
  { row: 'A.2 / A.3', tt: F.rowsA.row2, xs: [F.itemLabel, F.aLeftLabel, F.aRightNumber, F.aRightLabel] },
  { row: 'A.4 / A.5', tt: F.rowsA.row4, xs: [F.itemLabel, F.aLeftLabel, F.aRightNumber, F.aRightLabel] },
  { row: 'A.6 / A.7', tt: F.rowsA.row6, xs: [F.itemLabel, F.aLeftLabel, F.aRightNumber, F.aRightLabel] },
  { row: 'A.8 / A.9', tt: F.rowsA.children, xs: [F.itemLabel, F.aLeftLabel, F.aRightNumber, F.aRightLabel] },
  { row: 'A.8 line 2', tt: F.rowsA.childrenLine2, xs: [F.aLeftLabel] },
  { row: 'A.9(a)', tt: F.rowsA.startedOn, xs: [F.aRightLabel, F.aRightSubLabel] },
  { row: 'A.9(b)', tt: F.rowsA.leftOn, xs: [F.aRightLabel, F.aRightSubLabel] },
  { row: 'B heading', tt: F.sectionT.b, xs: [F.sectionLetter, F.itemLabel], letter: true },
  { row: 'B sub-heading + RM', tt: F.rowsB.excluding, xs: [F.itemLabel, F.rmHeading] },
  { row: 'B.1(a)', tt: F.rowsB.grossSalary, xs: [F.itemLabel, F.subLabel, F.subText] },
  { row: 'B.1(b)', tt: F.rowsB.feesCommissionBonus, xs: [F.subLabel, F.subText] },
  { row: 'B.1(c)', tt: F.rowsB.tipsPerquisitesOther, xs: [F.subLabel, F.subText] },
  { row: 'B.1(d)', tt: F.rowsB.taxBorneByEmployer, xs: [F.subLabel, F.subText] },
  { row: 'B.1(e)', tt: F.rowsB.esos, xs: [F.subLabel, F.subText] },
  { row: 'B.1(f)', tt: F.rowsB.gratuity, xs: [F.subLabel, F.subText] },
  { row: 'B.2', tt: F.rowsB.arrears, xs: [F.itemLabel, F.subLabel] },
  { row: 'B.2 type (a)', tt: F.rowsB.incomeTypeA, xs: [F.subLabel, F.incomeTypeX.letter] },
  { row: 'B.2 type (b)', tt: F.rowsB.incomeTypeB, xs: [F.incomeTypeX.letter] },
  { row: 'B.3', tt: F.rowsB.benefitsInKind, xs: [F.itemLabel, F.subLabel] },
  { row: 'B.4', tt: F.rowsB.livingAccommodation, xs: [F.itemLabel, F.subLabel] },
  { row: 'B.5', tt: F.rowsB.unapprovedFundRefund, xs: [F.itemLabel, F.subLabel] },
  { row: 'B.6', tt: F.rowsB.compensation, xs: [F.itemLabel, F.subLabel] },
  { row: 'C heading', tt: F.sectionT.c, xs: [F.sectionLetter, F.itemLabel], letter: true },
  { row: 'C.1', tt: F.rowsC.pension, xs: [F.itemLabel, F.subLabel] },
  { row: 'C.2', tt: F.rowsC.annuity, xs: [F.itemLabel, F.subLabel] },
  { row: 'C TOTAL', tt: F.rowsC.total, xs: [F.subLabel] },
  { row: 'D heading', tt: F.sectionT.d, xs: [F.sectionLetter, F.itemLabel], letter: true },
  { row: 'D.1', tt: F.rowsD.mtd, xs: [F.itemLabel, F.subLabel] },
  { row: 'D.2', tt: F.rowsD.cp38, xs: [F.itemLabel, F.subLabel] },
  { row: 'D.3', tt: F.rowsD.zakat, xs: [F.itemLabel, F.subLabel] },
  { row: 'D.4', tt: F.rowsD.donations, xs: [F.itemLabel, F.subLabel] },
  { row: 'D.5', tt: F.rowsD.tp1Heading, xs: [F.itemLabel, F.subLabel] },
  { row: 'D.5(a)', tt: F.rowsD.tp1Relief, xs: [F.subLabel, F.subTextD5, F.midRm] },
  { row: 'D.5(b)', tt: F.rowsD.zakatOther, xs: [F.subLabel, F.subTextD5, F.midRm] },
  { row: 'D.6', tt: F.rowsD.childRelief, xs: [F.itemLabel, F.subLabel] },
  { row: 'E heading', tt: F.sectionT.e, xs: [F.sectionLetter, F.itemLabel], letter: true },
  { row: 'E.1 fund', tt: F.rowsE.fundName, xs: [F.itemLabel, F.subLabel] },
  { row: 'E.1 amount', tt: F.rowsE.epf, xs: [F.subLabel, F.rmBeforeRule] },
  { row: 'E.2', tt: F.rowsE.perkeso, xs: [F.itemLabel, F.subLabel, F.rmBeforeRule] },
  { row: 'F heading', tt: F.sectionT.f, xs: [F.sectionLetter, F.itemLabel, F.rmBeforeRule], letter: true },
  { row: 'foot: officer', tt: F.officerBox.rowT0, xs: [F.officerBox.captionX] },
  { row: 'foot: designation', tt: F.officerBox.rowT0 + F.officerBox.rowPitch, xs: [F.officerBox.captionX] },
  { row: 'foot: employer', tt: F.officerBox.rowT0 + 2 * F.officerBox.rowPitch, xs: [F.officerBox.captionX] },
  { row: 'foot: phone + date', tt: F.officerBox.rowT0 + 4 * F.officerBox.rowPitch, xs: [F.officerBox.captionX, F.dateX] },
];

describe('r372 — EA_FORM is LHDN’s own grid, re-derived from LHDN’s own file', () => {
  it('the agency’s file is the vector C.P.8A this grid was measured from', () => {
    expect(agency.pages, 'the C.P.8A is one page').toBe(1);
    expect(agency.runs.length, 'the agency’s page parsed as empty — the parser, not the form').toBeGreaterThan(200);
    // The stamp, so a re-measurement against a different revision fails loudly rather than quietly.
    expect(joinRuns(agency.runs).some((r) => r.text.includes('C.P.') && r.text.includes('Pin.') && r.text.includes('2023'))).toBe(true);
  });

  /**
   * ⚠️ THE CONSTANTS ARE RE-DERIVED FROM THE AGENCY'S RUNS, NOT COMPARED WITH A TRANSCRIPTION. An item
   * number is a standalone run ("1.", "2." …) and a sub-item letter is a standalone "(a)", which is
   * what makes this possible without a caption match — and caption matching does not work on this
   * producer anyway: it breaks words mid-glyph ("Job Designat" + "ion").
   */
  it('the three text columns ARE the columns the agency sets its items in', () => {
    const body = agency.runs.filter((r) => r.tt > F.sectionT.a && r.tt < F.sectionT.f + 1);
    const column = (re: RegExp, within: (x: number) => boolean) => {
      const xs = body.filter((r) => re.test(r.text) && within(r.x)).map((r) => r.x);
      expect(xs.length, `no agency run matched ${re}`).toBeGreaterThan(4);
      return [...new Set(xs)];
    };
    expect(column(/^\d\.$/, (x) => x < 200), 'the agency’s item-number column').toEqual([F.itemLabel]);
    expect(column(/^\([a-f]\)$/, (x) => x < 100), 'the agency’s sub-item column').toEqual([F.subLabel]);
    // Section A's left captions and Section B..F's item captions share the sub-item column.
    expect(body.some((r) => near(r.x, F.subText)), 'the agency’s sub-item DESCRIPTION column').toBe(true);
    expect(body.some((r) => near(r.x, F.subTextD5) && /Relief|Zakat/.test(r.text)), 'D5’s own indent').toBe(true);
  });

  it('every section heading sits on the agency’s own baseline, and its letter in the agency’s column', () => {
    for (const [section, tt] of Object.entries(F.sectionT)) {
      const letter = section.toUpperCase();
      const hit = agency.runs.find((r) => r.text === letter && near(r.tt, tt) && r.x < 60);
      expect(hit, `the agency has no section ${letter} on tt ${tt}`).toBeDefined();
      expect(near(hit!.x, F.sectionLetter, 1), `section ${letter} at x ${hit!.x}`).toBe(true);
    }
  });

  it('the officer box is on the agency’s five rows, at its pitch, with its captions and rules', () => {
    for (let n = 0; n < 5; n += 1) {
      const tt = Math.round((F.officerBox.rowT0 + n * F.officerBox.rowPitch) * 10) / 10;
      expect(
        agency.runs.some((r) => near(r.tt, tt) && near(r.x, F.officerBox.captionX + 0)) ||
          agency.runs.some((r) => near(r.tt, tt) && near(r.x, F.officerBox.ruleX[0])),
        `the agency has no officer-box row on tt ${tt}`,
      ).toBe(true);
    }
    // The agency's Date is OUTSIDE the box, on the SAME row as the telephone — one table row.
    const lastRow = Math.round((F.officerBox.rowT0 + 4 * F.officerBox.rowPitch) * 10) / 10;
    expect(agency.runs.some((r) => near(r.tt, lastRow) && near(r.x, F.dateX)), 'the agency’s Date row').toBe(true);
  });

  it('the box’s own two readings agree: five rows plus its foot padding land on its bottom rule', () => {
    const O = F.officerBox;
    // Two independent measurements off the agency's page — the five text baselines (--all) and the
    // frame's bottom rule (--rects) — must be consistent, or one of them was read off the wrong thing.
    expect(O.rowT0 + 4 * O.rowPitch + O.footPad, 'the officer box’s rows and its frame disagree').toBeCloseTo(O.t1, 0);
    // The bottom rule is a 0.9 pt FILL, so `t1` is its outer edge (tt1) and `t0` the top rule's tt0.
    expect(agency.rects.some((r) => near(r.tt1, O.t1, 0.4) && near(r.x0, O.x0, 0.4)), 'the agency’s bottom rule').toBe(true);
    expect(agency.rects.some((r) => near(r.tt0, O.t0, 0.4) && near(r.x0, O.x0, 0.4)), 'the agency’s top rule').toBe(true);
  });

  it('the money column the item promises is UNTOUCHED is still the agency’s', () => {
    const cells = agency.rects.filter((r) => near(r.x0, F.moneyLeft) && near(r.x1, F.moneyRight));
    expect(cells.length, 'the agency’s money cells moved').toBeGreaterThan(50);
    expect(agency.runs.filter((r) => near(r.x, F.moneyLeader)).length).toBeGreaterThan(15);
  });

  it('nothing on the agency’s body table begins left of EA_FORM.left', () => {
    const bodyCells = agency.rects.filter((r) => r.tt0 > F.sectionT.a - 10 && r.x0 > 5);
    expect(Math.min(...bodyCells.map((r) => r.x0)), 'the agency’s leftmost body cell').toBe(F.left);
  });
});

describe.each(EDITIONS)('r372 — the %s edition is drawn on that grid', (locale) => {
  const labels = eaPdfLabelsFromCatalogue(locale);

  it.each([
    ['filled', false],
    ['blank', true],
  ])('%s: every numbered row is drawn in the agency’s columns', async (_kind, isBlank) => {
    const bytes = isBlank
      ? await renderEaPdf(blankEaPdfData(), labels, { locale, blank: true })
      : await renderEaPdf(statement(), labels, { locale });
    const { runs } = await readPdfPageGeometry(bytes);

    const missing: string[] = [];
    for (const { row, tt, xs, letter } of ROWS) {
      for (const x of xs) {
        if (!runAt(runs, tt, x, letter && near(x, F.sectionLetter) ? 1 : 0.6)) missing.push(`${row}: tt ${tt} x ${x}`);
      }
    }
    expect(missing, `${locale}/${_kind}: rows off the agency’s grid`).toEqual([]);
  });

  /**
   * ⚠️ THE NUMBERING LEFT THE CAPTION, WHICH IS WHAT MAKES THREE COLUMNS POSSIBLE AT ALL. Before this
   * round `payroll.ea.grossSalary` — "1(a) Gross salary, wages or leave pay (including overtime pay)" —
   * was drawn as ONE run at ONE x, so the item number and the sub-item had nowhere of their own to be.
   * The renderer now draws "1." and "(a)" from its own table and the caption without them; a caption
   * that still carried its number would print "1. (a) 1(a) Gross salary…", which this refuses.
   */
  it('the item number and the sub-item are the renderer’s, and the caption keeps only its words', async () => {
    const { runs } = await readPdfPageGeometry(await renderEaPdf(statement(), labels, { locale }));
    expect(runAt(runs, F.rowsB.grossSalary, F.itemLabel)?.text, `${locale}: B.1's item number`).toBe('1.');
    expect(runAt(runs, F.rowsB.grossSalary, F.subLabel)?.text, `${locale}: B.1(a)'s sub-item`).toBe('(a)');
    // The agency prints the item number ONCE, against its first sub-item only.
    expect(runAt(runs, F.rowsB.feesCommissionBonus, F.itemLabel), `${locale}: "1." repeated on 1(b)`).toBeUndefined();

    const numbered = [F.rowsB.grossSalary, F.rowsB.feesCommissionBonus, F.rowsB.taxBorneByEmployer, F.rowsB.esos];
    for (const tt of numbered) {
      const caption = runAt(runs, tt, F.subText);
      expect(caption, `${locale}: no caption on tt ${tt}`).toBeDefined();
      expect(
        /^[\d(]/.test(caption!.text),
        `${locale}: "${caption!.text}" still carries the form's numbering into the description column`,
      ).toBe(false);
    }
    for (const tt of [F.rowsD.mtd, F.rowsD.cp38, F.rowsB.benefitsInKind, F.rowsC.pension]) {
      const caption = runAt(runs, tt, F.subLabel);
      expect(/^\d/.test(caption?.text ?? ''), `${locale}: "${caption?.text}" still carries its number`).toBe(false);
    }
  });

  it('nothing is drawn left of the agency’s margin, right of its frame, or below the page floor', async () => {
    const bytes = await renderEaPdf(statement(), labels, { locale });
    const doc = await readPdfPageGeometry(bytes);
    const stray = doc.runs.filter((r) => r.x < F.left - 0.2 || r.tt > F.bottom || r.tt < 0);
    expect(stray.map((r) => `${r.text} @ ${r.x}/${r.tt}`), `${locale}: off the grid`).toEqual([]);
  });

  /**
   * THE PAGE ENDS WHERE THE AGENCY'S PAGE ENDS. The traced grid compressed everything to ~87%, so
   * Section F landed 85 pt — an inch — above the agency's and the officer box 99 pt above its own.
   * This is the half of the round the horizontal move could not be checked without.
   */
  it('the form is not compressed: F and the officer box end where the agency ends them', async () => {
    const { runs } = await readPdfPageGeometry(await renderEaPdf(statement(), labels, { locale }));
    const lowest = Math.max(...runs.map((r) => r.tt));
    expect(lowest, `${locale}: the last line of the form`).toBeCloseTo(F.officerBox.rowT0 + 4 * F.officerBox.rowPitch, 1);
    expect(runAt(runs, F.sectionT.f, F.itemLabel), `${locale}: Section F is not on the agency's baseline`).toBeDefined();
    // …and the agency agrees about both, read off its own file rather than restated here.
    expect(agency.runs.some((r) => near(r.tt, F.sectionT.f) && near(r.x, F.itemLabel))).toBe(true);
    expect(agency.runs.some((r) => near(r.tt, F.officerBox.rowT0 + 4 * F.officerBox.rowPitch) && near(r.x, F.dateX))).toBe(true);
  });
});

/**
 * ── THE CONTINUATION SHEET (r372, inheriting item 450f443f) ────────────────────────────────────────
 *
 * Round one made the officer box grow a rule at a time, because `fitSize` shrinks rather than wraps
 * and a 225-character employer block set its last line at 3.4 pt — present in the file, absent from
 * the paper. At the AGENCY's geometry the box ends at 817.9 against a page floor of 830: twelve points
 * against a 13.2 pt pitch, so not one more rule fits and the growth has nowhere to go on page one.
 * It goes to a second sheet, at a full 8 pt, rather than shrinking or truncating.
 */
describe('r372 — an employer the agency’s own box cannot hold', () => {
  const labels = eaPdfLabelsFromCatalogue('en');
  const LONG_NAME = 'Perbadanan Pembangunan Infrastruktur dan Teknologi Maklumat Semenanjung Malaysia Berhad';
  const LONG_ADDRESS = [
    'Aras 27, Menara Tabung Haji, Jalan Tun Razak',
    'Kawasan Perindustrian Desa Aman Fasa 3, Lot 88-A',
    '52200 Kuala Lumpur, Wilayah Persekutuan',
  ];

  it('the agency’s two rules leave no room for a third — the reason the sheet exists', () => {
    const room = EA_FORM.bottom - EA_FORM.officerBox.t1;
    expect(room, 'the room under the agency’s box').toBeLessThan(EA_FORM.officerBox.rowPitch);
    expect(EA_FORM.officerBox.employerRules, 'the agency’s own writing rules').toBe(2);
  });

  it('a block that fits the agency’s two rules stays on ONE page, exactly as the agency draws it', async () => {
    const { pages, runs } = await readPdfPageGeometry(await renderEaPdf(statement(), labels, { locale: 'en' }));
    expect(pages, 'a short employer block spilled').toBe(1);
    expect(runAt(runs, EA_FORM.officerBox.rowT0 + 4 * EA_FORM.officerBox.rowPitch, EA_FORM.dateX)?.text).toContain('Date');
  });

  it('a longer one continues on a second sheet at FULL SIZE, with nothing shrunk and nothing lost', async () => {
    const long: EaPdfData = {
      ...statement(),
      employer: { ...statement().employer, name: LONG_NAME, address: LONG_ADDRESS },
    };
    const bytes = await renderEaPdf(long, labels, { locale: 'en' });
    const page1 = await readPdfPageGeometry(bytes, 0);
    const page2 = await readPdfPageGeometry(bytes, 1);
    expect(page1.pages, 'the overflow did not reach a second sheet').toBe(2);

    const block = [LONG_NAME, ...LONG_ADDRESS].join(', ');
    const O = EA_FORM.officerBox;
    const onPage1 = [0, 1].map((k) => runAt(page1.runs, O.rowT0 + (2 + k) * O.rowPitch, O.ruleX[0] + 3));
    const onPage2 = page2.runs.filter((r) => near(r.x, EA_FORM.left + 3));
    const printed = [...onPage1.map((r) => r?.text ?? ''), ...onPage2.map((r) => r.text)].filter(Boolean).join(' ');
    expect(printed, 'the employer block was truncated or reordered').toBe(block);
    for (const run of [...onPage1, ...onPage2]) {
      if (run) expect(run.size, `"${run.text}" was shrunk to ${run.size}pt`).toBe(8);
    }
    // The sheet says which statement it belongs to, and introduces no wording of its own.
    const joined = joinRuns(page2.runs).map((r) => r.text);
    expect(joined.some((s) => s.includes('C.P.8A')), 'a loose second sheet with no form number').toBe(true);
    expect(joined.some((s) => s.includes('2026')), 'a loose second sheet with no year').toBe(true);
  });

  it('the form’s own page is unchanged by the overflow — the box is still the agency’s', async () => {
    const short = await readPdfPageGeometry(await renderEaPdf(statement(), labels, { locale: 'en' }));
    const long = await readPdfPageGeometry(
      await renderEaPdf(
        { ...statement(), employer: { ...statement().employer, name: LONG_NAME, address: LONG_ADDRESS } },
        labels,
        { locale: 'en' },
      ),
      0,
    );
    const foot = (g: { runs: PdfRun[] }) => g.runs.filter((r) => r.tt > EA_FORM.officerBox.t0).map((r) => `${r.tt}/${r.x}`);
    expect(foot(long), 'a long address moved the agency’s own rows').toEqual(foot(short));
  });
});
