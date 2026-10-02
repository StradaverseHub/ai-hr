import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {packFor} from '@/localization/registry';
import {PageHeader,pageWideCls,Card,Button,inputCls} from '@/components/ui';
import {savePayrollTaxSelectionAction} from '@/app/admin/personnel/[employmentId]/tax-selection-actions';
import {payrollTaxContextQuery} from '@/lib/payroll-tax-context-query';
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export default async function PayrollTaxConfigurationPage({params,searchParams}:{params:Promise<{batchId:string;employmentId:string}>;searchParams:Promise<{taxSelectionError?:string;from?:string;job?:string}>}){
 const session=await requireAdmin();const {batchId,employmentId}=await params;if(!uuid.test(batchId)||!uuid.test(employmentId))notFound();
 const t=await getTranslations('payroll.taxConfiguration');const tp=await getTranslations('people.detail');const tc=await getTranslations('common');
 let view;try{view=await packFor('MY')?.statutory.getTaxSelection?.(session,employmentId,batchId);}catch(error){if(error instanceof Error&&error.name==='TaxSelectionError'&&'code' in error&&error.code==='not_found')notFound();throw error;}if(!view)notFound();
 const query=await searchParams;const q=payrollTaxContextQuery(query.from,query.job);const errorCode=['confirmation_required','invalid_scheme','citizenship_unknown','not_resident','stale_context','not_found','saveFailed'].includes(query.taxSelectionError??'')?query.taxSelectionError:undefined;
 return <div className={pageWideCls}><PageHeader title={t('title')} description={t('context',{employee:view.employeeCode??employmentId,employer:view.companyName,period:view.payPeriod??''})}/><p className="mb-4 text-sm text-muted-foreground">{t('permissionHint')}</p><Link href={`/payroll/${batchId}/reprocess${q.size?`?${q}`:''}`} className="mb-4 inline-block text-sm text-primary">{t('back')}</Link><Card className="p-4">
 <form action={savePayrollTaxSelectionAction} className="flex flex-col gap-4"><input type="hidden" name="employmentId" value={employmentId}/><input type="hidden" name="payrollBatchId" value={batchId}/><input type="hidden" name="expectedCompanyId" value={view.companyId}/><input type="hidden" name="expectedVersion" value={view.version}/><input type="hidden" name="expectedPayPeriod" value={view.payPeriod}/><input type="hidden" name="payrollFrom" value={q.get('from')??''}/><input type="hidden" name="payrollJob" value={q.get('job')??''}/>
 <label className="flex flex-col gap-2">{tp('incomeTaxResident')}<select id="income-tax-resident" name="taxResidency" defaultValue={view.scheme??''} required className={inputCls}>{!view.scheme&&<option value="" disabled>{tp('taxSelectionChoose')}</option>}<option value="resident">{tp('taxResidencyResident')}</option><option value="non_resident">{tp('taxResidencyNonResident')}</option><option value="rep">{tp('taxResidencyRep')}</option><option value="knowledge_worker">{tp('taxResidencyKnowledgeWorker')}</option><option value="c_suite">{tp('taxResidencyCSuite')}</option></select></label>
 <p className="text-sm text-muted-foreground">{tp('taxSelectionEligibilityHint')}</p>{view.transitionState==='confirmation_required'&&<p className="text-sm text-amber-700">{tp('taxSelectionConfirmationRequired')}</p>}{errorCode&&<p role="alert" className="text-sm text-destructive">{t(`error_${errorCode}`)}</p>}<div><Button type="submit">{tc('save')}</Button></div></form></Card></div>;
}
