'use client';

import { useState } from 'react';
import { Button, inputCls } from '@/components/ui';
import { approveLeaveAction } from './actions';

/**
 * Whole-request Approve / Reject for an ORDINARY leave row (a per-date-approval request uses
 * LeaveDateBreakdown instead — ADR-0068 / R18 7e532d23).
 *
 * 33bf1a2d restyled the action column: Approve and Reject now sit TOGETHER on one row, and the
 * rejection-reason box is revealed only after the approver chooses Reject. Before this, the textarea was
 * rendered open on every pending row, which made the column three controls tall and read as though a
 * reason were being asked for up front.
 *
 * PRESENTATION ONLY — the decision path is byte-for-byte the one that was here before:
 *   · the same server action (approveLeaveAction) with the same hidden `id` / `decision` fields;
 *   · the same category+sort nav fields, so the redirect still lands on the same filtered view;
 *   · the same `required` textarea named `rejectReason` in the reject form (the client-side guard), with
 *     decideLeave still enforcing MissingRejectReasonError server-side (the authority).
 * Revealing the box changes WHEN it is on screen, not what is submitted or who may submit it. The reject
 * form is CONDITIONALLY MOUNTED rather than hidden with CSS, so the browser never has to validate a
 * `required` field it cannot focus.
 */
export function LeaveDecideControls({
  id,
  labels,
  nav,
}: {
  id: string;
  labels: { approve: string; reject: string; rejectReason: string };
  /** Category-panel return params (2dec6406): posted so the action's redirect keeps the filtered view. */
  nav: { category: string; sort: string };
}) {
  const [rejecting, setRejecting] = useState(false);
  const navFields = (
    <>
      <input type="hidden" name="category" value={nav.category} />
      <input type="hidden" name="sort" value={nav.sort} />
    </>
  );
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center justify-end gap-2">
        <form action={approveLeaveAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="decision" value="approved" />
          {navFields}
          <Button type="submit" size="sm">
            {labels.approve}
          </Button>
        </form>
        {/* Closed state: the plain Reject button only OPENS the reason box — it never posts a decision.
            Once open it steps aside for the submit button below the textarea, so there is exactly one
            Reject control on screen at a time and no way to reject without a reason in the same click. */}
        {!rejecting && (
          <Button type="button" size="sm" variant="outline" onClick={() => setRejecting(true)}>
            {labels.reject}
          </Button>
        )}
      </div>
      {rejecting && (
        <form action={approveLeaveAction} className="flex flex-col items-end gap-1">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="decision" value="rejected" />
          {navFields}
          <textarea
            name="rejectReason"
            required
            autoFocus
            rows={2}
            placeholder={labels.rejectReason}
            className={`${inputCls} w-48 resize-none text-xs`}
          />
          <Button type="submit" size="sm" variant="outline">
            {labels.reject}
          </Button>
        </form>
      )}
    </div>
  );
}
