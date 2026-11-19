'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Field, inputCls } from '@/components/ui';
import { personnelFormChoices, personnelFormLabel, personnelWorkflowControl, personnelWorkflowInput } from '@/lib/personnel-form-contract';
import { MOVEMENT_FORM_IDS } from '@/lib/movement-form-contract';
import { DateField } from '@/components/ui/date-field';
import type { HistoryValues } from '@/core/movement-history';
import type { MovementOrgScope, MovementOption } from './movement-new-event';
import type { MovementPageContext } from '@/lib/personnel-movement-navigation';
import { saveMovementPageAction } from './actions';

export function HistoryMovementEditForm({
  employmentId, movementId, revisionId, before, effectiveDate, remarks, companies, orgByCompany,
  selectedCompanyId, fallbackOrganisation, cancelHref, context,
}: {
  employmentId: string;
  movementId: string;
  revisionId: string;
  before: HistoryValues;
  effectiveDate: string;
  remarks?: string | null;
  companies: MovementOption[];
  orgByCompany: Record<string, MovementOrgScope>;
  selectedCompanyId: string;
  fallbackOrganisation: MovementOrgScope;
  cancelHref: string;
  context: MovementPageContext;
}) {
  const t = useTranslations('people.detail.movement');
  const root = useTranslations();
  const [error, action, pending] = useActionState(saveMovementPageAction, null);
  const [companyId, setCompanyId] = useState(before.companyId ?? '');
  const [organisation, setOrganisation] = useState<HistoryValues>(before);
  const scope = orgByCompany[companyId || selectedCompanyId] ?? fallbackOrganisation;
  const fields = [
    ['departmentId', t('field.department'), scope.departments],
    ['businessUnitId', t('field.businessUnit'), scope.businessUnits],
    ['positionId', t('field.position'), scope.positions],
    ['locationId', t('hireCorrection.fieldLocation'), scope.locations],
    ['employmentType', personnelFormLabel(MOVEMENT_FORM_IDS.employmentType,(key,fallback)=>root.has(key)?root(key):fallback),
      personnelFormChoices(MOVEMENT_FORM_IDS.employmentType).map(choice=>({id:choice.value,name:root(choice.labelKey)}))],
  ] as const;
  return (
    <form action={action} className="space-y-4 p-4" aria-busy={pending}>
      <input type="hidden" name="movementPage" value="edit" />
      <input type="hidden" name="historyEdit" value="1" />
      <input type="hidden" name="employmentId" value={employmentId} />
      <input type="hidden" name="movementId" value={movementId} />
      <input type="hidden" name="revisionId" value={revisionId} />
      <input type="hidden" name="from" value={context.from ?? ''} />
      <input type="hidden" name="showCorrected" value={context.showCorrected ?? ''} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">{t('form.recordHistory')}</p>
      <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span>{t('columns.effectiveDate')}</span>
          <DateField {...personnelWorkflowControl(MOVEMENT_FORM_IDS.effectiveDate, 'movement', 'record')} defaultValue={effectiveDate}
            label={t('columns.effectiveDate')} className={inputCls} />
        </label>
        <Field label={t('field.company')}>
          <select name="history.companyId" className={inputCls} value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setOrganisation((existing) => ({ employmentType: existing.employmentType }));
            }}>
            <option value="">{t('form.historyUnchanged')}</option>
            {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </Field>
        {fields.map(([field, label, options]) => (
          <Field key={field} label={label}>
            <select name={`history.${field}`} className={inputCls}
              value={organisation[field] === null ? '__clear__' : organisation[field] ?? ''}
              onChange={(event) => setOrganisation((current) => ({
                ...current, [field]: event.target.value === '__clear__' ? null : event.target.value,
              }))}>
              <option value="">{t('form.historyUnchanged')}</option>
              {field !== 'departmentId' && field !== 'employmentType' && <option value="__clear__">{t('form.none')}</option>}
              {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </Field>
        ))}
        <label className="space-y-1 text-sm"><span>{t('columns.remarks')}</span>
          <input {...personnelWorkflowInput(MOVEMENT_FORM_IDS.remarks, 'movement', 'edit')} maxLength={200} defaultValue={remarks ?? ''} className={inputCls} />
        </label>
        <label className="space-y-1 text-sm"><span>{t('correctionReasonLabel')}</span>
          <input {...personnelWorkflowInput(MOVEMENT_FORM_IDS.reason, 'movement', 'record')} maxLength={200} className={inputCls} />
        </label>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button asChild variant="outline"><Link href={cancelHref}>{t('form.cancel')}</Link></Button>
        <Button type="submit" disabled={pending}>{t('form.saveCorrection')}</Button>
      </div>
    </form>
  );
}
