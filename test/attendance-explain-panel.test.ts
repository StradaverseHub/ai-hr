/**
 * 7c834696 POINT 3 — the calculation-breakdown panel's CONTRACT with the six catalogs.
 *
 * The panel renders steps whose keys are chosen at RUNTIME (`te(step.key, values)`), and
 * components/attendance-figure-cells.tsx uses two namespaces, so BOTH halves of the existing i18n guard
 * are blind to it: test/i18n-coverage.ts checks literal `t('a.b')` keys and only in single-namespace
 * files. A missing key there is not a type error, not a build error and not a 200 — it is a
 * MISSING_MESSAGE at render, which is precisely the class this repo keeps shipping. So this file closes it.
 *
 * Four things are held:
 *  A. Every step key core/attendance-explain.ts can emit exists, non-empty, in ALL SIX catalogs.
 *  B. The matrix below reaches every one of those keys — otherwise A would be checking a subset and the
 *     unreached branch is the one that ships broken. Equality in both directions also catches a key that
 *     was renamed in the reader but left behind in the catalogs.
 *  C. Every ICU placeholder in every locale's message is an argument the reader actually supplies for
 *     that key. A message that says `{foo}` when nobody passes `foo` throws when it is formatted, and
 *     only for the day that takes that branch.
 *  D. The literal keys the panel chrome uses, plus the two ENUM-DRIVEN key families
 *     (`source.*` from TraceScheduleSource, `dayType.*` from TraceDayType), all resolve.
 *
 * No DB: the reader is pure and the catalogs are files.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { explainAttendanceDay, type ExplainStep } from '../core/attendance-explain';
import { ATTENDANCE_TRACE_VERSION, type AttendanceTraceV1, type TraceOtSplit } from '../core/attendance-trace';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

type Dict = Record<string, unknown>;
const catalog = (loc: string): Dict => JSON.parse(readFileSync(join(ROOT, `messages/${loc}.json`), 'utf8'));
const at = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);

const CATALOGS = Object.fromEntries(LOCALES.map((l) => [l, catalog(l)])) as Record<string, Dict>;
const message = (loc: string, key: string) => at(CATALOGS[loc], `attendance.explain.${key}`);

// ── the matrix ──────────────────────────────────────────────────────────────────────────────────────
// Traces, not fixtures: the reader's whole contract is that it consults nothing but the stored trace, so
// a hand-built trace is a complete input. Each entry names the branch it is here to reach.

const split = (over: Partial<TraceOtSplit> = {}): TraceOtSplit => ({
  flat: 0,
  ot00: 0,
  ot10: 0,
  ot15: 0,
  ot20: 0,
  ot30: 0,
  ...over,
});

const trace = (over: Partial<AttendanceTraceV1> = {}): AttendanceTraceV1 => ({
  v: ATTENDANCE_TRACE_VERSION,
  schedule: {
    source: 'default-shift',
    dayType: 'workday',
    startAbs: 540, // 09:00
    endAbs: 1080, // 18:00
    scheduledMinutes: 480,
    normalMinutesOverride: null,
    crossesMidnight: false,
    breakMinutes: 60,
    breakSpanned: null,
    ruleId: null,
  },
  punch: { inAbs: 545, outAbs: 1110, spanMinutes: 565, workedMinutes: 505 },
  lateness: null,
  latenessDeduction: null,
  earlyOut: null,
  earlyOutDeduction: null,
  overtime: null,
  ...over,
});

const late = (minutes: number, includeGrace: boolean): AttendanceTraceV1['lateness'] => ({
  startAbs: 540,
  graceMinutes: 10,
  thresholdAbs: 550,
  checkInAbs: 540 + minutes,
  includeGrace,
  minutes,
});
const early = (minutes: number, includeGrace: boolean): AttendanceTraceV1['earlyOut'] => ({
  endAbs: 1080,
  graceMinutes: 10,
  thresholdAbs: 1070,
  checkOutAbs: 1080 - minutes,
  includeGrace,
  minutes,
});
const ot = (over: Partial<NonNullable<AttendanceTraceV1['overtime']>> = {}): AttendanceTraceV1['overtime'] => ({
  basis: 'window',
  normalMinutes: 480,
  normalIsOverride: false,
  rawMinutes: 30,
  earlyMinutes: 0,
  earlyIncluded: false,
  shiftRule: null,
  rounding: null,
  minutes: 30,
  split: split({ ot15: 30 }),
  ...over,
});

const MATRIX: { why: string; t: AttendanceTraceV1 }[] = [
  { why: 'nothing applies to the day at all', t: trace() },
  { why: 'in on time; no deduction rule', t: trace({ lateness: late(0, false) }) },
  {
    why: 'late, counted from the scheduled start, rule present but deductions off',
    t: trace({
      lateness: late(20, true),
      latenessDeduction: { applies: false, everyMinutes: null, deductPerBlock: null, blocks: 0, minutes: 0 },
    }),
  },
  {
    why: 'late, counted from the end of grace, deductions on but unconfigured',
    t: trace({
      lateness: late(20, false),
      latenessDeduction: { applies: true, everyMinutes: null, deductPerBlock: null, blocks: 0, minutes: 0 },
    }),
  },
  {
    why: 'late 25m under "every 15" — one WHOLE block, the floor the panel has to make visible',
    t: trace({
      lateness: late(25, false),
      latenessDeduction: { applies: true, everyMinutes: 15, deductPerBlock: 30, blocks: 1, minutes: 30 },
    }),
  },
  { why: 'stayed to the end', t: trace({ earlyOut: early(0, false) }) },
  {
    why: 'early out from the scheduled end, deductions off',
    t: trace({
      earlyOut: early(20, true),
      earlyOutDeduction: { applies: false, everyMinutes: null, deductPerBlock: null, blocks: 0, minutes: 0 },
    }),
  },
  {
    why: 'early out from the start of grace, deductions on but unconfigured',
    t: trace({
      earlyOut: early(20, false),
      earlyOutDeduction: { applies: true, everyMinutes: null, deductPerBlock: null, blocks: 0, minutes: 0 },
    }),
  },
  {
    why: 'early out with a configured deduction',
    t: trace({
      earlyOut: early(25, false),
      earlyOutDeduction: { applies: true, everyMinutes: 15, deductPerBlock: 30, blocks: 1, minutes: 30 },
    }),
  },
  {
    why: 'rest-day work: every worked minute is overtime, legacy break cliff',
    t: trace({
      schedule: { ...trace().schedule, dayType: 'rest_day', source: 'roster-rest' },
      overtime: ot({ basis: 'nonWorkday', normalMinutes: null, rawMinutes: 505, minutes: 505, split: split({ flat: 505 }) }),
    }),
  },
  {
    why: 'workday overtime past the shift end, with a DECLARED break window the clocking spanned',
    t: trace({
      schedule: { ...trace().schedule, breakSpanned: 45, ruleId: 'rule-1' },
      overtime: ot({ basis: 'window' }),
    }),
  },
  {
    why: 'duration basis (company-policy branch), pre-shift minutes NOT folded in',
    t: trace({ overtime: ot({ basis: 'duration', earlyMinutes: 30, earlyIncluded: false }) }),
  },
  {
    why: 'manual normal-hours override, pre-shift minutes folded in',
    t: trace({
      overtime: ot({ basis: 'duration', normalIsOverride: true, normalMinutes: 420, earlyMinutes: 30, earlyIncluded: true }),
    }),
  },
  {
    why: 'a shift that is not eligible for overtime',
    t: trace({ overtime: ot({ shiftRule: { eligible: false, minMinutes: null, dailyCapMinutes: null, minutesAfter: 0 }, minutes: 0, split: split() }) }),
  },
  {
    why: 'a shift with BOTH a minimum block and a daily cap, and rounding that moved the figure',
    t: trace({
      overtime: ot({
        shiftRule: { eligible: true, minMinutes: 15, dailyCapMinutes: 120, minutesAfter: 30 },
        rounding: { applied: true, beforeMinutes: 33, afterMinutes: 30 },
      }),
    }),
  },
  {
    why: 'an OPEN day — clocked in, not yet out: lateness is knowable, overtime is not',
    t: trace({ punch: { inAbs: 545, outAbs: null, spanMinutes: null, workedMinutes: null }, lateness: late(5, false) }),
  },
];

/** key → every argument name the reader supplies for it, across the whole matrix. */
function emitted(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (s: ExplainStep) => {
    const set = out.get(s.key) ?? new Set<string>();
    for (const a of Object.keys(s.args ?? {})) set.add(a);
    out.set(s.key, set);
  };
  for (const { t } of MATRIX) {
    const e = explainAttendanceDay(t);
    if (e.kind !== 'explained') throw new Error('the matrix must contain only readable traces');
    for (const section of [e.lateness, e.earlyOut, e.overtime]) for (const s of section.steps) add(s);
  }
  return out;
}

/** Every step key the reader can produce, read off its source. Both the plain `key: 'x'` form and the
 *  `key: cond ? 'a' : 'b'` form live on ONE line each, so a line scan sees both. */
function declaredKeys(): Set<string> {
  const src = readFileSync(join(ROOT, 'core/attendance-explain.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const keys = new Set<string>();
  for (const lineText of src.split('\n')) {
    if (!/\bkey:/.test(lineText)) continue;
    for (const m of lineText.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)) keys.add(m[1]);
  }
  return keys;
}

const EMITTED = emitted();
const DECLARED = declaredKeys();
const placeholders = (msg: string) => [...msg.matchAll(/\{([^}]*)\}/g)].map((m) => m[1].trim());

const PANEL = readFileSync(join(ROOT, 'components/attendance-figure-cells.tsx'), 'utf8');
/** `te('x')` — the chrome strings the panel writes itself, as opposed to the reader's step keys. The
 *  enum-driven families are template literals (`te(\`source.${s}\`)`) and deliberately do not match. */
const CHROME_KEYS = new Set([...PANEL.matchAll(/\bte\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((m) => m[1]));

/** The literal members of a string-union type in core/attendance-trace.ts. */
function unionMembers(name: string): string[] {
  const src = readFileSync(join(ROOT, 'core/attendance-trace.ts'), 'utf8');
  const m = src.match(new RegExp(`export type ${name}\\s*=([^;]+);`));
  if (!m) throw new Error(`${name} is no longer a string union in core/attendance-trace.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('A + B. the reader’s keys and the six catalogs agree, both ways', () => {
  it('the matrix reaches every step key the reader declares', () => {
    // Not a formality: an unreached branch is the one that ships with a missing message, because nothing
    // else in the gate renders it. Equality also catches a key renamed in one place only.
    expect([...EMITTED.keys()].sort()).toEqual([...DECLARED].sort());
  });

  it('every step key resolves, non-empty, in all six catalogs', () => {
    const missing: string[] = [];
    for (const loc of LOCALES) {
      for (const key of DECLARED) {
        const m = message(loc, key);
        if (typeof m !== 'string' || m.trim() === '') missing.push(`${loc}: attendance.explain.${key}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('no catalog carries an explain key the reader can no longer emit', () => {
    // Chrome keys are literals in the panel and are checked separately below; everything else under
    // `explain` is a step key and must still have a producer, or the catalogs are accreting dead strings.
    const chrome = new Set([...CHROME_KEYS, 'source', 'dayType']);
    const orphans = Object.keys(at(CATALOGS.en, 'attendance.explain') as Dict).filter(
      (k) => !DECLARED.has(k) && !chrome.has(k),
    );
    expect(orphans, orphans.join(', ')).toEqual([]);
  });
});

describe('C. every placeholder is an argument the reader actually supplies', () => {
  it('no locale references a value nobody passes', () => {
    const bad: string[] = [];
    for (const loc of LOCALES) {
      for (const [key, args] of EMITTED) {
        const msg = message(loc, key);
        if (typeof msg !== 'string') continue; // the previous test owns "missing"
        for (const p of placeholders(msg)) {
          if (!/^\w+$/.test(p)) bad.push(`${loc}.${key}: "{${p}}" is not a plain placeholder`);
          else if (!args.has(p)) bad.push(`${loc}.${key}: "{${p}}" is never supplied (has: ${[...args].join(', ') || 'none'})`);
        }
        const braces = (msg.match(/\{/g) ?? []).length - (msg.match(/\}/g) ?? []).length;
        if (braces !== 0) bad.push(`${loc}.${key}: unbalanced braces`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('the English sentence mentions every number it was given', () => {
    // The other five locales may legitimately restructure a sentence; English is the source text, and a
    // number the engine computed but the sentence never shows is a step that explains nothing.
    const silent: string[] = [];
    for (const [key, args] of EMITTED) {
      const msg = message('en', key);
      if (typeof msg !== 'string') continue;
      const used = new Set(placeholders(msg));
      for (const a of args) if (!used.has(a)) silent.push(`en.${key} never shows "{${a}}"`);
    }
    expect(silent, silent.join('\n')).toEqual([]);
  });
});

describe('D. the panel chrome and the enum-driven keys resolve', () => {
  it('the panel writes chrome strings, and they are all translated', () => {
    expect(CHROME_KEYS.size).toBeGreaterThan(5); // the scan found the panel, not an empty file
    const missing: string[] = [];
    for (const loc of LOCALES) {
      for (const k of CHROME_KEYS) {
        const m = message(loc, k);
        if (typeof m !== 'string' || m.trim() === '') missing.push(`${loc}: attendance.explain.${k}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('every schedule source and day type the engine can stamp has a label', () => {
    const missing: string[] = [];
    for (const loc of LOCALES) {
      for (const s of unionMembers('TraceScheduleSource')) {
        if (typeof message(loc, `source.${s}`) !== 'string') missing.push(`${loc}: attendance.explain.source.${s}`);
      }
      for (const d of unionMembers('TraceDayType')) {
        if (typeof message(loc, `dayType.${d}`) !== 'string') missing.push(`${loc}: attendance.explain.dayType.${d}`);
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('the column labels the panel borrows for the OT buckets exist', () => {
    // The bucket names come from `t(BUCKET_KEY[bucket])` — a computed key no static scan of t() calls can
    // see, so the labels are matched by shape instead: every 'colX' literal in the panel must resolve.
    const cols = [...new Set([...PANEL.matchAll(/'(col[A-Za-z0-9]+)'/g)].map((m) => m[1]))];
    expect(cols.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const loc of LOCALES) {
      for (const c of cols) if (typeof at(CATALOGS[loc], `attendance.${c}`) !== 'string') missing.push(`${loc}: attendance.${c}`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('there is a bucket label for every bucket the split can carry', () => {
    const buckets = Object.keys(split());
    const mapped = [...PANEL.matchAll(/^\s*(\w+):\s*'col[A-Za-z0-9]+',$/gm)].map((m) => m[1]);
    expect(mapped.sort()).toEqual(buckets.sort());
  });
});

describe('a day with no working says so', () => {
  it('reports no-trace for a NULL column and never invents one', () => {
    // Migration 0411 does not backfill and explains why it never can, so this is the common case on every
    // existing row. An empty panel would read as "there was nothing to it", a different and false claim.
    const e = explainAttendanceDay(null);
    expect(e).toEqual({ kind: 'unavailable', reason: 'no-trace' });
  });

  it('reports unknown-version rather than mis-explaining a trace it does not understand', () => {
    const future = { ...trace(), v: ATTENDANCE_TRACE_VERSION + 1 };
    expect(explainAttendanceDay(future)).toEqual({ kind: 'unavailable', reason: 'unknown-version' });
    expect(explainAttendanceDay({ nonsense: true })).toEqual({ kind: 'unavailable', reason: 'unknown-version' });
  });

  it('all six catalogs can say it', () => {
    for (const loc of LOCALES) {
      for (const k of ['unavailable', 'unavailableWhy', 'unknownVersion']) {
        expect(typeof message(loc, k), `${loc}.${k}`).toBe('string');
      }
    }
  });
});

describe('the reader stays incapable of disagreeing with the figure', () => {
  it('each section reports the minutes the trace stored, not a recomputation', () => {
    const t = trace({ lateness: late(25, false), earlyOut: early(12, true), overtime: ot({ minutes: 30 }) });
    const e = explainAttendanceDay(t);
    if (e.kind !== 'explained') throw new Error('expected an explained day');
    expect(e.lateness.minutes).toBe(25);
    expect(e.earlyOut.minutes).toBe(12);
    expect(e.overtime.minutes).toBe(30);
  });

  it('a concept that does not apply to the day is null minutes, not zero', () => {
    const e = explainAttendanceDay(trace());
    if (e.kind !== 'explained') throw new Error('expected an explained day');
    // Null and 0 are different answers: "there is no scheduled start to be late against" versus "you were
    // on time". The panel prints an em dash for one and "0m" for the other.
    expect(e.lateness.minutes).toBeNull();
    expect(e.earlyOut.minutes).toBeNull();
    expect(e.overtime.minutes).toBeNull();
  });

  it('the OT bucket lines only appear for buckets that carry minutes', () => {
    const e = explainAttendanceDay(trace({ overtime: ot({ split: split({ ot15: 30 }) }) }));
    if (e.kind !== 'explained') throw new Error('expected an explained day');
    const buckets = e.overtime.steps.filter((s) => s.key === 'otBucket').map((s) => s.args?.bucket);
    expect(buckets).toEqual(['ot15']);
  });
});
