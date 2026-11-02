import { readPasswordPolicy } from '@/core/password-policy';
import { PasswordPolicyForm } from './password-policy-form';
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
  const [t, view, publishedTenant, policy] = await Promise.all([
    getTranslations('loginPresentation'), readLoginPresentationEditor(s), loginPresentationTenantId(), readSessionPolicyEditor(s),
  ]);
  const tIdle = await getTranslations('sessionTimeout');
  const passwordPolicy = internalSelected() ? await readPasswordPolicy(s) : null;
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('settingsTitle')} description={t('settingsDescription')}/>
    <p className="text-sm leading-relaxed text-muted-foreground">{t(publishedTenant === s.tenantId ? 'activeOrganization' : 'otherOrganization')}</p>
    {passwordPolicy && <Card className="p-6"><PasswordPolicyForm {...passwordPolicy}/></Card>}
    <Card className="p-6"><LoginPresentationForm presentation={view.presentation} revision={view.revision}/></Card>
    <Card className="p-6">
      <SessionPolicyForm idleTimeoutMinutes={policy.idleTimeoutMinutes} revision={policy.revision}/>
      {!internalSelected() && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{tIdle('notEnforced')}</p>}
    </Card>
  </div>;
}
