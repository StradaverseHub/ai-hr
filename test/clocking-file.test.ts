/**
 * r424 (50ed39e1) — lib/clocking-file.ts, the pure reading of a clocking device's file through a File
 * Structure Mapping. No database: this is the function the browser's "Test with the sample" runs and the
 * server re-runs on Validate and on Import.
 */
import { describe, expect, it } from 'vitest';
import {
  codesFromSample,
  decodeClockingBytes,
  parseWithMapping,
  readDate,
  readTime,
  sampleLinesOf,
  splitDelimited,
  validateMappingDef,
  type ClockingMappingDef,
} from '../lib/clocking-file';

const delimited = (delimiter: string, extra: Partial<ClockingMappingDef> = {}): ClockingMappingDef => ({
  fileType: 'csv',
  layout: 'delimited',
  delimiter,
  hasHeader: false,
  encoding: 'utf-8',
  fields: {
    cardId: { column: 1 },
    deviceId: { column: 2 },
    day: { column: 3 },
    month: { column: 4 },
    year: { column: 5 },
    hours: { column: 6 },
    minute: { column: 7 },
    inOutCode: { column: 8 },
  },
  inOutCodes: [
    { code: 'IN', direction: 'in' },
    { code: 'OUT', direction: 'out' },
  ],
  ...extra,
});

// ZKTeco-style fixed width, the mockup's positions: card 1-10, device 11-15, day 16-17, month 18-19,
// year 20-23, hours 24-25, minute 26-27, code 28-30.
const fixed: ClockingMappingDef = {
  fileType: 'txt',
  layout: 'fixed_width',
  delimiter: null,
  hasHeader: false,
  encoding: 'utf-8',
  fields: {
    cardId: { start: 1, end: 10 },
    deviceId: { start: 11, end: 15 },
    day: { start: 16, end: 17 },
    month: { start: 18, end: 19 },
    year: { start: 20, end: 23 },
    hours: { start: 24, end: 25 },
    minute: { start: 26, end: 27 },
    inOutCode: { start: 28, end: 30 },
  },
  inOutCodes: [
    { code: 'IN', direction: 'in' },
    { code: 'OUT', direction: 'out' },
  ],
};
const fw = (card: string, dev: string, dd: string, mm: string, yyyy: string, hh: string, mi: string, code: string) =>
  `${card.padEnd(10)}${dev.padEnd(5)}${dd}${mm}${yyyy}${hh}${mi}${code}`;

describe('delimited files', () => {
  it.each([
    [',', 'comma'],
    ['\t', 'tab'],
    [';', 'semicolon'],
    ['|', 'another character'],
  ])('reads a %s-separated (%s) line, keeping leading zeros and the direction', (d) => {
    const line = ['001234', '01', '08', '10', '2026', '08', '15', 'IN'].join(d);
    const r = parseWithMapping(line, delimited(d));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      lineNo: 1,
      cardRef: '001234',
      deviceRef: '01',
      date: '2026-10-08',
      time: '08:15:00',
      direction: 'in',
      error: null,
    });
  });

  it('skips the header and blank lines without counting them, and line numbers stay the file’s own', () => {
    const text = 'card,dev,d,m,y,h,mi,code\n\n001234,01,08,10,2026,08,15,IN\n   \n001234,01,08,10,2026,17,32,out\n';
    const r = parseWithMapping(text, delimited(',', { hasHeader: true }));
    expect(r.headerLineNo).toBe(1);
    expect(r.lines.map((l) => l.lineNo)).toEqual([3, 5]);
    // Code lookup is trimmed and case-insensitive.
    expect(r.lines[1].direction).toBe('out');
  });

  it('honours double quotes around a cell and trims surrounding spaces', () => {
    expect(splitDelimited('"00,12",  01 ,"a ""q"""', ',')).toEqual(['00,12', '  01 ', 'a "q"']);
    const r = parseWithMapping('"001234 ", 01 ,08,10,2026,08,15, IN ', delimited(','));
    expect(r.lines[0]).toMatchObject({ cardRef: '001234', deviceRef: '01', direction: 'in', error: null });
  });

  it('reports a missing column instead of guessing', () => {
    const r = parseWithMapping('001234,01,08,10,2026,08', delimited(','));
    expect(r.lines[0].error).toBe('missing_value');
    expect(r.lines[0].errorField).toBe('minute');
  });

  it('reports an unknown In/Out code, never guesses one', () => {
    const r = parseWithMapping('001234,01,08,10,2026,08,15,BRK', delimited(','));
    expect(r.lines[0].error).toBe('unknown_in_out_code');
    expect(r.lines[0].code).toBe('BRK');
  });

  it('without an In Out Code field the direction is left for the day to decide (null)', () => {
    const def = delimited(',');
    delete def.fields.inOutCode;
    const r = parseWithMapping('001234,01,08,10,2026,08,15', def);
    expect(r.lines[0]).toMatchObject({ direction: null, code: null, error: null });
  });
});

describe('dates and times are read as printed and checked against the real calendar', () => {
  it('a two-digit year 26 means 2026', () => expect(readDate('8', '10', '26')).toBe('2026-10-08'));
  it.each([
    ['31', '09', '2026', '31 September'],
    ['35', '10', '2026', 'day 35'],
    ['08', '13', '2026', 'month 13'],
    ['29', '02', '2026', '29 February in a common year'],
    ['08', '10', '226', 'a three-digit year'],
  ])('%s/%s/%s is not a date (%s)', (d, m, y) => expect(readDate(d, m, y)).toBeNull());
  it('29 February in a leap year is a date', () => expect(readDate('29', '02', '2028')).toBe('2028-02-29'));
  it.each([
    ['25', '10'],
    ['08', '75'],
    ['8a', '10'],
  ])('%s:%s is not a time', (h, m) => expect(readTime(h, m)).toBeNull());
  it('seconds are never read: a time is kept to the minute', () => expect(readTime('8', '5')).toBe('08:05:00'));

  it('a line names WHICH check failed, date before time', () => {
    const r = parseWithMapping('A,01,31,09,2026,25,10,IN\nB,01,02,10,2026,25,10,IN', delimited(','));
    expect(r.lines.map((l) => l.error)).toEqual(['invalid_date', 'invalid_time']);
    expect(r.lines[0].dateText).toBe('31 / 09 / 2026');
    expect(r.lines[1].timeText).toBe('25:10');
  });

  it('a future clocking is refused against the Malaysia clock it is given', () => {
    const now = { date: '2026-10-08', time: '09:00' };
    const r = parseWithMapping('A,01,09,10,2026,08,00,IN\nA,01,08,10,2026,09,30,IN\nA,01,08,10,2026,08,59,IN', delimited(','), now);
    expect(r.lines.map((l) => l.error)).toEqual(['future_date', 'future_date', null]);
  });
});

describe('fixed-width files', () => {
  it('slices 1-based inclusive positions and trims', () => {
    const r = parseWithMapping(fw('001234', 'DEV01', '08', '10', '2026', '08', '15', 'IN'), fixed);
    expect(r.lines[0]).toMatchObject({ cardRef: '001234', deviceRef: 'DEV01', date: '2026-10-08', time: '08:15:00', direction: 'in', error: null });
  });

  it('a line cut short inside the date or time is reported, never read as a shorter number', () => {
    const full = fw('001234', 'DEV01', '08', '10', '2026', '08', '15', 'IN');
    const r = parseWithMapping(full.slice(0, 26), fixed); // the minute is "1" — not 01, not 15
    expect(r.lines[0].error).toBe('line_too_short');
    expect(r.lines[0].errorField).toBe('minute');
  });

  it('a text field may end early (a trailing space trimmed by an editor is not an error)', () => {
    // "IN" in a 28-30 slot: the line is 29 characters long, one short of the slot's end.
    const r = parseWithMapping(fw('001234', 'DEV01', '08', '10', '2026', '08', '15', 'IN'), fixed);
    expect(r.lines[0].raw.length).toBe(29);
    expect(r.lines[0].error).toBeNull();
  });
});

describe('encodings (decoded in the browser before the text crosses the wire)', () => {
  it('UTF-8 with a byte-order mark: the first card id does not carry it', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('001234,01,08,10,2026,08,15,IN')]);
    const r = parseWithMapping(decodeClockingBytes(bytes, 'utf-8'), delimited(','));
    expect(r.lines[0].cardRef).toBe('001234');
  });

  it('UTF-16 little-endian with a BOM', () => {
    const s = '001234,01,08,10,2026,08,15,IN';
    const bytes = new Uint8Array(2 + s.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < s.length; i++) bytes[2 + i * 2] = s.charCodeAt(i);
    const text = decodeClockingBytes(bytes, 'utf-16le');
    expect(text).toBe(s);
    expect(parseWithMapping(text, delimited(',')).lines[0].error).toBeNull();
  });

  it('Windows-1252 decodes the bytes that are not ASCII', () => {
    const bytes = new Uint8Array([0x41, 0xe9, 0x80]); // A é €
    expect(decodeClockingBytes(bytes, 'windows-1252')).toBe('Aé€');
  });
});

describe('the built-in AIHR Standard Template wraps lib/attendance-csv.ts', () => {
  it('reads staff_id, timestamp with file line numbers, minutes only, and checks the calendar', () => {
    const r = parseWithMapping('staff_id,timestamp\nE001,2026-07-01 08:02:30\n\nE001,2026-13-01 17:00\nE001,\n', { builtin: true });
    expect(r.headerLineNo).toBe(1);
    expect(r.lines.map((l) => [l.lineNo, l.error])).toEqual([
      [2, null],
      [4, 'invalid_date'],
      [5, 'missing_value'],
    ]);
    expect(r.lines[0]).toMatchObject({ cardRef: 'E001', date: '2026-07-01', time: '08:02:00', direction: null });
  });
});

describe('mapping validation — the one rule the screen shows and the service enforces', () => {
  it('names every missing required field (the six), and only those', () => {
    const def = delimited(',');
    def.fields = { deviceId: { column: 2 }, inOutCode: { column: 8 } };
    expect(validateMappingDef(def).missing).toEqual(['cardId', 'day', 'month', 'year', 'hours', 'minute']);
    expect(validateMappingDef(delimited(',')).missing).toEqual([]);
  });

  it('refuses two fields on one column, overlapping positions, a code without a meaning, a bad delimiter', () => {
    const same = delimited(',');
    same.fields.minute = { column: 6 };
    expect(validateMappingDef(same).problems).toContain('sameColumn');
    const overlap: ClockingMappingDef = { ...fixed, fields: { ...fixed.fields, deviceId: { start: 10, end: 15 } } };
    expect(validateMappingDef(overlap).problems).toContain('overlap');
    const noMeaning = delimited(',', { inOutCodes: [{ code: 'IN', direction: '' as never }] });
    expect(validateMappingDef(noMeaning).problems).toContain('codeNoMeaning');
    expect(validateMappingDef(delimited(',', { inOutCodes: [] })).problems).toContain('noCodes');
    expect(validateMappingDef(delimited('ab')).problems).toContain('badDelimiter');
    expect(validateMappingDef(delimited(',')).problems).toEqual([]);
  });

  it('pre-fills the code table from the sample, giving a meaning only to IN and OUT', () => {
    const lines = ['A,01,08,10,2026,08,15,IN', 'A,01,08,10,2026,12,00,BRK', 'A,01,08,10,2026,17,32,out'];
    expect(codesFromSample(lines, delimited(','))).toEqual([
      { code: 'IN', direction: 'in' },
      { code: 'BRK', direction: null },
      { code: 'out', direction: 'out' },
    ]);
  });

  it('keeps at most 20 sample lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    expect(sampleLinesOf(text)).toHaveLength(20);
  });
});
