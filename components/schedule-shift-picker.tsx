'use client';

import {useId,useState} from 'react';
import {useTranslations} from 'next-intl';
import {btnPrimary,inputCls} from '@/components/ui';
import {useSchedulePoolDraft} from './schedule-pool-draft';

export type ScheduleShiftChoice = {
  id:string; name:string; code:string|null; startTime?:string|null; endTime?:string|null;
  archived:boolean; available:boolean;
};

export function ScheduleDraftShiftPicker({shifts, disabled, base = false}: {
  shifts:readonly ScheduleShiftChoice[]; disabled?:boolean; base?:boolean;
}) {
  const draft = useSchedulePoolDraft();
  if (!draft) return null;
  return <>
    {base && <input type="hidden" name="expectedShiftIds" data-attendance-guard-meta value={JSON.stringify(draft.saved)}/>}
    <ScheduleShiftPicker shifts={shifts} selected={draft.selected} onChange={draft.setSelected}
      editing disabled={disabled} submitSelection={base}/>
  </>;
}

export function ScheduleShiftPicker({shifts,selected,onChange,editing,disabled=false,submitSelection=true}:{
  shifts:readonly ScheduleShiftChoice[]; selected:readonly string[]; onChange:(ids:string[])=>void;
  editing:boolean; disabled?:boolean; submitSelection?:boolean;
}) {
  const t=useTranslations('scheduleGroupEditor');
  const tr=useTranslations('admin.rotation');
  const id=useId();
  const [searches,setSearches]=useState({excluded:'',included:''});
  const [marked,setMarked]=useState<string[]>([]);
  const selection=new Set(selected);
  const active=shifts.filter(shift=>!shift.archived&&shift.available);
  const history=shifts.filter(shift=>selection.has(shift.id)&&(shift.archived||!shift.available));
  const columns=(['excluded','included'] as const).map(side=>{
    const rows=active.filter(shift=>selection.has(shift.id)===(side==='included'));
    const query=searches[side].trim().toLocaleLowerCase();
    const matches=rows.filter(shift=>!query||`${shift.code??''} ${shift.name}`.toLocaleLowerCase().includes(query));
    const markedIds=rows.filter(row=>marked.includes(row.id)).map(row=>row.id);
    return {side,rows,matches,markedIds};
  });
  const label=(shift:ScheduleShiftChoice)=>shift.code?`${shift.code} · ${shift.name}`:shift.name;
  const move=(ids:string[],include:boolean)=>{
    if(!ids.length)return;
    onChange(include?[...new Set([...selected,...ids])]:selected.filter(value=>!ids.includes(value)));
    setMarked(old=>old.filter(value=>!ids.includes(value)));
  };
  return <div className="space-y-4">
    {submitSelection&&selected.map(value=><input key={value} type="hidden" name="allowedShiftIds" value={value}/>)}
    <div className={editing?'grid gap-3 sm:grid-cols-2':'grid gap-3'}>
      {columns.filter(column=>editing||column.side==='included').map(({side,rows,matches})=><section key={side}
        aria-labelledby={id+side} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
        <h4 id={id+side} className="font-semibold">{t(side)} <span className="text-sm font-normal text-muted-foreground">· {t('shiftCount',{count:rows.length})}</span></h4>
        {editing&&<input type="search" autoComplete="off" aria-label={t(side==='excluded'?'searchExcluded':'searchIncluded')}
          placeholder={t(side==='excluded'?'searchExcluded':'searchIncluded')} value={searches[side]} className={inputCls}
          onChange={event=>setSearches({...searches,[side]:event.target.value})} disabled={disabled}/>}
        <ul className="max-h-52 divide-y divide-border overflow-y-auto">
          {matches.map(shift=><li key={shift.id} className="py-2 text-sm">{editing
            ? <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 accent-primary" checked={marked.includes(shift.id)} disabled={disabled}
                onChange={event=>setMarked(event.target.checked?[...marked,shift.id]:marked.filter(value=>value!==shift.id))}/>
              <span>{label(shift)}</span>
            </label>
            : <span>{label(shift)}</span>}</li>)}
        </ul>
        {!matches.length&&<p className="text-sm text-muted-foreground">{rows.length?t('noShiftMatches'):t('noShifts')}</p>}
      </section>)}
    </div>
    {editing&&<div className="flex flex-wrap gap-2">
      <button type="button" className={btnPrimary+' disabled:opacity-50'} disabled={disabled||!columns[0].markedIds.length}
        onClick={()=>move(columns[0].markedIds,true)}>{t('includeMarked',{count:columns[0].markedIds.length})}</button>
      <button type="button" className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50"
        disabled={disabled||!columns[1].markedIds.length} onClick={()=>move(columns[1].markedIds,false)}>
        {t('excludeMarked',{count:columns[1].markedIds.length})}</button>
    </div>}
    {history.length>0&&<section aria-label={tr('poolHistorical')} className="rounded-lg border border-border p-3">
      <h4 className="text-sm font-medium">{tr('poolHistorical')}</h4>
      <p className="mt-1 text-xs text-muted-foreground">{tr('poolHistoricalHelp')}</p>
      <ul className="mt-2 space-y-2">{history.map(shift=><li key={shift.id} className="flex items-center justify-between gap-3 text-sm">
        <span>{label(shift)} · {shift.archived?tr('archived'):tr('otherGroup')}</span>
        {editing&&<button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
          disabled={disabled} onClick={()=>move([shift.id],false)} aria-label={tr('poolRemoveNamed',{shift:label(shift)})}>
          {tr('poolRemove')}</button>}
      </li>)}</ul>
    </section>}
  </div>;
}
