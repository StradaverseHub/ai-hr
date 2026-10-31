import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { seedCatalogAction } from '../actions';
import { cycleHref, cycleListHref, cycleNewHref } from '../nav';

/**
 * 6df24751 — ONE COMPANY'S PAYROLL CYCLE CATALOG (step 2 of the company-first route).
 *
 * A company holds SEVERAL cycles, so the middle of the route is a real list rather than the single record
 * the original sketch assumed. Nothing else is on this page: no company picker (the company is the route)
 * and no add/edit form (those are their own screens). Add New Cycle, and each row's View / Edit, are the
 * only ways in.
 *
 * Copy to companies, Activate / Deactivate and Delete are unchanged in behaviour but have MOVED onto the
 * individual cycle's screen — a row of four competing actions per line is what made the old table hard to
 * read, and every one of them acts on a single cycle, which now has somewhere of its own to live.
 *
 * The back link goes ONE STEP, to the company listing, carrying the listing's search term — never all the
 * way out to Payroll Settings (that is `settingsBack()`, and it belongs only on the listing itself).
 */
export default async function CompanyPayrollCyclesPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollCycleConfig');
  const { companyId } = await params;
  const { error, q } = await searchParams;

  const all = await listCompanies(s);
  // Out of scope is indistinguishable from "does not exist" on purpose — RLS is the real backstop, and a
  // 404 tells an admin nothing about companies they may not administer.
  const company = all.find((c) => c.id === companyId && scopeIds.includes(c.id));
  if (!company) notFound();

  const cycles = await listPayrollCycles(s, company.id);

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={company.name}
        description={t('description')}
        back={{ href: cycleListHref(q), label: t('title') }}
        actions={
          <Link href={cycleNewHref(company.id, q)} className={btnPrimary}>
            {t('addNewCycle')}
          </Link>
        }
      />
      {error && <ErrorBanner message={error} />}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 pr-4">
          <SectionHeader title={t('catalogTitle')} count={cycles.length} />
          {cycles.length === 0 && (
            <form action={seedCatalogAction}>
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="q" value={q ?? ''} />
              <button className={btnPrimary}>{t('seedDefaults')}</button>
            </form>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colName')}</th>
                {/* 4157a498 — the short code an import file's "Payroll Cycle" column names. */}
                <th className="px-4 py-2 font-medium">{t('colCode')}</th>
                <th className="px-4 py-2 font-medium">{t('colRunType')}</th>
                <th className="px-4 py-2 font-medium">{t('colRemarks')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colSort')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastUpdated')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {cycles.map((c) => {
                const active = c.archivedAt == null;
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{c.code ?? '—'}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      <span title={t(`runTypeHint.${c.runType}`)}>{t(`runType.${c.runType}`)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{c.remarks ?? '—'}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums">{c.sortOrder}</td>
                    <td className="px-4 py-2.5 text-center">
                      <Badge variant={active ? 'success' : 'default'}>{active ? t('active') : t('inactive')}</Badge>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {/* Blank until the row is next edited — migration 0443 deliberately backfilled
                          nothing, because any backfilled date would be a claim about history. */}
                      {c.updatedAt ? c.updatedAt.toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        {/* Two doors onto ONE screen (the pay-components precedent, where the Input Type
                            cell and the Edit action both open ./[code]): a cycle's screen shows everything
                            about it AND lets it be changed, so "view it" and "edit it" are the same place. */}
                        <Link href={cycleHref(company.id, c.id, q)} className="text-xs font-medium text-primary hover:underline">
                          {t('view')}
                        </Link>
                        <Link href={cycleHref(company.id, c.id, q)} className="text-xs font-medium text-primary hover:underline">
                          {t('edit')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {cycles.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
