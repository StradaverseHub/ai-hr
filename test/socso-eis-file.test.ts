/**
 * #73 (P-73b) — PERKESO combined SOCSO+EIS textfile **v2.0** (with SKBBK), against the official spec
 * sample line (formatteksfail.pdf, 13 Feb 2026): employer A3702086586A, month 02/2026, a member with
 * SOCSO 60.35/17.25, EIS 6.90/6.90, SKBBK 25.85 — all cents, fixed positions, 278-char record.
 *
 * ⚠️ r296 — EVERY POSITIONAL ASSERTION BELOW IS THE ONE IT ALWAYS WAS. What changed is the function
 * under it. This file used to drive `buildSocsoEisFile`, a SECOND fixed-width writer that lived in
 * `localization/my/socso-eis-file.ts` and disagreed with `lib/perkeso-socso-file.ts` about padding, about
 * the SKBBK box and about the trailing CRLF — while both were reachable from the UI. There is now one
 * writer for the one artefact, and this is the case that pins its v2.0 layout; the v1.0 layout is pinned
 * byte-for-byte against a real accepted file in test/perkeso-socso-file.test.ts.
 *
 * ⚠️ AND v2.0 IS STILL THE UNVERIFIED HALF. This sample line is a specification's own example, not a file
 * PERKESO has accepted from us. It is the best evidence that exists for v2.0 and it is weaker than the
 * evidence for v1.0 — see PERKESO_LAYOUT_UNVERIFIED.
 */
import { describe, expect, it } from 'vitest';
import {
  PERKESO_FILE_LINE_LENGTH,
  buildPerkesoSocsoFile,
  perkesoFileEmployeesFrom,
  perkesoFileTotals,
} from '../lib/perkeso-socso-file';

const EMPLOYER = { employerCode: 'A3702086586A', myCoId: null, periodMonth: 2, periodYear: 2026 };
const build = (rows: Parameters<typeof perkesoFileEmployeesFrom>[0]) =>
  buildPerkesoSocsoFile({ employer: EMPLOYER, employees: perkesoFileEmployeesFrom(rows), layout: 'v2.0' });

describe('SOCSO+EIS combined textfile v2.0 (#73)', () => {
  it('lays out the verified spec sample at the exact fixed-width positions', () => {
    const line = build([
      {
        ic: '851028166666',
        name: 'ALI BIN ABU',
        wage: 3457.99,
        socsoEmployer: 60.35,
        socsoEmployee: 17.25,
        eisEmployer: 6.9,
        eisEmployee: 6.9,
        skbbk: 25.85,
      },
    ]);
    expect(line).toHaveLength(278);
    expect(line.slice(0, 12)).toBe('A3702086586A'); // employer code (left, 12)
    expect(line.slice(32, 44)).toBe('851028166666'); // IC (left, 12)
    expect(line.slice(44, 55)).toBe('ALI BIN ABU'); // name (left, space-padded)
    expect(line.slice(194, 200)).toBe('022026'); // month MMYYYY
    expect(line.slice(200, 214)).toBe('00000000345799'); // salary cents (14)
    expect(line.slice(214, 220)).toBe('006035'); // SOCSO employer
    expect(line.slice(220, 226)).toBe('001725'); // SOCSO employee
    expect(line.slice(226, 232)).toBe('000690'); // EIS employer
    expect(line.slice(232, 238)).toBe('000690'); // EIS employee
    expect(line.slice(238, 244)).toBe('002585'); // SKBBK employee (NEW v2.0)
    expect(line.slice(244, 278)).toBe(' '.repeat(34)); // Filler 1 (14) + Filler 2 (20)

    // The totals, read back out of the emitted bytes rather than added up from the rows above.
    const t = perkesoFileTotals(line, 'v2.0');
    expect(t).toMatchObject({ records: 1, excluded: [] });
    expect(t.sen.wage).toBe(345_799);
    expect(t.sen.socsoEmployer + t.sen.socsoEmployee).toBe(7_760);
    expect(t.sen.eisEmployer + t.sen.eisEmployee).toBe(1_380);
    expect(t.sen.skbbk).toBe(2_585);
  });

  it('zero-pads EIS for an EIS-exempt member (foreign / 60+) but still carries SKBBK', () => {
    const line = build([
      { ic: '201900690345', name: 'FOREIGN WORKER', wage: 2000, socsoEmployer: 24.85, socsoEmployee: 0, eisEmployer: 0, eisEmployee: 0, skbbk: 14.65 },
    ]);
    expect(line.slice(226, 232)).toBe('000000'); // EIS employer = 0, zero-padded (not blank)
    expect(line.slice(232, 238)).toBe('000000'); // EIS employee = 0
    expect(line.slice(238, 244)).toBe('001465'); // SKBBK still applies to foreign workers
  });

  /**
   * The refusals are the WRITER's now, and they are stricter than the ones this module used to apply: an
   * identity number must FIT rather than merely be non-empty, and a missing wage base refuses by name
   * instead of writing gross pay. Same principle, one implementation — a fixed-width record cannot say
   * "this did not fit", so nothing is ever truncated.
   */
  it('throws rather than silently truncate an overflowing amount, a bad IC or a missing wage', () => {
    const one = (over: Record<string, unknown>) =>
      build([{ ic: '900101010001', name: 'X', wage: 1000, socsoEmployer: 1, socsoEmployee: 1, eisEmployer: 1, eisEmployee: 1, skbbk: 1, ...over }]);
    expect(() => one({ ic: '' })).toThrow(/exactly 12 characters/);
    expect(() => one({ ic: '9001010100019' })).toThrow(/exactly 12 characters/);
    expect(() => one({ socsoEmployer: 99_999_999 })).toThrow(/the box holds 6/);
    expect(() => one({ wage: null })).toThrow(/no SOCSO wage was recorded/);
  });

  /** Still 278 characters — v2.0 takes the SKBBK box out of Filler 1, it does not widen the record. */
  it('is the same record width as v1.0', () => {
    const line = build([
      { ic: '900101010001', name: 'X', wage: 1000, socsoEmployer: 1, socsoEmployee: 1, eisEmployer: 1, eisEmployee: 1, skbbk: 1 },
    ]);
    expect(line).toHaveLength(PERKESO_FILE_LINE_LENGTH);
  });
});
