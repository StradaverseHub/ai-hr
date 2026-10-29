'use server';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {validateIndividualImport,confirmIndividualImport,revertIndividualImport,IndividualImportError,BatchNotDraftError} from '@/packs/payroll/service';
import type {IndividualImportMethod} from '@/lib/payroll-txn-import-schema';
import type {IndividualImportAttempt} from '@/lib/individual-txn-import-model';
async function result(run:()=>Promise<IndividualImportAttempt>){try{return {ok:true as const,data:await run()};}catch(e){return {ok:false as const,error:e instanceof IndividualImportError?e.message:e instanceof BatchNotDraftError?'revertFailed':'failed'};}}
export async function validateIndividualImportAction(p:{operationId:string;sourceName:string;csv:string;method:IndividualImportMethod}){const {s,scopeIds}=await scopedAdmin();return result(()=>validateIndividualImport(s,{...p,scopeIds}));}
export async function confirmIndividualImportAction(id:string){const {s,scopeIds}=await scopedAdmin();return result(async()=>{const r=await confirmIndividualImport(s,{id,scopeIds});revalidatePath('/payroll/transactions/individual');return r;});}
export async function revertIndividualImportAction(p:{id:string;confirmProcessed:boolean}){const {s,scopeIds}=await scopedAdmin();return result(async()=>{const r=await revertIndividualImport(s,{...p,scopeIds});revalidatePath('/payroll/transactions/individual');revalidatePath('/payroll/transactions/individual/imports');return r;});}
