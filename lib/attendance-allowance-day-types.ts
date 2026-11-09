/** Allowance evaluation inputs and the recorded attendance facts they can carry. */
import type { AllowanceDayKind } from './attendance-allowance-vocabulary';

export type AllowanceDay = {
  date: string; attendanceId: string | null; kind: AllowanceDayKind; shiftId: string | null;
  workingMinutes: number | null; actualMinutes: number | null; overtimeMinutes: number | null;
  lateMinutes: number | null; earlyOutMinutes: number | null;
  absentDays: number; attendanceDays: number; eligibleWorkingDays: number;
  complete: boolean;
  v3Facts?: {shortMinutes:number|null;incomplete:boolean;fixedClockApplicable:boolean|null;attendanceEvidence?:RecordedAllowanceAttendanceFacts;absenceKnown?:boolean;leave:{typeId:string;paid:boolean|null;days:number;requestIds:string[]}[]|null;leaveTypesPresent:string[];leaveUnknownTypeIds?:string[];source:string};
  factSources?: { measurements: 'recorded-attendance' | 'canonical-scheduled-absence'; recordedDayType: string | null; dayAndShift: 'canonical-schedule-at-calculation'; canonicalKind: AllowanceDayKind };
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
  recordedLateMinutes: number | null;
  recordedEarlyOutMinutes: number | null;
  incomplete: boolean;
  shortMinutes: number | null;
  recordedUnderMinutes: number | null;
  recordedNormalMinutes: number | null;
  fullDayNormalMinutes: number | null;
  leaveMinutes: number | null;
  sources: { applicability: AllowanceAttendanceFactSource; shortfall: AllowanceAttendanceFactSource };
  reasons: { applicability: AllowanceAttendanceFactReason; shortfall: AllowanceAttendanceFactReason };
};
