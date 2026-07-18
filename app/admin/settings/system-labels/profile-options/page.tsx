import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listAllProfileOptions, PROFILE_OPTION_CATEGORIES } from '@/core/profile-options';
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
export default async function ProfileOptionsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.profileOptions');
  const { error } = await searchParams;
  const all = await listAllProfileOptions(s, { activeOnly: false });
  const totalCount = Object.values(all).reduce((n, rows) => n + rows.length, 0);

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
          categories={[...PROFILE_OPTION_CATEGORIES]}
          data={all}
          actions={{ save: saveProfileOptionsAction, remove: removeProfileOptionAction }}
        />
      )}
    </div>
  );
}
