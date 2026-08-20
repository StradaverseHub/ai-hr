/**
 * cc74dcb2 — THE KWSP BORANG A UPLOAD FILE for i-Akaun.
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: the fixed-width layout, and the totals invariant that decides
 * whether a file is offered at all. Both fail SILENTLY — a file with one field a column too far left, or
 * a trailer that does not agree with its own detail lines, downloads exactly like a correct one and is
 * discovered when i-Akaun rejects it, by which time nobody can see which of 129 columns moved.
 *
 * ⚠️ THE SPECIFICATION IS `test/fixtures/kwsp-borang-a-epforma2.txt`, WHICH IS A REAL KWSP FILE — the
 * EPFORMA2 file the customer attached to cc74dcb2, committed here byte for byte. The previous version of
 * this file tested against the field tables of item 3aae0789, which were reverse-engineered WITHOUT a
 * sample, and every assertion passed while the writer put the wages where the employer's contribution
 * belongs and the two contributions added together where the employee's belongs. That is what a test
 * written against a description rather than an artefact buys you.
 *
 * THE GOLDEN TEST IS THEREFORE THE POINT OF THIS FILE: build the fourteen employees the sample carries
 * and assert the emitted characters equal the sample EXACTLY. Everything else here explains a property
 * the golden test would only tell you was broken.
 *
 * NO OFFSET IS RESTATED. Every position below is read out of `BORANG_A_FILE_FIELDS`, which is the single
 * transcription; a test that hardcoded `line.slice(96, 105)` would pass against a writer that had drifted,
 * because both would have been edited together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BORANG_A_FILE_DESCRIPTION,
  BORANG_A_FILE_EOL,
  BORANG_A_FILE_FIELDS,
  BORANG_A_FILE_LINE_LENGTH,
  BorangAFileError,
  assertBorangAFileBalances,
  borangAFileLines,
  borangAFileReadiness,
  borangAFileReport,
  buildBorangAFile,
  describeBorangAFile,
  fileField,
  borangAFileEmployeesFrom,
  parseBorangAFileTotals,
  type BorangAFileEmployee,
  type BorangAFileInput,
} from '../lib/kwsp-borang-a-file';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** The customer's own file, read as bytes. `utf8` and `latin1` agree here because it is pure ASCII. */
const FIXTURE_PATH = 'test/fixtures/kwsp-borang-a-epforma2.txt';
const FIXTURE = fs.readFileSync(path.join(ROOT, FIXTURE_PATH), 'latin1');

/**
 * The fourteen employees of the sample, read off its own 02 records. Member numbers are given WITHOUT
 * their leading zeros so the golden test also proves the padding, and the amounts are in ringgit because
 * that is what the rest of the system holds.
 */
/**
 * ⚠️ ROW-SHAPED, AND MAPPED THROUGH `borangAFileEmployeesFrom` BELOW — not written straight into the
 * file's own shape. That is the whole point: the mapping from a payroll row to the 02 record's three
 * amount boxes is the one step nothing downstream can check (transposing the two contributions leaves
 * the length, the header totals and the trailer totals all self-consistent), so the golden drives the
 * SAME function the screen's download does. Written as literals here in the report's row shape.
 */
const GOLDEN_ROWS = [
  { memberNo: '22039094', ic: '941128035179', name: 'AHMAD AZMER IZAT BIN MAT YAZID', staffNo: 'IDB010', employer: 708, employee: 649, wage: 5900 },
  { memberNo: '22154734', ic: '970628105455', name: 'AHMAD MUHAIMIN BIN AZHAR', staffNo: '100502', employer: 672, employee: 616, wage: 5600 },
  { memberNo: '14957564', ic: '810329105276', name: 'FAZLIANA BINTI ISMAIL', staffNo: 'IDB-240001', employer: 732, employee: 671, wage: 6052 },
  { memberNo: '17712944', ic: '890714145496', name: 'HANISAH BINTI SHAMSUDIN', staffNo: 'IDB012', employer: 1044, employee: 957, wage: 8700 },
  { memberNo: '11534752', ic: '700325025036', name: 'HASLIZA BINTI AHMAD', staffNo: 'IDB007', employer: 720, employee: 660, wage: 6000 },
  { memberNo: '21278530', ic: '950604036119', name: 'JUKHAIRUL SYAFIQ BIN MOHD ZUKI', staffNo: 'IDB013', employer: 637, employee: 539, wage: 4900 },
  { memberNo: '18846253', ic: '920530016467', name: 'MOHAMMAD FAIZ BIN ABDUL GHANI', staffNo: '100507', employer: 684, employee: 627, wage: 5650 },
  { memberNo: '21482758', ic: '950102115175', name: 'MOHD ASRUL FARHAM BIN NOOR', staffNo: 'IDB002', employer: 622, employee: 526, wage: 4777.42 },
  { memberNo: '16681328', ic: '860823295779', name: 'MOHD NOR HAMDAN BIN AWANG', staffNo: 'IDB011', employer: 984, employee: 902, wage: 8200 },
  { memberNo: '20138513', ic: '870313035407', name: 'MOHD RIDHUAN BIN ISMAIL', staffNo: '100180', employer: 648, employee: 594, wage: 5325.81 },
  { memberNo: '21729682', ic: '990830146005', name: 'MUHAMMAD FADZLIN BIN JAAFAR', staffNo: 'IDB006', employer: 492, employee: 416, wage: 3777.42 },
  { memberNo: '18690645', ic: '901010146619', name: 'NOOR AZID SHAH BIN DAUD', staffNo: '100777', employer: 351, employee: 297, wage: 2700 },
  { memberNo: '19807671', ic: '930508055434', name: 'NUR FARAH HANIM BINTI MOHAMED NAZIM', staffNo: '100009', employer: 900, employee: 825, wage: 7413 },
  { memberNo: '19686732', ic: '891002095050', name: 'SHAMIMI MAZWANI BT SAMSUDIN', staffNo: 'KK028', employer: 1200, employee: 1100, wage: 10000 },
];

const GOLDEN_EMPLOYEES: BorangAFileEmployee[] = borangAFileEmployeesFrom(GOLDEN_ROWS);

/** Kept as the literal restatement the mapper is checked against, one row deep. */
const GOLDEN_EMPLOYEES_LITERAL: BorangAFileEmployee[] = [
  { epfMemberNo: '22039094', icNumber: '941128035179', name: 'AHMAD AZMER IZAT BIN MAT YAZID', staffNo: 'IDB010', employerContribution: 708, employeeContribution: 649, wages: 5900 },
  { epfMemberNo: '22154734', icNumber: '970628105455', name: 'AHMAD MUHAIMIN BIN AZHAR', staffNo: '100502', employerContribution: 672, employeeContribution: 616, wages: 5600 },
  { epfMemberNo: '14957564', icNumber: '810329105276', name: 'FAZLIANA BINTI ISMAIL', staffNo: 'IDB-240001', employerContribution: 732, employeeContribution: 671, wages: 6052 },
  { epfMemberNo: '17712944', icNumber: '890714145496', name: 'HANISAH BINTI SHAMSUDIN', staffNo: 'IDB012', employerContribution: 1044, employeeContribution: 957, wages: 8700 },
  { epfMemberNo: '11534752', icNumber: '700325025036', name: 'HASLIZA BINTI AHMAD', staffNo: 'IDB007', employerContribution: 720, employeeContribution: 660, wages: 6000 },
  { epfMemberNo: '21278530', icNumber: '950604036119', name: 'JUKHAIRUL SYAFIQ BIN MOHD ZUKI', staffNo: 'IDB013', employerContribution: 637, employeeContribution: 539, wages: 4900 },
  { epfMemberNo: '18846253', icNumber: '920530016467', name: 'MOHAMMAD FAIZ BIN ABDUL GHANI', staffNo: '100507', employerContribution: 684, employeeContribution: 627, wages: 5650 },
  { epfMemberNo: '21482758', icNumber: '950102115175', name: 'MOHD ASRUL FARHAM BIN NOOR', staffNo: 'IDB002', employerContribution: 622, employeeContribution: 526, wages: 4777.42 },
  { epfMemberNo: '16681328', icNumber: '860823295779', name: 'MOHD NOR HAMDAN BIN AWANG', staffNo: 'IDB011', employerContribution: 984, employeeContribution: 902, wages: 8200 },
  { epfMemberNo: '20138513', icNumber: '870313035407', name: 'MOHD RIDHUAN BIN ISMAIL', staffNo: '100180', employerContribution: 648, employeeContribution: 594, wages: 5325.81 },
  { epfMemberNo: '21729682', icNumber: '990830146005', name: 'MUHAMMAD FADZLIN BIN JAAFAR', staffNo: 'IDB006', employerContribution: 492, employeeContribution: 416, wages: 3777.42 },
  { epfMemberNo: '18690645', icNumber: '901010146619', name: 'NOOR AZID SHAH BIN DAUD', staffNo: '100777', employerContribution: 351, employeeContribution: 297, wages: 2700 },
  { epfMemberNo: '19807671', icNumber: '930508055434', name: 'NUR FARAH HANIM BINTI MOHAMED NAZIM', staffNo: '100009', employerContribution: 900, employeeContribution: 825, wages: 7413 },
  { epfMemberNo: '19686732', icNumber: '891002095050', name: 'SHAMIMI MAZWANI BT SAMSUDIN', staffNo: 'KK028', employerContribution: 1200, employeeContribution: 1100, wages: 10000 },
];

/**
 * THE MAPPER IS THE GUARD. GOLDEN_EMPLOYEES above is built by borangAFileEmployeesFrom from row-shaped
 * literals; GOLDEN_EMPLOYEES_LITERAL is the same fourteen people written directly in the file's shape,
 * off the sample's own 02 records. If the mapper ever crosses the two contribution fields, these two
 * stop matching AND the byte-for-byte golden below fails — the second is what makes this more than a
 * restatement, because its expected bytes are a real KWSP file rather than anything written here.
 * Every row has employer > employee, so a swap cannot hide behind equal values.
 */
describe('cc74dcb2 — the payroll row to 02 record mapping', () => {
  it('maps employer, employee and wage into their own boxes, and never crosses them', () => {
    expect(GOLDEN_EMPLOYEES).toEqual(GOLDEN_EMPLOYEES_LITERAL);
    for (const e of GOLDEN_EMPLOYEES) {
      expect(e.employerContribution).toBeGreaterThan(e.employeeContribution);
    }
    // The one call site that produces a downloadable file reads the same function, so the shape below is
    // the shape the screen writes. Source-shape, because the call itself needs a request session.
    const shared = read('app/payroll/borang-a/shared.ts');
    expect(shared).toContain('employees: borangAFileEmployeesFrom(rows)');
    expect(shared).not.toMatch(/employerContribution:\s*r\.employee/);
    expect(shared).not.toMatch(/employeeContribution:\s*r\.employer/);
  });
});

/** The sample's own header values: employer 016231193, short code DSK, period 02/2026, made on 20/08/2026. */
const goldenInput: BorangAFileInput = {
  employer: { epfRefNo: '016231193', code: 'DSK', periodMonth: 2, periodYear: 2026 },
  employees: GOLDEN_EMPLOYEES,
  fileDate: new Date(2026, 7, 20),
  batchNo: 1,
};

/** One employee of the sample, for the tests that do not need all fourteen. 12% and 11% of 5,900. */
const SAMPLE: BorangAFileEmployee = GOLDEN_EMPLOYEES[0];

const input = (p: Partial<BorangAFileInput> = {}): BorangAFileInput => ({
  employer: { epfRefNo: '016231193', code: 'DSK', periodMonth: 8, periodYear: 2026 },
  employees: [SAMPLE],
  fileDate: new Date(2026, 7, 13),
  batchNo: 1,
  ...p,
});

const lines = (text: string) => borangAFileLines(text);
/** Overwrite one field of one record, keeping the line exactly as wide. The mutation the invariant catches. */
const setField = (line: string, spec: readonly [number, number], value: string) =>
  line.slice(0, spec[0]) + value.padStart(spec[1], '0').slice(0, spec[1]) + line.slice(spec[0] + spec[1]);
/** Reassemble mutated lines the way the writer does — CRLF between, none after the last. */
const rejoin = (l: readonly string[]) => l.join(BORANG_A_FILE_EOL);

/** Where two files first differ, in a form a person can act on. Used only when the golden test fails. */
function firstDifference(got: string, want: string): string {
  const g = got.split(BORANG_A_FILE_EOL);
  const w = want.split(BORANG_A_FILE_EOL);
  for (let i = 0; i < Math.max(g.length, w.length); i += 1) {
    if (g[i] === w[i]) continue;
    const col = [...(w[i] ?? '')].findIndex((c, j) => c !== (g[i] ?? '')[j]);
    return [
      `line ${i + 1} differs, first at column ${col + 1}:`,
      `  sample: ${JSON.stringify(w[i] ?? null)}`,
      `  built : ${JSON.stringify(g[i] ?? null)}`,
    ].join('\n');
  }
  return `the lines match; the difference is in the line endings (built ${got.length} characters, sample ${want.length})`;
}

/**
 * THE FIXTURE ITSELF, checked before it is used as a specification. If git, an editor or a merge ever
 * rewrites its line endings the golden test below would start failing for a reason that has nothing to
 * do with the writer, and this test says so first.
 */
describe('the sample KWSP file, as committed', () => {
  it('is 17 lines of exactly 129 characters, CRLF between them and none after the last', () => {
    expect(FIXTURE).toHaveLength(2225);
    const l = FIXTURE.split(BORANG_A_FILE_EOL);
    expect(l).toHaveLength(17);
    for (const [i, x] of l.entries()) expect(x.length, `line ${i + 1}`).toBe(BORANG_A_FILE_LINE_LENGTH);
    // 17 x 129 + 16 x 2 = 2225. The file ends at the last character of its 99 record.
    expect(17 * BORANG_A_FILE_LINE_LENGTH + 16 * BORANG_A_FILE_EOL.length).toBe(FIXTURE.length);
    expect(FIXTURE.endsWith(BORANG_A_FILE_EOL)).toBe(false);
    expect(FIXTURE.startsWith('00' + BORANG_A_FILE_DESCRIPTION)).toBe(true);
  });

  it('is pure ASCII, which is what makes a fixed-width record read the same everywhere', () => {
    expect(FIXTURE).toMatch(/^[\x20-\x7E\r\n]+$/);
  });
});

/**
 * ── THE GOLDEN TEST ───────────────────────────────────────────────────────────────────────────────
 *
 * The deliverable of cc74dcb2. Fourteen employees in, one file out, and it must equal a file KWSP
 * accepted, character for character. Nothing else in this suite can catch a field in the wrong box:
 * every other assertion here reads the same table the writer does, so writer and test drift together.
 * This one does not — the sample was produced by somebody else's software.
 */
describe('the golden file', () => {
  const built = buildBorangAFile(goldenInput);

  it('reproduces the customer’s EPFORMA2 file byte for byte', () => {
    expect(built, firstDifference(built, FIXTURE)).toBe(FIXTURE);
    expect(Buffer.byteLength(built, 'latin1')).toBe(Buffer.byteLength(FIXTURE, 'latin1'));
  });

  it('carries the sample’s own totals: employer 10,394.00 and employee 9,379.00, and no wage total', () => {
    const t = parseBorangAFileTotals(built);
    expect(t.detailCount).toBe(14);
    expect(t.trailerCount).toBe(14);
    expect([t.detailEmployerCents, t.headerEmployerCents, t.trailerEmployerCents]).toEqual([1039400, 1039400, 1039400]);
    expect([t.detailEmployeeCents, t.headerEmployeeCents, t.trailerEmployeeCents]).toEqual([937900, 937900, 937900]);
    // The wage total is 84,995.65 and appears NOWHERE in the file — which is why nothing checks it.
    expect(t.detailWageCents).toBe(8499565);
    expect(FIXTURE).not.toContain('8499565');
  });

  it('derives the trailer’s control total as the hash total of the member numbers', () => {
    const t = parseBorangAFileTotals(built);
    expect(t.memberNoSum).toBe('266741200');
    expect(t.controlTotal).toBe(t.memberNoSum);
    expect(GOLDEN_EMPLOYEES.reduce((a, e) => a + Number(e.epfMemberNo), 0)).toBe(266741200);
  });

  it('proves which amount is which from the sample’s own arithmetic', () => {
    // AHMAD MUHAIMIN: 672 is 12% of 5,600 and 616 is 11% — the employer's rate and the employee's. The
    // file that used to be produced here wrote 5,600 first, then 1,288, then zeros.
    const e = GOLDEN_EMPLOYEES[1];
    expect(e.employerContribution).toBe(e.wages * 0.12);
    expect(e.employeeContribution).toBe(e.wages * 0.11);
    const detail = lines(built)[3];
    expect(fileField(detail, BORANG_A_FILE_FIELDS.detail.employerContribution)).toBe('000067200');
    expect(fileField(detail, BORANG_A_FILE_FIELDS.detail.employeeContribution)).toBe('000061600');
    expect(fileField(detail, BORANG_A_FILE_FIELDS.detail.wages)).toBe('000000000560000');
  });
});

describe('the line geometry', () => {
  it('writes 129 characters per line, CRLF between lines and none after the last', () => {
    const text = buildBorangAFile(input());
    // The sample ends at the last character of its 99 record, and that is the only real file anyone here
    // has seen. A trailing CRLF would be two bytes it does not have.
    expect(text.endsWith(BORANG_A_FILE_EOL)).toBe(false);
    // The CR must be there between lines: a portal reading fixed-width records with a bare LF sees a
    // 128-character line and every field after the break shifts.
    expect(text).toContain('\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
    for (const [i, l] of lines(text).entries()) {
      expect(l.length, `line ${i + 1}`).toBe(BORANG_A_FILE_LINE_LENGTH);
    }
  });

  it('emits 00, 01, one 02 per employee, then 99 — in that order and no other', () => {
    const text = buildBorangAFile(input({ employees: [SAMPLE, { ...SAMPLE, name: 'SECOND PERSON' }] }));
    expect(lines(text).map((l) => fileField(l, BORANG_A_FILE_FIELDS.header.recordType))).toEqual(['00', '01', '02', '02', '99']);
  });

  it('still produces a well-formed file for a month with nobody on it', () => {
    const text = buildBorangAFile(input({ employees: [] }));
    const l = lines(text);
    expect(l.map((x) => fileField(x, BORANG_A_FILE_FIELDS.header.recordType))).toEqual(['00', '01', '99']);
    const t = parseBorangAFileTotals(text);
    expect([t.detailCount, t.trailerCount, t.headerEmployerCents, t.headerEmployeeCents]).toEqual([0, 0, 0, 0]);
    // No member numbers to hash, so the control total is zeros rather than a guess.
    expect(t.controlTotal).toBe('0');
  });
});

describe('every field lands where the sample says it does', () => {
  const text = buildBorangAFile(input());
  const [header, employer, detail, trailer] = lines(text);
  const F = BORANG_A_FILE_FIELDS;

  it('00 — header, whose two totals are the two CONTRIBUTIONS', () => {
    expect(fileField(header, F.header.recordType)).toBe('00');
    expect(fileField(header, F.header.description)).toBe(BORANG_A_FILE_DESCRIPTION);
    // YYYYMMDD, from the LOCAL calendar date, so a file produced on the 13th says the 13th.
    expect(fileField(header, F.header.fileDate)).toBe('20260813');
    expect(fileField(header, F.header.batchNo)).toBe('00001');
    // Amount x 100, zero-padded: 708.00 → 70800 and 649.00 → 64900. NOT the wage, which is 5,900.00.
    expect(fileField(header, F.header.totalEmployer)).toBe('000000000070800');
    expect(fileField(header, F.header.totalEmployee)).toBe('000000000064900');
    expect(fileField(header, F.header.filler)).toBe('0'.repeat(12));
    expect(fileField(header, F.header.employerRef)).toBe('016231193');
  });

  it('01 — employer, whose period is MMYYYY and NOT the header’s YYYYMMDD', () => {
    expect(fileField(employer, F.employer.recordType)).toBe('01');
    expect(fileField(employer, F.employer.filler1)).toBe('0'.repeat(10));
    expect(fileField(employer, F.employer.employerRef)).toBe('016231193');
    // The single most confusable field in the file: two records, two date orders.
    expect(fileField(employer, F.employer.period)).toBe('082026');
    expect(fileField(employer, F.employer.shortCode)).toBe('DSK');
    expect(fileField(employer, F.employer.batchNo)).toBe('00001');
    expect(fileField(employer, F.employer.filler2)).toBe('0'.repeat(8));
  });

  it('02 — employee detail: EMPLOYER, then EMPLOYEE, then WAGES', () => {
    expect(fileField(detail, F.detail.recordType)).toBe('02');
    expect(fileField(detail, F.detail.memberNo)).toBe('0000000000022039094');
    expect(fileField(detail, F.detail.ic)).toBe('941128035179');
    expect(fileField(detail, F.detail.filler)).toBe('   ');
    expect(fileField(detail, F.detail.name)).toBe('AHMAD AZMER IZAT BIN MAT YAZID'.padEnd(40, ' '));
    expect(fileField(detail, F.detail.staffNo)).toBe('IDB010'.padEnd(20, ' '));
    expect(fileField(detail, F.detail.employerContribution)).toBe('000070800');
    expect(fileField(detail, F.detail.employeeContribution)).toBe('000064900');
    // FIFTEEN wide, and the wage rather than an account balance. There is no balance field: KWSP holds a
    // member's balance and this box is not it.
    expect(fileField(detail, F.detail.wages)).toBe('000000000590000');
  });

  it('99 — trailer, whose control total is derived and whose two totals match the header’s', () => {
    expect(fileField(trailer, F.trailer.recordType)).toBe('99');
    expect(fileField(trailer, F.trailer.recordCount)).toBe('0000001');
    expect(fileField(trailer, F.trailer.totalEmployer)).toBe('000000000070800');
    expect(fileField(trailer, F.trailer.totalEmployee)).toBe('000000000064900');
    // 12 zeros of filler, then a NINE-wide control total. The sample cannot tell that apart from one
    // 21-wide field — its own hash fits in nine digits either way — and the module's header records why
    // the narrow reading wins: the 00 record ends in exactly this shape, and 3aae0789's independent
    // transcription said the same before this sample existed.
    expect(fileField(trailer, F.trailer.filler)).toBe('0'.repeat(12));
    expect(fileField(trailer, F.trailer.controlTotal)).toBe('022039094');
  });

  it('leaves no gap and no overlap: the declared fields plus the padding ARE the line', () => {
    // The property that makes every offset above worth trusting. A field table with a hole in it can
    // still pass every assertion in this describe while the file has a column nobody writes.
    for (const v of describeBorangAFile(text)) {
      expect(v.fields.map((f) => f.value).join(''), `line ${v.lineNo}`).toBe(lines(text)[v.lineNo - 1]);
      let at = 0;
      for (const f of v.fields) {
        expect(f.offset, `line ${v.lineNo} field ${f.name}`).toBe(at);
        at += f.length;
      }
      expect(at).toBe(BORANG_A_FILE_LINE_LENGTH);
    }
  });

  it('writes a supplied control number verbatim, and derives one otherwise', () => {
    const withControl = buildBorangAFile(input({ trailerControlNumber: '196562715' }));
    const F2 = BORANG_A_FILE_FIELDS.trailer.controlTotal;
    expect(fileField(lines(withControl)[3], F2)).toBe('196562715');
    // …and every other record is byte-identical, which is what "an override, not a rewrite" means: no
    // other field may move because this one changed.
    const derived = buildBorangAFile(input());
    expect(lines(withControl).slice(0, -1)).toEqual(lines(derived).slice(0, -1));
    expect(fileField(lines(derived)[3], F2)).not.toBe(fileField(lines(withControl)[3], F2));
  });

  /**
   * A HASH TOTAL TOO BIG FOR THE FIELD IS WRITTEN AS ZEROS, NOT REFUSED AND NOT TRUNCATED — and this is
   * the case where the sample stops being evidence. Nine digits runs out at roughly 46 employees on
   * eight-digit member numbers, which is an ordinary employer, so refusing would stop them filing at all
   * and truncating to the low nine would invent a rule. Zeros is what this file carried before the total
   * was derivable, so it is the one option that cannot be newly wrong. The validation report says it
   * happened; nothing else would tell the operator.
   */
  it('writes zeros, not a truncation, when the hash total will not fit the nine-digit field', () => {
    const big = ['9'.repeat(19), '9'.repeat(19), '9'.repeat(19)].map((m, i) => ({
      ...SAMPLE,
      name: `PERSON ${i}`,
      epfMemberNo: m,
    }));
    const text2 = buildBorangAFile(input({ employees: big }));
    const t = parseBorangAFileTotals(text2);
    expect(t.memberNoSum).toBe('29999999999999999997'); // the real sum, still reported
    expect(t.controlTotal).toBe('0'); // …but the field could not carry it
    expect(fileField(lines(text2)[5], BORANG_A_FILE_FIELDS.trailer.controlTotal)).toBe('000000000');
    // NOT the low nine digits of the sum, which is the mistake this case exists to prevent.
    expect(fileField(lines(text2)[5], BORANG_A_FILE_FIELDS.trailer.controlTotal)).not.toBe('999999997');
    // And the file is still offered: a 46-employee employer must be able to file.
    expect(() => buildBorangAFile(input({ employees: big }))).not.toThrow();
    // The report is where the operator learns it.
    expect(borangAFileReport(text2)).toContain('written as zeros');
  });
});

/**
 * THE INVARIANT — the one thing in this module that decides whether a download happens.
 *
 * `buildBorangAFile` re-reads its own emitted characters before returning them, so this check runs
 * against the bytes rather than against the writer's arithmetic. The mutation test below is what proves
 * that: it corrupts a file that was already built and verified, and the checker still catches it.
 */
describe('the totals invariant refuses rather than emitting a file i-Akaun will reject', () => {
  const good = buildBorangAFile(
    input({
      employees: [SAMPLE, { ...SAMPLE, name: 'SECOND PERSON', employerContribution: 264.12, employeeContribution: 242.11, wages: 2201 }],
    }),
  );

  it('accepts the file it just built', () => {
    expect(() => assertBorangAFileBalances(good)).not.toThrow();
    const t = parseBorangAFileTotals(good);
    expect(t.headerEmployerCents).toBe(t.detailEmployerCents);
    expect(t.trailerEmployerCents).toBe(t.detailEmployerCents);
    expect(t.headerEmployeeCents).toBe(t.detailEmployeeCents);
    expect(t.trailerEmployeeCents).toBe(t.detailEmployeeCents);
    expect(t.trailerCount).toBe(t.detailCount);
    // Summed independently of the writer: 708.00 + 264.12 and 649.00 + 242.11.
    expect(t.detailEmployerCents).toBe(70800 + 26412);
    expect(t.detailEmployeeCents).toBe(64900 + 24211);
  });

  it('MUTATING ONE 02 LINE’S EMPLOYER CONTRIBUTION makes the file refuse', () => {
    const l = lines(good);
    // Row 2 (index 3) gains one ringgit that no total knows about. Everything else is untouched, the
    // line is still 129 characters, and every record type is still in place — so ONLY the invariant can
    // see this.
    l[3] = setField(l[3], BORANG_A_FILE_FIELDS.detail.employerContribution, String(26412 + 100));
    const mutated = rejoin(l);
    expect(mutated.length).toBe(good.length);
    expect(() => assertBorangAFileBalances(mutated)).toThrow(BorangAFileError);
    expect(() => assertBorangAFileBalances(mutated)).toThrow(/total employer contribution does not add up/);
  });

  it('catches a mutated EMPLOYEE contribution too, not only the employer’s', () => {
    const l = lines(good);
    l[2] = setField(l[2], BORANG_A_FILE_FIELDS.detail.employeeContribution, String(64900 + 1));
    expect(() => assertBorangAFileBalances(rejoin(l))).toThrow(/total employee contribution does not add up/);
  });

  it('does NOT check the wage column, because no record in this format carries a wage total', () => {
    // NOT AN OVERSIGHT — a fact about the file, and the reason it is written down. The sample's own wage
    // total, 84,995.65, appears in none of its 17 lines. A check invented here would have to compare the
    // wage sum against something the format does not have, and the only way to do that is to make one up.
    const l = lines(good);
    l[2] = setField(l[2], BORANG_A_FILE_FIELDS.detail.wages, String(590000 + 1));
    expect(() => assertBorangAFileBalances(rejoin(l))).not.toThrow();
    expect(parseBorangAFileTotals(rejoin(l)).detailWageCents).toBe(590000 + 1 + 220100);
  });

  it('catches a trailer whose count disagrees with the number of 02 records', () => {
    const l = lines(good);
    l[l.length - 1] = setField(l[l.length - 1], BORANG_A_FILE_FIELDS.trailer.recordCount, '9');
    expect(() => assertBorangAFileBalances(rejoin(l))).toThrow(/record count does not match/);
  });

  it('catches a HEADER that disagrees while the trailer still agrees, and vice versa', () => {
    const l = lines(good);
    const bumpedHeader = [...l];
    bumpedHeader[0] = setField(bumpedHeader[0], BORANG_A_FILE_FIELDS.header.totalEmployer, '1');
    expect(() => assertBorangAFileBalances(rejoin(bumpedHeader))).toThrow(/the header says/);
    const bumpedTrailer = [...l];
    const last = bumpedTrailer.length - 1;
    bumpedTrailer[last] = setField(bumpedTrailer[last], BORANG_A_FILE_FIELDS.trailer.totalEmployee, '1');
    expect(() => assertBorangAFileBalances(rejoin(bumpedTrailer))).toThrow(/the trailer says/);
  });

  it('refuses a file whose lines are not all 129 characters', () => {
    const l = lines(good);
    l[2] = l[2].slice(0, 128);
    expect(() => assertBorangAFileBalances(rejoin(l))).toThrow(/128 characters/);
  });
});

/**
 * THE REFUSALS. Each one exists because the alternative — truncating, or padding, or writing a zero — puts
 * somebody else's number on somebody's contribution and nothing downstream can tell.
 */
describe('what it refuses to write', () => {
  it('refuses a non-numeric employer reference, which production actually has', () => {
    // MEASURED 2026-08-13: one of the three companies with an EPF employer reference has `xx` in the box.
    expect(() => buildBorangAFile(input({ employer: { epfRefNo: 'xx', periodMonth: 8, periodYear: 2026 } }))).toThrow(
      /must be digits only/,
    );
  });

  it('refuses an EPF member number that is not digits, which production also actually has', () => {
    // MEASURED: four of the nine employees who have a member number carry `EPF9203030`-shaped values.
    expect(() =>
      buildBorangAFile(input({ employees: [{ ...SAMPLE, epfMemberNo: 'EPF9203030' }] })),
    ).toThrow(/EPF member number: must be digits only/);
  });

  it('names the PERSON in a per-employee refusal, not just the field', () => {
    expect(() =>
      buildBorangAFile(input({ employees: [{ ...SAMPLE, name: 'SITI BINTI ALI', epfMemberNo: '' }] })),
    ).toThrow(/SITI BINTI ALI/);
  });

  it('refuses an identity card number that is not exactly twelve digits once dashes are stripped', () => {
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, icNumber: '94112803517' }] }))).toThrow(
      /exactly 12 digits/,
    );
    // …but dashes and spaces are fine, because that is a formatting difference, not a data error.
    const dashed = buildBorangAFile(input({ employees: [{ ...SAMPLE, icNumber: '941128-03-5179' }] }));
    expect(fileField(lines(dashed)[2], BORANG_A_FILE_FIELDS.detail.ic)).toBe('941128035179');
  });

  it('refuses a negative amount rather than writing a minus sign into a digit field', () => {
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, employeeContribution: -1 }] }))).toThrow(/negative/);
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, wages: -1 }] }))).toThrow(/negative/);
  });

  it('refuses a contribution too large for its nine-digit field rather than truncating it', () => {
    // The 02 contribution fields are 9 digits, i.e. at most 9,999,999.99 each.
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, employerContribution: 10_000_000 }] }))).toThrow(
      /employer contribution: 1000000000 needs 10 digits and the field holds 9/,
    );
    // The WAGE field is fifteen wide, so a wage that would not fit a contribution box still fits its own.
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, wages: 10_000_000 }] }))).not.toThrow();
  });

  it('refuses a short code longer than three characters, and writes three spaces for a blank one', () => {
    expect(() =>
      buildBorangAFile(input({ employer: { epfRefNo: '016231193', code: 'ABCD', periodMonth: 8, periodYear: 2026 } })),
    ).toThrow(/at most 3 characters/);
    const blank = buildBorangAFile(input({ employer: { epfRefNo: '016231193', periodMonth: 8, periodYear: 2026 } }));
    expect(fileField(lines(blank)[1], BORANG_A_FILE_FIELDS.employer.shortCode)).toBe('   ');
  });

  it('refuses a month outside 1-12 rather than writing 13 into the period', () => {
    expect(() =>
      buildBorangAFile(input({ employer: { epfRefNo: '016231193', periodMonth: 13, periodYear: 2026 } })),
    ).toThrow(/must be 1-12/);
  });

  it('refuses a non-numeric control number instead of quietly falling back to the derived one', () => {
    expect(() => buildBorangAFile(input({ trailerControlNumber: 'ABC' }))).toThrow(/must be digits only/);
  });
});

/**
 * THE TWO FIELDS ALLOWED TO LOSE INFORMATION, and nothing else. A 41-character legal name is not a data
 * error and a form is not worth refusing over it; a member number that does not fit is.
 */
describe('names and staff numbers are the only truncations', () => {
  it('uppercases and truncates a long name to the 40-character box', () => {
    const long = 'ABDUL RAHMAN BIN MOHAMED ZULKIFLI BIN HASSAN ABDULLAH';
    const text = buildBorangAFile(input({ employees: [{ ...SAMPLE, name: long }] }));
    const cell = fileField(lines(text)[2], BORANG_A_FILE_FIELDS.detail.name);
    expect(cell).toHaveLength(40);
    expect(cell).toBe(long.slice(0, 40));
  });

  it('uppercases a lower-case name rather than writing it as typed', () => {
    const text = buildBorangAFile(input({ employees: [{ ...SAMPLE, name: 'ang pei yee' }] }));
    expect(fileField(lines(text)[2], BORANG_A_FILE_FIELDS.detail.name).trim()).toBe('ANG PEI YEE');
  });

  it('replaces a non-ASCII character rather than shifting every field after it', () => {
    // A fixed-width record read as latin-1 would gain a byte per multi-byte character, and everything
    // after the name would move. Substituting a space keeps the geometry, which is what matters here.
    const text = buildBorangAFile(input({ employees: [{ ...SAMPLE, name: 'JOSÉ MÜLLER 陈' }] }));
    for (const l of lines(text)) expect(l).toHaveLength(BORANG_A_FILE_LINE_LENGTH);
    expect(fileField(lines(text)[2], BORANG_A_FILE_FIELDS.detail.name)).toMatch(/^[\x20-\x7E]+$/);
  });

  it('truncates a staff number to its 20-character box', () => {
    const text = buildBorangAFile(input({ employees: [{ ...SAMPLE, staffNo: 'X'.repeat(30) }] }));
    expect(fileField(lines(text)[2], BORANG_A_FILE_FIELDS.detail.staffNo)).toBe('X'.repeat(20));
  });
});

/**
 * THE VALIDATION REPORT — the document an operator holds beside a KWSP sample before uploading anything.
 * It is a view over the emitted characters, so its only job is to be a TRUE description of them.
 */
describe('the field-by-field check report', () => {
  const text = buildBorangAFile(goldenInput);
  const report = borangAFileReport(text);

  it('describes every line of the file, and reads every value out of the file itself', () => {
    const views = describeBorangAFile(text);
    expect(views).toHaveLength(17);
    for (const v of views) {
      expect(v.length).toBe(BORANG_A_FILE_LINE_LENGTH);
      const source = lines(text)[v.lineNo - 1];
      for (const f of v.fields) {
        // Read back with the table, which is the only place an offset exists.
        expect(f.value, `line ${v.lineNo} field ${f.name}`).toBe(source.slice(f.offset, f.offset + f.length));
        expect(f.firstColumn).toBe(f.offset + 1);
        expect(f.lastColumn).toBe(f.offset + f.length);
      }
    }
  });

  it('prints the columns and value of every field of every line', () => {
    for (const v of describeBorangAFile(text)) {
      expect(report).toContain(`LINE ${v.lineNo} - record type ${v.recordType}`);
      for (const f of v.fields) {
        expect(report, `line ${v.lineNo} ${f.name}`).toContain(`${f.firstColumn}-${f.lastColumn}`);
        expect(report, `line ${v.lineNo} ${f.name} value`).toContain(`[${f.value}]`);
      }
    }
    expect(report).toContain(`every line is ${BORANG_A_FILE_LINE_LENGTH} characters`);
    expect(report).toContain('Lines: 17');
  });

  it('states the totals it can check and says plainly that the wage total is not one of them', () => {
    expect(report).toContain('RM 10394.00');
    expect(report).toContain('RM 9379.00');
    expect(report).toContain('RM 84995.65');
    expect(report).toContain('No record in this format carries a wage total');
    expect(report).toContain('266741200, which is the sum of the 14 EPF member numbers');
  });

  it('says so when the control total was supplied rather than derived', () => {
    const supplied = borangAFileReport(buildBorangAFile({ ...goldenInput, trailerControlNumber: '5' }));
    expect(supplied).toContain('It was supplied rather than derived');
    expect(supplied).toContain('sum to 266741200');
  });

  it('reports a line that is the wrong length instead of describing it as if it were right', () => {
    const l = lines(text);
    l[2] = l[2].slice(0, 100);
    const broken = borangAFileReport(rejoin(l));
    expect(broken).toContain('line 3 is 100');
    expect(broken).toContain('does not parse as a Borang A upload file');
  });

  it('is pure ASCII, like the file it describes', () => {
    expect(report).toMatch(/^[\x20-\x7E\n]+$/);
  });

  it('reads its offsets ONLY from the field table — there is no second copy in the module', () => {
    // The report is only worth reading if it cannot describe a layout the writer does not use. Strip the
    // one table and no `[offset, width]` pair and no numeric two-argument slice may remain anywhere in
    // the module — including in the writer, the parser and the report.
    const src = read('lib/kwsp-borang-a-file.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/export const BORANG_A_FILE_FIELDS = \{[\s\S]*?\n\} as const;/, '');
    expect(src).not.toMatch(/\[\s*\d+\s*,\s*\d+\s*\]/);
    expect(src).not.toMatch(/\.slice\(\s*\d+\s*,\s*\d+\s*\)/);
  });
});

/**
 * READINESS — what stops the file BEFORE anybody presses download. This is the list that turns "KWSP
 * rejected your file" into "these four people need a member number recorded", and the production shapes
 * below are why it exists in the form it does.
 */
describe('the readiness check names what is missing before the download', () => {
  const row = (p: Partial<{ employmentId: string; name: string; memberNo: string; ic: string; wageRecorded: boolean }>) => ({
    employmentId: 'e1',
    name: 'ANG PEI YEE',
    memberNo: '17955667',
    ic: '860208105128',
    wageRecorded: true,
    ...p,
  });

  it('passes a complete company', () => {
    const r = borangAFileReadiness({ employerRef: '016231193', rows: [row({})] });
    expect(r).toEqual({ employer: [], employees: [], ok: true });
  });

  it('names the employer-level gap once, not once per employee', () => {
    const r = borangAFileReadiness({
      employerRef: '',
      rows: [row({ employmentId: 'a' }), row({ employmentId: 'b' })],
    });
    expect(r.employer).toHaveLength(1);
    expect(r.employees).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('distinguishes an ABSENT member number from a MALFORMED one, because the fixes differ', () => {
    const absent = borangAFileReadiness({ employerRef: '016231193', rows: [row({ memberNo: '' })] });
    expect(absent.employees[0].problem).toBe('no EPF member number');
    const malformed = borangAFileReadiness({ employerRef: '016231193', rows: [row({ memberNo: 'EPF9203030' })] });
    expect(malformed.employees[0].problem).toMatch(/not digits only/);
  });

  it('flags a payroll run that recorded no EPF wage basis, and never lets it fall back to gross pay', () => {
    const r = borangAFileReadiness({ employerRef: '016231193', rows: [row({ wageRecorded: false })] });
    expect(r.ok).toBe(false);
    expect(r.employees[0].problem).toMatch(/no EPF wage basis/);
  });

  it('agrees with the writer: everything readiness passes, the writer accepts', () => {
    // The property that makes the two lists worth having — a readiness check that says "ready" and a
    // writer that then refuses is worse than no check at all.
    const rows = [row({ employmentId: 'a' }), row({ employmentId: 'b', memberNo: '19807671', ic: '910416145530' })];
    expect(borangAFileReadiness({ employerRef: '016231193', rows }).ok).toBe(true);
    expect(() =>
      buildBorangAFile(
        input({
          employees: rows.map((r) => ({
            epfMemberNo: r.memberNo,
            icNumber: r.ic,
            name: r.name,
            staffNo: '',
            employerContribution: 13,
            employeeContribution: 11,
            wages: 100,
          })),
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * INDEPENDENCE FROM BORANG 8A, asserted on the SOURCE. The two forms have opposite contribution-month
 * rules, and the failure this pair guards against is one module acquiring the other's through a shared
 * helper that grew a parameter.
 */
describe('the KWSP file module stands alone', () => {
  it('imports nothing from the PERKESO modules, and nothing imports it from there', () => {
    const src = read('lib/kwsp-borang-a-file.ts');
    expect(src).not.toContain("from './borang-8a'");
    expect(src).not.toContain('borang-8a-pdf');
    expect(read('lib/borang-8a.ts')).not.toContain('borang-a');
    // It is also PURE: no database, no pack, no React, so every rule above is testable without any of them.
    for (const forbidden of ['db/', 'drizzle', 'localization/', 'react']) {
      expect(src, `lib/kwsp-borang-a-file.ts must not reach for ${forbidden}`).not.toContain(`from '${forbidden}`);
    }
  });

  it('no longer claims the reverse-engineered tables of 3aae0789 as its specification', () => {
    // The comment that said "THE REQUEST IS THE SPECIFICATION AND IS NOT RE-DERIVED HERE" is exactly how
    // the amounts ended up in the wrong boxes, and a stale comment would send the next reader back to it.
    const src = read('lib/kwsp-borang-a-file.ts');
    expect(src).toContain(FIXTURE_PATH);
    expect(src).not.toContain('THE REQUEST IS THE SPECIFICATION');
    // No box called `balance` survives anywhere: that field is the WAGES field.
    expect(src).not.toContain('balance');
  });
});
