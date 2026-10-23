'use server';
import { publicErrorMessage } from '@/lib/public-error';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { archiveAllowancePolicy,createAllowancePolicy,DuplicateAllowancePolicyCodeError,getAllowancePolicy,setAllowancePolicyStatus,StaleAllowancePreviewError,transferAllowancesToBatch,updateAllowancePolicy,validateAllowanceRules,type AllowancePolicyType } from '@/packs/attendance/service';
import { AllowancePayrollConflictError, BatchNotDraftError } from '@/packs/payroll/service';
import type { AttendanceAllowanceCriteria,AttendanceAllowanceScope } from '@/db/schema';
const PAGE='/admin/attendance-allowance';
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(fd:FormData,key:string)=>String(fd.get(key)??'').trim();
function legacyCriteria(fd:FormData):AttendanceAllowanceCriteria{
  const out:AttendanceAllowanceCriteria={};
  for(const key of ['minAttendanceDays','maxAbsentDays','maxLateCount','maxTotalLeaveDays'] as const){const v=text(fd,key);if(v){if(!/^\d+$/.test(v))throw new Error('Legacy thresholds must be non-negative whole days or counts');out[key]=Number(v);}}
  if(fd.get('requirePerfectAttendance')==='on')out.requirePerfectAttendance=true;
  return out;
}
function legacyScope(fd:FormData):AttendanceAllowanceScope{
  const out:AttendanceAllowanceScope={};for(const key of ['departmentIds','businessUnitIds','companyIds'] as const){const values=fd.getAll(key).map(String);if(values.some(v=>!uuid(v)))throw new Error('Invalid policy scope');if(values.length)out[key]=values;}return out;
}
async function message(error:unknown){
  const t=await getTranslations('allowanceV2.errors');
  if(error instanceof DuplicateAllowancePolicyCodeError)return t('duplicateCode');
  if(error instanceof StaleAllowancePreviewError)return t('stalePreview');
  if(error instanceof BatchNotDraftError)return t('payrollLocked');
  if(error instanceof AllowancePayrollConflictError)return t('payrollConflict');
  return publicErrorMessage(error);
}
async function scopedPolicy(id:string){
  const {s,scopeIds}=await scopedAdmin();
  if(!uuid(id))throw new Error('Invalid policy');
  const policy=await getAllowancePolicy(s,id);
  if(!policy||!scopeIds.includes(policy.companyId))throw new Error('This policy is outside the selected company scope');
  return {s,policy};
}
export async function saveAllowancePolicyFormAction(_state:{error:string|null},fd:FormData):Promise<{error:string|null}>{
  let reviewPath:string|undefined;
  try{
    const {s,scopeIds}=await scopedAdmin();
    const companyId=text(fd,'companyId'),id=text(fd,'id');
    if(!scopeIds.includes(companyId))throw new Error('Choose a company in the selected scope');
    if(id){const existing=await getAllowancePolicy(s,id);if(!existing||existing.companyId!==companyId)throw new Error('Policy does not belong to the selected company');}
    if(fd.get('reviewed')!=='on')throw new Error('Review and confirm the policy before saving');
    const raw=text(fd,'rules');if(raw.length>250000)throw new Error('Too many policy conditions');
    const rules=raw?validateAllowanceRules(JSON.parse(raw)):null;
    if(!id&&!rules)throw new Error('New policies require the attendance and employee conditions');
    const policyType=text(fd,'policyType');if(policyType!=='earning'&&policyType!=='deduction')throw new Error('Choose Earning or Deduction');
    const input={companyId,code:text(fd,'code'),name:text(fd,'name'),policyType:policyType as AllowancePolicyType,method:text(fd,'method'),amount:text(fd,'amount'),payComponentId:text(fd,'payComponentId'),effectiveFrom:text(fd,'effectiveFrom'),rules,...(!rules?{criteria:legacyCriteria(fd),scope:legacyScope(fd)}:{})};
    const saved=id?(await updateAllowancePolicy(s,{id,...input})):await createAllowancePolicy(s,input);
    if(rules&&(rules.v===3||rules.v===4))reviewPath=`${PAGE}/${saved.id}`;
    revalidatePath(PAGE);if(id)revalidatePath(`${PAGE}/${id}`);
  }catch(error){return {error:await message(error)};}
  redirect(reviewPath??PAGE);
}
async function runStatus(fd:FormData,archive:boolean){
  let error:string|undefined;
  try{const id=text(fd,'id');const {s}=await scopedPolicy(id);if(archive)await archiveAllowancePolicy(s,{id});else await setAllowancePolicyStatus(s,{id,status:text(fd,'status'),previewMonth:text(fd,'previewMonth'),expectedDigest:text(fd,'expectedDigest'),reviewed:fd.get('activationReviewed')==='on'});revalidatePath(PAGE);}catch(e){error=await message(e);}
  redirect(error?`${PAGE}?error=${encodeURIComponent(error)}`:PAGE);
}
export async function setAllowanceStatusAction(fd:FormData){return runStatus(fd,false);}
export async function archiveAllowancePolicyAction(fd:FormData){return runStatus(fd,true);}
export async function transferAllowanceAction(fd:FormData){
  const id=text(fd,'id'),batchId=text(fd,'batchId');let error:string|undefined;
  try{
    const {s}=await scopedPolicy(id);
    const expectedDigest=text(fd,'inputDigest');
    if(!uuid(batchId)||!/^[0-9a-f]{64}$/i.test(expectedDigest))throw new Error('Preview a payroll run before transferring');
    const result=await transferAllowancesToBatch(s,{policyId:id,batchId,expectedDigest,reprocess:fd.get('reprocess')==='on'});
    if(result.gated)throw new Error('The typed payroll component module must be enabled before transferring');
    revalidatePath(PAGE);revalidatePath(`${PAGE}/${id}`);revalidatePath('/payroll');
  }catch(e){error=await message(e);}
  const query=new URLSearchParams({batchId,...(error?{error}:{transferred:'1'})});
  redirect(`${PAGE}/${uuid(id)?id:''}?${query}`);
}

/** Read-only searches retain the selected company scope and the service's own access checks. */
export async function searchAllowanceEmployees(input: import('@/packs/attendance/service').AllowanceEmployeePageInput) {
  const {s,scopeIds}=await scopedAdmin();
  if(!scopeIds.includes(input.companyId))throw new Error('Choose a company in the selected scope');
  const {allowanceEmployeePage}=await import('@/packs/attendance/service');
  return allowanceEmployeePage(s,input);
}
export async function searchAllowanceEmployeeValues(input: {companyId:string;field:import('@/lib/allowance-employee-expression').AllowanceEmployeeFieldV4;query:string;page:number;selected?:string[]}) {
  const {s,scopeIds}=await scopedAdmin();
  if(!scopeIds.includes(input.companyId))throw new Error('Choose a company in the selected scope');
  const {allowanceEmployeeValues}=await import('@/packs/attendance/service');
  return allowanceEmployeeValues(s,input);
}

export async function previewAllowanceEmployeeSelection(input:{companyId:string;rules:unknown;method:string;month:string}) {
  const {s,scopeIds}=await scopedAdmin();
  if(!scopeIds.includes(input.companyId))throw new Error('Choose a company in the selected scope');
  const {previewAllowanceEmployees}=await import('@/packs/attendance/service');
  return previewAllowanceEmployees(s,input);
}
