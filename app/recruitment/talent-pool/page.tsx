import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireModule } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import { ErrorBanner, Input, PageHeader, btnGhost, btnPrimary } from '@/components/ui';
import { cn } from '@/lib/utils';
import {
  blockedList, parsePoolKey, poolChoices, poolMembers, poolNav, talentPool, BLOCKED_REASON_MAX, RecruitmentError, type BlockedList, type PoolMembers,
  type PoolNav, type TalentPool,
} from '@/packs/recruitment/service';
import { addPoolCandidateToJobAction, removeCandidateFromPoolAction, unblockCandidateAction } from '../actions';
import { AddToPool } from '../pool-ui';
import { NoRecruitmentCompany, Notice, Pill, RecruitmentTabs, klDate, klDateTime, recruitmentErrorText, recruitmentViewerAccess, selectCls, textareaCls } from '../shared';

type Search = { pool?: string; job?: string; reason?: string; since?: string; tag?: string; problem?: string; notice?: string };
type T = Awaited<ReturnType<typeof getTranslations<'recruitment.pools'>>>;

/**
 * Recruitment › Talent pool. A pool list with counts: the public pool (administrators; slice 4 — the latest archived
 * application of each candidate, with the stage it left and the reason, "Add to job"), the custom pools and sub-pools the viewer
 * can see (slice 13: administrators all; the company's recruiters and assistants those shared with them), and the blocked list
 * (administrators with reasons and history; recruiters and assistants the candidates they work with, never the reason).
 * Choosing a pool filters the list. Every count and list is read under the viewer's own row security.
 */
export default async function TalentPoolPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireModule('recruitment');
  const { s, scopeIds } = await scopedSession();
  const access = await recruitmentViewerAccess(s, scopeIds);
  const sp = await searchParams;
  const [t, tp, nav, locale, tc] = await Promise.all([getTranslations('recruitment.pool'), getTranslations('recruitment.pools'), getTranslations('nav'), getLocale(),
    getTranslations('recruitment.cand')]);
  const adminIds = access.adminCompanies.map((c) => c.id);
  const poolIds = access.poolCompanies.map((c) => c.id);
  const navData = await poolNav(s, poolIds);
  const asked = parsePoolKey(sp.pool);
  const firstPool = navData.pools[0]?.id;
  const key = asked?.kind === 'public' && !adminIds.length ? (firstPool ? { kind: 'custom' as const, id: firstPool } : { kind: 'blocked' as const }) : asked;
  const poolParam = key?.kind === 'custom' ? key.id : key?.kind === 'blocked' ? 'blocked' : 'public';
  const notice = sp.notice === 'saved' ? t('addedNotice') : sp.notice === 'pool-added' ? tp('notice.added') : sp.notice === 'pool-removed' ? tp('notice.removed')
    : sp.notice === 'blocked' ? tp('notice.blocked') : sp.notice === 'unblocked' ? tp('notice.unblocked') : undefined;
  let members: PoolMembers | null = null;
  if (key?.kind === 'custom') {
    members = await poolMembers(s, key.id).catch((e) => { if (e instanceof RecruitmentError) return null; throw e; });
  }
  return (
    <div className="w-full space-y-5">
      <PageHeader title={nav('recruitment')} description={t('purpose')} />
      <RecruitmentTabs active="talentPool" admin={access.isAdmin} approvals={access.pendingApprovals} reports={access.reportCompanies.length > 0}
        screening={access.pendingScreening} pools={poolIds.length > 0} />
      <Notice text={notice} />
      <ErrorBanner message={await recruitmentErrorText(sp.problem)} />
      {poolIds.length === 0 ? <NoRecruitmentCompany /> : (
        <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <PoolList navData={navData} admin={adminIds.length > 0} current={poolParam} t={tp} />
          <div className="min-w-0 space-y-5">
            {key?.kind === 'public' && adminIds.length > 0 && (
              <PublicPool s={s} companyIds={adminIds} poolIds={poolIds} sp={sp} t={t} tp={tp} tc={tc} locale={locale} />
            )}
            {key?.kind === 'custom' && (members
              ? <CustomPool members={members} t={tp} tc={tc} locale={locale} />
              : <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{tp('notFound')}</p>)}
            {key?.kind === 'blocked' && <BlockedListView list={await blockedList(s, poolIds)} t={tp} tc={tc} locale={locale} />}
            {!key && <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{tp('notFound')}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function PoolList({ navData, admin, current, t }: { navData: PoolNav; admin: boolean; current: string; t: T }) {
  const item = (href: string, label: string, count: number, on: boolean, indent = false) => (
    <li key={href}>
      <Link href={href} aria-current={on ? 'page' : undefined}
        className={cn('flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm transition-colors', indent && 'ml-4',
          on ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
        <span className="truncate">{label}</span><span className="tabular-nums text-xs">{count}</span>
      </Link>
    </li>
  );
  return (
    <nav aria-label={t('nav.label')} className="space-y-3 rounded-xl border border-border bg-card p-3 lg:self-start">
      <ul className="space-y-0.5">
        {admin && (
          <li>
            <Link href="/recruitment/talent-pool?pool=public" aria-current={current === 'public' ? 'page' : undefined}
              className={cn('block rounded-md px-3 py-1.5 text-sm transition-colors', current === 'public' ? 'bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
              {t('nav.public')}
            </Link>
          </li>
        )}
      </ul>
      <div className="space-y-1">
        <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('nav.custom')}</p>
        {navData.pools.length === 0 ? <p className="px-3 text-xs text-muted-foreground">{t('nav.noPools')}</p> : (
          <ul className="space-y-0.5">
            {navData.pools.flatMap((p) => [
              item(`/recruitment/talent-pool?pool=${p.id}`, p.name, p.count, current === p.id),
              ...p.children.map((c) => item(`/recruitment/talent-pool?pool=${c.id}`, c.name, c.count, current === c.id, true)),
            ])}
          </ul>
        )}
      </div>
      <ul className="border-t border-border pt-2">
        {item('/recruitment/talent-pool?pool=blocked', t('nav.blocked'), navData.blockedCount, current === 'blocked')}
      </ul>
    </nav>
  );
}

async function PublicPool({ s, companyIds, poolIds, sp, t, tp, tc, locale }: {
  s: Awaited<ReturnType<typeof scopedSession>>['s']; companyIds: string[]; poolIds: string[]; sp: Search; t: Awaited<ReturnType<typeof getTranslations<'recruitment.pool'>>>;
  tp: T; tc: Awaited<ReturnType<typeof getTranslations<'recruitment.cand'>>>; locale: string;
}) {
  const [pool, choices]: [TalentPool, Awaited<ReturnType<typeof poolChoices>>] = await Promise.all([
    talentPool(s, companyIds, { jobId: sp.job, reasonId: sp.reason, since: sp.since, tagId: sp.tag }), poolChoices(s, poolIds)]);
  const here = `/recruitment/talent-pool?${new URLSearchParams(Object.entries({ job: sp.job ?? '', reason: sp.reason ?? '', since: sp.since ?? '', tag: sp.tag ?? '' }).filter(([, v]) => v))}`;
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-xl border border-border bg-card px-4 py-3"><dt className="text-xs text-muted-foreground">{t('today')}</dt><dd className="text-2xl font-semibold tabular-nums">{pool.totals.today}</dd></div>
        <div className="rounded-xl border border-border bg-card px-4 py-3"><dt className="text-xs text-muted-foreground">{t('total')}</dt><dd className="text-2xl font-semibold tabular-nums">{pool.totals.total}</dd></div>
      </dl>
      <form method="get" className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5">
        <input type="hidden" name="pool" value="public" />
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterPosition')}
          <select name="job" defaultValue={sp.job ?? ''} className={selectCls}>
            <option value="">{t('any')}</option>
            {pool.jobs.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
          </select></label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterReason')}
          <select name="reason" defaultValue={sp.reason ?? ''} className={selectCls}>
            <option value="">{t('any')}</option>
            {pool.reasons.map((r) => <option key={r.id} value={r.id}>{r.internal}</option>)}
          </select></label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('filterSince')}
          <Input name="since" type="date" defaultValue={sp.since ?? ''} /></label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{tc('tagFilter')}
          <select name="tag" defaultValue={sp.tag ?? ''} className={selectCls}>
            <option value="">{tc('anyTag')}</option>
            {pool.tags.map((g) => <option key={g.id} value={g.id}>{g.groupName} · {g.name}</option>)}
          </select></label>
        <div className="flex items-end gap-2">
          <button type="submit" className={btnPrimary}>{t('apply')}</button>
          <Link href="/recruitment/talent-pool" className={btnGhost}>{t('reset')}</Link>
        </div>
      </form>
      {pool.cards.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p> : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {pool.cards.map((c) => {
            const addable = c.removed ? [] : choices.filter((p) => p.companyId === c.companyId && !c.pools.includes(p.label));
            return (
              <li key={c.applicationId} className="space-y-3 rounded-xl border border-border bg-card p-4">
                <div>
                  <p className="flex flex-wrap items-center gap-2 font-medium">{c.removed ? tc('removedLabel') : c.candidateName}{c.blocked && <Pill tone="bad">{tp('blocked.flag')}</Pill>}</p>
                  <p className="text-xs text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(' · ') || t('noContact')}</p>
                  {c.tags.length > 0 && (
                    <ul aria-label={tc('tags')} className="mt-1 flex flex-wrap gap-1">
                      {c.tags.map((tag) => <li key={tag.id} className="rounded-full border border-border px-2 py-0.5 text-xs">{tag.name}</li>)}
                    </ul>
                  )}
                  {c.pools.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{tp('poolsLine', { names: c.pools.join(', ') })}</p>}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">{t('position')}</dt><dd>{c.jobTitle} <span className="font-mono">{c.jobNumber}</span></dd></div>
                  <div><dt className="text-muted-foreground">{t('applied')}</dt><dd>{klDate(locale, c.appliedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">{t('archived')}</dt><dd>{klDate(locale, c.archivedAt)}</dd></div>
                  <div><dt className="text-muted-foreground">{t('stageLeft')}</dt><dd>{c.stageLeft}</dd></div>
                  <div className="col-span-2"><dt className="text-muted-foreground">{t('reason')}</dt><dd>{c.reason}</dd></div>
                </dl>
                {c.addable.length > 0 ? (
                  <form action={addPoolCandidateToJobAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="applicationId" value={c.applicationId} />
                    <input type="hidden" name="returnTo" value={here} />
                    <label className="sr-only" htmlFor={`job-${c.applicationId}`}>{t('addToJob')}</label>
                    <select id={`job-${c.applicationId}`} name="jobId" required defaultValue="" className={cn(selectCls, 'h-9 w-56')}>
                      <option value="" disabled>{t('chooseJob')}</option>
                      {c.addable.map((j) => <option key={j.id} value={j.id}>{j.title} · {j.jobNumber}</option>)}
                    </select>
                    <button type="submit" className={btnPrimary}>{t('addToJob')}</button>
                  </form>
                ) : <p className="text-xs text-muted-foreground">{c.removed ? tc('removedNote') : t('noOpenJob')}</p>}
                {addable.length > 0 && <AddToPool candidateId={c.candidateId} choices={addable} here={here} t={tp} id={c.applicationId} />}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function CustomPool({ members, t, tc, locale }: { members: PoolMembers; t: T; tc: Awaited<ReturnType<typeof getTranslations<'recruitment.cand'>>>; locale: string }) {
  const here = `/recruitment/talent-pool?pool=${members.poolId}`;
  return (
    <section aria-labelledby="pool-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pool-title" className="text-base font-semibold">{members.parentName ? `${members.parentName} › ${members.name}` : members.name}</h2>
        <p className="text-sm text-muted-foreground">{t('members.total', { n: members.total })}</p>
      </div>
      {members.cards.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('members.empty')}</p> : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {members.cards.map((c) => (
            <li key={c.candidateId} className="space-y-2 rounded-xl border border-border bg-card p-4">
              <p className="flex flex-wrap items-center gap-2 font-medium">{c.removed ? tc('removedLabel') : c.candidateName}{c.blocked && <Pill tone="bad">{t('blocked.flag')}</Pill>}</p>
              <p className="text-xs text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(' · ') || t('members.noContact')}</p>
              {c.pools.length > 0 && <p className="text-xs text-muted-foreground">{t('poolsLine', { names: c.pools.join(', ') })}</p>}
              {c.latest ? (
                <p className="text-sm"><Link className="text-primary hover:underline" href={`/recruitment/applications/${c.latest.applicationId}`}>{c.latest.jobTitle}</Link>{' '}
                  <span className="font-mono text-xs">{c.latest.jobNumber}</span> · <span className="text-muted-foreground">{c.latest.state === 'active' ? c.latest.stageName : t(`members.state.${c.latest.state}`)}</span></p>
              ) : <p className="text-xs text-muted-foreground">{t('members.noApplication')}</p>}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t('members.addedBy', { by: c.addedBy ?? t('unnamedUser'), date: klDate(locale, c.addedAt) })}</span>
                <form action={removeCandidateFromPoolAction}>
                  <input type="hidden" name="poolId" value={members.poolId} /><input type="hidden" name="candidateId" value={c.candidateId} />
                  <input type="hidden" name="returnTo" value={here} />
                  <button type="submit" className="text-destructive hover:underline">{t('members.remove')}</button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BlockedListView({ list, t, tc, locale }: { list: BlockedList; t: T; tc: Awaited<ReturnType<typeof getTranslations<'recruitment.cand'>>>; locale: string }) {
  const here = '/recruitment/talent-pool?pool=blocked';
  return (
    <section aria-labelledby="blocked-title" className="space-y-4">
      <div className="space-y-1">
        <h2 id="blocked-title" className="text-base font-semibold">{t('blocked.title')}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{list.isAdmin ? t('blocked.note') : t('blocked.operatorNote')}</p>
      </div>
      {list.entries.length === 0 ? <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t('blocked.empty')}</p> : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {list.entries.map((e) => (
            <li key={e.entryId} className="space-y-2 rounded-xl border border-border bg-card p-4">
              <p className="flex flex-wrap items-center gap-2 font-medium">{e.removed ? tc('removedLabel') : e.candidateName}<Pill tone="bad">{t('blocked.flag')}</Pill></p>
              {e.latest && (
                <p className="text-sm"><Link className="text-primary hover:underline" href={`/recruitment/applications/${e.latest.applicationId}`}>{e.latest.jobTitle}</Link>{' '}
                  <span className="font-mono text-xs">{e.latest.jobNumber}</span></p>
              )}
              {e.reason !== null && <p className="whitespace-pre-wrap text-sm"><span className="font-medium">{t('blocked.reason')}:</span> {e.reason}</p>}
              <p className="text-xs text-muted-foreground">{t('blocked.addedBy', { by: e.addedBy ?? t('unnamedUser'), date: klDate(locale, e.addedAt) })} · {t('blocked.openMarks', { n: e.openMarks })}</p>
              {e.reason !== null && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-destructive">{t('blocked.remove')}</summary>
                  <form action={unblockCandidateAction} className="mt-2 space-y-2">
                    <input type="hidden" name="entryId" value={e.entryId} /><input type="hidden" name="returnTo" value={here} />
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">{t('blocked.removalReason')}
                      <textarea name="reason" required maxLength={BLOCKED_REASON_MAX} rows={2} className={textareaCls} /></label>
                    <button type="submit" className={btnGhost}>{t('blocked.remove')}</button>
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.history && (
        <section aria-labelledby="blocked-history-title" className="space-y-2">
          <h3 id="blocked-history-title" className="text-sm font-semibold">{t('blocked.history')}</h3>
          {list.history.length === 0 ? <p className="text-sm text-muted-foreground">{t('blocked.noHistory')}</p> : (
            <ol className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
              {list.history.map((h) => (
                <li key={h.id} className="border-l-2 border-border pl-3">
                  <p>{t(`blocked.actions.${h.action}`)}{h.detail ? ` (${t(`blocked.details.${h.detail}`)})` : ''} · {h.candidateName}
                    {h.application && <> · <Link className="text-primary hover:underline" href={`/recruitment/applications/${h.application.id}`}>{h.application.jobTitle}</Link></>}</p>
                  {h.reason && <p className="whitespace-pre-wrap text-xs">{t('blocked.reason')}: {h.reason}</p>}
                  <p className="text-xs text-muted-foreground">{h.actor ?? t('blocked.system')} · {klDateTime(locale, h.occurredAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </section>
  );
}
