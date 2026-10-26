/** UNMOUNTED Claims submission specialist source. Explicit existing draft only, never a new claim,
 * upload, approval, reimbursement, payroll effect or model financial decision. Shared custody must
 * own human POST, locked review/completion and completed retries before browser/tool exposure. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {prepareOwnClaimSubmissionReviewTx,submitReviewedOwnClaimDraftTx,readOwnClaimSubmissionReferenceTx} from '../../packs/claims/service';
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
