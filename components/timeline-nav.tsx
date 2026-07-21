'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftMonthIso } from '@/lib/leave-calendar-range';

const MS_DAY = 86_400_000;
const shiftIso = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_DAY).toISOString().slice(0, 10);

const iconBtn =
  'grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95';

/** Date navigation that drives a search param — weekly for the absences timeline
 *  (param `abs`, step 7) or daily for the attendance day view (param `date`, step 1).
 *
 *  ee55f5fe: `mode: 'month'` steps whole months (shiftMonthIso, never drifting on short months) and
 *  renders a MONTH picker. The format mapping matters: the page anchor is uniformly YYYY-MM-DD but
 *  <input type="month"> speaks YYYY-MM, so the picker renders `from.slice(0, 7)` and writes back
 *  `${v}-01` — without that the input renders blank and its onChange emits a value the page regex
 *  rejects. Week and day modes keep their behaviour byte-for-byte (mode defaults from stepDays).
 *
 *  eae550e9 step 4: `onGo`, when provided, delegates navigation to the caller — the dashboard's
 *  client panel owns the useTransition + optimistic date so the calendar can show a busy state.
 *  Without it this component pushes the router itself, exactly as before. */
export function TimelineNav({
  from,
  isDefault,
  basePath = '/',
  param = 'abs',
  stepDays = 7,
  mode,
  onGo,
}: {
  from: string;
  isDefault: boolean;
  basePath?: string;
  param?: string;
  stepDays?: number;
  mode?: 'day' | 'week' | 'month';
  onGo?: (iso: string | null) => void;
}) {
  const t = useTranslations('components.timelineNav');
  const router = useRouter();
  const searchParams = useSearchParams();
  const effectiveMode = mode ?? (stepDays === 1 ? 'day' : 'week');
  // Preserve sibling query params (e.g. the Leave Calendar My/Team `view`) when stepping the window,
  // so navigating dates never silently resets the other controls.
  const go = (iso: string | null) => {
    if (onGo) {
      onGo(iso);
      return;
    }
    const next = new URLSearchParams(searchParams.toString());
    if (iso) next.set(param, iso);
    else next.delete(param);
    const qs = next.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
  };
  const step = (dir: 1 | -1) =>
    go(effectiveMode === 'month' ? shiftMonthIso(from, dir) : shiftIso(from, dir * stepDays));
  const unit =
    effectiveMode === 'day' ? t('unitDay') : effectiveMode === 'month' ? t('unitMonth') : t('unitWeek');

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => step(-1)} aria-label={t('previous', { unit })} className={iconBtn}>
        <ChevronLeft className="size-4" />
      </button>
      {effectiveMode === 'month' ? (
        <input
          type="month"
          value={from.slice(0, 7)}
          onChange={(e) => {
            const v = e.target.value;
            if (v && `${v}-01` !== from) go(`${v}-01`);
          }}
          aria-label={t('windowStartLabel')}
          className="h-7 rounded-lg border border-border bg-card px-2 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
        />
      ) : (
        <input
          type="date"
          value={from}
          onChange={(e) => {
            const v = e.target.value;
            if (v && v !== from) go(v);
          }}
          aria-label={effectiveMode === 'day' ? t('dateLabel') : t('windowStartLabel')}
          className="h-7 rounded-lg border border-border bg-card px-2 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
        />
      )}
      <button type="button" onClick={() => step(1)} aria-label={t('next', { unit })} className={iconBtn}>
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
