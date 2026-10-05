'use client';

/**
 * r389 bc3e203d · LEAVE CREDIT HISTORY — the client half: the table (cards on a phone), the read-only View
 * panel, Cancel on a pending row, and the filter form.
 *
 * DB-free. Every row arrives as plain data from app/leave/credit/page.tsx, already filtered, counted, sorted
 * and paged on the server by lib/leave-credit-history.ts; this file draws what it is given and filters
 * nothing. All copy comes from useTranslations INSIDE the island (the house pattern for client widgets), so
 * no translator crosses the server→client boundary. Labels are reused from the catalogues that already own
 * them, so this page cannot drift from its siblings:
 *   · approval status  — `leave.status.*` (the vocabulary every leave surface prints);
 *   · credit status    — `admin.leaveCredit.status.*` (the HR Leave Credit screen's own five names);
 *   · day type         — `replacementRequest.dayKind.*` (the request and approver screens' names);
 *   · credit days      — `leave.myLeave.daysValue`, through lib/day-format (one day-figure format).
 *
 * The View panel reads stored facts only. Where a line has no attendance snapshot (a rest day, an off day or
 * a public holiday has no shift end or clock-out to store) it says so rather than leaving a blank. A paid-out
 * credit is described in DAYS: no amount reaches this file (core/leave-credit-history.ts selects none).
 */
import { useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Check, Clock, Filter, ChevronDown, X } from 'lucide-react';
import { Drawer } from '@/components/ui/drawer';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { DAY_DASH, dayPluralCategory, formatDays } from '@/lib/day-format';
import {
  CREDIT_DAY_TYPES,
  CREDIT_STATUS_LABEL_KEY,
  DAY_TYPE_LABEL_KEY,
  LEAVE_CREDIT_STATUSES,
  YEAR_ALL,
  dmy,
  expiryHintDays,
  filterFormQuery,
  hhmm,
  hoursLabel,
  tabAfterApply,
  type ApprovalStatus,
  type ApprovalTab,
  type CreditHistoryFilters,
  type CreditHistoryLine,
  type LeaveCreditStatusKey,
} from '@/lib/leave-credit-history';

/** Approval Status: a FILLED badge, the colours My Leave History uses for the same four states. */
const APPROVAL_BADGE: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  cancelled: 'bg-muted text-muted-foreground',
};

/** Credit Status: an OUTLINED badge with a dot, in the HR Leave Credit screen's colour for each name. */
const CREDIT_BADGE: Record<LeaveCreditStatusKey, { ring: string; dot: string }> = {
  available: { ring: 'border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-400', dot: 'bg-emerald-500' },
  used: { ring: 'border-indigo-300 text-indigo-700 dark:border-indigo-500/40 dark:text-indigo-300', dot: 'bg-indigo-500' },
  expired: { ring: 'border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-400', dot: 'bg-rose-500' },
  paid_out: { ring: 'border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400', dot: 'bg-amber-500' },
  reversed: { ring: 'border-border text-muted-foreground', dot: 'bg-muted-foreground' },
};

type Action = (fd: FormData) => void | Promise<void>;

function useLabels() {
  const t = useTranslations('leaveCreditHistory');
  const tLeave = useTranslations('leave');
  const tCredit = useTranslations('admin.leaveCredit');
  const tRR = useTranslations('replacementRequest');
  const locale = useLocale();
  return {
    t,
    approval: (s: ApprovalStatus) => tLeave(`status.${s}`),
    credit: (s: LeaveCreditStatusKey) => tCredit(CREDIT_STATUS_LABEL_KEY[s]),
    dayType: (d: CreditHistoryLine['dayType']) => (d ? tRR(DAY_TYPE_LABEL_KEY[d]) : DAY_DASH),
    days: (n: number | null | undefined) =>
      n == null ? DAY_DASH : tLeave('myLeave.daysValue', { v: formatDays(n), cat: dayPluralCategory(n, locale) }),
    hours: (l: Pick<CreditHistoryLine, 'fromTime' | 'toTime' | 'hours'>) =>
      l.fromTime && l.toTime
        ? l.hours != null
          ? t('hoursValue', { from: hhmm(l.fromTime), to: hhmm(l.toTime), hours: hoursLabel(l.hours) })
          : `${hhmm(l.fromTime)} – ${hhmm(l.toTime)}`
        : DAY_DASH,
    shiftEndLabel: tRR('sectionB.shiftEnd'),
    clockOutLabel: tRR('sectionB.actualClockOut'),
  };
}

function ApprovalBadge({ status, label }: { status: ApprovalStatus; label: string }) {
  return (
    <span data-testid="lch-approval-badge" className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${APPROVAL_BADGE[status]}`}>
      {label}
    </span>
  );
}

function CreditBadge({ status, label }: { status: LeaveCreditStatusKey; label: string }) {
  const c = CREDIT_BADGE[status];
  return (
    <span data-testid="lch-credit-badge" className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${c.ring}`}>
      <span aria-hidden className={`inline-block size-1.5 rounded-full ${c.dot}`} />
      {label}
    </span>
  );
}

export function LeaveCreditHistoryTable({
  rows,
  today,
  leaveTypeNames,
  requestDates,
  cancelAction,
  back,
}: {
  /** This page's rows, already filtered, sorted and sliced on the server. */
  rows: CreditHistoryLine[];
  /** todayInKualaLumpur(), resolved on the server — the days-left hint never reads the browser clock. */
  today: string;
  /** leave_type id → the tenant's own (localized) name, for the applications that used a credit. */
  leaveTypeNames: Record<string, string>;
  /** request id → every date worked in it, so Cancel can say exactly what it withdraws. */
  requestDates: Record<string, string[]>;
  cancelAction: Action;
  /** This view's query string, so a cancellation returns to the same tab, filters and page. */
  back: string;
}) {
  const L = useLabels();
  const { t } = L;
  // The selection outlives the close, so the drawer can slide out with its content still in it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const selected = rows.find((r) => r.lineId === selectedId) ?? null;

  const expiryCell = (r: CreditHistoryLine) => {
    if (!r.credit) return DAY_DASH;
    const left = expiryHintDays(r, today);
    return (
      <span className="tabular-nums">
        {dmy(r.credit.expiresOn)}
        {left != null && (
          <span data-testid="lch-days-left" className="block text-xs font-semibold text-orange-600 dark:text-orange-400">
            {t('daysLeft', { count: left })}
          </span>
        )}
      </span>
    );
  };

  const cancelForm = (r: CreditHistoryLine, phone: boolean) =>
    r.approvalStatus === 'pending' ? (
      <form action={cancelAction} className="inline">
        <input type="hidden" name="requestId" value={r.requestId} />
        <input type="hidden" name="back" value={back} />
        <ConfirmSubmit
          variant="ghost"
          size="sm"
          className={`${phone ? 'min-h-11 ' : ''}h-auto px-1 py-0 text-sm font-semibold text-rose-600 hover:bg-transparent hover:underline dark:text-rose-400`}
          title={t('cancelTitle')}
          description={t('cancelDescription', { dates: (requestDates[r.requestId] ?? [r.workedDate]).map(dmy).join(', ') })}
          confirmLabel={t('cancelConfirm')}
          data-testid="lch-cancel"
        >
          {t('cancel')}
        </ConfirmSubmit>
      </form>
    ) : null;

  const viewButton = (r: CreditHistoryLine, phone: boolean) => (
    <button
      type="button"
      onClick={() => {
        setSelectedId(r.lineId);
        setOpen(true);
      }}
      aria-label={t('viewAria', { date: dmy(r.workedDate) })}
      data-testid="lch-view"
      className={`${phone ? 'min-h-11 ' : ''}px-1 text-sm font-semibold text-primary underline-offset-2 hover:underline`}
    >
      {t('view')}
    </button>
  );

  return (
    <>
      {/* ── Desktop and tablet: the table, in the reporter's column order ─────────────────────────────── */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[60rem] text-sm" data-testid="lch-table">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.dateWorked')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.dayType')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.extendedHours')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.creditDays')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.expiryDate')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.appliedOn')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.approvalStatus')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.creditStatus')}</th>
              <th scope="col" className="px-3 py-2 font-medium">{t('col.action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.lineId} data-testid="lch-row" data-request-id={r.requestId}>
                <td className="px-3 py-3 font-semibold tabular-nums">{dmy(r.workedDate)}</td>
                <td className="px-3 py-3">{L.dayType(r.dayType)}</td>
                <td className="px-3 py-3 tabular-nums">{L.hours(r)}</td>
                <td className="px-3 py-3 tabular-nums">{L.days(r.days)}</td>
                <td className="px-3 py-3">{expiryCell(r)}</td>
                <td className="px-3 py-3 tabular-nums">{dmy(r.submittedOn)}</td>
                <td className="px-3 py-3">
                  <ApprovalBadge status={r.approvalStatus} label={L.approval(r.approvalStatus)} />
                </td>
                <td className="px-3 py-3">{r.credit ? <CreditBadge status={r.credit.status} label={L.credit(r.credit.status)} /> : DAY_DASH}</td>
                <td className="whitespace-nowrap px-3 py-3">
                  <span className="flex items-center gap-3">
                    {viewButton(r, false)}
                    {cancelForm(r, false)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Phone: one card per date worked ───────────────────────────────────────────────────────────── */}
      <ul className="space-y-3 p-3 md:hidden" data-testid="lch-cards">
        {rows.map((r) => (
          <li key={r.lineId} className="rounded-xl border border-border bg-card p-4" data-testid="lch-card">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold tabular-nums">{dmy(r.workedDate)}</p>
                <p className="text-sm text-muted-foreground">{L.dayType(r.dayType)}</p>
              </div>
              <p className="shrink-0 font-semibold tabular-nums">{L.days(r.days)}</p>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <ApprovalBadge status={r.approvalStatus} label={L.approval(r.approvalStatus)} />
              {r.credit && <CreditBadge status={r.credit.status} label={L.credit(r.credit.status)} />}
            </div>
            <div className="mt-3 flex items-end justify-between gap-3 border-t border-border pt-3">
              <div className="text-sm">
                <p className="text-muted-foreground">{t('col.expiryDate')}</p>
                <div className="font-semibold">{expiryCell(r)}</div>
              </div>
              <div className="flex items-center gap-3">
                {viewButton(r, true)}
                {cancelForm(r, true)}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {selected && (
        <CreditDrawer line={selected} open={open} leaveTypeNames={leaveTypeNames} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** One label/value pair in a drawer section. */
function Fact({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">
        {label}
        {hint && <span className="block text-xs">{hint}</span>}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function CreditDrawer({
  line: l,
  open,
  leaveTypeNames,
  onClose,
}: {
  line: CreditHistoryLine;
  open: boolean;
  leaveTypeNames: Record<string, string>;
  onClose: () => void;
}) {
  const L = useLabels();
  const { t } = L;
  const notRecorded = <span className="text-muted-foreground">{t('drawer.notRecorded')}</span>;
  const c = l.credit;
  const range = (a: string, b: string) => (a === b ? dmy(a) : `${dmy(a)} – ${dmy(b)}`);

  const approvalLine =
    l.approvalStatus === 'approved'
      ? t('drawer.approved', { date: dmy(l.decidedOn), time: l.decidedTime ?? '' })
      : l.approvalStatus === 'rejected'
        ? t('drawer.rejected', { date: dmy(l.decidedOn), time: l.decidedTime ?? '' })
        : l.approvalStatus === 'cancelled'
          ? l.decidedOn
            ? t('drawer.cancelled', { date: dmy(l.decidedOn), time: l.decidedTime ?? '' })
            : t('drawer.cancelledUndated')
          : t('drawer.waiting');
  const dot =
    l.approvalStatus === 'approved'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
      : l.approvalStatus === 'rejected'
        ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400'
        : l.approvalStatus === 'cancelled'
          ? 'bg-muted text-muted-foreground'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400';

  return (
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width="narrow"
      closeLabel={t('drawer.close')}
      title={
        <span data-testid="lch-drawer">
          <span className="block text-xs font-medium text-muted-foreground">{t('drawer.kicker', { ref: l.requestRef })}</span>
          <span className="mt-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('col.dateWorked')}</span>
          <span className="block text-xl font-semibold tabular-nums">
            {dmy(l.workedDate)} <span className="text-sm font-normal text-muted-foreground">· {L.dayType(l.dayType)}</span>
          </span>
        </span>
      }
      description={
        <span className="mt-2 flex flex-col gap-2">
          <span className="flex flex-wrap gap-2">
            <ApprovalBadge status={l.approvalStatus} label={L.approval(l.approvalStatus)} />
            {c && <CreditBadge status={c.status} label={L.credit(c.status)} />}
          </span>
          {c && (
            <span className="text-sm text-muted-foreground">
              {t('col.expiryDate')} <span className="font-semibold text-foreground tabular-nums">{dmy(c.expiresOn)}</span>
            </span>
          )}
        </span>
      }
      footer={
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="min-h-11 rounded-md border border-border px-4 text-sm font-medium">
            {t('drawer.close')}
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="font-semibold">{t('drawer.request')}</h3>
          <dl className="mt-1">
            <Fact label={t('col.dateWorked')}>{dmy(l.workedDate)}</Fact>
            <Fact label={t('col.dayType')}>{L.dayType(l.dayType)}</Fact>
            <Fact label={t('col.extendedHours')} hint={t('drawer.extendedHoursHint')}>
              {L.hours(l)}
            </Fact>
            <Fact label={t('col.creditDays')}>{L.days(l.days)}</Fact>
            <Fact label={t('drawer.reason')}>{l.reason ?? DAY_DASH}</Fact>
            <Fact label={t('col.appliedOn')}>{dmy(l.submittedOn)}</Fact>
          </dl>
        </section>

        <section className="border-t border-border pt-4" data-testid="lch-attendance">
          <h3 className="font-semibold">
            {t('drawer.attendance')} <span className="text-xs font-normal text-muted-foreground">{t('drawer.attendanceNote')}</span>
          </h3>
          <dl className="mt-1">
            <Fact label={L.shiftEndLabel}>{l.shiftEnd ? hhmm(l.shiftEnd) : notRecorded}</Fact>
            <Fact label={L.clockOutLabel}>{l.actualClockOut ? hhmm(l.actualClockOut) : notRecorded}</Fact>
            <Fact label={t('drawer.eligibleMinutes')}>{l.eligibleMinutes != null ? l.eligibleMinutes : notRecorded}</Fact>
          </dl>
        </section>

        <section className="border-t border-border pt-4" data-testid="lch-approval">
          <h3 className="font-semibold">{t('drawer.approval')}</h3>
          <div className="mt-2 flex items-start gap-3">
            <span aria-hidden className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${dot}`}>
              {l.approvalStatus === 'pending' ? <Clock className="size-3.5" /> : l.approvalStatus === 'approved' ? <Check className="size-3.5" /> : <X className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{approvalLine}</p>
              {l.approvalStatus !== 'cancelled' && (
                <p className="text-muted-foreground" data-testid="lch-approval-level">
                  {l.decidedByName ? t('drawer.levelNamed', { level: 1, name: l.decidedByName }) : t('drawer.level', { level: 1 })}
                </p>
              )}
              {l.decisionNote && (
                <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{t('drawer.remarks')}</p>
                  <p className="whitespace-pre-wrap">{l.decisionNote}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="border-t border-border pt-4" data-testid="lch-usage">
          <h3 className="font-semibold">{t('drawer.creditUsage')}</h3>
          {!c ? (
            <p className="mt-2 text-muted-foreground">{t('drawer.noCredit')}</p>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(
                  [
                    ['col.creditDays', c.daysCredited, 'lch-usage-credited'],
                    ['drawer.used', c.used, 'lch-usage-used'],
                    ['drawer.remaining', c.remaining, 'lch-usage-remaining'],
                  ] as const
                ).map(([key, n, id]) => (
                  <div key={key} className="rounded-lg border border-border p-2.5">
                    <p className="text-xs text-muted-foreground">{t(key)}</p>
                    <p className="font-semibold tabular-nums" data-testid={id}>
                      {L.days(n)}
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-3 rounded-lg border border-border">
                <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('drawer.usedBy')}
                </p>
                {c.usage.length === 0 ? (
                  <p className="px-3 py-2 text-muted-foreground">{t('drawer.notUsed')}</p>
                ) : (
                  <ul className="divide-y divide-border" data-testid="lch-usage-list">
                    {c.usage.map((u) => (
                      <li key={u.leaveRequestId} className="px-3 py-2 tabular-nums">
                        {t('drawer.usageLine', {
                          days: L.days(u.days),
                          dates: range(u.startDate, u.endDate),
                          leaveType: leaveTypeNames[u.leaveTypeId] ?? DAY_DASH,
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {c.settled && (
                <p className="mt-3" data-testid="lch-settled">
                  {c.settled.kind === 'expired'
                    ? t('drawer.forfeited', { days: L.days(c.settled.days), date: dmy(c.settled.on) })
                    : t('drawer.paidOut', { days: L.days(c.settled.days), date: dmy(c.settled.on) })}
                </p>
              )}
              {c.status === 'reversed' && c.reversedOn && (
                <p className="mt-3" data-testid="lch-reversed">
                  {t('drawer.reversed', { date: dmy(c.reversedOn) })}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </Drawer>
  );
}

/**
 * The filters: Credit Status, Day Type, Year, Date Worked From / To, Apply and Clear — a plain GET form, so
 * it works without script and every view is a link. On a phone it folds behind one "Filters" row.
 *
 * Choosing a Credit Status switches the tab to Approved when the form is applied (bc3e203d): the hidden `tab`
 * field is `tabAfterApply(current, chosen)`, the same pure function the suite pins.
 *
 * The Year defaults to the current year (the page passes it already selected); "All" is the value `all`. With
 * script the form navigates to an address holding only the fields that have a value (`filterFormQuery`), so
 * applying the filters does not write `day=&from=&to=`; without script it still works as a plain GET.
 */
export function LeaveCreditHistoryFilterForm({
  filters,
  years,
  size,
  clearHref,
}: {
  filters: CreditHistoryFilters;
  years: number[];
  /** Rows per page rides along so applying a filter does not reset it. */
  size: number | null;
  clearHref: string;
}) {
  const t = useTranslations('leaveCreditHistory');
  const tCredit = useTranslations('admin.leaveCredit');
  const tRR = useTranslations('replacementRequest');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [credit, setCredit] = useState<string>(filters.creditStatus ?? '');
  const tab: ApprovalTab = tabAfterApply(filters.tab, credit || null);
  const selectCls = 'h-10 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground';
  const labelCls = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground';

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="lch-filter-form"
        className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border px-3 text-left text-sm md:hidden"
      >
        <Filter className="size-4" aria-hidden />
        <span className="font-semibold">{t('filters.toggle')}</span>
        <span className="truncate text-muted-foreground">{t('filters.summary')}</span>
        <ChevronDown className={`ml-auto size-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <form
        id="lch-filter-form"
        method="GET"
        action="/leave/credit"
        data-testid="lch-filter-form"
        onSubmit={(e) => {
          e.preventDefault();
          const qs = filterFormQuery(new FormData(e.currentTarget).entries());
          router.push(qs ? `/leave/credit?${qs}` : '/leave/credit');
        }}
        className={`${open ? 'grid' : 'hidden'} mt-3 grid-cols-1 gap-3 sm:grid-cols-2 md:mt-0 md:grid md:grid-cols-[repeat(5,minmax(0,1fr))_auto_auto] md:items-end`}
      >
        {tab !== 'all' && <input type="hidden" name="tab" value={tab} />}
        {size != null && <input type="hidden" name="size" value={size} />}
        <label>
          <span className={labelCls}>{t('filters.creditStatus')}</span>
          <select name="credit" value={credit} onChange={(e) => setCredit(e.target.value)} className={selectCls}>
            <option value="">{t('filters.all')}</option>
            {LEAVE_CREDIT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {tCredit(CREDIT_STATUS_LABEL_KEY[s])}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>{t('filters.dayType')}</span>
          <select name="day" defaultValue={filters.dayType ?? ''} className={selectCls}>
            <option value="">{t('filters.all')}</option>
            {CREDIT_DAY_TYPES.map((d) => (
              <option key={d} value={d}>
                {tRR(DAY_TYPE_LABEL_KEY[d])}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>{t('filters.year')}</span>
          <select name="year" defaultValue={filters.year != null ? String(filters.year) : YEAR_ALL} className={selectCls}>
            <option value={YEAR_ALL}>{t('filters.all')}</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>{t('filters.from')}</span>
          <input type="date" name="from" defaultValue={filters.from ?? ''} className={selectCls} />
        </label>
        <label>
          <span className={labelCls}>{t('filters.to')}</span>
          <input type="date" name="to" defaultValue={filters.to ?? ''} className={selectCls} />
        </label>
        <button type="submit" className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          {t('filters.apply')}
        </button>
        <a href={clearHref} className="flex h-10 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">
          {t('filters.clear')}
        </a>
      </form>
    </div>
  );
}
