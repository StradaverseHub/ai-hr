import type { ReactNode } from 'react';
import Link from 'next/link';
import { Paperclip } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { styleFor } from '@/components/planned-absences';

/**
 * The leave-request table cells, extracted so the TWO surfaces that list leave requests render the SAME
 * thing (feedback 33bf1a2d).
 *
 * Before this module there were two hand-written copies: the My Leave → Requests table
 * (app/leave/page.tsx) had grown avatars, colour-coded type chips and the ADR-0048 duration label, while
 * the Approval Items leave table (app/approvals/page.tsx) still rendered a bare name link and plain type
 * text. Same information, two looks — the reporter asked for the (cleaner) My Leave style on both.
 *
 * Copying the markup across would have guaranteed a THIRD divergence the next time either table changed,
 * so the cells live here and both tables consume them. Anything surface-specific (the approver's stage
 * line, the maternity allowance note, the applicant's balance) rides in as `children` under the shared
 * presentation rather than forking it.
 *
 * These are plain server components: no state, no 'use client'. They take already-translated strings —
 * translation stays with the page that owns the namespace, so neither surface's i18n leaks in here.
 */

/** Employee identity: avatar + name. `href` (Approval Items → the personnel record) turns the name into
 *  a link; My Leave, which has no such destination, passes none and gets the plain bold name. */
export function LeaveEmployeeCell({
  name,
  href,
  linkTitle,
}: {
  name: string;
  href?: string;
  linkTitle?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Avatar name={name} className="size-7 text-[10px]" />
      {href ? (
        <Link href={href} title={linkTitle} className="font-medium underline-offset-2 hover:text-primary hover:underline">
          {name}
        </Link>
      ) : (
        <span className="font-medium">{name}</span>
      )}
    </div>
  );
}

/** Leave type as the colour-coded chip + icon (the palette is `styleFor`, shared with the leave calendar).
 *  The trailing " Leave" is trimmed because the chip's icon already says what it is ("Annual Leave" →
 *  "Annual"). `groupLabel` is the Emergency Leave (0106) tag on the ANNUAL/UNPAID halves of one EL
 *  submission; `children` carries anything only one surface shows. */
export function LeaveTypeCell({
  typeCode,
  typeName,
  groupLabel,
  children,
}: {
  typeCode: string;
  typeName: string;
  groupLabel?: string | null;
  children?: ReactNode;
}) {
  const { chip, Icon } = styleFor(typeCode);
  return (
    <>
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${chip}`}>
        <Icon className="size-3" />
        {typeName.replace(/\s*leave$/i, '')}
      </span>
      {groupLabel && (
        <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {groupLabel}
        </span>
      )}
      {children}
    </>
  );
}

/** Day count + the ADR-0048 duration label ("Half day (AM)" / "2h" — resolved by the caller via
 *  `durationLabel`, which needs the caller's `leave` translator) + the 0129 hourly window. The window is
 *  gated on durationType==='hourly' AND both times so a stray time never renders on a full/half-day row;
 *  `.slice(0, 5)` drops the Postgres ':00' seconds. `children` is the surface-specific extra (Approval
 *  Items shows the applicant's remaining balance underneath). */
export function LeaveDaysCell({
  days,
  durationSuffix,
  durationType,
  fromTime,
  toTime,
  children,
}: {
  days: string | number;
  durationSuffix?: string | null;
  durationType?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  children?: ReactNode;
}) {
  return (
    <>
      {Number(days)}
      {durationSuffix && (
        <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">{durationSuffix}</span>
      )}
      {durationType === 'hourly' && fromTime && toTime && (
        <span className="ml-1 text-[10px] font-medium text-muted-foreground">
          {fromTime.slice(0, 5)}–{toTime.slice(0, 5)}
        </span>
      )}
      {children}
    </>
  );
}

/** Supporting document (33bf1a2d): a paperclip the approver can click to open the employee's attachment,
 *  or an em-dash when the request carries none. `href` is null exactly when the row's `hasDocument` is
 *  false — that flag is already part of the SHARED leave-request projection (core/read.ts
 *  `leaveRequestSelection`), so the column costs no extra query and no per-row fetch.
 *
 *  NB: this is the LEAVE attachment (leave_request_attachment, streamed by /me/leave/attachment/[id]
 *  under RLS), not the feedback attachment feature. */
export function LeaveAttachmentCell({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      className="inline-flex text-muted-foreground transition-colors hover:text-primary"
    >
      <Paperclip className="size-4" aria-hidden />
    </a>
  );
}
