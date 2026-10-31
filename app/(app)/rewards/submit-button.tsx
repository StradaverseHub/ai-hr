'use client';
import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui';
export function RewardSubmit({ children, disabled, ...props }: ComponentProps<typeof Button>) {
  const { pending } = useFormStatus(); const t = useTranslations('rewards');
  return <Button {...props} type="submit" disabled={disabled || pending} aria-busy={pending}>{pending ? t('saving') : children}</Button>;
}
