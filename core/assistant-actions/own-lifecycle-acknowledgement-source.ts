/** Human-reviewed source adapter. Uses the journalled native acknowledgement SQL owner (0629). Shared human
 * custody/POST/CSRF/confirmation UI and actual security acceptance remain separate prerequisites.
 * No model execution, email delivery, provisioning, asset reassignment or reimbursement. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {normalizeMyAcknowledgement,submitReviewedMyAcknowledgementTx} from '../../packs/lifecycle/service';
import {withAgentActionGuard} from './agent-action-guard';
import {OwnLifecycleAcknowledgementHumanContent as Human,OwnLifecycleAcknowledgementConfirmation as Confirmation,OwnLifecycleAcknowledgementPreparedSource as Prepared,OwnLifecycleAcknowledgementSourceReceipt as Receipt} from '../../lib/assistant-actions/own-lifecycle-acknowledgement-contract';
export class OwnLifecycleAcknowledgementUnavailable extends Error{constructor(){super('Your equipment acknowledgement is unavailable.');this.name='OwnLifecycleAcknowledgementUnavailable';}}
const Source=z.object({caseId:z.guid(),caseNumber:z.string().min(1).max(100),caseRevision:z.string().regex(/^\d+$/),distributionRevision:z.string().regex(/^\d+$/)}).strict();
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertOwnLifecycleAcknowledgementActorTx(tx:Tx,supplied:SessionContext){return withAgentActionGuard(tx,capture(supplied),'lifecycle.acknowledgement.submit');}
async function prepare(tx:Tx,ctx:SessionContext,humanValue:unknown){
 const fresh=await assertOwnLifecycleAcknowledgementActorTx(tx,ctx),human=Human.parse(humanValue),normalized=normalizeMyAcknowledgement(human);
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
 try{const reference=z.union([z.object({caseId:z.guid(),submittedEventId:z.guid()}).strict(),Receipt]).parse(structuredClone(value));await assertOwnLifecycleAcknowledgementActorTx(tx,ctx);const [row]=await tx.execute<{reference:unknown}>(sql`select app.lc_my_daa_reference(${reference.caseId}::uuid,${reference.submittedEventId}::uuid) as reference`);return Receipt.parse({...(row?.reference as object),kind:'acknowledgement_submitted',replayed:true});}catch{throw new OwnLifecycleAcknowledgementUnavailable();}
}

/** Native own-case interval before shared custody. This is NOT the pending-only review reader:
 * already submitted cases can reconcile, but cancelled/replaced/relinked sources cannot retarget. */
export async function withOwnLifecycleAcknowledgementIntervalTx<T>(tx:Tx,supplied:SessionContext,caseId:string,work:(fresh:SessionContext,source:{caseId:string;caseNumber:string;casePersonId:string|null;employmentId:string|null;companyId:string|null})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),id=z.guid().parse(caseId);try{const fresh=await assertOwnLifecycleAcknowledgementActorTx(tx,ctx),[row]=await tx.execute<{source:unknown}>(sql`select app.lc_my_daa_custody_source(${id}::uuid) as source`),source=z.object({caseId:z.guid(),caseNumber:z.string().min(1).max(100),casePersonId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid().nullable()}).strict().parse(row?.source);if(source.caseId!==id)throw new OwnLifecycleAcknowledgementUnavailable();return await work(fresh,source);}catch{throw new OwnLifecycleAcknowledgementUnavailable();}
}
