import Link from 'next/link';
import { notFound } from 'next/navigation';
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
        back={{ href: '/performance', label: 'Performance' }}
        title={cycle.name}
        description={
          <>
            {cycle.companyId ? 'Company cycle' : 'Group-wide'} · {cycle.periodStart} → {cycle.periodEnd}
            {cycle.releasedAt ? ' · ratings released' : ''}
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={cycle.status} />
            {cycle.status === 'draft' && (
              <LifecycleButton action={openCycleAction} cycleId={cycle.id} label="Open cycle" />
            )}
            {cycle.status === 'open' && (
              <LifecycleButton action={calibrateAction} cycleId={cycle.id} label="Move to calibration" variant="secondary" />
            )}
            {(cycle.status === 'open' || cycle.status === 'calibration') && !cycle.releasedAt && (
              <form action={releaseAction}>
                <input type="hidden" name="cycleId" value={cycle.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="secondary"
                  title="Release ratings to employees?"
                  description="Every employee will be able to see their manager rating and overall score. This cannot be undone."
                  confirmLabel="Release ratings"
                >
                  Release ratings
                </ConfirmSubmit>
              </form>
            )}
            {(cycle.status === 'open' || cycle.status === 'calibration') && (
              <LifecycleButton action={closeAction} cycleId={cycle.id} label="Close" variant="outline" />
            )}
          </div>
        }
      />
      <ErrorBanner message={error} />

      {cycle.status === 'draft' ? (
        <Card className="p-6 text-sm text-muted-foreground">
          This cycle is a draft. Opening it snapshots the in-scope employees into one review each
          (administrative manager as reviewer) and starts the self-review stage.
        </Card>
      ) : (
        <>
          {/* Distribution + budget */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h2 className="text-sm font-semibold">Rating distribution</h2>
              <p className="text-xs text-muted-foreground">Finalized overall ratings</p>
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
              <h2 className="text-sm font-semibold">Merit budget</h2>
              <p className="text-xs text-muted-foreground">
                {budget.pool == null ? 'No pool set for this cycle' : 'Recommended salary increases vs the pool (monthly)'}
              </p>
              {budget.pool == null ? (
                <p className="mt-4 text-sm">
                  Recommended merit: <span className="font-medium tabular-nums">{rm(budget.consumed)}</span> / month
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
                    <span className="text-muted-foreground">used {rm(budget.consumed)}</span>
                    <span className={budget.over ? 'font-medium text-red-600 dark:text-red-400' : 'text-muted-foreground'}>
                      {budget.over ? `over by ${rm(Math.abs(budget.remaining ?? 0))}` : `${rm(budget.remaining)} left`}
                    </span>
                    <span className="text-muted-foreground">pool {rm(budget.pool)}</span>
                  </div>
                </div>
              )}
              <p className="mt-3 text-xs text-muted-foreground">
                Recommended bonuses (one-off): <span className="tabular-nums">{rm(budget.bonusTotal)}</span>
              </p>
            </Card>
          </div>

          {/* Enact worklist */}
          {pendingComp.length > 0 && (
            <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
              <SectionHeader title="Pay recommendations to enact" count={pendingComp.length} />
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                Enacting applies the change through payroll: a merit % becomes an effective-dated salary
                increase; a bonus is staged into a draft batch and taxed as additional remuneration. Performance
                never writes pay directly.
              </p>
              <ul className="divide-y divide-border">
                {pendingComp.map((r) => (
                  <li key={r.reviewId} className="px-4 py-3">
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="text-sm">
                        <span className="font-medium">{r.employee}</span>
                        <div className="text-xs text-muted-foreground">
                          {r.recommendedMeritPct != null && (
                            <>merit {r.recommendedMeritPct}% (on {rm(r.currentBasic)}) </>
                          )}
                          {r.recommendedBonus != null && <>· bonus {rm(r.recommendedBonus)}</>}
                        </div>
                      </div>
                      <div className="flex items-end gap-2">
                        {r.recommendedBonus != null && draftBatches.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            Bonus needs a draft batch —{' '}
                            <Link href="/payroll" className="text-primary hover:underline">
                              create one in Payroll
                            </Link>
                          </span>
                        ) : (
                          <form action={enactAction} className="flex items-end gap-2">
                            <input type="hidden" name="reviewId" value={r.reviewId} />
                            <input type="hidden" name="cycleId" value={cycle.id} />
                            {r.recommendedMeritPct != null && (
                              <label className="text-[10px] uppercase text-muted-foreground">
                                effective
                                <input name="meritEffectiveFrom" type="date" defaultValue={nextDay} className={`${inputCls} w-36`} required />
                              </label>
                            )}
                            {r.recommendedBonus != null && (
                              <label className="text-[10px] uppercase text-muted-foreground">
                                bonus batch
                                <select name="bonusBatchId" className={`${inputCls} w-44`} required defaultValue="">
                                  <option value="" disabled>
                                    choose draft batch
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
                              title={`Enact pay for ${r.employee}?`}
                              description="This applies a real pay change through payroll — an effective-dated raise and/or a taxed bonus. It cannot be undone here."
                              confirmLabel="Enact"
                            >
                              Enact
                            </ConfirmSubmit>
                          </form>
                        )}
                        <form action={declineAction}>
                          <input type="hidden" name="reviewId" value={r.reviewId} />
                          <input type="hidden" name="cycleId" value={cycle.id} />
                          <Button type="submit" size="sm" variant="outline">
                            Decline
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
            <SectionHeader title="Reviews" count={roster.length} />
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Employee</th>
                  <th className="px-4 py-2 font-medium">Reviewer</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-center font-medium">Self</th>
                  <th className="px-4 py-2 text-center font-medium">Overall</th>
                  <th className="px-4 py-2 font-medium">Recommendation</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {roster.map((r) => (
                  <tr key={r.reviewId} className="hover:bg-muted/40">
                    <td className="px-4 py-2.5 font-medium">{r.employee}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.reviewer ?? '— (admin)'}</td>
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
                          {r.recommendedMeritPct != null && `merit ${r.recommendedMeritPct}% `}
                          {r.recommendedBonus != null && `bonus ${rm(r.recommendedBonus)} `}
                          <span className="text-foreground">({r.compActionStatus})</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/performance/review/${r.reviewId}`} className="text-xs text-primary hover:underline">
                        Open
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
