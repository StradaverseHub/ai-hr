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
  :kind==='reopen'?{kind,reason:String(form.get('reason')??'')}:{kind,basis:String(form.get('basis')??''),reason:String(form.get('reason')??''),summaryDigest:String(form.get('summaryDigest')??'')};
 let error:string|undefined;
 try{await changeRewardPreparation(await getBrowserCommandSession(),unitId,revision,payload);}
 catch(value){
  const t=await getTranslations('rewardsPreparation');
  const message=publicErrorMessage(value);
  error=/Review the summary again/.test(message)?t('summaryChanged'):/changed in another|revision/.test(message)?t('stale')
   :/Complete|confirm every|expected release/.test(message)?t('incomplete'):/locked|controlled change/.test(message)?t('lockedError'):t('saveFailed');
 }
 revalidatePath('/rewards','layout');revalidatePath('/admin/rewards','layout');
 redirect(`/rewards/${encodeURIComponent(unitId)}/setup${error?'?error='+encodeURIComponent(error):''}`);
}
