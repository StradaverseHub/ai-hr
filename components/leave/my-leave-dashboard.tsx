'use client';

/**
 * r302 (board 6c9802c9) — My Leave: the leave balance dashboard.
 *
 * ONE card per leave type that applies to the employee, in the order the server decided (Primary before
 * Secondary; Hidden never arrives). r378 gives every type the same card frame. Drawable entitlement types use the existing
 * segment arithmetic; hidden, negative, borrower and taken-only states use a neutral track.
 * A type with no entitlement (`takenOnly`) still shows only its permitted taken figure.
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
// r355 (8d3a7bff) — no `next/link` here any more: this component's ONLY navigation was the pooled card's
// "View details", and the page it navigated to is deleted. Nothing on a balance card navigates now; the
// Details affordances are in-page panels (`leave.myLeave.details`), which is what the reporter wanted.
import { useTranslations } from 'next-intl';
import { LEAVE_FIGURE_LABEL_KEY, LEAVE_FIGURE_NS } from '@/lib/leave-figure-labels';
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
import type { SharedLeaveGroupEntry } from './shared-leave-group-entry';

export type MyLeaveDashboardCard = MyLeaveCard & {
  /** Replacement Leave only: the per-credit table its Details opens instead of the summary side-sheet. */
  replacement?: ReplacementPanelData | null;
  /** Replacement Leave only: days claimed and still waiting on a line manager (never part of the balance). */
  pendingInLieu?: number | null;
  /**
   * r341 (8d3a7bff) — THE SHARED-GROUP CEILING THIS CARD HOLDS THE POOL FOR, so the pool draws ONE card.
   *
   * The reporter saw two cards headed "Special Leave": this leave type, and the shared GROUP of the same
   * name as its own stacked-layers tile. They are two different settings (a ledger route and a combined
   * ceiling — lib/shared-leave-pool.ts says why they must not be reconciled) but they are one pot on screen,
   * so the group's lines move onto the card whose ledger the ceiling caps and the tile goes.
   *
   * ⚠️ NO FIGURE ON THIS CARD CHANGES. `available` here is the group's own drawable figure
   * (`sharedGroupAvailableDays`), which is a ceiling figure and NOT this card's balance — it is printed in
   * the group's own pre-translated sentence, never as the card's headline. Every string arrives translated
   * (this is a client island; the RSC owns t()).
   */
  pooledCeiling?: PooledCeilingLines | null;
  /**
   * r341 (8d3a7bff) — pre-translated lines for the ceilings this card COUNTS TOWARDS while keeping its own
   * balance. Hiding these cards was the literal request and would have hidden 177.00 days of Marriage Leave
   * from 59 employments; naming the ceiling is what was approved instead.
   *
   * ⚠️ r343 (1478c281) — ON PRODUCTION THAT IS MARRIAGE LEAVE AND NOTHING ELSE, which corrects what this
   * comment said before. Caregiver, Examination, Graduation and Study are in the same group and hold 0.00
   * days each; a member that holds nothing of its own now draws no card at all (the gate in core/read.ts), so
   * no card of theirs reaches this component and no ceiling line is built for them. Granting one of them a
   * day brings its card back and this line with it — there is no list of names anywhere to maintain.
   */
  ceilingLines?: string[];
};

/** Every line the merged group contributes, pre-translated by the RSC. `null` cap ⇒ the group has none. */
export type PooledCeilingLines = {
  /** e.g. "9.00 of 10.00 shared days" — the drawable pooled figure with the ceiling as context beside it. */
  availableLabel: string;
  limitLabel: string;
  /** e.g. "Shared across: Caregiver, Compassionate, …" */
  membersLine: string;
  /** e.g. "Up to 3.00 days in one application", or null when the group sets no per-application cap. */
  capLine: string | null;
  /**
   * r355 (8d3a7bff) — e.g. "Used this year: 2.00": the whole cycle's committed days across the pool.
   *
   * ⚠️ THIS FIELD REPLACES `detailsHref` / `detailsLabel`, and that is the whole shape of r355. 76dbcaa1
   * put a "View details" link here into /leave/shared/[groupId]; the reporter read that page as a
   * configuration screen — it repeated the heading they had just clicked, led with policy limits, had no
   * way back, and after r341 folded the group's tile onto this card it repeated four of its five figures
   * too. The page is deleted. The fifth figure is this line, so the removal loses nothing.
   *
   * NOT OPTIONAL. A merged ceiling always has a used figure (0.00 is a real answer and says the pool is
   * untouched), so making it nullable would only invite a caller to drop it silently.
   */
  usedLine: string;
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
  // 7da0a4e7 — the two figures this card shares with the balance table take their NAMES from
  // lib/leave-figure-labels.ts. `leave.myLeave.canApplyFor` ("You can apply for") and `.earnedSoFar`
  // ("Earned so far") were this screen's own words for numbers the table already called something else;
  // the reporter found them by reading the two screens side by side. The DATA fields keep their names —
  // only the labels moved. Both retired keys stay in the catalogues (see lib/leave-figure-labels.ts).
  const tf = useTranslations(LEAVE_FIGURE_NS);
  const labelAvailable = () => tf(LEAVE_FIGURE_LABEL_KEY.available);
  const labelEarned = () => tf(LEAVE_FIGURE_LABEL_KEY.ytdEntitled);
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
      {/* r341 (8d3a7bff) — THE MERGED SHARED-GROUP CEILING. The stacked-layers tile that used to sit beside
          this card is gone and its lines are here: the drawable pooled figure with the ceiling beside it, who
          shares it, and the per-application cap. Below the pool caption, because that sentence says whose
          ledger this is and these lines qualify what may be taken from it.

          ⚠️ r355 (8d3a7bff, same item) — AND THE "View details" LINK IS GONE FROM THE END OF IT. The
          reporter contested r341 not on the cards but on the page behind this link: it re-used the heading
          they had just clicked, led with the policy limits, offered no way back, and — once r341 had moved
          the tile's figures here — told them almost nothing this block does not. The page is deleted and the
          route deregistered (lib/permissions.ts). `usedLine` below is the one figure that page held alone,
          which is why its removal takes no information with it.

          ⚠️ AND THIS IS NOT A LOST WAY TO APPLY, which was the reporter's own question. Every member type of
          the pool is in the Request Leave picker, grouped under the pool's name by the <optgroup> at
          components/leave-duration-fields.tsx; core/read.ts's folding gate records the same rule — dropping
          a card is "never a right to apply". The deleted page's per-reason Apply buttons pointed INTO that
          same form (`/leave?applyType=…`), so they were a shortcut to it and never a second write path. */}
      {c.pooledCeiling && (
        <div className="mt-2 border-t border-border pt-2" data-testid="pooled-ceiling">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Layers className="size-3 shrink-0" aria-hidden />
            <span>{c.pooledCeiling.availableLabel}</span>
            <span aria-hidden>·</span>
            <span>{c.pooledCeiling.limitLabel}</span>
          </p>
          {/* What has already gone, so the subtraction behind the figure above is visible rather than
              implied — the deleted page's own words for it, in the deleted page's own key. */}
          <p className="text-[11px] text-muted-foreground" data-testid="pooled-used">
            {c.pooledCeiling.usedLine}
          </p>
          <p className="text-[11px] text-muted-foreground">{c.pooledCeiling.membersLine}</p>
          {c.pooledCeiling.capLine && <p className="text-[11px] text-muted-foreground">{c.pooledCeiling.capLine}</p>}
        </div>
      )}
      {/* r341 (8d3a7bff) — a member that keeps its OWN balance and also counts towards a ceiling. This is the
          plan's challenge made visible: the reporter asked for these cards to go, and Marriage Leave's 177.00
          days across 59 employments are the reason they stay. One line, no figure — the ceiling's figures
          belong to the card that holds the pool. */}
      {(c.ceilingLines ?? []).map((line) => (
        <p key={line} className="mt-2 text-[11px] text-muted-foreground" data-testid="ceiling-membership">
          {line}
        </p>
      ))}
      {/* 31e39d74 / r209 — WHY THIS TYPE READS 0.00, in one amber line. ⚠️ r343 (1478c281): a placed-group
          member folded by the gate in core/read.ts never reaches this component, so this caption is dropped
          WITH its card and never FROM a card that renders — the fold removes whole rows and touches nothing
          here. MEASURED 2026-09-26: the reporter's folded four have NO entitlement
          template, so they are NOT `capped_by_max_balance`; that shape is a different member's (a 3-day table under a
          Maximum Balance of 0), so that caption is part of what hiding them costs; HR keeps it through
          `includeHidden`. Both halves pinned in test/1478c281-empty-member-cards.test.ts (f). */}
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
            ? labelAvailable()
            : t('remaining')
          : t('notEarnedYet');

  const canApplyLine = (c: MyLeaveDashboardCard) =>
    c.canApplyFor != null ? (
      <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-xs font-semibold" data-testid="can-apply-for">
        <span>{labelAvailable()}</span>
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
    /**
     * cac9a3a1 (r369) — THE CENTRE IS THE GREEN ARC, NOT A SECOND FIGURE.
     *
     * RETIRED CLAIM, quoted so it is not reinstated by accident: r302's header said "The big number in the
     * middle is the Balance, which is not an arc", and r302's fix pass pinned it as "The big centre number
     * stays Balance, labelled Balance". The reporter (cac9a3a1) read 11.50 in the middle and 10.50 in the
     * Available Balance row of the same card and asked which one was theirs. Balance is GROSS of pending; the
     * green arc the centre sits inside is `remaining`, i.e. Available Balance. So the centre disagreed with
     * its own ring.
     *
     * It is now `c.remaining` — the SAME expression the Available Balance legend row below prints, not a
     * re-derivation — and its caption is `segmentLabel('available', c)`, the green arc's own label, so the
     * centre and the arc cannot carry two names ("Available Balance" this leave year, "Remaining" for an
     * earlier one). `leave.myLeave.balanceDays` is RETIRED IN PLACE in all six catalogues, never deleted
     * (i18n/request.ts deep-merges each locale over English: a key dropped from `en` but left in `ms` still
     * renders — see the note at the top of lib/leave-figure-labels.ts).
     *
     * The Available Balance legend row STAYS: it is the green arc's legend entry, and deleting it would strip
     * the arc's label. ringDrawable() is untouched, so a hidden or overdrawn figure still draws no ring and
     * the centre can never be null or negative.
     */
    const centreLabel = segmentLabel('available', c);
    return (
      <article
        key={c.leaveTypeId}
        className="flex h-full items-start gap-3 rounded-xl border border-border bg-background p-4"
        data-testid="leave-ring-card"
        aria-label={c.leaveType}
      >
        <div className="flex flex-col items-center self-center">
          <LeaveBalanceRing
            segments={segments}
            size={136}
            centre={fmt(c.remaining)}
            centreCaption={centreLabel}
            label={t('ringLabel', {
              type: c.leaveType,
              label: centreLabel,
              available: fmt(c.remaining),
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
            {row(labelEarned(), c.earnedSoFar)}
            {!c.annualLeave && row(t('balance'), c.balance)}
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
        className="flex h-full items-start gap-3 rounded-xl border border-border bg-background p-4"
        data-testid="leave-type-card"
        aria-label={c.leaveType}
      >
        <div className="shrink-0 self-start">
          <LeaveBalanceRing
            size={136}
            segments={[]}
            centre={fmt(c.takenOnly ? c.taken : borrowed ? borrowedValue : c.isCurrentCycle ? c.canApplyFor : c.remaining)}
            centreCaption={c.takenOnly ? t('takenOnlyCaption') : segmentLabel('available', c)}
            label={`${c.leaveType}: ${c.takenOnly ? t('takenOnlyCaption') : segmentLabel('available', c)} ${fmt(c.takenOnly ? c.taken : borrowed ? borrowedValue : c.isCurrentCycle ? c.canApplyFor : c.remaining)}`}
          />
        </div>
        <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <span className={v.hasColor ? `rounded p-0.5 ${v.chipClass}` : undefined}>
            <Icon className="size-3.5 shrink-0" aria-hidden />
          </span>
          <span className="min-w-0 break-words">{c.leaveType}</span>
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
            <p className="text-[11px] text-muted-foreground">{c.isCurrentCycle ? labelAvailable() : t('remaining')}</p>
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
              {c.hasEntitlement && row(labelEarned(), c.earnedSoFar)}
              {row(t('taken'), c.taken)}
              {row(t('pendingApproval'), c.pending)}
            </dl>
            {canApplyLine(c)}
          </>
        )}
        {extras(c)}
        {footer(c)}
        </div>
      </article>
    );
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs" data-testid="leave-shared-legend">
        {(['available', 'pending', 'taken', 'unearned'] as const).map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm" style={{ background: RING_COLORS[key] }} />
            {key === 'available' ? labelAvailable() : key === 'pending' ? t('pendingApproval') : key === 'taken' ? t('taken') : t('notEarnedYet')}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-2" data-testid="leave-balance-grid">
          {cards.map((c) => c.hasEntitlement && !c.takenOnly && poolRole(c) !== 'borrower' && ringDrawable(c) ? ringCard(c) : smallCard(c))}
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
