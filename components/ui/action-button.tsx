'use client';

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { useFormStatus } from 'react-dom';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { pendingLabel?: string };

/** Native button styling, with the same feedback as Button for React form actions. */
export const ActionButton = forwardRef<HTMLButtonElement, Props>(function ActionButton(
  { children, disabled, pendingLabel, 'aria-busy': explicitBusy, ...props }, ref,
) {
  const form = useFormStatus();
  const formPending = props.type !== 'button' && props.type !== 'reset' && form.pending;
  const pending = formPending || explicitBusy === true || explicitBusy === 'true';
  return <button {...props} ref={ref} disabled={disabled || formPending}
    aria-busy={pending || explicitBusy} data-action-pending={pending || undefined}>
    {pending && pendingLabel ? pendingLabel : children}
  </button>;
});
