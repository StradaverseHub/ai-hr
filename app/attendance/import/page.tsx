import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { listClockingMappings } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID, BUILTIN_MAPPING_NAME } from '@/lib/clocking-file';
import { layoutLabel } from '@/app/admin/attendance/file-mappings/labels';
import { ClockingImport, type ImportMappingOption } from './clocking-import';

/**
 * r424 (50ed39e1) — Attendance › Import Clocking Data (the Import row, renamed). Choose an ACTIVE mapping,
 * drop the device's file, Validate (nothing saved), then Import the valid lines; every import leaves a
 * log. Administrators only, as before (requireAdmin).
 */
export default async function AttendanceImportPage() {
  const s = await requireAdmin();
  const t = await getTranslations('clockingFile');
  const mappings = await listClockingMappings(s);
  const options: ImportMappingOption[] = [
    ...mappings
      .filter((m) => m.active)
      .map((m) => ({
        id: m.id,
        label: t('import.mappingOption', { name: m.name, type: t(`fileType.${m.fileType}`), layout: layoutLabel(t, m) }),
        encoding: m.encoding as ImportMappingOption['encoding'],
      })),
    {
      id: BUILTIN_MAPPING_ID,
      label: t('import.mappingOption', { name: BUILTIN_MAPPING_NAME, type: t('fileType.csv'), layout: t('layoutName.builtin') }),
      encoding: 'utf-8',
    },
  ];
  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader
        title={t('import.title')}
        description={t('import.description')}
        actions={
          <Link href="/attendance/import/logs" className="text-sm text-primary underline underline-offset-2">
            {t('import.logsLink')}
          </Link>
        }
      />
      <ClockingImport mappings={options} />
    </div>
  );
}
