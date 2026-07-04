'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
import { createRunAction, fetchPayrollRunEmployees, resumeRunAction } from './actions';
import { StepPeriod, type Company, type CycleRunType, type CycleOption, type ExistingRun } from './steps/step-period';
import { StepSelection, type Master, type PayrollRunEmployeeRow } from './steps/step-selection';

/** Payroll Process wizard (3b) — STEPS registry, sequential gating, plain useState. No workflow engine:
 *  future steps slot in as additional entries in `STEPS` (plan §16, guardrail). */
const STEPS = [
  { key: 'period', titleKey: 'stepPeriod' },
  { key: 'selection', titleKey: 'stepSelection' },
] as const;

/** A DRAFT batch being resumed (the "who's in this run" step, formerly bypassed for drafts). Carries the
 *  fixed identity of the existing batch — company/period/cycle are NOT editable mid-resume; only the
 *  employee selection is. Off-cycle/bonus/adjustment drafts resume too, so cycle/paymentDate/remarks
 *  carry through unchanged, not defaulted back to 'regular'. */
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
  /** When set, the wizard opens in RESUME mode: Step 2 (Employee Selection) directly, Step 1 disabled,
   *  company/period/cycle fixed to the existing draft, selection pre-seeded from the persisted scope. */
  resumeBatch?: ResumeBatch;
}) {
  const t = useTranslations('payroll.process');
  const isResume = !!resumeBatch;
  // In resume mode we land straight on Step 2 (Employee Selection) with the batch identity fixed. The
  // selection is seeded from the persisted scope: an explicit scope ⇒ filtersTouched=true + selected set;
  // an empty/absent scope ⇒ filtersTouched=false so the whole-company default applies (step-selection.tsx).
  const seededEmploymentIds = resumeBatch?.scope?.employmentIds ?? [];
  const [step, setStep] = useState(isResume ? 1 : 0);
  const [companyId, setCompanyId] = useState(resumeBatch?.companyId ?? '');
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

  // Reset per-company/period state so a changed Step-1 selection can never leak a stale Step-2 pick. In
  // resume mode the company/period are FIXED (Step 1 is disabled), so this reset would clobber the seeded
  // selection on the first render — skip it entirely when resuming.
  useEffect(() => {
    if (isResume) return;
    setSelected(new Set());
    setFiltersTouched(false);
    setEmployees([]);
  }, [companyId, payPeriod, isResume]);

  useEffect(() => {
    if (!companyId || !/^\d{4}-\d{2}$/.test(payPeriod)) return;
    setLoadingEmployees(true);
    fetchPayrollRunEmployees(companyId, payPeriod)
      .then(setEmployees)
      .finally(() => setLoadingEmployees(false));
  }, [companyId, payPeriod]);

  const companyDepartments = useMemo(() => departments.filter((d) => d.companyId === companyId), [departments, companyId]);
  const companyBusinessUnits = useMemo(() => businessUnits.filter((b) => b.companyId === companyId), [businessUnits, companyId]);
  const companyPositions = useMemo(() => positions.filter((p) => p.companyId === companyId), [positions, companyId]);
  const companyCostCenters = useMemo(() => costCenters.filter((c) => c.companyId === companyId), [costCenters, companyId]);

  const step1Valid = !!companyId && /^\d{4}-\d{2}$/.test(payPeriod) && !!cycleId;
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
    fd.set('companyId', companyId);
    fd.set('payPeriod', payPeriod);
    // ADR-0069: submit the chosen cycle's id — the server resolves runType/remarks from the row (it does
    // not trust any client-submitted runType/remarks, same defensive pattern as employmentIds).
    fd.set('payrollCycleId', cycleId);
    fd.set('paymentDate', paymentDate || defaultDate);
    if (filtersTouched) {
      for (const id of selected) fd.append('employmentIds', id);
    }
    startTransition(() => {
      createRunAction(fd);
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
        {step === 0 && (
          <StepPeriod
            companies={companies}
            companyId={companyId}
            onCompanyId={setCompanyId}
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
        {/* Resume mode: company/period/cycle are fixed to the existing draft, so Back to Step 1 is disabled
            (same disabled-idiom as the fresh-run step===0 case) — the admin only edits the selection. */}
        <Button type="button" variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || isResume}>
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={!step1Valid}>
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
