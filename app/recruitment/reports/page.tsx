import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { DateField } from '@/components/ui/date-field';
import {
  ReportTooSlowError, recruitmentInterviewsReport, recruitmentOverviewReport, recruitmentPositionsReport, recruitmentTeamReport,
  type InterviewsReport, type OverviewReport, type PositionsReport, type ReportFilterInput, type ReportScope, type TeamReport,
} from '@/packs/recruitment/service';
import { RecruitmentTabs, SubTabs, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../shared';
import { InterviewsView, OverviewView, PositionsView, TeamView } from './views';

type Search = { view?: string; company?: string; job?: string; department?: string; from?: string; to?: string };
const VIEWS = ['overview', 'positions', 'interviews', 'team'] as const;
type View = (typeof VIEWS)[number];
type Loaded =
  | { view: 'overview'; data: OverviewReport } | { view: 'positions'; data: PositionsReport }
  | { view: 'interviews'; data: InterviewsReport } | { view: 'team'; data: TeamReport };

/**
 * Recruitment › Reports (slice 6): four fixed dashboards — Overview, Positions, Interviews and Team — over the companies
 * the viewer administers and, elsewhere, only the jobs where they are the recruiter, an assistant or a hiring manager.
 * An interviewer alone or anyone else is sent away; Team is for administrators only. Every figure is an aggregate the
 * service computes in one read-only snapshot; no candidate's name, contact or restricted value reaches this page.
 * Filters are a plain GET form (company, job, department, period).
 */
export default async function RecruitmentReportsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  if (!access.reportCompanies.length) redirect(access.companies.length ? '/recruitment/candidates' : '/recruitment/approvals');
  const sp = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(sp.view ?? '') ? (sp.view as View) : 'overview';
  if (view === 'team' && !access.isAdmin) redirect('/recruitment/reports');
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.reports'), getTranslations('nav'), getLocale()]);
  const companyIds = access.reportCompanies.map((c) => c.id);
  const input: ReportFilterInput = { companyId: sp.company, jobId: sp.job, departmentId: sp.department, from: sp.from, to: sp.to };
  // ONE run: with `fallback` the service drops a refused filter (period too long or reversed, a job the viewer may not
  // report on, a company out of reach) and says which, so the page shows the message beside the default figures. A
  // dashboard over its time budget comes back as ReportTooSlowError with the filters it had, never as an error page.
  const opts = { fallback: true } as const;
  let loaded: Loaded | null = null;
  let slowScope: ReportScope | null = null;
  try {
    if (view === 'positions') loaded = { view, data: await recruitmentPositionsReport(s, companyIds, input, opts) };
    else if (view === 'interviews') loaded = { view, data: await recruitmentInterviewsReport(s, companyIds, input, opts) };
    else if (view === 'team') loaded = { view, data: await recruitmentTeamReport(s, companyIds, input, opts) };
    else loaded = { view: 'overview', data: await recruitmentOverviewReport(s, companyIds, input, opts) };
  } catch (e) {
    if (!(e instanceof ReportTooSlowError)) throw e;
    slowScope = e.scope;
  }
  const scope: ReportScope | null = loaded?.data.scope ?? slowScope;
  const error = loaded ? loaded.data.scope.refused ?? undefined : 'report_too_slow';
  const keep = (next: Partial<Search>) => {
    const q = new URLSearchParams(Object.entries({
      view: view === 'overview' ? '' : view, company: scope?.companyId ?? sp.company ?? '', job: scope?.jobId ?? sp.job ?? '',
      department: scope?.departmentId ?? sp.department ?? '', from: scope?.period.from ?? sp.from ?? '', to: scope?.period.to ?? sp.to ?? '', ...next,
    }).filter(([, v]) => v));
    return `/recruitment/reports${q.size ? `?${q}` : ''}`;
  };
  const formCompanies = scope?.companies ?? access.reportCompanies;
  const views = VIEWS.filter((v) => v !== 'team' || (scope ? scope.teamAvailable : access.isAdmin));
  const label = 'flex flex-col gap-1.5 text-xs font-medium text-muted-foreground';
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="reports" admin={access.isAdmin} approvals={access.pendingApprovals} reports  screening={access.pendingScreening} />
      <SubTabs label={t('views')} items={views.map((v) => ({ key: v, href: keep({ view: v === 'overview' ? '' : v }), text: t(v), current: v === view }))} />
      <ErrorBanner message={await recruitmentErrorText(error)} />
      <form method="get" aria-label={t('filters')} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-6">
        {view !== 'overview' && <input type="hidden" name="view" value={view} />}
        <label className={label}>{t('company')}
          <select name="company" defaultValue={scope?.companyId ?? sp.company ?? ''} className={selectCls}>
            {formCompanies.length > 1 && <option value="">{t('allCompanies')}</option>}
            {formCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
        <label className={label}>{t('job')}
          <select name="job" defaultValue={scope?.jobId ?? ''} className={selectCls}>
            <option value="">{t('allJobs')}</option>
            {(scope?.jobs ?? []).map((j) => <option key={j.id} value={j.id}>{j.jobNumber} · {j.title}</option>)}
          </select></label>
        <label className={label}>{t('department')}
          <select name="department" defaultValue={scope?.departmentId ?? ''} className={selectCls}>
            <option value="">{t('allDepartments')}</option>
            {(scope?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></label>
        <label className={label}>{t('from')}
          <DateField name="from" defaultValue={scope?.period.from ?? sp.from ?? ''} label={t('from')} className={selectCls} required /></label>
        <label className={label}>{t('to')}
          <DateField name="to" defaultValue={scope?.period.to ?? sp.to ?? ''} label={t('to')} className={selectCls} required /></label>
        <div className="flex items-end gap-2">
          <button type="submit" className={btnPrimary}>{t('apply')}</button>
          <Link href={view === 'overview' ? '/recruitment/reports' : `/recruitment/reports?view=${view}`} className={btnGhost}>{t('reset')}</Link>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-6">
          {t('periodHint')}
          {scope && !scope.adminScope && <> {t('teamScope')}</>}
          {scope?.jobsTruncated && <> {t('jobsTruncated', { count: scope.jobs.length })}</>}
        </p>
      </form>
      {loaded?.view === 'overview' && <OverviewView data={loaded.data} locale={locale} />}
      {loaded?.view === 'positions' && <PositionsView data={loaded.data} locale={locale} />}
      {loaded?.view === 'interviews' && <InterviewsView data={loaded.data} locale={locale} />}
      {loaded?.view === 'team' && <TeamView data={loaded.data} />}
    </div>
  );
}
