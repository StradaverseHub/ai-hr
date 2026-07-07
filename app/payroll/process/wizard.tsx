'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
import { fetchPayrollRunEmployees, resumeRunAction, runMultiCompanyAction } from './actions';
import { wizardInitialStep } from './selection-logic';
import { StepPeriod, type Company, type CycleRunType, type CycleOption, type ExistingRun } from './steps/step-period';
import { StepSelection, type Master, type PayrollRunEmployeeRow } from './steps/step-selection';

/** Payroll Process wizard (3b) — STEPS registry, sequential gating, plain useState. No workflow engine:
 *  future steps slot in as additional entries in `STEPS` (plan §16, guardrail). */
const STEPS = [
  { key: 'period', titleKey: 'stepPeriod' },
  { key: 'selection', titleKey: 'stepSelection' },
] as const;

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
  thisMonth,
  multiCycle,
  resumeBatch,
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
  thisMonth: string;
  multiCycle: boolean;
  /** When set, the wizard opens in RESUME mode: Step 1 shows the draft's fixed identity READ-ONLY for
   *  review (feedback 4f00d8f0), then Step 2 (Employee Selection) with the selection pre-seeded from the
   *  persisted scope. */
  resumeBatch?: ResumeBatch;
}) {
  const t = useTranslations('payroll.process');
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

  const defaultDate = defaultPayDate(payPeriod, payDayByCompany[companyId]);

  // ADR-0069: the cycle options for the selected company. When multiCycle is OFF, filter down to only
  // regular-mapped cycles — the flag continues to gate non-regular visibility exactly as before, on top
  // of the admin-configured active list (so a configured-but-flag-off cycle can never reach a user and
  // fail at createAdditionalRun).
  const cycleOptions = useMemo(() => {
    const all = cyclesByCompany[companyId] ?? [];
    return multiCycle ? all : all.filter((c) => c.runType === 'regular');
  }, [cyclesByCompany, companyId, multiCycle]);

  // Keep the selected cycle valid for the current company: default to the first regular-mapped option
  // (falling back to the first available), and clear it when it no longer belongs to this company's list.
  useEffect(() => {
    if (cycleOptions.length === 0) {
      if (cycleId !== '') setCycleId('');
      return;
    }
    if (!cycleOptions.some((c) => c.id === cycleId)) {
      const preferred = cycleOptions.find((c) => c.runType === 'regular') ?? cycleOptions[0];
      setCycleId(preferred.id);
    }
  }, [cycleOptions, cycleId]);

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

  const submit = () => {
    const fd = new FormData();
    if (isResume && resumeBatch) {
      // Resume path: re-set the EXISTING draft's scope, then hand off to the same Transaction Key-In
      // screen a fresh run reaches. Never re-create the batch. Only post employmentIds when the admin
      // actually narrowed the set (filtersTouched) — an untouched resume leaves the existing scope as-is.
      fd.set('batchId', resumeBatch.id);
      fd.set('filtersTouched', String(filtersTouched));
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
    if (filtersTouched) {
      for (const id of selected) fd.append('employmentIds', id);
    }
    startTransition(() => {
      runMultiCompanyAction(fd);
    });
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-emerald-500 text-white' : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={`text-sm ${i === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{t(s.titleKey)}</span>
            {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
          </div>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">{t('stepOf', { n: step + 1, total: STEPS.length + 1 })}</span>
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
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        {/* Back is enabled from Step 2 in BOTH modes now that resume has a real (read-only) Step 1 to go
            back to (feedback 4f00d8f0). */}
        <Button type="button" variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          // Resume mode's Step-1 gate is the resume-valid check (seeded company + period) — the cycle is
          // fixed on the persisted draft and never re-posted, so it must not block Continue.
          <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={isResume ? !step2Valid : !step1Valid}>
            {t('continue')}
          </Button>
        ) : (
          <Button type="button" onClick={submit} disabled={!step2Valid || isPending} data-tour="payroll-create-submit">
            {isPending ? t('creating') : isResume ? t('confirmSelectionAndProcess') : t('createRun')}
          </Button>
        )}
      </div>
    </Card>
  );
}
