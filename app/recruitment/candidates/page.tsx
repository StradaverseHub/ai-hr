import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Field, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import { applicationHistory, candidateBoard, CANDIDATE_SOURCES, ID_TYPES, RecruitmentError, type ApplicationHistoryRow } from '@/packs/recruitment/service';
import { moveApplicationAction, rejectApplicationAction } from '../actions';
import { NoRecruitmentCompany, Notice, RecruitmentTabs, recruitmentErrorText, recruitmentViewerAccess, selectCls } from '../shared';
import { RejectDialog } from './reject-dialog';
import { AddApplicationForm } from './add-application-form';

type Search = { job?: string; tab?: string; tag?: string; application?: string; error?: string; notice?: string };

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
  const [t, nav, locale, tc] = await Promise.all([getTranslations('recruitment.candidates'), getTranslations('nav'), getLocale(), getTranslations('recruitment.cand')]);
  const board = await candidateBoard(s, companies.map((c) => c.id), { jobId: sp.job, tab: sp.tab, tagId: sp.tag });
  const selectedTab = board.tabs.find((x) => x.key === sp.tab) ?? board.tabs[0];
  const query = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ job: sp.job, tag: sp.tag, tab: selectedTab?.key, ...next }).filter((e): e is [string, string] => !!e[1]));
    return `/recruitment/candidates${q.size ? `?${q}` : ''}`;
  };
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
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="candidates" admin={access.isAdmin} approvals={access.pendingApprovals} />
      <Notice text={sp.notice === 'saved' ? t('savedNotice') : undefined} />
      <ErrorBanner message={await recruitmentErrorText(sp.error)} />
      {companies.length === 0 ? <NoRecruitmentCompany /> : (
        <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
          <div className="min-w-0 space-y-4">
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
              <button type="submit" className={btnGhost}>{t('apply')}</button>
            </form>
            <nav aria-label={t('stages')} className="flex flex-wrap gap-2">
              {board.tabs.map((tab) => (
                <Link key={tab.key} href={query({ tab: tab.key, application: undefined })} aria-current={tab.key === selectedTab?.key ? 'page' : undefined}
                  className={cn('rounded-full border px-3 py-1 text-sm', tab.key === selectedTab?.key ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent')}>
                  {tabLabel(tab.key, tab.name)} <span className="tabular-nums">({tab.count})</span>
                </Link>
              ))}
            </nav>
            {board.cards.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {board.cards.map((card) => {
                  const next = board.nextStage[card.id];
                  return (
                    <li key={card.id} className={cn('space-y-3 rounded-xl border border-border bg-card p-4', sp.application === card.id && 'border-primary')}>
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
                      </div>
                      <dl className="grid grid-cols-2 gap-2 text-xs">
                        <div><dt className="text-muted-foreground">{t('stage')}</dt><dd>{card.state === 'active' ? card.stageName : card.state === 'hired' ? t('hired') : t('archivedFrom', { stage: card.stageName })}</dd></div>
                        <div><dt className="text-muted-foreground">{t('owner')}</dt><dd>{card.ownerName ?? t('unnamedUser')}</dd></div>
                        {card.archiveReason && <div className="col-span-2"><dt className="text-muted-foreground">{t('archiveReason')}</dt><dd>{card.archiveReason}</dd></div>}
                      </dl>
                      <div className="flex flex-wrap items-center gap-2">
                        {card.state === 'active' && card.canReview && next && (
                          <form action={moveApplicationAction}>
                            <input type="hidden" name="applicationId" value={card.id} />
                            <input type="hidden" name="returnTo" value={here} />
                            <button type="submit" className={btnPrimary}>{next === 'hired' ? t('markHired') : t('moveTo', { stage: next.name })}</button>
                          </form>
                        )}
                        {card.state === 'active' && (board.moveTargets[card.id]?.length ?? 0) > 0 && (
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
                            reasons={board.reasons.filter((r) => r.companyId === card.companyId)} labels={rejectLabels} />
                        )}
                        <Link href={`/recruitment/applications/${card.id}`} className="text-sm font-medium text-primary hover:underline">{t('open')}</Link>
                        <Link href={query({ application: card.id })} className="text-sm text-primary hover:underline">{t('history')}</Link>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <aside className="space-y-4">
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
                  labels={{
                    job: t('job'), choose: t('choose'), required: t('required'), fullName: t('fullName'), email: t('email'), phone: t('phone'),
                    idType: tc('idType'), idNumber: tc('idNumber'), idNone: tc('idNone'), source: t('source'), add: t('add'), adding: tc('adding'),
                    duplicateTitle: tc('dup.title'), duplicateAskAdmin: tc('dup.askAdmin'), duplicateAdmin: tc('dup.admin'), useExisting: tc('dup.useExisting'),
                    createSeparate: tc('dup.createSeparate'), matchedOn: tc('dup.matchedOn'), noApplications: tc('dup.noApplications'),
                  }}
                />
              )}
            </section>}
          </aside>
        </div>
      )}
    </div>
  );
}
