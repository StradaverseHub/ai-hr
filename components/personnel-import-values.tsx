'use client';
import {useTranslations} from 'next-intl';
import {personnelColumnLabel,personnelImportField,personnelFieldChoices,type PersonnelImportSheet} from '@/lib/personnel-import-contract';
export function PersonnelImportValues({values,sheet}:{values?:{column:string;value:string}[];sheet:PersonnelImportSheet}) {
  const labels=useTranslations();const t=useTranslations('people.import');
  if(!values?.length)return null;
  return <details className="mt-1 max-w-3xl text-xs font-normal"><summary className="cursor-pointer text-primary">{t('proposedValues')}</summary><dl className="mt-2 space-y-1">
    {values.map(({column,value})=>{
      const field=personnelImportField(column,sheet);const option=field?personnelFieldChoices(field).find(option=>option.value===value):undefined;
      const shown=option && labels.has(option.labelKey)?labels(option.labelKey):value;
      return <div key={column} className="flex flex-wrap gap-x-4 gap-y-1"><dt className="min-w-0 basis-40 grow break-words text-muted-foreground">{personnelColumnLabel(column,sheet,(key,fallback)=>labels.has(key)?labels(key):fallback)}</dt><dd className="min-w-0 basis-64 grow break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{shown}</dd></div>;
    })}
  </dl></details>;
}
