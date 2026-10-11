'use client';
import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
export function EmailSubmit({children,disabled,...props}:ComponentProps<typeof Button>){
 const {pending}=useFormStatus(),t=useTranslations('identityEmail');
 return <Button {...props} type="submit" disabled={disabled||pending} aria-busy={pending}>{pending?t('saving'):children}</Button>;
}
