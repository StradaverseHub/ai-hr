/**
 * r219 (feedback ece6d75d) — THE EA IS NOW THE C.P.8A (Pin. 2024) PAGE, AND THESE ARE THE CLAIMS THAT
 * MAKES THAT HAVE TO KEEP BEING TRUE.
 *
 * The arrangement itself is pinned where it can be: `docs/forms/ea-cp8a-pin-2024-specimen.png` is the
 * blank form, `docs/forms/ea-cp8a-pin-2023-transcription.txt` is every caption on it, and the
 * coordinates live in `EA_FORM`. What a test can hold is (a) that the agency's own words reach the page
 * in BOTH languages, (b) that item 9 obeys the form's own condition rather than the presence of a date,
 * (c) that the boxes the form does NOT have stay off it, and (d) that the foot's officer box is fed and
 * carries the agency's own spelling.
 *
 * Read this beside test/ea-form-boxes-contract.test.ts (every EA field reaches every surface) and
 * test/ea-pdf.test.ts (the whole form is ONE page in every locale). Neither of those can see any of the
 * below: a form drawn to the wrong arrangement is still one page with every box on it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  EA_FORM,
  EA_FORM_NUMBERING,
  EA_FORM_WORDS,
  eaCaptionWords,
  eaFormWords,
  renderEaPdf,
  type EaPdfData,
  type EaPdfLabels,
} from '../lib/ea-pdf';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Every string the renderer actually drew, with its page. Same technique as test/ea-pdf.test.ts. */
async function drawn(bytes: Uint8Array): Promise<{ text: string; x: number; y: number; page: number }[]> {
  const doc = await PDFDocument.load(bytes);
  const out: { text: string; x: number; y: number; page: number }[] = [];
  doc.getPages().forEach((page, index) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray ? contents.asArray().map((ref) => page.node.context.lookup(ref)) : [contents];
    let raw = '';
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) raw += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    for (const m of raw.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)) {
      out.push({ x: Number(m[1]), y: Number(m[2]), page: index, text: Buffer.from(m[3], 'hex').toString('latin1') });
    }
  });
  return out;
}

const interp = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);

/** The label bundle EXACTLY as app/me/ea/[employmentId]/pdf/route.ts builds it, minus next-intl. */
function bundleFor(locale: 'en' | 'ms'): EaPdfLabels {
  const msgs = JSON.parse(read(`messages/${locale}.json`));
  const ea = msgs.payroll.ea as Record<string, string> & { override: Record<string, string> };
  const L = (k: string) => {
    const v = ea[k];
    if (typeof v !== 'string') throw new Error(`messages/${locale}.json is missing payroll.ea.${k}`);
    return v;
  };
  const keys = [
    'sectionAEmployeeParticulars', 'name', 'jobTitle', 'employeeNo', 'icNo', 'passportNo', 'epfNo', 'socsoNo',
    'childrenTaxRelief', 'partYearNote', 'startedOn', 'leftOn', 'sectionBEmploymentIncome', 'sectionBExcluding',
    'grossSalary', 'feesCommissionBonus', 'tipsPerquisitesOther', 'paymentDetail', 'stateWhat', 'addressCue',
    'taxBorneByEmployer', 'esos', 'gratuity', 'periodFrom', 'periodTo', 'incomeType', 'arrears', 'benefitsInKind',
    'livingAccommodation', 'unapprovedFundRefund', 'compensation', 'sectionCPensionOther', 'pension', 'annuity',
    'formTotal', 'sectionDTotalDeductions', 'monthlyTaxDeduction', 'cp38Deductions', 'zakatViaSalary', 'donations',
    'tp1ClaimHeading', 'tp1Relief', 'zakatOther', 'childRelief', 'sectionEContributions', 'fundName',
    'contributionAmount', 'sectionFExemptAllowances', 'title',
  ] as const;
  const bundle = Object.fromEntries(keys.map((k) => [k, L(k)])) as unknown as EaPdfLabels;
  bundle.amendedNote = ea.override.amendedNote;
  return bundle;
}

const BASE: EaPdfData = {
  year: '2026',
  employer: {
    name: 'ISEDECOR BINA SDN BHD',
    eNumber: 'E1234567890',
    address: ['No. 12, Jalan Raja Chulan', '50200 Kuala Lumpur, Wilayah Persekutuan'],
    phone: '03-2000 1234',
    lhdnState: 'W.P. Kuala Lumpur',
    officerName: 'Nurul Aina binti Hamzah',
    officerPosition: 'Human Resource Manager',
  },
  employee: {
    name: 'Aisyah Rahman',
    ic: '900101015555',
    taxNo: 'SG12345678090',
    epfNo: 'EPF0012345',
    socsoNo: 'SOC0012345',
    category: 1,
    children: 2,
    hiredOn: '2019-05-06',
    terminatedOn: null,
    employeeNo: 'EMP-0001',
    jobTitle: 'Site Supervisor',
    passport: 'A12345678',
  },
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
  partD: { mtd: 4200, cp38: 600, zakat: 240, tp1Relief: 5200, donations: 350, zakatOther: 800, childRelief: 4000 },
  // ⚠️ r367 — three non-zero, mutually distinct PERKESO legs; E(2) prints their sum, 459.25.
  partE: { epf: 7810, socso: 297, eis: 118.8, skbbk: 43.45, fundName: 'KWSP' },
  // r367 — Tarikh is filled now (it was an unconditional empty rule when r219 wrote this fixture).
  formDate: '2027-02-15',
  statutoryVersion: '2026.3',
  overrides: [],
};

/** Everything payroll cannot source left unset, and every employer box empty. */
const EMPTY: EaPdfData = {
  ...BASE,
  employer: {
    name: 'ISEDECOR BINA SDN BHD',
    eNumber: null,
    address: [],
    phone: null,
    lhdnState: null,
    officerName: null,
    officerPosition: null,
  },
  partB: {
    grossSalary: 60000, bonus: 5000, allowances: 6000, gross: 71000, exemptAllowances: 0,
    directorFee: 0, tipsPerquisites: 0, taxBorneByEmployer: 0, esos: 0, gratuity: 0, arrears: 0,
    benefitsInKind: 0, livingAccommodation: 0, unapprovedFundRefund: 0, compensation: 0,
  },
  partC: { pension: 0, annuity: 0, total: 0 },
  partD: { mtd: 4200, cp38: 0, zakat: 0, tp1Relief: 0, donations: 0, zakatOther: 0, childRelief: 0 },
};

const textsOf = async (d: EaPdfData, locale: 'en' | 'ms' = 'ms') =>
  // r346 — the furniture follows the DOCUMENT's language, so the render is given the same locale its
  // label bundle is for. Without it a Malay-captioned form is drawn with English furniture, which is a
  // page no route produces.
  (await drawn(await renderEaPdf(d, bundleFor(locale), { locale }))).map((i) => i.text);

describe('r219 — item 9 is conditional on the YEAR, not on a date existing', () => {
  /**
   * ⚠️ THIS IS THE DEFECT THE ROUND WAS RAISED ON, AND IT LOOKED COMPLETELY NORMAL.
   *
   * The form says "Jika bekerja tidak genap setahun, nyatakan:" — state these only if the employment did
   * not run the whole year. The renderer printed `hiredOn → terminatedOn` whenever either date existed,
   * so a person hired in 2019 carried "6 May 2019" on their 2026 EA, which reads as a statement that
   * their employment began during that year of assessment.
   *
   * Each half is decided on ITS OWN date, which is what the four cases below are for: a leaver hired
   * years ago must show a leaving date and NO commencement date, and the previous rule gets that wrong
   * in the one direction a single-case test would miss.
   */
  /**
   * ⚠️ r367 (item fda53352, round A) — THE FOUR CASES BELOW STILL PIN ITEM 9's CONDITION EXACTLY, BUT THE
   * EXACT-SET ASSERTIONS HAD TO GROW ONE MEMBER, AND THE CLAIM THEY MADE IS QUOTED WHERE IT CHANGED.
   *
   * They collect EVERY dd/mm/yyyy string on the drawn page, which was the right way to catch item 9
   * printing a date it should not — while the page carried no other date at all. The foot's "Tarikh" is
   * filled now (r219's empty rule reversed at the reporter's instruction), so every one of these pages
   * carries exactly one more date than it did. It is named in each set rather than filtered out: a
   * filtered assertion would stop noticing if the FOOT's date disappeared.
   *
   * `BASE.formDate` is '2027-02-15', so the foot prints 15/02/2027 on all four.
   */
  const FOOT = '15/02/2027';

  it('a person employed for the whole year gets neither date — only the foot’s Tarikh', async () => {
    const printed = await textsOf({ ...BASE, employee: { ...BASE.employee, hiredOn: '2019-05-06', terminatedOn: null } });
    expect(printed).not.toContain('06/05/2019');
    // ⚠️ THIS ASSERTED `'no date at all on the form'` → false UNTIL r367. Item 9 still prints neither date;
    // the only date on the page is the one the employer signs under.
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s)), 'item 9 printed a date it should not').toEqual([
      FOOT,
    ]);
    // The blank form prints these captions whether or not there is anything to write beside them.
    const ms = bundleFor('ms');
    expect(printed).toContain(ms.partYearNote);
    expect(printed).toContain(ms.startedOn);
    expect(printed).toContain(ms.leftOn);
  });

  it('a person hired INSIDE the tax year gets 9(a) only', async () => {
    const printed = await textsOf({ ...BASE, employee: { ...BASE.employee, hiredOn: '2026-03-01', terminatedOn: null } });
    expect(printed).toContain('01/03/2026');
    // r367 — `['01/03/2026']` until the foot's Tarikh started printing.
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['01/03/2026', FOOT]);
  });

  it('a long-serving LEAVER gets 9(b) only — the half a single-case test would miss', async () => {
    const printed = await textsOf({
      ...BASE,
      employee: { ...BASE.employee, hiredOn: '2019-05-06', terminatedOn: '2026-11-30' },
    });
    expect(printed).toContain('30/11/2026');
    expect(printed).not.toContain('06/05/2019');
    // r367 — `['30/11/2026']` until the foot's Tarikh started printing.
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['30/11/2026', FOOT]);
  });

  it('a person who both joined and left inside the year gets both', async () => {
    const printed = await textsOf({
      ...BASE,
      employee: { ...BASE.employee, hiredOn: '2026-03-01', terminatedOn: '2026-11-30' },
    });
    // r367 — `['01/03/2026', '30/11/2026']` until the foot's Tarikh started printing.
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['01/03/2026', '30/11/2026', FOOT]);
  });

  it('the rule is the YEAR, in the source, not "a date is present"', () => {
    const src = read('lib/ea-pdf.ts');
    expect(src).toMatch(/const inYear = \(iso: string \| null\) => \(iso && iso\.slice\(0, 4\) === d\.year \? formDate\(iso\) : ''\);/);
    expect(src).toContain('inYear(d.employee.hiredOn)');
    expect(src).toContain('inYear(d.employee.terminatedOn)');
  });
});

describe('r219 — the agency’s own page furniture reaches the paper, in both languages', () => {
  it.each(['ms', 'en'] as const)('%s: the masthead, the banner and the header boxes are drawn', async (locale) => {
    const printed = await textsOf(BASE, locale);
    // r346 — THIS EDITION's words, not one edition's words on both pages. See the reversal recorded on
    // the case below.
    const W = eaFormWords(locale);
    for (const w of [
      W.formNo,
      W.serialNo,
      W.employerTin,
      W.masthead1,
      W.masthead2,
      W.masthead3,
      W.privateStatement,
      W.ea,
      W.employeeTin,
      W.lhdnState,
      W.banner,
    ]) {
      expect(printed, `${locale}: ${w}`).toContain(w);
    }
    // The masthead's fourth line carries the YEAR of assessment, which the blank form leaves open.
    expect(printed).toContain(`${W.masthead4} 2026`);
    // …and the values that belong in those boxes.
    expect(printed).toContain('E1234567890'); // TIN Majikan E
    expect(printed).toContain('SG12345678090'); // the employee's own TIN, under the "EA"
    expect(printed).toContain('W.P. Kuala Lumpur'); // LHDNM Negeri
  });

  /**
   * ⚠️ THIS CASE USED TO ASSERT THE OPPOSITE, AND IT WAS WRONG (r346, item fda53352).
   *
   * It read "the agency's words are the SAME in both languages — they are not translated", and pinned
   * the Malay masthead, banner and officer box onto the ENGLISH form too. The rationale was that "the
   * viewer's language never changes a Malaysian tax form".
   *
   * LHDN CONTRADICTS IT BY PUBLISHING BOTH. `docs/forms/ea-cp8a-pin-2023-official-en.pdf` — fetched from
   * hasil.gov.my and byte-identical to the reporter's attachment — has an ENGLISH masthead: "Serial No.",
   * "Employer's No. E", "LHDNM State", "THIS FORM EA MUST BE PREPARED AND PROVIDED TO THE EMPLOYEE FOR
   * INCOME TAX PURPOSE", "Name of Officer". We were not preserving the agency's page; we were printing
   * the Malay edition's furniture around English captions, which is a document the agency does not issue.
   *
   * What the old case was RIGHT about is kept below: neither edition is translated by us. Each is read
   * off the agency's own file for that language.
   */
  it('each edition prints ITS OWN agency words, and neither is translated by us', async () => {
    const ms = await textsOf(BASE, 'ms');
    const en = await textsOf(BASE, 'en');
    for (const [locale, printed] of [
      ['ms', ms],
      ['en', en],
    ] as const) {
      const W = eaFormWords(locale);
      for (const [key, w] of Object.entries(W)) {
        if (w === '') continue; // privateStatement2 — a line the Malay edition does not use
        // masthead4 is COMPLETED rather than merely printed: the year of assessment is filled in.
        const hit = key === 'masthead4' ? printed.some((t) => t.startsWith(w)) : printed.includes(w);
        expect(hit, `${locale}: ${w}`).toBe(true);
      }
    }
    // …and the two editions really are different pages, not the same one twice.
    expect(ms).toContain('CUKAI PENDAPATAN');
    expect(en).toContain('INCOME TAX');
    expect(en, 'the Malay masthead must not appear on the English form').not.toContain('CUKAI PENDAPATAN');
    expect(ms, 'nor the English on the Malay').not.toContain('INCOME TAX');
  });
});

describe('r219 — the foot: the officer box, and the agency’s own spelling of its caption', () => {
  it('carries the officer, the employer and the telephone number, and an empty rule where there is none', async () => {
    const printed = await textsOf(BASE);
    expect(printed).toContain('Nurul Aina binti Hamzah');
    expect(printed).toContain('Human Resource Manager');
    /**
     * ⚠️ r353 — RE-POINTED, NOT LOOSENED: THE NAME AND ADDRESS ARE ONE BLOCK OVER TWO RULES NOW.
     *
     * This used to assert the employer's name as one whole run and the joined address as another, because
     * that is what was drawn — the name alone on the first rule and the ENTIRE address squeezed onto the
     * second by `fitSize`, which shrinks instead of wrapping and is floored at 1 pt (a four-part address
     * printed at about 6 pt). The agency's box gives "Name and Address of Employer" two writing lines
     * (measured: `scripts/measure-ea-official-pdf.ts --rects`, rows at tt 766.2 and 779.4), so the block
     * is greedy-wrapped across both and neither run is any one field.
     *
     * What the case is FOR is unchanged and is asserted more strictly than before: every word of the
     * employer's name and address reaches the page, and nothing is dropped in the wrap.
     */
    const block = printed.join(' ');
    for (const part of ['ISEDECOR BINA SDN BHD', 'No. 12, Jalan Raja Chulan', '50200 Kuala Lumpur, Wilayah Persekutuan']) {
      expect(block, `${part} is missing from the officer box`).toContain(part);
    }
    expect(printed).toContain('03-2000 1234');

    // An employer with none of it on file prints the blank form's rules and NOTHING ELSE — no placeholder,
    // no "—", no plausible-looking guess (AGENTS 28). The captions still print, because the form has them.
    const bare = await textsOf(EMPTY);
    expect(bare).toContain(EA_FORM_WORDS.officerName);
    expect(bare).toContain(EA_FORM_WORDS.employerPhone);
    expect(bare).not.toContain('Nurul Aina binti Hamzah');
    expect(bare).not.toContain('03-2000 1234');
    expect(bare.filter((s) => s === '—' || s === '-' || s === 'N/A')).toEqual([]);
  });

  /**
   * ⚠️ THIS CASE USED TO PIN A TYPO, AND DEFENDED IT IN DETAIL (reversed in r346).
   *
   * It asserted `officerName === 'Name Pegawai'` and explained that this "is how the specimen spells it",
   * so that anyone "fixing" it would fail here rather than "shipping a form that no longer matches the
   * page it was traced from". Every word of that was true — and the page it was traced from was another
   * payroll vendor's rendering (item ece6d75d, Producer "Developer Express Inc. DXperience v23.2.5"),
   * not LHDN's form. The typo was THEIRS.
   *
   * LHDN's own Bahasa Malaysia file (`docs/forms/ea-cp8a-pin-2023-official-bm.xlsx`, docProps
   * Company=LHDNM) carries the shared string "Nama Pegawai". A faithful transcription of the wrong
   * source is still the wrong words, and a guard that pins it makes the error permanent.
   */
  it('the officer caption is the agency’s own “Nama Pegawai”', async () => {
    expect(eaFormWords('ms').officerName).toBe('Nama Pegawai');
    expect(await textsOf(BASE)).toContain('Nama Pegawai');
    expect(await textsOf(BASE, 'en'), 'and the English edition says what the English form says').toContain(
      'Name of Officer',
    );
    const transcription = read('docs/forms/ea-cp8a-pin-2023-transcription.txt');
    expect(transcription).toContain('Nama Pegawai');
    // The correction is RECORDED, not silently applied — the next reader must find out why it moved.
    expect(transcription).toMatch(/THIS NOTE USED TO DEFEND A TYPO/);
  });

  /**
   * ⚠️ r367 (item fda53352, round A) — THIS CASE PINNED THE DECISION THE REPORTER HAS NOW REVERSED, SO IT
   * IS UPDATED RATHER THAN DELETED (CLAUDE.md §8).
   *
   * ⚠️ ITS OLD TITLE AND CLAIM, QUOTED: "Tarikh is an empty rule — the signing date is the employer's to
   * write, not ours to invent", asserting `valueOrRule('', 68, 150, 723, 8);` verbatim. The reporter has
   * now told us what to write in that box, so we write it.
   *
   * THE RULE IS THEIRS, NOT THE AGENCY'S. `MIN(today in Kuala Lumpur, 28 February of the year after the EA
   * year)`. **No published LHDN date for this box is sourced in this repository or in the committed agency
   * files** — docs/forms/ea-cp8a-pin-2023-official-en.pdf carries the box and no deadline — so it is not
   * presented as a statutory deadline anywhere, and test/statutory-forms-page.test.ts still leaves Form E's
   * deadline unset for the reason it always did.
   *
   * WHAT THIS CASE PINS NOW: the box's POSITION is untouched (round A moves no coordinates), the value is
   * taken from `EaPdfData` rather than read off a clock inside the renderer, and an absent value still
   * prints the agency's empty rule. The rule's ARITHMETIC is pinned against an injected clock in
   * test/r367-ea-form-date.test.ts, where it can be tested without rendering a PDF.
   *
   * ⚠️ r372 (item 450f443f) — THE TWO SOURCE-TEXT ASSERTIONS ARE NOW MEASUREMENTS ON A RENDERED FORM,
   * AND THE CASE IS STRICTLY STRONGER FOR IT. They read, verbatim:
   *
   *     expect(src, 'the caption moved — round A changes no coordinates').toContain('put(W.date, L + 6, 723, 8)');
   *     expect(src).toMatch(/valueOrRule\(formDate\(d\.formDate\), 68, 150, 723, 8\);/);
   *
   * The intent was "round A moves no coordinates", and it was pinned by grepping for the literal 723 in
   * the renderer's source. r372 grows the officer box downwards when the employer's name and address
   * need more than the agency's two writing lines, and LHDN prints the Date on the SAME table row as
   * the Telephone No. — `scripts/measure-ea-official-pdf.ts --rects`, tt 802, the date at x 45.2 and the
   * telephone rule at 331.5 — so the date rides down with that row rather than floating above the box's
   * new foot. The literal is therefore gone from the source and the baseline is computed.
   *
   * WHAT REPLACES IT IS THE CLAIM ITSELF, measured on the page: the caption and its rule are drawn on
   * the same baseline as the telephone number, outside the box, where the agency prints them. A source
   * grep could not have told the difference between that and a coincidence; this can.
   *
   * ⚠️ AND THE SENTENCE THAT STOOD HERE PROMISED SOMETHING IT COULD NOT DELIVER (retired in r372):
   * "…drawn at EXACTLY tt 723 … and it survives round two re-pitching the box (item 795c470c)". A
   * hard-coded 723 does not survive a re-pitch; it fails it, which is the honest outcome but not the
   * promised one. The baselines below are derived from the box's own two constants instead.
   */
  it('Tarikh is filled from the statement’s own formDate, at the position r219 put it', async () => {
    const src = read('lib/ea-pdf.ts');
    const items = await drawn(await renderEaPdf(BASE, bundleFor('ms'), { locale: 'ms' }));
    const H = 841.89; // A4, and the renderer's own `at()` is H - tt.
    const tt = (y: number) => Math.round((H - y) * 100) / 100;
    const caption = items.find((i) => i.text === EA_FORM_WORDS.date);
    const value = items.find((i) => i.text === '15/02/2027');
    const phone = items.find((i) => i.text === BASE.employer.phone);
    expect(caption, 'the Tarikh caption is not on the page').toBeDefined();
    expect(value, 'the foot carries no date').toBeDefined();
    expect(phone, 'the telephone number is not on the page').toBeDefined();
    /**
     * ⚠️ r372 — THE NUMBERS THIS PINNED WERE r219's AND THEY WERE THE TRACING's. Quoted, because this
     * case's own prose claimed the opposite ("it survives round two re-pitching the box") and that
     * claim was wrong:
     *
     *     expect(caption!.x).toBeCloseTo(EA_FORM.left + 6, 2);
     *     expect(value!.x).toBeCloseTo(71, 2);
     *     expect(tt(caption!.y)).toBeCloseTo(723, 2);
     *
     * LHDN puts its Date at x 45.2 on tt 802, on the SAME table row as its Telephone No. rule at
     * 331.5. r219 put ours at `left + 6` on 723, off a 150 dpi tracing of another vendor's page, and
     * 723 is 79 pt above the agency's row. The RELATIONSHIP r367 cared about — the date and the
     * telephone on one baseline, the date OUTSIDE the box — is the agency's own and is what is pinned
     * now, against `EA_FORM` rather than against a literal, so the next re-pitch really does carry it.
     */
    const O = EA_FORM.officerBox;
    const footRow = Math.round((O.rowT0 + 4 * O.rowPitch) * 10) / 10;
    expect(caption!.x, 'the Tarikh caption left the agency’s own column').toBeCloseTo(EA_FORM.dateX, 2);
    expect(value!.x, 'the date is written before its own caption').toBeGreaterThan(caption!.x);
    expect(value!.x, 'the date ran past the agency’s rule').toBeLessThan(EA_FORM.dateRule[1]);
    expect(tt(caption!.y), 'the Tarikh caption left the agency’s last row').toBeCloseTo(footRow, 1);
    expect(tt(value!.y), 'the date left the agency’s last row').toBeCloseTo(footRow, 1);
    expect(caption!.x, 'the date moved INSIDE the officer box — the agency prints it outside').toBeLessThan(O.x0);
    // …and it is the agency's own arrangement that keeps them together: LHDN's Date and Telephone No.
    // share one table row, so a change that moves one and not the other is the defect to catch.
    expect(tt(phone!.y), 'the date and the telephone number came off the same row').toBeCloseTo(tt(value!.y), 2);
    // The renderer must not read a clock: that is what keeps every EA test time-independent.
    // Comment-proof: the renderer's own prose NAMES `todayInKualaLumpur` (to say where the value comes
    // from), so the check is on the IMPORTS — a pure renderer cannot read a clock it never imported, and
    // `new Date()` is the other way in.
    expect(src, 'lib/ea-pdf.ts imported the clock').not.toMatch(/^import .*hr-date.*$/m);
    const body = src.slice(src.indexOf('export async function renderEaPdf'));
    expect(body, 'the renderer constructs a Date').not.toMatch(/new Date\(/);
    expect(body, 'the renderer calls Date.now').not.toMatch(/Date\.now\(/);
  });

  it('a statement with no formDate still prints the agency’s empty rule', async () => {
    // r219's real invariant, kept: the blank C.P.8A and any caller with nothing to date get the form's own
    // rule and no invented date. `blankEaPdfData()` sets formDate: null.
    const dated = await textsOf(BASE);
    expect(dated, 'the filled form must carry its date').toContain('15/02/2027');
    const undated = await textsOf({ ...BASE, formDate: null });
    expect(undated.some((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x)), 'an undated statement printed a date').toBe(false);
  });
});

describe('r219 — the boxes the C.P.8A does not have stay OFF the drawn page', () => {
  /**
   * `mtdCategory` has no box on the official form. r209's lesson (AGENTS 28) is that ADDING a box can
   * make a form worse than the gap it filled, and inventing a position for a box the agency does not
   * print is the same failure one step earlier. It is still on the HTML statement, where it is ours to
   * lay out however we like.
   */
  it('the MTD category has no box, so nothing on the form can print it', async () => {
    const src = read('lib/ea-pdf.ts');
    const labels = src.slice(src.indexOf('export type EaPdfLabels = {'), src.indexOf('const A4:'));
    expect(labels).not.toMatch(/^ {2}mtdCategory\??:/m);
    expect(labels).not.toMatch(/^ {2}category[123]\??:/m);
    // …and the renderer never reads the figure either, so there is nothing for a later edit to place.
    expect(src).not.toContain('d.employee.category');
    // The HTML statement still has it — this is a decision about the FORM, not about the vocabulary.
    expect(read('app/payroll/reports/ea/[employmentId]/page.tsx')).toContain("t('mtdCategory')");

    // And it is absent from the drawn page in both languages: the MTD category of this fixture is 1, and
    // no bare "1" is drawn anywhere a category value could be.
    const printed = await textsOf(BASE, 'en');
    expect(printed.filter((s) => /^Category [123]/.test(s))).toEqual([]);
  });

  it('the form has ONE total, the JUMLAH, and it totals B and C together', async () => {
    const printed = await textsOf(BASE);
    // 91,000 (Part B) + 15,000 (Part C).
    expect(printed).toContain('106,000.00');
    const src = read('lib/ea-pdf.ts');
    expect(src).toContain('derived(d.partB.gross + d.partC.total)');
    // Our own two subtotals are gone from the form — the agency's page has neither.
    const labels = src.slice(src.indexOf('export type EaPdfLabels = {'), src.indexOf('const A4:'));
    expect(labels).not.toMatch(/^ {2}totalGrossRemuneration\??:/m);
    expect(labels).not.toMatch(/^ {2}totalPensionOther\??:/m);
  });

  /**
   * The form's 1(b) and 1(c) are ONE box each over TWO of our figures. Printing only half of either
   * would leave taxable money off the line the agency asks for it on; printing two lines would be a
   * box the C.P.8A does not have.
   */
  it('1(b) and 1(c) each print ONE figure covering both of our boxes', async () => {
    const printed = await textsOf(BASE);
    expect(printed).toContain('9,000.00'); // 1(b) = bonus 5,000 + director's fees 4,000
    // ⚠️ r353 — THE NUMBER DID NOT MOVE AND ITS MEANING DID. `partB.allowances` is now the TAXABLE
    // allowance (localization/my/reports.ts subtracts the exempt portion before this renderer sees it),
    // so 6,000 + 1,500 is still 7,500 — but the 1,200 of exempt money in this fixture is no longer
    // inside that 6,000. The renderer does no exemption arithmetic of its own; the case below is what
    // pins that.
    expect(printed).toContain('7,500.00'); // 1(c) = taxable allowances 6,000 + tips/perquisites 1,500
    // …and neither half is ALSO printed on its own, which would double the money on the page.
    expect(printed.filter((s) => s === '5,000.00')).toEqual([]);
    expect(printed.filter((s) => s === '4,000.00')).toEqual(['4,000.00']); // D6 child relief only
    expect(printed.filter((s) => s === '6,000.00')).toEqual([]);
    expect(printed.filter((s) => s === '1,500.00')).toEqual(['1,500.00']); // B6 compensation only
  });

  /**
   * r353 (item fda53352 point 3) — THE EXEMPT RINGGIT IS PRINTED ONCE, AND 1(c) IS NOT WHERE.
   *
   * Section B's own sub-caption is "(Excluding Tax Exempt Allowances / Perquisites / Gifts / Benefits)"
   * and Section F's title IS the exempt total, so the two boxes are disjoint. Until this round the exempt
   * amount was inside `partB.allowances` AND printed in F, so the same money appeared twice on one page
   * under a caption forbidding one of them.
   *
   * ⚠️ THIS ALSO PINS WHICH FILE OWNS THE SUBTRACTION. The renderer is a pure printer: 1(c) is exactly
   * `allowances + tipsPerquisites`, with no exemption arithmetic. The subtraction belongs in
   * `localization/my/reports.ts`, because `partB.gross` is recomputed there from EA_PART_B_COMPONENTS —
   * a renderer-side subtraction would print a 1(c) that no longer adds up to the JUMLAH above it, and
   * would put `exemptAllowances` back inside Section B's code, which test/r217-ea-sections.test.ts
   * refuses. The amounts here are chosen so each figure is unique on the page.
   */
  it('r353 — the exempt total prints in F only, and the renderer does no exemption arithmetic in 1(c)', async () => {
    const withExempt: EaPdfData = {
      ...BASE,
      partB: { ...BASE.partB, allowances: 1000, tipsPerquisites: 0, exemptAllowances: 6543.21 },
    };
    const printed = await textsOf(withExempt);
    // 1(c) is the figures it is given, untouched: no 7,543.21 (added back) and no -5,543.21 (re-subtracted).
    expect(printed.filter((s) => s === '1,000.00'), '1(c) must print allowances + tips, unaltered').toEqual([
      '1,000.00',
    ]);
    expect(printed).not.toContain('7,543.21');
    // …and the exempt total appears EXACTLY ONCE on the whole page — Section F's line.
    expect(printed.filter((s) => s === '6,543.21'), 'the exempt total is printed once, in Section F').toEqual([
      '6,543.21',
    ]);
  });

  it('r351 — EIS is on NO printed EA, because the reporter had our strip removed', async () => {
    // ⚠️ INVERTED, NOT DELETED. This case used to assert the figure was printed BELOW the form, outside
    // Section E — r219's compromise, because the C.P.8A has no EIS box but the deduction is real money.
    // The reporter wrote "Remove this part from the EA Form" on the shipped page, so the compromise is
    // over and the page ends at the officer box. The cost is recorded in the round entry: the EA is no
    // longer anywhere an employee can read their annual EIS. The HTML statement still shows it.
    const items = await drawn(await renderEaPdf(BASE, bundleFor('ms')));
    const eis = items.find((i) => i.text === 'RM 118.80');
    expect(eis, 'the EIS figure is back on the printed form').toBeUndefined();
    return;
    // In pdf-lib coordinates a LOWER y is further down the page; the officer box's bottom edge is at
    // EA_FORM.officerBox.t1 from the top.
    const officerBoxBottom = 841.89 - EA_FORM.officerBox.t1;
    expect(eis!.y, 'EIS must sit below the officer box, in our own strip').toBeLessThan(officerBoxBottom);
  });
});

describe('r219 — a caption can never overprint its neighbour', () => {
  /**
   * r205's Borang A lesson, and a fixed-geometry form makes it sharper: pdf-lib does NOT clip, so a
   * caption wider than its slot prints straight through whatever is beside it and the page still renders,
   * still returns 200 and still downloads. One renderer serving two languages guarantees the situation —
   * an English caption is routinely wider than its Malay original, and four more locales reach this
   * renderer through test/ea-pdf.test.ts's one-page case.
   *
   * So every LABEL drawn inside the form goes through `putFit`, which shrinks rather than clips. The two
   * exceptions are deliberate and both sit in OUR strip below the officer box, where the full page width
   * is free and there is no neighbour to run into.
   */
  it('every label drawn inside the form goes through the shrink-to-fit path', () => {
    const src = read('lib/ea-pdf.ts');
    /**
     * ⚠️ r372 — THIS GUARD HAD BEEN VACUOUS SINCE r346 AND NOTHING SAID SO. It sliced the renderer
     * between two markers:
     *
     *     src.slice(src.indexOf('const W = EA_FORM_WORDS;'), src.indexOf('let y: number = EA_FORM.footStripT'))
     *
     * r346 split the agency's furniture per edition and the first line became
     * `const W = eaFormWords(opts.locale ?? 'en');`, so `indexOf` returned -1; r351 removed the strip
     * below the form and the second marker went too. `slice(-1, -1)` is the EMPTY STRING, so the
     * matchAll found nothing, the array was empty and the case passed — on no source at all. A guard
     * that greps a slice must assert the slice exists, which is what the two lines below do.
     */
    const from = src.indexOf('const W = eaFormWords(');
    const to = src.indexOf('return doc.save();');
    expect(from, 'the renderer’s drawing section could not be found — this guard reads nothing').toBeGreaterThan(0);
    expect(to, 'the renderer’s end could not be found — this guard reads nothing').toBeGreaterThan(from);
    const form = src.slice(from, to);
    expect(form.length, 'the sliced drawing section is empty').toBeGreaterThan(5000);
    const unbounded = [...form.matchAll(/\bput[RC]?\(t\.[a-zA-Z0-9]+/g)].map((m) => m[0]);
    expect(unbounded, `labels drawn without a width bound: ${unbounded.join(', ')}`).toEqual([]);
    // …and the shrink is a real one: it rounds DOWN so the drawn string stays inside its slot, and it
    // clamps rather than vanishing.
    expect(src).toMatch(/return Math\.max\(1, Math\.floor\(\(size \* maxW \* 10\) \/ w\) \/ 10\);/);
  });
});

describe('r219 — an unsourced box prints the blank form’s rule, never 0.00', () => {
  it('a statement with nothing manual entered prints no 0.00 for any manual box', async () => {
    const printed = await textsOf(EMPTY);
    // Section D's derived boxes legitimately print 0.00 (a zero we can stand behind) — CP38 and zakat are
    // stamped on every payslip. Section F's figure is derived too. So the count of "0.00" is exactly
    // those three, and none of the eleven manual boxes contributes one.
    expect(printed.filter((s) => s === '0.00').length).toBe(3);
    // The captions are all still there: the form prints them whether or not it has a figure.
    //
    // ⚠️ r372 — WHAT REACHES THE PAGE IS THE CAPTION'S WORDS, NOT THE CATALOGUE STRING. The agency sets
    // the item number, the sub-item letter and the words in three separate columns, so the renderer
    // draws "1.", "(f)" and "Ganjaran bagi tempoh" rather than one run reading "1(f) Ganjaran bagi
    // tempoh". `eaCaptionWords` is the renderer's own rule, imported rather than re-implemented here.
    const ms = bundleFor('ms');
    const N = EA_FORM_NUMBERING;
    for (const [caption, n] of [
      [ms.gratuity, N.gratuity],
      [ms.esos, N.esos],
      [ms.compensation, N.compensation],
      [ms.pension, N.pension],
      [ms.annuity, N.annuity],
      [ms.childRelief, N.childRelief],
    ] as const) {
      expect(printed, caption).toContain(eaCaptionWords(caption, n));
      // …and the number really is drawn, separately — otherwise stripping it would be losing it.
      expect(printed, `the form's own number for "${caption}"`).toContain(`${n.item}.`);
    }
  });
});

/**
 * r219 FIX PASS — THE CAPTIONS THEMSELVES, AGAINST THE TRANSCRIPTION IN THIS REPOSITORY.
 *
 * ⚠️ THIS IS THE GUARD THAT WAS MISSING, AND ITS ABSENCE SHIPPED A DEFECT INSIDE THIS SAME ROUND.
 * `EA_FORM_WORDS` pins the Malay FURNITURE the renderer owns, but the box captions live in
 * `messages/ms.json`, and one of them — D.5(a) — kept its r217 wording ("Pelepasan dituntut melalui
 * Borang TP1") while gaining the form's "5(a)" prefix. It then LOOKED like the agency's box while
 * saying something the agency's page does not say, which is worse than an obviously-ours label: a
 * reader checking a C.P.8A against the blank form has no reason to doubt a numbered caption.
 *
 * So every Malay caption the drawn form uses must appear VERBATIM in
 * docs/forms/ea-cp8a-pin-2023-transcription.txt — the hand transcription of the specimen. The numbering
 * prefix is ours (the form prints the number in its own column), so it is stripped before the check;
 * everything after it is the agency's and must match. A caption cannot be reworded without the
 * transcription being changed too, and the transcription cannot be changed without reading the image.
 */
describe('r219 — every Malay box caption is the agency’s own, checked against the transcription', () => {
  const TRANSCRIPTION = read('docs/forms/ea-cp8a-pin-2023-transcription.txt');
  const ms = JSON.parse(read('messages/ms.json')).payroll.ea as Record<string, string>;

  /**
   * The keys whose value IS an agency caption. Anything not here is ours and may be worded freely.
   *
   * ⚠️ r220 FIX — THIS LIST USED TO LIE BY FOUR ENTRIES. It named `compensationLossOfEmployment`,
   * `mtd`, `cp38` and `zakat`, none of which exist under `payroll.ea`; the trailing
   * `.filter((k) => typeof ms[k] === 'string')` dropped them WITHOUT A WORD, and the
   * `toBeGreaterThan(15)` floor was satisfied by the seventeen survivors, so nothing reported the
   * loss. Part B item 6 and the whole top of Section D were drawn on the form with their agency
   * wording unverified while a guard named after them looked green. The keys are now the real ones
   * (`compensation`, `monthlyTaxDeduction`, `cp38Deductions`, `zakatViaSalary`) and the resolution
   * is ASSERTED rather than filtered — a renamed or deleted key fails here instead of vanishing.
   */
  const AGENCY_CAPTIONS = [
    'grossSalary',
    'feesCommissionBonus',
    'tipsPerquisitesOther',
    'taxBorneByEmployer',
    'esos',
    'gratuity',
    'arrears',
    'benefitsInKind',
    'livingAccommodation',
    'unapprovedFundRefund',
    'compensation',
    'pension',
    'annuity',
    'monthlyTaxDeduction',
    'cp38Deductions',
    'zakatViaSalary',
    'donations',
    'tp1ClaimHeading',
    'tp1Relief',
    'zakatOther',
    'childRelief',
  ];

  /** Strip OUR numbering prefix — "1(b) ", "5(a) ", "4. " — and keep the agency's own words. */
  const caption = (v: string) => v.replace(/^\d+(\([a-z]\))?[.)]?\s+/, '').trim();

  it('every key this guard names really is a caption in the Malay bundle', () => {
    // The check that the guard is checking anything at all. A silent `.filter` here is how four of
    // these went unverified for a whole round.
    const unresolved = AGENCY_CAPTIONS.filter((k) => typeof ms[k] !== 'string');
    expect(unresolved, `AGENCY_CAPTIONS names keys that are not in messages/ms.json → payroll.ea: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('appears verbatim in the transcription of the specimen', () => {
    expect(AGENCY_CAPTIONS.length).toBeGreaterThan(15);
    // `?? <<unresolved>>` and not `?? ''`: `includes('')` is true, so a key that stopped resolving
    // would have passed this case too — exactly the way the old `.filter` let four of them through.
    const missing = AGENCY_CAPTIONS.filter((k) => !TRANSCRIPTION.includes(caption(ms[k] ?? `<<unresolved:${k}>>`)));
    expect(missing, `these Malay captions are not in docs/forms/ea-cp8a-pin-2023-transcription.txt: ${missing.map((k) => `${k}=${JSON.stringify(ms[k])}`).join(', ')}`).toEqual([]);
  });

  it('D.5(a) is the form’s own one-word caption — the case this guard exists for', () => {
    // ⚠️ r351 — "5(a)" BECAME "(a)", and the agency's own transcription is why. The reporter red-boxed
    // this exact pair on their comparison: docs/forms/ea-cp8a-pin-2023-transcription.txt:137-138 prints
    // "(a) Pelepasan" and "(b) Zakat selain…" beneath the parent line "5. Jumlah tuntutan potongan…",
    // so repeating the 5 was ours. The guard keeps pinning the caption verbatim; only the value moved.
    expect(ms.tp1Relief).toBe('(a) Pelepasan');
    expect(TRANSCRIPTION).toContain('(a) Pelepasan');
    // …and NOT the r217 wording it carried into this round.
    expect(ms.tp1Relief).not.toMatch(/dituntut melalui/);
  });
});
