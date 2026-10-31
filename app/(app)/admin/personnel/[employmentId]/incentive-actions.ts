'use server';

import {redirect} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {packFor} from '@/localization/registry';
import {payrollTaxContextQuery} from '@/lib/payroll-tax-context-query';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Retired declaration controls may still be submitted from an older open browser tab.
// Resolve the visible employer context before redirecting; never write or revoke historical records.
async function redirectToSelection(formData:FormData):Promise<never>{
  const session=await requireAdmin();
  const employmentId=String(formData.get('employmentId')??'');
  const batchValue=String(formData.get('payrollBatchId')??'');
  const contextual=formData.has('payrollBatchId');
  if(!uuid.test(employmentId)||(contextual&&!uuid.test(batchValue)))redirect(contextual?'/payroll':'/admin/personnel');
  const service=packFor('MY')?.statutory.getTaxSelection;
  if(!service)redirect(contextual?'/payroll':'/admin/personnel');
  try{await service(session,employmentId,contextual?batchValue:undefined);}
  catch{redirect(contextual?'/payroll':'/admin/personnel');}
  if(contextual){
    const q=payrollTaxContextQuery(formData.get('payrollFrom'),formData.get('payrollJob'));
    redirect(`/payroll/${batchValue}/tax-configuration/${employmentId}${q.size?`?${q}`:''}#income-tax-resident`);
  }
  const q=new URLSearchParams({tab:'bankStatutory'});
  if(formData.get('from')==='org')q.set('from','org');
  const asOf=String(formData.get('asOf')??'');
  if(/^\d{4}-\d{2}-\d{2}$/.test(asOf))q.set('asOf',asOf);
  redirect(`/admin/personnel/${employmentId}?${q}#income-tax-resident`);
}

export async function saveIncentiveDeclarationAction(formData:FormData){return redirectToSelection(formData);}
export async function revokeIncentiveDeclarationAction(formData:FormData){return redirectToSelection(formData);}
