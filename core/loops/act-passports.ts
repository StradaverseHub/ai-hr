/** The passports loop's automatic step, at Level 2 (Act within limits) only: a REQUEST-ONLY step (owner decision,
 * 11 November 2026; Level 2 at most, coordinator, 13 November 2026).
 *
 * At Prepare the loop puts a card on HR's Today and a reminder card on the employee's. At Level 2 it sends the employee
 * the renewal request itself: one in-app notice saying when the passport on record expires and asking them to renew it
 * and send the new details to HR from their profile. It changes no record: the employee sends the new passport details
 * as a change request and HR approves it as usual (ADR-0159).
 *  - Conditions, read under the sponsor's current authority: the employment is still active, and the passport on record
 *    still expires on the date the case found (a renewal recorded since then means there is nothing to ask).
 *  - Apply: the notice event ('teras-loop.request.sent', the same event the missing employee data loop sends, so the
 *    AI Centre stop holds its delivery, migration 3200) in a transaction carrying the loop's attribution
 *    (core/loops/attribution.ts): the event records the loop, its agent principal and the sponsor who answers for it,
 *    on behalf of the company.
 *  - Once per passport period: the action ledger holds at most one action per case (migration 2004), and the case is
 *    the employment's passport; the same case never sends a second request.
 *  - Compensate (undo): the person who asked (HR, or the employee) withdraws the request, recorded as that person; the
 *    employee is told they can ignore it ('teras-loop.request.withdrawn'). Nothing is deleted.
 * No model is called. */
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appendEvent} from '../../db/events';
import {employeeStatutoryMy,employment} from '../../db/schema';
import {setLoopAttributionTx} from './attribution';
import {requireLoopMayStillActTx} from './act-gate';
import type {LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import {LoopActRefused} from './act-clock-outs';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason,UndoneBy} from './autonomy-types';

export const PASSPORT_ACT_VERSION='loop_document_expiry.act@v1';
/** The request kind both notice events carry, so the notice reads as a passport renewal (core/notification-registry.ts). */
export const PASSPORT_RENEWAL_REQUEST='passport_renewal' as const;
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopActionCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});

export type PassportCandidate=Readonly<{caseId:string;companyId:string;employmentId:string;expiresOn:string}>;
export type PassportEvaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;

/** An open passport case as a candidate: the employment and the expiry date the loop found. */
export function passportCandidate(row:Readonly<{id:string;companyId:string;employmentId:string|null;facts:Readonly<Record<string,unknown>>}>):PassportCandidate|null{
 return row.employmentId&&isDate(row.facts.expiresOn)?Object.freeze({caseId:row.id,companyId:row.companyId,employmentId:row.employmentId,expiresOn:row.facts.expiresOn}):null;
}

export async function evaluatePassport(sponsor:SessionContext,item:PassportCandidate):Promise<PassportEvaluation>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({terminatedOn:employment.terminatedOn,expiresOn:employeeStatutoryMy.passportExpiryDate}).from(employment)
   .leftJoin(employeeStatutoryMy,eq(employeeStatutoryMy.personId,employment.personId)).where(eq(employment.id,item.employmentId)).limit(1);
  const active=!!row&&row.terminatedOn==null;
  const same=!!row&&row.expiresOn===item.expiresOn;
  const checks=[check('employment_active','db/schema.ts#employment',active),check('passport_expiry_unchanged','db/schema.ts#employeeStatutoryMy',same)];
  const reason:LoopActionReason|null=!active?'condition_inactive':!same?'condition_record_changed':null;
  return Object.freeze({ok:reason===null,reason,checks:Object.freeze(checks)});
 });
}

/** Dates and keys only, like a case's facts: the expiry date the request is about. */
export const passportFacts=(item:PassportCandidate):LoopActionFacts=>Object.freeze({date:item.expiresOn,request:PASSPORT_RENEWAL_REQUEST});

/** Send the renewal request: the employee's notice, attributed to the loop. The notice event is the owner's record of it. */
export async function applyPassport(sponsor:SessionContext,p:Readonly<{item:PassportCandidate;actionId:string;undoUntil:Date;workerId:string;attribution:LoopAttribution}>):Promise<Readonly<{ownerRef:string}>>{
 try{
  return await withTenant(sponsor,async tx=>{
   await setLoopAttributionTx(tx,p.attribution);
   // A switch-off, stop, pause or demotion since the attempt was recorded is honoured here, and again before commit.
   const gate={tenantId:sponsor.tenantId,workerId:p.workerId,companyId:p.item.companyId};
   await requireLoopMayStillActTx(tx,gate);
   const id=await appendEvent(tx,{tenantId:sponsor.tenantId,aggregateType:'teras-loop-action',aggregateId:p.actionId,eventType:'teras-loop.request.sent',
    actor:{type:'agent',id:p.attribution.principalId},subjectEmploymentId:p.item.employmentId,
    payload:{workerId:p.workerId,request:PASSPORT_RENEWAL_REQUEST,expiresOn:p.item.expiresOn,undoUntil:p.undoUntil.toISOString()}},{returnId:true});
   await requireLoopMayStillActTx(tx,gate);
   return Object.freeze({ownerRef:id});
  });
 }catch(error){throw error instanceof LoopActRefused?error:new LoopActRefused('owner_refused');}
}

/** Withdraw a sent renewal request, in the caller's transaction: the employee is told. Recorded as the person who asked
 * for the undo (HR, or the employee), never as the loop's agent. */
export async function withdrawPassportRequestTx(tx:Tx,authority:SessionContext,p:Readonly<{actionId:string;employmentId:string;by:UndoneBy;askedByUserId:string}>):Promise<string>{
 return appendEvent(tx,{tenantId:authority.tenantId,aggregateType:'teras-loop-action',aggregateId:p.actionId,eventType:'teras-loop.request.withdrawn',
  actor:{type:'user',id:p.askedByUserId},subjectEmploymentId:p.employmentId,payload:{by:p.by,request:PASSPORT_RENEWAL_REQUEST}},{returnId:true});
}
