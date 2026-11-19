'use client';

import { Field, inputCls } from '@/components/ui';

export function StatutoryPeriodFields({ year, month, payrollCycleId, years, months, availableCycles, labels }: {
  year?: number;
  month?: string;
  payrollCycleId?: string;
  years: number[];
  months: string[];
  availableCycles: { id: string; label: string }[];
  labels: { year: string; month: string; cycle: string; empty: string; months: string[] };
}) {
  return (
    <>
      <Field label={labels.year}>
        <select name="year" className={inputCls} defaultValue={year ?? ''} disabled={!years.length}
          onChange={(event) => {
            const form = event.currentTarget.form;
            const month = form?.elements.namedItem('month');
            const cycle = form?.elements.namedItem('payrollCycleId');
            if (month instanceof HTMLSelectElement) month.value = '';
            if (cycle instanceof HTMLSelectElement) cycle.value = '';
            form?.requestSubmit();
          }}>
          {!years.length && <option value="">{labels.empty}</option>}
          {years.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </Field>
      <Field label={labels.month}>
        <select name="month" className={inputCls} defaultValue={month ?? ''} disabled={!months.length}
          onChange={(event) => {
            const form = event.currentTarget.form;
            const cycle = form?.elements.namedItem('payrollCycleId');
            if (cycle instanceof HTMLSelectElement) cycle.value = '';
            form?.requestSubmit();
          }}>
          {!months.length && <option value="">{labels.empty}</option>}
          {months.map((option) => <option key={option} value={option}>{labels.months[Number(option) - 1]}</option>)}
        </select>
      </Field>
      <Field label={labels.cycle}>
        <select name="payrollCycleId" className={inputCls} defaultValue={payrollCycleId ?? ''} disabled={!availableCycles.length}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}>
          {(!availableCycles.length || !payrollCycleId) && <option value="">{labels.empty}</option>}
          {availableCycles.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </Field>
    </>
  );
}
