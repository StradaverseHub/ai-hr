'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { saveIndividualTxnGridAction, type SaveGridResult } from './actions';

/** Client-side mirror of TXN_KINDS (core/payroll-individual-txn.ts). Kept as a literal here so this client
 *  component never imports the DB-touching service module (RSC boundary). The i18n dynamic-key test pins the
 *  kindLabel.* keys, so a drift here would surface as a failing test. */
const KINDS = ['earning', 'deduction', 'overtime', 'unpaid', 'leave'] as const;

/** An active pay component from the Payroll Item Master (feedback 7b2d4228) — the item dropdown is now sourced
 *  dynamically from this catalog (not a hardcoded kind list). Only payable earning/deduction items are passed. */
export type WizardPayItem = { id: string; code: string; name: string; kind: string };

/** Map a Pay-Item-Master component kind onto one of the five ledger txn kinds. The ledger stores a kind, not a
 *  component id (ADR-0056 kinds-only ledger), so a chosen master item is recorded as its kind + its name in the
 *  remarks. 'allowance' ⇒ earning, 'deduction' ⇒ deduction (the two payable one-off classes). */
const COMPONENT_KIND_TO_TXN: Record<string, (typeof KINDS)[number]> = { allowance: 'earning', deduction: 'deduction' };

/** A resolved item-picker option: either a generic kind (`k:<kind>`) or a master component (`c:<id>`). */
type ItemOption = { value: string; label: string; kind: (typeof KINDS)[number]; fromMaster: boolean };

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
  /** Derived employment status ('active' when not terminated, else 'ended') — the Step-1 status filter. */
  status: 'active' | 'ended';
};

export type WizardBatch = {
  id: string;
  companyId: string;
  payPeriod: string;
  runType: 'regular' | 'off_cycle' | 'bonus' | 'adjustment';
  runSeq: number;
  scope: { departmentIds?: string[]; employmentIds?: string[] } | null;
};

type GridRow = { item: string; txnDate: string; amount: string; notes: string };
const blankRow = (): GridRow => ({ item: 'k:earning', txnDate: '', amount: '', notes: '' });

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
  payItems,
  processHref,
}: {
  employees: WizardEmployee[];
  batches: WizardBatch[];
  companies: { id: string; name: string }[];
  payItems: WizardPayItem[];
  processHref: string;
}) {
  const t = useTranslations('payroll.transactions.individual');
  const tFixed = useTranslations('payroll.transactions.fixed');

  // Item picker options, sourced dynamically from the Payroll Item Master (feedback 7b2d4228). The five generic
  // kinds are always offered (they cover overtime / unpaid / leave, which are not component-catalog kinds); the
  // master's active payable earning/deduction components are added as specific, named items above them.
  const itemOptions = useMemo<ItemOption[]>(() => {
    const generic: ItemOption[] = KINDS.map((k) => ({ value: `k:${k}`, label: t(`kindLabel.${k}`), kind: k, fromMaster: false }));
    const master: ItemOption[] = payItems
      .filter((c) => COMPONENT_KIND_TO_TXN[c.kind] != null)
      .map((c) => ({ value: `c:${c.id}`, label: `${c.code} — ${c.name}`, kind: COMPONENT_KIND_TO_TXN[c.kind], fromMaster: true }));
    return [...generic, ...master];
  }, [payItems, t]);
  const itemByValue = useMemo(() => new Map(itemOptions.map((o) => [o.value, o])), [itemOptions]);
  const masterEarnings = useMemo(() => itemOptions.filter((o) => o.fromMaster && o.kind === 'earning'), [itemOptions]);
  const masterDeductions = useMemo(() => itemOptions.filter((o) => o.fromMaster && o.kind === 'deduction'), [itemOptions]);
  /** Resolve a grid row into the record that will be persisted: the chosen item → its kind, and (for a named
   *  master item) its label defaulted into the remarks so the specific pay item is recorded in the ledger. */
  const resolveRow = (r: GridRow) => {
    const opt = itemByValue.get(r.item) ?? itemOptions[0];
    const notes = r.notes.trim() || (opt.fromMaster ? opt.label : '');
    return { kind: opt.kind, txnDate: r.txnDate, amount: r.amount, notes };
  };
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // Multi-employee: the wizard now records the same grid for one OR many employees, all in one atomic save.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [period, setPeriod] = useState('');
  const [runType, setRunType] = useState('');
  const [batchId, setBatchId] = useState('');
  const [rows, setRows] = useState<GridRow[]>([blankRow()]);
  const [rowErrors, setRowErrors] = useState<Set<number>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const byId = useMemo(() => new Map(employees.map((e) => [e.employmentId, e])), [employees]);
  const selectedEmployees = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((e): e is WizardEmployee => e != null),
    [selectedIds, byId],
  );
  // The whole selection is constrained to ONE company (a batch belongs to one company). The company of the
  // first-selected employee anchors the selection; the list disables out-of-company rows below.
  const selectionCompanyId = selectedEmployees[0]?.companyId ?? null;

  // Draft batches in the selection's company that include EVERY selected employee in their scope
  // (intersection — C3 + C4 UI filter). With ≥1 employee selected this is the batches all of them share.
  const eligibleBatches = useMemo(() => {
    if (selectedEmployees.length === 0 || selectionCompanyId == null) return [];
    return batches.filter(
      (b) => b.companyId === selectionCompanyId && selectedEmployees.every((e) => batchIncludesEmployee(b, e)),
    );
  }, [batches, selectedEmployees, selectionCompanyId]);

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

  // The chosen batch and any selected employees NOT covered by it (a coverage-gap hint on Step 2). A batch
  // is only shown as eligible when it covers ALL selected employees, so with the guardrails this is empty;
  // it is a defensive backstop that names anyone a stale selection would exclude.
  const chosenBatch = useMemo(() => eligibleBatches.find((b) => b.id === batchId) ?? null, [eligibleBatches, batchId]);
  const uncoveredEmployees = useMemo(
    () => (chosenBatch ? selectedEmployees.filter((e) => !batchIncludesEmployee(chosenBatch, e)) : []),
    [chosenBatch, selectedEmployees],
  );

  // Department options derive from the currently-visible (in-company) employee set — no extra query.
  const departmentOptions = useMemo(() => {
    const src = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    const seen = new Map<string, string>();
    for (const e of src) if (e.departmentId && e.department) seen.set(e.departmentId, e.department);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, companyId]);

  const CAP = 25;
  const filteredEmployees = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Narrow to company → department → status BEFORE the name/number match, then cap. The cap counts only
    // rows that already pass every filter, so a large company never hides a small filtered result set.
    let base = companyId ? employees.filter((e) => e.companyId === companyId) : employees;
    if (deptFilter) base = base.filter((e) => e.departmentId === deptFilter);
    if (statusFilter) base = base.filter((e) => e.status === statusFilter);
    if (q) base = base.filter((e) => e.name.toLowerCase().includes(q) || (e.employeeCode ?? '').toLowerCase().includes(q));
    return base;
  }, [employees, query, companyId, deptFilter, statusFilter]);
  const searchResults = useMemo(() => filteredEmployees.slice(0, CAP), [filteredEmployees]);
  const capped = filteredEmployees.length > CAP;

  // Pre-select the sole company so single-company admins see no change (their one company is chosen for
  // them and the search behaves exactly as before).
  useEffect(() => {
    if (companies.length === 1) setCompanyId(companies[0].id);
  }, [companies]);

  // Reset the employee selection + dept filter when the company changes so stale picks from another company
  // can't carry forward. The selection effect below then unwinds period/run/batch.
  useEffect(() => {
    setSelectedIds([]);
    setDeptFilter('');
  }, [companyId]);

  // Reset every downstream selection when the chosen employee SET changes — a stale period/run/batch from a
  // different selection (possibly a different company) must never leak forward.
  const selectionKey = selectedIds.join(',');
  useEffect(() => {
    setPeriod('');
    setRunType('');
    setBatchId('');
  }, [selectionKey]);

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

  const step1Valid = selectedIds.length > 0;
  const step2Valid = !!batchId;

  // Toggle one employee in/out of the selection. The whole selection is pinned to one company: once at least
  // one employee is picked, employees in a different company are disabled in the list below.
  const toggleEmployee = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const removeEmployee = (id: string) => setSelectedIds((prev) => prev.filter((x) => x !== id));

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

  /** A row is "empty" (ignored) when no date, amount, or remarks is filled. The item select always carries a
   *  default, so it is not a content signal on its own. Otherwise the row must be complete + valid. */
  const isEmptyRow = (r: GridRow) => !r.txnDate && !r.amount.trim() && !r.notes.trim();
  const rowIsValid = (r: GridRow): boolean => {
    if (isEmptyRow(r)) return true; // ignored on save
    if (!itemByValue.has(r.item)) return false;
    if (!r.txnDate) return false;
    if (monthBounds && (r.txnDate < monthBounds.min || r.txnDate > monthBounds.max)) return false;
    const amt = Number(r.amount);
    if (!(amt > 0)) return false;
    return true;
  };

  /** Canonical duplicate signature of the row AS IT WILL BE SAVED (resolved kind + date + amount + remarks) —
   *  mirrors the server's txnRowSignature so the client blocks byte-for-byte duplicates before submitting. */
  const rowSignature = (r: GridRow): string => {
    const p = resolveRow(r);
    const amt = Number(p.amount);
    return [p.kind, p.txnDate, Number.isFinite(amt) ? amt.toFixed(2) : p.amount, p.notes.trim().toLowerCase()].join('|');
  };

  const validate = (): boolean => {
    const bad = new Set<number>();
    rows.forEach((r, i) => {
      if (!rowIsValid(r)) bad.add(i);
    });
    // Duplicate-record validation (feedback 7b2d4228): flag every non-empty row whose saved shape is identical
    // to an earlier one (same item/date/amount/remarks) — a double-entry keying mistake.
    const seen = new Map<string, number>();
    let hasDuplicate = false;
    rows.forEach((r, i) => {
      if (isEmptyRow(r) || bad.has(i)) return;
      const sig = rowSignature(r);
      if (seen.has(sig)) {
        bad.add(i);
        bad.add(seen.get(sig)!);
        hasDuplicate = true;
      } else {
        seen.set(sig, i);
      }
    });
    // At least one non-empty valid row is required.
    const hasContent = rows.some((r) => !isEmptyRow(r));
    setRowErrors(bad);
    if (hasDuplicate) {
      setSaveError(t('duplicateRow'));
      return false;
    }
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
      .map((r) => {
        const p = resolveRow(r);
        return { kind: p.kind, txnDate: p.txnDate, amount: p.amount, notes: p.notes };
      });
    const fd = new FormData();
    fd.set('batchId', batchId);
    fd.set('employmentIds', JSON.stringify(selectedIds));
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
        {/* ── Step 1 — Employees (multi-select) ── */}
        {step === 0 && (
          <div className="space-y-4">
            {/* Filters — company / department / employment status narrow the list before the name/ID search.
                A single company is auto-selected above; department options derive from the visible set. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <Field label={t('deptFilter')}>
                <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className={inputCls}>
                  <option value="">{t('allDepartments')}</option>
                  {departmentOptions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('statusFilter')}>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
                  <option value="">{t('allStatuses')}</option>
                  <option value="active">{tFixed('statusActive')}</option>
                  <option value="ended">{tFixed('statusEnded')}</option>
                </select>
              </Field>
            </div>
            <Field label={t('employeeSearch')}>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className={inputCls}
              />
            </Field>

            {/* Selected-employee chips (removable) — a running summary of the payees the grid will apply to. */}
            {selectedEmployees.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('selectedCount', { count: selectedEmployees.length })}
                </span>
                {selectedEmployees.map((e) => (
                  <span
                    key={e.employmentId}
                    className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-foreground"
                  >
                    {e.name}
                    <button
                      type="button"
                      onClick={() => removeEmployee(e.employmentId)}
                      aria-label={t('removeEmployee', { name: e.name })}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedIds([])}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('clearSelection')}
                </button>
              </div>
            )}

            <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {searchResults.length === 0 && (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noEmployees')}</p>
              )}
              {searchResults.map((e) => {
                const checked = selectedIds.includes(e.employmentId);
                // Once a company is anchored by the first pick (and no company filter is set), employees in a
                // different company can't be added — a batch belongs to exactly one company.
                const otherCompany =
                  !checked && selectionCompanyId != null && e.companyId !== selectionCompanyId;
                return (
                  <label
                    key={e.employmentId}
                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      otherCompany ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-muted'
                    } ${checked ? 'bg-primary/10' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={otherCompany}
                      onChange={() => toggleEmployee(e.employmentId)}
                      className="size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">{e.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {e.company} · {e.employeeCode ?? '—'} · {e.department ?? '—'} · {e.position ?? '—'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            {capped && <p className="text-xs text-muted-foreground">{t('showingCapped', { cap: CAP, total: filteredEmployees.length })}</p>}
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
                {selectedEmployees.length > 1 ? t('noSharedDraft') : t('noDraftForSelection')}{' '}
                <a href={processHref} className="font-medium underline underline-offset-2">
                  {t('noDraftForSelectionLink')}
                </a>
              </p>
            )}
            {uncoveredEmployees.length > 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
                {t('coverageGapHint', { names: uncoveredEmployees.map((e) => e.name).join(', ') })}
              </p>
            )}
          </div>
        )}

        {/* ── Step 3 — Grid ── */}
        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t('txnIntro')}</p>
            {selectedEmployees.length > 1 && (
              <p className="text-xs text-muted-foreground">{t('applyAllHint', { count: selectedEmployees.length })}</p>
            )}
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
                        <select value={r.item} onChange={(e) => setRow(i, { item: e.target.value })} className={inputCls}>
                          <optgroup label={t('itemGroupGeneral')}>
                            {KINDS.map((k) => (
                              <option key={k} value={`k:${k}`}>
                                {t(`kindLabel.${k}`)}
                              </option>
                            ))}
                          </optgroup>
                          {masterEarnings.length > 0 && (
                            <optgroup label={t('itemGroupEarnings')}>
                              {masterEarnings.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {masterDeductions.length > 0 && (
                            <optgroup label={t('itemGroupDeductions')}>
                              {masterDeductions.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
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
              <div className="col-span-2 sm:col-span-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('reviewEmployees', { count: selectedEmployees.length })}
                </div>
                <div className="font-medium">
                  {selectedEmployees.length ? selectedEmployees.map((e) => e.name).join(', ') : '—'}
                </div>
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
              {t('reviewCount', {
                count: rows.filter((r) => !isEmptyRow(r)).length * Math.max(selectedEmployees.length, 1),
              })}
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
