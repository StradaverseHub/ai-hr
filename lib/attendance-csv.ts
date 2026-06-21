/**
 * Biometric / terminal punch-log CSV parser (ADR-0032 C6). Pure, jurisdiction-neutral. Accepts a header
 * row naming an employee column (staff/employee/emp/badge/user/ic/id) and a timestamp column
 * (time/date/stamp/punch), or — failing that — positional columns (0 = employee, 1 = timestamp).
 * Each output punch is an (employeeRef, date YYYY-MM-DD, time HH:MM:SS); reconciliation happens in the service.
 */
export type ParsedPunch = { employeeRef: string; date: string; time: string; row: number };
export type PunchParseResult = { punches: ParsedPunch[]; errors: string[] };

// "2026-07-01 22:00", "2026-07-01T22:00:30", "2026-07-01 6:05" → date + zero-padded HH:MM:SS
const TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
const p2 = (s: string) => s.padStart(2, '0');

export function parseAttendanceCsv(text: string): PunchParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { punches: [], errors: ['The file is empty.'] };

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  let refCol = header.findIndex((h) => /staff|employee|emp|badge|user|ic|id/.test(h));
  let tsCol = header.findIndex((h) => /time|date|stamp|punch/.test(h));
  let start = 1;
  if (refCol === -1 || tsCol === -1) {
    // No recognizable header → assume positional, and treat row 0 as data if it already looks like one.
    refCol = 0;
    tsCol = 1;
    start = TS.test((lines[0].split(',')[1] ?? '').trim()) ? 0 : 1;
  }

  const punches: ParsedPunch[] = [];
  const errors: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    const ref = cells[refCol];
    const ts = cells[tsCol];
    if (!ref || !ts) {
      errors.push(`Row ${i + 1}: missing employee reference or timestamp.`);
      continue;
    }
    const m = TS.exec(ts);
    if (!m) {
      errors.push(`Row ${i + 1}: could not read timestamp "${ts}".`);
      continue;
    }
    punches.push({ employeeRef: ref, date: m[1], time: `${p2(m[2])}:${m[3]}:${m[4] ?? '00'}`, row: i + 1 });
  }
  return { punches, errors };
}
