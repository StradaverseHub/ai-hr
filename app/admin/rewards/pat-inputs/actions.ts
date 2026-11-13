'use server';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {z} from 'zod';
import {rewardPatInputs,rewardPatExport,previewRewardPatBatch,saveRewardPatBatch} from '@/packs/rewards/pat-inputs';
import {RewardConfigReviewError,type RewardConfigSummary} from '@/packs/rewards/config-change-model';
import {workbookRows,patFromWorkbook} from '@/packs/rewards/setup-workbook';
import {RewardSetupError,type PatInput} from '@/packs/rewards/setup-model';
export type PatPreview={companyId:string;company:string;expectedRevision:number;inputs:PatInput};
export type PatState={error:string;rows?:PatPreview[];copy?:boolean};
const text=(f:FormData,k:string)=>String(f.get(k)??'');
async function failure(e:unknown){return e instanceof RewardSetupError||e instanceof RewardConfigReviewError?e.message:(await getTranslations('rewardSetup'))('failed');}
export async function previewPatImportAction(_state:PatState,form:FormData):Promise<PatState>{const s=await getSession(),year=Number(form.get('year'));try{const current=await rewardPatInputs(s,year);if(form.get('copy')==='1'){const last=await rewardPatExport(s,year-1);return{error:'',copy:true,rows:current.map(r=>{const p=last.find(p=>p.company.id===r.company.id);return{companyId:r.company.id,company:r.company.name,expectedRevision:r.pending?.revision??r.current?.revision??0,inputs:{targetCents:p?.inputs.targetCents??null,targetMonthsBp:p?.inputs.targetMonthsBp??20000,forecastCents:null,actualCents:null}};})};}
 const file=form.get('file');if(!(file instanceof File)||file.size>2_000_000)throw new RewardSetupError('invalid','Choose an Excel workbook.');const rows=patFromWorkbook(workbookRows(new Uint8Array(await file.arrayBuffer())),new Set(current.map(r=>r.company.id)));return{error:'',rows:rows.map(r=>{const prior=current.find(c=>c.company.id===r.companyId)!;return{...r,company:prior.company.name,expectedRevision:prior.pending?.revision??prior.current?.revision??0};})};}catch(e){return{error:await failure(e)};}}
/** Board 2103041d: one grid, one batch. The grid previews its edits (server summary and digest), the editor gives a
 * reason in "Review before saving", and the batch saves all rows or none. No second-person confirmation (60f1fdcd). */
export type PatGridRow={companyId:string;expectedRevision:number;inputs:PatInput};
export type PatBatchResult={ok:true;affected:number}|{ok:false;error:string;review?:{summary:RewardConfigSummary;digest:string}};
const gridRows=z.array(z.object({companyId:z.uuid(),expectedRevision:z.number().int().nonnegative(),inputs:z.unknown()}).strict()).min(1).max(1000);
export async function previewPatBatchAction(year:number,mode:'draft'|'active',rows:PatGridRow[]):Promise<{error:string;review?:{summary:RewardConfigSummary;digest:string}}>{
 try{const review=await previewRewardPatBatch(await getSession(),{year,mode,reason:'Preview only, not saved.',rows:gridRows.parse(rows)});return{error:'',review};}catch(e){return{error:await failure(e)};}
}
export async function savePatBatchAction(year:number,mode:'draft'|'active',rows:PatGridRow[],reason:string,summaryDigest:string):Promise<PatBatchResult>{
 const s=await getSession(),parsed=gridRows.parse(rows);
 try{const result=await saveRewardPatBatch(s,{year,mode,reason,summaryDigest,rows:parsed});revalidatePath('/admin/rewards','layout');return{ok:true,affected:result.affectedReviewIds.length};}
 catch(e){if(e instanceof RewardConfigReviewError&&e.code==='changed'){const review=await previewRewardPatBatch(s,{year,mode,reason,rows:parsed});return{ok:false,error:e.message,review};}return{ok:false,error:await failure(e)};}
}
