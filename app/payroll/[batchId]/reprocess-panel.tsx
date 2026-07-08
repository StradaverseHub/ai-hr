'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, EmployeeCode } from '@/components/ui';
import { reprocessSelectedAction } from '../actions';

export type ReprocessEmployee = { employmentId: string; employeeCode: string | null; name: string };

/**
 * Selective per-employee reprocessing (feedback 9bc442bc, reporter ask #3). A checkbox multi-select over
 * the processed run's payslips + a "Reprocess selected" submit. Submitting posts the ticked employment ids
 * (native checkbox `name="employmentIds"`) to reprocessSelectedAction, which creates a same-month
 * adjustment run scoped to exactly those employees — the regular run's payslips stay untouched. A live
 * "N of M selected" summary + an optional reason (traceability) sit above the submit.
 */
export function ReprocessPanel({
  batchId,
  employees,
}: {
  batchId: string;
  employees: ReprocessEmployee[];
}) {
  const t = useTranslations('payroll.batch');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const total = employees.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(employees.map((e) => e.employmentId)));
  const clearAll = () => setSelected(new Set());

  return (
    <form action={reprocessSelectedAction} className="space-y-3">
      <input type="hidden" name="batchId" value={batchId} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs font-medium text-foreground">{t('reprocessSummary', { n: selected.size, total })}</span>
        <button type="button" onClick={selectAll} className="text-xs font-medium text-primary hover:underline">
          {t('reprocessSelectAll')}
        </button>
        <button type="button" onClick={clearAll} className="text-xs font-medium text-primary hover:underline">
          {t('reprocessClear')}
        </button>
      </div>
      <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
        {employees.map((e) => (
          <label key={e.employmentId} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="employmentIds"
              value={e.employmentId}
              checked={selected.has(e.employmentId)}
              onChange={() => toggle(e.employmentId)}
              className="size-4 rounded"
            />
            <EmployeeCode code={e.employeeCode} />
            {e.name}
          </label>
        ))}
        {employees.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">{t('reprocessNoEmployees')}</p>}
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-foreground">{t('reprocessReasonLabel')}</span>
        <textarea
          name="reason"
          rows={2}
          placeholder={t('reprocessReasonPlaceholder')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
        />
      </label>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={selected.size === 0}>
          {t('reprocessSelected')}
        </Button>
      </div>
    </form>
  );
}
