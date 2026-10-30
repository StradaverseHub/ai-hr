/** Annual-only source/proof owner. Exact V4 proof owner was independently reviewed before mounting. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type Tx,type SessionContext} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import {agentActionById} from '../../lib/ai/agent-action-registry';
import {withAgentActionGuard} from './agent-action-guard';
import {reviewAnnualRewardReturnTx,returnAnnualRewardReviewTx} from '../../packs/rewards/service';
import {REWARDS_RETURN_ACTION as action,RewardsReturnHuman,RewardsReturnReview,RewardsReturnReceipt,RewardsReturnChoices} from '../../lib/assistant-actions/rewards-return-contract';
export const rewardsReturnUnavailable=():never=>{throw Error('Please reopen this annual review on the native Rewards screen.');};
const hash=z.string().regex(/^[a-f0-9]{64}$/),xmin=z.string().regex(/^\d+$/),ctid=z.string().regex(/^\(\d+,\d+\)$/);
export const RewardsReturnSnapshot=z.object({unitStableHash:hash,unitFullHash:hash,unitXmin:xmin,unitCtid:ctid,revision:z.number().int().nonnegative(),fromStage:z.string().max(40),entriesHash:hash,historyHash:hash,eventsHash:hash,peopleHash:hash,employmentIds:z.array(z.guid()),personIds:z.array(z.guid())}).strict();
export const RewardsReturnStoredSnapshot=RewardsReturnSnapshot.extend({nativeDecisionDigest:hash}).strict();
export const RewardsReturnEffectProof=z.object({unitId:z.guid(),decisionId:z.guid(),eventId:z.guid(),returnedRevision:z.number().int().nonnegative(),fromStage:z.enum(['bg','gr','ctro','ec','approved']),unitXmin:xmin,unitCtid:ctid,decisionXmin:xmin,decisionCtid:ctid,eventXmin:xmin,eventCtid:ctid,unitHash:hash,decisionHash:hash,eventHash:hash,snapshotHash:hash,targets:z.array(z.object({kind:z.enum(['employment','person']),id:z.guid()}).strict())}).strict();
const Scope=z.object({unitId:z.guid(),companyId:z.guid(),companyName:z.string().min(1).max(1000),name:z.string().min(1).max(1000),revision:z.number().int().nonnegative(),status:z.string().max(40),snapshot:RewardsReturnSnapshot}).strict();
export type RewardsReturnSource=z.infer<typeof Scope>&{reviewId:string|null};
export async function assertRewardsReturnActorTx(tx:Tx,ctx:SessionContext){
 const declared=agentActionById(action);if(!declared||String(declared.id)!==action)return rewardsReturnUnavailable();
 return withAgentActionGuard(tx,ctx,declared.id,'approve');
}
async function scopeTx(tx:Tx,unitId:string,reviewId:string|null,lock:boolean){const [r]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_return_scope(${z.guid().parse(unitId)}::uuid,${reviewId}::uuid,${lock}) scope`);return Scope.parse(r?.scope);}
export async function withRewardsReturnIntervalTx<T>(tx:Tx,ctx:SessionContext,unitId:string,reviewId:string|null,work:(fresh:SessionContext,source:RewardsReturnSource)=>Promise<T>){
 const fresh=await assertRewardsReturnActorTx(tx,ctx);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access-configuration:'||${fresh.tenantId}::text,0))`);
 const source=await scopeTx(tx,unitId,reviewId,true);return work(fresh,{...source,reviewId});
}
export async function prepareRewardsReturnSourceTx(tx:Tx,ctx:SessionContext,value:unknown,source?:RewardsReturnSource){
 const content=RewardsReturnHuman.parse(value),s=source??{...await scopeTx(tx,content.unitId,null,true),reviewId:null},native=await reviewAnnualRewardReturnTx(tx,ctx,content.unitId,content.revision);
 if(content.unitId!==s.unitId||content.revision!==s.revision||native.companyId!==s.companyId||native.before!==s.status)return rewardsReturnUnavailable();
 const review=RewardsReturnReview.parse({unitId:s.unitId,companyId:s.companyId,companyName:s.companyName,name:s.name,kind:'annual',revision:s.revision,before:s.status,after:'draft',returnedTo:'bu',reason:content.reason,consequence:'whole_annual_review_returns_to_bu_new_revision_approvals_reset_entries_and_history_retained'});
 return{content,review,nativeDecisionDigest:native.decisionDigest,privateSnapshot:RewardsReturnStoredSnapshot.parse({...s.snapshot,nativeDecisionDigest:native.decisionDigest}),reviewedDigest:createHash('sha256').update(JSON.stringify([1,action,s.unitId,s.companyId,s.companyName,s.name,s.snapshot,native.fingerprint,native.decisionDigest,content])).digest('hex')};
}
export async function confirmRewardsReturnSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string,source:RewardsReturnSource){
 if(!source.reviewId)return rewardsReturnUnavailable();const current=await prepareRewardsReturnSourceTx(tx,ctx,value,source);if(current.reviewedDigest!==expected)return rewardsReturnUnavailable();
 await returnAnnualRewardReviewTx(tx,ctx,current.content.unitId,current.content.revision,current.content.reason);
 const [r]=await tx.execute<{proof:unknown}>(sql`select app.assistant_rewards_return_native_effect(${source.reviewId}::uuid,${current.content.reason}) proof`),proof=RewardsReturnEffectProof.parse(r?.proof);
 if(proof.unitId!==source.unitId||proof.returnedRevision!==current.content.revision)return rewardsReturnUnavailable();return{proof,reason:current.content.reason,targets:proof.targets};
}
export async function reconcileRewardsReturnSourceTx(tx:Tx,ctx:SessionContext,reviewId:string){const [r]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_return_receipt(${z.guid().parse(reviewId)}::uuid) receipt`);return RewardsReturnReceipt.parse(r?.receipt);}
export async function readRewardsReturnChoicesTx(tx:Tx,ctx:SessionContext){return withRewardsReturnBoundsTx(tx,async()=>{await assertRewardsReturnActorTx(tx,ctx);const [r]=await tx.execute<{choices:unknown}>(sql`select app.assistant_rewards_return_choices() choices`),value=RewardsReturnChoices.parse(r?.choices);if(Buffer.byteLength(JSON.stringify(value))>49152)return rewardsReturnUnavailable();return value;});}
export const readRewardsReturnChoices=(ctx:SessionContext)=>withTenant(ctx,tx=>readRewardsReturnChoicesTx(tx,ctx));
export async function withRewardsReturnBoundsTx<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') saved,setting::integer milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return rewardsReturnUnavailable();
 await tx.execute(sql`select set_config('lock_timeout',${String(prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000))+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}
