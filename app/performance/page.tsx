import {PerformanceOverview} from './onehr/overview';
import {PerformanceAdminAssistant} from './onehr/admin-assistant';
import {PerformanceGuideReportPanel} from './onehr/guide-report';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { canManagePerfComp, isAdmin, isOnehrOnlyPerformanceAdmin, requireModule } from '@/lib/authz';
import { hasAssignedPerformanceWork, hasLedPeople, onehrAssignments } from '@/packs/performance/service';
import { listCompanies } from '@/core/read';
import { listCycles, listOnehrAdminCompanyIds, listOnehrAdminCycles, managerCheckIns, managerPendingReviews, type OnehrAdminCycleSummary } from '@/core/performance';
import { Button, Card, EmployeeCode, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
import {
  cancelCheckInAction,
  completeCheckInAction,
  scheduleCheckInAction,
} from './actions';
import { PerformanceCyclesAdmin } from './onehr/admin-cycles';
import { paginateRows, parsePageQuery } from '@/lib/pagination';

import { todayInKualaLumpur } from '@/lib/hr-date';

export default async function PerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; page?: string; size?: string }>;
}) {
  // ADR-0077 slice 4 — a courtesy redirect when the tenant has not bought this module, so they get
  // an explanation instead of the service error. NOT the control: the reads below refuse on their
  // own (D3), and this guard fails open on an unresolved snapshot. Applied at the module ENTRY
  // point; a deep link skips it and meets the service refusal, which is the correct outcome.
  await requireModule('performance');
  const { s,scopeIds } = await scopedSession();
  const t = await getTranslations('performance.list');
  const admin = isAdmin(s) || canManagePerfComp(s);
  // ADR-0142 — a session whose only performance authority is the OneHR performance partner administers
  // OneHR-native cycles: it sees those cycles and the OneHR panels, never generic cycles, pending pay or
  // the new-cycle form (cycle creation stays with HR).
  const onehrOnly = isOnehrOnlyPerformanceAdmin(s);
  const performanceAdmin = admin || onehrOnly;
  const manager = (s.roles ?? []).includes('manager');
  // D-P1-03 — a person named on performance work (a reviewer, moderator, plan reviewer or calibration reviewer)
  // gets tasks that land here, whatever their platform role. The bell's own projection decides who that is;
  // reaching the page grants nothing (ADR-0132): every read below is fenced by its own service and RLS.
  // WP-E — a leader (HOD, BU CEO, BG CEO or group chief seat) reaches "What you led" from here.
  const leads = await hasLedPeople(s);
  if (!performanceAdmin && !manager && !leads && !(await hasAssignedPerformanceWork(s, scopeIds))) redirect('/');
  const sp = await searchParams;
  const { error } = sp;
  const today = todayInKualaLumpur();

  const [cycles, pending, companies, checkinData, onehr] = await Promise.all([
    (admin ? listCycles(s) : onehrOnly ? listOnehrAdminCycles(s) : Promise.resolve([])) as Promise<(OnehrAdminCycleSummary & { pendingComp?: number })[]>,
    managerPendingReviews(s),
    admin ? listCompanies(s) : onehrOnly ? Promise.all([listCompanies(s), listOnehrAdminCompanyIds(s)]).then(([rows, ids]) => rows.filter((c) => ids.has(c.id))) : Promise.resolve([]),
    managerCheckIns(s),
    onehrAssignments(s),
  ]);
  const to=await getTranslations('onehr');
  const { checkins, reports } = checkinData;
  // fc776376 — review cycles accumulate every period; the rest of this screen is a fixed worklist.
  const { rows: cyclePage, state: pgState } = paginateRows(cycles, parsePageQuery(sp));
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
      {performanceAdmin&&<PerformanceAdminAssistant/>}
      {performanceAdmin&&<PerformanceOverview session={s}/>}
      {performanceAdmin&&<PerformanceGuideReportPanel companies={companies.map(c=>({id:c.id,name:c.name}))}/>}
      <Link href="/performance/workspace" className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-primary bg-primary/5 px-5 py-4 font-medium text-primary">{to('workspace.title')}<span className="text-sm font-normal">{to('workspace.description')} →</span></Link>
      {leads&&<Link href="/performance/led" className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg border border-border px-5 py-4 font-medium text-primary">{to('led.link')}<span className="text-sm font-normal">{to('led.linkHelp')} →</span></Link>}
      {(onehr.reviews.length>0||onehr.sessions.length>0)&&<Card className="space-y-3 p-5"><h2 className="font-semibold">{to('assignments')}</h2>{onehr.reviews.map(r=><p key={r.id}><Link className="text-primary hover:underline" href={`/performance/review/${r.id}`}>{r.name} · {r.cycle} · {r.periodEnd}</Link></p>)}{onehr.sessions.map(c=><p key={c.id}><Link className="text-primary hover:underline" href={`/performance/assessment/calibration/${c.id}`}>{c.name}</Link></p>)}</Card>}

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
                  {/* Employee ID left-of-name (feedback 38668d9b) */}
                  {r.employeeCode && <EmployeeCode code={r.employeeCode} className="mr-1.5" />}
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

      {performanceAdmin && <PerformanceCyclesAdmin cycles={cycles} rows={cyclePage} pgState={pgState} basePath="/performance" admin={admin} companies={companies.filter(c=>scopeIds.includes(c.id))} today={today} />}
    </div>
  );
}
