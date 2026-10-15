/** Read-only allowance facts from recorded Attendance and approved Leave-owner measurements.
 * No calendar, shift lookup, write, or re-derivation: historical missing evidence stays unknown.
 */
import { isAttendanceTrace } from './attendance-trace';
import type { ApprovedAllowanceLeavePiece } from '../packs/leave/service';

export type RecordedAllowanceAttendance = {
  checkInAt: Date | string | null;
  checkOutAt: Date | string | null;
  workedMinutes: number | null;
  otMinutes: number | null;
  underMinutes: number | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  calcTrace: unknown;
};
export type AllowanceAttendanceFactSource =
  | 'recorded-attendance' | 'recorded-attendance-trace'
  | 'recorded-attendance-and-approved-leave' | 'unavailable';
export type AllowanceAttendanceFactReason =
  | 'recorded-fixed-clock-applicability' | 'fixed-clock-applicability-not-recorded'
  | 'attendance-not-recorded' | 'incomplete-clocks' | 'shortfall-not-recorded'
  | 'recorded-zero-shortfall' | 'no-approved-leave' | 'approved-leave-allocation-unknown'
  | 'recorded-normal-target-unavailable' | 'recorded-full-day-basis-unavailable'
  | 'approved-leave-minutes-unavailable' | 'approved-full-day-leave'
  | 'approved-partial-leave-adjustment' | 'recorded-non-workday';
export type RecordedAllowanceAttendanceFacts = {
  fixedClockApplicable: boolean | null;
  lateMinutes: number | null;
  earlyOutMinutes: number | null;
  incomplete: boolean;
  shortMinutes: number | null;
  recordedUnderMinutes: number | null;
  recordedNormalMinutes: number | null;
  fullDayNormalMinutes: number | null;
  leaveMinutes: number | null;
  sources: { applicability: AllowanceAttendanceFactSource; shortfall: AllowanceAttendanceFactSource };
  reasons: { applicability: AllowanceAttendanceFactReason; shortfall: AllowanceAttendanceFactReason };
};
const measurement = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Call for attended rows. Explicit absence/no event remains the caller's canonical date fact.
 * approvedLeave=null means the Leave owner could not recover a non-overlapping date allocation.
 * A piece with full_day session covers this date's recorded required target, including a half day;
 * AM/PM fractions use the recorded FULL-day unit, never the already-halved date target.
 * Leave owns overlap resolution; this reader never independently unions request spans or sessions.
 */
export function recordedAllowanceAttendanceFacts(input: {
  record: RecordedAllowanceAttendance | null;
  approvedLeave: readonly ApprovedAllowanceLeavePiece[] | null;
}): RecordedAllowanceAttendanceFacts {
  const { record, approvedLeave } = input;
  const trace = isAttendanceTrace(record?.calcTrace) ? record.calcTrace : null;
  // These additive V1 fields are optional on historical traces. No reconstruction from current config.
  const schedule = trace?.schedule as (NonNullable<typeof trace>['schedule'] & {
    fixedClockApplicable?: boolean; fullDayNormalMinutes?: number;
  }) | undefined;
  const applicability = typeof schedule?.fixedClockApplicable === 'boolean' ? schedule.fixedClockApplicable : null;
  const recordedNonWorkday = schedule?.dayType === 'rest_day' || schedule?.dayType === 'holiday';
  const normal = recordedNonWorkday ? 0 : schedule?.dayType === 'workday'
    ? measurement(schedule.normalMinutesOverride ?? schedule.scheduledMinutes) : null;
  const fullDayNormal = measurement(schedule?.fullDayNormalMinutes);
  const under = measurement(record?.underMinutes);
  const incomplete = !!record && (record.checkInAt == null || record.checkOutAt == null
    || measurement(record.workedMinutes) == null || measurement(record.otMinutes) == null);
  const facts: RecordedAllowanceAttendanceFacts = {
    fixedClockApplicable: applicability,
    // Recorded raw positive AND zero figures outrank applicability. An old null is not silently zero.
    lateMinutes: measurement(record?.lateMinutes) ?? (applicability === false ? 0 : null),
    earlyOutMinutes: measurement(record?.earlyOutMinutes) ?? (applicability === false ? 0 : null),
    incomplete, shortMinutes: null, recordedUnderMinutes: under,
    recordedNormalMinutes: normal, fullDayNormalMinutes: fullDayNormal, leaveMinutes: null,
    sources: { applicability: applicability == null ? 'unavailable' : 'recorded-attendance-trace', shortfall: 'unavailable' },
    reasons: { applicability: applicability == null ? 'fixed-clock-applicability-not-recorded' : 'recorded-fixed-clock-applicability', shortfall: 'attendance-not-recorded' },
  };
  const result = (shortMinutes: number | null, reason: AllowanceAttendanceFactReason,
    source: AllowanceAttendanceFactSource = 'unavailable', leaveMinutes: number | null = null) => {
    facts.shortMinutes = shortMinutes;
    facts.leaveMinutes = leaveMinutes;
    facts.reasons.shortfall = reason;
    facts.sources.shortfall = source;
    return facts;
  };
  if (!record) return facts;
  if (incomplete) return result(null, 'incomplete-clocks');
  if (recordedNonWorkday) return result(0, 'recorded-non-workday', 'recorded-attendance-trace', 0);
  if (under == null) return result(null, 'shortfall-not-recorded');
  // Leave can only reduce a known deficit. Zero remains known even if Leave allocation is unknown.
  if (under === 0) return result(0, 'recorded-zero-shortfall', 'recorded-attendance');
  if (approvedLeave == null) return result(null, 'approved-leave-allocation-unknown');
  if (!approvedLeave.length) return result(under, 'no-approved-leave', 'recorded-attendance', 0);
  if (approvedLeave.some(piece => piece.session === 'full_day')) {
    if (normal == null) return result(null, 'recorded-normal-target-unavailable');
    return result(Math.max(0, under - normal), 'approved-full-day-leave', 'recorded-attendance-and-approved-leave', normal);
  }
  let leaveMinutes = 0;
  for (const piece of approvedLeave) {
    if (piece.session === 'hourly') {
      const minutes = measurement(piece.minutes);
      if (minutes == null) return result(null, 'approved-leave-minutes-unavailable');
      leaveMinutes += minutes;
    } else {
      const days = measurement(piece.days);
      if (days == null || days > 1) return result(null, 'approved-leave-minutes-unavailable');
      if (fullDayNormal == null) return result(null, 'recorded-full-day-basis-unavailable');
      leaveMinutes += days * fullDayNormal;
    }
  }
  if (!Number.isFinite(leaveMinutes)) return result(null, 'approved-leave-minutes-unavailable');
  // Keep minute precision supplied by Leave; the expression owner applies its comparison precision.
  return result(Math.max(0, under - leaveMinutes), 'approved-partial-leave-adjustment',
    'recorded-attendance-and-approved-leave', leaveMinutes);
}
