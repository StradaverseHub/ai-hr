'use client';

/**
 * Employee dashboard card: leave balance with a leave-type selector (R17 e6f0384c).
 *
 * A Server Component can't pass state/handlers across the client boundary, so the interactive
 * `<select>` lives here as a `'use client'` island (see app/analytics/YearSelect.tsx for the pattern).
 * The server pre-fetches the balances (RLS-scoped to the caller's own employment via `leaveBalances`)
 * and passes them in; this island only picks which type's `available` figure to show — it reads no
 * data of its own. The card header links to /leave; the `<select>` is deliberately OUTSIDE that link
 * so choosing a type doesn't navigate.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { formatDays } from '@/lib/day-format';

export type LeaveBalanceOption = { leaveTypeId: string; leaveType: string; available: number };

export function LeaveBalanceCard({
  balances,
  href,
}: {
  balances: LeaveBalanceOption[];
  href: string;
}) {
  const t = useTranslations('dashboard');
  const [selectedId, setSelectedId] = useState(balances[0]?.leaveTypeId ?? '');
  const selected = balances.find((b) => b.leaveTypeId === selectedId) ?? balances[0] ?? null;

  return (
    <Card className="h-full p-5">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={href}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {t('leaveBalance')}
        </Link>
      </div>
      {balances.length === 0 ? (
        <div className="mt-2 text-sm text-muted-foreground">{t('noLeaveTypes')}</div>
      ) : (
        <>
          <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {/* 4a1abc4a: the dashboard's headline balance is the SAME `available` figure the /leave cards
                and the balance grid show, so it prints the same way. `daysRemaining` used to be an ICU
                plural whose `#` formatted the raw number ("12.5 days remaining") — the drift the reporter
                is describing. All six catalogs now take a pre-formatted `{d}`; dropping the plural is not a
                translation loss, because a figure that always carries two decimals has visible fraction
                digits and therefore always selects CLDR's "other" form anyway. */}
            {t('daysRemaining', { d: formatDays(selected ? selected.available : 0) })}
          </div>
          <select
            aria-label={t('selectLeaveType')}
            value={selectedId}
            onChange={(e) => setSelectedId(e.currentTarget.value)}
            className="mt-2 h-8 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {balances.map((b) => (
              <option key={b.leaveTypeId} value={b.leaveTypeId}>
                {b.leaveType}
              </option>
            ))}
          </select>
        </>
      )}
    </Card>
  );
}
