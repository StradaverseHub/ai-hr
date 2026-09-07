import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listHolidayGroups } from '@/core/admin';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary } from '@/components/ui';
import { HolidayTabs } from '@/components/holiday-tabs';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import { deleteHolidayGroupAction } from '../../actions';

/**
 * Holiday Group tab (66b8f5a8) — a simple list of the reusable holiday groups. Columns: code, name, status
 * + Edit / Delete actions; an "Add New" button in the top-right opens the dedicated add page (not a popup).
 * Groups are shared across the whole organisation (no company assignment) — already true today.
 *
 * PAGED SINCE 9da61c86, for the same reason its sibling Holiday tab is: it is a list of records, and the
 * bar is a framework rather than a control that appears once a list gets big (see showPager). Most tenants
 * will see one page and the record count — which is the point, because until now the screen said neither.
 */
export default async function HolidayGroupsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; page?: string; size?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.holidayGroups');
  const sp = await searchParams;
  const { error } = sp;
  const groups = await listHolidayGroups(s);
  const pq = parsePageQuery(sp);
  const { rows: pageGroups, state: pgState } = paginateRows(groups, pq);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <Link href="/admin/holidays/groups/new" className={btnPrimary}>
            {t('addNew')}
          </Link>
        }
      />
      <HolidayTabs active="groups" />
      <ErrorBanner message={error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('pageTitle')} count={groups.length} />
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">{t('codeCol')}</th>
                  <th className="px-4 py-2">{t('nameCol')}</th>
                  <th className="px-4 py-2">{t('statusCol')}</th>
                  <th className="px-4 py-2 text-right">{t('editAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageGroups.map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-2 font-mono text-muted-foreground">{g.code ?? '—'}</td>
                    <td className="px-4 py-2 font-medium text-foreground">
                      {g.name}
                      {g.parentName && (
                        <span className="ml-2 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                          {t('inheritsFrom', { name: g.parentName })}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {g.active ? t('statusActive') : t('statusInactive')}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-3">
                        <Link
                          href={`/admin/holidays/groups/${g.id}`}
                          className="text-sm font-medium text-indigo-600 transition-colors hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
                        >
                          {t('editAction')}
                        </Link>
                        <form action={deleteHolidayGroupAction}>
                          <input type="hidden" name="id" value={g.id} />
                          <button className="text-sm text-muted-foreground transition-colors hover:text-red-500">
                            {t('deleteAction')}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {/* The record count and the rows-per-page choice, on the same bar every other list carries. */}
            <Pager basePath="/admin/holidays/groups" state={pgState} />
          </>
        )}
      </Card>
    </div>
  );
}
