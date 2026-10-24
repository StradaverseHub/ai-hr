'use client';
import {useId,useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
export type ScheduleShiftChoice={id:string;name:string;code:string|null;startTime:string|null;endTime:string|null;archived:boolean;available:boolean};
export function ScheduleShiftPicker({shifts,selected,onChange,editing,disabled=false}:{shifts:readonly ScheduleShiftChoice[];selected:readonly string[];onChange:(ids:string[])=>void;editing:boolean;disabled?:boolean}){
 const t=useTranslations('admin.rotation'),searchId=useId(),[search,setSearch]=useState('');
 const selection=new Set(selected),query=search.trim().toLocaleLowerCase();
 const available=shifts.filter(shift=>!shift.archived&&shift.available),history=shifts.filter(shift=>selection.has(shift.id)&&(shift.archived||!shift.available));
 const visible=available.filter(shift=>!query||`${shift.code??''} ${shift.name}`.toLocaleLowerCase().includes(query));
 const label=(shift:ScheduleShiftChoice)=>`${shift.code?shift.code+' · ':''}${shift.name}`;
 const toggle=(id:string,checked:boolean)=>onChange(checked?[...new Set([...selected,id])]:selected.filter(value=>value!==id));
 return <div className="space-y-3">
  {/* Filtering never changes the submission set. Checkboxes are presentation; these carry all selections. */}
  {selected.map(id=><input key={id} type="hidden" name="allowedShiftIds" value={id}/>)}
  {editing&&<><label htmlFor={searchId} className="block text-sm font-medium">{t('poolSearch')}<input id={searchId} type="search" autoComplete="off" className={inputCls+' mt-1'} value={search} onChange={event=>setSearch(event.target.value)} disabled={disabled}/></label>
   <div className="flex flex-wrap items-center justify-between gap-2">
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{t('poolCounts',{selected:selected.length,visible:visible.length,total:available.length})}</p>
    <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled||!visible.some(shift=>!selection.has(shift.id))} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50" onClick={()=>onChange([...new Set([...selected,...visible.map(shift=>shift.id)])])}>{t('poolSelectResults')}</button>
     <button type="button" disabled={disabled||!selected.length} className="rounded border border-border px-3 py-1.5 text-xs disabled:opacity-50" onClick={()=>onChange([])}>{t('poolClearAll')}</button></div>
   </div></>}
  <div role="group" aria-label={t('poolActiveChoices')} className="grid max-h-72 gap-2 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
   {visible.filter(shift=>editing||selection.has(shift.id)).map(shift=><label key={shift.id} className={'flex items-start gap-2 rounded border p-2 text-sm '+(selection.has(shift.id)?'border-primary/40 bg-primary/5':'border-border')}>
    <input type="checkbox" checked={selection.has(shift.id)} disabled={!editing||disabled} onChange={event=>toggle(shift.id,event.target.checked)}/>
    <span>{label(shift)}<span className="block text-xs text-muted-foreground">{shift.startTime?.slice(0,5)??'—'}–{shift.endTime?.slice(0,5)??'—'}</span></span>
   </label>)}
   {(!visible.length||!editing&&!visible.some(shift=>selection.has(shift.id)))&&<p className="p-2 text-sm text-muted-foreground sm:col-span-2">{editing?t('poolNoMatches'):t('poolNoneSelected')}</p>}
  </div>
  {history.length>0&&<section aria-label={t('poolHistorical')} className="rounded-lg border border-border p-3"><h4 className="text-sm font-medium">{t('poolHistorical')}</h4><p className="mt-1 text-xs text-muted-foreground">{t('poolHistoricalHelp')}</p>
   <ul className="mt-2 space-y-2">{history.map(shift=><li key={shift.id} className="flex items-center justify-between gap-3 text-sm"><span>{label(shift)} · {shift.archived?t('archived'):t('otherGroup')}</span>{editing&&<button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={disabled} onClick={()=>toggle(shift.id,false)} aria-label={t('poolRemoveNamed',{shift:label(shift)})}>{t('poolRemove')}</button>}</li>)}</ul>
  </section>}
 </div>;
}
