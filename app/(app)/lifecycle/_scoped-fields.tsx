'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Field, inputCls } from '@/components/ui';

export type ScopedCompany = { id: string; name: string };
export type ScopedField = { key: string; label: string; type: 'text' | 'longtext' | 'number' | 'date' | 'yesno' | 'choice'; required: boolean; options: string[]; companyIds: string[] };

/**
 * The company picker plus everything that depends on it: the access systems that company offers, and the
 * custom fields that apply to it. Choosing a company reveals ITS access options and extra fields (handover
 * brief 4.1) without a round trip. The server still validates both sets against the chosen company.
 */
export function ScopedFields({
  companies, systems, fields, defaultCompanyId, selectedSystems = [], values = {}, showSystems, lockCompany = false,
}: {
  companies: ScopedCompany[]; systems: Record<string, string[]>; fields: ScopedField[]; defaultCompanyId?: string;
  selectedSystems?: string[]; values?: Record<string, unknown>; showSystems: boolean; lockCompany?: boolean;
}) {
  const t = useTranslations('lifecycle');
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? companies[0]?.id ?? '');
  const offered = systems[companyId] ?? [];
  const applicable = fields.filter((f) => f.companyIds.length === 0 || f.companyIds.includes(companyId));
  return (
    <>
      <Field label={t('common.company')} required className="col-span-full sm:col-span-1">
        {lockCompany ? (
          <>
            <input type="hidden" name="companyId" value={companyId} />
            <input className={inputCls} value={companies.find((c) => c.id === companyId)?.name ?? ''} readOnly />
          </>
        ) : (
          <select name="companyId" required value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </Field>
      {showSystems && (
        <fieldset className="col-span-full">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('forms.accessSystems')}</legend>
          {offered.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('forms.noSystems')}</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {offered.map((sys) => (
                <label key={`${companyId}-${sys}`} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" name="accessSystems" value={sys} defaultChecked={selectedSystems.includes(sys)} className="size-4" />{sys}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      {applicable.map((f) => {
        const name = `cf_${f.key}`;
        const v = values[f.key];
        const dv = v == null ? '' : String(v);
        return (
          <Field key={`${companyId}-${f.key}`} label={f.label} required={f.required} className={f.type === 'longtext' ? 'col-span-full' : undefined}>
            {f.type === 'longtext' ? <textarea name={name} defaultValue={dv} rows={2} required={f.required} className={`${inputCls} h-auto py-2`} />
              : f.type === 'yesno' ? (
                <select name={name} defaultValue={dv} required={f.required} className={inputCls}><option value="" />
                  <option value="Yes">{t('common.yes')}</option><option value="No">{t('common.no')}</option></select>
              ) : f.type === 'choice' ? (
                <select name={name} defaultValue={dv} required={f.required} className={inputCls}><option value="" />{f.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              ) : <input name={name} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} defaultValue={dv} required={f.required} className={inputCls} />}
          </Field>
        );
      })}
    </>
  );
}
