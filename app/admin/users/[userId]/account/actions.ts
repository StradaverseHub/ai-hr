'use server';
import {getSession} from '@/lib/session';
import {manageAccount,type AccountCommand} from '@/core/account-management';
import {revalidatePath} from 'next/cache';
export type AccountActionState={status:'idle'|'saved'|'failed';password?:string;delivery?:'sent'|'failed'|'skipped'|'uncertain'};
export async function accountAction(_state:AccountActionState,form:FormData):Promise<AccountActionState>{
 try{
  if(form.get('confirmed')!=='on')throw Error('invalid');
  const type=String(form.get('type')),reason=String(form.get('reason')??''),userId=String(form.get('userId')??'');
  let command:AccountCommand;
  if(type==='suspend'||type==='reactivate'||type==='reset-email')command={type,reason};
  else if(type==='expiry')command={type,reason,activeUntil:String(form.get('activeUntil')??'')||null};
  else if(type==='temporary-password'){
   const password=String(form.get('password')??'');if(password&&password!==String(form.get('confirmPassword')??''))throw Error('invalid');
   command={type,reason,password:password||undefined,minutes:Number(form.get('minutes'))};
  }
  else if(type==='recovery-exemption')command={type,reason,minutes:Number(form.get('minutes'))};
  else throw Error('invalid');
  const result=await manageAccount(await getSession(),userId,command);
  revalidatePath('/admin/users');revalidatePath(`/admin/users/${userId}/account`);
  return {status:'saved',...(result.password?{password:result.password}:{}),...(result.delivery?{delivery:result.delivery}:{})};
 }catch{return {status:'failed'};}
}
