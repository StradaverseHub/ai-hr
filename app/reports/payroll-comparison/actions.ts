'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {scopedAdmin} from '@/lib/scope';
import {saveCustomReport,updateCustomReport,getCustomReport,ensurePayrollBasicVarianceSample} from '@/core/custom-reports';
import {PayrollReconciliationRemarkConflict,savePayrollReconciliationRemark} from '@/core/report-payroll-reconciliation-remarks';
import {payrollComparisonSpec} from '@/core/report-payroll-comparison';
import {DEFAULT_PAYROLL_COMPARISON,payrollComparisonFilters,validatePayrollComparisonDefinition} from '@/lib/payroll-period-comparison';
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
    if(previous?.spec.payrollComparison?.defaults) spec.payrollComparison!.defaults=previous.spec.payrollComparison.defaults;
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

export async function savePayrollReconciliationRemarkAction(query: string, companyId: string, employmentId: string,
  currency: string | null, rowPayItem: string | null, revision: number, form: FormData) {
  const {s,scopeIds}=await scopedAdmin();
  const values=new URLSearchParams(query);
  values.delete('noteError');
  const body=form.get('remark');
  try {
    if (typeof body !== 'string') throw new Error('Invalid remark.');
    await savePayrollReconciliationRemark(s,scopeIds,{filters:Object.fromEntries(values),companyId,employmentId,currency,rowPayItem:rowPayItem??undefined,revision,body});
  } catch (error) {
    // SQL errors can contain the confidential remark as a bound parameter.
    values.set('noteError',error instanceof PayrollReconciliationRemarkConflict?'conflict':'failed');
  }
  revalidatePath('/reports/payroll-comparison/reconciliation');
  redirect('/reports/payroll-comparison/reconciliation?'+values);
}

export async function saveReconciliationTemplateAction(query: string, form: FormData) {
  const {s,scopeIds}=await scopedAdmin();
  const search=new URLSearchParams(query);
  let destination='/reports/payroll-comparison/reconciliation?'+search;
  try {
    const name=form.get('name');
    if(typeof name!=='string'||!name.trim()||name.length>150)throw new Error('Invalid template name.');
    const {payItemCode='BASIC',...raw}=Object.fromEntries(search);
    const filters=payrollComparisonFilters(raw,DEFAULT_PAYROLL_COMPARISON);
    if(filters.companyId&&!scopeIds.includes(filters.companyId))throw new Error('Company unavailable.');
    const definition=validatePayrollComparisonDefinition({...DEFAULT_PAYROLL_COMPARISON,payItemCode,
      compareMode:filters.previousPeriod?'specific':'previous',previousPeriod:filters.previousPeriod,
      runType:filters.runType,minVariance:filters.minVariance,onlyVariances:filters.onlyVariances,
      defaults:{currentPeriod:filters.currentPeriod,companyId:filters.companyId,departmentId:filters.departmentId,
        businessUnitId:filters.businessUnitId,positionId:filters.positionId,employmentId:filters.employmentId,
        employmentType:filters.employmentType,employmentStatus:filters.employmentStatus,groupBy:filters.groupBy,cycleIds:filters.cycleIds,previousCycleIds:filters.previousCycleIds}});
    const spec=payrollComparisonSpec(definition);
    const saved=await saveCustomReport(s,{name:name.trim(),datasetId:spec.datasetId,spec,companyIds:scopeIds});
    revalidatePath('/payroll/reconciliation');
    destination='/reports/payroll-comparison/'+saved.id;
  } catch {
    search.set('templateError','1');
    destination='/reports/payroll-comparison/reconciliation?'+search;
  }
  redirect(destination);
}
