'use client';

/**
 * r302 (board 6c9802c9) — My Leave: the leave balance dashboard.
 *
 * ONE card per leave type that applies to the employee, in the order the server decided (Primary before
 * Secondary; Hidden never arrives). The Annual Leave type — `annualLeave`, decided on the server by
 * isEarnedAccrualType — is drawn with the ring; every other type is a smaller card with the same figures; a type
 * with no entitlement (`takenOnly`) shows how much has been taken and nothing else.
 *
 * DB-FREE AND FORMULA-FREE. Every figure arrives computed (core/my-leave.ts) and is printed through the shared
 * day formatter; a null figure (HR hid it, or nothing could be read) prints an em dash, never a number. The
 * one piece of arithmetic here is the ring's (components/leave/leave-balance-ring.tsx): its arc proportions, and
 * Not earned yet — printed beside its own arc, from the ONE segment list the arcs are drawn from.
 *
 * r302 fix pass: for the current leave year Balance is the Apply form's balance (Balance − Pending = You can apply
 * for), and when it includes ledger rows dated after this leave year one plain line under it says so
 * (`balanceIncludesLater`, itemised on the server). The ring's legend is its arcs: Taken, Pending approval, You can
 * apply for (Remaining for an earlier year), Not earned yet.
 *
 * Each card's Details opens the SAME side-sheet the old cards opened (LeaveDetailsPanel over that year's
 * breakdown — which, for the current year, carries the card's own Pending and available figure; Replacement
 * Leave's per-credit table), with the as-at form hidden — the Year selector replaced it.
 *
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers } from 'lucide-react';
import type { MyLeaveCard } from '@/core/my-leave';
import { leaveVisual } from '@/lib/leave-visual';
import { DAY_DASH, dayPluralCategory, formatDays } from '@/lib/day-format';
import { otherContributors } from '@/lib/shared-leave-balance';
import { ENTITLEMENT_STATUS_LABEL_KEY, ENTITLEMENT_STATUS_TIP_KEY, entitlementStatusNeedsNotice } from '@/lib/entitlement-status';
import { essViewHasAnyVisibleRow } from '@/core/ess-view';
import { LeaveDetailsPanel } from './LeaveDetailsPanel';
import { ReplacementLeavePanel, type ReplacementPanelData } from './ReplacementLeavePanel';
import { LeaveBalanceRing, RING_COLORS, ringDrawable, ringSegments, type RingSegmentKey } from './leave-balance-ring';
import type { SharedLeaveGroupEntry } from './shared-leave-group-cards';

export type MyLeaveDashboardCard = MyLeaveCard & {
  /** Replacement Leave only: the per-credit table its Details opens instead of the summary side-sheet. */
  replacement?: ReplacementPanelData | null;
  /** Replacement Leave only: days claimed and still waiting on a line manager (never part of the balance). */
  pendingInLieu?: number | null;
};

export function MyLeaveDashboard({
  cards,
  sharedGroups = [],
  locale,
}: {
  cards: MyLeaveDashboardCard[];
  /** Shared leave groups HR placed Primary or Secondary, pre-translated (46afcc48) — non-clickable tiles. */
  sharedGroups?: SharedLeaveGroupEntry[];
  locale: string;
}) {
  const t = useTranslations('leave.myLeave');
  const tTable = useTranslations('me.leaveBalanceTable');
  const tBreakdown = useTranslations('leave.breakdown');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const fmt = (n: number | null | undefined) => (n == null ? DAY_DASH : formatDays(n));
  const fmtDate = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${iso}T00:00:00Z`),
      );
    } catch {
      return iso;
    }
  };

  if (cards.length === 0 && sharedGroups.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noCards')}</p>;
  }

  const ringCards = cards.filter((c) => c.annualLeave && !c.takenOnly && ringDrawable(c));
  const otherCards = cards.filter((c) => !ringCards.includes(c));
  const selected = cards.find((c) => c.leaveTypeId === selectedId) ?? null;
  const canOpen = (c: MyLeaveDashboardCard) => c.breakdown != null && (c.replacement != null || essViewHasAnyVisibleRow(c.essView));
  const openCard = (c: MyLeaveDashboardCard) => {
    setSelectedId(c.leaveTypeId);
    setOpen(true);
  };

  /**
   * 8d3a7bff — WHICH HALF OF A SHARED BALANCE THIS CARD IS.
   *
   * `leave_type.balance_source_type_id` makes one type spend another's ledger (production has two such
   * pairs: Emergency → Annual, Compassionate → Special). BOTH halves get a card, and both must: the
   * borrower is a type the employee can really apply for, and the pool is where the days live. What the
   * reporter saw was that the two cards were the same card twice — because `balanceStoryTypeId`
   * (lib/shared-leave-balance.ts) builds a borrower's figures from the POOL's breakdown, so Entitlement,
   * Earned so far, Taken, Pending and Balance printed on the borrower were the pool's, digit for digit.
   *
   * ⚠️ THE FIGURES ARE NOT THE BUG AND MUST NOT BE "FIXED" HERE. Read that file's header: giving a
   * borrower its own breakdown produced "YTD Entitled 0.00 … Balance 10.00" under a red notice telling HR
   * to create an entitlement table — the one change that would stop it borrowing. Nothing about which
   * figures are computed changes; this decides only which of them a borrower REPEATS, and what each card
   * says about the other. `null` for an ordinary type, which takes the untouched path.
   */
  const poolRole = (c: MyLeaveDashboardCard): 'pool' | 'borrower' | null =>
    c.sharedBalance == null ? null : c.sharedBalance.sourceLeaveTypeId === c.leaveTypeId ? 'pool' : 'borrower';

  /** Lines every card shares under its headline: caption, shared pool, cycle dates, Details. */
  const footer = (c: MyLeaveDashboardCard) => (
    <>
      {c.sharedBalance && otherContributors(c.sharedBalance, c.leaveType).length > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="shared-balance-caption">
          {poolRole(c) === 'borrower'
            ? t('sharedFromPool', { pool: c.sharedBalance.sourceLeaveTypeName })
            : t('sharedPoolHolder', { types: otherContributors(c.sharedBalance, c.leaveType).join(', ') })}
        </p>
      )}
      {entitlementStatusNeedsNotice(c.entitlementStatus) && (
        <p
          className="mt-2 text-[11px] text-amber-700 dark:text-amber-500"
          title={ENTITLEMENT_STATUS_TIP_KEY[c.entitlementStatus] ? tTable(ENTITLEMENT_STATUS_TIP_KEY[c.entitlementStatus]!) : undefined}
        >
          {tTable(ENTITLEMENT_STATUS_LABEL_KEY[c.entitlementStatus])}
        </p>
      )}
      {!c.cycleStart.endsWith('-01-01') && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t('cycleDates', { from: fmtDate(c.cycleStart), to: fmtDate(c.cycleEnd) })}
        </p>
      )}
      {canOpen(c) && (
        <button
          type="button"
          onClick={() => openCard(c)}
          className="mt-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
          aria-label={t('detailsFor', { type: c.leaveType })}
        >
          {t('details')}
        </button>
      )}
    </>
  );

  const row = (label: string, value: number | null | undefined) => (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="ml-auto pl-3 tabular-nums text-foreground">{fmt(value)}</dd>
    </div>
  );

  /** The one plain line under Balance when it includes ledger rows dated after this leave year (core/my-leave.ts). */
  const laterText = (c: MyLeaveDashboardCard, where: 'card' | 'panel'): string | null => {
    const later = c.balanceIncludesLater;
    if (!later || c.balance == null) return null;
    let text: string;
    if (later.itemised) {
      const parts = [
        later.granted > 0 ? t('laterGranted', { v: formatDays(later.granted), cat: dayPluralCategory(later.granted, locale) }) : null,
        later.booked > 0 ? t('laterBooked', { v: formatDays(later.booked), cat: dayPluralCategory(later.booked, locale) }) : null,
      ].filter((p): p is string => p != null);
      let joined: string;
      try {
        joined = new Intl.ListFormat(locale, { type: 'conjunction' }).format(parts);
      } catch {
        joined = parts.join(', ');
      }
      text = t(where === 'card' ? 'laterIncludes' : 'panelLaterIncludes', { span: later.span, parts: joined });
    } else {
      text = t(where === 'card' ? 'laterOther' : 'panelLaterOther');
    }
    return text;
  };
  const laterLine = (c: MyLeaveDashboardCard) => {
    const text = laterText(c, 'card');
    return text == null ? null : (
      <p className="mt-1 text-[11px] text-muted-foreground" data-testid="balance-includes-later">
        {text}
      </p>
    );
  };

  /** The ring legend's label for a segment — the same words its arc is titled with. */
  const segmentLabel = (key: RingSegmentKey, c: MyLeaveDashboardCard) =>
    key === 'taken'
      ? t('taken')
      : key === 'pending'
        ? t('pendingApproval')
        : key === 'available'
          ? c.isCurrentCycle
            ? t('canApplyFor')
            : t('remaining')
          : t('notEarnedYet');

  const canApplyLine = (c: MyLeaveDashboardCard) =>
    c.canApplyFor != null ? (
      <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-xs font-semibold" data-testid="can-apply-for">
        <span>{t('canApplyFor')}</span>
        <span className={`ml-auto tabular-nums ${c.canApplyFor < 0 ? 'text-destructive' : ''}`}>{fmt(c.canApplyFor)}</span>
      </div>
    ) : null;

  const extras = (c: MyLeaveDashboardCard) => (
    <>
      {c.expiringSoon != null && (
        <div className="flex items-center gap-2 py-0.5 text-xs">
          <span className="text-muted-foreground">{tBreakdown('field.expiringSoon')}</span>
          <span className="ml-auto tabular-nums">{fmt(c.expiringSoon)}</span>
        </div>
      )}
      {c.pendingInLieu != null && c.pendingInLieu > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">{tBreakdown('replacement.cardPending', { days: formatDays(c.pendingInLieu) })}</p>
      )}
    </>
  );

  const ringCard = (c: MyLeaveDashboardCard) => {
    // ONE list for the arcs and the legend: each legend entry is its arc's label and its arc's value.
    const segments = ringSegments(c).map((s) => ({ ...s, label: segmentLabel(s.key, c), display: fmt(s.value) }));
    return (
      <article
        key={c.leaveTypeId}
        className="flex flex-col gap-4 rounded-xl border border-border bg-background p-4 sm:flex-row sm:items-center"
        data-testid="leave-ring-card"
        aria-label={c.leaveType}
      >
        <div className="flex flex-col items-center self-center">
          <LeaveBalanceRing
            segments={segments}
            centre={fmt(c.balance)}
            centreCaption={t('balanceDays')}
            label={t('ringLabel', {
              type: c.leaveType,
              balance: fmt(c.balance),
              taken: fmt(c.taken),
              pending: fmt(c.pending),
              entitlement: fmt(c.entitlement),
              earned: fmt(c.earnedSoFar),
            })}
          />
          <div className="max-w-[12rem] text-center">{laterLine(c)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{c.leaveType}</h3>
          <dl className="mt-1.5">
            {row(t('entitlement'), c.entitlement)}
            {row(t('earnedSoFar'), c.earnedSoFar)}
            {segments.map((s) => (
              <div
                key={s.key}
                data-ring-legend={s.key}
                data-testid={s.key === 'available' && c.isCurrentCycle ? 'can-apply-for' : undefined}
                className={`flex items-center gap-2 py-0.5 text-xs ${s.key === 'available' ? 'mt-1 border-t border-border pt-1.5 font-semibold' : ''}`}
              >
                <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: RING_COLORS[s.key] }} />
                <dt className={s.key === 'available' ? 'text-foreground' : 'text-muted-foreground'}>{s.label}</dt>
                <dd className="ml-auto pl-3 tabular-nums text-foreground">{s.display}</dd>
              </div>
            ))}
          </dl>
          {extras(c)}
          {footer(c)}
        </div>
      </article>
    );
  };

  const smallCard = (c: MyLeaveDashboardCard) => {
    const v = leaveVisual({ color: c.color, icon: c.icon, code: c.code });
    const Icon = v.Icon;
    // A borrower's headline is the one figure that is ABOUT this type: how much of the pool is still
    // applicable for. For the cycle in force it is the Apply form's figure verbatim (`canApplyFor`); for an
    // earlier leave year there is no applying to do, so it is that year's Remaining — the same pair of
    // labels, chosen the same way, as the ring's third arc (`segmentLabel`).
    const borrowed = poolRole(c) === 'borrower';
    const borrowedValue = c.isCurrentCycle ? c.canApplyFor : c.remaining;
    return (
      <article
        key={c.leaveTypeId}
        className="flex flex-col rounded-xl border border-border bg-background p-3.5"
        data-testid="leave-type-card"
        aria-label={c.leaveType}
      >
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <span className={v.hasColor ? `rounded p-0.5 ${v.chipClass}` : undefined}>
            <Icon className="size-3.5 shrink-0" aria-hidden />
          </span>
          <span className="min-w-0 truncate">{c.leaveType}</span>
        </h3>
        {c.takenOnly ? (
          <>
            <p className="mt-2 text-xl font-bold tabular-nums">{fmt(c.taken)}</p>
            <p className="text-[11px] text-muted-foreground">{t('takenOnlyCaption')}</p>
          </>
        ) : borrowed ? (
          // 8d3a7bff — the borrowing half of a shared balance. Entitlement, Earned so far, Taken, Pending and
          // Balance are the POOL's figures (see `poolRole`); printing them here said this type had an
          // allowance of its own and made the pool's card look duplicated. The pool's card still prints every
          // one of them, unchanged, and the caption under this one names it.
          <>
            <p
              className={`mt-2 text-xl font-bold tabular-nums ${borrowedValue != null && borrowedValue < 0 ? 'text-destructive' : ''}`}
              data-testid={c.isCurrentCycle ? 'can-apply-for' : undefined}
            >
              {fmt(borrowedValue)}
            </p>
            <p className="text-[11px] text-muted-foreground">{c.isCurrentCycle ? t('canApplyFor') : t('remaining')}</p>
            {laterLine(c)}
          </>
        ) : (
          <>
            <p className={`mt-2 text-xl font-bold tabular-nums ${c.balance != null && c.balance < 0 ? 'text-destructive' : ''}`}>
              {fmt(c.balance)}
            </p>
            <p className="text-[11px] text-muted-foreground">{t('balance')}</p>
            {laterLine(c)}
            <dl className="mt-1.5">
              {c.hasEntitlement && row(t('entitlement'), c.entitlement)}
              {c.hasEntitlement && row(t('earnedSoFar'), c.earnedSoFar)}
              {row(t('taken'), c.taken)}
              {row(t('pending'), c.pending)}
            </dl>
            {canApplyLine(c)}
          </>
        )}
        {extras(c)}
        {footer(c)}
      </article>
    );
  };

  return (
    <>
      <div className={ringCards.length > 0 ? 'grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]' : ''}>
        {ringCards.length > 0 && <div className="flex flex-col gap-4">{ringCards.map(ringCard)}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {otherCards.map(smallCard)}
          {sharedGroups.map((g) => (
            <article key={g.id} className="flex flex-col rounded-xl border border-border bg-muted/40 p-3.5" aria-label={g.name}>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Layers className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{g.name}</span>
              </h3>
              <p className="mt-2 text-xl font-bold tabular-nums">{formatDays(g.available)}</p>
              <p className="text-[11px] text-muted-foreground">{g.limitLabel}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{g.membersLabel}</p>
              {g.capLabel && <p className="text-[11px] text-muted-foreground">{g.capLabel}</p>}
            </article>
          ))}
        </div>
      </div>

      {selected?.breakdown && selected.replacement && (
        <ReplacementLeavePanel
          key={selected.leaveTypeId}
          open={open}
          onOpenChange={setOpen}
          leaveTypeName={selected.leaveType}
          visual={{ color: selected.color, icon: selected.icon, code: selected.code }}
          asOf={selected.asOf}
          available={selected.canApplyFor}
          data={selected.replacement}
        />
      )}
      {selected?.breakdown && !selected.replacement && (
        <LeaveDetailsPanel
          key={selected.leaveTypeId}
          open={open}
          onOpenChange={setOpen}
          hideTrigger
          hideAsOfForm
          data={selected.breakdown}
          summary={{ available: selected.breakdown.totalAvailable }}
          footnote={laterText(selected, 'panel')}
          visual={{ color: selected.color, icon: selected.icon, code: selected.code }}
          asOf={selected.asOf}
          action="/leave"
          applyEssConfig
        />
      )}
    </>
  );
}
