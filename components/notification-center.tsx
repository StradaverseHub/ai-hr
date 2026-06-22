'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Bell } from 'lucide-react';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/notification-actions';
import type { NotificationRow } from '@/core/notifications';

/**
 * Topbar notification center (ADR-0034 34-3). A bell with an unread badge that opens a dropdown of the
 * viewer's recent notifications (RLS-scoped server-side); clicking one deep-links and marks it read.
 * Shown to every user when NOTIFICATIONS_ENABLED — the legacy approvals bell is the off-state fallback.
 */
const sevDot: Record<string, string> = { info: 'bg-sky-500', action: 'bg-indigo-500', warning: 'bg-rose-500' };

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

export function NotificationCenter({ unread, items }: { unread: number; items: NotificationRow[] }) {
  const t = useTranslations('notifications');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();

  const markRead = (id: string) => start(async () => { await markNotificationReadAction(id); router.refresh(); });
  const markAll = () => start(async () => { await markAllNotificationsReadAction(); router.refresh(); });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('aria', { count: unread })}
        className="relative inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Bell className="size-[18px]" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 inline-flex min-w-[15px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-[15px] text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-sm font-semibold text-foreground">{t('title')}</span>
              {unread > 0 && (
                <button type="button" onClick={markAll} className="text-xs font-medium text-primary hover:underline">
                  {t('markAllRead')}
                </button>
              )}
            </div>
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              <ul className="max-h-[22rem] divide-y divide-border overflow-y-auto">
                {items.map((n) => {
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
                    <li key={n.id} className={n.readAt ? '' : 'bg-primary/5'}>
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
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
