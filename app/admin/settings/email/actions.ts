'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireIdentityEmailAdmin } from '@/lib/identity/email-settings';
import { identityEmailRequest } from '@/lib/identity/email-ipc';
import { EmailSettingsError, emailConfigSchema } from '@/lib/identity/email-model';
import {internalSelected} from '@/lib/internal-auth/config';
const path='/admin/settings/email';
async function execute(op:'save'|'test'|'apply',form:FormData) {
 const {actor}=await requireIdentityEmailAdmin();
 let error:string|undefined;
 try{
  if(op==='save') {
   const microsoft=form.get('auth')==='microsoft365';
   if(microsoft&&!internalSelected())throw new EmailSettingsError('invalid');
   const result=emailConfigSchema.safeParse({host:form.get('host'),port:Number(form.get('port')),security:form.get('security')??'tls',from:form.get('from'),fromName:form.get('fromName'),replyTo:form.get('replyTo'),user:form.get('user'),auth:form.get('auth')==='true'||microsoft,
    ...(microsoft?{authentication:'microsoft365',oauth2:{tenantId:form.get('tenantId'),clientId:form.get('clientId')}}:{})});
   if(!result.success) throw new EmailSettingsError('invalid');
   await identityEmailRequest({op,actor,revision:String(form.get('revision')??''),config:result.data,password:String(form.get('password')??'')});
  }else if(op==='test') await identityEmailRequest({op,actor,draftId:String(form.get('draftId')??'')});
  else await identityEmailRequest({op,actor,draftId:String(form.get('draftId')??''),received:form.get('received')==='true'});
 }catch(e){error=e instanceof EmailSettingsError?e.code:'unavailable';}
 revalidatePath(path);redirect(path+'?'+new URLSearchParams(error?{error}:{success:op}));
}
export async function saveEmailDraft(form:FormData){await execute('save',form);}
export async function testEmailDraft(form:FormData){await execute('test',form);}
export async function activateEmailDraft(form:FormData){await execute('apply',form);}
