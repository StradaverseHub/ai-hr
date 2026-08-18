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
import {
  CP39_FORM_HEADER_KEYS,
  CP39_FORM_ROWS_PER_PAGE,
  cp39DeductionPeriodFor,
  cp39FormFilename,
  cp39FormFrom,
  cp39FormTextExport,
  deductionMonthLabel,
  formDate,
  isCp39PeriodKey,
  missingCp39FormHeader,
  missingCp39Preparer,
  money,
  paginateCp39,
  withPreparer,
  type Cp39FormRow,
} from '../lib/cp39-form';
import { CP39_HEADING_SIZE, CP39_TABLE_COLUMNS, renderCp39FormPdf } from '../lib/cp39-form-pdf';
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

describe('the two columns we cannot fill stay blank', () => {
  /**
   * THIS IS THE ASSERTION THAT PROTECTS A TAX DOCUMENT FROM A GUESS. There is no old-identity-card
   * column in the schema, and the passport's issuing country is free text rather than the ISO-2 code
   * Kod Negara wants. The approved plan says leave both blank. A later "improvement" that mapped country
   * text to a code would put a WRONG statutory code beside somebody's tax reference number, and it would
   * look completely normal on the page.
   */
  it('never populates No. K/P Lama or Kod Negara, whatever the read hands over', () => {
    const form = cp39FormFrom({
      header: header(),
      // Even if a read one day started supplying them, the READ is where that decision would have to be
      // taken deliberately — this asserts today's read supplies neither.
      rows: [{ employmentId: 'x', name: 'X', tin: 'SG1', pcb: 1, cp38: 0 }],
    });
    expect(form.pages[0].rows[0].oldIc).toBe('');
    expect(form.pages[0].rows[0].countryCode).toBe('');
  });

  it('is the READ that emits them blank, with the reason recorded beside it', () => {
    // Source-shape, because the defect would live in the contract BETWEEN the read and the model, where
    // a unit test of either half passes throughout (AGENTS rule 17).
    expect(READ_CODE).toContain("countryCode: ''");
    expect(READ_CODE).toContain("oldIc: ''");
    expect(REPORTS_CODE).toContain("countryCode: ''");
    expect(REPORTS_CODE).toContain("oldIc: ''");
    // …and no name→ISO-2 mapping was smuggled in anywhere on the path.
    expect(READ_CODE).not.toContain('passportIssuingCountry');
  });

  it('says so on the page and in the text export, so a blank column does not read as a bug', () => {
    const form = cp39FormFrom({ header: header(), rows: [row({ employmentId: 'a' })] });
    const txt = cp39FormTextExport(form);
    expect(txt).toContain('No. K/P Lama');
    expect(txt).toContain('Kod Negara');
    expect(PDF_CODE).toContain('No. K/P Lama dan Kod Negara dibiarkan kosong');
    expect(PREVIEW_CODE).toContain("t('blankColumnsHint')");
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
   * ⚠️ THE FIDELITY CLAIM, AND WHY IT DID NOT GO UP.
   *
   * `agency-layout` asserts that every box is where the AGENCY's form puts it. Borang A and Borang 8A
   * can say that because we were at least given completed specimens of those pages. For CP39 there is
   * NOTHING on disk — `public/forms/` holds one file and it is the CP22 — so every box on the drawn
   * statement is placed from the ticket's PROSE list of fields, which is exactly what `figures` means.
   * Understating is safe. Overstating is the single failure the whole vocabulary exists to prevent, and
   * HANDOFF records that two earlier "agency reference" attachments in this repo turned out to be
   * another vendor's output rather than the agency's page.
   */
  it('claims `figures` — not `official`, and not even `agency-layout`, because there is no artwork', () => {
    expect(def!.fidelity).toBe('figures');
    // The evidence, asserted rather than asserted-about: there is no CP39 page in public/forms to have
    // been drawn onto. The day somebody adds one, this fails and the claim gets reconsidered on purpose.
    expect(fs.readdirSync(path.join(ROOT, 'public/forms')).filter((f) => /cp\W?39/i.test(f))).toEqual([]);
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
    ]);
    const braced = Object.entries(ns).filter(([k, v]) => !INTERPOLATED.has(k) && /[{}]/.test(v));
    expect(braced.map(([k]) => k), 'these are rendered with no arguments').toEqual([]);
    for (const k of INTERPOLATED) expect(ns[k], k).toMatch(/\{/);
  });
});
