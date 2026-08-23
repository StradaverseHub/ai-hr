/**
 * 18c1d92b — THE PERKESO ASSIST UPLOAD FILE, CHECKED AGAINST A REAL ONE.
 *
 * THE POINT OF THIS FILE, and why the golden is not a restatement: the customer attached BRG8A.txt, a
 * file their own system produced and PERKESO accepted. It is committed as
 * test/fixtures/perkeso-brg8a.txt and the case below rebuilds its fourteen employees THROUGH the same
 * function the download drives, then asserts byte-for-byte equality. A field map transcribed into a test
 * proves only that the test agrees with itself; a real file cannot be argued with.
 *
 * WHAT IT CATCHES THAT NOTHING ELSE CAN. Four of the six numeric boxes are six characters wide and
 * adjacent — socsoEmployer, socsoEmployee, eisEmployer, eisEmployee. Transposing any two produces a file
 * of exactly the right length, with every record still 278 characters and every box still numeric, that
 * files the wrong money against every employee. The KWSP file shipped exactly that defect (r210) because
 * its golden built employees in the file's own shape instead of driving the mapper; this one drives
 * `perkesoFileEmployeesFrom`, so a swap fails against the customer's bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PERKESO_FILE_EOL,
  PERKESO_FILE_FIELDS,
  PERKESO_FILE_LINE_LENGTH,
  PERKESO_FILE_SPEC,
  PerkesoFileError,
  assertPerkesoFileShape,
  buildPerkesoSocsoFile,
  describePerkesoFile,
  perkesoField,
  perkesoFileEmployeesFrom,
  perkesoFileRecords,
  perkesoFileReport,
  perkesoFileTotals,
  perkesoFileUnfinishedNames,
} from '../lib/perkeso-socso-file';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = 'test/fixtures/perkeso-brg8a.txt';
/** `latin1` and `utf8` agree here because the file is pure ASCII — which is itself asserted below. */
const FIXTURE = fs.readFileSync(path.join(ROOT, FIXTURE_PATH), 'latin1');

/**
 * The fourteen employees of the customer's file, in the PAYROLL ROW shape — not the file's shape. They go
 * through `perkesoFileEmployeesFrom` below, which is the one place a row becomes a record.
 */
const GOLDEN_ROWS = [
  { ic: '941128035179', name: 'AHMAD AZMER IZAT BIN MAT YAZID', wage: 5900, socsoEmployer: 102.35, socsoEmployee: 29.25, eisEmployer: 11.7, eisEmployee: 11.7 },
  { ic: '970628105455', name: 'AHMAD MUHAIMIN BIN AZHAR', wage: 5600, socsoEmployer: 97.15, socsoEmployee: 27.75, eisEmployer: 11.1, eisEmployee: 11.1 },
  { ic: '810329105276', name: 'FAZLIANA BINTI ISMAIL', wage: 6052, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '890714145496', name: 'HANISAH BINTI SHAMSUDIN', wage: 8700, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '700325025036', name: 'HASLIZA BINTI AHMAD', wage: 6000, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '950604036119', name: 'JUKHAIRUL SYAFIQ BIN MOHD ZUKI', wage: 4900, socsoEmployer: 84.85, socsoEmployee: 24.25, eisEmployer: 9.7, eisEmployee: 9.7 },
  { ic: '920530016467', name: 'MOHAMMAD FAIZ BIN ABDUL GHANI', wage: 5650, socsoEmployer: 98.85, socsoEmployee: 28.25, eisEmployer: 11.3, eisEmployee: 11.3 },
  { ic: '950102115175', name: 'MOHD ASRUL FARHAM BIN NOOR', wage: 4777.42, socsoEmployer: 83.15, socsoEmployee: 23.75, eisEmployer: 9.5, eisEmployee: 9.5 },
  { ic: '860823295779', name: 'MOHD NOR HAMDAN BIN AWANG', wage: 8200, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '870313035407', name: 'MOHD RIDHUAN BIN ISMAIL', wage: 5325.81, socsoEmployer: 93.65, socsoEmployee: 26.75, eisEmployer: 10.7, eisEmployee: 10.7 },
  { ic: '990830146005', name: 'MUHAMMAD FADZLIN BIN JAAFAR', wage: 6627.42, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '901010146619', name: 'NOOR AZID SHAH BIN DAUD', wage: 2700, socsoEmployer: 46.35, socsoEmployee: 13.25, eisEmployer: 5.3, eisEmployee: 5.3 },
  { ic: '930508055434', name: 'NUR FARAH HANIM BINTI MOHAMED NAZIM', wage: 7413, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
  { ic: '891002095050', name: 'SHAMIMI MAZWANI BT SAMSUDIN', wage: 10000, socsoEmployer: 104.15, socsoEmployee: 29.75, eisEmployer: 11.9, eisEmployee: 11.9 },
];

const goldenInput = {
  employer: { employerCode: 'E1100007357Y', myCoId: '34111U', periodMonth: 1, periodYear: 2026 },
  employees: perkesoFileEmployeesFrom(GOLDEN_ROWS),
};

describe('18c1d92b — the customer\'s own PERKESO file, rebuilt', () => {
  it('is byte-for-byte identical to the file they filed', () => {
    expect(buildPerkesoSocsoFile(goldenInput)).toBe(FIXTURE);
  });

  it('the fixture is what the module says it is: 14 records, 278 characters, CRLF between and none after', () => {
    const bytes = fs.readFileSync(path.join(ROOT, FIXTURE_PATH));
    expect(bytes.length).toBe(14 * 278 + 13 * 2);
    expect(FIXTURE.endsWith('\r\n')).toBe(false);
    const records = perkesoFileRecords(FIXTURE);
    expect(records).toHaveLength(14);
    for (const r of records) expect(r.length).toBe(PERKESO_FILE_LINE_LENGTH);
    // Pure ASCII: a non-ASCII byte would shift every field after it when the portal reads the record.
    expect(/^[\x20-\x7E\r\n]*$/.test(FIXTURE)).toBe(true);
  });

  it('pads the money boxes with SPACES, which is the one thing the written specification left open', () => {
    const first = perkesoFileRecords(FIXTURE)[0];
    // The request says "left-pad with zeroes or spaces"; the filed file says spaces, and it wins.
    expect(perkesoField(first, PERKESO_FILE_FIELDS.wage)).toBe('        590000');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.socsoEmployer)).toBe(' 10235');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.socsoEmployee)).toBe('  2925');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.eisEmployer)).toBe('  1170');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.eisEmployee)).toBe('  1170');
  });

  it('every field lands where the customer\'s file has it', () => {
    const first = perkesoFileRecords(FIXTURE)[0];
    expect(perkesoField(first, PERKESO_FILE_FIELDS.employerCode)).toBe('E1100007357Y');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.myCoId)).toBe('34111U'.padEnd(20, ' '));
    expect(perkesoField(first, PERKESO_FILE_FIELDS.identityNo)).toBe('941128035179');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.name)).toBe('AHMAD AZMER IZAT BIN MAT YAZID'.padEnd(150, ' '));
    // MMYYYY, which the request is explicit about: not YYYYMM, not MM/YY.
    expect(perkesoField(first, PERKESO_FILE_FIELDS.contributionMonth)).toBe('012026');
    expect(perkesoField(first, PERKESO_FILE_FIELDS.filler1)).toBe(' '.repeat(20));
    expect(perkesoField(first, PERKESO_FILE_FIELDS.filler2)).toBe(' '.repeat(20));
  });

  it('leaves no gap and no overlap: the declared fields ARE the record', () => {
    for (const v of describePerkesoFile(FIXTURE)) {
      expect(v.fields.map((f) => f.value).join(''), `record ${v.recordNo}`).toBe(perkesoFileRecords(FIXTURE)[v.recordNo - 1]);
      let at = 0;
      for (const f of v.fields) {
        expect(f.position, `record ${v.recordNo} field ${f.name}`).toBe(`${at + 1}-${at + f.length}`);
        at += f.length;
      }
      expect(at).toBe(PERKESO_FILE_LINE_LENGTH);
    }
  });
});

describe('18c1d92b — what it refuses rather than filing', () => {
  type Row = (typeof GOLDEN_ROWS)[number];
  const one = (over: Partial<Omit<Row, 'wage'>> & { wage?: number | null } = {}) => ({
    employer: goldenInput.employer,
    employees: perkesoFileEmployeesFrom([{ ...GOLDEN_ROWS[0], ...over }]),
  });
  type Built = Parameters<typeof buildPerkesoSocsoFile>[0];

  /**
   * THE REFUSAL THAT MATTERS MOST. `bases.socsoEis` arrived in r187 and 34 of the 109 payslips on
   * production predate it. Gross pay is a DIFFERENT number and zero asserts the employee earned nothing,
   * so a missing wage stops the file and names them (AGENTS 28).
   */
  it('refuses an employee whose payslip recorded no SOCSO wage, and names them', () => {
    expect(() => buildPerkesoSocsoFile(one({ wage: null }))).toThrow(PerkesoFileError);
    expect(() => buildPerkesoSocsoFile(one({ wage: null }))).toThrow(/AHMAD AZMER IZAT BIN MAT YAZID/);
    expect(() => buildPerkesoSocsoFile(one({ wage: null }))).toThrow(/no SOCSO wage/);
  });

  it('refuses an identity number that is not twelve characters rather than padding it', () => {
    expect(() => buildPerkesoSocsoFile(one({ ic: '94112803517' }))).toThrow(/exactly 12 characters/);
    expect(() => buildPerkesoSocsoFile(one({ ic: '9411280351799' }))).toThrow(/exactly 12 characters/);
    // …but a DASHED identity card is the same number, and is accepted.
    expect(() => buildPerkesoSocsoFile(one({ ic: '941128-03-5179' }))).not.toThrow();
  });

  it('refuses a negative or oversized amount rather than writing a sign or a truncation', () => {
    expect(() => buildPerkesoSocsoFile(one({ socsoEmployee: -1 }))).toThrow(/negative/);
    // Six characters hold 9,999.99 at most; a bigger contribution has nowhere to go.
    expect(() => buildPerkesoSocsoFile(one({ socsoEmployer: 10_000 }))).toThrow(/the box holds 6/);
  });

  it('refuses an empty employer code and an empty file', () => {
    expect(() => buildPerkesoSocsoFile({ ...one(), employer: { ...goldenInput.employer, employerCode: '  ' } })).toThrow(
      /employer code is required/,
    );
    expect(() => buildPerkesoSocsoFile({ employer: goldenInput.employer, employees: [] })).toThrow(/nobody to file for/);
  });

  it('refuses a month outside 1-12, because MMYYYY has no room to be wrong quietly', () => {
    expect(() => buildPerkesoSocsoFile({ ...one(), employer: { ...goldenInput.employer, periodMonth: 13 } })).toThrow(/1-12/);
  });

  /**
   * 5d3acdc2 — PERKESO's own spec, field 5: "Month due cannot be advanced date". A return for a month
   * that has not happened yet is refused here rather than at the portal. `today` is injected so this
   * case does not depend on when it runs — the golden above files January 2026 and must stay legal
   * forever, which it does because its own `today` is the caller's.
   */
  it('refuses a contribution month that has not happened yet', () => {
    const march = new Date(2026, 2, 15); // 15 March 2026
    const inMarch = (m: number, y: number) => ({ ...one(), employer: { ...goldenInput.employer, periodMonth: m, periodYear: y }, today: march });
    // February 2026 is past, March 2026 is the current month — both legal.
    expect(() => buildPerkesoSocsoFile(inMarch(2, 2026))).not.toThrow();
    expect(() => buildPerkesoSocsoFile(inMarch(3, 2026))).not.toThrow();
    // April 2026 and anything in 2027 have not happened.
    expect(() => buildPerkesoSocsoFile(inMarch(4, 2026))).toThrow(/has not happened yet/);
    expect(() => buildPerkesoSocsoFile(inMarch(1, 2027))).toThrow(/has not happened yet/);
    // The message names the month it refused, in the file's own MMYYYY form.
    expect(() => buildPerkesoSocsoFile(inMarch(4, 2026))).toThrow(/042026/);
  });

  /** The shape check runs on the EMITTED bytes, so it catches a corruption the writer never intended. */
  it('the shape check reads the bytes, not the writer\'s intent', () => {
    const good = buildPerkesoSocsoFile(goldenInput);
    expect(() => assertPerkesoFileShape(good)).not.toThrow();
    const records = perkesoFileRecords(good);
    const shortened = [records[0].slice(0, 277), ...records.slice(1)].join('\r\n');
    expect(() => assertPerkesoFileShape(shortened)).toThrow(/277 characters/);
    const filthyFiller = [records[0].slice(0, 238) + '0'.repeat(20) + records[0].slice(258), ...records.slice(1)].join('\r\n');
    // 64c09b0e — the refusal names the field the agency's way, since this same sentence is what the
    // report lists for a record it could not validate.
    expect(() => assertPerkesoFileShape(filthyFiller)).toThrow(/Field 11 Filler 1 must be blank/);
  });
});

describe('18c1d92b — the mapping lives in ONE place', () => {
  /**
   * The r210 lesson, pinned rather than remembered. On the KWSP file the row-to-record mapping was
   * written out at the call site AND in the test, so transposing the employer and employee shares left
   * 214 tests green. Here the download's call site must DELEGATE, and the golden above drives the same
   * function — so a swap has nowhere to hide.
   */
  /**
   * THE CONTRACT BETWEEN THE PAGE AND THE ROUTE, pinned on BOTH sides (AGENTS 17), because a unit test of
   * either half passes throughout. The download form is method="get", so per the HTML spec the browser
   * DISCARDS a query string on the action URL and rebuilds it from the fields — a `formAction` carrying
   * `?report=1` hands over the FILE while looking correct in the source. A hidden input is the opposite
   * trap: it is submitted by EVERY button in the form. Only a submit button's own name/value is sent by
   * that button alone, and that is what the route reads.
   */
  it('the report is requested by the button own name/value, not a query string or a hidden input', () => {
    const page = fs.readFileSync(path.join(ROOT, 'app/payroll/borang-8a/preview/page.tsx'), 'utf8');
    expect(page).toContain('formAction="/payroll/borang-8a/file"');
    expect(page).toMatch(/name="report"\s*\n?\s*value="1"/);
    // The two shapes that would break it, refused in the page's own source.
    expect(page).not.toContain('/payroll/borang-8a/file?report');
    expect(page).not.toMatch(/<input[^>]*name="report"/);
    // …and the route reads exactly that field.
    const route = fs.readFileSync(path.join(ROOT, 'app/payroll/borang-8a/file/route.ts'), 'utf8');
    expect(route).toContain("q.get('report') === '1'");
  });

  it('the download delegates to perkesoFileEmployeesFrom instead of restating the fields', () => {
    const shared = fs.readFileSync(path.join(ROOT, 'app/payroll/borang-8a/shared.ts'), 'utf8');
    expect(shared).toContain('employees: perkesoFileEmployeesFrom(');
    // The four adjacent six-wide boxes must not be assigned by hand anywhere on the download path.
    expect(shared).not.toMatch(/socsoEmployer:\s*\w+\.socso/);
    expect(shared).not.toMatch(/eisEmployer:\s*\w+\.eis/);
  });
});

describe('18c1d92b — the validation report', () => {
  it('names every record, its length and every field position, from the same table the writer used', () => {
    const report = perkesoFileReport(FIXTURE);
    expect(report).toContain('Records: 14');
    expect(report).toContain(`Record length: every record is ${PERKESO_FILE_LINE_LENGTH} characters.`);
    expect(report).toContain('none after the last');
    // 64c09b0e — the positions are unchanged; the NAME beside each one is now the agency's, not ours.
    expect(report).toContain('201-214  Field 6 Employee Salary');
    expect(report).toContain('215-220  Field 7 Contribution Amount SOCSO (Employer share)');
    // …and the internal keys have left the report entirely, which is the half that retired.
    expect(report).not.toMatch(/\bsocsoEmployer\b/);
    expect(report).not.toMatch(/\beisEmployee\b/);
    expect(report).not.toMatch(/\bmyCoId\b/);
    expect(report).toContain('AHMAD AZMER IZAT BIN MAT YAZID');
    // ASCII only — it describes a us-ascii file.
    expect(/^[\x20-\x7E\n]*$/.test(report)).toBe(true);
  });
});

/**
 * 5dbce839 — WHAT THE REPORTER ASKED THE REPORT FOR, AND WHAT IT MUST NOT INVENT.
 *
 * Their request lists twelve things a validation report should say. The report already said five of them
 * (record count, character count, the per-record width check, one-record-per-employee, and every field
 * with its positions). Four more are honest to add and are pinned below; the twelfth — a SKBBK / Lindung
 * 24 Jam total — is NOT, and its ABSENCE is pinned too. The specification this file is written to has no
 * such field, so the file carries no such contribution, and a line reading "SKBBK: RM 0.00" would be a
 * statement about money on a return that never mentions it (AGENTS 28: an absent box asserts nothing, a
 * box reading 0.00 asserts the money does not exist).
 */
describe('5dbce839 — the four things the reporter asked the report for, and the one it must not invent', () => {
  it('names the specification it was written to, by name, version and date', () => {
    const report = perkesoFileReport(FIXTURE);
    expect(report).toContain('Spesifikasi Format Text File Untuk SOCSO + EIS Contribution');
    expect(report).toContain('v1.0');
    expect(report).toContain('22 July 2022');
    // The line is built from the module's own constant, so the report cannot name a specification the
    // field table was not derived from.
    expect(report).toContain(`${PERKESO_FILE_SPEC.version} of ${PERKESO_FILE_SPEC.dated}`);
    expect(report).toContain(`${PERKESO_FILE_LINE_LENGTH} characters per record`);
  });

  /**
   * THE FIVE TOTALS, ADDED UP BY HAND FROM THE FIXTURE so a reader can check them without running
   * anything. Each line below is the fourteen GOLDEN_ROWS in file order, in RM:
   *
   *   salary        5900 + 5600 + 6052 + 8700 + 6000 + 4900 + 5650 + 4777.42 + 8200 + 5325.81
   *                      + 6627.42 + 2700 + 7413 + 10000                              = 87,845.65
   *   socso er      102.35 + 97.15 + 104.15 + 104.15 + 104.15 + 84.85 + 98.85 + 83.15
   *                      + 104.15 + 93.65 + 104.15 + 46.35 + 104.15 + 104.15          =  1,335.40
   *   socso ee      29.25 + 27.75 + 29.75 + 29.75 + 29.75 + 24.25 + 28.25 + 23.75
   *                      + 29.75 + 26.75 + 29.75 + 13.25 + 29.75 + 29.75              =    381.50
   *   eis er        11.70 + 11.10 + 11.90 + 11.90 + 11.90 + 9.70 + 11.30 + 9.50
   *                      + 11.90 + 10.70 + 11.90 + 5.30 + 11.90 + 11.90               =    152.60
   *   eis ee        the same fourteen figures as the employer leg, which is the EIS rule =  152.60
   *
   * The file carries cents with no decimal point, so those are 8784565, 133540, 38150, 15260, 15260.
   */
  it('totals the five money boxes, and the figures are the ones you get by adding the fixture up', () => {
    const totals = perkesoFileTotals(FIXTURE);
    expect(totals.records).toBe(14);
    expect(totals.excluded).toEqual([]);
    expect(totals.sen).toEqual({
      wage: 8_784_565,
      socsoEmployer: 133_540,
      socsoEmployee: 38_150,
      eisEmployer: 15_260,
      eisEmployee: 15_260,
    });

    // …and the report prints each of them in RM with two decimals AND as the digits the file holds, so a
    // reader can check the file with a calculator and with their eyes.
    const report = perkesoFileReport(FIXTURE);
    // 64c09b0e — the FIGURES are exactly as they were; the label beside each is now the specification's
    // own row, so the five money lines can be ticked off against fields 6 to 10 without translation.
    expect(report).toMatch(/Field 6 Employee Salary\s+RM\s+87845\.65\s+in the file: 8784565/);
    expect(report).toMatch(/Field 7 Contribution Amount SOCSO \(Employer share\)\s+RM\s+1335\.40\s+in the file: 133540/);
    expect(report).toMatch(/Field 8 Contribution Amount SOCSO \(Employee share\)\s+RM\s+381\.50\s+in the file: 38150/);
    expect(report).toMatch(/Field 9 Contribution Amount EIS \(Employer share\)\s+RM\s+152\.60\s+in the file: 15260/);
    expect(report).toMatch(/Field 10 Contribution Amount EIS \(Employee share\)\s+RM\s+152\.60\s+in the file: 15260/);
    expect(report).toContain('CENTS WITH NO DECIMAL POINT');
    expect(report).toContain('Added up over 14 record(s) of 14.');
  });

  /**
   * ⚠️ THE TOTALS COME OUT OF THE FILE, NOT OUT OF THE ROWS — which is the only reason they are worth
   * printing. A total added up from the payroll rows agrees with the payroll by construction, including
   * when the writer has put a figure in the wrong box; only a total read back out of the emitted bytes can
   * disagree with the payroll and so be worth checking against it.
   *
   * THE CASE IS BUILT SO THAT NOTHING ELSE COULD PRODUCE IT. Ten ringgit is moved from the SOCSO employee
   * box into the EIS employer box IN THE TEXT, after the file has been written. No input row exists to
   * read: `buildPerkesoSocsoFile` was called with the untouched golden. If these totals came from anywhere
   * but the file, both figures below would be the golden's.
   */
  it('reads the totals back out of the FILE — edit a box in the text and the total follows', () => {
    const records = perkesoFileRecords(buildPerkesoSocsoFile(goldenInput));
    const { offset: seOffset, width: seWidth } = PERKESO_FILE_FIELDS.socsoEmployee;
    const { offset: erOffset, width: erWidth } = PERKESO_FILE_FIELDS.eisEmployer;
    // Record 1 carries "  2925" and "  1170"; 1000 sen moves from the first box to the second.
    expect(perkesoField(records[0], PERKESO_FILE_FIELDS.socsoEmployee)).toBe('  2925');
    expect(perkesoField(records[0], PERKESO_FILE_FIELDS.eisEmployer)).toBe('  1170');
    const edited = [
      records[0].slice(0, seOffset) +
        '1925'.padStart(seWidth, ' ') +
        '2170'.padStart(erWidth, ' ') +
        records[0].slice(erOffset + erWidth),
      ...records.slice(1),
    ].join(PERKESO_FILE_EOL);
    expect(edited).toHaveLength(FIXTURE.length);

    const totals = perkesoFileTotals(edited);
    expect(totals.sen.socsoEmployee, 'ten ringgit left the SOCSO employee box').toBe(38_150 - 1_000);
    expect(totals.sen.eisEmployer, 'and arrived in the EIS employer box').toBe(15_260 + 1_000);
    // Everything else is where it was — this is a transposition, not a loss.
    expect(totals.sen.wage).toBe(8_784_565);
    expect(totals.sen.socsoEmployer).toBe(133_540);
    expect(totals.sen.eisEmployee).toBe(15_260);
    expect(totals.excluded).toEqual([]);
  });

  it('names any record it could not validate, and leaves its figures out of the totals', () => {
    const records = perkesoFileRecords(FIXTURE);
    const shortened = [records[0].slice(0, 277), ...records.slice(1)].join(PERKESO_FILE_EOL);
    const report = perkesoFileReport(shortened);
    expect(report).toContain('Records that could not be validated: 1 of 14.');
    expect(report).toContain('record 1 is 277 characters and every record must be 278');
    expect(report).toContain('Their figures are NOT included in the totals below.');
    // 87,845.65 less the first record's 5,900.00.
    expect(perkesoFileTotals(shortened).sen.wage).toBe(8_194_565);
    expect(perkesoFileTotals(shortened).excluded).toEqual([1]);
    expect(report).toContain('Added up over 13 record(s) of 14.');
    // …and on a clean file it says so rather than staying silent, which would read the same as "not checked".
    expect(perkesoFileReport(FIXTURE)).toContain('Records that could not be validated: none.');
  });

  /**
   * THE LINE THAT MUST NOT BE THERE. The reporter's item 12 asks for a "Total SKBBK/LINDUNG 24 Jam
   * contribution, if applicable" — and it is not applicable: the twelve fields of this format have no
   * such box. Adding a zero would answer their question and be false.
   */
  it('prints no SKBBK / Lindung 24 Jam total, because the format has no such field', () => {
    for (const report of [perkesoFileReport(FIXTURE), perkesoFileReport(buildPerkesoSocsoFile(goldenInput))]) {
      expect(report).not.toMatch(/SKBBK/i);
      expect(report).not.toMatch(/lindung/i);
      expect(report).not.toMatch(/24 jam/i);
    }
    // Nor does the field table, which is where such a box would have to exist first.
    expect(Object.keys(PERKESO_FILE_FIELDS)).not.toContain('skbbk');
  });
});

/**
 * 5dbce839 — THE MYCOID BOX, SAID OUT LOUD IN THE REPORT.
 *
 * The customer's own accepted file carries "34111U" in positions 13-32; ours would carry twenty spaces,
 * because the number has never been entered for their company. The specification marks the field
 * Mandatory = N, so this is a NOTICE and never a refusal — and it is read out of the emitted FILE, not off
 * the form, so it can only ever describe the bytes that were actually written.
 */
describe('5dbce839 — the MyCoID notice, on both halves', () => {
  const withMyCoId = buildPerkesoSocsoFile(goldenInput);
  const withoutMyCoId = buildPerkesoSocsoFile({ ...goldenInput, employer: { ...goldenInput.employer, myCoId: null } });

  it('appears when the box is empty, naming the positions and where to set the number', () => {
    const report = perkesoFileReport(withoutMyCoId);
    expect(report).toContain('MyCoID / business registration number: positions 13-32 are EMPTY on every record.');
    expect(report).toContain('not mandatory');
    expect(report).toContain('Statutory identity');
  });

  it('does NOT appear when the number is set', () => {
    const report = perkesoFileReport(withMyCoId);
    expect(report).not.toContain('are EMPTY');
    expect(report).not.toMatch(/MyCoID \/ business registration number:/);
    // The value is still there to read in the field dump — the notice is gone, not the field.
    expect(report).toMatch(/Field 2 MyCoID\/SSM Number\s+\[34111U {14}\]/);
  });

  /** A blank MyCoID is not a refusal, and must never become one: the file is produced either way. */
  it('does not stop the file, and does not move a single byte of the other fields', () => {
    expect(perkesoFileRecords(withoutMyCoId)).toHaveLength(14);
    for (const r of perkesoFileRecords(withoutMyCoId)) expect(r.length).toBe(PERKESO_FILE_LINE_LENGTH);
    expect(perkesoField(perkesoFileRecords(withoutMyCoId)[0], PERKESO_FILE_FIELDS.myCoId)).toBe(' '.repeat(20));
    // Everything after the MyCoID box is identical, record by record, to the file that carries one — the
    // twenty spaces do not shift a single field that follows them.
    const cut = PERKESO_FILE_FIELDS.identityNo.offset;
    const withOne = perkesoFileRecords(withMyCoId);
    perkesoFileRecords(withoutMyCoId).forEach((r, i) => {
      expect(r.slice(cut), `record ${i + 1} after the MyCoID box`).toBe(withOne[i].slice(cut));
      const beforeMyCoId = cut - PERKESO_FILE_FIELDS.myCoId.width;
      expect(r.slice(0, beforeMyCoId)).toBe(withOne[i].slice(0, beforeMyCoId));
    });
  });
});

/**
 * 5dbce839 — THE FORMAT WAS NEVER THE DEFECT, AND THIS ROUND DID NOT TOUCH IT.
 *
 * The reporter's request is to "correct" the file format. It is already correct: the golden at the top of
 * this file rebuilds their own filed BRG8A.txt byte for byte. Everything this round added is a REPORT
 * about the file and a notice on the screen. This case is the cheap, explicit statement of that — the
 * field table, the record length and the line ending, pinned as literals, so an edit to any offset, width
 * or pad rule fails here and says why rather than only failing the golden.
 */
/**
 * r218 — THE NAMES IN FIELD 4, WHICH IS WHERE THIS FILE STOPPED BEING A FORMAT QUESTION.
 *
 * The approved plan's first step was to generate the customer's own January 2026 file from production
 * and compare it against the BRG8A.txt they filed. It came out format-perfect — 19 records, every one
 * 278 characters, CRLF between records and none after the last — and carrying `TEST0001` … `TEST0014`
 * in the name box, plus one record reading `ISMAIL` where their filed file says `MOHD RIDHUAN BIN
 * ISMAIL`. PERKESO's field 4 is "Name as per IC or passport".
 *
 * These cases use the fixture (whose fourteen names ARE real) and overwrite the name box in place, so a
 * reader can see that the check reads the FILE rather than the rows it was written from — the same
 * property the totals have, and for the same reason.
 */
describe('r218 — unfinished names, read back out of the file', () => {
  /** Overwrite one record's 150-character name box, leaving every other position untouched. */
  const withName = (text: string, recordNo: number, name: string) => {
    const rows = perkesoFileRecords(text);
    const { offset: off, width } = PERKESO_FILE_FIELDS.name;
    const r = rows[recordNo - 1];
    rows[recordNo - 1] = r.slice(0, off) + name.padEnd(width, ' ').slice(0, width) + r.slice(off + width);
    return rows.join(PERKESO_FILE_EOL);
  };

  it('the customer’s filed file has none — the check is not firing on real names', () => {
    expect(perkesoFileUnfinishedNames(FIXTURE)).toEqual([]);
  });

  it('names the record, the identity number and the name, for a placeholder and for a blank', () => {
    const mutated = withName(withName(FIXTURE, 2, 'TEST0001'), 5, '');
    expect(perkesoFileUnfinishedNames(mutated)).toEqual([
      { recordNo: 2, identityNo: '970628105455', name: 'TEST0001' },
      { recordNo: 5, identityNo: '700325025036', name: '' },
    ]);
    // Every record is still exactly the right width: the check reads, it does not rewrite.
    expect(perkesoFileRecords(mutated).every((r) => r.length === PERKESO_FILE_LINE_LENGTH)).toBe(true);
  });

  it('leaves a real name that merely begins with those letters alone', () => {
    expect(perkesoFileUnfinishedNames(withName(FIXTURE, 1, 'TESTA BINTI OSMAN'))).toEqual([]);
  });

  it('the report names them, says the file is still produced, and does not say it when there are none', () => {
    const clean = perkesoFileReport(FIXTURE);
    expect(clean).not.toMatch(/DO NOT LOOK FINISHED/);

    const report = perkesoFileReport(withName(FIXTURE, 3, 'TEST0002'));
    expect(report).toMatch(/EMPLOYEE NAMES THAT DO NOT LOOK FINISHED: 1 of 14\./);
    expect(report).toContain('record 3, identity number 810329105276: name reads "TEST0002"');
    expect(report).toMatch(/Name as per IC or passport/);
    expect(report).toMatch(/Nothing here stops the file\./);
    // AGENTS 28's other half: the report must not claim we corrected anything.
    expect(report).toMatch(/does not invent or shorten anybody/);
  });
});


/**
 * 64c09b0e — THE REPORT IS NOW READABLE AGAINST PERKESO'S OWN TABLE, AND SAYS WHY THE FILE LOOKS FOLDED.
 *
 * The item asked us to re-configure the format: to treat 13-18 as a staff number and to rename 215-238 so
 * that SOCSO's two shares became a wage class and a contribution component, with the employer/employee
 * pair moved onto 227-238. Following it would have credited every SOCSO amount to EIS in a file that still
 * measured 278 characters and whose totals still added up — nothing would have looked wrong until PERKESO
 * had the money in the wrong scheme.
 *
 * NOTHING IN THE FILE MOVED. What changed is that the report no longer speaks our language: every field
 * carries the agency's NO. and FIELD NAME (EN), so the reader can put this report beside the specification
 * instead of interpreting `socsoEmployer`. And the report says, at the top, the one thing that produced
 * BOTH items — every record is a single line, and an editor with word wrap on shows it folded.
 */
describe('64c09b0e — the report speaks the specification\'s language', () => {
  const REPORT = perkesoFileReport(FIXTURE);

  it('says at the top that a record is ONE line, and that word wrap is what folds it', () => {
    expect(REPORT).toContain(`EVERY RECORD IS A SINGLE LINE OF ${PERKESO_FILE_LINE_LENGTH} CHARACTERS.`);
    expect(REPORT).toMatch(/word wrap turned ON/);
    expect(REPORT).toMatch(/not a line break in the file/);
    // AT THE TOP: before the first record's field dump, or a reader who already believes the file is
    // broken will never reach it. Both items arrived with a screenshot of a wrapping editor.
    expect(REPORT.indexOf('EVERY RECORD IS A SINGLE LINE')).toBeLessThan(REPORT.indexOf('Record 1 ('));
    expect(REPORT.indexOf('EVERY RECORD IS A SINGLE LINE')).toBeLessThan(REPORT.indexOf('TOTALS,'));
    // …and it is true of this very file: no record contains a line break.
    for (const r of perkesoFileRecords(FIXTURE)) expect(r).not.toMatch(/[\r\n]/);
  });

  it('prints every field with the agency\'s number and name, for every record', () => {
    for (const view of describePerkesoFile(FIXTURE)) {
      for (const f of view.fields) {
        const spec = PERKESO_FILE_FIELDS[f.name as keyof typeof PERKESO_FILE_FIELDS];
        expect(f.no, f.name).toBe(spec.no);
        expect(f.label, f.name).toBe(spec.label);
        expect(REPORT, `record ${view.recordNo} ${f.name}`).toContain(`${f.position}  Field ${f.no} ${f.label}`);
      }
    }
  });

  /**
   * THE INTERNAL KEYS ARE GONE FROM THE REPORT — every one of the twelve, not just the ones a spot check
   * would name. `filler1` survived the first pass of this change because it lives in a refusal sentence
   * rather than in the field dump, which is exactly the kind of half-done rename this case exists to stop.
   */
  it('prints no internal key anywhere, including in a refusal sentence', () => {
    const records = perkesoFileRecords(FIXTURE);
    const filthyFiller = [records[0].slice(0, 238) + '0'.repeat(20) + records[0].slice(258), ...records.slice(1)].join(
      PERKESO_FILE_EOL,
    );
    for (const report of [REPORT, perkesoFileReport(filthyFiller)]) {
      for (const key of Object.keys(PERKESO_FILE_FIELDS)) {
        expect(report, key).not.toMatch(new RegExp(`\\b${key}\\b`));
      }
    }
    // …and the refusal it now prints instead names the row of the specification.
    expect(perkesoFileReport(filthyFiller)).toContain('Field 11 Filler 1 must be blank');
  });

  /** Still us-ascii, with the new lines in it — the report describes a us-ascii file. */
  it('stays pure ASCII', () => {
    expect(/^[\x20-\x7E\n]*$/.test(REPORT)).toBe(true);
  });
});

describe('5dbce839 — the writer and the field table come out of this round unchanged', () => {
  /**
   * ⚠️ 64c09b0e UPDATED THIS CASE RATHER THAN REPLACING IT, and the distinction is the whole point.
   *
   * The case was written to pin that 5dbce839 changed no offset. 64c09b0e is the SECOND round to change
   * no offset — and it arrived asking for four money boxes to be renamed, which would have moved every
   * SOCSO amount into the boxes PERKESO reads as EIS. So the twelve offset/width pairs below are
   * UNCHANGED, character for character, from what this case has always asserted; what is new is that each
   * row also carries the agency's own NO. and FIELD NAME (EN), which are LABELS and are asserted here
   * beside the numbers so that renaming a box and moving one are the same test failure.
   */
  it('keeps the twelve fields at exactly the offsets and widths read off the filed file', () => {
    // The offsets and widths, unchanged — written as the pairs the case has always pinned, then checked
    // against the table, so this half stays readable as the assertion it was before the labels arrived.
    const OFFSETS: Record<string, readonly [number, number]> = {
      employerCode: [0, 12],
      myCoId: [12, 20],
      identityNo: [32, 12],
      name: [44, 150],
      contributionMonth: [194, 6],
      wage: [200, 14],
      socsoEmployer: [214, 6],
      socsoEmployee: [220, 6],
      eisEmployer: [226, 6],
      eisEmployee: [232, 6],
      filler1: [238, 20],
      filler2: [258, 20],
    };
    expect(
      Object.fromEntries(Object.entries(PERKESO_FILE_FIELDS).map(([k, f]) => [k, [f.offset, f.width]])),
    ).toEqual(OFFSETS);
    expect(PERKESO_FILE_LINE_LENGTH).toBe(278);
    expect(PERKESO_FILE_EOL).toBe('\r\n');
  });

  /**
   * 64c09b0e — THE AGENCY'S OWN NO. AND FIELD NAME (EN), transcribed from the specification's table.
   *
   * The four amount rows are the ones the item got wrong, so they are spelled out in full: 7 and 8 are
   * SOCSO employer/employee, 9 and 10 are EIS employer/employee. Pinned as literals because this is what
   * the report now prints, and a report that names a money box after the wrong scheme is worse than one
   * that names it `socsoEmployer`.
   */
  it('names every field with PERKESO\'s own number and English name', () => {
    expect(
      Object.fromEntries(Object.entries(PERKESO_FILE_FIELDS).map(([k, f]) => [k, [f.no, f.label]])),
    ).toEqual({
      employerCode: [1, 'Employer Code'],
      myCoId: [2, 'MyCoID/SSM Number'],
      identityNo: [3, 'Identification Number / SOCSO Foreign Worker Number'],
      name: [4, 'Employee Name'],
      contributionMonth: [5, 'Month Contribution'],
      wage: [6, 'Employee Salary'],
      socsoEmployer: [7, 'Contribution Amount SOCSO (Employer share)'],
      socsoEmployee: [8, 'Contribution Amount SOCSO (Employee share)'],
      eisEmployer: [9, 'Contribution Amount EIS (Employer share)'],
      eisEmployee: [10, 'Contribution Amount EIS (Employee share)'],
      filler1: [11, 'Filler 1'],
      filler2: [12, 'Filler 2'],
    });
  });

  /**
   * The numbers are 1..12, once each, in the order the record lays the fields out.
   *
   * A gap or a duplicate would not fail the literal case above in any way a reader would notice — two
   * rows both numbered 8 read perfectly well — and it is exactly what a careless edit produces. Checked
   * against the OFFSET order, so a field numbered out of sequence fails here rather than being carried
   * into a report that claims to be readable against the agency's table.
   */
  it('numbers them 1 to 12, with no gaps, no duplicates, and in the record\'s own order', () => {
    const byOffset = Object.values(PERKESO_FILE_FIELDS)
      .slice()
      .sort((a, b) => a.offset - b.offset);
    expect(byOffset.map((f) => f.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(Object.values(PERKESO_FILE_FIELDS).map((f) => f.label)).size).toBe(12);
    for (const f of Object.values(PERKESO_FILE_FIELDS)) {
      expect(f.label.trim(), `field ${f.no}`).toBe(f.label);
      expect(f.label.length, `field ${f.no}`).toBeGreaterThan(0);
    }
    // The declared position of every field is the specification's own 1-based POSITION column.
    expect(byOffset.map((f) => `${f.offset + 1}-${f.offset + f.width}`)).toEqual([
      '1-12',
      '13-32',
      '33-44',
      '45-194',
      '195-200',
      '201-214',
      '215-220',
      '221-226',
      '227-232',
      '233-238',
      '239-258',
      '259-278',
    ]);
  });

  it('still writes the customer\'s own file byte for byte, through the same mapper', () => {
    expect(buildPerkesoSocsoFile({ employer: goldenInput.employer, employees: perkesoFileEmployeesFrom(GOLDEN_ROWS) })).toBe(
      FIXTURE,
    );
  });
});
