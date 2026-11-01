'use client';
import {useActionState,useState} from 'react';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {configureRunnerAction} from './actions';
import type {RunnerStatus} from '@/lib/runner-control-model';
export function RunnerControls({runner,frequency}:{runner:RunnerStatus;frequency:string}) {
 const t=useTranslations('runnerControl');
 const [state,action,pending]=useActionState(configureRunnerAction,{ok:false,error:null});
 const [edit,setEdit]=useState(false);
 const editable=runner.managed&&runner.installed&&!runner.hold;
 if(!editable)return null;
 return <details className="mt-3 border-t border-border pt-3">
  <summary className="cursor-pointer text-sm font-medium text-primary">{t('configure')}</summary>
  <form action={action} className="mt-3 space-y-3">
   <input type="hidden" name="id" value={runner.id}/><input type="hidden" name="revision" value={runner.revision}/>
   <input type="hidden" name="scheduleType" value={edit?(frequency==='interval'?'interval':'time'):'unchanged'}/>
   <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" value="true" defaultChecked={runner.enabled}/>{t('enabled')}</label>
   <input type="hidden" name="enabled" value="false"/>
   {frequency!=='continuous'&&<>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit} onChange={event=>setEdit(event.target.checked)} disabled={runner.running}/>{t('editSchedule')}</label>
    {edit&&(frequency==='interval'?<label className="block max-w-xs text-sm">{t('minutes')}<Input className="mt-1" name="minutes" type="number" min={1} max={1440} required/></label>:<label className="block max-w-xs text-sm">{t('time')}<Input className="mt-1" name="time" type="time" required/></label>)}
    {edit&&frequency==='monthly'&&<p className="text-sm text-muted-foreground">{t('monthlyRule')}</p>}
    {edit&&frequency==='yearly'&&<p className="text-sm text-muted-foreground">{t('yearlyRule')}</p>}
   </>}
   <p className="max-w-prose text-sm text-muted-foreground">{t('effectNote')}</p>
   <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1"/>{t('confirm')}</label>
   <Button type="submit" size="sm" disabled={pending}>{pending?t('saving'):t('save')}</Button>
   <p aria-live="polite" role="status" className="text-sm">{state.error?t('saveFailed'):state.ok?t('saved'):''}</p>
  </form>
 </details>;
}
