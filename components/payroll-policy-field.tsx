'use client';

/**
 * Payroll Policy — the "Applied policy" select. A shared field group (r393, item 685d2380 step 2): the
 * Personnel record's Payroll policy card and the draft employee's Payroll tab render THIS, so both offer
 * the same list in the same words — the company's ACTIVE payroll policies (`listAssignablePolicies`) or
 * the Monthly default (blank = null).
 *
 *   mode: 'form'        → `name="policyId"` + `defaultValue`, read by assignPolicyAction. NO function prop
 *                         (the r123 RSC-boundary fault). Its markup is the record's markup from before the
 *                         extraction, byte for byte — test/r393-draft-payroll-tab.dom.test.tsx pins it.
 *   mode: 'controlled'  → `value` + `onChange`, bound to the draft's state. No `name`.
 *
 * A STORED PICK THAT IS NO LONGER OFFERED (controlled mode only). A draft can hold a policy id that has
 * since been deactivated or deleted. A controlled `<select>` whose value matches no option silently SHOWS
 * the first option — "Monthly (default)" — while the draft still holds the stale id, and Activate would then
 * refuse a choice the screen says was never made. So the stale id is kept as its own option, labelled as
 * unavailable, until HR picks again. The record's form mode is unchanged (its own inactive-policy note
 * stays on the card).
 *
 * The CALLER decides whether the control appears at all (Payroll switched on); this file only renders it.
 * ONE NAMESPACE (`payrollPolicy`) and every key a literal.
 */

import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

export type AssignablePolicyOption = { id: string; name: string };

type Mode =
  | { mode: 'form'; defaultValue: string | null | undefined }
  | { mode: 'controlled'; value: string | null | undefined; onChange: (policyId: string) => void };

export function PayrollPolicyField(props: Mode & { policies: AssignablePolicyOption[] }) {
  const tp = useTranslations('payrollPolicy');
  const current = props.mode === 'controlled' ? (props.value ?? '') : '';
  const stale = props.mode === 'controlled' && current !== '' && !props.policies.some((p) => p.id === current);
  return (
    <Field label={tp('assignLabel')}>
      <select
        {...(props.mode === 'form'
          ? { name: 'policyId', defaultValue: props.defaultValue ?? '' }
          : {
              value: current,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) => props.onChange(e.target.value),
            })}
        className={inputCls}
      >
        <option value="">{tp('assignNone')}</option>
        {stale && <option value={current}>{tp('assignUnavailable')}</option>}
        {props.policies.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </Field>
  );
}

/** The record's own guidance under the select ("Payroll uses the assigned policy automatically…"). */
export function PayrollPolicyHint({ className }: { className?: string }) {
  const tp = useTranslations('payrollPolicy');
  return <p className={className}>{tp('assignHint')}</p>;
}
