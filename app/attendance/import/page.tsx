import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { PunchImport } from './punch-import';

export default async function AttendanceImportPage() {
  const t = await getTranslations('attendance.import');
  await requireAdmin();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/attendance', label: t('backLabel') }}
        title={t('title')}
        description={t('description')}
      />
      <PunchImport />
    </div>
  );
}
