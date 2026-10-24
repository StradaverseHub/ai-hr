import {isCalendarDate} from './calendar-date';
import {todayInKualaLumpur} from './hr-date';

/** Explicit HR testimony of actual work. These are entered instants, never clock captures,
 * approved-plan positions, computed payable counts or an approval capability. */
export type AttendancePolicyUnclockedWork={version:1;completeWorkedDay:true;sourceDate:string;reason:string;
 intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[];
 /** Explicit actual-work subset requested as overtime; never an approved plan. */
 requestedIntervals?:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};

export function validateAttendancePolicyUnclockedWork(value:AttendancePolicyUnclockedWork,nowMillisecond:number,requestedMinutes?:number):AttendancePolicyUnclockedWork{
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
 let requestedIntervals:AttendancePolicyUnclockedWork['requestedIntervals'];
 if(value.requestedIntervals!==undefined){
  if(!Array.isArray(value.requestedIntervals)||!value.requestedIntervals.length||value.requestedIntervals.length>16)
   throw Error('Record the actual intervals covered by the requested overtime count.');
  previous=midnight;let count=0;
  requestedIntervals=value.requestedIntervals.map(row=>{
   if(!row||!Number.isSafeInteger(row.fromEpochMillisecond)||!Number.isSafeInteger(row.toEpochMillisecond)
    ||row.fromEpochMillisecond<previous||row.toEpochMillisecond<=row.fromEpochMillisecond
    ||!intervals.some(actual=>actual.fromEpochMillisecond<=row.fromEpochMillisecond&&actual.toEpochMillisecond>=row.toEpochMillisecond))
    throw Error('Requested overtime intervals must be ordered, nonoverlapping subsets of the stated actual work.');
   const minutes=Math.floor((row.toEpochMillisecond-midnight)/60000)-Math.floor((row.fromEpochMillisecond-midnight)/60000);
   if(minutes<=0)throw Error('Each requested overtime interval must identify a positive minute count.');
   count+=minutes;previous=row.toEpochMillisecond;
   return {fromEpochMillisecond:row.fromEpochMillisecond,toEpochMillisecond:row.toEpochMillisecond};
  });
  if(requestedMinutes!==undefined&&count!==requestedMinutes)throw Error('The requested overtime count must match its explicitly positioned intervals.');
 }
 return {version:1,completeWorkedDay:true,sourceDate:value.sourceDate,reason:value.reason,intervals,
  ...(requestedIntervals?{requestedIntervals}:{})};
}

/** Explicit Malaysia local input, independent of the browser/server's own timezone. */
export function attendancePolicyLocalWorkInstant(value:string):number{
 const match=/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(value);
 if(!match||!isCalendarDate(match[1]))throw Error('Enter a valid actual work date and time in Malaysia time.');
 const instant=Date.parse(value+'+08:00');
 if(!Number.isSafeInteger(instant))throw Error('Enter an exact actual work instant.');
 return instant;
}

/** Calendar coverage for withdrawal protection only; no payable count or financial authority.
 * Retain the source day and every actual physical date, respecting exclusive interval ends. */
export function attendancePolicyUnclockedWorkDates(value:AttendancePolicyUnclockedWork):string[]{
 const work=validateAttendancePolicyUnclockedWork(value,Number.MAX_SAFE_INTEGER);
 const midnight=Date.parse(work.sourceDate+'T00:00:00+08:00'),day=86400000,dates=new Set([work.sourceDate]);
 for(const interval of work.intervals){
  const first=Math.floor((interval.fromEpochMillisecond-midnight)/day);
  const last=Math.floor((interval.toEpochMillisecond-1-midnight)/day);
  for(let offset=first;offset<=last;offset++)dates.add(todayInKualaLumpur(new Date(midnight+offset*day)));
 }
 return [...dates].sort();
}
