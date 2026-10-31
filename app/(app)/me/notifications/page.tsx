import { createHash } from 'node:crypto';
import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { currentProviderSession } from '@/lib/identity/provider';
import { notificationPreferenceCategories, notificationEmailLocales } from '@/lib/notification-email-model';
import {isModuleEnabled} from '@/core/entitlements';
import {readLetterEmailPreferences} from '@/core/letter-email-preferences';
import { readNotificationEmailPreferences } from '@/core/notification-email';
import { PageHeader, Card, SectionHeader, ErrorBanner, Field, inputCls, btnPrimary } from '@/components/ui';
import { saveMyWorkflowEmailPreferences,saveMyLetterEmailPreferences } from './actions';
const languageNames={en:'English',ms:'Bahasa Melayu',zh:'中文',vi:'Tiếng Việt',ta:'தமிழ்',th:'ไทย'};
export default async function MyEmailNotificationsPage({searchParams}:{searchParams:Promise<{saved?:string;error?:string}>}) {
  const {s,scopeIds}=await scopedSession();if(!scopeIds.some(id=>isModuleEnabled(s,'notifications',id)))await requireModule('notifications');
  const global=isModuleEnabled(s,'notifications');
  const t=await getTranslations('workflowEmail'),locale=await getLocale(),query=await searchParams;
  const view=global?await readNotificationEmailPreferences(s):{employments:[],preferences:[],policy:[]},account=await readLetterEmailPreferences(s),identity=await currentProviderSession().catch(()=>null);
  // The same canonical proof as the action; incomplete/unavailable proof cannot enable new consent.
  const verified=identity?.emailVerified===true&&Boolean(identity.issuer&&identity.subject&&identity.email),allowed=new Set(view.policy.filter(p=>p.enabled).map(p=>p.category));
  const pref=account.preference,checked=account.current&&(!verified||pref?.emailConsentIssuer===identity?.issuer&&pref?.emailConsentSubject===identity?.subject&&pref?.emailConsentAddressHash===(identity?.email?createHash('sha256').update(identity.email.toLowerCase()).digest('hex'):null)),accountLocale=pref?.emailLocale??locale;
  return <div className="max-w-3xl space-y-6"><PageHeader title={t('preferencesTitle')} description={t('preferencesDescription')}/>
    <ErrorBanner message={query.error?t('error'):undefined}/>{query.saved==='1'&&<p role="status" className="text-sm">{t('saved')}</p>}
    <p data-tour="notification-consent" className="text-sm text-muted-foreground">{t('consentHelp')}</p>{global&&<p className="text-sm text-muted-foreground">{t('reportConsentHelp')}</p>}
    {!verified&&<p role="status" className="text-sm text-muted-foreground">{t('identityRequired')}</p>}
    <Card className="space-y-4 p-5"><SectionHeader title={t('letterAccountTitle')}/><p className="text-sm text-muted-foreground">{t('letterAccountHelp')}</p>
      <form action={saveMyLetterEmailPreferences} className="space-y-4"><label className="flex min-h-11 items-start gap-2 py-2 text-sm"><input type="checkbox" name="enabled" value="true" defaultChecked={checked} disabled={!verified&&!checked} className="mt-1"/><span>{t('letterAccountConsent')}{!account.enabledByPolicy&&<span className="block text-xs text-muted-foreground">{t('notAllowed')}</span>}</span></label>
        <Field label={t('letterAccountLanguage')}><select name="locale" defaultValue={notificationEmailLocales.includes(accountLocale as never)?accountLocale:'en'} className={`${inputCls} min-h-11`}>{notificationEmailLocales.map(language=><option key={language} value={language}>{languageNames[language]}</option>)}</select></Field>
        <button type="submit" className={`${btnPrimary} min-h-11`}>{t('letterAccountSave')}</button>
      </form></Card>
    {global&&!view.employments.length&&<Card className="p-5"><p>{t('noEmployment')}</p></Card>}
    {view.employments.map(e=>{
      const prefs=view.preferences.filter(p=>p.recipientEmploymentId===e.id),emailLocale=prefs[0]?.emailLocale??locale;
      return <Card key={e.id} className="p-5"><SectionHeader title={`${t('employment')}: ${e.code}`}/><form action={saveMyWorkflowEmailPreferences} className="space-y-4">
        <input type="hidden" name="employmentId" value={e.id}/>
        <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">{t('preferencesCategories')}</legend>
          {notificationPreferenceCategories.filter(category=>category!=='letters').map(category=>{const pref=prefs.find(p=>p.category===category),checked=!!pref?.enabled&&pref.emailConsentUserId===s.userId&&pref.emailAfterSequence!=null&&(category!=='employee_master_reports'||!!pref.reportConsentVerifiedAt&&pref.reportConsentIssuer===identity?.issuer&&pref.reportConsentSubject===identity?.subject&&pref.reportConsentAddressHash===(identity?.email?createHash('sha256').update(identity.email.toLowerCase()).digest('hex'):null));
            return <label key={category} className="flex items-start gap-2 text-sm"><input type="checkbox" name="category" value={category} defaultChecked={checked} disabled={!verified&&!checked} className="mt-1"/><span>{t(`categories.${category}`)}{!allowed.has(category)&&<span className="block text-xs text-muted-foreground">{t('notAllowed')}</span>}</span></label>;
          })}
        </fieldset>
        <Field label={t('language')}><select name="locale" defaultValue={notificationEmailLocales.includes(emailLocale as never)?emailLocale:'en'} className={inputCls}>{notificationEmailLocales.map(l=><option key={l} value={l}>{languageNames[l]}</option>)}</select></Field>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form></Card>;
    })}
  </div>;
}
