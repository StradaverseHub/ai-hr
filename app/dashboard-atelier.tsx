import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowRight } from 'lucide-react';
import { AtelierAskBox } from '@/components/atelier-ask-box';
import type { ApprovalHistoryItem } from '@/lib/approval-history';
import type { PendingTaskItem } from '@/core/approvals-inbox';

/**
 * Atelier round 1 — THE ASSISTANT-FIRST HOME (brief: .impeccable/surfaces/app-layout-tsx.md; mock:
 * .impeccable/mocks/shell/home.html). Rendering only: app/(app)/page.tsx does every read and hands the results
 * here, after the same reads the other themes use, so the dashboard cards below are the viewer's own
 * saved layout, unchanged.
 *
 * WHAT IT DOES NOT CLAIM. The brief's "Prepared by the assistant" items need the assistant action layer,
 * which does not exist yet; until it does, "Needs you" lists only real pending approvals and tasks
 * (core/approvals-inbox.ts), each with the dashed ring that means "nobody has decided this". "Decided
 * today" is the approval history's own record of who decided what (app.approval_history, the same read
 * the bell's History tab uses), each with the maker's mark of the person who decided.
 */
export async function AtelierHome({
  name,
  hour,
  todayLong,
  locale,
  nowMs,
  tasks,
  history,
  showHistory,
  canAsk,
  notice,
  performance,
  dashboard,
}: {
  name: string | null;
  /** The viewer's wall-clock hour in Malaysia, 0–23. */
  hour: number;
  todayLong: string;
  locale: string;
  nowMs: number;
  tasks: readonly PendingTaskItem[];
  history: readonly ApprovalHistoryItem[];
  /** Approvers only: the history read is a team log, empty by construction for everyone else. */
  showHistory: boolean;
  canAsk: boolean;
  notice: ReactNode;
  /** WP-A2: the Performance block (reads its own facts; null without an open cycle). */
  performance?: ReactNode;
  dashboard: ReactNode;
}) {
  const t = await getTranslations('dashboard.atelier');
  const tTask = await getTranslations('notifications.task');
  const tHist = await getTranslations('approvalHistory');
  const greeting = t(hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening');
  const firstName = name?.trim().split(/\s+/)[0] ?? null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ago = (iso: string) => {
    const mins = Math.round((nowMs - new Date(iso).getTime()) / 60_000);
    if (mins < 60) return rtf.format(-Math.max(mins, 0), 'minute');
    if (mins < 60 * 24) return rtf.format(-Math.round(mins / 60), 'hour');
    return rtf.format(-Math.round(mins / 1440), 'day');
  };
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kuala_Lumpur' });
  const initials = (who: string | null) =>
    (who ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '·';
  const shown = tasks.slice(0, 6);

  return (
    <div className="atelier-home">
      {notice}
      <header className="atelier-hello">
        <h1>{firstName ? t('greetingWithName', { greeting, name: firstName }) : greeting}</h1>
        <p>
          {todayLong} · {t('pressure', { count: tasks.length })}
        </p>
      </header>

      {canAsk && (
        <AtelierAskBox
          label={t('askLabel')}
          placeholder={t('askPlaceholder')}
          submitLabel={t('askSubmit')}
          suggestions={[t('suggestLeave'), t('suggestAway'), t('suggestPay'), t('suggestHoliday')]}
        />
      )}

      {performance}

      <section className="atelier-sect" aria-labelledby="atelier-needs-you">
        <div className="atelier-sect-h">
          <h2 id="atelier-needs-you">{t('needsYou')}</h2>
          {tasks.length > 0 && <span className="atelier-n">{tasks.length}</span>}
          {tasks.length > shown.length && (
            <Link href="/approvals" className="atelier-sect-link">
              {t('viewAll')} <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="atelier-empty">{t('needsYouEmpty')}</p>
        ) : (
          <ul className="atelier-list">
            {shown.map((task) => (
              <li key={task.id} className="atelier-item">
                <span className="atelier-unmarked" role="img" aria-label={t('undecided')} />
                <div className="min-w-0">
                  <div className="atelier-t">{tTask(task.kind)}</div>
                  <div className="atelier-m">
                    {[task.subjectName, ago(task.createdAt)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <Link href={task.linkPath} className="atelier-btn">
                  {t('open')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {showHistory && (
        <section className="atelier-sect" aria-labelledby="atelier-decided">
          <div className="atelier-sect-h">
            <h2 id="atelier-decided">{t('decidedToday')}</h2>
            <span className="atelier-hint">{t('decidedHint')}</span>
          </div>
          {history.length === 0 ? (
            <p className="atelier-empty">{t('decidedEmpty')}</p>
          ) : (
            <ul className="atelier-list">
              {history.map((h) => (
                <li key={h.id} className="atelier-item">
                  <span className="atelier-mark" aria-hidden>
                    {h.isAuto ? 'A' : initials(h.deciderName)}
                  </span>
                  <div className="min-w-0">
                    <div className="atelier-t">
                      {tHist(`actionLabel.${h.actionKey}`)} · {tHist(`module.${h.moduleKey}`)}
                    </div>
                    <div className="atelier-m">{h.subjectName ?? '—'}</div>
                  </div>
                  <div className="atelier-by">
                    {h.isAuto ? t('automatic') : (h.deciderName ?? '—')}
                    <br />
                    <time dateTime={h.occurredAt}>{clock.format(new Date(h.occurredAt))}</time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="atelier-sect atelier-dash" aria-labelledby="atelier-dashboard">
        <div className="atelier-sect-h">
          <h2 id="atelier-dashboard">{t('yourDashboard')}</h2>
        </div>
        {dashboard}
      </section>
    </div>
  );
}
