'use client';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui';
export function ManualSubmit({children,...props}:ComponentProps<typeof Button>) {
 const {pending}=useFormStatus(),t=useTranslations('admin.users.manual');
 return <Button {...props} type="submit" disabled={props.disabled||pending} aria-busy={pending}>{pending?t('working'):children}</Button>;
}
