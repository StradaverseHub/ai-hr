import Link from 'next/link';
import {ReminderPersonPreview} from './reminder-person-preview';
import { getLocale,getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { getAssessmentReminders } from '@/packs/performance/service';
import { Button,Card,Field,inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { assessmentReminderAction,assessmentReminderPreviewAction } from '../assessment-reminder-actions';

/** `returnTo` (D-P1-32 PT-X4): the admin page each save comes back to; without it, the cycle page. */
export async function AssessmentReminderAdmin({cycleId,returnTo}:{cycleId:string;returnTo?:string}){
 const [ctx,t,locale]=await Promise.all([getSession(),getTranslations('onehr.reminders'),getLocale()]);const v=await getAssessmentReminders(ctx,cycleId);
 const back=returnTo?<input type="hidden" name="returnTo" value={returnTo}/>:null;
 const date=(instant:string)=>new Intl.DateTimeFormat(locale,{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(instant));
 return <Card className="space-y-4 p-5">
  <h2 className="font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('help')}</p>
  <div className="flex flex-wrap gap-4 text-sm"><span>{t('waiting',{count:v.waiting})}</span><span>{t('eligible',{count:v.mailEligible})}</span></div>
  <p className="text-sm">{v.next?t('next',{day:v.next.day}):t('noNext')}</p>
  <form action={assessmentReminderAction} className="space-y-3"><input type="hidden" name="cycleId" value={cycleId}/>{back}<input type="hidden" name="action" value="save"/>
   <fieldset disabled={!v.mayWrite} className="grid gap-3 sm:grid-cols-2">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={v.rules.enabled}/>{t('enabled')}</label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="onOpen" defaultChecked={v.rules.onOpen}/>{t('onOpen')}</label>
    <Field label={t('daysBefore')}><input name="daysBefore" maxLength={250} defaultValue={v.rules.daysBefore.join(', ')} className={inputCls}/></Field>
    <Field label={t('everyDays')}><input name="everyDays" type="number" min="0" max="30" required defaultValue={v.rules.everyDays} className={inputCls}/></Field>
    <Field label={t('sendTime')}><input name="sendTime" type="time" required defaultValue={v.rules.sendTime} className={inputCls}/></Field>
    {v.mayWrite?<Button type="submit" variant="secondary" className="self-end">{t('save')}</Button>:<p className="text-sm text-muted-foreground">{t('readonly')}</p>}
   </fieldset>
  </form>
  {v.mayWrite&&<p className="text-sm"><Link href="/admin/settings/email-templates" className="text-primary underline">{t('words')}</Link></p>}
  <ReminderPersonPreview cycleId={cycleId}/>
  <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>
  <form action={assessmentReminderAction} className="space-y-3"><input type="hidden" name="cycleId" value={cycleId}/>{back}<input type="hidden" name="action" value="manual"/>
   <Field label={t('limit')}><input name="limit" type="number" min="0" max="100000" required defaultValue={0} className={inputCls}/></Field>
   <div className="flex flex-wrap gap-3">
    <Button type="submit" formAction={assessmentReminderPreviewAction} variant="outline" disabled={!v.waiting}>{t('preview')}</Button>
    <ConfirmSubmit variant="secondary" description={t('confirm')} disabled={!v.mailEligible}>{t('send')}</ConfirmSubmit>
   </div>
  </form>
  {!!v.runs.length&&<div className="space-y-2"><h3 className="text-sm font-semibold">{t('runs')}</h3><ul className="space-y-2 text-sm">{v.runs.map(run=><li key={run.id} className="rounded-lg border border-border p-3"><p>{date(run.createdAt)}</p><p className="text-muted-foreground">{t('sent')}: {run.sent} · {t('failed')}: {run.failed} · {t('pending')}: {run.pending} · {t('skipped')}: {run.skipped} · {t('dry')}: {run.dry}</p></li>)}</ul></div>}
 </Card>;
}
