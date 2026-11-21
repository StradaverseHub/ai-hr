'use client';

import { useTranslations } from 'next-intl';
import { DateField } from '@/components/ui/date-field';
import { inputCls } from '@/components/ui';
import { MOVEMENT_FORM_IDS, movementHistoryDateFields } from '@/lib/movement-form-contract';
import { personnelFormLabel } from '@/lib/personnel-form-contract';
import type { HistoryDateFacts } from '@/core/movement-history';

export function HistoryMovementDateFields({ behaviour, dates }: { behaviour: string; dates?: HistoryDateFacts }) {
  const t = useTranslations();
  const before = t('people.detail.movement.detail.beforeChanges');
  const after = t('people.detail.movement.detail.afterChanges');
  return (
    <fieldset className="space-y-3 sm:col-span-2">
      <legend className="mb-2 text-sm font-medium">{t('people.detail.employmentInfo.datesGroup')}</legend>
      {movementHistoryDateFields(behaviour).map(field => {
        const label = personnelFormLabel(MOVEMENT_FORM_IDS[field], (key, fallback) => t.has(key) ? t(key) : fallback);
        return (
          <div key={field} className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{label} · {before}</span>
              <DateField className={inputCls} label={`${label} · ${before}`}
                name={`historyDate.before.${field}`} defaultValue={dates?.[field]?.before} />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>{label} · {after}</span>
              <DateField className={inputCls} label={`${label} · ${after}`}
                name={`historyDate.after.${field}`} defaultValue={dates?.[field]?.after} />
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
