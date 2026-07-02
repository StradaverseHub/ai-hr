'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card } from '@/components/ui';
import { createRunAction, fetchPayrollRunEmployees } from './actions';
import { StepPeriod, type Company, type Cycle, type ExistingRun } from './steps/step-period';
import { StepSelection, type Master, type PayrollRunEmployeeRow } from './steps/step-selection';

/** Payroll Process wizard (3b) — STEPS registry, sequential gating, plain useState. No workflow engine:
 *  future steps slot in as additional entries in `STEPS` (plan §16, guardrail). */
const STEPS = [
  { key: 'period', titleKey: 'stepPeriod' },
  { key: 'selection', titleKey: 'stepSelection' },
] as const;

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
  thisMonth,
  multiCycle,
}: {
  companies: Company[];
  departments: (Master & { businessUnitId: string | null })[];
  businessUnits: Master[];
  positions: Master[];
  costCenters: Master[];
  jobGrades: { id: string; name: string }[];
  payDayByCompany: Record<string, number | null>;
  existingRuns: ExistingRun[];
  thisMonth: string;
  multiCycle: boolean;
}) {
  const t = useTranslations('payroll.process');
  const [step, setStep] = useState(0);
  const [companyId, setCompanyId] = useState('');
  const [payPeriod, setPayPeriod] = useState(thisMonth);
  const [cycle, setCycle] = useState<Cycle>('regular');
  const [paymentDate, setPaymentDate] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filtersTouched, setFiltersTouched] = useState(false);
  const [employees, setEmployees] = useState<PayrollRunEmployeeRow[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [isPending, startTransition] = useTransition();

  const defaultDate = defaultPayDate(payPeriod, payDayByCompany[companyId]);

  // Reset per-company/period state so a changed Step-1 selection can never leak a stale Step-2 pick.
  useEffect(() => {
    setSelected(new Set());
    setFiltersTouched(false);
    setEmployees([]);
  }, [companyId, payPeriod]);

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

  const step1Valid = !!companyId && /^\d{4}-\d{2}$/.test(payPeriod);
  const step2Valid = step1Valid; // Step 2 never blocks on a selection (empty/no-filter ⇒ whole company).

  const submit = () => {
    const fd = new FormData();
    fd.set('companyId', companyId);
    fd.set('payPeriod', payPeriod);
    fd.set('cycle', cycle);
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
            cycle={cycle}
            onCycle={setCycle}
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
        <Button type="button" variant="secondary" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button type="button" onClick={() => setStep((s) => s + 1)} disabled={!step1Valid}>
            {t('continue')}
          </Button>
        ) : (
          <Button type="button" onClick={submit} disabled={!step2Valid || isPending} data-tour="payroll-create-submit">
            {isPending ? t('creating') : t('createRun')}
          </Button>
        )}
      </div>
    </Card>
  );
}
