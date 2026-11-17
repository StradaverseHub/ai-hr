import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { applicationHistory, candidateBoard, candidateEmailComposers, poolChoices, rejectionEmailPreviews, ASSIGNMENT_STATUSES, SCREENING_STATUS_WINDOW, WAITING_SCAN_LIMIT, CANDIDATE_SOURCES, ID_TYPES, REJECTION_EMAIL_DELAYS, RecruitmentError, type ApplicationCard, type ApplicationHistoryRow } from '@/packs/recruitment/service';
import { moveApplicationAction, rejectApplicationAction, removeCandidateFromPoolAction } from '../actions';
import { AddToPool } from '../pool-ui';
import { NoRecruitmentCompany, Notice, Pill, RecruitmentTabs, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../shared';
import { RejectDialog, type RejectEmailOffer } from './reject-dialog';
import { AddApplicationForm } from './add-application-form';
import { AgencyReviewList, AgencySubmissionPanel } from './agency-panel';
import { SCREENING_SEND_FORM, ScreeningSendPanel } from './screening-panel';
import { ScreeningStatusPill } from '../screening-ui';
import { CustomFilterSelect } from '../custom-fields-ui';
import { ExportPanel } from '../export-ui';

type Search = { job?: string; tab?: string; tag?: string; application?: string; problem?: string; notice?: string; screening?: string; send?: string; held?: string; cf?: string; waiting?: string };

/**
 * Recruitment › Candidates: the pipeline by stage, with live counts, Move forward, Reject and Add application.
 * Administrators see their companies' pipeline; a job-team member sees their jobs' applications and the ones they
 * interview, with only the actions their role allows (slice 2; the service and row security decide).
 */
export default async function RecruitmentCandidatesPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const companies = access.companies;
  const sp = await searchParams;
  const [t, nav, locale, tc, ts, tk, tp, tw] = await Promise.all([getTranslations('recruitment.candidates'), getTranslations('nav'), getLocale(), getTranslations('recruitment.cand'),
    getTranslations('recruitment.screening'), getTranslations('recruitment.checks'), getTranslations('recruitment.pools'), getTranslations('recruitment.waiting')]);
  const [board, choices] = await Promise.all([
    candidateBoard(s, companies.map((c) => c.id), { jobId: sp.job, tab: sp.tab, tagId: sp.tag, screening: sp.screening, custom: sp.cf, waiting: sp.waiting }),
    // Slice 13: the pools the viewer can see (operators and administrators), for "Add to pool" on the cards they operate.
    poolChoices(s, access.poolCompanies.map((c) => c.id)),
  ]);
  const selectedTab = board.tabs.find((x) => x.key === sp.tab) ?? board.tabs[0];
  const query = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ job: sp.job, tag: sp.tag, cf: board.customFilter ?? undefined, tab: selectedTab?.key, screening: board.screening?.filter ?? undefined,
      waiting: board.waiting?.filter ?? undefined, ...next })
      .filter((e): e is [string, string] => !!e[1]));
    return `/recruitment/candidates${q.size ? `?${q}` : ''}`;
  };
  // Slice 11: one job in view that the viewer operates, on a stage tab: its active cards can be ticked and sent to the job's
  // hiring managers together (the panel's form). The move offered is the stage's next enabled stage.
  const sendJob = board.jobs.find((j) => j.id === sp.job && j.canOperate && j.status !== 'closed');
  const sendable = sendJob && selectedTab?.stageId ? board.cards.filter((c) => c.jobId === sendJob.id && c.state === 'active' && c.canOperate) : [];
  const sendNext = sendable.map((c) => board.nextStage[c.id]).find((n) => n !== undefined);
  const here = query({});
  let history: ApplicationHistoryRow[] | null = null;
  if (sp.application) {
    try { history = await applicationHistory(s, sp.application); } catch (e) { if (!(e instanceof RecruitmentError)) throw e; }
  }
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(value));
  const dateTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }).format(new Date(value));
  const tabLabel = (key: string, name: string) => (key === 'hired' ? t('hired') : key === 'archived' ? t('archived') : name);
  const openJobs = board.jobs.filter((j) => j.status !== 'closed' && j.canOperate);
  const rejectLabels = { open: t('reject'), title: t('rejectTitle'), reason: t('rejectReason'), choose: t('choose'), external: t('externalReason'), confirm: t('rejectConfirm'), cancel: t('cancel') };
  // Slice 19: the rejection e-mail offered in each card's reject dialog, rendered exactly as it would be queued (companies whose candidate
  // e-mail is on, on an installation that can send; one set-based read for the cards, no query per card). Each preview carries its own
  // fingerprint: a change before the reject is submitted refuses it.
  const [te, previews, receiptComposers] = await Promise.all([getTranslations('recruitment.candidateEmail'),
    rejectionEmailPreviews(s, board.cards.filter((c) => c.state === 'active' && c.canReview && !c.removed).map((c) => c.id)),
    candidateEmailComposers(s, [...new Set(openJobs.map((j) => j.companyId))], 'application_received')]);
  const emailOffer = (card: ApplicationCard): RejectEmailOffer | null => {
    const p = previews[card.id];
    if (!p) return null;
    return { address: p.recipient, blocked: p.blocked === 'no_address' ? te('noAddress') : p.blocked === 'value_link' ? te('valueLink') : null,
      fromLine: te('fromLine', { name: p.senderName, replyTo: p.replyTo }), subjectLine: te('subjectLine', { subject: p.subject }), text: p.text,
      fingerprint: p.fingerprint, labels: { send: te('send'), sendNote: te('sendNote', { address: p.recipient ?? '' }), delay: te('delay'),
        delays: REJECTION_EMAIL_DELAYS.map((d) => ({ value: String(d), label: te(`delays.${d}`) })), preview: te('preview') } };
  };
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} actions={access.poolCompanies.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Link href="/recruitment/to-assign" className={btnGhost}>{t('toAssign')}</Link>
          <Link href="/recruitment/candidates/import" className={btnPrimary}>{t('import')}</Link>
        </div>
      ) : undefined} />
      <RecruitmentTabs active="candidates" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}  screening={access.pendingScreening} pools={access.poolCompanies.length > 0} />
      <Notice text={sp.notice === 'saved' ? t('savedNotice') : sp.notice === 'rejected-email' ? te('notice.rejectedQueued') : sp.notice === 'rejected-no-email' ? te('notice.rejectedNoEmail')
        : sp.notice === 'rejected-value-link' ? te('notice.rejectedValueLink') : sp.notice === 'rejected-not-previewed' ? te('notice.rejectedNotPreviewed')
        : sp.notice === 'receipt-queued' ? te('notice.receiptQueued') : sp.notice === 'receipt-no-email' ? te('notice.receiptNoEmail')
        : sp.notice === 'receipt-value-link' ? te('notice.receiptValueLink') : sp.notice === 'screening-sent' ? ts('sentNotice')
        : sp.notice === 'screening-sent-held' ? tp('notice.screeningHeld', { n: Math.max(1, Number.parseInt(sp.held ?? '1', 10) || 1) })
        : sp.notice === 'pool-added' ? tp('notice.added') : sp.notice === 'pool-removed' ? tp('notice.removed')
        : sp.notice === 'agency-accepted' || sp.notice === 'agency-waiting' ? await agencyNotice(sp.notice) : undefined} />
      <ErrorBanner message={(await recruitmentErrorText(sp.problem)) ?? (sp.notice === 'agency-refused' ? await agencyNotice(sp.notice) : undefined)} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
          <div className="min-w-0 space-y-4">
            {access.isAdmin && <AgencyReviewList s={s} companyIds={access.adminCompanies.map((c) => c.id)} />}
            <form method="get" className="flex flex-wrap items-end gap-2">
              <Field label={t('job')} className="min-w-64">
                <select name="job" defaultValue={sp.job ?? ''} className={selectCls}>
                  <option value="">{t('allJobs')}</option>
                  {board.jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
                </select>
              </Field>
              {board.tagOptions.length > 0 && (
                <Field label={tc('tagFilter')} className="min-w-48">
                  <select name="tag" defaultValue={sp.tag ?? ''} className={selectCls}>
                    <option value="">{tc('anyTag')}</option>
                    {board.tagOptions.map((g) => <option key={g.id} value={g.id}>{g.groupName} · {g.name}</option>)}
                  </select>
                </Field>
              )}
              <CustomFilterSelect choices={board.customFilters} value={board.customFilter} locale={locale} />
              <button type="submit" className={btnGhost}>{t('apply')}</button>
            </form>
            <nav aria-label={t('stages')} className="flex flex-wrap gap-2">
              {board.tabs.map((tab) => (
                <Link key={tab.key} href={query({ tab: tab.key, application: undefined })} aria-current={tab.key === selectedTab?.key ? 'page' : undefined}
                  className={cn('rounded-full border px-3 py-1 text-sm', tab.key === selectedTab?.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
                  {tabLabel(tab.key, tab.name)} <span className="tabular-nums">({tab.count}{board.waiting?.filter && tab.stageId && board.waiting.counts[tab.stageId]?.capped ? '+' : ''})</span>
                </Link>
              ))}
            </nav>
            {board.waiting && (() => {
              // Slice 17: the waiting filter, with the counts of the selected stage (or of every stage with a limit on Hired, Archived).
              const w = board.waiting!;
              const shown = selectedTab?.stageId && w.counts[selectedTab.stageId] ? [w.counts[selectedTab.stageId]] : Object.values(w.counts);
              const total = (k: 'waiting' | 'suggested') => shown.reduce((n, c) => n + (c[k] ?? 0), 0);
              const capped = shown.some((c) => c.capped);
              const canSuggest = Object.values(w.counts).some((c) => c.suggested !== null);
              const suggestJob = board.jobs.find((j) => j.id === sp.job && j.canOperate);
              return (
                <nav aria-label={tw('filterLabel')} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-xs font-medium text-muted-foreground">{tw('filterLabel')}</span>
                  {([null, 'waiting', ...(canSuggest ? ['suggested'] as const : [])] as const).map((key) => {
                    const current = (w.filter ?? null) === key;
                    return (
                      <Link key={key ?? 'all'} href={query({ waiting: key ?? '', application: undefined, send: undefined })} aria-current={current ? 'page' : undefined}
                        className={cn('rounded-md border px-2.5 py-1', current ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
                        {key ? <>{tw(`filter.${key}`)} <span className="tabular-nums">({total(key)}{capped ? '+' : ''})</span></> : tw('filter.all')}
                      </Link>
                    );
                  })}
                  {suggestJob && canSuggest && (
                    <Link href={`/recruitment/suggested-archive?job=${suggestJob.id}`} className="text-sm font-medium text-primary hover:underline">{tw('openSuggested')}</Link>
                  )}
                  {capped && <span className="w-full text-xs text-muted-foreground">{tw('countWindow', { count: WAITING_SCAN_LIMIT })}</span>}
                </nav>
              );
            })()}
            {board.screening && (
              <nav aria-label={ts('filterLabel')} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">{ts('filterLabel')}</span>
                {[null, ...ASSIGNMENT_STATUSES].map((key) => {
                  const count = key ? board.screening!.counts[key] : ASSIGNMENT_STATUSES.reduce((n, k) => n + board.screening!.counts[k], 0);
                  const current = (board.screening!.filter ?? null) === key;
                  return (
                    <Link key={key ?? 'all'} href={query({ screening: key ?? '', application: undefined, send: undefined })} aria-current={current ? 'page' : undefined}
                      className={cn('rounded-md border px-2.5 py-1', current ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
                      {key ? ts(`status.${key}`) : ts('allStatuses')} <span className="tabular-nums">({count}{board.screening!.capped ? '+' : ''})</span>
                    </Link>
                  );
                })}
                {board.screening.capped && <span className="w-full text-xs text-muted-foreground">{ts('countWindow', { count: SCREENING_STATUS_WINDOW })}</span>}
              </nav>
            )}
            {board.cards.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {board.cards.map((card) => {
                  const next = board.nextStage[card.id];
                  return (
                    <li key={card.id} className={cn('space-y-3 rounded-xl border border-border bg-card p-4', (sp.application === card.id || sp.send === card.id) && 'border-primary')}>
                      {(sendable.includes(card) || card.screeningStatus) && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          {sendable.includes(card) ? (
                            <label className="flex items-center gap-2 text-xs font-medium">
                              <input type="checkbox" name="applicationIds" value={card.id} form={SCREENING_SEND_FORM} defaultChecked={sp.send === card.id} className="accent-primary" />
                              {ts('select')}
                            </label>
                          ) : <span />}
                          {card.screeningStatus && <ScreeningStatusPill status={card.screeningStatus} />}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {t('applied', { date: date(card.appliedAt) })} · <Link href={`/recruitment/positions/${card.jobId}`} className="hover:underline">{card.jobTitle}</Link>
                        {card.source && <> · {(CANDIDATE_SOURCES as readonly string[]).includes(card.source) ? tc(`sources.${card.source as (typeof CANDIDATE_SOURCES)[number]}`) : card.source}</>}
                      </div>
                      <div>
                        <p className="font-medium">{card.removed ? tc('removedLabel') : card.candidateName}</p>
                        <p className="text-xs text-muted-foreground">{[card.email, card.phone].filter(Boolean).join(' · ') || t('noContact')}</p>
                        {card.tags.length > 0 && (
                          <ul aria-label={tc('tags')} className="mt-1 flex flex-wrap gap-1">
                            {card.tags.map((tag) => <li key={tag.id} className="rounded-full border border-border px-2 py-0.5 text-xs">{tag.name}</li>)}
                          </ul>
                        )}
                        {card.needsReview && (
                          <p className="mt-1">
                            <Link href={`/recruitment/applications/${card.id}`} className="inline-flex"><Pill tone="warn">{tp('review.cardFlag')}</Pill></Link>
                          </p>
                        )}
                        {card.waiting && (
                          <p className="mt-1 flex flex-wrap gap-1">
                            <Pill tone="warn">{tw('badge', { days: card.waiting.days, stage: card.waiting.stageName })}</Pill>
                            {card.waiting.suggested && <Pill tone="bad">{tw('suggestedBadge')}</Pill>}
                          </p>
                        )}
                        {card.pools.length > 0 && (
                          <ul aria-label={tp('candidate.title')} className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                            <li className="text-muted-foreground">{tp('poolsLabel')}</li>
                            {card.pools.map((p) => (
                              <li key={p.id} className="flex items-center rounded-full border border-border py-0.5 pl-2 pr-0.5">
                                <span>{p.label}</span>
                                <form action={removeCandidateFromPoolAction}>
                                  <input type="hidden" name="poolId" value={p.id} /><input type="hidden" name="candidateId" value={card.candidateId} />
                                  <input type="hidden" name="returnTo" value={here} />
                                  <button type="submit" aria-label={tp('candidate.removeFrom', { pool: p.label })} className="rounded-full px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">×</button>
                                </form>
                              </li>
                            ))}
                          </ul>
                        )}
                        {card.backgroundCheck && (
                          <p className="mt-1">
                            <Link href={`/recruitment/applications/${card.id}?tab=checks`} className="inline-flex">
                              <Pill tone={card.backgroundCheck === 'concerns_found' ? 'bad' : 'info'}>{tk(`marker.${card.backgroundCheck}`)}</Pill>
                            </Link>
                          </p>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 gap-2 text-xs">
                        <div><dt className="text-muted-foreground">{t('stage')}</dt><dd>{card.state === 'active' ? card.stageName : card.state === 'hired' ? t('hired') : t('archivedFrom', { stage: card.stageName })}</dd></div>
                        <div><dt className="text-muted-foreground">{t('owner')}</dt><dd>{card.ownerName ?? t('unnamedUser')}</dd></div>
                        {card.archiveReason && <div className="col-span-2"><dt className="text-muted-foreground">{t('archiveReason')}</dt><dd>{card.archiveReason}</dd></div>}
                      </dl>
                      <div className="flex flex-wrap items-center gap-2">
                        {card.state === 'active' && card.canReview && next && !card.needsReview && (
                          <form action={moveApplicationAction}>
                            <input type="hidden" name="applicationId" value={card.id} />
                            <input type="hidden" name="returnTo" value={here} />
                            <button type="submit" className={btnPrimary}>{next === 'hired' ? t('markHired') : t('moveTo', { stage: next.name })}</button>
                          </form>
                        )}
                        {card.state === 'active' && !card.needsReview && (board.moveTargets[card.id]?.length ?? 0) > 0 && (
                          <form action={moveApplicationAction} className="flex items-center gap-1">
                            <input type="hidden" name="applicationId" value={card.id} />
                            <input type="hidden" name="returnTo" value={here} />
                            <label className="sr-only" htmlFor={`target-${card.id}`}>{t('moveToStage')}</label>
                            <select id={`target-${card.id}`} name="targetStageId" required defaultValue="" className={cn(selectCls, 'h-9 w-40')}>
                              <option value="" disabled>{t('moveToStage')}</option>
                              {board.moveTargets[card.id].map((x) => <option key={x.stageId} value={x.stageId}>{x.name}</option>)}
                            </select>
                            <button type="submit" className={btnGhost}>{t('move')}</button>
                          </form>
                        )}
                        {card.state === 'active' && card.canReview && (
                          <RejectDialog action={rejectApplicationAction} applicationId={card.id} returnTo={here} candidateName={card.candidateName}
                            reasons={board.reasons.filter((r) => r.companyId === card.companyId)} labels={rejectLabels} email={emailOffer(card)} />
                        )}
                        {card.state === 'active' && card.canOperate && !sendable.includes(card) && (
                          <Link href={`${query({ job: card.jobId, send: card.id, screening: undefined, application: undefined })}#screening-send-panel`} className="text-sm text-primary hover:underline">{ts('send')}</Link>
                        )}
                        <Link href={`/recruitment/applications/${card.id}`} className="text-sm font-medium text-primary hover:underline">{t('open')}</Link>
                        <Link href={query({ application: card.id })} className="text-sm text-primary hover:underline">{t('history')}</Link>
                      </div>
                      {card.canOperate && !card.removed && (() => {
                        const addable = choices.filter((p) => p.companyId === card.companyId && !card.pools.some((x) => x.id === p.id));
                        return addable.length > 0 ? <AddToPool candidateId={card.candidateId} choices={addable} here={here} t={tp} id={card.id} /> : null;
                      })()}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <aside className="space-y-4">
            {access.poolCompanies.length > 0 && (
              <ExportPanel s={s} kind="board" companyIds={access.poolCompanies.map((c) => c.id)} returnTo={here}
                filters={{ job: sp.job, tab: selectedTab?.key, tag: sp.tag, cf: board.customFilter ?? undefined }} />
            )}
            {sendJob && selectedTab?.stageId && (
              <ScreeningSendPanel s={s} jobId={sendJob.id} here={query({ application: undefined })} selectable={sendable.length}
                nextStage={sendNext && sendNext !== 'hired' ? sendNext.name : null} />
            )}
            {history && (
              <section className="space-y-2 rounded-xl border border-border bg-card p-4" aria-labelledby="history-title">
                <h2 id="history-title" className="text-sm font-semibold">{t('historyTitle')}</h2>
                <ol className="space-y-2 text-sm">
                  {history.map((h) => (
                    <li key={h.id} className="border-l-2 border-border pl-3">
                      <p>{h.kind === 'applied' ? t('event.applied', { stage: h.toStage ?? '' })
                        : h.kind === 'moved' ? t('event.moved', { from: h.fromStage ?? '', to: h.toStage ?? '' })
                          : h.kind === 'hired' ? t('event.hired', { from: h.fromStage ?? '' })
                            : t('event.rejected', { from: h.fromStage ?? '', reason: h.reason ?? '' })}</p>
                      <p className="text-xs text-muted-foreground">{h.actorName ?? t('unnamedUser')} · {dateTime(h.occurredAt)}</p>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {(access.isAdmin || openJobs.length > 0) && <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-labelledby="add-title">
              <h2 id="add-title" className="text-sm font-semibold">{t('addTitle')}</h2>
              {openJobs.length === 0 ? <p className="text-sm text-muted-foreground">{t('noOpenJobs')}</p> : (
                <AddApplicationForm
                  returnTo={here}
                  jobs={openJobs.map((j) => ({ id: j.id, label: `${j.title} · ${j.jobNumber}` }))}
                  defaultJob={openJobs.some((j) => j.id === sp.job) ? sp.job! : ''}
                  sources={CANDIDATE_SOURCES.map((v) => ({ value: v, label: tc(`sources.${v}`) }))}
                  idTypes={ID_TYPES.map((v) => ({ value: v, label: tc(`idTypes.${v}`) }))}
                  matchLabels={{ idNumber: tc('match.idNumber'), email: tc('match.email'), name: tc('match.name'), mobile: tc('match.mobile') }}
                  stateLabels={{ active: tc('appStates.active'), hired: tc('appStates.hired'), archived: tc('appStates.archived') }}
                  receipt={Object.keys(receiptComposers).length ? { label: te('sendReceipt'), note: te('sendReceiptNote') } : null}
                  labels={{
                    job: t('job'), choose: t('choose'), required: t('required'), fullName: t('fullName'), email: t('email'), phone: t('phone'),
                    idType: tc('idType'), idNumber: tc('idNumber'), idNone: tc('idNone'), source: t('source'), add: t('add'), adding: tc('adding'),
                    duplicateTitle: tc('dup.title'), duplicateAskAdmin: tc('dup.askAdmin'), duplicateAdmin: tc('dup.admin'), useExisting: tc('dup.useExisting'),
                    createSeparate: tc('dup.createSeparate'), matchedOn: tc('dup.matchedOn'), noApplications: tc('dup.noApplications'),
                  }}
                />
              )}
            </section>}
            {sp.job && openJobs.some((j) => j.id === sp.job) && <AgencySubmissionPanel s={s} jobId={sp.job} here={here} />}
          </aside>
        </div>
      )}
    </div>
  );
}

/** The notice after recording an agency submission: its outcome only (slice 10). */
async function agencyNotice(notice: string): Promise<string | undefined> {
  const t = await getTranslations('recruitment.agency');
  switch (notice) {
    case 'agency-accepted': return t('notice.accepted');
    case 'agency-refused': return t('notice.refused');
    case 'agency-waiting': return t('notice.waiting');
    default: return undefined;
  }
}
