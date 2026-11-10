import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, Input, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  applicationHire, applicationHistory, applicationInterviews, applicationOffer, interviewFormOptions, CANDIDATE_RESPONSES, INTERVIEW_TYPES,
  OFFER_SEND_CHANNELS, RecruitmentError, type ApplicationHire, type InterviewFormOptions, type InterviewStatus, type OfferView,
} from '@/packs/recruitment/service';
import {
  cancelInterviewAction, markOfferSentAction, recordOfferDecisionAction, saveOfferAction, scheduleInterviewAction, setCandidateResponseAction,
  submitOfferAction, withdrawOfferAction,
} from '../../actions';
import { Notice, Pill, SubTabs, klDate, klDateTime, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../../shared';

type Tab = 'interviews' | 'offer' | 'history';
const STATUS_TONE: Record<InterviewStatus, 'neutral' | 'info' | 'good' | 'warn' | 'bad'> = {
  scheduled: 'info', in_progress: 'info', awaiting_feedback: 'warn', feedback_complete: 'good', cancelled: 'neutral',
};

/**
 * Recruitment › Application. Interview tab (schedule; per interviewer "Not evaluated" with "Add feedback" for that
 * interviewer only, or the result with "See scorecard"), Offer tab (fields, approval, Mark as sent, the candidate's
 * decision) and History. Readers: the job's reviewers and administrators, and the application's interviewers (who see
 * the Interview tab only). The hire hand-off appears once the application is at Onboarding or hired.
 */
export default async function RecruitmentApplicationPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; error?: string; notice?: string; fields?: string }>;
}) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let interviews;
  try {
    interviews = await applicationInterviews(s, id);
  } catch (e) {
    if (e instanceof RecruitmentError && (e.code === 'not_found' || e.code === 'forbidden')) notFound();
    throw e;
  }
  const soft = async <T,>(work: Promise<T>): Promise<T | null> => work.catch((e) => { if (e instanceof RecruitmentError) return null; throw e; });
  const [offer, history, hire, options] = await Promise.all([
    soft(applicationOffer(s, id)), soft(applicationHistory(s, id)), soft(applicationHire(s, id)),
    interviews.canSchedule ? soft(interviewFormOptions(s, id)) : Promise.resolve(null),
  ]);
  const reviewer = !!offer;
  const tab: Tab = sp.tab === 'offer' && reviewer ? 'offer' : sp.tab === 'history' && history ? 'history' : 'interviews';
  const [t, locale] = await Promise.all([getTranslations('recruitment'), getLocale()]);
  const here = `/recruitment/applications/${id}?tab=${tab}`;
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const stateText = interviews.state === 'active' ? interviews.stageName : interviews.state === 'hired' ? t('candidates.hired') : t('candidates.archivedFrom', { stage: interviews.stageName });
  const errorText = await recruitmentErrorText(sp.error);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <PageHeader title={interviews.candidateName} description={<>{interviews.jobTitle} · {stateText}</>}
        back={{ href: '/recruitment/candidates', label: t('app.back') }} />
      <Notice text={sp.notice === 'saved' ? t('candidates.savedNotice') : undefined} />
      <ErrorBanner message={errorText} />
      {hire && <HireSection hire={hire} applicationId={id} t={t} locale={locale} />}
      <SubTabs label={t('app.sections')} items={[
        { key: 'interviews', href: `/recruitment/applications/${id}?tab=interviews`, text: t('app.tabInterviews'), current: tab === 'interviews' },
        ...(reviewer ? [{ key: 'offer', href: `/recruitment/applications/${id}?tab=offer`, text: t('app.tabOffer'), current: tab === 'offer' }] : []),
        ...(history ? [{ key: 'history', href: `/recruitment/applications/${id}?tab=history`, text: t('app.tabHistory'), current: tab === 'history' }] : []),
      ]} />

      {tab === 'interviews' && (
        <div className="space-y-4">
          {interviews.interviews.length === 0 && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('iv.none')}</p>}
          <ul className="space-y-3">
            {interviews.interviews.map((iv) => (
              <li key={iv.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{t('iv.round', { n: iv.roundNo })} · {t(`iv.types.${iv.type}`)}</p>
                  <Pill tone={STATUS_TONE[iv.status]}>{iv.status === 'feedback_complete' || iv.status === 'awaiting_feedback' ? t('iv.feedbackCount', { done: iv.submitted, total: iv.total }) : t(`iv.status.${iv.status}`)}</Pill>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div><dt className="text-xs text-muted-foreground">{t('iv.time')}</dt><dd>{klDateTime(locale, iv.startsAt)} · {t('iv.minutes', { n: iv.durationMinutes })}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t('iv.site')}</dt><dd>{[iv.site, iv.meetingRoom].filter(Boolean).join(' · ') || '—'}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">{t('iv.response')}</dt><dd>{t(`iv.responses.${iv.candidateResponse}`)}</dd></div>
                </dl>
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {iv.interviewers.map((v) => (
                    <li key={v.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span>{v.name ?? t('job.unnamedUser')}{v.isViewer && <span className="ml-1 text-xs text-muted-foreground">({t('iv.you')})</span>}</span>
                      <span className="flex items-center gap-2">
                        {v.submitted ? (
                          <>
                            {v.result && <Pill tone={v.result === 'recommended' ? 'good' : v.result === 'not_suitable' ? 'bad' : 'neutral'}>{t(`fb.results.${v.result}`)}</Pill>}
                            {v.visible && v.scorecardId && <Link className="text-primary hover:underline" href={`/recruitment/scorecards/${v.scorecardId}`}>{t('iv.seeScorecard')}</Link>}
                            {v.isViewer && iv.canEditFeedback && <Link className="text-primary hover:underline" href={`/recruitment/interviews/${iv.id}/feedback`}>{t('iv.editFeedback')}</Link>}
                          </>
                        ) : (
                          <>
                            <span className="text-muted-foreground">{t('iv.notEvaluated')}</span>
                            {v.isViewer && iv.canAddFeedback && <Link className={btnPrimary} href={`/recruitment/interviews/${iv.id}/feedback`}>{t('iv.addFeedback')}</Link>}
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                {interviews.canSchedule && !iv.cancelled && (
                  <div className="flex flex-wrap items-center gap-2">
                    <form action={setCandidateResponseAction} className="flex items-center gap-1">
                      {hidden('interviewId', iv.id)}{hidden('applicationId', id)}{hidden('returnTo', here)}
                      <label className="sr-only" htmlFor={`resp-${iv.id}`}>{t('iv.response')}</label>
                      <select id={`resp-${iv.id}`} name="response" defaultValue={iv.candidateResponse} className={cn(selectCls, 'h-9 w-40')}>
                        {CANDIDATE_RESPONSES.map((r) => <option key={r} value={r}>{t(`iv.responses.${r}`)}</option>)}
                      </select>
                      <button type="submit" className={btnGhost}>{t('iv.saveResponse')}</button>
                    </form>
                    <form action={cancelInterviewAction}>
                      {hidden('interviewId', iv.id)}{hidden('applicationId', id)}{hidden('returnTo', here)}
                      <button type="submit" className={btnGhost}>{t('iv.cancel')}</button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {options && <ScheduleForm options={options} t={t} />}
        </div>
      )}

      {tab === 'offer' && offer && <OfferSection offer={offer} applicationId={id} here={here} t={t} locale={locale} />}

      {tab === 'history' && history && (
        <ol className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
          {history.map((h) => (
            <li key={h.id} className="border-l-2 border-border pl-3">
              <p>{h.kind === 'applied' ? t('candidates.event.applied', { stage: h.toStage ?? '' })
                : h.kind === 'moved' ? t('candidates.event.moved', { from: h.fromStage ?? '', to: h.toStage ?? '' })
                  : h.kind === 'hired' ? t('candidates.event.hired', { from: h.fromStage ?? '' })
                    : t('candidates.event.rejected', { from: h.fromStage ?? '', reason: h.reason ?? '' })}</p>
              <p className="text-xs text-muted-foreground">{h.actorName ?? t('candidates.unnamedUser')} · {klDateTime(locale, h.occurredAt)}</p>
            </li>
          ))}
        </ol>
      )}
      {!access.isAdmin && <p className="text-xs text-muted-foreground">{t('app.teamNote')}</p>}
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<'recruitment'>>>;

function ScheduleForm({ options, t }: { options: InterviewFormOptions; t: T }) {
  return (
    <form action={scheduleInterviewAction} className="space-y-4 rounded-xl border border-border bg-card p-4">
      <input type="hidden" name="applicationId" value={options.applicationId} />
      <h2 className="text-sm font-semibold">{t('iv.addTitle')} <span className="font-normal text-muted-foreground">· {options.stageName}</span></h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('iv.roundLabel')}>
          <select name="roundNo" className={selectCls} defaultValue={String(options.rounds[0] ?? 1)}>
            {options.rounds.map((n) => <option key={n} value={n}>{t('iv.round', { n })}</option>)}
          </select>
        </Field>
        <Field label={t('iv.type')} required requiredAriaLabel={t('job.required')}>
          <select name="type" className={selectCls} defaultValue="onsite" required>
            {INTERVIEW_TYPES.map((v) => <option key={v} value={v}>{t(`iv.types.${v}`)}</option>)}
          </select>
        </Field>
        <Field label={t('iv.form')}>
          <select name="formId" className={selectCls} defaultValue="">
            {options.forms.map((f) => <option key={f.id} value={f.isDefault ? '' : f.id}>{f.name}</option>)}
          </select>
        </Field>
        <Field label={t('iv.startsAt')} required requiredAriaLabel={t('job.required')}>
          <Input name="startsAt" type="datetime-local" required />
        </Field>
        <Field label={t('iv.duration')}>
          <Input name="durationMinutes" type="number" min={5} max={720} step={5} defaultValue={60} />
        </Field>
        <Field label={t('iv.site')}><Input name="site" maxLength={200} /></Field>
        <Field label={t('iv.room')}><Input name="meetingRoom" maxLength={120} /></Field>
        <Field label={t('iv.interviewers')} required requiredAriaLabel={t('job.required')} className="sm:col-span-2">
          <select name="interviewerIds" multiple required size={Math.min(6, Math.max(3, options.users.length))} className={cn(selectCls, 'h-auto')}>
            {options.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">{t('iv.interviewersHint')}</span>
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('iv.timeZoneNote')}</p>
      <button type="submit" className={btnPrimary}>{t('iv.schedule')}</button>
    </form>
  );
}

function OfferSection({ offer, applicationId, here, t, locale }: { offer: OfferView; applicationId: string; here: string; t: T; locale: string }) {
  const o = offer.offer;
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const labelTone = !o ? 'neutral' : o.label === 'accepted' || o.label === 'approved' ? 'good' : o.label === 'declined' || o.label === 'expired' ? 'bad' : o.label === 'pending' ? 'warn' : 'info';
  const shown = (f: OfferView['fields'][number]) => f.hidden ? t('offer.privateHidden') : !f.value ? '—'
    : f.value.kind === 'money' ? `${f.value.currency} ${f.value.amount}` : f.value.kind === 'number' ? f.value.number : f.value.kind === 'date' ? klDate(locale, `${f.value.date}T00:00:00+08:00`) : f.value.text;
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t('offer.title')}</h2>
          <Pill tone={labelTone}>{o ? t(`offer.labels.${o.label}`) : t('offer.none')}</Pill>
        </div>
        {o && (
          <p className="text-xs text-muted-foreground">
            {t('offer.createdBy', { name: o.createdBy ?? t('job.unnamedUser') })}
            {o.sentAt && <> · {t('offer.sentOn', { date: klDateTime(locale, o.sentAt), channel: t(`offer.channels.${o.sentChannel ?? 'other'}`) })}</>}
            {o.expiresOn && <> · {t('offer.expires', { date: klDate(locale, `${o.expiresOn}T00:00:00+08:00`) })}</>}
          </p>
        )}
        {o?.lastRejectionComment && o.status === 'draft' && <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t('offer.rejectedWith', { comment: o.lastRejectionComment })}</p>}
        {offer.can.edit ? (
          <form action={saveOfferAction} className="space-y-4">
            {hidden('applicationId', applicationId)}{hidden('returnTo', here)}
            <div className="grid gap-4 sm:grid-cols-2">
              {offer.fields.map((f) => (
                <Field key={f.id} label={`${f.label}${f.private ? ` · ${t('offer.private')}` : ''}${f.needsApproval ? ` · ${t('offer.needsApproval')}` : ''}`} required={f.required && !f.hidden} requiredAriaLabel={t('job.required')}>
                  {f.hidden ? <p className="text-sm text-muted-foreground">{t('offer.privateHidden')}</p>
                    : f.type === 'money' ? (
                      <div className="flex gap-2">
                        <Input name={`currency:${f.id}`} defaultValue={f.value?.kind === 'money' ? f.value.currency : 'MYR'} maxLength={3} className="w-20 uppercase" aria-label={t('offer.currency')} />
                        <Input name={`amount:${f.id}`} inputMode="decimal" defaultValue={f.value?.kind === 'money' ? f.value.amount : ''} aria-label={t('offer.amount')} />
                      </div>
                    ) : f.type === 'single_choice' ? (
                      <select name={`text:${f.id}`} className={selectCls} defaultValue={f.value?.kind === 'text' ? f.value.text : ''}>
                        <option value="">{t('job.choose')}</option>
                        {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <Input name={`text:${f.id}`} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined}
                        defaultValue={f.value ? (f.value.kind === 'text' ? f.value.text : f.value.kind === 'number' ? f.value.number : f.value.kind === 'date' ? f.value.date : '') : ''} />
                    )}
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('offer.peopleEnterPay')}</p>
            <button type="submit" className={btnPrimary}>{o ? t('offer.save') : t('offer.create')}</button>
          </form>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {offer.fields.map((f) => <div key={f.id}><dt className="text-xs text-muted-foreground">{f.label}</dt><dd>{shown(f)}</dd></div>)}
          </dl>
        )}
      </section>

      {o && offer.steps.length > 0 && (
        <section className="space-y-2 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('offer.approval', { round: o.round })}</h2>
          <ol className="space-y-1 text-sm">
            {offer.steps.map((st) => (
              <li key={st.position} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-muted-foreground">{st.position}.</span>
                <span>{st.approverName ?? t('job.unnamedUser')}</span>
                <Pill tone={st.state === 'approved' ? 'good' : st.state === 'rejected' ? 'bad' : st.state === 'pending' ? 'warn' : 'neutral'}>{t(`offer.steps.${st.state}`)}</Pill>
                {st.comment && <span className="text-xs text-muted-foreground">“{st.comment}”</span>}
              </li>
            ))}
          </ol>
          {offer.can.decide && <Link href="/recruitment/approvals" className="text-sm text-primary hover:underline">{t('offer.decideInApprovals')}</Link>}
        </section>
      )}

      {o && (offer.can.submit || offer.can.withdraw || offer.can.markSent || offer.can.recordDecision) && (
        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
          {offer.can.submit && (
            <form action={submitOfferAction}>{hidden('offerId', o.id)}{hidden('applicationId', applicationId)}{hidden('returnTo', here)}
              <button type="submit" className={btnPrimary}>{t('offer.submit')}</button></form>
          )}
          {offer.can.withdraw && (
            <form action={withdrawOfferAction}>{hidden('offerId', o.id)}{hidden('applicationId', applicationId)}{hidden('returnTo', here)}
              <button type="submit" className={btnGhost}>{t('offer.withdraw')}</button></form>
          )}
          {offer.can.markSent && (
            <form action={markOfferSentAction} className="flex items-end gap-2">{hidden('offerId', o.id)}{hidden('applicationId', applicationId)}{hidden('returnTo', here)}
              <Field label={t('offer.channel')}>
                <select name="channel" className={cn(selectCls, 'w-36')} defaultValue="email">
                  {OFFER_SEND_CHANNELS.map((c) => <option key={c} value={c}>{t(`offer.channels.${c}`)}</option>)}
                </select>
              </Field>
              <button type="submit" className={btnPrimary}>{t('offer.markSent')}</button>
              <span className="text-xs text-muted-foreground">{t('offer.validFor', { days: offer.validDays })}</span>
            </form>
          )}
          {offer.can.recordDecision && (
            <form action={recordOfferDecisionAction} className="flex items-end gap-2">{hidden('offerId', o.id)}{hidden('applicationId', applicationId)}{hidden('returnTo', here)}
              <Field label={t('offer.decision')}>
                <select name="decision" className={cn(selectCls, 'w-40')} defaultValue="accepted">
                  <option value="accepted">{t('offer.labels.accepted')}</option>
                  <option value="declined">{t('offer.labels.declined')}</option>
                </select>
              </Field>
              <button type="submit" className={btnPrimary}>{t('offer.recordDecision')}</button>
            </form>
          )}
        </section>
      )}
      <p className="text-xs text-muted-foreground">{t('offer.noSending')}</p>
    </div>
  );
}

function HireSection({ hire, applicationId, t, locale }: { hire: ApplicationHire; applicationId: string; t: T; locale: string }) {
  if (!hire.eligible && !hire.link) return null;
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
      {hire.link ? (
        <>
          <span>{t('hire.linked', { code: hire.link.employeeCode ?? '—', by: hire.link.linkedBy ?? t('job.unnamedUser'), at: klDateTime(locale, hire.link.linkedAt) })}</span>
          <Link className={btnGhost} href={`/admin/personnel/new?draft=${encodeURIComponent(hire.link.draftId)}`}>{t('hire.openDraft')}</Link>
        </>
      ) : hire.canStart ? (
        <>
          <span>{t('hire.ready')}</span>
          <Link className={btnPrimary} href={`/admin/personnel/new?fromApplication=${encodeURIComponent(applicationId)}`}>{t('hire.start')}</Link>
        </>
      ) : <span className="text-muted-foreground">{t('hire.adminOnly')}</span>}
    </section>
  );
}
