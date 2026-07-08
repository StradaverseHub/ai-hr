'use client';

import { type ReactNode, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { XCircle } from 'lucide-react';
import { Button, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * HR Admin Leave Cancellation on behalf of an employee (feedback 22e68ff0).
 *
 * An HR administrator cancels another employee's PENDING or APPROVED leave immediately, with no approval
 * workflow. The affordance appears on both the Leave Management page (a labelled destructive "Cancel leave"
 * button) and the Dashboard leave calendar (a compact XCircle icon inside the leave pill, via the `trigger`
 * prop — same pattern as CancelDatesDialog). Clicking opens a confirmation dialog with an optional reason
 * field; submitting posts `adminCancelLeaveAction` with `leaveRequestId`, `reason`, and a whitelisted `back`
 * surface ('/leave' or '/'). The service re-runs every eligibility gate authoritatively.
 */
export function AdminCancelLeaveDialog({
  leaveRequestId,
  back,
  submitAction,
  // Calendar entry point: the dashboard passes a COMPACT icon trigger on the leave pill instead of the default
  // labelled button the Leave page uses. When omitted, the Leave-page labelled button renders.
  trigger,
}: {
  leaveRequestId: string;
  back: '/leave' | '/';
  submitAction: Action;
  trigger?: ReactNode;
}) {
  const t = useTranslations('leave');
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {trigger ?? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            <XCircle className="size-3.5" />
            {t('adminCancelButton')}
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('adminCancelDialogTitle')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {t('adminCancelDialogDescription')}
          </Dialog.Description>
          <form action={submitAction} className="mt-4 space-y-3" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="leaveRequestId" value={leaveRequestId} />
            <input type="hidden" name="back" value={back} />
            <input name="reason" className={inputCls} placeholder={t('adminCancelReasonPlaceholder')} />
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancelDialogDismiss')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="sm"
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
              >
                {t('adminCancelConfirmLabel')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
