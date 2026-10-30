import {pgSqlState} from '../../lib/db-error';
/** Human cycle/company calendar editing; native Rewards retains the command and all authority. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {withAgentActionGuard} from './agent-action-guard';
import {saveRewardCalendarTx} from '../../packs/rewards/service';
import {REWARDS_CALENDAR_ACTION as action,RewardsCalendarHuman,RewardsCalendarReview,RewardsCalendarReceipt,RewardsCalendarChoices} from '../../lib/assistant-actions/rewards-calendar-contract';
export const rewardsCalendarUnavailable=():never=>{throw new Error('Please reopen this review on the native Rewards screen.');};
export const assertRewardsCalendarActorTx=(tx:Tx,ctx:SessionContext)=>withAgentActionGuard(tx,ctx,action,'approve');
const Scope=RewardsCalendarChoices.shape.units.element.extend({fingerprint:z.string()}).strict();
export async function withRewardsCalendarIntervalTx<T>(tx:Tx,ctx:SessionContext,unitId:string,work:(fresh:SessionContext,source:z.infer<typeof Scope>)=>Promise<T>){
 const fresh=await assertRewardsCalendarActorTx(tx,ctx);
 // Same access lock as native role maintenance. The native entry witness and shared calendar are locked by the source owner.
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('access-configuration:'||${fresh.tenantId}::text,0))`);
 const [row]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_calendar_scope(${z.guid().parse(unitId)}::uuid,true) as scope`);
 return work(fresh,Scope.parse(row?.scope));
}
export async function prepareRewardsCalendarSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const content=RewardsCalendarHuman.parse(value),[row]=await tx.execute<{scope:unknown}>(sql`select app.assistant_rewards_calendar_scope(${content.unitId}::uuid,true) as scope`),s=Scope.parse(row?.scope);
 if(s.calendarId!==content.calendarId||s.revision!==content.revision||s.cycleId!==content.cycleId||s.companyId!==content.companyId)return rewardsCalendarUnavailable();
 const review=RewardsCalendarReview.parse({unitId:s.unitId,cycleId:s.cycleId,companyId:s.companyId,companyName:s.companyName,name:s.name,calendarId:s.calendarId,revision:s.revision,before:s.values,after:content.values,consequence:'all_reviews_in_cycle_and_company_display_deadlines_only'});
 return{content,review,reviewedDigest:createHash('sha256').update(JSON.stringify([1,action,s,content])).digest('hex')};
}
export async function confirmRewardsCalendarSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string){
 const current=await prepareRewardsCalendarSourceTx(tx,ctx,value);if(current.reviewedDigest!==expected)return rewardsCalendarUnavailable();
 const result=await saveRewardCalendarTx(tx,ctx,current.content.unitId,current.content.revision,current.content.values);
 return{...result,postedEventId:result.eventId,postedRevision:result.revision,postedBatchId:result.calendarId};
}
export async function reconcileRewardsCalendarSourceTx(tx:Tx,ctx:SessionContext,reference:{unitId:string;eventId:string}){
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_rewards_calendar_receipt(${reference.unitId}::uuid,${reference.eventId}::uuid) as receipt`);return RewardsCalendarReceipt.parse(row?.receipt);
}
export async function readRewardsCalendarChoicesTx(tx:Tx,ctx:SessionContext){return withRewardsCalendarBoundsTx(tx,async()=>{await assertRewardsCalendarActorTx(tx,ctx);const [row]=await tx.execute<{choices:unknown}>(sql`select app.assistant_rewards_calendar_choices() as choices`);const result=RewardsCalendarChoices.parse(row?.choices);if(Buffer.byteLength(JSON.stringify(result))>49152)return rewardsCalendarUnavailable();return result;});}

/** Same per-lock bound as the existing Rewards post adapter, preserving shorter caller limits. */
export async function withRewardsCalendarBoundsTx<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') as saved,setting::integer as milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return rewardsCalendarUnavailable();
 const limit=prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000);await tx.execute(sql`select set_config('lock_timeout',${String(limit)+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}

export const readRewardsCalendarChoices=(ctx:SessionContext)=>withTenant(ctx,tx=>readRewardsCalendarChoicesTx(tx,ctx));
