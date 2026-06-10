'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const MS_DAY = 86_400_000;
const shiftIso = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_DAY).toISOString().slice(0, 10);

const iconBtn =
  'grid size-7 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95';

/** Date-window navigation for the Planned Absences timeline — drives the `abs` search param. */
export function TimelineNav({ from, isDefault }: { from: string; isDefault: boolean }) {
  const router = useRouter();
  const go = (iso: string | null) => router.push(iso ? `/?abs=${iso}` : '/', { scroll: false });

  return (
    <div className="flex items-center gap-1.5">
      <button type="button" onClick={() => go(shiftIso(from, -7))} aria-label="Previous week" className={iconBtn}>
        <ChevronLeft className="size-4" />
      </button>
      <input
        type="date"
        value={from}
        onChange={(e) => {
          const v = e.target.value;
          if (v && v !== from) go(v);
        }}
        aria-label="Window start date"
        className="h-7 rounded-lg border border-border bg-card px-2 text-xs tabular-nums text-foreground outline-none transition-colors focus-visible:border-ring"
      />
      <button type="button" onClick={() => go(shiftIso(from, 7))} aria-label="Next week" className={iconBtn}>
        <ChevronRight className="size-4" />
      </button>
      {!isDefault && (
        <button
          type="button"
          onClick={() => go(null)}
          className="h-7 rounded-lg border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition duration-150 ease-snappy hover:bg-accent hover:text-foreground active:scale-95"
        >
          Today
        </button>
      )}
    </div>
  );
}
