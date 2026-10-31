import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {getCustomReport,runPayrollComparisonReport,recordPayrollComparisonRun} from '@/core/custom-reports';
import {payrollComparisonOptions} from '@/core/report-payroll-comparison';
import {MasterReportAccessError} from '@/core/employee-master-access';
import {PageHeader,Card,ErrorBanner} from '@/components/ui';
import {payrollComparisonColumns,payrollComparisonCell} from '@/lib/payroll-comparison-presentation';
import {PAYROLL_COMPARISON_REASON_FILTERS} from '@/lib/payroll-period-comparison';
import {PayrollComparisonEditor} from '../PayrollComparisonEditor';
import {publicErrorMessage} from '@/lib/public-error';
export const dynamic='force-dynamic';
export default async function PayrollComparisonPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|undefined>>}){
  const {s,scopeIds}=await scopedAdmin(),{id}=await params,sp=await searchParams,t=await getTranslations('payrollComparison');
  let options:Awaited<ReturnType<typeof payrollComparisonOptions>>;
  try{options=await payrollComparisonOptions(s,scopeIds);}
  catch(error){if(error instanceof MasterReportAccessError)notFound();throw error;}
  if(sp.edit==='1'){
    const report=await getCustomReport(s,id,scopeIds,'edit').catch(()=>null);if(!report?.spec.payrollComparison)notFound();
    return <div className="space-y-5"><PageHeader title={t('editReport')} back={{href:'/reports/payroll-comparison/'+id,label:t('back')}}/>{sp.error&&<ErrorBanner message={sp.error}/>}<Card className="p-6"><PayrollComparisonEditor key={id+':'+report.version} id={id} version={report.version} name={report.name} description={report.spec.layout?.description??''} initial={report.spec.payrollComparison} payItems={options.payItems}/></Card></div>;
  }
  const raw=Object.fromEntries(Object.entries(sp).filter(([key,value])=>key!=='error'&&key!=='edit'&&value!==undefined));
  let run:Awaited<ReturnType<typeof runPayrollComparisonReport>>;
  try{run=await runPayrollComparisonReport(s,scopeIds,{id,filters:raw});await recordPayrollComparisonRun(s,run,'run');}
  catch(error){if(error instanceof MasterReportAccessError)notFound();return <div className="space-y-4"><PageHeader title={t('title')} back={{href:'/reports?cat=payroll',label:t('back')}}/><ErrorBanner message={publicErrorMessage(error)}/><Link href={'/reports/payroll-comparison/'+id}>{t('reset')}</Link></div>;}
  const {result,filters}=run,columns=payrollComparisonColumns(run.definition);
  const query=(changes:Record<string,string|number|null>={})=>{
    const values={...filters,onlyVariances:filters.onlyVariances?'1':'0',...changes},search=new URLSearchParams();
    for(const [key,value]of Object.entries(values))if(value!==null)search.set(key,String(value));return search.toString();
  };
  const input='mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
  return <div className="space-y-5">
    <nav aria-label={t('breadcrumb')} className="text-sm text-muted-foreground"><Link href="/reports">{t('reports')}</Link> › <Link href="/reports?cat=payroll">{t('payroll')}</Link> › {t('customReports')}</nav>
    <PageHeader title={run.name} description={run.description||t('reportHelp')}/>
    <div className="flex flex-wrap items-center justify-between gap-3"><span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{t('customTag')}</span><div className="flex gap-3 text-sm">{run.canEdit&&<Link className="rounded-lg border border-border px-3 py-2" href={'/reports/payroll-comparison/'+id+'?edit=1'}>{t('editReport')}</Link>}{run.canExport&&(['pdf','xlsx']as const).map(format=><a key={format} className="rounded-lg bg-primary px-3 py-2 text-primary-foreground" href={'/reports/payroll-comparison/export?id='+id+'&format='+format+'&'+query()}>{t(format==='pdf'?'exportPdf':'exportExcel')}</a>)}</div></div>
    {result.provisional&&<div role="status" className="rounded-xl border border-border bg-muted/50 p-4 text-sm text-foreground">{t('provisional')}</div>}
    {!result.available&&<div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"><p className="font-semibold">{t('unavailable')}</p><ul className="mt-2 list-inside list-disc">{result.issues.map((issue,index)=><li key={index}>{t(`issues.${issue.code}`)} · {issue.period} · {options.companies.find(company=>company.id===issue.companyId)?.name??issue.companyId}</li>)}</ul></div>}
    {run.contextUnavailable&&<p role="status" className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t('contextUnavailable')}</p>}
    <Card className="p-5"><form key={query()} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" method="get">
      <label className="text-sm font-medium">{t('company')}<select className={input} name="companyId" defaultValue={filters.companyId??''}><option value="">{t('allCompanies')}</option>{options.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('previousPeriod')}<input className={input} type="month" name="previousPeriod" defaultValue={filters.previousPeriod??''} required/></label>
      <label className="text-sm font-medium">{t('currentPeriod')}<input className={input} type="month" name="currentPeriod" defaultValue={filters.currentPeriod??''} required/></label>
      <label className="text-sm font-medium">{t('runs')}<select className={input} name="runType" defaultValue={filters.runType}><option value="regular">{t('regular')}</option><option value="all">{t('allRuns')}</option></select></label>
      <label className="text-sm font-medium">{t('department')}<select className={input} name="departmentId" defaultValue={filters.departmentId??''}><option value="">{t('allDepartments')}</option>{options.departments.map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('minimum')}<input className={input} type="number" name="minVariance" min="0" step="0.01" defaultValue={filters.minVariance} required/></label>
      <label className="text-sm font-medium">{t('onlyVariances')}<select className={input} name="onlyVariances" defaultValue={filters.onlyVariances?'1':'0'}><option value="1">{t('yes')}</option><option value="0">{t('no')}</option></select></label>
      <div className="flex items-end gap-3"><Link className="rounded-lg border border-border px-3 py-2 text-sm" href={'/reports/payroll-comparison/'+id}>{t('reset')}</Link><button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" type="submit">{t('generate')}</button></div>
    </form></Card>
    {result.summary&&<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Card className="p-4"><p className="text-xs text-muted-foreground">{t('headcount')}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{result.summary.previousHeadcount} → {result.summary.currentHeadcount}</p><p className="mt-2 text-xs text-muted-foreground">{t('joinersLeavers',{joiners:result.summary.joiners,leavers:result.summary.leavers})}</p></Card>
      {['previous','current','variance'].map(field=><Card key={field} className="p-4"><p className="text-xs text-muted-foreground">{t(`columns.${field}`)} · {run.definition.payItemCode}</p>{result.summary!.totals.map(total=><p key={total.currency??total.companyId} className="mt-2 font-semibold tabular-nums">{total.currency??t('currencyUnknown')} {total[field as 'previous'|'current'|'variance']??t('notAvailable')}{total.companyId&&<span className="block text-xs font-normal text-muted-foreground">{options.companies.find(company=>company.id===total.companyId)?.name}</span>}{field==='variance'&&<span className="ml-2 text-xs">({total.variancePct??t('notAvailable')}{total.variancePct!==null?'%':''})</span>}</p>)}</Card>)}
      <Card className="border-red-200 p-4"><p className="text-xs text-muted-foreground">{t('needsReview')}</p><p className="mt-2 text-2xl font-semibold text-red-700 dark:text-red-300">{result.summary.unexplained}</p></Card></div>}
    <div className="flex flex-wrap gap-2" aria-label={t('reasonFilters')}><Link className="rounded-full border border-border px-3 py-1 text-sm" aria-current={!filters.reason?'page':undefined} href={'?'+query({reason:null,page:1})}>{t('allReasons')} ({result.comparisonRows})</Link>{PAYROLL_COMPARISON_REASON_FILTERS.filter(reason=>!['increment','promotion','proratedLeaving'].includes(reason)&&(['unexplained','incrementPromotion','newHire','resigned','prorated'].includes(reason)||result.reasonFilterCounts[reason]>0)).map(reason=><Link key={reason} className={'rounded-full border px-3 py-1 text-sm '+(filters.reason===reason?'border-primary bg-primary/10 text-primary':'border-border')} aria-current={filters.reason===reason?'page':undefined} href={'?'+query({reason,page:1})}>{reason==='incrementPromotion'?t('incrementPromotion'):reason==='prorated'?t('prorated'):t(`reasons.${reason}`)} ({result.reasonFilterCounts[reason]})</Link>)}</div>
    <Card className="overflow-hidden"><div role="region" aria-label={t('comparisonTable')} tabIndex={0} className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><table className="w-full text-sm"><caption className="p-4 text-left text-xs text-muted-foreground">{t('rowCounts',{displayed:result.displayedRows,total:result.comparisonRows})}</caption><thead className="border-y border-border bg-muted/40"><tr>{columns.map(column=><th className={'whitespace-nowrap px-4 py-3 font-medium '+(column.numeric?'text-right':'text-left')} key={column.id}>{t(`columns.${column.id}`)}</th>)}</tr></thead><tbody>{result.rows.map(row=><tr key={JSON.stringify([row.employmentId,row.companyId,row.currency])} className={'border-b border-border '+(row.reason.reason==='unexplained'?'bg-red-50/60 dark:bg-red-950/20':'')}>{columns.map(column=>{
      const value=payrollComparisonCell(row,column.id,t),positive=column.id==='variance'&&value!==null&&!value.startsWith('-');
      return <td key={column.id} className={'px-4 py-3 align-top '+(column.numeric?'whitespace-nowrap text-right tabular-nums ':'')+(column.id==='variance'&&value!==null?(positive?'text-blue-700 dark:text-blue-300':'text-orange-700 dark:text-orange-300'):'')}>{column.id==='reason'?<span className="whitespace-nowrap rounded-full bg-muted px-2 py-1 text-xs">{t(`reasons.${row.reason.reason}`)}{row.reason.prorated?' · '+t('prorated'):''}</span>:value??t('notAvailable')}</td>;
    })}</tr>)}{!result.rows.length&&<tr><td className="p-8 text-center text-muted-foreground" colSpan={columns.length}>{result.available?t('noRows'):t('unavailable')}</td></tr>}</tbody></table></div>
      <div className="flex justify-between gap-4 p-4 text-sm"><span>{t('page',{page:filters.page})}</span><div className="flex gap-4">{filters.page>1&&<Link href={'?'+query({page:filters.page-1})}>{t('previous')}</Link>}{filters.page*filters.pageSize<result.displayedRows&&<Link href={'?'+query({page:filters.page+1})}>{t('next')}</Link>}</div></div></Card>
    <details className="rounded-xl border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">{t('sourceRuns')}</summary><ul className="mt-3 space-y-1 text-xs text-muted-foreground">{result.runs.map(batch=><li key={batch.id}>{options.companies.find(company=>company.id===batch.companyId)?.name} · {batch.period} · {t(`runTypes.${batch.runType}`)} · {t(`runStates.${batch.status}`)} · {batch.id}</li>)}</ul></details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('basis')}</p>
  </div>;
}
