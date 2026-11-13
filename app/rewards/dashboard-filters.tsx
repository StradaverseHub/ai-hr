'use client';
import {useEffect,useRef,useState,useTransition} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {REWARD_DASHBOARD_ALL,toggleRewardDashboardCompany} from '@/packs/rewards/dashboard-model';
import type {RewardDashboard} from '@/packs/rewards/service';
import {saveDashboardAction} from './dashboard-actions';

type Choice=Pick<RewardDashboard['choice'],'period'|'businessUnit'|'companies'|'year'>;
const same=(a:Choice,b:Choice)=>a.period===b.period&&a.businessUnit===b.businessUnit&&a.companies.join()===b.companies.join()&&a.year===b.year;

/**
 * 356ae8c1: choices apply straight away. 81a7b286: the Review year picker appears only when more than one year is
 * offered; with one year the context line already names its cycle. Saves run one at a time in the order they were made, and the
 * server's re-checked choice replaces the local one only when no later change is still being saved.
 */
export function RewardsDashboardFilters({value,showPeriod}:{value:RewardDashboard;showPeriod:boolean}){
 const t=useTranslations('rewardDashboard'),r=useTranslations('rewards');
 const server:Choice={period:value.choice.period,businessUnit:value.choice.businessUnit,companies:value.choice.companies,year:value.choice.year};
 const [choice,setChoice]=useState<Choice>(server),[failed,setFailed]=useState(false),[,startTransition]=useTransition();
 const queue=useRef<Promise<unknown>>(Promise.resolve()),pending=useRef(0);
 const serverKey=`${server.period}|${server.businessUnit}|${server.companies.join()}|${server.year}`;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 useEffect(()=>{if(pending.current===0)setChoice(current=>same(current,server)?current:server);},[serverKey]);
 const apply=(next:Choice)=>{
  if(same(next,choice))return;
  setChoice(next);setFailed(false);pending.current++;
  const job=queue.current.then(()=>saveDashboardAction(next)).catch(()=>setFailed(true)).finally(()=>{pending.current--;});
  queue.current=job;startTransition(async()=>{await job;});
 };
 const fixed=!value.canSelectAll&&value.businessUnits.length===1;
 const available=value.companies.map(company=>company.id);
 return <div className="space-y-3" role="group" aria-label={t('preferences')}>
  <div className="flex flex-wrap items-end justify-between gap-3">
   <div className="flex min-w-0 flex-wrap items-end gap-3">
   {fixed?<p className="text-sm"><span className="block text-muted-foreground">{r('unit')}</span><span className="font-medium">{value.businessUnits[0].label}</span></p>
    :<label className="min-w-0 space-y-1 text-sm"><span className="block">{r('unit')}</span>
     <select value={choice.businessUnit} onChange={event=>apply({...choice,businessUnit:event.target.value,companies:[]})} className={`${inputCls} max-w-full sm:max-w-md`}>
      {value.canSelectAll&&<option value={REWARD_DASHBOARD_ALL}>{t('allBusinessUnits')}</option>}
      {value.businessUnits.map(unit=><option key={unit.id} value={unit.id}>{unit.label}</option>)}
     </select></label>}
   {value.years.length>1&&<label className="min-w-0 space-y-1 text-sm"><span className="block">{t('reviewYear')}</span>
    <select value={choice.year} onChange={event=>apply({...choice,year:Number(event.target.value)})} className={inputCls}>
     {value.years.map(year=><option key={year} value={year}>{year}</option>)}
    </select></label>}
   </div>
   {showPeriod&&<div role="group" aria-label={t('salaryPeriod')} className="inline-flex rounded-md border border-border p-0.5 text-xs">
    {(['monthly','annual'] as const).map(period=><button key={period} type="button" aria-pressed={choice.period===period} onClick={()=>apply({...choice,period})}
     className={`rounded px-2.5 py-1 ${choice.period===period?'bg-primary text-primary-foreground':'text-muted-foreground hover:text-foreground'}`}>{t(period)}</button>)}
   </div>}
  </div>
  {value.companies.length>0&&<div role="group" aria-label={t('companies')} className="flex flex-wrap gap-2">
   {[{id:null,label:t('allCompanies'),headcount:null,blocked:false,preparing:false},...value.companies].map(company=>{
    const pressed=company.id===null?choice.companies.length===0:choice.companies.includes(company.id);
    return <button key={company.id??'all'} type="button" aria-pressed={pressed} onClick={()=>apply({...choice,companies:toggleRewardDashboardCompany(choice.companies,company.id,available)})}
     className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${pressed?'border-primary bg-primary/10 font-medium text-primary':'border-border text-foreground hover:bg-muted'}`}>
     <span>{company.label}</span>
     {company.id!==null&&<span className="text-xs text-muted-foreground">{company.preparing?t('beingPrepared'):company.headcount===null?'—':t('headcount',{count:company.headcount})}</span>}
     {company.blocked&&<span className="inline-block size-2 rounded-full bg-destructive" role="img" aria-label={t('hasBlockers')}/>}
    </button>;
   })}
  </div>}
  {failed&&<p role="alert" className="text-sm text-destructive">{t('saveFailed')}</p>}
 </div>;
}
