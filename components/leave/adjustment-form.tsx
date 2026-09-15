'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';
import { SubStepBar } from '@/components/leave-sub-step-bar';
import { Button, Field, inputCls } from '@/components/ui';
import { normalizeDayFieldOnBlur } from '@/lib/day-format';
import { cn } from '@/lib/utils';
import { matchesEmployeeSearch } from '@/lib/employee-search';
import { mergeEmploymentSelection } from '@/lib/employment-selection';
import type { EmployeePickOption } from '@/lib/employment-selection';

type Opt = { value: string; label: string };
type Action = (fd: FormData) => void | Promise<void>;

/**
 * One criteria control — the SHARED shape, declared once in `core/org-criteria-form.ts` alongside the
 * builder that produces it, and re-exported here so this file's existing importers keep compiling.
 *
 * Every field arrives already labelled and already option-loaded from the SERVER page — nothing here
 * decides what an axis means, which is what keeps the picker and the resolver from drifting apart. It is a
 * TYPE-only import, erased at compile time, so no server module is pulled into this client bundle.
 */
export type { CriteriaField, CriteriaSection } from '@/core/org-criteria-form';
import type { CriteriaSection } from '@/core/org-criteria-form';

/** What the live-count / validation server action answers. Counts, never names — see previewLeaveAdjustmentBatch. */
export type AdjustmentPreview = {
  employees: number;
  targeted: number;
  willWrite: number;
  issues: { kind: string; count: number; leaveTypeName?: string }[];
};
type PreviewAction = (p: {
  leaveTypeIds: string[];
  effectiveOn: string;
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | string>;
  employmentIds: string[];
}) => Promise<AdjustmentPreview>;

/**
 * 18103ba4 — Leave Adjustments as a FOUR-STEP internal flow, replacing the 491c499f single long form.
 *
 * ① Leave Type · ② Employee Selection · ③ Adjustment Details · ④ Review & Process — the reporter's own
 * walk order, and the same shape the rest of Leave Configuration already uses.
 *
 * ── THE STEP BAR IS NOT REINVENTED HERE ───────────────────────────────────────────────────────────────
 * `components/leave-sub-step-bar.tsx` carries an explicit reuse contract in its header: secondary flows
 * "MUST reuse this component rather than reinventing their own nested bar". This screen is the same shape,
 * so it uses SubStepBar and owns only the active key and its persistence, exactly as that contract says
 * the parent should.
 *
 * ── EVERY STEP STAYS MOUNTED. THIS IS LOAD-BEARING, NOT LAZINESS ──────────────────────────────────────
 * The whole flow is ONE <form> with ONE submit, so an unmounted step is a step whose values do not post.
 * Steps are therefore hidden with a class, never unmounted, which also lets Step 2's live count read the
 * effective date out of Step 3 while Step 3 is off-screen — and it has to, because every criterion is
 * resolved AS AT that date.
 *
 * A consequence worth stating: no input carries `required`. A hidden `required` control makes the browser
 * refuse to submit with an unfocusable-control error nobody can act on. `applyLeaveAdjustmentBatch` remains
 * the authority instead — it has always thrown readable errors for a missing type, a zero amount, a blank
 * reason and a bad date, and Step 4 refuses to show a Process button until there is something to process.
 *
 * ── WHY THE COPY IS READ HERE AND THE CRITERIA ARRIVE AS PROPS ────────────────────────────────────────
 * r124 took the Entitlements tab down in production by passing a server translator CLOSURE into a client
 * component; test/server-client-boundary.test.ts pins that class. The fix is not "never translate in a
 * client component" — it is "never send a function across the boundary". So this component calls
 * `useTranslations` itself (the leave-type-panel idiom), which also puts every key it uses in front of the
 * i18n guard's single-namespace check, while the criteria sections arrive as plain serialisable data
 * because their labels are paired with catalogue rows only the server can read. `action` / `previewAction`
 * are the exception the framework allows: a server action is a reference React can serialise (the
 * `countInScopeAction` precedent on the Entitlements page).
 */

/** The four steps, in walk order. These strings are STORAGE KEYS — renaming one strands every browser. */
const STEP_KEYS = ['types', 'employees', 'details', 'review'] as const;
type StepKey = (typeof STEP_KEYS)[number];

/** Where a persisted step key that must NOT be restored verbatim lands instead.
 *
 *  'review' is in here for a real reason rather than a hypothetical one: Step 4 renders nothing of its own
 *  — it is a summary DERIVED from the three steps in front of it — and a fresh page load has already
 *  discarded that form state. Restoring a browser straight onto Review would therefore show a summary of
 *  nothing, which is precisely the blank-screen failure the leaveTypeCards `RETIRED_*_SUB_STEP` remaps
 *  exist to prevent (components/leave-type-panel.tsx). It lands on step 1 instead, where the walk starts.
 *
 *  THE SAME TABLE IS THE RETIREMENT MECHANISM. When a step is later removed or renamed, its old key goes
 *  here pointing at wherever its content went — never just deleted, because an unmapped stored key is
 *  invisible: this is PER-BROWSER state that no test and no render can see, and the only person who ever
 *  finds out is the user who lands somewhere blank. Anything neither in STEP_KEYS nor in here falls back
 *  to step 1 rather than rendering an empty page. */
const STEP_REMAP: Record<string, StepKey> = { review: 'types' };

const STORAGE_KEY = 'leaveAdjustmentFlow';

/** The Step 4 summary, captured from the form at the same moment the count is asked for. */
type ReviewSummary = {
  leaveTypeIds: string[];
  effectiveOn: string;
  amount: number;
  deduct: boolean;
  reason: string;
};

export function AdjustmentForm({
  action,
  previewAction,
  today,
  leaveTypes,
  criteriaSections,
  employees,
}: {
  action: Action;
  previewAction: PreviewAction;
  today: string;
  leaveTypes: Opt[];
  /** The criteria builder, grouped into the reporter's expandable sections. */
  criteriaSections: CriteriaSection[];
  /**
   * r288 — every employment the signed-in administrator's companies hold, read once by the server page.
   * REQUIRED, not optional: an optional list defaulting to `[]` would render a picker that silently offers
   * nobody on any page that forgot to pass it, which is the failure this round exists to remove.
   */
  employees: EmployeePickOption[];
}) {
  const t = useTranslations('admin.leave');
  const [step, setStep] = useState<StepKey>('types');
  const [mode, setMode] = useState<'criteria' | 'individual'>('criteria');
  const [anyCriteria, setAnyCriteria] = useState(false);
  const [preview, setPreview] = useState<AdjustmentPreview | null>(null);
  /** What Step 4 shows back to the operator, snapshotted alongside the count — see refreshPreview. */
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [, startPreview] = useTransition();
  /**
   * r288 (8521e160) — DID THE LAST COUNT FAIL?
   *
   * The reporter was told this screen "goes quiet — the matched count simply stops updating". Rendered, it
   * does something adjacent and equally silent: `refreshPreview`'s catch sets `preview` back to null, and
   * null has always been rendered as `adjustmentsMatchedPending` ("Working it out…"). So a count that threw
   * was INDISTINGUISHABLE from one still in flight — the identical defect r287 fixed on Generate
   * Entitlement, wearing the same sentence. (The previous number does not stand; it is replaced by a
   * sentence that says the screen is still thinking, forever. Both readings are silence.)
   *
   * It threw for a reason worth writing down: `employmentIdsRaw` reaches `resolveAdjustmentTargets` as
   * `IN (…)` against `employment.id`, a **uuid** column (core/leave-adjustment.ts). Typing a NAME there does
   * not "match nothing" — Postgres rejects the statement outright:
   *
   *     Failed query: … from "employment" … where "employment"."id" in ($1)   params: Irwin
   *     cause: invalid input syntax for type uuid: "Irwin"
   *
   * The `not_found` issue below it is NOT this case and must not be mistaken for it: that branch reports
   * well-formed uuids that do not exist, and a typed name never reaches it because the statement was
   * already rejected. The picker is why an operator no longer has to type into the box, and this flag is
   * why the screen says something terminal when something still does.
   */
  const [previewFailed, setPreviewFailed] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── ② PICK INDIVIDUALLY: two ways in, one list out ──────────────────────────────────────────────────
  // The popover's chosen ids, and the paste box's text. Both are held HERE rather than read off the form
  // for display, because the Next button and the chip strip must update on the keystroke, not 250ms later
  // when the debounced count happens to run. What is POSTED is still the form's own fields, and
  // `refreshPreview` still reads those — see its header.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [pastedRaw, setPastedRaw] = useState('');

  // Hydrate the persisted step in an effect (client-only ⇒ no SSR hydration mismatch), the same trade-off
  // LeaveTypePanel makes for leaveTypeCards:<id>. Unknown / retired keys go through STEP_REMAP; anything
  // else falls back to step 1 rather than leaving the user staring at nothing.
  //
  // eslint's react-hooks/set-state-in-effect flags the setStep below, and this is the ONE shape where that
  // is unavoidable and correct: localStorage does not exist on the server, so a lazy useState initialiser
  // would return a different value on each side and produce a hydration mismatch. LeaveTypePanel carries
  // the identical finding at the identical line for the identical reason (components/leave-type-panel.tsx,
  // its leaveTypeCards hydration). The cost is a brief step-1 → restored flash; that is the documented
  // trade-off, not an oversight. Do not "fix" this into an initialiser.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { step?: unknown } | null;
      const stored = parsed && typeof parsed.step === 'string' ? parsed.step : null;
      if (!stored) return;
      if (stored in STEP_REMAP) setStep(STEP_REMAP[stored]);
      else if ((STEP_KEYS as readonly string[]).includes(stored)) setStep(stored as StepKey);
    } catch {
      /* storage unavailable / malformed ⇒ default step 1 */
    }
  }, []);

  const selectStep = (key: StepKey) => {
    setStep(key);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ step: key }));
    } catch {
      /* storage write blocked ⇒ the flow still works, it just does not survive a reload */
    }
  };

  /**
   * Ask the server what this form currently resolves to. Reads the LIVE form rather than mirrored state, so
   * the count is computed from exactly the values that would post — including the effective date sitting on
   * a step that is not on screen, because the whole criteria set is judged as at that date.
   */
  const refreshPreview = () => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const criteria: Record<string, string[] | string> = {};
    for (const section of criteriaSections) {
      for (const f of section.fields) {
        if (f.kind === 'multi') {
          const vals = fd.getAll(f.name).map(String).filter(Boolean);
          if (vals.length) criteria[f.name] = vals;
        } else {
          const v = String(fd.get(f.name) ?? '').trim();
          if (v) criteria[f.name] = v;
        }
      }
    }
    const leaveTypeIds = fd.getAll('leaveTypeIds').map(String).filter(Boolean);
    const effectiveOn = String(fd.get('effectiveOn') ?? '');
    // Step 4's summary is snapshotted HERE, in the same pass that asks for the count, rather than read off
    // the form again while Step 4 renders. Two reasons: reading a ref during render is a React rule
    // violation that can silently miss an update, and — more to the point — the summary and the count must
    // describe the SAME form. Captured together, they cannot disagree.
    setSummary({
      leaveTypeIds,
      effectiveOn,
      amount: Math.abs(Number(String(fd.get('days') ?? ''))) || 0,
      deduct: String(fd.get('adjustmentType') ?? 'add') === 'deduct',
      reason: String(fd.get('reason') ?? ''),
    });
    const payload = {
      leaveTypeIds,
      effectiveOn,
      targetMode: mode,
      criteria: mode === 'criteria' ? criteria : {},
      // r288 — THE SAME MERGE THE WRITE PATH USES (lib/employment-selection.ts), over the SAME two fields,
      // read off the LIVE form so the count describes exactly what a submit would post. If these two ever
      // parse differently the screen confirms one population and the batch adjusts another, and both
      // halves' tests still pass — which is why the rule is one shared function, not two.
      employmentIds:
        mode === 'individual'
          ? mergeEmploymentSelection(fd.getAll('employmentIds').map(String), String(fd.get('employmentIdsRaw') ?? ''))
          : [],
    };
    startPreview(async () => {
      try {
        setPreview(await previewAction(payload));
        setPreviewFailed(false);
      } catch {
        // A failed count must not block the flow or invent a number. It must also not go on claiming to be
        // working: `previewFailed` is what lets the screen print a terminal sentence instead of the pending
        // one. The write path validates independently.
        setPreview(null);
        setPreviewFailed(true);
      }
    });
  };

  /** Debounced, because this fires on every keystroke in the reason box and every chip toggle. */
  const schedulePreview = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(refreshPreview, 250);
  };
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );
  // Re-ask on mount and whenever the targeting mode flips: the two modes resolve completely different sets.
  useEffect(refreshPreview, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepIndex = STEP_KEYS.indexOf(step);
  const goto = (i: number) => selectStep(STEP_KEYS[Math.min(Math.max(i, 0), STEP_KEYS.length - 1)]);
  const shown = (key: StepKey) => (step === key ? undefined : 'hidden');
  const chipRemove = (label: string) => t('chipRemoveAria', { name: label });
  const matchedCount = preview?.employees ?? null;

  // ── r288 · THE EMPLOYEE PICKER'S DERIVED DATA (the shape r287 settled on generate-form.tsx) ─────────
  // The row behind an option id, so the chips can show name and Employee ID as two things rather than one
  // pre-joined string, and so the search rule can read the real fields.
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  // "Irwin Tan · EMP-0008" for the popover row, which is a single line of text by construction. Composed
  // on THIS side of the boundary: the server page hands over data, never sentences.
  const employeeOptions = useMemo(
    () => employees.map((e) => ({ id: e.id, name: e.employeeCode ? `${e.name} · ${e.employeeCode}` : e.name })),
    [employees],
  );
  // THE HOUSE RULE, not a second one (lib/employee-search.ts): partial name OR partial Employee ID, folded
  // so "emp0008" finds "EMP-0008" here exactly as it does in the Personnel switcher and on Generate.
  const matchEmployee = useMemo(
    () => (option: { id: string }, query: string) => {
      const row = employeeById.get(option.id);
      return row ? matchesEmployeeSearch(row, query) : false;
    },
    [employeeById],
  );
  // The chosen rows in the SERVER'S order (listEmployees sorts by full name), so the strip never reshuffles
  // for a reason the operator cannot see. A `Set` is also why the same person cannot be added twice.
  const pickedRows = useMemo(() => employees.filter((e) => picked.has(e.id)), [employees, picked]);
  // THE ONE LIST OUT. Identical rule to the one the posted form goes through — see lib/employment-selection.ts.
  const individualIds = useMemo(() => mergeEmploymentSelection([...picked], pastedRaw), [picked, pastedRaw]);
  /**
   * THE ONE WRITER for the picked set. The popover and the chips' × are two views of ONE selection, so
   * removing a chip and unticking the row are the same operation and the two can never disagree about who
   * the batch will adjust.
   *
   * ⚠️ `schedulePreview` is not optional here. A checkbox inside the popover is not a `change` the enclosing
   * `<form onChange>` hears — the same trap the criteria ChipMultiSelect's `onSelectionChange` above names,
   * found on this very screen by rendering it — so without this the matched count would go on describing
   * the previous selection.
   */
  const applyPicked = (next: Set<string>) => {
    setPicked(next);
    schedulePreview();
  };
  const unpick = (id: string) => {
    const next = new Set(picked);
    next.delete(id);
    applyPicked(next);
  };

  /**
   * Is there anything to process? `targeted` is employees × leave types, computed SERVER-side from the
   * fields that would actually post — so it is "at least one leave type AND at least one employee" without
   * this component having to re-derive either. Zero ⇒ no Process button: `applyLeaveAdjustmentBatch` would
   * refuse anyway, but only after a navigation and a red banner, which is a worse way to learn it.
   */
  const canProcess = (preview?.targeted ?? 0) > 0;
  /**
   * r288 — Next is OFF while Pick individually has nobody in it.
   *
   * ONLY on step ②, and ONLY in individual mode. In CRITERIA mode an empty set is a legitimate choice
   * meaning "everyone" (`adjustmentsEveryoneWarning` says so on screen), so blocking it there would break
   * behaviour this screen has always had.
   */
  const nextBlocked = step === 'employees' && mode === 'individual' && individualIds.length === 0;

  return (
    <form
      ref={formRef}
      action={action}
      className="space-y-5"
      // ONE listener for the whole form: any change anywhere re-asks for the count, which is what keeps the
      // number honest when the effective date changes on a step the operator is not looking at.
      onChange={schedulePreview}
    >
      <SubStepBar
        ariaLabel={t('adjustmentsFlowAria')}
        active={step}
        onSelect={(k) => selectStep(k as StepKey)}
        steps={[
          { key: 'types', label: t('adjustmentsStepTypes') },
          { key: 'employees', label: t('adjustmentsStepWho') },
          { key: 'details', label: t('adjustmentsStepWhat') },
          { key: 'review', label: t('adjustmentsStepReview') },
        ]}
      />

      {/* ── ① Leave Type ───────────────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('types'))}>
        <ChipMultiSelect
          name="leaveTypeIds"
          label={t('adjustmentsStepTypes')}
          options={leaveTypes}
          addPlaceholder={t('eligibilityChipAddPlaceholder')}
          removeLabelFor={chipRemove}
          searchPlaceholder={t('adjustmentsSearchPlaceholder')}
          selectAllLabel={t('adjustmentsSelectAll')}
          clearAllLabel={t('adjustmentsDeselectAll')}
          // A chip is a <button>, so toggling one fires NO form change event — without this the review
          // would keep describing the previous set of leave types. Found by rendering the page.
          onSelectionChange={schedulePreview}
        />
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted-foreground">{t('adjustmentsAdjustmentType')}</legend>
          <div className="flex flex-wrap gap-4">
            {/* The DIRECTION, split out of the amount. 491c499f posted one signed `days` field and told the
                operator in help text that a minus sign meant "take away"; the reporter asked for the two
                explicit choices instead. The action recomposes the sign — core/leave-adjustment.ts still
                receives, stores and reverses exactly the signed number it always did. */}
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input type="radio" name="adjustmentType" value="add" defaultChecked className="size-3.5 border-border" />
              {t('adjustmentsTypeAdd')}
            </label>
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input type="radio" name="adjustmentType" value="deduct" className="size-3.5 border-border" />
              {t('adjustmentsTypeDeduct')}
            </label>
          </div>
        </fieldset>
      </section>

      {/* ── ② Employee Selection ───────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('employees'))}>
        <span className="block text-xs font-medium text-muted-foreground">{t('adjustmentsSelectionMethod')}</span>
        <input type="hidden" name="targetMode" value={mode} />
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="radio"
              name="targetModeRadio"
              checked={mode === 'criteria'}
              onChange={() => setMode('criteria')}
              className="size-3.5 border-border"
            />
            {t('adjustmentsByCriteria')}
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input
              type="radio"
              name="targetModeRadio"
              checked={mode === 'individual'}
              onChange={() => setMode('individual')}
              className="size-3.5 border-border"
            />
            {t('adjustmentsByIndividual')}
          </label>
        </div>

        {mode === 'criteria' ? (
          <div className="space-y-2" onChange={() => setAnyCriteria(true)}>
            {/* Said once, at the top, because it governs EVERY control below it: the whole criteria set is
                resolved as at the effective date on step 3, not as at today. An operator who does not know
                that cannot reproduce their own matched count. */}
            <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              {t('adjustmentsCriteria.asAtNote')}
            </p>
            {/* Expandable sections rather than one long list — the reporter's central complaint about this
                step. Native <details>, so it works with no JavaScript and needs no accordion state. */}
            {criteriaSections.map((section, i) => (
              <details
                key={section.key}
                open={i === 0}
                className="rounded-lg border border-border bg-card/40 px-3 py-2"
              >
                <summary className="cursor-pointer select-none text-xs font-semibold text-foreground">
                  {section.title}
                </summary>
                <div className="space-y-3 pt-3">
                  {section.fields.map((f) =>
                    f.kind === 'multi' ? (
                      <ChipMultiSelect
                        key={f.name}
                        name={f.name}
                        label={f.label}
                        options={f.options ?? []}
                        addPlaceholder={t('eligibilityChipAddPlaceholder')}
                        removeLabelFor={chipRemove}
                        searchPlaceholder={t('adjustmentsSearchPlaceholder')}
                        selectAllLabel={t('adjustmentsSelectAll')}
                        clearAllLabel={t('adjustmentsDeselectAll')}
                        // ⚠️ THE LIVE COUNT'S WHOLE POINT. A ChipMultiSelect row is a <button>, so picking
                        // a department fires no `change` on the form and the form-level listener above
                        // never hears it. Rendering the page showed the count sitting at "8 employees /
                        // everyone" while criteria were being picked, moving only when a date or number
                        // field happened to be touched. Both hooks are needed: this one for the chips, the
                        // form's onChange for the plain inputs.
                        onSelectionChange={() => {
                          setAnyCriteria(true);
                          schedulePreview();
                        }}
                      />
                    ) : (
                      <Field key={f.name} label={f.label}>
                        <input
                          name={f.name}
                          type={f.kind === 'date' ? 'date' : 'number'}
                          min={f.kind === 'number' ? 0 : undefined}
                          step={f.kind === 'number' ? 1 : undefined}
                          className={cn(inputCls, 'w-full')}
                        />
                      </Field>
                    ),
                  )}
                  {section.note && <p className="text-[11px] text-muted-foreground">{section.note}</p>}
                </div>
              </details>
            ))}
            {/* THE ACCIDENT THIS EXISTS TO PREVENT: an empty criteria set legitimately means "everyone",
                and there is no way for the resolver to tell that apart from a form nobody finished. Said
                out loud rather than guessed at, because the resolver deliberately does not second-guess an
                explicit request. */}
            {!anyCriteria && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('adjustmentsEveryoneWarning')}
              </p>
            )}
          </div>
        ) : (
          /**
           * r288 (8521e160) — PICK INDIVIDUALLY IS A PICKER HERE TOO. TWO WAYS IN, ONE LIST OUT.
           *
           * WHAT WAS HERE: this box alone, under a help string inviting a paste of "employee references".
           * It has never accepted a reference OR a name — `resolveAdjustmentTargets` puts the contents
           * into `employment.id IN (…)` against a **uuid** column, so typing "Irwin" does not match
           * nothing, it makes Postgres reject the statement, the preview action rejects, and this screen's
           * catch left the PENDING sentence standing forever. Verified against a real database, not
           * reasoned about (test/r288-employee-pickers.test.ts §A).
           *
           * THE PICKER IS THE HOUSE ONE, AND IT IS r287's, NOT A THIRD. `MultiSelectPopover` with the two
           * opt-in props that round added — `matchOption` (the house `matchesEmployeeSearch`) and
           * `emptyLabelFor` (a search that finds nobody must SAY SO and name what was searched). Its form
           * contract does the rest: one hidden `employmentIds` input per chosen id, rendered OUTSIDE its
           * open/closed guard, so what is posted survives the panel closing before submit.
           *
           * THE PASTE BOX STAYS. It is how a bulk adjustment is set up today and deleting it would be an
           * unrequested regression. The two fields are merged by ONE shared rule
           * (`lib/employment-selection.ts`) that the live count above and `applyLeaveAdjustmentAction` both
           * call, so the population this screen confirms cannot differ from the one the batch adjusts.
           *
           * NO SERVER-SIDE SEARCH, DELIBERATELY — the same call r287 made on Generate: the list is already
           * read by the page and filtering it in the browser beats a round trip.
           */
          <div className="space-y-3">
            <MultiSelectPopover
              name="employmentIds"
              label={t('adjustmentsEmployeePicker')}
              allLabel={t('adjustmentsEmployeeNoneChosen')}
              options={employeeOptions}
              selected={picked}
              onChange={applyPicked}
              searchPlaceholder={t('adjustmentsEmployeeSearchPlaceholder')}
              selectAllLabel={t('adjustmentsSelectAll')}
              clearAllLabel={t('adjustmentsDeselectAll')}
              selectedCount={(n) => t('multiSelectSelectedCount', { count: n })}
              matchOption={matchEmployee}
              // THE TERMINAL STATE THE COMPLAINT IS ABOUT: a search that finds nobody says so, and names
              // what was searched. An empty panel asserts nothing (CLAUDE.md §8).
              emptyLabelFor={(query) => t('adjustmentsEmployeeNoMatch', { query })}
            />
            {pickedRows.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {pickedRows.map((e) => {
                  const chipLabel = e.employeeCode ? `${e.name} · ${e.employeeCode}` : e.name;
                  return (
                    <span
                      key={e.id}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
                    >
                      {chipLabel}
                      <button
                        type="button"
                        aria-label={chipRemove(chipLabel)}
                        title={chipRemove(chipLabel)}
                        onClick={() => unpick(e.id)}
                        className="grid size-4 shrink-0 place-items-center rounded-full text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                {t('adjustmentsEmployeeNonePicked')}
              </p>
            )}
            <Field label={t('adjustmentsPasteAlternative')}>
              {/* Controlled, so the count and the Next button move on the keystroke rather than 250ms later
                  when the debounced count happens to run. The field name and what the server does with it
                  are UNCHANGED — this round changed the control, not the contract. */}
              <textarea
                name="employmentIdsRaw"
                rows={3}
                value={pastedRaw}
                onChange={(e) => setPastedRaw(e.target.value)}
                className={cn(inputCls, 'w-full font-mono text-xs')}
              />
              <p className="pt-1 text-[11px] text-muted-foreground">{t('adjustmentsPasteAlternativeHelp')}</p>
            </Field>
          </div>
        )}

        {/* The reporter's "Employees matched / 186 Employees". A real number from the real resolver, as at
            the real effective date — 491c499f shipped only a static "this will match everyone" warning and
            countAdjustmentTargets sat with ZERO callers until this item. */}
        <div className="flex items-baseline justify-between rounded-lg border border-border px-3 py-2">
          <span className="text-xs text-muted-foreground">{t('adjustmentsMatched')}</span>
          {/* r288 — THREE STATES, NOT TWO. A count, a PENDING sentence, and — new — a TERMINAL sentence
              for a count that failed. Before this round the third collapsed into the second and the screen
              sat on "Working it out…" over an error it had already received. */}
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {matchedCount != null
              ? t('adjustmentsMatchedCount', { count: matchedCount })
              : previewFailed
                ? t('adjustmentsMatchedUnknown')
                : t('adjustmentsMatchedPending')}
          </span>
        </div>
      </section>

      {/* ── ③ Adjustment Details ───────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('details'))}>
        <Field label={t('adjustmentsDays')}>
          {/* min=0: the DIRECTION is step 1's business now, so a negative amount here would be a second,
              contradictory way to say "deduct". The action takes the absolute value regardless. */}
          {/* 4a1abc4a: the amount tidies to 2dp on blur, so the figure HR types is the figure they will
              later read back off the ledger row and the balance summary. Starts EMPTY and stays empty
              until typed — an adjustment of "0.00 days" is not a default anybody should be nudged into. */}
          <input
            name="days"
            type="number"
            step="0.5"
            min="0"
            onBlur={normalizeDayFieldOnBlur}
            className={cn(inputCls, 'w-full')}
          />
        </Field>
        <p className="text-xs text-muted-foreground">{t('adjustmentsDaysHelp')}</p>
        <Field label={t('adjustmentsEffectiveOn')}>
          <input name="effectiveOn" type="date" defaultValue={today} className={cn(inputCls, 'w-full')} />
        </Field>
        <Field label={t('adjustmentsReason')}>
          <input name="reason" type="text" maxLength={200} className={cn(inputCls, 'w-full')} />
        </Field>
        <p className="text-xs text-muted-foreground">{t('adjustmentsReasonHelp')}</p>
        {/* The reporter asked for an optional Remarks field. There is no column for one on
            leave_adjustment_batch and this item ships no migration, so rather than quietly dropping the
            request the screen says where the note belongs instead. */}
        <p className="text-xs text-muted-foreground">{t('adjustmentsRemarksNote')}</p>
      </section>

      {/* ── ④ Review & Process ─────────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('review'))}>
        <ReviewPanel preview={preview} summary={summary} leaveTypes={leaveTypes} />
      </section>

      {/* Back / Next / Process — one row, so the walk has an obvious direction from every step. */}
      <div className="flex items-center gap-2">
        {stepIndex > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => goto(stepIndex - 1)}>
            {t('adjustmentsBack')}
          </Button>
        )}
        {step !== 'review' ? (
          <Button type="button" size="sm" onClick={() => goto(stepIndex + 1)} disabled={nextBlocked}>
            {t('adjustmentsNext')}
          </Button>
        ) : (
          canProcess && (
            <Button type="submit" size="sm">
              {t('adjustmentsSubmit')}
            </Button>
          )
        )}
        {/* r288 — WHY Next IS OFF, beside the button that is off. A disabled control with no sentence is the
            same silence the pending string was. Scoped to Pick individually on purpose: an EMPTY criteria
            set legitimately means "everyone" and has its own warning above. */}
        {nextBlocked && <span className="text-[11px] text-muted-foreground">{t('adjustmentsEmployeeNonePicked')}</span>}
      </div>
    </form>
  );
}

/**
 * Step 4's summary + the automatic validation the reporter asked for.
 *
 * Purely presentational: BOTH halves of what it shows — the operator's own inputs (`summary`) and the
 * server's answer about them (`preview`) — were captured in the SAME pass of `refreshPreview`. That is the
 * point. A review panel that re-reads the form for the left column while the right column carries a count
 * taken at some other moment is a review that can describe two different batches at once; and reading the
 * form during render means reaching into a ref during render, which React explicitly does not guarantee.
 */
function ReviewPanel({
  preview,
  summary,
  leaveTypes,
}: {
  preview: AdjustmentPreview | null;
  summary: ReviewSummary | null;
  leaveTypes: Opt[];
}) {
  const t = useTranslations('admin.leave');
  const pickedTypeIds = summary?.leaveTypeIds ?? [];
  const labelOf = new Map(leaveTypes.map((x) => [x.value, x.label]));
  const amount = summary?.amount ?? 0;
  const deduct = summary?.deduct ?? false;
  const effectiveOn = summary?.effectiveOn ?? '';
  const reason = summary?.reason ?? '';
  const employees = preview?.employees ?? 0;

  // Nothing to process ⇒ say so instead of showing a summary of nothing. The parent hides the Process
  // button on the same condition (`canProcess`), so the two can never disagree about whether this batch
  // is ready.
  if ((preview?.targeted ?? 0) === 0) {
    return <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('adjustmentsReviewNothing')}</p>;
  }

  const row = (key: string, label: string, value: string) => (
    <div key={key} className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );

  /** One issue, in words. A switch over LITERAL keys so the i18n guard can see every one of them. */
  const issueText = (issue: { kind: string; count: number; leaveTypeName?: string }): string => {
    const leaveType = issue.leaveTypeName ?? '';
    switch (issue.kind) {
      case 'not_found':
        return t('adjustmentsIssueNotFound', { count: issue.count });
      case 'inactive':
        return t('adjustmentsIssueInactive', { count: issue.count });
      case 'not_eligible':
        return t('adjustmentsIssueNotEligible', { count: issue.count, leaveType });
      case 'frozen':
        return t('adjustmentsIssueFrozen', { count: issue.count, leaveType });
      default:
        return '';
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border px-3 py-1">
        {row('types', t('adjustmentsStepTypes'), pickedTypeIds.map((id) => labelOf.get(id) ?? id).join(', '))}
        {/* "+2 Days" / "−2 Days" — the reporter's mock, and the unit matters: this ledger is in DAYS and
            nothing on this screen accepts hours. */}
        {row('amount', t('adjustmentsAdjustmentType'), `${deduct ? '−' : '+'}${amount} ${t('adjustmentsDays')}`)}
        {row('who', t('adjustmentsMatched'), t('adjustmentsMatchedCount', { count: employees }))}
        {row('when', t('adjustmentsEffectiveOn'), effectiveOn)}
        {row('why', t('adjustmentsReason'), reason)}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('adjustmentsReviewRecords', {
          records: preview?.targeted ?? 0,
          types: pickedTypeIds.length,
          employees,
        })}
      </p>

      <div className="rounded-lg border border-border px-3 py-2">
        <span className="block text-xs font-semibold text-foreground">{t('adjustmentsIssuesTitle')}</span>
        {preview && preview.issues.length > 0 ? (
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {preview.issues.map((issue, i) => (
              <li key={`${issue.kind}-${issue.leaveTypeName ?? ''}-${i}`} className="text-xs text-foreground">
                {issueText(issue)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">{t('adjustmentsIssuesNone')}</p>
        )}
      </div>
    </div>
  );
}
