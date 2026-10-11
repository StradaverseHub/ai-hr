import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireIdentityEmailAdmin, readIdentityEmailSettings } from '@/lib/identity/email-settings';
import { defaultEmailConfig, emailFailureCodes, EmailSettingsError } from '@/lib/identity/email-model';
import { PageHeader, Card, SectionHeader, Field, inputCls, ErrorBanner } from '@/components/ui';
import { EmailSubmit } from './submit-button';
import { saveEmailDraft, testEmailDraft, activateEmailDraft } from './actions';

export default async function IdentityEmailPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}) {
 // Authenticated-role eligibility is refined by a separately enrolled installation capability.
 await scopedSession();const {actor}=await requireIdentityEmailAdmin();
 const t=await getTranslations('identityEmail'),query=await searchParams;
 let view;
 try{view=await readIdentityEmailSettings(actor);}catch(e){
  return <div className="space-y-6"><PageHeader title={t('title')} description={t('description')}/><ErrorBanner message={t(`errors.${e instanceof EmailSettingsError?e.code:'unavailable'}`)}/></div>;
 }
 const config=view.draft?.config??view.active??defaultEmailConfig;
 const error=emailFailureCodes.find(c=>c===query.error);
 const success=['save','test','apply'].find(c=>c===query.success);
 return <div className="max-w-4xl space-y-6">
  <PageHeader title={t('title')} description={t('description')}/>
  <p className="text-sm text-muted-foreground">{t('scope')}</p>
  <ErrorBanner message={error?t(`errors.${error}`):undefined}/>
  {success&&<p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">{t(`success.${success}`)}</p>}
  <Card><SectionHeader title={t('activeTitle')}/><div className="space-y-2 p-5 text-sm">
   <p>{view.active?t('activeSummary',{host:view.active.host,port:view.active.port,from:view.active.from}):t('notConfigured')}</p>
   <p className="text-muted-foreground">{t('tlsHelp')}</p>
  </div></Card>
  <Card><SectionHeader title={t('draftTitle')}/><form action={saveEmailDraft} className="grid gap-4 p-5 sm:grid-cols-2">
   <input type="hidden" name="revision" value={view.revision}/>
   <Field label={t('host')}><input name="host" defaultValue={config.host} required maxLength={253} className={inputCls} autoComplete="off"/></Field>
   <Field label={t('port')}><input name="port" type="number" min={1} max={65535} required defaultValue={config.port} className={inputCls}/></Field>
   <Field label={t('from')}><input name="from" type="email" required defaultValue={config.from} maxLength={320} className={inputCls}/></Field>
   <Field label={t('fromName')}><input name="fromName" defaultValue={config.fromName} maxLength={160} className={inputCls}/></Field>
   <Field label={t('replyTo')}><input name="replyTo" type="email" defaultValue={config.replyTo} maxLength={320} className={inputCls}/></Field>
   <Field label={t('authentication')}><select name="auth" defaultValue={String(config.auth)} className={inputCls}><option value="true">{t('passwordAuthentication')}</option><option value="false">{t('noAuthentication')}</option></select></Field>
   <Field label={t('username')}><input name="user" autoComplete="off" defaultValue={config.user} maxLength={320} className={inputCls}/></Field>
   <Field label={t('password')}><input name="password" type="password" autoComplete="new-password" maxLength={4096} className={inputCls}/></Field>
   <p className="text-sm text-muted-foreground sm:col-span-2">{view.draft?.hasPassword||view.active?.hasPassword?t('passwordKept'):t('passwordNeeded')}</p>
   <EmailSubmit type="submit" className="w-fit">{t('saveDraft')}</EmailSubmit>
  </form></Card>
  {view.draft&&<Card><SectionHeader title={t('verifyTitle')}/><div className="space-y-5 p-5">
   <p className="text-sm">{t('testHelp',{email:view.testRecipient})}</p>
   <form action={testEmailDraft}><input type="hidden" name="draftId" value={view.draft.id}/><EmailSubmit type="submit">{t('sendTest')}</EmailSubmit></form>
   {view.draft.testedAt&&<form action={activateEmailDraft} className="space-y-4">
    <input type="hidden" name="draftId" value={view.draft.id}/>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="received" value="true" required className="mt-1"/>{t('received')}</label>
    <p className="text-sm text-muted-foreground">{t('activateHelp')}</p>
    <EmailSubmit type="submit">{t('activate')}</EmailSubmit>
   </form>}
  </div></Card>}
 </div>;
}
