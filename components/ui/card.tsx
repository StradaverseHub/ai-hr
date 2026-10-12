import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * r400 — in Monolith a card is a SECTION (docs/design/monolith README §3–4, shell.css `.sec`, `.sh`):
 * nothing is a card, so no radius, side borders, fill or shadow — a 1px ink rule on top, the header a mono
 * label with no rule under it, content flush with the page's left edge. Classic's strings are byte-identical
 * to main's; the Monolith classes are appended and `monolith:`-scoped. A caller's own tint (an amber alert
 * card, say) is overridden in Monolith too — README §8, no tinted panels.
 */
const MONO_SECTION =
  'monolith:rounded-none monolith:border-0 monolith:border-t monolith:border-ink monolith:bg-transparent monolith:shadow-none';
const MONO_HEADER = 'monolith:border-b-0 monolith:px-0 monolith:pt-3 monolith:pb-2';
const MONO_TITLE =
  'monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid';
const MONO_CONTENT = 'monolith:px-0';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-ui-card
      className={cn(
        'rounded-[1.25rem] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]',
        MONO_SECTION,
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-ui-card-header className={cn('flex items-center justify-between border-b border-border px-4 py-3', MONO_HEADER, className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-medium', MONO_TITLE, className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', MONO_CONTENT, className)} {...props} />;
}
