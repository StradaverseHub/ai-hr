'use client';

/**
 * Leave Details Side Panel (feedback 584edf44).
 *
 * A modern slide-out RIGHT side-sheet that replaces the old inline-expand "Breakdown" card. It presents the
 * full leave picture for ONE leave type — grouped into the reporter's seven logical sections — driven ENTIRELY
 * by the declarative descriptor in entitlement-panel-config.ts. The panel iterates that descriptor, so adding a
 * future breakdown line is a one-line config change here, never a JSX edit (the item's core "configurable
 * Calculation-Breakdown-Display framework").
 *
 * DB-free client component: every figure arrives as a prop (the server already ran leaveEntitlementBreakdown +
 * leaveBalances and filtered the loaded requests). No formula is computed here — a field either PICKS an
 * already-computed value or renders an em-dash placeholder for a label whose mapping is deferred.
 *
 * ESS gating (65dec703): on /me (`applyEssConfig`) each section/field is gated against the leave type's
 * resolved ess-view config (missing key ⇒ visible); admin/HR pass it false and see everything.
 * Visual (639fdf77): the header shows the per-type icon + colour chip.
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui';
import { leaveVisual } from '@/lib/leave-visual';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  type PanelData,
  type PanelField,
  type PanelSection,
  type PanelSummary,
  type UpcomingLeaveItem,
} from './entitlement-panel-config';

const ENTRY_KEYS: Record<string, string> = {
  accrual: 'accrual',
  debit: 'debit',
  adjustment: 'adjustment',
  in_lieu_accrual: 'inLieuAccrual',
};

const PLACEHOLDER = '—';

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 text-sm ${strong ? 'font-semibold' : ''}`}>
      <span className={strong ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium text-foreground'} ${strong ? 'font-semibold' : ''}`}>
        {value}
      </span>
    </div>
  );
}

export function LeaveDetailsPanel({
  data,
  summary,
  upcoming,
  visual,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
}: {
  data: EntitlementBreakdownData;
  summary: PanelSummary;
  upcoming: UpcomingLeaveItem[];
  /** Display-only per-type theming (639fdf77). Unconfigured ⇒ code-keyed default icon, no chip. */
  visual: { color: string | null; icon: string | null; code: string | null };
  asOf: string;
  action: string;
  hiddenParams?: Record<string, string>;
  applyEssConfig?: boolean;
}) {
  const t = useTranslations('leave.breakdown');
  const fmtDays = (n: number) => n.toFixed(2);

  const panel: PanelData = { breakdown: data, summary, upcoming };
  // ESS gate: shown when config is not applied (admin) OR the key is not explicitly false (missing ⇒ visible).
  const show = (key?: string) => !applyEssConfig || key == null || data.essView?.[key as keyof typeof data.essView] !== false;

  const iconVisual = leaveVisual({ color: visual.color, icon: visual.icon, code: visual.code });
  const HeaderIcon = iconVisual.Icon;

  // Resolve a field to its display string (or null when it should be OMITTED entirely, §7 omitWhenNull).
  const fieldValue = (f: PanelField): string | null => {
    const raw = f.select ? f.select(panel) : undefined;
    if (raw === undefined) return PLACEHOLDER; // configured label, mapping deferred
    if (raw === null) {
      if (f.omitWhenNull) return null;
      return f.format === 'date' ? t('noExpiry') : PLACEHOLDER;
    }
    if (f.format === 'date') return String(raw);
    return typeof raw === 'number' ? fmtDays(raw) : String(raw);
  };

  const renderFields = (section: PanelSection) => {
    const fields = (section.fields ?? []).filter((f) => show(f.essKey));
    const rows = fields
      .map((f) => ({ f, value: fieldValue(f) }))
      .filter((r) => r.value !== null); // omitWhenNull drop
    if (rows.length === 0) return null;
    return (
      <div className="divide-y divide-border">
        {rows.map(({ f, value }) => (
          <Row
            key={f.key}
            label={t(f.labelKey)}
            value={value!}
            muted={value === PLACEHOLDER || (f.format === 'date' && value === t('noExpiry'))}
          />
        ))}
      </div>
    );
  };

  const renderUpcoming = () => {
    if (upcoming.length === 0) {
      return <p className="text-xs text-muted-foreground">{t('noUpcoming')}</p>;
    }
    return (
      <ul className="space-y-1.5 text-sm">
        {upcoming.map((u, i) => (
          <li key={`${u.startDate}-${i}`} className="flex items-baseline justify-between gap-3">
            <span className="tabular-nums text-foreground">
              {u.startDate}
              {u.endDate !== u.startDate && <span className="text-muted-foreground"> – {u.endDate}</span>}
            </span>
            <span className="tabular-nums text-muted-foreground">{t('daysCount', { count: u.days })}</span>
          </li>
        ))}
      </ul>
    );
  };

  const renderTransactions = () => {
    if (data.transactions.length === 0) {
      return <p className="text-xs text-muted-foreground">{t('noTransactions')}</p>;
    }
    // Balance Change = the signed day delta; running balance is client-derived (oldest → newest).
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">{t('colDate')}</th>
              <th className="py-1 font-medium">{t('colEntry')}</th>
              <th className="py-1 text-right font-medium">{t('colBalanceChange')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.transactions.map((tx, i) => (
              <tr key={`${tx.effectiveOn}-${i}`}>
                <td className="py-1 tabular-nums text-muted-foreground">{tx.effectiveOn}</td>
                <td className="py-1">
                  <Badge>{t(`entryType.${ENTRY_KEYS[tx.entryType] ?? 'adjustment'}`)}</Badge>
                </td>
                <td className="py-1 text-right tabular-nums text-foreground">
                  {tx.days >= 0 ? `+${tx.days.toFixed(2)}` : tx.days.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const sections = [...ENTITLEMENT_PANEL_SECTIONS].sort((a, b) => a.order - b.order);

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t('viewBreakdown')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-popover text-popover-foreground shadow-lg"
          aria-describedby={undefined}
        >
          {/* Header: leave-type icon + colour chip + name, and a close button. */}
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-popover px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                <span className={iconVisual.hasColor ? `rounded-md p-1 ${iconVisual.chipClass}` : undefined}>
                  <HeaderIcon className="size-4 shrink-0" aria-hidden />
                </span>
                <span className="truncate">{data.leaveType}</span>
              </Dialog.Title>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('panelSubtitle', { date: asOf })}</p>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('close')}
                className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/40"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="space-y-5 px-5 py-4">
            {/* As-at date control — the preserved ?asOf= GET form, moved INTO the panel. */}
            <form method="GET" action={action} className="flex flex-wrap items-end gap-2">
              {Object.entries(hiddenParams).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {t('asAtDate')}
                <input
                  type="date"
                  name="asOf"
                  defaultValue={asOf}
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
              <button
                type="submit"
                className="rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted dark:hover:bg-muted/40"
              >
                {t('apply')}
              </button>
            </form>

            {sections.map((section) => {
              if (!show(section.essKey)) return null;
              let body: React.ReactNode = null;
              if (section.kind === 'upcoming') body = renderUpcoming();
              else if (section.kind === 'transactions') body = renderTransactions();
              else body = renderFields(section);
              if (body == null) return null; // a fields section with everything gated/omitted
              return (
                <section key={section.key}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(section.labelKey)}
                  </h3>
                  {body}
                </section>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
