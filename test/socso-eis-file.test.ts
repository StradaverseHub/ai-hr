/**
 * #73 (P-73b) — PERKESO combined SOCSO+EIS textfile v2.0 (with SKBBK). Golden test against the official
 * spec sample line (formatteksfail.pdf, 13 Feb 2026): employer A3702086586A, month 02/2026, a member with
 * SOCSO 60.35/17.25, EIS 6.90/6.90, SKBBK 25.85 — all cents, fixed positions, 278-char record.
 */
import { describe, expect, it } from 'vitest';
import { buildSocsoEisFile } from '../localization/my/socso-eis-file';

describe('SOCSO+EIS combined textfile v2.0 (#73)', () => {
  const base = {
    employerCode: 'A3702086586A',
    ssmNo: null,
    year: 2026,
    month: 2,
  };

  it('lays out the verified spec sample at the exact fixed-width positions', () => {
    const f = buildSocsoEisFile({
      ...base,
      rows: [
        {
          ic: '851028166666',
          name: 'ALI BIN ABU',
          salary: 3457.99,
          socsoEmployer: 60.35,
          socsoEmployee: 17.25,
          eisEmployer: 6.9,
          eisEmployee: 6.9,
          skbbk: 25.85,
        },
      ],
    });
    const line = f.content.replace(/\r\n$/, '');
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
    expect(f.totals).toEqual({ salaryCents: 345799, socsoCents: 7760, eisCents: 1380, skbbkCents: 2585, records: 1 });
  });

  it('zero-pads EIS for an EIS-exempt member (foreign / 60+) but still carries SKBBK', () => {
    const f = buildSocsoEisFile({
      ...base,
      rows: [
        { ic: '201900690345', name: 'FOREIGN WORKER', salary: 2000, socsoEmployer: 24.85, socsoEmployee: 0, eisEmployer: 0, eisEmployee: 0, skbbk: 14.65 },
      ],
    });
    const line = f.content.replace(/\r\n$/, '');
    expect(line.slice(226, 232)).toBe('000000'); // EIS employer = 0, zero-padded (not blank)
    expect(line.slice(232, 238)).toBe('000000'); // EIS employee = 0
    expect(line.slice(238, 244)).toBe('001465'); // SKBBK still applies to foreign workers
  });

  it('throws rather than silently truncate an overflowing amount or a missing IC', () => {
    expect(() => buildSocsoEisFile({ ...base, rows: [{ ic: '', name: 'NO IC', salary: 1000, socsoEmployer: 1, socsoEmployee: 1, eisEmployer: 1, eisEmployee: 1, skbbk: 1 }] })).toThrow(/mandatory/i);
    expect(() =>
      buildSocsoEisFile({ ...base, rows: [{ ic: '900101010001', name: 'HUGE', salary: 10_000_000, socsoEmployer: 99_999_999, socsoEmployee: 1, eisEmployer: 1, eisEmployee: 1, skbbk: 1 }] }),
    ).toThrow(/exceeds 6 digits/);
  });
});
