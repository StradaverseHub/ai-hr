'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';

import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { SubStepBar } from '@/components/leave-sub-step-bar';
import { Button, Field, inputCls } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { CriteriaSection } from '@/core/org-criteria-form';
import type { LeaveGenerationResult } from '@/core/leave-generation';

type Opt = { value: string; label: string };
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
}: {
  action: Action;
  previewAction: PreviewAction;
  years: number[];
  defaultYear: number;
  leaveTypes: Opt[];
  criteriaSections: CriteriaSection[];
}) {
  const t = useTranslations('admin.leave');
  const [step, setStep] = useState<StepKey>('types');
  const [mode, setMode] = useState<'criteria' | 'individual'>('criteria');
  const [anyCriteria, setAnyCriteria] = useState(false);
  const [preview, setPreview] = useState<LeaveGenerationResult | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [, startPreview] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      employmentIds:
        mode === 'individual'
          ? String(fd.get('employmentIdsRaw') ?? '')
              .split(/[\s,]+/)
              .filter(Boolean)
          : [],
    };
    startPreview(async () => {
      try {
        setPreview(await previewAction(payload));
      } catch {
        // A failed preview must not block the flow or invent a number — the screen says nothing until the
        // next change succeeds. The write path validates independently.
        setPreview(null);
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

  /**
   * Is there anything to process? `employeesReached` is what the ENGINE actually visited — selected AND
   * active across the year boundary — not what the criteria matched. Those differ whenever somebody
   * selects a group that was all hired during the year, and offering Process for a run that will do
   * nothing is how an operator concludes the feature is broken.
   */
  const canProcess = (preview?.employeesReached ?? 0) > 0;
  const failures = (preview?.lines ?? []).filter((l) => l.outcome !== 'granted' && l.outcome !== 'already_open');

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
          <Field label={t('adjustmentsEmploymentIds')}>
            {/* Parsed SERVER-side out of this one block (the Notice Board / Adjustments idiom) rather than
                mirrored into hidden inputs, so the ids the action sees are the ids the user typed. */}
            <textarea name="employmentIdsRaw" rows={4} className={cn(inputCls, 'w-full font-mono text-xs')} />
            <p className="pt-1 text-[11px] text-muted-foreground">{t('adjustmentsEmploymentIdsHelp')}</p>
          </Field>
        )}
        <p className="text-xs font-medium text-foreground">
          {preview
            ? t('generateMatched', { count: preview.employeesSelected })
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
            {failures.length === 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                {t('generateIssuesNone')}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
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
                            the engine's string so a support question is answerable by grepping. */}
                        <td className="px-3 py-2 text-muted-foreground">{t(`generateOutcome_${l.outcome}`)}</td>
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
          <p className="text-xs text-muted-foreground">{t('adjustmentsMatchedPending')}</p>
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
          <Button type="button" size="sm" onClick={() => goto(stepIndex + 1)}>
            {t('adjustmentsNext')}
          </Button>
        )}
      </div>
    </form>
  );
}
