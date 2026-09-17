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
 *
 * r303 (31492f74) — HR'S SENTENCES. On the two HR mounts (`hrExplanation` set) each of the nine rows loses its
 * info icon and gains the sentences lib/leave-summary-explain.ts renders from the breakdown's `derivation`: how
 * THIS employee's figure was reached, not what the line means in general. An HR-authored explanation (Leave
 * Entitlement Formula Management) still shows, as a plain paragraph under the generated sentences. Without the
 * prop — every employee mount — the panel renders exactly what it rendered before r303 (pinned byte for byte by
 * test/r303-leave-summary-explain.dom.test.tsx against markup captured on the base).
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useLocale, useTranslations } from 'next-intl';
import { Info, X } from 'lucide-react';
import { leaveVisual } from '@/lib/leave-visual';
// 4a1abc4a: every day figure in this column goes through the ONE shared formatter, so the panel and the
// balance grid behind it cannot print the same number two ways.
import { DAY_DASH, formatDays } from '@/lib/day-format';
import type { EntitlementBreakdownData, HrLeaveSummaryExplanation } from './EntitlementBreakdown';
import { explainLeaveSummary, type ExplainArg, type ExplainStep, type LeaveSummaryLineKey } from '@/lib/leave-summary-explain';
import {
  entitlementStatusNeedsNotice,
  ELIGIBILITY_AXIS_LABEL_KEY,
  type EligibilityNotice,
  type EligibilityRuleNotice,
  type EntitlementStatus,
} from '@/lib/entitlement-status';
import {
  ENTITLEMENT_PANEL_SECTIONS,
  type PanelData,
  type PanelField,
  type PanelSection,
  type PanelSummary,
} from './entitlement-panel-config';

// The em dash this panel has always used for "no figure" — now the shared constant, so a row whose
// mapping is deferred and a null balance elsewhere are visibly the same kind of nothing.
const PLACEHOLDER = DAY_DASH;

// 31e39d74 — the states that need saying out loud, and their copy under `leave.breakdown`.
//
// WHY THIS IS A BANNER AND NOT A DESCRIPTOR FIELD. ENTITLEMENT_PANEL_SECTIONS is a list of FIGURES that
// add up to Available Balance (see entitlement-panel-config.ts); every entry is a signed addend of the
// reconciliation identity. This is not a figure — it is the reason a figure is 0.00 — so declaring it
// there would put a non-addend in a column whose whole property is that it closes. The 584edf44 mandate
// ("a future breakdown LINE is one config entry, never a JSX change") is about lines of the calculation
// and is untouched: no formula is computed here and nothing is hardcoded but the copy key.
//
// FOUR ENTRIES, NOT TWO, AND THE TWO ADDED ARE THE POINT: `earned_accrual` and `zero_entitlement` are
// states where pressing Generate Entitlement does NOTHING (core/leave.ts logs `earned_method` /
// `no_entitlement` and writes no row), so they must never borrow `not_generated`'s copy — that copy names
// a remedy. See lib/entitlement-status.ts for the full branch table. The map is exhaustive over
// `entitlementStatusNeedsNotice`, and the test file pins that so a sixth status cannot land captionless.
const PANEL_STATUS_COPY: Partial<Record<EntitlementStatus, { title: string; body: string }>> = {
  not_generated: { title: 'statusNotGeneratedTitle', body: 'statusNotGeneratedBody' },
  earned_accrual: { title: 'statusEarnedAccrualTitle', body: 'statusEarnedAccrualBody' },
  // r299 (3de1453a) — an earned method on a type that is not Annual Leave. It may NOT borrow `earned_accrual`'s
  // copy: that copy promises days "as each accrual run posts them", and no run posts anything for this type.
  earned_method_not_annual_leave: { title: 'statusEarnedMethodNotAnnualLeaveTitle', body: 'statusEarnedMethodNotAnnualLeaveBody' },
  zero_entitlement: { title: 'statusZeroEntitlementTitle', body: 'statusZeroEntitlementBody' },
  earning_method_missing: { title: 'statusEarningMethodMissingTitle', body: 'statusEarningMethodMissingBody' },
  // r209 — the three states 31e39d74 could not distinguish, and the reason it could not: `not_configured`
  // was one bucket for "there is no day table" AND "there are six and none of them reaches you", and it was
  // SILENT. `capped_by_max_balance` was not a state at all — a cap of 0 grants, clamps, writes its accrual
  // row and reads as `granted` over a figure of 0.00. None of the three borrows another's copy, for the same
  // reason `earned_accrual` may not borrow `not_generated`'s: each names a DIFFERENT thing to go and fix.
  no_entitlement_table: { title: 'statusNoEntitlementTableTitle', body: 'statusNoEntitlementTableBody' },
  no_eligibility_match: { title: 'statusNoEligibilityMatchTitle', body: 'statusNoEligibilityMatchBody' },
  capped_by_max_balance: { title: 'statusCappedByMaxBalanceTitle', body: 'statusCappedByMaxBalanceBody' },
};

/**
 * r212 (8ebf77ae) — THE FIVE STATES OF A RULE, EACH WITH ITS OWN SENTENCE.
 *
 * `statusNoEligibilityMatchBody` above already tells the employee that no rule reaches them and asks an
 * administrator to "check whether the rule has expired or narrows to a group you are not in". That is the
 * whole of what the screen could say, because the status is one word and the reasons are a list — so the
 * reporter's original request ("say WHICH rules exist and what about me did not match") had nowhere to go.
 * This map is the list's vocabulary, and it is deliberately not collapsed: an EXPIRED rule and a rule that
 * simply excludes you call for opposite actions, and flattening them is what left a whole tenant reading
 * 0.00 for six days after one `valid_to` passed.
 *
 * `{date}` is interpolated for the two dated states and ignored by the other three, so one call site can
 * pass it unconditionally.
 */
const RULE_STATE_COPY: Record<EligibilityRuleNotice['state'], string> = {
  matched: 'eligibilityStateMatched',
  in_force: 'eligibilityStateInForce',
  expired: 'eligibilityStateExpired',
  not_yet: 'eligibilityStateNotYet',
  table_stopped: 'eligibilityStateTableStopped',
};

export function LeaveDetailsPanel({
  data,
  summary,
  visual,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
  eligibility,
  open,
  onOpenChange,
  hideTrigger = false,
  hideAsOfForm = false,
  footnote = null,
  triggerLabel,
  triggerClassName,
  hrExplanation,
}: {
  data: EntitlementBreakdownData;
  summary: PanelSummary;
  /** Display-only per-type theming (639fdf77). Unconfigured ⇒ code-keyed default icon, no chip. */
  visual: { color: string | null; icon: string | null; code: string | null };
  asOf: string;
  action: string;
  /** A value may REPEAT (a multi-select filter posts one param per ticked value), so an array is a
   *  first-class value here — flattening it to a single string would silently drop the rest. */
  hiddenParams?: Record<string, string | string[]>;
  applyEssConfig?: boolean;
  /**
   * r212 (8ebf77ae) — WHICH ELIGIBILITY RULES EXIST FOR THIS LEAVE TYPE, AND WHY EACH ONE MISSED YOU.
   *
   * Plain already-resolved data (`lib/entitlement-status.ts`), computed server-side by
   * `explainEntitlementEligibility` + `eligibilityNoticeFrom` (core/entitlement-template.ts) — the SAME
   * `resolveOrgCriteriaTargets` calls the resolver decides with, never a second matcher. Nothing here
   * recomputes eligibility; this component only renders sentences.
   *
   * WHERE IT COMES FROM: `leaveEntitlementBreakdown` (core/read.ts) attaches it to the breakdown — and only
   * where the status is `no_eligibility_match`, which is the one state that means "tables exist and nothing
   * reached you" — and `EntitlementBreakdown` hands it down here. So every caller of that adapter (/leave,
   * the employee balances screen, /admin/personnel/[id]) gets it without knowing about it.
   *
   * OPTIONAL, and absent is a legitimate value: `components/leave/leave-cards.tsx` mounts this panel from a
   * row that carries no breakdown of its own, and it shows exactly what it showed before. Deliberately NOT
   * ESS-gated — an employee whose leave resolves to nothing is precisely the person these sentences are
   * for, which is the same argument the status notice above is ungated on.
   */
  eligibility?: EligibilityNotice;
  /** Controlled-open mode (Leave View Dashboard 6d78f373): when `open`/`onOpenChange` are supplied the caller
   *  owns the Dialog open state (e.g. a summary card that is itself the trigger). Omit both ⇒ uncontrolled,
   *  the panel manages its own open state via the internal "View Breakdown" trigger (today's behaviour). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Hide the built-in "View Breakdown" trigger (used with controlled-open, where an external card opens it). */
  hideTrigger?: boolean;
  /**
   * r302 (6c9802c9) — hide the as-at date form. My Leave replaced "As at" with a Year selector: the panel there
   * shows one leave year's figures, read at that year's last day, and an as-at form beside them would post a
   * date nothing on the page reads. Omit it and every other host is byte-identical.
   */
  hideAsOfForm?: boolean;
  /** r302 hand-fix — one plain line under the column (My Leave: what the card's Balance counts beyond this leave
   *  year, so the column that adds up and the card's figure are never left to contradict each other silently). */
  footnote?: string | null;
  /**
   * r242 — the built-in trigger's CAPTION and CLASSES, for a host whose surface names this affordance
   * differently. Employee Balances puts it in a table cell under an "Explanation" heading, where the
   * default stacked "Breakdown" link reads as a stray word and its `mt-2` fights the row.
   *
   * A PLAIN STRING, resolved by the caller — never a translator function. Handing a client island a
   * closure across the RSC boundary is a 500 on every request that tsc, the suite and `next build` all
   * stay green through (r123). Omit BOTH and this component is byte-identical to what /me, /leave and
   * the personnel record render today; that is the property that keeps this an addition, not a change.
   */
  triggerLabel?: string;
  triggerClassName?: string;
  /**
   * r303 (31492f74) — HR MOUNTS ONLY. Replaces each row's info icon with sentences written from this employee's
   * own records (see the header). A plain object built on the server — no closure crosses the boundary (r123).
   * Omit it and nothing about this panel changes.
   */
  hrExplanation?: HrLeaveSummaryExplanation;
}) {
  const t = useTranslations('leave.breakdown');
  const locale = useLocale();
  /**
   * r212 — THE CRITERIA AXIS NAMES, READ FROM WHERE THEY ALREADY LIVE.
   *
   * "Employment Type", "Division", "Job Grade" are the rule editor's own picker labels and they are already
   * shipped in six locales under these two namespaces. This panel resolves them through
   * `ELIGIBILITY_AXIS_LABEL_KEY` — the map that `test/r212-leave-type-inherited-conditions.test.ts` pins,
   * field by field, against `buildOrgCriteriaSections`'s real output. Minting a third set of axis names
   * under `leave.breakdown` is how r127 shipped a screen that rendered entirely through `MISSING_MESSAGE`
   * behind a green 200.
   */
  const tCriteria = useTranslations('admin.leave.adjustmentsCriteria');
  const tOrgCategory = useTranslations('admin.profileOptions.category');
  const axisLabel = (axis: string | null): string | null => {
    const k = axis ? ELIGIBILITY_AXIS_LABEL_KEY[axis] : undefined;
    if (!k) return null;
    return k.ns === 'criteria' ? tCriteria(k.key) : tOrgCategory(k.key);
  };
  const fmtDays = (n: number) => formatDays(n);

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
  // r303 — HR's per-line sentences, or null on every employee mount. Rendered from the figures this panel already
  // shows plus the breakdown's own derivation; nothing is looked up or recomputed here.
  const explained = hrExplanation
    ? explainLeaveSummary(data, { available: summary.available, sharedBalance: hrExplanation.sharedBalance })
    : null;
  // Typed step arguments → display strings. Day figures go through the ONE shared formatter (4a1abc4a).
  const explainValues = (args?: Record<string, ExplainArg>) => {
    const out: Record<string, string | number> = {};
    for (const [k, a] of Object.entries(args ?? {})) {
      if ('days' in a) out[k] = fmtDays(a.days);
      else if ('signedDays' in a) out[k] = a.signedDays > 0 ? `+${fmtDays(a.signedDays)}` : fmtDays(a.signedDays);
      else if ('date' in a) out[k] = a.date;
      else if ('text' in a) out[k] = a.text;
      else if ('count' in a) out[k] = a.count;
      else if ('choice' in a) out[k] = a.choice;
      else out[k] = new Intl.ListFormat(locale, { type: 'conjunction' }).format(a.list);
    }
    return out;
  };
  const explainText = (s: ExplainStep) => t(`explain.${s.key}`, explainValues(s.args));
  // Consecutive `item` steps are one list under the sentence before them (a credit, an adjustment, a request).
  const renderExplanation = (steps: ExplainStep[]) => {
    const out: ReactNode[] = [];
    let items: ExplainStep[] = [];
    const flush = (at: number) => {
      if (items.length === 0) return;
      out.push(
        <ul key={`list-${at}`} className="space-y-0.5 pl-3 tabular-nums">
          {items.map((it, i) => (
            <li key={i}>{explainText(it)}</li>
          ))}
        </ul>,
      );
      items = [];
    };
    steps.forEach((step, i) => {
      if (step.item) {
        items.push(step);
        return;
      }
      flush(i);
      out.push(<p key={i}>{explainText(step)}</p>);
    });
    flush(steps.length);
    return out;
  };
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
                  {/* r303: on the HR mounts the generated sentences below replace the icon. */}
                  {!explained && f.tooltipKey && !hasExpl && (
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
                  {!explained && hasExpl && (
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
              {/* r303 — HR only: how THIS employee's figure was reached, then HR's own explanation (if written)
                  as a plain paragraph. No icon, no hover: the reader asked "why this number", so it is on the page. */}
              {explained && (
                <div data-testid={`leave-explain-${f.key}`} className="mt-1 space-y-1 pl-3 text-xs text-muted-foreground">
                  {renderExplanation(explained[f.key as LeaveSummaryLineKey] ?? [])}
                  {hasExpl && (
                    <p data-testid={`leave-explain-hr-${f.key}`} className="border-l-2 border-border pl-2">
                      {explanation!.description && (
                        <span className="block">
                          <span className="font-medium text-foreground">{t('explanationDescription')}: </span>
                          {explanation!.description}
                        </span>
                      )}
                      {explanation!.formula && (
                        <span className="block">
                          <span className="font-medium text-foreground">{t('explanationFormula')}: </span>
                          {explanation!.formula}
                        </span>
                      )}
                    </p>
                  )}
                </div>
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
            className={triggerClassName ?? 'mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline'}
          >
            {triggerLabel ?? t('viewBreakdown')}
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
            {!hideAsOfForm && (
            <form method="GET" action={action} className="flex flex-wrap items-end gap-2">
              {Object.entries(hiddenParams).flatMap(([k, v]) =>
                (Array.isArray(v) ? v : [v]).map((one, i) => (
                  <input key={`${k}-${i}`} type="hidden" name={k} value={one} />
                )),
              )}
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
            )}

            {/* 31e39d74 — "configured but not yet generated", said before the column of figures rather than
                left to be inferred from a 0.00 inside it. Named alongside the entitlement TABLE that is
                waiting, so HR knows which one. Deliberately NOT ESS-gated: an employee whose entitlement has
                not been generated is exactly the person this sentence is for. */}
            {entitlementStatusNeedsNotice(data.entitlementStatus) && (
              <div
                role="status"
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <p className="font-medium">{t(PANEL_STATUS_COPY[data.entitlementStatus]!.title)}</p>
                {/* 6aee1d91 — `typeName` is read by the no-scheme body only ("No benefit scheme covers you
                    for {typeName}"); ICU ignores it on the others, so one call site serves every status. */}
                <p className="mt-0.5">
                  {t(PANEL_STATUS_COPY[data.entitlementStatus]!.body, { typeName: data.leaveType })}
                </p>
                {data.entitlementTemplateName && (
                  <p className="mt-0.5 opacity-80">
                    {t('statusEntitlementTable', { name: data.entitlementTemplateName })}
                  </p>
                )}
                {/* r212 (8ebf77ae) — the reporter's original ask: "No eligibility rule reaches you" naming
                    the rules that exist, saying which are in force, and for each one in force the FIRST
                    thing about this employee that does not match. Rendered inside the notice it explains,
                    not as a section of its own: it is the reason for the figure, not a figure.

                    ⚠️ THE VERDICT IS READ, NOT RE-DERIVED. `eligibilityNoticeFrom` decides it once for both
                    screens; this panel and the admin explain panel each testing their own `if` order over
                    the same object is exactly how they came to describe one configuration two ways.
                    `resolved` / `sole_table` render NOTHING here on purpose: `core/read.ts` attaches this
                    notice only where the engine resolved nothing, so a verdict that names a winner belongs
                    to a status this block is not explaining. */}
                {/* 76ffdcf2 — `default_table` joins that list for the same reason: a default table IS a
                    winner, so an explanation of why nothing reached this employee does not apply to it. */}
                {eligibility &&
                  eligibility.verdict !== 'resolved' &&
                  eligibility.verdict !== 'sole_table' &&
                  eligibility.verdict !== 'default_table' && (
                  <div className="mt-2 border-t border-current/20 pt-2">
                    {eligibility.verdict === 'not_active' ? (
                      <p>{t('eligibilityNotActive', { date: asOf })}</p>
                    ) : eligibility.verdict === 'no_rules' ? (
                      <p>{t('eligibilityNoRules')}</p>
                    ) : (
                      <>
                        <p className="font-medium">{t('eligibilityRulesTitle')}</p>
                        <ul className="mt-1 space-y-1">
                          {eligibility.rules.map((r) => (
                            /* KEYED ON THE LINEAGE, never on the name: nothing makes two rule names differ,
                               and two rows sharing a React key render as one. */
                            <li key={r.id}>
                              <span className="font-medium">{r.name}</span>
                              {' — '}
                              {t(RULE_STATE_COPY[r.state], { date: r.validTo ?? r.validFrom })}
                              {/* The axis this employee fails, named from the rule editor's own vocabulary.
                                  The VALUE is deliberately not quoted here: it is the reader's own record,
                                  and labelling a stored value needs the catalogue only the admin screen
                                  holds — a raw `full_time` inside a translated sentence is worse than the
                                  sentence without it. */}
                              {r.tested && axisLabel(r.failingAxis) && (
                                <span className="block opacity-90">
                                  {t('eligibilityWhyAxis', { axis: axisLabel(r.failingAxis)! })}
                                </span>
                              )}
                              {r.failsOnCombination && (
                                <span className="block opacity-90">{t('eligibilityWhyCombination')}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {/* AGENTS 28's spirit — say what the data cannot support rather than implying a precision
                        it does not have. `UNDATED_ELIGIBILITY_AXES` resolve at TODAY'S value however far back
                        the as-at date above reaches, because those columns carry no effective dating. */}
                    {eligibility.usesUndatedAxis && (
                      <p className="mt-1 opacity-80">{t('eligibilityUndatedNote')}</p>
                    )}
                  </div>
                )}
              </div>
            )}

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
            {footnote && (
              <p className="text-xs text-muted-foreground" data-testid="panel-footnote">
                {footnote}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
