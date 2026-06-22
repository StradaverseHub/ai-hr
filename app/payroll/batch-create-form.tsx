'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { createBatchAction } from './actions';

type Company = { id: string; name: string };
type Dept = { id: string; name: string; companyId: string };

/**
 * Create-batch form (ADR-0035 1E, #23) with optional department subset selection. The department
 * checkboxes follow the selected company; checking none ⇒ the whole company (today's behaviour).
 */
export function BatchCreateForm({
  companies,
  departments,
  thisMonth,
}: {
  companies: Company[];
  departments: Dept[];
  thisMonth: string;
}) {
  const t = useTranslations('payroll.list');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const depts = departments.filter((d) => d.companyId === companyId);

  return (
    <form action={createBatchAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
      <Field label={t('company')}>
        <select name="companyId" required value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('payPeriod')}>
        <input name="payPeriod" required placeholder="2026-05" defaultValue={thisMonth} pattern="[0-9]{4}-(0[1-9]|1[0-2])" title="YYYY-MM" className={inputCls} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" data-tour="payroll-create">
          {t('createBatch')}
        </Button>
      </div>

      {depts.length > 0 && (
        <div className="sm:col-span-4">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('scopeLabel')}</div>
          {/* key by company so checkboxes reset when the company changes */}
          <div key={companyId} className="flex flex-wrap gap-x-4 gap-y-1.5">
            {depts.map((d) => (
              <label key={d.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" name="departmentIds" value={d.id} className="size-4 rounded" />
                {d.name}
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('scopeHint')}</p>
        </div>
      )}
    </form>
  );
}
