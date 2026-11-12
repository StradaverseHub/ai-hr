import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { PageHeader, btnGhost, btnPrimary, tableWrapCls, tbodyCls, thCls, theadCls } from '@/components/ui';
import { INTERVIEW_TYPES, interviewSchedule, type ScheduleRow } from '@/packs/recruitment/service';
import { NoRecruitmentCompany, Pill, RecruitmentTabs, recruitmentViewerAccess, selectCls } from '../shared';

type Search = { job?: string; recruiter?: string; interviewer?: string; type?: string; status?: string };

/**
 * Recruitment › Interviews: the schedule, grouped Today, Upcoming and Recent (last 30 days). Filters: position,
 * recruiter, interviewer and type. A job-team member sees their jobs' interviews; an interviewer sees the ones they
 * interview. Status is derived (Scheduled, In progress, "n/m interview feedback", Cancelled).
 */
export default async function RecruitmentInterviewsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, nav, locale] = await Promise.all([getTranslations('recruitment.iv'), getTranslations('nav'), getLocale()]);
  const schedule = await interviewSchedule(s, access.companies.map((c) => c.id), { jobId: sp.job, recruiterUserId: sp.recruiter, interviewerUserId: sp.interviewer, type: sp.type });
  const rows = sp.status === 'awaiting_feedback' ? schedule.rows.filter((r) => r.status === 'awaiting_feedback') : schedule.rows;
  const time = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(iso));
  const groups = (['today', 'upcoming', 'recent'] as const).map((g) => ({ key: g, rows: rows.filter((r) => r.group === g) }));
  const status = (r: ScheduleRow) => r.status === 'awaiting_feedback' || r.status === 'feedback_complete'
    ? t('feedbackCount', { done: r.submitted, total: r.total }) : t(`status.${r.status}`);
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="interviews" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}  screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      {access.companies.length === 0 ? <NoRecruitmentCompany /> : (
        <>
          <form method="get" className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterPosition')}
              <select name="job" defaultValue={sp.job ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {schedule.jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterRecruiter')}
              <select name="recruiter" defaultValue={sp.recruiter ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {schedule.recruiters.map((r) => <option key={r.id} value={r.id}>{r.name || t('unnamedUser')}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterInterviewer')}
              <select name="interviewer" defaultValue={sp.interviewer ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {schedule.interviewers.map((r) => <option key={r.id} value={r.id}>{r.name || t('unnamedUser')}</option>)}
              </select></label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('type')}
              <select name="type" defaultValue={sp.type ?? ''} className={selectCls}>
                <option value="">{t('any')}</option>
                {INTERVIEW_TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
              </select></label>
            <div className="flex items-end gap-2">
              <button type="submit" className={btnPrimary}>{t('apply')}</button>
              <Link href="/recruitment/interviews" className={btnGhost}>{t('reset')}</Link>
            </div>
          </form>
          {groups.map((g) => (
            <section key={g.key} className="space-y-2" aria-labelledby={`group-${g.key}`}>
              <h2 id={`group-${g.key}`} className="text-sm font-semibold">{t(`groups.${g.key}`, { n: g.rows.length })}</h2>
              {g.rows.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-4 text-sm text-muted-foreground">{t('emptyGroup')}</p> : (
                <div className={tableWrapCls}>
                  <table className="w-full text-sm">
                    <thead className={theadCls}><tr>
                      <th className={thCls}>{t('colDetails')}</th><th className={thCls}>{t('time')}</th><th className={thCls}>{t('colCandidate')}</th>
                      <th className={thCls}>{t('colPosition')}</th><th className={thCls}>{t('site')}</th><th className={thCls}>{t('colRecruiter')}</th><th className={thCls}>{t('colStatus')}</th>
                    </tr></thead>
                    <tbody className={tbodyCls}>
                      {g.rows.map((r) => (
                        <tr key={r.id} className="hover:bg-accent/40">
                          <td className="px-3 py-2">{t('round', { n: r.roundNo })} · {t(`types.${r.type}`)}</td>
                          <td className="px-3 py-2 tabular-nums">{time(r.startsAt)}</td>
                          <td className="px-3 py-2"><Link className="font-medium hover:underline" href={`/recruitment/applications/${r.applicationId}?tab=interviews`}>{r.candidateName}</Link>
                            <div className="text-xs text-muted-foreground">{[r.email, r.phone].filter(Boolean).join(' · ')}</div></td>
                          <td className="px-3 py-2">{r.jobTitle} <span className="font-mono text-xs text-muted-foreground">{r.jobNumber}</span></td>
                          <td className="px-3 py-2">{[r.site, r.meetingRoom].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="px-3 py-2">{r.recruiterName ?? '—'}</td>
                          <td className="px-3 py-2"><Pill tone={r.status === 'awaiting_feedback' ? 'warn' : r.status === 'feedback_complete' ? 'good' : r.status === 'cancelled' ? 'neutral' : 'info'}>{status(r)}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
