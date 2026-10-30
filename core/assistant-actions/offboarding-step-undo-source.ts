import {lockAccessConfigurationTx} from '../access-configuration-lock';
/** Source adapter only; no model execution. Native lifecycle owns applicability and completion. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {prepareOffboardingStepUndoTx,undoStepTx,offboardingStepUndoChoicesTx} from '../../packs/lifecycle/service';
import {withAgentActionGuard} from './agent-action-guard';
import {OffboardingStepUndo as C,OffboardingStepUndoPrepared as Prepared,OffboardingStepUndoNativeReference as Native} from '../../lib/assistant-actions/offboarding-step-undo-contract';
export const offboardingStepUndoUnavailable=():never=>{throw Error('Offboarding step review unavailable.');};
export const OffboardingStepUndoSource=z.object({caseId:z.guid(),caseNumber:z.string(),casePersonId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid(),stepKey:z.string(),status:z.enum(['in_progress','completed']),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OffboardingStepUndoSource=z.infer<typeof OffboardingStepUndoSource>;
export async function withOffboardingStepUndoIntervalTx<T>(tx:Tx,ctx:SessionContext,caseId:string,stepKey:string,work:(fresh:SessionContext,source:OffboardingStepUndoSource)=>Promise<T>):Promise<T>{
 const fresh=await withAgentActionGuard(tx,ctx,C.action);if(!fresh.userId)return offboardingStepUndoUnavailable();
 const [row]=await tx.execute<{source:unknown}>(sql`select app.assistant_offboarding_step_undo_source(${caseId}::uuid,${stepKey}) as source`);
 return work(fresh,OffboardingStepUndoSource.parse(row?.source));
}
export async function prepareOffboardingStepUndoSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const human=C.Human.parse(value);
 return withOffboardingStepUndoIntervalTx(tx,ctx,human.caseId,human.stepKey,async(fresh,source)=>{
  if(source.caseNumber!==human.caseNumber)return offboardingStepUndoUnavailable();
  const review=await prepareOffboardingStepUndoTx(tx,fresh,human.caseId,human.caseNumber,human.stepKey,human.reason);
  const content=C.Human.parse({...human,reason:review.reason});
  const reviewedDigest=createHash('sha256').update(JSON.stringify([1,C.action,{tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId??null},source,content,review])).digest('hex');
  return Prepared.parse({content,review,reviewedDigest});
 });
}
export async function confirmOffboardingStepUndoSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string){
 const prepared=await prepareOffboardingStepUndoSourceTx(tx,ctx,value);if(prepared.reviewedDigest!==expected)return offboardingStepUndoUnavailable();
 const native=await undoStepTx(tx,ctx,'offboarding',prepared.content.caseNumber,prepared.content.stepKey,prepared.content.reason);
 const reference=Native.parse({caseId:native.caseId,stepKey:native.stepKey,status:native.status,stepEventId:native.stepEventId,reopeningEventId:native.caseEventId});
 if((reference.reopeningEventId!==null)!==prepared.review.reopensCase)return offboardingStepUndoUnavailable();return reference;
}
export async function reconcileOffboardingStepUndoSourceTx(tx:Tx,ctx:SessionContext,value:z.infer<typeof Native>){
 await withAgentActionGuard(tx,ctx,C.action);const p=Native.parse(value);
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_offboarding_step_undo_reference(${p.caseId}::uuid,${p.stepKey},${p.stepEventId}::uuid,${p.reopeningEventId}::uuid) as receipt`);
 return Native.parse(row?.receipt);
}
export async function readOffboardingStepUndoChoices(supplied:SessionContext,value:unknown){
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};
 try{const pick=C.Selection.parse(structuredClone(value));return await withTenant(ctx,async tx=>{
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const fresh=await withAgentActionGuard(tx,ctx,C.action);
  const selected=await offboardingStepUndoChoicesTx(tx,fresh,pick.caseNumber);
  return C.Choices.parse({kind:'choices',cases:[selected],truncated:false});
 });}catch{return{kind:'unavailable' as const};}
}
