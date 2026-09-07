import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listHiringDefaults } from '@/core/hiring-defaults';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import {
  Badge,
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import {
  SettingsSearch,
  SettingsStatusFilter,
  SettingsToolbar,
  SortHeader,
  parseSettingsStatus,
  parseSortDir,
  rowActionCls,
  rowActionsCls,
  type SettingsStatus,
  type SortDir,
} from '@/components/settings-list';

// Not exported: Next refuses unknown exports from a page module. The three files of this route each
// declare it; the guard test pins that they agree.
const PAGE = '/admin/settings/hiring-defaults';

/**
 * Hiring Defaults — the COMPANY LIST (feedback 7b5f18c3).
 *
 * WHAT MOVED, AND WHAT DID NOT. The screen used to live at /admin/personnel/settings, reachable only
 * from a button in the top-right corner of the Personnel list, and it rendered every company's form on
 * one page. It is a system setup, not a daily HR task, so it now sits in System Settings beside Employee
 * ID, Dashboard Cards, System Labels and Movement Settings — and it is a list of companies, one of which
 * you open. The old address still resolves (a redirect stub) so bookmarks survive.
 *
 * The SETTINGS THEMSELVES ARE UNTOUCHED. core/hiring-defaults.ts is not modified by this item: same
 * two per-company values (probation months, review-reminder cadence), same reads, same writes, same
 * clamp-to-NULL-restores-the-built-in behaviour. This is navigation plus presentation, which is why it
 * carries no migration.
 *
 * THE REPORTER ASKED FOR MORE FIELDS THAN EXIST. Their sketch listed Default Employment Type, Employee
 * Status, Payroll Policy, Leave Policy, Attendance Policy, Currency and Pay Mode. None of those is a
 * hiring default today (currency is a company-level field owned by Organization → General), and adding
 * them would be a schema change plus a hire-path change — its own request, not this one. The two real
 * settings are shown; nothing is invented to fill the sketch.
 *
 * ONE TRANSLATION NAMESPACE, so test/i18n-coverage.test.ts Check C statically resolves every key here.
 *
 * scopedAdmin (not the old requireAdmin + scopedSession pair) matches its four System Settings siblings
 * and narrows the company list to the acting scope. Access is IDENTICAL — scopedAdmin calls requireAdmin
 * internally — so the function-access matrix reports the same two admin roles it always did.
 */
export default async function HiringDefaultsListPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    toast?: string;
    q?: string;
    status?: string;
    sort?: string;
    dir?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('hiringDefaults');
  const sp = await searchParams;

  // includeArchived is LOAD-BEARING: the page does its own Active/Inactive/All filtering, so without it
  // an archived company would vanish from every filter including "All" (the pay-components precedent).
  const all = await listCompanies(s, { includeArchived: true });
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const defaults = await listHiringDefaults(
    s,
    companies.map((c) => c.id),
  );
  const byCompany = new Map(defaults.map((d) => [d.companyId, d]));

  const q = (sp.q ?? '').trim();
  const status: SettingsStatus = parseSettingsStatus(sp.status);
  const sort = sp.sort === 'status' ? 'status' : 'company';
  const dir: SortDir = parseSortDir(sp.dir);

  const needle = q.toLowerCase();
  const rows = companies
    .filter((c) => {
      // Company Name and Company Code, the two the reporter named. `companyLabel` IS the code field —
      // db/schema.ts calls it "short name / abbreviation / internal code" and Organization → General
      // maintains it; there is no second `code` column to search.
      const okQ = !needle || [c.name, c.companyLabel ?? ''].some((v) => v.toLowerCase().includes(needle));
      const okStatus =
        status === 'all' || (status === 'inactive' ? c.archivedAt != null : c.archivedAt == null);
      return okQ && okStatus;
    })
    .sort((a, b) => {
      const by =
        sort === 'status'
          ? Number(a.archivedAt != null) - Number(b.archivedAt != null) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name);
      return dir === 'desc' ? -by : by;
    });

  // Filter and sort first, page second, so a column header orders every company rather than one page of
  // them. The count beside the heading stays the whole matching set (9da61c86).
  const pq = parsePageQuery(sp);
  const { rows: pageRows, state: pgState } = paginateRows(rows, pq);

  /** Keep the whole view in the address when one control changes. `page` is NOT carried: a new filter or
   *  a new sort is a new list, and page 4 of the old one means nothing in it. `size` IS carried — it is
   *  not a position in a list but the reader's own choice of how many rows to see, and a filter change is
   *  no reason to reset it. */
  const href = (over: Partial<{ q: string; status: SettingsStatus; sort: string; dir: SortDir }>) => {
    const next = { q, status, sort, dir, ...over };
    const usp = new URLSearchParams();
    if (next.q) usp.set('q', next.q);
    if (next.status !== 'active') usp.set('status', next.status);
    if (next.sort !== 'company') usp.set('sort', next.sort);
    if (next.dir !== 'asc') usp.set('dir', next.dir);
    if (sp.size) usp.set('size', String(pq.size));
    const qs = usp.toString();
    return qs ? `${PAGE}?${qs}` : PAGE;
  };
  const sortHref = (col: 'company' | 'status') =>
    href({ sort: col, dir: sort === col && dir === 'asc' ? 'desc' : 'asc' });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SectionHeader title={t('catalogTitle')} count={rows.length} />

        <SettingsToolbar>
          <SettingsSearch
            action={PAGE}
            value={q}
            placeholder={t('searchPlaceholder')}
            hidden={{ status: status === 'active' ? undefined : status, sort: sort === 'company' ? undefined : sort, dir: dir === 'asc' ? undefined : dir }}
          />
          <SettingsStatusFilter
            current={status}
            options={[
              { value: 'active', href: href({ status: 'active' }), label: t('statusActive') },
              { value: 'inactive', href: href({ status: 'inactive' }), label: t('statusInactive') },
              { value: 'all', href: href({ status: 'all' }), label: t('statusAll') },
            ]}
          />
        </SettingsToolbar>

        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>
                  <SortHeader
                    label={t('colCompany')}
                    href={sortHref('company')}
                    active={sort === 'company'}
                    dir={dir}
                  />
                </th>
                <th className={thCls}>{t('colCode')}</th>
                <th className={thCls}>{t('colProbation')}</th>
                <th className={thCls}>{t('colReminders')}</th>
                <th className={thCls}>
                  <SortHeader
                    label={t('colStatus')}
                    href={sortHref('status')}
                    active={sort === 'status'}
                    dir={dir}
                  />
                </th>
                <th className={thCls}></th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {pageRows.map((c) => {
                const d = byCompany.get(c.id) ?? null;
                return (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-medium">
                      <Link href={`${PAGE}/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {c.companyLabel || '—'}
                    </td>
                    {/* NULL is not "unset and broken" — it means the built-in default applies, which is a
                        real, working configuration. Say so rather than showing a blank cell. */}
                    <td className="px-3 py-2">
                      {d?.probationMonths != null ? (
                        <span className="tabular-nums">{d.probationMonths}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('usingDefault')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {d?.reviewReminderDays?.length ? (
                        <span className="tabular-nums">{d.reviewReminderDays.join(', ')}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('usingDefault')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={c.archivedAt ? 'default' : 'success'}>
                        {c.archivedAt ? t('statusInactive') : t('statusActive')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className={rowActionsCls}>
                        <Link href={`${PAGE}/${c.id}`} className={rowActionCls}>
                          {t('edit')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    {companies.length === 0 ? t('emptyScope') : t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          basePath={PAGE}
          params={{
            q: q || undefined,
            status: status === 'active' ? undefined : status,
            sort: sort === 'company' ? undefined : sort,
            dir: dir === 'asc' ? undefined : dir,
          }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
