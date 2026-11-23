import {getTranslations} from 'next-intl/server';
import {requirePayrollAccess} from '@/lib/authz';
import Link from 'next/link';
import {taxBasisOptions,getTaxBasisBatch} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import type {TaxBasisSelection} from '@/lib/payroll-tax-basis';
import {TaxBasisWorkflow,type TaxBasisGroupProgressLink} from './workflow';

export default async function TaxBasisPage({searchParams}:{searchParams:Promise<{retry?:string;group?:string;phase?:string;company?:string;year?:string;month?:string;employee?:string}>}){
  const ctx=await requirePayrollAccess(),t=await getTranslations('payrollTaxBasis');
  const {retry,group,phase,company,year,month,employee}=await searchParams;
  const initialGroup:TaxBasisGroupProgressLink|undefined=group&&/^[\da-f-]{36}$/.test(group)&&(phase==='preview'||phase==='confirm')?{id:group,phase}:undefined;
  const options=await taxBasisOptions(ctx);
  const assessmentYear=Number(year),finalMonth=Number(month);
  let initialSelection:TaxBasisSelection|undefined =
    company && options.companies.some(row=>row.id===company) && options.years.includes(assessmentYear)
      && Number.isInteger(finalMonth) && finalMonth>=1 && finalMonth<=12
      ? {companyId:company,year:assessmentYear,upToMonth:finalMonth,employmentIds:employee && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(employee) ? [employee] : null}
      : undefined;
  if(retry&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(retry)){
    const batch=await getTaxBasisBatch(ctx,retry);
    const failed=batch?.employees.filter(employee=>employee.status==='failed').map(employee=>employee.id)??[];
    if(batch&&failed.length)initialSelection={companyId:batch.companyId,year:batch.year,upToMonth:batch.upToMonth,employmentIds:failed};
  }
  return <div className={pageWideCls}><PageHeader title={t('title')} description={t('description')} back={{href:'/payroll/setup',label:t('backSettings')}}
    actions={<Link href="/payroll/income-tax-recalculation/history" className="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('history')}</Link>}/>
    <TaxBasisWorkflow options={options} initialSelection={initialSelection} initialGroup={initialGroup}/></div>;
}
