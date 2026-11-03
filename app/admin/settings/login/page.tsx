import { readRememberedMfaPolicyEditor } from '@/core/remembered-mfa-policy';
import { RememberedMfaForm } from './remembered-mfa-form';
import Link from 'next/link';
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
  const rememberedMfa = internalSelected() ? await readRememberedMfaPolicyEditor(s) : null;
  const tPassword = await getTranslations('passwordPolicy');
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('settingsTitle')} description={t('settingsDescription')}/>
    <p className="text-sm leading-relaxed text-muted-foreground">{t(publishedTenant === s.tenantId ? 'activeOrganization' : 'otherOrganization')}</p>
    {internalSelected() && <Card className="p-6"><Link href="/admin/security-center/password-policy" className="text-primary underline">{tPassword('title')}</Link></Card>}
    {rememberedMfa && <Card className="p-6"><RememberedMfaForm {...rememberedMfa}/></Card>}
    <Card className="p-6"><LoginPresentationForm presentation={view.presentation} revision={view.revision}/></Card>
    <Card className="p-6">
      <SessionPolicyForm idleTimeoutMinutes={policy.idleTimeoutMinutes} revision={policy.revision}/>
      {!internalSelected() && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{tIdle('notEnforced')}</p>}
    </Card>
  </div>;
}
