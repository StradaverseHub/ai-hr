import type { OtRowInput } from '@/core/attendance-rule';

/** Parse the OT-rows hidden JSON field into typed rows. Invalid / empty ⇒ []. */
export function parseOtRows(raw: string, strict = false): OtRowInput[] {
  if (!raw && !strict) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr) || strict && arr.some(row=>!row || typeof row!=='object' || Array.isArray(row))) {
      throw new Error('The overtime bands could not be read. Reopen this schedule before saving.');
    }
    return arr
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .map((x) => ({
        fromMinutes: Math.trunc(Number(x.fromMinutes ?? 0)) || 0,
        toMinutes: Math.trunc(Number(x.toMinutes ?? 0)) || 0,
        ratePattern: x.ratePattern === 'variable' ? 'variable' : 'flat',
        // 7c834696 contested — an ABSENT rate stays absent. `Number(x.rate ?? 0) || 0` used to turn "the
        // admin has not typed a rate" into a stored 0.00, which is a real and different setting ("record
        // the hours, pay nothing"). Now the band that was never filled in is refused on save with a message
        // naming the row, instead of being paid at a number nobody chose.
        rate: x.rate == null || x.rate === '' ? null : Number(x.rate) || 0,
        phRate: x.phRate == null || x.phRate === '' ? null : Number(x.phRate) || 0,
        // 0439 — three modes. Anything else (including the pre-0439 booleans, if a stale tab posts one)
        // normalises to 'none' in core/attendance-rule.ts, which cannot change what a band pays.
        roundingMode: x.roundingMode === 'down' || x.roundingMode === 'up' ? x.roundingMode : 'none',
        roundToMinutes: x.roundToMinutes == null || x.roundToMinutes === '' ? null : Math.trunc(Number(x.roundToMinutes)) || null,
      }));
  } catch {
    if(strict)throw new Error('The overtime bands could not be read. Reopen this schedule before saving.');
    return [];
  }
}
