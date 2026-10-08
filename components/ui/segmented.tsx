import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * r427 (50ed39e1 contest) — a choice of a few options as a row of buttons. Every option has its own border and
 * the row wraps with a gap, so a long translated option moves to the next line whole instead of breaking one
 * shared outer border (the old control was one bordered box whose wrapped second row split it).
 * A radiogroup of role="radio" buttons, as before. No hooks, so it is usable from either side; the handler
 * means only a client component can pass it one.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5" data-segmented>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-9 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 [overflow-wrap:anywhere]',
              on ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background hover:bg-muted',
              'monolith:rounded-none monolith:border-ink',
              on ? 'monolith:bg-ink monolith:text-bone' : 'monolith:bg-transparent monolith:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
