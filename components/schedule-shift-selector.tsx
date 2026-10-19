'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnGhost, inputCls } from '@/components/ui';

export type ScheduleShiftChoice = {
  id: string;
  name: string;
  code: string | null;
  detail?: string;
  archived?: boolean;
  available?: boolean;
};

/** Search filters presentation only: successful controls always retain the complete selected set. */
export function ScheduleShiftSelector({ id: explicitId, choices, selectedIds, initialSelectedIds = [], onChange }: {
  id?: string;
  choices: readonly ScheduleShiftChoice[];
  selectedIds?: readonly string[];
  initialSelectedIds?: readonly string[];
  onChange?: (ids: string[]) => void;
}) {
  const t = useTranslations('scheduleShiftSelection');
  const generatedId = useId();
  const id = explicitId ?? generatedId;
  const [query, setQuery] = useState('');
  const [localIds, setLocalIds] = useState<string[]>([...initialSelectedIds]);
  const selected = selectedIds ?? localIds;
  const active = choices.filter(choice => !choice.archived && choice.available !== false);
  const needle = query.trim().toLocaleLowerCase();
  const matching = active.filter(choice => `${choice.code ?? ''} ${choice.name}`.toLocaleLowerCase().includes(needle));
  const historical = choices.filter(choice => (choice.archived || choice.available === false) && selected.includes(choice.id));
  const activeCount = active.filter(choice => selected.includes(choice.id)).length;
  const allMatchingSelected = matching.every(choice => selected.includes(choice.id));
  function change(ids: string[]) {
    // Previously selected unavailable references may be removed, never introduced or reintroduced.
    const next = [...new Set(ids)].filter(value => choices.some(choice => choice.id === value &&
      ((!choice.archived && choice.available !== false) || selected.includes(value))));
    setLocalIds(next);
    onChange?.(next);
  }
  return <div className="space-y-3">
    {selected.map(value => <input key={value} type="hidden" name="allowedShiftIds" value={value} />)}
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={`${id}-search`} className="min-w-0 flex-1 space-y-1 text-sm">
        <span className="block font-medium">{t('search')}</span>
        <input id={`${id}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)}
          placeholder={t('placeholder')} className={inputCls} aria-controls={`${id}-options`} />
      </label>
      <p role="status" className="pb-2 text-sm tabular-nums text-muted-foreground">{t('count', { selected: activeCount, total: active.length })}</p>
      <button type="button" className={`${btnGhost} focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50`} disabled={!matching.length || allMatchingSelected}
        onClick={() => change([...selected, ...matching.map(choice => choice.id)])}>{t('selectMatching')}</button>
      <button type="button" className={`${btnGhost} focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50`} disabled={!activeCount}
        onClick={() => change(selected.filter(value => !active.some(choice => choice.id === value)))}>{t('clearActive')}</button>
    </div>
    <div id={`${id}-options`} className="max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" role="group" tabIndex={0} aria-label={t('activeShifts')} >
      {matching.length ? <ul className="divide-y divide-border">{matching.map(choice => <li key={choice.id}>
        <label className="flex cursor-pointer items-start gap-3 px-3 py-3 text-sm hover:bg-muted/50 has-[:checked]:bg-primary/10">
          <input type="checkbox" value={choice.id} checked={selected.includes(choice.id)} className="mt-0.5 accent-primary"
            onChange={event => change(event.target.checked ? [...selected, choice.id] : selected.filter(value => value !== choice.id))} />
          <span className="min-w-0 break-words"><span className="font-medium">{choice.code ? `${choice.code} · ` : ''}{choice.name}</span>
            {choice.detail && <span className="mt-0.5 block text-xs text-muted-foreground">{choice.detail}</span>}</span>
        </label>
      </li>)}</ul> : <p className="p-4 text-sm text-muted-foreground">{active.length ? t('noMatches') : t('noActive')}</p>}
    </div>
    {historical.length > 0 && <section aria-label={t('historical')} className="space-y-2">
      <h3 className="text-sm font-medium">{t('historical')}</h3>
      <p className="text-xs text-muted-foreground">{t('historicalHelp')}</p>
      <ul className="space-y-2">{historical.map(choice => <li key={choice.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">{choice.code ? `${choice.code} · ` : ''}{choice.name}</span>
        <button type="button" className={`${btnGhost} focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50`} aria-label={t('removeNamed', { name: choice.name })}
          onClick={() => change(selected.filter(value => value !== choice.id))}>{t('remove')}</button>
      </li>)}</ul>
    </section>}
  </div>;
}
