'use client';

/**
 * Replacement Leave details side panel (feedback 00307068).
 *
 * THE DEFECT THIS EXISTS TO FIX. Clicking the Replacement Leave card on My Leave used to open
 * LeaveDetailsPanel — the same nine-line Leave Balance Summary (Eligible → … → Available Balance) every
 * other leave type gets. That layout is wrong here, and wrong in a way that makes the screen unreadable
 * rather than merely sparse: Replacement Leave is NOT a yearly allowance. It is a stack of separately
 * earned credits, each banked on a different day and each lapsing on its own date. One lumped figure
 * cannot say how the balance was built up or which piece is about to run out, so the employee is left
 * guessing at exactly the question they opened the card to answer.
 *
 * So this is a SIBLING of LeaveDetailsPanel, not a branch inside it. Same slide-out shell, same header,
 * same HR-authored info-icon behaviour — but the body is a table with one row per banked credit
 * (Request Date, Number, Unit, Approval Date, Expired Date, Available) instead of a summary column. Keeping them
 * separate is what stops the shared panel growing a leave-type conditional through its descriptor loop,
 * which is the property 584edf44 built that file around.
 *
 * THE BALANCE ABOVE THE TABLE IS `leaveBalances`' FIGURE, NEVER A SUM OF THE ROWS. The r75 rule applies
 * here as everywhere: the Available Balance an employee sees must be the same number the apply popup
 * enforces against. The table EXPLAINS that figure; it must never quietly disagree with it, which is what
 * re-adding the rows would eventually do the first time a row is filtered.
 *
 * DB-free client component: every value arrives as a serialisable prop (the server already ran
 * replacementLeaveLedger and leaveBalances). No formula is computed here.
 * Substrate: read-only presentation → NO DomainEvent. // substrate: read-only, no event
 */
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Info, X } from 'lucide-react';
import { leaveVisual } from '@/lib/leave-visual';
// 4a1abc4a: the balance above the table is the same `leaveBalances` figure the card and the summary panel
// show, so it must print through the same formatter — the r75 rule applied to the digits, not just the value.
import { DAY_DASH, formatDays } from '@/lib/day-format';

const PLACEHOLDER = DAY_DASH;

/** One banked credit, exactly as `replacementLeaveLedger` returns it (plain data, no Date objects). */
export type ReplacementCreditRow = {
  id: string;
  workedDate: string;
  expiresOn: string;
  daysCredited: number;
  daysTaken: number;
  status: 'active' | 'taken' | 'converted_to_pay' | 'lapsed';
  remaining: number;
  requestedOn: string | null;
  approvedOn: string | null;
  otMinutes: number;
};

/** The envelope the RSC pre-computes for the Replacement Leave card. */
export type ReplacementPanelData = {
  rows: ReplacementCreditRow[];
  /**
   * 5ff7daff — the AWAITING-APPROVAL half of the reporter's two-stage view: the total days across this
   * employee's replacement-leave requests that are still `pending`. NOT part of the balance and never added
   * to it (nothing is banked until a line manager approves), which is exactly why it is shown as its own
   * line rather than folded into the figure above the table.
   */
  pendingDays: number;
  /** The leave type's labelling unit (leave_type.leave_unit, e4980382) — display only, never a calculation. */
  leaveUnit: 'day' | 'hour';
  /** HR-authored per-COLUMN explanations, keyed by REPLACEMENT_COLUMN_KEYS. Missing ⇒ no info icon. */
  explanations: Record<string, { description?: string; formula?: string } | null>;
};

/** The five columns, in the order the reporter listed them. Each `key` is a REPLACEMENT_COLUMN_KEYS member,
 *  so a heading's label and its HR explanation are always resolved by the same key — a column can never be
 *  named one thing in the configuration and another here. */
const COLUMNS = [
  { key: 'requestDate', align: 'left' as const },
  { key: 'number', align: 'right' as const },
  { key: 'unit', align: 'left' as const },
  { key: 'approvalDate', align: 'left' as const },
  { key: 'expiredDate', align: 'left' as const },
  // 5ff7daff — "how much of THIS credit is still unused", the column the reporter listed and the only one
  // of their four that was missing. `remaining` (daysCredited − daysTaken) has ridden on every row since
  // 0113 and was already handed to this component; nothing new is computed here.
  { key: 'remaining', align: 'right' as const },
];

/** An ISO instant (approved_on is timestamptz) rendered as the DAY it happened — the table is a table of
 *  days. A plain date passes through unchanged, so both columns read identically. */
function asDay(v: string | null): string | null {
  if (!v) return null;
  return v.slice(0, 10);
}

/**
 * 3fb1a611 — "EXPIRING SOON", the reporter's last ask on this card: show it, so a credit is USED rather
 * than lost. Purely presentational; every field it reads (`status`, `remaining`, `expiresOn`) has ridden
 * on each row since 0113, and `asOf` is already a prop. Nothing new is fetched and no formula is computed
 * here — the r75 rule still holds, the Available figure above the table is `leaveBalances`' and this only
 * annotates rows.
 *
 * THIRTY DAYS, and the number is a judgement rather than a constant from somewhere. It has to be long
 * enough for the employee to do something about it: applying for replacement leave goes through the
 * ordinary approval chain, so a seven-day warning on a credit whose manager is on leave is a warning
 * nobody can act on. It also has to be short enough to mean something against the default 90-day expiry
 * (core/toil.ts POLICY_DEFAULTS) — a 60-day window would flag two thirds of every credit ever banked and
 * the badge would stop being read. It is deliberately NOT derived from the policy's expiry period: this
 * is "act now", not "a third of the way through", and an employee with credits from two companies must
 * not see the same urgency drawn at two different distances.
 */
const EXPIRING_SOON_DAYS = 30;

/** Whole days from `asOf` to `expiresOn`. Negative ⇒ already past. Both are plain YYYY-MM-DD. */
function daysUntil(asOf: string, expiresOn: string): number {
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
}

export function ReplacementLeavePanel({
  leaveTypeName,
  visual,
  asOf,
  available,
  data,
  open,
  onOpenChange,
}: {
  leaveTypeName: string;
  visual: { color: string | null; icon: string | null; code: string | null };
  asOf: string;
  /** leaveBalances' Available figure. `null` ⇒ HR has hidden it in ESS ⇒ render an em-dash, never a leak. */
  available: number | null;
  data: ReplacementPanelData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('leave.breakdown');

  // Info-icon per COLUMN HEADING — the same hover / keyboard-focus / tap-toggle control LeaveDetailsPanel
  // uses per row (b8b665ff, reworked by 2bc2f2a3), resolved by column key instead of field key. `pinned`
  // holds tap-toggled headings (several may stay open); `hovered` is the transient hover/focus target.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const toggle = (key: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const unpin = (key: string) =>
    setPinned((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const iconVisual = leaveVisual({ color: visual.color, icon: visual.icon, code: visual.code });
  const HeaderIcon = iconVisual.Icon;

  const unitLabel = t(data.leaveUnit === 'hour' ? 'replacement.unitHour' : 'replacement.unitDay');
  // The Number column reads in the unit HR named the type in. 'hour' renders the RAW banked minutes rather
  // than re-deriving hours from the rounded day figure — a 2-decimal day count cannot round-trip to hours.
  const amountOf = (r: ReplacementCreditRow) => (data.leaveUnit === 'hour' ? r.otMinutes / 60 : r.daysCredited);

  // NEWEST FIRST, by the date the credit was APPROVED — which is when it entered the balance, and the
  // question a reader scanning this table is asking ("what did I get most recently?"). A legacy row with no
  // approval date falls back to the day worked so it still sorts sensibly rather than sinking to the bottom.
  const sortKey = (r: ReplacementCreditRow) => asDay(r.approvedOn) ?? r.workedDate;
  const rows = [...data.rows].sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));

  // "Used-up and expired ones CLEARLY MARKED, so the table explains the balance instead of contradicting
  // it." A reader who sees five credits listed against a balance of two needs to be told which three are
  // spent — without that the table looks like the balance is wrong.
  const statusKey = (r: ReplacementCreditRow): string | null => {
    if (r.status === 'taken') return 'replacement.statusTaken';
    if (r.status === 'lapsed') return 'replacement.statusExpired';
    if (r.status === 'converted_to_pay') return 'replacement.statusConverted';
    // An ACTIVE row that has been partly consumed is neither "spent" nor untouched, and saying nothing about
    // it is what makes the arithmetic look wrong.
    if (r.daysTaken > 0) return 'replacement.statusPartlyUsed';
    return null;
  };
  const isSpent = (r: ReplacementCreditRow) => r.status !== 'active';

  // 3fb1a611 — the credits that are still spendable AND about to stop being spendable. A row that is
  // already past its date is NOT "expiring soon": it has expired, and `statusKey` above already says so
  // once the sweep has run. Ordered by expiry so the summary names the FIRST deadline, never an arbitrary
  // row's (CLAUDE.md §8 — pin invariants, not positions).
  const expiringSoon = rows
    .filter((r) => {
      if (r.status !== 'active' || r.remaining <= 0) return false;
      const left = daysUntil(asOf, r.expiresOn);
      return left >= 0 && left <= EXPIRING_SOON_DAYS;
    })
    .sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : 0));
  const expiringSoonIds = new Set(expiringSoon.map((r) => r.id));
  const expiringSoonDays = Math.round(expiringSoon.reduce((s, r) => s + r.remaining, 0) * 100) / 100;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-popover text-popover-foreground shadow-lg"
          aria-describedby={undefined}
        >
          <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-popover px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
                <span className={iconVisual.hasColor ? `rounded-md p-1 ${iconVisual.chipClass}` : undefined}>
                  <HeaderIcon className="size-4 shrink-0" aria-hidden />
                </span>
                <span className="truncate">{leaveTypeName}</span>
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
            {/* 5ff7daff — THE TWO STAGES, in the reporter's own words. "Replacement Leave in Lieu" is what is
                still waiting on the line manager; "Replacement Leave" is what has been approved and can
                actually be spent. Before approval those read 1.00 waiting / 0.00 available; after it, 0.00
                and 1.00; after a rejection, 0.00 and 0.00.

                The available figure is still leaveBalances', never a sum of the rows below (the r75 rule —
                the number an employee sees must be the number the apply popup enforces). The pending figure
                is deliberately NOT added to it: nothing is banked until a manager approves, and a card that
                counted unapproved claims as spendable balance would be lying about what can be booked. */}
            <div className="divide-y divide-border rounded-lg border border-border">
              <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-muted-foreground">{t('replacement.pendingLabel')}</span>
                  <span className="block text-xs text-muted-foreground/80">{t('replacement.pendingHint')}</span>
                </span>
                <span className="shrink-0 text-lg font-semibold tabular-nums text-muted-foreground">
                  {formatDays(data.pendingDays)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{t('replacement.approvedLabel')}</span>
                  <span className="block text-xs text-muted-foreground/80">{t('replacement.approvedHint')}</span>
                </span>
                <span className="shrink-0 text-lg font-semibold tabular-nums text-foreground">
                  {formatDays(available)}
                </span>
              </div>
              {/* 3fb1a611 — EXPIRING SOON. A third row rather than a banner, so the card reads as one
                  column of facts: what is waiting, what is available, and what is about to be lost. It is
                  ABSENT entirely when nothing is close to expiring — an always-present "0.00 expiring
                  soon" line is noise that trains the reader to skip the row that matters. Amber, because
                  a balance the employee is about to lose is not a neutral figure. The date named is the
                  FIRST deadline (the list is sorted by expiry), which is the one that needs acting on. */}
              {expiringSoon.length > 0 && (
                <div className="flex items-baseline justify-between gap-3 bg-amber-50/60 px-3 py-2.5 dark:bg-amber-500/5">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-amber-800 dark:text-amber-300">
                      {t('replacement.expiringSoonLabel')}
                    </span>
                    <span className="block text-xs text-amber-700/80 dark:text-amber-400/80">
                      {t('replacement.expiringSoonHint', { date: expiringSoon[0].expiresOn })}
                    </span>
                  </span>
                  <span className="shrink-0 text-lg font-semibold tabular-nums text-amber-800 dark:text-amber-300">
                    {formatDays(expiringSoonDays)}
                  </span>
                </div>
              )}
            </div>

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('replacement.creditsHeading')}
              </h3>
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('replacement.empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        {COLUMNS.map((c) => {
                          const explanation = data.explanations?.[c.key] ?? null;
                          const hasExpl = !!(explanation && (explanation.description || explanation.formula));
                          const isOpen = hasExpl && (hovered === c.key || pinned.has(c.key));
                          const tooltipId = `rl-col-expl-${c.key}`;
                          return (
                            <th
                              key={c.key}
                              scope="col"
                              className={`whitespace-nowrap py-1.5 pr-3 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                            >
                              <span className={`inline-flex items-center gap-1 ${c.align === 'right' ? 'justify-end' : ''}`}>
                                {t(`replacement.col.${c.key}`)}
                                {/* HR's wording for this column, on hover / focus / tap. Nothing is written
                                    into the software: the icon is absent entirely for a column HR left
                                    blank, so an unconfigured table carries no empty affordances. */}
                                {hasExpl && (
                                  <span className="relative shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => toggle(c.key)}
                                      onMouseEnter={() => setHovered(c.key)}
                                      onMouseLeave={() => setHovered((cur) => (cur === c.key ? null : cur))}
                                      onFocus={() => setHovered(c.key)}
                                      onBlur={() => setHovered((cur) => (cur === c.key ? null : cur))}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') {
                                          setHovered((cur) => (cur === c.key ? null : cur));
                                          unpin(c.key);
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
                                        className="absolute left-0 top-full z-20 mt-1 w-64 space-y-1 rounded-md border border-border bg-popover px-2.5 py-2 text-left text-xs font-normal normal-case tracking-normal text-muted-foreground shadow-md"
                                      >
                                        {explanation!.description && (
                                          <p>
                                            <span className="font-medium text-foreground">
                                              {t('explanationDescription')}:{' '}
                                            </span>
                                            {explanation!.description}
                                          </p>
                                        )}
                                        {explanation!.formula && (
                                          <p>
                                            <span className="font-medium text-foreground">
                                              {t('explanationFormula')}:{' '}
                                            </span>
                                            {explanation!.formula}
                                          </p>
                                        )}
                                      </div>
                                    )}
                                  </span>
                                )}
                              </span>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const sk = statusKey(r);
                        return (
                          <tr
                            key={r.id}
                            className={`border-b border-border/60 last:border-0 ${isSpent(r) ? 'text-muted-foreground' : 'text-foreground'}`}
                          >
                            <td className="whitespace-nowrap py-1.5 pr-3">{asDay(r.requestedOn) ?? PLACEHOLDER}</td>
                            <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                              {formatDays(amountOf(r))}
                            </td>
                            <td className="whitespace-nowrap py-1.5 pr-3">{unitLabel}</td>
                            <td className="whitespace-nowrap py-1.5 pr-3">{asDay(r.approvedOn) ?? PLACEHOLDER}</td>
                            <td className="whitespace-nowrap py-1.5 pr-3">
                              <span className={isSpent(r) ? 'line-through' : undefined}>{r.expiresOn}</span>
                              {sk && (
                                <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                                  {t(sk)}
                                </span>
                              )}
                              {/* 3fb1a611 — WHICH credit the summary row above is about. Without this the
                                  employee is told "1.00 expiring by 4 October" and then has to work out
                                  which line that is; with it the table answers the question the card
                                  raised. Only ever on an ACTIVE row with days left (see expiringSoon). */}
                              {expiringSoonIds.has(r.id) && (
                                <span className="ml-2 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                                  {t('replacement.expiringSoonBadge')}
                                </span>
                              )}
                            </td>
                            {/* How much of THIS credit is still unused. A lapsed or paid-out row shows 0.00
                                rather than its residue: the credit is gone, and printing what it once held
                                beside an Expired badge is the "table contradicts the balance" complaint this
                                panel exists to answer. */}
                            <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                              {formatDays(r.status === 'active' ? r.remaining : 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
