import * as React from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status';
import { MONO_LABEL, MONO_NUM } from './classes';

/**
 * r400 — Monolith primitives: STAT CELLS and the SPEC GRID (docs/design/monolith shell.css `.cells`,
 * `.cell`, `.kv`; generator.py `render_section` kind 'kv' and `build` cells). Both are description lists —
 * a label and its value — so they render as <dl> with <dt>/<dd> pairs (a <div> per pair is valid HTML).
 *
 * FIGURES ARE FLAT, STATIC AND TABULAR (README intro, §6): every value is `.num` + `tabular-nums`, nothing here
 * transitions or animates, in either theme. Theme by CSS only; server-safe.
 */

const TONE_TEXT: Record<StatusTone, string> = {
  ink: 'monolith:text-ink',
  signal: 'text-amber-700 dark:text-amber-400 monolith:text-signal-text',
  mid: 'text-muted-foreground monolith:text-mid',
};

export type Cell = {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  sub?: React.ReactNode;
  /** Needs attention: the label and figure in signal-text (Classic: amber). Never a fill. */
  signal?: boolean;
};

/** A row of 3–5 stat cells divided by hairlines, big mono figures (README §3 "Header"). */
export function Cells({ items, className }: { items: Cell[]; className?: string }) {
  return (
    <dl
      data-cells
      style={{ ['--cells' as string]: items.length }}
      className={cn(
        'grid grid-cols-2 gap-3 md:grid-cols-[repeat(var(--cells),minmax(0,1fr))]',
        'monolith:gap-0',
        className,
      )}
    >
      {items.map((c, i) => (
        <div
          key={i}
          className={cn(
            'flex flex-col gap-1.5 rounded-[1.25rem] border border-border bg-card p-4 shadow-[var(--shadow-card)]',
            'monolith:rounded-none monolith:border-0 monolith:border-l monolith:border-hairline monolith:bg-transparent monolith:px-[18px] monolith:pt-4 monolith:pb-[18px] monolith:shadow-none monolith:first:border-l-0 monolith:first:pl-0',
          )}
        >
          <dt
            className={cn(
              'text-xs font-medium uppercase tracking-wide text-muted-foreground',
              MONO_LABEL,
              c.signal ? TONE_TEXT.signal : 'monolith:text-mid',
            )}
          >
            {c.label}
          </dt>
          <dd className="m-0">
            <b
              className={cn(
                MONO_NUM,
                'text-3xl font-semibold leading-none',
                'monolith:text-[36px] monolith:font-medium monolith:tracking-[-0.03em]',
                c.signal && TONE_TEXT.signal,
              )}
            >
              {c.value}
              {c.unit != null && (
                <small className="ml-1.5 text-sm font-normal tracking-normal text-muted-foreground monolith:text-[14px] monolith:text-mid">
                  {c.unit}
                </small>
              )}
            </b>
            {c.sub != null && <span className="mt-1.5 block text-[13px] text-muted-foreground monolith:text-mid">{c.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export type KvItem = {
  label: React.ReactNode;
  value: React.ReactNode;
  /** A big figure: 28px mono in Monolith. */
  big?: boolean;
  tone?: StatusTone;
  sub?: React.ReactNode;
};

/** The read-only form: mono label over a 500-weight value, each pair under a hairline (shell.css `.kv`). */
export function Kv({ items, cols = 3, className }: { items: KvItem[]; cols?: number; className?: string }) {
  return (
    <dl
      data-kv
      style={{ ['--kv-cols' as string]: cols }}
      className={cn('grid grid-cols-1 gap-x-5 gap-y-3 text-sm sm:grid-cols-[repeat(var(--kv-cols),minmax(0,1fr))]', className)}
    >
      {items.map((f, i) => (
        <div key={i} className="flex min-w-0 flex-col gap-1 border-t border-border py-2.5 monolith:border-hairline">
          <dt className={cn('text-xs text-muted-foreground monolith:text-mid', MONO_LABEL)}>{f.label}</dt>
          <dd
            className={cn(
              'm-0 font-medium monolith:text-[15px]',
              f.big && cn(MONO_NUM, 'text-xl font-semibold monolith:text-[28px] monolith:font-medium monolith:tracking-[-0.03em]'),
              f.tone && TONE_TEXT[f.tone],
            )}
          >
            {f.value}
          </dd>
          {f.sub != null && <dd className="m-0 text-xs text-muted-foreground monolith:text-[12px] monolith:text-mid">{f.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}
