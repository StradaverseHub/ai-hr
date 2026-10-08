import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { getClockingMapping } from '@/packs/attendance/service';
import { BUILTIN_MAPPING_ID } from '@/lib/clocking-file';
import { PageHeader } from '@/components/ui';
import { MappingForm } from '../../mapping-form';

/** r424 (50ed39e1) — Edit Mapping. The built-in template cannot be edited; its address shows the view. */
export default async function EditFileMappingPage({ params }: { params: Promise<{ mappingId: string }> }) {
  const s = await requireAdmin();
  const { mappingId } = await params;
  if (mappingId === BUILTIN_MAPPING_ID) redirect(`/admin/attendance/file-mappings/${BUILTIN_MAPPING_ID}`);
  if (!/^[0-9a-f-]{36}$/i.test(mappingId)) notFound();
  const m = await getClockingMapping(s, mappingId);
  if (!m) notFound();
  const t = await getTranslations('clockingFile.form');
  const { id: _id, createdAt: _c, updatedAt: _u, lastUsedAt: _l, ...initial } = m;
  return (
    <div className="mx-auto max-w-[90rem] space-y-6">
      <PageHeader back={{ href: '/admin/attendance/file-mappings', label: t('back') }} title={t('editTitle')} description={t('intro')} />
      <MappingForm mappingId={m.id} initial={initial} />
    </div>
  );
}
