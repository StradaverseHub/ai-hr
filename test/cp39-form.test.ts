/**
 * e0cd4583 — CP39 PRINTED FORM (LHDN monthly PCB / MTD statement).
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: the dating rule, the page totals, the two columns that must
 * stay blank, the honesty of the fidelity claim, and the places the statement could quietly stop being
 * the statement. Every one of them fails SILENTLY in production — a CP39 stamped with the wrong month,
 * or whose page totals double-count, or with a guessed country code against somebody's tax reference
 * number, downloads exactly like a correct one and is discovered when a payment is queried.
 *
 * ⚠️ THERE IS NO SPECIMEN AND THEREFORE NO ARITHMETIC FIXTURE. Borang A could assert its totals against
 * a specimen whose 744 + 682 = 1,426.00; we hold no CP39 page at all, filled or blank. So the
 * cross-check here is against the OTHER CP39 output this repo already ships — the e-Data PCB upload file
 * (`localization/my/cp39-file.ts`), whose record counts and cent totals are built by a pure function.
 * Building both from one row set and comparing them is a real second path, not a restatement.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import zlib from 'node:zlib';
import {
  CP39_FORM_HEADER_KEYS,
  CP39_FORM_ROWS_PER_PAGE,
  cp39DeductionPeriodFor,
  cp39FormFilename,
  cp39FormFrom,
  cp39FormTextExport,
  cp39PrintedRows,
  cp39ScheduleScopeNote,
  deductionMonthLabel,
  duplicateCp39TaxNumbers,
  formDate,
  formatMyIc,
  isCp39PeriodKey,
  missingCp39FormHeader,
  missingCp39Preparer,
  money,
  paginateCp39,
  unfinishedCp39Names,
  withPaymentInstrument,
  withPreparer,
  type Cp39FormRow,
} from '../lib/cp39-form';
import {
  CP39_COVER,
  CP39_COVER_HEADING_SIZE,
  CP39_HEADING_SIZE,
  CP39_NOTE_A,
  CP39_NOTE_B,
  CP39_NOTE_B_SABAH,
  CP39_NOTE_B_SARAWAK,
  CP39_NOTE_B_TAIL,
  CP39_NOTE_C,
  CP39_ROW_SIZE,
  CP39_TABLE_COLUMNS,
  renderCp39FormPdf,
} from '../lib/cp39-form-pdf';
// The OTHER CP39 output, imported rather than restated — see the joint assertion below.
import { buildCp39File } from '../localization/my/cp39-file';
// The NEIGHBOURING form's rule, imported rather than restated — the two must never agree.
import { epfContributionPeriodFor } from '../lib/borang-a';
import { MY_REPORTS } from '../localization/my/reports';
import { REGISTERED_ROUTES } from '../lib/permissions';
import en from '../messages/en.json';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Source with its PROSE removed, for the assertions that say "this file must not mention X".
 *
 * These files document exactly what they refuse to do — the model explains that it shares no helper with
 * Borang A, and `shared.ts` explains that `app/` never names `localization/my`. Scanning the raw text
 * would make an honest comment fail the test the comment exists to reinforce. Same stripper
 * test/borang-a.test.ts uses: block comments go, and only WHOLE-LINE `//` comments go, so a URL inside a
 * string survives.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PDF_SRC = read('lib/cp39-form-pdf.ts');
const PREVIEW = read('app/payroll/cp39/preview/page.tsx');
const LIB_CODE = code('lib/cp39-form.ts');
const PDF_CODE = code('lib/cp39-form-pdf.ts');
const READ_CODE = code('localization/my/cp39-form.ts');
const SHARED_CODE = code('app/payroll/cp39/shared.ts');
const PREVIEW_CODE = code('app/payroll/cp39/preview/page.tsx');
const PDF_ROUTE_CODE = code('app/payroll/cp39/pdf/route.ts');
const TEXT_ROUTE_CODE = code('app/payroll/cp39/text/route.ts');
const REPORTS_CODE = code('localization/my/reports.ts');

const row = (p: Partial<Cp39FormRow> & { employmentId: string }): Cp39FormRow => ({
  // '' by default ON PURPOSE: it exercises the identity fallback in `cp39PersonKey`, which is what a
  // caller that predates the field gets. The person-aware cases below pass one explicitly.
  personId: '',
  tin: 'SG23607354000',
  name: 'ANG PEI YEE',
  oldIc: '',
  newIc: '860208105128',
  employeeNo: 'EMP001',
  passport: '',
  countryCode: '',
  pcb: 110.5,
  cp38: 0,
  ...p,
});

const header = (p: Record<string, string> = {}) => ({
  employerNo: 'E0094573909',
  registrationNo: '199801012345',
  employerName: 'ISEDECOR BINA SDN BHD',
  employerAddress: 'Level 12, Menara Satu\n50450 Kuala Lumpur, Wilayah Persekutuan',
  deductionPeriodKey: '2026-01',
  deductionMonth: 'JANUARI',
  deductionMonthNo: '01',
  deductionYear: '2026',
  printedOn: '18/08/2026',
  preparerName: 'CHONG PEI YUH',
  preparerIc: '910416145530',
  preparerPosition: 'ASSISTANT MANAGER',
  preparerPhone: '0123081733',
  ...p,
});

/**
 * 7ee14bbc — THE e-DATA PCB UPLOAD FILE, FROZEN.
 *
 * A GOLDEN RATHER THAN A RESTATEMENT OF THE LAYOUT. "The file did not change" is a claim about BYTES, and
 * a test that rebuilds the expected record from the same field widths the builder uses would move with it
 * — passing for exactly the change it exists to catch. These three lines are the output as it stood
 * BEFORE identity-card formatting was added, captured once. Any drift in a fixed-width field, any dash
 * that leaks in from the printed form's model, any change of record length or line ending fails here.
 *
 * Split per record so a failure names WHICH one moved: `H` is the 57-character header, `D` the two
 * 136-character detail records, and the terminator is CRLF including after the last line.
 */
const CP39_FILE_GOLDEN_NAME = '009457390901_2026.txt';
const CP39_FILE_GOLDEN_HEADER = 'H00945739090094573909202601000001105000001000002500000001';
const CP39_FILE_GOLDEN_DETAIL_1 = 'D23607354000ANG PEI YEE                                                             941128035179              0001105000000000EMP001    ';
const CP39_FILE_GOLDEN_DETAIL_2 = 'D10000000002BETA TWO                                                                860208105128              0000000000025000EMP002    ';
const CP39_FILE_GOLDEN =
  [CP39_FILE_GOLDEN_HEADER, CP39_FILE_GOLDEN_DETAIL_1, CP39_FILE_GOLDEN_DETAIL_2].join('\r\n') + '\r\n';

describe('the deduction month is the payroll month, and never the EPF +1', () => {
  it.each([['2026-01'], ['2026-07'], ['2026-11'], ['2026-12'], ['2027-01']])(
    'a %s payroll produces the same deduction month',
    (payroll) => {
      expect(cp39DeductionPeriodFor(payroll)).toBe(payroll);
    },
  );

  /**
   * THE JOINT ASSERTION. Both rules are imported here rather than restated, so this fails the moment
   * either module acquires the other's — which is the one way this can break without anything looking
   * wrong. December is included deliberately: EPF's rule rolls the YEAR there, so a CP39 that had
   * silently acquired it would be stamped 2027 on a 2026 statement.
   */
  it.each([['2026-01'], ['2026-07'], ['2026-12']])('never agrees with the EPF Borang A rule for %s', (payroll) => {
    expect(cp39DeductionPeriodFor(payroll)).not.toBe(epfContributionPeriodFor(payroll));
    // …and the difference is exactly one month, in the direction EPF documents on its own form.
    expect(epfContributionPeriodFor(cp39DeductionPeriodFor(payroll))).toBe(epfContributionPeriodFor(payroll));
  });

  it('refuses a malformed period rather than stamping nonsense on a tax document', () => {
    for (const bad of ['2026-13', '2026-00', '2026', '', 'not-a-month']) {
      expect(() => cp39DeductionPeriodFor(bad), bad).toThrow(/YYYY-MM/);
    }
    expect(isCp39PeriodKey('2026-01')).toBe(true);
    expect(isCp39PeriodKey('2026-13')).toBe(false);
  });

  it('names the month in Bahasa Malaysia, never in the viewer’s locale', () => {
    // A CP39 is a Malaysian statutory document. Running the month through Intl with the viewer's locale
    // would print a Chinese month name on a Malaysian tax form for a Chinese-language user.
    expect(deductionMonthLabel('2026-01')).toBe('JANUARI');
    expect(deductionMonthLabel('2026-03')).toBe('MAC');
    expect(deductionMonthLabel('2026-08')).toBe('OGOS');
    expect(deductionMonthLabel('2026-12')).toBe('DISEMBER');
    expect(() => deductionMonthLabel('2026-13')).toThrow();
  });
});

describe('pagination, and the totals that must not double-count', () => {
  const rows = (n: number, per: (i: number) => Partial<Cp39FormRow> = () => ({})) =>
    Array.from({ length: n }, (_, i) => row({ employmentId: `e${i}`, name: `PERSON ${i}`, ...per(i) }));

  it.each([
    [1, 26, 1],
    [26, 26, 1],
    [27, 26, 2],
    [7, 3, 3],
  ])('%i rows at %i per page yields %i sheet(s)', (count, perPage, sheets) => {
    const pages = paginateCp39(rows(count), perPage);
    expect(pages).toHaveLength(sheets);
    expect(pages.map((p) => p.sheet)).toEqual(Array.from({ length: sheets }, (_, i) => i + 1));
    expect(new Set(pages.map((p) => p.of))).toEqual(new Set([sheets]));
    // Every row appears on exactly one sheet, in order.
    expect(pages.flatMap((p) => p.rows.map((r) => r.employmentId))).toEqual(rows(count).map((r) => r.employmentId));
  });

  it('yields ONE empty sheet for an empty statement, never zero', () => {
    const pages = paginateCp39([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ sheet: 1, of: 1, rows: [], pagePcb: 0, pageCp38: 0, pageTotal: 0 });
  });

  it.each([
    [1, 26],
    [5, 2],
    [7, 3],
  ])('JUMLAH BESAR is the sum of the page JUMLAHs at %i rows / %i per page', (count, perPage) => {
    const rs = rows(count, (i) => ({ pcb: 100 + i, cp38: i % 2 === 0 ? 25.5 : 0 }));
    const form = cp39FormFrom({ header: header(), rows: rs, perPage });
    const pcbFromPages = form.pages.reduce((a, p) => a + p.pagePcb, 0);
    const cp38FromPages = form.pages.reduce((a, p) => a + p.pageCp38, 0);
    expect(Math.round(pcbFromPages * 100) / 100).toBe(form.totalPcb);
    expect(Math.round(cp38FromPages * 100) / 100).toBe(form.totalCp38);
    expect(form.totalAmount).toBe(Math.round((form.totalPcb + form.totalCp38) * 100) / 100);
    // …and the total is the sum of the ROWS as well, so a page sum cannot be right while the split is wrong.
    expect(form.totalPcb).toBe(Math.round(rs.reduce((a, r) => a + r.pcb, 0) * 100) / 100);
    expect(form.employees).toBe(count);
  });

  it('refuses a page size below one rather than looping forever', () => {
    expect(() => paginateCp39([], 0)).toThrow(/at least 1/);
  });

  it('has a default page size the renderer and the text export both use', () => {
    expect(CP39_FORM_ROWS_PER_PAGE).toBeGreaterThan(1);
    expect(cp39FormFrom({ header: header(), rows: rows(CP39_FORM_ROWS_PER_PAGE) }).pages).toHaveLength(1);
    expect(cp39FormFrom({ header: header(), rows: rows(CP39_FORM_ROWS_PER_PAGE + 1) }).pages).toHaveLength(2);
  });
});

describe('Bilangan Pekerja is TWO counts, and they agree with the e-Data PCB file', () => {
  const rs: Cp39FormRow[] = [
    row({ employmentId: 'a', name: 'ALPHA ONE', tin: 'SG10000000001', pcb: 110.5, cp38: 0 }),
    row({ employmentId: 'b', name: 'BETA TWO', tin: 'SG10000000002', pcb: 0, cp38: 250 }),
    row({ employmentId: 'c', name: 'GAMMA THREE', tin: 'SG10000000003', pcb: 88.25, cp38: 40.75 }),
    row({ employmentId: 'd', name: 'DELTA FOUR', tin: 'SG10000000004', pcb: 0, cp38: 0 }),
  ];

  it('counts a row against a deduction only when that deduction is non-zero', () => {
    const form = cp39FormFrom({ header: header(), rows: rs });
    expect(form.employees).toBe(4);
    expect(form.pcbEmployees).toBe(2);
    expect(form.cp38Employees).toBe(2);
    expect(form.totalPcb).toBe(198.75);
    expect(form.totalCp38).toBe(290.75);
    expect(form.totalAmount).toBe(489.5);
  });

  /**
   * THE SECOND PATH. `buildCp39File` derives its header record counts and cent totals independently,
   * from the same rows, for the file LHDN actually ingests. If the printed statement and the uploaded
   * file ever disagreed about how many people were deducted or how much, one of them would be wrong and
   * nothing else in the product would say so.
   */
  it('reports the same counts and the same cents as the upload file built from the same rows', () => {
    const form = cp39FormFrom({ header: header(), rows: rs });
    const file = buildCp39File({
      employerNo: 'E0094573909',
      year: 2026,
      month: 1,
      rows: rs.map((r) => ({
        tin: r.tin,
        name: r.name,
        newIc: r.newIc,
        mtd: r.pcb,
        cp38: r.cp38,
        employeeNo: r.employeeNo,
      })),
    });
    expect(form.pcbEmployees).toBe(file.totals.mtdRecords);
    expect(form.cp38Employees).toBe(file.totals.cp38Records);
    expect(Math.round(form.totalPcb * 100)).toBe(file.totals.mtdCents);
    expect(Math.round(form.totalCp38 * 100)).toBe(file.totals.cp38Cents);
  });
});

describe('the two columns that used to be unfillable, and the guess still refused', () => {
  /**
   * ⚠️ HALF OF THIS CASE WAS REVERSED BY e4b541c6 (r217) AND HALF OF IT STILL STANDS. Read both before
   * touching it.
   *
   * REVERSED: "there is no old-identity-card column and no code column" was true until migration 0450,
   * which added `old_ic_number` and `passport_issuing_country_code`. The reporter asked for exactly that,
   * so the read now carries both and a row can legitimately print either. The blank-when-absent case
   * below replaces the never-populated one.
   *
   * STILL STANDS, and it is the important half: NOTHING MAY DERIVE THE CODE FROM THE COUNTRY TEXT. The
   * `passport_issuing_country` column is fed from the tenant's NATIONALITY list ("Malaysian"); the CP39
   * wants an ISO-2 ("MY"). A later "improvement" that mapped one to the other would put a WRONG statutory
   * code beside somebody's tax reference and look completely normal on the page. HR picks the code.
   */
  it('leaves both blank when the employee has neither on file, which is the ordinary case', () => {
    const form = cp39FormFrom({
      header: header(),
      // A read that supplies neither — an employee with no old card and no passport code.
      rows: [{ employmentId: 'x', name: 'X', tin: 'SG1', pcb: 1, cp38: 0 }],
    });
    expect(form.pages[0].rows[0].oldIc).toBe('');
    expect(form.pages[0].rows[0].countryCode).toBe('');
  });

  it('prints what the read supplies, now that the columns exist', () => {
    const form = cp39FormFrom({
      header: header(),
      rows: [{ employmentId: 'x', name: 'X', tin: 'SG1', pcb: 1, cp38: 0, oldIc: 'A 1234567', countryCode: 'MY' }],
    });
    expect(form.pages[0].rows[0].oldIc).toBe('A 1234567');
    expect(form.pages[0].rows[0].countryCode).toBe('MY');
  });

  it('the READ takes them from their own columns, and still derives NEITHER from the country text', () => {
    // Source-shape, because the defect would live in the contract BETWEEN the read and the model, where
    // a unit test of either half passes throughout (AGENTS rule 17).
    expect(READ_CODE).toContain('oldIc: employeeStatutoryMy.oldIcNumber');
    expect(READ_CODE).toContain('countryCode: employeeStatutoryMy.passportIssuingCountryCode');
    expect(REPORTS_CODE).toContain("oldIc: x?.oldIc ?? ''");
    expect(REPORTS_CODE).toContain("countryCode: x?.countryCode ?? ''");
    // THE HALF THAT DID NOT CHANGE: the demonym column must not appear on this path at all, so no
    // name→ISO-2 mapping can be smuggled in beside the code that is now stored properly.
    expect(READ_CODE).not.toContain('passportIssuingCountry:');
    expect(READ_CODE).not.toMatch(/passportIssuingCountry\b(?!Code)/);
  });

  /**
   * ⚠️ c99e8358 REVERSED THE OTHER HALF OF THIS CASE, AND THE CASE IS UPDATED RATHER THAN DELETED.
   *
   * The printed note used to read "No. K/P Lama dan Kod Negara dibiarkan kosong: tiada medan kad
   * pengenalan lama dalam rekod pekerja" — a statement in Malay, on a tax document, that stopped being
   * true when migration 0450 gave both columns a home. It is now the opposite claim: both PRINT from the
   * staff record, and blank means the record has none. The surfaces are still pinned, because a blank
   * column with NO explanation is what invites somebody to guess a country code onto a filing.
   */
  it('says on the page and in the text export where the two columns come from', () => {
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a' })] });
    const txt = cp39FormTextExport(form);
    expect(txt).toContain('No. K/P Lama');
    expect(txt).toContain('Kod Negara');
    // The retired half must not survive on ANY printed surface: it is a false claim about a filing.
    expect(PDF_CODE).not.toContain('tiada medan kad pengenalan lama');
    expect(txt).not.toContain('no old-identity-card field exists');
    expect(txt).not.toContain('Columns we cannot fill');
    // …and the half that still governs is stated on both, and on the screen.
    expect(PDF_CODE).toContain('tidak pernah diterbitkan daripada teks kewarganegaraan');
    expect(txt).toContain('NEVER derived');
    expect(PREVIEW_CODE).toContain("t('blankColumnsHint')");
    const ns = (en.payroll as Record<string, unknown>).cp39Form as Record<string, string>;
    expect(ns.blankColumnsHint).toContain('never derived');
    expect(ns.blankColumnsHint).not.toContain('there is no old identity card field');
  });
});

describe('the header, the preparer block and the gates', () => {
  it('exposes the key list BOTH halves are pinned against', () => {
    expect([...CP39_FORM_HEADER_KEYS].sort()).toEqual(Object.keys(header()).sort());
    // The read must set every one of them, or a box silently prints empty on a statutory document.
    // `[:,]` because a header entry may legitimately be written as ES shorthand (`deductionPeriodKey,`).
    for (const k of CP39_FORM_HEADER_KEYS) {
      expect(READ_CODE, `the read must set ${k}`).toMatch(new RegExp(`\\b${k}\\s*[:,]`));
    }
  });

  it('blocks on the employer-level fields, and NOT on the address or the registration number', () => {
    expect(missingCp39FormHeader(header())).toEqual([]);
    expect(missingCp39FormHeader(header({ employerNo: '' }))).toEqual(['employerNo']);
    expect(missingCp39FormHeader(header({ employerName: '  ' }))).toEqual(['employerName']);
    // A company with no registered business number or no address still gets its statement.
    expect(missingCp39FormHeader(header({ registrationNo: '', employerAddress: '' }))).toEqual([]);
    // Null/undefined is a report, never a throw — this runs on a render path.
    expect(missingCp39FormHeader(null).length).toBeGreaterThan(0);
  });

  it('reports preparer gaps as an advisory that blocks nothing', () => {
    expect(missingCp39Preparer(header())).toEqual([]);
    expect(missingCp39Preparer(header({ preparerPhone: '' }))).toEqual(['preparerPhone']);
    expect(missingCp39Preparer(null)).toEqual([
      'preparerName',
      'preparerIc',
      'preparerPosition',
      'preparerPhone',
    ]);
    // The gate is the header list, not this one: `loadCp39Form` only ever refuses on the two above.
    expect(SHARED_CODE).toContain('missingCp39FormHeader');
    expect(SHARED_CODE).toMatch(/preparerMissing/);
    expect(SHARED_CODE).not.toMatch(/preparerMissing\.length[^\n]*not-ready/);
  });

  /**
   * A BOX THAT IS ALWAYS SUBMITTED CANNOT BE READ BY PRESENCE — AGENTS rule 17, which shipped a pay
   * setting nobody could turn off. Every preparer input is on the form whether or not it was touched, so
   * an empty one has to mean "keep the company default", never "clear the name off the statement".
   */
  it('treats a blank preparer box as "keep the default", not "clear it"', () => {
    const form = cp39FormFrom({ header: header(), rows: [] });
    const untouched = withPreparer(form, {
      preparerName: '',
      preparerIc: '   ',
      preparerPosition: undefined,
      preparerPhone: '',
    });
    expect(untouched.preparerName).toBe('CHONG PEI YUH');
    expect(untouched.preparerIc).toBe('910416145530');
    expect(untouched.preparerPosition).toBe('ASSISTANT MANAGER');
    expect(untouched.preparerPhone).toBe('0123081733');

    const typed = withPreparer(form, { preparerName: '  LEE MEI  ', preparerPhone: '03-1234' });
    expect(typed.preparerName).toBe('LEE MEI');
    expect(typed.preparerPhone).toBe('03-1234');
    // …and nothing else moved.
    expect(typed.preparerIc).toBe(form.preparerIc);
  });

  it('honours a valid print date and IGNORES a junk one rather than 500ing a render path', () => {
    const form = cp39FormFrom({ header: header(), rows: [] });
    expect(withPreparer(form, { printedOnIso: '2026-02-03' }).printedOn).toBe('03/02/2026');
    for (const junk of ['', 'yesterday', '03/02/2026', undefined]) {
      expect(withPreparer(form, { printedOnIso: junk }).printedOn).toBe('18/08/2026');
    }
  });

  it('formats dates, money and the download name', () => {
    expect(formDate('2026-08-18')).toBe('18/08/2026');
    expect(formDate('not a date')).toBe('');
    expect(formDate(null)).toBe('');
    expect(money(4173.9)).toBe('4,173.90');
    expect(money(0)).toBe('0.00');
    const form = cp39FormFrom({ header: header(), rows: [] });
    expect(cp39FormFilename(form, 'pdf')).toBe('cp39-E0094573909-202601.pdf');
    expect(cp39FormFilename(cp39FormFrom({ header: header({ employerNo: '' }), rows: [] }), 'txt')).toMatch(
      /^cp39-EMP-/,
    );
  });

  it('splits the employer address back into lines the renderer can print', () => {
    const form = cp39FormFrom({ header: header(), rows: [] });
    expect(form.employerAddress).toEqual(['Level 12, Menara Satu', '50450 Kuala Lumpur, Wilayah Persekutuan']);
    expect(cp39FormFrom({ header: header({ employerAddress: '' }), rows: [] }).employerAddress).toEqual([]);
  });
});

/**
 * BUTIR-BUTIR PEMBAYARAN — the payment instrument, which the approved plan lists TWICE: once in the
 * workflow ("the preparer block and payment-instrument fields editable") and once under MANUAL FIELDS
 * ("cheque/bank draft/postal order no. and branch … leave blank/editable on preview"). Both halves are
 * true at once: nothing in payroll can derive either value, AND the operator can type it, because this
 * page doubles as the payment cover document and the instrument is normally in front of them.
 *
 * THE BLANK RULE HERE IS THE OPPOSITE OF THE PREPARER BLOCK'S, which is why it is a separate helper. A
 * preparer box is pre-filled from the company record, so "" must mean "keep the default" (AGENTS rule
 * 17). These have no default and never can, so "" means blank — and the page goes back to printing the
 * ruled line it printed before they were typeable.
 */
describe('the payment instrument', () => {
  const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a' })] });

  it('starts empty, because no read can know a cheque number', () => {
    expect(form.paymentRef).toBe('');
    expect(form.paymentBranch).toBe('');
    // …and it is NOT part of the read↔renderer header contract, so no read is asked to produce it.
    expect([...CP39_FORM_HEADER_KEYS]).not.toContain('paymentRef');
    expect([...CP39_FORM_HEADER_KEYS]).not.toContain('paymentBranch');
  });

  it('carries what the operator typed, trimmed, and treats a blank box as BLANK not "keep"', () => {
    const typed = withPaymentInstrument(form, { paymentRef: '  123456  ', paymentBranch: ' MAYBANK KLCC ' });
    expect(typed.paymentRef).toBe('123456');
    expect(typed.paymentBranch).toBe('MAYBANK KLCC');
    // Clearing the box really clears it — the opposite of `withPreparer`, and deliberately so.
    const cleared = withPaymentInstrument(typed, { paymentRef: '', paymentBranch: '   ' });
    expect([cleared.paymentRef, cleared.paymentBranch]).toEqual(['', '']);
    const untouched = withPaymentInstrument(typed, {});
    expect([untouched.paymentRef, untouched.paymentBranch]).toEqual(['', '']);
    // Nothing else on the statement moved.
    expect(typed.preparerName).toBe(form.preparerName);
    expect(typed.totalAmount).toBe(form.totalAmount);
  });

  it('prints the typed value in the text export, and a rule to write on when there is none', () => {
    expect(cp39FormTextExport(form)).toContain('No. Cek / Draf Bank / Wang Pos : ____');
    const typed = withPaymentInstrument(form, { paymentRef: 'CHQ 004417', paymentBranch: 'CIMB IPOH' });
    const txt = cp39FormTextExport(typed);
    expect(txt).toContain('CHQ 004417');
    expect(txt).toContain('CIMB IPOH');
    // The "left blank on purpose" footer names what is STILL blank. Telling somebody who has just typed
    // a cheque number that it was left out is how a correct document gets re-done by hand.
    const footer = txt.slice(txt.indexOf('Left blank on purpose'));
    expect(footer).toContain('Tandatangan');
    expect(footer).not.toContain('No. Cek');
    expect(footer).not.toContain('Cawangan');
    const blankFooter = cp39FormTextExport(form);
    expect(blankFooter.slice(blankFooter.indexOf('Left blank on purpose'))).toContain('No. Cek');
  });

  /**
   * ⚠️ c99e8358 RETIRED THE SOURCE-SHAPE HALF OF THIS CASE AND KEPT THE RULE. It used to pin the two
   * literals `if (form.paymentRef)` / `if (form.paymentBranch)`, and the redraw put both boxes on ONE
   * table-driven loop over the instrument rows, so those literals are gone while nothing about the
   * behaviour moved. The rule is now asserted on the DRAWN PAGE, which the source shape never could:
   * see also the positional case further down, which pins the cell each one lands in.
   */
  it('draws the typed value on the page rather than always a ruled line', async () => {
    expect(PDF_CODE).toContain('form.paymentRef');
    expect(PDF_CODE).toContain('form.paymentBranch');

    const typed = withPaymentInstrument(form, { paymentRef: 'CHQ 004417', paymentBranch: 'CIMB IPOH' });
    const bytes = await renderCp39FormPdf(typed);
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    expect(await drawnText(bytes)).toEqual(expect.arrayContaining(['CHQ 004417', 'CIMB IPOH']));
    // An untyped one prints NEITHER — the specimen prints a rule there and so do we.
    const blank = await drawnText(await renderCp39FormPdf(form));
    expect(blank).not.toContain('CHQ 004417');
    expect(blank).not.toContain('CIMB IPOH');
  });

  /**
   * THE CONTRACT BETWEEN THE SCREEN AND THE LOADER, which is where this would break invisibly: an input
   * whose `name` nobody reads is submitted on every request and silently ignored, and a loader reading a
   * name no input carries is dead code. A unit test of either half passes throughout (AGENTS rule 17).
   */
  it('is typed on the review screen and read by the ONE loader the routes share', () => {
    expect(PREVIEW).toContain('name="payRef"');
    expect(PREVIEW).toContain('name="payBranch"');
    expect(PREVIEW_CODE).toContain("t('payRef')");
    expect(PREVIEW_CODE).toContain("t('payBranch')");
    expect(SHARED_CODE).toContain("p.query.get('payRef')");
    expect(SHARED_CODE).toContain("p.query.get('payBranch')");
    expect(SHARED_CODE).toContain('withPaymentInstrument');
    // The two download routes inherit it because they hand the SAME query to `loadCp39Form` — the
    // property that stops the reviewed statement and the downloaded one carrying different numbers.
    for (const src of [PDF_ROUTE_CODE, TEXT_ROUTE_CODE]) expect(src).toContain('query: q');
  });

  it('is never persisted and never reaches the pack', () => {
    // One generation of one statement. A cheque number stored on a company record is wrong next month.
    expect(SHARED_CODE).not.toMatch(/insert|update|upsert/i);
    expect(READ_CODE).not.toContain('paymentRef');
    expect(REPORTS_CODE).not.toContain('paymentRef');
  });
});

describe('the catalog entry', () => {
  const def = MY_REPORTS.find((r) => r.id === 'my.cp39');

  it('is still ONE CP39 card on the LHDN shelf, not two', () => {
    expect(def, 'my.cp39 must be registered').toBeTruthy();
    expect(def!.submission?.body).toBe('lhdn');
    expect(def!.submission?.agency).toBe('LHDN');
    expect(def!.submission?.dueDayOfNextMonth).toBe(15);
    // The printed form was built by ENRICHING this generator. A second entry would give the shelf two
    // CP39s with two readiness gates that could disagree about who is ready to be filed.
    expect(MY_REPORTS.filter((r) => r.id.startsWith('my.cp39')).map((r) => r.id)).toEqual(['my.cp39']);
  });

  /**
   * ⚠️ THE FIDELITY CLAIM MOVED ONCE, IN c99e8358, AND ONLY THE FIRST HALF OF IT MOVED.
   *
   * WHAT MOVED: `figures` → `agency-layout`. `agency-layout` asserts that every box is where the
   * AGENCY's form puts it, on our own paper. That was untrue while every box was placed from the
   * ticket's prose list of fields; it is true now that page one is drawn to
   * `docs/forms/cp39-pin-2015-specimen.png` via the hand transcription beside it, masthead, payment
   * panel and A / B / C notes included. `my.borang-8a` and `my.borang-a` already carry that value for
   * exactly the same reason, and this is the third member of the set, not a fourth status.
   *
   * WHAT DID NOT MOVE, and is the half worth keeping: `official` is a claim about GOVERNMENT ARTWORK,
   * it belongs to `my.cp22` alone, and the specimen is another payroll vendor's rendering rather than
   * LHDN's page — which is why it lives in `docs/forms/` and not in `public/forms/`. Understating is
   * safe. Overstating is the single failure the whole vocabulary exists to prevent.
   */
  it('claims `agency-layout` now that the page is drawn to the specimen — and never `official`', () => {
    expect(def!.fidelity).toBe('agency-layout');
    // The evidence for the ceiling, asserted rather than asserted-about: there is still no CP39 page in
    // public/forms. The day somebody puts LHDN's own artwork there, this fails and `official` gets
    // reconsidered on purpose — and only then.
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /cp\W?39/i.test(f))).toEqual([]);
    // The evidence for the floor: the specimen and its transcription ARE in the repository, so the
    // arrangement was copied rather than remembered.
    expect(fs.existsSync(path.join(ROOT, 'docs/forms/cp39-pin-2015-specimen.png'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'docs/forms/cp39-pin-2015-transcription.txt'))).toBe(true);
    // `official` belongs to `my.cp22` alone and to no ReportDef at all.
    expect(MY_REPORTS.filter((r) => r.fidelity === 'official').map((r) => r.id)).toEqual([]);
    // And the drawn page and its text twin both say so on their face rather than only in a comment.
    expect(PDF_CODE).toContain('bukan borang rasmi LHDN');
    expect(cp39FormTextExport(cp39FormFrom({ header: header(), rows: [] }))).toContain('NOT LHDN ARTWORK');
  });

  it('keeps the FIGURES table’s four columns, so the existing screen and exports are untouched', () => {
    // The printed form's extra fields ride on the ROWS, which the figures screen and the CSV/XLSX export
    // both ignore — they map `result.columns`, never `Object.keys(row)`. Adding a column here would
    // change a file somebody already consumes downstream.
    expect(REPORTS_CODE).toContain("{ key: 'pcb', label: 'MTD / PCB', numeric: true }");
    expect(REPORTS_CODE).toContain("sumTotals(rows, ['pcb', 'cp38'])");
  });

  it('resolves the review-link keys the figures screen renders', () => {
    const ns = en.payroll.statutoryForms as Record<string, string>;
    expect(ns.cp39Review).toBeTruthy();
    expect(ns.cp39ReviewTitle).toBeTruthy();
    // The e-Data PCB file keeps its own button; the printed form did not replace it.
    expect(ns.cp39DownloadLabel).toBeTruthy();
  });
});

describe('the three surfaces cannot disagree', () => {
  it('registers the review PAGE in the access matrix and the two ROUTES nowhere', () => {
    // Rule 20: only page.tsx files are enumerated. A guarded page with no column fails
    // test/function-access.test.ts; a route handler with one would be a column nobody can use.
    expect(REGISTERED_ROUTES.has('/payroll/cp39/preview')).toBe(true);
    expect(REGISTERED_ROUTES.has('/payroll/cp39/pdf')).toBe(false);
    expect(REGISTERED_ROUTES.has('/payroll/cp39/text')).toBe(false);
  });

  it('routes every surface through the one loader, and none of them through the pack', () => {
    for (const [name, src] of [
      ['preview', PREVIEW_CODE],
      ['pdf', PDF_ROUTE_CODE],
      ['text', TEXT_ROUTE_CODE],
    ] as const) {
      expect(src, `${name} must go through the shared loader`).toMatch(/loadCp39Form\(/);
      // ADR-0080 D1: app/ reaches the pack only through core/reporting.
      expect(src, `${name} must not import the pack`).not.toContain('localization/my');
    }
    expect(SHARED_CODE).toContain('reportPreview');
    expect(SHARED_CODE).not.toContain('localization/my');
  });

  it('gates the downloads in the LOADER, not only on the screen', () => {
    // A URL is not a screen. `includeIncomplete` is the review screen's alone.
    expect(SHARED_CODE).toContain("reason: 'not-ready'");
    expect(SHARED_CODE).toContain('p.includeIncomplete');
    expect(PREVIEW_CODE).toContain('includeIncomplete: true');
    for (const src of [PDF_ROUTE_CODE, TEXT_ROUTE_CODE]) {
      expect(src, 'a download route must never ask for incomplete rows').not.toContain('includeIncomplete');
    }
    // Scope, not `isAdmin` — an hr_admin grant on ANY company would otherwise export another company's
    // employee names, identity card numbers, tax reference numbers and deductions.
    expect(SHARED_CODE).toContain('scopedAdmin');
    expect(SHARED_CODE).not.toContain('isAdmin');
  });

  it('hides the download buttons rather than disabling them', () => {
    // A disabled button is still a button and still gets clicked at.
    expect(PREVIEW_CODE).not.toContain('disabled');
    expect(PREVIEW_CODE).toContain("t('downloadsBlocked')");
  });

  it('never nests the two forms, which browsers silently drop', () => {
    expect(PREVIEW).toContain('<input type="hidden" name="companyId"');
    expect(PREVIEW).toContain('<input type="hidden" name="periodKey"');
    expect((PREVIEW.match(/<form /g) ?? []).length).toBe(2);
  });

  it('never claims the printed page is the LHDN submission', () => {
    // The submission is the e-Data PCB file behind its own route. This one is a record and a payment
    // cover document, and every surface has to say so — the request is explicit about it.
    expect(TEXT_ROUTE_CODE).not.toContain('cp39-file');
    expect(cp39FormTextExport(cp39FormFrom({ header: header(), rows: [] }))).toMatch(/e-PCB/);
  });
});

describe('the module stands alone from the EPF and PERKESO forms', () => {
  it('shares no code with Borang A or Borang 8A, in either direction', () => {
    // The dating rules are DIFFERENT (identity here, +1 for EPF). A shared helper that grew a parameter
    // is exactly how one acquires the other's, and it would pass every unit test of either half.
    // COMMENT-STRIPPED on both sides: these files document which module they are independent of, and
    // scanning the prose would make the honest note fail the test the note exists to reinforce.
    for (const src of [LIB_CODE, PDF_CODE, READ_CODE]) {
      expect(src).not.toContain('borang-a');
      expect(src).not.toContain('borang-8a');
    }
    expect(code('lib/borang-a.ts')).not.toContain('cp39');
    expect(code('lib/borang-8a.ts')).not.toContain('cp39');
  });

  it('does not reach into the e-Data FILE builder either — they share figures, not code', () => {
    // `localization/my/cp39-file.ts` is a fixed-width machine format with hard field widths that REFUSE
    // rather than truncate. The printed page has none of that, and a shared helper would drag one
    // module's refusals into the other's render path.
    expect(LIB_CODE).not.toContain('cp39-file');
    expect(PDF_CODE).not.toContain('cp39-file');
  });
});

describe('the drawn page', () => {
  it('renders a real PDF: one cover page plus one sheet per page of employees', async () => {
    for (const [count, perPage, sheets] of [
      [1, 26, 1],
      [7, 3, 3],
    ] as const) {
      const rows = Array.from({ length: count }, (_, i) => row({ employmentId: `e${i}`, name: `PERSON ${i}` }));
      const form = cp39FormFrom({ header: header(), rows, perPage });
      expect(form.pages).toHaveLength(sheets);
      const bytes = await renderCp39FormPdf(form);
      expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
      expect(bytes.byteLength).toBeGreaterThan(1000);
      // Page 1 is the cover the request asks for (employer + payment summary + preparer); the schedule
      // starts on page 2. A regression that folded the cover into the table would show up here.
      const loaded = await PDFDocument.load(bytes);
      expect(loaded.getPageCount()).toBe(1 + sheets);
    }
  });

  it('renders a statement with no employees rather than throwing', async () => {
    const bytes = await renderCp39FormPdf(cp39FormFrom({ header: header(), rows: [] }));
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  it('renders when every header box is empty, because that is a render path too', async () => {
    const bytes = await renderCp39FormPdf(cp39FormFrom({ header: {}, rows: [row({ employmentId: 'a' })] }));
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('folds typography Helvetica cannot encode instead of printing "?"', () => {
    // r193 shipped "the agency?s own page" on the Borang 8A footer before this fold existed.
    expect(PDF_SRC).toContain("replace(/[‘’ʼ]/g, \"'\")");
    expect(PDF_SRC).toContain('replace(/[–—−]/g,');
  });

  it('prints JUMLAH BESAR on the last sheet only', () => {
    // Repeating it is how a multi-page statement gets filed with a page total mistaken for the grand one.
    expect(PDF_CODE).toContain('JUMLAH BESAR');
    expect(PDF_CODE).toContain('if (last) {');
  });

  /**
   * TEN COLUMNS ON A4 PORTRAIT, MEASURED RATHER THAN EYEBALLED.
   *
   * A heading is NOT clipped by pdf-lib, so one wider than its column prints straight into its
   * neighbour — the r193 Borang 8A lesson, and the reason the narrow headings here are split over two
   * lines. This asserts it with the real font metrics rather than by rasterising and hoping.
   */
  it('tiles the printable width with no overlap and no heading wider than its column', async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const M = 28;
    const RIGHT = 595.28 - M;

    const spans = CP39_TABLE_COLUMNS.map((c) => ({
      key: c.key,
      left: c.align === 'right' ? c.x - c.width : c.x,
      right: c.align === 'right' ? c.x : c.x + c.width,
    }));
    for (const s of spans) {
      expect(s.left, `${s.key} starts inside the left margin`).toBeGreaterThanOrEqual(M);
      expect(s.right, `${s.key} ends inside the right margin`).toBeLessThanOrEqual(RIGHT);
    }
    const ordered = [...spans].sort((a, b) => a.left - b.left);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i].left, `${ordered[i].key} overlaps ${ordered[i - 1].key}`).toBeGreaterThanOrEqual(
        ordered[i - 1].right,
      );
    }
    // The columns are declared in printed order, which is also the order the request lists them in.
    expect(ordered.map((s) => s.key)).toEqual(CP39_TABLE_COLUMNS.map((c) => c.key));
    expect(CP39_TABLE_COLUMNS.map((c) => c.key)).toEqual([
      'bil',
      'tin',
      'name',
      'oldIc',
      'newIc',
      'employeeNo',
      'passport',
      'countryCode',
      'pcb',
      'cp38',
    ]);
    for (const c of CP39_TABLE_COLUMNS) {
      for (const h of c.head) {
        expect(
          bold.widthOfTextAtSize(h, CP39_HEADING_SIZE),
          `heading "${h}" does not fit the ${c.key} column`,
        ).toBeLessThanOrEqual(c.width - 2);
      }
    }
  });
});

describe('the text export', () => {
  const form = cp39FormFrom({
    header: header(),
    rows: [
      row({ employmentId: 'a', name: 'ALPHA ONE', pcb: 110.5, cp38: 0 }),
      row({ employmentId: 'b', name: 'BETA TWO', pcb: 88.25, cp38: 40.75 }),
    ],
  });
  const txt = cp39FormTextExport(form);

  it('carries the employer block, the period and both payment totals', () => {
    expect(txt).toContain('E0094573909');
    expect(txt).toContain('ISEDECOR BINA SDN BHD');
    expect(txt).toContain('POTONGAN BAGI BULAN JANUARI TAHUN 2026');
    expect(txt).toContain('198.75');
    expect(txt).toContain('40.75');
    expect(txt).toContain('239.50');
  });

  it('says plainly that it is not the upload file and not the submission', () => {
    expect(txt).toContain('NOT LHDN ARTWORK');
    expect(txt).toContain('e-Data PCB');
    expect(txt).toContain('PEGAWAI YANG MENYEDIAKAN MAKLUMAT');
  });

  it('lists the manual fields it deliberately leaves blank', () => {
    expect(txt).toContain('Tandatangan');
    expect(txt).toContain('Cawangan');
  });

  it('ends with a newline, so appending or diffing it does not join two lines', () => {
    expect(txt.endsWith('\n')).toBe(true);
  });
});

/**
 * EVERY KEY THE REVIEW SCREEN RENDERS RESOLVES. A message that does not exist throws MISSING_MESSAGE at
 * RENDER time and paints the raw key on the page, while tsc, the suite and `next build` all stay green.
 */
describe('the review screen’s messages', () => {
  const ns = (en.payroll as Record<string, unknown>).cp39Form as Record<string, string>;

  it('exists as a namespace', () => {
    expect(ns, 'payroll.cp39Form must exist in en.json').toBeTruthy();
    expect(PREVIEW).toContain("getTranslations('payroll.cp39Form')");
  });

  it('resolves every literal t(...) key the screen uses', () => {
    const keys = [...PREVIEW.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(30);
    for (const k of new Set(keys)) expect(ns[k], `payroll.cp39Form.${k} is missing`).toBeTruthy();
  });

  it('resolves the keys the screen looks up through its two label maps', () => {
    // Dynamic lookups are invisible to the scan above and to i18n-coverage's namespace check.
    for (const k of ['headerField_employerNo', 'headerField_employerName']) expect(ns[k], k).toBeTruthy();
    for (const k of ['prepField_name', 'prepField_ic', 'prepField_position', 'prepField_phone']) {
      expect(ns[k], k).toBeTruthy();
    }
  });

  it('keeps braces out of every key rendered without arguments', () => {
    // A message carrying {placeholders} rendered through a plain t('…') throws FORMATTING_ERROR at render
    // time — a 200 that shows the raw key path.
    const INTERPOLATED = new Set([
      'noBatch',
      'tilePcbHint',
      'tileCp38Hint',
      'tileEmployer',
      'missingTitle',
      'pageTotal',
      // 7ee14bbc
      'dupTinTitle',
      'deductedOnly',
      'noDeductions',
      'unfinishedNameTitle',
    ]);
    const braced = Object.entries(ns).filter(([k, v]) => !INTERPOLATED.has(k) && /[{}]/.test(v));
    expect(braced.map(([k]) => k), 'these are rendered with no arguments').toEqual([]);
    for (const k of INTERPOLATED) expect(ns[k], k).toMatch(/\{/);
  });
});

// ── 7ee14bbc ───────────────────────────────────────────────────────────────────────────────────────
//
// FIVE POINTS WERE REPORTED AGAINST THIS EXPORT AND ONLY TWO OF THEM WERE EXPORT FAULTS. The counts were
// right and the TABLE was wrong; the repeated tax numbers and the TEST#### names are the reporter's own
// records. The approved plan says so on measured evidence, and what follows pins the half we built —
// including, deliberately, the two places where the right answer was to change NOTHING (the e-Data upload
// file, and the tax numbers the statement prints).

/**
 * Every string the renderer actually DREW, decoded off the saved page.
 *
 * WHY THIS EXISTS AND WHY FONT ARITHMETIC IS NOT ENOUGH: metrics prove a column is wide enough for a
 * value. They cannot prove the renderer put the WHOLE value in it, and the defect point 5 is about is
 * silent LOSS — the old `textClip` dropped characters off the end until the string fitted, so
 * `941128-03-5179` became `941128-03-517`: a different identity card number that still reads as one,
 * beside somebody's tax reference, on a document that gets signed. An overprint gets queried; a clean
 * truncation does not, and clipping is also exactly how you hide an overprint from a geometry check.
 *
 * pdf-lib writes each drawn run as a hex string followed by `Tj` inside a Flate content stream, so
 * inflating every stream object and decoding those gives the literal text on the page.
 */
async function drawnText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const raw = (obj as unknown as { contents?: Uint8Array }).contents;
    if (!raw) continue;
    let stream: string;
    try {
      stream = zlib.inflateSync(Buffer.from(raw)).toString('latin1');
    } catch {
      stream = Buffer.from(raw).toString('latin1');
    }
    for (const m of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(m[1], 'hex').toString('latin1'));
    }
  }
  return out;
}

describe('7ee14bbc — the schedule prints the DEDUCTED, and the count beside it is the count of them', () => {
  /**
   * THE REPORTER'S OWN 2026-08 RUN, IN SHAPE: 38 people paid, 7 of them deducted, nobody on a CP38
   * instalment. Their reference statement from another payroll system shows 13 rows against a Bilangan
   * Pekerja of 13; ours showed 38 rows against 7, and they read that as the count under-reporting by 31.
   * The count was right. A CP39 is a statement of tax DEDUCTED, and a person who had none is not a line.
   */
  const augustShaped: Cp39FormRow[] = [
    ...Array.from({ length: 7 }, (_, i) =>
      row({ employmentId: `d${i}`, name: `DEDUCTED ${i}`, tin: `SG2000000000${i}`, pcb: 10 + i, cp38: 0 }),
    ),
    ...Array.from({ length: 31 }, (_, i) =>
      row({ employmentId: `z${i}`, name: `ZERO ${i}`, tin: `SG3000000000${i}`, pcb: 0, cp38: 0 }),
    ),
  ];

  it('prints 7 rows for the 38-person run, and 7 is the number printed beside them', () => {
    const form = cp39FormFrom({ header: header(), rows: augustShaped });
    const printed = form.pages.flatMap((p) => p.rows);

    expect(form.employees).toBe(38); // everyone the run paid — still counted, still not a box on the form
    expect(form.pcbEmployees).toBe(7);
    expect(form.cp38Employees).toBe(0);
    // THE PIN. Not "7 === 7" twice, but that the rows and the count are ONE number by construction.
    expect(printed).toHaveLength(7);
    expect(form.deductedEmployees).toBe(printed.length);
    expect(printed).toHaveLength(form.pcbEmployees);
    expect(printed.every((r) => r.pcb > 0 || r.cp38 > 0)).toBe(true);
    expect(printed.map((r) => r.name)).not.toContain('ZERO 0');
  });

  it('keeps a CP38-only employee, whose PCB is zero — the rule is EITHER deduction', () => {
    const rs = [
      row({ employmentId: 'a', name: 'PCB ONLY', tin: 'SG1', pcb: 110.5, cp38: 0 }),
      row({ employmentId: 'b', name: 'CP38 ONLY', tin: 'SG2', pcb: 0, cp38: 250 }),
      row({ employmentId: 'c', name: 'BOTH', tin: 'SG3', pcb: 88.25, cp38: 40.75 }),
      row({ employmentId: 'd', name: 'NEITHER', tin: 'SG4', pcb: 0, cp38: 0 }),
    ];
    const form = cp39FormFrom({ header: header(), rows: rs });
    expect(form.pages.flatMap((p) => p.rows).map((r) => r.name)).toEqual(['PCB ONLY', 'CP38 ONLY', 'BOTH']);
    // NOT `pcbEmployees` and not `cp38Employees` — the UNION. A filter on `pcb > 0` alone would drop a
    // court-ordered CP38 instalment off a filing the money is actually paid for.
    expect(form.deductedEmployees).toBe(3);
    expect(form.pcbEmployees).toBe(2);
    expect(form.cp38Employees).toBe(2);
    expect(cp39PrintedRows(rs).map((r) => r.name)).toEqual(['PCB ONLY', 'CP38 ONLY', 'BOTH']);
  });

  it('changes no total, because a row it stopped printing contributed nothing to either', () => {
    const deducted = augustShaped.filter((r) => r.pcb > 0 || r.cp38 > 0);
    const all = cp39FormFrom({ header: header(), rows: augustShaped });
    const only = cp39FormFrom({ header: header(), rows: deducted });
    expect(all.totalPcb).toBe(only.totalPcb);
    expect(all.totalCp38).toBe(only.totalCp38);
    expect(all.totalAmount).toBe(only.totalAmount);
    expect(all.totalPcb).toBe(91); // 10+11+12+13+14+15+16
    // …and the page totals still sum to the grand total, which is the property pagination exists for.
    expect(all.pages.reduce((a, p) => a + p.pagePcb, 0)).toBe(all.totalPcb);
  });

  it('does not paginate the people it no longer prints', async () => {
    // 38 rows at 26 per sheet was TWO sheets, the second almost entirely people with no deduction —
    // a whole extra page of a statutory schedule that should never have been filed.
    const form = cp39FormFrom({ header: header(), rows: augustShaped, perPage: 26 });
    expect(form.pages).toHaveLength(1);
    expect(form.pages[0].of).toBe(1);
    expect((await PDFDocument.load(await renderCp39FormPdf(form))).getPageCount()).toBe(2); // cover + 1
  });

  it('says on the document AND on the screen why the schedule is shorter than the payroll', () => {
    const form = cp39FormFrom({ header: header(), rows: augustShaped });
    // Whoever reconciles this against a payroll summary otherwise counts a shorter list with nothing
    // telling them why — the reporter's own complaint in reverse.
    expect(cp39FormTextExport(form)).toContain('Senarai pekerja: 7 daripada 38');
    // ONE sentence, called twice — see `cp39ScheduleScopeNote`. Two copies of a claim about the
    // document's own arithmetic are two claims that can drift, and one of them already drifted false.
    expect(PDF_CODE).toContain('cp39ScheduleScopeNote(form)');
    expect(LIB_CODE).toContain('cp39ScheduleScopeNote(form)');
    expect(PREVIEW_CODE).toContain("t('deductedOnly'");
    // The heading's count moved off `form.employees` — it is the count of the rows underneath it now.
    expect(PREVIEW_CODE).toContain('count={form.deductedEmployees}');
    expect(PREVIEW_CODE).not.toContain('count={form.employees}');
  });

  it('tells an operator that a run with no deductions is not a run with no employees', () => {
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', pcb: 0, cp38: 0 })] });
    expect(form.employees).toBe(1);
    expect(form.deductedEmployees).toBe(0);
    // ONE empty sheet, not zero: "Muka surat 1/0" is not a thing, and that rule survives the filter.
    expect(form.pages).toHaveLength(1);
    expect(form.pages[0].rows).toHaveLength(0);
    expect(PREVIEW_CODE).toContain("t('noDeductions'");
  });

  it('does NOT narrow the readiness gate, which is the e-Data file’s and covers everyone paid', () => {
    // The upload file emits a detail record for every employee the run paid and refuses on a missing TIN
    // for any of them, so the printed statement keeps inheriting that same list rather than growing a
    // second, looser one. Source-shape, because the defect would live BETWEEN the model and the loader.
    expect(SHARED_CODE).toContain('if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete)');
    expect(SHARED_CODE).not.toContain('deductedEmployees');
  });
});

describe('7ee14bbc — identity card numbers are dashed AT RENDER, and nowhere else', () => {
  it.each([
    ['941128035179', '941128-03-5179'],
    ['860208105128', '860208-10-5128'],
  ])('formats %s as %s, the way the card itself prints it', (raw, formatted) => {
    expect(formatMyIc(raw)).toBe(formatted);
  });

  it.each([
    ['', ''],
    ['941128-03-5179', '941128-03-5179'], // already dashed — never rearranged a second time
    ['A1234567', 'A1234567'], // a passport, not a MyKad
    ['94112803517', '94112803517'], // eleven digits is not a MyKad either
    ['9411280351790', '9411280351790'], // nor thirteen
    ['941128 03 5179', '941128 03 5179'],
  ])('leaves "%s" exactly as it is', (raw, out) => {
    // CONSERVATIVE BY CONSTRUCTION. The one thing worse than an unformatted identity card number on a
    // tax document is a rearranged one, so only an exactly-twelve-digit value is touched.
    expect(formatMyIc(raw)).toBe(out);
  });

  it('leaves the STORED value on the row alone — the dashes exist only on the way to a page', () => {
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', newIc: '941128035179' })] });
    expect(form.pages[0].rows[0].newIc).toBe('941128035179');
  });

  it('draws the whole formatted number on the page, and the raw one nowhere', async () => {
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', newIc: '941128035179' })] });
    const drawn = await drawnText(await renderCp39FormPdf(form));
    expect(drawn).toContain('941128-03-5179');
    expect(drawn).not.toContain('941128035179');
  });

  /**
   * ⚠️ WHY POINT 5 TRAVELS WITH POINT 2. Two dashes make the number FOURTEEN characters, and at the row
   * type size that is wider than the No. K/P Baru column. Under the old `textClip` the fix for point 2
   * would have shipped `941128-03-517` — a different identity card number, on every row, looking
   * completely normal. The premise is asserted rather than assumed.
   */
  it('shrinks to fit rather than truncating, which is the only reason the dashes are safe', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const col = CP39_TABLE_COLUMNS.find((c) => c.key === 'newIc')!;
    expect(font.widthOfTextAtSize('941128-03-5179', CP39_ROW_SIZE)).toBeGreaterThan(col.width - 4);

    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', newIc: '941128035179' })] });
    expect(await drawnText(await renderCp39FormPdf(form))).toContain('941128-03-5179');
    expect(PDF_CODE, 'the clipping renderer is gone, not merely unused').not.toContain('textClip');
  });

  it('prints a long legal name whole rather than cutting it down to a shorter company', async () => {
    const name = 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR';
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', name })] });
    expect(await drawnText(await renderCp39FormPdf(form))).toContain(name);
  });

  /**
   * ⚠️ THE ASSERTION THIS CHANGE EXISTS TO BE SAFE UNDER, not an extra one beside it.
   *
   * The e-Data PCB upload is a fixed-width 57/136-character machine format LHDN's portal ingests, and its
   * identity-card field is TWELVE characters. Two dashes make fourteen. The formatter must therefore be
   * unreachable from it — and "unreachable" is a claim about bytes, so the built file is pinned BYTE FOR
   * BYTE. If a later tidy-up routes the file through the printed form's row model, this fails.
   */
  it('leaves the e-Data PCB upload file byte for byte what it was', () => {
    const file = buildCp39File({
      employerNo: 'E0094573909',
      year: 2026,
      month: 1,
      rows: [
        { tin: 'SG23607354000', name: 'ANG PEI YEE', newIc: '941128035179', mtd: 110.5, cp38: 0, employeeNo: 'EMP001' },
        { tin: 'SG10000000002', name: 'BETA TWO', newIc: '860208105128', mtd: 0, cp38: 250, employeeNo: 'EMP002' },
      ],
    });
    expect(file.content).toBe(CP39_FILE_GOLDEN);
    expect(file.filename).toBe(CP39_FILE_GOLDEN_NAME);
    // Named separately from the golden so a failure says WHICH thing moved.
    expect(file.content).not.toContain('941128-03-5179');
    expect(file.content).toContain('941128035179');
    for (const line of file.content.split('\r\n').filter(Boolean).slice(1)) expect(line).toHaveLength(136);
  });

  it('cannot be reached by the formatter at all, and IS applied on both render surfaces', () => {
    // The file builder reads `employee_statutory_my.ic_number` straight from the database; it has never
    // imported the printed form's model and must not start.
    expect(code('localization/my/cp39-file.ts')).not.toContain('formatMyIc');
    expect(code('localization/my/cp39-file.ts')).not.toContain('cp39-form');
    // Source-shape across BOTH halves of the contract: a unit test of either one passes throughout.
    expect(PDF_CODE).toContain('formatMyIc(r.newIc)');
    expect(PREVIEW_CODE).toContain('formatMyIc(r.newIc)');
  });

  it('leaves the plain-text twin unformatted, because that is what you key into e-PCB', () => {
    // It is also fixed-width — `pad(r.newIc.slice(0, 13), 14)` — and a formatted number is exactly 14,
    // so the slice would cut the last digit off it.
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', newIc: '941128035179' })] });
    const txt = cp39FormTextExport(form);
    expect(txt).toContain('941128035179');
    expect(txt).not.toContain('941128-03-5179');
  });
});

describe('7ee14bbc — a tax number filed against two people is NAMED, and still printed as filed', () => {
  /**
   * THE REPORTER'S OWN PRODUCTION PAIR, measured 2026-08-19: 31 employees hold a tax number and only 24
   * are distinct. `SG90010101` is filed against both of these people, who have DIFFERENT ic_numbers — so
   * it is two records disagreeing, not a join fault, and not something the export can repair.
   */
  const shared: Cp39FormRow[] = [
    row({ employmentId: 'a', name: 'Aisyah Rahman', tin: 'SG90010101', newIc: '900101015555', pcb: 120 }),
    row({ employmentId: 'b', name: 'Irwin Law', tin: 'SG90010101', newIc: '880808085555', pcb: 95 }),
    row({ employmentId: 'c', name: 'Nur Hidayah', tin: 'SG23607354000', newIc: '910416145530', pcb: 80 }),
  ];

  it('names BOTH people against the number they share — which is the whole deliverable', () => {
    // Naming one of them is useless: the point is to be able to tell WHICH of the two records is wrong.
    const form = cp39FormFrom({ header: header(), rows: shared });
    expect(form.duplicateTaxNumbers).toEqual([{ tin: 'SG90010101', names: ['Aisyah Rahman', 'Irwin Law'] }]);
  });

  it('goes on printing what is filed under each of them, unaltered and undeduped', () => {
    const form = cp39FormFrom({ header: header(), rows: shared });
    const printed = form.pages.flatMap((p) => p.rows);
    expect(printed.map((r) => r.tin)).toEqual(['SG90010101', 'SG90010101', 'SG23607354000']);
    // NOT MERGED, NOT BLANKED, NOT RENUMBERED. A statement that quietly disagreed with the staff record
    // it was built from would be the worse document, and the correction belongs on the record.
    expect(cp39FormTextExport(form).match(/SG90010101/g)).toHaveLength(2);
  });

  it('does not block the download — that is what a MISSING number does, and this is not missing', () => {
    // ONE gate, in the ONE loader all three surfaces share, and it is unchanged: `missing` +
    // `headerMissing`. A duplicate is an advisory beside it, never a fourth reason to refuse.
    expect(SHARED_CODE).toContain('if ((missing.length > 0 || headerMissing.length > 0) && !p.includeIncomplete)');
    expect(SHARED_CODE).not.toContain('duplicate');
    expect(PREVIEW_CODE).toContain('const ready = missing.length === 0 && headerMissing.length === 0;');
    expect(PREVIEW_CODE).toContain('form.duplicateTaxNumbers.length > 0');
  });

  it('never reports employees who have NO tax number as sharing one', () => {
    // Blank numbers are the BLOCKING gate's business. Grouping them here would announce "17 employees
    // share a tax reference number" about seventeen people who have none.
    const form = cp39FormFrom({
      header: header(),
      rows: [
        row({ employmentId: 'a', name: 'NO NUMBER ONE', tin: '', pcb: 10 }),
        row({ employmentId: 'b', name: 'NO NUMBER TWO', tin: '   ', pcb: 10 }),
      ],
    });
    expect(form.duplicateTaxNumbers).toEqual([]);
  });

  it('compares trimmed and case-insensitively, and reports the number as it is filed', () => {
    expect(
      duplicateCp39TaxNumbers([
        row({ employmentId: 'a', name: 'ONE', tin: 'SG90010101' }),
        row({ employmentId: 'b', name: 'TWO', tin: ' sg90010101 ' }),
      ]),
    ).toEqual([{ tin: 'SG90010101', names: ['ONE', 'TWO'] }]);
  });

  it('sees a number shared between somebody the statement prints and somebody it does not', () => {
    // The scan runs over EVERY row the run paid, not the printed subset: the e-Data file emits a record
    // for both of them, and the wrong record is just as wrong when its owner had no deduction.
    const form = cp39FormFrom({
      header: header(),
      rows: [
        row({ employmentId: 'a', name: 'DEDUCTED', tin: 'SG90010101', pcb: 120 }),
        row({ employmentId: 'b', name: 'NOT DEDUCTED', tin: 'SG90010101', pcb: 0, cp38: 0 }),
      ],
    });
    expect(form.pages.flatMap((p) => p.rows)).toHaveLength(1);
    expect(form.duplicateTaxNumbers).toEqual([{ tin: 'SG90010101', names: ['DEDUCTED', 'NOT DEDUCTED'] }]);
  });

  it('survives the two per-generation overrides, which rebuild the form object', () => {
    const form = withPaymentInstrument(
      withPreparer(cp39FormFrom({ header: header(), rows: shared }), { preparerName: 'CHONG PEI YUH' }),
      { paymentRef: '004512' },
    );
    expect(form.duplicateTaxNumbers).toHaveLength(1);
    expect(form.deductedEmployees).toBe(3);
  });

  it('resolves both banner messages in every catalog, with real translations', () => {
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const) {
      const cat = JSON.parse(read(`messages/${locale}.json`)) as {
        payroll: { cp39Form: Record<string, string> };
      };
      const ns = cat.payroll.cp39Form;
      for (const k of ['dupTinTitle', 'dupTinHint', 'deductedOnly', 'noDeductions']) {
        expect(ns[k], `${locale}.payroll.cp39Form.${k}`).toBeTruthy();
      }
      // A stale VALUE is not enforced by the parity check, so pin that these are not copies of English.
      if (locale !== 'en') {
        expect(ns.dupTinHint, `${locale} dupTinHint is still English`).not.toBe(
          (JSON.parse(read('messages/en.json')) as { payroll: { cp39Form: Record<string, string> } }).payroll.cp39Form
            .dupTinHint,
        );
      }
    }
  });
});

describe('7ee14bbc / c99e8358 — the specimen’s provenance, and the one claim it did and did not move', () => {
  /**
   * ⚠️ THIS CASE USED TO ASSERT "the fidelity claim did not move", AND c99e8358 MOVED IT. Read what
   * follows before touching either half.
   *
   * RETIRED: "the masthead and the A/B/C panels are still not drawn, because the specimen is not in this
   * repository". The specimen IS in the repository now (`docs/forms/`), transcribed by hand, and page
   * one is drawn to it — which is what took the catalogue entry from `figures` to `agency-layout`.
   *
   * STILL STANDS, and it is why the paragraph is edited rather than deleted: the PRINCIPLE that kept it
   * undrawn. Printing a government office address, or a statutory instruction panel, FROM MEMORY is
   * inventing a fact about a filing. It stayed undrawn for as long as there was nothing to copy from,
   * and the day somebody deletes that reasoning is the day the next round writes an LHDN panel out of
   * its own head. So the file must still carry it, and must still record that the specimen is another
   * vendor's rendering rather than the agency's artwork.
   */
  it('keeps the refusal that governs every word, and records where the words actually came from', () => {
    // The principle. Not one of these may be deleted just because the panels are drawn now.
    expect(PDF_SRC).toContain('inventing a fact about a filing');
    expect(PDF_SRC).toContain('fabricating the content of a government document');
    // The provenance: a vendor's rendering of the agency's page, named, in both files.
    expect(PDF_SRC).toContain('DXperience v23.2.5');
    expect(read('lib/cp39-form.ts')).toContain('DXperience v23.2.5');
    // And the source that replaced memory, named on the file that draws from it.
    expect(PDF_SRC).toContain('docs/forms/cp39-pin-2015-transcription.txt');
    expect(PDF_SRC).toContain('docs/forms/cp39-pin-2015-specimen.png');
  });

  it('raised fidelity exactly one step, and left the ceiling where it was', () => {
    // A vendor's drawing of the agency's page is still not the agency's page. `agency-layout` is what
    // that earns — the same value the Borang A and Borang 8A specimens earned, for the same reason —
    // and `official` remains unreachable while `public/forms/` holds no CP39.
    expect(MY_REPORTS.find((r) => r.id === 'my.cp39')!.fidelity).toBe('agency-layout');
    expect(MY_REPORTS.filter((r) => r.fidelity === 'official')).toEqual([]);
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /cp\W?39/i.test(f))).toEqual([]);
    expect(PDF_CODE).toContain('bukan borang rasmi LHDN');
  });
});

// ── r209 cp39 FIX ROUND ────────────────────────────────────────────────────────────────────────────
//
// Three defects the adversarial verification found in 7ee14bbc's first build. Two of them were things
// that WORKED BEFORE AND DID NOT AFTER — a false sentence printed on the document, and a warning that
// fired on correct data — which is the worse kind, and they come first.

describe('r209 — the document never claims a reconciliation that can be false', () => {
  /**
   * THE ORDINARY CASE THAT MAKES THE OLD SENTENCE A LIE: one employee on PCB, a DIFFERENT employee on a
   * CP38 instalment (a Personnel-entered court/LHDN instalment on somebody whose MTD is nil), and one
   * paid with neither. Two rows print; Bilangan Pekerja reads 1 and 1. The first build printed
   * "bilangan baris sepadan dengan Bilangan Pekerja di atas" under exactly that — a false assurance
   * about the very disagreement 7ee14bbc was raised about.
   */
  const split: Cp39FormRow[] = [
    row({ employmentId: 'a', personId: 'p1', name: 'PCB ONLY', tin: 'SG1', pcb: 110.5, cp38: 0 }),
    row({ employmentId: 'b', personId: 'p2', name: 'CP38 ONLY', tin: 'SG2', pcb: 0, cp38: 250 }),
    row({ employmentId: 'c', personId: 'p3', name: 'NEITHER', tin: 'SG3', pcb: 0, cp38: 0 }),
  ];
  const form = () => cp39FormFrom({ header: header(), rows: split });
  /** Every drawn run joined back into one string — `wrap` splits the sentence across drawn lines. */
  const flat = (drawn: string[]) => drawn.join(' ').replace(/\s+/g, ' ');

  it('is the case the claim is false in: 2 rows, and neither Bilangan Pekerja is 2', () => {
    const f = form();
    expect(f.deductedEmployees).toBe(2);
    expect(f.pcbEmployees).toBe(1);
    expect(f.cp38Employees).toBe(1);
    expect(f.pages.flatMap((p) => p.rows)).toHaveLength(2);
  });

  it('says how many rows there are and NOT that they match the Bilangan Pekerja figures', () => {
    const note = cp39ScheduleScopeNote(form());
    expect(note).toContain('Senarai pekerja: 2 daripada 3');
    // The false half, gone from the sentence itself…
    expect(note).not.toMatch(/sepadan dengan Bilangan Pekerja/);
    // …and replaced by the relation that IS true at 1, 1 and 2.
    expect(note).toContain('sekurang-kurangnya satu potongan');
  });

  it('prints that sentence, not the old one, on the drawn page AND in the text export', async () => {
    const f = form();
    const drawn = flat(await drawnText(await renderCp39FormPdf(f)));
    const txt = cp39FormTextExport(f);
    for (const surface of [drawn, txt]) {
      expect(surface).toContain('Senarai pekerja: 2 daripada 3');
      expect(surface, 'the false reconciliation must not survive on any printed surface').not.toMatch(
        /sepadan dengan Bilangan Pekerja/,
      );
      expect(surface).toContain('sekurang-kurangnya satu potongan');
    }
  });

  it('carries ONE sentence, so the page and the text export cannot drift apart', async () => {
    const f = form();
    const note = cp39ScheduleScopeNote(f);
    expect(cp39FormTextExport(f)).toContain(note);
    // The drawn page wraps it, so compare word-wise rather than as one run.
    expect(flat(await drawnText(await renderCp39FormPdf(f)))).toContain(note.slice(0, 60));
  });

  it('never tells any of the six catalogs that the row count always matches the two counts', () => {
    // The sentence exists on the REVIEW SCREEN too, once per language, and the English one said "the
    // number of rows always matches the Bilangan Pekerja figures above". Frozen per locale so a revert
    // fails here and not only in Malay.
    const FALSE_CLAIM: Record<string, string> = {
      en: 'always matches the Bilangan Pekerja',
      ms: 'sentiasa sepadan dengan angka Bilangan Pekerja',
      ta: 'எப்போதும் ஒத்துப்போகும்',
      th: 'ตรงกับตัวเลข Bilangan Pekerja ด้านบนเสมอ',
      vi: 'luôn khớp với các con số Bilangan Pekerja',
      zh: '始终与上方的 Bilangan Pekerja 人数一致',
    };
    for (const [locale, claim] of Object.entries(FALSE_CLAIM)) {
      const cat = JSON.parse(read(`messages/${locale}.json`)) as { payroll: { cp39Form: Record<string, string> } };
      expect(cat.payroll.cp39Form.deductedOnly, `${locale}.deductedOnly still carries the false claim`).not.toContain(
        claim,
      );
    }
    // …and the English one states the true relation instead of a false equality.
    expect((en.payroll as { cp39Form: Record<string, string> }).cp39Form.deductedOnly).toContain(
      'at least one deduction',
    );
  });

  it('does not leave the false claim in the model’s own documentation either', () => {
    // A false comment is how the next round reintroduces the sentence.
    expect(read('lib/cp39-form.ts')).not.toContain('THIS IS THE FIGURE THAT MUST AGREE WITH THE HEADER');
    expect(read('lib/cp39-form.ts')).toContain('IT IS THE UNION');
  });
});

describe('r209 — a tax number is a PERSON’s, so one person’s two employments are not a duplicate', () => {
  /**
   * THE FALSE ALARM: `employee_statutory_my` is keyed on `person_id` (uniqueIndex
   * `employee_statutory_my_person_uq`), while a CP39 row is an EMPLOYMENT. One person holding two
   * concurrent employments in one company — supported and tested elsewhere in this suite — therefore
   * arrives as two rows with the SAME tax number by construction. The first build reported that as a
   * duplicate, printed the person's name twice, and told the operator to "correct whichever record is
   * wrong" about a single, correct record.
   */
  const twoJobs: Cp39FormRow[] = [
    row({ employmentId: 'e1', personId: 'p1', name: 'ALI BIN ABU', tin: 'IG25834425022', newIc: '900101015555', pcb: 120 }),
    row({ employmentId: 'e2', personId: 'p1', name: 'ALI BIN ABU', tin: 'IG25834425022', newIc: '900101015555', pcb: 80 }),
  ];

  it('reports nothing for one person paid on two employments', () => {
    expect(duplicateCp39TaxNumbers(twoJobs)).toEqual([]);
    const form = cp39FormFrom({ header: header(), rows: twoJobs });
    expect(form.duplicateTaxNumbers).toEqual([]);
    // BOTH rows still print, and both still print the number as filed. The warning was wrong; the
    // statement was not.
    expect(form.pages.flatMap((p) => p.rows).map((r) => r.employmentId)).toEqual(['e1', 'e2']);
    expect(form.deductedEmployees).toBe(2);
  });

  it('STILL reports two different people under one number — the real defect is untouched', () => {
    const real = [
      row({ employmentId: 'e1', personId: 'p1', name: 'Aisyah Rahman', tin: 'SG90010101', newIc: '900101015555', pcb: 120 }),
      row({ employmentId: 'e2', personId: 'p2', name: 'Irwin Law', tin: 'SG90010101', newIc: '880808085555', pcb: 95 }),
    ];
    expect(duplicateCp39TaxNumbers(real)).toEqual([{ tin: 'SG90010101', names: ['Aisyah Rahman', 'Irwin Law'] }]);
  });

  it('names each person ONCE even when they hold two of the employments in the group', () => {
    // Otherwise the banner reads "SG90010101 — Aisyah Rahman · Aisyah Rahman · Irwin Law", which reads
    // as three records to check.
    expect(
      duplicateCp39TaxNumbers([
        row({ employmentId: 'e1', personId: 'p1', name: 'Aisyah Rahman', tin: 'SG90010101', pcb: 120 }),
        row({ employmentId: 'e2', personId: 'p1', name: 'Aisyah Rahman', tin: 'SG90010101', pcb: 40 }),
        row({ employmentId: 'e3', personId: 'p2', name: 'Irwin Law', tin: 'SG90010101', pcb: 95 }),
      ]),
    ).toEqual([{ tin: 'SG90010101', names: ['Aisyah Rahman', 'Irwin Law'] }]);
  });

  it('falls back to identity card AND name together when the caller supplies no person', () => {
    const sameCard = [
      row({ employmentId: 'e1', name: 'ALI BIN ABU', tin: 'IG1', newIc: '900101015555' }),
      row({ employmentId: 'e2', name: 'ALI BIN ABU', tin: 'IG1', newIc: '900101015555' }),
    ];
    expect(duplicateCp39TaxNumbers(sameCard), 'same card, same name ⇒ one person').toEqual([]);
    const namesakes = [
      row({ employmentId: 'e1', name: 'ALI BIN ABU', tin: 'IG1', newIc: '900101015555' }),
      row({ employmentId: 'e2', name: 'ALI BIN ABU', tin: 'IG1', newIc: '880808085555' }),
    ];
    // Different card ⇒ two people, however alike the names. Never the card alone and never the name
    // alone: either one on its own fuses a pair the other one separates.
    expect(duplicateCp39TaxNumbers(namesakes)).toEqual([{ tin: 'IG1', names: ['ALI BIN ABU', 'ALI BIN ABU'] }]);
  });

  it('still counts ROWS when a row says nothing at all about who it is', () => {
    // Knowing nothing must be the LOUD answer, not a silent suppression.
    expect(
      duplicateCp39TaxNumbers([
        row({ employmentId: 'e1', name: '', tin: 'IG1', newIc: '' }),
        row({ employmentId: 'e2', name: '', tin: 'IG1', newIc: '' }),
      ]),
    ).toEqual([{ tin: 'IG1', names: ['', ''] }]);
  });

  it('is fed a real personId by the READ, which is the half a unit test of the model cannot see', () => {
    // The contract lives BETWEEN two files (AGENTS rule 17): the model can only tell people apart if the
    // read puts a person on the row. Both halves pinned.
    expect(READ_CODE).toContain('personId: employment.personId');
    expect(READ_CODE).toContain('personId: r.personId');
    expect(REPORTS_CODE).toContain("personId: x?.personId ?? ''");
    expect(LIB_CODE).toContain('personId: str(r.personId)');
  });
});

describe('r209 — unfinished employee names are warned about before filing, as the plan promised', () => {
  it.each([['TEST0001'], ['TEST'], ['TEST_1'], ['Test User'], ['test 12'], ['   ']])(
    'flags "%s" as a name that is not yet a name',
    (name) => {
      expect(unfinishedCp39Names([row({ employmentId: 'a', name })]).map((u) => u.name)).toHaveLength(1);
    },
  );

  it.each([['ANG PEI YEE'], ['TESTA BINTI OSMAN'], ['Testani Rahman'], ['Ernest Testman']])(
    'leaves the real name "%s" alone — a false accusation costs more than a missed placeholder',
    (name) => {
      expect(unfinishedCp39Names([row({ employmentId: 'a', name })])).toEqual([]);
    },
  );

  it('carries the employee number, because a BLANK name leaves nothing else to find them by', () => {
    expect(unfinishedCp39Names([row({ employmentId: 'a', name: '', employeeNo: 'EMP0042' })])).toEqual([
      { employmentId: 'a', name: '', employeeNo: 'EMP0042' },
    ]);
  });

  it('reaches the form and the review screen, scanning everyone PAID and not only the printed rows', () => {
    const form = cp39FormFrom({
      header: header(),
      rows: [
        row({ employmentId: 'a', personId: 'p1', name: 'TEST0001', tin: 'SG1', pcb: 120 }),
        row({ employmentId: 'b', personId: 'p2', name: 'TEST0002', tin: 'SG2', pcb: 0, cp38: 0 }),
        row({ employmentId: 'c', personId: 'p3', name: 'ANG PEI YEE', tin: 'SG3', pcb: 90 }),
      ],
    });
    // The e-Data file carries a name for everybody the run paid, so an unfinished one is just as wrong
    // on somebody the printed schedule leaves out.
    expect(form.unfinishedNames.map((u) => u.name)).toEqual(['TEST0001', 'TEST0002']);
    expect(PREVIEW_CODE).toContain("t('unfinishedNameTitle'");
    expect(PREVIEW_CODE).toContain("t('unfinishedNameHint')");
    expect(PREVIEW_CODE).toContain('form.unfinishedNames.length > 0');
  });

  it('counts one person once, however many employments they hold', () => {
    const form = cp39FormFrom({
      header: header(),
      rows: [
        row({ employmentId: 'e1', personId: 'p1', name: 'TEST0001', pcb: 120 }),
        row({ employmentId: 'e2', personId: 'p1', name: 'TEST0001', pcb: 60 }),
      ],
    });
    expect(form.unfinishedNames).toHaveLength(1);
  });

  it('NEVER blocks the download, and never appears on the document itself', () => {
    // Same standing as the duplicate-number banner: it is their data, the statement prints the name on
    // file, and the correction belongs on the staff record. Our OPINION about a staff record is not
    // something a signed statutory statement gets to publish.
    expect(SHARED_CODE).not.toContain('unfinished');
    expect(PREVIEW_CODE).toContain('const ready = missing.length === 0 && headerMissing.length === 0;');
    expect(PDF_CODE).not.toContain('unfinishedNames');
    expect(LIB_CODE.slice(LIB_CODE.indexOf('export function cp39FormTextExport'))).not.toContain('unfinishedNames');
  });

  it('resolves both messages in every catalog, with real translations', () => {
    const enNs = (JSON.parse(read('messages/en.json')) as { payroll: { cp39Form: Record<string, string> } }).payroll
      .cp39Form;
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const) {
      const ns = (JSON.parse(read(`messages/${locale}.json`)) as { payroll: { cp39Form: Record<string, string> } })
        .payroll.cp39Form;
      for (const k of ['unfinishedNameTitle', 'unfinishedNameHint']) {
        expect(ns[k], `${locale}.payroll.cp39Form.${k}`).toBeTruthy();
      }
      if (locale !== 'en') {
        expect(ns.unfinishedNameHint, `${locale} unfinishedNameHint is still English`).not.toBe(
          enNs.unfinishedNameHint,
        );
      }
    }
  });
});

/**
 * ── c99e8358 — PAGE ONE, MEASURED ────────────────────────────────────────────────────────────────
 *
 * The cover is now a drawn FORM rather than a stack of headings, and a drawn form fails in a way no
 * unit test of the model can see: pdf-lib does not clip, so a caption one point too wide prints into the
 * panel beside it and the page still renders, still returns 200 and still downloads. Worse on this
 * particular page, PCB and CP 38 are two adjacent columns of nearly equal width carrying two different
 * amounts — the transposition that shipped a wrong KWSP file in an earlier round — and no assertion
 * about the totals object can tell them apart. So these read the POSITIONS off the drawn page.
 */
type CoverRun = { text: string; x: number; y: number; size: number; bold: boolean };

/**
 * Every text run on the ONE content stream that carries `marker`, WITH the position it was drawn at.
 *
 * `drawnText` above answers "does this string appear anywhere in the document", which cannot tell a
 * figure in the PCB column from the same figure in the CP 38 column beside it. pdf-lib writes each run
 * as `/<font> <size> Tf … 1 0 0 1 <x> <y> Tm <hex> Tj`, so the operators carry the font, the size and
 * the origin. The page is found by its marker rather than by index, so inserting a page ahead of it
 * cannot silently make these assertions measure a different sheet.
 */
async function drawnRunsOn(bytes: Uint8Array, marker: string): Promise<CoverRun[]> {
  const doc = await PDFDocument.load(bytes);
  const re =
    /\/(Helvetica[A-Za-z0-9-]*)\s+([\d.]+)\s+Tf|1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]+)>\s*Tj/g;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const raw = (obj as unknown as { contents?: Uint8Array }).contents;
    if (!raw) continue;
    let stream: string;
    try {
      stream = zlib.inflateSync(Buffer.from(raw)).toString('latin1');
    } catch {
      stream = Buffer.from(raw).toString('latin1');
    }
    const runs: CoverRun[] = [];
    let size = 0;
    let bold = false;
    for (const m of stream.matchAll(re)) {
      if (m[1] !== undefined) {
        bold = m[1].includes('Bold');
        size = Number(m[2]);
        continue;
      }
      runs.push({
        text: Buffer.from(m[5], 'hex').toString('latin1'),
        x: Number(m[3]),
        y: Number(m[4]),
        size,
        bold,
      });
    }
    if (runs.some((r) => r.text.includes(marker))) return runs;
  }
  throw new Error(`no content stream carries "${marker}"`);
}

describe('c99e8358 — page one is the Borang CP39 (Pin.2015) arrangement, drawn from the specimen', () => {
  const X = CP39_COVER.x;
  const Y = CP39_COVER.yTop;

  /**
   * FOUR FIGURES THAT ARE ALL DIFFERENT, WHICH IS THE ONLY WAY A TRANSPOSITION IS VISIBLE. PCB
   * 15,374.70 over three people, CP38 250.00 over one. Swap either pair and the page still adds up.
   */
  const split: Cp39FormRow[] = [
    row({ employmentId: 'a', personId: 'p1', name: 'SATU', tin: 'SG1', pcb: 15000, cp38: 0 }),
    row({ employmentId: 'b', personId: 'p2', name: 'DUA', tin: 'SG2', pcb: 300, cp38: 0 }),
    row({ employmentId: 'c', personId: 'p3', name: 'TIGA', tin: 'SG3', pcb: 74.7, cp38: 250 }),
  ];

  /** Runs on the cover, each carrying its width and its distance from the TOP edge. */
  type Measured = CoverRun & { top: number; w: number };
  async function cover(form: Parameters<typeof renderCp39FormPdf>[0]): Promise<Measured[]> {
    const d = await PDFDocument.create();
    const reg = await d.embedFont(StandardFonts.Helvetica);
    const bld = await d.embedFont(StandardFonts.HelveticaBold);
    const runs = await drawnRunsOn(await renderCp39FormPdf(form), 'BUTIR-BUTIR MAJIKAN');
    return runs.map((r) => ({
      ...r,
      // CP39_COVER is written from the top edge, the way the specimen reads; pdf-lib draws from the foot.
      top: CP39_COVER.H - r.y,
      w: (r.bold ? bld : reg).widthOfTextAtSize(r.text, r.size),
    }));
  }
  /** The three panels of the middle band, as the drawn page tiles them. */
  const panels = [
    { key: 'BUTIR-BUTIR MAJIKAN', x0: X.left, x1: X.panel1Right },
    { key: 'BUTIR-BUTIR PEMBAYARAN', x0: X.panel1Right, x1: X.panel2Right },
    { key: 'PEGAWAI YANG MENYEDIAKAN MAKLUMAT', x0: X.panel2Right, x1: X.right },
  ];
  /** Everything drawn strictly inside the rectangle (x0, x1] x (t0, t1] — i.e. inside one CELL. */
  const cell = (runs: Measured[], x0: number, x1: number, t0: number, t1: number) =>
    runs
      .filter((r) => r.top > t0 && r.top <= t1 && r.x >= x0 - 0.5 && r.x + r.w <= x1 + 0.5)
      .map((r) => r.text);
  const flat = (runs: Measured[]) => runs.map((r) => r.text).join(' ').replace(/\s+/g, ' ');

  it('is exactly ONE landscape page, and the employee schedule stays A4 portrait behind it', async () => {
    const form = cp39FormFrom({ header: header(), rows: split, perPage: 2 });
    expect(form.pages).toHaveLength(2);
    const doc = await PDFDocument.load(await renderCp39FormPdf(form));
    expect(doc.getPageCount()).toBe(1 + form.pages.length);

    const one = doc.getPage(0).getSize();
    expect(one.width).toBeCloseTo(CP39_COVER.W, 2);
    expect(one.height).toBeCloseTo(CP39_COVER.H, 2);
    expect(one.width, 'the cover is landscape').toBeGreaterThan(one.height);
    // …and NOTHING else turned landscape with it. Ten columns were tiled for portrait.
    for (let i = 1; i < doc.getPageCount(); i += 1) {
      const s = doc.getPage(i).getSize();
      expect(s.width, `sheet ${i} must stay portrait`).toBeLessThan(s.height);
      expect(s.width).toBeCloseTo(595.28, 2);
      expect(s.height).toBeCloseTo(841.89, 2);
    }
  });

  /** Fails the named panel when a run straddles a divider or hangs outside the band entirely. */
  const everyRunInItsOwnPanel = (runs: Measured[]) => {
    const inBand = runs.filter((r) => r.top >= Y.bandTop && r.top <= Y.bandBottom + 2);
    expect(inBand.length, 'the band must actually carry the employer, payment and preparer boxes').toBeGreaterThan(25);
    for (const r of inBand) {
      const home = panels.filter((p) => r.x >= p.x0 - 0.5 && r.x + r.w <= p.x1 + 0.5);
      expect(
        home.map((p) => p.key),
        `"${r.text}" spans ${r.x.toFixed(1)}..${(r.x + r.w).toFixed(1)} and is not inside one panel`,
      ).toHaveLength(1);
    }
  };

  it('tiles the band into three panels, and every caption in it is inside its own panel', async () => {
    expect(panels[0].x0).toBeGreaterThanOrEqual(0);
    expect(panels[2].x1).toBeLessThanOrEqual(CP39_COVER.W);
    for (let i = 1; i < panels.length; i += 1) {
      expect(panels[i].x0, `${panels[i].key} overlaps ${panels[i - 1].key}`).toBeGreaterThanOrEqual(
        panels[i - 1].x1,
      );
    }

    const d = await PDFDocument.create();
    const bld = await d.embedFont(StandardFonts.HelveticaBold);
    for (const p of panels) {
      expect(
        bld.widthOfTextAtSize(p.key, CP39_COVER_HEADING_SIZE),
        `the "${p.key}" heading does not fit its own panel`,
      ).toBeLessThanOrEqual(p.x1 - p.x0 - 4);
    }

    everyRunInItsOwnPanel(await cover(cp39FormFrom({ header: header(), rows: split })));
  });

  /**
   * ⚠️ THE VALUE THAT DOES NOT FIT — the failure a panelled form has and a full-width sheet does not.
   *
   * pdf-lib does not clip. 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR' measures 231pt at the
   * cover's value size and the Nama Syarikat rule is 173pt wide, so an unshrunk legal name prints 58pt
   * through the divider and lands ON TOP of the PCB figures in the panel beside it. The fix is to shrink
   * and never to truncate: a clean truncation would satisfy every geometry assertion here and be far
   * worse than an overprint, because a shorter company name reads as the company's name.
   */
  it('shrinks a long name, title or amount rather than printing it into the next panel', async () => {
    const long = header({
      employerName: 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR',
      registrationNo: '199801012345 (123456-X) CAWANGAN SABAH',
      preparerName: 'NURUL SYAFIQAH BINTI MOHAMMED ZULKARNAIN ABDULLAH',
      preparerPosition: 'ASSISTANT PAYROLL MANAGER, HUMAN RESOURCES SHARED SERVICES',
      employerAddress: [
        'Tingkat 12, Menara Perbadanan Pembangunan Pertanian',
        'Jalan Sultan Salahuddin Abdul Aziz Shah',
        'Seksyen 14, Bandar Baru',
        '40000 Shah Alam, Selangor Darul Ehsan',
      ].join('\n'),
    });
    // A payroll big enough that the amounts are long too — they are right-aligned, so an unshrunk one
    // backs OUT of its cell leftwards into the column beside it, which is the same defect mirrored.
    const big = [row({ employmentId: 'a', pcb: 12345678.9, cp38: 987654.32 })];
    const runs = await cover(cp39FormFrom({ header: long, rows: big }));
    everyRunInItsOwnPanel(runs);

    // …and every one of them is printed WHOLE. Nothing here may reach the page as a shorter company.
    const drawn = runs.map((r) => r.text);
    expect(drawn).toContain('PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR');
    expect(drawn).toContain('NURUL SYAFIQAH BINTI MOHAMMED ZULKARNAIN ABDULLAH');
    expect(drawn).toContain('ASSISTANT PAYROLL MANAGER, HUMAN RESOURCES SHARED SERVICES');
    expect(drawn).toContain('Tingkat 12, Menara Perbadanan Pembangunan Pertanian');
    expect(drawn).toContain('12,345,678.90');
    expect(drawn).toContain('987,654.32');
    // The shrink is real rather than the values happening to fit: the name is set smaller than the box.
    const name = runs.find((r) => r.text === 'PERBADANAN PEMBANGUNAN PERTANIAN NEGERI SELANGOR')!;
    expect(name.size).toBeLessThan(7.5);
    expect(name.size, 'shrunk to invisible is silent loss too').toBeGreaterThanOrEqual(1);
  });

  it('never draws a single run off the edge of the sheet', async () => {
    const runs = await cover(cp39FormFrom({ header: header(), rows: split }));
    for (const r of runs) {
      expect(r.x, `"${r.text}" starts left of the sheet`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, `"${r.text}" runs off the right edge`).toBeLessThanOrEqual(CP39_COVER.W);
      expect(r.y, `"${r.text}" falls off the foot of the sheet`).toBeGreaterThanOrEqual(0);
      expect(r.y + r.size, `"${r.text}" is drawn above the head of the sheet`).toBeLessThanOrEqual(CP39_COVER.H);
    }
  });

  /**
   * ⚠️ THE ONE THAT MATTERS. Not "do the totals add up" — they always did — but WHICH CELL each figure
   * landed in. Two adjacent columns of nearly equal width, four figures, and a page that reads as
   * perfectly normal whichever way round they go.
   */
  it('puts each amount and each count in its OWN column of the payment panel', async () => {
    const form = cp39FormFrom({ header: header(), rows: split });
    expect(form.totalPcb).toBe(15374.7);
    expect(form.totalCp38).toBe(250);
    expect(form.pcbEmployees).toBe(3);
    expect(form.cp38Employees).toBe(1);
    expect(form.totalAmount).toBe(15624.7);

    const runs = await cover(form);
    const pcbCol = [X.payLabelRight, X.payPcbRight] as const;
    const cp38Col = [X.payPcbRight, X.panel2Right] as const;
    const jumlah = [Y.payHeadBottom, Y.payJumlahBottom] as const;
    const bilangan = [Y.payJumlahBottom, Y.payBilanganBottom] as const;

    // Jumlah Potongan: the PCB figure under PCB, the CP38 figure under CP 38, and NEITHER under the other.
    expect(cell(runs, ...pcbCol, ...jumlah)).toContain('15,374.70');
    expect(cell(runs, ...pcbCol, ...jumlah), 'the CP38 total is in the PCB column').not.toContain('250.00');
    expect(cell(runs, ...cp38Col, ...jumlah)).toContain('250.00');
    expect(cell(runs, ...cp38Col, ...jumlah), 'the PCB total is in the CP 38 column').not.toContain('15,374.70');

    // Bilangan Pekerja: 3 under PCB and 1 under CP 38, which is the same trap one row down.
    expect(cell(runs, ...pcbCol, ...bilangan)).toContain('3');
    expect(cell(runs, ...pcbCol, ...bilangan), 'the CP38 headcount is in the PCB column').not.toContain('1');
    expect(cell(runs, ...cp38Col, ...bilangan)).toContain('1');
    expect(cell(runs, ...cp38Col, ...bilangan), 'the PCB headcount is in the CP 38 column').not.toContain('3');

    // And the column headings are over the columns they name, not the other way round.
    expect(cell(runs, ...pcbCol, Y.bandHeadBottom, Y.payHeadBottom)).toEqual(['PCB']);
    expect(cell(runs, ...cp38Col, Y.bandHeadBottom, Y.payHeadBottom)).toEqual(['CP 38']);
  });

  it('carries Amaun and Tarikh, and a rule rather than a figure where the operator writes', async () => {
    const form = cp39FormFrom({ header: header(), rows: split });
    const runs = await cover(form);
    const val = [X.payInstrLabelRight, X.panel2Right] as const;
    const rowH = (Y.bandBottom - Y.payBilanganBottom) / 4;
    const at = (i: number) => [Y.payBilanganBottom + i * rowH, Y.payBilanganBottom + (i + 1) * rowH] as const;

    expect(cell(runs, ...val, ...at(0))).toContain('15,624.70');
    // AGENTS rule 28: Nombor and Cawangan are the operator's to write. An empty rule asserts nothing;
    // a printed 0.00 or a placeholder there would assert something about the payment that is not true.
    expect(cell(runs, ...val, ...at(1)), 'Nombor must be a rule to write on, not a printed value').toEqual([]);
    expect(cell(runs, ...val, ...at(2)), 'Cawangan must be a rule to write on, not a printed value').toEqual([]);
    expect(cell(runs, ...val, ...at(3))).toContain('18/08/2026');

    // …and when the operator HAS typed the instrument in, it prints in those same two rows.
    const typed = await cover(withPaymentInstrument(form, { paymentRef: 'CHQ 004512', paymentBranch: 'MAYBANK PJ' }));
    expect(cell(typed, ...val, ...at(1))).toContain('CHQ 004512');
    expect(cell(typed, ...val, ...at(2))).toContain('MAYBANK PJ');
  });

  it('prints 0.00 for a month with no CP38, because that is what the specimen prints there', async () => {
    // The specimen's own employer had no CP38 instalments and its CP 38 cell reads RM 0.00. Here the
    // figure IS zero and the form derives it, so printing it states something true — which is the other
    // half of rule 28, and the reason the Nombor rule above stays empty instead.
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a', pcb: 110.5, cp38: 0 })] });
    expect(form.totalCp38).toBe(0);
    const runs = await cover(form);
    const cp38Col = [X.payPcbRight, X.panel2Right] as const;
    expect(cell(runs, ...cp38Col, Y.payHeadBottom, Y.payJumlahBottom)).toContain('0.00');
    expect(cell(runs, ...cp38Col, Y.payJumlahBottom, Y.payBilanganBottom)).toContain('0');
  });

  it('draws the masthead, the citations and the period boxes in the specimen’s own words', async () => {
    const runs = await cover(cp39FormFrom({ header: header(), rows: split }));
    const page = flat(runs);
    for (const s of [
      'Borang ini boleh difotokopi',
      'CP39 Pin.2015',
      'KETUA PENGARAH HASIL DALAM NEGERI',
      'LEMBAGA HASIL DALAM NEGERI',
      'Pusat Bayaran Kuala Lumpur',
      'Kaunter Bayaran Dan Tingkat 1, Blok 8A',
      'Kompleks Bangunan Kerajaan, Jalan Duta',
      '50600 KUALA LUMPUR',
      'CUKAI PENDAPATAN MALAYSIA',
      'PENYATA POTONGAN CUKAI OLEH MAJIKAN',
      '[SEKSYEN 107 AKTA CUKAI PENDAPATAN, 1967',
      'KAEDAH CUKAI PENDAPATAN (POTONGAN DARIPADA',
      'SARAAN), 1994]',
      'UNTUK KEGUNAAN PEJABAT',
      'POTONGAN BAGI BULAN',
      'TAHUN',
    ]) {
      expect(page, `the cover must carry "${s}"`).toContain(s);
    }
    // The month is Malay and upper case IN ITS OWN BOX, whatever language the operator reads the screen
    // in — and the year is in the box beside it, not folded into the same run.
    const period = runs.filter((r) => r.top > Y.mastheadBottom - 18 && r.top <= Y.mastheadBottom);
    expect(period.map((r) => r.text)).toEqual(
      expect.arrayContaining(['POTONGAN BAGI BULAN', 'JANUARI', 'TAHUN', '2026']),
    );
    // UNTUK KEGUNAAN PEJABAT is the AGENCY's box: two ruled lines and not one character we supplied.
    const office = runs.filter((r) => r.x >= X.officeLeft && r.top >= Y.boxTop && r.top <= Y.officeBottom);
    expect(office.map((r) => r.text).sort()).toEqual(['No. Kelompok', 'No. Resit', 'UNTUK KEGUNAAN PEJABAT']);
  });

  /**
   * THE NON-FABRICATION GUARD. Every sentence checked here must appear BOTH on the drawn page AND in
   * `docs/forms/cp39-pin-2015-transcription.txt` — which is what "transcribed, not remembered" means in
   * a form a test can hold. If somebody later "tidies" the specimen's own doubled "CP38 - CP38 -" or its
   * "borang in lieu of CP39", the two sides stop matching and this fails.
   */
  it('reproduces the A / B / C panels verbatim from the transcription in the repository', async () => {
    const transcript = read('docs/forms/cp39-pin-2015-transcription.txt').replace(/\s+/g, ' ');
    const page = flat(await cover(cp39FormFrom({ header: header(), rows: split })));
    for (const s of [
      'Borang ini mesti diisi dengan lengkap dan betul.',
      'Contoh: SG 2506203-00(0) boleh diisi sebagai SG 02506203000',
      'Borang CP22 atau borang in lieu of CP39 dikemukakan ke cawangan LHDNM yang berdekatan.',
      'Nombor Pengenalan : Isikan kedua-dua nombor kad pengenalan baru dan lama (sekiranya ada).',
      'CP38 - CP38 - Isikan amaun potongan cukai mengikut arahan Borang CP38 (jika ada).',
      'Pastikan jumlah potongan PCB/CP38 adalah betul dan sama dengan nilai instrumen bayaran.',
      'Untuk bayaran bagi Negeri Sabah, sila alamatkan ke:',
      '88600 Kota Kinabalu, Sabah',
      '93100 Kuching, Sarawak',
      'Sila hubungi talian 1-800-88-LHDN (5436) untuk sebarang pertanyaan lanjut.',
      'Jika jumlah instrumen bayaran tidak sama dengan jumlah potongan, bayaran akan ditolak.',
      'Sekiranya maklumat tidak lengkap dan tidak betul, majikan akan dikenakan kompaun.',
    ]) {
      expect(transcript, `"${s}" must come from the transcription, not from memory`).toContain(s);
      expect(page, `"${s}" must be printed on the page`).toContain(s);
    }
    // The panels' own headings, and the letters that index them.
    for (const s of ['BORANG CP 39', 'PEMBAYARAN', 'PERINGATAN']) expect(page).toContain(s);
    // Malay on EVERY locale — the notes are constants, not messages, and there is nothing to translate.
    expect(PDF_CODE).not.toContain('useTranslations');
    expect([...CP39_NOTE_A, ...CP39_NOTE_B, ...CP39_NOTE_B_SABAH, ...CP39_NOTE_B_SARAWAK, ...CP39_NOTE_B_TAIL,
      ...CP39_NOTE_C].every((l) => l.length > 0)).toBe(true);
  });

  it('keeps A out of the B/C column, and the whole notes band on the sheet', async () => {
    const runs = await cover(cp39FormFrom({ header: header(), rows: split }));
    const notes = runs.filter((r) => r.top >= Y.noteHeadTop - 1 && r.top < Y.footTop - 6);
    expect(notes.length, 'the A / B / C panels must actually be on the page').toBeGreaterThan(40);
    for (const r of notes) {
      if (r.x < X.noteBLeft) {
        expect(r.x, `"${r.text}" starts left of the A column`).toBeGreaterThanOrEqual(X.left - 0.5);
        expect(r.x + r.w, `"${r.text}" runs out of the A column into B`).toBeLessThanOrEqual(X.noteBLeft - 2);
      } else {
        expect(r.x + r.w, `"${r.text}" runs off the right edge of the B / C column`).toBeLessThanOrEqual(
          X.right + 0.5,
        );
      }
    }
    // C's heading sits below B's last line and above the provenance strip — the r205 Borang A failure is
    // a caption drawn at whatever y a loop left behind, and only a measurement or a picture sees it.
    const cHead = notes.find((r) => r.text === 'PERINGATAN')!;
    const bLast = Math.max(...notes.filter((r) => r.x >= X.noteBLeft && r.top < Y.noteCHeadTop - 4).map((r) => r.top));
    expect(cHead.top).toBeGreaterThan(bLast);
    expect(Math.max(...notes.map((r) => r.top)), 'the notes must not run into the provenance strip').toBeLessThan(
      Y.footTop - 6,
    );
    expect(Math.max(...runs.map((r) => r.top)), 'nothing may print past the foot margin').toBeLessThan(
      CP39_COVER.H - 8,
    );
  });
});
