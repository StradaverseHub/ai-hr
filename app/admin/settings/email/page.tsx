import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { canConfigureIdentityEmail, requireIdentityEmailAdmin, readIdentityEmailSettings } from '@/lib/identity/email-settings';
import { defaultEmailConfig, emailFailureCodes, EmailSettingsError, type EmailSettingsView } from '@/lib/identity/email-model';
import { PageHeader, Card, SectionHeader, Field, inputCls, ErrorBanner } from '@/components/ui';
import { AccountEmailDeliveries } from '@/components/account-email-deliveries';
import { readAccountEmailHistory } from '@/core/account-email';
import { withInternalRecoveryLabels } from '@/lib/internal-auth/account-email-view';
import { EmailSubmit } from './submit-button';
import { DemoSmtpForm } from './demo-form';
import {SavedEmailConnectionFields} from './connection-fields';
import {internalSelected} from '@/lib/internal-auth/config';
import Link from 'next/link';
import {btnPrimary,btnGhost,Badge} from '@/components/ui';
import {emailDisplayClock,formatEmailTimestamp} from '@/lib/email-display-clock';
import { saveEmailDraft, testEmailDraft, activateEmailDraft } from './actions';

export default async function IdentityEmailPage({searchParams}:{searchParams:Promise<{error?:string;success?:string;accountRetry?:string;connection?:string;fromDate?:string;toDate?:string;before?:string}>}) {
 // Demo admins may probe temporary connections. Saved relay settings retain installation authority.
 const {s}=await scopedSession();
 const mayConfigure=await canConfigureIdentityEmail(s);
 if(!mayConfigure&&!isAdmin(s)) redirect('/');
 const [t,accountT,query]=await Promise.all([getTranslations('identityEmail'),getTranslations('accountEmail'),searchParams]);
 const filters={...(query.fromDate?{fromDate:query.fromDate}:{}),...(query.toDate?{toDate:query.toDate}:{}),...(query.before?{before:query.before}:{})};
 let history:Awaited<ReturnType<typeof readAccountEmailHistory>>={items:[],hasMore:false,nextCursor:undefined},historyError=false;
 try{history=await readAccountEmailHistory(s,undefined,filters);}catch{historyError=true;}
 let deliveries=history.items;
 let view:EmailSettingsView|null=null;
 if(mayConfigure) {
  const {session,actor}=await requireIdentityEmailAdmin();
  try{history=await readAccountEmailHistory(session,actor,filters);deliveries=await withInternalRecoveryLabels(session,actor,history.items);historyError=false;}catch{historyError=true;}
  try{view=await readIdentityEmailSettings(actor,internalSelected()?query.connection:undefined);}catch(e){
  return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')}/><ErrorBanner message={t(`errors.${e instanceof EmailSettingsError?e.code:'unavailable'}`)}/><AccountEmailDeliveries items={deliveries} returnTo="/admin/settings/email"/></div>;
  }
 }
 const named=Boolean(view?.connections),editing=!named||Boolean(query.connection),clock=emailDisplayClock();
 const config=named&&query.connection==='new'?defaultEmailConfig:view?.draft?.config??view?.active??defaultEmailConfig;
 const demoTest=!view&&demoSwitcherEnabled();
 const connectionFields=(demoTest:boolean)=><>
   <Field label={t('host')}><input name="host" placeholder="smtp.example.com" defaultValue={config.host} required maxLength={253} className={inputCls} autoComplete="off"/></Field>
   <Field label={t('port')}><input name="port" type="number" min={1} max={65535} required defaultValue={config.port} className={inputCls}/></Field>
   <Field label={t('security')}>{demoTest?<select name="security" defaultValue="tls" className={inputCls}><option value="tls">{t('tlsSecurity')}</option><option value="starttls">{t('starttlsSecurity')}</option></select>:<input readOnly value={t('tlsSecurity')} className={inputCls}/>}</Field>
   <Field label={t('authentication')}><select name="auth" defaultValue={String(config.auth)} className={inputCls}><option value="true">{t('passwordAuthentication')}</option><option value="false">{t('noAuthentication')}</option></select></Field>
   <Field label={t('from')}><input name="from" placeholder="hr@example.com" type="email" required={!demoTest} defaultValue={config.from} maxLength={320} className={inputCls}/></Field>
   <Field label={t('fromName')}><input name="fromName" defaultValue={config.fromName} maxLength={160} className={inputCls}/></Field>
   <Field label={t('username')}><input name="user" autoComplete="off" defaultValue={config.user} maxLength={320} className={inputCls}/></Field>
   <Field label={t('password')}><input name="password" type="password" autoComplete="new-password" maxLength={4096} className={inputCls}/></Field>
   <Field label={t('replyTo')} className="sm:col-span-2"><input name="replyTo" type="email" defaultValue={config.replyTo} maxLength={320} className={inputCls}/></Field>
 </>;
 const error=view&&emailFailureCodes.find(c=>c===query.error);
 const success=view&&['save','test','apply'].find(c=>c===query.success);
 return <div className={`${editing?'max-w-4xl':'max-w-7xl'} space-y-6`}>
  <PageHeader title={t('title')} description={t('description')}/>
  {view?<p className="text-sm text-muted-foreground">{t('scope')}</p>:<div role="status" className="space-y-2 rounded-xl border border-border bg-card p-5"><h2 className="font-medium">{t(demoTest?'demoTestTitle':'previewTitle')}</h2><p className="max-w-prose text-sm text-muted-foreground">{t(demoTest?'demoSetup':'restrictedSetup')}</p></div>}
  <ErrorBanner message={query.error==='account-retry'?accountT('retryError'):error?t(`errors.${error}`):undefined}/>
  {query.accountRetry==='1'?<p role="status" className="text-sm">{accountT('retryProcessed')}</p>:null}
  {success&&<p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">{t(`success.${success}`)}</p>}
  {view&&<Card><SectionHeader title={t('activeTitle')}/><div className="space-y-2 p-5 text-sm">
   <p>{view.active?t('activeSummary',{host:view.active.host,port:view.active.port,from:view.active.from}):t('notConfigured')}</p>
  </div></Card>}
  {named&&!editing&&<section aria-labelledby="saved-smtp-title" className="space-y-4">
   <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="saved-smtp-title" className="text-lg font-semibold">{t('connectionsTitle')}</h2><Link href="/admin/settings/email?connection=new" className={btnPrimary}>{t('newConnection')}</Link></div>
   {!view?.connections?.length?<p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">{t('noConnections')}</p>:<div className="overflow-x-auto rounded-xl border border-border"><table className="w-full text-left text-sm"><thead className="bg-muted/40 text-muted-foreground"><tr>{(['connectionName','host','username','from','security','connectionStatus','lastTest'] as const).map(key=><th key={key} scope="col" className="px-4 py-3 font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y divide-border">{view.connections.map(c=><tr key={c.id} className="hover:bg-muted/30"><td className="px-4 py-4"><Link className="font-medium underline-offset-4 hover:underline focus-visible:underline" href={'/admin/settings/email?connection='+encodeURIComponent(c.id)}>{c.name}</Link></td><td className="px-4 py-4">{c.config.host}:{c.config.port}</td><td className="px-4 py-4 break-all">{c.config.user||'—'}</td><td className="px-4 py-4 break-all">{c.config.from}</td><td className="px-4 py-4">{t(c.config.security==='starttls'?'starttlsSecurity':'tlsSecurity')}</td><td className="px-4 py-4"><Badge>{t(c.active?'connectionActive':'connectionSaved')}</Badge>{c.hasUnappliedChanges&&<p className="mt-1 text-xs text-muted-foreground">{t('changesPending')}</p>}</td><td className="whitespace-nowrap px-4 py-4">{c.testedAt?formatEmailTimestamp(c.testedAt,clock):t('notRecorded')}</td></tr>)}</tbody></table></div>}
  </section>}
  {editing&&<><div className="flex flex-wrap items-center gap-3">{named&&<Link href="/admin/settings/email" className={btnGhost}>{t('backToConnections')}</Link>}{named&&<h2 className="text-lg font-semibold">{view?.selectedConnectionName??t('newConnection')}</h2>}</div>
  {named&&view?.connections?.find(c=>c.id===view.selectedConnectionId)?.hasUnappliedChanges&&<p role="status" className="text-sm text-muted-foreground">{t('activeChangesHelp')}</p>}
  <Card><SectionHeader title={t('connectionTitle')}/>{demoTest?<DemoSmtpForm>{connectionFields(true)}</DemoSmtpForm>:<form action={view?saveEmailDraft:undefined} className="p-5">
   <fieldset disabled={!view} aria-label={t('connectionTitle')} className="grid min-w-0 gap-4 sm:grid-cols-2">
   {view&&<input type="hidden" name="revision" value={view.revision}/>}
   {named&&<><input type="hidden" name="connectionId" value={view?.selectedConnectionId??''}/><Field label={t('connectionName')} className="sm:col-span-2"><input name="connectionName" required maxLength={120} defaultValue={view?.selectedConnectionName??''} className={inputCls} placeholder={t('connectionNamePlaceholder')}/></Field></>}
   <SavedEmailConnectionFields key={view?.draft?.id??view?.revision??'preview'} config={config} allowMicrosoft365={internalSelected()} hasSecret={Boolean(named?view?.draft?.hasPassword:view?.draft?.hasPassword||view?.active?.hasPassword)}/>
   {view&&<EmailSubmit type="submit" className="w-fit">{t(named?'saveConnection':'saveDraft')}</EmailSubmit>}
   </fieldset>
   <p className="mt-4 max-w-prose text-sm text-muted-foreground">{t('tlsHelp')}</p>
  </form>}</Card>
  {view?.draft&&<Card><SectionHeader title={t('verifyTitle')}/><div className="space-y-5 p-5">
   <p className="text-sm">{t('testHelp',{email:view.testRecipient})}</p>
   <form action={testEmailDraft}><input type="hidden" name="connectionId" value={view.selectedConnectionId??''}/><input type="hidden" name="draftId" value={view.draft.id}/><EmailSubmit type="submit">{t('sendTest')}</EmailSubmit></form>
   {view.draft.testedAt&&<form action={activateEmailDraft} className="space-y-4">
    <input type="hidden" name="draftId" value={view.draft.id}/>
    <input type="hidden" name="connectionId" value={view.selectedConnectionId??''}/>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="received" value="true" required className="mt-1"/>{t('received')}</label>
    <p className="text-sm text-muted-foreground">{t('activateHelp')}</p>
    <EmailSubmit type="submit">{t('activate')}</EmailSubmit>
   </form>}
  </div></Card>}</>}
  {historyError&&<ErrorBanner message={accountT('historyUnavailable')}/>}
  <AccountEmailDeliveries items={deliveries} returnTo="/admin/settings/email" history={{...filters,hasMore:history.hasMore,nextCursor:history.nextCursor}}/>
 </div>;
}
