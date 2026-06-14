import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { AuditRow } from '@/core/read';
import {
  ACTOR_DOT,
  ACTOR_LABEL,
  aggregateHref,
  aggregateLabel,
  describePayload,
  humanizeEvent,
  relativeTime,
} from '@/lib/audit-format';

/** Append-only event ledger, rendered as scannable rows with an expandable payload diff.
 *  PII (bank/IC/salary) is masked by describePayload. Server component — no client JS. */
export async function AuditTable({ rows, nowMs }: { rows: AuditRow[]; nowMs: number }) {
  const t = await getTranslations('components.auditTable');
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        const who = r.actorName ?? ACTOR_LABEL[r.actorType] ?? r.actorType;
        const href = aggregateHref(r.aggregateType, r.aggregateId);
        const detail = describePayload(r.payload);
        return (
          <li key={r.id} className="px-4 py-2.5 text-sm">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <span
                  className={`size-2 shrink-0 rounded-full ${ACTOR_DOT[r.actorType] ?? 'bg-muted-foreground'}`}
                  title={r.actorType}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{humanizeEvent(r.eventType)}</span>{' '}
                  <span className="text-muted-foreground">{t('byActor', { who })}</span>
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
              {detail.length > 0 && (
                <dl className="mt-2 ml-5 space-y-0.5 border-l border-border/60 pl-3 text-xs">
                  {detail.map((d, i) => (
                    <div key={i} className="flex gap-2">
                      <dt className="text-muted-foreground">{d.key}</dt>
                      <dd className="tabular-nums">{d.value}</dd>
                    </div>
                  ))}
                  <div className="pt-0.5 text-[10px] text-muted-foreground/70">{t('sequence', { seq: r.sequence })}</div>
                </dl>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
