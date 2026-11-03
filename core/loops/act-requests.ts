/** AI v2 Phase 2 P2-1 — the missing employee data loop's automatic step, at Level 2 (Act within limits) and above.
 *
 * At Prepare the loop puts a request card on the employee's Today and waits for them to open it. Above Prepare it sends
 * the request to the employee itself: one in-app notice listing what they can fill in, linking to their own profile
 * request section. It changes no record: the employee still fills in their details and HR approves them as usual.
 *  - Conditions, read under the sponsor's current authority: the employment is still active, and the case still lists
 *    details the employee may fill in themselves.
 *  - Apply: the notice event (core/notifications.ts 'teras-loop.request.sent') in a transaction carrying the loop's
 *    attribution (core/loops/attribution.ts), so it records the loop, its agent principal and its sponsor.
 *  - Compensate (undo): HR withdraws the request; the employee is told they can ignore it
 *    ('teras-loop.request.withdrawn'). Nothing is deleted.
 * No model is called. */
import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {appendEvent} from '../../db/events';
import {domainEvent,employment} from '../../db/schema';
import {setLoopAttributionTx} from './attribution';
import type {LoopAttribution} from '../../lib/ai-centre/loop-attribution';
import {LoopActRefused,LoopUndoRefused} from './act-clock-outs';
import type {LoopActionCheck,LoopActionFacts,LoopActionReason,UndoneBy} from './autonomy-types';

export const REQUEST_ACT_VERSION='loop_missing_employee_data.act@v1';
const TABS=new Set(['profile','bankStatutory','payroll']);
const check=(name:string,ruleVersion:string|null,ok:boolean):LoopActionCheck=>Object.freeze({check:name,ruleVersion,result:ok?'pass':'fail'});

export type RequestCandidate=Readonly<{caseId:string;companyId:string;employmentId:string;gaps:readonly string[];tab:string}>;
export type RequestEvaluation=Readonly<{ok:boolean;reason:LoopActionReason|null;checks:readonly LoopActionCheck[]}>;

/** A record case as a candidate: the details the employee may fill in and their own request section. */
export function requestCandidate(row:Readonly<{id:string;companyId:string;employmentId:string|null;facts:Readonly<Record<string,unknown>>}>):RequestCandidate|null{
 const gaps=Array.isArray(row.facts.gaps)?(row.facts.gaps as unknown[]).filter((gap):gap is string=>typeof gap==='string'&&/^[a-z_]{1,40}$/.test(gap)):[];
 const tab=Array.isArray(row.facts.tabs)?(row.facts.tabs as unknown[]).find((value):value is string=>typeof value==='string'&&TABS.has(value)):undefined;
 return row.employmentId&&gaps.length&&tab?Object.freeze({caseId:row.id,companyId:row.companyId,employmentId:row.employmentId,gaps:Object.freeze(gaps),tab}):null;
}

export async function evaluateRequest(sponsor:SessionContext,item:RequestCandidate):Promise<RequestEvaluation>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({terminatedOn:employment.terminatedOn}).from(employment).where(eq(employment.id,item.employmentId)).limit(1);
  const active=!!row&&row.terminatedOn==null;
  const checks=[check('gaps_the_employee_can_fill','core/readiness-actions.ts#loadReadinessActions',true),check('employment_active','db/schema.ts#employment',active)];
  return Object.freeze({ok:active,reason:active?null:'condition_inactive' as const,checks:Object.freeze(checks)});
 });
}

export const requestFacts=(item:RequestCandidate):LoopActionFacts=>Object.freeze({gaps:item.gaps.length,tab:item.tab});

/** Send the request: the employee's notice, attributed to the loop. The notice event is the owner's record of it. */
export async function applyRequest(sponsor:SessionContext,p:Readonly<{item:RequestCandidate;actionId:string;undoUntil:Date;workerId:string;attribution:LoopAttribution}>):Promise<Readonly<{ownerRef:string}>>{
 try{
  return await withTenant(sponsor,async tx=>{
   await setLoopAttributionTx(tx,p.attribution);
   const id=await appendEvent(tx,{tenantId:sponsor.tenantId,aggregateType:'teras-loop-action',aggregateId:p.actionId,eventType:'teras-loop.request.sent',
    actor:{type:'agent',id:p.attribution.principalId},subjectEmploymentId:p.item.employmentId,
    payload:{workerId:p.workerId,gaps:p.item.gaps.length,tab:p.item.tab,undoUntil:p.undoUntil.toISOString()}},{returnId:true});
   return Object.freeze({ownerRef:id});
  });
 }catch{throw new LoopActRefused('owner_refused');}
}

/** For an attempt left half-way: the notice event itself says whether the request was sent. */
export async function sentRecordOf(sponsor:SessionContext,actionId:string):Promise<Readonly<{ownerRef:string;at:Date}>|null>{
 return withTenant(sponsor,async tx=>{
  const [row]=await tx.select({id:domainEvent.id,at:domainEvent.occurredAt}).from(domainEvent)
   .where(and(eq(domainEvent.aggregateType,'teras-loop-action'),eq(domainEvent.aggregateId,actionId),eq(domainEvent.eventType,'teras-loop.request.sent'))).limit(1);
  return row?Object.freeze({ownerRef:row.id,at:row.at}):null;
 });
}

/** Withdraw a sent request, in the caller's transaction (which carries the loop's attribution): the employee is told. */
export async function withdrawRequestTx(tx:Tx,authority:SessionContext,p:Readonly<{actionId:string;employmentId:string;facts:LoopActionFacts;by:UndoneBy;principalId:string}>):Promise<string>{
 if(typeof p.facts.tab!=='string')throw new LoopUndoRefused('unavailable');
 return appendEvent(tx,{tenantId:authority.tenantId,aggregateType:'teras-loop-action',aggregateId:p.actionId,eventType:'teras-loop.request.withdrawn',
  actor:{type:'agent',id:p.principalId},subjectEmploymentId:p.employmentId,payload:{by:p.by}},{returnId:true});
}
