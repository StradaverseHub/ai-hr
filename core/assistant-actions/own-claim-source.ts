/** Human-reviewed canonical Claims DRAFT source. The module browser command and prepared-review custody bind this source; models cannot confirm it.
 * The parent custody owner must retain a locked durable action row, encrypted human review custody,
 * expiry/erasure, actual human POST/CSRF, atomic completion+native refs and security/interleaving proof.
 * NEW native draft creation is NOT idempotent: repeat confirm without completed custody can create
 * another draft. Completed replay MUST call reconciliation, never the create/update owner again.
 * No submit, approval, reimbursement, reservation, notification or provider call happens here. */
import type {SessionContext,Tx} from '../../db/client';
import {prepareOwnClaimDraftReviewTx,saveReviewedOwnClaimDraftTx,readOwnClaimDraftSavedReferenceTx,type DraftClaimInput} from '../../packs/claims/service';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {OwnClaimDraftHumanContent,OwnClaimDraftConfirmation,OwnClaimDraftPreparedSource,OwnClaimDraftSourceReceipt} from '../../lib/assistant-actions/own-claim-contract';
export class OwnClaimDraftSourceUnavailable extends Error{constructor(){super('The draft claim is unavailable.');this.name='OwnClaimDraftSourceUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const nativeInput=(human:OwnClaimDraftHumanContent):DraftClaimInput&{id?:string;expectedDraftRevision?:string}=>({employmentId:human.employmentId,claimTypeId:human.claimTypeId,claimItemId:human.claimItemId,amount:human.enteredAmount,quantityKm:human.quantityKm,incurredOn:human.incurredOn,description:human.description,fieldValues:human.fieldValues,...human.expectedDraftRevision?{expectedDraftRevision:human.expectedDraftRevision}:{},...human.draftId?{id:human.draftId}:{}});
async function actorTx(tx:Tx,ctx:SessionContext){const actor=await readOwnLeaveActorTx(tx,ctx);if(!actor)throw new OwnClaimDraftSourceUnavailable();await assertAiActionUnpausedTx(tx,actor,'hr_assistant');return actor;}
export async function prepareOwnClaimDraftSourceTx(tx:Tx,supplied:SessionContext,humanValue:unknown):Promise<OwnClaimDraftPreparedSource>{
 const ctx=capture(supplied);let human:OwnClaimDraftHumanContent;try{human=OwnClaimDraftHumanContent.parse(structuredClone(humanValue));}catch{throw new OwnClaimDraftSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),review=await prepareOwnClaimDraftReviewTx(tx,actor,nativeInput(human),human.retainedAttachmentIds);
  return OwnClaimDraftPreparedSource.parse({kind:'prepared_source',content:human,reviewedDigest:review.reviewedDigest,provisionalAmount:review.provisionalAmount,provisionalQuantityKm:review.provisionalQuantityKm,provisionalTaxable:review.provisionalTaxable,consequence:'draft_only_no_submission_or_reimbursement'});
 }catch{throw new OwnClaimDraftSourceUnavailable();}
}
/** Human content must be read from trusted shared custody, never the confirmation/model packet.
 * Any failure requires WHOLE enclosing Tx rollback; do not swallow it and complete an action row. */
export async function confirmOwnClaimDraftSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<OwnClaimDraftSourceReceipt>{
 const ctx=capture(supplied);let human:OwnClaimDraftHumanContent,confirmation:OwnClaimDraftConfirmation;try{human=OwnClaimDraftHumanContent.parse(structuredClone(storedHumanValue));confirmation=OwnClaimDraftConfirmation.parse(structuredClone(confirmationValue));}catch{throw new OwnClaimDraftSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),source=await saveReviewedOwnClaimDraftTx(tx,actor,nativeInput(human),human.retainedAttachmentIds,confirmation.reviewedDigest);
  return OwnClaimDraftSourceReceipt.parse({kind:'draft_saved',draftId:source.draftId,savedEventId:source.savedEventId,employmentId:source.employmentId,currentStatus:source.status,replayed:false});
 }catch{throw new OwnClaimDraftSourceUnavailable();}
}
/** Read exact original native refs only. A later native submission/decision is shown unchanged,
 * not performed or retried by this replay. Deleted drafts refuse rather than being recreated. */
export async function reconcileOwnClaimDraftSourceTx(tx:Tx,supplied:SessionContext,referenceValue:unknown):Promise<OwnClaimDraftSourceReceipt>{
 const ctx=capture(supplied);let reference:OwnClaimDraftSourceReceipt;try{reference=OwnClaimDraftSourceReceipt.parse(structuredClone(referenceValue));}catch{throw new OwnClaimDraftSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),source=await readOwnClaimDraftSavedReferenceTx(tx,actor,reference.draftId,reference.savedEventId);if(!source||source.employmentId!==reference.employmentId)throw new OwnClaimDraftSourceUnavailable();
  return OwnClaimDraftSourceReceipt.parse({kind:'draft_saved',draftId:source.draftId,savedEventId:source.savedEventId,employmentId:source.employmentId,currentStatus:source.status,replayed:true});
 }catch{throw new OwnClaimDraftSourceUnavailable();}
}
