'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Card, EmployeeName, Field, inputCls } from '@/components/ui';
import { saveIndividualTxnGridAction, type SaveGridResult } from './actions';

/** Client-side mirror of TXN_KINDS (core/payroll-individual-txn.ts). Kept as a literal here so this client
 *  component never imports the DB-touching service module (RSC boundary). The i18n dynamic-key test pins the
 *  kindLabel.* keys, so a drift here would surface as a failing test. */
const KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;

/** Real days-in-month (leap-year correct) — mirrors core/payroll.ts daysInMonth so the grid's date max is
 *  the true month-end (not a hardcoded -31), matching what the server's assertDateInPeriod enforces (C9). */
function daysInMonth(year: number, month1: number): number {
  if (month1 === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month1 - 1];
}

export type WizardEmployee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  department: string | null;
  departmentId: string | null;
  position: string | null;
  company: string;
  companyId: string;
};

export type WizardBatch = {
  id: string;
  companyId: string;
  payPeriod: string;
  runType: 'regular' | 'off_cycle' | 'bonus' | 'adjustment';
  runSeq: number;
  scope: { departmentIds?: string[]; employmentIds?: string[] } | null;
};

type GridRow = { kind: string; txnDate: string; amount: string; notes: string };
const blankRow = (): GridRow => ({ kind: 'earning', txnDate: '', amount: '', notes: '' });

const STEPS = [
  { key: 'employee', titleKey: 'stepEmployee' },
  { key: 'period', titleKey: 'stepPeriod' },
  { key: 'entry', titleKey: 'stepEntry' },
  { key: 'save', titleKey: 'stepSave' },
] as const;

/** True when a batch's scope includes this employment (empty/null scope ⇒ whole company). Mirrors the
 *  server's resolveBatchScopeFilter membership rule; the service re-checks it authoritatively (C4). */
function batchIncludesEmployee(b: WizardBatch, emp: WizardEmployee): boolean {
  const empIds = b.scope?.employmentIds ?? [];
  const deptIds = b.scope?.departmentIds ?? [];
  if (empIds.length === 0 && deptIds.length === 0) return true; // whole company
  if (empIds.includes(emp.employmentId)) return true;
  if (emp.departmentId && deptIds.includes(emp.departmentId)) return true;
  return false;
}

/**
 * Individual Transaction wizard — a four-step guided flow for one-off payroll items (cloned in shape from
 * app/payroll/process/wizard.tsx). Step 1 pick employee → Step 2 pick period + cycle (+ run when a
 * (period, cycle) maps to >1 draft batch) resolving a concrete batchId in the employee's company →
 * Step 3 an editable grid → Step 4 one atomic Save. The grid is client-state (useState), so a save error
 * preserves the entered rows and highlights the offending ones instead of redirecting away (C10).
 */
export function TxnGrid({
  employees,
  batches,
  companies,
  processHref,
}: {
  employees: WizardEmployee[];
  batches: WizardBatch[];
  companies: { id: string; name: string }[];
  processHref: string;
}) {
  const t = useTranslations('payroll.transactions.individual');
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [period, setPeriod] = useState('');
  const [runType, setRunType] = useState('');
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState<GridRow[]>([blankRow()]);
  const [rowErrors, setRowErrors] = useState<Set<number>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const employee = useMemo(() => employees.find((e) => e.employmentId === employeeId) ?? null, [employees, employeeId]);

  // Draft batches in the employee's company that also include the employee in their scope (C3 + C4 UI filter).
  const eligibleBatches = useMemo(() => {
    if (!employee) return [];
    return batches.filter((b) => b.companyId === employee.companyId && batchIncludesEmployee(b, employee));
  }, [batches, employee]);

  const periods = useMemo(
    () => [...new Set(eligibleBatches.map((b) => b.payPeriod))].sort().reverse(),
    [eligibleBatches],
  );
  const runTypesForPeriod = useMemo(
    () => [...new Set(eligibleBatches.filter((b) => b.payPeriod === period).map((b) => b.runType))],
    [eligibleBatches, period],
  );
  // When a (period, runType) maps to >1 draft batch, expose a run selector (label mirrors the batch listing).
  const runsForSelection = useMemo(
    () => eligibleBatches.filter((b) => b.payPeriod === period && b.runType === runType).sort((a, b) => a.runSeq - b.runSeq),
    [eligibleBatches, period, runType],
  );

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Narrow to the chosen company BEFORE the name/number match and BEFORE the 25-row slice, so the cap
    // counts only in-company rows — a large first company must never fill all 25 slots and hide a small
    // selected company's people. This is view-only narrowing; the set is already access-fenced upstream.
    const inCompany = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    const base = q
      ? inCompany.filter(
          (e) => e.name.toLowerCase().includes(q) || (e.employeeCode ?? '').toLowerCase().includes(q),
        )
      : inCompany;
    return base.slice(0, 25);
  }, [employees, query, companyId]);

  // Pre-select the sole company so single-company admins see no change (their one company is chosen for
  // them and the search behaves exactly as before).
  useEffect(() => {
    if (companies.length === 1) setCompanyId(companies[0].id);
  }, [companies]);

  // Reset the selected employee when the company changes so a stale pick from another company can't carry
  // forward. The employeeId effect below then unwinds period/run/batch, so this one line clears the chain.
  useEffect(() => {
    setEmployeeId('');
  }, [companyId]);

  // Reset every downstream selection when the chosen employee changes — a stale period/run/batch from a
  // different employee (possibly a different company) must never leak forward.
  useEffect(() => {
    setPeriod('');
    setRunType('');
    setBatchId('');
  }, [employeeId]);

  // Reset the run/batch when the period changes; auto-resolve a single run.
  useEffect(() => {
    setRunType('');
    setBatchId('');
  }, [period]);

  // Auto-resolve the batchId when the (period, runType) picks out exactly one run; clear on ambiguity.
  useEffect(() => {
    if (runsForSelection.length === 1) setBatchId(runsForSelection[0].id);
    else setBatchId('');
  }, [runsForSelection]);

  const cycleLabel = (b: WizardBatch) => `${t(`cycle.${b.runType}`)}${b.runSeq > 1 ? ` #${b.runSeq}` : ''}`;

  const monthBounds = useMemo(() => {
    if (!/^\d{4}-\d{2}$/.test(period)) return null;
    const [y, m] = period.split('-').map(Number);
    return { min: `${period}-01`, max: `${period}-${String(daysInMonth(y, m)).padStart(2, '0')}` };
  }, [period]);

  const step1Valid = !!employeeId;
  const step2Valid = !!batchId;

  const setRow = (i: number, patch: Partial<GridRow>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setRowErrors((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
    setSaveError(null);
  };
  const addRow = () => setRows((rs) => [...rs, blankRow()]);
  const deleteRow = (i: number) =>
    setRows((rs) => {
      const next = rs.filter((_, idx) => idx !== i);
      return next.length ? next : [blankRow()];
    });

  /** A row is "empty" (ignored) when nothing is filled. Otherwise it must be complete + valid. */
  const isEmptyRow = (r: GridRow) => !r.kind && !r.txnDate && !r.amount.trim() && !r.notes.trim();
  const rowIsValid = (r: GridRow): boolean => {
    if (isEmptyRow(r)) return true; // ignored on save
    if (!KINDS.includes(r.kind as (typeof KINDS)[number])) return false;
    if (!r.txnDate) return false;
    if (monthBounds && (r.txnDate < monthBounds.min || r.txnDate > monthBounds.max)) return false;
    const amt = Number(r.amount);
    if (!(amt > 0)) return false;
    return true;
  };

  const validate = (): boolean => {
    const bad = new Set<number>();
    rows.forEach((r, i) => {
      if (!rowIsValid(r)) bad.add(i);
    });
    // At least one non-empty valid row is required.
    const hasContent = rows.some((r) => !isEmptyRow(r));
    setRowErrors(bad);
    if (bad.size > 0) {
      setSaveError(t('rowIncomplete'));
      return false;
    }
    if (!hasContent) {
      setSaveError(t('rowIncomplete'));
      return false;
    }
    return true;
  };

  const submit = () => {
    setSavedCount(null);
    if (!step1Valid || !step2Valid) return;
    if (!validate()) return;
    const payload = rows
      .filter((r) => !isEmptyRow(r))
      .map((r) => ({ kind: r.kind, txnDate: r.txnDate, amount: r.amount, notes: r.notes }));
    const fd = new FormData();
    fd.set('batchId', batchId);
    fd.set('employmentId', employeeId);
    fd.set('rows', JSON.stringify(payload));
    startTransition(async () => {
      const res: SaveGridResult = await saveIndividualTxnGridAction(fd);
      if (res.ok) {
        setSavedCount(res.count);
        setSaveError(null);
        setRowErrors(new Set());
        setRows([blankRow()]);
        toast.success(t('saveSuccess', { count: res.count }));
      } else {
        // PRESERVE the entered rows; surface the friendly error inline (C10). A row-level failure highlights
        // every non-empty row so the user can find and fix it.
        setSaveError(t(res.error as never));
        setRowErrors(new Set(rows.map((_, i) => i).filter((i) => !isEmptyRow(rows[i]))));
      }
    });
  };

  return (
    <Card className="overflow-hidden">
      {/* Step indicator (numbered chips) — mirrors process/wizard.tsx. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-medium ${
                i === step
                  ? 'bg-primary text-primary-foreground'
                  : i < step
                    ? 'bg-emerald-500 text-white'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={`text-sm ${i === step ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
              {t(s.titleKey)}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 text-muted-foreground">→</span>}
          </div>
        ))}
      </div>

      <div className="p-4">
        {/* ── Step 1 — Employee ── */}
        {step === 0 && (
          <div className="space-y-4">
            {/* Company pre-filter — narrows the employee list to one company before search. A leading
                placeholder only when there's a real choice; a single company is auto-selected above. */}
            <Field label={t('company')}>
              <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={inputCls}>
                {companies.length > 1 && <option value="">—</option>}
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('employeeSearch')}>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className={inputCls}
              />
            </Field>
            <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {searchResults.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noEmployees')}</p>
              )}
              {searchResults.map((e) => {
                const active = e.employmentId === employeeId;
                return (
                  <button
                    key={e.employmentId}
                    type="button"
                    onClick={() => setEmployeeId(e.employmentId)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-muted ${
                      active ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="min-w-0">
                      {/* Employee ID left-of-name (feedback 38668d9b) */}
                      <EmployeeName code={e.employeeCode} name={e.name} className="block truncate font-medium text-foreground" />
                      <span className="block truncate text-xs text-muted-foreground">
                        {e.company} · {e.department ?? '—'} · {e.position ?? '—'}
                      </span>
                    </span>
                    {active && <span className="shrink-0 text-primary">✓</span>}
                  </button>
                );
              })}
            </div>
            {employee && (
              <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-4">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('empId')}</div>
                  <div className="font-medium">{employee.employeeCode ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('employee')}</div>
                  <div className="font-medium">{employee.name}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('dept')}</div>
                  <div className="font-medium">{employee.department ?? '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('position')}</div>
                  <div className="font-medium">{employee.position ?? '—'}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2 — Period + Cycle (+ Run) ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('monthLabel')}>
                <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {periods.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('cycleLabel')}>
                <select
                  value={runType}
                  onChange={(e) => setRunType(e.target.value)}
                  disabled={!period}
                  className={inputCls}
                >
                  <option value="">—</option>
                  {runTypesForPeriod.map((rt) => (
                    <option key={rt} value={rt}>
                      {t(`cycle.${rt}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {runsForSelection.length > 1 && (
                <Field label={t('pickRun')}>
                  <select value={batchId} onChange={(e) => setBatchId(e.target.value)} className={inputCls}>
                    <option value="">—</option>
                    {runsForSelection.map((b) => (
                      <option key={b.id} value={b.id}>
                        {cycleLabel(b)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            {period && runType && runsForSelection.length === 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                {t('noDraftForSelection')}{' '}
                <a href={processHref} className="font-medium underline underline-offset-2">
                  {t('noDraftForSelectionLink')}
                </a>
              </p>
            )}
            {eligibleBatches.length === 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                {t('noDraftForSelection')}{' '}
                <a href={processHref} className="font-medium underline underline-offset-2">
                  {t('noDraftForSelectionLink')}
                </a>
              </p>
            )}
          </div>
        )}

        {/* ── Step 3 — Grid ── */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('txnIntro')}</p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('colItem')}</th>
                    <th className="px-3 py-2 font-medium">{t('colEffectiveDate')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('colAmount')}</th>
                    <th className="px-3 py-2 font-medium">{t('colRemarks')}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r, i) => (
                    <tr key={i} className={rowErrors.has(i) ? 'bg-red-50/40 dark:bg-red-500/5' : ''}>
                      <td className="px-3 py-1.5">
                        <select value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value })} className={inputCls}>
                          {KINDS.map((k) => (
                            <option key={k} value={k}>
                              {t(`kindLabel.${k}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="date"
                          value={r.txnDate}
                          min={monthBounds?.min}
                          max={monthBounds?.max}
                          onChange={(e) => setRow(i, { txnDate: e.target.value })}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={r.amount}
                          onChange={(e) => setRow(i, { amount: e.target.value })}
                          className={`${inputCls} text-right`}
                        />
                      </td>
                      <td className="px-3 py-1.5">
                        <input
                          type="text"
                          value={r.notes}
                          placeholder={t('notesPlaceholder')}
                          onChange={(e) => setRow(i, { notes: e.target.value })}
                          className={inputCls}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => deleteRow(i)}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {t('gridDeleteRow')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                {t('gridAddRow')}
              </Button>
              {saveError && <span className="text-sm text-destructive">{saveError}</span>}
            </div>
          </div>
        )}

        {/* ── Step 4 — Save ── */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-3">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('employee')}</div>
                <div className="font-medium">{employee?.name ?? '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('monthLabel')}</div>
                <div className="font-medium">{period || '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('cycleLabel')}</div>
                <div className="font-medium">
                  {(() => {
                    const b = eligibleBatches.find((x) => x.id === batchId);
                    return b ? cycleLabel(b) : '—';
                  })()}
                </div>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('reviewCount', { count: rows.filter((r) => !isEmptyRow(r)).length })}
            </p>
            {saveError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
                {saveError}
              </div>
            )}
            {savedCount != null && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400">
                {t('saveSuccess', { count: savedCount })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
        >
          {t('back')}
        </Button>
        {step < STEPS.length - 1 ? (
          <Button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            disabled={(step === 0 && !step1Valid) || (step === 1 && !step2Valid)}
          >
            {t('next')}
          </Button>
        ) : (
          <Button type="button" onClick={submit} disabled={isPending || savedCount != null}>
            {isPending ? t('saving') : t('saveAll')}
          </Button>
        )}
      </div>
    </Card>
  );
}
