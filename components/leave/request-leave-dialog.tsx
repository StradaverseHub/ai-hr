'use client';

import { type ComponentProps, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { LeaveDurationFields, type LeaveTypeOption } from '../leave-duration-fields';

type Action = (fd: FormData) => void | Promise<void>;

/** Preview server-action shape — reuse exactly what LeaveDurationFields expects for its `action` prop. */
type PreviewAction = NonNullable<ComponentProps<typeof LeaveDurationFields>['action']>;
/** Apply-summary server-action shape — same reuse, for the Pending/Taken/Balance block. */
type SummaryAction = ComponentProps<typeof LeaveDurationFields>['summaryAction'];

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
  defaultTypeId,
  employeeOptions,
  eligibleTypeIdsByEmployment,
  submitAction,
  previewAction,
  summaryAction,
}: {
  types: LeaveTypeOption[];
  startDefault?: string;
  /** 76dbcaa1 — forwarded to LeaveDurationFields: the type an Apply action asked to open on. */
  defaultTypeId?: string | null;
  // Optional (item 69088c13): omitted for self-service employees so the Employee selector is hidden and the
  // submit binds to the signed-in viewer; passed only on the admin/manager on-behalf-of path.
  employeeOptions?: { id: string; name: string }[];
  /** ad965821: which leave types each selectable employment qualifies for, so the type list re-draws when
   *  the on-behalf-of employee changes. Forwarded verbatim to LeaveDurationFields, which owns the selection
   *  state; omitted (with employeeOptions) for a plain self-service applicant. */
  eligibleTypeIdsByEmployment?: Record<string, string[]>;
  submitAction: Action;
  previewAction: PreviewAction;
  /** Employee apply-popup enhancement: Taken / Pending / Balance / Available for the selected type. Required — this is
   *  the only consumer of LeaveDurationFields' summary block. */
  summaryAction: SummaryAction;
}) {
  const t = useTranslations('leave');
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  const openedFromUrl = useRef(false);

  /**
   * Open on arrival when the dashboard's Apply Leave shortcut sent us here with `?apply=1`
   * (feedback a46fe0c0).
   *
   * The dialog is opened HERE rather than rendered on the dashboard, and that is the point of the item:
   * this form needs the employee's leave types, balances and policy data, which My Leave already loads
   * and the dashboard does not. Mounting it on the dashboard would mean duplicating that loading — the
   * "do not create a new leave application page or duplicate function" the item asks us to avoid. The
   * employee still sees the pop-up open in one click; it just opens on the page that already has the data.
   *
   * The marker is STRIPPED once consumed, so a refresh or a Back navigation does not silently re-open a
   * form the employee deliberately closed. `openedFromUrl` guards React's dev double-invoke, which would
   * otherwise re-open it immediately after the first close.
   */
  useEffect(() => {
    if (params.get('apply') !== '1' || openedFromUrl.current) return;
    openedFromUrl.current = true;
    setOpen(true);
    const next = new URLSearchParams(params.toString());
    next.delete('apply');
    const qs = next.toString();
    router.replace(qs ? `/leave?${qs}` : '/leave', { scroll: false });
  }, [params, router]);

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
              defaultTypeId={defaultTypeId}
              showDocumentFields
              employeeOptions={employeeOptions}
              eligibleTypeIdsByEmployment={eligibleTypeIdsByEmployment}
              action={previewAction}
              summaryAction={summaryAction}
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
