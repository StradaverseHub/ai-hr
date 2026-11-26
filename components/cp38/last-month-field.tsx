'use client';

import { useState } from 'react';
import { inputCls } from '@/components/ui';
import { personnelInput } from '@/lib/personnel-form-contract';

/**
 * bc6b5490 — the "Last month amount" tick box of the CP38 Add/Edit form, shared by the employee's Payroll tab and
 * the Payroll > Transaction Entry > CP38 Deduction pop-up so the two forms ask the same question the same way.
 *
 * Ticked, it reveals "Last month deduction amount (RM)" (required, numeric, zero or more) and posts
 * `lastMonthEnabled=1`; unticked it posts neither field, which the shared reader (lib/cp38-form.ts) turns into
 * "no last-month amount", so un-ticking on Edit clears it. An Effective to month is then required too — the browser
 * cannot say that across two fields, so the service refuses it by name (`lastMonthNeedsEnd`) and the screen shows it.
 *
 * Every prop is plain data with pre-translated labels: the Payroll tab is a server component, and a function prop
 * crossing that boundary is a 500 nothing else catches (r123).
 */
export function Cp38LastMonthField({
  defaultAmount,
  labels,
}: {
  /** The record's saved last-month amount ('289.35'), or null when it has none. */
  defaultAmount: string | null;
  labels: { toggle: string; amount: string; hint: string };
}) {
  const [on, setOn] = useState(defaultAmount != null);
  return (
    <div className="flex flex-col gap-2 sm:col-span-2">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          name="lastMonthEnabled"
          value="1"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
          className="size-4 rounded"
          data-cp38-last-month-toggle=""
        />
        {labels.toggle}
      </label>
      {on && (
        <label className="flex flex-col gap-1.5 sm:max-w-xs">
          <span className="text-xs font-medium text-muted-foreground">{labels.amount}</span>
          <input
            {...personnelInput('payroll.cp38_deduction.lastmonthamount', 'edit')}
            required
            inputMode="decimal"
            defaultValue={defaultAmount ?? ''}
            className={inputCls}
          />
          <span className="text-xs text-muted-foreground">{labels.hint}</span>
        </label>
      )}
    </div>
  );
}
