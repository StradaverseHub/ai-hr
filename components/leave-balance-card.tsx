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
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui';
import { dayPluralCategory, formatDays } from '@/lib/day-format';

export type LeaveBalanceOption = { leaveTypeId: string; leaveType: string; available: number };

export function LeaveBalanceCard({
  balances,
  href,
}: {
  balances: LeaveBalanceOption[];
  href: string;
}) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const [selectedId, setSelectedId] = useState(balances[0]?.leaveTypeId ?? '');
  const selected = balances.find((b) => b.leaveTypeId === selectedId) ?? balances[0] ?? null;

  return (
    // r401 — Monolith: drawn as the dashboard board's stat `.cell` (no rule on top, mono label, 36px mono figure,
    // an underlined select). Appended `monolith:` classes only; Classic's strings are unchanged.
    <Card className="h-full p-5 monolith:flex monolith:flex-col monolith:gap-1.5 monolith:border-t-0 monolith:px-0 monolith:pt-4 monolith:pb-[18px]">
      <div className="flex items-center justify-between gap-2">
        <Link
          href={href}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:tracking-[0.12em] monolith:text-mid monolith:hover:text-ink"
        >
          {t('leaveBalance')}
        </Link>
      </div>
      {balances.length === 0 ? (
        <div className="mt-2 text-sm text-muted-foreground monolith:mt-0 monolith:text-[13px] monolith:text-mid">{t('noLeaveTypes')}</div>
      ) : (
        <>
          <div className="mt-2 text-3xl font-semibold tracking-tight tabular-nums monolith:mt-0 monolith:font-mono monolith:text-[28px] monolith:font-medium monolith:leading-none monolith:tracking-[-0.03em] monolith:text-ink">
            {/* 4a1abc4a: the dashboard's headline balance is the SAME `available` figure the /leave cards
                and the balance grid show, so it prints the same way. `daysRemaining` used to be an ICU
                plural whose `#` formatted the raw number ("12.5 days remaining") — the drift the reporter
                is describing.

                TWO ARGUMENTS, ON PURPOSE. `v` is the formatted text that prints; `cat` is the CLDR plural
                category for that text, computed at the SAME precision it is shown in. An earlier version
                dropped the plural and justified it with "two visible fraction digits always select CLDR's
                other form" — true in five of our six locales, FALSE IN TAMIL, whose rule is `i = 0 or n = 1`,
                so 1.00 selects `one` and Tamil uses a different word for it. Putting the plural back as a
                plain ICU `plural` was ALSO wrong: ICU selects on the number with zero fraction digits, so
                English read "1.00 day remaining". See dayPluralCategory. */}
            {t('daysRemaining', {
              v: formatDays(selected ? selected.available : 0),
              cat: dayPluralCategory(selected ? selected.available : 0, locale),
            })}
          </div>
          <select
            aria-label={t('selectLeaveType')}
            value={selectedId}
            onChange={(e) => setSelectedId(e.currentTarget.value)}
            className="mt-2 h-8 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 monolith:mt-1 monolith:h-9 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink monolith:bg-transparent monolith:px-0 monolith:text-[13px] monolith:focus:ring-0 monolith:focus-visible:outline-2"
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
