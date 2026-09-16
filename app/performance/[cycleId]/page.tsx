import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { calibrationView, cycleDetail } from '@/core/performance';
import { listBatches } from '@/core/payroll';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { Button, Card, EmployeeCode, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, inputCls } from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { todayInKualaLumpur } from '@/lib/hr-date';
import {
  calibrateAction,
  closeAction,
  closeReviewAction,
  commitCalibrationAction,
  declineAction,
  enactAction,
  openCalibrationAction,
  openCycleAction,
  proposeCalibrationAction,
  releaseAction,
} from '../actions';

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
  const tl = await getTranslations('performance.lifecycle');
  const { cycleId } = await params;
  const { error } = await searchParams;
  const data = await cycleDetail(s, cycleId);
  if (!data) notFound();
  const { cycle, roster, distribution, budget } = data;
  const calib = cycle.status === 'calibration' ? await calibrationView(s, cycleId) : null;
  const today = todayInKualaLumpur();
  const nextDay = new Date(Date.parse(`${cycle.periodEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  // r292 — PERFORMANCE AND PAYROLL ARE SEPARATELY SOLD, and this screen reads payroll only for the comp
  // seam (a merit/bonus recommendation is enacted onto a DRAFT batch). `listBatches` is service-gated
  // (core/module-gate.ts), so a tenant with Performance but WITHOUT Payroll would have had this page throw.
  // No Payroll ⇒ no draft batches ⇒ the enact control simply has nowhere to post, which is what the empty
  // list already expresses; `enactCompAction` refuses at the payroll service if it is reached anyway.
  const batches = isModuleEnabledOrFalse(s, 'payroll') ? await listBatches(s) : [];
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

          {/* Calibration cockpit (ADR-0022) — admins propose adjusted overall ratings, then commit */}
          {calib && (
            <Card className="overflow-hidden border-indigo-200 dark:border-indigo-500/30">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-indigo-50/50 px-4 py-3 dark:bg-indigo-500/10">
                <div>
                  <h2 className="text-sm font-semibold">{t('calibrationTitle')}</h2>
                  <p className="text-xs text-muted-foreground">{t('calibrationHint')}</p>
                </div>
                {calib.status === 'committed' ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                    {t('calibrationCommitted')}
                  </span>
                ) : calib.sessionId == null ? (
                  <form action={openCalibrationAction}>
                    <input type="hidden" name="cycleId" value={cycle.id} />
                    <Button type="submit" size="sm">
                      {t('calibrationOpen')}
                    </Button>
                  </form>
                ) : (
                  <form action={commitCalibrationAction}>
                    <input type="hidden" name="sessionId" value={calib.sessionId} />
                    <input type="hidden" name="cycleId" value={cycle.id} />
                    <Button type="submit" size="sm">
                      {t('calibrationCommit')}
                    </Button>
                  </form>
                )}
              </div>

              {/* Per-reviewer leniency (analytics) */}
              {calib.reviewerLeniency.length > 0 && (
                <div className="border-b border-border px-4 py-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('calibrationLeniency')}</p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {calib.reviewerLeniency.map((rl) => (
                      <span key={rl.reviewer} className="tabular-nums">
                        {rl.reviewer}: <span className="font-medium">{rl.avg}</span>
                        <span className="text-xs text-muted-foreground"> ({rl.count})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* By-department grouping (calibration governance, G3) */}
              {calib.byDepartment.length > 0 && (
                <div className="border-b border-border px-4 py-3">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{tl('byDepartment')}</p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {calib.byDepartment.map((d) => (
                      <span key={d.department} className="tabular-nums">
                        {d.department}: <span className="font-medium">{d.avg}</span>
                        <span className="text-xs text-muted-foreground"> ({d.count})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Roster with inline proposed-rating editor (when a session is open) */}
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">{t('calibrationCode')}</th>
                    <th className="px-4 py-2 font-medium">{t('calibrationEmployee')}</th>
                    <th className="px-4 py-2 font-medium">{t('calibrationReviewer')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('calibrationCurrent')}</th>
                    <th className="px-4 py-2 text-center font-medium">{t('calibrationProposed')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {calib.rows.map((cr) => (
                    <tr key={cr.reviewId}>
                      <td className="px-4 py-2.5">
                        <EmployeeCode code={cr.employeeCode} />
                      </td>
                      <td className="px-4 py-2.5 font-medium">{cr.employee}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{cr.reviewer ?? '—'}</td>
                      <td className="px-4 py-2.5 text-center tabular-nums">{cr.overallRating ?? '—'}</td>
                      <td className="px-4 py-2.5 text-center">
                        {calib.status === 'open' && calib.sessionId ? (
                          <form action={proposeCalibrationAction} className="flex items-center justify-center">
                            <input type="hidden" name="sessionId" value={calib.sessionId} />
                            <input type="hidden" name="reviewId" value={cr.reviewId} />
                            <input type="hidden" name="cycleId" value={cycle.id} />
                            <select
                              name="proposedRating"
                              defaultValue={cr.proposedRating ?? ''}
                              className={`${inputCls} w-32`}
                              // auto-submit on change via a sibling button is simpler than JS; show a Save
                            >
                              <option value="">—</option>
                              {calib.ratingScale.map((sc) => (
                                <option key={sc.value} value={sc.value}>
                                  {sc.value} · {sc.label}
                                </option>
                              ))}
                            </select>
                            <Button type="submit" size="sm" variant="ghost" className="ml-1">
                              {t('calibrationSet')}
                            </Button>
                          </form>
                        ) : (
                          <span className="tabular-nums text-muted-foreground">{cr.proposedRating ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

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
                        {/* Employee ID left-of-name (feedback 38668d9b) */}
                        {r.employeeCode && <EmployeeCode code={r.employeeCode} className="mr-1.5" />}
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
                  <th className="px-4 py-2 font-medium">{t('colCode')}</th>
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
                    <td className="px-4 py-2.5">
                      <EmployeeCode code={r.employeeCode} />
                    </td>
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

          {/* Final closure (lifecycle G4) — admin records final score + ABC once the cycle is released */}
          {cycle.releasedAt != null && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold">{tl('closurePanelTitle')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{tl('closurePanelHint')}</p>
              <form action={closeReviewAction} className="mt-3 flex flex-wrap items-end gap-2">
                <input type="hidden" name="cycleId" value={cycle.id} />
                <Field label={t('colEmployee')}>
                  <select name="reviewId" required className={inputCls} defaultValue="">
                    <option value="" disabled>—</option>
                    {roster
                      .filter((r) => r.status === 'submitted' || r.status === 'acknowledged')
                      .map((r) => (
                        <option key={r.reviewId} value={r.reviewId}>
                          {r.employee}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={tl('finalScore')}>
                  <input name="finalScore" type="number" step="0.01" min="0" className={`${inputCls} w-24`} />
                </Field>
                <Field label={tl('abcClass')}>
                  <select name="abcClass" required className={inputCls} defaultValue="">
                    <option value="" disabled>—</option>
                    <option value="A">{tl('classA')}</option>
                    <option value="B">{tl('classB')}</option>
                    <option value="C">{tl('classC')}</option>
                  </select>
                </Field>
                <Button type="submit" variant="secondary">{tl('closeReview')}</Button>
              </form>
            </Card>
          )}
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
