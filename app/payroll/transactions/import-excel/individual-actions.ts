'use server';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {submitIndividualImportJob,queueIndividualImportConfirmation,requestIndividualImportRevert,IndividualImportError,BatchNotDraftError} from '@/packs/payroll/service';
import {INDIVIDUAL_IMPORT_MAX_BYTES} from '@/lib/individual-import-job';
import type {IndividualImportMethod} from '@/lib/payroll-txn-import-schema';
async function result<T>(run:()=>Promise<T>){try{return {ok:true as const,data:await run()};}catch(e){return {ok:false as const,error:e instanceof IndividualImportError?e.message:e instanceof BatchNotDraftError?'revertFailed':'failed'};}}
export async function submitIndividualImportAction(form: FormData) {
  const {s, scopeIds} = await scopedAdmin();
  const file = form.get('file');
  if (!(file instanceof File)) return {ok: false as const, error: 'invalidFormat'};
  if (file.size > INDIVIDUAL_IMPORT_MAX_BYTES) return {ok: false as const, error: 'fileTooLarge'};
  try {
    const id = await submitIndividualImportJob(s, {
      id: String(form.get('id') ?? ''), name: file.name, content: Buffer.from(await file.arrayBuffer()),
      worksheet: typeof form.get('worksheet') === 'string' ? String(form.get('worksheet')) : undefined,
      method: form.get('method') as IndividualImportMethod, scopeIds,
    });
    return {ok: true as const, id};
  } catch (error) {
    return {ok: false as const, error: error instanceof IndividualImportError ? error.message : 'importFailed'};
  }
}
export async function queueIndividualImportAction(id: string) {
  const {s, scopeIds} = await scopedAdmin();
  try {
    return {ok: await queueIndividualImportConfirmation(s, id, scopeIds)};
  } catch {
    return {ok: false};
  }
}
/** 0ec0ee00 — refusals are decided here; a queued batch is then reverted by the worker in steps (`queued`). */
export async function revertIndividualImportAction(p:{id:string;confirmProcessed:boolean}){const {s,scopeIds}=await scopedAdmin();return result(async()=>{const r=await requestIndividualImportRevert(s,{...p,scopeIds});revalidatePath('/payroll/transactions/individual');revalidatePath('/payroll/transactions/individual/imports');return r;});}
