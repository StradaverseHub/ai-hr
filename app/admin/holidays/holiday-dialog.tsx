'use client';

import { startTransition, useActionState, useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ErrorBanner, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { saveHolidayAction, type HolidaySaveResult } from '../actions';

/**
 * Holidays — Add / Edit a holiday, in a MODAL DIALOG over the list (def44f29).
 *
 * WHY THIS FILE EXISTS. "Add holiday" was an anchor jump to a form card BELOW the paged list, and every
 * row was an inline edit form; National / State was read-only text with no way to set it, so every
 * holiday added from the screen was national and moving one to a state meant delete-and-recreate. The
 * reporter asked for the form in a window over the list and for National / State to be changeable.
 *
 * THE SHAPE IS app/admin/settings/movement/movement-type-dialog.tsx (1b87e8a0), copied on purpose rather
 * than re-derived: Radix Dialog, useActionState over a VALUE-RETURNING server action, CONTROLLED inputs,
 * every label pre-translated by the server page, no t() and no core/ import in the island. Read that
 * file's header for why each of those is load-bearing; the short version is that a refused save must
 * keep the dialog open with the typing intact, and React 19 resets a `<form action={…}>` once the action
 * settles — success or failure — snapping every <select> and checkbox back to its default while React
 * still holds what was chosen.
 *
 * ⚠️ THE RESET IS NOT CANCELLED HERE, IT IS NEVER REQUESTED. The movement dialog cancels it with
 * `onReset={(e) => e.preventDefault()}`. That handler cannot run: react-dom 19.2 switches its own event
 * listener OFF for the commit phase (`_enabled = false`) and calls `form.reset()` INSIDE that phase, so
 * the `reset` event it fires is dropped by React before any onReset sees it — proved by rendering in
 * test/holiday-dialog.dom.test.tsx, where a controlled state <select> came back "National" after a
 * refused save with the cancel in place. React only requests the reset for a submission that goes
 * through the form's `action` prop, so this form has no `action`: onSubmit builds the FormData and
 * dispatches the same useActionState action inside startTransition. Same pending state, same result,
 * no reset. (The onReset cancel is kept as well: it costs nothing and covers a manual form.reset().)
 *
 * WHAT DIFFERS FROM THE MOVEMENT DIALOG, and why:
 *   · ON SUCCESS THE ACTION RETURNS A PATH and the island `router.push`es it. The Holiday master pages
 *     and is ordered by date, so the row you just saved can be on another page than the one you were
 *     on; the redirect used to carry holidayFollowPath (9da61c86) and this keeps that behaviour without
 *     a redirect. The hidden filter fields ride inside this form so the action can rebuild the address.
 *   · NATIONAL / STATE is a dropdown fed per country by the server page from the country pack's state
 *     list (never a hand-typed second copy). A business-group / holiday-group row gets a FIXED label and
 *     no picker at all — and then posts no `state` field, which is how the action knows to leave it
 *     alone (the service refuses a change on such a row independently).
 *   · COUNTRY is a dropdown when adding and read-only when editing: updateHoliday takes no country.
 *
 * Mounted only while open, so every open starts from the server's values — a cancelled edit cannot leak
 * into the next one, and the Add dialog always opens on today's date.
 */

/** Every visible string, resolved by the server page. Add and Edit pass different title/hint. */
export type HolidayDialogLabels = {
  title: string;
  hint: string;
  name: string;
  namePlaceholder: string;
  date: string;
  nationalState: string;
  /** Under the picker: what National means and what choosing a state does. */
  nationalStateHint: string;
  /** The picker's first option. */
  national: string;
  /** Under the fixed label of a business-group / holiday-group row. */
  scopeFixedHint: string;
  holidayType: string;
  country: string;
  active: string;
  tentative: string;
  submit: string;
  saving: string;
  cancel: string;
  close: string;
};

/** The active list filter, echoed as hidden fields so the action can land the admin back in the same
 *  view (app/admin/actions.ts holidaysPath reads exactly these four). `size` is '' unless the READER
 *  chose a rows-per-page — posting the resolved default would write ?size=25 into a bare address. */
export type HolidayDialogFilter = { country: string; year: string; page: string; size: string };

export type HolidayDialogInitial = {
  name: string;
  holidayDate: string;
  /** '' = national; otherwise a state label from the country's pack. */
  state: string;
  holidayType: string;
  country: string;
  active: boolean;
  tentative: boolean;
};

type FormProps = {
  /** null = adding; an id = editing that row. */
  id: string | null;
  initial: HolidayDialogInitial;
  /** A business-group / holiday-group row's scope label, shown read-only in place of the picker; null for
   *  a national or state row. */
  fixedScope: string | null;
  countryOptions: readonly string[];
  /** Per ISO country code, the pack's state labels. A country with no pack lists none: National only. */
  statesByCountry: Record<string, readonly string[]>;
  typeOptions: readonly { value: string; label: string }[];
  filter: HolidayDialogFilter;
  labels: HolidayDialogLabels;
};

export function HolidayDialog({
  triggerLabel,
  triggerClassName,
  ...form
}: FormProps & { triggerLabel: string; triggerClassName: string }) {
  const [open, setOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {/* `cursor-pointer` is not decoration: Tailwind v4's preflight gives a <button> the ARROW cursor,
            and the Add trigger replaced an <a>. Without it the button stops looking clickable. */}
        <button type="button" className={`cursor-pointer ${triggerClassName}`}>
          {triggerLabel}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          // Radix would focus the ✕ first; the name is what you came to type (and on Edit, to correct).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
            nameRef.current?.select();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <HolidayForm {...form} nameRef={nameRef} onSaved={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HolidayForm({
  id,
  initial,
  fixedScope,
  countryOptions,
  statesByCountry,
  typeOptions,
  filter,
  labels,
  nameRef,
  onSaved,
}: FormProps & {
  nameRef: RefObject<HTMLInputElement | null>;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<HolidaySaveResult | null, FormData>(
    saveHolidayAction,
    null,
  );
  const [name, setName] = useState(initial.name);
  const [holidayDate, setHolidayDate] = useState(initial.holidayDate);
  const [holidayState, setHolidayState] = useState(initial.state);
  const [holidayType, setHolidayType] = useState(initial.holidayType);
  const [country, setCountry] = useState(initial.country);
  const [active, setActive] = useState(initial.active);
  const [tentative, setTentative] = useState(initial.tentative);

  const stateOptions = statesByCountry[country] ?? [];

  // The close goes through a ref so the effect fires once per RESULT (each submit returns a fresh object)
  // rather than every time the parent hands down a new arrow. The action has already revalidated the
  // route; pushing the returned path is what puts the saved row's page in front of the admin, and the
  // refresh redraws the list under the dialog when that path is the one already on screen.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  useEffect(() => {
    if (state?.ok) {
      router.push(state.path);
      router.refresh();
      onSavedRef.current();
    }
  }, [state, router]);

  return (
    <form
      // NO `action` PROP, ON PURPOSE — see the file header. Dispatching the action ourselves is what
      // keeps React from resetting the form when it settles; a refused save must show "Sabah" over a
      // form that will save "Sabah", not "National".
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

      {/* The row being edited. Absent when adding, which is what makes the action an insert. */}
      {id && <input type="hidden" name="id" value={id} />}
      {/* The list filter, so the action can rebuild the address of the view the admin was in. */}
      <input type="hidden" name="filterCountry" value={filter.country} />
      <input type="hidden" name="filterYear" value={filter.year} />
      <input type="hidden" name="filterPage" value={filter.page} />
      {filter.size && <input type="hidden" name="filterSize" value={filter.size} />}

      <Field label={labels.name}>
        <input
          ref={nameRef}
          name="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputCls}
          placeholder={labels.namePlaceholder}
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={labels.date}>
          <input
            name="holidayDate"
            type="date"
            required
            value={holidayDate}
            onChange={(e) => setHolidayDate(e.target.value)}
            className={`${inputCls} font-mono tabular-nums`}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          {/* National / State. A business-group / holiday-group row shows its fixed label and posts NO
              state field — the action reads the field's presence, the service refuses a change anyway. */}
          {fixedScope ? (
            <>
              <Field label={labels.nationalState}>
                <input className={inputCls} value={fixedScope} readOnly disabled />
              </Field>
              <p className="text-xs text-muted-foreground">{labels.scopeFixedHint}</p>
            </>
          ) : (
            <>
              <Field label={labels.nationalState}>
                <select
                  name="state"
                  value={holidayState}
                  onChange={(e) => setHolidayState(e.target.value)}
                  className={inputCls}
                >
                  <option value="">{labels.national}</option>
                  {stateOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-muted-foreground">{labels.nationalStateHint}</p>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={labels.holidayType}>
          <select
            name="holidayType"
            value={holidayType}
            onChange={(e) => setHolidayType(e.target.value)}
            className={inputCls}
          >
            {typeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={labels.country}>
          {/* Fixed on edit: updateHoliday takes no country, and the leave/attendance counters match a
              holiday on company.country — re-homing a row is a delete and an add. */}
          {id ? (
            <input className={inputCls} value={country} readOnly disabled />
          ) : (
            <select
              name="country"
              value={country}
              onChange={(e) => {
                const next = e.target.value;
                setCountry(next);
                // A state belongs to one country: switching country drops a state the new one lacks.
                if (holidayState && !(statesByCountry[next] ?? []).includes(holidayState)) setHolidayState('');
              }}
              className={inputCls}
            >
              {countryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            name="active"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="size-4"
          />
          {labels.active}
        </label>
        {/* ADR-0063: a not-yet-gazetted date, loaded provisionally — it still counts as a holiday. */}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            name="tentative"
            checked={tentative}
            onChange={(e) => setTentative(e.target.checked)}
            className="size-4"
          />
          {labels.tentative}
        </label>
      </div>

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
