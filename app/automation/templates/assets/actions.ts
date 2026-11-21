'use server';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {automationEmailCaseFilePage} from '@/packs/automation/service';
export async function readContractEmailFilePage(caseId:string,offset:number){
 try{return {ok:true as const,page:await automationEmailCaseFilePage(await requireScopedLifecycleModule(),caseId,{offset,limit:50})};}
 catch{return {ok:false as const,error:'Email files are unavailable. Reload the case and try again.'};}
}
