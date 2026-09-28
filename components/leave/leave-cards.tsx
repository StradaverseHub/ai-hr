'use client';

/**
 * "My Leave" summary cards (Leave View Dashboard 6d78f373).
 *
 * The full-width row of PRIMARY leave-type cards at the top of the My Absence page (/leave — relocated from
 * the /me Leave tab by a7cbd895, nav-only move). Each card shows the
 * per-type icon, the remaining balance, and the leave-type name over a colour-coded background (reusing the
 * shared lib/leave-visual resolver so cards speak the same visual language as the side-sheet header + chips).
 *
 * INTERACTION (the reporter's expected_function §1): clicking a card HIGHLIGHTS it and opens THAT type's full
 * details in the existing right-side slide-out panel (components/leave/LeaveDetailsPanel) with NO page refresh —
 * it drives the panel in controlled-open mode (the card is the trigger, this island owns the open + selected
 * state for the highlight). The panel itself is unchanged: same summary / breakdown / as-at form /
 * ESS-view gating (65dec703) it already renders from the "View Breakdown" link on the secondary rows.
 *
 * The RSC hands each card its already-computed plain data (remaining figure + the breakdown envelope). A card
 * whose breakdown is absent OR whose every Leave Summary line HR has hidden (essViewHasAnyVisibleRow, 1f6fd6d8)
 * renders as a static tile —
 * still shows the balance, but has nothing to open, so it is not a button. A `null` remaining (the Available
 * figure ESS-hidden for this type) renders an em-dash, never a leaked number.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers } from 'lucide-react';
import { leaveVisual } from '@/lib/leave-visual';
// 4a1abc4a: the card's figure is the same number the panel behind it shows, so it must print identically.
import { formatDays } from '@/lib/day-format';
import { LeaveDetailsPanel } from './LeaveDetailsPanel';
import { ReplacementLeavePanel, type ReplacementPanelData } from './ReplacementLeavePanel';
import type { SharedLeaveGroupEntry } from './shared-leave-group-entry';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';
import type { PanelSummary } from './entitlement-panel-config';

/** The plain envelope the RSC pre-computes so the panel can mount client-side without a DB client. */
export type LeaveCardPanel = {
  data: EntitlementBreakdownData;
  summary: PanelSummary;
  visual: { color: string | null; icon: string | null; code: string | null };
  asOf: string;
};

export type LeaveCardEntry = {
  leaveTypeId: string;
  leaveType: string;
  color: string | null;
  icon: string | null;
  code: string | null;
  /** Remaining balance to show on the card. `null` ⇒ the Available figure is ESS-hidden ⇒ render "—". */
  remaining: number | null;
  /** The breakdown envelope the panel needs; `null` ⇒ no breakdown loaded or ESS-hidden ⇒ static tile. */
  panel: LeaveCardPanel | null;
  /**
   * 00307068 — Replacement Leave's card opens a DIFFERENT panel: the per-credit table, not the nine-line
   * Leave Balance Summary. Non-null on the REPLACEMENT card only; every other type sees this field absent
   * and its behaviour is byte-identical to before.
   *
   * It sits BESIDE `panel` rather than replacing it because the card's clickability, its highlight and its
   * remaining figure are all still driven by `panel` — the type's balance envelope is the same, only the
   * body of the side-sheet differs.
   */
  replacement?: ReplacementPanelData | null;
  /**
   * 5ff7daff — the days still WAITING on a line manager, shown as a second line under the card's balance.
   * Non-null on the Replacement Leave card only. It is deliberately not added into `remaining`: nothing is
   * banked until the manager approves, and a card that counted unapproved claims as spendable balance would
   * disagree with what the apply popup will actually let the employee book. 0 renders nothing at all — a
   * permanent "0.00 in lieu" on a card is noise for the employees who never claim.
   */
  pendingInLieu?: number | null;
};

export function LeaveCards({
  entries,
  // 46afcc48 — shared leave groups placed PRIMARY render as NON-clickable tiles appended to this same grid,
  // so a pooled balance shows INSIDE the "My Leave Balance" row instead of a separate "Shared leave
  // balances" category. Presentation only: the figures arrive pre-computed (sharedGroupAvailableDays) and
  // are the same numbers my-leave-dashboard.tsx draws for a group placed SECONDARY. (That sentence used
  // to name <SharedLeaveGroupCards>; r302 folded both placements into the one dashboard grid and r356
  // deleted the component, which had rendered nowhere since.) A group is a pooled ceiling, not a ledger,
  // so it has nothing to open — hence a static tile, never a button.
  sharedGroups,
}: {
  entries: LeaveCardEntry[];
  sharedGroups?: SharedLeaveGroupEntry[];
}) {
  const t = useTranslations('me');
  // 5ff7daff — the replacement-leave wording lives with the panel's own keys, so the card's "in lieu" line
  // and the panel it opens can never call the same stage two different things.
  const tRep = useTranslations('leave.breakdown.replacement');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (entries.length === 0 && (sharedGroups == null || sharedGroups.length === 0)) return null;

  // null ⇒ the Available figure is ESS-hidden ⇒ em dash, never a leaked (or invented) number.
  const fmt = (n: number | null) => formatDays(n);
  const selected = entries.find((e) => e.leaveTypeId === selectedId) ?? null;

  const openCard = (e: LeaveCardEntry) => {
    if (!e.panel) return;
    setSelectedId(e.leaveTypeId);
    setOpen(true);
  };

  return (
    <section>
      <h2 className="text-sm font-semibold">{t('myLeaveHeading')}</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {entries.map((e) => {
          const v = leaveVisual({ color: e.color, icon: e.icon, code: e.code });
          const Icon = v.Icon;
          const isSelected = e.leaveTypeId === selectedId;
          const clickable = e.panel != null;
          const bgClass = v.hasColor ? v.chipClass : 'bg-muted/50 text-foreground';
          return (
            <button
              key={e.leaveTypeId}
              type="button"
              onClick={() => openCard(e)}
              disabled={!clickable}
              aria-pressed={isSelected}
              className={[
                'flex flex-col items-start gap-2 rounded-xl p-4 text-left transition',
                bgClass,
                clickable ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
                isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'ring-0',
              ].join(' ')}
            >
              <Icon className="size-5 shrink-0" aria-hidden />
              <span className="text-2xl font-semibold tabular-nums">{fmt(e.remaining)}</span>
              <span className="line-clamp-2 text-xs font-medium">{e.leaveType}</span>
              {/* The awaiting-approval half of the two-stage view — the employee's own acknowledgement that
                  the request they just submitted exists. Until this round nothing on My Leave said so. */}
              {e.pendingInLieu != null && e.pendingInLieu > 0 && (
                <span className="text-[11px] font-medium opacity-75">
                  {tRep('cardPending', { days: formatDays(e.pendingInLieu) })}
                </span>
              )}
            </button>
          );
        })}
        {/* 46afcc48 — PRIMARY shared leave groups, appended to the same grid as static (non-clickable)
            tiles. Same visual as the dashboard's own pooled tile (my-leave-dashboard.tsx; it was
            <SharedLeaveGroupCards> until r356 deleted that dead component): Layers icon, the drawable figure,
            the "of N shared" ceiling as context BESIDE it (never in place of it), the group name, its
            member list and the per-application cap when set. Nothing to open — a group is a pooled
            ceiling, not a ledger — so it is a plain div, not a button. */}
        {sharedGroups?.map((g) => (
          <div
            key={g.id}
            className="flex flex-col items-start gap-2 rounded-xl bg-muted/50 p-4 text-foreground"
          >
            <Layers className="size-5 shrink-0" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">{formatDays(g.available)}</span>
            <span className="text-xs text-muted-foreground">{g.limitLabel}</span>
            <span className="line-clamp-2 text-xs font-medium">{g.name}</span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{g.membersLabel}</span>
            {g.capLabel && <span className="text-xs text-muted-foreground">{g.capLabel}</span>}
          </div>
        ))}
      </div>

      {/* 00307068: Replacement Leave opens the per-credit table instead of the summary panel. The branch is
          HERE, at the one place that decides which side-sheet a card opens, rather than inside
          LeaveDetailsPanel — that file's whole design is a descriptor loop with no leave-type conditionals
          in it (584edf44), and adding the first one would be the end of that property. Same controlled-open
          contract, same remount-per-selection key. */}
      {selected?.panel && selected.replacement && (
        <ReplacementLeavePanel
          key={selected.leaveTypeId}
          open={open}
          onOpenChange={setOpen}
          leaveTypeName={selected.leaveType}
          visual={selected.panel.visual}
          asOf={selected.panel.asOf}
          available={selected.remaining}
          data={selected.replacement}
        />
      )}

      {/* One controlled panel, remounted per selection (key) so its internal state resets on type switch. */}
      {selected?.panel && !selected.replacement && (
        <LeaveDetailsPanel
          key={selected.leaveTypeId}
          open={open}
          onOpenChange={setOpen}
          hideTrigger
          data={selected.panel.data}
          summary={selected.panel.summary}
          visual={selected.panel.visual}
          asOf={selected.panel.asOf}
          // a7cbd895: the cards live on /leave (My Absence) now — the panel's as-at GET form posts back
          // there (no ?tab= needed; /leave is not tabbed).
          action="/leave"
          applyEssConfig
        />
      )}
    </section>
  );
}
