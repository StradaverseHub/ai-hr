import {ATTENDANCE_CLOCK_DAY_TYPES,type AttendanceClockPolicy} from '@/lib/attendance-clock-policy';

export function readScheduleClockPolicyFields(form: FormData) {
  if (form.get('scheduleClockPolicy') !== '1') return null;
  const pairing = {} as AttendanceClockPolicy['pairing'];
  for (const day of ATTENDANCE_CLOCK_DAY_TYPES) {
    const value = form.get('clockPairing_' + day);
    if (value !== 'auto' && value !== 'firstInLastOut') throw new Error('Choose a pairing method for each day type.');
    pairing[day] = value;
  }
  const ordinal = String(form.get('clockExpectedOrdinal') ?? '');
  const interval = String(form.get('clockMinimumInterval') ?? '');
  if (!/^\d+$/.test(ordinal) || !/^\d+$/.test(interval)) {
    throw new Error('Provide the current revision and a whole number of minutes.');
  }
  return {
    companyId: String(form.get('clockCompanyId') ?? ''),
    expectedOrdinal: Number(ordinal),
    effectiveFrom: String(form.get('clockEffectiveFrom') ?? ''),
    reason: String(form.get('clockReason') ?? ''),
    policy: { pairing, minimumIntervalMinutes: Number(interval) },
  };
}
