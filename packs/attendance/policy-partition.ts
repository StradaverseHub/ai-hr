/** Derived parts of ONE source. Calendar facts must come from its canonical dated owner.
 * This function validates shape and coverage; it does not establish authority, approve work,
 * calculate money, or create another Attendance/settlement identity. */
import type {AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import type {PolicyCalendarProof,PolicyMoneyDay} from '../../lib/attendance-policy-calendar';
export type {PolicyCalendarProof} from '../../lib/attendance-policy-calendar';
import {
  attendancePolicyIntervalMinutes,splitAttendancePolicyIntervalsAtMidnight,
  unionAttendancePolicyIntervals,type AttendancePolicyInterval,
} from '../../lib/attendance-policy-intervals';
import {overtimeDate} from '../../lib/overtime-pattern-schema';

export type AttendancePolicyPart={
  date:string;dayClass:AttendancePolicyDayClass;moneyDay:PolicyMoneyDay;calendarReferences:string[];
  /** All intervals retain their absolute offsets on the PARENT source timeline. */
  intervals:AttendancePolicyInterval[];minutes:number;
};
export type PolicyPartition={status:'ready';parts:AttendancePolicyPart[];minutes:number}|
  {status:'unavailable';date:string;reason:'calendarUnavailable'|'holidayDesignationUnavailable';parts:[]};

const MONEY_DAY:Record<AttendancePolicyDayClass,PolicyMoneyDay>={
  normal:'workday',off:'workday',rest:'rest_day',publicHoliday:'holiday',replacementHoliday:'holiday',
};
const dateOffset=(date:string,offset:number)=>new Date(Date.parse(date+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);

/** Date offsets are calendar arithmetic over an already-established HR-local source date.
 * No timezone, punch direction, replacement holiday or approved interval is inferred here. */
export function partitionAttendancePolicyWork(input:{
  sourceDate:string;periodMinutes:number;splitAtMidnight:boolean;
  intervals:readonly AttendancePolicyInterval[];calendar:readonly PolicyCalendarProof[];
}):PolicyPartition{
  overtimeDate(input.sourceDate,'sourceDate');
  if(typeof input.splitAtMidnight!=='boolean'||input.calendar.length>3)throw Error('Invalid policy calendar proof.');
  const work=unionAttendancePolicyIntervals(input.intervals,input.periodMinutes),byDate=new Map<string,PolicyCalendarProof>();
  for(const fact of input.calendar){
    overtimeDate(fact.date,'calendar.date');
    if(byDate.has(fact.date))throw Error('Ambiguous policy calendar proof.');
    if(fact.state==='known'){
      if(!Object.hasOwn(MONEY_DAY,fact.dayClass)||MONEY_DAY[fact.dayClass]!==fact.moneyDay||!Array.isArray(fact.references)
        ||fact.references.length<1||fact.references.length>32||fact.references.some(ref=>typeof ref!=='string'||!ref.trim()||ref.length>500)
        ||new Set(fact.references).size!==fact.references.length)throw Error('Invalid recorded policy calendar classification.');
    }else if(fact.state!=='unknown'||!['calendarUnavailable','holidayDesignationUnavailable'].includes(fact.reason))throw Error('Invalid policy calendar refusal.');
    byDate.set(fact.date,fact);
  }
  const slices=input.splitAtMidnight
    ?splitAttendancePolicyIntervalsAtMidnight(work,input.periodMinutes).map(part=>({date:dateOffset(input.sourceDate,part.dayOffset),from:part.sourceFrom,to:part.sourceTo}))
    :work.map(part=>({date:input.sourceDate,...part}));
  const grouped=new Map<string,AttendancePolicyInterval[]>();
  for(const slice of slices){const rows=grouped.get(slice.date)??[];rows.push({from:slice.from,to:slice.to});grouped.set(slice.date,rows);}
  const parts:AttendancePolicyPart[]=[];
  for(const [date,intervals]of grouped){
    const fact=byDate.get(date);
    // A later unavailable date invalidates the entire partition, never just the missing child.
    if(!fact||fact.state==='unknown')return {status:'unavailable',date,reason:fact?.reason??'calendarUnavailable',parts:[]};
    parts.push({date,dayClass:fact.dayClass,moneyDay:fact.moneyDay,calendarReferences:[...fact.references],intervals,
      minutes:attendancePolicyIntervalMinutes(intervals,input.periodMinutes)});
  }
  const minutes=attendancePolicyIntervalMinutes(work,input.periodMinutes);
  if(parts.reduce((sum,part)=>sum+part.minutes,0)!==minutes)throw Error('Policy parts must partition one complete source.');
  return {status:'ready',parts,minutes};
}
