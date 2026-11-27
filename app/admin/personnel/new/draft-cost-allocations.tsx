'use client';

/**
 * Board 2c1b2fba — EMPLOYMENT › COST CENTER ALLOCATION ON A DRAFT.
 *
 * The activated record's allocation set (components/personnel/cost-center-allocations.tsx), less the
 * parts that only make sense once an employment has a history: one or more cost centres with a
 * percentage, each cost centre once, no more than 100% in total, and the running Total / Unallocated line
 * the record shows. The same Personnel field descriptors (`employment.cost_center_allocation.*`) give the
 * captions, and the SAME parser (`percentageHundredths`, lib/employment-cost-allocation.ts) judges a box,
 * so a percentage this screen accepts is one `saveEmploymentCostAllocations` will accept at Activate.
 *
 * THERE IS NO EFFECTIVE DATE BOX: the set takes effect from the Group Join Date, the day the employment
 * starts, and the line under the rows says so.
 *
 * CONTROLLED BY THE WIZARD: `rows` is `draftCostAllocations(data)`, which reads a legacy single
 * `employment.costCenterId` as one row at 100%, so an older draft shows what it holds. Nothing is written
 * until HR changes a row; the whole list is then written to `data.costAllocations` and lands on Save.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, SectionHeader, inputCls } from '@/components/ui';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelDisplay, personnelInput } from '@/lib/personnel-form-contract';
import { formatAllocationPercent, percentageHundredths } from '@/lib/employment-cost-allocation';
import { DRAFT_LIST_LIMITS, type EmployeeDraftCostAllocation } from '@/lib/employee-draft-schema';
import { newRowKey } from './draft-register';

type Choice = { id: string; label: string };

/** The record's client check, on the draft's rows: the running total in hundredths, and which rule (if any)
 *  the rows break. A blank row is not an error until it has a value — the list still names it. */
export function allocationState(rows: EmployeeDraftCostAllocation[]) {
  let total = 0;
  let invalid = false;
  for (const r of rows) {
    if (!(r.percentage ?? '').trim()) continue;
    try {
      total += percentageHundredths(r.percentage ?? '');
    } catch {
      invalid = true;
    }
  }
  const ids = rows.map((r) => (r.costCenterId ?? '').trim()).filter(Boolean);
  const duplicate = new Set(ids).size !== ids.length;
  return { total, error: total > 10000 ? 'total' : invalid ? 'invalid' : duplicate ? 'duplicate' : null } as const;
}

export function DraftCostAllocations({
  title,
  rows,
  onChange,
  choices,
  allCostCenters,
  emptyNote,
}: {
  /** `people.wizard.sections.costCenterAllocation`, pinned equal to `costAllocations.title`. */
  title: string;
  rows: EmployeeDraftCostAllocation[];
  /** Receives the WHOLE list — replaced, never merged. */
  onChange: (next: EmployeeDraftCostAllocation[]) => void;
  /** The cost centres the draft's company may use (the existing `hireOptionVisible` filter). */
  choices: Choice[];
  /** Every cost centre the reader can see — only to NAME a stored one the company no longer offers. */
  allCostCenters: Choice[];
  /** The d61f0ff2 zero-visible-options note, when the company may use none of the cost centres. */
  emptyNote?: ReactNode;
}) {
  const t = useTranslations('costAllocations');
  const tWizard = useTranslations('people.wizard');
  const { total, error } = allocationState(rows);
  const update = (at: number, patch: Partial<EmployeeDraftCostAllocation>) =>
    onChange(rows.map((r, i) => (i === at ? { ...r, ...patch } : r)));

  return (
    <Card className="overflow-hidden" data-draft-cost-allocations>
      <SectionHeader title={title} />
      <div className="space-y-3 p-4">
        {rows.map((row, index) => {
          const id = (row.costCenterId ?? '').trim();
          const stale = id !== '' && !choices.some((c) => c.id === id);
          return (
            <div key={row.key ?? index} className="flex flex-wrap items-end gap-3" data-allocation-row>
              <div className="min-w-56 flex-1">
                <PersonnelField fieldId="employment.cost_center_allocation.cost_center_id" mode="draft">
                  <select {...personnelControl('employment.cost_center_allocation.cost_center_id', 'draft')}
                    aria-label={`${t('costCenter')} ${index + 1}`}
                    className={inputCls} value={id} onChange={(e) => update(index, { costCenterId: e.target.value })}>
                    <option value="">{t('choose')}</option>
                    {stale && (
                      <option value={id}>{allCostCenters.find((c) => c.id === id)?.label ?? t('unavailable')}</option>
                    )}
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </select>
                </PersonnelField>
              </div>
              <div className="w-36">
                <PersonnelField fieldId="employment.cost_center_allocation.percentage" mode="draft">
                  <input {...personnelInput('employment.cost_center_allocation.percentage', 'draft')}
                    aria-label={`${t('percentage')} ${index + 1}`} inputMode="decimal" className={inputCls}
                    value={row.percentage ?? ''} onChange={(e) => update(index, { percentage: e.target.value })} />
                </PersonnelField>
              </div>
              <Button type="button" variant="ghost" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                {t('remove')}
              </Button>
            </div>
          );
        })}
        {emptyNote}
        <Button type="button" variant="outline" disabled={rows.length >= DRAFT_LIST_LIMITS.costAllocations}
          onClick={() => onChange([...rows, { key: newRowKey(rows.length), costCenterId: '', percentage: '' }])}>
          {t('add')}
        </Button>
        <div className="flex flex-wrap gap-6 rounded-md border p-3 text-sm" role="status">
          <span {...personnelDisplay('employment.cost_center_allocation.total_percentage')}>
            {t('total', { value: formatAllocationPercent(total) })}
          </span>
          <span {...personnelDisplay('employment.cost_center_allocation.unallocated_percentage')} className="text-muted-foreground">
            {t('remainder', { value: formatAllocationPercent(Math.max(0, 10000 - total)) })}
          </span>
        </div>
        {error === 'total' && <p role="alert" className="text-sm text-destructive">{t('errors.total')}</p>}
        {error === 'invalid' && <p role="alert" className="text-sm text-destructive">{t('errors.invalid')}</p>}
        {error === 'duplicate' && <p role="alert" className="text-sm text-destructive">{t('errors.duplicate')}</p>}
        <p className="text-xs text-muted-foreground">{tWizard('hints.costAllocationEffective')}</p>
      </div>
    </Card>
  );
}
