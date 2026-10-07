'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { MONO_LABEL } from './classes';
import { Status, type StatusTone } from './status';

/**
 * r400 — Monolith primitives: HAIRLINE TABLE and HAIRLINE LIST (docs/design/monolith shell.css `.th`, `.tbl`,
 * `.tr`, `.st`, `.ls`; generator.py `render_table`, `render_section` kind 'list').
 *
 * "Table rows are 50px hairline rows; the first column mono mid, the second 500 weight, status as a mono word
 * coloured by meaning. Hover is pressed, selected is ink with bone text. An orange 3px bar appears at the
 * row's left edge on hover." (README §4)
 *
 * TWO STRUCTURES, chosen by whether rows can be picked, because they are two different things to a screen
 * reader:
 *  • read-only → a real <table> (caption, <th scope="col">, <td>) laid out with <colgroup> widths, so table
 *    navigation and header association work as for any table;
 *  • selectable (`onSelect`) → a group of <button aria-current> rows (components.md: "rows are <button> when
 *    selectable"). A button cannot sit inside table semantics, so each cell carries its column name as
 *    visually-hidden text and the visual header is hidden from assistive tech: each row's accessible name reads
 *    "Code E-001, Employee Aisyah, Status Pending".
 * Client component because of `onSelect`; the server-client-boundary guard stops a server page passing it a
 * closure.
 */
export type HairlineRow = {
  key: string;
  cells: React.ReactNode[];
  /** Colours the status column's word (when `statusCol` is set and the cell is text). */
  tone?: StatusTone;
  selected?: boolean;
};

const ROW_MONO =
  'monolith:min-h-[50px] monolith:border-hairline monolith:text-[14px] monolith:hover:bg-pressed';

function cellClass(ci: number, statusCol: number | undefined) {
  if (ci === statusCol) return '';
  if (ci === 0) return cn('font-mono text-xs text-muted-foreground', MONO_LABEL, 'monolith:text-mid');
  if (ci === 1) return 'font-medium';
  return 'text-muted-foreground monolith:text-mid';
}

function renderCell(cell: React.ReactNode, ci: number, row: HairlineRow, statusCol: number | undefined) {
  if (ci === statusCol && (typeof cell === 'string' || typeof cell === 'number')) {
    // On a selected (ink) row every tone would vanish into the fill, so the word turns bone there.
    return <Status word={cell} tone={row.tone ?? 'mid'} className="monolith:group-aria-[current=true]:text-bone" />;
  }
  return cell;
}

export function HairlineTable({
  label,
  cols,
  widths,
  rows,
  statusCol,
  onSelect,
  empty,
  className,
}: {
  /** What the table lists — its caption (read-only) or group name (selectable). Required: a table needs a name. */
  label: string;
  cols: React.ReactNode[];
  /** Per-column widths (CSS lengths or `fr`s for the selectable grid), from the boards' grid-template-columns. */
  widths?: string[];
  rows: HairlineRow[];
  statusCol?: number;
  onSelect?: (key: string) => void;
  /** Shown instead of the rows when there are none (e.g. an <Empty>). */
  empty?: React.ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && empty != null) return <>{empty}</>;
  const headClass = cn('text-left text-xs font-medium uppercase tracking-wide text-muted-foreground', MONO_LABEL, 'monolith:text-mid');

  if (!onSelect) {
    return (
      <table data-hairline-table className={cn('w-full border-collapse text-sm', 'monolith:border-b monolith:border-hairline', className)}>
        <caption className="sr-only">{label}</caption>
        {widths && (
          <colgroup>
            {widths.map((w, i) => (
              <col key={i} style={{ width: /fr$/.test(w) ? undefined : w }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} scope="col" className={cn(headClass, 'h-10 px-2 align-middle monolith:h-[30px] monolith:px-0.5')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={cn('border-t border-border hover:bg-muted/50', ROW_MONO, 'group')}>
              {r.cells.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'h-11 px-2 align-middle monolith:h-[50px] monolith:px-0.5',
                    ci === 0 &&
                      'monolith:relative monolith:before:absolute monolith:before:inset-y-0 monolith:before:-left-4 monolith:before:w-[3px] monolith:before:bg-signal monolith:before:opacity-0 monolith:group-hover:before:opacity-100',
                    cellClass(ci, statusCol),
                  )}
                >
                  {renderCell(cell, ci, r, statusCol)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  const grid = { gridTemplateColumns: (widths ?? cols.map(() => 'minmax(0,1fr)')).join(' ') };
  return (
    <div role="group" aria-label={label} data-hairline-table className={cn('text-sm', className)}>
      <div aria-hidden="true" style={grid} className={cn('grid min-h-10 items-center gap-3.5 px-2', headClass, 'monolith:min-h-[30px] monolith:px-0.5')}>
        {cols.map((c, i) => (
          <span key={i}>{c}</span>
        ))}
      </div>
      <div className="border-b border-border monolith:-ml-4 monolith:border-hairline monolith:pl-4">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            aria-current={r.selected ? 'true' : undefined}
            onClick={() => onSelect(r.key)}
            style={grid}
            className={cn(
              'group relative grid min-h-11 w-full items-center gap-3.5 border-t border-border px-2 text-left hover:bg-muted/50',
              'aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground',
              ROW_MONO,
              'monolith:px-0.5 monolith:aria-[current=true]:bg-ink monolith:aria-[current=true]:text-bone',
              'monolith:before:absolute monolith:before:inset-y-0 monolith:before:-left-4 monolith:before:w-[3px] monolith:before:bg-signal monolith:before:opacity-0 monolith:hover:before:opacity-100',
            )}
          >
            {r.cells.map((cell, ci) => (
              <span key={ci} className={cn('min-w-0', cellClass(ci, statusCol), 'monolith:group-aria-[current=true]:text-bone/75')}>
                <span className="sr-only">
                  {cols[ci]}
                  {', '}
                </span>
                {renderCell(cell, ci, r, statusCol)}
              </span>
            ))}
          </button>
        ))}
      </div>
    </div>
  );
}

export type HairlineListItem = {
  key: string;
  /** The lead: a date, a code or a figure (mono mid). */
  lead?: React.ReactNode;
  /** Render the lead as a tabular figure rather than a mono label. */
  leadNum?: boolean;
  title: React.ReactNode;
  sub?: React.ReactNode;
  /** The right-hand status word. */
  right?: React.ReactNode;
  tone?: StatusTone;
};

/** An activity list (shell.css `.ls`): lead · title (· sub) · status word, one hairline row each. */
export function HairlineList({ items, label, className }: { items: HairlineListItem[]; label?: string; className?: string }) {
  return (
    <ul aria-label={label} data-hairline-list className={cn('border-b border-border text-sm monolith:border-hairline', className)}>
      {items.map((i) => (
        <li
          key={i.key}
          className="grid min-h-11 grid-cols-[70px_minmax(0,1fr)_auto] items-center gap-3.5 border-t border-border px-0.5 monolith:min-h-[46px] monolith:border-hairline monolith:text-[14px]"
        >
          <span
            className={
              i.leadNum
                ? 'num tabular-nums text-muted-foreground monolith:font-mono monolith:text-mid'
                : cn('font-mono text-xs text-muted-foreground', MONO_LABEL, 'monolith:text-mid')
            }
          >
            {i.lead}
          </span>
          <span className="min-w-0">
            <span className="font-medium">{i.title}</span>
            {i.sub != null && <span className="text-muted-foreground monolith:text-mid"> · {i.sub}</span>}
          </span>
          {i.right != null ? (
            typeof i.right === 'string' || typeof i.right === 'number' ? (
              <Status word={i.right} tone={i.tone ?? 'mid'} />
            ) : (
              i.right
            )
          ) : (
            <span />
          )}
        </li>
      ))}
    </ul>
  );
}
