/**
 * 0d02d4a1 (r340) — THE LHDN FILE NAME HAS ONE DEFINITION, AND IT IS THE SPEC'S.
 *
 * ⚠️ THIS IS A GUARD, NOT A FIX, AND SAYING WHICH MATTERS. The name `buildCp39File` produces was ALREADY
 * `xxxxxxxxxxmm_yyyy.txt` and is already asserted at three call sites (test/slice0.test.ts:2164 and :2213,
 * test/cp39-form.test.ts:438). What r340 changed is that the rule is now an EXPORTED function rather than a
 * template literal inside the builder, so a second surface offering this file asks for the name instead of
 * formatting one — the property `borangAUploadFilename` and `perkesoUploadFilename` already have, and which
 * r336 introduced precisely because two screens naming one month's file differently leaves an operator
 * unable to tell which file they are uploading. These assertions would pass against the old code too; they
 * exist so the extraction cannot drift from the builder, and a claim that they prove a behaviour change
 * would be false.
 *
 * SOURCE: LHDN "Specification for MTD Calculations Using Computerized Calculation for 2026", Exhibit 4 —
 * `xxxxxxxxxxmm_yyyy.txt`, where `xxxxxxxxxx` is the employer number, `mm` the month of deduction and
 * `yyyy` the year of deduction. The employer-number forms are Exhibit 5's own worked examples.
 */
import { describe, expect, it } from 'vitest';
import { buildCp39File, cp39UploadFilename, normalizeEmployerNo } from '../localization/my/cp39-file';

/** Exhibit 4's own naming convention, as a pattern: ten digits, a two-digit month, `_`, four-digit year. */
const LHDN_NAME = /^\d{10}(0[1-9]|1[0-2])_\d{4}\.txt$/;

describe('0d02d4a1 — cp39UploadFilename', () => {
  it('names the file the way Exhibit 4 does, for Exhibit 5’s own employer number', () => {
    // "E 908915-10" is the specification's worked employer number; normalised it is 0090891510.
    expect(normalizeEmployerNo('E 908915-10')).toBe('0090891510');
    const name = cp39UploadFilename({ employerNo: 'E 908915-10', year: 2026, month: 1 });
    expect(name).toBe('009089151001_2026.txt');
    expect(name).toMatch(LHDN_NAME);
  });

  it('normalises the employer number, so a raw E-number and its digits name one file', () => {
    expect(cp39UploadFilename({ employerNo: 'E 908915-10', year: 2026, month: 12 })).toBe(
      cp39UploadFilename({ employerNo: '0090891510', year: 2026, month: '12' }),
    );
  });

  it('zero-pads the month — a single-digit month would not be the spec’s `mm`', () => {
    expect(cp39UploadFilename({ employerNo: '0291212306', year: 2002, month: 5 })).toBe('029121230605_2002.txt');
    expect(cp39UploadFilename({ employerNo: '0291212306', year: 2002, month: 5 })).toMatch(LHDN_NAME);
  });

  it('is the SAME definition the builder uses — the shelf and the route cannot name one month differently', () => {
    const built = buildCp39File({
      employerNo: 'E 908915-10',
      year: 2026,
      month: 1,
      rows: [{ tin: '531367080', name: 'ABDUL HANIFAH MOHD ARIF', newIc: '530706015461', mtd: 900 }],
    });
    expect(built.filename).toBe(cp39UploadFilename({ employerNo: 'E 908915-10', year: 2026, month: 1 }));
    expect(built.filename).toMatch(LHDN_NAME);
  });

  it('refuses an employer number that cannot be ten digits, rather than naming a file it cannot key', () => {
    expect(() => cp39UploadFilename({ employerNo: '12345678901', year: 2026, month: 1 })).toThrow(/1–10 digits/);
    expect(() => cp39UploadFilename({ employerNo: '', year: 2026, month: 1 })).toThrow(/1–10 digits/);
  });
});
