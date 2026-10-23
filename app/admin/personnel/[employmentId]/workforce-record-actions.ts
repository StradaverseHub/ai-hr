'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requireWorkforceAccess} from '@/lib/workforce-authz';
import {setWorkforceEmployeeCode,WorkforceCodeValidationError,WorkforceRecordChangedError} from '@/core/workforce-code';
import {WorkforceAccessError} from '@/core/workforce-access';
import {maintainWorkforceRecord,WorkforceMaintenanceValidationError,WorkforceMaintenanceUnavailableError} from '@/core/workforce-maintenance';
import {workforceMaintenanceFields,WORKFORCE_PROFILE_SECTIONS,type WorkforceMaintenanceKind,type WorkforceMaintenanceOperation} from '@/lib/workforce-maintenance-fields';

/** Fixed command endpoint. Client identity, company, role and permission flags are never inputs. */
export async function saveWorkforceCodeAction(formData:FormData){
 const {s}=await requireWorkforceAccess();
 const id=String(formData.get('employmentId')??'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))redirect('/admin/personnel');
 const path=`/admin/personnel/${id}`;
 let outcome='saved';
 try{
  const raw=formData.get('expectedCode');let expected:unknown;
  try{expected=typeof raw==='string'&&raw.length<=100?JSON.parse(raw):undefined;}catch{expected=undefined;}
  if(expected!==null&&typeof expected!=='string')throw new WorkforceCodeValidationError('Employee ID baseline invalid');
  await setWorkforceEmployeeCode(s,{employmentId:id,employeeCode:String(formData.get('employeeCode')??''),expectedCode:expected});
 }catch(error){
  if(error instanceof WorkforceAccessError)outcome='denied';
  else if(error instanceof WorkforceRecordChangedError)outcome='changed';
  else if(error instanceof WorkforceCodeValidationError)outcome='invalid';
  else throw error;
 }
 revalidatePath(path);
 // Success survives the normal session/cookie refresh; no submitted value enters the redirect.
 redirect(`${path}?workforceCode=${outcome}`);
}

/** The server chooses the entire field set. Form identity/permission flags are never authority. */
export async function saveWorkforceRecordAction(formData:FormData){
 const {s}=await requireWorkforceAccess();
 const id=formData.get('employmentId');
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 if(typeof id!=='string'||!uuid.test(id))redirect('/admin/personnel');
 const path=`/admin/personnel/${id}`;
 let outcome='saved';
 try{
  const kind=formData.get('kind'),operation=formData.get('operation'),section=formData.get('section');
  const row=formData.get('rowId'),expected=formData.get('expectedVersion');
  if(!['person','qualification','emergency','dependent'].includes(String(kind))||!['add','update','archive'].includes(String(operation))||
   typeof kind!=='string'||typeof operation!=='string'||formData.getAll('operation').length!==1)
   throw new WorkforceMaintenanceValidationError();
  if(kind==='person'&&(operation!=='update'||row!=null||!WORKFORCE_PROFILE_SECTIONS.some(item=>item.key===section)))throw new WorkforceMaintenanceValidationError();
  if(kind!=='person'&&(operation==='add'?row!=null:typeof row!=='string'||!uuid.test(row)))throw new WorkforceMaintenanceValidationError();
  if(operation==='add'?expected!=null:typeof expected!=='string'||!/^\d{1,20}$/.test(expected))throw new WorkforceMaintenanceValidationError();
  const patch:Record<string,unknown>={};
  if(operation!=='archive')for(const {key,field}of workforceMaintenanceFields(kind as WorkforceMaintenanceKind,kind==='person'?String(section):undefined)){
   const value=formData.get(key);
   if(typeof value!=='string'||value.length>4000||formData.getAll(key).length!==1)throw new WorkforceMaintenanceValidationError();
   if(field.type==='boolean'){
    if(kind==='dependent'&&['spouseWorking','isStudent','childTaxRelief'].includes(key)&&value===''){patch[key]=null;continue;}
    if(value!=='true'&&value!=='false')throw new WorkforceMaintenanceValidationError();patch[key]=value==='true';
   }else patch[key]=value;
  }
  const result=await maintainWorkforceRecord(s,{employmentId:id,kind:kind as WorkforceMaintenanceKind,operation:operation as WorkforceMaintenanceOperation,
   rowId:typeof row==='string'?row:null,expectedVersion:typeof expected==='string'?expected:null,patch});
  if(result.hrReviewNotice)outcome='review';
 }catch(error){
  if(error instanceof WorkforceAccessError)outcome='denied';
  else if(error instanceof WorkforceRecordChangedError)outcome='changed';
  else if(error instanceof WorkforceMaintenanceValidationError)outcome='invalid';
  else if(error instanceof WorkforceMaintenanceUnavailableError)outcome='unavailable';
  else throw error;
 }
 revalidatePath(path);
 redirect(`${path}?workforceEdit=${outcome}`);
}
