import {ATTENDANCE_CLOCK_DAY_TYPES,MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES,type AttendanceClockPolicy} from '@/lib/attendance-clock-policy';
import {readClockBaseline,readClockScope,readClockToken,sameClockPolicy,sameClockScope,type ClockScope} from '@/lib/schedule-clock-scope';

/**
 * c03670cc — the Attendance tab's clock settings, or null when nothing needs writing.
 *
 * The form always carries the controls (there is no "schedule new clock settings" tick box any more), so
 * "the administrator changed nothing" is read from the baseline the form rendered: an untouched form
 * writes no revision. The effective date and the reason are never read from the form: the service
 * supplies both.
 */
export function readScheduleClockPolicyFields(form: FormData): {
  scope: ClockScope; policy: AttendanceClockPolicy; expected: Record<string, number>;
} | null {
  if (form.get('clockEditor') !== '1') return null;
  const pairing = {} as AttendanceClockPolicy['pairing'];
  for (const day of ATTENDANCE_CLOCK_DAY_TYPES) {
    const value = form.get('clockPairing_' + day);
    if (value !== 'auto' && value !== 'firstInLastOut') throw new Error('Choose a pairing method for each day type.');
    pairing[day] = value;
  }
  const interval = String(form.get('clockMinimumInterval') ?? '').trim();
  if (!/^\d{1,4}$/.test(interval) || Number(interval) > MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES) {
    throw new Error(`Minimum Interval Between Clock must be a whole number of minutes from 0 to ${MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES}.`);
  }
  const policy: AttendanceClockPolicy = { pairing, minimumIntervalMinutes: Number(interval) };
  const scope = readClockScope(form.get('clockScope'), form.getAll('clockCompanyIds'));
  const baseline = readClockBaseline(form.get('clockBaseline'));
  if (baseline && sameClockScope(baseline.scope, scope) && sameClockPolicy(baseline.policy, policy)) return null;
  return { scope, policy, expected: readClockToken(form.get('clockRevisionToken')) };
}
