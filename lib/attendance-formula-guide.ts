import {attendanceFormulaVariable,ATTENDANCE_FORMULA_ALIASES} from './attendance-formula-catalog';
/** Public documentation only. Examples never supply missing source facts. */
export function attendanceFormulaVariableGuide(id:string){
 const variable=attendanceFormulaVariable(id);if(!variable)throw Error('Unknown Attendance variable.');
 const example=variable.type==='date'?'2026-11-08':variable.type==='boolean'?'true':variable.type==='decimal'?(variable.unit==='clock-minute'?'540':variable.unit==='days'?'0.5':variable.unit==='count'?'4':'60'):id==='DayTypeToday'||id==='SysDetectDayType'?'workday':/DayType|DayCode/.test(id)?'normal':id.includes('Time')?'09:00':id.includes('LeaveCode')?'ANNUAL':'Recorded code';
 const requirement=variable.owner==='overtime-approval'?'approvedCoverage':/Leave|OnLeave/.test(id)?'approvedLeave':id.startsWith('OTtoLeave_')?'toilSource':/Break|Flex|InShiftOT|Unproductive/.test(id)?'clockGeometry':/Yesterday|Tomorrow/.test(id)?'adjacentDate':/DayType|DayCode|Holiday/.test(id)?'datedCalendar':'recordedSource';
 return {example,requirement,aliasOf:ATTENDANCE_FORMULA_ALIASES[id]??null};
}
