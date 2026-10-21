'use server';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requireWorkforceAccess} from '@/lib/workforce-authz';
import {setWorkforceEmployeeCode,WorkforceCodeValidationError,WorkforceRecordChangedError} from '@/core/workforce-code';
import {WorkforceAccessError} from '@/core/workforce-access';

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
