'use server';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import * as owner from '@/packs/contracts/service';
import {ContractManagementError} from '@/lib/contract-management-model';
import {ZodError} from 'zod';
import {readBulkJob} from '@/core/bulk-job';

async function perform<T>(work:(session:NonNullable<Awaited<ReturnType<typeof requireScopedLifecycleModule>>>)=>Promise<T>,invalidate=true){
 const session=await requireScopedLifecycleModule();
 if(!session)return {ok:false as const,error:'Your session ended. Sign in again.'};
 try{const value=await work(session);if(invalidate)revalidatePath('/lifecycle/contracts','layout');return {ok:true as const,value};}
 catch(error){return {ok:false as const,error:error instanceof ContractManagementError?error.message:error instanceof ZodError?'Check the entered values and try again.':'The request could not be completed. Your entries are still here. Try again.'};}
}
export async function actSharedApproval(input:Parameters<typeof owner.actContractSharedApproval>[1]){return perform(s=>owner.actContractSharedApproval(s,input));}
export async function actSharedLetter(input:Parameters<typeof owner.actContractSharedLetter>[1]){return perform(async s=>{const letter=await owner.actContractSharedLetter(s,input);return {letter,document:owner.renderContractSharedLetter(letter),capabilities:await owner.contractSharedLetterActions(s,letter.id),form:await owner.readContractSharedForm(s,letter.id),releaseProof:await owner.readContractSharedReleaseProof(s,letter.id)};});}
export async function editSharedLetter(input:Parameters<typeof owner.editContractSharedLetter>[1]){return perform(async s=>{const letter=await owner.editContractSharedLetter(s,input);return {letter,document:owner.renderContractSharedLetter(letter),capabilities:await owner.contractSharedLetterActions(s,letter.id),form:await owner.readContractSharedForm(s,letter.id),releaseProof:await owner.readContractSharedReleaseProof(s,letter.id)};});}
export async function bindSharedEmployee(id:string){return perform(async s=>{const letter=await owner.bindContractSharedEmployee(s,id);return {letter,document:owner.renderContractSharedLetter(letter),capabilities:await owner.contractSharedLetterActions(s,letter.id),form:await owner.readContractSharedForm(s,letter.id),releaseProof:await owner.readContractSharedReleaseProof(s,letter.id)};});}
export async function previewSharedDecision(input:Parameters<typeof owner.previewContractSharedDecision>[1]){return perform(s=>owner.previewContractSharedDecision(s,input));}
export async function readSharedDecisionPreview(id:string){return perform(async s=>{const preview=await owner.readContractSharedDecisionPreview(s,id),job=await readBulkJob(s,preview.jobId,'contract_preview');return {...preview,jobState:job.state};},false);}
export async function submitSharedDecision(input:Parameters<typeof owner.submitContractSharedDecision>[1]){return perform(s=>owner.submitContractSharedDecision(s,input));}
export async function adoptSharedCase(id:string){return perform(s=>owner.adoptContractSharedCase(s,id));}
export async function openSharedPeriod(input:Parameters<typeof owner.openContractSharedPeriod>[1]){return perform(s=>owner.openContractSharedPeriod(s,input));}
export async function saveSharedSettings(input:Parameters<typeof owner.saveContractSharedSettings>[1]){return perform(s=>owner.saveContractSharedSettings(s,input));}
export async function saveSharedRole(input:Parameters<typeof owner.saveContractSharedRole>[1]){return perform(s=>owner.saveContractSharedRole(s,input));}
export async function saveSharedMember(input:Parameters<typeof owner.saveContractSharedMember>[1]){return perform(s=>owner.saveContractSharedMember(s,input));}
export async function searchSharedPeople(search:string){return perform(s=>owner.contractSharedAccessPeople(s,search),false);}
export async function readSharedPeriods(caseId:string,offset:number){return perform(s=>owner.contractSharedPeriods(s,caseId,offset),false);}
export async function startSharedSetup(input:Parameters<typeof owner.startContractSharedSetup>[1]){return perform(s=>owner.startContractSharedSetup(s,input));}
export async function readSharedSetup(companyId:string){return perform(async s=>{const setup=await owner.contractSharedSetup(s,companyId),job=setup.jobId?await readBulkJob(s,setup.jobId,'contract_setup'):null;return {...setup,jobState:job?.state??null};},false);}

export async function recordSharedDecline(input:Parameters<typeof owner.recordContractSharedDecline>[1]){return perform(s=>owner.recordContractSharedDecline(s,input));}

export async function confirmSharedPay(input:Parameters<typeof owner.confirmContractSharedPay>[1]){return perform(s=>owner.confirmContractSharedPay(s,input));}

export async function readSharedManualWorkflows(caseId:string){return perform(s=>owner.contractSharedManualWorkflows(s,caseId),false);}
export async function startSharedManualWorkflow(input:Parameters<typeof owner.startContractSharedManualWorkflow>[1]){return perform(s=>owner.startContractSharedManualWorkflow(s,input));}
export async function saveSharedForm(input:Parameters<typeof owner.saveContractSharedForm>[1]){return perform(s=>owner.saveContractSharedForm(s,input));}

export async function readSharedLetterState(id:string){return perform(async s=>{const letter=await owner.readContractSharedLetter(s,id);return {letter,document:owner.renderContractSharedLetter(letter),capabilities:await owner.contractSharedLetterActions(s,id),form:await owner.readContractSharedForm(s,id),releaseProof:await owner.readContractSharedReleaseProof(s,id)};},false);}

export async function readSharedFallbacks(caseId:string,before:number){return perform(s=>owner.contractSharedFallbacks(s,caseId,before),false);}

export async function readSharedEmailReconciliations(caseId:string,offset:number){return perform(s=>owner.contractSharedEmailReconciliations(s,caseId,offset),false);}
