'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
import { fetchPayrollRunEmployees, resumeRunAction, runMultiCompanyAction } from './actions';
import { preferredCycleId, wizardInitialStep } from './selection-logic';
import { StepPeriod, type Company, type CycleRunType, type CycleOption, type ExistingRun } from './steps/step-period';
import { StepSelection, type Master, type PayrollRunEmployeeRow } from './steps/step-selection';
import { StepValidation } from './steps/step-validation';
import { PAYROLL_PHASES, payrollPhaseIndex, type PayrollPhaseKey } from '@/packs/payroll/phases';

/** Payroll Process wizard (3b) — STEPS registry, sequential gating, plain useState. No workflow engine:
 *  future steps slot in as additional entries in `STEPS` (plan §16, guardrail).
 *  R37 70764928: a Validation step now sits between Employee Selection and the terminal Process action,
 *  so the operator sees an explicit green/amber/red "is everything ready?" checkpoint before processing.
 *  Each STEP declares which PAYROLL PHASE (below) it belongs to for the progress rail. */
const STEPS = [
  { key: 'period', titleKey: 'stepPeriod', phase: 'validation' },
  { key: 'selection', titleKey: 'stepSelection', phase: 'validation' },
  { key: 'validation', titleKey: 'stepValidation', phase: 'validation' },
] as const satisfies readonly { key: string; titleKey: string; phase: PayrollPhaseKey }[];

/**
 * a1d82340 STEP 3 — the rail is now the CANONICAL payroll sequence (packs/payroll/phases.ts), the same
 * six phases the Workflow Guide teaches and the same order the sidebar is sorted into.
 *
 * It replaces a five-stage rail of this wizard's own (Preparation → Validation → Process → Review →
 * Finalize, R37 70764928). That rail was not wrong about the work, but it was a THIRD ordering with its
 * own names and its own count, so "Stage 2 of 5" here and "Phase 3 of 6" on the guide named the same
 * moment differently — which is precisely the disagreement step 3 exists to end.
 *
 * The mapping is deliberate and is the honest one:
 *   - phases 1–2 (master data, transactions) happen BEFORE you open this wizard, so they render as
 *     already behind you;
 *   - all three wizard steps sit in phase 3, VALIDATION: choosing the period, choosing who is in the
 *     run and reading the readiness checks are all "confirm this run is right before it is computed".
 *     The finer progression inside the phase is the step counter beside the rail, which is what the
 *     old rail's first two positions were really tracking;
 *   - phase 4, PROCESSING, is the terminal Process button — you are not in it until you press it;
 *   - phases 5–6 (review, finalize) happen on the batch page and stay visible as what comes next.
 */
const PHASE_STEP_COUNT = STEPS.length;

/** A DRAFT batch being resumed. Carries the fixed identity of the existing batch — company/period/cycle
 *  are NOT editable mid-resume (Step 1 shows them READ-ONLY for review, feedback 4f00d8f0; to change
 *  them, delete the draft and create a new run); only the employee selection is editable.
 *  Off-cycle/bonus/adjustment drafts resume too, so cycle/paymentDate/remarks carry through unchanged,
 *  not defaulted back to 'regular'. */
export type ResumeBatch = {
  id: string;
  companyId: string;
  payPeriod: string;
  cycle: CycleRunType;
  paymentDate: string;
  remarks: string;
  scope: { departmentIds?: string[]; employmentIds?: string[] } | null;
};

function defaultPayDate(payPeriod: string, payDay: number | null | undefined): string {
  if (!payPeriod) return '';
  const [y, m] = payPeriod.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  const day = payDay == null ? dim : Math.min(Math.max(1, payDay), dim);
  return `${payPeriod}-${String(day).padStart(2, '0')}`;
}

export function Wizard({
  companies,
  departments,
  businessUnits,
  positions,
  costCenters,
  jobGrades,
  payDayByCompany,
  existingRuns,
  cyclesByCompany,
  defaultCycleByCompany,
  thisMonth,
  multiCycle,
  resumeBatch,
  from,
  adjustmentsPanel,
}: {
  companies: Company[];
  departments: (Master & { businessUnitId: string | null })[];
  businessUnits: Master[];
  positions: Master[];
  costCenters: Master[];
  jobGrades: { id: string; name: string }[];
  payDayByCompany: Record<string, number | null>;
  existingRuns: ExistingRun[];
  cyclesByCompany: Record<string, CycleOption[]>;
  // Organization Module (361e3b15): each company's SAVED default cycle NAME. Drives the Step-1 pre-select for
  // the single/primary company (matched by name against the active options), falling back gracefully.
  defaultCycleByCompany: Record<string, string>;
  thisMonth: string;
  multiCycle: boolean;
  /** When set, the wizard opens in RESUME mode: Step 1 shows the draft's fixed identity READ-ONLY for
   *  review (feedback 4f00d8f0), then Step 2 (Employee Selection) with the selection pre-seeded from the
   *  persisted scope. */
  resumeBatch?: ResumeBatch;
  /** d75b0c11 — the Payroll Process list's own filter query, already whitelisted by shape on the server
   *  (`payrollProcessBack`). Posted with the run so the terminal result screen can send Back to the list
   *  AS IT WAS LEFT; `/payroll/process/result` has read `?from=` since 9066bd6c and never received one,
   *  because a redirect is the only way onto it and neither action carried the value. Undefined on a
   *  wizard opened without a selection, and then nothing is posted at all. */
  from?: string;
  /** 7076f8af — the draft's adjustment panel, RENDERED ON THE SERVER and handed down as a node.
   *
   *  It is a React node, never a function: a server component reaches a client one only by being passed as
   *  a prop or child (this file is `'use client'`, so anything it imported would be bundled and its server
   *  reads would not run). Passing a CLOSURE across this boundary is the failure that shipped to
   *  production once — it type-checks, renders in dev and breaks under a real build. Only the resumed
   *  draft has one; a fresh run has no batch to adjust yet, so the page passes null. */
  adjustmentsPanel?: React.ReactNode;
}) {
  const t = useTranslations('payroll.process');
  // The rail's phase titles are the GUIDE's, deliberately: reusing `payroll.guide.phase{n}Title` is what
  // makes the two screens say the same words, and it adds no key to any of the six catalogs.
  const tGuide = useTranslations('payroll.guide');
  const isResume = !!resumeBatch;
  // Resume mode ALSO opens on Step 1 — a read-only review of the draft's period/company/cycle (feedback
  // 4f00d8f0: "return the user to Step 1 … to review") — with the batch identity fixed. The selection is
  // seeded from the persisted scope: an explicit scope ⇒ filtersTouched=true + selected set; an
  // empty/absent scope ⇒ filtersTouched=false so the whole-company default applies (step-selection.tsx).
  const seededEmploymentIds = resumeBatch?.scope?.employmentIds ?? [];
  const [step, setStep] = useState(wizardInitialStep(isResume));
  // Multi-company (3653d14b): a fresh run selects ONE, SEVERAL, or ALL companies. In resume mode the batch's
  // single company is fixed, so the array holds exactly that one id. `companyIds[0]` is the "primary" company
  // that drives the cycle catalog, per-company masters, and the payment-date default (all per-company today).
  const [companyIds, setCompanyIds] = useState<string[]>(resumeBatch ? [resumeBatch.companyId] : []);
  // "All my companies" — bounded to the scoped `companies` list the page passed in (never wider). When on,
  // the selection tracks the full provided list and the server re-resolves "all" to the admin's grants.
  const [selectAll, setSelectAll] = useState(false);
  const companyId = companyIds[0] ?? '';
  const [payPeriod, setPayPeriod] = useState(resumeBatch?.payPeriod ?? thisMonth);
  // ADR-0069: the cycle is now a per-company payroll_cycle row referenced by id (not a fixed enum). A fresh
  // run picks one in Step 1; a resumed draft has its cycle fixed on the persisted batch and never re-posts
  // it, so cycleId is only meaningfully used on the fresh-run path.
  const [cycleId, setCycleId] = useState('');
  const [paymentDate, setPaymentDate] = useState(resumeBatch?.paymentDate ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(seededEmploymentIds));
  const [filtersTouched, setFiltersTouched] = useState(seededEmploymentIds.length > 0);
  const [employees, setEmployees] = useState<PayrollRunEmployeeRow[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Validation-step status (R37 70764928). Reported up from StepValidation so the footer can keep Process
  // disabled while the checks are still running AND when there are hard blockers. Initialised to loading so
  // Process can never fire before the first check resolves.
  const [validation, setValidation] = useState<{ loading: boolean; hasBlockers: boolean }>({ loading: true, hasBlockers: false });

  const defaultDate = defaultPayDate(payPeriod, payDayByCompany[companyId]);

  // ADR-0069: the cycle options for the selected company. When multiCycle is OFF, filter down to only
  // regular-mapped cycles — the flag continues to gate non-regular visibility exactly as before, on top
  // of the admin-configured active list (so a configured-but-flag-off cycle can never reach a user and
  // fail at createAdditionalRun).
  const cycleOptions = useMemo(() => {
    const all = cyclesByCompany[companyId] ?? [];
    return multiCycle ? all : all.filter((c) => c.runType === 'regular');
  }, [cyclesByCompany, companyId, multiCycle]);

  // Keep the selected cycle valid for the current company. Organization Module (361e3b15): the pre-select
  // order is now saved-default-name → first regular → first available (preferredCycleId), so the primary
  // company's STORED default actually drives Step-1 (and therefore the intended run type). A saved name that
  // is no longer active falls through gracefully to the regular/first fallback (no blank selection). Clear
  // the pick when the current company has no options.
  useEffect(() => {
    if (cycleOptions.length === 0) {
      if (cycleId !== '') setCycleId('');
      return;
    }
    if (!cycleOptions.some((c) => c.id === cycleId)) {
      setCycleId(preferredCycleId(cycleOptions, defaultCycleByCompany[companyId]));
    }
  }, [cycleOptions, cycleId, defaultCycleByCompany, companyId]);

  // A stable key for the SET of selected companies, so the reset/fetch effects fire when the multi-select
  // changes (an array reference alone would not be a reliable dependency). Order-independent.
  const companyKey = useMemo(() => [...companyIds].sort().join(','), [companyIds]);

  // Reset per-company/period state so a changed Step-1 selection can never leak a stale Step-2 pick. Keys
  // off the whole company SET now (multi-company). In resume mode the company/period are FIXED (Step 1 is
  // disabled), so this reset would clobber the seeded selection on the first render — skip when resuming.
  useEffect(() => {
    if (isResume) return;
    setSelected(new Set());
    setFiltersTouched(false);
    setEmployees([]);
  }, [companyKey, payPeriod, isResume]);

  useEffect(() => {
    if (companyIds.length === 0 || !/^\d{4}-\d{2}$/.test(payPeriod)) return;
    setLoadingEmployees(true);
    fetchPayrollRunEmployees(companyIds, payPeriod)
      .then(setEmployees)
      .finally(() => setLoadingEmployees(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- companyKey is the stable dependency for the set
  }, [companyKey, payPeriod]);

  // Step-2 filter catalogs span the WHOLE selected company set (multi-company): a filter dropdown must offer
  // every selected company's departments / BUs / positions / cost centres, not just the primary company's.
  const companySet = useMemo(() => new Set(companyIds), [companyIds]);
  const companyDepartments = useMemo(() => departments.filter((d) => companySet.has(d.companyId)), [departments, companySet]);
  const companyBusinessUnits = useMemo(() => businessUnits.filter((b) => companySet.has(b.companyId)), [businessUnits, companySet]);
  const companyPositions = useMemo(() => positions.filter((p) => companySet.has(p.companyId)), [positions, companySet]);
  const companyCostCenters = useMemo(() => costCenters.filter((c) => companySet.has(c.companyId)), [costCenters, companySet]);

  // Step 1 valid: AT LEAST ONE company (multi-company), a valid month, and a cycle. Multi-company Phase 1
  // uses a single shared cycle across the selected companies (plan §"Step 1"); the primary company's cycle
  // catalog drives the picker (regular is the common month-end case).
  const step1Valid = companyIds.length > 0 && /^\d{4}-\d{2}$/.test(payPeriod) && !!cycleId;
  // Step 2 never blocks on a selection (empty/no-filter ⇒ whole company). In resume mode the cycle is fixed
  // on the persisted draft and never re-posted, so the submit gate must NOT require a fresh cycleId — only a
  // valid (seeded) company + period. A fresh run still requires step1Valid (which includes the cycle).
  const step2Valid = isResume ? !!companyId && /^\d{4}-\d{2}$/.test(payPeriod) : step1Valid;

  // The canonical payroll phase the current wizard step belongs to (drives the rail highlight).
  const currentPhase = payrollPhaseIndex(STEPS[step].phase);
  // Continue is a per-step gate now that there are three steps: Step 1 (period) requires a valid selection
  // (resume uses the seeded-identity check); Step 2 (employee selection) never blocks — an empty selection
  // means "whole company". The final Process button lives on Step 3 (Validation) and has its own gate.
  const canContinue = step === 0 ? (isResume ? step2Valid : step1Valid) : true;
  // Process is blocked while the validation check is still running or when it found hard blockers (missing
  // compensation / missing BASIC component) — the operator must fix those before the run can proceed.
  const canProcess = step2Valid && !isPending && !validation.loading && !validation.hasBlockers;

  const submit = () => {
    const fd = new FormData();
    if (isResume && resumeBatch) {
      // Resume path: re-set the EXISTING draft's scope, then hand off to the same Transaction Key-In
      // screen a fresh run reaches. Never re-create the batch. Only post employmentIds when the admin
      // actually narrowed the set (filtersTouched) — an untouched resume leaves the existing scope as-is.
      fd.set('batchId', resumeBatch.id);
      fd.set('filtersTouched', String(filtersTouched));
      // d75b0c11 — carried so the result screen's Back returns the filtered list, not a bare /payroll.
      if (from) fd.set('from', from);
      if (filtersTouched) {
        for (const id of selected) fd.append('employmentIds', id);
      }
      startTransition(() => {
        resumeRunAction(fd);
      });
      return;
    }
    // Fresh run (single, several, or all companies) — the Payroll Process is now a TERMINAL action that
    // runs the calculation across every selected company and lands on the Step-3 result page (3653d14b).
    // "All my companies" is re-resolved to the admin's grants server-side; explicit ids are re-intersected.
    for (const id of companyIds) fd.append('companyIds', id);
    fd.set('selectAll', String(selectAll));
    fd.set('payPeriod', payPeriod);
    // ADR-0069: submit the chosen cycle's id — the server resolves runType/remarks from the row (it does
    // not trust any client-submitted runType/remarks, same defensive pattern as employmentIds).
    fd.set('payrollCycleId', cycleId);
    fd.set('paymentDate', paymentDate || defaultDate);
    if (from) fd.set('from', from);
    if (filtersTouched) {
      for (const id of selected) fd.append('employmentIds', id);
    }
    startTransition(() => {
      runMultiCompanyAction(fd);
    });
  };

  return (
    <Card className="overflow-hidden">
      {/* The canonical six-phase payroll rail (a1d82340 step 3) — the SAME sequence, names and numbering the
          Workflow Guide teaches and the sidebar is ordered by. Earlier phases render as behind you, the
          wizard's phase is active, later phases are upcoming; the counter on the right tracks the step
          WITHIN the active phase, which is the progression the retired five-stage rail was really showing. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-4 py-3">
        {PAYROLL_PHASES.map((p, i) => {
          const done = i < currentPhase;
          const active = i === currentPhase;
          return (
            <div key={p.key} className="flex items-center gap-2">
              <span
                className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                  active ? 'bg-primary text-primary-foreground' : done ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'
                }`}
              >
                {p.n}
              </span>
              <span className={`text-sm ${active ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                {tGuide(p.titleKey)}
              </span>
              {i < PAYROLL_PHASES.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
            </div>
          );
        })}
        <span className="ml-auto text-xs text-muted-foreground">
          {t('stepOf', { n: step + 1, total: PHASE_STEP_COUNT })} · {t(STEPS[step].titleKey)}
        </span>
      </div>

      <div className="p-4">
        {/* Resume mode Step 1 (feedback 4f00d8f0): the draft's identity shown READ-ONLY for review — the
            reporter's flow lands here first ("return the user to Step 1 … to review"), then continues to
            Employee Selection. Changing period/company on an existing draft is deliberately not offered
            (delete the draft from the listing and create a new run instead — see resumeStep1Note). */}
        {step === 0 && isResume && resumeBatch && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('resumeStep1Note')}</p>
            <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('company')}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {companies.find((c) => c.id === resumeBatch.companyId)?.name ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('payPeriod')}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">{resumeBatch.payPeriod}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('cycleLabel')}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {/* Same runType-label + remarks pattern as the listing's Payroll Cycle column, so wizard
                      cycles stored under the generic 'off_cycle' bucket display distinctly. */}
                  {t(`runType.${resumeBatch.cycle}`)}
                  {resumeBatch.remarks ? ` — ${resumeBatch.remarks}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('paymentDate')}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums">{resumeBatch.paymentDate || '—'}</dd>
              </div>
            </dl>
          </div>
        )}
        {step === 0 && !isResume && (
          <StepPeriod
            companies={companies}
            companyIds={companyIds}
            onCompanyIds={setCompanyIds}
            selectAll={selectAll}
            onSelectAll={setSelectAll}
            payPeriod={payPeriod}
            onPayPeriod={setPayPeriod}
            cycleId={cycleId}
            onCycleId={setCycleId}
            cycleOptions={cycleOptions}
            paymentDate={paymentDate}
            onPaymentDate={setPaymentDate}
            defaultPaymentDate={defaultDate}
            multiCycle={multiCycle}
            existingRuns={existingRuns}
          />
        )}
        {step === 1 && (
          <StepSelection
            employees={employees}
            loading={loadingEmployees}
            multiCompany={companyIds.length > 1}
            businessUnits={companyBusinessUnits}
            departments={companyDepartments}
            positions={companyPositions}
            jobGrades={jobGrades}
            costCenters={companyCostCenters}
            selected={selected}
            onSelectedChange={setSelected}
            filtersTouched={filtersTouched}
            onFiltersTouchedChange={setFiltersTouched}
          />
        )}
        {step === 2 && (
          // Validation step (R37 70764928): runs the pre-processing checks over the CURRENT selection and
          // renders green/amber/red before the terminal Process action. In resume mode the batch's single
          // company is fixed; a fresh run may span several. `employmentIds` is only sent when the operator
          // actually narrowed the set (filtersTouched) — otherwise the whole-company default is validated.
          <StepValidation
            companyIds={isResume ? [companyId] : companyIds}
            payPeriod={payPeriod}
            employmentIds={filtersTouched ? [...selected] : undefined}
            // Organization Module (361e3b15): the intended run type drives the missing-cycle pre-flight. A
            // resume has its cycle fixed on the batch and does not re-resolve cycles, so the pre-flight is
            // skipped there (undefined); a fresh run derives it from the Step-1 cycle selection.
            intendedRunType={isResume ? undefined : cycleOptions.find((c) => c.id === cycleId)?.runType}
            onStatusChange={setValidation}
          />
        )}
        {step === 2 && adjustmentsPanel && (
          // 7076f8af — the draft-run adjustment panel, on the Review step. This is the reporter's own
          // ask ("everything you may need to correct before a run is calculated ... on the Review step"),
          // and it is where the panel has to be if it is not to be a separate screen: it is the last
          // moment before the figures are computed. COLLAPSED by default so the Review step still opens
          // as a readiness check rather than a data-entry form.
          <details className="mt-4 rounded-lg border border-border">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t('adjustmentsTitle')}</summary>
            <div className="space-y-3 border-t border-border p-4">
              <p className="text-xs text-muted-foreground">{t('adjustmentsHint')}</p>
              {adjustmentsPanel}
            </div>
          </details>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        {/* Back is enabled from Step 2 in BOTH modes now that resume has a real (read-only) Step 1 to go
            back to (feedback 4f00d8f0). */}
        <Button type="button" variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          // Continue advances through Preparation (Step 1 gates on a valid period/company; Step 2 selection
          // never blocks) into the Validation step. The terminal Process button only appears on Step 3.
          <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={!canContinue}>
            {t('continue')}
          </Button>
        ) : (
          // Process is the terminal action, now gated on the Validation step: disabled while the checks run
          // and whenever there are hard blockers (missing salary record / missing BASIC component).
          // 7076f8af — ONE LABEL FOR BOTH MODES. A resumed run used to read "Confirm selection & continue",
          // which was accurate then (it saved the scope and handed you to another screen) and is a lie now:
          // the resume path calculates the run and ends on the result page, exactly as a fresh run does.
          <Button type="button" onClick={submit} disabled={!canProcess} data-tour="payroll-create-submit">
            {isPending ? t('creating') : t('processPayroll')}
          </Button>
        )}
      </div>
    </Card>
  );
}
