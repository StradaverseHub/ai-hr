import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, StatusBadge, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { getJob, jobCareersStatus, JOB_MEMBER_ROLES, JOB_STATUS_TRANSITIONS, RecruitmentError, type JobDetail } from '@/packs/recruitment/service';
import { addJobMemberAction, changeJobStatusAction, removeJobMemberAction, setJobCareersPageAction, setJobReferralPortalAction, updateJobAction } from '../../actions';
import { Notice, klDate, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../../shared';
import { JobInfoFields } from '../job-fields';

type Tab = 'info' | 'settings' | 'team';

/**
 * Recruitment › Position: Job info, Job settings and Team, with the status control in the header. Administrators edit;
 * a job-team member sees the job read-only (slice 2).
 */
export default async function RecruitmentPositionPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; error?: string; notice?: string }>;
}) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentViewerAccess(s, scopeIds);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let detail: JobDetail;
  try {
    detail = await getJob(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    throw e;
  }
  const tab: Tab = sp.tab === 'settings' || sp.tab === 'team' ? sp.tab : 'info';
  const [t, status] = await Promise.all([getTranslations('recruitment.job'), getTranslations('recruitment.status')]);
  const { job, options } = detail;
  if (!detail.manage || !options) return <TeamJobView detail={detail} />;
  const here = `/recruitment/positions/${job.id}${tab === 'info' ? '' : `?tab=${tab}`}`;
  // Administrators only (this view is the manage view); a refusal hides the section rather than showing a wrong state.
  const [careers, locale] = tab === 'settings'
    ? await Promise.all([jobCareersStatus(s, job.id).catch((e) => { if (e instanceof RecruitmentError) return null; throw e; }), getLocale()])
    : [null, 'en'];
  const hidden = (name: string, value: string | null | undefined) => <input type="hidden" name={name} value={value ?? ''} />;
  const notice = sp.notice === 'created' ? t('createdNotice') : sp.notice === 'saved' ? t('savedNotice') : undefined;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader
        title={job.title}
        description={<><span className="font-mono">{job.jobNumber}</span> · {detail.companyName} · <StatusBadge status={job.status} label={status(job.status)} /></>}
        back={{ href: '/recruitment/positions', label: t('backToPositions') }}
        actions={[...(job.status !== 'closed' ? [<Link key="cand" href={`/recruitment/candidates?job=${job.id}`} className={btnGhost}>{t('candidates')}</Link>] : []), ...JOB_STATUS_TRANSITIONS[job.status].map((to) => (
          <form key={to} action={changeJobStatusAction}>
            {hidden('jobId', job.id)}{hidden('status', to)}{hidden('returnTo', here)}
            <button type="submit" className={to === 'closed' ? btnGhost : btnPrimary}>{t(`statusAction.${to}`)}</button>
          </form>
        ))]}
      />
      <Notice text={notice} />
      <ErrorBanner message={await recruitmentErrorText(sp.error)} />
      {detail.requisition && (
        <p className="text-sm text-muted-foreground">{t('requisition')}: <Link className="text-primary hover:underline" href={`/recruitment/requisitions/${detail.requisition.id}`}>
          <span className="font-mono">{detail.requisition.reqNumber}</span> · {detail.requisition.title}</Link></p>
      )}
      <nav aria-label={t('sections')} className="flex gap-1 border-b border-border">
        {(['info', 'settings', 'team'] as const).map((key) => (
          <Link key={key} href={`/recruitment/positions/${job.id}${key === 'info' ? '' : `?tab=${key}`}`} aria-current={tab === key ? 'page' : undefined}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {t(`tab.${key}`)}
          </Link>
        ))}
      </nav>

      {tab !== 'team' && (
        <form action={updateJobAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
          {hidden('jobId', job.id)}{hidden('returnTo', here)}
          {tab === 'info' ? (
            <>
              <JobInfoFields options={options} values={job} />
              {hidden('processId', job.processId)}
              {job.autoArchiveAfterReject && hidden('autoArchiveAfterReject', 'on')}
            </>
          ) : (
            <>
              {hidden('title', job.title)}{hidden('description', job.description)}{hidden('workLocation', job.workLocation)}
              {hidden('recruitmentType', job.recruitmentType)}{hidden('employmentType', job.employmentType)}
              {hidden('businessUnitId', job.businessUnitId)}{hidden('departmentId', job.departmentId)}
              {job.jobGradeIds.map((g) => <input key={g} type="hidden" name="jobGradeIds" value={g} />)}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('positionAttribute')}>
                  <p className="text-sm">{t(`positionAttributes.${job.positionAttribute}`)}</p>
                  <span className="text-xs text-muted-foreground">{t('positionAttributeLocked')}</span>
                </Field>
                <Field label={t('process')}>
                  <select name="processId" defaultValue={job.processId} className={selectCls} disabled={detail.hasApplications}>
                    {options.processes.filter((p) => p.enabled || p.id === job.processId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  {detail.hasApplications && <>{hidden('processId', job.processId)}<span className="text-xs text-muted-foreground">{t('processLocked')}</span></>}
                </Field>
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" name="autoArchiveAfterReject" defaultChecked={job.autoArchiveAfterReject} />{t('autoArchive')}
                </label>
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t('pipeline')}</h3>
                <ol className="flex flex-wrap gap-2 text-xs">
                  {detail.stages.map((st) => (
                    <li key={st.stageId} className={cn('rounded-full border border-border px-2 py-1', !st.enabled && 'border-dashed text-muted-foreground')}>
                      {st.name} <span className="tabular-nums">({st.active})</span>{!st.enabled && ` · ${t('stageDisabled')}`}
                    </li>
                  ))}
                  <li className="rounded-full bg-muted px-2 py-1">{t('hired')} <span className="tabular-nums">({detail.hired})</span></li>
                  <li className="rounded-full bg-muted px-2 py-1">{t('archived')} <span className="tabular-nums">({detail.archived})</span></li>
                </ol>
              </div>
            </>
          )}
          <button type="submit" className={btnPrimary}>{t('save')}</button>
        </form>
      )}

      {tab === 'settings' && (
        <form action={setJobReferralPortalAction} className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="referral-portal-title">
          {hidden('jobId', job.id)}{hidden('returnTo', here)}
          <div>
            <h2 id="referral-portal-title" className="text-sm font-semibold">{t('referralPortal.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('referralPortal.note')}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="showOnReferralPortal" defaultChecked={job.showOnReferralPortal} />{t('referralPortal.show')}
          </label>
          {job.showOnReferralPortal && job.status !== 'open' && <p className="text-xs text-muted-foreground">{t('referralPortal.notOpen')}</p>}
          <button type="submit" className={btnGhost}>{t('referralPortal.save')}</button>
        </form>
      )}

      {tab === 'settings' && careers && (
        <form action={setJobCareersPageAction} className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="careers-page-title">
          {hidden('jobId', job.id)}{hidden('returnTo', here)}
          <div>
            <h2 id="careers-page-title" className="text-sm font-semibold">{t('careersPage.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('careersPage.note')}</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="showOnCareersPage" defaultChecked={careers.show} />{t('careersPage.show')}
          </label>
          {careers.show && careers.postedAt && <p className="text-xs text-muted-foreground">{t('careersPage.postedOn', { date: klDate(locale, careers.postedAt) })}</p>}
          {careers.show && !careers.jobOpen && <p className="text-xs text-muted-foreground">{t('careersPage.notOpen')}</p>}
          {careers.show && !careers.sitePublished && <p className="text-xs text-muted-foreground">{t('careersPage.notPublished')}</p>}
          {careers.publicPath && (
            <p className="text-sm"><span className="font-medium">{t('careersPage.publicLink')}:</span>{' '}
              <a href={careers.publicPath} target="_blank" rel="noopener noreferrer" className="break-all text-primary hover:underline">{careers.publicPath}</a></p>
          )}
          <button type="submit" className={btnGhost}>{t('careersPage.save')}</button>
        </form>
      )}

      {tab === 'team' && (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{t('teamNote')}</p>
          {JOB_MEMBER_ROLES.map((role) => {
            const members = detail.members.filter((m) => m.role === role);
            return (
              <div key={role} className="space-y-1">
                <h3 className="text-sm font-semibold">{t(`memberRoles.${role}`)}</h3>
                {members.length === 0 ? <p className="text-sm text-muted-foreground">{t('noMembers')}</p> : (
                  <ul className="flex flex-wrap gap-2">
                    {members.map((m) => (
                      <li key={m.id} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm">
                        {m.name ?? t('unnamedUser')}
                        <form action={removeJobMemberAction}>
                          {hidden('jobId', job.id)}{hidden('memberId', m.id)}{hidden('returnTo', here)}
                          <button type="submit" className="text-xs text-muted-foreground hover:text-destructive" aria-label={t('removeMember', { name: m.name ?? t('unnamedUser') })}>×</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <form action={addJobMemberAction} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            {hidden('jobId', job.id)}{hidden('returnTo', here)}
            <Field label={t('memberRole')}>
              <select name="role" className={selectCls} defaultValue="hiring_manager">
                {JOB_MEMBER_ROLES.map((r) => <option key={r} value={r}>{t(`memberRoles.${r}`)}</option>)}
              </select>
            </Field>
            <Field label={t('member')}>
              <select name="userId" className={selectCls} required defaultValue="">
                <option value="" disabled>{t('choose')}</option>
                {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
            <button type="submit" className={btnPrimary}>{t('addMember')}</button>
          </form>
        </section>
      )}
    </div>
  );
}

/** A job-team member's read-only view of their job: its information and pipeline counts. */
async function TeamJobView({ detail }: { detail: JobDetail }) {
  const [t, status] = await Promise.all([getTranslations('recruitment.job'), getTranslations('recruitment.status')]);
  const { job } = detail;
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader title={job.title} description={<><span className="font-mono">{job.jobNumber}</span> · {detail.companyName} · <StatusBadge status={job.status} label={status(job.status)} /></>}
        back={{ href: '/recruitment/positions', label: t('backToPositions') }}
        actions={<Link href={`/recruitment/candidates?job=${job.id}`} className={btnPrimary}>{t('candidates')}</Link>} />
      <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      <section className="space-y-3 rounded-xl border border-border bg-card p-4 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t('workLocation')}</dt><dd>{job.workLocation}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('employmentType')}</dt><dd>{t(`employmentTypes.${job.employmentType}`)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('recruitmentType')}</dt><dd>{t(`recruitmentTypes.${job.recruitmentType}`)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('positionAttribute')}</dt><dd>{t(`positionAttributes.${job.positionAttribute}`)}</dd></div>
        </dl>
        {job.description && <p className="whitespace-pre-wrap">{job.description}</p>}
      </section>
      <section className="space-y-2 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('pipeline')}</h2>
        <ol className="flex flex-wrap gap-2 text-xs">
          {detail.stages.filter((st) => st.enabled).map((st) => <li key={st.stageId} className="rounded-full border border-border px-2 py-1">{st.name} <span className="tabular-nums">({st.active})</span></li>)}
          <li className="rounded-full bg-muted px-2 py-1">{t('hired')} <span className="tabular-nums">({detail.hired})</span></li>
          <li className="rounded-full bg-muted px-2 py-1">{t('archived')} <span className="tabular-nums">({detail.archived})</span></li>
        </ol>
      </section>
    </div>
  );
}
