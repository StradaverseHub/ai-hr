/** Annual-submit source. Reviewed SQL proof/fence; closed local mount awaits hosted verification. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type Tx,type SessionContext} from '../../db/client';
import {pgSqlState} from '../../lib/db-error';
import {agentActionById} from '../../lib/ai/agent-action-registry';
import {withAgentActionGuard} from './agent-action-guard';
import {reviewAnnualRewardSubmitTx,submitAnnualRewardReviewTx} from '../../packs/rewards/service';
import {REWARDS_SUBMIT_ACTION as action,RewardsSubmitHuman,RewardsSubmitReview,RewardsSubmitReceipt,RewardsSubmitChoices} from '../../lib/assistant-actions/rewards-submit-contract';
export const rewardsSubmitUnavailable=():never=>{throw Error('Please reopen this annual review on the native Rewards screen.');};
const hash=z.string().regex(/^[a-f0-9]{64}$/),xmin=z.string().regex(/^\d+$/),ctid=z.string().regex(/^\(\d+,\d+\)$/);
export const RewardsSubmitSnapshot=z.object({unitStableHash:hash,unitFullHash:hash,unitXmin:xmin,unitCtid:ctid,revision:z.number().int().nonnegative(),fromStage:z.string().max(40),entriesHash:hash,historyHash:hash,eventsHash:hash,peopleHash:hash,nativeVisibleDependenciesHash:hash,employmentIds:z.array(z.guid()),personIds:z.array(z.guid())}).strict();
export const RewardsSubmitStoredSnapshot=RewardsSubmitSnapshot.extend({nativeDecisionDigest:hash}).strict();
export const RewardsSubmitEffectProof=z.object({unitId:z.guid(),decisionId:z.guid(),eventId:z.guid(),submittedRevision:z.number().int().nonnegative(),fromStage:z.literal('draft'),unitXmin:xmin,unitCtid:ctid,decisionXmin:xmin,decisionCtid:ctid,eventXmin:xmin,eventCtid:ctid,unitHash:hash,decisionHash:hash,eventHash:hash,snapshotHash:hash,targets:z.array(z.object({kind:z.enum(['employment','person']),id:z.guid()}).strict())}).strict();
const Scope=z.object({unitId:z.guid(),companyId:z.guid(),companyName:z.string().min(1).max(1000),name:z.string().min(1).max(1000),revision:z.number().int().nonnegative(),status:z.enum(['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn']),snapshot:RewardsSubmitSnapshot}).strict();
export type RewardsSubmitSource=z.infer<typeof Scope>&{reviewId:string|null};
export async function assertRewardsSubmitActorTx(tx:Tx,ctx:SessionContext){
 const declared=agentActionById(action);if(!declared||String(declared.id)!==action)return rewardsSubmitUnavailable();
 return withAgentActionGuard(tx,ctx,declared.id,'approve');
}
async function scopeTx(tx:Tx,unitId:string,reviewId:string|null,lock:boolean){const [r]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_submit_scope(${z.guid().parse(unitId)}::uuid,${reviewId}::uuid,${lock}) scope`);return Scope.parse(r?.scope);}
export async function withRewardsSubmitIntervalTx<T>(tx:Tx,ctx:SessionContext,unitId:string,reviewId:string|null,work:(fresh:SessionContext,source:RewardsSubmitSource)=>Promise<T>){
 const fresh=await assertRewardsSubmitActorTx(tx,ctx);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access-configuration:'||${fresh.tenantId}::text,0))`);
 const source=await scopeTx(tx,unitId,reviewId,true);return work(fresh,{...source,reviewId});
}
export async function prepareRewardsSubmitSourceTx(tx:Tx,ctx:SessionContext,value:unknown,source?:RewardsSubmitSource){
 const content=RewardsSubmitHuman.parse(value),s=source??{...await scopeTx(tx,content.unitId,null,true),reviewId:null},native=await reviewAnnualRewardSubmitTx(tx,ctx,content.unitId,content.revision,content.reason);
 if(content.unitId!==s.unitId||content.revision!==s.revision||native.companyId!==s.companyId||native.before!==s.status)return rewardsSubmitUnavailable();
 const review=RewardsSubmitReview.parse({unitId:s.unitId,companyId:s.companyId,companyName:s.companyName,name:s.name,kind:'annual',revision:s.revision,before:s.status,after:'bg',nextSeat:'bg',reason:content.reason,consequence:'whole_annual_review_submitted_to_bg_same_revision_native_approvals_required'});
 return{content,review,nativeDecisionDigest:native.decisionDigest,privateSnapshot:RewardsSubmitStoredSnapshot.parse({...s.snapshot,nativeDecisionDigest:native.decisionDigest}),reviewedDigest:createHash('sha256').update(JSON.stringify([1,action,s.unitId,s.companyId,s.companyName,s.name,s.snapshot,native.fingerprint,native.decisionDigest,content])).digest('hex')};
}
export async function confirmRewardsSubmitSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string,source:RewardsSubmitSource){
 if(!source.reviewId)return rewardsSubmitUnavailable();const current=await prepareRewardsSubmitSourceTx(tx,ctx,value,source);if(current.reviewedDigest!==expected)return rewardsSubmitUnavailable();
 await tx.execute(sql`select app.assistant_rewards_submit_begin_effect(${source.reviewId}::uuid)`);
 await submitAnnualRewardReviewTx(tx,ctx,current.content.unitId,current.content.revision,current.content.reason);
 const [r]=await tx.execute<{proof:unknown}>(sql`select app.assistant_rewards_submit_native_effect(${source.reviewId}::uuid,${current.content.reason}) proof`),proof=RewardsSubmitEffectProof.parse(r?.proof);
 if(proof.unitId!==source.unitId||proof.submittedRevision!==current.content.revision)return rewardsSubmitUnavailable();return{proof,reason:current.content.reason,targets:proof.targets};
}
export async function reconcileRewardsSubmitSourceTx(tx:Tx,ctx:SessionContext,reviewId:string){const [r]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_submit_receipt(${z.guid().parse(reviewId)}::uuid) receipt`);return RewardsSubmitReceipt.parse(r?.receipt);}
export async function readRewardsSubmitChoicesTx(tx:Tx,ctx:SessionContext){return withRewardsSubmitBoundsTx(tx,async()=>{await assertRewardsSubmitActorTx(tx,ctx);const [r]=await tx.execute<{choices:unknown}>(sql`select app.assistant_rewards_submit_choices() choices`),value=RewardsSubmitChoices.parse(r?.choices);if(Buffer.byteLength(JSON.stringify(value))>49152)return rewardsSubmitUnavailable();return value;});}
export const readRewardsSubmitChoices=(ctx:SessionContext)=>withTenant(ctx,tx=>readRewardsSubmitChoicesTx(tx,ctx));
export async function withRewardsSubmitBoundsTx<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') saved,setting::integer milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return rewardsSubmitUnavailable();
 await tx.execute(sql`select set_config('lock_timeout',${String(prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000))+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}
