'use client';

import * as React from 'react';
import {useTranslations} from 'next-intl';
import {useRouter} from 'next/navigation';
import {locales,localeNames} from '@/i18n/config';
import {Button,inputCls} from '@/components/ui';
import {HOME_QUICK_ACTIONS,HOME_TASK_KINDS,HOME_TEMPLATE_FIELDS,type HomeQuickAction} from '@/lib/employee-home';
import type {EmployeeHomeConfigurationView} from '@/core/employee-home-configuration';
import {saveHomeConfigurationAction,type HomeConfigurationSaveState} from '@/app/(app)/admin/settings/dashboard/home-actions';

export function HomeConfigurationEditor({initial}:{initial:EmployeeHomeConfigurationView}){
 const t=useTranslations('employeeHome.configuration'),names=useTranslations('employeeHome.templateNames'),quick=useTranslations('employeeHome.quickActions'),task=useTranslations('employeeHome.taskNames');
 const router=useRouter();
 const inFlight=React.useRef(false),errorRef=React.useRef<HTMLParagraphElement|null>(null);
 const submit=React.useCallback(async(state:HomeConfigurationSaveState,data:FormData):Promise<HomeConfigurationSaveState>=>{
  try{const result=await saveHomeConfigurationAction(state,data);inFlight.current=Boolean(result.destination);return result;}
  catch{inFlight.current=false;return {error:t('failed')};}
 },[t]);
 const [state,dispatch,pending]=React.useActionState<HomeConfigurationSaveState,FormData>(submit,{error:null});
 const navigated=React.useRef<HomeConfigurationSaveState|null>(null);
 React.useEffect(()=>{if(state.destination&&navigated.current!==state){navigated.current=state;router.push(state.destination);router.refresh();}},[state,router]);
 React.useEffect(()=>{if(state.error)errorRef.current?.focus();},[state]);
 const [actions,setActions]=React.useState<HomeQuickAction[]>(initial.configuration.quickActions);
 const actionRows=[...actions,...HOME_QUICK_ACTIONS.filter(key=>!actions.includes(key))];
 function move(key:HomeQuickAction,delta:number){setActions(previous=>{const index=previous.indexOf(key),next=index+delta;if(index<0||next<0||next>=previous.length)return previous;const copy=[...previous];[copy[index],copy[next]]=[copy[next],copy[index]];return copy;});}
 return <form method="post"
  onInvalidCapture={event=>{
   if(event.target instanceof HTMLElement){const details=event.target.closest('details');if(details)details.open=true;}
  }}
  onSubmit={event=>{event.preventDefault();if(inFlight.current||state.destination)return;const data=new FormData(event.currentTarget);inFlight.current=true;React.startTransition(()=>dispatch(data));}}
  className="space-y-6">
  {/* Manual dispatch preserves native textarea/select drafts after a refused action; React's form-action
      auto-reset otherwise loses them. POST also keeps these fields out of a URL before hydration. */}
  <input type="hidden" name="companyId" value={initial.companyId}/><input type="hidden" name="audienceRole" value={initial.audienceRole}/><input type="hidden" name="expectedOrdinal" value={initial.ordinal}/>
  {state.error&&<p ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{state.error}</p>}
  <fieldset disabled={pending||Boolean(state.destination)} className="space-y-6">
   <div className="space-y-3"><h3 className="font-semibold">{t('quickTitle')}</h3><p className="max-w-prose text-sm text-muted-foreground">{t('quickHint')}</p>
    <ul className="divide-y rounded-lg border">{actionRows.map(key=><li key={key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-1">
     <label className="flex min-h-11 min-w-0 items-center gap-3 text-sm"><input type="checkbox" name="quickAction" value={key} checked={actions.includes(key)} onChange={event=>{const checked=event.target.checked;setActions(previous=>checked?[...previous,key]:previous.filter(item=>item!==key));}}/>{quick(key)}</label>
     {actions.includes(key)&&<span className="flex gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={actions.indexOf(key)===0} aria-label={t('moveUp',{item:quick(key)})} onClick={()=>move(key,-1)}>↑</Button><Button type="button" variant="outline" className="min-h-11" disabled={actions.indexOf(key)===actions.length-1} aria-label={t('moveDown',{item:quick(key)})} onClick={()=>move(key,1)}>↓</Button></span>}
    </li>)}</ul>
   </div>
   <div className="space-y-3"><h3 className="font-semibold">{t('templatesTitle')}</h3><p className="max-w-prose text-sm text-muted-foreground">{t('templatesHint')}</p>
    {initial.configuration.templates.map(template=><details key={template.key} className="rounded-lg border p-3">
     <summary className="flex min-h-11 cursor-pointer items-center font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{names(template.key)}</summary>
     <div className="mt-3 space-y-4"><div className="flex flex-wrap items-end gap-4">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name={`template.${template.key}.enabled`} defaultChecked={template.enabled}/>{t('enabled')}</label>
      <label className="space-y-1 text-sm"><span className="block">{t('priority')}</span><input className={inputCls+' min-h-11 w-28'} type="number" min={0} max={1000} step={1} required name={`template.${template.key}.priority`} defaultValue={template.priority}/></label>
     </div><p className="text-sm text-muted-foreground">{HOME_TEMPLATE_FIELDS[template.key].length?t('fields',{fields:HOME_TEMPLATE_FIELDS[template.key].map(key=>'{'+key+'}').join(', ')}):t('noFields')}</p>
      <div className="grid gap-4 md:grid-cols-2">{locales.map(locale=><label key={locale} className="min-w-0 space-y-1 text-sm"><span className="block">{localeNames[locale]}</span><textarea className={inputCls+' min-h-24 resize-y'} required rows={3} maxLength={600} lang={locale} name={`template.${template.key}.${locale}`} defaultValue={template.text[locale]}/></label>)}</div>
     </div>
    </details>)}
   </div>
   <div className="space-y-3"><h3 className="font-semibold">{t('effortTitle')}</h3><p className="max-w-prose text-sm text-muted-foreground">{t('effortHint')}</p>
    <div className="grid gap-3 md:grid-cols-2">{HOME_TASK_KINDS.map(kind=><label key={kind} className="flex min-h-11 items-center justify-between gap-3 text-sm"><span>{task(kind)}</span><input type="number" className={inputCls+' min-h-11 w-28 shrink-0'} min={0} max={1440} step={1} name={'effort.'+kind} defaultValue={initial.configuration.effortMinutes[kind]??''}/></label>)}</div>
   </div>
   <div className="space-y-3"><h3 className="font-semibold">{t('sharingTitle')}</h3><p className="max-w-prose text-sm text-muted-foreground">{t('sharingHint')}</p>
    <label className="block space-y-1 text-sm"><span>{t('teamVisibility')}</span><select className={inputCls+' min-h-11'} required name="teamVisibility" defaultValue={initial.configuration.teamVisibility}><option value="off">{t('off')}</option><option value="direct">{t('direct')}</option><option value="department">{t('department')}</option></select></label>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="celebrationsEnabled" defaultChecked={initial.configuration.celebrations.enabled}/>{t('celebrationsEnabled')}</label>
    <label className="block space-y-1 text-sm"><span>{t('celebrationScope')}</span><select className={inputCls+' min-h-11'} required name="celebrationsScope" defaultValue={initial.configuration.celebrations.scope}><option value="direct">{t('direct')}</option><option value="department">{t('department')}</option></select></label>
   </div>
   <label className="block space-y-1 text-sm"><span>{t('reason')}</span><textarea className={inputCls+' min-h-24'} required maxLength={500} rows={3} name="reason"/></label>
   <Button type="submit" className="min-h-11">{pending?t('saving'):t('save')}</Button>
  </fieldset>
 </form>;
}
