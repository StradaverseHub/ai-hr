/** UNMOUNTED Claims submission specialist source. Explicit existing draft only, never a new claim,
 * upload, approval, reimbursement, payroll effect or model financial decision. Shared custody must
 * own human POST, locked review/completion and completed retries before browser/tool exposure. */
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {prepareOwnClaimSubmissionReviewTx,submitReviewedOwnClaimDraftTx,readOwnClaimSubmissionReferenceTx,claimLimitLockKey} from '../../packs/claims/service';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled} from '../entitlements';
import {OwnClaimSubmissionHumanContent as Human,OwnClaimSubmissionConfirmation as Confirmation,OwnClaimSubmissionPreparedSource as Prepared,OwnClaimSubmissionSourceReceipt as Receipt} from '../../lib/assistant-actions/own-claim-submission-contract';
export class OwnClaimSubmissionUnavailable extends Error{constructor(){super('That claim submission needs another look. Please reopen your draft.');this.name='OwnClaimSubmissionUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,ctx:SessionContext){const fresh=await readOwnLeaveActorTx(tx,ctx);if(!fresh)throw new OwnClaimSubmissionUnavailable();assertModuleEnabled(fresh,'claims');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
export async function prepareOwnClaimSubmissionSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const human=Human.parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await prepareOwnClaimSubmissionReviewTx(tx,fresh,human),{reviewedDigest,...review}=native;return Prepared.parse({kind:'prepared_source',content:human,review,reviewedDigest,consequence:'submitted_for_approval_not_approved_or_reimbursed'});}catch{throw new OwnClaimSubmissionUnavailable();}
}
/** Stored human content is trusted custody input, not posted model/confirmation content. Any error
 * requires rollback of the WHOLE enclosing command; never continue to complete a custody receipt. */
export async function confirmOwnClaimSubmissionSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const human=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await actor(tx,ctx),native=await submitReviewedOwnClaimDraftTx(tx,fresh,human,expected.reviewedDigest);return Receipt.parse({kind:'submitted',claimId:native.claimId,submittedEventId:native.submittedEventId,employmentId:native.employmentId,currentStatus:native.status,replayed:false});}catch{throw new OwnClaimSubmissionUnavailable();}
}
/** Canonical submitted event/current own row only. Does not repeat submit or infer approval/payment. */
export async function reconcileOwnClaimSubmissionSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({claimId:true,submittedEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await readOwnClaimSubmissionReferenceTx(tx,fresh,reference.claimId,reference.submittedEventId);if(!native)throw new OwnClaimSubmissionUnavailable();return Receipt.parse({kind:'submitted',claimId:native.claimId,submittedEventId:native.submittedEventId,employmentId:native.employmentId,currentStatus:native.status,replayed:true});}catch{throw new OwnClaimSubmissionUnavailable();}
}

/** Native limit-before-row ownership for shared custody. Only actual own draft/type IDs nominate
 * the interval; no fabricated receipts/status or repeated pricing engine. Ordinary native writers
 * already own this SAME key. Pending/completed callbacks must use their actual canonical source.
 * Any refusal/partial ownership requires whole enclosing top-level transaction rollback. */
export async function withOwnClaimSubmissionIntervalTx<T>(tx:Tx,supplied:SessionContext,draftId:string,work:(fresh:SessionContext,own:{draftId:string;employmentId:string;companyId:string})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),id=z.uuid().parse(draftId);try{
  const fresh=await actor(tx,ctx);
  const [nominee]=await tx.execute<{employmentId:string;claimTypeId:string;companyId:string}>(sql`select q.employment_id as "employmentId",q.claim_type_id as "claimTypeId",e.company_id as "companyId" from public.claim_request q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id where q.id=${id}::uuid and q.tenant_id=${fresh.tenantId}::uuid and e.person_id=${fresh.personId}::uuid`);
  if(!nominee)throw new OwnClaimSubmissionUnavailable();
  const [key]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${claimLimitLockKey(fresh.tenantId,nominee.employmentId,nominee.claimTypeId)},0)) as owned`);if(key?.owned!==true)throw new OwnClaimSubmissionUnavailable();
  const [row]=await tx.execute<{id:string;employmentId:string;claimTypeId:string;companyId:string}>(sql`select q.id,q.employment_id as "employmentId",q.claim_type_id as "claimTypeId",e.company_id as "companyId" from public.claim_request q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id where q.id=${id}::uuid and q.tenant_id=${fresh.tenantId}::uuid and e.person_id=${fresh.personId}::uuid for update of q nowait`);
  if(!row||row.employmentId!==nominee.employmentId||row.claimTypeId!==nominee.claimTypeId||row.companyId!==nominee.companyId)throw new OwnClaimSubmissionUnavailable();
  return await work(fresh,{draftId:row.id,employmentId:row.employmentId,companyId:row.companyId});
 }catch{throw new OwnClaimSubmissionUnavailable();}
}
