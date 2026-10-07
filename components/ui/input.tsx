import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * r400 — Monolith's underlined field (docs/design/monolith/shell.css `.fd input`): no box, no fill, no
 * shadow, a 1px ink bottom rule, 40px tall, 500 weight at 15px; focus turns the rule signal and thickens it
 * by a 1px shadow (no layout shift). The label above the field is <Field> (components/monolith/field.tsx) —
 * an <input> has no label of its own. Appended after Classic's string, which is byte-identical to main's.
 */
export const MONO_FIELD =
  'monolith:h-10 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-input monolith:bg-transparent monolith:px-0 monolith:py-2 monolith:text-[15px] monolith:font-medium monolith:shadow-none monolith:placeholder:text-faint monolith:focus-visible:border-signal monolith:focus-visible:ring-0 monolith:focus-visible:shadow-[0_1px_0_0_var(--signal)]';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50',
        MONO_FIELD,
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
