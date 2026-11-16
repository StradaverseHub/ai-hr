'use server';
import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import * as owner from '@/packs/contracts/service';
import {ContractManagementError} from '@/lib/contract-management-model';
import {ZodError} from 'zod';

async function perform<T>(work:(session:NonNullable<Awaited<ReturnType<typeof requireScopedLifecycleModule>>>)=>Promise<T>,invalidate=true){
 const session=await requireScopedLifecycleModule();
 if(!session)return {ok:false as const,error:'Your session ended. Sign in again.'};
 try{const value=await work(session);if(invalidate)revalidatePath('/lifecycle/contracts','layout');return {ok:true as const,value};}
 catch(error){return {ok:false as const,error:error instanceof ContractManagementError?error.message:error instanceof ZodError?'Check the entered values and try again.':'The request could not be completed. Your entries are still here. Reload and try again.'};}
}
export async function actSharedApproval(input:Parameters<typeof owner.actContractSharedApproval>[1]){return perform(s=>owner.actContractSharedApproval(s,input));}
export async function actSharedLetter(input:Parameters<typeof owner.actContractSharedLetter>[1]){return perform(async s=>{const letter=await owner.actContractSharedLetter(s,input);return {letter,document:owner.renderContractSharedLetter(letter)};});}
export async function editSharedLetter(input:Parameters<typeof owner.editContractSharedLetter>[1]){return perform(async s=>{const letter=await owner.editContractSharedLetter(s,input);return {letter,document:owner.renderContractSharedLetter(letter)};});}
export async function bindSharedEmployee(id:string){return perform(async s=>{const letter=await owner.bindContractSharedEmployee(s,id);return {letter,document:owner.renderContractSharedLetter(letter)};});}
export async function previewSharedDecision(input:Parameters<typeof owner.previewContractSharedDecision>[1]){return perform(s=>owner.previewContractSharedDecision(s,input));}
export async function readSharedDecisionPreview(id:string){return perform(s=>owner.readContractSharedDecisionPreview(s,id),false);}
export async function submitSharedDecision(input:Parameters<typeof owner.submitContractSharedDecision>[1]){return perform(s=>owner.submitContractSharedDecision(s,input));}
export async function adoptSharedCase(id:string){return perform(s=>owner.adoptContractSharedCase(s,id));}
export async function openSharedPeriod(input:Parameters<typeof owner.openContractSharedPeriod>[1]){return perform(s=>owner.openContractSharedPeriod(s,input));}
export async function saveSharedSettings(input:Parameters<typeof owner.saveContractSharedSettings>[1]){return perform(s=>owner.saveContractSharedSettings(s,input));}
export async function saveSharedRole(input:Parameters<typeof owner.saveContractSharedRole>[1]){return perform(s=>owner.saveContractSharedRole(s,input));}
export async function saveSharedMember(input:Parameters<typeof owner.saveContractSharedMember>[1]){return perform(s=>owner.saveContractSharedMember(s,input));}
export async function searchSharedPeople(search:string){return perform(s=>owner.contractSharedAccessPeople(s,search),false);}
