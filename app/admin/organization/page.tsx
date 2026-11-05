import {OrganisationTaggingWorkspace} from './organisation-tagging-workspace';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { companyRegistrationOverview } from '@/core/company-registration-readiness';
import { registrationTreeState, type CompanyRegistrationStatus, type CompanyRegistrationReadiness } from '@/lib/company-registration-readiness';
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
import { resolveGroupTree, type TreeNode } from './group-tree';
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
 * select. Parent company is a COLUMN in the table, the Group Structure card still draws the tree, and
 * the parent is settable on each company's maintenance page. A pure flat table would look tidier and
 * quietly break the group hierarchy other screens depend on.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — test/i18n-coverage.test.ts check C skips any file that
 * opens more than one, which is how a screen of MISSING_MESSAGEs once shipped behind a green suite.
 */

function CompanyTree({
  nodes,
  parentId = null,
  depth = 0,
  registration, counts, missingLabel,
}: {
  nodes: TreeNode[];
  parentId?: string | null;
  depth?: number;
  registration: ReadonlyMap<string, CompanyRegistrationReadiness>;
  counts: ReadonlyMap<string, number>;
  missingLabel: (count: number) => string;
}) {
  const children = nodes.filter((n) => n.parentId === parentId);
  if (children.length === 0) return null;
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5 border-l border-border pl-3'}>
      {children.map((n) => (
        <li key={n.id}>
          <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">{n.name}{registration.get(n.id)?.counted && registration.get(n.id)?.status==='missing' && <AlertTriangle aria-label={missingLabel(1)} className="h-4 w-4 text-amber-700 dark:text-amber-400"/>}{!!counts.get(n.id) && <span className="text-xs font-normal text-muted-foreground">{missingLabel(counts.get(n.id)!)}</span>}</span>{' '}
          <span className="text-xs text-muted-foreground">{n.country}</span>
          <CompanyTree nodes={nodes} parentId={n.id} depth={depth + 1} registration={registration} counts={counts} missingLabel={missingLabel} />
        </li>
      ))}
    </ul>
  );
}

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    q?: string;
    status?: string;
    sort?: string;
    statutory?: string;
    issues?: string;
    page?: string;
    size?: string;
  }>;
}) {
  const { s } = await scopedAdmin();
  const sp = await searchParams;
  const { error, q, status, sort } = sp;
  const t = await getTranslations('admin.organization');

  // Three reads, all RLS-scoped. The per-company panel data (bank profiles, statutory authorities,
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

  // The group hierarchy, intersected with the administrable set and re-rooted — see ./group-tree.ts.
  const { visibleTree, parentBy } = resolveGroupTree(companies, tree);

  // Rows for the table: derived from the SAME resolved company array as the Group Structure card, so
  // the two bracketed counts on this screen cannot drift apart.
  const treeReadiness = registrationTreeState(visibleTree, statBy);
  const issuesOnly=sp.issues==='1';
  const displayedTree=issuesOnly?visibleTree.filter(node=>treeReadiness.visible.has(node.id)):visibleTree;
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
    if (sp.issues) p.set('issues', sp.issues);
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
      {missingStatutory.length>0 && <div role="status" className="rounded-md border border-border p-4 text-sm"><p>{t('registration.topAlert',{missing:missingStatutory.length,total:countedCompanies})}</p><p className="mt-1 text-xs text-muted-foreground">{t('registration.levyHint')}</p><Link href="/admin/organization?statutory=missing" className="mt-2 inline-flex min-h-11 items-center text-primary underline underline-offset-2">{t('registration.showInTable')}</Link></div>}

      {/* Group structure is collapsed by default (native details/summary keeps this a server
          component — no client JS/state). Reuses SectionHeader's border/padding classes; the
          Show/Hide affordance toggles via the group-open CSS variant. CompanyTree stays
          server-rendered inside so navigation/rendering of the hierarchy is unchanged. */}
      <Card data-tour="people-org-tree">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between border-b border-border px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              {t('groupStructure')}
              <span className="ml-2 text-muted-foreground">({companies.length})</span>
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              <span className="group-open:hidden">{t('showGroupStructure')}</span>
              <span className="hidden group-open:inline">{t('hideGroupStructure')}</span>
            </span>
          </summary>
          <div className="px-4 py-3">
            <Link href={issuesOnly?'/admin/organization':'/admin/organization?issues=1'} aria-pressed={issuesOnly} className="mb-3 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-2">{issuesOnly?t('registration.showAllBranches'):t('registration.showIssuesOnly')}</Link>
            {displayedTree.length > 0 ? (
              <CompanyTree nodes={displayedTree} registration={statBy} counts={treeReadiness.counts} missingLabel={count=>t('registration.missingCount',{count})} />
            ) : (
              <p className="text-sm text-muted-foreground">{t('noCompaniesYet')}</p>
            )}
          </div>
        </details>
      </Card>

      <OrganisationTaggingWorkspace session={s}/>

      <Card data-tour="people-org-companies">
        <SectionHeader title={t('companies')} count={rows.length} />
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
          {sp.issues && <input type="hidden" name="issues" value={sp.issues}/>}
          {/* Sort and page size ride along so applying a filter does not silently reset them. `page`
              deliberately does NOT: a new filter belongs on page one. */}
          {sort && <input type="hidden" name="sort" value={sort} />}
          {sp.size && <input type="hidden" name="size" value={sp.size} />}
          <button type="submit" className={btnPrimary}>
            {t('applyFilter')}
          </button>
        </form>

        <Pager basePath="/admin/organization" params={{ q, status, sort, statutory:sp.statutory,issues:sp.issues }} state={pgState} />
        {/* 3783fd87 — lines rather than filled grey. `tableWrapCls`'s own rounded border is dropped
            because this table sits INSIDE a Card that already draws one; two borders 4px apart is the
            "unnecessary grey" the request names, and the Card's own edge is the boundary. The shared
            constants are reused rather than re-written by hand — overriding them HERE keeps every other
            admin table on the house look, which is the drift components/ui.tsx exists to prevent. */}
        <div className={cn(tableWrapCls, 'rounded-none border-0')}>
          <table className="w-full text-sm">
            <thead className={cn(theadCls, 'border-y border-border bg-transparent')}>
              <tr>
                <th className={thCls}>
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
