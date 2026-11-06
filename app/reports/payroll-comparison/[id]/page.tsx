import {Fragment} from 'react';
import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {getCustomReport,runPayrollComparisonReport,recordPayrollComparisonRun} from '@/core/custom-reports';
import {payrollComparisonOptions} from '@/core/report-payroll-comparison';
import {MasterReportAccessError} from '@/core/employee-master-access';
import {PageHeader,Card,ErrorBanner} from '@/components/ui';
import {payrollComparisonColumns,payrollComparisonCell} from '@/lib/payroll-comparison-presentation';
import {PAYROLL_COMPARISON_REASON_FILTERS,PAYROLL_COMPARISON_EMPLOYMENT_TYPES,PAYROLL_COMPARISON_GROUPS} from '@/lib/payroll-period-comparison';
import {savePayrollReconciliationRemarkAction,saveReconciliationTemplateAction} from '../actions';
import {PayrollComparisonEditor} from '../PayrollComparisonEditor';
import {publicErrorMessage} from '@/lib/public-error';
export const dynamic='force-dynamic';
export default async function PayrollComparisonPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const {s,scopeIds}=await scopedAdmin(),{id}=await params,sp=await searchParams,t=await getTranslations('payrollComparison');
  let options:Awaited<ReturnType<typeof payrollComparisonOptions>>;
  try{options=await payrollComparisonOptions(s,scopeIds);}
  catch(error){if(error instanceof MasterReportAccessError)notFound();throw error;}
  const builtIn = id === 'reconciliation';
  if(sp.edit==='1'){
    if (builtIn) notFound();
    const report=await getCustomReport(s,id,scopeIds,'edit').catch(()=>null);if(!report?.spec.payrollComparison)notFound();
    return <div className="space-y-5"><PageHeader title={t('editReport')} back={{href:'/reports/payroll-comparison/'+id,label:t('back')}}/>{sp.error&&<ErrorBanner message={typeof sp.error === 'string' ? sp.error : undefined}/>}<Card className="p-6"><PayrollComparisonEditor key={id+':'+report.version} id={id} version={report.version} name={report.name} description={report.spec.layout?.description??''} initial={report.spec.payrollComparison} payItems={options.payItems}/></Card></div>;
  }
  const raw=Object.fromEntries(Object.entries(sp).filter(([key,value])=>key!=='error'&&key!=='edit'&&key!=='noteError'&&key!=='templateError'&&value!==undefined));
  let run:Awaited<ReturnType<typeof runPayrollComparisonReport>>;
  try{run=await runPayrollComparisonReport(s,scopeIds,{id,filters:raw});await recordPayrollComparisonRun(s,run,builtIn?'preview':'run');}
  catch(error){if(error instanceof MasterReportAccessError)notFound();return <div className="space-y-4"><PageHeader title={t('title')} back={{href:'/reports?cat=payroll',label:t('back')}}/><ErrorBanner message={publicErrorMessage(error)}/><Link href={'/reports/payroll-comparison/'+id}>{t('reset')}</Link></div>;}
  const people=await getTranslations('people.detail.employmentInfo');
  const {result,filters}=run,columns=payrollComparisonColumns(run.definition);
  const query=(changes:Record<string,string|number|null>={})=>{
    const values={...filters,...(builtIn?{payItemCode:run.definition.payItemCode}:{}),onlyVariances:filters.onlyVariances?'1':'0',...changes},search=new URLSearchParams();
    for(const [key,value]of Object.entries(values))if(value!==null)search.set(key,String(value));return search.toString();
  };
  const input='mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';
  return <div className="space-y-5">
    <nav aria-label={t('breadcrumb')} className="text-sm text-muted-foreground"><Link href="/reports">{t('reports')}</Link> › <Link href="/reports?cat=payroll">{t('payroll')}</Link> › {t('customReports')}</nav>
    <PageHeader title={builtIn ? t('title') : run.name} description={run.description||t('reportHelp')}/>
    <div className="flex flex-wrap items-center justify-between gap-3">{!builtIn && <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">{t('customTag')}</span>}<div className="flex gap-3 text-sm">{!builtIn&&run.canEdit&&<Link className="rounded-lg border border-border px-3 py-2" href={'/reports/payroll-comparison/'+id+'?edit=1'}>{t('editReport')}</Link>}{run.canExport&&(['pdf','xlsx']as const).map(format=><a key={format} className="rounded-lg bg-primary px-3 py-2 text-primary-foreground" href={'/reports/payroll-comparison/export?id='+id+'&format='+format+'&'+query()}>{t(format==='pdf'?'exportPdf':'exportExcel')}</a>)}</div></div>
    {builtIn&&sp.noteError&&<ErrorBanner message={t(sp.noteError==='conflict'?'hrRemarkConflict':'hrRemarkFailed')}/>}
    {builtIn&&sp.templateError&&<ErrorBanner message={t('saveFailed')}/>}
    {result.provisional&&<div role="status" className="rounded-xl border border-border bg-muted/50 p-4 text-sm text-foreground">{t('provisional')}</div>}
    {!result.available&&<div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm"><p className="font-semibold">{t('unavailable')}</p><ul className="mt-2 list-inside list-disc">{result.issues.map((issue,index)=><li key={index}>{t(`issues.${issue.code}`)} · {issue.period} · {options.companies.find(company=>company.id===issue.companyId)?.name??issue.companyId}</li>)}</ul></div>}
    {run.contextUnavailable&&<p role="status" className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t('contextUnavailable')}</p>}
    {builtIn&&run.canEdit&&<details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">{t('saveTemplate')}</summary><form action={saveReconciliationTemplateAction.bind(null,query({employeeSearch:null,page:1}))} className="mt-3 flex flex-wrap items-end gap-2"><label className="text-sm">{t('reportName')}<input className={input} name="name" required maxLength={150}/></label><button className="rounded-md border border-border px-3 py-2 text-sm">{t('saveTemplate')}</button></form></details>}
    <Card className="p-5"><form key={query()} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" method="get">
      <label className="text-sm font-medium">{t('company')}<select className={input} name="companyId" defaultValue={filters.companyId??''}><option value="">{t('allCompanies')}</option>{options.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('previousPeriod')}<input className={input} type="month" name="previousPeriod" defaultValue={filters.previousPeriod??''} required/></label>
      <label className="text-sm font-medium">{t('currentPeriod')}<input className={input} type="month" name="currentPeriod" defaultValue={filters.currentPeriod??''} required/></label>
      {builtIn&&<label className="text-sm font-medium">{t('payItem')}<select className={input} name="payItemCode" defaultValue={run.definition.payItemCode}>
        {options.payItems.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}
      </select></label>}
      <label className="text-sm font-medium">{t('runs')}<select className={input} name="runType" defaultValue={filters.runType}><option value="regular">{t('regular')}</option><option value="all">{t('allRuns')}</option></select></label>
      <label className="text-sm font-medium">{t('payCycles')}
        <select className={input} name="cycleIds" multiple size={Math.min(4, Math.max(2, options.cycles.length))} defaultValue={filters.cycleIds ?? []}>
          {options.cycles.map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.name} · {options.companies.find(company => company.id === cycle.companyId)?.name}</option>)}
        </select>
      </label>
      <label className="text-sm font-medium">{t('department')}<select className={input} name="departmentId" defaultValue={filters.departmentId??''}><option value="">{t('allDepartments')}</option>{options.departments.map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('businessUnit')}<select className={input} name="businessUnitId" defaultValue={filters.businessUnitId??''}><option value="">{t('noGrouping')}</option>{options.businessUnits.map(unit=><option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('position')}<select className={input} name="positionId" defaultValue={filters.positionId??''}><option value="">{t('noGrouping')}</option>{options.positions.map(position=><option key={position.id} value={position.id}>{position.name}</option>)}</select></label>
      <label className="text-sm font-medium">{t('employmentType')}<select className={input} name="employmentType" defaultValue={filters.employmentType??''}><option value="">{t('noGrouping')}</option>{PAYROLL_COMPARISON_EMPLOYMENT_TYPES.map(type=><option key={type} value={type}>{people(`employmentType_${type}`)}</option>)}</select></label>
      {filters.employmentId&&<input type="hidden" name="employmentId" value={filters.employmentId}/>}
      <label className="text-sm font-medium">{t('employeeSearch')}<input className={input} type="search" name="employeeSearch" maxLength={100} defaultValue={filters.employeeSearch??''}/></label>
      <label className="text-sm font-medium">{t('groupBy')}<select className={input} name="groupBy" defaultValue={filters.groupBy??''}><option value="">{t('noGrouping')}</option>{PAYROLL_COMPARISON_GROUPS.map(group=><option key={group} value={group}>{group==='businessUnit'?t('businessUnit'):t(`columns.${group}`)}</option>)}</select></label>
      <label className="text-sm font-medium">{t('minimum')}<input className={input} type="number" name="minVariance" min="0" step="0.01" defaultValue={filters.minVariance} required/></label>
      <label className="text-sm font-medium">{t('onlyVariances')}<select className={input} name="onlyVariances" defaultValue={filters.onlyVariances?'1':'0'}><option value="1">{t('yes')}</option><option value="0">{t('no')}</option></select></label>
      <div className="flex items-end gap-3"><Link className="rounded-lg border border-border px-3 py-2 text-sm" href={'/reports/payroll-comparison/'+id}>{t('reset')}</Link><button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" type="submit">{t('generate')}</button></div>
    </form></Card>
    {result.summary&&<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><Card className="p-4"><p className="text-xs text-muted-foreground">{t('headcount')}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{result.summary.previousHeadcount} → {result.summary.currentHeadcount}</p><p className="mt-2 text-xs text-muted-foreground">{t('joinersLeavers',{joiners:result.summary.joiners,leavers:result.summary.leavers})}</p></Card>
      {['previous','current','variance'].map(field=><Card key={field} className="p-4"><p className="text-xs text-muted-foreground">{t(`columns.${field}`)} · {run.definition.payItemCode}</p>{result.summary!.totals.map(total=><p key={total.currency??total.companyId} className="mt-2 font-semibold tabular-nums">{total.currency??t('currencyUnknown')} {total[field as 'previous'|'current'|'variance']??t('notAvailable')}{total.companyId&&<span className="block text-xs font-normal text-muted-foreground">{options.companies.find(company=>company.id===total.companyId)?.name}</span>}{field==='variance'&&<span className="ml-2 text-xs">({total.variancePct??t('notAvailable')}{total.variancePct!==null?'%':''})</span>}</p>)}</Card>)}
      <Card className="border-red-200 p-4"><p className="text-xs text-muted-foreground">{t('needsReview')}</p><p className="mt-2 text-2xl font-semibold text-red-700 dark:text-red-300">{result.summary.unexplained}</p></Card></div>}
    <div className="flex flex-wrap gap-2" aria-label={t('reasonFilters')}><Link className="rounded-full border border-border px-3 py-1 text-sm" aria-current={!filters.reason?'page':undefined} href={'?'+query({reason:null,page:1})}>{t('allReasons')} ({result.comparisonRows})</Link>{PAYROLL_COMPARISON_REASON_FILTERS.filter(reason=>!['increment','promotion','proratedLeaving'].includes(reason)&&(['unexplained','incrementPromotion','newHire','resigned','prorated'].includes(reason)||result.reasonFilterCounts[reason]>0)).map(reason=><Link key={reason} className={'rounded-full border px-3 py-1 text-sm '+(filters.reason===reason?'border-primary bg-primary/10 text-primary':'border-border')} aria-current={filters.reason===reason?'page':undefined} href={'?'+query({reason,page:1})}>{reason==='incrementPromotion'?t('incrementPromotion'):reason==='prorated'?t('prorated'):t(`reasons.${reason}`)} ({result.reasonFilterCounts[reason]})</Link>)}</div>
    <Card className="overflow-hidden"><div role="region" aria-label={t('comparisonTable')} tabIndex={0} className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"><table className="w-full text-sm"><caption className="p-4 text-left text-xs text-muted-foreground">{t('rowCounts',{displayed:result.displayedRows,total:result.comparisonRows})}</caption><thead className="border-y border-border bg-muted/40"><tr>{columns.map(column=><th className={'whitespace-nowrap px-4 py-3 font-medium '+(column.numeric?'text-right':'text-left')} key={column.id}>{t(`columns.${column.id}`)}</th>)}</tr></thead><tbody>{result.rows.map((row,index)=><Fragment key={JSON.stringify([row.employmentId,row.companyId,row.currency])}>{filters.groupBy&&(index===0||row[filters.groupBy]!==result.rows[index-1][filters.groupBy])&&<tr className="bg-muted/30"><th colSpan={columns.length} className="px-4 py-2 text-left font-medium">{row[filters.groupBy]??t('notAvailable')}</th></tr>}<tr className={'border-b border-border '+(row.reason.reason==='unexplained'?'bg-red-50/60 dark:bg-red-950/20':'')}>{columns.map(column=>{
      const value=payrollComparisonCell(row,column.id,t),positive=column.id==='variance'&&value!==null&&!value.startsWith('-');
      return <td key={column.id} className={'px-4 py-3 align-top '+(column.numeric?'whitespace-nowrap text-right tabular-nums ':'')+(column.id==='variance'&&value!==null?(positive?'text-blue-700 dark:text-blue-300':'text-orange-700 dark:text-orange-300'):'')}>{column.id==='reason'?<span className="whitespace-nowrap rounded-full bg-muted px-2 py-1 text-xs">{t(`reasons.${row.reason.reason}`)}{row.reason.prorated?' · '+t('prorated'):''}</span>:column.id==='remarks'&&builtIn&&run.canEdit?<div className="space-y-1">
        <div>{value}</div>
        <details><summary className="cursor-pointer text-primary">{t('hrRemarkEdit')}</summary>
          <form className="mt-2 grid min-w-48 gap-2" action={savePayrollReconciliationRemarkAction.bind(null,query(),row.companyId,row.employmentId,row.currency,row.hrRemark?.revision??0)}>
            <label className="grid gap-1 text-xs">{t('hrRemark')}<textarea name="remark" className={input} maxLength={1000} rows={3} defaultValue={row.hrRemark?.body??''}/></label>
            <button className="justify-self-start rounded-md border border-border px-2 py-1 text-xs">{t('hrRemarkSave')}</button>
          </form>
        </details>
      </div>:column.id==='employeeName'&&!filters.employmentId?<Link className="text-primary underline" href={'?'+query({employmentId:row.employmentId,employeeSearch:null,page:1})}>{value??t('notAvailable')}</Link>:value??t('notAvailable')}</td>;
    })}</tr></Fragment>)}{!result.rows.length&&<tr><td className="p-8 text-center text-muted-foreground" colSpan={columns.length}>{result.available?t('noRows'):t('unavailable')}</td></tr>}</tbody></table></div>
      <div className="flex justify-between gap-4 p-4 text-sm"><span>{t('page',{page:filters.page})}</span><div className="flex gap-4">{filters.page>1&&<Link href={'?'+query({page:filters.page-1})}>{t('previous')}</Link>}{filters.page*filters.pageSize<result.displayedRows&&<Link href={'?'+query({page:filters.page+1})}>{t('next')}</Link>}</div></div></Card>
    <details className="rounded-xl border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">{t('sourceRuns')}</summary><ul className="mt-3 space-y-1 text-xs text-muted-foreground">{result.runs.map(batch=><li key={batch.id}>{options.companies.find(company=>company.id===batch.companyId)?.name} · {batch.period} · {t(`runTypes.${batch.runType}`)} · {t(`runStates.${batch.status}`)} · {batch.id}</li>)}</ul></details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('basis')}</p>
  </div>;
}
