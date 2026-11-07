'use client';

import { type ComponentProps, useEffect, useRef, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { LeaveDurationFields, type LeaveTypeOption } from '../leave-duration-fields';

type Action = (fd: FormData, inlineErrors?: boolean) => void | Promise<void | {error?:string;redirectTo?:string}>;

/** Preview server-action shape — reuse exactly what LeaveDurationFields expects for its `action` prop. */
type PreviewAction = NonNullable<ComponentProps<typeof LeaveDurationFields>['action']>;
/** Apply-summary server-action shape — same reuse, for the Pending/Taken/Balance block. */
type SummaryAction = ComponentProps<typeof LeaveDurationFields>['summaryAction'];

/** Keep the mounted form and attachments on validation failure; close only after confirmed success. */
export function RequestLeaveDialog({
  types,
  startDefault,
  endDefault,
  durationDefault,
  defaultTypeId,
  employeeOptions,
  ownEmploymentId,
  eligibleTypeIdsByEmployment,
  submitAction,
  previewAction,
  summaryAction,
}: {
  types: LeaveTypeOption[];
  startDefault?: string;
  /** Issue 10 — forwarded to LeaveDurationFields: the end date and duration a chat card's Edit opens the form on. */
  endDefault?: string;
  durationDefault?: ComponentProps<typeof LeaveDurationFields>['durationDefault'];
  /** 76dbcaa1 — forwarded to LeaveDurationFields: the type an Apply action asked to open on. */
  defaultTypeId?: string | null;
  // Optional (item 69088c13): omitted for self-service employees so the Employee selector is hidden and the
  // submit binds to the signed-in viewer; passed only on the admin/manager on-behalf-of path.
  employeeOptions?: { id: string; name: string }[];
  /** An explicit own selection from Home. The canonical writer repeats subject authorization. */
  ownEmploymentId?:string;
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
  const [error,setError]=useState('');
  const [zeroDays,setZeroDays]=useState(false);
  const [pending,startSubmit]=useTransition();
  const errorRef=useRef<HTMLParagraphElement>(null);
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
    <Dialog.Root open={open} onOpenChange={next=>{if(!pending){setOpen(next);if(!next)setError('');}}}>
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
            onSubmit={event => {
              event.preventDefault();
              if(pending||zeroDays)return;
              const data=new FormData(event.currentTarget);
              setError('');
              startSubmit(async()=>{
                try {
                  const result=await submitAction(data,true);
                  if(result?.error){setError(result.error);requestAnimationFrame(()=>errorRef.current?.focus());return;}
                  setOpen(false);
                  if(result?.redirectTo)router.push(result.redirectTo);
                  else router.refresh();
                } catch {
                  setError(t('submitUnconfirmed'));
                  requestAnimationFrame(()=>errorRef.current?.focus());
                }
              });
            }}
            className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <fieldset disabled={pending} className="contents">
            <LeaveDurationFields
              types={types}
              startDefault={startDefault}
              endDefault={endDefault}
              durationDefault={durationDefault}
              defaultTypeId={defaultTypeId}
              showDocumentFields
              employeeOptions={employeeOptions}
              ownEmploymentId={ownEmploymentId}
              eligibleTypeIdsByEmployment={eligibleTypeIdsByEmployment}
              action={previewAction}
              summaryAction={summaryAction}
              onZeroDaysChange={setZeroDays}
            />
            <Field label={t('fieldReason')}>
              <input name="reason" className={inputCls} placeholder={t('reasonPlaceholder')} />
            </Field>
            {error&&<p ref={errorRef} role="alert" tabIndex={-1} className="rounded-md border border-destructive p-3 text-sm text-destructive sm:col-span-2">{error}</p>}
            {zeroDays&&<p role="status" className="text-sm text-muted-foreground sm:col-span-2">{t('zeroDaysHint')}</p>}
            <div className="flex items-end justify-end gap-3 sm:col-span-2">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancelDialogDismiss')}
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={pending||zeroDays}>{pending?t('submittingRequest'):t('submitRequest')}</Button>
            </div>
            </fieldset>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
