import {calendarWindowDates} from './calendar-window';
/** Home transport contains clock facts, never capture GPS, photos, commands or payroll amounts. */
export type EmployeeHomeToday={
 version:1;employmentId:string;serverNow:string;businessDate:string;attendanceEnabled:boolean;payrollEnabled:boolean;
 clock:{date:string;clockedIn:boolean;openSince:string|null;workedSeconds:number;crossesMidnight:boolean;
  shift:{code:string|null;start:string|null;end:string|null};geofencingRequired:boolean;photoRequired:boolean}|null;
 dayKind:'workday'|'rest_day'|'off_day'|'holiday'|null;leavePresence:'full_day'|'part_day'|null;
 workLocations:{total:number;names:string[]};payday:{date:string;daysAway:number}|null;
};
export function validateEmployeeHomeToday(value:EmployeeHomeToday,employmentId:string){
 const date=(raw:unknown)=>{if(typeof raw!=='string')return false;try{calendarWindowDates(raw,raw);return true;}catch{return false;}};
 const instant=(raw:unknown)=>typeof raw==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)&&Number.isFinite(Date.parse(raw));
 if(!value||value.version!==1||value.employmentId!==employmentId||!instant(value.serverNow)||!date(value.businessDate)
  ||typeof value.attendanceEnabled!=='boolean'||typeof value.payrollEnabled!=='boolean'
  ||!value.workLocations||!Number.isSafeInteger(value.workLocations.total)||value.workLocations.total<0
  ||!Array.isArray(value.workLocations.names)||value.workLocations.names.length>3||value.workLocations.names.length>value.workLocations.total
  ||value.workLocations.names.some(name=>typeof name!=='string'||!name.trim())
  ||value.leavePresence!==null&&!['full_day','part_day'].includes(value.leavePresence)
  ||value.dayKind!==null&&!['workday','rest_day','off_day','holiday'].includes(value.dayKind))throw Error('Your Day unavailable.');
 if(value.attendanceEnabled){
  const clock=value.clock;
  if(!clock||!date(clock.date)||typeof clock.clockedIn!=='boolean'||!Number.isSafeInteger(clock.workedSeconds)||clock.workedSeconds<0
   ||clock.openSince!==null&&!instant(clock.openSince)||clock.clockedIn!==(clock.openSince!==null)
   ||typeof clock.crossesMidnight!=='boolean'||typeof clock.geofencingRequired!=='boolean'||typeof clock.photoRequired!=='boolean'
   ||!clock.shift||[clock.shift.code,clock.shift.start,clock.shift.end].some(raw=>raw!==null&&typeof raw!=='string')||value.dayKind===null)throw Error('Your Day unavailable.');
 }else if(value.clock!==null||value.dayKind!==null||value.leavePresence!==null||value.workLocations.total!==0)throw Error('Your Day unavailable.');
 if(value.payday!==null&&(!value.payrollEnabled||!date(value.payday.date)||!Number.isSafeInteger(value.payday.daysAway)||value.payday.daysAway<0))throw Error('Your Day unavailable.');
 return value;
}
