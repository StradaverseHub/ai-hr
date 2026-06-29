'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/** Pay-period filter for the payroll By-Batches list. Drives the `period` search param
 *  (Build #10), mirroring the URL-param pattern the Reports screen uses. Picking a period
 *  narrows the list to that period; "All periods" (value '') clears the filter. */
export function PeriodSwitcher({ options, active }: { options: string[]; active: string }) {
  const t = useTranslations('payroll.list');
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="payroll-period" className="text-xs font-medium text-muted-foreground">
        {t('periodContext')}
      </label>
      <select
        id="payroll-period"
        value={active}
        onChange={(e) => {
          const v = e.target.value;
          router.push(v ? `/payroll?period=${v}` : '/payroll', { scroll: false });
        }}
        className="h-8 rounded-lg border border-border bg-card px-2 text-sm tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
      >
        <option value="">{t('allPeriods')}</option>
        {options.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </div>
  );
}
