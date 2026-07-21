'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

type OpeningUnit = 'days' | 'weeks' | 'months';

/**
 * Advanced Leave Year Rules dialog (cluster 37088a65). Replaces the shared bottom-of-page "Advanced leave
 * year rules" panel: each DRAFT leave-year row now opens its OWN pop-up, prefilled with that year's saved
 * advance-opening settings. The year is pinned by a hidden input derived from the row (never a dropdown),
 * so a rule can no longer be saved onto the wrong leave year. Structure mirrors edit-leave-dialog.tsx
 * (Dialog.Root + useState open, form wholly inside Dialog.Content, onSubmit closes).
 *
 * Validation is stateful on purpose: `required` on the amount input is bound to the enable checkbox's
 * state — an unconditional `required` would block the DISABLE path (unticking the box with an empty amount
 * must still save). saveFutureOpeningRule remains the authority; `enable` absent ⇒ disable the rule.
 */
export function LeaveYearRuleDialog({
  year,
  current,
  saveAction,
}: {
  year: number;
  current: {
    openingRuleEnabled: boolean;
    openBeforeAmount: number | null;
    openBeforeUnit: OpeningUnit | null;
    openLeaveYearDate: string | null;
  };
  saveAction: Action;
}) {
  const t = useTranslations('admin.leave');
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(current.openingRuleEnabled);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline">
          {t('leaveYearAdvancedTitle')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          {/* Title names the clicked year directly (a number needs no translation — no new ICU key). */}
          <Dialog.Title className="text-base font-semibold">
            {t('leaveYearAdvancedTitle')} {year}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {t('openingRuleHelp')}
          </Dialog.Description>
          <form action={saveAction} className="mt-4 space-y-3" onSubmit={() => setOpen(false)}>
            {/* The year binding: fixed to the row that opened the dialog — no year dropdown exists here. */}
            <input type="hidden" name="year" value={year} />

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="enable"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4 rounded"
              />
              {t('openingRuleEnableLabel')}
            </label>

            <Field label={t('openBeforeAmountLabel')}>
              <input
                type="number"
                name="openBeforeAmount"
                min={1}
                step={1}
                required={enabled}
                defaultValue={current.openBeforeAmount ?? ''}
                placeholder="14"
                className={inputCls}
              />
            </Field>

            <Field label={t('openBeforeUnitLabel')}>
              <select name="openBeforeUnit" defaultValue={current.openBeforeUnit ?? 'days'} className={inputCls}>
                <option value="days">{t('openingUnitDays')}</option>
                <option value="weeks">{t('openingUnitWeeks')}</option>
                <option value="months">{t('openingUnitMonths')}</option>
              </select>
            </Field>

            {/* The currently computed opening date, shown on (re)open so the admin sees the saved rule took. */}
            {current.openingRuleEnabled && (
              <p className="text-xs text-muted-foreground">
                {t('openingRuleSummary', {
                  year,
                  amount: current.openBeforeAmount ?? 0,
                  unit: t(
                    current.openBeforeUnit === 'weeks'
                      ? 'openingUnitWeeks'
                      : current.openBeforeUnit === 'months'
                        ? 'openingUnitMonths'
                        : 'openingUnitDays',
                  ),
                  date: current.openLeaveYearDate ?? '—',
                })}
              </p>
            )}

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
