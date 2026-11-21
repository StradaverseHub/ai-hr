/** 87bd9656 — Overtime Backdate Control: the pure date rule and its typed refusal. Client-safe, no imports.
 *
 * The count runs back from the submission date (the HR business date, lib/hr-date.ts todayInKualaLumpur) in
 * calendar days. With 3 days, an application submitted on 16-Nov-2026 may be for 13, 14, 15 or 16-Nov-2026 (or
 * any later, planned date), and not for 12-Nov-2026 or earlier. The submission owner (core/attendance.ts)
 * decides which Schedule Group revision supplies the limit; this module only does the arithmetic. */

/** The earliest overtime date a limit of `limitDays` allows on `today` (both ISO yyyy-mm-dd). */
export function overtimeBackdateEarliestDate(today: string, limitDays: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isSafeInteger(limitDays) || limitDays < 1) throw new Error('Invalid overtime backdate limit.');
  return new Date(Date.parse(today + 'T00:00:00Z') - limitDays * 86_400_000).toISOString().slice(0, 10);
}

/** Whether an overtime application dated `date` is outside the limit on `today`. Today and later always pass. */
export function overtimeBackdateRefused(date: string, today: string, limitDays: number): boolean {
  return date < overtimeBackdateEarliestDate(today, limitDays);
}

/** Refusal raised by the one submission owner. Web actions and mobile v2 map it to a translated sentence
 * (scheduleOvertimeSetting.backdateRefused) naming the earliest date the person can still choose. */
export class OvertimeBackdateNotAllowedError extends Error {
  constructor(readonly limitDays: number, readonly earliestDate: string) {
    super(`Overtime applications can be backdated by at most ${limitDays} day(s). Choose ${earliestDate} or a later date.`);
    this.name = 'OvertimeBackdateNotAllowedError';
  }
}
