/** Human-reviewed Rewards specialist. Trusted human command must own non-own/shared unit custody and
 * one top-level Tx. Models cannot calculate, approve or post, and never receive the private source. */
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {pgSqlState} from '../../lib/db-error';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {assertModuleEnabled} from '../entitlements';
import {lockReviewedRewardPostSourceTx,prepareReviewedRewardPostTx,postReviewedRewardUnitTx,readReviewedRewardPostReferenceTx} from '../../packs/rewards/service';
import {ReviewedRewardsPostHumanContent as Human,ReviewedRewardsPostConfirmation as Confirmation,ReviewedRewardsPostPreparedSource as Prepared,ReviewedRewardsPostSourceReceipt as Receipt} from '../../lib/assistant-actions/reviewed-rewards-post-contract';
export class ReviewedRewardsPostUnavailable extends Error{constructor(){super('That Rewards handoff needs another look. Please reopen the approved review.');this.name='ReviewedRewardsPostUnavailable';}}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertReviewedRewardsPostActorTx(tx:Tx,supplied:SessionContext){const fresh=await withAgentActionGuard(tx,capture(supplied),'rewards.post','approve');assertModuleEnabled(fresh,'rewards');assertModuleEnabled(fresh,'payroll');return fresh;}
const selection=(p:z.infer<typeof Human>)=>({unitId:p.unitId,revision:p.revision,batchId:p.batchId});
const receipt=(native:NonNullable<Awaited<ReturnType<typeof readReviewedRewardPostReferenceTx>>>,replayed:boolean)=>Receipt.parse({kind:'posted',...native,proof:'historical_post_current_unit',semantics:'salary_grade_and_draft_payroll_inputs_not_processed_or_paid',replayed});
export async function prepareReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Prepared>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(value)),fresh=await assertReviewedRewardsPostActorTx(tx,ctx),native=await prepareReviewedRewardPostTx(tx,fresh,selection(content));return Prepared.parse({kind:'prepared_source',content,review:native.review,reviewedDigest:native.reviewedDigest,consequence:'whole_approved_unit_post_subject_to_native_checks'});}catch{throw new ReviewedRewardsPostUnavailable();}
}
/** Any failure requires whole Tx rollback: salary/grade/payroll inputs/funding/unit/event together. */
export async function confirmReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,storedHumanValue:unknown,confirmationValue:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const content=Human.parse(structuredClone(storedHumanValue)),expected=Confirmation.parse(structuredClone(confirmationValue)),fresh=await assertReviewedRewardsPostActorTx(tx,ctx),native=await postReviewedRewardUnitTx(tx,fresh,selection(content),expected.reviewedDigest);return receipt(native,false);}catch{throw new ReviewedRewardsPostUnavailable();}
}
export async function reconcileReviewedRewardsPostSourceTx(tx:Tx,supplied:SessionContext,value:unknown):Promise<z.infer<typeof Receipt>>{
 const ctx=capture(supplied);try{const reference=z.union([Receipt.pick({unitId:true,postedEventId:true}).strict(),Receipt]).parse(structuredClone(value)),fresh=await assertReviewedRewardsPostActorTx(tx,ctx),native=await readReviewedRewardPostReferenceTx(tx,fresh,reference);if(!native)throw new ReviewedRewardsPostUnavailable();return receipt(native,true);}catch{throw new ReviewedRewardsPostUnavailable();}
}

/** Source-only per-lock bound; no ordinary API wait changes or hidden retries. Existing shorter
 * nonzero bounds are preserved. SQL/restoration failure requires rollback of the WHOLE caller Tx. */
async function bounded<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') as saved,setting::integer as milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)throw new ReviewedRewardsPostUnavailable();
 const limit=prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000);await tx.execute(sql`select set_config('lock_timeout',${String(limit)+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{/* Aborted Tx must roll back; never continue. */}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}
/** Real authority/funding-parent/unit ownership, valid before pending or completed custody. The
 * pending command must ALSO run actual full native preflight before custody row NOWAIT. */
export async function withReviewedRewardsPostIntervalTx<T>(tx:Tx,supplied:SessionContext,unitId:string,work:(fresh:SessionContext,binding:{unitId:string;companyId:string})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),id=z.guid().parse(unitId);return bounded(tx,async()=>{const fresh=await assertReviewedRewardsPostActorTx(tx,ctx),owned=await lockReviewedRewardPostSourceTx(tx,fresh,id);return work(fresh,{unitId:owned.unit.id,companyId:owned.unit.companyId});});
}
