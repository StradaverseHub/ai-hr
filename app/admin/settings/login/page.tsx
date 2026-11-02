import Link from 'next/link';
import {settingsAccess} from '@/core/organisation-access';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { isGroupAdmin } from '@/lib/authz';
import { readLoginPresentationEditor } from '@/core/login-presentation';
import { loginPresentationTenantId } from '@/lib/login-presentation-server';
import { PageHeader, Card } from '@/components/ui';
import { LoginPresentationForm } from './presentation-form';
import { readSessionPolicyEditor } from '@/core/session-policy';
import { internalSelected } from '@/lib/internal-auth/config';
import { SessionPolicyForm } from './session-policy-form';
export default async function LoginPresentationPage() {
  const { s } = await scopedAdmin();
  if (!isGroupAdmin(s)) redirect('/');
  const [canViewPresentation,canEditPresentation,canViewSession,canEditSession]=await Promise.all([
    settingsAccess(s,'view','loginPresentation'),settingsAccess(s,'edit','loginPresentation'),
    settingsAccess(s,'view','loginPresentation.sessionPolicy'),settingsAccess(s,'edit','loginPresentation.sessionPolicy'),
  ]);
  if(!canViewPresentation&&!canViewSession)redirect('/');
  const [t,view,publishedTenant,policy]=await Promise.all([
    getTranslations('loginPresentation'),canViewPresentation?readLoginPresentationEditor(s):null,
    canViewPresentation?loginPresentationTenantId():null,canViewSession?readSessionPolicyEditor(s):null,
  ]);
  const tIdle = await getTranslations('sessionTimeout');
  const tPassword = await getTranslations('passwordPolicy');
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('settingsTitle')} description={t('settingsDescription')}/>
    {view&&<p className="text-sm leading-relaxed text-muted-foreground">{t(publishedTenant === s.tenantId ? 'activeOrganization' : 'otherOrganization')}</p>}
    {internalSelected() && <Card className="p-6"><Link href="/admin/security-center/password-policy" className="text-primary underline">{tPassword('title')}</Link></Card>}
    {view&&<Card className="p-6"><LoginPresentationForm presentation={view.presentation} revision={view.revision} canEdit={canEditPresentation}/></Card>}
    {policy&&<Card className="p-6">
      <SessionPolicyForm idleTimeoutMinutes={policy.idleTimeoutMinutes} revision={policy.revision} canEdit={canEditSession}/>
      {!internalSelected() && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{tIdle('notEnforced')}</p>}
    </Card>}
  </div>;
}
