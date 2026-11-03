'use server';
import {getSession} from '@/lib/session';
import {savePasswordPolicy} from '@/core/password-policy';
import {revalidatePath} from 'next/cache';
import type {PasswordPolicyResult} from '@/app/admin/settings/login/password-policy-actions';
export async function saveFullPasswordPolicy(_previous:PasswordPolicyResult,form:FormData):Promise<PasswordPolicyResult>{
 try{
  const on=(key:string)=>form.get(key)==='on',number=(key:string)=>Number(form.get(key));
  const saved=await savePasswordPolicy(await getSession(),{enabled:on('enabled'),interval:number('interval'),unit:form.get('unit'),requirements:{
   minLength:number('minLength'),maxLength:number('maxLength'),uppercase:on('uppercase'),lowercase:on('lowercase'),numbers:on('numbers'),special:on('special'),
   historyEnabled:on('historyEnabled'),historyCount:number('historyCount'),lockoutEnabled:on('lockoutEnabled'),failedAttempts:number('failedAttempts'),
   autoUnlock:on('autoUnlock'),unlockMinutes:number('unlockMinutes'),forceFirstChange:on('forceFirstChange'),firstResetVerification:on('firstResetVerification'),
  }},number('revision'));
  revalidatePath('/admin/security-center/password-policy');revalidatePath('/admin/settings/login');return {status:'saved',revision:saved.revision};
 }catch(error){const code=error instanceof Error?error.message:'';return {status:['invalid','conflict','forbidden'].includes(code)?code as 'invalid'|'conflict'|'forbidden':'unavailable'};}
}
