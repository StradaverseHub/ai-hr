import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * r427 (50ed39e1 contest) — a table on a wide section, a block of labelled values per row on a narrow one,
 * from ONE DOM: nothing is rendered twice and nothing scrolls sideways on a phone.
 *
 * The switch is a CONTAINER query on the table's own wrapper (`@container`, stacked below 48rem), not a
 * window breakpoint, because the shell's sidebar decides how much room a table really has. Below that width
 * the header row is visually hidden (kept for screen readers), every row becomes a two-column grid, and each
 * cell prints its column name above its value from its own `data-label` (`content: attr(data-label)`).
 *
 * `display:grid` on a <tr> drops the row's table semantics in WebKit, so every element carries its role
 * explicitly (table / rowgroup / row / columnheader / cell).
 *
 * At 48rem and wider it is an ordinary table inside an `overflow-x-auto` boundary, so a table wider than its
 * section scrolls INSIDE the section rather than widening the page (test/table-scroll-containment).
 * Server-safe: no hooks, no 'use client'.
 */

export function StackedTable({
  label,
  children,
  className,
  tableClassName,
}: {
  /** The table's accessible name. */
  label?: string;
  children: React.ReactNode;
  className?: string;
  tableClassName?: string;
}) {
  return (
    <div className={cn('@container min-w-0', className)} data-stacked-table>
      <div className="overflow-x-auto @max-3xl:overflow-visible">
        <table role="table" aria-label={label} className={cn('w-full text-sm @max-3xl:block', tableClassName)}>
          {children}
        </table>
      </div>
    </div>
  );
}

/** The header row. Classic keeps the house header (tinted, uppercase); Monolith is mono labels on an ink rule. */
export function StackedHead({ children }: { children: React.ReactNode }) {
  return (
    <thead
      role="rowgroup"
      className={cn(
        'bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground',
        'monolith:bg-transparent monolith:font-mono monolith:text-[11px] monolith:tracking-[0.12em] monolith:text-mid',
        '@max-3xl:sr-only',
      )}
    >
      <tr role="row">{children}</tr>
    </thead>
  );
}

export function StackedTh({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      role="columnheader"
      scope="col"
      className={cn('px-3 py-2 align-bottom font-medium monolith:border-b monolith:border-ink monolith:px-0 monolith:pr-4 monolith:font-normal', className)}
    >
      {children}
    </th>
  );
}

export function StackedBody({ children }: { children: React.ReactNode }) {
  return (
    <tbody role="rowgroup" className="divide-y divide-border monolith:divide-hairline @max-3xl:block">
      {children}
    </tbody>
  );
}

export function StackedRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <tr
      role="row"
      className={cn('@max-3xl:grid @max-3xl:grid-cols-2 @max-3xl:gap-x-4 @max-3xl:gap-y-3 @max-3xl:py-4', className)}
    >
      {children}
    </tr>
  );
}

/**
 * How a cell sits when the row is a block:
 *  - `title`   top-left, the row's name, no label printed (a mapping's name);
 *  - `title-inline` top-left with its label inline in front (`LINE 4`);
 *  - `aside`   top-right, no label printed (the status word);
 *  - `full`    the whole row width, label above (actions, a long reason);
 *  - default   one of two columns, label above.
 */
export type StackedCellRole = 'title' | 'title-inline' | 'aside' | 'full';

const LABEL_BEFORE =
  '@max-3xl:before:mb-1 @max-3xl:before:block @max-3xl:before:font-sans @max-3xl:before:text-[13px] @max-3xl:before:font-medium @max-3xl:before:normal-case @max-3xl:before:tracking-normal @max-3xl:before:text-muted-foreground @max-3xl:before:content-[attr(data-label)] @max-3xl:before:[overflow-wrap:anywhere] ' +
  'monolith:@max-3xl:before:font-mono monolith:@max-3xl:before:text-[11px] monolith:@max-3xl:before:font-normal monolith:@max-3xl:before:uppercase monolith:@max-3xl:before:tracking-[0.12em] monolith:@max-3xl:before:text-mid';

const ROLE_CLS: Record<StackedCellRole | 'cell', string> = {
  cell: LABEL_BEFORE,
  full: cn(LABEL_BEFORE, '@max-3xl:col-span-2'),
  title: '@max-3xl:col-start-1 @max-3xl:row-start-1 @max-3xl:font-semibold',
  'title-inline': cn(
    LABEL_BEFORE,
    '@max-3xl:col-start-1 @max-3xl:row-start-1 @max-3xl:font-semibold @max-3xl:before:mr-1.5 @max-3xl:before:mb-0 @max-3xl:before:inline',
  ),
  aside: '@max-3xl:col-start-2 @max-3xl:row-start-1 @max-3xl:text-right',
};

export function StackedTd({
  label,
  role: cellRole,
  colSpan,
  className,
  children,
  hideLabel,
}: {
  /** The column name, printed above the value when stacked. */
  label: string;
  role?: StackedCellRole;
  colSpan?: number;
  className?: string;
  children?: React.ReactNode;
  /** Print no label when stacked (an actions cell, an empty-state message). */
  hideLabel?: boolean;
}) {
  return (
    <td
      role="cell"
      data-label={label}
      colSpan={colSpan}
      className={cn(
        'px-3 py-2.5 align-top monolith:px-0 monolith:pr-4',
        '@max-3xl:block @max-3xl:min-w-0 @max-3xl:p-0 @max-3xl:[overflow-wrap:anywhere] monolith:@max-3xl:p-0',
        !hideLabel
          ? ROLE_CLS[cellRole ?? 'cell']
          : cellRole === 'full'
            ? '@max-3xl:col-span-2'
            : cellRole === 'title' || cellRole === 'aside'
              ? ROLE_CLS[cellRole]
              : '',
        className,
      )}
    >
      {children}
    </td>
  );
}
