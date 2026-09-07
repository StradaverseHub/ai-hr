/**
 * 420ebab5 part one — THE EMPLOYEE ROW IS THE LINK.
 *
 * The row already carried `hover:bg-muted/40`, so it highlighted under the pointer and looked
 * clickable; only the person's name actually opened anything. That is a control lying about what it
 * does — the reporter's whole complaint — and the fix is to make the row deliver what the hover tint
 * has been promising, not to remove the tint.
 *
 * WHY THIS SHAPE, and not the two obvious alternatives:
 *   • `<a>` wrapped around `<tr>` is invalid HTML; the parser hoists the anchor out of the table and
 *     the row stops being a row.
 *   • `onClick` on the `<tr>` needs a client island, is invisible to the keyboard, and kills
 *     middle-click / ⌘-click "open in a new tab" — three regressions to fix one.
 *
 * So: a transparent link overlay per CELL, from ./row-link — read that file's header before touching any
 * of this. The one thing to carry away from it: the positioning context is the `<td>`, never the `<tr>`,
 * because WebKit computes `position: relative` on a row as `static` and an overlay pinned to a row
 * therefore escapes to `<main className="relative …">` and covers the whole screen in Safari. That was
 * this branch's first shape and it was measured to be wrong.
 *
 * TWO INVARIANTS THIS FILE DEPENDS ON, both pinned in test/personnel-row-click.dom.test.tsx:
 *   1. each overlay's containing block is its own CELL — so every `<td>` is positioned, the `<tr>` is
 *      not, and nothing between an overlay and its cell is positioned either;
 *   2. no OTHER cell content may be positioned — it would paint above the overlay and become a dead zone
 *      in the middle of a clickable row (the Employee ID and Status cells are the two the plan calls out
 *      by name).
 *
 * The row is extracted from page.tsx into its own component for one reason beyond tidiness: the listing
 * is an async server component that reads the database before it renders anything, so the row could not
 * otherwise be RENDERED in a test — and every claim above is a claim about rendered markup. The hit areas
 * themselves are measured in a real engine by test/personnel-row-click.browser.test.tsx.
 */
import Link from 'next/link';
import { Avatar, EmployeeCode, StatusBadge } from '@/components/ui';
import type { EmployeeColumnKey } from '@/lib/employee-columns';
import type { EmploymentStatus } from '@/core/employment-status';
import { CLICKABLE_ROW_CLS, ROW_CELL_CLS, ROW_NAME_LINK_CLS, RowOverlayLink } from './row-link';

/** The one place the listing's row destination is spelled. `from=personnel` is what the profile reads
 *  to draw its back-link, so the row and the name can never drift into two different hrefs. */
export function employeeRowHref(employmentId: string): string {
  return `/admin/personnel/${employmentId}?from=personnel`;
}

export type EmployeeRowProps = {
  employmentId: string;
  name: string;
  email?: string | null;
  employeeCode?: string | null;
  /** Derived, never stored — see core/employment-status.ts. */
  status: EmploymentStatus;
  /** Already translated by the caller: this component holds no t() of its own. */
  statusLabel: string;
  columns: readonly EmployeeColumnKey[];
  /** Plain text per column, from the SAME projection the Excel export prints. */
  text: Partial<Record<EmployeeColumnKey, string | null>>;
};

export function EmployeeRow({
  employmentId,
  name,
  email,
  employeeCode,
  status,
  statusLabel,
  columns,
  text,
}: EmployeeRowProps) {
  const href = employeeRowHref(employmentId);
  return (
    <tr className={CLICKABLE_ROW_CLS} data-employment-id={employmentId}>
      {columns.map((key) => (
        <td key={key} className={ROW_CELL_CLS}>
          {key === 'name' ? (
            // The ONE named, focusable link of the row. Its own `::after` covers this cell, so the name
            // cell needs no overlay of its own — and hovering anywhere in it still tints the name.
            <div className="flex items-center gap-3">
              <Avatar name={name} />
              <div className="min-w-0">
                <Link href={href} className={ROW_NAME_LINK_CLS}>
                  {name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{email}</div>
              </div>
            </div>
          ) : (
            <>
              {key === 'code' ? (
                <EmployeeCode code={employeeCode} />
              ) : key === 'status' ? (
                <StatusBadge status={status} label={statusLabel} />
              ) : (
                <span className="whitespace-nowrap text-muted-foreground">{text[key] ?? '—'}</span>
              )}
              <RowOverlayLink href={href} />
            </>
          )}
        </td>
      ))}
    </tr>
  );
}
