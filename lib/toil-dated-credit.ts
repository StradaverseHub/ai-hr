/** Existing TOIL credit arithmetic, with an explicit per-date/class partition. This
 * owns credit quantities only; the banking owner still proves source, consent,
 * statutory eligibility, duplicate settlement, permissions and closed Payroll. */
import {extendedHoursCreditDays,type ExtendedHoursTiers} from './extended-hours';
export const TOIL_STANDARD_DAY_MINUTES=480;
export const TOIL_PREMIUM_MULTIPLIER={workday:1.5,rest_day:2,holiday:3} as const;
export function toilMeasuredCreditDays(minutes:number,dayType:keyof typeof TOIL_PREMIUM_MULTIPLIER|null,basis:string):number{
 const multiplier=dayType!==null&&basis==='premium_equivalent'?TOIL_PREMIUM_MULTIPLIER[dayType]:1;
 return Math.round((minutes/TOIL_STANDARD_DAY_MINUTES)*multiplier*100)/100;
}
export type DatedToilCreditInput={sequence:number;date:string;dayClass:'normal'|'off'|'rest'|'publicHoliday'|'replacementHoliday';
 minutes:number;afterShiftMinutes:number|null};
export type DatedToilCredit={sequence:number;date:string;dayClass:DatedToilCreditInput['dayClass'];
 rule:'extendedHours'|'measuredRestDay'|'measuredHoliday'|'claimWindow';qualifyingMinutes:number;countedMinutes:number;days:number};
/** Each dated class uses its existing rule. Thresholds, break/grace and caps run
 * on that date alone. No aggregate threshold or invented mixed day classification. */
export function calculateDatedToilCredit(rows:readonly DatedToilCreditInput[],policy:ExtendedHoursTiers&{
 extendedHoursEnabled:boolean;accrualBasis:string},path:'roster'|'claim'):{parts:DatedToilCredit[];days:number;countedMinutes:number}{
 if(!rows.length||rows.length>3||!['roster','claim'].includes(path))throw Error('Complete dated TOIL allocation required.');
 if(!['hours_worked','premium_equivalent'].includes(policy.accrualBasis)||[policy.extendedHalfDayMinutes,policy.extendedFullDayMinutes,policy.extendedBreakMinutes,policy.extendedGraceMinutes].some(n=>!Number.isSafeInteger(n)||n<0)
  ||policy.extendedHalfDayMinutes<1||policy.extendedFullDayMinutes<policy.extendedHalfDayMinutes
  ||rows.reduce((n,r)=>n+r.minutes,0)>4320)throw Error('Invalid dated TOIL policy or total.');
 const dates=new Set<string>();let previous='',previousSequence=-1;const parts:DatedToilCredit[]=[];
 for(const row of rows){
  if(!Number.isSafeInteger(row.sequence)||row.sequence<=previousSequence||row.sequence>2||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||!Number.isFinite(Date.parse(row.date+'T00:00:00Z'))
   ||new Date(row.date+'T00:00:00Z').toISOString().slice(0,10)!==row.date||row.date<=previous||dates.has(row.date)
   ||!['normal','off','rest','publicHoliday','replacementHoliday'].includes(row.dayClass)
   ||!Number.isSafeInteger(row.minutes)||row.minutes<0||row.minutes>4320)throw Error('Invalid dated TOIL partition.');
  previous=row.date;previousSequence=row.sequence;dates.add(row.date);
  if(Date.parse(row.date+'T00:00:00Z')-Date.parse(rows[0].date+'T00:00:00Z')>2*86400000)throw Error('Dated TOIL exceeds its source horizon.');
  const ordinary=row.dayClass==='normal';
  if(ordinary&&(!policy.extendedHoursEnabled||row.afterShiftMinutes===null||!Number.isSafeInteger(row.afterShiftMinutes)
   ||row.afterShiftMinutes<0||row.afterShiftMinutes>row.minutes))throw Error('Recorded ordinary-day post-shift qualification required.');
  const qualifyingMinutes=ordinary?row.afterShiftMinutes!:row.minutes;
  if(path==='claim'||ordinary){
   const credit=extendedHoursCreditDays(qualifyingMinutes,policy);
   parts.push({sequence:row.sequence,date:row.date,dayClass:row.dayClass,rule:path==='claim'?'claimWindow':'extendedHours',
    qualifyingMinutes,countedMinutes:credit.countedMinutes,days:credit.days});
  }else{
   // The roster election still excludes Off days. The employee/HR claim path
   // above retains its existing all-class threshold rule.
   if(row.dayClass==='off')throw Error('Off-day roster TOIL is unavailable under the existing credit rule.');
   const holiday=row.dayClass==='publicHoliday'||row.dayClass==='replacementHoliday';
   parts.push({sequence:row.sequence,date:row.date,dayClass:row.dayClass,rule:holiday?'measuredHoliday':'measuredRestDay',
    qualifyingMinutes,countedMinutes:qualifyingMinutes,days:toilMeasuredCreditDays(qualifyingMinutes,holiday?'holiday':'rest_day',policy.accrualBasis)});
  }
 }
 return {parts,days:Math.round(parts.reduce((n,p)=>n+p.days,0)*100)/100,countedMinutes:parts.reduce((n,p)=>n+p.countedMinutes,0)};
}
