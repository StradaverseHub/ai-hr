'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ErrorBanner, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { saveTerminationReasonAction, type MovementTypeSaveResult } from './actions';

/**
 * 1d58019a — Add / Rename a termination reason, in the house modal (components/family-form-dialog.tsx,
 * app/admin/holidays/holiday-dialog.tsx). A reason is a name and a group, so it stays a small dialog over the
 * list rather than a page of its own — the reporter's "dedicated page" request was about EVENT TYPES, whose
 * configuration is growing into several cards.
 *
 * The shape is the one movement-type-dialog.tsx proved before it was retired (def44f29): the save RETURNS
 * its outcome so a refusal keeps the dialog open with the typing intact; the fields are CONTROLLED; and the
 * form has NO `action` prop — onSubmit dispatches the useActionState action itself, so React never requests
 * the post-action form reset that snapped a controlled <select> back to its first option.
 *
 * The GROUP is chosen once, when a reason is added: the turnover reports read it, so the service refuses a
 * re-point and a rename shows it read-only. NO t() HERE: every string arrives translated.
 */
export type ReasonDialogLabels = {
  title: string;
  hint: string;
  name: string;
  namePlaceholder: string;
  group: string;
  groupPlaceholder: string;
  groupFixed: string;
  submit: string;
  saving: string;
  cancel: string;
  close: string;
};

export function ReasonDialog({
  triggerLabel,
  triggerClassName,
  code,
  initialLabel,
  groupLabel,
  groupOptions,
  labels,
}: {
  triggerLabel: string;
  triggerClassName: string;
  /** null = adding one of the organisation's own reasons. */
  code: string | null;
  initialLabel: string;
  /** The reason's group, translated — shown read-only when renaming. */
  groupLabel: string;
  groupOptions: readonly { value: string; label: string }[];
  labels: ReasonDialogLabels;
}) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={`cursor-pointer ${triggerClassName}`}>
          {triggerLabel}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          {/* Mounted only while open, so every open starts from the server's values. */}
          <ReasonForm
            code={code}
            initialLabel={initialLabel}
            groupLabel={groupLabel}
            groupOptions={groupOptions}
            labels={labels}
            nameRef={nameRef}
            onSaved={() => setOpen(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReasonForm({
  code,
  initialLabel,
  groupLabel,
  groupOptions,
  labels,
  nameRef,
  onSaved,
}: {
  code: string | null;
  initialLabel: string;
  groupLabel: string;
  groupOptions: readonly { value: string; label: string }[];
  labels: ReasonDialogLabels;
  nameRef: RefObject<HTMLInputElement | null>;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MovementTypeSaveResult | null, FormData>(
    saveTerminationReasonAction,
    null,
  );
  const [label, setLabel] = useState(initialLabel);
  const [category, setCategory] = useState('');

  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      onSavedRef.current();
    }
  }, [state, router]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <Dialog.Title className="text-base font-semibold">{labels.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">{labels.hint}</Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button
            type="button"
            aria-label={labels.close}
            className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </Dialog.Close>
      </div>

      <div aria-live="polite">{state && !state.ok && <ErrorBanner message={state.error} />}</div>

      {code && <input type="hidden" name="code" value={code} />}

      <Field label={labels.name}>
        <input
          ref={nameRef}
          name="label"
          required
          maxLength={120}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={inputCls}
          placeholder={labels.namePlaceholder}
        />
      </Field>

      <Field label={labels.group}>
        {code ? (
          <input className={inputCls} value={groupLabel} readOnly disabled />
        ) : (
          <select
            name="category"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              {labels.groupPlaceholder}
            </option>
            {groupOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="-mt-2 text-xs text-muted-foreground">{labels.groupFixed}</p>

      <div className="mt-1 flex items-center justify-end gap-2">
        <Dialog.Close asChild>
          <button type="button" className={btnGhost}>
            {labels.cancel}
          </button>
        </Dialog.Close>
        <button type="submit" className={btnPrimary} disabled={pending}>
          {pending ? labels.saving : labels.submit}
        </button>
      </div>
    </form>
  );
}
