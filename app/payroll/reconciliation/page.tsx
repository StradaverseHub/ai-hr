import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {Card,PageHeader,ErrorBanner,inputCls,pageWideCls} from '@/components/ui';
import {listCustomReports,runPayrollComparisonReport,recordPayrollComparisonRun} from '@/core/custom-reports';
import {payrollComparisonOptions,payrollReconciliationPeriods} from '@/core/report-payroll-comparison';
import {MasterReportAccessError} from '@/core/employee-master-access';
import {scopedAdmin} from '@/lib/scope';
import {ALL_RECORDED_PAY_ITEMS} from '@/lib/payroll-period-comparison';
import {payrollComparisonCell} from '@/lib/payroll-comparison-presentation';
import {publicErrorMessage} from '@/lib/public-error';
import {ReconciliationFilters} from './filters';
export const dynamic='force-dynamic';
export default async function PayrollReconciliationPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {s,scopeIds}=await scopedAdmin(),sp=await searchParams,t=await getTranslations('payrollComparison');
 const raw=Object.fromEntries(Object.entries(sp).filter(([key,value])=>key!=='template'&&value!==undefined));
 let options:Awaited<ReturnType<typeof payrollComparisonOptions>>,run:Awaited<ReturnType<typeof runPayrollComparisonReport>>;
 try{
  options=await payrollComparisonOptions(s,scopeIds);
  run=await runPayrollComparisonReport(s,scopeIds,{id:'reconciliation',filters:{...raw,payItemCode:'__NETPAY__'}});
  await recordPayrollComparisonRun(s,run,'preview');
 }catch(error){if(error instanceof MasterReportAccessError)notFound();return <div className={pageWideCls}><PageHeader title={t('reconciliationTitle')}/><ErrorBanner message={publicErrorMessage(error)}/></div>;}
 const {filters,result}=run;
 const query=(changes:Record<string,string|number|null>={})=>{const q=new URLSearchParams();for(const [key,value]of Object.entries({...filters,onlyVariances:filters.onlyVariances?'1':'0',...changes}))if(value!==null&&value!==undefined)q.set(key,String(value));return q;};
 const returnQuery=query().toString();
 const [reports,periods]=await Promise.all([listCustomReports(s,{category:'payroll',companyIds:scopeIds}),payrollReconciliationPeriods(s,scopeIds)]);
 const status=(row:typeof result.rows[number])=>!row.previousPresent&&row.reason.reason==='newHire'?'statusNewJoiner':!row.currentPresent&&['resigned','proratedLeaving'].includes(row.reason.reason)?'statusLeaver':!row.previousPresent||!row.currentPresent?'statusOnePeriod':row.variance===null?'needsReview':row.variance==='0.00'?'statusNoVariance':'statusVariance';
 return <div className={pageWideCls+' space-y-5'}>
  <PageHeader title={t('reconciliationTitle')} description={t('summaryNetPay')} back={{href:'/payroll',label:t('payroll')}} actions={<Link href={'/reports/payroll-comparison/reconciliation?'+query({payItemCode:ALL_RECORDED_PAY_ITEMS,page:1})} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">{t('newComparison')}</Link>}/>
  <Card className="p-5"><ReconciliationFilters>
   <label className="grid gap-1 text-sm">{t('company')}<select name="companyId" className={inputCls} defaultValue={filters.companyId??''}><option value="">{t('allCompanies')}</option>{options.companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <label className="grid gap-1 text-sm">{t('currentPeriod')}<input type="month" name="currentPeriod" className={inputCls} defaultValue={filters.currentPeriod??''} required/></label>
   <label className="grid gap-1 text-sm">{t('payCycles')}<select name="cycleIds" className={inputCls} defaultValue={filters.cycleIds?.[0]??''}><option value="">{t('allPayCycles')}</option>{options.cycles.filter(c=>!filters.companyId||c.companyId===filters.companyId).map(c=><option key={c.id} value={c.id}>{c.name} · {options.companies.find(company=>company.id===c.companyId)?.name}</option>)}</select></label>
  </ReconciliationFilters><p className="mt-3 text-xs text-muted-foreground">{t('previousPeriod')}: {filters.previousPeriod} · {t('summaryNetPay')}</p></Card>
  {!result.available&&<ErrorBanner message={t('unavailable')}/>}<ul className="text-sm text-muted-foreground">{result.issues.map((issue,index)=><li key={index}>{t('issues.'+issue.code)} · {issue.period} · {options.companies.find(c=>c.id===issue.companyId)?.name}</li>)}</ul>
  <Card className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="p-4 text-left font-medium">{t('basicView')}</caption><thead className="border-y border-border bg-muted/40"><tr>{['employeeCode','employeeName','company','currency','current','previous','variance','variancePct','comparisonStatus','comparisonResults'].map(key=><th key={key} className="px-3 py-3">{t('columns.'+key)}</th>)}</tr></thead><tbody>{result.rows.map(row=>{
   const detail=query({employmentId:row.employmentId,payItemCode:ALL_RECORDED_PAY_ITEMS,employeeSearch:null,page:1});detail.set('returnQuery',returnQuery);
   return <tr key={JSON.stringify([row.employmentId,row.companyId,row.currency])} className="border-b border-border"><td className="p-3">{row.employeeCode}</td><td className="p-3">{row.employeeName}</td><td className="p-3">{row.company}</td><td className="p-3">{row.currency??t('currencyUnknown')}</td>{(['current','previous','variance','variancePct'] as const).map(key=><td key={key} className="p-3 tabular-nums">{payrollComparisonCell(row,key,t)??t('notAvailable')}{key==='variancePct'&&row.variancePct!==null?'%':''}</td>)}<td className="p-3">{t(status(row))}</td><td className="p-3"><Link className="text-primary underline" href={'/reports/payroll-comparison/reconciliation?'+detail}>{t('comparisonTable')}</Link></td></tr>;
  })}{!result.rows.length&&<tr><td colSpan={10} className="p-6 text-center text-muted-foreground">{result.available?t('noRows'):t('unavailable')}</td></tr>}</tbody></table><div className="flex justify-between p-4 text-sm"><span>{t('rowCounts',{displayed:result.displayedRows,total:result.comparisonRows})}</span><div className="flex gap-3">{filters.page>1&&<Link href={'?'+query({page:filters.page-1})}>{t('previous')}</Link>}{filters.page*filters.pageSize<result.displayedRows&&<Link href={'?'+query({page:filters.page+1})}>{t('next')}</Link>}</div></div></Card>
  <details className="rounded-xl border border-border p-4"><summary>{t('sourceRuns')}</summary><ul className="mt-3 text-sm">{periods.map(p=><li key={p.companyId+p.period}>{p.companyName} · {p.period} · {p.cycles.join(', ')} · {p.generatedAt??t('notAvailable')} · {p.requiresReprocessing?t('needsReview'):t('reconciliationReady')}</li>)}</ul></details>
  <details className="rounded-xl border border-border p-4"><summary>{t('customReports')}</summary><ul className="mt-3 space-y-2 text-sm">{reports.filter(r=>r.spec.payrollComparison).map(r=><li key={r.id}><Link className="text-primary underline" href={'/reports/payroll-comparison/'+r.id}>{r.name}</Link></li>)}</ul></details>
 </div>;
}
