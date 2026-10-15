'use client';
import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui';
import { personnelFormLabel, personnelFormRequired, type PersonnelFormContext, type PersonnelFormMode } from '@/lib/personnel-form-contract';
/** The existing layout and children stay intact; presentation comes from the same descriptor as imports. */
export function PersonnelField({fieldId,mode='edit',context,...props}:Omit<ComponentProps<typeof Field>,'label'|'required'> & {fieldId:string;mode?:PersonnelFormMode;context?:PersonnelFormContext}) {
  const t=useTranslations();
  return <Field {...props} requiredAriaLabel={props.requiredAriaLabel ?? t('people.detail.requiredField')} label={personnelFormLabel(fieldId,(key,fallback)=>t.has(key)?t(key):fallback)} required={personnelFormRequired(fieldId,mode,context)} />;
}
