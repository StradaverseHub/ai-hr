/**
 * core/attendance-trace.ts is a LEAF, and its two re-declared shapes must not drift.
 *
 * The header of that module promises both things, and names this file as the thing that holds it to
 * them. It was written before this test existed; this is the test.
 *
 * WHY A LEAF. db/schema.ts types the `attendance.calc_trace` jsonb column with `AttendanceTraceV1`, and
 * db/schema.ts imports nothing else from core/. If the trace module imported `DayType` from
 * core/attendance.ts — which imports db/schema.ts — the cycle would close. `import type` is erased at
 * runtime so it could not bite TODAY, but core/movement-kinds.ts was extracted for exactly this reason
 * and records the failure mode: "a `const` array that is `undefined` at module-init time depending on
 * which file was loaded first". One `import` that is later widened from a type to a value is all it takes,
 * and the symptom appears far from the edit. So the rule enforced here is the blunt one: NO imports at all.
 *
 * WHY THE SHAPES ARE PINNED. TraceDayType and TraceOtSplit are hand copies of core/attendance.ts's
 * `DayType` and core/attendance-calc.ts's `OtSplit`. A copy that silently falls behind its original is
 * worse than an import: the engine would write a bucket the panel cannot read, and only on the days that
 * used it. The two type-level assertions below are compile errors — `Expect<false>` does not type-check —
 * so a divergence fails `tsc --noEmit`, not just this file.
 *
 * No DB, no fixtures: everything here is source text and types.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_TRACE_VERSION,
  isAttendanceTrace,
  type TraceDayType,
  type TraceOtSplit,
} from '../core/attendance-trace';
import type { DayType } from '../core/attendance';
import type { OtSplit } from '../core/attendance-calc';

// ── the compile-time half ───────────────────────────────────────────────────────────────────────────
// Exported so no lint rule can decide an unused alias is dead and delete the guard.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type TraceDayTypeStillMatchesDayType = Expect<Equal<TraceDayType, DayType>>;
export type TraceOtSplitStillMatchesOtSplit = Expect<Equal<TraceOtSplit, OtSplit>>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'core/attendance-trace.ts'), 'utf8');
/** Comments talk ABOUT imports at length; only code counts. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('core/attendance-trace.ts is a leaf', () => {
  it('imports nothing at all — not even a type', () => {
    const offenders = code.split('\n').filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
    expect(
      offenders,
      'core/attendance-trace.ts must stay import-free so db/schema.ts can type the jsonb column without ' +
        'closing a cycle back into core/. Re-declare the shape and pin it above instead.',
    ).toEqual([]);
  });
});

describe('the stored trace declares its version', () => {
  it('is version 1', () => {
    expect(ATTENDANCE_TRACE_VERSION).toBe(1);
  });

  it('recognises a trace of the current version and nothing else', () => {
    const ok = { v: ATTENDANCE_TRACE_VERSION, schedule: {}, punch: {} };
    expect(isAttendanceTrace(ok)).toBe(true);
    // A future build's trace read by today's code is the exact failure the version exists to stop: the
    // reader must report `unavailable`, never explain a figure against rules it does not understand.
    expect(isAttendanceTrace({ ...ok, v: ATTENDANCE_TRACE_VERSION + 1 })).toBe(false);
    expect(isAttendanceTrace({ v: ATTENDANCE_TRACE_VERSION, punch: {} })).toBe(false); // no schedule
    expect(isAttendanceTrace({ v: ATTENDANCE_TRACE_VERSION, schedule: {} })).toBe(false); // no punch
    for (const junk of [null, undefined, 0, '', 'trace', [], true]) {
      expect(isAttendanceTrace(junk), `${JSON.stringify(junk)} is not a trace`).toBe(false);
    }
  });
});
