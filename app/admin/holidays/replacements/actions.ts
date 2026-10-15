'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {publicErrorMessage} from '@/lib/public-error';
import {adjustReplacementHoliday,saveReplacementHolidayPolicy} from '@/core/holiday-replacements';
import type {ReplacementPolicy} from '@/lib/holiday-replacement';
const route='/admin/holidays/replacements';
function back(companyId:string,field:string,message:string,receipt=''):never{
 const query=new URLSearchParams({company:companyId,[field]:message});
 if(/^[a-f0-9]{32}$/.test(receipt))query.set('saveAck',receipt);
 revalidatePath(route);revalidatePath('/attendance/my-roster');redirect(route+'?'+query.toString());
}
export async function saveReplacementPolicyAction(fd:FormData){
 const ctx=await getSession(),companyId=String(fd.get('companyId')??'');
 try{await saveReplacementHolidayPolicy(ctx,{companyId,effectiveFrom:String(fd.get('effectiveFrom')??''),regime:String(fd.get('regime')??'') as ReplacementPolicy['regime'],confirmed:fd.get('confirmed')==='1',restMode:String(fd.get('restMode')??'') as ReplacementPolicy['restMode'],halfEligible:fd.get('halfEligible')==='1',searchDays:Number(fd.get('searchDays')),reason:String(fd.get('reason')??'')});}
 catch(error){back(companyId,'error',publicErrorMessage(error));}
 const t=await getTranslations('replacementHoliday');back(companyId,'toast',t('saved'),String(fd.get('__attendanceSaveNonce')??''));
}
export async function adjustReplacementAction(fd:FormData){
 const ctx=await getSession(),companyId=String(fd.get('companyId')??''),intent=String(fd.get('intent')??'adjust');
 try{await adjustReplacementHoliday(ctx,{allocationId:String(fd.get('allocationId')??''),date:intent==='waive'?null:String(fd.get('date')??'')||null,reason:String(fd.get('reason')??''),policyId:String(fd.get('policyId')??'')||null,releaseToAutomatic:intent==='release'});}
 catch(error){back(companyId,'error',publicErrorMessage(error));}
 const t=await getTranslations('replacementHoliday');back(companyId,'toast',t('saved'),String(fd.get('__attendanceSaveNonce')??''));
}
