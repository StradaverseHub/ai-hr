'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {saveCustomReport,updateCustomReport,getCustomReport,ensurePayrollBasicVarianceSample} from '@/core/custom-reports';
import {payrollComparisonSpec} from '@/core/report-payroll-comparison';
import {validatePayrollComparisonDefinition} from '@/lib/payroll-period-comparison';
import {publicErrorMessage} from '@/lib/public-error';
import {getTranslations} from 'next-intl/server';
import {PayrollComparisonInputError} from '@/lib/payroll-period-comparison';
export async function savePayrollComparisonAction(form:FormData):Promise<{error:string}|null>{
  const {s,scopeIds}=await scopedAdmin(),id=String(form.get('id')??'');
  const t=await getTranslations('payrollComparison');
  let destination='/reports?cat=payroll';
  try{
    const name=String(form.get('name')??'').trim(),description=String(form.get('description')??'').trim();
    if(!name||name.length>150||description.length>1000)throw new Error('Enter a name up to 150 characters and a description up to 1000 characters.');
    const compareMode=String(form.get('compareMode')??'previous');
    const definition=validatePayrollComparisonDefinition({version:1,payItemCode:String(form.get('payItemCode')??'BASIC'),
      compareMode,previousPeriod:compareMode==='specific'?String(form.get('previousPeriod')??''):null,
      runType:String(form.get('runType')??'regular'),minVariance:String(form.get('minVariance')??'0.01'),
      autoTag:form.get('autoTag')==='on',onlyVariances:form.get('onlyVariances')==='on',columns:form.getAll('columns'),roles:form.getAll('roles')});
    const previous=id?await getCustomReport(s,id,scopeIds,'edit'):null;
    if(id&&!previous)throw new Error('Report unavailable.');
    const spec=payrollComparisonSpec(definition);spec.layout={...previous?.spec.layout,description};
    if(id){await updateCustomReport(s,{id,name,spec,shared:previous!.shared,version:Number(form.get('version')),companyIds:scopeIds});destination='/reports/payroll-comparison/'+id;}
    else{const saved=await saveCustomReport(s,{name,datasetId:spec.datasetId,spec,companyIds:scopeIds});destination='/reports/payroll-comparison/'+saved.id;}
    revalidatePath('/reports');
  }catch(error){return {error:error instanceof PayrollComparisonInputError&&error.code==='roles'?t('rolesRequired'):publicErrorMessage(error)};}
  redirect(destination);
}

/** Invoked only by an explicit signed-in user action; no GET or deployment-time impersonation. */
export async function createPayrollComparisonSampleAction(){
  const {s,scopeIds}=await scopedAdmin();let destination='/reports?cat=payroll';
  try{
    const saved=await ensurePayrollBasicVarianceSample(s,scopeIds);
    revalidatePath('/reports');destination='/reports/payroll-comparison/'+saved.id;
  }catch(error){destination+='&error='+encodeURIComponent(publicErrorMessage(error));}
  redirect(destination);
}
