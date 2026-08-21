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
  PERKESO_FILE_FIELDS,
  PERKESO_FILE_LINE_LENGTH,
  PerkesoFileError,
  assertPerkesoFileShape,
  buildPerkesoSocsoFile,
  describePerkesoFile,
  perkesoField,
  perkesoFileEmployeesFrom,
  perkesoFileRecords,
  perkesoFileReport,
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

  /** The shape check runs on the EMITTED bytes, so it catches a corruption the writer never intended. */
  it('the shape check reads the bytes, not the writer\'s intent', () => {
    const good = buildPerkesoSocsoFile(goldenInput);
    expect(() => assertPerkesoFileShape(good)).not.toThrow();
    const records = perkesoFileRecords(good);
    const shortened = [records[0].slice(0, 277), ...records.slice(1)].join('\r\n');
    expect(() => assertPerkesoFileShape(shortened)).toThrow(/277 characters/);
    const filthyFiller = [records[0].slice(0, 238) + '0'.repeat(20) + records[0].slice(258), ...records.slice(1)].join('\r\n');
    expect(() => assertPerkesoFileShape(filthyFiller)).toThrow(/filler1 must be blank/);
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
    expect(report).toContain('201-214  wage');
    expect(report).toContain('215-220  socsoEmployer');
    expect(report).toContain('AHMAD AZMER IZAT BIN MAT YAZID');
    // ASCII only — it describes a us-ascii file.
    expect(/^[\x20-\x7E\n]*$/.test(report)).toBe(true);
  });
});
