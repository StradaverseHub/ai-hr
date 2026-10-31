import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requireAdmin } from '@/lib/authz';
import { getHolidayGroup, listGroupHolidayIds, listHolidayGroups, listHolidays } from '@/core/admin';
// 0e276da0 (r269) — the same read the Locations screen uses, so the calendar's own screen says the same
// thing without anything being attached to it.
import { holidayCalendarCoverage } from '@/core/holidays';
import { PageHeader, ErrorBanner } from '@/components/ui';
import { HolidayGroupForm } from '@/components/holiday-group-form';
import { HolidayCoverageWarning } from '@/components/holiday-coverage-warning';
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

  const [holidays, groups, selectedIds, coverage] = await Promise.all([
    listHolidays(s, {}),
    listHolidayGroups(s),
    listGroupHolidayIds(s, { groupId: id }),
    holidayCalendarCoverage(s),
  ]);
  // 0e276da0 — what THIS calendar would cost the staff of any location attached to it. Only a
  // stand-alone (Custom) calendar can cost anything, so the component renders nothing for the others.
  const thisCoverage = coverage.find((c) => c.groupId === id);
  // Only parentless groups (excluding self) may be a parent (single-level nesting — service-enforced too).
  const parentCandidates = groups
    .filter((g) => !g.parentGroupId && g.id !== id)
    .map((g) => ({ id: g.id, name: g.name }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('editTitle')} back={{ href: '/admin/holidays/groups', label: t('back') }} />
      <ErrorBanner message={error} />
      {/* 0e276da0 — the gap, visible here without attaching anything. WARN, never block: Save is
          untouched and a deliberately short calendar still saves. */}
      {thisCoverage && <HolidayCoverageWarning coverage={thisCoverage} showComplete />}
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
