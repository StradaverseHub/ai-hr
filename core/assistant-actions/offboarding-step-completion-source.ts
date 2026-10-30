/** Source adapter only; no model execution. Native lifecycle owns applicability and completion. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {prepareOffboardingStepTx,tickStepTx,getCase} from '../../packs/lifecycle/service';
import {withAgentActionGuard} from './agent-action-guard';
import {OffboardingStepCompletion as C,OffboardingStepCompletionPreparedSource as Prepared,OffboardingStepCompletionNativeReference as Native} from '../../lib/assistant-actions/offboarding-step-completion-contract';
export const offboardingStepUnavailable=():never=>{throw Error('Offboarding step review unavailable.');};
export const OffboardingStepSource=z.object({caseId:z.guid(),caseNumber:z.string(),casePersonId:z.guid().nullable(),employmentId:z.guid().nullable(),companyId:z.guid(),stepKey:z.string(),status:z.enum(['in_progress','completed']),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OffboardingStepSource=z.infer<typeof OffboardingStepSource>;
export async function withOffboardingStepIntervalTx<T>(tx:Tx,ctx:SessionContext,caseId:string,stepKey:string,work:(fresh:SessionContext,source:OffboardingStepSource)=>Promise<T>):Promise<T>{
 const fresh=await withAgentActionGuard(tx,ctx,C.action);if(!fresh.userId)return offboardingStepUnavailable();
 const [row]=await tx.execute<{source:unknown}>(sql`select app.assistant_offboarding_step_source(${caseId}::uuid,${stepKey}) as source`);
 return work(fresh,OffboardingStepSource.parse(row?.source));
}
export async function prepareOffboardingStepSourceTx(tx:Tx,ctx:SessionContext,value:unknown){
 const human=C.Human.parse(value);
 return withOffboardingStepIntervalTx(tx,ctx,human.caseId,human.stepKey,async(fresh,source)=>{
  const review=await prepareOffboardingStepTx(tx,fresh,human.caseId,human.caseNumber,human.stepKey,human);
  const content=C.Human.parse({...human,reference:review.reference,notes:review.notes});
  const reviewedDigest=createHash('sha256').update(JSON.stringify([1,C.action,{tenantId:fresh.tenantId,userId:fresh.userId,personId:fresh.personId??null},source,content,review])).digest('hex');
  return Prepared.parse({content,review,reviewedDigest});
 });
}
export async function confirmOffboardingStepSourceTx(tx:Tx,ctx:SessionContext,value:unknown,expected:string){
 const prepared=await prepareOffboardingStepSourceTx(tx,ctx,value);if(prepared.reviewedDigest!==expected)return offboardingStepUnavailable();
 return Native.parse(await tickStepTx(tx,ctx,'offboarding',prepared.content.caseNumber,prepared.content.stepKey,prepared.content));
}
export async function reconcileOffboardingStepSourceTx(tx:Tx,ctx:SessionContext,value:z.infer<typeof Native>){
 await withAgentActionGuard(tx,ctx,C.action);const p=Native.parse(value);
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_offboarding_step_reference(${p.caseId}::uuid,${p.stepKey},${p.stepEventId}::uuid,${p.completionEventId}::uuid) as receipt`);
 return Native.parse(row?.receipt);
}
export async function readOffboardingStepChoices(ctx:SessionContext,value:unknown){
 try{const pick=C.Selection.parse(value);await withTenant(ctx,tx=>withAgentActionGuard(tx,ctx,C.action));const view=await getCase(ctx,'offboarding',pick.caseNumber);
 return C.Choices.parse({kind:'choices',cases:[{caseId:view.case.id,caseNumber:view.case.number,steps:view.steps.filter(step=>!step.blocked&&step.key!=='resign_outcome').map(step=>({key:step.key,label:step.label}))}],truncated:false});}catch{return{kind:'unavailable' as const};}
}
