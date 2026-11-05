'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getTranslations} from 'next-intl/server';
import {getSession} from '@/lib/session';
import {z} from 'zod';
import {rewardPatInputs,proposeRewardPat,confirmRewardPat,rewardPatExport,proposeRewardPatBatch} from '@/packs/rewards/pat-inputs';
import {workbookRows,patFromWorkbook} from '@/packs/rewards/setup-workbook';
import {decimalToCents,decimalToMonths,RewardSetupError,type PatInput} from '@/packs/rewards/setup-model';
export type PatPreview={companyId:string;company:string;expectedRevision:number;inputs:PatInput};
export type PatState={error:string;rows?:PatPreview[]};
const text=(f:FormData,k:string)=>String(f.get(k)??'');
async function failure(e:unknown){return e instanceof RewardSetupError?e.message:(await getTranslations('rewardSetup'))('failed');}
export async function savePatAction(_state:PatState,form:FormData):Promise<PatState>{const s=await getSession();try{await proposeRewardPat(s,{companyId:text(form,'companyId'),year:Number(form.get('year')),expectedRevision:Number(form.get('revision')),inputs:{targetCents:decimalToCents(text(form,'target'),true),forecastCents:decimalToCents(text(form,'forecast'),true),actualCents:decimalToCents(text(form,'actual'),true),targetMonthsBp:decimalToMonths(text(form,'months'))},reason:text(form,'reason')});revalidatePath('/admin/rewards/pat-inputs');return{error:''};}catch(e){return{error:await failure(e)};}}
export async function confirmPatAction(form:FormData){let error='';try{await confirmRewardPat(await getSession(),text(form,'id'));}catch(e){error=await failure(e);}revalidatePath('/admin/rewards','layout');redirect('/admin/rewards/pat-inputs?year='+Number(form.get('year'))+(error?'&error='+encodeURIComponent(error):'&saved=1'));}
export async function previewPatImportAction(_state:PatState,form:FormData):Promise<PatState>{const s=await getSession(),year=Number(form.get('year'));try{const current=await rewardPatInputs(s,year);if(form.get('copy')==='1'){const last=await rewardPatExport(s,year-1);return{error:'',rows:current.map(r=>{const p=last.find(p=>p.company.id===r.company.id);return{companyId:r.company.id,company:r.company.name,expectedRevision:r.pending?.revision??r.current?.revision??0,inputs:{targetCents:p?.inputs.targetCents??null,targetMonthsBp:p?.inputs.targetMonthsBp??20000,forecastCents:null,actualCents:null}};})};}
 const file=form.get('file');if(!(file instanceof File))throw new RewardSetupError('invalid','Choose an Excel workbook.');const rows=patFromWorkbook(workbookRows(new Uint8Array(await file.arrayBuffer())),new Set(current.map(r=>r.company.id)));return{error:'',rows:rows.map(r=>{const prior=current.find(c=>c.company.id===r.companyId)!;return{...r,company:prior.company.name,expectedRevision:prior.pending?.revision??prior.current?.revision??0};})};}catch(e){return{error:await failure(e)};}}
export async function commitPatImportAction(_state:PatState,form:FormData):Promise<PatState>{try{const payload=text(form,'rows');if(payload.length>1_000_000)throw new Error('oversize');const rows=z.array(z.object({companyId:z.uuid(),expectedRevision:z.number().int().nonnegative(),inputs:z.unknown(),company:z.string()}).strict()).max(1000).parse(JSON.parse(payload));await proposeRewardPatBatch(await getSession(),rows.map(r=>({companyId:r.companyId,expectedRevision:r.expectedRevision,year:Number(form.get('year')),inputs:r.inputs,reason:text(form,'reason')})));revalidatePath('/admin/rewards/pat-inputs');return{error:''};}catch(e){return{error:await failure(e)};}}
