import type { OtRowInput } from '@/core/attendance-rule';
import { OT_RATE_MAX, otRateText } from '@/lib/ot-rate';

/** A posted band rate: blank ⇒ null; otherwise it must be a valid typed rate (c03670cc). An invalid one is
 * REFUSED with the row named, never coerced — `Number('2.x') || 0` used to store "pay nothing". */
function postedRate(value: unknown, row: number, label: 'OT Rate' | 'PH Rate'): number | null {
  if (value == null || value === '') return null;
  const text = otRateText(value);
  if (text === null) {
    throw new Error(`Overtime row ${row}: ${label} must be a number from 0 to ${OT_RATE_MAX} with up to two decimal places.`);
  }
  return Number(text);
}

/** Parse the OT-rows hidden JSON field into typed rows. Invalid / empty JSON ⇒ [] (or refused when strict). */
export function parseOtRows(raw: string, strict = false): OtRowInput[] {
  if (!raw && !strict) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    if (strict) throw new Error('The overtime bands could not be read. Reopen this schedule before saving.');
    return [];
  }
  if (!Array.isArray(arr) || strict && arr.some(row=>!row || typeof row!=='object' || Array.isArray(row))) {
    if (strict) throw new Error('The overtime bands could not be read. Reopen this schedule before saving.');
    return [];
  }
  return (arr as unknown[])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, index) => ({
      fromMinutes: Math.trunc(Number(x.fromMinutes ?? 0)) || 0,
      toMinutes: Math.trunc(Number(x.toMinutes ?? 0)) || 0,
      ratePattern: x.ratePattern === 'variable' ? 'variable' : 'flat',
      // 7c834696 contested — an ABSENT rate stays absent and is refused on save with the row named.
      // c03670cc — a PRESENT rate must be a valid typed rate; anything else is refused here.
      rate: postedRate(x.rate, index + 1, 'OT Rate'),
      phRate: postedRate(x.phRate, index + 1, 'PH Rate'),
      // 0439 — three modes. Anything else (including the pre-0439 booleans, if a stale tab posts one)
      // normalises to 'none' in core/attendance-rule.ts, which cannot change what a band pays.
      roundingMode: x.roundingMode === 'down' || x.roundingMode === 'up' ? x.roundingMode : 'none',
      roundToMinutes: x.roundToMinutes == null || x.roundToMinutes === '' ? null : Math.trunc(Number(x.roundToMinutes)) || null,
    }));
}
