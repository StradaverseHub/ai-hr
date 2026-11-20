'use server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {saveContractWorkflow,previewContractWorkflow,contractConfigurationDirectory} from '@/packs/contracts/service';
export async function saveWorkflowAction(input:unknown){const session=await requireScopedLifecycleModule();if(!session)throw new Error('Sign in to continue.');return saveContractWorkflow(session,input);}
export async function previewWorkflowAction(input:unknown){const session=await requireScopedLifecycleModule();if(!session)throw new Error('Sign in to continue.');return previewContractWorkflow(session,input);}

export async function searchContractReviewersAction(input:{companyId:string;query:string;selectedUserIds:string[]}){
 try{
  const session=await requireScopedLifecycleModule();
  const result=await contractConfigurationDirectory(session,input);
  return {ok:true as const,result};
 }catch{
  return {ok:false as const,detail:undefined};
 }
}
