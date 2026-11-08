'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';

/** One added control; the surrounding maintenance layout and save flow remain intact. */
export function CompanyApplicability({ companies, initialIds, canEdit }: {
  companies: { id: string; name: string }[];
  initialIds: string[] | null;
  canEdit: boolean;
}) {
  const t = useTranslations('payComponents.companyApplicability');
  const [mode, setMode] = useState(initialIds == null ? 'all' : 'selected');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialIds ?? []));
  const visible = companies.filter(company => company.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <fieldset className="space-y-1.5 sm:col-span-3"><legend className="text-sm font-medium">{t('label')}</legend>
    <select aria-label={t('label')} name={canEdit ? 'appliedCompanyMode' : undefined} value={mode} onChange={event => setMode(event.target.value)} disabled={!canEdit} className={inputCls}>
      <option value="all">{t('all')}</option><option value="selected">{t('selected')}</option>
    </select>
    {mode === 'selected' && <div className="mt-2 space-y-2">
      {canEdit && <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('search')} aria-label={t('search')} className={inputCls} />}
      {canEdit && [...selected].map(id => <input key={id} type="hidden" name="appliedCompanyIds" value={id} />)}
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border p-3">
        {visible.map(company => <label key={company.id} className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={selected.has(company.id)} disabled={!canEdit} onChange={event => {
            const checked = event.target.checked;
            setSelected(previous => { const next = new Set(previous); if (checked) next.add(company.id); else next.delete(company.id); return next; });
          }} />{company.name}
        </label>)}
        {!visible.length && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      </div>
      {canEdit && !selected.size && <p role="status" className="text-sm text-destructive">{t('required')}</p>}
    </div>}
    {!canEdit && <p className="mt-1 text-sm text-muted-foreground">{t('locked')}</p>}
  </fieldset>;
}
