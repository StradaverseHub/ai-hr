'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/intent-link';
import { Card, ErrorBanner, Field, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { saveMovementEventTypeAction, type MovementTypeSaveResult } from './actions';

/**
 * 1d58019a — the event-type CONFIGURATION PAGE's form (Add and Edit), replacing movement-type-dialog.tsx.
 *
 * The reporter asked for a dedicated full-width page organised in cards instead of the small pop-up. Step 1
 * builds three cards — General Information, Classification (read-only) and Description — with Save and
 * Cancel in a footer that stays visible. Termination Reasons and Field Controls cards belong to Step 2.
 *
 * WHAT CARRIES OVER FROM THE DIALOG (each was a defect once, see the 1b87e8a0 and def44f29 notes in git
 * history and test/movement-settings.test.ts):
 *   • The save action RETURNS its outcome. A refusal paints here and keeps every field as typed; only a
 *     success navigates (back to the list).
 *   • Every field is CONTROLLED, and the form has NO `action` prop: onSubmit builds the FormData and
 *     dispatches the useActionState action inside startTransition. React 19 resets a form submitted through
 *     its `action` prop once the action settles, and a controlled <select> does not survive that reset —
 *     the behaviour picker snapped back to its first option over a refused save.
 *   • A built-in never gets an editable behaviour: Termination ends employment, Confirmation completes
 *     probation. The service refuses a re-point independently.
 *
 * CLASSIFICATION IS DERIVED, NOT EDITED, in this step: Termination for the termination behaviour, Non-
 * Termination for everything else (ADR-0165). It is shown as a disabled radio pair so the card already reads
 * the way Step 2 will use it, and it follows the behaviour picker live for a custom type.
 *
 * NO t() HERE: every string arrives translated from the server page.
 */
export type EventTypeFormLabels = {
  sections: { general: string; classification: string; description: string };
  name: string;
  namePlaceholder: string;
  code: string;
  codeAuto: string;
  behaviour: string;
  behaviourPlaceholder: string;
  behaviourHint: string;
  builtInBehaviour: string;
  classificationHint: string;
  termination: string;
  nonTermination: string;
  optional: string;
  descriptionHint: string;
  descriptionPlaceholder: string;
  save: string;
  saving: string;
  cancel: string;
};

export function EventTypeForm({
  code,
  builtIn,
  initialLabel,
  initialBehaviourKind,
  initialDescription,
  behaviourLabel,
  behaviourOptions,
  listHref,
  labels,
}: {
  /** null = adding one of the organisation's own types. */
  code: string | null;
  builtIn: boolean;
  initialLabel: string;
  initialBehaviourKind: string;
  initialDescription: string;
  /** The built-in's behaviour, translated — the read-only field's value when `builtIn`. */
  behaviourLabel: string;
  behaviourOptions: readonly { value: string; label: string }[];
  listHref: string;
  labels: EventTypeFormLabels;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<MovementTypeSaveResult | null, FormData>(
    saveMovementEventTypeAction,
    null,
  );
  const [label, setLabel] = useState(initialLabel);
  const [behaviourKind, setBehaviourKind] = useState(initialBehaviourKind);
  const [description, setDescription] = useState(initialDescription);

  useEffect(() => {
    if (state?.ok) {
      router.push(listHref);
      router.refresh();
    }
  }, [state, router, listHref]);

  const isTermination = behaviourKind === 'termination';
  const sections = [
    { id: 'general', label: labels.sections.general },
    { id: 'classification', label: labels.sections.classification },
    { id: 'description', label: labels.sections.description },
  ];

  return (
    <form
      // NO `action` PROP — see the header.
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]"
    >
      {/* Section index: anchors to the cards, so a long page (Step 2 adds two more cards) stays navigable. */}
      <nav className="hidden lg:block">
        <Card className="sticky top-4 p-2">
          <ul className="space-y-0.5 text-sm">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#section-${s.id}`}
                  className="block rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </nav>

      <div className="min-w-0 space-y-4">
        {/* The service's refusal, on the page rather than as a redirect — the typing stays. */}
        <div aria-live="polite">{state && !state.ok && <ErrorBanner message={state.error} />}</div>

        {/* The ledger identity of the type being edited; absent when adding, which makes the save an insert. */}
        {code && <input type="hidden" name="code" value={code} />}

        <Card id="section-general" className="scroll-mt-4 p-5">
          <h2 className="mb-3 text-sm font-semibold">{labels.sections.general}</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label={labels.name}>
              <input
                name="label"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className={inputCls}
                placeholder={labels.namePlaceholder}
              />
            </Field>
            <Field label={labels.code}>
              {/* Never editable: every recorded movement of this type already points at it. */}
              <input className={inputCls} value={code ?? labels.codeAuto} readOnly disabled />
            </Field>
            <div className="md:col-span-2">
              <Field label={labels.behaviour}>
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
              <p className="mt-1 text-xs text-muted-foreground">
                {builtIn ? labels.builtInBehaviour : labels.behaviourHint}
              </p>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card id="section-classification" className="scroll-mt-4 p-5">
            <h2 className="text-sm font-semibold">{labels.sections.classification}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{labels.classificationHint}</p>
            {/* Read-only in Step 1: derived from the behaviour, never posted. */}
            <div role="radiogroup" aria-label={labels.sections.classification} className="mt-3 flex flex-wrap gap-6 text-sm">
              <label className="inline-flex items-center gap-2">
                <input type="radio" checked={!isTermination} readOnly disabled />
                {labels.nonTermination}
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" checked={isTermination} readOnly disabled />
                {labels.termination}
              </label>
            </div>
          </Card>

          <Card id="section-description" className="scroll-mt-4 p-5">
            <h2 className="text-sm font-semibold">
              {labels.sections.description}{' '}
              <span className="font-normal text-muted-foreground">{labels.optional}</span>
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{labels.descriptionHint}</p>
            <textarea
              name="description"
              aria-label={labels.sections.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={labels.descriptionPlaceholder}
              className="mt-3 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
            />
          </Card>
        </div>

        {/* Save and Cancel stay visible however far the page scrolls. */}
        <Card className="sticky bottom-3 z-10 flex items-center justify-end gap-2 p-3">
          <Link href={listHref} className={btnGhost}>
            {labels.cancel}
          </Link>
          <button type="submit" className={btnPrimary} disabled={pending}>
            {pending ? labels.saving : labels.save}
          </button>
        </Card>
      </div>
    </form>
  );
}
