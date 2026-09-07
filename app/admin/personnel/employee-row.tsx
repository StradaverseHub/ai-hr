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
 * So: the STRETCHED-LINK idiom. The row becomes the positioning context (`relative`) and the ONE real
 * `<Link>` — still the name, still keyboard-focusable, still a plain anchor a browser can open in a new
 * tab — paints a transparent `::after` pinned to the row's box. Every cell is then inside the link's hit
 * area, and the row still exposes exactly ONE link to assistive technology rather than one per cell.
 *
 * TWO INVARIANTS THIS FILE DEPENDS ON, both pinned in test/personnel-row-click.dom.test.tsx:
 *   1. nothing BETWEEN the anchor and the `<tr>` may be positioned — the overlay would shrink to that
 *      element and the rest of the row would go back to being dead;
 *   2. no OTHER cell content may be positioned either — it would paint above the overlay and become a
 *      dead zone in the middle of a clickable row (the Employee ID and Status cells are the two the
 *      plan calls out by name).
 *
 * The row is extracted from page.tsx into its own component for one reason beyond tidiness: the listing
 * is an async server component that reads the database before it renders anything, so the row could not
 * otherwise be RENDERED in a test — and every claim above is a claim about rendered markup.
 */
import Link from 'next/link';
import { Avatar, EmployeeCode, StatusBadge } from '@/components/ui';
import type { EmployeeColumnKey } from '@/lib/employee-columns';
import type { EmploymentStatus } from '@/core/employment-status';

/** The one place the listing's row destination is spelled. `from=personnel` is what the profile reads
 *  to draw its back-link, so the row and the name can never drift into two different hrefs. */
export function employeeRowHref(employmentId: string): string {
  return `/admin/personnel/${employmentId}?from=personnel`;
}

/** The row: `relative` makes it the containing block the overlay stretches to, `cursor-pointer` stops
 *  the hover tint from being the only signal, and the tint itself is unchanged. */
export const EMPLOYEE_ROW_CLS = 'relative cursor-pointer hover:bg-muted/40';

/** The name link, plus the transparent overlay that turns the whole row into its hit area. */
export const EMPLOYEE_ROW_LINK_CLS =
  "font-medium text-foreground hover:text-primary after:absolute after:inset-0 after:content-['']";

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
  return (
    <tr className={EMPLOYEE_ROW_CLS} data-employment-id={employmentId}>
      {columns.map((key) => (
        <td key={key} className="px-4 py-3">
          {key === 'code' ? (
            <EmployeeCode code={employeeCode} />
          ) : key === 'name' ? (
            <div className="flex items-center gap-3">
              <Avatar name={name} />
              <div className="min-w-0">
                <Link href={employeeRowHref(employmentId)} className={EMPLOYEE_ROW_LINK_CLS}>
                  {name}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{email}</div>
              </div>
            </div>
          ) : key === 'status' ? (
            <StatusBadge status={status} label={statusLabel} />
          ) : (
            <span className="whitespace-nowrap text-muted-foreground">{text[key] ?? '—'}</span>
          )}
        </td>
      ))}
    </tr>
  );
}
