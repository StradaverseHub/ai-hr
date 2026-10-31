'use client';

import { useState } from 'react';
import { inputCls } from '@/components/ui';

/** One configured Payroll Cycle as the Fixed Transaction Edit screen offers it. */
export type FixedCycleOption = { id: string; label: string };

/**
 * 4fffe638 — the Payroll Cycle select on the Fixed Transaction EDIT page, with the hidden `cycleTouched`
 * flag beside it.
 *
 * WHY THE FLAG EXISTS. A `<select>` is always submitted, so the action cannot tell "the operator kept the
 * cycle" from "the operator chose this cycle" by presence (CLAUDE.md §8). The difference matters: an
 * untouched save must carry the edited row's own link forward — including a link to a cycle that has
 * since been made inactive, or an old run-type tag the one-match backfill could not resolve — while a
 * touched save re-links and is validated. The flag starts '0' and flips to '1' on the first change; the
 * action sends the cycle to the service only when it is '1' (the c11e81aa pattern in
 * individual/txn-workspace.tsx).
 *
 * Labels arrive pre-translated from the server page, so this island has no namespace of its own.
 */
export function FixedCycleSelect({
  options,
  defaultValue,
  placeholderLabel,
}: {
  options: FixedCycleOption[];
  /** The row's linked cycle id, or '' when it is unlinked. */
  defaultValue: string;
  /** What the empty option says: the row's old run-type label, or "—". */
  placeholderLabel: string;
}) {
  const [touched, setTouched] = useState(false);
  return (
    <>
      <select
        name="payrollCycleId"
        defaultValue={defaultValue}
        className={inputCls}
        onChange={() => setTouched(true)}
      >
        <option value="">{placeholderLabel}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <input type="hidden" name="cycleTouched" value={touched ? '1' : '0'} />
    </>
  );
}
