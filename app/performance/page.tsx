import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import { listCycles, managerCheckIns, managerPendingReviews } from '@/core/performance';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, inputCls } from '@/components/ui';
import {
  cancelCheckInAction,
  completeCheckInAction,
  createCycleAction,
  scheduleCheckInAction,
} from './actions';

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { s } = await scopedSession();
  const t = await getTranslations('performance.list');
  const admin = isAdmin(s);
  const manager = (s.roles ?? []).includes('manager');
  if (!admin && !manager) redirect('/');
  const { error } = await searchParams;
  const today = new Date().toISOString().slice(0, 10);

  const [cycles, pending, companies, checkinData] = await Promise.all([
    admin ? listCycles(s) : Promise.resolve([]),
    managerPendingReviews(s),
    admin ? listCompanies(s) : Promise.resolve([]),
    managerCheckIns(s),
  ]);
  const { checkins, reports } = checkinData;
  const checkinTone = (status: string) =>
    status === 'completed'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
      : status === 'cancelled'
        ? 'bg-muted text-muted-foreground'
        : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-400';

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div data-tour="performance-intro">
        <PageHeader title={t('title')} description={t('description')} />
      </div>
      <ErrorBanner message={error} />

      {pending.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div data-tour="performance-pending" className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('awaitingYou')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {pending.length}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {pending.map((r) => (
              <li key={r.reviewId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <span className="font-medium">{r.employee}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{r.cycleName}</span>
                </div>
                <Link href={`/performance/review/${r.reviewId}`} className="text-sm text-primary hover:underline">
                  {t('reviewAction')}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(reports.length > 0 || checkins.length > 0) && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('checkinsTitle')} count={checkins.length} />
          {reports.length > 0 && (
            <form action={scheduleCheckInAction} className="flex flex-wrap items-end gap-3 border-b border-border bg-muted/20 px-4 py-3">
              <Field label={t('checkinReport')}>
                <select name="subjectEmploymentId" required defaultValue="" className={`${inputCls} w-48`}>
                  <option value="" disabled>
                    {t('checkinReportPlaceholder')}
                  </option>
                  {reports.map((r) => (
                    <option key={r.employmentId} value={r.employmentId}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('checkinDate')}>
                <input name="scheduledOn" type="date" required defaultValue={today} className={inputCls} />
              </Field>
              <Button type="submit" variant="secondary">
                {t('checkinSchedule')}
              </Button>
            </form>
          )}
          {checkins.length === 0 ? (
            <p className="px-4 py-5 text-center text-sm text-muted-foreground">{t('checkinsEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {checkins.map((c) => (
                <li key={c.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{c.subject}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{c.scheduledOn}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${checkinTone(c.status)}`}>
                        {t(`checkinStatus_${c.status}`)}
                      </span>
                    </div>
                    {c.status === 'scheduled' && (
                      <div className="flex items-center gap-2">
                        <form action={completeCheckInAction} className="flex items-center gap-2">
                          <input type="hidden" name="checkinId" value={c.id} />
                          <input name="notes" placeholder={t('checkinNotesPlaceholder')} className={`${inputCls} w-56`} />
                          <Button type="submit" size="sm" variant="secondary">
                            {t('checkinComplete')}
                          </Button>
                        </form>
                        <form action={cancelCheckInAction}>
                          <input type="hidden" name="checkinId" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost">
                            {t('checkinCancel')}
                          </Button>
                        </form>
                      </div>
                    )}
                  </div>
                  {c.notes && <p className="mt-1 text-xs text-muted-foreground">{c.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {admin && (
        <>
          <Card className="overflow-hidden" data-tour="performance-cycles">
            <SectionHeader title={t('reviewCycles')} count={cycles.length} />
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
                    <th className="px-4 py-2 text-right font-medium">{t('colPendingPay')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {cycles.map((c) => (
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
                      <td className="px-4 py-3 text-right tabular-nums">
                        {c.pendingComp > 0 ? (
                          <span className="font-medium text-amber-600 dark:text-amber-400">{c.pendingComp}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card data-tour="performance-new-cycle">
            <details>
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">{t('newCycle')}</summary>
              <form action={createCycleAction} className="grid grid-cols-1 gap-4 border-t border-border p-4 sm:grid-cols-2">
                <Field label={t('fieldName')}>
                  <input name="name" required className={inputCls} placeholder={t('namePlaceholder')} />
                </Field>
                <Field label={t('fieldScope')}>
                  <select name="companyId" className={inputCls} defaultValue="">
                    <option value="">{t('scopeAllCompanies')}</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('fieldPeriodStart')}>
                  <input name="periodStart" type="date" required defaultValue={`${today.slice(0, 4)}-01-01`} className={inputCls} />
                </Field>
                <Field label={t('fieldPeriodEnd')}>
                  <input name="periodEnd" type="date" required defaultValue={`${today.slice(0, 4)}-12-31`} className={inputCls} />
                </Field>
                <Field label={t('fieldMeritPool')}>
                  <div className="flex gap-2">
                    <select name="meritBudgetKind" className={inputCls} defaultValue="">
                      <option value="">{t('meritNoPool')}</option>
                      <option value="percent">{t('meritPercent')}</option>
                      <option value="amount">{t('meritAmount')}</option>
                    </select>
                    <input name="meritBudgetValue" type="number" step="0.1" min="0" className={`${inputCls} w-28`} placeholder="3.5" />
                  </div>
                </Field>
                <Field label={t('fieldHiredBefore')}>
                  <input name="hiredBefore" type="date" className={inputCls} />
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="excludeProbation" defaultChecked className="size-4" />
                  {t('excludeProbation')}
                </label>
                <div className="sm:col-span-2">
                  <Button type="submit">{t('createCycle')}</Button>
                </div>
              </form>
            </details>
          </Card>
        </>
      )}
    </div>
  );
}
