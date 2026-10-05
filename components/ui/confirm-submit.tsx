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

/** Feedback f1701466 — opt-in two-step confirmation. Step 1 shows title/subtitle/description with
 *  No / Yes; Yes ADVANCES to step 2 (it must never close the dialog), which shows `warning`, a mandatory
 *  checkbox list under `reasonLegend`, and the final Confirm (disabled until ≥1 box is ticked). Each
 *  checked value is mirrored as a hidden input `name` INSIDE the enclosing <form> (same Portal caveat as
 *  `reasonField`), so the server action reads them via formData.getAll(name). */
export type TwoStep = {
  warning: string;
  reasonLegend: string;
  reasonOptions: { value: string; label: string }[];
  name: string;
  yesLabel: string;
  noLabel: string;
};

type Props = {
  children: React.ReactNode;
  title?: string;
  /** Optional line between title and description (e.g. "Leave Year 2027" — WHICH record is targeted). */
  subtitle?: string;
  description?: string;
  confirmLabel?: string;
  reasonField?: ReasonField;
  twoStep?: TwoStep;
} & Omit<ButtonProps, 'type'>;

/**
 * A destructive-action button that opens a confirmation dialog and, on confirm, submits its
 * enclosing <form> (server action). Drop in place of a submit button inside the form.
 *
 * Pass `reasonField` to collect a short free-text reason inside the dialog — the value posts under
 * `reasonField.name` via a hidden input kept in the form (the dialog content is portalled out of it).
 *
 * Pass `twoStep` for the Yes/No → reason-checkboxes → Confirm flow (f1701466). Backward-compatible:
 * without it the dialog behaves exactly as before.
 */
export function ConfirmSubmit({
  children,
  title,
  subtitle,
  description,
  confirmLabel,
  reasonField,
  twoStep,
  variant = 'destructive',
  ...props
}: Props) {
  const t = useTranslations('components.confirmSubmit');
  const resolvedTitle = title ?? t('title');
  const resolvedConfirmLabel = confirmLabel ?? t('confirm');
  const ref = React.useRef<HTMLButtonElement>(null);
  const [reason, setReason] = React.useState('');
  const [step, setStep] = React.useState<1 | 2>(1);
  const [checked, setChecked] = React.useState<string[]>([]);
  const onStep2 = !!twoStep && step === 2;
  const confirmDisabled =
    (!!reasonField?.required && reason.trim().length === 0) || (!!twoStep && checked.length === 0);
  return (
    <AlertDialog.Root
      onOpenChange={(open) => {
        if (!open) {
          setReason('');
          setStep(1);
          setChecked([]);
        }
      }}
    >
      {/* Hidden mirrors live inside the enclosing <form> (unlike the portalled dialog body) so the
          reason text / checked reason codes are included in the submitted FormData. */}
      {reasonField ? <input type="hidden" name={reasonField.name} value={reason} /> : null}
      {twoStep
        ? checked.map((v) => <input key={v} type="hidden" name={twoStep.name} value={v} />)
        : null}
      <AlertDialog.Trigger asChild>
        <Button ref={ref} type="button" variant={variant} {...props}>
          {children}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <AlertDialog.Title className="text-base font-semibold">{resolvedTitle}</AlertDialog.Title>
          {subtitle ? <p className="mt-1 text-sm font-medium text-foreground">{subtitle}</p> : null}
          {description && !onStep2 ? (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">
              {description}
            </AlertDialog.Description>
          ) : null}
          {onStep2 ? (
            <>
              <p className="mt-1.5 text-sm text-muted-foreground">{twoStep.warning}</p>
              <fieldset className="mt-4">
                <legend className="mb-1 block text-xs font-medium text-foreground">
                  {twoStep.reasonLegend}
                </legend>
                {twoStep.reasonOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 py-1 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="size-4 rounded"
                      checked={checked.includes(opt.value)}
                      onChange={(e) =>
                        setChecked((prev) =>
                          e.target.checked ? [...prev, opt.value] : prev.filter((v) => v !== opt.value),
                        )
                      }
                    />
                    {opt.label}
                  </label>
                ))}
              </fieldset>
            </>
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
                {twoStep && !onStep2 ? twoStep.noLabel : t('cancel')}
              </Button>
            </AlertDialog.Cancel>
            {twoStep && !onStep2 ? (
              /* Step-1 "Yes" ADVANCES the dialog — deliberately a plain Button, NOT AlertDialog.Action
                 or Cancel (both close the dialog on click; known Radix footgun). */
              <Button type="button" variant={variant} size="sm" onClick={() => setStep(2)}>
                {twoStep.yesLabel}
              </Button>
            ) : (
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
            )}
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
  cancelLabel,
  variant = 'destructive',
  onConfirm,
  onCancel,
  onCloseAutoFocus,
}: {
  title?: string;
  description?: string;
  confirmLabel?: string;
  /** r304 — the dismiss button's words when "Cancel" would be ambiguous (the drawer's "Keep editing"). */
  cancelLabel?: string;
  variant?: ButtonProps['variant'];
  onConfirm: () => void;
  onCancel: () => void;
  /** r304 — where focus goes when the dialog closes. It has no trigger, so Radix's own return lands on
   *  <body>; a caller inside another dialog passes this to put focus back where the user was. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations('components.confirmSubmit');
  return (
    <AlertDialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <AlertDialog.Title className="text-base font-semibold">{title ?? t('title')}</AlertDialog.Title>
          {description ? (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">{description}</AlertDialog.Description>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" size="sm">
                {cancelLabel ?? t('cancel')}
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
