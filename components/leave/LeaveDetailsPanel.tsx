'use client';

/**
 * Leave Details Side Panel (feedback 584edf44).
 *
 * A modern slide-out RIGHT side-sheet that replaces the old inline-expand "Breakdown" card. It presents the
 * leave picture for ONE leave type, driven ENTIRELY by the declarative descriptor in
 * entitlement-panel-config.ts. The panel iterates that descriptor, so adding a future breakdown line is a
 * one-line config change here, never a JSX edit (the item's core "configurable Calculation-Breakdown-Display
 * framework").
 *
 * 1f6fd6d8 rebuilt what it renders: four overlapping sections plus a reconciliation block became ONE column
 * that adds up (Eligible → … → Available Balance). The descriptor carries the layout too — signs, the two
 * dividing rules, the emphasised result rows and the expiry note under Brought Forward Forfeited — so this
 * file stayed a renderer rather than gaining a hardcoded copy of the reporter's design.
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
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Info, X } from 'lucide-react';
import { leaveVisual } from '@/lib/leave-visual';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  type PanelData,
  type PanelField,
  type PanelSection,
  type PanelSummary,
} from './entitlement-panel-config';

const PLACEHOLDER = '—';

export function LeaveDetailsPanel({
  data,
  summary,
  visual,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
  open,
  onOpenChange,
  hideTrigger = false,
}: {
  data: EntitlementBreakdownData;
  summary: PanelSummary;
  /** Display-only per-type theming (639fdf77). Unconfigured ⇒ code-keyed default icon, no chip. */
  visual: { color: string | null; icon: string | null; code: string | null };
  asOf: string;
  action: string;
  hiddenParams?: Record<string, string>;
  applyEssConfig?: boolean;
  /** Controlled-open mode (Leave View Dashboard 6d78f373): when `open`/`onOpenChange` are supplied the caller
   *  owns the Dialog open state (e.g. a summary card that is itself the trigger). Omit both ⇒ uncontrolled,
   *  the panel manages its own open state via the internal "View Breakdown" trigger (today's behaviour). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in "View Breakdown" trigger (used with controlled-open, where an external card opens it). */
  hideTrigger?: boolean;
}) {
  const t = useTranslations('leave.breakdown');
  const fmtDays = (n: number) => n.toFixed(2);

  // Info-icon per row (b8b665ff, reworked by 2bc2f2a3): the HR-authored explanation now shows as a HOVER
  // tooltip (mouse hover / keyboard focus reveal it; a tap TOGGLES it for touch, keyed by
  // `${sectionKey}:${fieldKey}`). `pinnedRows` holds tap-toggled rows (several may stay open at once);
  // `hoverRow` is the transient hover/focus target.
  const [pinnedRows, setPinnedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const toggleRow = (rowKey: string) =>
    setPinnedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  const unpinRow = (rowKey: string) =>
    setPinnedRows((prev) => {
      if (!prev.has(rowKey)) return prev;
      const next = new Set(prev);
      next.delete(rowKey);
      return next;
    });

  const panel: PanelData = { breakdown: data, summary };
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
    // Info-icon explanations (b8b665ff, extended by 2bc2f2a3): ANY row whose field key has an HR-authored
    // explanation (79011509's store, widened to every configurable view item) shows the info icon — no longer
    // only the §7 calculation rows. §7 rows keep resolving by their legacy component key; other sections' rows
    // resolve by their own field key (= the ess-view key HR ticked in the merged admin screen). The icon is
    // hidden entirely for any row HR left blank. Read-only presentation — no persistence here.
    return (
      <div>
        {rows.map(({ f, value }) => {
          const explanation = data.formulaExplanations?.[f.key] ?? null;
          const hasExpl = !!(explanation && (explanation.description || explanation.formula));
          const rowKey = `${section.key}:${f.key}`;
          const isOpen = hasExpl && (hoverRow === rowKey || pinnedRows.has(rowKey));
          const tooltipId = `leave-expl-${section.key}-${f.key}`;
          const muted = value === PLACEHOLDER || (f.format === 'date' && value === t('noExpiry'));
          // 1f6fd6d8: the reporter's layout, rendered from the descriptor — a rule above the two subtotal
          // lines, a bolder result row for Total and Available Balance, and a signed prefix on the addends
          // so the column reads as arithmetic rather than as an unexplained list of numbers.
          const isResult = f.emphasis === 'result';
          const note = f.noteSelect ? f.noteSelect(panel) : null;
          return (
            <div key={f.key} className={`py-1.5 ${f.ruleBefore ? 'mt-1 border-t-2 border-border pt-2' : ''}`}>
              <div className={`flex items-baseline justify-between gap-3 ${isResult ? 'text-sm font-semibold' : 'text-sm'}`}>
                <span className={`flex items-center gap-1 ${isResult ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {f.sign && (
                    <span aria-hidden className="w-2 shrink-0 tabular-nums">
                      {f.sign === '+' ? '+' : '−'}
                    </span>
                  )}
                  {t(f.labelKey)}
                  {/* §1 Leave Summary (877f2f37): a STATIC hover tooltip on the row — fixed plain-English copy,
                      no HR config. Suppressed when HR authored a custom explanation for this row (2bc2f2a3:
                      one icon per row — the HR content supersedes the generic copy). */}
                  {f.tooltipKey && !hasExpl && (
                    <span
                      title={t(f.tooltipKey)}
                      aria-label={t(f.tooltipKey)}
                      className="shrink-0 cursor-help text-muted-foreground/70"
                    >
                      <Info className="size-3.5" aria-hidden />
                    </span>
                  )}
                  {/* HR explanation (2bc2f2a3): hover/focus shows the tooltip, tap/click toggles it (touch),
                      Escape dismisses. Description and Formula render on separate lines. */}
                  {hasExpl && (
                    <span className="relative shrink-0">
                      <button
                        type="button"
                        onClick={() => toggleRow(rowKey)}
                        onMouseEnter={() => setHoverRow(rowKey)}
                        onMouseLeave={() => setHoverRow((cur) => (cur === rowKey ? null : cur))}
                        onFocus={() => setHoverRow(rowKey)}
                        onBlur={() => setHoverRow((cur) => (cur === rowKey ? null : cur))}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setHoverRow((cur) => (cur === rowKey ? null : cur));
                            unpinRow(rowKey);
                          }
                        }}
                        aria-expanded={isOpen}
                        aria-describedby={isOpen ? tooltipId : undefined}
                        aria-label={isOpen ? t('explanationHide') : t('explanationShow')}
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/40"
                      >
                        <Info className="size-3.5" aria-hidden />
                      </button>
                      {isOpen && (
                        <div
                          id={tooltipId}
                          role="tooltip"
                          className="absolute left-0 top-full z-20 mt-1 w-64 space-y-1 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-muted-foreground shadow-md"
                        >
                          {explanation!.description && (
                            <p>
                              <span className="font-medium text-foreground">{t('explanationDescription')}: </span>
                              {explanation!.description}
                            </p>
                          )}
                          {explanation!.formula && (
                            <p>
                              <span className="font-medium text-foreground">{t('explanationFormula')}: </span>
                              {explanation!.formula}
                            </p>
                          )}
                        </div>
                      )}
                    </span>
                  )}
                </span>
                <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>
                  {value}
                </span>
              </div>
              {/* 1f6fd6d8: the carry-expiry date sits UNDER the Brought Forward Forfeited figure it explains
                  ("Expires: 31/08/2026"), rather than as a row of its own that a reader has to connect back. */}
              {note && f.noteLabelKey && (
                <p className="mt-0.5 pl-3 text-xs text-muted-foreground">{t(f.noteLabelKey, { date: note })}</p>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Itemised data-derived rows (feedback 0315dac7): the config adjustments behind §4's Adjustment figure, one
  // row per grant carrying the reason HR typed and its own day count, so every adjusted day is traceable back
  // to the Adjustment configuration that created it. Deliberately NARROW — config adjustments only, NOT a
  // revival of the removed §6 generic transaction table. Labels here are USER DATA (a typed reason), so they
  // are rendered verbatim; only the "no reason given" fallback is translated.
  const renderItems = (section: PanelSection) => {
    if (!section.itemsSelect || !show(section.itemsEssKey)) return null;
    const items = section.itemsSelect(panel);
    if (items.length === 0) return null;
    return (
      <ul className="mt-1 space-y-1 border-t border-border pt-1.5">
        {items.map((it) => (
          <li key={it.key} className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 text-muted-foreground">
              <span className="break-words">{it.label || t('adjustmentNoReason')}</span>
              {it.note && <span className="ml-1 text-muted-foreground/70">({it.note})</span>}
            </span>
            <span className="shrink-0 tabular-nums text-foreground">
              {it.value > 0 ? `+${fmtDays(it.value)}` : fmtDays(it.value)}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  // Upcoming Leave renderer REMOVED (feedback 11876072): the §5 'upcoming' section descriptor was dropped from
  // entitlement-panel-config.ts (with its `upcomingApprovedLeave` ess-view key), so the panel no longer lists
  // approved-future requests here. The requests themselves are untouched — the /leave history still shows them.
  // Transaction History renderer REMOVED (feedback 1dd4d827): the 'transactions' section descriptor was dropped
  // from entitlement-panel-config.ts, so the panel no longer surfaces the leave ledger here. Ledger data on
  // `data.transactions` is untouched and still powers the /leave Leave History table.

  const sections = [...ENTITLEMENT_PANEL_SECTIONS].sort((a, b) => a.order - b.order);

  // Controlled when the caller drives `open` (a card owns the state for its highlight); else uncontrolled.
  const rootProps = open !== undefined ? { open, onOpenChange } : {};

  return (
    <Dialog.Root {...rootProps}>
      {!hideTrigger && (
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('viewBreakdown')}
          </button>
        </Dialog.Trigger>
      )}
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
              // Every remaining section is plain field rows (the 'upcoming'/'transactions' kinds are removed),
              // optionally followed by data-derived item rows (§4's itemised config adjustments, 0315dac7).
              const body = renderFields(section);
              const items = renderItems(section);
              if (body == null && items == null) return null; // everything gated/omitted
              return (
                <section key={section.key}>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(section.labelKey)}
                  </h3>
                  {/* 0315dac7: the reconciliation block spells its formula out in words under the heading. */}
                  {section.captionKey && (
                    <p className="mb-1.5 text-xs text-muted-foreground">{t(section.captionKey)}</p>
                  )}
                  {body}
                  {items}
                </section>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
