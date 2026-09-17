'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, Field, btnPrimary, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * 3fb1a611 (r299) · Reverse, on a Leave Credit line.
 *
 * A dialog rather than an inline button because a reversal needs a REASON (it is shown on the reversal line
 * and recorded on the audit event) and because it moves money: if overtime was recorded on the date worked,
 * reversing makes it payable again, and the dialog says so before the click. The service refuses anything
 * but an unused, unexpired credit and never deletes; this only collects the reason and posts the id.
 */
export function LeaveCreditReverseDialog({ accrualId, action }: { accrualId: string; action: Action }) {
  const t = useTranslations('admin.leaveCredit.reverse');
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="text-sm font-medium text-primary hover:underline" data-testid="leave-credit-reverse">
          {t('button')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold text-foreground">{t('title')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">{t('body')}</Dialog.Description>
          <form action={action} onSubmit={() => setOpen(false)} className="mt-4 space-y-4">
            <input type="hidden" name="accrualId" value={accrualId} />
            <Field label={t('reason')}>
              <input name="reason" required maxLength={500} className={inputCls} />
            </Field>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {t('cancel')}
                </Button>
              </Dialog.Close>
              <button className={btnPrimary}>{t('confirm')}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
