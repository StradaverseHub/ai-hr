/** UNMOUNTED Rewards specialist. Trusted human command must own non-own/shared unit custody and
 * one top-level Tx. Models cannot calculate, approve or post, and never receive the private source. */
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {resolveEntitlementsTx,assertModuleEnabled} from '../entitlements';
import {prepareReviewedRewardPostTx,postReviewedRewardUnitTx,readReviewedRewardPostReferenceTx} from '../../packs/rewards/service';
import {ReviewedRewardsPostHumanContent as Human,ReviewedRewardsPostConfirmation as Confirmation,ReviewedRewardsPostPreparedSource as Prepared,ReviewedRewardsPostSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-rewards-post-contract';
export class ReviewedRewardsPostUnavailable extends Error{constructor(){super('That Rewards handoff needs another look. Please reopen the approved review.');this.name='ReviewedRewardsPostUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,ctx:SessionContext){await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlementsError:undefined,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'rewards');assertModuleEnabled(fresh,'payroll');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
const selection=(p:z.infer<typeof Human>)=>({unitId:p.unitId,revision:p.revision,batchId:p.batchId});
const receipt=(native:NonNullable<Awaited<ReturnType<typeof readReviewedRewardPostReferenceTx>>>,replayed:boolean)=>Receipt.parse({kind:'posted',...native,proof:'historical_post_current_unit',semantics:'salary_grade_and_draft_payroll_inputs_not_processed_or_paid',replayed});
export async function prepareReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await prepareReviewedRewardPostTx(tx,fresh,selection(content));return Prepared.parse({kind:'prepared_source',content,review:native.review,reviewedDigest:native.reviewedDigest,consequence:'whole_approved_unit_post_subject_to_native_checks'});}catch{throw new ReviewedRewardsPostUnavailable();}
}
/** Any failure requires whole Tx rollback: salary/grade/payroll inputs/funding/unit/event together. */
export async function confirmReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await actor(tx,ctx),native=await postReviewedRewardUnitTx(tx,fresh,selection(content),expected.reviewedDigest);return receipt(native,false);}catch{throw new ReviewedRewardsPostUnavailable();}
}
export async function reconcileReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({unitId:true,postedEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await actor(tx,ctx),native=await readReviewedRewardPostReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedRewardsPostUnavailable();return receipt(native,true);}catch{throw new ReviewedRewardsPostUnavailable();}
}
