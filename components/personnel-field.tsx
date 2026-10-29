'use client';
import type { ComponentProps } from 'react';
import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui';
import { personnelFormLabel, personnelFormRequired, type PersonnelFormContext, type PersonnelFormMode } from '@/lib/personnel-form-contract';
/** The existing layout and children stay intact; presentation comes from the same descriptor as imports. */
/** `labelKey` names a category-specific caption for the same field (b6dbadc5: the Top-up rate boxes). */
export function PersonnelField({fieldId,mode='edit',context,labelKey,...props}:Omit<ComponentProps<typeof Field>,'label'|'required'> & {fieldId:string;mode?:PersonnelFormMode;context?:PersonnelFormContext;labelKey?:string}) {
  const t=useTranslations();
  const label=labelKey&&t.has(labelKey)?t(labelKey):personnelFormLabel(fieldId,(key,fallback)=>t.has(key)?t(key):fallback);
  return <Field {...props} requiredAriaLabel={props.requiredAriaLabel ?? t('people.detail.requiredField')} label={label} required={personnelFormRequired(fieldId,mode,context)} />;
}
