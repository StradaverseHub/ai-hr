'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { MONO_LABEL } from './classes';

/**
 * r400 — Monolith primitives: STEPS and RULER (docs/design/monolith shell.css `.steps`, `.step`, `.ruler`,
 * `.tick`; generator.py `render_section` kinds 'steps' / 'ruler').
 *
 * The current step's line and the picked tick carry a signal glow — a static mark, never animated (README §6).
 * Client component because the ruler takes an `onPick` handler.
 */
export type StepState = 'done' | 'cur' | 'todo';
export type Step = { key: string; label: React.ReactNode; sub?: React.ReactNode; state: StepState };

/** A wizard header: an ordered list, aria-current="step" on the current one. */
export function Steps({ steps, label, className }: { steps: Step[]; label?: string; className?: string }) {
  return (
    <ol aria-label={label} data-steps className={cn('flex gap-2 monolith:gap-0', className)}>
      {steps.map((s) => (
        <li
          key={s.key}
          aria-current={s.state === 'cur' ? 'step' : undefined}
          data-state={s.state}
          className="flex min-w-0 flex-1 flex-col gap-1.5 monolith:pr-2.5"
        >
          <span
            className={cn(
              'text-xs font-medium',
              s.state === 'cur' ? 'text-primary monolith:text-signal-text' : s.state === 'todo' ? 'text-muted-foreground monolith:text-mid' : 'monolith:text-ink',
              MONO_LABEL,
            )}
          >
            {s.label}
          </span>
          {s.sub != null && <span className="text-[13px] text-muted-foreground monolith:text-mid">{s.sub}</span>}
          <i
            aria-hidden="true"
            className={cn(
              'mt-1.5 block h-0.5 rounded-full monolith:h-px monolith:rounded-none',
              s.state === 'todo' ? 'bg-border monolith:bg-hairline' : 'bg-primary monolith:bg-ink',
              s.state === 'cur' && 'monolith:bg-signal monolith:shadow-[0_0_8px_rgb(255_77_0/0.6)]',
            )}
          />
        </li>
      ))}
    </ol>
  );
}

export type Tick = { key: string; label: React.ReactNode; sub?: React.ReactNode; past?: boolean };

/**
 * The time scrubber (month pickers, year filters): a group of tick buttons, aria-pressed on the picked one.
 * `label` names the group ("Pay period"); each tick's own text is its name.
 */
export function Ruler({
  ticks,
  on,
  onPick,
  label,
  className,
}: {
  ticks: Tick[];
  on?: string;
  onPick?: (key: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} data-ruler className={cn('relative flex border-t border-border monolith:h-[72px] monolith:border-ink', className)}>
      {ticks.map((t) => {
        const picked = t.key === on;
        return (
          <button
            key={t.key}
            type="button"
            aria-pressed={picked}
            onClick={onPick ? () => onPick(t.key) : undefined}
            className={cn(
              'relative flex-1 px-0 pt-3 pb-2 text-left text-xs leading-[1.7] text-muted-foreground',
              'before:absolute before:top-0 before:left-0 before:h-2.5 before:w-px before:bg-border',
              MONO_LABEL,
              'monolith:text-mid monolith:before:bg-ink',
              t.past && 'text-foreground monolith:text-ink',
              picked &&
                'font-semibold text-primary before:h-4 before:w-0.5 before:bg-primary monolith:font-normal monolith:text-signal-text monolith:before:h-6 monolith:before:w-0.5 monolith:before:bg-signal monolith:before:shadow-[0_0_10px_rgb(255_77_0/0.6)]',
            )}
          >
            <b className="font-medium text-inherit">{t.label}</b>
            {t.sub != null && (
              <>
                <br />
                {t.sub}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
