'use client';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  activePerformanceTab,
  performanceAreaTab,
  PERFORMANCE_STRIP_LABEL_KEYS,
  type PerformanceAreaStrip,
  type PerformanceCalibrationHint,
  type PerformanceTabId,
  type PerformanceTabView,
} from '@/packs/performance/onehr/tab-model';

/**
 * D-P1-32 PT-X1: draws one strip of already-gated tabs (PerformanceTabStrip gates them) and lights the tab for
 * the current location (activePerformanceTab). Colours, borders and radii come from the theme tokens only; the
 * area theme (a separate package) supplies their values. The strip scrolls sideways inside itself on a narrow
 * screen rather than wrapping or widening the page.
 */
export function PerformanceTabNav({ strip, tabs, hint, targets }: { strip: PerformanceAreaStrip; tabs: readonly PerformanceTabView[]; hint?: PerformanceCalibrationHint; targets?: Partial<Record<PerformanceTabId, string>> }) {
  const t = useTranslations('performanceArea');
  const tWorkspace = useTranslations('onehr.workspace');
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const active = activePerformanceTab(strip, pathname, searchParams, hint);
  const drawn = tabs.flatMap(view => {
    const entry = performanceAreaTab(view.id);
    return entry && entry.strip === strip ? [{ entry, state: view.state }] : [];
  });
  if (!drawn.length) return null;
  const base = 'inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-[15px] py-[7px] text-sm pointer-coarse:min-h-11';
  return (
    <nav aria-label={t(PERFORMANCE_STRIP_LABEL_KEYS[strip])} data-performance-tabs={strip} className="pt-tabs max-w-full overflow-x-auto overscroll-x-contain">
      <ul className="inline-flex w-max flex-nowrap gap-0.5 rounded-[9px] border border-border bg-secondary p-[3px]">
        {drawn.map(({ entry, state }) => {
          const label = t(entry.labelKey);
          const on = entry.id === active;
          return (
            <li key={entry.id} className="shrink-0">
              {state === 'disabled' ? (
                <span aria-disabled="true" title={tWorkspace('planLocked')} data-tab={entry.id} className={cn(base, 'cursor-not-allowed font-medium text-muted-foreground opacity-60')}>
                  {label}
                  <Lock className="size-3.5 shrink-0" aria-hidden />
                </span>
              ) : (
                <Link
                  href={targets?.[entry.id as PerformanceTabId] ?? entry.href}
                  data-tab={entry.id}
                  aria-current={on ? 'page' : undefined}
                  className={cn(base, on ? 'bg-card font-semibold text-primary' : 'font-medium text-muted-foreground hover:text-foreground')}
                >
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
