'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { MONO_LABEL } from './classes';

/**
 * r400 — Monolith primitive: SECTION (docs/design/monolith shell.css `.sec`, `.sh`, `.tabs`, `.navl`;
 * generator.py `render_section`). "Sections: 1px ink top, a mono index label (`01 · Period`) left and tabs or
 * a note right, then content. Never a card." (README §3). components.md: card.tsx BECOMES this — so in
 * Classic a Section paints exactly as a <Card> with a <CardHeader>/<CardContent> would, and a screen that
 * adopts it in step 4 keeps today's Classic look.
 *
 * Client component only because a tab may carry an onSelect handler; the server-client-boundary guard then
 * stops a server page from passing it a closure. Tabs with `href` work from a server page.
 */
export type SectionTab = {
  key: string;
  label: React.ReactNode;
  current?: boolean;
  /** A filter tab: a <button aria-pressed>. */
  onSelect?: () => void;
  /** A route tab: a link with aria-current="page" when current. */
  href?: string;
};

export function Section({
  index,
  label,
  tabs,
  right,
  children,
  className,
  bodyClassName,
}: {
  /** The section's ordinal, shown zero-padded (`01`). Optional. */
  index?: number;
  label?: React.ReactNode;
  tabs?: SectionTab[];
  /** A note or action on the header's right. */
  right?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const headingId = React.useId();
  const hasHead = label != null || index != null || (tabs && tabs.length > 0) || right != null;
  return (
    <section
      aria-labelledby={label != null || index != null ? headingId : undefined}
      data-section
      className={cn(
        // Classic: card.tsx's Card, verbatim.
        'rounded-[1.25rem] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]',
        'monolith:flex monolith:flex-col monolith:gap-2.5 monolith:rounded-none monolith:border-0 monolith:border-t monolith:border-ink monolith:bg-transparent monolith:pt-3 monolith:shadow-none',
        className,
      )}
    >
      {hasHead && (
        <div
          className={cn(
            // Classic: CardHeader's spacing and rule.
            'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3',
            'monolith:items-baseline monolith:border-b-0 monolith:p-0',
          )}
        >
          {(label != null || index != null) && (
            <h2 id={headingId} className={cn('text-sm font-medium', MONO_LABEL, 'monolith:text-mid')}>
              {index != null && (
                <span className="num tabular-nums text-muted-foreground monolith:text-mid">
                  {String(index).padStart(2, '0')}
                  {label != null && ' · '}
                </span>
              )}
              {label}
            </h2>
          )}
          {tabs && tabs.length > 0 && (
            <div className={cn('flex flex-wrap gap-1', 'monolith:gap-5')} data-section-tabs>
              {tabs.map((t) => {
                const cls = cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                  t.current && 'bg-secondary text-secondary-foreground',
                  MONO_LABEL,
                  'monolith:rounded-none monolith:border-b monolith:border-transparent monolith:bg-transparent monolith:px-0 monolith:py-1.5 monolith:text-mid monolith:hover:bg-transparent monolith:hover:text-ink',
                  t.current && 'monolith:border-ink monolith:text-ink',
                );
                return t.href != null ? (
                  <Link key={t.key} href={t.href} aria-current={t.current ? 'page' : undefined} className={cls}>
                    {t.label}
                  </Link>
                ) : (
                  <button key={t.key} type="button" aria-pressed={!!t.current} onClick={t.onSelect} className={cls}>
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
          {right != null && <div className={cn('text-xs text-muted-foreground', MONO_LABEL, 'monolith:text-mid')}>{right}</div>}
        </div>
      )}
      <div className={cn('p-4', 'monolith:p-0', bodyClassName)}>{children}</div>
    </section>
  );
}
