import {isCalendarDate} from './calendar-date';

/** Explicit HR testimony of actual work. These are entered instants, never clock captures,
 * approved-plan positions, computed payable counts or an approval capability. */
export type AttendancePolicyUnclockedWork={version:1;completeWorkedDay:true;sourceDate:string;reason:string;
 intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};

export function validateAttendancePolicyUnclockedWork(value:AttendancePolicyUnclockedWork,nowMillisecond:number):AttendancePolicyUnclockedWork{
 if(!value||value.version!==1||value.completeWorkedDay!==true||!isCalendarDate(value.sourceDate)||!Number.isSafeInteger(nowMillisecond)
  ||typeof value.reason!=='string'||value.reason!==value.reason.trim()||value.reason.length<1||value.reason.length>500
  ||!Array.isArray(value.intervals)||value.intervals.length<1||value.intervals.length>16)
  throw Error('Record the actual worked date, intervals and a reason for unclocked overtime.');
 const midnight=Date.parse(value.sourceDate+'T00:00:00+08:00'),limit=midnight+4320*60000;
 let previous=midnight;
 const intervals=value.intervals.map(row=>{
  if(!row||!Number.isSafeInteger(row.fromEpochMillisecond)||!Number.isSafeInteger(row.toEpochMillisecond)
   ||row.fromEpochMillisecond<previous||row.toEpochMillisecond<=row.fromEpochMillisecond
   ||row.toEpochMillisecond>limit||row.toEpochMillisecond>nowMillisecond)
   throw Error('Actual unclocked work requires ordered, nonoverlapping, completed intervals within the dated work period.');
  previous=row.toEpochMillisecond;
  return {fromEpochMillisecond:row.fromEpochMillisecond,toEpochMillisecond:row.toEpochMillisecond};
 });
 return {version:1,completeWorkedDay:true,sourceDate:value.sourceDate,reason:value.reason,intervals};
}

/** Explicit Malaysia local input, independent of the browser/server's own timezone. */
export function attendancePolicyLocalWorkInstant(value:string):number{
 const match=/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(value);
 if(!match||!isCalendarDate(match[1]))throw Error('Enter a valid actual work date and time in Malaysia time.');
 const instant=Date.parse(value+'+08:00');
 if(!Number.isSafeInteger(instant))throw Error('Enter an exact actual work instant.');
 return instant;
}
