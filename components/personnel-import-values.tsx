'use client';
import {useTranslations} from 'next-intl';
import {personnelColumnLabel,personnelImportField,personnelFieldChoices,type PersonnelImportSheet} from '@/lib/personnel-import-contract';
export function PersonnelImportValues({values,sheet}:{values?:{column:string;value:string}[];sheet:PersonnelImportSheet}) {
  const labels=useTranslations();const t=useTranslations('people.import');
  if(!values?.length)return null;
  return <details className="mt-1 max-w-sm text-xs font-normal"><summary className="cursor-pointer text-primary">{t('proposedValues')}</summary><dl className="mt-2 space-y-1">
    {values.map(({column,value})=>{
      const field=personnelImportField(column,sheet);const option=field?personnelFieldChoices(field).find(option=>option.value===value):undefined;
      const shown=option && labels.has(option.labelKey)?labels(option.labelKey):value;
      return <div key={column} className="grid grid-cols-2 gap-2"><dt className="text-muted-foreground">{personnelColumnLabel(column,sheet,(key,fallback)=>labels.has(key)?labels(key):fallback)}</dt><dd className="break-words whitespace-pre-wrap">{shown}</dd></div>;
    })}
  </dl></details>;
}
