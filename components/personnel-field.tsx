'use client';
import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui';
import { personnelFormLabel, personnelFormRequired, type PersonnelFormMode } from '@/lib/personnel-form-contract';
/** The existing layout and children stay intact; presentation comes from the same descriptor as imports. */
export function PersonnelField({fieldId,mode='edit',...props}:Omit<ComponentProps<typeof Field>,'label'|'required'> & {fieldId:string;mode?:PersonnelFormMode}) {
  const t=useTranslations();
  return <Field {...props} label={personnelFormLabel(fieldId,(key,fallback)=>t.has(key)?t(key):fallback)} required={personnelFormRequired(fieldId,mode)} />;
}
