import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * r400 — Monolith primitives: STATUS WORD, LIVE DOT, STATUS LINE (docs/design/monolith README §3–4,
 * components.md). Theme-aware by CSS only (`monolith:` utilities, `.mono`/`.monolith-dot` which are styled
 * only under <html data-ui-theme="monolith">), so these are server-safe and paint Classic's look in Classic.
 */

/** components.md "Status tones": ink = done, released, active, approved; signal = pending, overdue,
 *  blocking, needs you; mid = neutral, cancelled, inactive, upcoming. */
export type StatusTone = 'ink' | 'signal' | 'mid';

/** The Badge variant that carries each tone. In Monolith Badge IS the status word (components/ui/badge.tsx);
 *  in Classic the same mapping gives today's pill colours (green done, amber pending, grey neutral). */
export const STATUS_TONE_VARIANT = { ink: 'success', signal: 'warning', mid: 'default' } as const satisfies Record<
  StatusTone,
  'success' | 'warning' | 'default'
>;

/** A status is a WORD; colour only reinforces it (README §8). The word is the caller's translated label. */
export function Status({
  word,
  tone = 'mid',
  className,
}: {
  word: React.ReactNode;
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <Badge variant={STATUS_TONE_VARIANT[tone]} data-tone={tone} className={className}>
      {word}
    </Badge>
  );
}

/** The live dot (shell.css `.dot`): a signal dot with a 2.4s beat in Monolith, a still dot in Classic.
 *  Decorative — the caller says in words what is live. Stops under prefers-reduced-motion (globals.css). */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-live-dot
      className={cn('monolith-dot inline-block size-2 shrink-0 rounded-full bg-emerald-500', className)}
    />
  );
}

/** The status footer (shell.css `.stat`): one mono line of facts. Each item is the caller's own text. */
export function StatusLine({ items, className }: { items: React.ReactNode[]; className?: string }) {
  return (
    <p
      data-status-line
      className={cn(
        'flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground',
        'monolith:gap-x-7 monolith:border-ink monolith:font-mono monolith:text-[11px] monolith:uppercase monolith:tracking-[0.14em] monolith:text-mid',
        className,
      )}
    >
      {items.map((item, i) => (
        <span key={i}>{item}</span>
      ))}
    </p>
  );
}
