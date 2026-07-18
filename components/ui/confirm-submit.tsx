'use client';

import * as React from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslations } from 'next-intl';
import { Button, type ButtonProps } from './button';

/** An optional free-text field rendered inside the confirm dialog (e.g. a "reason" for a reset). The
 *  value is mirrored into a hidden input that lives INSIDE the enclosing <form> (the dialog body itself
 *  renders in a Portal outside the form, so it can't post directly), so it reaches the server action. */
export type ReasonField = {
  name: string;
  label: string;
  placeholder?: string;
  /** When true, Confirm stays disabled until the field is non-empty. */
  required?: boolean;
};

type Props = {
  children: React.ReactNode;
  title?: string;
  description?: string;
  confirmLabel?: string;
  reasonField?: ReasonField;
} & Omit<ButtonProps, 'type'>;

/**
 * A destructive-action button that opens a confirmation dialog and, on confirm, submits its
 * enclosing <form> (server action). Drop in place of a submit button inside the form.
 *
 * Pass `reasonField` to collect a short free-text reason inside the dialog — the value posts under
 * `reasonField.name` via a hidden input kept in the form (the dialog content is portalled out of it).
 */
export function ConfirmSubmit({
  children,
  title,
  description,
  confirmLabel,
  reasonField,
  variant = 'destructive',
  ...props
}: Props) {
  const t = useTranslations('components.confirmSubmit');
  const resolvedTitle = title ?? t('title');
  const resolvedConfirmLabel = confirmLabel ?? t('confirm');
  const ref = React.useRef<HTMLButtonElement>(null);
  const [reason, setReason] = React.useState('');
  const confirmDisabled = !!reasonField?.required && reason.trim().length === 0;
  return (
    <AlertDialog.Root onOpenChange={(open) => { if (!open) setReason(''); }}>
      {/* Hidden mirror lives inside the enclosing <form> (unlike the portalled textarea) so the reason
          is included in the submitted FormData. */}
      {reasonField ? <input type="hidden" name={reasonField.name} value={reason} /> : null}
      <AlertDialog.Trigger asChild>
        <Button ref={ref} type="button" variant={variant} {...props}>
          {children}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <AlertDialog.Title className="text-base font-semibold">{resolvedTitle}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          ) : null}
          {reasonField ? (
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-foreground">{reasonField.label}</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonField.placeholder}
                rows={3}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring dark:bg-input/30"
              />
            </label>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" size="sm">
                {t('cancel')}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                type="button"
                variant={variant}
                size="sm"
                disabled={confirmDisabled}
                onClick={() => ref.current?.closest('form')?.requestSubmit()}
              >
                {resolvedConfirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * A CONTROLLED confirmation dialog for imperative flows (no enclosing <form>) — e.g. the Profile Options
 * grid's row delete, which calls a value-returning server action directly rather than submitting a form.
 * Render it conditionally; `onConfirm` runs the action, `onCancel` closes it.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  variant = 'destructive',
  onConfirm,
  onCancel,
}: {
  title?: string;
  description?: string;
  confirmLabel?: string;
  variant?: ButtonProps['variant'];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('components.confirmSubmit');
  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <AlertDialog.Title className="text-base font-semibold">{title ?? t('title')}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">{description}</AlertDialog.Description>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" size="sm">
                {t('cancel')}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button type="button" variant={variant} size="sm" onClick={onConfirm}>
                {confirmLabel ?? t('confirm')}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
