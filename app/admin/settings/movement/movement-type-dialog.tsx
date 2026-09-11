'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ErrorBanner, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { saveMovementEventTypeAction, type MovementTypeSaveResult } from './actions';

/**
 * Movement Settings — Add / Edit an event type, in a MODAL DIALOG (1b87e8a0, re-built).
 *
 * WHY THIS FILE EXISTS. The first build put the Add/Edit form in a card at the BOTTOM of the page,
 * opened by `?new=1` / `?edit=CODE`. The reporter contested it: "displays the Add or Edit Event form at
 * the bottom of the existing page, which is not user-friendly". They are right — the form was below the
 * fold, so opening it scrolled you off the row you were working on and closing it did not put you back.
 *
 * DIALOG, NOT A SIDE PANEL — one surface, chosen once. The house already has this exact modal
 * (components/family-form-dialog.tsx, app/payroll/transactions/fixed/add-fixed-dialog.tsx: Radix
 * Dialog, `bg-black/50` overlay, centred `bg-popover` card), it has no slide-over primitive at all, and
 * the form is two fields — a sheet is the shape for a long form, not for a name and a dropdown.
 * Reusing the existing modal keeps this screen inside a pattern that already ships instead of inventing
 * a sixth one.
 *
 * THE LIST NEVER MOVES. There is no navigation: the trigger is client state, so opening Add or Edit
 * does not re-render the route, does not reset scroll, and does not touch the address. Radix returns
 * focus to the trigger on close, so dismissing an Edit lands you back ON the row you opened — which is
 * the reporter's complaint, answered. That is also why `?new=`/`?edit=` are gone rather than kept
 * alongside: two sources of truth for "is the form open" is how the panel comes back.
 *
 * A REJECTED SAVE KEEPS THE DIALOG OPEN AND THE TYPING INTACT. The action RETURNS
 * `{ ok: false, error }` instead of redirecting (the delegations pattern — useActionState over a
 * value-returning server action), so nothing navigates and the error paints inside the dialog. The two
 * fields are CONTROLLED on purpose: React 19 resets an uncontrolled `<form action={…}>` once the action
 * settles, error or not, so `defaultValue` alone would silently wipe a half-typed name on the exact
 * path this is meant to protect.
 *
 * ⚠️ def44f29 (2026-09-11) — THE FORM HAS NO `action` PROP ANY MORE, AND THAT IS THE FIX, NOT THE
 * `onReset` CANCEL BELOW. The cancel was believed to stop React's post-action reset; it cannot run:
 * react-dom 19.2 switches its own event listener OFF for the commit phase (`_enabled = false`) and calls
 * `form.reset()` INSIDE that phase, so the `reset` event is dropped before any onReset sees it. Proved
 * by rendering (test/movement-type-dialog.dom.test.tsx): after a refused save the behaviour <select>
 * snapped from the chosen "Promotion" back to "Transfer" with the cancel in place, so a re-submit would
 * have posted the wrong behaviour. React only requests the reset for a submission that goes through the
 * form's `action` prop, so onSubmit now builds the FormData and dispatches the same useActionState action
 * inside startTransition — same pending state, same result, no reset. The cancel stays (it costs nothing
 * and covers a manual form.reset()). Same shape as app/admin/holidays/holiday-dialog.tsx.
 *
 * NO t() HERE, BY DESIGN. Every visible string arrives pre-translated from the server page, which keeps
 * this island out of the i18n graph entirely and leaves the page's labels pinned where they already are
 * (test/movement-settings.test.ts's per-locale key list — the page opens two namespaces, so
 * i18n-coverage Check C skips it and that list is the only guard).
 */

/** Every visible string, resolved by the server page. Add and Edit pass different objects. */
export type MovementTypeDialogLabels = {
  title: string;
  hint: string;
  name: string;
  namePlaceholder: string;
  behaviour: string;
  behaviourPlaceholder: string;
  /** Shown under a built-in's read-only behaviour field: its meaning is not the tenant's to change. */
  builtInBehaviour: string;
  submit: string;
  saving: string;
  cancel: string;
  close: string;
};

type FormProps = {
  /** null = adding one of the organisation's own types; a code = editing that entry. */
  code: string | null;
  builtIn: boolean;
  initialLabel: string;
  initialBehaviourKind: string;
  /** The built-in's behaviour, already translated — the read-only field's value when `builtIn`. */
  behaviourLabel: string;
  behaviourOptions: readonly { value: string; label: string }[];
  labels: MovementTypeDialogLabels;
};

export function MovementTypeDialog({
  triggerLabel,
  triggerClassName,
  ...form
}: FormProps & { triggerLabel: string; triggerClassName: string }) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {/* `cursor-pointer` is not decoration: Tailwind v4's preflight gives a <button> the ARROW
            cursor, and both triggers replaced things that were <Link>s. Without it the row's Edit
            silently stops looking clickable — a regression inside a fix for an affordance complaint. */}
        <button type="button" className={`cursor-pointer ${triggerClassName}`}>
          {triggerLabel}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          // Radix would focus the ✕ first; the name is what you came to type (and on Edit, to replace).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          {/* Mounted only while open, so every open starts from the server's values — there is no stale
              state to clear, and a cancelled edit cannot leak into the next one. */}
          <MovementTypeForm {...form} nameRef={nameRef} onSaved={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function MovementTypeForm({
  code,
  builtIn,
  initialLabel,
  initialBehaviourKind,
  behaviourLabel,
  behaviourOptions,
  labels,
  nameRef,
  onSaved,
}: FormProps & {
  nameRef: RefObject<HTMLInputElement | null>;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MovementTypeSaveResult | null, FormData>(
    saveMovementEventTypeAction,
    null,
  );
  const [label, setLabel] = useState(initialLabel);
  const [behaviourKind, setBehaviourKind] = useState(initialBehaviourKind);

  // The close goes through a ref so the effect fires once per RESULT (each submit returns a fresh object)
  // rather than every time the parent hands down a new arrow. router.refresh() is what redraws the list
  // under the dialog: the action revalidates, and this is the client half of that.
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
      // NO `action` PROP, ON PURPOSE — see the file header (def44f29). React resets the <form> once a
      // form-action settles, success or failure; the text input survives it because React keeps a
      // controlled input's defaultValue in step with its value, but it does not do the equivalent for
      // <option>, so the behaviour dropdown snapped back to the FIRST option while React still held the
      // one you picked. The cancel below never ran (React drops its own reset event during the commit),
      // so the reset is not cancelled here — it is never requested: the action is dispatched by hand.
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      onReset={(e) => e.preventDefault()}
      className="flex flex-col gap-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <Dialog.Title className="text-base font-semibold">{labels.title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted-foreground">
            {labels.hint}
          </Dialog.Description>
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

      {/* The service's refusal, in the dialog rather than as a redirect — see the file header. */}
      <div aria-live="polite">{state && !state.ok && <ErrorBanner message={state.error} />}</div>

      {/* The ledger identity of the row being edited. Never editable: every recorded movement of this
          type already points at it. Absent when adding, which is what makes the action an insert. */}
      {code && <input type="hidden" name="code" value={code} />}

      <Field label={labels.name}>
        <input
          ref={nameRef}
          name="label"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={inputCls}
          placeholder={labels.namePlaceholder}
        />
      </Field>

      <Field label={labels.behaviour}>
        {/* EXACTLY ONE behaviour picker, and never for a built-in: Termination ends employment,
            Confirmation completes probation, a join-date correction moves leave entitlement. Those
            consequences belong to the built-in kind, not to its name. The service refuses a re-point
            independently — but an affordance that cannot work is a bug of its own. */}
        {builtIn ? (
          <input className={inputCls} value={behaviourLabel} readOnly disabled />
        ) : (
          <select
            name="behaviourKind"
            required
            value={behaviourKind}
            onChange={(e) => setBehaviourKind(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              {labels.behaviourPlaceholder}
            </option>
            {behaviourOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {builtIn && <p className="-mt-2 text-xs text-muted-foreground">{labels.builtInBehaviour}</p>}

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
