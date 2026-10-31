import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listHolidayGroups, listHolidays } from '@/core/admin';
import { PageHeader, ErrorBanner } from '@/components/ui';
import { HolidayGroupForm } from '@/components/holiday-group-form';
import { createHolidayGroupAction } from '../../../actions';

/** 66b8f5a8 — dedicated "Add New" holiday-group page (not a popup). Group info section + holiday tick-list. */
export default async function NewHolidayGroupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidayGroups');
  const { error } = await searchParams;
  const [holidays, groups] = await Promise.all([listHolidays(s, {}), listHolidayGroups(s)]);
  // Only parentless groups may be a parent (single-level nesting — service-enforced too).
  const parentCandidates = groups.filter((g) => !g.parentGroupId).map((g) => ({ id: g.id, name: g.name }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('newTitle')} back={{ href: '/admin/holidays/groups', label: t('back') }} />
      <ErrorBanner message={error} />
      <HolidayGroupForm
        action={createHolidayGroupAction}
        value={{ name: '', code: null, description: null, active: true, states: [], archetype: 'standard', parentGroupId: null }}
        holidays={holidays}
        selectedIds={[]}
        parentCandidates={parentCandidates}
      />
    </div>
  );
}
