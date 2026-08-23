/**
 * r219 (feedback ece6d75d) — THE EA IS NOW THE C.P.8A (Pin. 2024) PAGE, AND THESE ARE THE CLAIMS THAT
 * MAKES THAT HAVE TO KEEP BEING TRUE.
 *
 * The arrangement itself is pinned where it can be: `docs/forms/ea-cp8a-pin-2024-specimen.png` is the
 * blank form, `docs/forms/ea-cp8a-pin-2024-transcription.txt` is every caption on it, and the
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
import { EA_FORM, EA_FORM_WORDS, renderEaPdf, type EaPdfData, type EaPdfLabels } from '../lib/ea-pdf';

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
    'contributionAmount', 'eisSip', 'sectionFExemptAllowances', 'title',
  ] as const;
  const bundle = Object.fromEntries(keys.map((k) => [k, L(k)])) as unknown as EaPdfLabels;
  bundle.disclaimer = interp(L('disclaimer'), { year: '2026', version: '2026.3' });
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
  partE: { epf: 7810, socso: 297, eis: 118.8, fundName: 'KWSP' },
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
  (await drawn(await renderEaPdf(d, bundleFor(locale)))).map((i) => i.text);

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
  it('a person employed for the whole year gets neither date — and both captions with empty rules', async () => {
    const printed = await textsOf({ ...BASE, employee: { ...BASE.employee, hiredOn: '2019-05-06', terminatedOn: null } });
    expect(printed).not.toContain('06/05/2019');
    expect(printed.some((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s)), 'no date at all on the form').toBe(false);
    // The blank form prints these captions whether or not there is anything to write beside them.
    const ms = bundleFor('ms');
    expect(printed).toContain(ms.partYearNote);
    expect(printed).toContain(ms.startedOn);
    expect(printed).toContain(ms.leftOn);
  });

  it('a person hired INSIDE the tax year gets 9(a) only', async () => {
    const printed = await textsOf({ ...BASE, employee: { ...BASE.employee, hiredOn: '2026-03-01', terminatedOn: null } });
    expect(printed).toContain('01/03/2026');
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['01/03/2026']);
  });

  it('a long-serving LEAVER gets 9(b) only — the half a single-case test would miss', async () => {
    const printed = await textsOf({
      ...BASE,
      employee: { ...BASE.employee, hiredOn: '2019-05-06', terminatedOn: '2026-11-30' },
    });
    expect(printed).toContain('30/11/2026');
    expect(printed).not.toContain('06/05/2019');
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['30/11/2026']);
  });

  it('a person who both joined and left inside the year gets both', async () => {
    const printed = await textsOf({
      ...BASE,
      employee: { ...BASE.employee, hiredOn: '2026-03-01', terminatedOn: '2026-11-30' },
    });
    expect(printed.filter((s) => /^\d{2}\/\d{2}\/\d{4}$/.test(s))).toEqual(['01/03/2026', '30/11/2026']);
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
    for (const w of [
      EA_FORM_WORDS.formNo,
      EA_FORM_WORDS.serialNo,
      EA_FORM_WORDS.employerTin,
      EA_FORM_WORDS.masthead1,
      EA_FORM_WORDS.masthead2,
      EA_FORM_WORDS.masthead3,
      EA_FORM_WORDS.privateStatement,
      EA_FORM_WORDS.ea,
      EA_FORM_WORDS.employeeTin,
      EA_FORM_WORDS.lhdnState,
      EA_FORM_WORDS.banner,
    ]) {
      expect(printed, `${locale}: ${w}`).toContain(w);
    }
    // The masthead's fourth line carries the YEAR of assessment, which the blank form leaves open.
    expect(printed).toContain(`${EA_FORM_WORDS.masthead4} 2026`);
    // …and the values that belong in those boxes.
    expect(printed).toContain('E1234567890'); // TIN Majikan E
    expect(printed).toContain('SG12345678090'); // the employee's own TIN, under the "EA"
    expect(printed).toContain('W.P. Kuala Lumpur'); // LHDNM Negeri
  });

  it('the agency’s words are the SAME in both languages — they are not translated', async () => {
    const ms = await textsOf(BASE, 'ms');
    const en = await textsOf(BASE, 'en');
    for (const [key, w] of Object.entries(EA_FORM_WORDS)) {
      // masthead4 is the one line that is COMPLETED rather than merely printed: the blank form leaves the
      // year of assessment open and we fill it in, so it reaches the page as "… 31 DISEMBER 2026".
      const match = (drawnStrings: string[]) =>
        key === 'masthead4' ? drawnStrings.some((s) => s.startsWith(w)) : drawnStrings.includes(w);
      expect(match(ms), `ms: ${w}`).toBe(true);
      expect(match(en), `en: ${w}`).toBe(true);
    }
  });
});

describe('r219 — the foot: the officer box, and the agency’s own spelling of its caption', () => {
  it('carries the officer, the employer and the telephone number, and an empty rule where there is none', async () => {
    const printed = await textsOf(BASE);
    expect(printed).toContain('Nurul Aina binti Hamzah');
    expect(printed).toContain('Human Resource Manager');
    expect(printed).toContain('ISEDECOR BINA SDN BHD');
    expect(printed).toContain('No. 12, Jalan Raja Chulan, 50200 Kuala Lumpur, Wilayah Persekutuan');
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
   * ⚠️ "Name Pegawai", NOT "Nama Pegawai". That is how the specimen spells it, and the caption is
   * reproduced as the agency's form has it rather than silently corrected. This case exists so that a
   * later reader who spots the typo finds a test telling them it was READ, not mistyped — and so that
   * "fixing" it fails here rather than shipping a form that no longer matches the page it was traced
   * from. The transcription carries the same warning.
   */
  it('the officer caption keeps the specimen’s own spelling, and the transcription says why', async () => {
    expect(EA_FORM_WORDS.officerName).toBe('Name Pegawai');
    expect(await textsOf(BASE)).toContain('Name Pegawai');
    const transcription = read('docs/forms/ea-cp8a-pin-2024-transcription.txt');
    expect(transcription).toContain('Name Pegawai');
    expect(transcription).toMatch(/spelled that way ON THE SPECIMEN/);
    // The renderer says so too, next to the constant.
    expect(read('lib/ea-pdf.ts')).toMatch(/Malay would be "Nama"/);
  });

  it('Tarikh is an empty rule — the signing date is the employer’s to write, not ours to invent', () => {
    const src = read('lib/ea-pdf.ts');
    expect(src).toContain('put(W.date, L + 6, 723, 8)');
    expect(src).toMatch(/valueOrRule\('', 68, 150, 723, 8\);/);
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
    expect(printed).toContain('7,500.00'); // 1(c) = allowances 6,000 + tips/perquisites 1,500
    // …and neither half is ALSO printed on its own, which would double the money on the page.
    expect(printed.filter((s) => s === '5,000.00')).toEqual([]);
    expect(printed.filter((s) => s === '4,000.00')).toEqual(['4,000.00']); // D6 child relief only
    expect(printed.filter((s) => s === '6,000.00')).toEqual([]);
    expect(printed.filter((s) => s === '1,500.00')).toEqual(['1,500.00']); // B6 compensation only
  });

  it('EIS is printed BELOW the form, not inside Section E, because the C.P.8A has no EIS box', async () => {
    const items = await drawn(await renderEaPdf(BASE, bundleFor('ms')));
    const eis = items.find((i) => i.text === 'RM 118.80');
    expect(eis, 'the EIS figure must still be printed').toBeTruthy();
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
    const form = src.slice(src.indexOf('const W = EA_FORM_WORDS;'), src.indexOf('let y: number = EA_FORM.footStripT'));
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
    const ms = bundleFor('ms');
    for (const caption of [ms.gratuity, ms.esos, ms.compensation, ms.pension, ms.annuity, ms.childRelief]) {
      expect(printed, caption).toContain(caption);
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
 * docs/forms/ea-cp8a-pin-2024-transcription.txt — the hand transcription of the specimen. The numbering
 * prefix is ours (the form prints the number in its own column), so it is stripped before the check;
 * everything after it is the agency's and must match. A caption cannot be reworded without the
 * transcription being changed too, and the transcription cannot be changed without reading the image.
 */
describe('r219 — every Malay box caption is the agency’s own, checked against the transcription', () => {
  const TRANSCRIPTION = read('docs/forms/ea-cp8a-pin-2024-transcription.txt');
  const ms = JSON.parse(read('messages/ms.json')).payroll.ea as Record<string, string>;

  /** The keys whose value IS an agency caption. Anything not here is ours and may be worded freely. */
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
    'compensationLossOfEmployment',
    'pension',
    'annuity',
    'mtd',
    'cp38',
    'zakat',
    'donations',
    'tp1ClaimHeading',
    'tp1Relief',
    'zakatOther',
    'childRelief',
  ].filter((k) => typeof ms[k] === 'string');

  /** Strip OUR numbering prefix — "1(b) ", "5(a) ", "4. " — and keep the agency's own words. */
  const caption = (v: string) => v.replace(/^\d+(\([a-z]\))?[.)]?\s+/, '').trim();

  it('appears verbatim in the transcription of the specimen', () => {
    expect(AGENCY_CAPTIONS.length).toBeGreaterThan(15);
    const missing = AGENCY_CAPTIONS.filter((k) => !TRANSCRIPTION.includes(caption(ms[k])));
    expect(missing, `these Malay captions are not in docs/forms/ea-cp8a-pin-2024-transcription.txt: ${missing.map((k) => `${k}=${JSON.stringify(ms[k])}`).join(', ')}`).toEqual([]);
  });

  it('D.5(a) is the form’s own one-word caption — the case this guard exists for', () => {
    expect(ms.tp1Relief).toBe('5(a) Pelepasan');
    expect(TRANSCRIPTION).toContain('(a) Pelepasan');
    // …and NOT the r217 wording it carried into this round.
    expect(ms.tp1Relief).not.toMatch(/dituntut melalui/);
  });
});
