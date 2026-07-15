'use client';

import { type ComponentProps, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { LeaveDurationFields, type LeaveTypeOption } from '../leave-duration-fields';

type Action = (fd: FormData) => void | Promise<void>;

/** Preview server-action shape — reuse exactly what LeaveDurationFields expects for its `action` prop. */
type PreviewAction = NonNullable<ComponentProps<typeof LeaveDurationFields>['action']>;

/**
 * Request Leave, relocated (feedback 48e69709) — the apply form used to sit at the very bottom of /leave as an
 * inline <details> Card, forcing employees to scroll past balances + history to apply. It now lives behind a
 * primary "+" button in the PageHeader actions slot, opening this modal over the current page. The form itself
 * (LeaveDurationFields + Reason + submit → requestLeaveAction) is UNCHANGED — same fields, validations, and the
 * server action still does revalidatePath('/leave') + redirect on success. onSubmit closes the dialog so the
 * refreshed page shows the new request. Modeled on edit-leave-dialog.tsx.
 */
export function RequestLeaveDialog({
  types,
  startDefault,
  employeeOptions,
  submitAction,
  previewAction,
}: {
  types: LeaveTypeOption[];
  startDefault?: string;
  employeeOptions: { id: string; name: string }[];
  submitAction: Action;
  previewAction: PreviewAction;
}) {
  const t = useTranslations('leave');
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary} data-tour="leave-request">
          <Plus className="size-4" />
          {t('requestLeave')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">{t('requestLeave')}</Dialog.Title>
          <form
            action={submitAction}
            encType="multipart/form-data"
            onSubmit={() => setOpen(false)}
            className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <LeaveDurationFields
              types={types}
              startDefault={startDefault}
              showDocumentFields
              employeeOptions={employeeOptions}
              action={previewAction}
            />
            <Field label={t('fieldReason')}>
              <input name="reason" className={inputCls} placeholder={t('reasonPlaceholder')} />
            </Field>
            <div className="flex items-end justify-end gap-2 sm:col-span-2">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancelDialogDismiss')}
                </Button>
              </Dialog.Close>
              <Button type="submit">{t('submitRequest')}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
