/** UNMOUNTED OneHR specialist action; separate from standard review acknowledgement. Shared custody
 * owns human POST, top-level receipt commit and completed retries. No ratings or promotion decisions. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {domainEvent,onehrPlan} from '../../db/schema';
import {OwnOnehrPlanAcknowledgementIntent,OwnOnehrPlanAcknowledgementReview,OwnOnehrPlanAcknowledgementReceipt,OwnOnehrPlanAcknowledgementEventMetadata} from '../../lib/assistant-actions/own-onehr-plan-acknowledgement-contract';
import {readOwnOnehrPlanAcknowledgementSourceTx,acknowledgeOnehrPlanTx} from '../../packs/performance/service';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled,resolveEntitlementsTx} from '../entitlements';
const fail=():never=>{throw Error('Plan acknowledgement could not be confirmed.');};
async function guard(tx:Tx,supplied:SessionContext){
 const current={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};await assertAiPrincipalTx(tx,current);
 const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'performance');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;
}
function digest(ctx:SessionContext,intent:OwnOnehrPlanAcknowledgementIntent,current:Awaited<ReturnType<typeof readOwnOnehrPlanAcknowledgementSourceTx>>){return createHash('sha256').update(JSON.stringify({version:1,engine:'onehr_plan',tenantId:ctx.tenantId,userId:ctx.userId,personId:ctx.personId,intent,current})).digest('hex');}
function ready(current:Awaited<ReturnType<typeof readOwnOnehrPlanAcknowledgementSourceTx>>){if(current.status!=='closed'||current.acknowledgedAt!==null)return fail();}
export async function prepareOwnOnehrPlanAcknowledgementTx(tx:Tx,ctx:SessionContext,input:unknown){
 const intent=OwnOnehrPlanAcknowledgementIntent.parse(input),fresh=await guard(tx,ctx),current=await readOwnOnehrPlanAcknowledgementSourceTx(tx,fresh,intent.planId);ready(current);
 return OwnOnehrPlanAcknowledgementReview.parse({version:1,action:'performance.onehr.plan.acknowledge',engine:'onehr_plan',planId:current.planId,reviewId:current.reviewId,employmentId:current.employmentId,
  planYear:current.planYear,conversationHeldOn:current.conversationHeldOn,meaning:'acknowledge_career_conversation_not_rating_or_promotion',reviewDigest:digest(fresh,intent,current)});
}
/** No source effects outside the caller's whole transaction. Private versions can refuse only;
 * canonical current self/closed/revision checks always own the acknowledgement. */
export async function confirmOwnOnehrPlanAcknowledgementTx(tx:Tx,ctx:SessionContext,input:unknown,expectedDigest:string){
 const intent=OwnOnehrPlanAcknowledgementIntent.parse(input),fresh=await guard(tx,ctx),current=await readOwnOnehrPlanAcknowledgementSourceTx(tx,fresh,intent.planId);ready(current);
 if(typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest)||digest(fresh,intent,current)!==expectedDigest)return fail();
 const effect=await acknowledgeOnehrPlanTx(tx,fresh,intent.planId,current.planRevision,{employmentId:current.employmentId,planVersion:current.planVersion});
 if(!effect.eventId)return fail();return reopenOwnOnehrPlanAcknowledgementEventTx(tx,fresh,{employmentId:effect.employmentId,eventId:effect.eventId});
}
/** Read-only reconciliation of the reviewed-only native event. Legacy UI events have an empty
 * payload/null subject and are deliberately not accepted as an Assistant completion receipt.
 * The native update and reviewed event metadata use the SAME captured Date, never SQL-clock equality. */
export async function reopenOwnOnehrPlanAcknowledgementEventTx(tx:Tx,ctx:SessionContext,value:unknown){
 const reference=OwnOnehrPlanAcknowledgementReceipt.pick({employmentId:true,eventId:true}).strict().parse(value),fresh=await guard(tx,ctx);
 const [event]=await tx.select({planId:domainEvent.aggregateId,payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.id,reference.eventId),eq(domainEvent.tenantId,fresh.tenantId),eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,fresh.userId!),
  eq(domainEvent.aggregateType,'onehr'),eq(domainEvent.eventType,'onehr.plan-acknowledged'),eq(domainEvent.subjectEmploymentId,reference.employmentId)));
 if(!event)return fail();const metadata=OwnOnehrPlanAcknowledgementEventMetadata.parse(event.payload),current=await readOwnOnehrPlanAcknowledgementSourceTx(tx,fresh,event.planId);
 if(current.employmentId!==reference.employmentId||current.status!=='closed'||current.planRevision!==metadata.planRevision||!current.acknowledgedAt)return fail();
 const [binding]=await tx.select({matches:sql<boolean>`${onehrPlan.acknowledgedAt}=${metadata.acknowledgedAt}::timestamptz`}).from(onehrPlan).where(and(eq(onehrPlan.id,current.planId),eq(onehrPlan.tenantId,fresh.tenantId)));
 if(binding?.matches!==true)return fail();
 return OwnOnehrPlanAcknowledgementReceipt.parse({version:1,action:'performance.onehr.plan.acknowledge',engine:'onehr_plan',proof:'recorded_plan_acknowledgement_current_revision',planId:current.planId,reviewId:current.reviewId,
  employmentId:current.employmentId,eventId:reference.eventId,planYear:current.planYear,planRevision:current.planRevision,acknowledgedAt:current.acknowledgedAt.toISOString(),meaning:'acknowledged_career_conversation_not_rating_or_promotion'});
}
