/**
 * 3aae0789 — THE KWSP BORANG A UPLOAD FILE for i-Akaun.
 *
 * WHAT THIS FILE IS FOR, IN ONE SENTENCE: the fixed-width layout, and the totals invariant that decides
 * whether a file is offered at all. Both fail SILENTLY — a file with one field a column too far left, or
 * a trailer that does not agree with its own detail lines, downloads exactly like a correct one and is
 * discovered when i-Akaun rejects it, by which time nobody can see which of 129 columns moved.
 *
 * THE SPECIFICATION IS THE REQUEST'S OWN FIELD TABLE, and this file does not restate it: every offset
 * below is read out of `BORANG_A_FILE_FIELDS`, which is the single transcription. A test that hardcoded
 * `line.slice(96, 105)` would pass against a writer that had drifted, because both would have been edited
 * together — the point is that the WRITER and the READER agree with THE TABLE.
 *
 * THE SAMPLE VALUES ARE THE REPORTER'S OWN, from the `generateBorangAFile` signature in the request:
 * employer 016231193 / DSK / 08-2026, member 0000000000022039094, IC 941128035179,
 * AHMAD AZMER IZAT BIN MAT YAZID, staff IDB010, wages 684, contribution 627, balance 5677.00.
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
  borangAFileReadiness,
  buildBorangAFile,
  fileField,
  parseBorangAFileTotals,
  type BorangAFileEmployee,
  type BorangAFileInput,
} from '../lib/kwsp-borang-a-file';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SAMPLE: BorangAFileEmployee = {
  epfMemberNo: '0000000000022039094',
  icNumber: '941128035179',
  name: 'AHMAD AZMER IZAT BIN MAT YAZID',
  staffNo: 'IDB010',
  wages: 684,
  contribution: 627,
  balance: 5677.0,
};

const input = (p: Partial<BorangAFileInput> = {}): BorangAFileInput => ({
  employer: { epfRefNo: '016231193', code: 'DSK', periodMonth: 8, periodYear: 2026 },
  employees: [SAMPLE],
  fileDate: new Date(2026, 7, 13),
  batchNo: 1,
  ...p,
});

const lines = (text: string) => text.split(BORANG_A_FILE_EOL).filter((l) => l.length > 0);
/** Overwrite one field of one record, keeping the line exactly as wide. The mutation the invariant catches. */
const setField = (line: string, spec: readonly [number, number], value: string) =>
  line.slice(0, spec[0]) + value.padStart(spec[1], '0').slice(0, spec[1]) + line.slice(spec[0] + spec[1]);

describe('the line geometry', () => {
  it('writes 129 characters per line, CRLF-terminated, including the last line', () => {
    const text = buildBorangAFile(input());
    expect(text.endsWith(BORANG_A_FILE_EOL)).toBe(true);
    // The CR must be there: a portal reading fixed-width records with a bare LF sees a 128-character
    // line and every field after the break shifts.
    expect(text.includes('\r\n')).toBe(true);
    for (const [i, l] of lines(text).entries()) {
      expect(l.length, `line ${i + 1}`).toBe(BORANG_A_FILE_LINE_LENGTH);
    }
  });

  it('emits 00, 01, one 02 per employee, then 99 — in that order and no other', () => {
    const text = buildBorangAFile(input({ employees: [SAMPLE, { ...SAMPLE, name: 'SECOND PERSON' }] }));
    expect(lines(text).map((l) => l.slice(0, 2))).toEqual(['00', '01', '02', '02', '99']);
  });

  it('still produces a well-formed file for a month with nobody on it', () => {
    const text = buildBorangAFile(input({ employees: [] }));
    const l = lines(text);
    expect(l.map((x) => x.slice(0, 2))).toEqual(['00', '01', '99']);
    const t = parseBorangAFileTotals(text);
    expect([t.detailCount, t.trailerCount, t.headerWageCents, t.headerContribCents]).toEqual([0, 0, 0, 0]);
  });
});

describe('every field lands where the request’s table says it does', () => {
  const text = buildBorangAFile(input());
  const [header, employer, detail, trailer] = lines(text);
  const F = BORANG_A_FILE_FIELDS;

  it('00 — header', () => {
    expect(fileField(header, F.header.recordType)).toBe('00');
    expect(fileField(header, F.header.description)).toBe(BORANG_A_FILE_DESCRIPTION);
    // YYYYMMDD, from the LOCAL calendar date, so a file produced on the 13th says the 13th.
    expect(fileField(header, F.header.fileDate)).toBe('20260813');
    expect(fileField(header, F.header.batchNo)).toBe('00001');
    // Amount x 100, zero-padded: 684.00 → 68400.
    expect(fileField(header, F.header.totalWages)).toBe('000000000068400');
    expect(fileField(header, F.header.totalContribution)).toBe('000000000062700');
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

  it('02 — employee detail', () => {
    expect(fileField(detail, F.detail.recordType)).toBe('02');
    expect(fileField(detail, F.detail.memberNo)).toBe('0000000000022039094');
    expect(fileField(detail, F.detail.ic)).toBe('941128035179');
    expect(fileField(detail, F.detail.filler)).toBe('   ');
    expect(fileField(detail, F.detail.name)).toBe('AHMAD AZMER IZAT BIN MAT YAZID'.padEnd(40, ' '));
    expect(fileField(detail, F.detail.staffNo)).toBe('IDB010'.padEnd(20, ' '));
    expect(fileField(detail, F.detail.wages)).toBe('000068400');
    expect(fileField(detail, F.detail.contribution)).toBe('000062700');
    expect(fileField(detail, F.detail.balance)).toBe('000000000567700');
  });

  it('99 — trailer, whose control number defaults to zeros because nobody has derived it', () => {
    expect(fileField(trailer, F.trailer.recordType)).toBe('99');
    expect(fileField(trailer, F.trailer.recordCount)).toBe('0000001');
    expect(fileField(trailer, F.trailer.totalWages)).toBe('000000000068400');
    expect(fileField(trailer, F.trailer.totalContribution)).toBe('000000000062700');
    expect(fileField(trailer, F.trailer.filler)).toBe('0'.repeat(12));
    // UNRESOLVED. Zeros unless somebody supplies one — never derived from the totals or the reference.
    expect(fileField(trailer, F.trailer.controlNumber)).toBe('000000000');
  });

  it('writes a supplied control number verbatim, and never invents one', () => {
    const withControl = buildBorangAFile(input({ trailerControlNumber: '196562715' }));
    expect(fileField(lines(withControl)[2 + 1], BORANG_A_FILE_FIELDS.trailer.controlNumber)).toBe('196562715');
    // …and every other record is byte-identical, which is what "a parameter, not a derivation" means: no
    // other field may move because this one changed.
    const withoutControl = buildBorangAFile(input());
    expect(lines(withControl).slice(0, -1)).toEqual(lines(withoutControl).slice(0, -1));
  });

  it('never writes the employer reference into the control-number field', () => {
    // The reporter established this negative explicitly: the control number is NOT the employer reference,
    // and the most likely wrong guess is to reuse it because both are nine digits.
    expect(fileField(trailer, F.trailer.controlNumber)).not.toBe(fileField(header, F.header.employerRef));
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
      employees: [SAMPLE, { ...SAMPLE, name: 'SECOND PERSON', wages: 1200.55, contribution: 264.12 }],
    }),
  );

  it('accepts the file it just built', () => {
    expect(() => assertBorangAFileBalances(good)).not.toThrow();
    const t = parseBorangAFileTotals(good);
    expect(t.headerWageCents).toBe(t.detailWageCents);
    expect(t.trailerWageCents).toBe(t.detailWageCents);
    expect(t.headerContribCents).toBe(t.detailContribCents);
    expect(t.trailerContribCents).toBe(t.detailContribCents);
    expect(t.trailerCount).toBe(t.detailCount);
    // Summed independently of the writer: 684.00 + 1200.55 and 627.00 + 264.12.
    expect(t.detailWageCents).toBe(68400 + 120055);
    expect(t.detailContribCents).toBe(62700 + 26412);
  });

  it('MUTATING ONE 02 LINE’S CONTRIBUTION makes the file refuse — the test the item asks for by name', () => {
    const l = lines(good);
    // Row 2 (index 3) gains one ringgit that no total knows about. Everything else is untouched, the
    // line is still 129 characters, and every record type is still in place — so ONLY the invariant can
    // see this.
    l[3] = setField(l[3], BORANG_A_FILE_FIELDS.detail.contribution, String(26412 + 100));
    const mutated = l.map((x) => x + BORANG_A_FILE_EOL).join('');
    expect(mutated.length).toBe(good.length);
    expect(() => assertBorangAFileBalances(mutated)).toThrow(BorangAFileError);
    expect(() => assertBorangAFileBalances(mutated)).toThrow(/total contribution does not add up/);
  });

  it('catches a mutated WAGE too, not only a contribution', () => {
    const l = lines(good);
    l[2] = setField(l[2], BORANG_A_FILE_FIELDS.detail.wages, String(68400 + 1));
    expect(() => assertBorangAFileBalances(l.map((x) => x + BORANG_A_FILE_EOL).join(''))).toThrow(
      /total wages do not add up/,
    );
  });

  it('catches a trailer whose count disagrees with the number of 02 records', () => {
    const l = lines(good);
    l[l.length - 1] = setField(l[l.length - 1], BORANG_A_FILE_FIELDS.trailer.recordCount, '9');
    expect(() => assertBorangAFileBalances(l.map((x) => x + BORANG_A_FILE_EOL).join(''))).toThrow(
      /record count does not match/,
    );
  });

  it('catches a HEADER that disagrees while the trailer still agrees, and vice versa', () => {
    const l = lines(good);
    const bumpedHeader = [...l];
    bumpedHeader[0] = setField(bumpedHeader[0], BORANG_A_FILE_FIELDS.header.totalWages, '1');
    expect(() => assertBorangAFileBalances(bumpedHeader.map((x) => x + BORANG_A_FILE_EOL).join(''))).toThrow(
      /the header says/,
    );
    const bumpedTrailer = [...l];
    const last = bumpedTrailer.length - 1;
    bumpedTrailer[last] = setField(bumpedTrailer[last], BORANG_A_FILE_FIELDS.trailer.totalWages, '1');
    expect(() => assertBorangAFileBalances(bumpedTrailer.map((x) => x + BORANG_A_FILE_EOL).join(''))).toThrow(
      /the trailer says/,
    );
  });

  it('refuses a file whose lines are not all 129 characters', () => {
    const l = lines(good);
    l[2] = l[2].slice(0, 128);
    expect(() => assertBorangAFileBalances(l.map((x) => x + BORANG_A_FILE_EOL).join(''))).toThrow(/128 characters/);
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
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, contribution: -1 }] }))).toThrow(/negative/);
  });

  it('refuses an amount too large for its field rather than truncating it', () => {
    // The 02 wages field is 9 digits, i.e. at most 9,999,999.99.
    expect(() => buildBorangAFile(input({ employees: [{ ...SAMPLE, wages: 10_000_000 }] }))).toThrow(
      /needs 10 digits and the field holds 9/,
    );
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

  it('refuses a non-numeric control number instead of quietly falling back to zeros', () => {
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
            wages: 100,
            contribution: 24,
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
});
