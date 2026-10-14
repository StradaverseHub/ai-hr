'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { getAssessmentReminders,queueAssessmentReminders,saveAssessmentReminderRules } from '@/packs/performance/service';

export async function assessmentReminderAction(form:FormData){
 const ctx=await getSession(),cycleId=z.uuid().parse(form.get('cycleId')),path=`/performance/${cycleId}`,t=await getTranslations('onehr.reminders');
 let toast='';
 try{
  await getAssessmentReminders(ctx,cycleId);
  const action=z.enum(['save','manual','dry']).parse(form.get('action'));
  if(action==='save'){
   await saveAssessmentReminderRules(ctx,{enabled:form.has('enabled'),onOpen:form.has('onOpen'),daysBefore:String(form.get('daysBefore')??'').split(',').map(s=>s.trim()).filter(Boolean).map(Number),everyDays:Number(form.get('everyDays')),sendTime:String(form.get('sendTime')??'')});
   toast=t('saved');
  }else{
   const result=await queueAssessmentReminders(ctx,cycleId,action,Number(form.get('limit')??1000));
   toast=t('result',{queued:result.queued,skipped:result.skipped,dry:result.dry});
  }
 }catch(error){redirect(`${path}?error=${encodeURIComponent(publicErrorMessage(error))}`);}
 revalidatePath(path);redirect(`${path}?toast=${encodeURIComponent(toast)}`);
}
