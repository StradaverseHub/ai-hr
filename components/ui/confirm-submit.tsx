'use client';

import * as React from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button, type ButtonProps } from './button';

type Props = {
  children: React.ReactNode;
  title?: string;
  description?: string;
  confirmLabel?: string;
} & Omit<ButtonProps, 'type'>;

/**
 * A destructive-action button that opens a confirmation dialog and, on confirm, submits its
 * enclosing <form> (server action). Drop in place of a submit button inside the form.
 */
export function ConfirmSubmit({
  children,
  title = 'Are you sure?',
  description,
  confirmLabel = 'Confirm',
  variant = 'destructive',
  ...props
}: Props) {
  const ref = React.useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button ref={ref} type="button" variant={variant} {...props}>
          {children}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" size="sm">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                variant={variant}
                size="sm"
                onClick={() => ref.current?.closest('form')?.requestSubmit()}
              >
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
