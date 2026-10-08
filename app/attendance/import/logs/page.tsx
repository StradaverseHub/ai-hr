import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { listClockingImportRuns } from '@/packs/attendance/service';
import { RunsTable } from './runs-table';

/** r424 (50ed39e1) — every clocking-file import, most recent first. Administrators only (requireAdmin). */
export default async function ClockingImportLogsPage() {
  const s = await requireAdmin();
  const t = await getTranslations('clockingFile.logs');
  const runs = await listClockingImportRuns(s);
  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader back={{ href: '/attendance/import', label: t('back') }} title={t('title')} description={t('description')} />
      <RunsTable runs={runs} />
    </div>
  );
}
