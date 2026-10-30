import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, SectionHeader, StatusBadge } from '@/components/ui';
import { Pager } from '@/components/pager';
import { paginateRows, parsePageQuery, type PageState } from '@/lib/pagination';
import { scopedSession } from '@/lib/scope';
import { canManagePerfComp, isAdmin, isOnehrOnlyPerformanceAdmin } from '@/lib/authz';
import { todayInKualaLumpur } from '@/lib/hr-date';
import { listCompanies } from '@/core/read';
import { listCycles, listOnehrAdminCycles, type OnehrAdminCycleSummary } from '@/core/performance';
import { NewCycleForm } from '../new-cycle-form';

export type CycleRow = OnehrAdminCycleSummary & { pendingComp?: number };

/**
 * The review cycles list (with its Leaders link) and the new-cycle form, moved here unchanged from /performance so
 * the page and the admin area's Cycle › All cycles draw one copy (D-P1-32 PT-X4). `admin` is the HR / perf-comp
 * administrator: the pending-pay column and cycle creation are theirs; the OneHR performance partner sees neither.
 */
export async function PerformanceCyclesAdmin({ cycles, rows, pgState, basePath, admin, companies, today }: {
  cycles: readonly CycleRow[];
  rows: readonly CycleRow[];
  pgState: PageState;
  basePath: string;
  admin: boolean;
  companies: { id: string; name: string }[];
  today: string;
}) {
  const t = await getTranslations('performance.list'), to = await getTranslations('onehr');
  return (
    <>
    <Card className="overflow-hidden" data-tour="performance-cycles">
      <SectionHeader title={t('reviewCycles')} count={cycles.length} />
      <div className="border-b border-border px-4 py-2 text-sm"><Link href="/performance/leaders" className="text-primary hover:underline">{to('leaders.title')} →</Link> <span className="text-muted-foreground">{to('leaders.listHint')}</span></div>
      <Pager basePath={basePath} state={pgState} />
      {cycles.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t('noCycles')}
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('colCycle')}</th>
              <th className="px-4 py-2 font-medium">{t('colPeriod')}</th>
              <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('colProgress')}</th>
              {admin && <th className="px-4 py-2 text-right font-medium">{t('colPendingPay')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <Link href={`/performance/${c.id}`} className="font-medium text-foreground hover:text-primary">
                    {c.name}
                  </Link>
                  <div className="text-xs text-muted-foreground">
                    {c.companyId ? t('scopeCompany') : t('scopeGroup')}
                    {c.releasedAt ? t('releasedSuffix') : ''}
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {c.periodStart} → {c.periodEnd}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {c.acknowledged}/{c.submitted}/{c.total}
                  <div className="text-[10px] uppercase">{t('progressLegend')}</div>
                </td>
                {admin && (
                  <td className="px-4 py-3 text-right tabular-nums">
                    {(c.pendingComp ?? 0) > 0 ? (
                      <span className="font-medium text-amber-600 dark:text-amber-400">{c.pendingComp}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>

    {admin && (
      <Card data-tour="performance-new-cycle">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">{t('newCycle')}</summary>
          <NewCycleForm companies={companies} today={today} />
        </details>
      </Card>
    )}
    </>
  );
}

/**
 * Cycle › All cycles: the same list and form, read the way /performance reads them — every cycle for the HR /
 * perf-comp administrator, the OneHR-native cycles only for the OneHR performance partner (ADR-0142), who also
 * gets no new-cycle form. Paged at `basePath` (the tab's own address).
 */
export async function AdminAllCycles({ basePath, query }: { basePath: string; query: { page?: string; size?: string } }) {
  const { s, scopeIds } = await scopedSession();
  const admin = isAdmin(s) || canManagePerfComp(s), onehrOnly = isOnehrOnlyPerformanceAdmin(s);
  const [cycles, companies] = await Promise.all([
    (admin ? listCycles(s) : onehrOnly ? listOnehrAdminCycles(s) : Promise.resolve([])) as Promise<CycleRow[]>,
    admin ? listCompanies(s) : Promise.resolve([]),
  ]);
  const { rows, state } = paginateRows(cycles, parsePageQuery(query));
  return <PerformanceCyclesAdmin cycles={cycles} rows={rows} pgState={state} basePath={basePath} admin={admin} companies={companies.filter((c) => scopeIds.includes(c.id)).map((c) => ({ id: c.id, name: c.name }))} today={todayInKualaLumpur()} />;
}
