import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { payrollCycleReadiness } from '@/core/payroll-readiness';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { settingsBack } from '@/app/payroll/setup/back';
import { CYCLE_ROOT, cycleCompanyHref } from './nav';

/**
 * Payroll Cycles — THE COMPANY LISTING (feedback 6df24751).
 *
 * This page used to be three jobs stacked in one column: a company picker, that company's cycle table, and
 * the add/edit form in a Card at the bottom. It is now step 1 of a company-first route, the shape the
 * neighbouring Pay Items screen was rebuilt into (911b2886): pick a company here, manage that company's
 * catalog on its own screen, edit one cycle on a screen of its own.
 *
 * NOTHING ON THIS PAGE WRITES. There is no upsert form here any more — that is the whole point of the
 * item, and test/payroll-settings-company-first.test.ts pins it so the form cannot creep back underneath
 * the list.
 *
 * The status column costs no new query: `payrollCycleReadiness` is the same two-query aggregate already
 * powering the readiness panel on /payroll/setup, so a company that cannot open a payroll run is flagged
 * by exactly the rule that will refuse it (INVALID_CYCLE), here as well as there.
 *
 * requireAdmin (via scopedAdmin) gates the page; RLS (can_admin_payroll_for) is the real backstop.
 */
export default async function PayrollCycleCompaniesPage({
  searchParams,
}: {
  // `edit` / `copy` are the PRE-SPLIT parameters, declared but not read: every legacy link that carried
  // one also carried `company`, so the redirect below already routes them to the right screen. They are
  // kept in the type so the old query shape stays greppable from the screen that replaced it.
  searchParams: Promise<{ company?: string; error?: string; edit?: string; copy?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollCycleConfig');
  const { company: companyParam, error, q: qParam } = await searchParams;

  // Back-compat: the pre-split UI addressed a company with ?company=ID (bookmarks, browser history, and
  // every redirect the server actions used to mint). Send those to the company's own screen rather than
  // silently ignoring the parameter and showing an unfiltered list.
  if (companyParam) redirect(cycleCompanyHref(companyParam));

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const q = (qParam ?? '').trim();
  const needle = q.toLowerCase();
  const rows = needle ? companies.filter((c) => c.name.toLowerCase().includes(needle)) : companies;

  // Readiness for the FILTERED set only — the aggregate is cheap, but there is no reason to compute a
  // status for companies the search has already hidden.
  const readiness = await payrollCycleReadiness(
    s,
    rows.map((c) => c.id),
  );
  const byCompany = new Map(readiness.map((r) => [r.companyId, r]));

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('listDescription')} back={await settingsBack()} />
      {error && <ErrorBanner message={error} />}

      <Card className="overflow-hidden">
        <SectionHeader title={t('companiesTitle')} count={rows.length} />

        {/* Search — a plain GET form, so the term lives in the URL and every back link can carry it. */}
        <div className="flex flex-wrap items-center gap-3 px-4 pb-3">
          <form action={CYCLE_ROOT} method="get" className="flex items-center gap-2">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('searchCompanyPlaceholder')}
              aria-label={t('searchCompanyPlaceholder')}
              className={`${inputCls} w-56`}
            />
            <button className={btnPrimary} type="submit">
              {t('search')}
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colCycles')}</th>
                <th className="px-4 py-2 font-medium">{t('colDefaultCycle')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('colStatus')}</th>
                <th className="px-4 py-2 font-medium">{t('colLastUpdated')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((c) => {
                const r = byCompany.get(c.id);
                // "Ready" is not a softer word for "has rows": it is `canRunRegularPayroll`, the exact
                // condition core/payroll-run-group.ts enforces when a run is opened.
                const ready = r?.canRunRegularPayroll ?? false;
                return (
                  <tr key={c.id}>
                    <td className="px-4 py-2.5 font-medium">{c.name}</td>
                    <td className="px-4 py-2.5 text-center tabular-nums text-muted-foreground">
                      {r?.activeCycles ?? 0}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {r?.defaultCycleName ? (
                        // A stored default that names no live cycle reads as configured when it is not —
                        // the exact production shape 707b3851 was raised for. Say so on the row.
                        <span title={r.defaultCycleResolves ? undefined : t('defaultCycleMissing')}>
                          {r.defaultCycleName}
                          {!r.defaultCycleResolves && <span className="ml-1 text-amber-600 dark:text-amber-400">!</span>}
                        </span>
                      ) : (
                        t('notSet')
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <Badge variant={ready ? 'success' : 'warning'}>
                        {ready ? t('statusReady') : t('statusNeedsSetup')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {r?.lastUpdatedAt ? r.lastUpdatedAt.toISOString().slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-3">
                        {/* View, not Edit: a company holds SEVERAL cycles, so there is no single record
                            for an Edit link here to open. Editing happens one cycle at a time, inside. */}
                        <Link
                          href={cycleCompanyHref(c.id, q)}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {t('view')}
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {t('emptyCompanies')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">{t('readinessNote')}</p>
    </div>
  );
}
