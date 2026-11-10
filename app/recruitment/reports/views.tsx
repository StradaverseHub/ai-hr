import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { BarChart } from '@/components/charts/BarChart';
import { tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { SectionCard } from '@/components/ui/section-card';
import { StatCells } from '@/components/ui/stat-cells';
import { cn } from '@/lib/utils';
import {
  NO_VALUE, barPercent, formatDelta, formatNumber, formatPercent,
  type Bucket, type InterviewsReport, type OverviewReport, type PositionsReport, type ReportScope, type TeamReport,
} from '@/packs/recruitment/service';

/**
 * The four Reports dashboards, drawn from the service's aggregates only (server components). Charts are the repository's
 * dependency-free SVG BarChart; every chart has the same figures in a table, and bars in tables are CSS widths beside the
 * number they illustrate (the number is always printed; the bar only reinforces it). A rate with nothing to divide by
 * is "—".
 */
const KL = 'Asia/Kuala_Lumpur';
const dayText = (locale: string, day: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: KL }).format(new Date(`${day}T00:00:00+08:00`));
const shortDay = (locale: string, day: string) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: KL }).format(new Date(`${day}T00:00:00+08:00`));
const monthText = (locale: string, day: string) => new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: KL }).format(new Date(`${day}T00:00:00+08:00`));
const num = (locale: string, n: number) => new Intl.NumberFormat(locale).format(n);
const td = 'px-3 py-2';
const tdNum = 'px-3 py-2 text-right tabular-nums';

function Bar({ value, whole }: { value: number; whole: number }) {
  return (
    <div aria-hidden="true" className="h-2 w-full min-w-16 rounded-full bg-muted">
      <div className="h-2 rounded-full bg-primary" style={{ width: `${barPercent(value, whole)}%` }} />
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{text}</p>;
}
function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className={tableWrapCls}>
      <table className="w-full text-sm"><thead className={theadCls}>{head}</thead><tbody className={tbodyCls}>{children}</tbody></table>
    </div>
  );
}
/** Count + share table with a CSS bar per row. */
function ShareTable({ label, rows, t, locale }: { label: string; rows: { key: string; name: string; count: number }[]; t: (k: 'count' | 'share') => string; locale: string }) {
  const whole = rows.reduce((n, r) => n + r.count, 0);
  return (
    <Table head={<tr><th className={thCls}>{label}</th><th className={cn(thCls, 'text-right')}>{t('count')}</th><th className={cn(thCls, 'w-2/5')}>{t('share')}</th></tr>}>
      {rows.map((r) => (
        <tr key={r.key}>
          <td className={td}>{r.name}</td>
          <td className={tdNum}>{num(locale, r.count)}</td>
          <td className={td}><Bar value={r.count} whole={whole} /></td>
        </tr>
      ))}
    </Table>
  );
}
function JobCell({ jobNumber, title }: { jobNumber: string; title: string }) {
  return <td className={td}><span className="font-medium text-foreground">{title}</span><div className="font-mono text-xs text-muted-foreground">{jobNumber}</div></td>;
}

function bucketLabel(locale: string, scope: ReportScope, b: Bucket): string {
  return scope.granularity === 'month' ? monthText(locale, b.key) : shortDay(locale, b.from);
}

export async function OverviewView({ data, locale }: { data: OverviewReport; locale: string }) {
  const t = await getTranslations('recruitment.reports');
  const req = data.requisitions;
  return (
    <div className="space-y-5">
      <StatCells cells={[
        { label: t('applications'), value: num(locale, data.applications) },
        { label: t('offersCreated'), value: num(locale, data.offersCreated) },
        { label: t('offersSent'), value: num(locale, data.offersSent) },
        { label: t('hired'), value: num(locale, data.hired) },
        { label: t('onboardingNow'), value: num(locale, data.onboardingNow) },
        ...(req ? [
          { label: t('requisitions'), value: num(locale, req.count) },
          { label: t('completionRate'), value: <>{formatPercent(req.completionRate, locale)}<span className="block text-xs font-normal text-muted-foreground">{t('completionDetail', { filled: req.filled, vacancies: req.vacancies })}</span></> },
        ] : []),
      ]} />
      <p className="text-xs text-muted-foreground">
        {t('cohortNote')} {t('dashNote')}
        {!req && data.scope.companies.some((c) => c.admin) && <> {t('requisitionsHidden')}</>}
      </p>
      <SectionCard index={1} title={t('trend')} aside={data.scope.granularity === 'week' ? t('trendWeekly') : t('trendMonthly')}>
        <BarChart id="recruitment-report-trend" ariaLabel={t('trend')} categories={data.trend.map((b) => bucketLabel(locale, data.scope, b))}
          series={[{ label: t('applications'), values: data.trend.map((b) => b.count) }]} />
        <table className="sr-only">
          <caption>{t('trend')}</caption>
          <thead><tr><th>{t('bucket')}</th><th>{t('applications')}</th></tr></thead>
          <tbody>{data.trend.map((b) => <tr key={b.key}><td>{t('bucketRange', { from: dayText(locale, b.from), to: dayText(locale, b.to) })}</td><td>{b.count}</td></tr>)}</tbody>
        </table>
      </SectionCard>
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard index={2} title={t('byStage')} description={t('byStageNote')}>
          {data.byStage.length ? <ShareTable label={t('stage')} t={t} locale={locale} rows={data.byStage.map((r) => ({ key: r.name, name: r.name, count: r.count }))} /> : <Empty text={t('noData')} />}
        </SectionCard>
        <SectionCard index={3} title={t('bySource')}>
          {data.bySource.length ? <ShareTable label={t('source')} t={t} locale={locale} rows={data.bySource.map((r) => ({ key: r.source, name: t(`sources.${r.source}`), count: r.count }))} /> : <Empty text={t('noData')} />}
        </SectionCard>
      </div>
      <SectionCard index={4} title={t('jobProgress')} aside={data.jobsTotal > data.jobs.length ? t('showing', { shown: data.jobs.length, total: data.jobsTotal }) : undefined}>
        {data.jobs.length === 0 ? <Empty text={t('noData')} /> : (
          <Table head={<tr><th className={thCls}>{t('jobColumn')}</th><th className={cn(thCls, 'text-right')}>{t('applications')}</th><th className={cn(thCls, 'text-right')}>{t('interviewed')}</th>
            <th className={cn(thCls, 'text-right')}>{t('offers')}</th><th className={cn(thCls, 'text-right')}>{t('hired')}</th><th className={cn(thCls, 'text-right')}>{t('vacancies')}</th></tr>}>
            {data.jobs.map((j) => (
              <tr key={j.id}>
                <JobCell jobNumber={j.jobNumber} title={j.title} />
                <td className={tdNum}>{num(locale, j.applications)}</td><td className={tdNum}>{num(locale, j.interviewed)}</td>
                <td className={tdNum}>{num(locale, j.offers)}</td>
                <td className={tdNum}>{num(locale, j.hired)}</td>
                <td className={tdNum}>{j.vacancies === null ? NO_VALUE : num(locale, j.vacancies)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SectionCard>
    </div>
  );
}

export async function PositionsView({ data, locale }: { data: PositionsReport; locale: string }) {
  const t = await getTranslations('recruitment.reports');
  const f = data.totals;
  return (
    <div className="space-y-5">
      <StatCells cells={[
        { label: t('applications'), value: num(locale, f.applications) },
        { label: t('interviewed'), value: num(locale, f.interviewed) },
        { label: t('offersCreated'), value: num(locale, f.offersCreated) },
        { label: t('offersSent'), value: num(locale, f.offersSent) },
        { label: t('hired'), value: num(locale, f.hired) },
        { label: t('rejected'), value: num(locale, f.rejected) },
        { label: t('applicationsPerHire'), value: formatNumber(f.applicationsPerHire, locale) },
        { label: t('acceptanceRate'), value: formatPercent(f.acceptanceRate, locale) },
        { label: t('averageDaysToHire'), value: formatNumber(f.averageDaysToHire, locale, 0) },
      ]} />
      <p className="text-xs text-muted-foreground">{t('cohortNote')} {t('dashNote')}</p>
      <SectionCard index={1} title={t('positionsTable')} aside={data.jobsTotal > data.jobs.length ? t('showing', { shown: data.jobs.length, total: data.jobsTotal }) : undefined}>
        {data.jobs.length === 0 ? <Empty text={t('noData')} /> : (
          <Table head={<tr>
            <th className={thCls}>{t('jobColumn')}</th><th className={cn(thCls, 'text-right')}>{t('applications')}</th><th className={cn(thCls, 'text-right')}>{t('interviewed')}</th>
            <th className={cn(thCls, 'text-right')}>{t('offersCreated')}</th><th className={cn(thCls, 'text-right')}>{t('offersSent')}</th><th className={cn(thCls, 'text-right')}>{t('hired')}</th>
            <th className={cn(thCls, 'text-right')}>{t('rejected')}</th><th className={cn(thCls, 'text-right')}>{t('applicationsPerHire')}</th>
            <th className={cn(thCls, 'text-right')}>{t('acceptanceRate')}</th><th className={cn(thCls, 'text-right')}>{t('averageDaysToHire')}</th></tr>}>
            {data.jobs.map((j) => (
              <tr key={j.id}>
                <JobCell jobNumber={j.jobNumber} title={j.title} />
                <td className={tdNum}>{num(locale, j.applications)}</td><td className={tdNum}>{num(locale, j.interviewed)}</td>
                <td className={tdNum}>{num(locale, j.offersCreated)}</td><td className={tdNum}>{num(locale, j.offersSent)}</td>
                <td className={tdNum}>{num(locale, j.hired)}</td><td className={tdNum}>{num(locale, j.rejected)}</td>
                <td className={tdNum}>{formatNumber(j.applicationsPerHire, locale)}</td><td className={tdNum}>{formatPercent(j.acceptanceRate, locale)}</td>
                <td className={tdNum}>{formatNumber(j.averageDaysToHire, locale, 0)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SectionCard>
      {data.jobs.length > 0 && (
        <SectionCard index={2} title={t('funnel')} description={t('funnelNote')}>
          <div className="space-y-2">
            {data.jobs.map((j) => (
              <details key={j.id} open={data.jobs.length === 1} className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">{j.title} <span className="font-mono text-xs text-muted-foreground">{j.jobNumber}</span></summary>
                <ol aria-label={t('funnelOf', { job: j.title })} className="mt-2 space-y-1.5">
                  {[...j.funnel.map((st) => ({ key: st.stageId, name: st.name, count: st.count })), { key: 'hired', name: t('hired'), count: j.hired }].map((st) => (
                    <li key={st.key} className="grid grid-cols-[minmax(8rem,14rem)_3.5rem_1fr] items-center gap-3 text-sm">
                      <span className="[overflow-wrap:anywhere]">{st.name}</span>
                      <span className="text-right tabular-nums">{num(locale, st.count)}</span>
                      <Bar value={st.count} whole={j.applications} />
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

export async function InterviewsView({ data, locale }: { data: InterviewsReport; locale: string }) {
  const t = await getTranslations('recruitment.reports');
  const resultRows = [
    { key: 'recommended', name: t('resultLabels.recommended'), count: data.results.recommended },
    { key: 'keepInView', name: t('resultLabels.keepInView'), count: data.results.keepInView },
    { key: 'notSuitable', name: t('resultLabels.notSuitable'), count: data.results.notSuitable },
    ...(data.results.noResult ? [{ key: 'noResult', name: t('resultLabels.noResult'), count: data.results.noResult }] : []),
  ];
  return (
    <div className="space-y-5">
      <StatCells cells={[
        { label: t('held'), value: <>{num(locale, data.held)}<span className="block text-xs font-normal text-muted-foreground">{t('changeVsPrevious', {
          delta: `${formatDelta(data.change.delta, locale)}${data.change.rate === null ? '' : ` (${formatPercent(data.change.rate, locale)})`}`,
          previous: data.previousHeld, from: dayText(locale, data.previousPeriod.from), to: dayText(locale, data.previousPeriod.to),
        })}</span></> },
        { label: t('feedbackRate'), value: <>{formatPercent(data.feedbackRate, locale)}<span className="block text-xs font-normal text-muted-foreground">{t('feedbackDetail', { submitted: data.submitted, places: data.places })}</span></> },
        { label: t('pendingFeedback'), value: num(locale, data.pendingFeedback), warn: data.pendingFeedback > 0 },
        { label: t('upcoming'), value: <>{num(locale, data.upcoming)}<span className="block text-xs font-normal text-muted-foreground">{t('upcomingNote')}</span></> },
        { label: t('passRate'), value: <>{formatPercent(data.passRate, locale)}<span className="block text-xs font-normal text-muted-foreground">{t('passDetail', { passed: data.passed, decided: data.withOutcome })}</span></> },
      ]} />
      <p className="text-xs text-muted-foreground">{t('interviewsNote')} {t('dashNote')}</p>
      <SectionCard index={1} title={t('results')}>
        {resultRows.some((r) => r.count > 0) ? <ShareTable label={t('result')} t={t} locale={locale} rows={resultRows} /> : <Empty text={t('noData')} />}
      </SectionCard>
    </div>
  );
}

export async function TeamView({ data }: { data: TeamReport }) {
  const t = await getTranslations('recruitment.reports');
  return (
    <SectionCard index={1} title={t('team')} description={`${t('teamNote')} ${t('teamCredit')}`}
      aside={data.rowsTotal > data.rows.length ? t('showingRecruiters', { shown: data.rows.length, total: data.rowsTotal }) : undefined}>
      {data.rows.length === 0 ? <Empty text={t('noData')} /> : (
        <Table head={<tr><th className={thCls}>{t('recruiter')}</th><th className={cn(thCls, 'text-right')}>{t('jobs')}</th><th className={cn(thCls, 'text-right')}>{t('moved')}</th>
          <th className={cn(thCls, 'text-right')}>{t('interviewsScheduled')}</th><th className={cn(thCls, 'text-right')}>{t('offersCreated')}</th><th className={cn(thCls, 'text-right')}>{t('hires')}</th></tr>}>
          {data.rows.map((r) => (
            <tr key={r.recruiterUserId ?? 'none'}>
              <td className={td}>{r.recruiterUserId ? r.recruiterName ?? NO_VALUE : <span className="text-muted-foreground">{t('noRecruiter')}</span>}</td>
              <td className={tdNum}>{r.jobs}</td><td className={tdNum}>{r.movedFromFirstStage}</td><td className={tdNum}>{r.interviewsScheduled}</td>
              <td className={tdNum}>{r.offersCreated}</td><td className={tdNum}>{r.hires}</td>
            </tr>
          ))}
        </Table>
      )}
    </SectionCard>
  );
}
