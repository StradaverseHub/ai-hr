import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { getHolidayGroup, listGroupHolidayIds, listHolidayGroups, listHolidays } from '@/core/admin';
import { PageHeader, ErrorBanner } from '@/components/ui';
import { HolidayGroupForm } from '@/components/holiday-group-form';
import { updateHolidayGroupAction } from '../../../actions';

/** 66b8f5a8 — dedicated holiday-group EDIT page. Group info section + holiday tick-list, prefilled. */
export default async function EditHolidayGroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidayGroups');
  const { id } = await params;
  const { error } = await searchParams;

  const group = await getHolidayGroup(s, { id });
  if (!group) notFound();

  const [holidays, groups, selectedIds] = await Promise.all([
    listHolidays(s, {}),
    listHolidayGroups(s),
    listGroupHolidayIds(s, { groupId: id }),
  ]);
  // Only parentless groups (excluding self) may be a parent (single-level nesting — service-enforced too).
  const parentCandidates = groups
    .filter((g) => !g.parentGroupId && g.id !== id)
    .map((g) => ({ id: g.id, name: g.name }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('editTitle')} back={{ href: '/admin/holidays/groups', label: t('back') }} />
      <ErrorBanner message={error} />
      <HolidayGroupForm
        action={updateHolidayGroupAction}
        value={{
          id: group.id,
          name: group.name,
          code: group.code,
          description: group.description,
          active: group.active,
          states: (group.states as string[]) ?? [],
          archetype: group.archetype ?? 'standard',
          parentGroupId: group.parentGroupId,
        }}
        holidays={holidays}
        selectedIds={selectedIds}
        parentCandidates={parentCandidates}
      />
    </div>
  );
}
