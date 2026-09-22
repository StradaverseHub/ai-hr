'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

export type EditDate = {
  iso: string;
  /** The localised "01 Sep" the grid's heading shows for this date — built by the SERVER, so the editor
   *  and the roster behind it cannot print a date two different ways. */
  day: string;
  dow: string;
  /** What this date currently resolves to (RD / OFF / a shift code / —), from lib/roster-month. */
  current: string;
  /** Today or earlier: already attended, so it is called out before it is overwritten. */
  past: boolean;
};

/**
 * The date tiles on the per-employee Edit screen (a57f0584 rev 2).
 *
 * A CLIENT ISLAND FOR ONE REASON: Select all / Clear. The tiles are ordinary checkboxes named
 * `shiftDates` inside the enclosing server `<form action={saveRosterRowAction}>`, so the form posts and
 * saves with JavaScript disabled and this component holds no submit path of its own. No server action is
 * passed in as a prop — a function crossing that boundary is the 500-on-every-request this codebase has
 * hit before; the island is INSIDE the form, not around it.
 */
export function RosterEditDates({ dates, initial }: { dates: EditDate[]; initial: string[] }) {
  const t = useTranslations('roster');
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const pastPicked = dates.filter((d) => d.past && picked.has(d.iso)).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setPicked(new Set(dates.map((d) => d.iso)))}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {t('selectAllDates')}
        </button>
        <button
          type="button"
          onClick={() => setPicked(new Set())}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {t('clearDates')}
        </button>
        <span className="text-xs text-muted-foreground">{t('applyRow', { count: picked.size })}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {dates.map((d) => {
          const on = picked.has(d.iso);
          return (
            <label
              key={d.iso}
              className={`flex min-w-[76px] cursor-pointer flex-col items-center rounded border px-1.5 py-1 text-[11px] ${
                on ? 'border-primary bg-primary/15' : 'border-border bg-background'
              }`}
            >
              <input
                type="checkbox"
                name="shiftDates"
                value={d.iso}
                className="sr-only"
                checked={on}
                onChange={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(d.iso)) n.delete(d.iso);
                    else n.add(d.iso);
                    return n;
                  })
                }
              />
              <span className="tabular-nums">{d.day}</span>
              <span className="text-[10px] text-muted-foreground">{d.dow}</span>
              <span className="truncate text-[10px] text-muted-foreground">{d.current}</span>
            </label>
          );
        })}
      </div>

      {/* The past-date warning the grid asks with window.confirm. On a screen there is room to SAY it
          rather than interrupt with it, and it updates as dates are ticked. */}
      {pastPicked > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300">
          {t('pastWarning', { count: pastPicked })}
        </p>
      )}
    </div>
  );
}
