'use client';

import { type ReactNode, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { XCircle } from 'lucide-react';
import { Button, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * Partial Leave Cancellation — discoverable entry point (R5 Build #2, ADR-0065).
 *
 * Replaces the buried grey `<details>Cancel date(s)</details>` text link (which read like the ineligible "—"
 * dash) with a clearly-labelled "Cancel dates" BUTTON in the Leave-history Action column. Clicking it opens a
 * small pop-up listing the cancellable working dates as tick-boxes, a reason input, and a submit — posting the
 * SAME server action (`requestLeaveCancellationAction`) with the SAME field names (`leaveRequestId`,
 * `cancelDate[]`, `reason`). No new action, no new route.
 *
 * `candidateDates` are the row's REAL working dates strictly after today (MYT) — resolved server-side from the
 * roster + public-holiday calendar (core/read.ts → workingDatesForSpan), so they agree exactly with what the
 * service will accept (no Mon–Fri drift, no offered holiday). When empty, the button renders DISABLED with an
 * inline "nothing left to cancel" reason instead of a silent dash.
 */
export function CancelDatesDialog({
  leaveRequestId,
  candidateDates,
  submitAction,
  returnContext,
  // Calendar entry point (ADR-0065): the dashboard passes a COMPACT icon trigger (a small XCircle button on the
  // approved pill) instead of the default labelled "Cancel dates" outline button the Leave page uses. Optional
  // — when omitted, the Leave-page behaviour is byte-identical (default labelled button, disabled-with-reason
  // empty state). When a custom trigger is supplied, the caller has already gated eligibility, so we never
  // render the disabled empty-state button for it (the calendar simply doesn't render the affordance instead).
  trigger,
}: {
  leaveRequestId: string;
  candidateDates: string[];
  submitAction: Action;
  returnContext?: string;
  trigger?: ReactNode;
}) {
  const t = useTranslations('leave');
  const [open, setOpen] = useState(false);

  // Empty/edge state (§5.4): approved + own but nothing currently cancellable (all past / closed period /
  // already given back). Show the button DISABLED with a short reason — never a silent "—". A custom trigger
  // (calendar) is only rendered by an already-eligible caller, so it skips this branch.
  if (candidateDates.length === 0 && !trigger) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled
        title={t('cancelReasonNothingLeft')}
        className="gap-1.5"
      >
        <XCircle className="size-3.5" />
        {t('cancelDatesButton')}
      </Button>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {trigger ?? (
          <Button type="button" size="sm" variant="outline" className="gap-1.5">
            <XCircle className="size-3.5" />
            {t('cancelDatesButton')}
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('cancelDialogTitle')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {t('cancelDatesHint')}
          </Dialog.Description>
          <form
            action={submitAction}
            className="mt-4 space-y-3"
            onSubmit={() => setOpen(false)}
          >
            <input type="hidden" name="leaveRequestId" value={leaveRequestId} />
            {returnContext != null && <><input type="hidden" name="leaveOrigin" value="history" /><input type="hidden" name="leaveContext" value={returnContext} /></>}
            <div className="space-y-1.5">
              {candidateDates.map((d) => (
                <label key={d} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="cancelDate" value={d} className="size-4" />
                  <span className="tabular-nums">{d}</span>
                </label>
              ))}
            </div>
            <input name="reason" className={inputCls} placeholder={t('reasonPlaceholder')} />
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancelDialogDismiss')}
                </Button>
              </Dialog.Close>
              <Button type="submit" size="sm">
                {t('cancelSubmit')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
