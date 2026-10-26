/** UNMOUNTED source adapter. Requires the unapplied reviewed native SQL owner draft. Shared human
 * custody/POST/CSRF/confirmation UI and actual security acceptance remain separate prerequisites.
 * No model execution, email delivery, provisioning, asset reassignment or reimbursement. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {normalizeMyAcknowledgement,submitReviewedMyAcknowledgementTx} from '../lifecycle-self';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled} from '../entitlements';
import {OwnLifecycleAcknowledgementHumanContent as Human,OwnLifecycleAcknowledgementConfirmation as Confirmation,OwnLifecycleAcknowledgementPreparedSource as Prepared,OwnLifecycleAcknowledgementSourceReceipt as Receipt} from '../../lib/assistant-actions/own-lifecycle-acknowledgement-contract';
export class OwnLifecycleAcknowledgementUnavailable extends Error{constructor(){super('Your equipment acknowledgement is unavailable.');this.name='OwnLifecycleAcknowledgementUnavailable';}}
const Source=z.object({caseId:z.uuid(),caseNumber:z.string().min(1).max(100),caseRevision:z.string().regex(/^\d+$/),distributionRevision:z.string().regex(/^\d+$/)}).strict();
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,ctx:SessionContext){const fresh=await readOwnLeaveActorTx(tx,ctx);if(!fresh)throw new OwnLifecycleAcknowledgementUnavailable();assertModuleEnabled(fresh,'lifecycle');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
async function prepare(tx:Tx,ctx:SessionContext,humanValue:unknown){
 const fresh=await actor(tx,ctx),human=Human.parse(humanValue),normalized=normalizeMyAcknowledgement(human);
 const [row]=await tx.execute<{source:unknown}>(sql`select app.lc_my_daa_review_source() as source`),source=Source.parse(row?.source);
 if(source.caseId!==human.caseId)throw new OwnLifecycleAcknowledgementUnavailable();
 const content=Human.parse({...human,...normalized}),reviewedDigest=createHash('sha256').update(JSON.stringify(['own-lifecycle-acknowledgement:v1',{tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId},source,content])).digest('hex');
 return{ctx:fresh,source,review:Prepared.parse({kind:'prepared_source',content,caseNumber:source.caseNumber,reviewedDigest,consequence:'equipment_acknowledgement_only'})};
}
export async function prepareOwnLifecycleAcknowledgementSourceTx(tx:Tx,supplied:SessionContext,humanValue:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const value=structuredClone(humanValue);return(await prepare(tx,ctx,value)).review;}catch{throw new OwnLifecycleAcknowledgementUnavailable();}
}
/** Same native case/step/history/event in the enclosing human-command Tx. Any failure requires whole
 * caller-Tx rollback. No second execution ledger; native one-submission rule is never auto-retried. */
export async function confirmOwnLifecycleAcknowledgementSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);
 try{const value=structuredClone(storedHumanValue),confirmation=structuredClone(confirmationValue),expected=Confirmation.parse(confirmation),prepared=await prepare(tx,ctx,value);if(expected.reviewedDigest!==prepared.review.reviewedDigest)throw new OwnLifecycleAcknowledgementUnavailable();
  const native=await submitReviewedMyAcknowledgementTx(tx,prepared.ctx,prepared.review.content,prepared.source);
  return{...await reconcileOwnLifecycleAcknowledgementSourceTx(tx,prepared.ctx,native),replayed:false};
 }catch{throw new OwnLifecycleAcknowledgementUnavailable();}
}
/** Current canonical own-case and ORIGINAL caller native event only. A cancelled/relinked/replaced
 * own case refuses; the adapter never recreates or resubmits from an old completed reference. */
export async function reconcileOwnLifecycleAcknowledgementSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);
 try{const reference=z.union([z.object({caseId:z.uuid(),submittedEventId:z.uuid()}).strict(),Receipt]).parse(structuredClone(value));await actor(tx,ctx);const [row]=await tx.execute<{reference:unknown}>(sql`select app.lc_my_daa_reference(${reference.caseId}::uuid,${reference.submittedEventId}::uuid) as reference`);return Receipt.parse({...(row?.reference as object),kind:'acknowledgement_submitted',replayed:true});}catch{throw new OwnLifecycleAcknowledgementUnavailable();}
}
