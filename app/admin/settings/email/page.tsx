import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { demoSwitcherEnabled } from '@/lib/demo-mode';
import { canConfigureIdentityEmail, requireIdentityEmailAdmin, readIdentityEmailSettings } from '@/lib/identity/email-settings';
import { defaultEmailConfig, emailFailureCodes, EmailSettingsError, type EmailSettingsView } from '@/lib/identity/email-model';
import { PageHeader, Card, SectionHeader, Field, inputCls, ErrorBanner } from '@/components/ui';
import { AccountEmailDeliveries } from '@/components/account-email-deliveries';
import { readAccountEmailDeliveries } from '@/core/account-email';
import { EmailSubmit } from './submit-button';
import { saveEmailDraft, testEmailDraft, activateEmailDraft } from './actions';

export default async function IdentityEmailPage({searchParams}:{searchParams:Promise<{error?:string;success?:string;accountRetry?:string}>}) {
 // HR admins may inspect the setup. Real settings and all mutations retain installation authority.
 const {s}=await scopedSession();
 const mayConfigure=await canConfigureIdentityEmail(s);
 if(!mayConfigure&&!isAdmin(s)) redirect('/');
 const [t,accountT,query]=await Promise.all([getTranslations('identityEmail'),getTranslations('accountEmail'),searchParams]);
 let deliveries=await readAccountEmailDeliveries(s);
 let view:EmailSettingsView|null=null;
 if(mayConfigure) {
  const {session,actor}=await requireIdentityEmailAdmin();
  deliveries=await readAccountEmailDeliveries(session,actor);
  try{view=await readIdentityEmailSettings(actor);}catch(e){
  return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')}/><ErrorBanner message={t(`errors.${e instanceof EmailSettingsError?e.code:'unavailable'}`)}/><AccountEmailDeliveries items={deliveries} returnTo="/admin/settings/email"/></div>;
  }
 }
 const config=view?.draft?.config??view?.active??defaultEmailConfig;
 const error=view&&emailFailureCodes.find(c=>c===query.error);
 const success=view&&['save','test','apply'].find(c=>c===query.success);
 return <div className="max-w-4xl space-y-6">
  <PageHeader title={t('title')} description={t('description')}/>
  {view?<p className="text-sm text-muted-foreground">{t('scope')}</p>:<div role="status" className="space-y-2 rounded-xl border border-border bg-card p-5"><h2 className="font-medium">{t('previewTitle')}</h2><p className="max-w-prose text-sm text-muted-foreground">{t(demoSwitcherEnabled()?'demoSetup':'restrictedSetup')}</p></div>}
  <ErrorBanner message={query.error==='account-retry'?accountT('retryError'):error?t(`errors.${error}`):undefined}/>
  {query.accountRetry==='1'?<p role="status" className="text-sm">{accountT('retryProcessed')}</p>:null}
  {success&&<p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">{t(`success.${success}`)}</p>}
  {view&&<Card><SectionHeader title={t('activeTitle')}/><div className="space-y-2 p-5 text-sm">
   <p>{view.active?t('activeSummary',{host:view.active.host,port:view.active.port,from:view.active.from}):t('notConfigured')}</p>
  </div></Card>}
  <Card><SectionHeader title={t('connectionTitle')}/><form action={view?saveEmailDraft:undefined} className="p-5">
   <fieldset disabled={!view} aria-label={t('connectionTitle')} className="grid min-w-0 gap-4 sm:grid-cols-2">
   {view&&<input type="hidden" name="revision" value={view.revision}/>}
   <Field label={t('host')}><input name="host" placeholder="smtp.example.com" defaultValue={config.host} required maxLength={253} className={inputCls} autoComplete="off"/></Field>
   <Field label={t('port')}><input name="port" type="number" min={1} max={65535} required defaultValue={config.port} className={inputCls}/></Field>
   <Field label={t('security')}><input readOnly value={t('tlsSecurity')} className={inputCls}/></Field>
   <Field label={t('authentication')}><select name="auth" defaultValue={String(config.auth)} className={inputCls}><option value="true">{t('passwordAuthentication')}</option><option value="false">{t('noAuthentication')}</option></select></Field>
   <Field label={t('from')}><input name="from" placeholder="hr@example.com" type="email" required defaultValue={config.from} maxLength={320} className={inputCls}/></Field>
   <Field label={t('fromName')}><input name="fromName" defaultValue={config.fromName} maxLength={160} className={inputCls}/></Field>
   <Field label={t('username')}><input name="user" autoComplete="off" defaultValue={config.user} maxLength={320} className={inputCls}/></Field>
   <Field label={t('password')}><input name="password" type="password" autoComplete="new-password" maxLength={4096} className={inputCls}/></Field>
   <Field label={t('replyTo')} className="sm:col-span-2"><input name="replyTo" type="email" defaultValue={config.replyTo} maxLength={320} className={inputCls}/></Field>
   {view&&<p className="text-sm text-muted-foreground sm:col-span-2">{view.draft?.hasPassword||view.active?.hasPassword?t('passwordKept'):t('passwordNeeded')}</p>}
   {view&&<EmailSubmit type="submit" className="w-fit">{t('saveDraft')}</EmailSubmit>}
   </fieldset>
   <p className="mt-4 max-w-prose text-sm text-muted-foreground">{t('tlsHelp')}</p>
  </form></Card>
  {view?.draft&&<Card><SectionHeader title={t('verifyTitle')}/><div className="space-y-5 p-5">
   <p className="text-sm">{t('testHelp',{email:view.testRecipient})}</p>
   <form action={testEmailDraft}><input type="hidden" name="draftId" value={view.draft.id}/><EmailSubmit type="submit">{t('sendTest')}</EmailSubmit></form>
   {view.draft.testedAt&&<form action={activateEmailDraft} className="space-y-4">
    <input type="hidden" name="draftId" value={view.draft.id}/>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="received" value="true" required className="mt-1"/>{t('received')}</label>
    <p className="text-sm text-muted-foreground">{t('activateHelp')}</p>
    <EmailSubmit type="submit">{t('activate')}</EmailSubmit>
   </form>}
  </div></Card>}
  <AccountEmailDeliveries items={deliveries} returnTo="/admin/settings/email"/>
 </div>;
}
