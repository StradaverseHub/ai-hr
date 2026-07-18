'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { createFixedTransactionAction } from './actions';

export type AddDialogComponent = { id: string; code: string; name: string };

/**
 * Fixed Transaction toolbar (feedback ee21508c). The always-on add form is replaced by a single
 * "Add New Fixed Transaction" button that opens this modal only when the admin wants to add one — keeping
 * the transaction list as the primary surface. Export is a labelled placeholder for the noted future work;
 * Refresh re-reads the current employee's list. The form posts to the unchanged createFixedTransactionAction
 * (server-side scope-guard + validation intact); a redirect on submit closes the modal via navigation.
 */
export function FixedToolbar({
  employmentId,
  defaultStart,
  components,
  cycles,
}: {
  employmentId: string;
  defaultStart: string;
  components: AddDialogComponent[];
  cycles: readonly string[];
}) {
  const t = useTranslations('payroll.transactions.fixed');
  const tc = useTranslations('payroll.transactions.individual');
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <Button type="button" size="sm">
            {t('addNew')}
          </Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <Dialog.Title className="text-base font-semibold">{t('formTitle')}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('intro')}</Dialog.Description>
            <form
              action={createFixedTransactionAction}
              onSubmit={() => setOpen(false)}
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              <input type="hidden" name="employmentId" value={employmentId} />
              <Field label={t('payrollItem')} required requiredAriaLabel={t('requiredField')}>
                <select name="componentId" required className={inputCls}>
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('payrollCycle')} required requiredAriaLabel={t('requiredField')}>
                <select name="runType" required defaultValue="" className={inputCls}>
                  <option value="" disabled>
                    —
                  </option>
                  {cycles.map((c) => (
                    <option key={c} value={c}>
                      {tc(`cycle.${c}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('amount')} required requiredAriaLabel={t('requiredField')}>
                <input name="amount" type="number" min="0.01" step="0.01" required className={`${inputCls} text-right`} />
              </Field>
              <Field label={t('startDate')} required requiredAriaLabel={t('requiredField')}>
                <input name="effectiveFrom" type="date" required defaultValue={defaultStart} className={inputCls} />
              </Field>
              <Field label={t('endDate')}>
                <input name="effectiveTo" type="date" className={inputCls} />
              </Field>
              <Field label={t('remarks')}>
                <input name="remarks" type="text" className={inputCls} />
              </Field>
              <div className="col-span-full mt-2 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline" size="sm">
                    {t('cancel')}
                  </Button>
                </Dialog.Close>
                <Button type="submit" size="sm">
                  {t('add')}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Button type="button" variant="outline" size="sm" disabled title={t('exportSoon')}>
        {t('export')}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
        {t('refresh')}
      </Button>
    </div>
  );
}
