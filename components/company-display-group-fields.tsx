'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';
import { companyDisplayGroupFields, type CompanyDisplayGroup, type CompanyDisplayGroupOption } from '@/lib/company-display-group';

export function CompanyDisplayGroupFields({ options, saved, children }: {
  options: readonly CompanyDisplayGroupOption[];
  saved?: CompanyDisplayGroup | null;
  children?: React.ReactNode;
}) {
  const t = useTranslations('admin.organization');
  const [method, setMethod] = useState(saved ? 'field' : 'parent');
  const [field, setField] = useState(saved?.field ?? '');
  const [id, setId] = useState(saved?.id ?? '');
  const values = options.filter(option => option.field === field);

  return <>
    <Field label={t('displayGrouping.method')}>
      <select name="displayGroupingMethod" value={method} onChange={e => setMethod(e.target.value)} className={inputCls}>
        <option value="parent">{t('parentCompany')}</option>
        <option value="field">{t('displayGrouping.byField')}</option>
      </select>
    </Field>
    {method === 'parent' ? children : <>
      <Field label={t('displayGrouping.field')}>
        <select name="displayGroupField" value={field} required className={inputCls} onChange={e => {
          setField(e.target.value as typeof field);
          setId('');
        }}>
          <option value="">—</option>
          {companyDisplayGroupFields.filter(key => saved?.field === key || options.some(row => row.field === key))
            .map(key => <option key={key} value={key}>{t(`displayGrouping.fields.${key}`)}</option>)}
        </select>
      </Field>
      <Field label={t('displayGrouping.value')}>
        <select name="displayGroupOptionId" value={id} required className={inputCls} onChange={e => setId(e.target.value)}>
          <option value="">—</option>
          {id && !values.some(row => row.id === id) && <option value={id}>{t('displayGrouping.unavailable')}</option>}
          {values.map(option => <option key={option.id} value={option.id}>
            {option.code === option.label ? option.label : `${option.code} – ${option.label}`}
          </option>)}
        </select>
      </Field>
    </>}
  </>;
}
