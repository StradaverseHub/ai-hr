import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * r400 — in Monolith a badge is a STATUS WORD (docs/design/monolith README §4, components.md "Status
 * tones"): DM Mono 11px uppercase, tracking 0.12em, no fill, no pill — colour only reinforces the word.
 *   success, accent         → ink          (done, released, active, approved)
 *   warning, danger         → signal-text  (pending, overdue, blocking, needs you)
 *   default, info           → mid          (neutral, cancelled, inactive, upcoming)
 * Every class is `monolith:`-scoped and appended after Classic's, which are byte-identical to main's. The
 * `monolith:` variant is declared after `dark:` in app/globals.css, so it also wins over the dark tints.
 */
const MONO_WORD =
  ' monolith:rounded-none monolith:bg-transparent monolith:px-0 monolith:py-0 monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em]';
const MONO_INK = ' monolith:bg-transparent monolith:text-ink';
const MONO_SIGNAL = ' monolith:bg-transparent monolith:text-signal-text';
const MONO_MID = ' monolith:bg-transparent monolith:text-mid';

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize' + MONO_WORD, {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground' + MONO_MID,
      success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' + MONO_INK,
      warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' + MONO_SIGNAL,
      danger: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400' + MONO_SIGNAL,
      info: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' + MONO_MID,
      accent: 'bg-primary/10 text-primary' + MONO_INK,
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
