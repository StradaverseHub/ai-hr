/**
 * r424 (feedback 50ed39e1) — reading a clocking device's file through a File Structure Mapping.
 *
 * PURE AND DB-FREE, and imported by BOTH sides on purpose: the New Mapping screen's "Test with the sample"
 * and the import preview's decoding run this in the browser, and the server re-runs the very same
 * function on the text it receives. The server never trusts the browser's reading of a file — the
 * browser's only privileged job is DECODING the bytes (TextDecoder with the mapping's encoding), because
 * that has to happen before the text can cross a server action at all.
 *
 * WHAT A LINE IS. One physical line of the file. Blank lines are skipped and NOT counted; the header line
 * (when the mapping says there is one) is skipped and not counted. Line numbers are the file's own,
 * 1-based, so "line 225" in the log is line 225 in a text editor.
 *
 * WHAT THIS DOES NOT DO. It never looks up an employee, never checks for duplicates and never decides a
 * business day — those need the database and live in core/attendance-clocking-import.ts. It answers only
 * "what does this line say", and refuses to guess: a month of 13, the 31st of September, an hour of 25, a
 * minute of 75, a code that is not in the In/Out table and a line too short to hold its numbers are each
 * reported, never repaired. Times are read as printed (Malaysia time, no conversion) and kept to the
 * MINUTE: seconds are never read. A two-digit year YY is 20YY.
 */
import { parseAttendanceCsv } from './attendance-csv';

export const CLOCKING_FIELDS = ['cardId', 'deviceId', 'day', 'month', 'year', 'hours', 'minute', 'inOutCode'] as const;
export type ClockingField = (typeof CLOCKING_FIELDS)[number];
/** The reporter's six: a mapping missing any one of these cannot be saved. */
export const REQUIRED_CLOCKING_FIELDS: readonly ClockingField[] = ['cardId', 'day', 'month', 'year', 'hours', 'minute'];

export const CLOCKING_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'] as const;
export type ClockingEncoding = (typeof CLOCKING_ENCODINGS)[number];

/** Delimited: a 1-based column number. Fixed width: 1-based, inclusive character positions. */
export type FieldSpec = { column: number } | { start: number; end: number };
export type InOutCode = { code: string; direction: 'in' | 'out' };

export type ClockingMappingDef = {
  fileType: 'csv' | 'txt';
  layout: 'delimited' | 'fixed_width';
  /** One character; '\t' for tab. Null for fixed width. */
  delimiter: string | null;
  hasHeader: boolean;
  encoding: ClockingEncoding;
  fields: Partial<Record<ClockingField, FieldSpec>>;
  inOutCodes: InOutCode[];
};

/** The reading of the file every tenant has without configuring anything: today's "staff_id, timestamp"
 *  layout, read by lib/attendance-csv.ts exactly as the old importer read it. Code, not a row. */
export const BUILTIN_MAPPING_ID = 'builtin';
export const BUILTIN_MAPPING_NAME = 'AIHR Standard Template';
export type BuiltinMappingDef = { builtin: true };
export type AnyMappingDef = ClockingMappingDef | BuiltinMappingDef;
export const isBuiltinDef = (d: AnyMappingDef): d is BuiltinMappingDef => 'builtin' in d && d.builtin === true;

/** Every way one line can fail to be read. The DB-side results (unmatched_card, duplicate, …) are added by
 *  the service; this module produces only the reading failures. */
export type LineReadError =
  | 'missing_value'
  | 'line_too_short'
  | 'invalid_date'
  | 'invalid_time'
  | 'future_date'
  | 'unknown_in_out_code';

export type ReadLine = {
  lineNo: number;
  raw: string;
  cardRef: string;
  deviceRef: string | null;
  /** YYYY-MM-DD when the date reads as a real calendar date, else null. */
  date: string | null;
  /** The date as printed, for a line whose date did not read (so the log can show "31 / 09 / 2026"). */
  dateText: string;
  /** HH:MM:00 when the time reads, else null. */
  time: string | null;
  timeText: string;
  /** null when the mapping has no In Out Code field (the day is then read in time order). */
  direction: 'in' | 'out' | null;
  code: string | null;
  error: LineReadError | null;
  /** Which field the error is about, when it is about one (missing_value, line_too_short). */
  errorField: ClockingField | null;
};

export type ReadResult = {
  lines: ReadLine[];
  /** The physical line number of the skipped header, or null. */
  headerLineNo: number | null;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Strip a leading byte-order mark. TextDecoder already drops one for UTF-8 by default; this covers text
 *  that reached us some other way (a paste, a test) so the first card id never reads "﻿001234". */
export const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Decode a file's bytes with the mapping's encoding. Browser and Node both ship these four labels. */
export function decodeClockingBytes(bytes: Uint8Array, encoding: ClockingEncoding): string {
  return stripBom(new TextDecoder(encoding).decode(bytes));
}

/** Split text into physical lines, keeping each line's 1-based number. CRLF, LF and CR all end a line. */
export function physicalLines(text: string): { lineNo: number; text: string }[] {
  const out: { lineNo: number; text: string }[] = [];
  const parts = stripBom(text).split(/\r\n|\n|\r/);
  // A file that ends with a newline has one empty trailing element; it is not a line.
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  parts.forEach((t, i) => out.push({ lineNo: i + 1, text: t }));
  return out;
}

/** Split one delimited line. Double quotes are honoured ("a,b" is one cell, "" is a literal quote); a
 *  device file has no embedded newlines, so a record is always one physical line. */
export function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      inQuotes = true;
      cell = '';
      continue;
    }
    if (c === delimiter) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += c;
  }
  cells.push(cell);
  return cells;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const daysInMonth = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]);

/** Read day/month/year as printed. Returns the ISO date, or null when it is not a real calendar date. */
export function readDate(day: string, month: string, year: string): string | null {
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^(\d{2}|\d{4})$/.test(year)) return null;
  const d = Number(day);
  const m = Number(month);
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Read hours/minute as printed. Returns HH:MM:00, or null outside 0-23 / 0-59. Seconds are never read. */
export function readTime(hours: string, minute: string): string | null {
  if (!/^\d{1,2}$/.test(hours) || !/^\d{1,2}$/.test(minute)) return null;
  const h = Number(hours);
  const mi = Number(minute);
  if (h > 23 || mi > 59) return null;
  return `${pad2(h)}:${pad2(mi)}:00`;
}

/** Look a device code up in the mapping's table: trimmed, case-insensitive. Never guessed. */
export function lookupCode(codes: InOutCode[], value: string): 'in' | 'out' | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  return codes.find((c) => c.code.trim().toLowerCase() === v)?.direction ?? null;
}

/** The mapped fields' raw values for one line, plus the first structural problem (a value that is not
 *  there). Exposed so the New Mapping screen's "Line 1 reads" column and the test table read the file the
 *  same way the import does. */
export function extractFields(
  line: string,
  def: ClockingMappingDef,
): { values: Partial<Record<ClockingField, string>>; error: LineReadError | null; errorField: ClockingField | null } {
  const values: Partial<Record<ClockingField, string>> = {};
  let error: LineReadError | null = null;
  let errorField: ClockingField | null = null;
  const fail = (e: LineReadError, f: ClockingField) => {
    if (!error) {
      error = e;
      errorField = f;
    }
  };
  if (def.layout === 'delimited') {
    const cells = splitDelimited(line, def.delimiter ?? ',');
    for (const f of CLOCKING_FIELDS) {
      const spec = def.fields[f];
      if (!spec || !('column' in spec)) continue;
      const cell = cells[spec.column - 1];
      if (cell === undefined) {
        values[f] = '';
        if (f !== 'deviceId') fail('missing_value', f);
        continue;
      }
      values[f] = cell.trim();
    }
  } else {
    for (const f of CLOCKING_FIELDS) {
      const spec = def.fields[f];
      if (!spec || !('start' in spec)) continue;
      // The numbers must be WHOLE: a line cut short inside the minute would otherwise read 08:1 as 08:01.
      // Text fields (card, device, code) may end early — trailing spaces are routinely trimmed by editors.
      const numeric = f === 'day' || f === 'month' || f === 'year' || f === 'hours' || f === 'minute';
      if (line.length < spec.start || (numeric && line.length < spec.end)) {
        values[f] = line.slice(spec.start - 1, spec.end).trim();
        if (f !== 'deviceId') fail('line_too_short', f);
        continue;
      }
      values[f] = line.slice(spec.start - 1, spec.end).trim();
    }
  }
  if (!error) {
    for (const f of ['cardId', 'day', 'month', 'year', 'hours', 'minute'] as const) {
      if (!values[f]) {
        fail('missing_value', f);
        break;
      }
    }
  }
  return { values, error, errorField };
}

/** Read one line through a custom mapping. `now` (Malaysia date + HH:MM) makes "future" decidable while
 *  keeping this function pure; omitted, nothing is future. */
export function readLine(
  lineNo: number,
  raw: string,
  def: ClockingMappingDef,
  now?: { date: string; time: string },
): ReadLine {
  const { values, error: structural, errorField } = extractFields(raw, def);
  const day = values.day ?? '';
  const month = values.month ?? '';
  const year = values.year ?? '';
  const dateText = [day, month, year].filter((x) => x !== '').join(' / ');
  const timeText = values.hours || values.minute ? `${values.hours ?? ''}:${values.minute ?? ''}` : '';
  const out: ReadLine = {
    lineNo,
    raw,
    cardRef: values.cardId ?? '',
    deviceRef: def.fields.deviceId ? (values.deviceId ?? '') || null : null,
    date: null,
    dateText,
    time: null,
    timeText,
    direction: null,
    code: def.fields.inOutCode ? (values.inOutCode ?? '') : null,
    error: structural,
    errorField,
  };
  if (structural) return out;
  out.date = readDate(day, month, year);
  out.time = readTime(values.hours ?? '', values.minute ?? '');
  if (!out.date) {
    out.error = 'invalid_date';
    return out;
  }
  if (!out.time) {
    out.error = 'invalid_time';
    return out;
  }
  if (now && (out.date > now.date || (out.date === now.date && out.time.slice(0, 5) > now.time))) {
    out.error = 'future_date';
    return out;
  }
  if (def.fields.inOutCode) {
    const dir = lookupCode(def.inOutCodes, values.inOutCode ?? '');
    if (!dir) {
      out.error = 'unknown_in_out_code';
      return out;
    }
    out.direction = dir;
  }
  return out;
}

/** The built-in template: lib/attendance-csv.ts reads the file (header detection and all, unchanged), and
 *  each of its rows is mapped back to the file's own line number. Its timestamp regex accepts any digits,
 *  so the calendar and clock checks are applied here on top — 2026-13-45 is not a date. */
function readBuiltin(text: string, now?: { date: string; time: string }): ReadResult {
  const nonBlank = physicalLines(text).filter((l) => l.text.trim().length > 0);
  const parsed = parseAttendanceCsv(nonBlank.map((l) => l.text).join('\n'));
  const lineOf = (row: number) => nonBlank[row - 1];
  const lines: ReadLine[] = [];
  for (const p of parsed.punches) {
    const pl = lineOf(p.row);
    const [y, mo, d] = p.date.split('-');
    const [h, mi] = p.time.split(':');
    const base: ReadLine = {
      lineNo: pl.lineNo,
      raw: pl.text,
      cardRef: p.employeeRef.trim(),
      deviceRef: null,
      date: readDate(d, mo, y),
      dateText: p.date,
      time: readTime(h, mi),
      timeText: `${h}:${mi}`,
      direction: null,
      code: null,
      error: null,
      errorField: null,
    };
    if (!base.date) base.error = 'invalid_date';
    else if (!base.time) base.error = 'invalid_time';
    else if (now && (base.date > now.date || (base.date === now.date && base.time!.slice(0, 5) > now.time)))
      base.error = 'future_date';
    lines.push(base);
  }
  for (const f of parsed.failures) {
    const pl = lineOf(f.row);
    lines.push({
      lineNo: pl.lineNo,
      raw: pl.text,
      cardRef: f.ref.trim(),
      deviceRef: null,
      date: null,
      dateText: f.ts,
      time: null,
      timeText: '',
      direction: null,
      code: null,
      error: f.reason === 'missing' ? 'missing_value' : 'invalid_date',
      errorField: f.reason === 'missing' ? (f.ref ? 'day' : 'cardId') : 'day',
    });
  }
  lines.sort((a, b) => a.lineNo - b.lineNo);
  return { lines, headerLineNo: parsed.headerRow && nonBlank[0] ? nonBlank[0].lineNo : null };
}

/** Read a whole file through a mapping. */
export function parseWithMapping(text: string, def: AnyMappingDef, now?: { date: string; time: string }): ReadResult {
  if (isBuiltinDef(def)) return readBuiltin(text, now);
  const all = physicalLines(text).filter((l) => l.text.trim().length > 0);
  let headerLineNo: number | null = null;
  let data = all;
  if (def.hasHeader && all.length > 0) {
    headerLineNo = all[0].lineNo;
    data = all.slice(1);
  }
  return { lines: data.map((l) => readLine(l.lineNo, l.text, def, now)), headerLineNo };
}

// ── Mapping validation — the one rule, shared by the screen (to say what is missing as you go) and the
//    service (which refuses to save, whatever the browser said). ────────────────────────────────────────
export type MappingProblem =
  | 'badColumn'
  | 'badPosition'
  | 'sameColumn'
  | 'overlap'
  | 'badDelimiter'
  | 'noCodes'
  | 'badCode'
  | 'duplicateCode'
  | 'codeNoMeaning';

export function validateMappingDef(def: ClockingMappingDef): { missing: ClockingField[]; problems: MappingProblem[] } {
  const missing = REQUIRED_CLOCKING_FIELDS.filter((f) => !def.fields[f]);
  const problems = new Set<MappingProblem>();
  if (def.layout === 'delimited') {
    if (!def.delimiter || def.delimiter.length !== 1 || /[\r\n"]/.test(def.delimiter)) problems.add('badDelimiter');
    const used = new Map<number, ClockingField>();
    for (const f of CLOCKING_FIELDS) {
      const s = def.fields[f];
      if (!s) continue;
      if (!('column' in s) || !Number.isInteger(s.column) || s.column < 1 || s.column > 500) {
        problems.add('badColumn');
        continue;
      }
      if (used.has(s.column)) problems.add('sameColumn');
      used.set(s.column, f);
    }
  } else {
    const spans: [number, number][] = [];
    for (const f of CLOCKING_FIELDS) {
      const s = def.fields[f];
      if (!s) continue;
      if (
        !('start' in s) ||
        !Number.isInteger(s.start) ||
        !Number.isInteger(s.end) ||
        s.start < 1 ||
        s.end < s.start ||
        s.end > 2000
      ) {
        problems.add('badPosition');
        continue;
      }
      if (spans.some(([a, b]) => s.start <= b && a <= s.end)) problems.add('overlap');
      spans.push([s.start, s.end]);
    }
  }
  if (def.fields.inOutCode) {
    if (def.inOutCodes.length === 0) problems.add('noCodes');
    const seen = new Set<string>();
    for (const c of def.inOutCodes) {
      const k = c.code.trim().toLowerCase();
      if (!k || k.length > 20) problems.add('badCode');
      if (seen.has(k)) problems.add('duplicateCode');
      seen.add(k);
      if (c.direction !== 'in' && c.direction !== 'out') problems.add('codeNoMeaning');
    }
  }
  return { missing, problems: [...problems] };
}

/** Distinct In/Out values found in the sample's code column, for pre-filling the table. Only the words
 *  that cannot mean anything else (IN, OUT and their obvious spellings) are given a meaning; every other
 *  code is listed with NO meaning, so the administrator has to say — a code is never guessed. */
export function codesFromSample(lines: string[], def: ClockingMappingDef): { code: string; direction: 'in' | 'out' | null }[] {
  if (!def.fields.inOutCode) return [];
  const data = def.hasHeader ? lines.slice(1) : lines;
  const seen = new Map<string, string>();
  for (const l of data) {
    if (!l.trim()) continue;
    const v = (extractFields(l, def).values.inOutCode ?? '').trim();
    if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v);
  }
  return [...seen.values()].map((code) => {
    const k = code.toLowerCase().replace(/[\s_-]/g, '');
    const direction = /^(in|clockin|checkin|cin)$/.test(k) ? 'in' : /^(out|clockout|checkout|cout)$/.test(k) ? 'out' : null;
    return { code, direction };
  });
}

/** The first `n` physical lines of a sample, each capped, for keeping with the mapping. */
export const SAMPLE_LINE_LIMIT = 20;
export const SAMPLE_LINE_MAX_CHARS = 500;
export function sampleLinesOf(text: string, n = SAMPLE_LINE_LIMIT): string[] {
  return physicalLines(text)
    .slice(0, n)
    .map((l) => l.text.slice(0, SAMPLE_LINE_MAX_CHARS));
}
