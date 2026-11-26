'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Field, inputCls } from '@/components/ui';
import { DateField } from '@/components/ui/date-field';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { useActionFeedbackToast } from '@/components/ui/toast-trigger';
import { Cp38LastMonthField } from '@/components/cp38/last-month-field';
import { Cp38HistoryList, type Cp38HistoryEntry, type Cp38HistoryLabels } from '@/components/cp38/history-list';
import { ACTION_NAVIGATION_FIELD, inAppHref, splitActionFeedback } from '@/lib/action-navigation';
import { deleteCp38DialogAction, saveCp38DialogAction, type Cp38DialogResult } from './actions';

/**
 * 038c304b — the CP38 Deduction page's Add / Edit / Delete / History pop-ups, modelled on the Fixed Transaction
 * View / Edit pop-up (app/payroll/transactions/fixed/edit-fixed-dialog.tsx): the actions ANSWER WITH A VALUE, so a
 * refused save keeps the pop-up open with the typing intact and the reason inside it, and a successful one closes it
 * and navigates in-app to the list it came from (lib/action-navigation.ts) — the app frame is not redrawn.
 *
 * The form has the fields of the employee's Payroll tab, and the same "Last month amount" control
 * (components/cp38/last-month-field.tsx); both screens post through lib/cp38-form.ts into the same core/cp38.ts
 * writers, so a record changed here is the record on the employee's tab (bc6b5490: editable and deletable always).
 *
 * Every prop is plain data with pre-translated labels (the page is a server component; r123).
 */
export type Cp38DialogRecord = {
  id: string;
  employmentId: string;
  cp38Ref: string;
  amount: string;
  lastMonthAmount: string | null;
  validFrom: string;
  /** INCLUSIVE last month, null = open-ended. */
  validTo: string | null;
  remarks: string | null;
};
export type Cp38DialogLabels = {
  add: string;
  addTitle: string;
  edit: string;
  editTitle: string;
  save: string;
  saving: string;
  close: string;
  ref: string;
  refPlaceholder: string;
  amount: string;
  from: string;
  to: string;
  toHint: string;
  remarks: string;
  remarksPlaceholder: string;
  lastMonth: { toggle: string; amount: string; hint: string };
  delete: string;
  deleteTitle: string;
  history: string;
  historyTitle: string;
  historyLabels: Cp38HistoryLabels;
};

/** The pop-up shell the four controls share (the Family-tab dialog's shape). */
function Shell({ trigger, title, open, onOpenChange, children }: {
  trigger: ReactNode;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Run a value-returning action; on success navigate in-app with its feedback, else show the refusal. */
function useCp38Submit(onDone: () => void) {
  const router = useRouter();
  const showFeedback = useActionFeedbackToast();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const submit = (action: (fd: FormData) => Promise<Cp38DialogResult>) => (fd: FormData) =>
    start(async () => {
      fd.set(ACTION_NAVIGATION_FIELD, 'client');
      const result = await action(fd);
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage(null);
      onDone();
      const target = inAppHref(result.navigate);
      if (!target) return;
      const { href, feedback } = splitActionFeedback(target);
      showFeedback(feedback);
      router.push(href);
    });
  return { pending, message, setMessage, submit };
}

function Cp38Form({ record, employmentId, returnTo, defaultFrom, labels, onDone }: {
  record: Cp38DialogRecord | null;
  employmentId: string;
  returnTo: string;
  defaultFrom: string;
  labels: Cp38DialogLabels;
  onDone: () => void;
}) {
  const { pending, message, submit } = useCp38Submit(onDone);
  return (
    <form action={submit(saveCp38DialogAction)} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2" data-cp38-form="">
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {record && <input type="hidden" name="id" value={record.id} />}
      {message && (
        <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300 sm:col-span-2">
          {message}
        </p>
      )}
      <Field label={labels.ref} required>
        <input name="cp38Ref" required defaultValue={record?.cp38Ref ?? ''} placeholder={labels.refPlaceholder} className={inputCls} />
      </Field>
      <Field label={labels.amount} required>
        <input
          name="amount"
          type="number"
          min={0}
          step={0.01}
          required
          inputMode="decimal"
          defaultValue={record ? Number(record.amount).toFixed(2) : ''}
          className={inputCls}
        />
      </Field>
      <Field label={labels.from} required>
        <DateField name="validFrom" required defaultValue={record?.validFrom ?? defaultFrom} className={inputCls} label={labels.from} />
      </Field>
      <Field label={labels.to}>
        <DateField name="validTo" defaultValue={record?.validTo ?? ''} className={inputCls} label={labels.to} />
        <span className="text-xs text-muted-foreground">{labels.toHint}</span>
      </Field>
      <Cp38LastMonthField defaultAmount={record?.lastMonthAmount ?? null} labels={labels.lastMonth} />
      <Field label={labels.remarks} className="sm:col-span-2">
        <input name="remarks" defaultValue={record?.remarks ?? ''} placeholder={labels.remarksPlaceholder} className={inputCls} />
      </Field>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? labels.saving : labels.save}
        </Button>
      </div>
    </form>
  );
}

/** Add CP38 for the employee chosen in the panel (active employees only: the page offers Add only for them). */
export function Cp38AddButton({ employmentId, returnTo, defaultFrom, labels }: {
  employmentId: string;
  returnTo: string;
  defaultFrom: string;
  labels: Cp38DialogLabels;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Shell trigger={<Button size="sm">{labels.add}</Button>} title={labels.addTitle} open={open} onOpenChange={setOpen}>
      <Cp38Form record={null} employmentId={employmentId} returnTo={returnTo} defaultFrom={defaultFrom} labels={labels} onDone={() => setOpen(false)} />
    </Shell>
  );
}

/** Edit, Delete (with a confirmation naming the record) and History for one list row. */
export function Cp38RowActions({ record, returnTo, labels, history, deleteDescription }: {
  record: Cp38DialogRecord;
  returnTo: string;
  labels: Cp38DialogLabels;
  history: readonly Cp38HistoryEntry[];
  /** The confirmation's sentence naming this record (reference, amount and months), pre-translated. */
  deleteDescription: string;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const del = useCp38Submit(() => undefined);
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Shell
        trigger={<Button size="sm" variant="outline">{labels.edit}</Button>}
        title={labels.editTitle}
        open={editOpen}
        onOpenChange={setEditOpen}
      >
        <Cp38Form
          record={record}
          employmentId={record.employmentId}
          returnTo={returnTo}
          defaultFrom={record.validFrom}
          labels={labels}
          onDone={() => setEditOpen(false)}
        />
      </Shell>
      <Shell
        trigger={<Button size="sm" variant="outline">{labels.history}</Button>}
        title={labels.historyTitle}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      >
        <Cp38HistoryList entries={history} labels={labels.historyLabels} />
      </Shell>
      <form action={del.submit(deleteCp38DialogAction)}>
        <input type="hidden" name="id" value={record.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <ConfirmSubmit size="sm" title={labels.deleteTitle} description={deleteDescription} confirmLabel={labels.delete} disabled={del.pending}>
          {labels.delete}
        </ConfirmSubmit>
      </form>
      {del.message && (
        <p role="alert" className="basis-full text-right text-xs text-rose-700 dark:text-rose-300">
          {del.message}
        </p>
      )}
    </div>
  );
}

/** One employee's whole correction history, deleted records included (shown when an employee is chosen). */
export function Cp38EmployeeHistoryButton({ history, labels, title }: {
  history: readonly Cp38HistoryEntry[];
  labels: Cp38DialogLabels;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Shell trigger={<Button size="sm" variant="outline">{labels.history}</Button>} title={title} open={open} onOpenChange={setOpen}>
      <Cp38HistoryList entries={history} labels={labels.historyLabels} />
    </Shell>
  );
}
