/** UNMOUNTED source adapter, not a completed Assistant action. The future shared action command
 * must own one top-level authenticated Tx, encrypted review custody/expiry/erasure, human POST/CSRF,
 * exact completion receipt and uncertain-retry reconciliation. No route/model tool calls this file.
 * Model nomination is not human content; a posted digest alone is not confirmation authorization. */
import type {SessionContext,Tx} from '../../db/client';
import {prepareOwnProfileChangeRequestReviewTx,requestReviewedOwnProfileChangeTx,readOwnProfileChangeSubmissionReferenceTx} from '../profile';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {OwnProfileChangeHumanContent,OwnProfileChangeConfirmation,OwnProfileChangePreparedSource,OwnProfileChangeSourceReceipt} from '../../lib/assistant-actions/own-profile-change-contract';
export class OwnProfileChangeSourceUnavailable extends Error{constructor(){super('The profile request is unavailable.');this.name='OwnProfileChangeSourceUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
async function actorTx(tx:Tx,ctx:SessionContext){
 // Reuse the existing current-human Assistant identity/grant proof. Despite its first-action name,
 // it grants no leave/profile authority; the canonical ESS owner must prove own subject and fields.
 const actor=await readOwnLeaveActorTx(tx,ctx);if(!actor)throw new OwnProfileChangeSourceUnavailable();
 await assertAiActionUnpausedTx(tx,actor,'hr_assistant');return actor;
}
export async function prepareOwnProfileChangeSourceTx(tx:Tx,supplied:SessionContext,humanValue:unknown):Promise<OwnProfileChangePreparedSource>{
 const ctx=capture(supplied);let human:OwnProfileChangeHumanContent;
 try{human=OwnProfileChangeHumanContent.parse(structuredClone(humanValue));}catch{throw new OwnProfileChangeSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),review=await prepareOwnProfileChangeRequestReviewTx(tx,actor,{employmentId:human.employmentId,proposed:human.proposal});
  return OwnProfileChangePreparedSource.parse({kind:'prepared_source',content:{action:'profile.change.request',contractVersion:1,employmentId:review.employmentId,proposal:review.proposal},reviewedDigest:review.reviewedDigest,consequence:'request_hr_review'});
 }catch{throw new OwnProfileChangeSourceUnavailable();}
}
/** `storedHumanValue` MUST come from the future trusted custody owner, not this confirmation packet
 * or model output. Any refusal/storage error requires the whole enclosing Tx to roll back. Never
 * catch this bounded error inside a savepoint and continue an action completion. */
export async function confirmOwnProfileChangeSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<OwnProfileChangeSourceReceipt>{
 const ctx=capture(supplied);let human:OwnProfileChangeHumanContent,confirmation:OwnProfileChangeConfirmation;
 try{human=OwnProfileChangeHumanContent.parse(structuredClone(storedHumanValue));confirmation=OwnProfileChangeConfirmation.parse(structuredClone(confirmationValue));}catch{throw new OwnProfileChangeSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),source=await requestReviewedOwnProfileChangeTx(tx,actor,{employmentId:human.employmentId,proposed:human.proposal},confirmation.reviewedDigest);
  return OwnProfileChangeSourceReceipt.parse({kind:'submitted',requestId:source.requestId,requestedEventId:source.requestedEventId,employmentId:source.employmentId,currentStatus:source.status,replayed:source.replayed});
 }catch{throw new OwnProfileChangeSourceUnavailable();}
}
/** Metadata/event reconciliation only, even after the native request was approved/rejected. This
 * never invokes the canonical request owner, replays human content or creates an execution ledger. */
export async function reconcileOwnProfileChangeSourceTx(tx:Tx,supplied:SessionContext,referenceValue:unknown):Promise<OwnProfileChangeSourceReceipt>{
 const ctx=capture(supplied);let reference:OwnProfileChangeSourceReceipt;try{reference=OwnProfileChangeSourceReceipt.parse(structuredClone(referenceValue));}catch{throw new OwnProfileChangeSourceUnavailable();}
 try{const actor=await actorTx(tx,ctx),source=await readOwnProfileChangeSubmissionReferenceTx(tx,actor,reference.requestId,reference.requestedEventId);if(!source||source.employmentId!==reference.employmentId)throw new OwnProfileChangeSourceUnavailable();
  return OwnProfileChangeSourceReceipt.parse({kind:'submitted',requestId:source.requestId,requestedEventId:source.requestedEventId,employmentId:source.employmentId,currentStatus:source.status,replayed:true});
 }catch{throw new OwnProfileChangeSourceUnavailable();}
}
