'use client';

import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/** V3's UI vocabulary. Keep the workflow on its own controls instead of inheriting
 * the old lifecycle screens' density, shadows and rounded button/input metrics. */
export const inputCls = 'onb-input';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost' | 'link' | 'destructive';
  size?: 'default' | 'sm' | 'lg' | 'icon';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function OnboardingButton(
  { variant = 'default', size = 'default', className, type = 'button', ...props }, ref,
) {
  return <button ref={ref} type={type} data-onb-variant={variant} data-onb-size={size} className={cn('onb-button', className)} {...props} />;
});

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('onb-card', className)} {...props} />;
}

export function Field({ label, children, className, required, requiredAriaLabel }: {
  label: string; children: ReactNode; className?: string; required?: boolean; requiredAriaLabel?: string;
}) {
  return <label className={cn('onb-field', className)}><span>{label}{required && <span className="text-destructive" aria-label={requiredAriaLabel}> *</span>}</span>{children}</label>;
}

export function PageHeader({ title, description, actions, back }: {
  title: string; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string };
}) {
  return <header data-page-header className="onb-page-header">
    {back && <Link href={back.href}>← {back.label}</Link>}
    <div><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="onb-page-actions">{actions}</div>}</div>
  </header>;
}
