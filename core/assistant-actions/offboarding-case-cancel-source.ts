/** Bounded native case-cancellation source adapter with same-transaction authority. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {isAgentActionId} from '../../lib/ai/agent-action-registry';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {withAgentActionGuard} from './agent-action-guard';
import {prepareOffboardingCaseCancellationTx,cancelCaseTx,offboardingCaseCancellationChoiceTx} from '../../packs/lifecycle/service';
import {OffboardingCaseCancel as C,OffboardingCaseCancelPrepared as Prepared,OffboardingCaseCancelNativeReference as Native} from '../../lib/assistant-actions/offboarding-case-cancel-contract';
export const offboardingCaseCancelUnavailable=():never=>{throw Error('Case cancellation unavailable.');};
export const OffboardingCaseCancelSource=z.object({caseId:z.guid(),caseNumber:z.string(),casePersonId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid(),status:z.enum(['in_progress','completed','cancelled']),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OffboardingCaseCancelSource=z.infer<typeof OffboardingCaseCancelSource>;
async function guard(tx:Tx,ctx:SessionContext){
 const action:string=C.action;if(!isAgentActionId(action))return offboardingCaseCancelUnavailable();
 return withAgentActionGuard(tx,ctx,action);
}
export async function withOffboardingCaseCancelIntervalTx<T>(tx:Tx,ctx:SessionContext,caseId:string,work:(fresh:SessionContext,source:OffboardingCaseCancelSource)=>Promise<T>):Promise<T>{
 await lockAccessConfigurationTx(tx,ctx.tenantId);const fresh=await guard(tx,ctx);if(!fresh.userId)return offboardingCaseCancelUnavailable();
 const [row]=await tx.execute<{source:unknown}>(sql`select app.assistant_offboarding_case_cancel_source(${caseId}::uuid) as source`);
 return work(fresh,OffboardingCaseCancelSource.parse(row?.source));
}
export async function prepareOffboardingCaseCancelSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const human=C.Human.parse(value);
 return withOffboardingCaseCancelIntervalTx(tx,ctx,human.caseId,async(fresh,source)=>{
  if(source.caseNumber!==human.caseNumber||source.status!=='in_progress')return offboardingCaseCancelUnavailable();
  const review=await prepareOffboardingCaseCancellationTx(tx,fresh,human.caseId,human.caseNumber,human.reason),content=C.Human.parse({...human,reason:review.after.cancelReason});
  const reviewedDigest=createHash('sha256').update(JSON.stringify([1,C.action,{tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId??null},source,content,review])).digest('hex');
  return Prepared.parse({content,review,reviewedDigest});
 });
}
export async function confirmOffboardingCaseCancelSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string){
 const prepared=await prepareOffboardingCaseCancelSourceTx(tx,ctx,value);if(prepared.reviewedDigest!==expected)return offboardingCaseCancelUnavailable();
 const native=await cancelCaseTx(tx,ctx,'offboarding',prepared.content.caseNumber,prepared.content.reason);
 return Native.parse(native);
}
export async function reconcileOffboardingCaseCancelSourceTx(tx:Tx,ctx:SessionContext,actionId:string){
 await guard(tx,ctx);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_offboarding_case_cancel_reference(${actionId}::uuid) as receipt`);return Native.parse(row?.receipt);
}
export async function readOffboardingCaseCancelChoices(supplied:SessionContext,value:unknown){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 try{const pick=C.Selection.parse(structuredClone(value));return await withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,ctx.tenantId);const fresh=await guard(tx,ctx);const selected=await offboardingCaseCancellationChoiceTx(tx,fresh,pick.caseNumber);
  return C.Choices.parse({kind:'choices',cases:[selected],truncated:false});
 });}catch{return {kind:'unavailable' as const};}
}
