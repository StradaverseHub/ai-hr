import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { isGroupAdmin } from '@/lib/authz-model';
import { settingEnabledOrDefault } from '@/core/entitlements';
import { PageHeader, pageWideCls } from '@/components/ui';
import { PayrollCorrectionsForm } from '../corrections-form';

/** Same tenant setting and audited writer as the former inline form. */
export default async function PayrollCorrectionControlsPage() {
  const { s } = await scopedAdmin();
  const t = await getTranslations('payroll.setup');
  return <div className={pageWideCls}>
    <PageHeader title={t('corrections.title')} back={{ href: '/payroll/setup', label: t('title') }}/>
    <PayrollCorrectionsForm
      enabled={settingEnabledOrDefault(s, 'payroll.reset_enabled')}
      canEdit={isGroupAdmin(s)}
      labels={{
        title: t('corrections.title'), label: t('corrections.label'),
        description: t('corrections.description'), scope: t('corrections.scope'),
        readOnly: t('corrections.readOnly'), save: t('corrections.save'),
        saving: t('corrections.saving'), saved: t('corrections.saved'),
      }}
    />
  </div>;
}
