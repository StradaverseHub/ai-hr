'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Play } from 'lucide-react';
import { Button } from '../ui';
import {
  EarnedAccrualCard,
  type EarnedScopeOption,
  type EarnedLeaveYearOption,
} from '../earned-accrual-card';

/**
 * Run Accrual dialog (R61 · feedback d778d2d3). The Run Earned Accrual tool lost its standalone
 * section on the Entitlements page: this compact "Run Accrual" button opens the SAME
 * EarnedAccrualCard — scope selection, dry-run preview, confirm — inside a wide pop-up. It first
 * sat in the PageHeader actions cluster; since R64 (7b945408 + 962077a8) it mounts ONLY inside the
 * Entitlement step's Adjustments sub-step, where entitlement adjustments live. The card is wrapped unchanged: it is fully
 * self-contained (its Preview/Run/Cancel/Export buttons call the server actions directly via
 * useTransition — no <form>, so the ConfirmSubmit requestSubmit-in-portal caveat does not apply).
 * Structure mirrors leave-year-edit-dialog.tsx (Dialog.Root + useState open, Radix portal).
 *
 * Width: the preview table sets min-w-[720px] inside its own overflow-x-auto container, so the
 * content needs a WIDE dialog (max-w-4xl) to show the dry-run numbers without immediate scrolling;
 * on narrow screens the table scrolls horizontally inside the card exactly as it did in the section.
 *
 * The trigger Button MUST be type="button" — the trigger may sit inside other layouts and a
 * default-type button could submit an enclosing form.
 */
export function EarnedAccrualDialog({
  companies,
  grades,
  leaveTypes,
  leaveYears,
  defaultYear,
}: {
  companies: EarnedScopeOption[];
  grades: EarnedScopeOption[];
  leaveTypes: EarnedScopeOption[];
  leaveYears: EarnedLeaveYearOption[];
  defaultYear: number;
}) {
  const t = useTranslations('admin.leave');
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" className="gap-1.5">
          <Play className="size-3.5" />
          {t('runAccrualAction')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('runEarnedAccrual')}</Dialog.Title>
          {/* -mx-4 lines the card's own px-4 gutters up with the dialog's p-5 padding (the same
              gutter-alignment trick the Entitlement step uses for FestiveGrantCard). */}
          <div className="-mx-4 mt-2">
            <EarnedAccrualCard
              companies={companies}
              grades={grades}
              leaveTypes={leaveTypes}
              leaveYears={leaveYears}
              defaultYear={defaultYear}
            />
          </div>
          <div className="flex justify-end pt-2">
            <Dialog.Close asChild>
              <Button type="button" size="sm" variant="outline">
                {t('close')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
