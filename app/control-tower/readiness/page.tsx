import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { isGroupAdmin, requireAdmin } from '@/lib/authz';
import { recordReadiness, PEOPLE_PER_GAP } from '@/core/record-readiness';
import { orchestrationQueue } from '@/core/hr-orchestrator';
import { readinessLoopAsks, type ReadinessAsk } from '@/core/loops/readiness-asks';
import { Card, EmployeeCode, PageHeader, SectionHeader, pageWideCls } from '@/components/ui';
import { OperationsTabs } from '../operations-tabs';
import { OrchestrationWorkQueue } from '../work-queue';

/**
 * ADR-0083 §3 item 2 — the readiness screen, and since the AI Centre restructure (owner decision 29, 4 November 2026)
 * THE ONE LIST OF RECORD GAPS. The former Operations overview's work queue is part of it: for each person in a gap, who
 * acts (the employee, HR or group HR, from the HR engine's last check), the way to act where it is a review waiting on
 * the viewer, and what the missing-employee-data loop has asked them; with the queue's Refresh. Elsewhere (Today, the
 * Assistant, the Pre-salary loop) a record gap is a count or a link to this page.
 *
 * THE PAGE IS A FIX LIST, NOT A FINDING LIST. It is built around the gap, with the people inside it, rather than around
 * the person with their gaps listed: a fix is permanent, a review recurs every cycle.
 *
 * EVERY GAP LEADS WITH WHAT IT STOPS. The consequence is the heading and the field name is the detail.
 *
 * AN EMPTY LIST IS THE GOAL STATE AND IS RENDERED AS ONE, and names the number it checked.
 *
 * Reads, together and each with its own checks: the live gaps (core/record-readiness.ts, the one definition of what is
 * missing), the HR engine's queue as of its last check (core/hr-orchestrator.ts), and the loop's open cases
 * (core/loops/readiness-asks.ts). The live gaps decide who is listed; the queue and the loop only annotate them, so a
 * person whose gap appeared after the last check says so rather than borrowing an older answer. HR and group
 * administrators only (requireAdmin); every read is under the viewer's row-level security.
 */
export default async function ReadinessPage({ searchParams }: { searchParams?: Promise<{ refresh?: string }> } = {}) {
  const s = await requireAdmin();
  const [t, to, tc, f, sp, view, queue] = await Promise.all([getTranslations('controlTower.readinessScreen'), getTranslations('controlTower.orchestrator'),
    getTranslations('controlTower.corrections'), getFormatter(), searchParams ?? Promise.resolve({} as { refresh?: string }),
    recordReadiness(s), orchestrationQueue(s).catch(() => null)]);
  const ta = await getTranslations('aiCentre.readiness');
  const people = [...new Set(view.gaps.flatMap(g => g.people.map(p => p.employmentId)))];
  const asks: ReadonlyMap<string, ReadinessAsk> | null = await readinessLoopAsks(s, people).catch(() => null);
  const pct = view.employees === 0 ? 1 : view.ready / view.employees;
  const cases = new Map((queue?.rows ?? []).map(row => [`${row.employmentId}:${row.gap}`, row]));
  const day = (at: Date) => f.dateTime(at, { dateStyle: 'medium', timeZone: 'Asia/Kuala_Lumpur' });

  /** Who acts on this person's gap, from the HR engine's last check: its next step where the viewer may take it. */
  const whoActs = (employmentId: string, gap: string) => {
    const row = cases.get(`${employmentId}:${gap}`);
    if (!queue || queue.actionsUnavailable) return <span className="text-muted-foreground">{tc('actionUnavailable')}</span>;
    if (!row) return <span className="text-muted-foreground">{ta('notChecked')}</span>;
    const action = row.action;
    if (action?.type === 'review_submission') {
      return action.mayReview
        ? <Link href="/approvals" className="font-medium text-primary hover:underline">{tc('review')}</Link>
        : <span>{tc(action.approver === 'group_admin' ? 'waitingGroup' : 'waiting')}</span>;
    }
    const employee = (action?.audience ?? row.audience) === 'employee';
    return <span>{to(employee ? 'employee' : 'hr')}<span className="text-muted-foreground"> · {to(employee ? 'collect' : 'review')}</span></span>;
  };
  /** What the missing-employee-data loop has asked this person, when it has an open case for them. */
  const asked = (employmentId: string) => {
    if (asks === null) return null;
    const ask = asks.get(employmentId);
    if (!ask) return null;
    return <span data-readiness-loop={ask.state} className="text-xs text-muted-foreground">
      {ask.state === 'open' ? ta('loopAsked', { date: day(ask.openedAt) }) : ta('loopWaiting')}
    </span>;
  };

  return (
    <div className={pageWideCls}>
      <OperationsTabs session={s} active="readiness" />
      <PageHeader title={t('title')} description={t('description')} />

      <Card className="p-5">
        <div className="flex flex-wrap items-end gap-8">
          <div>
            <p className="text-4xl font-semibold tabular-nums">{Math.round(pct * 100)}%</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('readyPct')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {view.ready.toLocaleString()} / {view.employees.toLocaleString()}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t('readyOf')}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{view.gaps.length}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('gapKinds')}</p>
          </div>
          {/* Said out loud, because a screen with no timestamp invites "is this from last night?". The gaps are live; who
              acts is as of the HR engine's last check, which the queue's Refresh below repeats. */}
          <p className="max-w-sm text-xs text-muted-foreground">{t('liveNote')}</p>
        </div>
      </Card>

      {/* The HR engine's queue: Refresh, its last check and run. Who acts is shown with each person below. */}
      {queue ? await OrchestrationWorkQueue({ view: queue, refresh: sp.refresh, canViewRuns: isGroupAdmin(s), rows: false })
        : <Card className="p-5"><p role="status" className="text-sm text-muted-foreground">{tc('actionUnavailable')}</p></Card>}

      {view.gaps.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm">{t('allReady', { n: view.employees })}</p>
        </Card>
      ) : (
        view.gaps.map((g) => (
          <Card key={g.id} className="overflow-hidden" data-readiness-gap={g.id}>
            <SectionHeader title={t(`gap.${g.id}`)} count={g.count} />
            <div className="px-4 pb-4">
              {/* The consequence, first and in its own right. */}
              <p
                className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  g.blocks === 'payroll'
                    ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300'
                    : g.blocks === 'payment'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'bg-muted text-muted-foreground'
                }`}
              >
                {t(`blocks.${g.blocks}`, { n: g.count })}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{t(`gap.${g.id}Fix`)}</p>

              <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
                {g.people.map((p) => (
                  <li key={p.employmentId} data-readiness-person={p.employmentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                    {/* Straight to the record: from "14 people" to the field they have to fill in, in one click. */}
                    <Link href={`/admin/personnel/${p.employmentId}`} className="font-medium text-primary hover:underline">
                      {p.name}
                    </Link>
                    {p.employeeCode && <EmployeeCode code={p.employeeCode} />}
                    <span className="text-xs text-muted-foreground">{p.company}</span>
                    {/* Who acts, and what the loop asked: the former Operations overview's columns, on the person. */}
                    <span className="ml-auto flex flex-col items-end gap-0.5 text-right text-xs sm:flex-row sm:items-center sm:gap-3">
                      <span data-readiness-who>{whoActs(p.employmentId, g.id)}</span>
                      {asked(p.employmentId)}
                    </span>
                    {(cases.get(`${p.employmentId}:${g.id}`)?.reopenCount ?? 0) > 0 && (
                      <span className="basis-full text-xs text-amber-700 dark:text-amber-300">{to('reopened', { count: cases.get(`${p.employmentId}:${g.id}`)!.reopenCount })}</span>
                    )}
                  </li>
                ))}
              </ul>

              {g.count > g.people.length && (
                // The cap is stated rather than silent: a list that shows 25 of 200 without saying so reads as "there are 25".
                <p className="mt-2 text-xs text-muted-foreground">{t('moreNotShown', { shown: PEOPLE_PER_GAP, total: g.count })}</p>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
