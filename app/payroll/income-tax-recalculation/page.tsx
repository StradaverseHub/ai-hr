import {getTranslations} from 'next-intl/server';
import {requirePayrollAccess} from '@/lib/authz';
import {taxBasisOptions,listTaxBasisBatches,getTaxBasisBatch} from '@/packs/payroll/service';
import {PageHeader,pageWideCls} from '@/components/ui';
import type {TaxBasisSelection} from '@/lib/payroll-tax-basis';
import {TaxBasisWorkflow} from './workflow';
import {TaxBasisHistory} from './history';

export default async function TaxBasisPage({searchParams}:{searchParams:Promise<{retry?:string;company?:string;year?:string;month?:string}>}){
  const ctx=await requirePayrollAccess(),t=await getTranslations('payrollTaxBasis');
  const {retry,company,year,month}=await searchParams;
  const [options,batches]=await Promise.all([taxBasisOptions(ctx),listTaxBasisBatches(ctx)]);
  const assessmentYear=Number(year),finalMonth=Number(month);
  let initialSelection:TaxBasisSelection|undefined =
    company && options.companies.some(row=>row.id===company) && options.years.includes(assessmentYear)
      && Number.isInteger(finalMonth) && finalMonth>=1 && finalMonth<=12
      ? {companyId:company,year:assessmentYear,upToMonth:finalMonth,employmentIds:null}
      : undefined;
  if(retry&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(retry)){
    const batch=await getTaxBasisBatch(ctx,retry);
    const failed=batch?.employees.filter(employee=>employee.status==='failed').map(employee=>employee.id)??[];
    if(batch&&failed.length)initialSelection={companyId:batch.companyId,year:batch.year,upToMonth:batch.upToMonth,employmentIds:failed};
  }
  return <div className={pageWideCls}><PageHeader title={t('title')} description={t('description')} back={{href:'/payroll/setup',label:t('backSettings')}}/><TaxBasisWorkflow options={options} initialSelection={initialSelection}/><TaxBasisHistory batches={batches}/></div>;
}
