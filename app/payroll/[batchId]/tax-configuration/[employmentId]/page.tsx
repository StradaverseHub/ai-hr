import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {packFor} from '@/localization/registry';
import {PageHeader,pageWideCls,Card,Button} from '@/components/ui';
import {ScopedTaxResidencyField} from './scoped-tax-residency-field';
import {savePayrollTaxSelectionAction} from '@/app/admin/personnel/[employmentId]/tax-selection-actions';
import {payrollTaxContextQuery} from '@/lib/payroll-tax-context-query';
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export default async function PayrollTaxConfigurationPage({params,searchParams}:{params:Promise<{batchId:string;employmentId:string}>;searchParams:Promise<{taxSelectionError?:string;from?:string;job?:string}>}){
 const session=await requireAdmin();const {batchId,employmentId}=await params;if(!uuid.test(batchId)||!uuid.test(employmentId))notFound();
 const t=await getTranslations('payroll.taxConfiguration');const tp=await getTranslations('people.detail');const tc=await getTranslations('common');
 let view;try{view=await packFor('MY')?.statutory.getTaxSelection?.(session,employmentId,batchId);}catch(error){if(error instanceof Error&&error.name==='TaxSelectionError'&&'code' in error&&error.code==='not_found')notFound();throw error;}if(!view)notFound();
 const query=await searchParams;const q=payrollTaxContextQuery(query.from,query.job);const errorCode=['confirmation_required','invalid_scheme','citizenship_unknown','not_resident','stale_context','not_found','custom_value_missing','custom_value_invalid','saveFailed'].includes(query.taxSelectionError??'')?query.taxSelectionError:undefined;
 const none=view.scheme==='none';
 const selectedScheme=view.transitionState==='resolved'&&['resident','non_resident','rep','knowledge_worker','c_suite','custom_fixed','custom_rate'].includes(view.scheme??'')?view.scheme??'':'';
 return <div className={pageWideCls}><PageHeader title={t('title')} back={{href:`/payroll/${batchId}/reprocess${q.size?`?${q}`:''}`,label:t('back')}} description={t('context',{employee:view.employeeCode??employmentId,employer:view.companyName,period:view.payPeriod??''})}/><p className="mb-4 text-sm text-muted-foreground">{t('permissionHint')}</p><Card className="p-4">
 <form action={savePayrollTaxSelectionAction} className="flex flex-col gap-4"><input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="payrollBatchId" value={batchId}/><input type="hidden" name="expectedCompanyId" value={view.companyId}/><input type="hidden" name="expectedVersion" value={view.version}/><input type="hidden" name="expectedPayPeriod" value={view.payPeriod}/><input type="hidden" name="payrollFrom" value={q.get('from')??''}/><input type="hidden" name="payrollJob" value={q.get('job')??''}/>
 <ScopedTaxResidencyField none={none} defaultScheme={selectedScheme} savedAmount={view.customPcbAmount??null} savedRate={view.customPcbRate??null}/>
 <p className="text-sm text-muted-foreground">{tp('taxSelectionEligibilityHint')}</p>{view.transitionState==='confirmation_required'&&<p className="text-sm text-amber-700">{tp('taxSelectionConfirmationRequired')}</p>}{errorCode&&<p role="alert" className="text-sm text-destructive">{t(`error_${errorCode}`)}</p>}<div><Button type="submit">{tc('save')}</Button></div></form></Card></div>;
}
