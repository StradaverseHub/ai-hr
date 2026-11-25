'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as Dialog from '@radix-ui/react-dialog';
import { toast } from 'sonner';
import { ActionButton } from '@/components/ui/action-button';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { Badge, ErrorBanner, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { formatMoney } from '@/lib/money';
import {
  removeFixedTransactionDialogAction,
  saveFixedTransactionDialogAction,
  type FixedDialogResult,
} from './actions';
import { FixedCycleSelect } from './cycle-select';
import { FIXED_ERROR_KEYS, fixedErrorValues, type FixedEditCycleOption } from './edit-model';

/**
 * cc8bd87f — Fixed Transaction View / Edit, as a POP-UP over the employee's transaction list.
 *
 * WHAT IT REPLACES. View / Edit used to leave the list for a separate page (`fixed/[id]`, f3ae3245) with
 * two boxes that set the SAME stored date: an Edit form with "End date" and a Stop form with "Last date to
 * pay". Both wrote `employment_pay_component.valid_to`; they differed only in how they saved. Here there is
 * one field, End Date (Last Date to Pay), and one Save: `editFixedTransaction` writes nothing when nothing
 * changed, updates the same line when only the end date changed (so ending still works after a closed
 * month, as Stop did), and adds a new line exactly as Edit did for anything else.
 *
 * THE SHAPE IS app/admin/holidays/holiday-dialog.tsx, copied on purpose: Radix Dialog, useActionState over
 * VALUE-RETURNING server actions, every label pre-translated by the server page, no core/ import. The form
 * has NO `action` prop — onSubmit dispatches the action inside startTransition — because React 19 resets a
 * `<form action={…}>` when the action settles, and a refused save must keep the typing (read that file's
 * header for the proof). Mounted only while open (the list renders it for one row at a time), so Cancel and
 * the cross discard everything and the next open starts from the stored values again.
 *
 * The one translation done here is the refusal: it comes back from the action as a key plus ICU arguments
 * (`overlap` names the clashing record, `endClosedMonth` the closed month), which only exist after the save.
 */

/** Every visible string, resolved by the server page (payroll.transactions.fixed). */
export type EditFixedDialogLabels = {
  subtitle: string;
  notChangedHere: string;
  employee: string;
  currentAmount: string;
  status: string;
  statusActive: string;
  statusEnded: string;
  versioningTitle: string;
  versioningBody: string;
  amount: string;
  payrollCycle: string;
  startDate: string;
  endDate: string;
  endDateHint: string;
  remarks: string;
  requiredField: string;
  save: string;
  saving: string;
  cancel: string;
  close: string;
  remove: string;
  removeTitle: string;
  removeBody: string;
  saved: string;
  removed: string;
  openEnded: string;
};

/** The row being viewed, from the list's own read (no extra request). */
export type EditFixedDialogRow = {
  id: string;
  code: string;
  name: string;
  /** numeric(12,2) as a string, straight from the row. */
  amount: string;
  currency: string | null;
  validFrom: string;
  /** INCLUSIVE last date to pay; null = open-ended (the field shows blank, never a default). */
  validTo: string | null;
  remarks: string | null;
  /** The linked configured cycle, '' / null when unlinked. */
  payrollCycleId: string | null;
  ended: boolean;
  /** The company's active cycles, with an inactive linked cycle first (fixedEditCycleOptions). */
  cycleOptions: FixedEditCycleOption[];
  /** The empty option's words: the row's old run-type label, or "—". */
  cyclePlaceholder: string;
};

export function EditFixedDialog({
  employmentId,
  employee,
  row,
  labels,
  initialError,
  onClose,
}: {
  employmentId: string;
  employee: { code: string | null; name: string };
  row: EditFixedDialogRow;
  labels: EditFixedDialogLabels;
  /** A refusal that arrived by redirect (the Remove form of the old page, or an old link), already localised. */
  initialError?: string | null;
  onClose: () => void;
}) {
  const tFixed = useTranslations('payroll.transactions.fixed');
  // Refusal keys are dynamic (they come back from the action), so the typed key check cannot apply.
  const t = (key: string, values: Record<string, string>) => tFixed(key as never, values as never);
  const router = useRouter();
  const amountRef = useRef<HTMLInputElement>(null);
  const [saveState, saveAction, savePending] = useActionState<FixedDialogResult | null, FormData>(
    saveFixedTransactionDialogAction,
    null,
  );
  const [removeState, removeAction, removePending] = useActionState<FixedDialogResult | null, FormData>(
    removeFixedTransactionDialogAction,
    null,
  );
  const pending = savePending || removePending;

  // Controlled fields, seeded from the stored row. The cycle select keeps its own cycleTouched flag.
  const [amount, setAmount] = useState(row.amount);
  const [effectiveFrom, setEffectiveFrom] = useState(row.validFrom);
  const [effectiveTo, setEffectiveTo] = useState(row.validTo ?? '');
  const [remarks, setRemarks] = useState(row.remarks ?? '');
  // A refusal that arrived by redirect is captured once: the redirect's query is stripped straight after.
  const [redirectError] = useState<string | null>(initialError ?? null);
  // Which form was submitted last, set in the submit handler, so the banner shows THAT form's answer.
  const [lastSubmit, setLastSubmit] = useState<'save' | 'remove' | null>(null);
  const lastResult = lastSubmit === 'save' ? saveState : lastSubmit === 'remove' ? removeState : null;
  const error =
    lastSubmit === null ? redirectError : lastResult && !lastResult.ok ? refusalText(lastResult, t, labels.openEnded) : null;

  // The success effects read through ONE ref, refreshed every render, so each fires once per RESULT (every
  // dispatch returns a fresh object) and never again because the list handed down a new arrow or labels.
  const latest = useRef({ router, labels, onClose });
  useEffect(() => {
    latest.current = { router, labels, onClose };
  });
  useEffect(() => {
    if (!saveState?.ok) return;
    const { router: r, labels: l, onClose: close } = latest.current;
    // Nothing changed wrote nothing: close without re-reading the list or announcing a save.
    if (saveState.changed) {
      toast.success(l.saved);
      r.refresh();
    }
    close();
  }, [saveState]);
  useEffect(() => {
    if (!removeState?.ok) return;
    const { router: r, labels: l, onClose: close } = latest.current;
    toast.success(l.removed);
    r.refresh();
    close();
  }, [removeState]);

  const formId = `fixed-edit-${row.id}`;
  const dispatch =
    (kind: 'save' | 'remove', action: (fd: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (pending) return;
      const formData = new FormData(e.currentTarget);
      setLastSubmit(kind);
      startTransition(() => action(formData));
    };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !pending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            amountRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold">
                  {row.code} — {row.name}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">{labels.subtitle}</Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={labels.close}
                  disabled={pending}
                  className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  ✕
                </button>
              </Dialog.Close>
            </div>

            {/* The facts NOT editable here, stated as facts rather than as disabled inputs. */}
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{labels.notChangedHere}</p>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {labels.employee}{' '}
                  <span className="font-medium text-foreground">
                    {employee.code ? `${employee.code} · ` : ''}
                    {employee.name}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  {labels.currentAmount}{' '}
                  <span className="font-medium tabular-nums text-foreground">{formatMoney(row.amount, row.currency)}</span>
                </span>
                <span className="text-muted-foreground">
                  {labels.status}{' '}
                  <Badge variant={row.ended ? 'default' : 'success'}>{row.ended ? labels.statusEnded : labels.statusActive}</Badge>
                </span>
              </div>
            </div>

            {/* What Save does, in the room the separate page gave it (f3ae3245), in its shorter form. */}
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
              <span className="font-medium">{labels.versioningTitle}</span> <span>{labels.versioningBody}</span>
            </div>

            {/* The service's refusal, in the pop-up rather than as a redirect. */}
            <div aria-live="polite">{error && <ErrorBanner message={error} />}</div>

            <form
              id={formId}
              // NO `action` PROP, ON PURPOSE — see the file header.
              onSubmit={dispatch('save', saveAction)}
              onReset={(e) => e.preventDefault()}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="id" value={row.id} />
              <Field label={labels.amount} required requiredAriaLabel={labels.requiredField}>
                <input
                  ref={amountRef}
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`${inputCls} text-right tabular-nums`}
                />
              </Field>
              <Field label={labels.payrollCycle}>
                <FixedCycleSelect
                  options={row.cycleOptions}
                  defaultValue={row.payrollCycleId ?? ''}
                  placeholderLabel={row.cyclePlaceholder}
                />
              </Field>
              <Field label={labels.startDate} required requiredAriaLabel={labels.requiredField}>
                <input
                  name="effectiveFrom"
                  type="date"
                  required
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className={`${inputCls} tabular-nums`}
                />
              </Field>
              <div className="flex flex-col gap-1.5">
                <Field label={labels.endDate}>
                  <input
                    name="effectiveTo"
                    type="date"
                    min={effectiveFrom || undefined}
                    value={effectiveTo}
                    onChange={(e) => setEffectiveTo(e.target.value)}
                    className={`${inputCls} tabular-nums`}
                  />
                </Field>
                <p className="text-xs text-muted-foreground">{labels.endDateHint}</p>
              </div>
              <div className="sm:col-span-2">
                <Field label={labels.remarks}>
                  <input
                    name="remarks"
                    type="text"
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              {/* Remove: its own form (a form may not nest inside the Save form), behind the same question. */}
              <form onSubmit={dispatch('remove', removeAction)}>
                <input type="hidden" name="employmentId" value={employmentId} />
                <input type="hidden" name="id" value={row.id} />
                <ConfirmSubmit
                  size="sm"
                  variant="outline"
                  confirmVariant="destructive"
                  className="text-destructive"
                  disabled={pending}
                  title={labels.removeTitle}
                  description={labels.removeBody}
                  confirmLabel={labels.remove}
                >
                  {labels.remove}
                </ConfirmSubmit>
              </form>
              <div className="flex items-center gap-2">
                <Dialog.Close asChild>
                  <button type="button" className={btnGhost} disabled={pending}>
                    {labels.cancel}
                  </button>
                </Dialog.Close>
                <ActionButton aria-busy={savePending} type="submit" form={formId} className={btnPrimary} disabled={pending}>
                  {savePending ? labels.saving : labels.save}
                </ActionButton>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A refusal in words: the screen's sentence with its ICU arguments, or the public error text as given. */
function refusalText(
  r: Extract<FixedDialogResult, { ok: false }>,
  t: (key: string, values: Record<string, string>) => string,
  openEnded: string,
): string {
  return FIXED_ERROR_KEYS.has(r.error) ? t(r.error, fixedErrorValues(r.args, openEnded)) : r.error;
}
