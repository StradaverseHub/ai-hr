'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { Button, inputCls } from '@/components/ui';
import { searchAllowanceEmployees } from '@/app/(app)/admin/attendance-allowance/actions';
import type { AllowanceEmployeeOption } from '@/packs/attendance/service';

/** Included IDs and checked rows live independently of each search result page. */
export function AllowanceEmployeePicker({ companyId, values, onChange }: {
  companyId: string; values: string[]; onChange: (values: string[]) => void;
}) {
  const t = useTranslations('allowanceV4');
  const [checked, setChecked] = useState<{available:string[];included:string[]}>({available:[],included:[]});
  const [notice, setNotice] = useState('');
  const move = (side:'available'|'included') => {
    const ids = checked[side];
    const next = side === 'available' ? [...new Set([...values,...ids])] : values.filter(id => !ids.includes(id));
    if (next.length > 2000) {setNotice(t('limit'));return;}
    onChange(next);setChecked(previous=>({...previous,[side]:[]}));setNotice(t('includedCount',{count:next.length}));
  };
  return <div className="space-y-3">
    <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      <EmployeePane key={`${companyId}:available`} side="available" companyId={companyId} included={values} checked={checked.available} onChecked={available=>setChecked(previous=>({...previous,available}))}/>
      <div className="flex flex-wrap items-center justify-center gap-2 lg:flex-col">
        <Button type="button" variant="secondary" disabled={!checked.available.length} onClick={()=>move('available')} className="min-h-11"><ArrowRight className="size-4" aria-hidden/>{t('includeChecked',{count:checked.available.length})}</Button>
        <Button type="button" variant="secondary" disabled={!checked.included.length} onClick={()=>move('included')} className="min-h-11"><ArrowLeft className="size-4" aria-hidden/>{t('removeChecked',{count:checked.included.length})}</Button>
      </div>
      <EmployeePane key={`${companyId}:included`} side="included" companyId={companyId} included={values} checked={checked.included} onChecked={included=>setChecked(previous=>({...previous,included}))}/>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p>{t('includedCount',{count:values.length})}</p><Button type="button" variant="ghost" disabled={!values.length} onClick={()=>{onChange([]);setChecked({available:[],included:[]});setNotice(t('includedCount',{count:0}));}}>{t('clearIncluded')}</Button></div>
    <p className="text-xs text-muted-foreground">{t('selectionHelp')}</p><p role="status" aria-live="polite" className="text-sm">{notice}</p>
  </div>;
}
function EmployeePane({side,companyId,included,checked,onChecked}:{side:'available'|'included';companyId:string;included:string[];checked:string[];onChecked:(ids:string[])=>void}) {
  const t=useTranslations('allowanceV4');
  const [query,setQuery]=useState(''),[page,setPage]=useState(1);
  const [result,setResult]=useState<{rows:AllowanceEmployeeOption[];total:number;unavailable:string[]}|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(false),[retry,setRetry]=useState(0);
  const selectionKey=JSON.stringify(included);
  useEffect(()=>{
    let active=true;setLoading(true);setError(false);
    const timeout=setTimeout(()=>{searchAllowanceEmployees({companyId,query,page,side,included:JSON.parse(selectionKey)}).then(value=>{if(active){setResult(value);setLoading(false);}}).catch(()=>{if(active){setError(true);setLoading(false);}});},200);
    return ()=>{active=false;clearTimeout(timeout);};
  },[companyId,query,page,side,selectionKey,retry]);
  const rows=result?.rows??[],allVisible=rows.length>0&&rows.every(row=>checked.includes(row.id));
  const toggle=(id:string)=>onChecked(checked.includes(id)?checked.filter(value=>value!==id):[...checked,id]);
  return <section className="min-w-0 space-y-3 rounded-xl border border-border bg-background p-3" aria-label={t(side)} aria-busy={loading}>
    <h3 className="font-semibold">{t(side)} <span className="font-normal text-muted-foreground">({side==='included'?included.length:result?.total??'—'})</span></h3>
    <label className="relative block"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden/><input type="search" value={query} className={`${inputCls} pl-9`} aria-label={t('searchSide',{side:t(side)})} placeholder={t('search')} onChange={event=>{setQuery(event.target.value);setPage(1);}}/></label>
    {error?<div role="alert" className="space-y-2 text-sm"><p>{t('loadError')}</p><Button type="button" variant="secondary" onClick={()=>setRetry(value=>value+1)}>{t('retry')}</Button></div>:<>
      <label className="flex min-h-11 items-center gap-2 text-xs font-medium"><input type="checkbox" disabled={loading||!rows.length} checked={allVisible} onChange={()=>onChecked(allVisible?checked.filter(id=>!rows.some(row=>row.id===id)):[...new Set([...checked,...rows.map(row=>row.id)])])}/>{t('selectVisible',{count:rows.length})}</label>
      <div className="min-h-48 divide-y divide-border">
        {loading?<p role="status" className="py-5 text-sm text-muted-foreground">{t('loading')}</p>:!rows.length?<p className="py-5 text-sm text-muted-foreground">{t('empty')}</p>:rows.map(row=><label key={row.id} className="flex cursor-pointer items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1" checked={checked.includes(row.id)} onChange={()=>toggle(row.id)}/><span className="min-w-0"><span className="block font-medium">{row.name}</span><span className="block break-words text-xs text-muted-foreground">{[row.code??t('noCode'),row.department,row.businessUnit].filter(Boolean).join(' · ')}</span></span></label>)}
      </div>
      {!!result?.unavailable.length&&<div className="space-y-2 border-t border-border pt-3"><p className="text-xs text-amber-700 dark:text-amber-300">{t('unavailable')}</p>{result.unavailable.slice(0,25).map(id=><label key={id} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={checked.includes(id)} onChange={()=>toggle(id)}/><span className="break-all">{id}</span></label>)}{result.unavailable.length>25&&<p className="text-xs">{t('unavailableMore',{count:result.unavailable.length-25})}</p>}</div>}
      <div className="flex items-center justify-between gap-2"><Button type="button" variant="ghost" disabled={loading||page===1} onClick={()=>setPage(value=>value-1)}>{t('previous')}</Button><span className="text-xs tabular-nums">{t('page',{page})}</span><Button type="button" variant="ghost" disabled={loading||page*25>=(result?.total??0)} onClick={()=>setPage(value=>value+1)}>{t('next')}</Button></div>
    </>}
  </section>;
}
