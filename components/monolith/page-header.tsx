import * as React from 'react';
import { cn } from '@/lib/utils';
import { MONO_LABEL } from './classes';

/**
 * r401 — Monolith primitive: the PAGE HEADER (docs/design/monolith README §3 "Header", components.md
 * `PageHeader({ kicker, title, actions, cells })`): a mono kicker (scope · date), the `h1`, optional actions
 * (one `.pill`, the rest `.txt`), and whatever the caller puts beside it (stat cells).
 *
 * MONOLITH-ONLY MARKUP. Unlike the r400 primitives this one has no Classic look of its own: a screen renders it
 * only on its Monolith branch and keeps its own `PageHeader` for Classic, because Classic's header is a
 * different structure (a 20px title and a description line), not a restyle of this one. Carries no strings.
 */
export function MonoPageHeader({
  kicker,
  title,
  actions,
  aside,
  className,
}: {
  /** The mono line above the title — the caller's text (scope · date, or the person's identity). */
  kicker?: React.ReactNode;
  title: React.ReactNode;
  /** Text buttons / links under the title. */
  actions?: React.ReactNode;
  /** Right of the title block on wide screens (the board's stat cells). */
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <section data-mono-header className={cn('flex flex-wrap items-end justify-between gap-6', className)}>
      <div className="min-w-0 flex-[1_1_420px]">
        {kicker != null && <p className={cn(MONO_LABEL, 'm-0 text-mid')}>{kicker}</p>}
        <h1 className="mt-1.5 text-[40px] font-medium leading-[0.96] tracking-[-0.04em] text-ink min-[900px]:text-[56px]">
          {title}
        </h1>
        {actions != null && <div className="mt-3.5 flex flex-wrap items-center gap-x-[22px] gap-y-2">{actions}</div>}
      </div>
      {aside != null && <div className="min-w-0 flex-[0_1_640px]">{aside}</div>}
    </section>
  );
}
