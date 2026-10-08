import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { PageHeader } from '@/components/ui';
import { MappingForm } from '../mapping-form';

/** r424 (50ed39e1) — New Mapping. Administrators only, like the list it hangs off. */
export default async function NewFileMappingPage() {
  await requireAdmin();
  const t = await getTranslations('clockingFile.form');
  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader back={{ href: '/admin/attendance/file-mappings', label: t('back') }} title={t('newTitle')} description={t('intro')} />
      <MappingForm mappingId={null} initial={null} />
    </div>
  );
}
