/**
 * Reports hub (ADR-0074, c440b365) — the single "Report" surface. Groups every reporting destination by
 * the six reporter categories (Master / Attendance / Leave / Payroll / Claim / Performance): the existing
 * predefined reports as one-click links PLUS the user's saved custom reports, with a "New custom report"
 * entry per category that opens the drag-and-drop builder.
 *
 * Admin-only (scopedAdmin) — every linked report surface is already admin-gated today.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCustomReports } from '@/core/custom-reports';
import { datasetsForCategory, REPORT_CATEGORIES, type ReportCategory } from '@/core/report-registry';
import { Card, PageHeader, ErrorBanner } from '@/components/ui';
import { ReportRowActions } from './ReportRowActions';

export const dynamic = 'force-dynamic';

/** Predefined (built-in) report destinations per category — honest links to surfaces that exist today. */
const PREDEFINED: Record<ReportCategory, { href: string; key: string }[]> = {
  master: [{ href: '/analytics', key: 'analytics' }],
  attendance: [
    /* ⚠️ THIS POINTED AT `/attendance/ot-report` AND 404'd. `app/attendance/ot-report/` holds ONLY
       `export/route.ts` — a download endpoint, never a page — so the link in a list whose own comment
       promises "surfaces that exist today" was the one entry that did not. The Overtime report is an
       export control on the Attendance screen, so that is where this now goes. Caught by a browser
       audit: the 404 only ever showed up as a failed RSC prefetch, never as a broken-looking page. */
    { href: '/attendance#ot-report', key: 'otReport' },
    { href: '/attendance', key: 'attendanceRecords' },
  ],
  leave: [{ href: '/analytics#leave', key: 'leaveAnalytics' }],
  payroll: [
    { href: '/payroll/reports', key: 'payrollReports' },
    { href: '/payroll/transactions/view', key: 'payrollView' },
  ],
  claim: [{ href: '/claims', key: 'claims' }],
  performance: [{ href: '/performance', key: 'performance' }],
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { s } = await scopedAdmin();
  const t = await getTranslations('reports');
  const sp = await searchParams;
  const only = sp.cat as ReportCategory | undefined;
  const categories = only && REPORT_CATEGORIES.includes(only) ? [only] : REPORT_CATEGORIES;

  const saved = await listCustomReports(s);

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      {sp.error && <ErrorBanner message={sp.error} />}
      {sp.toast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400">
          {sp.toast}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {categories.map((cat) => {
          const datasets = datasetsForCategory(cat);
          const custom = saved.filter((r) => r.category === cat);
          const links = PREDEFINED[cat];
          return (
            <Card key={cat} className="space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">{t(`category.${cat}`)}</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">{t(`categoryDesc.${cat}`)}</p>
                </div>
                {datasets.length > 0 && (
                  <Link
                    href={`/reports/builder/new?dataset=${encodeURIComponent(datasets[0].id)}`}
                    className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:opacity-90"
                  >
                    {t('newReport')}
                  </Link>
                )}
              </div>

              {/* Predefined reports */}
              {links.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                    {t('builtInReports')}
                  </div>
                  <ul className="space-y-1">
                    {links.map((l) => (
                      <li key={l.href}>
                        <Link
                          href={l.href}
                          className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm transition hover:bg-accent/60"
                        >
                          <span>{t(`predefined.${l.key}`)}</span>
                          <span aria-hidden className="text-muted-foreground">→</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Custom reports */}
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
                  {t('customReports')}
                </div>
                {datasets.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    {t('noDataset')}
                  </p>
                ) : custom.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    {t('noCustomReports')}
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {custom.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      >
                        {/* Same click-through affordance as the predefined rows above (feedback 622e12eb):
                            label on the left, → on the right; the row actions menu keeps its own slot. */}
                        <Link href={`/reports/builder/${r.id}`} className="flex min-w-0 flex-1 items-center gap-2">
                          {r.isFavourite && <span aria-hidden className="text-amber-500">★</span>}
                          <span className="truncate hover:underline">{r.name}</span>
                          {r.shared && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('shared')}
                            </span>
                          )}
                          <span aria-hidden className="ml-auto pl-2 text-muted-foreground">→</span>
                        </Link>
                        <ReportRowActions
                          id={r.id}
                          isFavourite={r.isFavourite}
                          shared={r.shared}
                          labels={{
                            favourite: t('favourite'),
                            unfavourite: t('unfavourite'),
                            share: t('share'),
                            unshare: t('unshare'),
                            duplicate: t('duplicate'),
                            delete: t('delete'),
                            deleteConfirm: t('deleteConfirm'),
                            exportCsv: t('exportCsv'),
                            exportXlsx: t('exportXlsx'),
                            exportPdf: t('exportPdf'),
                            exportDocx: t('exportDocx'),
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
