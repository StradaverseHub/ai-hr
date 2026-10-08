import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/utils';
import { LEVEL } from '@/packs/lifecycle/service';

const TONE: Record<string, string> = {
  in_progress: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  open: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  requested: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  pending_l2: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  pending_approval: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  accepted: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  assigned: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  issued: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  in_stock: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  returned: 'bg-slate-100 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300',
  procured: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  tagged: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  under_repair: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-400',
  rejected: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
  retired: 'bg-muted text-muted-foreground',
  written_off: 'bg-muted text-muted-foreground',
};

/** A labelled status pill. The label is already translated by the caller; the tone keys off the raw value. */
export function Pill({ value, label }: { value: string; label: string }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONE[value] ?? 'bg-muted text-muted-foreground')}>{label}</span>;
}

export function ProgressBar({ percent, label }: { percent: number; label?: string }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>
      <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
    </div>
  );
}

/** The module's section strip. Requesters see only Overview and Asset requests; staff see the rest. */
export async function LifecycleTabs({ level, active }: { level: number; active: string }) {
  const t = await getTranslations('lifecycle.tabs');
  const tabs = [
    { key: 'overview', href: '/lifecycle', min: 0 },
    { key: 'onboarding', href: '/lifecycle/onboarding', min: LEVEL.agent },
    { key: 'offboarding', href: '/lifecycle/offboarding', min: LEVEL.agent },
    { key: 'requisitions', href: '/lifecycle/requisitions', min: LEVEL.agent },
    { key: 'assets', href: '/lifecycle/assets', min: LEVEL.agent },
    { key: 'assetRequests', href: '/lifecycle/asset-requests', min: 0 },
  ].filter((x) => level >= x.min);
  return (
    <nav aria-label={t('label')} className="flex flex-wrap gap-1 border-b border-border">
      {tabs.map((x) => (
        <Link key={x.key} href={x.href} aria-current={active === x.key ? 'page' : undefined}
          className={cn('-mb-px border-b-2 px-3 py-2 text-sm', active === x.key ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
          {t(x.key)}
        </Link>
      ))}
    </nav>
  );
}

export const fmt = (d: string | Date | null | undefined): string => (d == null || d === '' ? '—' : d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
export const fmtTime = (d: Date | string | null | undefined): string => (d == null ? '—' : new Date(d).toISOString().slice(0, 16).replace('T', ' '));
export const yesNo = (b: boolean, y: string, n: string): string => (b ? y : n);

/** Every `action` the services write to lc_history. test/lifecycle-i18n.test.ts pins that each has a label. */
export const HISTORY_ACTIONS = [
  'case.created', 'case.edited', 'case.completed', 'case.reverted', 'case.cancelled', 'case.reopened', 'case.commented', 'case.owner_changed', 'case.email_changed',
  'case.devices_returned', 'step.done', 'step.undone', 'outcome.set', 'outcome.changed', 'return.created', 'return.cancelled', 'daa.submitted',
  'requisition.created', 'requisition.edited', 'requisition.provision', 'requisition.approved', 'requisition.rejected', 'requisition.completed', 'requisition.status', 'requisition.cancelled',
  'asset.registered', 'asset.status', 'asset.edited', 'asset.issued', 'asset.returned',
  'request.created', 'request.approved', 'request.rejected', 'request.procured', 'request.tagged', 'request.assigned', 'request.completed', 'request.handler', 'request.cancelled',
] as const;

type Hist = { id: string; action: string; detail: unknown; actorName: string | null; at: Date | string };

/** A one-line, human summary of a history row's detail (reasons, transitions, step and item names). */
export function historyDetail(detail: unknown): string {
  const d = (detail ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof d.step === 'string') bits.push(d.step);
  if (typeof d.item === 'string') bits.push(d.item);
  if (typeof d.from === 'string' && typeof d.to === 'string') bits.push(`${d.from} → ${d.to}`);
  if (typeof d.holder === 'string' && d.holder) bits.push(d.holder);
  if (typeof d.requisition === 'string') bits.push(d.requisition);
  if (typeof d.reference === 'string' && d.reference) bits.push(`#${d.reference}`);
  if (typeof d.importedFrom === 'string' && d.importedFrom) bits.push(d.importedFrom);
  if (typeof d.reason === 'string' && d.reason) bits.push(`“${d.reason}”`);
  if (typeof d.notes === 'string' && d.notes) bits.push(`“${d.notes}”`);
  if (Array.isArray(d.fields)) bits.push(d.fields.join(', '));
  return bits.join(' · ');
}

export async function HistoryList({ rows }: { rows: Hist[] }) {
  const t = await getTranslations('lifecycle');
  const known = new Set<string>(HISTORY_ACTIONS);
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">{t('common.noHistory')}</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {rows.map((h) => (
        <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-3 px-4 py-2">
          <span><span className="font-medium">{known.has(h.action) ? t(`history.${h.action}`) : h.action}</span>{historyDetail(h.detail) && <span className="ml-2 text-muted-foreground">{historyDetail(h.detail)}</span>}</span>
          <span className="text-xs text-muted-foreground">{h.actorName ?? '—'} · {fmtTime(h.at)}</span>
        </li>
      ))}
    </ul>
  );
}
