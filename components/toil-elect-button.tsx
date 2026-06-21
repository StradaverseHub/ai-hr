'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { accrueToilAction } from '@/app/roster/actions';

/** "Bank in lieu" on a rest-worked variance row (ADR-0033). Calls accrueToil and reports the credit (with a
 *  compliance note for First-Schedule employees) or the refusal reason inline. */
export function ToilElectButton({ employmentId, workedDate }: { employmentId: string; workedDate: string }) {
  const t = useTranslations('roster');
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<{ days: number; warning?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const click = () =>
    start(async () => {
      setError(null);
      const r = await accrueToilAction({ employmentId, workedDate });
      if (r.ok) {
        setDone({ days: r.daysCredited, warning: r.warning });
        router.refresh();
      } else {
        setError(r.error);
      }
    });

  if (done) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        {t('bankInLieuDone', { days: done.days })}
        {done.warning && (
          <span className="text-amber-600 dark:text-amber-400" title={done.warning}>
            ⚠
          </span>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error && (
        <span className="max-w-[16rem] truncate text-xs text-red-600 dark:text-red-400" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        onClick={click}
        disabled={pending}
        className="rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
      >
        {pending ? t('bankInLieuPending') : t('bankInLieu')}
      </button>
    </span>
  );
}
