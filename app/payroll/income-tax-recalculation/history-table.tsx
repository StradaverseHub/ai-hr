'use client';

import Link from 'next/link';
import {useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {useFormatter,useTranslations} from 'next-intl';
import {taxBasisProgressPercent,type TaxBasisHistoryRow} from '@/lib/payroll-tax-basis';
import {TaxProgressBar,TaxStatePill} from './progress-bar';

const HISTORY_REFRESH_MS=5000;

/** Server-ordered rows; this component only presents them. It refreshes the server page while a run is still moving. */
export function TaxBasisHistory({rows}:{rows:TaxBasisHistoryRow[]}){
  const t=useTranslations('payrollTaxBasis'),format=useFormatter(),router=useRouter();
  const active=rows.some(row=>!row.interrupted&&(row.status==='pending'||row.status==='processing'));
  useEffect(()=>{
    if(!active)return;
    const timer=setInterval(()=>router.refresh(),HISTORY_REFRESH_MS);
    return ()=>clearInterval(timer);
  },[active,router]);
  const when=(value:string)=>format.dateTime(new Date(value),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'});
  if(rows.length===0)return <section className="rounded-xl border border-border p-5"><p className="text-sm text-muted-foreground">{t('noHistory')}</p></section>;
  return <section className="overflow-x-auto rounded-xl border border-border" aria-label={t('history')}>
    <table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>
      {['reference','company','period','submittedBy','submittedAt','progressLabel','employeesColumn','status','completedAt','details'].map(key=><th key={key} className="p-3 font-medium">{t(key)}</th>)}
    </tr></thead><tbody>{rows.map(row=>{
      const finished=row.status==='completed'||row.status==='completed_with_errors'||row.status==='failed';
      const percent=taxBasisProgressPercent(row.processedCount,row.employeeCount,finished);
      return <tr key={row.id} className="border-t border-border align-top">
        <td className="p-3 font-mono text-xs">{row.reference??<span className="text-muted-foreground">{t('queuedReference')}</span>}</td>
        <td className="p-3">{row.companyName}</td>
        <td className="p-3 whitespace-nowrap">{row.year&&row.upToMonth?t('periodRange',{year:row.year,month:t(`months.${row.upToMonth}`)}):'—'}</td>
        <td className="p-3">{row.actorName}</td>
        <td className="p-3 whitespace-nowrap">{when(row.createdAt)}</td>
        <td className="min-w-40 p-3"><TaxProgressBar percent={percent} state={row.status} label={t('companyProgressFor',{company:row.companyName})}/></td>
        <td className="p-3 whitespace-nowrap">{row.kind==='queued'?<span className="text-muted-foreground">{t('waitingToStart')}</span>:<>
          <span className="tabular-nums">{t('processedOfTotal',{processed:row.processedCount,total:row.employeeCount})}</span>
          <p className="mt-1 text-xs text-muted-foreground">{t('failedAndNotIncluded',{failed:row.failedCount,notIncluded:row.notIncludedCount})}</p>
        </>}</td>
        <td className="p-3"><TaxStatePill state={row.status} label={t(row.interrupted?'interruptedStatus':`batchStates.${row.status}`)}/></td>
        <td className="p-3 whitespace-nowrap">{row.completedAt?when(row.completedAt):'—'}</td>
        <td className="p-3">{row.batches.length===1?<Link className="font-medium text-primary underline underline-offset-2" href={'/payroll/income-tax-recalculation/'+row.batches[0].id}>{t('viewDetails')}</Link>
          :row.batches.length>1?<details><summary className="cursor-pointer font-medium text-primary">{t('employeeGroups',{count:row.batches.length})}</summary>
            <ul className="mt-2 space-y-1">{row.batches.map((batch,index)=><li key={batch.id}><Link className="text-xs text-primary underline underline-offset-2" href={'/payroll/income-tax-recalculation/'+batch.id}>{t('employeeGroup',{number:index+1})}</Link></li>)}</ul>
          </details>:null}</td>
      </tr>;
    })}</tbody></table>
  </section>;
}
