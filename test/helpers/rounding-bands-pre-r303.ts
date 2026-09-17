/**
 * THE ORACLE — the custom rounding table's evaluator and validator EXACTLY AS THEY SHIPPED BEFORE r303
 * (05db6aa7), copied verbatim from core/leave-compute.ts at main@d6829740 (comments trimmed, code not
 * touched). NEVER "FIX" OR MODERNISE THIS FILE: its only job is to be the old behaviour.
 *
 * Under these rules a row {from, to, result} matched a decimal portion f when  from <= f < to  (a row
 * ending at exactly 1.000 inclusive), with every figure snapped to THREE decimals. r303 made the ranges
 * inclusive at both ends, at two decimals, and migration 0473 rewrote every stored table so the figures
 * credited do not move. Two guards compare against this copy:
 *
 *   - test/leave-rounding-bands-0473.test.ts runs the REAL migration SQL and asserts
 *     old(oldTable) === new(convertedTable) for every 2dp decimal and several whole parts;
 *   - test/leave-rounding-bands.test.ts §5 pins what migration 0414 changed, which was a change measured
 *     under THESE rules and cannot be restated under the new ones.
 */

type RoundingBand = { from: number; to: number; result: number };

type RoundingBandProblem =
  | { kind: 'shape'; index: number }
  | { kind: 'range'; index: number }
  | { kind: 'order'; index: number }
  | { kind: 'duplicate'; index: number }
  | { kind: 'overlap'; index: number }
  | { kind: 'gap'; from: number; to: number };

function round2dp(n: number): number {
  return Math.round(n * 100) / 100;
}

const bandRound = (n: number) => Math.round(n * 1000) / 1000;

function checkRoundingBands(bands: unknown): RoundingBandProblem[] {
  const out: RoundingBandProblem[] = [];
  if (!Array.isArray(bands)) return [{ kind: 'shape', index: 0 }];
  const rows: { from: number; to: number; i: number }[] = [];
  bands.forEach((b, i) => {
    const row = b as Record<string, unknown> | null;
    const nums = [row?.from, row?.to, row?.result];
    if (row == null || typeof row !== 'object' || nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      out.push({ kind: 'shape', index: i });
      return;
    }
    const from = bandRound(row.from as number);
    const to = bandRound(row.to as number);
    const result = bandRound(row.result as number);
    if (from < 0 || from > 1 || to < 0 || to > 1 || result < 0 || result > 1) {
      out.push({ kind: 'range', index: i });
      return;
    }
    if (from >= to) {
      out.push({ kind: 'order', index: i });
      return;
    }
    rows.push({ from, to, i });
  });
  for (let a = 0; a < rows.length; a++) {
    for (let z = a + 1; z < rows.length; z++) {
      const x = rows[a];
      const y = rows[z];
      if (x.from === y.from && x.to === y.to) out.push({ kind: 'duplicate', index: y.i });
      else if (x.from < y.to && y.from < x.to) out.push({ kind: 'overlap', index: y.i });
    }
  }
  if (out.length === 0) {
    let cursor = 0;
    for (const r of [...rows].sort((p, q) => p.from - q.from)) {
      if (r.from > cursor) out.push({ kind: 'gap', from: cursor, to: r.from });
      cursor = Math.max(cursor, r.to);
    }
    if (cursor < 1) out.push({ kind: 'gap', from: cursor, to: 1 });
  }
  return out;
}

function roundingBandErrors(bands: unknown): RoundingBandProblem[] {
  return checkRoundingBands(bands).filter((p) => p.kind !== 'gap');
}

function isWellFormedRoundingBands(bands: unknown): bands is RoundingBand[] {
  return Array.isArray(bands) && bands.length > 0 && roundingBandErrors(bands).length === 0;
}

function applyRoundingBands(value: number, bands: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (!isWellFormedRoundingBands(bands)) return value;
  const whole = Math.floor(value);
  const f = Math.round((value - whole) * 1000) / 1000;
  if (f === 0) return round2dp(value);
  for (const b of bands) {
    const from = bandRound(b.from);
    const to = bandRound(b.to);
    if (f >= from && (to >= 1 ? f <= to : f < to)) return round2dp(whole + bandRound(b.result));
  }
  return value;
}

export {
  applyRoundingBands as preR303ApplyRoundingBands,
  checkRoundingBands as preR303CheckRoundingBands,
  isWellFormedRoundingBands as preR303IsWellFormedRoundingBands,
};
