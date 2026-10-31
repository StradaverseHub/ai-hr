import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { isGroupAdmin } from '@/lib/authz';
import { readLoginPresentationEditor } from '@/core/login-presentation';
import { loginPresentationTenantId } from '@/lib/login-presentation-server';
import { PageHeader, Card } from '@/components/ui';
import { LoginPresentationForm } from './presentation-form';
export default async function LoginPresentationPage() {
  const { s } = await scopedAdmin();
  if (!isGroupAdmin(s)) redirect('/');
  const [t, view, publishedTenant] = await Promise.all([
    getTranslations('loginPresentation'), readLoginPresentationEditor(s), loginPresentationTenantId(),
  ]);
  return <div className="mx-auto max-w-3xl space-y-6">
    <PageHeader title={t('settingsTitle')} description={t('settingsDescription')}/>
    <p className="text-sm leading-relaxed text-muted-foreground">{t(publishedTenant === s.tenantId ? 'activeOrganization' : 'otherOrganization')}</p>
    <Card className="p-6"><LoginPresentationForm presentation={view.presentation} revision={view.revision}/></Card>
  </div>;
}
