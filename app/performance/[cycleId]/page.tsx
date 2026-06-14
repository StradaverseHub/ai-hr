import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { cycleDetail } from '@/core/performance';
import { listBatches } from '@/core/payroll';
import { Button, Card, ErrorBanner, PageHeader, SectionHeader, StatusBadge, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { calibrateAction, closeAction, declineAction, enactAction, openCycleAction, releaseAction } from '../actions';

const rm = (n: number | null | undefined) =>
  n == null ? '—' : `RM ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_TONE: Record<string, string> = {
  self_review: 'text-muted-foreground',
  manager_review: 'text-blue-600 dark:text-blue-400',
  submitted: 'text-emerald-600 dark:text-emerald-400',
  acknowledged: 'text-emerald-700 dark:text-emerald-300',
};

export default async function CyclePage({
  params,
  searchParams,
}: {
  params: Promise<{ cycleId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('performance.cycle');
  const { cycleId } = await params;
  const { error } = await searchParams;
  const data = await cycleDetail(s, cycleId);
  if (!data) notFound();
  const { cycle, roster, distribution, budget } = data;
  const today = new Date().toISOString().slice(0, 10);
  const nextDay = new Date(Date.parse(`${cycle.periodEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const batches = await listBatches(s);
  const draftBatches = batches.filter((b) => b.status === 'draft');
  const pendingComp = roster.filter((r) => r.compActionStatus === 'recommended');
  const maxDist = Math.max(1, ...distribution.map((d) => d.count));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/performance', label: t('back') }}
        title={cycle.name}
        description={
          <>
            {cycle.companyId ? t('scopeCompany') : t('scopeGroup')} · {cycle.periodStart} → {cycle.periodEnd}
            {cycle.releasedAt ? ` · ${t('ratingsReleased')}` : ''}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={cycle.status} />
            {cycle.status === 'draft' && (
              <LifecycleButton action={openCycleAction} cycleId={cycle.id} label={t('openCycle')} />
            )}
            {cycle.status === 'open' && (
              <LifecycleButton action={calibrateAction} cycleId={cycle.id} label={t('moveToCalibration')} variant="secondary" />
            )}
            {(cycle.status === 'open' || cycle.status === 'calibration') && !cycle.releasedAt && (
              <form action={releaseAction}>
                <input type="hidden" name="cycleId" value={cycle.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="secondary"
                  title={t('releaseConfirmTitle')}
                  description={t('releaseConfirmDescription')}
                  confirmLabel={t('releaseRatings')}
                >
                  {t('releaseRatings')}
                </ConfirmSubmit>
              </form>
            )}
            {(cycle.status === 'open' || cycle.status === 'calibration') && (
              <LifecycleButton action={closeAction} cycleId={cycle.id} label={t('close')} variant="outline" />
            )}
          </div>
        }
      />
      <ErrorBanner message={error} />

      {cycle.status === 'draft' ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {t('draftHint')}
        </Card>
      ) : (
        <>
          {/* Distribution + budget */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('ratingDistribution')}</h2>
              <p className="text-xs text-muted-foreground">{t('finalizedOverallRatings')}</p>
              <div className="mt-4 space-y-2">
                {distribution.map((d) => (
                  <div key={d.value} className="flex items-center gap-3 text-sm">
                    <span className="w-28 shrink-0 text-muted-foreground">
                      {d.value} · {d.label}
                    </span>
                    <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
                      <div
                        className="h-full rounded bg-primary/70"
                        style={{ width: `${(d.count / maxDist) * 100}%` }}
                      />
                    </div>
                    <span className="w-6 text-right tabular-nums">{d.count}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <h2 className="text-sm font-semibold">{t('meritBudget')}</h2>
              <p className="text-xs text-muted-foreground">
                {budget.pool == null ? t('noPoolSet') : t('recommendedIncreasesVsPool')}
              </p>
              {budget.pool == null ? (
                <p className="mt-4 text-sm">
                  {t('recommendedMeritLabel')} <span className="font-medium tabular-nums">{rm(budget.consumed)}</span> {t('perMonth')}
                </p>
              ) : (
                <div className="mt-4 space-y-2">
                  <div className="h-5 overflow-hidden rounded bg-muted">
                    <div
                      className={`h-full rounded ${budget.over ? 'bg-red-500/70' : 'bg-emerald-500/70'}`}
                      style={{ width: `${Math.min(100, (budget.consumed / budget.pool) * 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-sm tabular-nums">
                    <span className="text-muted-foreground">{t('used', { amount: rm(budget.consumed) })}</span>
                    <span className={budget.over ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}>
                      {budget.over ? t('overBy', { amount: rm(Math.abs(budget.remaining ?? 0)) }) : t('left', { amount: rm(budget.remaining) })}
                    </span>
                    <span className="text-muted-foreground">{t('pool', { amount: rm(budget.pool) })}</span>
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                {t('recommendedBonusesLabel')} <span className="tabular-nums">{rm(budget.bonusTotal)}</span>
              </p>
            </Card>
          </div>

          {/* Enact worklist */}
          {pendingComp.length > 0 && (
            <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
              <SectionHeader title={t('payRecommendationsToEnact')} count={pendingComp.length} />
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                {t('enactExplainer')}
              </p>
              <ul className="divide-y divide-border">
                {pendingComp.map((r) => (
                  <li key={r.reviewId} className="px-4 py-3">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="text-sm">
                        <span className="font-medium">{r.employee}</span>
                        <div className="text-xs text-muted-foreground">
                          {r.recommendedMeritPct != null && (
                            <>{t('meritOn', { pct: r.recommendedMeritPct, basic: rm(r.currentBasic) })} </>
                          )}
                          {r.recommendedBonus != null && <>{t('bonusSep', { amount: rm(r.recommendedBonus) })}</>}
                        </div>
                      </div>
                      <div className="flex items-end gap-2">
                        {r.recommendedBonus != null && draftBatches.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t('bonusNeedsBatch')}{' '}
                            <Link href="/payroll" className="text-primary hover:underline">
                              {t('createOneInPayroll')}
                            </Link>
                          </span>
                        ) : (
                          <form action={enactAction} className="flex items-end gap-2">
                            <input type="hidden" name="reviewId" value={r.reviewId} />
                            <input type="hidden" name="cycleId" value={cycle.id} />
                            {r.recommendedMeritPct != null && (
                              <label className="text-[10px] uppercase text-muted-foreground">
                                {t('effective')}
                                <input name="meritEffectiveFrom" type="date" defaultValue={nextDay} className={`${inputCls} w-36`} required />
                              </label>
                            )}
                            {r.recommendedBonus != null && (
                              <label className="text-[10px] uppercase text-muted-foreground">
                                {t('bonusBatch')}
                                <select name="bonusBatchId" className={`${inputCls} w-44`} required defaultValue="">
                                  <option value="" disabled>
                                    {t('chooseDraftBatch')}
                                  </option>
                                  {draftBatches.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.company} · {b.payPeriod}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            <ConfirmSubmit
                              size="sm"
                              variant="default"
                              title={t('enactConfirmTitle', { employee: r.employee })}
                              description={t('enactConfirmDescription')}
                              confirmLabel={t('enact')}
                            >
                              {t('enact')}
                            </ConfirmSubmit>
                          </form>
                        )}
                        <form action={declineAction}>
                          <input type="hidden" name="reviewId" value={r.reviewId} />
                          <input type="hidden" name="cycleId" value={cycle.id} />
                          <Button type="submit" size="sm" variant="outline">
                            {t('decline')}
                          </Button>
                        </form>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Roster */}
          <Card className="overflow-hidden">
            <SectionHeader title={t('reviews')} count={roster.length} />
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('colReviewer')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('colSelf')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('colOverall')}</th>
                  <th className="px-4 py-2 font-medium">{t('colRecommendation')}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {roster.map((r) => (
                  <tr key={r.reviewId} className="hover:bg-muted/40">
                    <td className="px-4 py-2.5 font-medium">{r.employee}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.reviewer ?? t('reviewerAdminFallback')}</td>
                    <td className={`px-4 py-2.5 capitalize ${STATUS_TONE[r.status] ?? ''}`}>
                      {r.status.replace('_', ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-center tabular-nums text-muted-foreground">{r.selfRating ?? '—'}</td>
                    <td className="px-4 py-2.5 text-center font-medium tabular-nums">{r.overallRating ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.compActionStatus === 'none' ? (
                        '—'
                      ) : (
                        <span className="capitalize">
                          {r.recommendedMeritPct != null && `${t('meritShort', { pct: r.recommendedMeritPct })} `}
                          {r.recommendedBonus != null && `${t('bonusShort', { amount: rm(r.recommendedBonus) })} `}
                          <span className="text-foreground">({r.compActionStatus})</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/performance/review/${r.reviewId}`} className="text-xs text-primary hover:underline">
                        {t('open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function LifecycleButton({
  action,
  cycleId,
  label,
  variant,
}: {
  action: (fd: FormData) => void | Promise<void>;
  cycleId: string;
  label: string;
  variant?: 'secondary' | 'outline';
}) {
  return (
    <form action={action}>
      <input type="hidden" name="cycleId" value={cycleId} />
      <Button type="submit" size="sm" variant={variant}>
        {label}
      </Button>
    </form>
  );
}
