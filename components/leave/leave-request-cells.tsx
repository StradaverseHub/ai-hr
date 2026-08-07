import type { ReactNode } from 'react';
import Link from 'next/link';
import { Paperclip } from 'lucide-react';
import { Avatar } from '@/components/ui';
import { formatDays } from '@/lib/day-format';
import { styleFor } from '@/components/planned-absences';

/**
 * The leave-request table cells, extracted so every surface that lists leave requests renders the SAME
 * thing (feedback 33bf1a2d).
 *
 * THREE tables consume them now: My Leave → Requests (app/leave/page.tsx) and, on Approval Items
 * (app/approvals/page.tsx), BOTH the leave-request queue and the leave-CANCELLATION queue — the r80
 * follow-up, which found the cancellation table still on the pre-r77 bare-text look while the request
 * table beside it had been restyled.
 *
 * Before this module there were two hand-written copies: the My Leave → Requests table
 * (app/leave/page.tsx) had grown avatars, colour-coded type chips and the ADR-0048 duration label, while
 * the Approval Items leave table (app/approvals/page.tsx) still rendered a bare name link and plain type
 * text. Same information, two looks — the reporter asked for the (cleaner) My Leave style on both.
 *
 * Copying the markup across would have guaranteed another divergence the next time any one table changed,
 * so the cells live here and every table consumes them. Anything surface-specific (the approver's stage
 * line, the maternity allowance note) rides in as `children` under the shared presentation rather than
 * forking it.
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
 *  `.slice(0, 5)` drops the Postgres ':00' seconds.
 *
 *  The cell shows the DAYS and nothing else. Approval Items used to append the applicant's remaining
 *  balance ("13.5d left") underneath; the reporter asked for it gone (33bf1a2d follow-up), so it is gone on
 *  every surface and this cell takes no `children` — there is no second thing to put in the Days column.
 *  The balance is still one click away for an approver: the employee name in the row beside it links to
 *  /personnel/<employmentId>, whose leave summary carries it. */
export function LeaveDaysCell({
  days,
  durationSuffix,
  durationType,
  fromTime,
  toTime,
  splitRows,
}: {
  days: string | number;
  durationSuffix?: string | null;
  durationType?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  /** fef49b9a — the paid/unpaid breakdown when the balance did not cover the whole application. Built by
   *  lib/leave-split.ts on the server and PRE-TRANSLATED; null/absent for the ordinary fully-covered case,
   *  which renders byte-identically to before. Landing it in the shared Days cell rather than in each
   *  page is what stops the manager's list and the HR record disagreeing about the same request. */
  splitRows?: { label: string; days: number; unpaid: boolean }[] | null;
}) {
  return (
    <>
      {/* 4a1abc4a: the request's day count is the ledger row behind the employee's balance, so it prints
          through the same shared formatter — "1" and "1.00" for the same request on two screens was
          exactly the reported complaint. */}
      {formatDays(days)}
      {durationSuffix && (
        <span className="ml-1 text-[10px] font-medium uppercase text-muted-foreground">{durationSuffix}</span>
      )}
      {durationType === 'hourly' && fromTime && toTime && (
        <span className="ml-1 text-[10px] font-medium text-muted-foreground">
          {fromTime.slice(0, 5)}–{toTime.slice(0, 5)}
        </span>
      )}
      {/* The breakdown sits UNDER the total rather than replacing it: the request is still one request for
          that many days, and an approver is approving all of them in one action. */}
      {splitRows && splitRows.length > 1 && (
        <div className="mt-0.5 text-[10px] font-medium text-muted-foreground">
          {splitRows.map((row, i) => (
            <span key={row.label + i}>
              {i > 0 && ' · '}
              <span className={row.unpaid ? 'text-amber-700 dark:text-amber-400' : undefined}>
                {row.label} {formatDays(row.days)}
              </span>
            </span>
          ))}
        </div>
      )}
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
