'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { createFixedTransactionAction } from './actions';

export type AddDialogComponent = { id: string; code: string; name: string };

/** 4fffe638 — one ACTIVE configured Payroll Cycle of the selected employee's company, in the Payroll
 *  Cycles order. The id is what is posted; the service derives the run type from it. */
export type AddDialogCycle = { id: string; name: string };

/**
 * 2aed39d4 — one recurring row the employee ALREADY holds, as the Add dialog sees it. Ended rows are
 * included on purpose: an ended row still occupies its dates, and a new row running into one is exactly
 * the case that produced X000001's three overlapping HANDPHONE ALLOWANCE lines.
 */
export type AddDialogExisting = {
  componentId: string;
  code: string;
  amount: string;
  validFrom: string;
  /** INCLUSIVE end date; null = open-ended. */
  validTo: string | null;
  ended: boolean;
};

/** Inclusive-inclusive overlap — the same boundary the kernel pays on and migration 0426 indexes. */
const overlaps = (r: AddDialogExisting, from: string, to: string | null) =>
  r.validFrom <= (to ?? '9999-12-31') && from <= (r.validTo ?? '9999-12-31');

/**
 * Fixed Transaction toolbar (feedback ee21508c). The always-on add form is replaced by a single
 * "Add New Fixed Transaction" button that opens this modal only when the admin wants to add one — keeping
 * the transaction list as the primary surface. Export is a labelled placeholder for the noted future work;
 * Refresh re-reads the current employee's list. The form posts to the unchanged createFixedTransactionAction
 * (server-side scope-guard + validation intact); a redirect on submit closes the modal via navigation.
 *
 * 2aed39d4 — THE PRE-SAVE WARNING. The dialog used to be handed the catalog and NOTHING about what the
 * employee already holds, so the first time an operator learned their dates collided was after the save
 * — and until this round, not even then: the save silently succeeded and the item paid twice. The
 * employee's live rows now come in with the catalog, and the block below shows the ones for the pay item
 * currently selected, turning amber the moment the typed dates run into one.
 *
 * IT IS A WARNING, NOT THE RULE. The refusal lives in setEmploymentPayComponent and the backstop is the
 * 0426 exclusion constraint; this is the third layer and the only one the operator sees BEFORE pressing
 * Save. It deliberately does NOT disable the button — the server decides, and a client-side block that
 * disagreed with the server would be a worse bug than the one being fixed.
 */
export function FixedToolbar({
  employmentId,
  defaultStart,
  components,
  cycles,
  existing = [],
}: {
  employmentId: string;
  defaultStart: string;
  components: AddDialogComponent[];
  cycles: AddDialogCycle[];
  existing?: AddDialogExisting[];
}) {
  const t = useTranslations('payroll.transactions.fixed');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mirrors of the three fields the overlap depends on. The form still posts the real inputs; these
  // exist only so the warning can be computed as the operator types.
  const [componentId, setComponentId] = useState(components[0]?.id ?? '');
  const [from, setFrom] = useState(defaultStart);
  const [to, setTo] = useState('');

  const held = existing.filter((r) => r.componentId === componentId);
  const clashes = from ? held.filter((r) => overlaps(r, from, to || null)) : [];

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
                <select
                  name="componentId"
                  required
                  className={inputCls}
                  value={componentId}
                  onChange={(e) => setComponentId(e.target.value)}
                >
                  {components.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('payrollCycle')} required requiredAriaLabel={t('requiredField')}>
                <select name="payrollCycleId" required defaultValue="" className={inputCls}>
                  <option value="" disabled>
                    —
                  </option>
                  {cycles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {cycles.length === 0 && <p className="mt-1 text-xs text-muted-foreground">{t('noCycles')}</p>}
              </Field>
              <Field label={t('amount')} required requiredAriaLabel={t('requiredField')}>
                <input name="amount" type="number" min="0.01" step="0.01" required className={`${inputCls} text-right`} />
              </Field>
              <Field label={t('startDate')} required requiredAriaLabel={t('requiredField')}>
                <input
                  name="effectiveFrom"
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('endDate')}>
                {/* Blank by default (ticket point 4): a blank end date means the item runs until another
                    record replaces it or it is stopped by hand. */}
                <input
                  name="effectiveTo"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('remarks')}>
                <input name="remarks" type="text" className={inputCls} />
              </Field>

              {/* ── 2aed39d4: what this employee already holds for the selected pay item ── */}
              {held.length > 0 && (
                <div
                  className={
                    clashes.length > 0
                      ? 'col-span-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                      : 'col-span-full rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground'
                  }
                >
                  <p className="font-medium">{t('existingTitle', { count: held.length })}</p>
                  <ul className="mt-1 space-y-0.5">
                    {held.map((r) => (
                      <li key={`${r.componentId}-${r.validFrom}-${r.validTo ?? 'open'}-${r.amount}`} className="tabular-nums">
                        {r.amount} · {r.validFrom} – {r.validTo ?? t('openEnded')}
                        {r.ended ? ` · ${t('statusEnded')}` : ''}
                        {clashes.includes(r) ? ` · ${t('existingClashTag')}` : ''}
                      </li>
                    ))}
                  </ul>
                  {clashes.length > 0 && <p className="mt-1.5 font-medium">{t('existingClash')}</p>}
                </div>
              )}

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
