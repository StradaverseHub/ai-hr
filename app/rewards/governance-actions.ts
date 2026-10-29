'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { saveRewardUnitInputs, proposeRewardExemption, confirmRewardGovernance, saveRewardSeniorAward } from '@/packs/rewards/service';

/** Decimal input to integer money/rates; never binary multiplication of an HR-entered decimal. */
function scaled(value:FormDataEntryValue|null,places:number):number|null{
 const raw=String(value??'').trim();if(!raw)return null;
 if(!new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(raw))throw new Error('Enter a nonnegative amount with the supported decimal precision.');
 const [whole,fraction='']=raw.split('.'),number=BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
 const result=Number(number);if(!Number.isSafeInteger(result))throw new Error('Amount exceeds the supported limit.');return result;
}
async function change(f:FormData,work:(session:Awaited<ReturnType<typeof getSession>>,unitId:string,revision:number)=>Promise<unknown>){
 const unitId=String(f.get('unitId')??''),revision=Number(f.get('revision'));let error='';
 try{await work(await getSession(),unitId,revision);}catch(value){error=value instanceof Error?value.message:'Could not save this decision.';}
 revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');
 redirect(`/rewards/${encodeURIComponent(unitId)}${error?'?error='+encodeURIComponent(error):''}#unit-governance`);
}
export async function unitInputsAction(f:FormData){return change(f,(s,id,rev)=>saveRewardUnitInputs(s,id,rev,{
 forecastCents:scaled(f.get('forecast'),2),actualCents:scaled(f.get('actual'),2),targetCents:scaled(f.get('target'),2),targetMonthsBp:scaled(f.get('targetMonths'),4)??0,
 multiplierBp:scaled(f.get('multiplier'),4),branchRatings:Object.fromEntries([...f.entries()].filter(([key])=>key.startsWith('branch.')).map(([key,value])=>[key.slice(7),String(value)])),
},String(f.get('reason')??'')));}
export async function exemptionAction(f:FormData){return change(f,(s,id,rev)=>proposeRewardExemption(s,id,rev,String(f.get('reason')??'')));}
export async function confirmGovernanceAction(f:FormData){return change(f,(s,id,rev)=>{
 const kind=String(f.get('kind'));if(!['selection','exemption','award'].includes(kind))throw new Error('Unknown decision.');
 return confirmRewardGovernance(s,id,rev,kind as 'selection'|'exemption'|'award',String(f.get('entryId')??'')||undefined);
});}
export async function seniorAwardAction(f:FormData){return change(f,async(s,id,rev)=>{
 const evidence=[];
 for(const file of f.getAll('evidence'))if(file instanceof File&&file.size){if(file.size>10*1024*1024)throw new Error('Evidence files must be at most 10 MB.');evidence.push({name:file.name,mime:file.type,content:Buffer.from(await file.arrayBuffer()).toString('base64')});}
 return saveRewardSeniorAward(s,id,rev,{entryId:String(f.get('entryId')??''),newBasicCents:scaled(f.get('newBasic'),2),incrementBp:scaled(f.get('increment'),2),bonusCents:scaled(f.get('bonus'),2)??0,
 approvalReference:String(f.get('reference')??''),approvalDate:String(f.get('approvalDate')??''),reason:String(f.get('reason')??''),evidence});
});}
