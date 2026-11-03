/** AI v2 W8 loop 5 — passports expiring.
 *
 * Detect: a recorded passport expiry within DOCUMENT_EXPIRY_HORIZON_DAYS, from the existing follow-up owner
 * (core/automatic-followups.ts followupItemsTx('passport_expiry')). That owner's window is 30 days, so the loop asks it
 * twice: from today, and from today + 30 (that second window judges "still employed" as of that later day, which is
 * when the passport would lapse). Companies outside the scope are left out.
 * Prepare: a Today card for the company's HR administrators (all expiring passports at a glance) and a reminder card
 * for the employee to renew it and send HR the new details through their profile. Nothing is changed by the loop.
 * Verify, as the sponsor reads the record: done when the recorded expiry is beyond the window (renewed); inactive when
 * the employment ended. A blank expiry proves nothing and leaves the case as it is. An expiry moved back inside the
 * window reopens the case. */
import {eq,inArray} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {employeeStatutoryMy,employment} from '../../db/schema';
import {followupItemsTx} from '../automatic-followups';
import {addHrDays} from '../../lib/today/audience';
import {read,unique,type LoopDetectInput,type LoopDetection,type LoopObservation} from './detect';

export const DOCUMENT_EXPIRY_HORIZON_DAYS=60;
/** The follow-up owner's own window (app.automatic_followup_facts, migration 0819). */
const FOLLOWUP_WINDOW_DAYS=30;
export const DOCUMENT_EXPIRY_LOOP_VERSION='loop_document_expiry@v1';
export const passportKey=(employmentId:string)=>`passport:${employmentId}`;

export async function detectDocumentExpiry(sponsor:SessionContext,input:LoopDetectInput):Promise<LoopDetection>{
 const scope=new Set(input.companyIds),horizon=addHrDays(input.today,DOCUMENT_EXPIRY_HORIZON_DAYS);
 const tracked=new Map(input.tracked.map(item=>[item.subjectKey,item]));
 return withTenant(sponsor,async tx=>{
  const near=await followupItemsTx(tx,'passport_expiry',input.today);
  const far=await followupItemsTx(tx,'passport_expiry',addHrDays(input.today,FOLLOWUP_WINDOW_DAYS));
  const expiring=new Map<string,{companyId:string;expiresOn:string}>();
  for(const item of [...near,...far]){
   if(!scope.has(item.companyId)||item.waitingOn>horizon)continue;
   const seen=expiring.get(item.employmentId);
   if(!seen||item.waitingOn<seen.expiresOn)expiring.set(item.employmentId,{companyId:item.companyId,expiresOn:item.waitingOn});
  }
  // Positive verification of tracked cases: the expiry on record now, and whether the employment ended.
  const trackedIds=unique(input.tracked.flatMap(item=>item.employmentId?[item.employmentId]:[]));
  const records=trackedIds.length?await tx.select({id:employment.id,terminatedOn:employment.terminatedOn,expiresOn:employeeStatutoryMy.passportExpiryDate})
   .from(employment).leftJoin(employeeStatutoryMy,eq(employeeStatutoryMy.personId,employment.personId)).where(inArray(employment.id,trackedIds)):[];
  const recordOf=new Map(records.map(row=>[row.id,row]));
  const observations:LoopObservation[]=[];
  for(const [employmentId,item] of expiring){
   const key=passportKey(employmentId),known=tracked.get(key);
   observations.push({subjectKey:key,companyId:known?.companyId??item.companyId,employmentId,recipient:'employee',state:'open',facts:{expiresOn:item.expiresOn}});
  }
  for(const item of input.tracked){
   if(!item.employmentId||expiring.has(item.employmentId))continue;
   const record=recordOf.get(item.employmentId);
   if(!record)continue;
   const base={subjectKey:item.subjectKey,companyId:item.companyId,employmentId:item.employmentId,recipient:'employee' as const};
   if(record.terminatedOn!=null&&record.terminatedOn<=input.today){observations.push({...base,state:'closed',closeReason:'inactive',facts:item.facts});continue;}
   if(!record.expiresOn)continue;
   if(record.expiresOn>horizon)observations.push({...base,state:'closed',closeReason:'done',resolution:'completed',facts:{expiresOn:record.expiresOn}});
   else observations.push({...base,state:'open',facts:{expiresOn:record.expiresOn}});
  }
  return {observations,reads:[read('followup.passport_expiry','core/automatic-followups.ts#followupItemsTx'),
   ...(trackedIds.length?[read('statutory.passport_expiry_date','db/schema.ts#employeeStatutoryMy')]:[])]};
 });
}
