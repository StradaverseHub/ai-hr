'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const MS_DAY = 86_400_000;
const shiftIso = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_DAY).toISOString().slice(0, 10);

const iconBtn =
  'grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95';

/** Date navigation that drives a search param — weekly for the absences timeline
 *  (param `abs`, step 7) or daily for the attendance day view (param `date`, step 1). */
export function TimelineNav({
  from,
  isDefault,
  basePath = '/',
  param = 'abs',
  stepDays = 7,
}: {
  from: string;
  isDefault: boolean;
  basePath?: string;
  param?: string;
  stepDays?: number;
}) {
  const t = useTranslations('components.timelineNav');
  const router = useRouter();
  const searchParams = useSearchParams();
  // Preserve sibling query params (e.g. the Leave Calendar My/Team `view`) when stepping the window,
  // so navigating dates never silently resets the other controls.
  const go = (iso: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (iso) next.set(param, iso);
    else next.delete(param);
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
  };
  const unit = stepDays === 1 ? t('unitDay') : t('unitWeek');

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => go(shiftIso(from, -stepDays))}
        aria-label={t('previous', { unit })}
        className={iconBtn}
      >
        <ChevronLeft className="size-4" />
      </button>
      <input
        type="date"
        value={from}
        onChange={(e) => {
          const v = e.target.value;
          if (v && v !== from) go(v);
        }}
        aria-label={stepDays === 1 ? t('dateLabel') : t('windowStartLabel')}
        className="h-7 rounded-lg border border-border bg-card px-2 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
      />
      <button
        type="button"
        onClick={() => go(shiftIso(from, stepDays))}
        aria-label={t('next', { unit })}
        className={iconBtn}
      >
        <ChevronRight className="size-4" />
      </button>
      {!isDefault && (
        <button
          type="button"
          onClick={() => go(null)}
          className="h-7 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95"
        >
          {t('today')}
        </button>
      )}
    </div>
  );
}
