import { Button, inputCls } from '@/components/ui';
import type { ReactNode } from 'react';

/**
 * APPROVE / REJECT A PROFILE CHANGE — AND A REJECTION CANNOT BE SUBMITTED WITHOUT A REASON.
 *
 * r260 stage two (board item 9583deac). The approved plan promises the reporter: "Rejecting asks for a
 * reason, and the reason is stored and shown to the employee."
 *
 * ── WHY THIS IS ONE COMPONENT AND NOT TWO COPIES ────────────────────────────────────────────────────
 * There are TWO admin surfaces that decide these requests — the pending-changes card on
 * /admin/personnel and the Profile changes section on /approvals — and both post to their own server
 * action. `decideProfileChange` refuses a reasonless rejection server-side, so a surface that kept a
 * bare Reject button would not be "the old behaviour": it would be a button that always fails. Both
 * therefore render this, and the `action` is a prop precisely so there is one control and two callers.
 *
 * ── NOT A CLIENT COMPONENT, ON PURPOSE ──────────────────────────────────────────────────────────────
 * The leave equivalent (app/approvals/leave-decide-controls.tsx) is `'use client'` because it toggles
 * the reason box with `useState`. This one uses `<details>`, which is the browser's own disclosure and
 * needs no JavaScript — the same idiom /me already uses for its fold-out forms. That keeps it a SERVER
 * component, which matters here for a specific reason: a server page may not pass a function prop to a
 * client component (test/server-client-boundary.test.ts, the r123 P0), and `action` is a function. As a
 * server component it is simply rendered by both pages, and the server action is passed the way React
 * passes any prop between server components.
 *
 * ── THE REASON BOX IS INSIDE THE REJECT FORM, AND THE APPROVE FORM DOES NOT CARRY ONE ───────────────
 * Two separate `<form>`s, exactly as the buttons were before. The textarea is `required`, so the browser
 * refuses the submit before the round trip; `decideProfileChange` throws
 * ProfileChangeReasonRequiredError if anything reaches it anyway, and migration 0458's CHECK refuses the
 * row under that. Three layers, because the employee being told WHY is the entire deliverable.
 */
export function ProfileChangeDecide({
  action,
  requestId,
  idFieldName,
  labels,
  hidden,
  disabled,
}: {
  /** The caller's own server action. Both surfaces have one; neither shares the other's redirect. */
  action: (fd: FormData) => void | Promise<void>;
  requestId: string;
  /** `/approvals` posts the request id as `id`; `/admin/personnel` posts it as `requestId`. */
  idFieldName: 'id' | 'requestId';
  labels: { approve: string; reject: string; reasonPlaceholder: string; yourRequest: string };
  /** Extra hidden inputs the caller's action needs back (the /approvals category + sort nav fields). */
  hidden?: ReactNode;
  /** True when the viewer is the subject of the request — an approver may never decide their own. */
  disabled?: boolean;
}) {
  if (disabled) {
    return <span className="text-xs text-muted-foreground">{labels.yourRequest}</span>;
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <form action={action}>
          <input type="hidden" name={idFieldName} value={requestId} />
          <input type="hidden" name="decision" value="approved" />
          {hidden}
          <Button type="submit" size="sm">
            {labels.approve}
          </Button>
        </form>
        {/* Closed, the summary only OPENS the box — it posts nothing. Open, the submit button sits
            below the textarea, so there is never a way to reject in one click without a reason. */}
        <details className="relative">
          <summary className="inline-flex cursor-pointer select-none items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {labels.reject}
          </summary>
          <form action={action} className="mt-2 flex flex-col items-end gap-1">
            <input type="hidden" name={idFieldName} value={requestId} />
            <input type="hidden" name="decision" value="rejected" />
            {hidden}
            <textarea
              name="reason"
              required
              rows={2}
              placeholder={labels.reasonPlaceholder}
              className={`${inputCls} w-56 resize-none text-xs`}
            />
            <Button type="submit" size="sm" variant="outline">
              {labels.reject}
            </Button>
          </form>
        </details>
      </div>
    </div>
  );
}
