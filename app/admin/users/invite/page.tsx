import {getLocale,getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {Card,ErrorBanner,SectionHeader,btnPrimary,inputCls} from '@/components/ui';
import {inviteUserAction} from '../../actions';
import {loadUsersData,ROLES} from '../data';
import {AccountTargetFields} from '../account-target-fields';
import {SecurityPageHeader} from '../security-page';
export default async function InviteUserPage({searchParams}:{searchParams:Promise<{activate?:string;error?:string;saved?:string}>}){
 const s=await requireGroupAdministration(),params=await searchParams,t=await getTranslations('admin.users'),center=await getTranslations('securityCenter'),tAll=await getTranslations(),locale=await getLocale();
 const {peopleOptions,companies,pendingEmployees}=await loadUsersData(s),selectedPerson=pendingEmployees.find(p=>p.id===params.activate);
 return <div className="mx-auto max-w-5xl space-y-6"><SecurityPageHeader title={center('invite.title')}/>{params.error&&<div role="alert"><ErrorBanner message={params.error}/></div>}
 {params.saved==='1'&&<p role="status" className="rounded-lg border border-border p-4 text-sm">{center('invitationSent')}</p>}
        <Card>
          <div id="invite-user"><SectionHeader title={t('inviteTitle')} /></div>
          <div className="px-4 py-3">
            <p className="mb-3 text-xs text-muted-foreground">{t('inviteHint')}</p>
            <form action={inviteUserAction} className="grid gap-4 sm:grid-cols-2">
              <AccountTargetFields idPrefix="invite" people={peopleOptions} companies={companies} roles={ROLES.map(value=>({value,label:t(`role.${value}`)}))} selectedPerson={selectedPerson}>
              <label className="flex min-w-56 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{t('inviteEmail')}</span>
                <input type="email" name="email" required defaultValue={selectedPerson?.email ?? ''} placeholder="name@company.com" className={inputCls} />
              </label>
              <label className="flex min-w-56 flex-1 flex-col gap-1"><span className="text-xs font-medium text-muted-foreground">{tAll('emailDesign.language')}</span><select name="emailLocale" defaultValue={locale} className={inputCls}>{['en','ms','zh','vi','ta','th'].map(language=><option key={language} value={language}>{tAll(`emailDesign.languages.${language}`)}</option>)}</select></label>
              </AccountTargetFields>
              <button type="submit" className={`${btnPrimary} w-fit`}>
                {t('inviteSubmit')}
              </button>
            </form>
          </div>
        </Card>
 </div>;
}
