/** AI v2 W8 loop 4 — missed clock-outs.
 *
 * Detect: an attendance day in the last CLOCK_OUT_LOOKBACK_DAYS with a clock-in and no clock-out, as the attendance
 * owner reads it (packs/attendance/service attendanceForEmploymentsRange), for employments of the companies in scope
 * that use attendance. Yesterday's shift that runs past midnight is left for the next run.
 * Diagnose: the roster (or default shift) end time the attendance owner resolved for that day. A day with no end
 * time is not prepared: there is nothing to propose.
 * Prepare: an attendance-correction card for the employee proposing the roster end time as the clock-out. The card
 * opens the slice 1 correction's own form (the attendance day, prefilled with that time), where the employee confirms
 * it or changes it and gives their reason; the attendance service then sends it for the usual approval. The attendance
 * service takes a clock-out only after the clock-in on the same day (core/attendance.ts refuses an end on or before the
 * start; it has no correction across midnight). So a day whose end time is not after its clock-in (an overnight shift
 * on an older day, or a clock-in after the roster end) gets no employee card the service would refuse: it is an HR case,
 * "needs a manual correction", with no proposed time (recipient hr, facts.needs manual_correction).
 * Verify: waiting while the employee's correction is pending; done when a clock-out is on record, completed as
 * prepared when it equals the proposed time and changed by the person when it differs (an HR case proposed none, so it
 * is completed); superseded when the clock-in
 * is gone; inactive when the employment ended; expired after CLOCK_OUT_EXPIRY_DAYS. A rejected or withdrawn
 * correction with still no clock-out reopens the card. */
import {and,eq,gte,inArray,isNull,lte} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {attendanceCorrection,employment} from '../../db/schema';
import {isModuleEnabled} from '../entitlements';
import {attendanceForEmploymentsRange} from '../../packs/attendance/service';
import {addHrDays} from '../../lib/today/audience';
import {clockOf,read,unique,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';

export const CLOCK_OUT_LOOKBACK_DAYS=7;
export const CLOCK_OUT_EXPIRY_DAYS=31;
export const CLOCK_OUT_LOOP_VERSION='loop_missed_clock_outs@v1';
const OWNER='packs/attendance/service.ts#attendanceForEmploymentsRange';
const BATCH=100;
export const clockOutKey=(employmentId:string,date:string)=>`clockout:${employmentId}:${date}`;
const dateOfKey=(key:string)=>/:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1]??null;

type Day=Readonly<{checkIn:string|null;checkOut:string|null;shiftStart:string|null;shiftEnd:string|null}>;
/** The HR case for a day the employee's card cannot correct. */
export const CLOCK_OUT_MANUAL='manual_correction';
const minutes=(clock:string)=>Number(clock.slice(0,2))*60+Number(clock.slice(3,5));
/** Whether the attendance service takes this clock-out with this clock-in: strictly later on the same day. */
export const clockOutCorrectable=(checkIn:string,checkOut:string)=>minutes(checkOut)>minutes(checkIn);
/** The case for one day: the employee's card proposing the roster end, or HR's when the service would refuse that. */
function caseFor(date:string,checkIn:string,shiftEnd:string,shiftStart:string|null):Readonly<{recipient:'employee'|'hr';facts:LoopObservation['facts']}>{
 const end=shiftEnd.slice(0,5),start:Readonly<Record<string,string>>=shiftStart?{shiftStart:shiftStart.slice(0,5)}:{};
 return clockOutCorrectable(checkIn,end)?{recipient:'employee',facts:{date,checkIn,proposedCheckOut:end,...start}}
  :{recipient:'hr',facts:{date,checkIn,needs:CLOCK_OUT_MANUAL,shiftEnd:end,...start}};
}
const manual=(facts:LoopObservation['facts'])=>facts.needs===CLOCK_OUT_MANUAL;

export async function detectMissedClockOuts(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const companies=input.companyIds.filter(companyId=>isModuleEnabled(sponsor,'attendance',companyId));
 const to=addHrDays(input.today,-1),from=addHrDays(input.today,-CLOCK_OUT_LOOKBACK_DAYS),oldest=addHrDays(input.today,-CLOCK_OUT_EXPIRY_DAYS);
 const tracked=input.tracked.flatMap(item=>{const date=dateOfKey(item.subjectKey);return date&&item.employmentId?[{...item,date,employmentId:item.employmentId}]:[];});
 const observations:LoopObservation[]=[];
 // Tracked days past the expiry are closed without a read: the moment for this card has passed.
 for(const item of tracked)if(item.date<oldest)observations.push({subjectKey:item.subjectKey,companyId:item.companyId,employmentId:item.employmentId,
  recipient:manual(item.facts)?'hr':'employee',state:'closed',closeReason:'expired',facts:item.facts});
 const live=tracked.filter(item=>item.date>=oldest);
 const start=live.reduce((min,item)=>item.date<min?item.date:min,from);
 const people=await withTenant(sponsor,async tx=>{
  const scoped=companies.length?await tx.select({id:employment.id,companyId:employment.companyId,terminatedOn:employment.terminatedOn}).from(employment)
   .where(and(inArray(employment.companyId,companies),lte(employment.hiredOn,to))):[];
  const trackedIds=unique(live.map(item=>item.employmentId)).filter(id=>!scoped.some(row=>row.id===id));
  const others=trackedIds.length?await tx.select({id:employment.id,companyId:employment.companyId,terminatedOn:employment.terminatedOn}).from(employment)
   .where(inArray(employment.id,trackedIds)):[];
  return [...scoped,...others];
 });
 const active=people.filter(row=>row.terminatedOn==null||row.terminatedOn>=from),ended=new Set(people.filter(row=>row.terminatedOn!=null&&row.terminatedOn<input.today).map(row=>row.id));
 const days=new Map<string,Day>();
 const ids=unique(active.map(row=>row.id));
 for(let offset=0;offset<ids.length;offset+=BATCH){
  const range=await attendanceForEmploymentsRange(sponsor,ids.slice(offset,offset+BATCH),start,to);
  for(const [employmentId,rows] of range)for(const row of rows)
   days.set(`${employmentId}:${row.date}`,{checkIn:clockOf(row.checkInAt),checkOut:clockOf(row.checkOutAt),shiftStart:row.shiftStart,shiftEnd:row.shiftEnd});
 }
 // Corrections the employee already sent for these days, as the attendance owner stores them.
 const pending=new Set<string>();
 if(ids.length){
  await withTenant(sponsor,async tx=>{
   for(let offset=0;offset<ids.length;offset+=500){
    const rows=await tx.select({employmentId:attendanceCorrection.employmentId,date:attendanceCorrection.attendanceDate}).from(attendanceCorrection)
     .where(and(inArray(attendanceCorrection.employmentId,ids.slice(offset,offset+500)),gte(attendanceCorrection.attendanceDate,start),lte(attendanceCorrection.attendanceDate,to),
      eq(attendanceCorrection.status,'pending'),isNull(attendanceCorrection.cancelledAt)));
    for(const row of rows)pending.add(`${row.employmentId}:${row.date}`);
   }
  });
 }
 const companyOf=new Map(people.map(row=>[row.id,row.companyId])),known=new Map(live.map(item=>[item.subjectKey,item]));
 // Tracked cases first: verify each against the day as it is on record now.
 for(const item of live){
  const base={subjectKey:item.subjectKey,companyId:item.companyId,employmentId:item.employmentId,recipient:manual(item.facts)?'hr' as const:'employee' as const};
  if(ended.has(item.employmentId)){observations.push({...base,state:'closed',closeReason:'inactive',facts:item.facts});continue;}
  const day=days.get(`${item.employmentId}:${item.date}`);
  if(!day)continue;
  if(day.checkOut){
   const proposed=typeof item.facts.proposedCheckOut==='string'?item.facts.proposedCheckOut:null;
   observations.push({...base,state:'closed',closeReason:'done',resolution:manual(item.facts)?'completed':day.checkOut===proposed?'as_prepared':'changed',
    facts:{...item.facts,recordedCheckOut:day.checkOut}});
   continue;
  }
  if(!day.checkIn){observations.push({...base,state:'closed',closeReason:'superseded',facts:item.facts});continue;}
  const state=pending.has(`${item.employmentId}:${item.date}`)?'waiting' as const:'open' as const;
  // An employee card whose proposal the attendance service would refuse (prepared before this check, or the clock-in
  // changed since) becomes HR's case: the person is never asked to confirm a time the service cannot take.
  const proposed=typeof item.facts.proposedCheckOut==='string'?item.facts.proposedCheckOut:null;
  if(!manual(item.facts)&&proposed&&!clockOutCorrectable(day.checkIn,proposed)){
   observations.push({...base,recipient:'hr',state,facts:caseFor(item.date,day.checkIn,proposed,day.shiftStart).facts});
   continue;
  }
  observations.push({...base,state,facts:item.facts});
 }
 // New days: a clock-in, no clock-out, an end time to propose and no correction already sent.
 for(const [dayKey,day] of days){
  const [employmentId,date]=[dayKey.slice(0,36),dayKey.slice(37)];
  const key=clockOutKey(employmentId,date),companyId=companyOf.get(employmentId);
  if(known.has(key)||!companyId||!companies.includes(companyId)||date<from||ended.has(employmentId))continue;
  if(!day.checkIn||day.checkOut||!day.shiftEnd||pending.has(dayKey))continue;
  // A shift that ends after midnight may still be running on yesterday's row.
  if(date===to&&day.shiftStart&&day.shiftEnd<=day.shiftStart)continue;
  // The employee's card proposes the roster end; a day whose end is not after the clock-in (an overnight shift on an
  // older day) is HR's, needing a manual correction: never a card the attendance service would refuse.
  const prepared=caseFor(date,day.checkIn,day.shiftEnd,day.shiftStart);
  observations.push({subjectKey:key,companyId,employmentId,recipient:prepared.recipient,state:'open',facts:prepared.facts});
 }
 return {observations,reads:[read('attendance.days',OWNER),read('attendance.corrections_pending','db/schema.ts#attendanceCorrection')]};
}
