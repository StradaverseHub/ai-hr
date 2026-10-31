'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireIdentityEmailAdmin } from '@/lib/identity/email-settings';
import { identityEmailRequest } from '@/lib/identity/email-ipc';
import { EmailSettingsError, emailConfigSchema } from '@/lib/identity/email-model';
import { managedEmailSenderProfiles, type ManagedEmailSenderProfile } from '@/lib/managed-email-policy';
import {internalSelected} from '@/lib/internal-auth/config';
import {saveAccountEmailRetention} from '@/core/account-email-retention';
const path='/admin/settings/email';
async function execute(op:'save'|'test'|'apply',form:FormData) {
 const {actor}=await requireIdentityEmailAdmin();
 let error:string|undefined;let appliedSender=false;
 let connectionId=String(form.get('connectionId')??'');
 try{
  if(op==='save') {
   const microsoft=form.get('auth')==='microsoft365';
   if(microsoft&&!internalSelected())throw new EmailSettingsError('invalid');
   const result=emailConfigSchema.safeParse({host:form.get('host'),port:Number(form.get('port')),security:form.get('security')??'tls',from:form.get('from'),fromName:form.get('fromName'),replyTo:form.get('replyTo'),user:form.get('user'),auth:form.get('auth')==='true'||microsoft,
    ...(microsoft?{authentication:'microsoft365',oauth2:{tenantId:form.get('tenantId'),clientId:form.get('clientId')}}:{})});
   if(!result.success) throw new EmailSettingsError('invalid');
   const named=internalSelected()&&form.has('connectionName');
   const saved=await identityEmailRequest<{connectionId?:string}>({op,actor,revision:String(form.get('revision')??''),config:result.data,password:String(form.get('password')??''),...(named?{connectionName:String(form.get('connectionName')??''),...(connectionId?{connectionId}:{})}:{})});
   connectionId=saved.connectionId??connectionId;
  }else if(op==='test') await identityEmailRequest({op,actor,draftId:String(form.get('draftId')??''),...(connectionId?{connectionId}:{})});
  else {
   const profile=String(form.get('lifecycleSender')??'');
   if(profile&&(!internalSelected()||!connectionId||!managedEmailSenderProfiles.includes(profile as ManagedEmailSenderProfile)))throw new EmailSettingsError('invalid');
   await identityEmailRequest({op,actor,draftId:String(form.get('draftId')??''),received:form.get('received')==='true',...(connectionId?{connectionId}:{}),...(profile?{lifecycleSender:profile as ManagedEmailSenderProfile}:{})});
   appliedSender=!!profile;
  }
 }catch(e){error=e instanceof EmailSettingsError?e.code:'unavailable';}
 revalidatePath(path);redirect(path+'?'+new URLSearchParams({...error?{error}:{success:appliedSender?'sender':op},...(connectionId?{connection:connectionId}:form.has('connectionName')?{connection:'new'}:{})}));
}
export async function saveEmailDraft(form:FormData){await execute('save',form);}
export async function testEmailDraft(form:FormData){await execute('test',form);}
export async function activateEmailDraft(form:FormData){await execute('apply',form);}
export async function saveEmailRetention(form:FormData){
 const {session,actor}=await requireIdentityEmailAdmin();
 let failed=false;
 try{
  const mode=form.get('retentionMode');
  if(mode!=='never'&&mode!=='days')throw Error('Invalid retention mode.');
  if(!/^\d+$/.test(String(form.get('retentionRevision')??'')))throw Error('Invalid retention revision.');
  await saveAccountEmailRetention(session,actor,{days:mode==='never'?null:Number(form.get('retentionDays')),revision:Number(form.get('retentionRevision')),acknowledged:form.get('retentionAcknowledged')==='true'});
 }catch{failed=true;}
 revalidatePath(path);redirect(path+'?'+(failed?'retentionError=1':'retentionSaved=1'));
}
