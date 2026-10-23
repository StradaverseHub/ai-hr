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
 rule:'extendedHours'|'measuredRestDay'|'measuredHoliday'|'claimWindow';sourceMinutes:number;qualifyingMinutes:number;countedMinutes:number;days:number};
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
    sourceMinutes:row.minutes,qualifyingMinutes,countedMinutes:credit.countedMinutes,days:credit.days});
  }else{
   // The roster election still excludes Off days. The employee/HR claim path
   // above retains its existing all-class threshold rule.
   if(row.dayClass==='off')throw Error('Off-day roster TOIL is unavailable under the existing credit rule.');
   const holiday=row.dayClass==='publicHoliday'||row.dayClass==='replacementHoliday';
   parts.push({sequence:row.sequence,date:row.date,dayClass:row.dayClass,rule:holiday?'measuredHoliday':'measuredRestDay',
    sourceMinutes:row.minutes,qualifyingMinutes,countedMinutes:qualifyingMinutes,days:toilMeasuredCreditDays(qualifyingMinutes,holiday?'holiday':'rest_day',policy.accrualBasis)});
  }
 }
 return {parts,days:Math.round(parts.reduce((n,p)=>n+p.days,0)*100)/100,countedMinutes:parts.reduce((n,p)=>n+p.countedMinutes,0)};
}

/** Frozen banking/expiry basis, never a caller-supplied grant or current duration capability. */
export type DatedToilCreditEvidence={v:1;sourceDate:string;calculationId:string;sourceRevision:number;durationDigest:string;
 path:'roster'|'claim';consumptionOrder:'earliestDateFirst';sourceMinutes:number;countedMinutes:number;days:number;parts:DatedToilCredit[]};

/** Consume dated credits in the owner's explicit earliest-date-first order. Use
 * integer hundredths of a credit day so partially used lots retain exact balances. */
export function remainingDatedToilCredit(evidence:DatedToilCreditEvidence,remaining:number){
 const cents=(n:number)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>9999.99||Math.abs(n*100-Math.round(n*100))>0.000001)throw Error('Invalid dated credit day balance.');return Math.round(n*100);};
 if(!evidence||evidence.v!==1||evidence.consumptionOrder!=='earliestDateFirst'||!['roster','claim'].includes(evidence.path)
  ||!Array.isArray(evidence.parts)||!evidence.parts.length||evidence.parts.length>3
  ||!Number.isSafeInteger(evidence.sourceRevision)||evidence.sourceRevision<1||!/^[0-9a-f]{64}$/.test(evidence.durationDigest))throw Error('Invalid retained dated TOIL credit.');
 let previous='',sequence=-1,days=0,sourceMinutes=0,countedMinutes=0;
 for(const part of evidence.parts){
  if(!Number.isSafeInteger(part.sequence)||part.sequence<=sequence||part.sequence>2||part.date<=previous
   ||!/^\d{4}-\d{2}-\d{2}$/.test(part.date)||!Number.isFinite(Date.parse(part.date+'T00:00:00Z'))
   ||new Date(part.date+'T00:00:00Z').toISOString().slice(0,10)!==part.date||part.date<evidence.sourceDate
   ||Date.parse(part.date+'T00:00:00Z')-Date.parse(evidence.sourceDate+'T00:00:00Z')>2*86400000
   ||![part.sourceMinutes,part.qualifyingMinutes,part.countedMinutes].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=4320)
   ||part.countedMinutes>part.qualifyingMinutes||part.qualifyingMinutes>part.sourceMinutes
   ||!['normal','off','rest','publicHoliday','replacementHoliday'].includes(part.dayClass)
   ||(evidence.path==='claim'?part.rule!=='claimWindow':!((part.rule==='extendedHours'&&part.dayClass==='normal')
    ||(part.rule==='measuredRestDay'&&part.dayClass==='rest')||(part.rule==='measuredHoliday'&&['publicHoliday','replacementHoliday'].includes(part.dayClass)))))throw Error('Dated credit partition changed.');
  previous=part.date;sequence=part.sequence;days+=cents(part.days);sourceMinutes+=part.sourceMinutes;countedMinutes+=part.countedMinutes;
 }
 if(days!==cents(evidence.days)||sourceMinutes!==evidence.sourceMinutes||countedMinutes!==evidence.countedMinutes||sourceMinutes>4320)throw Error('Dated credit totals changed.');
 let used=days-cents(remaining);if(used<0)throw Error('Dated credit remainder exceeds its original grant.');
 return evidence.parts.map(part=>{const original=cents(part.days),taken=Math.min(used,original);used-=taken;return {...part,remainingDays:(original-taken)/100};});
}
