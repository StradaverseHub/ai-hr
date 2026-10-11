import { getLocale, getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { requireModule } from '@/lib/authz';
import { keycloakSelected } from '@/lib/identity/config';
import { currentIdentitySession } from '@/lib/identity/session';
import { notificationEmailCategories, notificationEmailLocales } from '@/lib/notification-email-model';
import { readNotificationEmailPreferences } from '@/core/notification-email';
import { PageHeader, Card, SectionHeader, ErrorBanner, Field, inputCls, btnPrimary } from '@/components/ui';
import { saveMyWorkflowEmailPreferences } from './actions';
const languageNames={en:'English',ms:'Bahasa Melayu',zh:'中文',vi:'Tiếng Việt',ta:'தமிழ்',th:'ไทย'};
export default async function MyEmailNotificationsPage({searchParams}:{searchParams:Promise<{saved?:string;error?:string}>}) {
  const {s}=await scopedSession();await requireModule('notifications');
  const t=await getTranslations('workflowEmail'),locale=await getLocale(),query=await searchParams;
  const view=await readNotificationEmailPreferences(s),identity=keycloakSelected()?await currentIdentitySession():null;
  const verified=identity?.emailVerified===true,allowed=new Set(view.policy.filter(p=>p.enabled).map(p=>p.category));
  return <div className="max-w-3xl space-y-6"><PageHeader title={t('preferencesTitle')} description={t('preferencesDescription')}/>
    <ErrorBanner message={query.error?t('error'):undefined}/>{query.saved==='1'&&<p role="status" className="text-sm">{t('saved')}</p>}
    <p className="text-sm text-muted-foreground">{t('consentHelp')}</p>
    {!verified&&<p role="status" className="text-sm text-muted-foreground">{t('identityRequired')}</p>}
    {!view.employments.length&&<Card className="p-5"><p>{t('noEmployment')}</p></Card>}
    {view.employments.map(e=>{
      const prefs=view.preferences.filter(p=>p.recipientEmploymentId===e.id),emailLocale=prefs[0]?.emailLocale??locale;
      return <Card key={e.id} className="p-5"><SectionHeader title={`${t('employment')}: ${e.code}`}/><form action={saveMyWorkflowEmailPreferences} className="space-y-4">
        <input type="hidden" name="employmentId" value={e.id}/>
        <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">{t('preferencesCategories')}</legend>
          {notificationEmailCategories.map(category=>{const pref=prefs.find(p=>p.category===category),checked=!!pref?.enabled&&pref.emailConsentUserId===s.userId&&pref.emailAfterSequence!=null;
            return <label key={category} className="flex items-start gap-2 text-sm"><input type="checkbox" name="category" value={category} defaultChecked={checked} disabled={!verified&&!checked} className="mt-1"/><span>{t(`categories.${category}`)}{!allowed.has(category)&&<span className="block text-xs text-muted-foreground">{t('notAllowed')}</span>}</span></label>;
          })}
        </fieldset>
        <Field label={t('language')}><select name="locale" defaultValue={notificationEmailLocales.includes(emailLocale as never)?emailLocale:'en'} className={inputCls}>{notificationEmailLocales.map(l=><option key={l} value={l}>{languageNames[l]}</option>)}</select></Field>
        <button type="submit" className={btnPrimary}>{t('save')}</button>
      </form></Card>;
    })}
  </div>;
}
