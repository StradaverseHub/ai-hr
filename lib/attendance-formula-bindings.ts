import {ATTENDANCE_FORMULA_VARIABLES} from './attendance-formula-catalog';
/** Implemented native bindings only. Inventory membership is not an implementation or availability claim.
 * Every binding still requires its dated native evidence; missing proof is never synthesized as zero. */
export const ATTENDANCE_FORMULA_IMPLEMENTED_IDS=[
 'RecordDate','ShiftDate','DayDate','WeekDayNumber','WeekDay','PID','StartWork','LastWork','isResigned',
 'YesterdayNormalDayType','TomorrowNormalDayType','YesterdayLeaveCode','TomorrowLeaveCode',
 'LeaveCode1stHalf','LeaveCode2ndHalf','LeaveValue1stHalf','LeaveValue2ndHalf','OnLeaveDurationMins',
 'ClockSrcCount','TotalWorkingMins','OTEntry','LateInShift','EarlyOutFromShift','DayTypeToday','SysDetectDayType','FirstInTime','LastOutTime',
 'GazettedPublicHoliday','DayCodeInfo','PairingRemark','ScheduleOT','FirstIn','LastOut','FirstInLastOutMins','ShiftStart','ShiftEnd','ShiftID','ShiftGroupID','ScheduleWorkingTime','ShiftStartTime','ShiftEndTime',
 'InGracePeriod','LateInShiftRaw','LateWithinGracePeriod','OutGracePeriod','EarlyOutFromShiftRaw','EarlyInShift','LateOut','OTAdjustment',
 'UnproductiveTime','ShiftWorkingMins','ZoneAWorkingMins','ZoneBWorkingMins','ZoneADayType','ZoneBDayType','ZoneADayTypeDesc','OTAssignmentInShift','OutOfOfficeDurationMins',
] as const;
const implemented=new Set<string>(ATTENDANCE_FORMULA_IMPLEMENTED_IDS);
export const implementedAttendanceFormulaVariables=()=>ATTENDANCE_FORMULA_VARIABLES.filter(variable=>implemented.has(variable.id));
