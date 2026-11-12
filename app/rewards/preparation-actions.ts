'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getBrowserCommandSession } from '@/lib/session';
import { changeRewardPreparation } from '@/packs/rewards/service';
import { publicErrorMessage } from '@/lib/public-error';

export async function preparationAction(form:FormData){
 const unitId=String(form.get('unitId')??'');
 const revision=Number(form.get('revision'));
 const kind=String(form.get('kind')??'');
 const payload=kind==='expected'?{kind,date:String(form.get('expectedRelease')??'')}
  :kind==='confirm'?{kind,step:String(form.get('step')??''),basis:String(form.get('basis')??'')}
  :kind==='reopen'?{kind,reason:String(form.get('reason')??'')}:{kind,basis:String(form.get('basis')??'')};
 let error:string|undefined;
 try{await changeRewardPreparation(await getBrowserCommandSession(),unitId,revision,payload);}
 catch(value){
  const t=await getTranslations('rewardsPreparation');
  const message=publicErrorMessage(value);
  error=/different Group Rewards/.test(message)?t('independent'):/changed in another|revision/.test(message)?t('stale')
   :/Complete|confirm every|expected release/.test(message)?t('incomplete'):/locked|controlled change/.test(message)?t('lockedError'):t('saveFailed');
 }
 revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');
 // 70d5e7c5: set-up lives in Configuration › Review Set-up; return to the step that was open.
 const step=String(form.get('returnStep')??'');
 const query=new URLSearchParams({...(/^[a-z]{1,20}$/.test(step)?{step}:{}),...(error?{error}:{})}).toString();
 redirect(`/admin/rewards/review-setup/${encodeURIComponent(unitId)}${query?'?'+query:''}`);
}
