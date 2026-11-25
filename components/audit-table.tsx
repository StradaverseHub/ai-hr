import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { loopActorOf } from '@/lib/ai-centre/loop-attribution';
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
  structurePayload,
  type ActionKind,
  type AuditDisplayLabel,
  type AuditDisplayValue,
  type ModuleKey,
} from '@/lib/audit-format';
import { formatAuditEntity, type AuditFieldLabelKey, type AuditLabels } from '@/lib/audit-fields';
import { formatDmyInText, formatDmyTime } from '@/lib/date-display';

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
export async function AuditTable({
  rows,
  nowMs,
  dmyDates = false,
  labels,
}: {
  rows: AuditRow[];
  nowMs: number;
  /** r422 — OPT-IN: draw the absolute timestamp as "31-Jan-2026 14:05" (Kuala Lumpur clock) and every
   *  yyyy-mm-dd inside a payload value as DD-MMM-YYYY (lib/date-display.ts). The Personnel profile's
   *  Change History passes it; the Audit screens do not and are unchanged. */
  dmyDates?: boolean;
  /** 74a7a074 — OPT-IN: names for the record references on this page (core/audit-labels.ts
   *  resolveAuditLabels, run as the viewer under row security). When given, the expanded row is the
   *  readable Action / Record / Changes / Other details view with a collapsed Technical details block;
   *  without it the original "key: value" lines render unchanged. */
  labels?: AuditLabels;
}) {
  const t = await getTranslations('components.auditTable');
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>;
  }
  const tp = await getTranslations('payroll.batch');
  const moduleLabel = (k: ModuleKey) => t(`module_${k}` as `module_${ModuleKey}`);
  const actionLabel = (k: ActionKind) => t(`action_${k}` as `action_${ActionKind}`);
  const dateText = (text: string) => (dmyDates ? formatDmyInText(text) : text);
  const fieldLabel = (l: AuditDisplayLabel) => (l.key ? t(`field_${l.key}` as `field_${AuditFieldLabelKey}`) : l.fallback);
  const unavailable = <span className="italic text-muted-foreground">{t('notAvailable')}</span>;
  /** One display value. A reference resolves through `labels`; an id it does not hold — deleted or out of
   *  the viewer's scope, deliberately indistinguishable — reads "Record not available". */
  const show = (v: AuditDisplayValue) => {
    switch (v.type) {
      case 'empty':
        return '—';
      case 'text':
        return dateText(v.text);
      case 'technical':
        return <span className="italic text-muted-foreground">{t('seeTechnical')}</span>;
      case 'fields':
        return v.labels.map(fieldLabel).join(', ');
      case 'ref': {
        const resolved = labels?.[v.kind];
        const names = v.ids.map((id) => resolved?.[id]).map((r) => (r ? dateText(formatAuditEntity(v.kind, r)) : null));
        if (names.every((n) => n == null)) return unavailable;
        // A long id list (companyIds on a group rule) shows the first twenty; the rest stay in Technical details.
        const shown = names.slice(0, 20).map((n) => n ?? t('notAvailable'));
        return names.length > 20 ? `${shown.join(', ')} +${names.length - 20}` : shown.join(', ');
      }
    }
  };
  const sectionTitle = 'pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-0';
  const line = (key: string | number, label: string, value: ReactNode) => (
    <div key={key} className="grid grid-cols-[minmax(7rem,11rem)_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
  /** 74a7a074 — the readable detail: Action, Record, Changes (Previous / Updated), Other details, the
   *  "current names" note and a collapsed Technical details block with the original keys and ids. */
  const readable = (r: AuditRow, who: string) => {
    const d = structurePayload(r);
    const hasReference = [...d.record, ...d.other].some((f) => f.value.type === 'ref') ||
      d.changes.some((c) => c.previous.type === 'ref' || c.updated.type === 'ref');
    return (
      <div className="mt-2 ml-5 space-y-1 border-l border-border/60 pl-3 text-xs" data-audit-detail={r.id}>
        <section data-audit-section="action">
          <h4 className={sectionTitle}>{t('sectionAction')}</h4>
          <dl className="space-y-0.5">
            {line('who', t('doneBy'), who)}
            {line('when', t('when'), <span className="tabular-nums">{formatDmyTime(new Date(r.occurredAt))}</span>)}
            {line('event', t('event'), humanizeEvent(r.eventType))}
          </dl>
        </section>
        {d.record.length > 0 && (
          <section data-audit-section="record">
            <h4 className={sectionTitle}>{t('sectionRecord')}</h4>
            <dl className="space-y-0.5">{d.record.map((f, i) => line(i, fieldLabel(f.label), show(f.value)))}</dl>
          </section>
        )}
        {(d.changes.length > 0 || d.noFieldChanged) && (
          <section data-audit-section="changes">
            <h4 className={sectionTitle}>{t('sectionChanges')}</h4>
            {d.changes.length > 0 ? (
              <table className="w-full table-fixed border-collapse text-left">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th scope="col" className="py-1 pr-2 font-medium">{t('columnField')}</th>
                    <th scope="col" className="py-1 pr-2 font-medium">{t('columnPrevious')}</th>
                    <th scope="col" className="py-1 font-medium">{t('columnUpdated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.changes.map((c, i) => (
                    <tr key={i} className="border-b border-border/60 align-top">
                      <th scope="row" className="py-1 pr-2 font-normal text-foreground">{fieldLabel(c.label)}</th>
                      <td className="break-words py-1 pr-2 text-rose-700 dark:text-rose-300">{show(c.previous)}</td>
                      <td className="break-words py-1 text-emerald-700 dark:text-emerald-300">{show(c.updated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-muted-foreground">{t('noFieldChanged')}</p>
            )}
          </section>
        )}
        {d.other.length > 0 && (
          <section data-audit-section="other">
            <h4 className={sectionTitle}>{t('sectionOther')}</h4>
            <dl className="space-y-0.5">{d.other.map((f, i) => line(i, fieldLabel(f.label), show(f.value)))}</dl>
          </section>
        )}
        {hasReference && <p className="pt-1 text-[11px] text-muted-foreground">{t('currentNames')}</p>}
        <details className="pt-1" data-audit-section="technical">
          <summary className="cursor-pointer text-[11px] text-primary hover:underline">{t('technicalDetails')}</summary>
          <dl className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
            {d.technical.map((x, i) => (
              <div key={i} className="flex gap-2">
                <dt>{x.key}</dt>
                <dd className="min-w-0 break-all">{x.value}</dd>
              </div>
            ))}
            <div className="pt-0.5">{t('sequence', { seq: r.sequence })}</div>
          </dl>
        </details>
      </div>
    );
  };
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => {
        // AI v2 Phase 2 P2-1: an event an AI Centre loop wrote names the loop and its sponsor (its stored label).
        const who = loopActorOf(r.payload)?.label ?? r.actorName ?? ACTOR_LABEL[r.actorType] ?? r.actorType;
        const href = aggregateHref(r.aggregateType, r.aggregateId);
        const detail = labels ? [] : describePayload(r.payload);
        const recorded = r.eventType === 'payroll-batch.employee-reprocess-outcome' && r.payload
          && typeof r.payload === 'object' && !Array.isArray(r.payload) ? r.payload as Record<string,unknown> : null;
        const processingStatus = recorded && ['reprocessed','skipped','validation_failed'].includes(String(recorded.status))
          ? String(recorded.status) : null;
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
                  <span className="font-medium text-foreground">{humanizeEvent(r.eventType)}</span>
                  {processingStatus && <span className="ml-1 font-medium">· {tp(`reprocessOutcomeStatus.${processingStatus}`)}
                    {recorded?.reasonCode === 'NOTHING_PAYABLE' ? ` — ${tp('reprocessNothingPayableShort')}` : ''}</span>}{' '}
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
                  title={dmyDates ? formatDmyTime(new Date(r.occurredAt)) : new Date(r.occurredAt).toLocaleString(undefined, { timeZone: HR_LOCAL_TZ })}
                >
                  {relativeTime(r.occurredAt, nowMs)}
                </time>
                <span className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>
                  ›
                </span>
              </summary>
              {labels ? (
                readable(r, who)
              ) : (
                <dl className="mt-2 ml-5 space-y-0.5 border-l border-border/60 pl-3 text-xs">
                  {detail.map((d, i) => (
                    <div key={i} className="flex gap-2">
                      <dt className="text-muted-foreground">{d.key}</dt>
                      <dd className={d.changed ? 'font-medium text-foreground' : 'tabular-nums'}>{dmyDates ? formatDmyInText(d.value) : d.value}</dd>
                    </div>
                  ))}
                  <div className="flex gap-2 pt-0.5 text-[10px] text-muted-foreground/70">
                    <dt>{t('at')}</dt>
                    <dd className="tabular-nums">
                      {dmyDates ? formatDmyTime(new Date(r.occurredAt)) : new Date(r.occurredAt).toLocaleString(undefined, { timeZone: HR_LOCAL_TZ })}
                    </dd>
                  </div>
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
