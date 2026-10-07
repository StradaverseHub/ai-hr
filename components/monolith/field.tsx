'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { MONO_LABEL } from './classes';

/**
 * r400 — Monolith primitives: FIELD and SWITCH (docs/design/monolith shell.css `.fd`, `.sw`; generator.py
 * `render_section` kind 'form').
 *
 * Field is the label-above wrapper the boards put around every input: a <label> that CONTAINS its control,
 * so the association needs no id. Put an <Input>, <select> or <textarea> inside; <Input> already draws the
 * underline in Monolith (components/ui/input.tsx).
 *
 * Switch is a real checkbox with role="switch" (visually hidden, still focusable and form-submitted) and a
 * drawn track: a 40×22 hairline pill with an ink dot; off moves the dot and hollows it (README §4). Classic
 * paints a conventional track. Client component because of the change handler.
 */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label data-field className={cn('flex flex-col gap-1.5', className)}>
      <span className={cn('text-sm font-medium', MONO_LABEL, 'monolith:text-mid')}>{label}</span>
      {children}
      {hint != null && <span className="text-xs text-muted-foreground monolith:text-[12px] monolith:text-mid">{hint}</span>}
    </label>
  );
}

export type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> & {
  label: React.ReactNode;
  onCheckedChange?: (checked: boolean) => void;
};

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { label, onCheckedChange, onChange, className, disabled, ...input },
  ref,
) {
  return (
    <label
      data-switch
      className={cn(
        'flex min-h-10 cursor-pointer items-center justify-between gap-3.5 text-sm',
        'monolith:border-t monolith:border-hairline monolith:text-[14px]',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span>{label}</span>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        disabled={disabled}
        className="peer sr-only"
        onChange={(e) => {
          onChange?.(e);
          onCheckedChange?.(e.currentTarget.checked);
        }}
        {...input}
      />
      <i
        aria-hidden="true"
        className={cn(
          // Classic: a filled track, the knob slides right when on.
          'relative h-5 w-9 flex-none rounded-full bg-border transition-colors peer-checked:bg-primary',
          'after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-card after:shadow-sm after:transition-transform peer-checked:after:translate-x-4',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-focus-visible:outline-solid',
          // Monolith (.sw i): hairline-ink pill, ink dot at 3px when on; off moves it to 21px and hollows it.
          'monolith:h-[22px] monolith:w-10 monolith:border monolith:border-ink monolith:bg-transparent monolith:peer-checked:bg-transparent',
          'monolith:after:top-[3px] monolith:after:left-[21px] monolith:after:size-3 monolith:after:border monolith:after:border-ink monolith:after:bg-transparent monolith:after:shadow-none',
          'monolith:peer-checked:after:left-[3px] monolith:peer-checked:after:size-3.5 monolith:peer-checked:after:translate-x-0 monolith:peer-checked:after:border-0 monolith:peer-checked:after:bg-ink',
          'monolith:peer-focus-visible:outline-signal monolith:peer-focus-visible:outline-offset-[3px]',
        )}
      />
    </label>
  );
});
