import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { isGroupAdmin } from '@/lib/authz';
import { getSession } from '@/lib/session';
import { JOBS, listRecentJobRuns, type JobRunRow } from '@/core/job-run';
import { Card, PageHeader, SectionHeader } from '@/components/ui';
import { Badge } from '@/components/ui/badge';

/** How many past runs a job's expanded panel shows. */
const RECENT = 10;

/**
 * Scheduled actions (0280) — READ-ONLY operator view of the four out-of-band sweeps. Answers the one
 * question nobody could answer without SSHing to the box: "did the overnight work run, and did it work?"
 *
 * Deliberately has no actions.ts, no run-now button, no interval/active controls and no next-run column:
 *   - There is no write path to job_run at all (see migration 0280's header). Its read gate,
 *     app.is_group_admin(), reads the CURRENT SESSION's grants and has no tenant dimension, so any write
 *     gated on the same predicate would let one customer's HR admin forge or erase another's history.
 *   - The schedules are business rules (accrual on the 1st, carry-forward forfeiture just after 31 Mar),
 *     not preferences, and they live in version-controlled systemd units on the host. Next-run belongs to
 *     `systemctl list-timers`; duplicating it here would let the two disagree silently.
 *
 * Gated in-page with getSession() + isGroupAdmin(), matching app/admin/users/page.tsx. The nav row uses
 * the existing adminOnly flag (a delegated admin sees the row and is redirected here), and RLS is the
 * real backstop — a company-scoped hr_admin reading this table gets zero rows regardless of the UI.
 */
export default async function ScheduledActionsPage() {
  const s = await getSession();
  if (!isGroupAdmin(s)) redirect('/');

  const t = await getTranslations('scheduledActions');
  const locale = await getLocale();
  const runs = await listRecentJobRuns(s, RECENT);

  const now = Date.now();
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const number = new Intl.NumberFormat(locale);

  // Relative time via the platform formatter, not message keys: Intl.RelativeTimeFormat already knows
  // every locale's plural rules, so there are no ICU plurals in messages/*.json to keep in parity (the
  // i18n gate checks argument NAMES only and would not catch a missing plural category).
  const ago = (d: Date): string => {
    const secs = Math.round((d.getTime() - now) / 1000);
    const abs = Math.abs(secs);
    if (abs < 60) return relative.format(Math.round(secs), 'second');
    if (abs < 3600) return relative.format(Math.round(secs / 60), 'minute');
    if (abs < 86400) return relative.format(Math.round(secs / 3600), 'hour');
    if (abs < 2592000) return relative.format(Math.round(secs / 86400), 'day');
    if (abs < 31536000) return relative.format(Math.round(secs / 2592000), 'month');
    return relative.format(Math.round(secs / 31536000), 'year');
  };

  // Unit abbreviations, never pluralised — "820 ms" / "1.5 s" / "2.3 min" read the same at every count.
  const duration = (ms: number | null): string => {
    if (ms == null) return '—';
    if (ms < 1000) return `${number.format(ms)} ${t('unitMs')}`;
    if (ms < 60000) return `${number.format(Math.round(ms / 100) / 10) } ${t('unitSeconds')}`;
    return `${number.format(Math.round(ms / 6000) / 10)} ${t('unitMinutes')}`;
  };

  const outcomeVariant = (o: string) => (o === 'success' ? 'success' : o === 'partial' ? 'warning' : 'danger');
  const outcomeLabel = (o: string) => (t.has(`outcome.${o}`) ? t(`outcome.${o}`) : o);

  /**
   * "What it changed", from the jsonb counters. Values are rendered through Intl.NumberFormat and are
   * NEVER coerced to integers — expire-carry reports forfeited DAYS as a float, so 12.5 must
   * not display as 12. An unrecognised counter falls back to its raw key rather than throwing.
   */
  const changed = (result: Record<string, number> | null): string => {
    if (!result) return '—';
    const parts = Object.entries(result)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${t.has(`counters.${k}`) ? t(`counters.${k}`) : k}: ${number.format(v)}`);
    return parts.length ? parts.join(' · ') : '—';
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      <Card className="p-4 text-sm text-muted-foreground">{t('readOnlyNote')}</Card>

      <div className="space-y-3">
        {JOBS.map((job) => {
          const history = runs.filter((r) => r.jobKey === job.key).slice(0, RECENT);
          const last: JobRunRow | undefined = history[0];
          return (
            <Card key={job.key} className="overflow-hidden">
              <details className="group">
                <summary className="cursor-pointer list-none p-4 hover:bg-muted/40">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{t(`jobs.${job.i18nKey}.name`)}</div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{t(`jobs.${job.i18nKey}.description`)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('scheduleLabel')}: {job.schedule}
                      </p>
                    </div>
                    {last ? (
                      <Badge variant={outcomeVariant(last.outcome)}>{outcomeLabel(last.outcome)}</Badge>
                    ) : (
                      <Badge variant="default">{t('neverRun')}</Badge>
                    )}
                  </div>

                  {last ? (
                    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t('colLastRun')}</dt>
                        <dd title={dateTime.format(last.ranAt)}>{ago(last.ranAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t('colDuration')}</dt>
                        <dd>{duration(last.durationMs)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t('colChanged')}</dt>
                        <dd>{changed(last.result)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{t('colTenants')}</dt>
                        <dd>
                          {number.format(last.tenantsProcessed)}
                          {last.tenantsFailed > 0 ? ` (${number.format(last.tenantsFailed)} ${t('failedSuffix')})` : ''}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">{t('emptyJob')}</p>
                  )}

                  {last?.error && (
                    <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-400">
                      {last.error}
                    </p>
                  )}
                </summary>

                <div className="border-t border-border bg-muted/20 px-4 pb-4">
                  <SectionHeader title={t('historyTitle')} count={history.length} />
                  {history.length === 0 ? (
                    <p className="pb-2 text-sm text-muted-foreground">{t('emptyJob')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="py-2 pr-4 font-medium">{t('colRanAt')}</th>
                            <th className="py-2 pr-4 font-medium">{t('colDuration')}</th>
                            <th className="py-2 pr-4 font-medium">{t('colOutcome')}</th>
                            <th className="py-2 pr-4 font-medium">{t('colChanged')}</th>
                            <th className="py-2 font-medium">{t('colError')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((r) => (
                            <tr key={r.id} className="border-t border-border/60 align-top">
                              <td className="py-2 pr-4 whitespace-nowrap">{dateTime.format(r.ranAt)}</td>
                              <td className="py-2 pr-4 whitespace-nowrap">{duration(r.durationMs)}</td>
                              <td className="py-2 pr-4">
                                <Badge variant={outcomeVariant(r.outcome)}>{outcomeLabel(r.outcome)}</Badge>
                              </td>
                              <td className="py-2 pr-4">{changed(r.result)}</td>
                              <td className="py-2 text-muted-foreground">{r.error ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
