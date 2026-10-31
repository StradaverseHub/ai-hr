/**
 * 420ebab5 — THE DRAFT ROW IS A ROW IN THE SAME LIST, so it is clickable the same way.
 *
 * The first cut of this change fenced the drafts off: they link to the continue-the-draft form, not to a
 * profile that does not exist yet, so they were called "not clickable-employee rows" and left alone. That
 * was the wrong cut. The reporter's sentence was "the row highlights when you hover, which makes it look
 * clickable" — and these are the rows at the TOP of the table, the first ones they see. They kept the
 * hover tint with only the name linking, so the exact reported defect survived on them; and they now sat
 * directly above rows that behaved the opposite way, which is worse than the uniform defect was.
 *
 * The DESTINATION differs — a draft opens the form that finishes it, at the step it stopped on — and it
 * says so twice: the status chip reads Draft, and the sub-line under the name says how many fields are
 * still missing. What must not differ is whether a click lands. Same idiom, same file: ./row-link.
 *
 * Extracted from page.tsx for the same reason EmployeeRow was: the listing is an async server component
 * that reads the database before it renders anything, so a row can only be rendered in a test from here.
 * Like EmployeeRow, this component holds no translator of its own — every string arrives resolved, so the
 * page stays the one place the listing's wording is chosen.
 */
import Link from 'next/link';
import { Avatar, EmployeeCode, StatusBadge } from '@/components/ui';
import type { EmployeeColumnKey } from '@/lib/employee-columns';
import { CLICKABLE_ROW_CLS, ROW_CELL_CLS, ROW_NAME_LINK_CLS, RowOverlayLink } from './row-link';

/** The one place a draft row's destination is spelled: the wizard, reopened on that draft. */
export function draftRowHref(draftId: string): string {
  return `/admin/personnel/new?draft=${draftId}`;
}

export type DraftRowProps = {
  draftId: string;
  /** Already defaulted by the caller — the untitled-draft wording is the page's to choose. */
  label: string;
  /** What the initials circle is built from: the raw label, or '?' when there is none yet. */
  avatarName: string;
  /** The sub-line under the name: how many fields are still missing, or that it is ready. */
  subtitle: string;
  /** The Employee ID held for this draft (item 06f0cb8f), or null on a draft that predates the hold. */
  reservedEmployeeCode?: string | null;
  /** Already defaulted by the caller to the "no company yet" wording. */
  companyName: string;
  statusLabel: string;
  columns: readonly EmployeeColumnKey[];
};

export function DraftRow({
  draftId,
  label,
  avatarName,
  subtitle,
  reservedEmployeeCode,
  companyName,
  statusLabel,
  columns,
}: DraftRowProps) {
  const href = draftRowHref(draftId);
  return (
    <tr className={`bg-muted/20 ${CLICKABLE_ROW_CLS}`} data-draft-id={draftId}>
      {columns.map((key) => (
        <td key={key} className={ROW_CELL_CLS}>
          {key === 'name' ? (
            <div className="flex items-center gap-3">
              <Avatar name={avatarName} />
              <div className="min-w-0">
                <Link href={href} className={ROW_NAME_LINK_CLS}>
                  {label}
                </Link>
                <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
              </div>
            </div>
          ) : (
            <>
              {/* Every column a draft genuinely has no answer for shows an em dash rather than being left
                  blank: a blank cell in a table of filled ones reads as a loading fault. */}
              {key === 'code' ? (
                reservedEmployeeCode ? (
                  <EmployeeCode code={reservedEmployeeCode} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )
              ) : key === 'status' ? (
                <StatusBadge status="draft" label={statusLabel} />
              ) : key === 'company' ? (
                <span className="text-muted-foreground">{companyName}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              <RowOverlayLink href={href} />
            </>
          )}
        </td>
      ))}
    </tr>
  );
}
