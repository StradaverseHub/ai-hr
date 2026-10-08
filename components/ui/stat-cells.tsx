import * as React from 'react';
import { cn } from '@/lib/utils';
import { typeLabelCls } from './section-card';

/**
 * r427 (50ed39e1 contest) — a row of figures divided by thin lines, instead of boxed tiles. Four to a row once
 * the section is 48rem wide, two below. Figures are tabular. Server-safe.
 *
 * The dividers are each cell's own top and left hairline: a cell that starts a row has no left line, so the
 * grid has no outer box. The first cell of every row is flush with the section's left edge.
 */
export type StatCell = {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Needs attention: the figure in the error colour (Classic text-destructive; Monolith signal-text). */
  warn?: boolean;
  /** A word or date rather than a count: drawn smaller so it wraps inside its cell. */
  text?: boolean;
};

export function StatCells({ cells, className }: { cells: StatCell[]; className?: string }) {
  return (
    <div className={cn('@container min-w-0', className)}>
      <dl data-stat-cells className="grid grid-cols-2 border-b border-border @3xl:grid-cols-4 monolith:border-hairline">
        {cells.map((c, i) => (
          <div
            key={i}
            className={cn(
              'min-w-0 border-l border-t border-border py-3 pl-4 pr-3 monolith:border-hairline',
              '[&:nth-child(2n+1)]:border-l-0 [&:nth-child(2n+1)]:pl-0',
              '@3xl:[&:nth-child(4n+3)]:border-l @3xl:[&:nth-child(4n+3)]:pl-4',
            )}
          >
            <dt className={cn(typeLabelCls, '[overflow-wrap:anywhere]')}>{c.label}</dt>
            <dd
              className={cn(
                'm-0 mt-1 font-semibold tabular-nums [overflow-wrap:anywhere] monolith:font-mono monolith:font-medium',
                c.text ? 'text-base monolith:text-[16px]' : 'text-2xl monolith:text-[28px] monolith:tracking-[-0.02em]',
                c.warn && 'text-destructive monolith:text-signal-text',
              )}
            >
              {c.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
