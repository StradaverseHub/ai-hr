import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { CalendarCheck, ClipboardCheck, ListChecks, Receipt, Wand2 } from 'lucide-react';
import type { SessionContext } from '@/db/client';
import { listPendingTasks, type PendingTaskItem } from '@/core/approvals-inbox';
import { allowedCompanies } from '@/core/read';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { openExceptionsAcrossRuns } from '@/core/payroll-anomaly';
import { proposeActions } from '@/core/agent-actions';
import { recordReadiness } from '@/core/record-readiness';
import { isAdmin } from '@/lib/authz';
import { getScopeIds } from '@/lib/scope';
import { PageHeader } from '@/components/ui';
import { ProposalCard } from '@/components/ai-centre/proposal-card';
import { LeaveRecommendationLink, RecommendationPanel } from '@/components/ai-centre/leave-recommendation';
import { digestPreview, latestDailyDigest } from '@/core/digest/daily-digest';
import { readLeaveRecommendation } from './recommendation';

type Finding = { key: 'exceptions' | 'proposals' | 'readiness'; count: number; blocking?: number; href: string };

/** Read each source as the viewer. A source that fails is left out and reported as one sentence: the
 * Inbox degrades, the item's own page keeps working, and nothing private reaches the message. */
async function settle<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try { return { ok: true, value: await read() }; } catch { return { ok: false }; }
}

/** ADR-0170 §3.1 "what needs you": everything waiting on this person, from owners that already decide it.
 *
 *  - Decisions: the canonical approvals queue (core/approvals-inbox.ts listPendingTasks), the same list the
 *    notification bell shows, each linking to the page where the person decides.
 *  - Findings, administrators only and with the same module gates as the Control Tower rows: open payroll
 *    exceptions, proposed actions awaiting approval, and records missing data, each linking to its
 *    existing Control Tower page.
 * Nothing is written, prepared or decided here. */
export async function AiCentreInbox({ session, recommend }: { session: SessionContext; recommend?: string }) {
  const t = await getTranslations('aiCentre');
  const tasksLabel = await getTranslations('notifications.task');
  const f = await getFormatter();
  const admin = isAdmin(session);
  const payroll = isModuleEnabledOrFalse(session, 'payroll');

  const tasks = await settle(async () => {
    const scopeIds = await getScopeIds((await allowedCompanies(session)).map(company => company.id));
    return listPendingTasks(session, scopeIds, {
      attendance: isModuleEnabledOrFalse(session, 'attendance'),
      claims: isModuleEnabledOrFalse(session, 'claims'),
      performance: isModuleEnabledOrFalse(session, 'performance'),
      rewards: isModuleEnabledOrFalse(session, 'rewards'),
    });
  });
  // Step 5: today's digest, computed now as the viewer and not recorded, plus the viewer's last prepared one.
  const [digest, lastDigest] = await Promise.all([settle(() => digestPreview(session)), settle(() => latestDailyDigest(session))]);
  const [exceptions, proposals, readiness] = await Promise.all([
    admin && payroll ? settle(() => openExceptionsAcrossRuns(session, { limit: 100 })) : null,
    admin && payroll ? settle(() => proposeActions(session)) : null,
    admin ? settle(() => recordReadiness(session, { peopleLimit: 0 })) : null,
  ]);
  const failed = [tasks, exceptions, proposals, readiness].some(result => result && !result.ok);
  // The one recommendation the approver asked to open, if it is a leave request in their own queue.
  const opened = tasks.ok && recommend && tasks.value.some(task => task.kind === 'leave' && task.id === recommend)
    ? { id: recommend, view: await readLeaveRecommendation(session, recommend) } : null;

  const decisions: PendingTaskItem[] = tasks.ok ? tasks.value : [];
  const findings: Finding[] = [];
  if (exceptions?.ok && exceptions.value.total > 0)
    findings.push({ key: 'exceptions', count: exceptions.value.total, blocking: exceptions.value.rows.filter(row => row.disposition === 'block').length, href: '/control-tower/exceptions' });
  const proposalCount = proposals?.ok ? proposals.value.reduce((sum, proposal) => sum + proposal.count, 0) : 0;
  if (proposalCount > 0) findings.push({ key: 'proposals', count: proposalCount, href: '/control-tower/actions' });
  const missing = readiness?.ok ? readiness.value.employees - readiness.value.ready : 0;
  if (missing > 0) findings.push({ key: 'readiness', count: missing, href: '/control-tower/readiness' });

  const taskTitle = (task: PendingTaskItem) => {
    const label = tasksLabel.has(task.kind) ? tasksLabel(task.kind) : t('inbox.items.review');
    return task.subjectName ? `${label} · ${task.subjectName}` : label;
  };
  const approvalPrepared = { summary: t('card.howPrepared'), rows: [
    [t('card.authority'), t('card.approvalAuthority')], [t('card.read'), t('card.approvalRead')],
    [t('card.model'), t('card.noModel')], [t('card.decision'), t('card.notYet')],
  ] as const };
  const findingPrepared = { summary: t('card.howPrepared'), rows: [
    [t('card.authority'), t('card.findingAuthority')], [t('card.read'), t('card.findingRead')], [t('card.model'), t('card.findingModel')],
  ] as const };
  const findingIcon = { exceptions: <Receipt />, proposals: <Wand2 />, readiness: <ClipboardCheck /> } as const;
  const empty = decisions.length === 0 && findings.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader title={t('inbox.title')} description={t('inbox.description')} />
      {failed && <p role="status" className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">{t('inbox.unavailable')}</p>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-7">
          {digest.ok && (
            <section aria-labelledby="inbox-digest" data-inbox-digest className="rounded-xl border border-border bg-card p-4">
              <h2 id="inbox-digest" className="text-[0.9375rem] font-semibold">{t('digest.title')}</h2>
              <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                <li><Link href={digest.value.approvals.page} className="block rounded-lg border border-border p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="block text-xs text-muted-foreground">{t('digest.approvals')}</span><span className="text-lg font-semibold tabular-nums">{digest.value.approvals.total}</span></Link></li>
                {digest.value.setup && <li><Link href={digest.value.setup.page} className="block rounded-lg border border-border p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="block text-xs text-muted-foreground">{t('digest.setup')}</span><span className="text-lg font-semibold tabular-nums">{digest.value.setup.blocked + digest.value.setup.attention}</span>
                  <span className="block text-xs text-muted-foreground">{t('digest.setupDetail', { blocked: digest.value.setup.blocked, attention: digest.value.setup.attention })}</span></Link></li>}
                {digest.value.deadlines && <li><Link href={digest.value.deadlines.page} className="block rounded-lg border border-border p-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="block text-xs text-muted-foreground">{t('digest.deadlines')}</span><span className="text-lg font-semibold tabular-nums">{digest.value.deadlines.overdue + digest.value.deadlines.dueSoon}</span>
                  <span className="block text-xs text-muted-foreground">{t('digest.deadlinesDetail', { overdue: digest.value.deadlines.overdue, dueSoon: digest.value.deadlines.dueSoon })}</span></Link></li>}
              </ul>
              {lastDigest.ok && lastDigest.value && <p className="mt-2 text-xs text-muted-foreground">{t('digest.lastPrepared', { when: f.dateTime(lastDigest.value.preparedAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' }) })}</p>}
            </section>
          )}
          {empty && !failed && (
            <section className="rounded-xl border border-dashed border-border p-6 text-center">
              <p className="font-medium">{t('inbox.empty')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('inbox.emptyHelp')}</p>
            </section>
          )}
          {decisions.length > 0 && (
            <section aria-labelledby="inbox-decide" className="space-y-2">
              <div className="flex items-baseline gap-2"><h2 id="inbox-decide" className="text-[0.9375rem] font-semibold">{t('inbox.groups.decide')}</h2><span className="text-xs tabular-nums text-muted-foreground">{decisions.length}</span></div>
              <p className="text-xs text-muted-foreground">{t('inbox.groups.decideHelp')}</p>
              <ul className="space-y-2">{decisions.map(task => (
                <li key={`${task.kind}:${task.id}`}>
                  <ProposalCard tone="decide" icon={task.kind === 'noticeAcknowledgement' ? <ListChecks /> : <CalendarCheck />} title={taskTitle(task)}
                    meta={[t('inbox.items.fromApprovals'), f.dateTime(new Date(task.createdAt), { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' })]}
                    href={task.linkPath} cta={t('inbox.items.review')} awaitingLabel={t('card.awaiting')} prepared={approvalPrepared} />
                  {task.kind === 'leave' && (opened?.id === task.id ? <RecommendationPanel id={`recommendation-${task.id}`} view={opened.view} /> : <LeaveRecommendationLink leaveRequestId={task.id} />)}
                </li>
              ))}</ul>
            </section>
          )}
          <section aria-labelledby="inbox-prepared" className="space-y-2">
            <h2 id="inbox-prepared" className="text-[0.9375rem] font-semibold">{t('inbox.groups.prepared')}</h2>
            <p className="max-w-3xl text-xs text-muted-foreground">{t('inbox.groups.preparedHelp')}</p>
            <Link href="/assistant" className="inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">{t('inbox.openPrepared')}</Link>
          </section>
          {findings.length > 0 && (
            <section aria-labelledby="inbox-findings" className="space-y-2">
              <div className="flex items-baseline gap-2"><h2 id="inbox-findings" className="text-[0.9375rem] font-semibold">{t('inbox.groups.findings')}</h2><span className="text-xs tabular-nums text-muted-foreground">{findings.length}</span></div>
              <p className="text-xs text-muted-foreground">{t('inbox.groups.findingsHelp')}</p>
              <ul className="space-y-2">{findings.map(finding => (
                <li key={finding.key}>
                  <ProposalCard tone="finding" icon={findingIcon[finding.key]} title={t(`inbox.items.${finding.key}Title`, { count: finding.count })}
                    meta={[t(`inbox.items.${finding.key}Source`)]}
                    checks={finding.key === 'exceptions' && finding.blocking !== undefined ? [{ label: t('inbox.items.exceptionsBlocking', { count: finding.blocking }), tone: finding.blocking > 0 ? 'warn' : 'ok' }] : []}
                    href={finding.href} cta={t(`inbox.items.${finding.key}Cta`)} prepared={findingPrepared} />
                </li>
              ))}</ul>
            </section>
          )}
        </div>
        <aside className="space-y-3">
          <section aria-labelledby="inbox-summary" className="rounded-xl border border-border bg-card p-4 text-sm">
            <h2 id="inbox-summary" className="font-semibold">{t('inbox.summary')}</h2>
            <dl className="mt-2 divide-y divide-border">
              <div className="flex justify-between py-1.5"><dt>{t('inbox.decisions')}</dt><dd className="font-semibold tabular-nums">{decisions.length}</dd></div>
              {admin && <div className="flex justify-between py-1.5"><dt>{t('inbox.findingsCount')}</dt><dd className="font-semibold tabular-nums">{findings.length}</dd></div>}
            </dl>
          </section>
          <section aria-labelledby="inbox-jobs" className="rounded-xl border border-border bg-card p-4 text-sm">
            <h2 id="inbox-jobs" className="font-semibold">{t('inbox.jobsTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('inbox.jobsNone')}</p>
            <Link href="/assistant?view=jobs" className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-primary hover:underline">{t('inbox.jobsLink')}</Link>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** The Inbox count the tab bar shows: decisions only, from the same canonical queue. Never throws. */
export async function aiCentreInboxCount(session: SessionContext): Promise<number | undefined> {
  const tasks = await settle(async () => {
    const scopeIds = await getScopeIds((await allowedCompanies(session)).map(company => company.id));
    return listPendingTasks(session, scopeIds, {
      attendance: isModuleEnabledOrFalse(session, 'attendance'), claims: isModuleEnabledOrFalse(session, 'claims'),
      performance: isModuleEnabledOrFalse(session, 'performance'), rewards: isModuleEnabledOrFalse(session, 'rewards'),
    });
  });
  return tasks.ok ? tasks.value.length : undefined;
}
