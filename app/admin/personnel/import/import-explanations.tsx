'use client';
import {useTranslations} from 'next-intl';
import {personnelImportExclusionEntries,type PersonnelImportChoice} from '@/lib/personnel-import-exclusions';

export function ImportExplanations({choice}:{choice:PersonnelImportChoice}){
  const t=useTranslations('people.import');
  const labels=useTranslations();
  const entries=personnelImportExclusionEntries(choice,(key,fallback)=>labels.has(key)?labels(key):fallback);
  if(!entries.length)return null;
  const tabs=[...new Set(entries.map(entry=>entry.tab))];
  return <details className="rounded-lg border border-border p-4 text-sm">
    <summary className="cursor-pointer font-medium">{t('exclusionsTitle')}</summary>
    <p className="mt-2 text-xs text-muted-foreground">{t('exclusionsHint')}</p>
    <div className="mt-3 space-y-2">
      {tabs.map(tab=><details key={tab} className="border-t border-border pt-2">
        <summary className="cursor-pointer font-medium">{tab}</summary>
        <dl className="mt-2 space-y-3">
          {entries.filter(entry=>entry.tab===tab).map(entry=><div key={entry.id} data-personnel-exclusion={entry.id}>
            <dt className="text-xs font-medium">{entry.label}</dt>
            <dd className="mt-0.5 text-xs text-muted-foreground">{entry.reason}</dd>
          </div>)}
        </dl>
      </details>)}
    </div>
  </details>;
}
