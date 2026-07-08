import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { AuditRow } from '@/core/read';
import {
  ACTOR_DOT,
  ACTOR_LABEL,
  actionOf,
  aggregateHref,
  aggregateLabel,
  describePayload,
  humanizeEvent,
  isHighImpactAction,
  moduleKeyOf,
  relativeTime,
  type ActionKind,
  type ModuleKey,
} from '@/lib/audit-format';

/** Colour-coded action badge classes (light + dark). High-impact actions (delete/supersede/archive)
 *  read as warnings; the rest are informational. */
const ACTION_BADGE: Record<ActionKind, string> = {
  created: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  updated: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  deleted: 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300',
  archived: 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
  unarchived: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
  superseded: 'bg-purple-100 text-purple-800 dark:bg-purple-500/15 dark:text-purple-300',
  other: 'bg-muted text-muted-foreground',
};

/** Append-only event ledger, rendered as scannable rows with an expandable payload diff. Each row shows
 *  a module chip + a colour-coded action badge; expanding reveals the before→after comparison and the
 *  absolute timestamp. PII (bank/IC/salary) is masked by describePayload. Server component — no client JS. */
export async function AuditTable({ rows, nowMs }: { rows: AuditRow[]; nowMs: number }) {
  const t = await getTranslations('components.auditTable');
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>;
  }
  const moduleLabel = (k: ModuleKey) => t(`module_${k}` as `module_${ModuleKey}`);
  const actionLabel = (k: ActionKind) => t(`action_${k}` as `action_${ActionKind}`);
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const who = r.actorName ?? ACTOR_LABEL[r.actorType] ?? r.actorType;
        const href = aggregateHref(r.aggregateType, r.aggregateId);
        const detail = describePayload(r.payload);
        const action = actionOf(r.eventType);
        const mod = moduleKeyOf(r.aggregateType);
        const highImpact = isHighImpactAction(action);
        return (
          <li key={r.id} className="px-4 py-2.5 text-sm">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <span
                  className={`size-2 shrink-0 rounded-full ${ACTOR_DOT[r.actorType] ?? 'bg-muted-foreground'}`}
                  title={r.actorType}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ACTION_BADGE[action]}`}
                  >
                    {actionLabel(action)}
                  </span>
                  {highImpact && (
                    <span className="mr-1.5 inline-block text-[10px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-400">
                      {t('highImpact')}
                    </span>
                  )}
                  <span className="font-medium text-foreground">{humanizeEvent(r.eventType)}</span>{' '}
                  <span className="text-muted-foreground">{t('byActor', { who })}</span>
                </span>
                <span className="hidden shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
                  {moduleLabel(mod)}
                </span>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {href ? (
                    <Link href={href} className="text-primary hover:underline">
                      {aggregateLabel(r.aggregateType)}
                    </Link>
                  ) : (
                    aggregateLabel(r.aggregateType)
                  )}
                </span>
                <time
                  className="shrink-0 tabular-nums text-xs text-muted-foreground"
                  dateTime={new Date(r.occurredAt).toISOString()}
                  title={new Date(r.occurredAt).toLocaleString()}
                >
                  {relativeTime(r.occurredAt, nowMs)}
                </time>
                <span className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>
                  ›
                </span>
              </summary>
              <dl className="mt-2 ml-5 space-y-0.5 border-l border-border/60 pl-3 text-xs">
                {detail.map((d, i) => (
                  <div key={i} className="flex gap-2">
                    <dt className="text-muted-foreground">{d.key}</dt>
                    <dd className={d.changed ? 'font-medium text-foreground' : 'tabular-nums'}>{d.value}</dd>
                  </div>
                ))}
                <div className="flex gap-2 pt-0.5 text-[10px] text-muted-foreground/70">
                  <dt>{t('at')}</dt>
                  <dd className="tabular-nums">{new Date(r.occurredAt).toLocaleString()}</dd>
                </div>
                <div className="pt-0.5 text-[10px] text-muted-foreground/70">{t('sequence', { seq: r.sequence })}</div>
              </dl>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
