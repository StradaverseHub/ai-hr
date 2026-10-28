/** Human-reviewed standard-cycle action source. Shared custody owns human POST, top-level completion and
 * completed retries. OneHR development-plan acknowledgement is a separate pending engine adapter. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {domainEvent,performanceReview} from '../../db/schema';
import {OwnReviewAcknowledgementIntent,OwnReviewAcknowledgementReview,OwnReviewAcknowledgementReceipt} from '../../lib/assistant-actions/own-review-acknowledgement-contract';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled,resolveEntitlementsTx} from '../entitlements';
import {acknowledgeReviewTx,readOwnReviewAcknowledgementSourceTx} from '../../packs/performance/service';
export class OwnReviewAcknowledgementRefusal extends Error {
 constructor(public readonly code:'unsupported_engine'|'unavailable'='unavailable'){super('Review acknowledgement could not be confirmed.');}
}
const fail=():never=>{throw new OwnReviewAcknowledgementRefusal();};
async function guard(tx:Tx,supplied:SessionContext){
 const current={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};await assertAiPrincipalTx(tx,current);
 const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'performance');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;
}
async function source(tx:Tx,ctx:SessionContext,reviewId:string){
 try{return await readOwnReviewAcknowledgementSourceTx(tx,ctx,reviewId);}catch(error){
  if(error instanceof Error&&error.message==='Use the performance and talent review for this cycle.')throw new OwnReviewAcknowledgementRefusal('unsupported_engine');
  throw error; // Storage/busy failures require the enclosing whole transaction to roll back.
 }
}
function digest(ctx:SessionContext,intent:OwnReviewAcknowledgementIntent,current:Awaited<ReturnType<typeof source>>){return createHash('sha256').update(JSON.stringify({version:1,engine:'standard_cycle_only',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,intent,current})).digest('hex');}
function ready(current:Awaited<ReturnType<typeof source>>){if(!current.releasedAt||current.status!=='submitted')return fail();}
export async function prepareOwnReviewAcknowledgementTx(tx:Tx,ctx:SessionContext,input:unknown){
 const intent=OwnReviewAcknowledgementIntent.parse(input),fresh=await guard(tx,ctx),current=await source(tx,fresh,intent.reviewId);ready(current);
 return OwnReviewAcknowledgementReview.parse({version:1,action:'performance.review.acknowledge',engine:'standard_cycle_only',reviewId:current.reviewId,employmentId:current.employmentId,cycleId:current.cycleId,
  cycleName:current.cycleName,periodStart:current.periodStart,periodEnd:current.periodEnd,meaning:'acknowledgement_not_rating_endorsement',reviewDigest:digest(fresh,intent,current)});
}
/** Confirmation-only native effect. Source versions are refusal-only and never model-posted facts.
 * Caller must roll back the entire transaction on any refusal, including completion-store failure. */
export async function confirmOwnReviewAcknowledgementTx(tx:Tx,ctx:SessionContext,input:unknown,expectedDigest:string){
 const intent=OwnReviewAcknowledgementIntent.parse(input),fresh=await guard(tx,ctx),current=await source(tx,fresh,intent.reviewId);ready(current);
 if(typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest)||digest(fresh,intent,current)!==expectedDigest)return fail();
 const effect=await acknowledgeReviewTx(tx,fresh,{reviewId:intent.reviewId},current);
 return reopenOwnReviewAcknowledgementEventTx(tx,fresh,{employmentId:effect.employmentId,eventId:effect.eventId});
}
/** Only native references survive terminal custody. No model text, source digest, rating or private
 * review content is retained. This read never acknowledges again; exact native event timestamp must
 * still identify the current record's acknowledgement, under the current own-subject release gate. */
export async function reopenOwnReviewAcknowledgementEventTx(tx:Tx,ctx:SessionContext,value:unknown){
 const reference=OwnReviewAcknowledgementReceipt.pick({employmentId:true,eventId:true}).strict().parse(value),fresh=await guard(tx,ctx);
 const [event]=await tx.select({reviewId:domainEvent.aggregateId,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.id,reference.eventId),eq(domainEvent.tenantId,fresh.tenantId),
  eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,fresh.userId!),eq(domainEvent.aggregateType,'performance-review'),eq(domainEvent.eventType,'performance-review.acknowledged'),eq(domainEvent.subjectEmploymentId,reference.employmentId)));
 if(!event||event.payload!==null)return fail();
 const current=await source(tx,fresh,event.reviewId);if(current.employmentId!==reference.employmentId||!current.releasedAt||current.status!=='acknowledged'||!current.acknowledgedAt)return fail();
 const [binding]=await tx.select({matches:sql<boolean>`${performanceReview.acknowledgedAt}=${domainEvent.occurredAt}`}).from(performanceReview).innerJoin(domainEvent,and(eq(domainEvent.aggregateId,performanceReview.id),eq(domainEvent.tenantId,performanceReview.tenantId)))
  .where(and(eq(performanceReview.id,current.reviewId),eq(performanceReview.tenantId,fresh.tenantId),eq(domainEvent.id,reference.eventId)));
 if(binding?.matches!==true)return fail();
 return OwnReviewAcknowledgementReceipt.parse({version:1,action:'performance.review.acknowledge',engine:'standard_cycle_only',proof:'recorded_acknowledgement_current_record',reviewId:current.reviewId,employmentId:current.employmentId,
  cycleId:current.cycleId,eventId:reference.eventId,acknowledgedAt:current.acknowledgedAt.toISOString(),meaning:'acknowledged_not_rating_endorsement'});
}
