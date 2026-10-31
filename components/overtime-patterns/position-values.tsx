'use client';
import {useEffect,useState,useRef} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import {overtimePositionChoicesAction} from '@/app/(app)/admin/attendance/settings/overtime-patterns/actions';
import type {OvertimeChoice} from './rule-controls';
/** Catalogue paging changes available choices only; the saved selected IDs remain authoritative. */
export function OvertimePositionValues({options,selected,onChange}:{options:OvertimeChoice[];selected:string[];onChange:(ids:string[])=>void}){
 const t=useTranslations('overtimePatterns');
 const [items,setItems]=useState(options),[search,setSearch]=useState(''),[cursor,setCursor]=useState<string|null>(options.length===500?options.at(-1)!.id:null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const request=useRef(0),selectedRef=useRef(selected);selectedRef.current=selected;
 // Resolve saved selections beyond the first catalogue page without changing their identities.
 const missing=selected.filter(id=>!items.some(item=>item.id===id)).join(',');
 useEffect(()=>{if(!missing)return;let active=true;const ids=missing.split(',');overtimePositionChoicesAction({selectedIds:ids}).then(result=>{if(active&&result.ok)setItems(previous=>[...new Map([...previous,...result.value.items].map(item=>[item.id,item])).values()]);}).catch(()=>{if(active)setError('system');});return()=>{active=false;};},[missing]);
 async function load(more=false){
  const token=++request.current;setBusy(true);setError(null);
  try{const result=await overtimePositionChoicesAction({search,cursor:more?cursor??undefined:undefined,selectedIds:selectedRef.current});if(token!==request.current)return;if(!result.ok){setError(result.code);return;}setItems(previous=>[...new Map([...(more?previous:previous.filter(item=>selectedRef.current.includes(item.id))),...result.value.items].map(item=>[item.id,item])).values()]);setCursor(result.value.nextCursor);}catch{if(token===request.current)setError('system');}finally{if(token===request.current)setBusy(false);}
 }
 return <div className="space-y-3"><div className="flex flex-wrap items-end gap-2"><Field label={t('positionSearch')}><input className={inputCls} maxLength={160} value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();load();}}}/></Field><button type="button" disabled={busy} className="min-h-10 rounded-lg border px-3 py-2 text-sm" onClick={()=>load()}>{t(busy?'working':'search')}</button>{cursor&&<button type="button" disabled={busy} className="min-h-10 rounded-lg border px-3 py-2 text-sm" onClick={()=>load(true)}>{t('loadMorePositions')}</button>}</div><Field label={t('values')}><select className={`${inputCls} min-h-24`} multiple value={selected} onChange={event=>onChange(Array.from(event.target.selectedOptions,option=>option.value))}>{items.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}{selected.filter(id=>!items.some(item=>item.id===id)).map(id=><option key={id} value={id}>{t('unavailableReference',{id})}</option>)}</select></Field>{error&&<p role="alert" className="text-sm text-destructive">{t(`errors.${error}`)}</p>}</div>;
}
