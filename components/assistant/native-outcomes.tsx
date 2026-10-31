import {createHash,randomUUID} from 'node:crypto';
import type {SessionContext} from '../../db/client';
import type {NativeOutcomeWorkspace} from '../../core/module-native-outcome-workspace';
import {getTranslations,getLocale} from 'next-intl/server';
import {getBrowserCommandSession} from '../../lib/session';
import {loadOwnNativeOutcomeWorkspace} from '../../core/module-native-outcome-workspace';
import {reopenOwnNativeOutcomeAssociation} from '../../core/module-native-outcomes';
import {resolveOwnNotificationServerIdentity} from '../../core/assistant-actions/own-notification-preferences-source';
import {NativeOutcomeAssociationView,type NativeOutcomeAction} from '../../lib/ai/module-native-outcomes';
import {NativeOutcomeForm} from './native-outcome-form';
import {OwnClearForm} from './own-clear';
import {eraseNativeOutcomesAction,reopenNativeOutcomeAction} from '../../app/(app)/assistant/native-outcome-actions';
const actionKey=(action:NativeOutcomeAction)=>'action_'+action.replace(/[.-]/g,'_');
const control='min-h-11 rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
/** Each render obtains strict selected-cookie identity and fresh source authority. Each render has
 * a fresh private form lifetime; no posted identity capability, cached HR body or provider context. */
export async function NativeOutcomes({jobId,status,selectedLink}:{jobId:string;status?:string;selectedLink?:string}){
 let ctx:SessionContext|undefined;
 try{const session=await getBrowserCommandSession();ctx={...session,roles:session.roles?.slice(),grants:session.grants?.map(g=>({...g}))};}catch{/* The same bounded message covers authentication and source refusal. */}
 const locale=await getLocale(),t=await getTranslations('assistant.workspace.nativeOutcomes');
 let workspace:NativeOutcomeWorkspace;
 try{if(!ctx)throw Error();workspace=await loadOwnNativeOutcomeWorkspace(ctx,jobId);}
 catch{return <section className="rounded-md border p-4"><p role="alert">{t('unavailable')}</p></section>;}
 if(!ctx)return null;
 let checked:NativeOutcomeAssociationView|null=null,checkFailed=false;
 if(selectedLink){
  try{
   const link=workspace.links.find(item=>item.associationId===selectedLink);if(!link)throw Error();
   // Completed-only public reopen starts AFTER the discovery transaction ended; no nested Tx.
   const server=link.action==='notifications.email_preferences.save'?{notificationIdentity:await resolveOwnNotificationServerIdentity()}:{};
   checked=NativeOutcomeAssociationView.parse(await reopenOwnNativeOutcomeAssociation(ctx,{associationId:link.associationId},server));
   if(checked.action!==link.action)throw Error();
  }catch{checked=null;checkFailed=true;}
 }
 const formatted=(value:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(value));
 const key=createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId,ctx.roles,ctx.grants,locale,workspace.jobId,randomUUID()])).digest('hex');
 return <section aria-labelledby="native-outcome-title" className="space-y-4 rounded-md border p-5">
  <h2 id="native-outcome-title" className="font-medium">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('description')}</p>
  {(status==='unavailable'||checkFailed)&&<p role="alert" className="text-sm">{t('unavailable')}</p>}
  {status==='saved'&&checked&&<p role="status" className="text-sm">{t('saved')}</p>}
  {checked&&<div role="status" className="space-y-2 rounded-md bg-muted p-3 text-sm"><p>{t('checked')}</p><p>{t(actionKey(checked.action))}</p><p>{t('notQuality')}</p></div>}
  {workspace.choices.length?<NativeOutcomeForm key={key} jobId={workspace.jobId} nonce={randomUUID()} options={workspace.choices.map(choice=>({value:JSON.stringify(choice.reference),label:t(actionKey(choice.reference.action))+' · '+formatted(choice.createdAt)}))} messages={{choose:t('choose'),consent:t('consent'),save:t('save'),pending:t('pending'),recover:t('recover')}}/>:<p className="text-sm">{t('empty')}</p>}
  {workspace.truncated&&<p className="text-sm text-muted-foreground">{t('bounded')}</p>}
  {workspace.links.length>0&&<div className="space-y-2"><h3 className="text-sm font-medium">{t('history')}</h3>{workspace.links.map(link=><form key={link.associationId} action={reopenNativeOutcomeAction} className="flex flex-wrap items-center gap-3"><input type="hidden" name="jobId" value={workspace.jobId}/><input type="hidden" name="associationId" value={link.associationId}/><span className="text-sm">{t(actionKey(link.action))} · {formatted(link.createdAt)}</span><button type="submit" className={control}>{t('reopen')}</button></form>)}</div>}
  <p className="text-xs text-muted-foreground">{t('notQuality')}</p>
 </section>;
}
/** This control needs no module/grant/employee lookup and remains visible in the denied branch. It asks
 * first; the outcome sits OUTSIDE the collapsible so the post-redirect page shows it. */
export async function NativeOutcomePrivacy({status}:{status?:string}){
 const t=await getTranslations('assistant.workspace.nativeOutcomes');
 return <div className="space-y-2">{status==='erased'&&<p role="status" className="text-xs">{t('erased')}</p>}{status==='erase_unavailable'&&<p role="alert" className="text-xs">{t('unavailable')}</p>}<details className="rounded-md border p-3 text-sm"><summary className="flex min-h-11 cursor-pointer items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('privacy')}</summary><p className="my-2 text-xs text-muted-foreground">{t('privacyDescription')}</p><OwnClearForm kind="outcomes" action={eraseNativeOutcomesAction} label={t('erase')} className="min-h-11 text-sm underline"/></details></div>;
}
