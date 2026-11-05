import Link from 'next/link';
import { companyRegistrationOverview } from '@/core/company-registration-readiness';
import type { CompanyRegistrationStatus } from '@/lib/company-registration-readiness';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { companyTree } from '@/core/read';
import {
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  inputCls,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { cn } from '@/lib/utils';
import { Pager } from '@/components/pager';
import { pageState, parsePageQuery, paginateRows } from '@/lib/pagination';
import { CompanyRows, COMPANY_STATUS_FILTERS, selectCompanyRows } from './company-rows';
import { resolveGroupTree } from './group-tree';
// 3c2f55d7 rev 2 — the listing's Archive action. Reuses the EXISTING company archive action (the same one
// the company's own maintenance page posts to); no new service, no new permission surface.
import { archiveCompanyAction } from '../actions';

/**
 * Admin → Organization, THE LISTING (item defd4644).
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────────────────────────────
 * This screen used to open straight into a company form with the create form on the same page and no
 * way to browse — the only admin module that worked that way. It is now browse → pick → maintain like
 * the rest: a table of companies here, `/admin/organization/new` for the create form, and
 * `/admin/organization/[companyId]` for one company's maintenance screen.
 *
 * SERVER COMPONENT, NO CLIENT ISLAND. Search, status filter, sort and paging are a plain GET form and
 * `?q=&status=&sort=&page=&size=`, so selection lives in the ADDRESS and every server-side scope guard
 * still applies to it. The previous design shipped every company's full editable panel to the client
 * inside one client wrapper; that payload is what overflowed the Flight row budget and turned rows
 * 2..N into lazies (see the header of components/organization-list.tsx for that story). Nothing on
 * this page crosses the RSC boundary any more.
 *
 * ── SCOPE IS THE QUERY, NOT THE UI ────────────────────────────────────────────────────────────────
 * `listCompanies(s, { includeArchived: true, adminOnly: true })` applies the database's own
 * `app.is_admin_for` — the same predicate the company table's WITH CHECK uses — so every company
 * listed here is one this person can actually write to. For a GROUP-WIDE hr_admin that resolves to
 * every company in the tenant (the reporter's case, unchanged); for a company-scoped admin it is their
 * company and its subtree. DO NOT widen this query to make the listing look fuller: the filter IS the
 * permission boundary, and /admin/organization/[companyId] refuses anything outside it.
 *
 * The company switcher (getScopeIds) is still deliberately ignored: this is a master-data screen, not
 * an operational one (0f1802bf).
 *
 * ── THE HIERARCHY SURVIVES ────────────────────────────────────────────────────────────────────────
 * `companyTree` stays a separate read because it carries parentCompanyId, which listCompanies does not
 * select. Parent company stays a column in the table and a field on the maintenance page.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — test/i18n-coverage.test.ts check C skips any file that
 * opens more than one, which is how a screen of MISSING_MESSAGEs once shipped behind a green suite.
 */

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    q?: string;
    status?: string;
    sort?: string;
    statutory?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const { s } = await scopedAdmin();
  const sp = await searchParams;
  const { error, q, status, sort } = sp;
  const t = await getTranslations('admin.organization');

  // Both reads are RLS-scoped. The per-company panel data (bank profiles, statutory authorities,
  // signatories, profile options, payroll cycles) moved to the maintenance page with the panel it
  // feeds — a browse screen has no business running an N+1 over payroll cycles.
  const [statutory, tree] = await Promise.all([
    companyRegistrationOverview(s),
    companyTree(s),
  ]);
  const companies=statutory.map(row=>row.company);
  const statBy = new Map(statutory.map((r) => [r.id, r]));

  // Country-pack completeness and explicit entity metadata share the same scoped readiness owner.
  const missingStatutory = statutory.filter(row=>row.counted && row.status==='missing');
  const countedCompanies = statutory.filter(row=>row.counted).length;

  const { parentBy } = resolveGroupTree(companies, tree);

  const rows = selectCompanyRows(companies, parentBy, { q, status, sort })
    .map(row=>({...row,statutoryStatus:(statBy.get(row.id)?.status??'missing') as CompanyRegistrationStatus,activeEmployees:statBy.get(row.id)?.activeEmployees??0,registrationCounted:statBy.get(row.id)?.counted??false}))
    .filter(row=>!['complete','missing','not_required'].includes(sp.statutory??'')||(row.statutoryStatus===sp.statutory&&(sp.statutory!=='missing'||row.registrationCounted)));
  rows.sort((a,b)=>Number(b.activeEmployees>0)-Number(a.activeEmployees>0));
  const pq = parsePageQuery(sp);
  const { rows: pageRows } = paginateRows(rows, pq);
  const pgState = pageState(pq, rows.length, pageRows.length);

  const sortHref = (key: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (sp.size) p.set('size', sp.size);
    if (sp.statutory) p.set('statutory', sp.statutory);
    p.set('sort', key);
    return `/admin/organization?${p.toString()}`;
  };

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('pageTitle')}
        description={t('pageDescription')}
        actions={
          <Link href="/admin/organization/new" data-tour="people-org-add" className={btnPrimary}>
            <span aria-hidden className="text-base leading-none">
              +
            </span>
            {t('addNewCompany')}
          </Link>
        }
      />
      <ErrorBanner message={error} />
      <Card data-tour="people-org-companies">
        <SectionHeader title={t('companies')} count={rows.length} />
        {missingStatutory.length > 0 && (
          <details className="mx-4 mt-4 rounded-md border border-border text-sm">
            <summary className="cursor-pointer px-4 py-3">
              {t('registration.topAlert', { missing: missingStatutory.length, total: countedCompanies })}
            </summary>
            <div className="space-y-2 border-t border-border px-4 py-3">
              <p className="text-xs text-muted-foreground">{t('registration.levyHint')}</p>
              <ul className="list-inside list-disc">
                {missingStatutory.map(({ company }) => (
                  <li key={company.id}>
                    <Link href={`/admin/organization/${company.id}/statutory`} className="text-primary underline underline-offset-2">
                      {company.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href="/admin/organization?statutory=missing" className="inline-flex min-h-11 items-center text-primary underline underline-offset-2">
                {t('registration.showInTable')}
              </Link>
            </div>
          </details>
        )}
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('searchLabel')}
            <input
              name="q"
              type="search"
              defaultValue={q ?? ''}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              className={cn(inputCls, 'w-72')}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t('colStatus')}
            <select name="status" defaultValue={status ?? ''} className={cn(inputCls, 'w-44')}>
              <option value="">{t('allStatuses')}</option>
              {COMPANY_STATUS_FILTERS.map((v) => (
                <option key={v} value={v}>
                  {v === 'archived' ? t('statusArchived') : t('statusActive')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('registration.column')}<select name="statutory" defaultValue={sp.statutory??''} className={cn(inputCls,'w-44')}><option value="">{t('registration.all')}</option>{(['complete','missing','not_required'] as const).map(value=><option key={value} value={value}>{t(`registration.${value}`)}</option>)}</select></label>
          {/* Sort and page size ride along so applying a filter does not silently reset them. `page`
              deliberately does NOT: a new filter belongs on page one. */}
          {sort && <input type="hidden" name="sort" value={sort} />}
          {sp.size && <input type="hidden" name="size" value={sp.size} />}
          <button type="submit" className={btnPrimary}>
            {t('applyFilter')}
          </button>
        </form>

        <Pager basePath="/admin/organization" params={{ q, status, sort, statutory:sp.statutory }} state={pgState} />
        {/* 3783fd87 — lines rather than filled grey. `tableWrapCls`'s own rounded border is dropped
            because this table sits INSIDE a Card that already draws one; two borders 4px apart is the
            "unnecessary grey" the request names, and the Card's own edge is the boundary. The shared
            constants are reused rather than re-written by hand — overriding them HERE keeps every other
            admin table on the house look, which is the drift components/ui.tsx exists to prevent. */}
        <div className={cn(tableWrapCls, 'rounded-none border-0')}>
          <table className="w-full text-sm">
            <thead className={cn(theadCls, 'border-y border-border bg-transparent')}>
              <tr>
                <th className={cn(thCls,'hidden sm:table-cell')}>
                  <Link href={sortHref('code')}>{t('colCode')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('name')}>{t('legalName')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('regNo')}>{t('regNo')}</Link>
                </th>
                <th className={thCls}>{t('registration.column')}</th>
                <th className={thCls}>
                  <Link href={sortHref('parent')}>{t('parentCompany')}</Link>
                </th>
                <th className={thCls}>
                  <Link href={sortHref('status')}>{t('colStatus')}</Link>
                </th>
                <th className={thCls}>{t('colActions')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {/* 3c2f55d7 rev 2 — View · Edit · Archive replaces the single Open link. Archive is a
                  write, so the row posts to the SAME server action the company's own page uses; nothing
                  new was added to core for it. */}
              <CompanyRows
                rows={pageRows}
                labels={{
                  active: t('statusActive'),
                  archived: t('statusArchived'),
                  empty: companies.length === 0 ? t('noCompaniesYet') : t('noMatches'),
                  view: t('actionView'),
                  edit: t('actionEdit'),
                  archive: t('actionArchive'),
                  unarchive: t('actionUnarchive'),
                  registration:{complete:t('registration.complete'),missing:t('registration.missing'),not_required:t('registration.not_required'),completeAction:t('registration.completeAction')},
                }}
                archiveAction={archiveCompanyAction}
              />
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
