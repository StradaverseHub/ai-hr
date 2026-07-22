'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Button, Field, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * Edit Leave Year dialog. Replaces the always-open inline date form on each Leave Year row of the
 * Application Rules page: clicking the row's Edit button used to SUBMIT the inline form immediately
 * ("Leave year saved." with no review step). Now Edit opens this pop-up, prefilled with the row's
 * saved dates; nothing is saved until the Save button inside the dialog is pressed, and Cancel
 * discards. Structure mirrors leave-year-rule-dialog.tsx (Dialog.Root + useState open, form wholly
 * inside Dialog.Content, onSubmit closes).
 *
 * The trigger Button MUST be type="button": rendered as a sibling of the row's lifecycle/delete
 * forms, a default-type trigger would submit an adjacent form — the exact click-Edit-triggers-a-save
 * bug this dialog fixes.
 *
 * The date inputs are deliberately NOT required: blanking a date then saving must clear it (the
 * action coerces '' to null). No reset-on-open state either — Radix portals unmount Dialog.Content
 * when closed, so reopening remounts the inputs with fresh server props.
 */
export function LeaveYearEditDialog({
  year,
  current,
  saveAction,
}: {
  year: number;
  current: {
    openLeaveYearDate: string | null;
    employeeApplicationStartDate: string | null;
  };
  saveAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline" className="gap-1.5">
          <Pencil className="size-3.5" />
          {t('edit')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          {/* Title names the clicked year directly (a number needs no translation — no ICU key). */}
          <Dialog.Title className="text-base font-semibold">
            {t('editLeaveYearTitle')} {year}
          </Dialog.Title>
          <form action={saveAction} className="mt-4 space-y-3" onSubmit={() => setOpen(false)}>
            {/* The year binding: fixed to the row that opened the dialog — the year identifies the record. */}
            <input type="hidden" name="year" value={year} />

            <Field label={t('openLeaveYearDateLabel')}>
              <input
                type="date"
                name="openLeaveYearDate"
                defaultValue={current.openLeaveYearDate ?? ''}
                className={inputCls}
              />
            </Field>

            <Field label={t('employeeApplicationStartDateLabel')}>
              <input
                type="date"
                name="employeeApplicationStartDate"
                defaultValue={current.employeeApplicationStartDate ?? ''}
                className={inputCls}
              />
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancel')}
                </Button>
              </Dialog.Close>
              <Button type="submit" size="sm">
                {t('save')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
