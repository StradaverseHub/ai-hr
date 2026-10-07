'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useIsMonolith } from '@/components/ui-theme-context';
import { Bell, Search } from 'lucide-react';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/notification-actions';
import type { NotificationRow } from '@/core/notifications';
import type { PendingTaskItem } from '@/core/approvals-inbox';
import type { ApprovalHistoryItem } from '@/lib/approval-history';

/**
 * Topbar notification center (ADR-0034 34-3; 3-tab redesign, feedback 1514d366). One bell for every
 * role, opening a segmented 3-tab panel:
 *   • Notification — informational updates (unread, non-action), with the unread badge + mark-as-read.
 *   • Task — everything awaiting the viewer's action: the live approvals queue (leave, claims,
 *     corrections, travel, profile changes, resignations, reviews — RLS/role-scoped server-side) plus
 *     severity-'action' notifications; clicking deep-links to the page where the user acts. A decided
 *     approval drops off the queue and surfaces in History via the approval-history read.
 *   • History — read notifications merged with recent approval decisions (canApprove viewers),
 *     searchable, never affecting the unread count.
 * Same framework for Employee / Manager / HR Admin — only the data each role's reads return differs.
 */
const sevDot: Record<string, string> = { info: 'bg-sky-500', action: 'bg-indigo-500', warning: 'bg-rose-500' };

const actionBadge: Record<string, string> = {
  rejected: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  terminated: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
};

type TabKey = 'notifications' | 'tasks' | 'history';

/** Subtle light selected-tab colours per the spec: blue / orange-amber / grey. */
const selectedTabCls: Record<TabKey, string> = {
  notifications: 'bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300',
  tasks: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  history: 'bg-zinc-200/80 text-zinc-900 dark:bg-zinc-500/20 dark:text-zinc-200',
};

function relTime(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export function NotificationCenter({
  unread,
  items,
  tasks = [],
  taskNotifications = [],
  taskCount = 0,
  readItems = [],
  history = [],
  canApprove = false,
}: {
  /** Unread informational (non-action) notifications — the Notification tab badge. */
  unread: number;
  /** The Notification tab list — unread, non-action. */
  items: NotificationRow[];
  /** The live approvals queue awaiting the viewer's decision. */
  tasks?: PendingTaskItem[];
  /** Unread severity-'action' notifications — "complete this" items outside the approvals queue. */
  taskNotifications?: NotificationRow[];
  /** Full open-task count (queue + action notices) — the Task tab badge. */
  taskCount?: number;
  /** Read notifications — the History tab's "past notifications" half. */
  readItems?: NotificationRow[];
  /** Recent approval decisions — the History tab's "completed activities" half (canApprove only). */
  history?: ApprovalHistoryItem[];
  canApprove?: boolean;
}) {
  const t = useTranslations('notifications');
  const tH = useTranslations('approvalHistory');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('notifications');
  const [query, setQuery] = useState('');
  const [, start] = useTransition();

  const markRead = (id: string) => start(async () => { await markNotificationReadAction(id); router.refresh(); });
  const markAll = () => start(async () => { await markAllNotificationsReadAction(); router.refresh(); });

  // ── Task tab: merge the approvals queue with the action notifications, newest first. ──
  const taskEntries = useMemo(() => {
    const entries: ({ type: 'queue'; at: number; item: PendingTaskItem } | { type: 'notif'; at: number; item: NotificationRow })[] = [
      ...tasks.map((item) => ({ type: 'queue' as const, at: Date.parse(item.createdAt), item })),
      ...taskNotifications.map((item) => ({ type: 'notif' as const, at: new Date(item.createdAt).getTime(), item })),
    ];
    return entries.sort((a, b) => b.at - a.at);
  }, [tasks, taskNotifications]);

  // ── History tab: read notifications + approval decisions, merged newest first, searchable. ──
  const historyEntries = useMemo(() => {
    const entries: ({ type: 'notif'; at: number; text: string; item: NotificationRow } | { type: 'decision'; at: number; text: string; item: ApprovalHistoryItem })[] = [
      ...readItems.map((item) => ({
        type: 'notif' as const,
        at: new Date(item.createdAt).getTime(),
        text: `${item.title} ${item.body}`.toLowerCase(),
        item,
      })),
      ...history.map((item) => ({
        type: 'decision' as const,
        at: Date.parse(item.occurredAt),
        text: `${item.moduleKey} ${item.subjectName ?? ''} ${item.deciderName ?? ''} ${item.actionKey}`.toLowerCase(),
        item,
      })),
    ];
    const q = query.trim().toLowerCase();
    return entries.filter((e) => (q ? e.text.includes(q) : true)).sort((a, b) => b.at - a.at);
  }, [readItems, history, query]);

  const notifRow = (n: NotificationRow) => {
    const onClick = () => {
      if (!n.readAt) markRead(n.id);
      setOpen(false);
    };
    const inner = (
      <div className="flex gap-2.5 px-4 py-2.5">
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : (sevDot[n.severity] ?? 'bg-sky-500')}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${n.readAt ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>{n.title}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{relTime(new Date(n.createdAt))}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
        </div>
      </div>
    );
    return (
      <li key={`n-${n.id}`} className={n.readAt ? '' : 'bg-primary/5'}>
        {n.linkPath ? (
          <Link href={n.linkPath} onClick={onClick} className="block hover:bg-accent">
            {inner}
          </Link>
        ) : (
          <button type="button" onClick={onClick} className="block w-full text-left hover:bg-accent">
            {inner}
          </button>
        )}
      </li>
    );
  };

  const taskQueueRow = (task: PendingTaskItem) => (
    <li key={`t-${task.id}`}>
      <Link href={task.linkPath} onClick={() => setOpen(false)} className="block hover:bg-accent">
        <div className="flex gap-2.5 px-4 py-2.5">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {t(`task.${task.kind}` as 'task.leave')}
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{relTime(new Date(task.createdAt))}</span>
            </div>
            {task.subjectName && <p className="mt-0.5 truncate text-xs text-muted-foreground">{task.subjectName}</p>}
          </div>
        </div>
      </Link>
    </li>
  );

  const decisionRow = (h: ApprovalHistoryItem) => (
    <li key={`h-${h.id}`} className="px-4 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {tH(`module.${h.moduleKey}` as 'module.leave')}
          {h.subjectName ? ` · ${h.subjectName}` : ''}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {relTime(new Date(h.occurredAt))}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
        <span
          className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${actionBadge[h.actionKey] ?? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}`}
        >
          {tH(`actionLabel.${h.actionKey}` as 'actionLabel.approved')}
        </span>
        <span>{h.isAuto ? tH('systemAutomatic') : (h.deciderName ?? '—')}</span>
      </div>
      {!h.isAuto && h.onBehalfOfName && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {tH('onBehalfOf', { name: h.onBehalfOfName })}
        </p>
      )}
    </li>
  );

  // ── Bell badge (feedback f71dcafd): ONE combined count, so the old unread + task bubbles can no
  // longer collide on the same 36px button. The per-tab pills below keep the two figures separate. ──
  const total = unread + taskCount;
  // r398 — Monolith's top line shows the count as mono text, the number in signal-text (README §3).
  const monolith = useIsMonolith();

  const tabBtn = (key: TabKey, label: string, count?: number) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      aria-pressed={tab === key}
      className={`flex items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs font-semibold transition-colors ${
        tab === key ? selectedTabCls[key] : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className="truncate">{label}</span>
      {count != null && count > 0 && (
        <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums leading-4">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('ariaBell', { total, unread, tasks: taskCount })}
        className="relative inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground monolith:w-auto monolith:gap-1.5 monolith:rounded-none monolith:px-1 monolith:font-mono monolith:text-[11px] monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid monolith:hover:bg-transparent monolith:hover:text-ink"
      >
        {monolith ? (
          // The button's aria-label carries the full count; this text is its visible form.
          <span aria-hidden className="whitespace-nowrap">
            <span className={total > 0 ? 'tabular-nums text-signal-text' : 'tabular-nums'}>{total > 99 ? '99+' : total}</span>{' '}
            {/* Below sm only the number shows: a phone's top line cannot carry the word as well. */}
            <span className="hidden sm:inline">{t('countWord', { count: total })}</span>
          </span>
        ) : (
          <>
            <Bell className="size-[18px]" />
            {total > 0 && (
              <span className="absolute right-1 top-1 inline-flex min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-[15px] text-primary-foreground">
                {total > 99 ? '99+' : total}
              </span>
            )}
          </>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-[22rem] overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
            {/* Segmented tab bar — one style for every role; only the data behind each tab differs. */}
            <div className="border-b border-border px-3 pb-2 pt-2.5">
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1">
                {tabBtn('notifications', t('tabNotifications'), unread)}
                {tabBtn('tasks', t('tabTasks'), taskCount)}
                {tabBtn('history', t('tabHistory'))}
              </div>
            </div>

            {tab === 'notifications' && (
              <>
                {unread > 0 && (
                  <div className="flex justify-end border-b border-border px-4 py-1.5">
                    <button type="button" onClick={markAll} className="text-xs font-medium text-primary hover:underline">
                      {t('markAllRead')}
                    </button>
                  </div>
                )}
                {items.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
                ) : (
                  <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">{items.map(notifRow)}</ul>
                )}
              </>
            )}

            {tab === 'tasks' &&
              (taskEntries.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('tasksEmpty')}</p>
              ) : (
                <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">
                  {taskEntries.map((e) => (e.type === 'queue' ? taskQueueRow(e.item) : notifRow(e.item)))}
                </ul>
              ))}

            {tab === 'history' && (
              <>
                <div className="border-b border-border px-3 py-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t('historySearch')}
                      className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>
                {historyEntries.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('historyEmpty')}</p>
                ) : (
                  <ul className="max-h-[19rem] divide-y divide-border overflow-y-auto">
                    {historyEntries.map((e) => (e.type === 'notif' ? notifRow(e.item) : decisionRow(e.item)))}
                  </ul>
                )}
                {canApprove && (
                  <div className="border-t border-border px-4 py-2.5 text-center">
                    <Link
                      href="/approvals/history"
                      onClick={() => setOpen(false)}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {tH('viewFull')}
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
