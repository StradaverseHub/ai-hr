'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { MultiSelectPopover } from '@/components/ui/multi-select-popover';
import { SubStepBar } from '@/components/leave-sub-step-bar';
import { Button, Field, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import { matchesEmployeeSearch } from '@/lib/employee-search';
import { mergeEmploymentSelection, resolveEmploymentSelection } from '@/lib/employment-selection';
import type { EmployeePickOption } from '@/lib/employment-selection';
import type { CriteriaSection } from '@/core/org-criteria-form';
import type { LeaveGenerationResult } from '@/core/leave-generation';

type Opt = { value: string; label: string };

/**
 * r287 — ONE EMPLOYMENT, AS THE PICKER NEEDS IT. Three plain fields, nothing formatted: the server page
 * hands over data, this client component composes every string it shows.
 *
 * r288 (8521e160) MOVED THE DECLARATION to `lib/employment-selection.ts`, beside the merge rule, because
 * Leave Adjustments and Notice Board now mount the same picker over the same population and a copy per
 * screen is a copy per screen to keep in step with `listEmployees`. Re-exported here under the name r287
 * gave it so this file's importers are undisturbed; the shape is unchanged.
 */
export type { EmployeePickOption };
type Action = (fd: FormData) => void | Promise<void>;
type PreviewAction = (p: {
  year: number;
  leaveTypeIds: string[];
  targetMode: 'criteria' | 'individual';
  criteria: Record<string, string[] | string>;
  employmentIds: string[];
}) => Promise<LeaveGenerationResult>;

/**
 * 93249794 — GENERATE ENTITLEMENT as the reporter's five-step internal flow.
 *
 * ① Leave Selection · ② Generation Settings · ③ Employee Selection · ④ Validation & Preview · ⑤ Process.
 *
 * This REPLACES the plain year-and-a-button page 4b0e76ae shipped, in place, exactly as that page's own
 * header said it would ("the wizard replaces it in place"). The Process button still posts to
 * `openLeaveYearAction` — the ONE route from a browser to the grant sweep, guarded as such by
 * test/leave-generate-page.test.ts — so a leave year remains openable at every point in this change.
 *
 * ── WHAT MAKES STEP ④ TRUSTWORTHY ─────────────────────────────────────────────────────────────────────
 * It is not a checklist. `previewAction` runs the REAL engine with `dryRun: true`, so the verdict shown
 * for each employee is produced by the same pass that will produce the grant. The plan's build notes are
 * explicit that anything else drifts, and this component is deliberately incapable of drifting: it renders
 * `result.lines` and knows nothing about how a day is composed.
 *
 * ── EVERY STEP STAYS MOUNTED. LOAD-BEARING, NOT LAZINESS ──────────────────────────────────────────────
 * The whole flow is ONE <form> with ONE submit, so an unmounted step is a step whose values do not post.
 * Steps are hidden with a class, never unmounted — the AdjustmentForm contract, and the same consequence
 * follows: no input carries `required`, because a hidden `required` control makes the browser refuse to
 * submit with an unfocusable-control error nobody can act on. The server action and `runLeaveGeneration`
 * remain the authority.
 *
 * ── THE STEP BAR AND THE CRITERIA PICKER ARE REUSED, NOT REINVENTED ───────────────────────────────────
 * `components/leave-sub-step-bar.tsx` carries an explicit reuse contract in its header. The criteria
 * sections arrive as plain data from `buildOrgCriteriaSections` (core/org-criteria-form.ts) — the SAME
 * builder the Leave Adjustments screen uses — so the two screens cannot come to offer different axes.
 *
 * ── WHY THE COPY IS READ HERE AND THE CRITERIA ARRIVE AS PROPS ────────────────────────────────────────
 * r124 took a tab down in production by passing a server translator CLOSURE into a client component;
 * test/server-client-boundary.test.ts pins that class. So this component calls `useTranslations` itself
 * (one namespace, which also puts every key in front of the i18n guard's check C), while the criteria
 * sections arrive as serialisable data because their labels are paired with catalogue rows only the server
 * can read. `action` / `previewAction` are the exception the framework allows.
 */

/** The five steps, in walk order. These strings are STORAGE KEYS — renaming one strands every browser. */
const STEP_KEYS = ['types', 'settings', 'employees', 'validate', 'process'] as const;
type StepKey = (typeof STEP_KEYS)[number];

/**
 * Where a persisted step key that must NOT be restored verbatim lands instead.
 *
 * 'validate' and 'process' are both here for a real reason. Neither renders anything of its own — both are
 * DERIVED from the three steps in front of them plus a server preview, and a fresh page load has already
 * discarded that form state. Restoring a browser straight onto either would show a summary of nothing,
 * which is the blank-screen failure the `RETIRED_*_SUB_STEP` remaps exist to prevent.
 *
 * THE SAME TABLE IS THE RETIREMENT MECHANISM. When a step is later removed or renamed its old key goes
 * here pointing at wherever its content went — never just deleted, because an unmapped stored key is
 * invisible: this is PER-BROWSER state no test and no render can see, and the only person who finds out is
 * the user who lands somewhere blank.
 */
const STEP_REMAP: Record<string, StepKey> = { validate: 'types', process: 'types' };

const STORAGE_KEY = 'leaveGenerateFlow';

/** The Step ⑤ confirmation, captured from the form at the same moment the preview is asked for. */
type ReviewSummary = { year: string; leaveTypeIds: string[] };

export function GenerateForm({
  action,
  previewAction,
  years,
  defaultYear,
  leaveTypes,
  criteriaSections,
  employees,
}: {
  action: Action;
  previewAction: PreviewAction;
  years: number[];
  defaultYear: number;
  leaveTypes: Opt[];
  criteriaSections: CriteriaSection[];
  /**
   * r287 — every employment the signed-in administrator's companies hold, read once by the server page.
   * REQUIRED, not optional: an optional list defaulting to `[]` would render a picker that silently
   * offers nobody on any page that forgot to pass it, which is the failure this round exists to remove.
   */
  employees: EmployeePickOption[];
}) {
  const t = useTranslations('admin.leave');
  const [step, setStep] = useState<StepKey>('types');
  const [mode, setMode] = useState<'criteria' | 'individual'>('criteria');
  const [anyCriteria, setAnyCriteria] = useState(false);
  const [preview, setPreview] = useState<LeaveGenerationResult | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [, startPreview] = useTransition();
  /**
   * r287 — DID THE LAST PREVIEW FAIL? This flag is the reporter's screenshot.
   *
   * `refreshPreview` swallows a rejected preview and sets `preview` back to null, and null was rendered as
   * "Working it out…" — the PENDING sentence. So a preview that threw was indistinguishable from one still
   * in flight, and the screen sat on "Working it out…" forever with no result and no reason.
   *
   * It threw for a reason worth writing down: `employmentIdsRaw` is fed to `resolveOrgCriteriaTargets` as
   * `IN (…)` against `employment.id`, a **uuid** column. Typing a NAME there does not "match nothing" —
   * Postgres rejects the statement outright (`invalid input syntax for type uuid: "Irwin"`), the action
   * rejects, and this catch runs. The picker below is why an operator no longer has to type into it, and
   * this flag is why the screen says so when something still does.
   */
  const [previewFailed, setPreviewFailed] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── ③ PICK INDIVIDUALLY: two ways in, one list out ──────────────────────────────────────────────────
  // The popover's chosen ids, and the paste box's text. Both are held HERE rather than read off the form
  // for display, because the Next button and the chip strip must update on the keystroke, not 250ms later
  // when the debounced preview happens to run. What is POSTED is still the form's own fields, and
  // `refreshPreview` still reads those — see its header.
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [pastedRaw, setPastedRaw] = useState('');

  // Hydrate the persisted step in an effect (client-only ⇒ no SSR hydration mismatch), the same trade-off
  // LeaveTypePanel and AdjustmentForm both make. eslint's react-hooks/set-state-in-effect flags the setStep
  // and this is the one shape where that is unavoidable and correct: localStorage does not exist on the
  // server, so a lazy useState initialiser would return a different value on each side. Do not "fix" this
  // into an initialiser.
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
   * Ask the server what this form currently resolves to — a DRY RUN of the real generation.
   *
   * Reads the LIVE form rather than mirrored state, so the answer is computed from exactly the values that
   * would post, including the year sitting on a step that is not on screen. Every criterion is resolved as
   * at 1 January of that year, so the year is not optional context — it changes who matches.
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
    const year = String(fd.get('year') ?? '');
    // Snapshotted HERE, in the same pass that asks for the preview, rather than read off the form again
    // while Step ⑤ renders: reading a ref during render is a React rule violation that can silently miss
    // an update, and the confirmation and the counts must describe the SAME form.
    setSummary({ year, leaveTypeIds });
    const payload = {
      year: Number(year),
      leaveTypeIds,
      targetMode: mode,
      criteria: mode === 'criteria' ? criteria : {},
      // r287 — THE SAME MERGE THE WRITE PATH USES (lib/employment-selection.ts), over the SAME two fields,
      // read off the LIVE form so the preview describes exactly what a submit would post. If these two
      // ever parse differently the screen confirms one population and the sweep grants to another, and
      // both halves' tests still pass — which is why the rule is one shared function, not two.
      //
      // r289 — …and over the SAME population. `employees` is the third argument because an Employee ID
      // only becomes an employment id against a list of employments; `openLeaveYearAction` reads the
      // identical list server-side before merging, so a pasted `EMP-0008` means the same person here as
      // it does on submit.
      employmentIds:
        mode === 'individual'
          ? mergeEmploymentSelection(
              fd.getAll('employmentIds').map(String),
              String(fd.get('employmentIdsRaw') ?? ''),
              employees,
            )
          : [],
    };
    startPreview(async () => {
      try {
        setPreview(await previewAction(payload));
        setPreviewFailed(false);
      } catch {
        // A failed preview must not block the flow or invent a number. It must also not go on claiming to
        // be working: `previewFailed` is what lets the screen print a terminal sentence instead of the
        // pending one. The write path validates independently.
        setPreview(null);
        setPreviewFailed(true);
      }
    });
  };

  /** Debounced, because this fires on every chip toggle and every keystroke in the employee box. */
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
  // Re-ask on mount and whenever the targeting mode flips: the two modes resolve different sets.
  useEffect(refreshPreview, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepIndex = STEP_KEYS.indexOf(step);
  const goto = (i: number) => selectStep(STEP_KEYS[Math.min(Math.max(i, 0), STEP_KEYS.length - 1)]);
  const shown = (key: StepKey) => (step === key ? undefined : 'hidden');
  const chipRemove = (label: string) => t('chipRemoveAria', { name: label });

  // ── r287 · THE EMPLOYEE PICKER'S DERIVED DATA ───────────────────────────────────────────────────────
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
  // so "emp0008" finds "EMP-0008". A picker that prints an Employee ID and then cannot find it when typed
  // is the same broken promise the paste box made.
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
  //
  // r289 — AND WHAT IT COULD NOT READ. `unmatched` is what lets the box stop failing silently: paste twelve
  // references, get two wrong, and the screen names the two. It is a MESSAGE, not a gate — both tokens are
  // still inside `ids`, still posted, and still answer to `resolveOrgCriteriaTargets`. Dropping them here
  // would turn a twelve-person run into a ten-person run that looked like it worked.
  const selection = useMemo(
    () => resolveEmploymentSelection([...picked], pastedRaw, employees),
    [picked, pastedRaw, employees],
  );
  const individualIds = selection.ids;
  /**
   * THE ONE WRITER for the picked set (the ChipMultiSelect `apply` idiom). The popover and the chips' ×
   * are two views of ONE selection, so removing a chip and unticking the row are the same operation and
   * the two can never disagree about who the run will cover.
   *
   * ⚠️ `schedulePreview` is not optional here. A checkbox inside the popover is not a `change` the
   * enclosing `<form onChange>` hears — the same trap ChipMultiSelect's `onSelectionChange` docblock
   * names — so without this the matched count would go on describing the previous selection.
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
   * Is there anything to process? `employeesReached` is what the ENGINE actually visited — selected AND
   * active across the year boundary — not what the criteria matched. Those differ whenever somebody
   * selects a group that was all hired during the year, and offering Process for a run that will do
   * nothing is how an operator concludes the feature is broken.
   */
  const canProcess = (preview?.employeesReached ?? 0) > 0;
  /**
   * r287 — Next is OFF while Pick individually has nobody in it. The plan's words: "keep Next switched off
   * until at least one is chosen."
   *
   * ONLY on step ③, and ONLY in individual mode. In CRITERIA mode an empty set is a legitimate choice
   * meaning "everyone" (`generateEveryoneWarning` says so on screen), so blocking it there would break the
   * behaviour the bare Generate button this screen replaces has always had.
   */
  const nextBlocked = step === 'employees' && mode === 'individual' && individualIds.length === 0;
  // r301 (e5018593) — an earned Annual Leave line the accrual REACHED is not an issue: its days are added (or
  // already were). The server decided that (`earnedAccrual`); this reads the flag and restates nothing.
  const failures = (preview?.lines ?? []).filter(
    (l) => l.outcome !== 'granted' && l.outcome !== 'already_open' && l.earnedAccrual === null,
  );
  /**
   * r301 — "Entitlement to grant", one row per leave type: the `granted` lines the engine returned, counted
   * and summed. A tally of the server's own lines for display, not a composition — each line's `days` is
   * the figure the run will post, and a pair is an employee within one type.
   */
  const grantRows = useMemo(() => {
    const byType = new Map<string, { leaveTypeId: string; leaveTypeName: string; employees: number; days: number }>();
    for (const l of preview?.lines ?? []) {
      if (l.outcome !== 'granted') continue;
      const row = byType.get(l.leaveTypeId) ?? { leaveTypeId: l.leaveTypeId, leaveTypeName: l.leaveTypeName, employees: 0, days: 0 };
      row.employees += 1;
      row.days = Math.round((row.days + l.days) * 100) / 100;
      byType.set(l.leaveTypeId, row);
    }
    return [...byType.values()].sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
  }, [preview]);
  const accrual = preview?.accrual ?? null;

  return (
    <form ref={formRef} action={action} className="space-y-5" onChange={schedulePreview}>
      <SubStepBar
        ariaLabel={t('generateFlowAria')}
        active={step}
        onSelect={(k) => selectStep(k as StepKey)}
        steps={[
          { key: 'types', label: t('generateStepTypes') },
          { key: 'settings', label: t('generateStepSettings') },
          { key: 'employees', label: t('generateStepWho') },
          { key: 'validate', label: t('generateStepValidate') },
          { key: 'process', label: t('generateStepProcess') },
        ]}
      />

      {/* ── ① Leave Selection ─────────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('types'))}>
        <Field label={t('yearLabel')}>
          <select name="year" defaultValue={String(defaultYear)} className={`${inputCls} w-28`}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <ChipMultiSelect
          name="leaveTypeIds"
          // NOT `generateStepTypes` — that is the STEP's name ("Leave Selection"), and using it here put
          // two controls with the same accessible name on one screen. Found by rendering it. This is the
          // FIELD's name, reused from the Adjustments flow where it already ships in all six locales.
          label={t('adjustmentsStepTypes')}
          options={leaveTypes}
          addPlaceholder={t('eligibilityChipAddPlaceholder')}
          removeLabelFor={chipRemove}
          searchPlaceholder={t('adjustmentsSearchPlaceholder')}
          selectAllLabel={t('adjustmentsSelectAll')}
          clearAllLabel={t('adjustmentsDeselectAll')}
          // A chip is a <button>, so toggling one fires NO form change event — without this the preview
          // would keep describing the previous set of leave types.
          onSelectionChange={schedulePreview}
        />
        {/* Picking none is a real and useful choice, not an unfinished form — it is what the button this
            page replaces always did. Said out loud so nobody reads an empty picker as an error. */}
        <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">{t('generateAllTypesNote')}</p>
      </section>

      {/* ── ② Generation Settings ─────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('settings'))}>
        {/* THREE HONEST NOTES INSTEAD OF THREE CONTROLS THAT WOULD LIE.
            • Prorate for new employees is not a decision this sweep makes: it only ever visits employments
              hired BEFORE the year starts, and a joiner's prorated grant is posted at hire.
            • Generate Leave Until <month> CHANGES WHAT THE CALCULATION DOES — it is a new proration rule
              the hire grant, the accrual engine and the recalc kernel would all have to learn in the same
              breath or the next profile save would claw the difference back.
            • Recalculate Previous Year rewrites a closed year's ledger history. The approved plan puts it
              in release two behind its own preview and its own confirmation.
            A disabled checkbox implies "switch this on later and it works". A sentence does not. */}
        <p className="text-xs text-muted-foreground">{t('generateSettingsIntro')}</p>
        <ul className="space-y-2">
          {(['Prorate', 'UntilMonth', 'Recalc'] as const).map((k) => (
            <li key={k} className="rounded-lg border border-border bg-card/40 px-3 py-2">
              <span className="block text-xs font-semibold text-foreground">{t(`generateSetting${k}`)}</span>
              <span className="block pt-1 text-[11px] text-muted-foreground">{t(`generateSetting${k}Note`)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── ③ Employee Selection ──────────────────────────────────────────────────────────────────── */}
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
            {/* Said once, at the top, because it governs EVERY control below it: the criteria are resolved
                as at 1 January of the chosen year, not as at today. An operator who does not know that
                cannot reproduce their own matched count. */}
            <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              {t('generateAsAtNote')}
            </p>
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
                        // A ChipMultiSelect row is a <button>, so picking a department fires no `change` on
                        // the form and the form-level listener never hears it. Both hooks are needed.
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
                and the resolver deliberately does not second-guess an explicit request. */}
            {!anyCriteria && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('generateEveryoneWarning')}
              </p>
            )}
          </div>
        ) : (
          /**
           * r287 (ff1c935f) — PICK INDIVIDUALLY IS A PICKER NOW. TWO WAYS IN, ONE LIST OUT.
           *
           * WHAT WAS HERE: this box alone. Its help text invites you to "paste employee references", but
           * what `resolveOrgCriteriaTargets` does with the contents is `employment.id IN (…)` against a
           * **uuid** column — so the box has never accepted a reference OR a name. Typing "Irwin" does not
           * match nothing; Postgres rejects the statement (`invalid input syntax for type uuid`), the
           * preview action rejects, and the screen sat on "Working it out…". The reporter was right to
           * call it a bug, and right that it is not a search box.
           *
           * THE PICKER IS THE HOUSE ONE. `MultiSelectPopover` — the same control behind Run Earned Accrual
           * and Location Assignment — not a second multi-select. Its form contract does the work: one
           * hidden `employmentIds` input per chosen id, rendered OUTSIDE its open/closed guard, so what is
           * posted survives the panel closing before submit.
           *
           * THE PASTE BOX STAYS. It is how a bulk run is set up today and deleting it would be an
           * unrequested regression. The two fields are merged by ONE shared rule
           * (`lib/employment-selection.ts`) that the live preview above and `openLeaveYearAction` both
           * call, so the population this screen confirms cannot differ from the one the sweep grants to.
           *
           * NO SERVER-SIDE SEARCH, DELIBERATELY. 84 employments on production; the list is already read by
           * the page, and filtering it in the browser is faster than a round trip. If that ever stops being
           * true, the criteria path beside this one already resolves populations server-side through
           * `core/org-criteria.ts` — extend that rather than minting an employee-search endpoint.
           */
          <div className="space-y-3">
            <MultiSelectPopover
              name="employmentIds"
              label={t('generateEmployeePicker')}
              allLabel={t('generateEmployeeNoneChosen')}
              options={employeeOptions}
              selected={picked}
              onChange={applyPicked}
              searchPlaceholder={t('generateEmployeeSearchPlaceholder')}
              selectAllLabel={t('adjustmentsSelectAll')}
              clearAllLabel={t('adjustmentsDeselectAll')}
              selectedCount={(n) => t('multiSelectSelectedCount', { count: n })}
              matchOption={matchEmployee}
              // THE TERMINAL STATE THE COMPLAINT IS ABOUT: a search that finds nobody says so, and names
              // what was searched. An empty panel asserts nothing.
              emptyLabelFor={(query) => t('generateEmployeeNoMatch', { query })}
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
                {t('generateEmployeeNonePicked')}
              </p>
            )}
            <Field label={t('generatePasteAlternative')}>
              {/* Controlled, so the count and the Next button move on the keystroke rather than 250ms
                  later when the debounced preview happens to run. The field name and what the server does
                  with it are UNCHANGED — this round changed the control, not the contract. */}
              <textarea
                name="employmentIdsRaw"
                rows={4}
                value={pastedRaw}
                onChange={(e) => setPastedRaw(e.target.value)}
                className={cn(inputCls, 'w-full font-mono text-xs')}
              />
              <p className="pt-1 text-[11px] text-muted-foreground">{t('generatePasteAlternativeHelp')}</p>
              {/* r289 — WHAT WE COULD NOT READ, NAMED. Rendered only when there is something to say, so a
                  clean paste stays quiet. It is a sentence, never a block: the run still covers everything
                  it can resolve, and these tokens go downstream as typed to resolve to nobody. */}
              {selection.unmatched.length > 0 && (
                <p className="pt-1 text-[11px] font-medium text-destructive">
                  {t('generatePasteUnmatched', { list: selection.unmatched.join(', ') })}
                </p>
              )}
            </Field>
          </div>
        )}
        <p className="text-xs font-medium text-foreground">
          {preview
            ? t('generateMatched', { count: preview.employeesSelected })
            : previewFailed
              ? t('generateMatchedUnknown')
              : t('adjustmentsMatchedPending')}
        </p>
      </section>

      {/* ── ④ Validation & Preview ────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('validate'))}>
        <p className="text-[11px] text-muted-foreground">{t('generateValidationHelp')}</p>
        {preview ? (
          <>
            <dl className="grid grid-cols-3 gap-3">
              {(
                [
                  ['generateValidationSelected', preview.employeesSelected],
                  ['generateValidationPassed', preview.employeesPassed],
                  ['generateValidationFailed', preview.employeesFailed],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="rounded-lg border border-border bg-card/40 px-3 py-2">
                  <dt className="text-[11px] text-muted-foreground">{t(key)}</dt>
                  <dd className="text-lg font-semibold text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            {/* r301 (e5018593) — BOTH PARTS OF THE RUN, SIDE BY SIDE, before anything is written: what the
                year-open will grant, and the earned Annual Leave the same run will add. Both come from the one
                dry run (`previewAction`), so neither can say something the commit will not do. The earned
                half renders only when the engine logged an earned line at all. */}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <span id="generate-grant-title" className="block text-xs font-semibold text-foreground">
                  {t('generateGrantTitle')}
                </span>
                {grantRows.length === 0 ? (
                  <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('generateGrantNone')}</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table aria-labelledby="generate-grant-title" className="w-full text-left text-xs">
                      <thead className="bg-muted/60 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">{t('generateIssuesType')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('generateGrantColEmployees')}</th>
                          <th className="px-3 py-2 text-right font-medium">{t('generateGrantColDays')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {grantRows.map((r) => (
                          <tr key={r.leaveTypeId}>
                            <td className="px-3 py-2 text-foreground">{r.leaveTypeName}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.employees}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.days}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              {accrual && (
                <div className="min-w-0 space-y-1.5">
                  <span id="generate-accrual-title" className="block text-xs font-semibold text-foreground">
                    {t('generateAccrualTitle')}
                  </span>
                  {accrual.annualLeaveLines > 0 &&
                    (accrual.skippedFutureYear ? (
                      <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {t('generateAccrualFuture', { year: preview.year })}
                      </p>
                    ) : accrual.error !== null ? (
                      // The dry run of the accrual failed. Said before Generate is pressed, with the way to the
                      // tool that tops the days up once the entitlement is in.
                      <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {t.rich('generateAccrualFailed', {
                          reason: accrual.error,
                          link: (chunks) => (
                            <Link href="/admin/leave-config/earned-accrual" className="font-medium underline underline-offset-2">
                              {chunks}
                            </Link>
                          ),
                        })}
                      </p>
                    ) : accrual.byLeaveType.length === 0 ? (
                      <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {t('generateAccrualNothing', { date: accrual.asOf ?? '' })}
                      </p>
                    ) : (
                      <>
                        <div className="overflow-x-auto rounded-lg border border-border">
                          <table aria-labelledby="generate-accrual-title" className="w-full text-left text-xs">
                            <thead className="bg-muted/60 text-muted-foreground">
                              <tr>
                                <th className="px-3 py-2 font-medium">{t('generateIssuesType')}</th>
                                <th className="px-3 py-2 text-right font-medium">{t('generateAccrualColToppedUp')}</th>
                                <th className="px-3 py-2 text-right font-medium">{t('generateAccrualColUpToDate')}</th>
                                <th className="px-3 py-2 text-right font-medium">{t('generateGrantColDays')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {accrual.byLeaveType.map((r) => (
                                <tr key={r.leaveTypeId}>
                                  <td className="px-3 py-2 text-foreground">{r.leaveTypeName}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.posted}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.upToDate}</td>
                                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.days}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {t('generateAccrualAsAt', { date: accrual.asOf ?? '' })}
                        </p>
                      </>
                    ))}
                  {accrual.notAnnualLeaveLines > 0 && (
                    <p className="rounded-lg bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                      {t('generateAccrualNotAnnualLeave', { count: accrual.notAnnualLeaveLines })}
                    </p>
                  )}
                </div>
              )}
            </div>
            {failures.length === 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('generateIssuesNone')}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table aria-label={t('generateIssuesAria')} className="w-full text-left text-xs">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('generateIssuesEmployee')}</th>
                      <th className="px-3 py-2 font-medium">{t('generateIssuesType')}</th>
                      <th className="px-3 py-2 font-medium">{t('generateIssuesReason')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {failures.map((l) => (
                      <tr key={`${l.employmentId}|${l.leaveTypeId}`}>
                        <td className="px-3 py-2 text-foreground">{l.employeeName}</td>
                        <td className="px-3 py-2 text-muted-foreground">{l.leaveTypeName}</td>
                        {/* The engine's own verdict, translated for display only. The stored value stays
                            the engine's string so a support question is answerable by grepping.
                            r299 (3de1453a): an `earned_method` line on a type that is NOT Annual Leave carries
                            the server's `earnedMethodNotAnnualLeave` — nothing will add its days, so it must
                            not read "accrues through the year". Annual Leave keeps the outcome's own label. */}
                        <td className="px-3 py-2 text-muted-foreground">
                          {l.earnedMethodNotAnnualLeave
                            ? t('generateOutcomeEarnedMethodNotAnnualLeave')
                            : t(`generateOutcome_${l.outcome}`)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* 6e9a126e — WHICH RULE DECIDED THIS EMPLOYEE. Empty for every tenant today: the entitlement
                template layer shipped in release one and no granting engine reads it until release two, so
                the section simply does not render rather than showing an empty promise. */}
            {preview.decidedBy.length > 0 && (
              <div className="space-y-1 rounded-lg border border-border bg-card/40 px-3 py-2">
                <span className="block text-xs font-semibold text-foreground">{t('generateDecidedByTitle')}</span>
                <p className="text-[11px] text-muted-foreground">{t('generateDecidedByNote')}</p>
                <ul className="space-y-0.5 pt-1">
                  {preview.decidedBy.map((d) => (
                    <li key={d.employmentId} className="text-[11px] text-muted-foreground">
                      {/* r193: a NULL rule is not a missing rule — it is a leave type with exactly one
                          entitlement table and no rule in force, which needs none. Naming a rule that does
                          not exist (or rendering the word "null") is what made this feel like the product
                          wanted a second setup. It gets its own sentence instead. */}
                      {d.ruleName == null
                        ? t('generateDecidedBySoleLine', { template: d.templateName })
                        : t('generateDecidedByLine', {
                            rule: d.ruleName,
                            template: d.templateName,
                            also: d.alsoMatched,
                          })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          // r287 — the same three-state rule as step ③: a preview that FAILED says so rather than
          // going on claiming to be working.
          <p className="text-xs text-muted-foreground">
            {previewFailed ? t('generateMatchedUnknown') : t('adjustmentsMatchedPending')}
          </p>
        )}
      </section>

      {/* ── ⑤ Process ─────────────────────────────────────────────────────────────────────────────── */}
      <section className={cn('space-y-3', shown('process'))}>
        {canProcess && summary ? (
          <>
            <dl className="space-y-1 rounded-lg border border-border bg-card/40 px-3 py-3 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('yearLabel')}</dt>
                <dd className="font-medium text-foreground">{summary.year}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t('generateStepTypes')}</dt>
                <dd className="font-medium text-foreground">
                  {summary.leaveTypeIds.length === 0
                    ? t('generateReviewAllTypes')
                    : t('generateReviewTypeCount', { count: summary.leaveTypeIds.length })}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                {/* REACHED, not SELECTED, and it gets its own label because the two are different
                    numbers: the selection is what the criteria matched, the reach is who the sweep will
                    actually visit once its own year-boundary eligibility is applied. Labelling both
                    "Employees selected" put one word over two figures. */}
                <dt className="text-muted-foreground">{t('generateReviewEmployees')}</dt>
                <dd className="font-medium text-foreground">{preview?.employeesReached ?? 0}</dd>
              </div>
            </dl>
            <p className="text-[11px] text-muted-foreground">{t('generateProcessNote')}</p>
            <Button type="submit" size="sm">
              {t('generateButton')}
            </Button>
          </>
        ) : (
          <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t('generateNothingToProcess')}
          </p>
        )}
      </section>

      {/* Back / Next — one row, so the walk has an obvious direction from every step. Process lives INSIDE
          step ⑤ beside its confirmation, never out here: a submit button visible from step ① is a way to
          generate a year's entitlement without ever reading the validation. */}
      <div className="flex items-center gap-2">
        {stepIndex > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={() => goto(stepIndex - 1)}>
            {t('adjustmentsBack')}
          </Button>
        )}
        {stepIndex < STEP_KEYS.length - 1 && (
          <Button type="button" size="sm" onClick={() => goto(stepIndex + 1)} disabled={nextBlocked}>
            {t('adjustmentsNext')}
          </Button>
        )}
        {/* r287 — WHY Next IS OFF, beside the button that is off. A disabled control with no sentence is
            the same silence the pending string was. Scoped to Pick individually on purpose: an EMPTY
            criteria set legitimately means "everyone" and has its own warning above. */}
        {nextBlocked && <span className="text-[11px] text-muted-foreground">{t('generateEmployeeNonePicked')}</span>}
      </div>
    </form>
  );
}
