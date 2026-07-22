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
 * state for the highlight). The panel itself is unchanged: same summary / upcoming / breakdown / as-at form /
 * ESS-view gating (65dec703) it already renders from the "View Breakdown" link on the secondary rows.
 *
 * The RSC hands each card its already-computed plain data (remaining figure + the breakdown envelope). A card
 * whose breakdown is absent OR ESS-hidden (essView.entitlementCalcBreakdown=false) renders as a static tile —
 * still shows the balance, but has nothing to open, so it is not a button. A `null` remaining (the Available
 * figure ESS-hidden for this type) renders an em-dash, never a leaked number.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { leaveVisual } from '@/lib/leave-visual';
import { LeaveDetailsPanel } from './LeaveDetailsPanel';
import type { EntitlementBreakdownData } from './EntitlementBreakdown';
import type { PanelSummary, UpcomingLeaveItem } from './entitlement-panel-config';

/** The plain envelope the RSC pre-computes so the panel can mount client-side without a DB client. */
export type LeaveCardPanel = {
  data: EntitlementBreakdownData;
  summary: PanelSummary;
  upcoming: UpcomingLeaveItem[];
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
};

export function LeaveCards({ entries }: { entries: LeaveCardEntry[] }) {
  const t = useTranslations('me');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  const fmt = (n: number | null) => (n == null ? '—' : n.toFixed(2));
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
            </button>
          );
        })}
      </div>

      {/* One controlled panel, remounted per selection (key) so its internal state resets on type switch. */}
      {selected?.panel && (
        <LeaveDetailsPanel
          key={selected.leaveTypeId}
          open={open}
          onOpenChange={setOpen}
          hideTrigger
          data={selected.panel.data}
          summary={selected.panel.summary}
          upcoming={selected.panel.upcoming}
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
