'use client';

/**
 * Read-only leave-entitlement breakdown panel (shared by /me and /admin/personnel/[id]).
 *
 * Pure presentation: it renders the figures the server already reconstructed from the flat leave_ledger
 * (core/read.ts → leaveEntitlementBreakdown). It NEVER imports a DB client or a server action, so it is a
 * safe client component (no RSC boundary violation). The only interactivity is:
 *  - a local open/closed toggle (single-pager discipline: collapsed by default), and
 *  - an "as at date" GET form that re-renders the parent RSC with a new ?asOf= (and preserves any other
 *    query params the parent threads through via `hiddenParams`).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Card } from '@/components/ui';

/** Mirror of core/read.ts LeaveEntitlementBreakdown — kept structural so this stays db-free. */
export type EntitlementBreakdownData = {
  leaveTypeId: string;
  leaveType: string;
  asOf: string;
  cycleStart: string;
  currentYearEntitlement: number;
  monthlyAccruedToDate: number | null;
  carriedForward: number;
  carryForwardRemaining: number;
  carryForwardExpiryDate: string | null;
  forfeited: number;
  totalAvailable: number;
  transactions: { effectiveOn: string; entryType: string; days: number; sourceRequestId: string | null }[];
  /** Employee Leave View Configuration (65dec703): per-component ESS visibility (missing key ⇒ visible).
   *  Only consulted when `applyEssConfig` is set — i.e. on /me; admin/HR pass it false and see every row. */
  essView?: Record<string, boolean>;
};

const ENTRY_KEYS: Record<string, string> = {
  accrual: 'accrual',
  debit: 'debit',
  adjustment: 'adjustment',
  in_lieu_accrual: 'inLieuAccrual',
};

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium text-foreground'}`}>{value}</span>
    </div>
  );
}

export function EntitlementBreakdown({
  data,
  asOf,
  action,
  hiddenParams = {},
  applyEssConfig = false,
}: {
  data: EntitlementBreakdownData;
  /** The current as-at date driving the view (defaults to today server-side). */
  asOf: string;
  /** The GET target of the as-at form (the page path, e.g. '/me' or '/admin/personnel/<id>'). */
  action: string;
  /** Other query params to preserve across the as-at GET (kept as hidden inputs). */
  hiddenParams?: Record<string, string>;
  /** Employee Leave View Configuration (65dec703): when true (ESS /me), gate each row against
   *  `data.essView` (missing key ⇒ visible). Admin/HR leave it false so every row always shows — the SAME
   *  component renders on /admin/personnel/[id], and the spec scopes hiding to self-service only. */
  applyEssConfig?: boolean;
}) {
  const t = useTranslations('leave.breakdown');
  const [open, setOpen] = useState(false);

  const fmt = (n: number) => n.toFixed(2);
  // A component is shown when config is not applied (admin view) OR its key is not false in the resolved
  // ESS-view map (missing ⇒ visible). Gating only affects the /me surface.
  const show = (key: string) => !applyEssConfig || data.essView?.[key] !== false;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        {open ? t('hide') : t('viewBreakdown')}
      </button>

      {open && (
        <Card className="mt-2 border-border bg-muted/30 p-3 dark:bg-muted/20">
          {/* As-at date control — a single native date input that re-renders the RSC via ?asOf=. */}
          <form method="GET" action={action} className="mb-3 flex flex-wrap items-end gap-2">
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

          <div className="divide-y divide-border">
            {/* ESS-view gating (65dec703): entitlementToDate ⇒ current-year entitlement; ytdEntitled ⇒ the
                monthly-accrued-to-date line; broughtForward ⇒ carried + remaining carry; carryForwardExpiry,
                forfeited, available (the total). Admin view (applyEssConfig=false) always shows every row. */}
            {show('entitlementToDate') && (
              <Row label={t('currentYearEntitlement')} value={fmt(data.currentYearEntitlement)} />
            )}
            {data.monthlyAccruedToDate != null && show('ytdEntitled') && (
              <Row label={t('monthlyAccrued')} value={fmt(data.monthlyAccruedToDate)} />
            )}
            {show('broughtForward') && <Row label={t('carriedForward')} value={fmt(data.carriedForward)} />}
            {show('broughtForward') && (
              <Row label={t('carryForwardRemaining')} value={fmt(data.carryForwardRemaining)} />
            )}
            {show('carryForwardExpiry') && (
              <Row
                label={t('carryForwardExpiry')}
                value={data.carryForwardExpiryDate ?? t('noExpiry')}
                muted={!data.carryForwardExpiryDate}
              />
            )}
            {show('forfeited') && <Row label={t('forfeited')} value={fmt(data.forfeited)} />}
            {show('available') && (
              <div className="flex items-baseline justify-between gap-3 pt-1.5 text-sm font-semibold">
                <span className="text-foreground">{t('totalAvailable')}</span>
                <span className="tabular-nums text-foreground">{fmt(data.totalAvailable)}</span>
              </div>
            )}
          </div>

          {show('transactionHistory') && (
          <div className="mt-3">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('transactionsHeading')}
            </div>
            {data.transactions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noTransactions')}</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 font-medium">{t('colDate')}</th>
                    <th className="py-1 font-medium">{t('colEntry')}</th>
                    <th className="py-1 text-right font-medium">{t('colDays')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.transactions.map((tx, i) => (
                    <tr key={`${tx.effectiveOn}-${i}`}>
                      <td className="py-1 tabular-nums text-muted-foreground">{tx.effectiveOn}</td>
                      <td className="py-1">
                        <Badge>{t(`entryType.${ENTRY_KEYS[tx.entryType] ?? 'adjustment'}`)}</Badge>
                      </td>
                      <td className="py-1 text-right tabular-nums text-foreground">{tx.days.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          )}
        </Card>
      )}
    </div>
  );
}
