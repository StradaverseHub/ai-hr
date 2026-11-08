/** Missed-clock-out proposals are Prepare/review-only (owner, 9 November 2026).
 * Historical source/observation reads remain available. Legacy automatic apply and compensation entry
 * points refuse without writes; the normal attendance workflow owns any new human-reviewed correction. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {domainEvent} from '../../db/schema';
import {attendanceForEmploymentsRange} from '../../packs/attendance/service';
import {clockOf,unique} from './detect';
import type {LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason,LoopLimits,UndoneBy} from './autonomy-types';

export const CLOCK_OUT_ACT_VERSION='loop_missed_clock_outs.act@v1';

export class LoopActRefused extends Error{constructor(readonly reason:LoopActionReason){super('Loop action not applied: '+reason);this.name='LoopActRefused';}}
export class LoopUndoRefused extends Error{constructor(readonly reason:'changed'|'unavailable'|'human_review_required'){super('Loop undo refused: '+reason);this.name='LoopUndoRefused';}}

export type ClockOutCandidate=Readonly<{caseId:string;companyId:string;employmentId:string;date:string;checkIn:string;proposedCheckOut:string}>;
export type ClockOutEvaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopActionCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});
const isDate=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** A case's facts as a candidate, or null when the case lacks what the action needs. */
export function clockOutCandidate(row:Readonly<{id:string;companyId:string;employmentId:string|null;facts:Readonly<Record<string,unknown>>}>):ClockOutCandidate|null{
 const {date,checkIn,proposedCheckOut}=row.facts;
 return row.employmentId&&isDate(date)&&isClock(checkIn)&&isClock(proposedCheckOut)
  ?Object.freeze({caseId:row.id,companyId:row.companyId,employmentId:row.employmentId,date,checkIn,proposedCheckOut}):null;
}

/** Every condition for one candidate, read under the sponsor. Never writes. */
export async function evaluateClockOut(sponsor:SessionContext,item:ClockOutCandidate,limits:LoopLimits):Promise<ClockOutEvaluation>{
 return Object.freeze({ok:false,reason:'approval_routed' as const,checks:Object.freeze([check('human_approval_required',null,false)])});
}

export type ClockOutApplied=Readonly<{ownerRef:string;addedPunchId:string}>;
/** Compatibility refusal for the retired automatic apply entry. Never starts a write transaction. */
export async function applyClockOut(sponsor:SessionContext,p:Readonly<{item:ClockOutCandidate;actionId:string;undoUntil:Date;principalId:string;workerId:string;
 attribution:LoopAttribution;condition:LoopLimits['condition']}>):Promise<ClockOutApplied>{
 // Owner decision: prepared corrections must enter the employee's human approval workflow.
 throw new LoopActRefused('approval_routed');
}

/** For an action left half-way by an interrupted run: the owner's own record says whether the change committed. The
 * notice event is written in the same transaction as the correction, so its presence proves both. */
export async function appliedRecordOf(sponsor:SessionContext,actionId:string):Promise<Readonly<{ownerRef:string;addedPunchId:string;at:Date}>|null>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({payload:domainEvent.payload,at:domainEvent.occurredAt}).from(domainEvent)
   .where(and(eq(domainEvent.aggregateType,'teras-loop-action'),eq(domainEvent.aggregateId,actionId),eq(domainEvent.eventType,'teras-loop.action.applied'))).limit(1);
  const payload=row?.payload as Record<string,unknown>|null|undefined;
  return payload&&typeof payload.correctionId==='string'&&typeof payload.addedPunchId==='string'
   ?Object.freeze({ownerRef:payload.correctionId,addedPunchId:payload.addedPunchId,at:row!.at}):null;
 });
}

/** Whether each applied action's clock-out still stands as the loop set it, read under the sponsor. A day the read
 * cannot see is left unknown (absent from the result), never counted as a change. */
export async function observeClockOuts(sponsor:SessionContext,actions:readonly Readonly<{id:string;employmentId:string;facts:LoopActionFacts}>[]):Promise<Map<string,string|null>>{
 const out=new Map<string,string|null>();
 const items=actions.flatMap(action=>isDate(action.facts.date)&&isClock(action.facts.checkOut)?[{...action,date:action.facts.date as string,checkOut:action.facts.checkOut as string}]:[]);
 if(!items.length)return out;
 const dates=items.map(item=>item.date).sort(),ids=unique(items.map(item=>item.employmentId));
 for(let offset=0;offset<ids.length;offset+=100){
  const range=await attendanceForEmploymentsRange(sponsor,ids.slice(offset,offset+100),dates[0],dates[dates.length-1]);
  for(const item of items){
   const rows=range.get(item.employmentId);if(!rows)continue;
   const day=rows.find(row=>row.date===item.date);if(!day)continue;
   const recorded=clockOf(day.checkOutAt);
   if(recorded!==item.checkOut)out.set(item.id,recorded);
  }
 }
 return out;
}

/** Compatibility refusal: a historical action cannot authorise a new automatic compensation. */
export async function compensateClockOutTx(tx:Tx,authority:SessionContext,p:Readonly<{actionId:string;employmentId:string;facts:LoopActionFacts;by:UndoneBy}>):Promise<string>{
 // A legacy automatic action does not authorise a new automatic approval or compensation.
 throw new LoopUndoRefused('human_review_required');
}
