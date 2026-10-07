'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * r400 — Monolith's two button looks (docs/design/monolith/shell.css `.pill`, `.txt`; components.md):
 *   default      → `.pill`        ink fill, bone text, 44px, radius 999px — the ONE primary action
 *   secondary    → `.pill.ghost`  ink outline
 *   destructive  → `.pill.ghost` in signal-text (README §8: never an orange fill behind text)
 *   outline, ghost, link → `.txt` underlined text button (1px ink rule, signal-text on hover)
 * Every class is `monolith:`-scoped, so it does not match in Classic at all.
 */
const MONO_PILL_BASE = ' monolith:rounded-full monolith:border monolith:text-[14px] monolith:font-semibold';
const MONO_PILL = `${MONO_PILL_BASE} monolith:border-ink monolith:bg-ink monolith:text-bone monolith:hover:bg-ink/85`;
const MONO_PILL_GHOST = `${MONO_PILL_BASE} monolith:border-ink monolith:bg-transparent monolith:text-ink monolith:hover:bg-pressed`;
const MONO_PILL_DESTRUCTIVE = `${MONO_PILL_BASE} monolith:border-signal-text monolith:bg-transparent monolith:text-signal-text monolith:hover:bg-pressed`;
const MONO_TXT =
  ' monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-ink monolith:bg-transparent monolith:text-[15px] monolith:font-medium monolith:text-ink monolith:no-underline monolith:hover:border-signal-text monolith:hover:bg-transparent monolith:hover:text-signal-text monolith:hover:no-underline';
const PILLS = ['default', 'secondary', 'destructive'] as const;
const TXTS = ['outline', 'ghost', 'link'] as const;

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition duration-150 ease-snappy active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50' +
    // r400 — Monolith (docs/design/monolith README §4): `.pill` / `.txt`. Appended, never edited in: Classic's string
    // above is byte-identical to main's (test/r400-monolith-primitives.test.ts). The theme's own :focus-visible
    // outline (app/globals.css) is the focus mark, so the Classic ring is switched off under Monolith only.
    ' monolith:active:scale-100 monolith:focus-visible:ring-0 monolith:focus-visible:ring-offset-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90' + MONO_PILL,
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90' + MONO_PILL_DESTRUCTIVE,
        outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground' + MONO_TXT,
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80' + MONO_PILL_GHOST,
        ghost: 'hover:bg-accent hover:text-accent-foreground' + MONO_TXT,
        link: 'text-primary underline-offset-4 hover:underline' + MONO_TXT,
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'size-9',
      },
    },
    // r400 — Monolith geometry per (look, size). Compound classes come after the size's in cva's output, so
    // tailwind-merge keeps these over any same-property monolith: class. Classic sizes carry no monolith: class.
    compoundVariants: [
      { variant: PILLS, size: ['default', 'lg'], class: 'monolith:h-11 monolith:px-5' },
      { variant: PILLS, size: 'sm', class: 'monolith:h-9 monolith:px-4 monolith:text-[13px]' },
      { variant: TXTS, size: ['default', 'lg'], class: 'monolith:h-auto monolith:min-h-11 monolith:px-0.5' },
      { variant: TXTS, size: 'sm', class: 'monolith:h-auto monolith:min-h-8 monolith:px-0.5 monolith:text-[13px]' },
      // An icon-only button is not a text link: no underline, a pressed wash on hover instead.
      { variant: TXTS, size: 'icon', class: 'monolith:border-b-0 monolith:hover:bg-pressed' },
    ],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
