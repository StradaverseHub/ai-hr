import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, StatusBadge, btnGhost, btnPrimary } from '@/components/ui';
import { getRequisition, requisitionFormOptions, RecruitmentError, type RequisitionDetail } from '@/packs/recruitment/service';
import {
  associateJobAction, changeRequisitionStatusAction, dissociateJobAction, submitRequisitionAction, updateRequisitionAction, withdrawRequisitionAction,
} from '../../actions';
import { Notice, Pill, klDateTime, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../../shared';
import { RequisitionFields } from '../requisition-fields';

/**
 * Recruitment › Job requisition. Administrators edit it, submit it for approval, move its status along the allowed
 * moves, associate jobs (many jobs to one requisition) and create a job from it. The vacancy table is two count
 * queries; a negative shows as 0 with an over-filled warning. An approver sees it read-only and decides on the
 * Approvals page.
 */
export default async function RequisitionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string; fields?: string }> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  await recruitmentViewerAccess(s, scopeIds);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let d: RequisitionDetail;
  try {
    d = await getRequisition(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError) notFound();
    throw e;
  }
  const [t, locale] = await Promise.all([getTranslations('recruitment.req'), getLocale()]);
  const r = d.requisition;
  const options = d.manage ? await requisitionFormOptions(s, r.companyId) : null;
  const here = `/recruitment/requisitions/${r.id}`;
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const terminal = r.status === 'completed' || r.status === 'cancelled';
  const error = await recruitmentErrorText(sp.error);
  const fields = (sp.fields ?? '').split(',').filter(Boolean);
  const notice = sp.notice === 'created' ? t('createdNotice') : sp.notice === 'saved' ? t('savedNotice') : undefined;
  const person = (uid: string | null) => (uid ? d.names[uid] ?? t('unnamedUser') : '—');
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader title={r.title} back={{ href: d.manage ? '/recruitment/requisitions' : '/recruitment/approvals', label: d.manage ? t('back') : t('backToApprovals') }}
        description={<><span className="font-mono">{r.reqNumber}</span> · {d.companyName} · <StatusBadge status={d.status} label={t(`status.${d.status}`)} />
          {r.approvalStatus !== 'not_submitted' && <> · {t(`approvalStatus.${r.approvalStatus}`)}</>}</>}
        actions={d.manage ? [
          ...(d.canSubmit ? [<form key="submit" action={submitRequisitionAction}>{hidden('requisitionId', r.id)}{hidden('returnTo', here)}<button type="submit" className={btnPrimary}>{t('submit')}</button></form>] : []),
          ...(d.canWithdraw ? [<form key="withdraw" action={withdrawRequisitionAction}>{hidden('requisitionId', r.id)}{hidden('returnTo', here)}<button type="submit" className={btnGhost}>{t('withdraw')}</button></form>] : []),
          ...d.moves.map((to) => (
            <form key={to} action={changeRequisitionStatusAction}>{hidden('requisitionId', r.id)}{hidden('status', to)}{hidden('returnTo', here)}
              <button type="submit" className={to === 'completed' || to === 'cancelled' ? btnGhost : btnPrimary}>{t(`moveTo.${to}`)}</button></form>
          )),
          ...(!terminal ? [<Link key="job" href={`/recruitment/positions/new?requisition=${r.id}`} className={btnGhost}>{t('createJob')}</Link>] : []),
        ] : undefined} />
      <Notice text={notice} />
      <ErrorBanner message={error && fields.length ? `${error} ${fields.filter((f) => t.has(`fieldNames.${f}`)).map((f) => t(`fieldNames.${f}`)).join(', ')}` : error} />
      {terminal && <p className="text-sm text-muted-foreground">{t('terminalNote')}</p>}

      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('vacancyTitle')}</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          <div><dt className="text-xs text-muted-foreground">{t('vacancies')}</dt><dd className="text-lg font-semibold tabular-nums">{d.vacancy.vacancies}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('onboarded')}</dt><dd className="text-lg font-semibold tabular-nums">{d.vacancy.onboarded}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('offersInProcess')}</dt><dd className="text-lg font-semibold tabular-nums">{d.vacancy.offersInProcess}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('remainingOffers')}</dt><dd className="text-lg font-semibold tabular-nums">{d.vacancy.shownOffers}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('remainingOnboarding')}</dt><dd className="text-lg font-semibold tabular-nums">{d.vacancy.shownOnboarding}</dd></div>
        </dl>
        {d.vacancy.overFilled && <p className="text-sm text-amber-700 dark:text-amber-400">{t('overFilledNote')}</p>}
        <p className="text-xs text-muted-foreground">{t('vacancyNote')}</p>
      </section>

      {d.steps.length > 0 && (
        <section className="space-y-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('approvalTitle', { round: r.approvalRound })}</h2>
          <ol className="space-y-1 text-sm">
            {d.steps.map((st) => (
              <li key={st.position} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-muted-foreground">{st.position}.</span><span>{st.approverName ?? t('unnamedUser')}</span>
                <Pill tone={st.state === 'approved' ? 'good' : st.state === 'rejected' ? 'bad' : st.state === 'pending' ? 'warn' : 'neutral'}>{t(`steps.${st.state}`)}</Pill>
                {st.actedAt && <span className="text-xs text-muted-foreground">{klDateTime(locale, st.actedAt)}</span>}
                {st.comment && <span className="text-xs text-muted-foreground">“{st.comment}”</span>}
              </li>
            ))}
          </ol>
          {d.canDecide && <Link href="/recruitment/approvals" className="text-sm text-primary hover:underline">{t('decideInApprovals')}</Link>}
        </section>
      )}

      {d.manage && (
        <section className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('jobsTitle')}</h2>
          {d.jobs.length === 0 ? <p className="text-sm text-muted-foreground">{t('noJobs')}</p> : (
            <ul className="divide-y divide-border text-sm">
              {d.jobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/recruitment/positions/${j.id}`} className="hover:underline">{j.title} <span className="font-mono text-xs text-muted-foreground">{j.jobNumber}</span></Link>
                  <span className="flex items-center gap-3 text-xs text-muted-foreground">{t('jobFigures', { candidates: j.candidates, hired: j.hired })}
                    {!terminal && <form action={dissociateJobAction}>{hidden('requisitionId', r.id)}{hidden('jobId', j.id)}{hidden('returnTo', here)}
                      <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">{t('dissociate')}</button></form>}</span>
                </li>
              ))}
            </ul>
          )}
          {!terminal && d.linkableJobs.length > 0 && (
            <form action={associateJobAction} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              {hidden('requisitionId', r.id)}{hidden('returnTo', here)}
              <Field label={t('associateJob')} className="min-w-64">
                <select name="jobId" required defaultValue="" className={selectCls}>
                  <option value="" disabled>{t('choose')}</option>
                  {d.linkableJobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
                </select>
              </Field>
              <button type="submit" className={btnGhost}>{t('associate')}</button>
            </form>
          )}
        </section>
      )}

      {d.manage && options && !terminal ? (
        <form action={updateRequisitionAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
          {hidden('requisitionId', r.id)}{hidden('companyId', r.companyId)}{hidden('returnTo', here)}
          <h2 className="text-sm font-semibold">{t('detailsSection')}</h2>
          <RequisitionFields options={options} values={r as unknown as Record<string, string | number | string[] | null>} />
          {r.status !== 'draft' && <p className="text-xs text-muted-foreground">{t('reapprovalNote')}</p>}
          <button type="submit" className={btnPrimary}>{t('save')}</button>
        </form>
      ) : (
        <section className="rounded-xl border border-border bg-card p-4 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">{t('vacancies')}</dt><dd>{r.vacancies}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('hiringManager')}</dt><dd>{person(r.hiringManagerUserId)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('targetOnboardDate')}</dt><dd>{r.targetOnboardDate ?? '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">{t('salaryRange')}</dt><dd>{r.salaryMin || r.salaryMax ? `${r.salaryCurrency ?? ''} ${r.salaryMin ?? '…'} – ${r.salaryMax ?? '…'}` : '—'}</dd></div>
          </dl>
          {r.description && <p className="mt-3 whitespace-pre-wrap">{r.description}</p>}
        </section>
      )}
    </div>
  );
}
