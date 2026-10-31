'use server';
import {assessmentReminderMessage} from '@/lib/assessment-reminder-message';
import {appOrigin} from '@/lib/real-auth';
import {notificationEmailLocales} from '@/lib/notification-email-model';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getLocale,getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { getSession } from '@/lib/session';
import { publicErrorMessage } from '@/lib/public-error';
import { adminReturnPath } from '@/packs/performance/onehr/admin-sections';
import { getAssessmentReminders,queueAssessmentReminders,saveAssessmentReminderRules,saveAssessmentReminderWords,previewAssessmentReminder } from '@/packs/performance/service';

export async function assessmentReminderAction(form:FormData){
 const ctx=await getSession(),cycleId=z.uuid().parse(form.get('cycleId')),path=adminReturnPath(form.get('returnTo'),cycleId)??`/performance/${cycleId}`,t=await getTranslations('onehr.reminders');
 // An admin page's address may already carry `?sub=`.
 const join=path.includes('?')?'&':'?';
 let toast='';
 try{
  await getAssessmentReminders(ctx,cycleId);
  const action=z.enum(['save','words','reset-words','manual','dry']).parse(form.get('action'));
  if(action==='save'){
   await saveAssessmentReminderRules(ctx,{enabled:form.has('enabled'),onOpen:form.has('onOpen'),daysBefore:String(form.get('daysBefore')??'').split(',').map(s=>s.trim()).filter(Boolean).map(Number),everyDays:Number(form.get('everyDays')),sendTime:String(form.get('sendTime')??'')});
   toast=t('saved');
  }else if(action==='words'||action==='reset-words'){
   await saveAssessmentReminderWords(ctx,action==='reset-words'?null:{subject:String(form.get('subject')??''),opening:String(form.get('opening')??'')});toast=t('wordsSaved');
  }else{
   const result=await queueAssessmentReminders(ctx,cycleId,action,Number(form.get('limit')??0));
   toast=t('result',{queued:result.queued,skipped:result.skipped,dry:result.dry});
  }
 }catch(error){redirect(`${path}${join}error=${encodeURIComponent(publicErrorMessage(error))}`);}
 revalidatePath(path.split('?')[0]);revalidatePath(`/performance/${cycleId}`);redirect(`${path}${join}toast=${encodeURIComponent(toast)}`);
}

export async function assessmentReminderPreviewAction(form:FormData){
 form.set('action','dry');return assessmentReminderAction(form);
}

export async function assessmentReminderPersonPreviewAction(cycleId:string,employeeCode:string){
 try{
  const ctx=await getSession(),preview=await previewAssessmentReminder(ctx,cycleId,employeeCode),language=preview.mode==='full'?preview.locale:await getLocale(),locale=notificationEmailLocales.find(locale=>locale===language)??'en',origin=appOrigin();
  return {result:{employee:preview.employee,employeeCode:preview.employeeCode,eligible:preview.eligible,mode:preview.mode,locale,message:preview.mail.tasks.length?assessmentReminderMessage(preview.mail,locale,origin?new URL('/me/performance',origin).href:'/me/performance',preview.design):null}};
 }catch(error){return {error:publicErrorMessage(error)};}
}
