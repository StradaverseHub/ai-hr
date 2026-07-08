'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmSubmit } from './ui/confirm-submit';

/**
 * Basic Salary revision — live increment preview + confirm-before-save (feedback 87c82b18).
 *
 * A small client island that lives INSIDE the server-rendered `<form action={setCompensationAction}>` on
 * the Payroll tab (f2904eeb: the panel stays a server component; only interactivity is extracted here).
 * It watches the sibling `basicSalary` input by name, live-computes the increment vs the current active
 * salary, and submits through the shared ConfirmSubmit dialog. When there is no current salary (the very
 * first record) there is nothing to increment against, so the preview is hidden.
 */
export function SalaryRevisionConfirm({
  currentBasic,
  currency,
}: {
  currentBasic: number | null;
  currency: string;
}) {
  const t = useTranslations('people.detail');
  const ref = useRef<HTMLDivElement>(null);
  const [basic, setBasic] = useState<number | null>(currentBasic);

  useEffect(() => {
    const form = ref.current?.closest('form');
    const input = form?.querySelector('input[name="basicSalary"]') as HTMLInputElement | null;
    if (!input) return;
    const handler = () => {
      const v = input.value.trim();
      setBasic(v === '' ? null : Number(v));
    };
    input.addEventListener('input', handler);
    handler();
    return () => input.removeEventListener('input', handler);
  }, []);

  const fmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Increment only makes sense against an existing active salary. currentBasic > 0 guards the percentage.
  const amount = currentBasic != null && basic != null && !Number.isNaN(basic) ? basic - currentBasic : null;
  const pct = amount != null && currentBasic != null && currentBasic > 0 ? (amount / currentBasic) * 100 : null;
  const showPreview = amount != null;

  return (
    <div ref={ref} className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {showPreview ? (
          <span
            className={
              amount! > 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : amount! < 0
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-muted-foreground'
            }
          >
            {t('salaryIncrementPreview', {
              amount: `${currency} ${fmt(amount!)}`,
              pct: pct != null ? pct.toFixed(2) : '—',
            })}
          </span>
        ) : null}
      </div>
      <ConfirmSubmit
        variant="default"
        title={t('salaryRevisionConfirmTitle')}
        description={t('salaryRevisionConfirmDescription')}
        confirmLabel={t('updatePay')}
      >
        {t('updatePay')}
      </ConfirmSubmit>
    </div>
  );
}
