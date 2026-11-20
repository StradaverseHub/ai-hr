'use client';

import { ActionButton } from '@/components/ui/action-button';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useFormatter,useTranslations} from 'next-intl';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import {formatMoney} from '@/lib/money';
import type {TaxBasisEmployee,TaxBasisPreview,TaxBasisSelection} from '@/lib/payroll-tax-basis';
import {previewTaxBasisAction,confirmTaxBasisAction,queueTaxBasisGroupPreviewAction,queueTaxBasisGroupConfirmationAction,taxBasisGroupProgressAction,searchCurrentTaxBasisEmployeesAction} from './actions';
import {TaxBasisResults} from './results';

export type TaxBasisOptions={companies:{id:string;name:string;canRecalculate?:boolean}[];employees:{id:string;companyId:string;employeeNo:string;name:string}[];years:number[];canRecalculate:boolean};
const input='mt-1 block w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const button='inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const primary=button+' border-primary bg-primary text-primary-foreground hover:bg-primary/90';

type CompanyPreview=Omit<TaxBasisPreview,'employees'>;
const PAGE_SIZE=30;
function combinePreviews(previews:CompanyPreview[],employees:TaxBasisEmployee[]):TaxBasisPreview{
  const sum=(key:keyof TaxBasisPreview['totals'])=>previews.some(preview=>preview.totals[key]===null)
    ?null:Math.round(previews.reduce((value,preview)=>value+preview.totals[key]!,0)*100)/100;
  return {
    ...previews[0],companyName:previews.map(preview=>preview.companyName).join(', '),
    expiresAt:previews.map(preview=>preview.expiresAt).sort()[0],
    eligibleCount:previews.reduce((n,preview)=>n+preview.eligibleCount,0),
    unchangedCount:previews.reduce((n,preview)=>n+preview.unchangedCount,0),
    skippedCount:previews.reduce((n,preview)=>n+(preview.skippedCount??0),0),
    blockedCount:previews.reduce((n,preview)=>n+preview.blockedCount,0),
    recordCount:previews.reduce((n,preview)=>n+preview.recordCount,0),
    totals:{beforeTaxable:sum('beforeTaxable'),taxable:sum('taxable'),difference:sum('difference'),beforeExempt:sum('beforeExempt'),exempt:sum('exempt')},
    employees,
  };
}
const employeeKey=(employee:{id:string;companyId?:string})=>`${employee.companyId??''}:${employee.id}`;

export type TaxBasisGroupProgressLink={id:string;phase:'preview'|'confirm'};
function updateGroupProgressLink(job:TaxBasisGroupProgressLink|null){
  const url=new URL(window.location.href);
  if(job){url.searchParams.set('group',job.id);url.searchParams.set('phase',job.phase);}
  else {url.searchParams.delete('group');url.searchParams.delete('phase');}
  window.history.replaceState(null,'',url);
}

export function TaxBasisWorkflow({options,initialSelection,initialGroup}:{options:TaxBasisOptions;initialSelection?:TaxBasisSelection;initialGroup?:TaxBasisGroupProgressLink}){
  const t=useTranslations('payrollTaxBasis'),format=useFormatter(),router=useRouter();
  const refresh=router.refresh;
  const [companyIds,setCompanyIds]=useState(()=>[initialSelection?.companyId??options.companies[0]?.id].filter((id):id is string=>!!id));
  const [companiesOpen,setCompaniesOpen]=useState(false);
  const [previewJobId,setPreviewJobId]=useState<string|null>(null);
  const [previewCompanies,setPreviewCompanies]=useState<CompanyPreview[]>([]);
  const [resultOffset,setResultOffset]=useState(0);
  const [totalResultEmployees,setTotalResultEmployees]=useState(0);
  const [loadingResultPage,setLoadingResultPage]=useState(false);
  const [job,setJob]=useState<TaxBasisGroupProgressLink|null>(initialGroup??null);
  const [jobProgress,setJobProgress]=useState<{done:number;total:number}|null>(null);
  const [companyOutcomes,setCompanyOutcomes]=useState<{companyId:string;companyName:string;id:string|null;error:string|null}[]>([]);
  const [year,setYear]=useState(initialSelection?.year??options.years[0]??0);
  const [upToMonth,setUpToMonth]=useState(initialSelection?.upToMonth??12);
  const [all,setAll]=useState(initialSelection?.employmentIds==null);
  const [selected,setSelected]=useState(()=>initialSelection?.employmentIds?.map(id=>employeeKey({id,companyId:initialSelection.companyId}))??[]);
  const [search,setSearch]=useState('');
  const [currentMatches,setCurrentMatches]=useState<TaxBasisOptions['employees']>([]);
  const [selectedCurrent,setSelectedCurrent]=useState<TaxBasisOptions['employees']>([]);
  const [preview,setPreview]=useState<TaxBasisPreview|null>(null);
  const [busy,setBusy]=useState<'preview'|'confirm'|null>(initialGroup?.phase??null);
  const [error,setError]=useState<string|null>(null);
  const [confirmOpen,setConfirmOpen]=useState(false);
  const [acknowledged,setAcknowledged]=useState(false);
  const [employeePage,setEmployeePage]=useState(0);
  const permittedCompanies=options.companies.filter(company=>company.canRecalculate??options.canRecalculate);
  const namedCompanies=new Map(options.companies.map(company=>[company.id,company.name]));
  const companySet=new Set(companyIds);
  const canRecalculate=companyIds.length>0&&companyIds.every(id=>permittedCompanies.some(company=>company.id===id));
  const employees=[...new Map([...options.employees,...selectedCurrent,...currentMatches]
    .filter(employee=>companySet.has(employee.companyId)).map(employee=>[employeeKey(employee),employee])).values()];
  const selectedKeys=new Set(selected);
  const includedEmployees=employees.filter(employee=>selectedKeys.has(employeeKey(employee)));
  const matching=employees.filter(employee=>(employee.employeeNo+' '+employee.name+' '+namedCompanies.get(employee.companyId)).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages=Math.max(1,Math.ceil(matching.length/30));
  const eligible=preview?.employees.filter(employee=>employee.status==='ready')??[];
  function invalidate(){updateGroupProgressLink(null);setPreview(null);setPreviewJobId(null);setPreviewCompanies([]);setCompanyOutcomes([]);setError(null);setConfirmOpen(false);setAcknowledged(false);}
  function changeCompanies(ids:string[]){invalidate();setCurrentMatches([]);setCompanyIds(ids);setEmployeePage(0);}
  useEffect(()=>{
    if(all||search.trim().length<2||!companyIds.length)return;
    let cancelled=false;
    const timer=setTimeout(async()=>{
      try{
        const found=await searchCurrentTaxBasisEmployeesAction(companyIds,search);
        if(!cancelled)setCurrentMatches(found);
      }catch{
        if(!cancelled)setCurrentMatches([]);
      }
    },250);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[all,companyIds,search]);
  useEffect(()=>{
    if(!job)return;
    let cancelled=false;
    let timer:ReturnType<typeof setTimeout>;
    let failures=0;
    const poll=async()=>{
      try{
        const result=await taxBasisGroupProgressAction(job.id);
        if(cancelled)return;
        failures=0;
        const {progress}=result;
        setJobProgress({done:progress.stepsDone,total:progress.stepsTotal});
        if(progress.state==='completed'){
          if(job.phase==='preview'&&result.previews?.length){
            setPreview(combinePreviews(result.previews,result.employees));
            setPreviewCompanies(result.previews);
            setCompanyIds(result.previews.map(company=>company.companyId));
            setPreviewJobId(job.id);
            setResultOffset(0);
            setTotalResultEmployees(result.totalEmployees);
          }else if(job.phase==='confirm'&&result.batches){
            setCompanyOutcomes(result.batches);refresh();
          }else setError(t('unexpectedError'));
        }else if(progress.state==='failed'||progress.state==='cancelled')setError(t('unexpectedError'));
        else {timer=setTimeout(poll,1500);return;}
      }catch{
        if(cancelled)return;
        if(++failures<3){timer=setTimeout(poll,2000);return;}
        setError(t('unexpectedError'));
      }
      setJob(null);setBusy(null);setJobProgress(null);
    };
    void poll();
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[job,refresh,t]);
  async function pageResults(offset:number){
    if(!previewJobId||loadingResultPage)return;
    setLoadingResultPage(true);setError(null);
    try{
      const result=await taxBasisGroupProgressAction(previewJobId,offset);
      if(!result.previews?.length)throw new Error();
      setPreview(combinePreviews(result.previews,result.employees));
      setResultOffset(offset);
    }catch{setError(t('unexpectedError'));}
    finally{setLoadingResultPage(false);}
  }
  function toggleEmployee(id:string){
    invalidate();
    if(selectedKeys.has(id)){
      setSelected(values=>values.filter(value=>value!==id));
      setSelectedCurrent(values=>values.filter(value=>employeeKey(value)!==id));
    }else{
      setSelected(values=>[...values,id]);
      const current=currentMatches.find(employee=>employeeKey(employee)===id);
      if(current)setSelectedCurrent(values=>[...values,current]);
    }
  }
  async function generatePreview(){
    updateGroupProgressLink(null);setPreview(null);setPreviewJobId(null);setPreviewCompanies([]);
    setCompanyOutcomes([]);setError(null);setBusy('preview');
    try{
      const selections=companyIds.map(companyId=>({companyId,year,upToMonth,
        employmentIds:all?null:includedEmployees.filter(employee=>employee.companyId===companyId).map(employee=>employee.id),
      }));
      if(selections.length>1){
        const id=await queueTaxBasisGroupPreviewAction(selections,crypto.randomUUID());
        const queued={id,phase:'preview' as const};
        updateGroupProgressLink(queued);setJob(queued);
        return;
      }
      const result=await previewTaxBasisAction(selections[0]);
      if(result.ok)setPreview(result.preview);else setError(result.error??t('unexpectedError'));
    }catch{setError(t('unexpectedError'));}
    setBusy(null);
  }
  async function confirm(){
    if(!preview||!acknowledged||busy)return;
    setBusy('confirm');setError(null);
    try{
      if(previewJobId){
        const id=await queueTaxBasisGroupConfirmationAction(previewJobId);
        const queued={id,phase:'confirm' as const};
        updateGroupProgressLink(queued);setJob(queued);setConfirmOpen(false);setPreview(null);setAcknowledged(false);
        return;
      }
      const result=await confirmTaxBasisAction({previewId:preview.previewId,previewHash:preview.previewHash});
      if(result.ok){setConfirmOpen(false);setPreview(null);router.push('/payroll/income-tax-recalculation/'+result.result.id);router.refresh();}
      else{setError(result.error??t('unexpectedError'));setPreview(null);setConfirmOpen(false);}
    }catch{setError(t('unexpectedError'));setConfirmOpen(false);setPreview(null);}
    setBusy(null);setAcknowledged(false);
  }
  const money=(value:number|null)=>value===null?t('unavailable'):formatMoney(value,'MYR');
  if(options.companies.length===0||options.years.length===0)return <section className="rounded-xl border border-border p-6"><p className="text-sm text-muted-foreground">{t('noHistoryAvailable')}</p></section>;
  return <div className="space-y-6">
    {!canRecalculate&&<p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">{t('readOnly')}</p>}
    {initialSelection&&<p role="status" className="rounded-lg border border-border bg-muted/30 p-4 text-sm">{t('retryHint')}</p>}
    <section className="space-y-5 rounded-xl border border-border p-5" aria-labelledby="tax-basis-period-title">
      <fieldset disabled={busy!==null||loadingResultPage} className="space-y-5 disabled:opacity-70">
        <legend id="tax-basis-period-title" className="font-semibold">{t('recalculationPeriod')}</legend>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="relative text-sm">
            <span id="tax-company-label" className="font-medium">{t('company')}</span>
            <button type="button" aria-labelledby="tax-company-label tax-company-value" aria-expanded={companiesOpen}
              aria-controls="tax-company-options" className={input+' flex items-center justify-between gap-2 text-left'}
              onClick={()=>setCompaniesOpen(open=>!open)} onKeyDown={event=>{if(event.key==='Escape')setCompaniesOpen(false);}}>
              <span id="tax-company-value" className="truncate">{companyIds.map(id=>namedCompanies.get(id)).join(', ')||t('selectCompanies')}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {companiesOpen&&<div id="tax-company-options" onKeyDown={event=>{if(event.key==='Escape')setCompaniesOpen(false);}}
              className="absolute inset-x-0 top-full z-10 mt-1 space-y-2 rounded-lg border border-border bg-popover p-3 shadow-md">
              <div className="flex flex-wrap justify-between gap-2">
                <button type="button" className="font-medium underline" onClick={()=>changeCompanies(permittedCompanies.map(company=>company.id))} disabled={!permittedCompanies.length}>{t('selectAllCompanies')}</button>
                <button type="button" className="text-primary underline" onClick={()=>changeCompanies([])}>{t('clearCompanies')}</button>
              </div>
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {options.companies.map(company=><label key={company.id} className="flex items-center gap-2 rounded px-1 py-1.5">
                  <input type="checkbox" checked={companySet.has(company.id)} disabled={!companySet.has(company.id)&&!permittedCompanies.includes(company)}
                    onChange={()=>changeCompanies(companySet.has(company.id)?companyIds.filter(id=>id!==company.id):[...companyIds,company.id])}/>
                  {company.name}
                </label>)}
              </div>
            </div>}
          </div>
          <label className="text-sm font-medium" htmlFor="tax-year">{t('year')}<select id="tax-year" disabled={!canRecalculate} className={input} value={year} onChange={event=>{invalidate();setYear(Number(event.target.value));}}>{options.years.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
          <label className="text-sm font-medium" htmlFor="tax-month">{t('upToMonth')}<select id="tax-month" disabled={!canRecalculate} className={input} value={upToMonth} onChange={event=>{invalidate();setUpToMonth(Number(event.target.value));}}>{Array.from({length:12},(_,index)=><option key={index+1} value={index+1}>{t(`months.${index+1}`)}</option>)}</select></label>
        </div>
        <p className="text-xs text-muted-foreground">{t('periodHint',{year,month:t(`months.${upToMonth}`)})}</p>
        <fieldset disabled={!canRecalculate} className="space-y-3 border-t border-border pt-5"><legend className="pt-4 font-semibold">{t('employeeSelection')}</legend>
          <div className="flex flex-wrap gap-6 text-sm"><label className="flex items-center gap-2"><input type="radio" name="tax-selection" checked={all} onChange={()=>{invalidate();setAll(true);}}/>{t('allEmployees')}</label><label className="flex items-center gap-2"><input type="radio" name="tax-selection" checked={!all} onChange={()=>{invalidate();setAll(false);}}/>{t('selectedEmployees')}</label></div>
          <p className="text-xs text-muted-foreground">{t('employeeHint')}</p>
          {!all&&<div className="space-y-3">
            <label htmlFor="tax-search" className="block text-sm font-medium">{t('searchEmployees')}<input id="tax-search" type="search" className={input} value={search} placeholder={t('searchPlaceholder')} onChange={event=>{setSearch(event.target.value);setCurrentMatches([]);setEmployeePage(0);}}/></label>
            {includedEmployees.length>0&&<ul aria-label={t('selectedEmployees')} className="flex flex-wrap gap-2">{includedEmployees.map(employee=> <li key={employeeKey(employee)}><button type="button" className="rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>toggleEmployee(employeeKey(employee))} aria-label={t('removeEmployee',{employee:employee.employeeNo+' · '+employee.name})}>{employee.employeeNo} · {employee.name}{companyIds.length>1&&' · '+namedCompanies.get(employee.companyId)} <span aria-hidden="true" className="ml-2">×</span></button></li>)}</ul>}
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-2">{matching.length===0?<p className="p-3 text-sm text-muted-foreground">{t('noSearchResults')}</p>:matching.slice(employeePage*30,(employeePage+1)*30).map(employee=><label key={employeeKey(employee)} className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm hover:bg-muted/50"><input type="checkbox" checked={selectedKeys.has(employeeKey(employee))} onChange={()=>toggleEmployee(employeeKey(employee))}/><span>{employee.employeeNo} · {employee.name}{companyIds.length>1&&' · '+namedCompanies.get(employee.companyId)}</span></label>)}</div>
            {pages>1&&<nav aria-label={t('employeePagination')} className="flex items-center justify-end gap-3 text-xs"><button type="button" className={button} disabled={employeePage===0} onClick={()=>setEmployeePage(page=>page-1)}>{t('previous')}</button><span>{t('page',{current:employeePage+1,total:pages})}</span><button type="button" className={button} disabled={employeePage+1===pages} onClick={()=>setEmployeePage(page=>page+1)}>{t('next')}</button></nav>}
          </div>}
        </fieldset>
        <div className="flex justify-end"><ActionButton guardNavigation={false} aria-busy={busy==='preview'} actionKind="generating" type="button" className={button} onClick={generatePreview} disabled={!canRecalculate||!year||(!all&&includedEmployees.length===0)}>{t(busy==='preview'?'previewing':'previewAction')}</ActionButton></div>
      </fieldset>
    </section>
    {jobProgress&&<p role="status" className="text-sm">{t('companyProgress',{done:jobProgress.done,total:jobProgress.total||companyIds.length})}</p>}
    {companyOutcomes.length>0&&<section className="space-y-3 rounded-xl border border-border p-5">
      <h2 className="font-semibold">{t('outcomes')}</h2>
      <ul className="divide-y divide-border">{companyOutcomes.map(company=><li key={company.companyId} className="flex flex-wrap justify-between gap-3 py-2 text-sm">
        <span>{company.companyName}</span>
        {company.id?<Link className="text-primary underline" href={'/payroll/income-tax-recalculation/'+company.id}>{t('viewDetails')}</Link>:<span>{company.error?t('companyFailed'):t('noCompanyChanges')}</span>}
      </li>)}</ul>
    </section>}
    {error&&<p role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive">{error}</p>}
    {preview&&<section className="space-y-5 rounded-xl border border-border p-5" aria-labelledby="tax-basis-preview-title">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="tax-basis-preview-title" className="font-semibold">{t('summary')}</h2><p className="text-xs text-muted-foreground">{t('previewExpires',{time:format.dateTime(new Date(preview.expiresAt),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'})})}</p></div>
      <p className="text-sm text-muted-foreground">{preview.companyName} · {t('periodRange',{year:preview.year,month:t(`months.${preview.upToMonth}`)})} · {t(preview.selection==='all'?'allEmployees':'selectedEmployees')}</p>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{([{key:'beforeTaxable',value:preview.totals.beforeTaxable},{key:'afterTaxable',value:preview.totals.taxable},{key:'difference',value:preview.totals.difference},{key:'afterExempt',value:preview.totals.exempt}] as const).map(item=><div key={item.key} className="rounded-lg bg-muted/40 p-4"><dt className="text-xs text-muted-foreground">{t(item.key)}</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{money(item.value)}</dd></div>)}</dl>
      <p className="text-sm">{t('previewCounts',{eligible:preview.eligibleCount,unchanged:preview.unchangedCount,blocked:preview.blockedCount,skipped:preview.skippedCount??0,records:preview.recordCount})}</p>
      <p className="text-xs text-muted-foreground">{t('totalsHint')}</p>
      <TaxBasisResults employees={preview.employees}/>
      {previewJobId&&totalResultEmployees>PAGE_SIZE&&<nav aria-label={t('employeePagination')} className="flex items-center justify-end gap-3 text-xs">
        <button type="button" className={button} disabled={!resultOffset||loadingResultPage} onClick={()=>pageResults(resultOffset-PAGE_SIZE)}>{t('previous')}</button>
        <span>{t('page',{current:resultOffset/PAGE_SIZE+1,total:Math.ceil(totalResultEmployees/PAGE_SIZE)})}</span>
        <button type="button" className={button} disabled={resultOffset+PAGE_SIZE>=totalResultEmployees||loadingResultPage} onClick={()=>pageResults(resultOffset+PAGE_SIZE)}>{t('next')}</button>
      </nav>}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4"><p className="max-w-3xl text-xs text-muted-foreground">{t('preserved')}</p>
        <AlertDialog.Root open={confirmOpen} onOpenChange={open=>{if(!busy){setConfirmOpen(open);setAcknowledged(false);}}}>
          <AlertDialog.Trigger asChild><ActionButton aria-busy={busy==='confirm'} type="button" className={primary} disabled={busy!==null||loadingResultPage||preview.eligibleCount===0||!canRecalculate}>{t('recalculateAction',{count:preview.eligibleCount})}</ActionButton></AlertDialog.Trigger>
          <AlertDialog.Portal><AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/45"/><AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-popover p-6 text-popover-foreground shadow-xl">
            <AlertDialog.Title className="text-lg font-semibold">{t('confirmTitle')}</AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-sm text-muted-foreground">{t('confirmDescription',{company:preview.companyName,year:preview.year,month:t(`months.${preview.upToMonth}`),count:preview.eligibleCount,records:preview.recordCount})}</AlertDialog.Description>
            <ul className="my-4 max-h-44 overflow-y-auto rounded-lg border border-border p-3 text-sm">{previewJobId?previewCompanies.map(company=><li key={company.companyId} className="py-1">{company.companyName} · {t('previewCounts',{eligible:company.eligibleCount,unchanged:company.unchangedCount,skipped:company.skippedCount??0,blocked:company.blockedCount,records:company.recordCount})}</li>):eligible.map(employee=><li key={employeeKey(employee)} className="py-1">{employee.employeeNo} · {employee.name}{employee.companyName&&' · '+employee.companyName}</li>)}</ul>
            <p className="text-xs text-muted-foreground">{t('excludedHint',{blocked:preview.blockedCount,skipped:preview.skippedCount??0,unchanged:preview.unchangedCount})}</p><p className="mt-3 text-xs text-muted-foreground">{t('preserved')}</p>
            <label className="mt-4 flex items-start gap-3 text-sm"><input className="mt-1" type="checkbox" checked={acknowledged} disabled={busy!==null} onChange={event=>setAcknowledged(event.target.checked)}/><span>{t('acknowledge')}</span></label>
            <div className="mt-6 flex flex-wrap justify-end gap-3"><AlertDialog.Cancel asChild><ActionButton aria-busy={busy==='confirm'} type="button" className={button} disabled={busy!==null}>{t('cancel')}</ActionButton></AlertDialog.Cancel><ActionButton guardNavigation aria-busy={busy==='confirm'} type="button" className={primary} onClick={confirm} disabled={busy!==null||!acknowledged}>{t(busy==='confirm'?'processing':'confirmAction')}</ActionButton></div>
          </AlertDialog.Content></AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </section>}
  </div>;
}
