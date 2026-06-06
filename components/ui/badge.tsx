import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize', {
  variants: {
    variant: {
      default: 'bg-secondary text-secondary-foreground',
      success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
      warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
      danger: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
      info: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
      accent: 'bg-primary/10 text-primary',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
