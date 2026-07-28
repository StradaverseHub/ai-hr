import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAllProfileOptions, PERSON_PROFILE_CATEGORIES } from '@/core/profile-options';
import { Button, Card, ErrorBanner, PageHeader } from '@/components/ui';
import { SystemLabelsTabs } from '@/components/system-labels-tabs';
import { ProfileOptionsGrid } from '@/components/profile-options-grid';
import { saveProfileOptionsAction, seedProfileOptionsAction, removeProfileOptionAction } from './actions';

// 15277676 — Profile Options is rebuilt from a stack of one Card+table PER category (which grew unbounded and
// forced excessive scrolling) into a single Excel-style master-data grid: a left category rail + one editable
// spreadsheet for the selected category, mirroring the sibling System Labels grid. This server component just
// loads the full catalog and hands it to the client grid; all mutations flow through the SAME core functions
// (via actions.ts) so value-immutability + DomainEvent coverage are unchanged. The grid is DELIBERATELY
// simpler than SystemLabelsGrid — Profile Options is a flat tenant-wide catalog with no company scope/sharing.
//
// c9986927 — this tab now shows only the genuine personal-profile lists. Division / Branch / Region / Line /
// Section / Team / Base / Category are organisation master data and are maintained on the Organisation
// Labels tab beside Departments, Positions, Cost Centres and Business Units. The catalog itself is
// unchanged (same table, same core mutations) — only the maintenance surface moved.
export default async function ProfileOptionsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.profileOptions');
  const { error } = await searchParams;
  const all = await listAllProfileOptions(s, { activeOnly: false });
  // Counted over the categories this tab still renders, so a tenant whose only rows are org values does not
  // see an empty grid with no way to seed the personal-profile defaults.
  const totalCount = PERSON_PROFILE_CATEGORIES.reduce((n, c) => n + (all[c] ?? []).length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      <SystemLabelsTabs active="profile-options" />
      <ErrorBanner message={error} />

      {totalCount === 0 ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('emptyAll')}</p>
          <form action={seedProfileOptionsAction}>
            <Button type="submit">{t('seedDefaults')}</Button>
          </form>
        </Card>
      ) : (
        <ProfileOptionsGrid
          categories={[...PERSON_PROFILE_CATEGORIES]}
          data={all}
          actions={{ save: saveProfileOptionsAction, remove: removeProfileOptionAction }}
        />
      )}
    </div>
  );
}
