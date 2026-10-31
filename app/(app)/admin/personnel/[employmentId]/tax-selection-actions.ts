'use server';
import {revalidatePath} from 'next/cache';
import {redirect} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {packFor} from '@/localization/registry';
import {payrollTaxContextQuery} from '@/lib/payroll-tax-context-query';
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export async function savePayrollTaxSelectionAction(form:FormData){
 const session=await requireAdmin();const employmentId=String(form.get('employmentId')??'');const batchId=String(form.get('payrollBatchId')??'');
 if(!uuid.test(employmentId)||!uuid.test(batchId))redirect('/payroll');
 const q=payrollTaxContextQuery(form.get('payrollFrom'),form.get('payrollJob'));
 const service=packFor('MY')?.statutory.saveTaxSelection;
 if(!service)redirect('/payroll');
 try{await service(session,{employmentId,scheme:String(form.get('taxResidency')??''),expectedCompanyId:String(form.get('expectedCompanyId')??''),expectedVersion:Number(form.get('expectedVersion')),payrollBatchId:batchId,expectedPayPeriod:String(form.get('expectedPayPeriod')??'')});}
 catch(error){const code=error instanceof Error&&error.name==='TaxSelectionError'&&'code' in error&&['confirmation_required','invalid_scheme','citizenship_unknown','not_resident','stale_context','not_found'].includes(String(error.code))?String(error.code):'saveFailed';q.set('taxSelectionError',code);redirect(`/payroll/${batchId}/tax-configuration/${employmentId}?${q}`);}
 revalidatePath(`/payroll/${batchId}/tax-configuration/${employmentId}`);revalidatePath(`/admin/personnel/${employmentId}`);q.set('toast','Saved');redirect(`/payroll/${batchId}/tax-configuration/${employmentId}?${q}`);
}
