'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
import type { ButtonProps } from '@/components/ui/button';
// b25e421e — from lib/, never core/: the header below records that core/dependents.ts pulls the pg driver
// via db/client and must not cross into a client bundle. lib/dependent-vocabulary.ts is the client-safe
// half core/dependents.ts re-exports, and lib/hr-date.ts is pure Intl.
import { childAgeYears } from '@/lib/dependent-vocabulary';
import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Item 5988053a — Family tab Add/Edit child dialog shell. The ONLY client file this feature adds, modelled
 * on FixedToolbar (app/payroll/transactions/fixed/add-fixed-dialog.tsx): a trigger Button plus a Radix
 * Dialog whose body is the SERVER-RENDERED dependent form passed as `children`. It holds the open state and
 * nothing else — no core/ import (core/dependents.ts pulls the pg driver via db/client, so values from it
 * must never cross into a client bundle), and no message namespace beyond the close label.
 *
 * TAB RETENTION (feedback bd2f0bb2): Dialog.Portal reparents Content to document.body, so the form inside
 * it is OUTSIDE the PersonnelTabs shell and the shell's capture-phase submit listener never sees it
 * (`shell.contains(form)` is false). The server page therefore renders a STATIC hidden
 * `<input name="tab" value="family" data-tab-tracker />` inside every dialog form — that input, not this
 * component, is what keeps the post-save redirect on the Family tab.
 *
 * ERROR PATH — accepted, documented limitation: addDependentAction / editDependentAction redirect with
 * `?error=` on a DependentValidationError, so a failed submit navigates away and the typed values are lost
 * (unchanged from the pre-dialog inline forms for realistic input; HTML validation catches the common
 * mistakes client-side). Deliberately NO optimistic close-on-submit here (unlike the FixedToolbar
 * precedent) — the redirect is what dismisses the dialog, so an error redirect is never masked by an
 * eagerly-closed modal.
 *
 * LIVE AGE: while the admin types a date of birth, the read-only Age field (marked `data-child-age` by the
 * server form) updates immediately via a delegated onInput listener. This mirrors, for display only, the
 * authoritative whole-year rule in core/dependents.ts childAgeYears (which this bundle cannot import — see
 * above); the server re-derives the real value on save, and the relief-category note next to the field is
 * static guidance — the category is never auto-filled from an age-based guess.
 */
export function FamilyFormDialog({
  triggerLabel,
  triggerVariant = 'default',
  title,
  children,
}: {
  triggerLabel: string;
  triggerVariant?: ButtonProps['variant'];
  title: string;
  children: ReactNode;
}) {
  const t = useTranslations('components.confirmSubmit');
  const [open, setOpen] = useState(false);

  const onFormInput = (e: FormEvent<HTMLDivElement>) => {
    const el = e.target as HTMLInputElement | null;
    if (!el || el.name !== 'dateOfBirth') return;
    const out = e.currentTarget.querySelector<HTMLInputElement>('input[data-child-age]');
    if (!out) return;
    // b25e421e (r352) — THROUGH THE SHARED COUNTER, not a third copy of the arithmetic. This line used to
    // carry its own `floor(elapsed / 365.25 days)`, the same approximation `childAgeYears` was built on and
    // the same one that read 17 to a child on their eighteenth birthday. Two copies of an age rule agree
    // until one is corrected, and this dialog is where HR reads the Age back before saving the date — so it
    // is the worst possible place to disagree with the eligibility the tax figure is then derived from.
    const age = childAgeYears(el.value, new Date(`${todayInKualaLumpur()}T00:00:00Z`));
    out.value = age == null ? '—' : String(age);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant={triggerVariant}>
          {triggerLabel}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="sm" aria-label={t('cancel')}>
                ✕
              </Button>
            </Dialog.Close>
          </div>
          <div className="mt-4" onInput={onFormInput}>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
