import {pgSqlState} from '../../lib/db-error';
/** Whole-unit human cancellation; native Rewards retains the command and all authority. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {readRewardsPresentationChoices} from './rewards-presentation';
import {cancelRewardReviewTx} from '../../packs/rewards/service';
import {REWARDS_CANCEL_ACTION as action,RewardsCancelHuman,RewardsCancelReview,RewardsCancelReceipt,RewardsCancelChoices} from '../../lib/assistant-actions/rewards-cancel-contract';
export const rewardsCancelUnavailable=():never=>{throw new Error('Please reopen this review on the native Rewards screen.');};
export const assertRewardsCancelActorTx=(tx:Tx,ctx:SessionContext)=>withAgentActionGuard(tx,ctx,action,'approve');
const Scope=z.object({unitId:z.guid(),companyId:z.guid(),companyName:z.string().min(1).max(1000),name:z.string(),revision:z.number().int(),status:z.string(),fingerprint:z.string()}).strict();
export async function withRewardsCancelIntervalTx<T>(tx:Tx,ctx:SessionContext,unitId:string,work:(fresh:SessionContext,source:z.infer<typeof Scope>)=>Promise<T>){
 const fresh=await assertRewardsCancelActorTx(tx,ctx);
 // Same access lock as native role maintenance. Lock unit then funding parent, matching cancellation.
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access-configuration:'||${fresh.tenantId}::text,0))`);
 const [row]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_cancel_scope(${z.guid().parse(unitId)}::uuid,true) as scope`);
 return work(fresh,Scope.parse(row?.scope));
}
export async function prepareRewardsCancelSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=RewardsCancelHuman.parse(value),[row]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_cancel_scope(${content.unitId}::uuid,true) as scope`),s=Scope.parse(row?.scope);
 if(s.revision!==content.revision)return rewardsCancelUnavailable();
 const review=RewardsCancelReview.parse({unitId:s.unitId,companyId:s.companyId,companyName:s.companyName,name:s.name,revision:s.revision,before:s.status,after:'withdrawn',reason:content.reason,consequence:'whole_review_cancelled_entries_and_decisions_retained_reservation_released'});
 return{content,review,reviewedDigest:createHash('sha256').update(JSON.stringify([1,action,s,content])).digest('hex')};
}
export async function confirmRewardsCancelSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string){
 const current=await prepareRewardsCancelSourceTx(tx,ctx,value);if(current.reviewedDigest!==expected)return rewardsCancelUnavailable();
 const result=await cancelRewardReviewTx(tx,ctx,current.content.unitId,current.content.revision,current.content.reason);
 return{...result,postedEventId:result.eventId,postedRevision:result.cancelledRevision,postedBatchId:null};
}
export async function reconcileRewardsCancelSourceTx(tx:Tx,ctx:SessionContext,reference:{unitId:string;eventId:string}){
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_cancel_receipt(${reference.unitId}::uuid,${reference.eventId}::uuid) as receipt`);return RewardsCancelReceipt.parse(row?.receipt);
}
/** Same per-lock bound as the existing Rewards post adapter, preserving shorter caller limits. */
export async function withRewardsCancelBoundsTx<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') as saved,setting::integer as milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return rewardsCancelUnavailable();
 const limit=prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000);await tx.execute(sql`select set_config('lock_timeout',${String(limit)+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}

export const readRewardsCancelChoices=(ctx:SessionContext)=>readRewardsPresentationChoices(ctx,action,
 sql`select app.assistant_rewards_cancel_presentation_choices_v1() as choices`,RewardsCancelChoices,rewardsCancelUnavailable);
