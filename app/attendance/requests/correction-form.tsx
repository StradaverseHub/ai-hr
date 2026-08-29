'use client';

import { useState, type ComponentProps, type ReactNode } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Field, inputCls } from '@/components/ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * c6bb5f5a — the attendance-correction request form, stated ONCE and mounted twice.
 *
 * BEFORE THIS ROUND there was one form with two faces: the Fix panel showed a flagged day's locked/prefilled
 * times when a day was selected, and the SAME <form> fell back to a free date box ("Correct another day")
 * when none was. The reporter asked for the second face to become a pop-up. Splitting them by copy-paste
 * would have left two forms that must agree about the 30-day bounds, the locked half of an incomplete
 * punch, the attachment rule and the read-only approver — so the form moved here whole and takes a `day`
 * (the flagged-day face) or no day (the another-day face) instead.
 *
 * WHY A CLIENT COMPONENT. Only the pop-up needs state; the inline path needs none. But a form that renders
 * differently in the two places is the drift this file exists to prevent, so BOTH paths render this one
 * component and the dialog simply wraps it. `t` never crosses the boundary — the page resolves every string
 * server-side and hands over plain text (test/server-client-boundary.test.ts).
 *
 * THE BOUNDS ARE THE SAME IN BOTH PATHS, deliberately: `min`/`max` are the correction window the screen
 * states out loud, and a pop-up that accepted a date the service refuses would be a worse form than the
 * inline one it replaced.
 *
 * NO explicit encType: React sets multipart itself for a form whose action is a function, and spelling it
 * out earns "Cannot specify a encType or method for a form that specifies a function as the action" in the
 * dev log on every render. The file input still uploads.
 *
 * r227 MOVED THE SECOND MOUNT. The pop-up is now BOTH faces — the header's free-date "Correct another day"
 * AND every table row's Request — because the reporter asked for the side panel that squeezed the list to
 * become a pop-up. The inline mount survives for `?fix=YYYY-MM-DD` links written before this round; nothing
 * generates that address any more. So the same "one form, two mounts" rule is what still holds this file
 * together, and the pair of things that MOVED WITH the form (the Cancel beside Submit, and the absent day's
 * request-leave-instead note) are here rather than in the page for the same reason.
 */
export type CorrectionCopy = {
  dateLabel: string;
  anotherHelp: string;
  checkIn: string;
  checkOut: string;
  required: string;
  reason: string;
  reasonPlaceholder: string;
  remark: string;
  remarkPlaceholder: string;
  attachment: string;
  attachmentHelp: string;
  goesTo: string;
  originalKept: string;
  submit: string;
};

/** The flagged day the panel opened on — the subset of ExceptionDay the form actually reads. */
export type CorrectionDay = {
  date: string;
  missing: 'in' | 'out' | null;
  prefillIn: string | null;
  prefillOut: string | null;
};

export function CorrectionForm({
  copy,
  approver,
  submitAction,
  section,
  requestKind,
  day,
  minDate,
  maxDate,
  cancel,
  onSubmitted,
}: {
  copy: CorrectionCopy;
  approver: string;
  submitAction: Action;
  /** Which section the request is filed from — carried so the action lands back on the right tab. */
  section: string;
  /** The stored request_kind (db/schema ATTENDANCE_REQUEST_KINDS). */
  requestKind: string;
  /** A flagged day, or null for the free "correct another day" face. */
  day: CorrectionDay | null;
  /** The correction window, inclusive — the same bounds the screen states in words. */
  minDate: string;
  maxDate: string;
  /** r227 — the dismiss control that sits BESIDE Submit, supplied by whoever can dismiss this form.
   *  A node rather than a label because only the pop-up has something to close: `Dialog.Close` throws
   *  outside a `Dialog.Root`, and the inline `?fix=` panel has no dialog around it. */
  cancel?: ReactNode;
  onSubmitted?: () => void;
}) {
  return (
    <form action={submitAction} onSubmit={onSubmitted} className="space-y-2.5 p-4">
      <input type="hidden" name="section" value={section} />
      <input type="hidden" name="requestKind" value={requestKind} />
      {day ? (
        <>
          <input type="hidden" name="date" value={day.date} />
          <div className="grid grid-cols-2 gap-2">
            {/* The half we already hold is LOCKED and travels in a hidden field: the service refuses a
                clock-out with no clock-in (it has no anchor to derive against), so the prefill has to
                carry it — and letting the employee retype a punch that is already correct is how a
                correction introduces a second error. */}
            {day.missing === 'out' ? (
              <>
                <Field label={copy.checkIn}>
                  <input type="hidden" name="checkIn" value={day.prefillIn ?? ''} />
                  <div className={`${inputCls} flex items-center bg-muted/40`}>{day.prefillIn ?? '—'}</div>
                </Field>
                <Field label={copy.checkOut} required requiredAriaLabel={copy.required}>
                  <input type="time" name="checkOut" required defaultValue={day.prefillOut ?? ''} className={inputCls} />
                </Field>
              </>
            ) : (
              <>
                <Field label={copy.checkIn} required requiredAriaLabel={copy.required}>
                  <input type="time" name="checkIn" required defaultValue={day.prefillIn ?? ''} className={inputCls} />
                </Field>
                <Field label={copy.checkOut}>
                  <input type="time" name="checkOut" defaultValue={day.prefillOut ?? ''} className={inputCls} />
                </Field>
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground">{copy.anotherHelp}</p>
          <Field label={copy.dateLabel} required requiredAriaLabel={copy.required}>
            <input type="date" name="date" required max={maxDate} min={minDate} className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={copy.checkIn}>
              <input type="time" name="checkIn" defaultValue="09:00" className={inputCls} />
            </Field>
            <Field label={copy.checkOut}>
              <input type="time" name="checkOut" defaultValue="18:00" className={inputCls} />
            </Field>
          </div>
        </>
      )}

      <Field label={copy.reason} required requiredAriaLabel={copy.required}>
        <input name="reason" required placeholder={copy.reasonPlaceholder} className={inputCls} />
      </Field>
      <Field label={copy.remark}>
        <input name="remark" placeholder={copy.remarkPlaceholder} className={inputCls} />
      </Field>
      <Field label={copy.attachment}>
        <input
          type="file"
          name="attachment"
          accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
          className={`${inputCls} py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs`}
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">{copy.attachmentHelp}</p>
      <Field label={copy.goesTo}>
        {/* Read-only and deliberately NOT a form field: the approver is resolved from the reporting line at
            decide time (assertCanDecide), so anything posted from here would be ignored. */}
        <div className={`${inputCls} flex items-center bg-muted/40`}>{approver}</div>
      </Field>
      <p className="text-[11px] text-muted-foreground">{copy.originalKept}</p>
      <div className="flex items-center justify-end gap-2 pt-1">
        {cancel}
        <Button type="submit" size="sm">
          {copy.submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * r227 — THE ABSENT DAY'S SECOND ROUTE, stated once and mounted twice.
 *
 * `maRequestLeaveHelp` + the `/leave?apply=1&start=` button are NOT part of the correction form: they are
 * the OTHER answer to an absent day (don't correct the clock — ask for leave for it), which is why
 * `maAbsentTwoRoutes` says so out loud under the list. When the form moved into a pop-up this note had to
 * move with it, or an absent day would silently be left with one route. It lives here so the pop-up and
 * the legacy inline panel cannot end up offering different things.
 *
 * Takes three plain strings: the page resolves `t` server-side, as everything crossing this boundary must.
 */
export function LeaveInsteadNote({ href, help, label }: { href: string; help: string; label: string }) {
  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-[11px] text-muted-foreground">{help}</p>
      <Button asChild size="sm" variant="outline" className="mt-2">
        <Link href={href}>{label}</Link>
      </Button>
    </div>
  );
}

/**
 * The correction request as a POP-UP — both faces of it.
 *
 * ⚠️ IT WAS CALLED `CorrectAnotherDayDialog` UNTIL r227, and the rename is the point of the round rather
 * than tidying. c6bb5f5a built this for the header's "Correct another day" only, but `day`, `section` and
 * `requestKind` were already props and already spread into the shared CorrectionForm — it was the
 * free-date face ONLY because the page handed it `day={null}`. r227 hands it a real flagged day from each
 * table row, so the same component is now the per-row Request pop-up as well, with nothing changed inside
 * it. A name that said "another day" would have been a lie on every row.
 *
 * WHY THE ROWS STOPPED NAVIGATING. `Request` used to be a link to `?fix=YYYY-MM-DD`, which opened the form
 * in a second column beside the table — and that column is what squeezed the list the employee came to
 * read (the reporter's complaint). The pop-up needs no column, so the table gets the whole width. The
 * `?fix=` branch on the page is KEPT, unlinked-to, so bookmarks and already-sent links still open.
 *
 * NOTHING BUT STRINGS, A PLAIN DAY OBJECT AND THE SERVER ACTION CROSSES. The page is a server component
 * and this module is 'use client': `t` and the page's `href()` closure may not cross
 * (test/server-client-boundary.test.ts), so every label — including the per-row title — is resolved
 * server-side. `section` / `requestKind` come across as strings rather than being derived here, which is
 * what keeps an "Also waiting for you" row filing under ITS OWN kind instead of the open tab's.
 */
export function CorrectionDialog({
  title,
  triggerLabel,
  triggerIcon,
  triggerVariant = 'outline',
  closeLabel,
  cancelLabel,
  leaveHref,
  leaveHelp,
  leaveLabel,
  ...form
}: Omit<Parameters<typeof CorrectionForm>[0], 'cancel' | 'onSubmitted'> & {
  title: string;
  triggerLabel: string;
  /** Optional glyph on the trigger. NOT hardcoded any more: the header's "Correct another day" wants a
   *  calendar, a row's plain "Request" does not. */
  triggerIcon?: ReactNode;
  triggerVariant?: ComponentProps<typeof Button>['variant'];
  closeLabel: string;
  cancelLabel: string;
  /** The absent day's second route, when there is one — see LeaveInsteadNote. */
  leaveHref?: string;
  leaveHelp?: string;
  leaveLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant={triggerVariant} className={triggerIcon ? 'gap-1.5' : undefined}>
          {triggerIcon}
          {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          // No Dialog.Description on this form — say so, or Radix logs a missing-description warning on
          // every open (the same reason components/leave/request-leave-dialog.tsx sets it).
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button type="button" size="sm" variant="ghost">
                {closeLabel}
              </Button>
            </Dialog.Close>
          </div>
          {/* Closing on submit is what makes the pop-up feel like the inline panel it replaced: the action
              redirects back to this screen, and a dialog still hanging over the refreshed page would hide
              the very row it just changed.

              CANCEL sits beside Submit (the shape components/leave/request-leave-dialog.tsx already uses):
              a form that can only be escaped by the header's Close reads as one you are committed to. */}
          <CorrectionForm
            {...form}
            onSubmitted={() => setOpen(false)}
            cancel={
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {cancelLabel}
                </Button>
              </Dialog.Close>
            }
          />
          {leaveHref && leaveHelp && leaveLabel ? (
            <LeaveInsteadNote href={leaveHref} help={leaveHelp} label={leaveLabel} />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
