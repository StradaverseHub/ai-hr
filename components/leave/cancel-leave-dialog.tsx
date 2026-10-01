'use client';

import { type ReactNode, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { XCircle } from 'lucide-react';
import { Button } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * Edit-by-status self-service (item c9a19e34) — an employee withdraws their OWN PENDING leave. A confirmation
 * dialog (expected_function 4.ii — "display a confirmation dialog before cancelling") posting `submitAction`
 * (myCancelLeave / cancelOwnLeaveAction) with a hidden leaveRequestId. Available ONLY for pending rows (the
 * parent gates this; the service also re-asserts status='pending' + subject-only). An APPROVED row uses the
 * manager-approved give-back flow (CancelDatesDialog) instead, not this immediate withdraw.
 */
export function CancelLeaveDialog({
  leaveRequestId,
  submitAction,
  returnContext,
  // Optional compact trigger (e.g. a calendar pill icon); defaults to a labelled destructive button.
  trigger,
}: {
  leaveRequestId: string;
  submitAction: Action;
  returnContext?: string;
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
            {t('selfCancelButton')}
          </Button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('selfCancelDialogTitle')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {t('selfCancelDialogDescription')}
          </Dialog.Description>
          <form action={submitAction} className="mt-4 space-y-3" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="leaveRequestId" value={leaveRequestId} />
            {returnContext != null && <><input type="hidden" name="leaveOrigin" value="history" /><input type="hidden" name="leaveContext" value={returnContext} /></>}
            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('selfCancelKeep')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="sm"
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
              >
                {t('selfCancelConfirm')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
