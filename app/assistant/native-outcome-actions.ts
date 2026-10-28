'use server';
import {z} from 'zod';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {getBrowserCommandSession} from '@/lib/session';
import type {SessionContext} from '@/db/client';
import {RecordNativeOutcomeAssociation,NativeOutcomeAssociationView} from '@/lib/ai/module-native-outcomes';
import {recordOwnNativeOutcomeAssociation,reopenOwnNativeOutcomeAssociation,eraseOwnNativeOutcomeAssociations} from '@/core/module-native-outcomes';
import {loadOwnNativeOutcomeWorkspace} from '@/core/module-native-outcome-workspace';
import {resolveOwnNotificationServerIdentity} from '@/core/assistant-actions/own-notification-preferences-source';
// Next Server Actions enforce POST and matching Origin/Host. These commands additionally use
// the strict selected browser session and the canonical owner; rendered controls are not authority.
const Id=z.guid().transform(v=>v.toLowerCase());
const capture=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const path=(jobId:string,status:string,link?:string)=>'/assistant?governed='+encodeURIComponent(jobId)+'&nativeOutcome='+status+(link?'&nativeLink='+encodeURIComponent(link):'');
/** Form values are captured before authentication awaits. Neither actor nor native facts are posted. */
export async function recordNativeOutcomeAction(form:FormData){
 const raw=String(form.get('reference')??''),job=Id.safeParse(form.get('jobId'));let input:RecordNativeOutcomeAssociation;
 try{if(raw.length>512)throw Error();input=RecordNativeOutcomeAssociation.parse({jobId:form.get('jobId'),reference:JSON.parse(raw),nonce:form.get('nonce'),consented:form.get('consented')==='yes'});}catch{redirect(job.success?path(job.data,'unavailable'):'/assistant?nativeOutcome=unavailable');}
 let associationId:string;
 try{
  const ctx=capture(await getBrowserCommandSession());
  const server=input.reference.action==='notifications.email_preferences.save'?{notificationIdentity:await resolveOwnNotificationServerIdentity()}:{};
  const view=NativeOutcomeAssociationView.parse(await recordOwnNativeOutcomeAssociation(ctx,input,server));
  if(view.action!==input.reference.action)throw Error();associationId=view.associationId;
 }catch{redirect(path(input.jobId,'unavailable'));}
 revalidatePath('/assistant');redirect(path(input.jobId,'saved',associationId));
}
export async function reopenNativeOutcomeAction(form:FormData){
 const job=Id.safeParse(form.get('jobId')),link=Id.safeParse(form.get('associationId'));
 if(!job.success||!link.success)redirect('/assistant?nativeOutcome=unavailable');
 try{
  const ctx=capture(await getBrowserCommandSession()),workspace=await loadOwnNativeOutcomeWorkspace(ctx,job.data);
  const selected=workspace.links.find(item=>item.associationId===link.data);if(!selected)throw Error();
  const server=selected.action==='notifications.email_preferences.save'?{notificationIdentity:await resolveOwnNotificationServerIdentity()}:{};
  const view=NativeOutcomeAssociationView.parse(await reopenOwnNativeOutcomeAssociation(ctx,{associationId:link.data},server));
  if(view.action!==selected.action)throw Error();
 }catch{redirect(path(job.data,'unavailable'));}
 redirect(path(job.data,'checked',link.data));
}
/** Identity-only erasure has no posted target and survives Assistant/native grant loss. */
export async function eraseNativeOutcomesAction(){
 try{await eraseOwnNativeOutcomeAssociations(capture(await getBrowserCommandSession()));}
 catch{redirect('/assistant?nativeOutcome=erase_unavailable#assistant-privacy');}
 revalidatePath('/assistant');redirect('/assistant?nativeOutcome=erased#assistant-privacy');
}
