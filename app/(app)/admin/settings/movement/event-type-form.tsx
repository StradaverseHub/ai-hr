'use client';

import { startTransition, useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from '@/components/intent-link';
import { Card, ErrorBanner, Field, btnGhost, btnPrimary, inputCls, tableWrapCls, theadCls, thCls, tbodyCls } from '@/components/ui';
import {
  MOVEMENT_RULE_GROUPS,
  defaultMovementFieldRule,
  movementRuleFieldsFor,
  normaliseMovementFieldRule,
  type MovementDocumentMode,
  type MovementFieldRule,
  type MovementRuleField,
} from '@/lib/movement-field-rules';
import { saveMovementEventTypeAction, type MovementTypeSaveResult } from './actions';

/**
 * 1d58019a — the event-type CONFIGURATION PAGE's form (Add and Edit), replacing movement-type-dialog.tsx.
 *
 * The reporter asked for a dedicated full-width page organised in cards instead of the small pop-up: General
 * Information, Classification, Description, and (Step 2, ADR-0166) Termination Reasons and Field Controls,
 * with Save and Cancel in a footer that stays visible.
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
 * CLASSIFICATION IS DERIVED FROM THE BEHAVIOUR, NEVER STORED (ADR-0165/0166): Termination for the termination
 * behaviour, Non-Termination for everything else. Step 2 lets one of the organisation's own types be a
 * Termination, so for such a type the radio pair is a shortcut onto the behaviour picker (Termination picks
 * the termination behaviour; Non-Termination asks for one of the others). It is never posted. It is locked —
 * like the behaviour itself — for a built-in and for any type already used by recorded movements.
 *
 * FIELD CONTROLS follow the Employee Change Requests grid: Want to Change This, Allow to Edit, Required to
 * Change, File Enabled. The grid is posted as one JSON value; the service validates and normalises it, and a
 * grid left at its defaults is stored as nothing ("no rules means today's behaviour").
 *
 * NO t() HERE: every string arrives translated from the server page.
 */
export type EventTypeFormLabels = {
  sections: {
    general: string;
    classification: string;
    description: string;
    /** 1d58019a Step 2. */
    reasons?: string;
    fields?: string;
  };
  name: string;
  namePlaceholder: string;
  code: string;
  codeAuto: string;
  behaviour: string;
  behaviourPlaceholder: string;
  behaviourHint: string;
  builtInBehaviour: string;
  classificationHint: string;
  /** 1d58019a Step 2 — shown instead of the hint when the classification cannot change. */
  classificationLocked?: string;
  classificationBuiltIn?: string;
  termination: string;
  nonTermination: string;
  optional: string;
  descriptionHint: string;
  descriptionPlaceholder: string;
  save: string;
  saving: string;
  cancel: string;
  /** 1d58019a Step 2 — the Termination Reasons and Field Controls cards. */
  controls?: {
    reasonsHint: string;
    reasonsAllHint: string;
    reasonsManageHint: string;
    reasonSwitchedOff: string;
    fieldsHint: string;
    fieldsNotApplicable: string;
    fieldsCompanyLocked: string;
    columns: { field: string; include: string; edit: string; mustChange: string; file: string };
    groups: { organisation: string; labels: string; salary: string };
    documents: { none: string; optional: string; required: string };
  };
};

export type EventTypeReasonOption = { code: string; label: string; category: string; active: boolean };

export function EventTypeForm({
  code,
  builtIn,
  inUse = false,
  initialLabel,
  initialBehaviourKind,
  initialDescription,
  behaviourLabel,
  behaviourOptions,
  comparisonBehaviours = [],
  reasonGroups = [],
  reasonOptions = [],
  initialReasonCodes = [],
  fieldLabels = {},
  initialRules = [],
  listHref,
  labels,
}: {
  /** null = adding one of the organisation's own types. */
  code: string | null;
  builtIn: boolean;
  /** 1d58019a Step 2 — already used by recorded movements: what it does (and its classification) is locked. */
  inUse?: boolean;
  initialLabel: string;
  initialBehaviourKind: string;
  initialDescription: string;
  /** The built-in's behaviour, translated — the read-only field's value when `builtIn`. */
  behaviourLabel: string;
  behaviourOptions: readonly { value: string; label: string }[];
  /** The behaviours that change employment details, i.e. get the Field Controls grid. */
  comparisonBehaviours?: readonly string[];
  /** The three fixed reason groups, translated, in order. */
  reasonGroups?: readonly { category: string; label: string }[];
  /** The tenant's reasons (active ones, plus any switched-off one already ticked). */
  reasonOptions?: readonly EventTypeReasonOption[];
  /** Ticked reason codes; none = every active reason is offered. */
  initialReasonCodes?: readonly string[];
  fieldLabels?: Readonly<Record<string, string>>;
  /** The type's effective Field Controls for its current behaviour. */
  initialRules?: readonly MovementFieldRule[];
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
  const [reasonCodes, setReasonCodes] = useState<string[]>([...initialReasonCodes]);
  const [rules, setRules] = useState<Map<string, MovementFieldRule>>(
    () => new Map(initialRules.map((r) => [r.field, r])),
  );

  useEffect(() => {
    if (state?.ok) {
      router.push(listHref);
      router.refresh();
    }
  }, [state, router, listHref]);

  const isTermination = behaviourKind === 'termination';
  const isComparison = comparisonBehaviours.includes(behaviourKind);
  // The behaviour — and so the classification — cannot change for a built-in or once the type is used.
  const behaviourLocked = builtIn || inUse;
  const controls = labels.controls;

  /** The grid as it will be saved: every field the behaviour offers, consistent with its dependencies. */
  const gridRules = movementRuleFieldsFor(behaviourKind).map((f) =>
    normaliseMovementFieldRule(behaviourKind, rules.get(f) ?? defaultMovementFieldRule(f)),
  );
  const ruleOf = (f: MovementRuleField) => gridRules.find((r) => r.field === f)!;
  const setRule = (f: MovementRuleField, patch: Partial<MovementFieldRule>) =>
    setRules((prev) => {
      const next = new Map(prev);
      next.set(f, normaliseMovementFieldRule(behaviourKind, { ...ruleOf(f), ...patch }));
      return next;
    });

  const sections = [
    { id: 'general', label: labels.sections.general },
    { id: 'classification', label: labels.sections.classification },
    { id: 'description', label: labels.sections.description },
    ...(isTermination && labels.sections.reasons ? [{ id: 'reasons', label: labels.sections.reasons }] : []),
    ...(labels.sections.fields ? [{ id: 'fields', label: labels.sections.fields }] : []),
  ];

  const toggleReason = (reason: string, on: boolean) =>
    setReasonCodes((prev) => (on ? [...new Set([...prev, reason])] : prev.filter((c) => c !== reason)));

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
      {/* Section index: anchors to the cards, so the long page stays navigable. */}
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
                  // Disabled (and so not posted) once the type is used: the service refuses a re-point anyway.
                  <select
                    name="behaviourKind"
                    required
                    disabled={inUse}
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
            <p data-testid="classification-hint" className="mt-1 text-xs text-muted-foreground">
              {builtIn
                ? (labels.classificationBuiltIn ?? labels.classificationHint)
                : inUse
                  ? (labels.classificationLocked ?? labels.classificationHint)
                  : labels.classificationHint}
            </p>
            {/* Derived from the behaviour and never posted; for an unused custom type, a shortcut onto it. */}
            <div role="radiogroup" aria-label={labels.sections.classification} className="mt-3 flex flex-wrap gap-6 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  disabled={behaviourLocked}
                  checked={!isTermination}
                  onChange={() => setBehaviourKind('')}
                />
                {labels.nonTermination}
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  disabled={behaviourLocked}
                  checked={isTermination}
                  onChange={() => setBehaviourKind('termination')}
                />
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

        {controls && labels.sections.fields && (
          <Card id="section-fields" className="scroll-mt-4 p-5">
            <h2 className="text-sm font-semibold">{labels.sections.fields}</h2>
            {isComparison ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">{controls.fieldsHint}</p>
                {/* The grid travels as ONE value; the service validates and normalises it. */}
                <input type="hidden" name="fieldRules" value={JSON.stringify(gridRules)} />
                <div className={`mt-3 ${tableWrapCls}`}>
                  <table className="w-full text-sm" data-testid="field-controls-grid">
                    <thead className={theadCls}>
                      <tr>
                        <th className={thCls}>{controls.columns.field}</th>
                        <th className={`${thCls} text-center`}>{controls.columns.include}</th>
                        <th className={`${thCls} text-center`}>{controls.columns.edit}</th>
                        <th className={`${thCls} text-center`}>{controls.columns.mustChange}</th>
                        <th className={`${thCls} text-center`}>{controls.columns.file}</th>
                      </tr>
                    </thead>
                    {MOVEMENT_RULE_GROUPS.map((group) => {
                      const fields = group.fields.filter((f) => gridRules.some((r) => r.field === f));
                      if (!fields.length) return null;
                      return (
                        <tbody key={group.id} className={tbodyCls}>
                          <tr>
                            <th scope="colgroup" colSpan={5} className="bg-muted/50 px-3 py-2 text-left font-semibold">
                              {controls.groups[group.id]}
                            </th>
                          </tr>
                          {fields.map((f) => {
                            const r = ruleOf(f);
                            const name = fieldLabels[f] ?? f;
                            // Entity Transfer's company IS the event: fixed included, editable and required.
                            const fixed = behaviourKind === 'entityTransfer' && f === 'companyId';
                            return (
                              <tr key={f} data-field={f}>
                                <th scope="row" className="px-3 py-2 text-left font-normal">
                                  {name}
                                  {fixed && (
                                    <span className="mt-0.5 block text-xs text-muted-foreground">{controls.fieldsCompanyLocked}</span>
                                  )}
                                </th>
                                <td className="px-3 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    aria-label={`${name}: ${controls.columns.include}`}
                                    checked={r.included}
                                    disabled={fixed}
                                    onChange={(e) => setRule(f, { included: e.target.checked, editable: e.target.checked })}
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    aria-label={`${name}: ${controls.columns.edit}`}
                                    checked={r.editable}
                                    disabled={fixed || !r.included}
                                    onChange={(e) => setRule(f, { editable: e.target.checked })}
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <input
                                    type="checkbox"
                                    aria-label={`${name}: ${controls.columns.mustChange}`}
                                    checked={r.mustChange}
                                    disabled={fixed || !r.editable}
                                    onChange={(e) => setRule(f, { mustChange: e.target.checked })}
                                  />
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <select
                                    aria-label={`${name}: ${controls.columns.file}`}
                                    value={r.document}
                                    disabled={!r.editable}
                                    onChange={(e) => setRule(f, { document: e.target.value as MovementDocumentMode })}
                                    className="rounded-md border border-input bg-card px-2 py-1 text-sm disabled:opacity-50"
                                  >
                                    <option value="none">{controls.documents.none}</option>
                                    <option value="optional">{controls.documents.optional}</option>
                                    <option value="required">{controls.documents.required}</option>
                                  </select>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      );
                    })}
                  </table>
                </div>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">{controls.fieldsNotApplicable}</p>
            )}
          </Card>
        )}

        {controls && labels.sections.reasons && isTermination && (
          <Card id="section-reasons" className="scroll-mt-4 p-5">
            <h2 className="text-sm font-semibold">{labels.sections.reasons}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{controls.reasonsHint}</p>
            {/* Marks the list as posted, so ticking none (= every active reason) is a choice the service sees. */}
            <input type="hidden" name="reasonsPosted" value="1" />
            <div className="mt-3 grid grid-cols-1 gap-4 rounded-md border border-dashed border-border p-4 md:grid-cols-3">
              {reasonGroups.map((g) => (
                <fieldset key={g.category}>
                  <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</legend>
                  <ul className="mt-2 space-y-1.5 text-sm">
                    {reasonOptions
                      .filter((r) => r.category === g.category)
                      .map((r) => (
                        <li key={r.code}>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              name="reasonCode"
                              value={r.code}
                              checked={reasonCodes.includes(r.code)}
                              onChange={(e) => toggleReason(r.code, e.target.checked)}
                            />
                            {r.label}
                            {!r.active && <span className="text-xs text-muted-foreground">({controls.reasonSwitchedOff})</span>}
                          </label>
                        </li>
                      ))}
                  </ul>
                </fieldset>
              ))}
              <p className="text-xs text-muted-foreground md:col-span-3">
                {reasonCodes.length ? controls.reasonsManageHint : `${controls.reasonsAllHint} ${controls.reasonsManageHint}`}
              </p>
            </div>
          </Card>
        )}

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
