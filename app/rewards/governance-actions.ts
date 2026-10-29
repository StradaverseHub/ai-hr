'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {ZodError} from 'zod';
import {publicErrorMessage} from '@/lib/public-error';
import {PROFILE_ATTACHMENT_TOTAL_MAX_BYTES} from '@/lib/profile-attachment';
import { getSession } from '@/lib/session';
import { saveRewardUnitInputs, proposeRewardExemption, confirmRewardGovernance, saveRewardSeniorAward,RewardError } from '@/packs/rewards/service';

/** Decimal input to integer money/rates; never binary multiplication of an HR-entered decimal. */
function scaled(value:FormDataEntryValue|null,places:number):number|null{
 const raw=String(value??'').trim();if(!raw)return null;
 if(raw.length>64)throw new RewardError('Amount exceeds the supported limit.');
 if(!new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(raw))throw new RewardError('Enter a nonnegative amount with the supported decimal precision.');
 const [whole,fraction='']=raw.split('.'),number=BigInt(whole)*BigInt(10)**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
 const result=Number(number);if(!Number.isSafeInteger(result))throw new RewardError('Amount exceeds the supported limit.');return result;
}
async function change(f:FormData,work:(session:Awaited<ReturnType<typeof getSession>>,unitId:string,revision:number)=>Promise<unknown>){
 const unitId=String(f.get('unitId')??''),revision=Number(f.get('revision'));let error='';
 try{await work(await getSession(),unitId,revision);}catch(value){
  const t=await getTranslations('rewards.governance.errors');
  if(value instanceof ZodError)error=t('invalid');
  else if(value instanceof RewardError){
   const message=value.message;
   const key=/different Group Rewards/.test(message)?'independent':/changed|Reload|refresh|revision/.test(message)?'stale':/below|lower|reduction/.test(message)?'salary':/evidence|Evidence|file/.test(message)?'evidence':/access|authority|not available|not in your/.test(message)?'authority':/Final|PAT|branch|multiplier|pool/.test(message)?'budget':/confirm|decision|membership|Senior|JG/.test(message)?'decision':/draft|locked|approved/.test(message)?'locked':'invalid';
   error=t(key);
  }else error=publicErrorMessage(value);
 }

 revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');
 redirect(`/rewards/${encodeURIComponent(unitId)}${error?'?error='+encodeURIComponent(error):''}#unit-governance`);
}
export async function unitInputsAction(f:FormData){return change(f,(s,id,rev)=>saveRewardUnitInputs(s,id,rev,{
 forecastCents:scaled(f.get('forecast'),2),actualCents:scaled(f.get('actual'),2),targetCents:scaled(f.get('target'),2),targetMonthsBp:scaled(f.get('targetMonths'),4)??0,
 multiplierBp:scaled(f.get('multiplier'),4),branchRatings:Object.fromEntries([...f.entries()].filter(([key])=>key.startsWith('branch.')).map(([key,value])=>[key.slice(7),String(value)])),
},String(f.get('reason')??'')));}
export async function exemptionAction(f:FormData){return change(f,(s,id,rev)=>proposeRewardExemption(s,id,rev,String(f.get('reason')??'')));}
export async function confirmGovernanceAction(f:FormData){return change(f,(s,id,rev)=>{
 const kind=String(f.get('kind'));if(!['selection','exemption','award'].includes(kind))throw new RewardError('Unknown decision.');
 return confirmRewardGovernance(s,id,rev,kind as 'selection'|'exemption'|'award',String(f.get('entryId')??'')||undefined);
});}
export async function seniorAwardAction(f:FormData){return change(f,async(s,id,rev)=>{
 const evidence=[];let totalBytes=0;
 for(const file of f.getAll('evidence'))if(file instanceof File&&file.size){totalBytes+=file.size;if(totalBytes>Math.min(PROFILE_ATTACHMENT_TOTAL_MAX_BYTES,20*1024*1024))throw new RewardError('Evidence files exceed the total upload limit.');if(file.size>10*1024*1024)throw new RewardError('Evidence files must be at most 10 MB.');evidence.push({name:file.name,mime:file.type,content:Buffer.from(await file.arrayBuffer()).toString('base64')});}
 return saveRewardSeniorAward(s,id,rev,{entryId:String(f.get('entryId')??''),newBasicCents:scaled(f.get('newBasic'),2),incrementBp:scaled(f.get('increment'),2),bonusCents:scaled(f.get('bonus'),2)??0,
 approvalReference:String(f.get('reference')??''),approvalDate:String(f.get('approvalDate')??''),reason:String(f.get('reason')??''),evidence});
});}
