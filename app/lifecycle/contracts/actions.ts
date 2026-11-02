'use server';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import * as owner from '@/packs/contracts/service';
import {z} from 'zod';
export type ContractCommand='previewIntake'|'intake'|'previewDecision'|'decision'|'confirm'|'approval'|'generate'|'accept'|'release'|'retry'|'handoff'|'reconcile'|'verifyRecords'|'setup'|'configure'|'role'|'captureEvidence'|'verifyEvidence'|'amendEnd'|'refreshApprovers'|'saveDecisionDraft'|'revokeRole';
/** Every request authenticates again; the owner independently validates scope, capability and revision. */
export async function runContractCommand(command:ContractCommand,input:unknown){
 const session=await requireScopedLifecycleModule();if(!session)return{ok:false as const,error:'session'};
 try{
  let result:unknown;
  switch(command){
   case 'previewIntake':result=await owner.previewContractIntake(session,z.string().uuid().parse(input));break;
   case 'intake':result=await owner.intakeContract(session,input);break;
   case 'previewDecision':result=await owner.previewContractDecision(session,input);break;
   case 'decision':result=await owner.submitContractDecision(session,input);break;
   case 'saveDecisionDraft':result=await owner.saveContractDecisionDraft(session,input);break;
   case 'revokeRole':result=await owner.revokeContractRole(session,input);break;
   case 'confirm':result=await owner.confirmContractDecision(session,input);break;
   case 'approval':result=await owner.decideContractApproval(session,input);break;
   case 'generate':result=await owner.generateContractDocument(session,input);break;
   case 'accept':result=await owner.acceptContract(session,input);break;
   case 'release':result=await owner.releaseContractLetter(session,input);break;
   case 'retry':result=await owner.retryContractRecords(session,z.string().uuid().parse(input));break;
   case 'handoff':result=await owner.handoffContract(session,input);break;
   case 'reconcile':result=await owner.reconcileContractSource(session,input);break;
   case 'verifyRecords':result=await owner.verifyContractRecords(session,input);break;
   case 'setup':{const p=z.object({companyId:z.uuid(),allowanceComponentId:z.uuid()}).strict().parse(input);result=await owner.setupContractManagement(session,p.companyId,p.allowanceComponentId);break;}
   case 'configure':result=await owner.saveContractConfiguration(session,input);break;
   case 'role':result=await owner.assignContractRole(session,input);break;
   case 'captureEvidence':result=await owner.captureContractRetirementEvidence(session,input);break;
   case 'verifyEvidence':result=await owner.verifyContractRetirementEvidence(session,input);break;
   case 'amendEnd':result=await owner.amendContractEnd(session,input);break;
   case 'refreshApprovers':result=await owner.refreshContractApprovers(session,input);break;
   default:return{ok:false as const,error:'invalid'};
  }
  if(!['previewIntake','previewDecision'].includes(command))revalidatePath('/lifecycle/contracts','layout');
  return{ok:true as const,result};
 }catch(error){return{ok:false as const,error:error instanceof Error&&error.name==='ContractManagementError'?error.message:error instanceof z.ZodError?'invalid':'failed'};}
}
export async function readContractRetirementContext(employmentId:string){
 const session=await requireScopedLifecycleModule();if(!session)return{ok:false as const,error:'session'};
 try{z.uuid().parse(employmentId);const choices=await owner.contractRetirementChoices(session,employmentId),evidence=(await owner.contractRetirementEvidence(session)).filter(row=>row.employmentId===employmentId);return{ok:true as const,choices,evidence};}catch{return{ok:false as const,error:'failed'};}
}

export async function readContractLetterEditor(caseId:string,type:'renewal'|'end'|'declined'|'retirement'){
 const session=await requireScopedLifecycleModule();if(!session)return{ok:false as const,error:'session'};
 try{return{ok:true as const,editor:await owner.contractLetterEditor(session,z.uuid().parse(caseId),z.enum(['renewal','end','declined','retirement']).parse(type))};}catch{return{ok:false as const,error:'failed'};}

}
