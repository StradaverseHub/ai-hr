'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CalendarPlus } from 'lucide-react';
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
      <div className="flex justify-end pt-1">
        <Button type="submit" size="sm">
          {copy.submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * "Correct another day", as the pop-up the reporter asked for. The form inside is the component above —
 * the same fields, the same bounds, the same action — so the two paths cannot describe the correction
 * window differently.
 */
export function CorrectAnotherDayDialog({
  title,
  triggerLabel,
  closeLabel,
  ...form
}: Parameters<typeof CorrectionForm>[0] & { title: string; triggerLabel: string; closeLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline" className="gap-1.5">
          <CalendarPlus className="size-3.5" />
          {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
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
              the very row it just changed. */}
          <CorrectionForm {...form} onSubmitted={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
