'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useFormatter,useTranslations} from 'next-intl';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {formatMoney} from '@/lib/money';
import type {TaxBasisPreview,TaxBasisSelection} from '@/lib/payroll-tax-basis';
import {previewTaxBasisAction,confirmTaxBasisAction} from './actions';
import {TaxBasisResults} from './results';

export type TaxBasisOptions={companies:{id:string;name:string}[];employees:{id:string;companyId:string;employeeNo:string;name:string}[];years:number[];canRecalculate:boolean};
const input='mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const button='inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const primary=button+' border-primary bg-primary text-primary-foreground hover:bg-primary/90';

export function TaxBasisWorkflow({options,initialSelection}:{options:TaxBasisOptions;initialSelection?:TaxBasisSelection}){
  const t=useTranslations('payrollTaxBasis'),format=useFormatter(),router=useRouter();
  const [companyId,setCompanyId]=useState(initialSelection?.companyId??options.companies[0]?.id??'');
  const [year,setYear]=useState(initialSelection?.year??options.years[0]??0);
  const [upToMonth,setUpToMonth]=useState(initialSelection?.upToMonth??12);
  const [all,setAll]=useState(initialSelection?.employmentIds==null);
  const [selected,setSelected]=useState<string[]>(initialSelection?.employmentIds??[]);
  const [search,setSearch]=useState('');
  const [preview,setPreview]=useState<TaxBasisPreview|null>(null);
  const [busy,setBusy]=useState<'preview'|'confirm'|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [confirmOpen,setConfirmOpen]=useState(false);
  const [acknowledged,setAcknowledged]=useState(false);
  const [employeePage,setEmployeePage]=useState(0);
  const employees=options.employees.filter(employee=>employee.companyId===companyId);
  const matching=employees.filter(employee=>(employee.employeeNo+' '+employee.name).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages=Math.max(1,Math.ceil(matching.length/30));
  const eligible=preview?.employees.filter(employee=>employee.status==='ready')??[];
  function invalidate(){setPreview(null);setError(null);setConfirmOpen(false);setAcknowledged(false);}
  function toggleEmployee(id:string){invalidate();setSelected(values=>values.includes(id)?values.filter(value=>value!==id):[...values,id]);}
  async function generatePreview(){
    setPreview(null);setError(null);setBusy('preview');
    try{
      const result=await previewTaxBasisAction({companyId,year,upToMonth,employmentIds:all?null:selected});
      if(result.ok)setPreview(result.preview);else setError(result.error??t('unexpectedError'));
    }catch{setError(t('unexpectedError'));}finally{setBusy(null);}
  }
  async function confirm(){
    if(!preview||!acknowledged||busy)return;
    setBusy('confirm');setError(null);
    try{
      const result=await confirmTaxBasisAction({previewId:preview.previewId,previewHash:preview.previewHash});
      if(result.ok){setConfirmOpen(false);setPreview(null);router.push('/payroll/income-tax-recalculation/'+result.result.id);router.refresh();}
      else{setError(result.error??t('unexpectedError'));setPreview(null);setConfirmOpen(false);}
    }catch{setError(t('unexpectedError'));setConfirmOpen(false);setPreview(null);}finally{setBusy(null);setAcknowledged(false);}
  }
  const money=(value:number|null)=>value===null?t('unavailable'):formatMoney(value,'MYR');
  if(options.companies.length===0||options.years.length===0)return <section className="rounded-xl border p-6"><p className="text-sm text-muted-foreground">{t('noHistoryAvailable')}</p></section>;
  return <div className="space-y-6">
    {!options.canRecalculate&&<p className="rounded-lg border p-4 text-sm text-muted-foreground">{t('readOnly')}</p>}
    {initialSelection&&<p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">{t('retryHint')}</p>}
    <section className="space-y-5 rounded-xl border p-5" aria-labelledby="tax-basis-period-title">
      <fieldset disabled={busy!==null||!options.canRecalculate} className="space-y-5 disabled:opacity-70">
        <legend id="tax-basis-period-title" className="font-semibold">{t('recalculationPeriod')}</legend>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="text-sm font-medium" htmlFor="tax-company">{t('company')}<select id="tax-company" className={input} value={companyId} onChange={event=>{invalidate();setCompanyId(event.target.value);setSelected([]);setSearch('');setEmployeePage(0);}}>{options.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
          <label className="text-sm font-medium" htmlFor="tax-year">{t('year')}<select id="tax-year" className={input} value={year} onChange={event=>{invalidate();setYear(Number(event.target.value));}}>{options.years.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
          <label className="text-sm font-medium" htmlFor="tax-month">{t('upToMonth')}<select id="tax-month" className={input} value={upToMonth} onChange={event=>{invalidate();setUpToMonth(Number(event.target.value));}}>{Array.from({length:12},(_,index)=><option key={index+1} value={index+1}>{t(`months.${index+1}`)}</option>)}</select></label>
        </div>
        <p className="text-xs text-muted-foreground">{t('periodHint',{year,month:t(`months.${upToMonth}`)})}</p>
        <fieldset className="space-y-3 border-t pt-5"><legend className="pt-4 font-semibold">{t('employeeSelection')}</legend>
          <div className="flex flex-wrap gap-6 text-sm"><label className="flex items-center gap-2"><input type="radio" name="tax-selection" checked={all} onChange={()=>{invalidate();setAll(true);}}/>{t('allEmployees')}</label><label className="flex items-center gap-2"><input type="radio" name="tax-selection" checked={!all} onChange={()=>{invalidate();setAll(false);}}/>{t('selectedEmployees')}</label></div>
          <p className="text-xs text-muted-foreground">{t('employeeHint')}</p>
          {!all&&<div className="space-y-3">
            <label htmlFor="tax-search" className="block text-sm font-medium">{t('searchEmployees')}<input id="tax-search" type="search" className={input} value={search} placeholder={t('searchPlaceholder')} onChange={event=>{setSearch(event.target.value);setEmployeePage(0);}}/></label>
            {selected.length>0&&<ul aria-label={t('selectedEmployees')} className="flex flex-wrap gap-2">{selected.map(id=>{const employee=employees.find(candidate=>candidate.id===id);return employee?<li key={id}><button type="button" className="rounded-lg border bg-muted/30 px-3 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>toggleEmployee(id)} aria-label={t('removeEmployee',{employee:employee.employeeNo+' · '+employee.name})}>{employee.employeeNo} · {employee.name} <span aria-hidden="true" className="ml-2">×</span></button></li>:null;})}</ul>}
            <div className="max-h-64 overflow-y-auto rounded-lg border p-2">{matching.length===0?<p className="p-3 text-sm text-muted-foreground">{t('noSearchResults')}</p>:matching.slice(employeePage*30,(employeePage+1)*30).map(employee=><label key={employee.id} className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm hover:bg-muted/50"><input type="checkbox" checked={selected.includes(employee.id)} onChange={()=>toggleEmployee(employee.id)}/><span>{employee.employeeNo} · {employee.name}</span></label>)}</div>
            {pages>1&&<nav aria-label={t('employeePagination')} className="flex items-center justify-end gap-3 text-xs"><button type="button" className={button} disabled={employeePage===0} onClick={()=>setEmployeePage(page=>page-1)}>{t('previous')}</button><span>{t('page',{current:employeePage+1,total:pages})}</span><button type="button" className={button} disabled={employeePage+1===pages} onClick={()=>setEmployeePage(page=>page+1)}>{t('next')}</button></nav>}
          </div>}
        </fieldset>
        <div className="flex justify-end"><button type="button" className={button} onClick={generatePreview} disabled={!companyId||!year||(!all&&selected.length===0)}>{t(busy==='preview'?'previewing':'previewAction')}</button></div>
      </fieldset>
    </section>
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}</p>}
    {preview&&<section className="space-y-5 rounded-xl border p-5" aria-labelledby="tax-basis-preview-title">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="tax-basis-preview-title" className="font-semibold">{t('summary')}</h2><p className="text-xs text-muted-foreground">{t('previewExpires',{time:format.dateTime(new Date(preview.expiresAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})})}</p></div>
      <p className="text-sm text-muted-foreground">{preview.companyName} · {t('periodRange',{year:preview.year,month:t(`months.${preview.upToMonth}`)})} · {t(preview.selection==='all'?'allEmployees':'selectedEmployees')}</p>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{([{key:'beforeTaxable',value:preview.totals.beforeTaxable},{key:'afterTaxable',value:preview.totals.taxable},{key:'difference',value:preview.totals.difference},{key:'afterExempt',value:preview.totals.exempt}] as const).map(item=><div key={item.key} className="rounded-lg bg-muted/40 p-4"><dt className="text-xs text-muted-foreground">{t(item.key)}</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{money(item.value)}</dd></div>)}</dl>
      <p className="text-sm">{t('previewCounts',{eligible:preview.eligibleCount,unchanged:preview.unchangedCount,blocked:preview.blockedCount,records:preview.recordCount})}</p>
      <p className="text-xs text-muted-foreground">{t('totalsHint')}</p>
      <TaxBasisResults employees={preview.employees}/>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t pt-4"><p className="max-w-3xl text-xs text-muted-foreground">{t('preserved')}</p>
        <AlertDialog.Root open={confirmOpen} onOpenChange={open=>{if(!busy){setConfirmOpen(open);setAcknowledged(false);}}}>
          <AlertDialog.Trigger asChild><button type="button" className={primary} disabled={busy!==null||preview.eligibleCount===0||!options.canRecalculate}>{t('recalculateAction',{count:preview.eligibleCount})}</button></AlertDialog.Trigger>
          <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/45"/><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-popover p-6 text-popover-foreground shadow-xl">
            <AlertDialog.Title className="text-lg font-semibold">{t('confirmTitle')}</AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-sm text-muted-foreground">{t('confirmDescription',{company:preview.companyName,year:preview.year,month:t(`months.${preview.upToMonth}`),count:preview.eligibleCount,records:preview.recordCount})}</AlertDialog.Description>
            <ul className="my-4 max-h-44 overflow-y-auto rounded-lg border p-3 text-sm">{eligible.map(employee=><li key={employee.id} className="py-1">{employee.employeeNo} · {employee.name}</li>)}</ul>
            <p className="text-xs text-muted-foreground">{t('excludedHint',{blocked:preview.blockedCount,unchanged:preview.unchangedCount})}</p><p className="mt-3 text-xs text-muted-foreground">{t('preserved')}</p>
            <label className="mt-4 flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={acknowledged} disabled={busy!==null} onChange={event=>setAcknowledged(event.target.checked)}/><span>{t('acknowledge')}</span></label>
            <div className="mt-6 flex flex-wrap justify-end gap-3"><AlertDialog.Cancel asChild><button type="button" className={button} disabled={busy!==null}>{t('cancel')}</button></AlertDialog.Cancel><button type="button" className={primary} onClick={confirm} disabled={busy!==null||!acknowledged}>{t(busy==='confirm'?'processing':'confirmAction')}</button></div>
          </AlertDialog.Content></AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </section>}
  </div>;
}
