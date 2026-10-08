import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/ui';
import { LEVEL, listMyCompanies } from '@/packs/lifecycle/service';
import { lifecycleSession } from '../../_guard';
import { ImportHires } from './import-hires';

export default async function ImportPage() {
  const { s } = await lifecycleSession(LEVEL.agent);
  const t = await getTranslations('lifecycle');
  const companies = await listMyCompanies(s);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('import.title')} description={t('import.subtitle')} back={{ href: '/lifecycle/onboarding', label: t('onboarding.title') }} />
      <ImportHires companies={companies.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}
