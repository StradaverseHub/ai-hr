'use server';
import {getSession} from '@/lib/session';
import {generateManagedAccountPassword,manageAccount,readManagedAccountHistory,type AccountCommand} from '@/core/account-management';
import {instantFromKualaLumpurLocal} from '@/lib/hr-date';
import {revalidatePath} from 'next/cache';
export type AccountActionState={status:'idle'|'saved'|'failed';password?:string;delivery?:'sent'|'failed'|'skipped'|'uncertain'};
/** Temporary-password lifetimes offered in hours; the owner keeps its 5-1440 minute bound. */
const TEMPORARY_PASSWORD_HOURS=new Set([1,2,4,8,12,24]);
export async function accountAction(_state:AccountActionState,form:FormData):Promise<AccountActionState>{
 try{
  if(form.get('confirmed')!=='on')throw Error('invalid');
  const type=String(form.get('type')),reason=String(form.get('reason')??''),userId=String(form.get('userId')??'');
  let command:AccountCommand;
  if(type==='suspend'||type==='reactivate'||type==='reset-email')command={type,reason};
  else if(type==='expiry')command={type,reason,activeUntil:String(form.get('activeUntil')??'')||null};
  else if(type==='temporary-password'){
   const password=String(form.get('password')??'');if(password&&password!==String(form.get('confirmPassword')??''))throw Error('invalid');
   // The Reset Password dialog posts hours (default 24); the minutes field remains for direct callers.
   const hours=form.has('hours')?Number(form.get('hours')):null;
   if(hours!==null&&!TEMPORARY_PASSWORD_HOURS.has(hours))throw Error('invalid');
   command={type,...(reason.trim()?{reason}:{}),password:password||undefined,minutes:hours!==null?hours*60:Number(form.get('minutes'))};
  }
  else if(type==='recovery-exemption'){
   const expiresAt=instantFromKualaLumpurLocal(String(form.get('until')??''));if(expiresAt===null)throw Error('invalid');
   command={type,reason,expiresAt};
  }
  else if(type==='recovery-exemption-cancel')command={type,...(reason.trim()?{reason}:{})};
  else throw Error('invalid');
  const result=await manageAccount(await getSession(),userId,command);
  revalidatePath('/admin/users');revalidatePath(`/admin/users/${userId}/account`);
  return {status:'saved',...(result.password?{password:result.password}:{}),...(result.delivery?{delivery:result.delivery}:{})};
 }catch{return {status:'failed'};}
}
/** Generate Password in the Reset Password dialog: the saved Password Policy shapes the candidate.
 * Nothing is stored; the same scope proof as every account action admits the target. */
export async function generatePasswordAction(userId:string):Promise<{status:'ok';password:string}|{status:'failed'}>{
 try{return {status:'ok',password:await generateManagedAccountPassword(await getSession(),String(userId))};}
 catch{return {status:'failed'};}
}
export type AccountHistoryEntry={at:string;event:string;actor:string|null;until:string|null};
/** Recent security history for the Authenticator Control dialog: times, event names and actor names only. */
export async function accountHistoryAction(userId:string):Promise<{status:'ok';entries:AccountHistoryEntry[]}|{status:'failed'}>{
 try{
  const rows=await readManagedAccountHistory(await getSession(),String(userId),5);
  return {status:'ok',entries:rows.map(row=>({at:new Date(row.occurred_at).toISOString(),event:row.event_type,actor:row.actor_name,
   until:row.expires_at&&/^\d+$/.test(row.expires_at)?new Date(Number(row.expires_at)).toISOString():null}))};
 }catch{return {status:'failed'};}
}
