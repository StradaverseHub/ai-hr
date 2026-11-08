import {ATTENDANCE_FORMULA_VARIABLES} from './attendance-formula-catalog';
/** Implemented native bindings only. Inventory membership is not an implementation or availability claim.
 * Every binding still requires its dated native evidence; missing proof is never synthesized as zero. */
export const ATTENDANCE_FORMULA_IMPLEMENTED_IDS=[
 'AprZoneAPostOTBreakWorkMins','AprZoneAPreOTBreakWorkMins','AprZoneBPostOTBreakWorkMins','AprZoneBPreOTBreakWorkMins','ZoneAInShiftOT','ZoneBPostInShiftOT','ZoneBPreInShiftOT','ZoneBPreOTDayType',
 'RecordDate','ShiftDate','DayDate','WeekDayNumber','WeekDay','PID','StartWork','LastWork','isResigned',
 'YesterdayNormalDayType','TomorrowNormalDayType','YesterdayLeaveCode','TomorrowLeaveCode',
 'LeaveCode1stHalfAll','LeaveCode2ndHalfAll','LeaveOnBreak1','LeaveOnBreak2','LeaveOnBreak3','LeaveOnBreak4','OnHourlyLeaveLateIn','OnHourlyLeaveEarlyOut','OnLeaveFirstHalfLateIn','OnLeaveSecondHalfEarlyOut','LeaveCode1stHalf','LeaveCode2ndHalf','LeaveValue1stHalf','LeaveValue2ndHalf','OnLeaveDurationMins',
 'ClockSrcAdjusted','DutyRosterPattern','ClockSrcCount','TotalWorkingMins','OTEntry','LateInShift','EarlyOutFromShift','DayTypeToday','SysDetectDayType','FirstInTime','LastOutTime',
 'GazettedPublicHoliday','DayCodeInfo','PairingRemark','ScheduleOT','FirstIn','LastOut','FirstInLastOutMins','ShiftStart','ShiftEnd','ShiftID','ShiftGroupID','ScheduleWorkingTime','ShiftStartTime','ShiftEndTime',
 'OTtoLeave_isUtilizeAll','OTtoLeave_TotalOTUsed','ShiftFirstHalfWorkingMins','ShiftSecondHalfWorkingMins','ShiftSeq','EarlyIn','TomorrowZoneADayType','TomorrowZoneAWorkingMins','TomorrowZoneBWorkingMins','YesterdayZoneADayType','YesterdayZoneAWorkingMins','YesterdayZoneBWorkingMins','InGracePeriod','LateInShiftRaw','LateWithinGracePeriod','OutGracePeriod','EarlyOutFromShiftRaw','EarlyInShift','LateOut','OTAdjustment',
 'ActualPreOTBreak','ActualPostOTBreak','ActualShiftBreak','Break1Interval','Break2Interval','Break3Interval','Break4Interval','Break1FlexUsed','Break2FlexUsed','Break3FlexUsed','Break4FlexUsed','Flex1Interval','Flex2Interval','Flex3Interval','Flex4Interval','BreakOnPreOT','BreakOnPostOT','BreakOnShift','FlexiBreakOnPreOT','FlexiBreakOnPostOT','FlexiBreakOnShift','PreOTBreakWorkingMins','PostOTBreakWorkingMins','UnUtilisedBreak','LateOnPreOTBreak','LateOnPostOTBreak','LateOnShiftBreak','EarlyOutOnPreOTBreak','EarlyOutOnPostOTBreak','EarlyOutOnShiftBreak',
 'ApproveZoneAOT','ApproveZoneAPreOT','ApproveZoneBOT','ApproveZoneBPreOT','ZoneAPreOT','ZoneAPostOT','ZoneBPostOT','ZoneBPreOT','UnproductiveTime','ShiftWorkingMins','ZoneAWorkingMins','ZoneBWorkingMins','ZoneADayType','ZoneBDayType','ZoneADayTypeDesc','OTAssignmentInShift','OutOfOfficeDurationMins',
] as const;
const implemented=new Set<string>(ATTENDANCE_FORMULA_IMPLEMENTED_IDS);
export const implementedAttendanceFormulaVariables=()=>ATTENDANCE_FORMULA_VARIABLES.filter(variable=>implemented.has(variable.id));
