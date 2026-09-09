'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Field, inputCls } from '@/components/ui';
import { resumeHref } from '../selection-logic';

export type ExistingRun = {
  id: string;
  companyId: string;
  payPeriod: string;
  runType: string;
  status: string;
  company: string;
};

/** f1bbc572 — `sharedSystemLabels` is the company's Shared System Labels opt-out, carried because the
 *  GLOBAL branch of the Step-2 label catalogs is gated on it exactly as the server-side resolver is
 *  (core/system-labels.ts visibleLabelIdsCondition). Step 1 itself never reads it. */
export type Company = { id: string; name: string; sharedSystemLabels: boolean };

/** The four fixed behavioural run types a configured cycle maps to (mirrors payrollRunTypeEnum). */
export type CycleRunType = 'regular' | 'off_cycle' | 'bonus' | 'adjustment';

/** ADR-0069: a configurable cycle option, sourced from the payroll_cycle catalog. `id` is the selected
 *  value submitted to the wizard; `runType` drives the same gating the hardcoded list used to. */
export type CycleOption = { id: string; name: string; runType: CycleRunType; remarks: string | null; description: string | null };

/** Step 1 (3c / 3653d14b) — company MULTI-select ("one, several, or all"), month/year, cycle (DB-driven),
 *  payment date; per-company existing-runs indicators so already-processed companies are visible up front. */
export function StepPeriod({
  companies,
  companyIds,
  onCompanyIds,
  selectAll,
  onSelectAll,
  payPeriod,
  onPayPeriod,
  cycleId,
  onCycleId,
  cycleOptions,
  paymentDate,
  onPaymentDate,
  defaultPaymentDate,
  multiCycle,
  existingRuns,
}: {
  companies: Company[];
  companyIds: string[];
  onCompanyIds: (v: string[]) => void;
  selectAll: boolean;
  onSelectAll: (v: boolean) => void;
  payPeriod: string;
  onPayPeriod: (v: string) => void;
  cycleId: string;
  onCycleId: (v: string) => void;
  cycleOptions: CycleOption[];
  paymentDate: string;
  onPaymentDate: (v: string) => void;
  defaultPaymentDate: string;
  multiCycle: boolean;
  existingRuns: ExistingRun[];
}) {
  const t = useTranslations('payroll.process');
  const selectedSet = new Set(companyIds);
  // The "primary" company (first selected) still drives the cycle-availability gating below — Phase 1 uses a
  // single shared cycle across the selected companies (plan §"Step 1"), so the regular-exists check keys off
  // the primary company; per-company already-processed state is surfaced in the per-company list instead.
  const primaryId = companyIds[0] ?? '';
  const runsForPeriod = existingRuns.filter((r) => r.companyId === primaryId && r.payPeriod === payPeriod);
  const regularExists = runsForPeriod.some((r) => r.runType === 'regular');
  const regularRun = runsForPeriod.find((r) => r.runType === 'regular');

  // The selected cycle's mapped run type drives the "only one regular per period" gating exactly as the
  // old literal 'regular' compare did — but keyed off the resolved runType, not the label.
  const selectedRunType = cycleOptions.find((c) => c.id === cycleId)?.runType;

  // Each configured cycle becomes an option. A regular-mapped cycle is disabled once a regular run exists;
  // a non-regular cycle is disabled until one does (unchanged behaviour). The multiCycle flag continues to
  // gate visibility upstream (page.tsx / wizard filter this list to regular-only when the flag is off).
  const options = cycleOptions.map((c) => ({
    id: c.id,
    label: c.name,
    runType: c.runType,
    disabled: c.runType === 'regular' ? regularExists : !regularExists,
  }));

  // Whether a REGULAR run already exists for a given company this period — surfaced per row so the admin
  // sees the "already processed" companies BEFORE running (pre-empting PERIOD_ALREADY_PROCESSED failures).
  const regularExistsFor = (id: string) =>
    existingRuns.some((r) => r.companyId === id && r.payPeriod === payPeriod && r.runType === 'regular');

  const toggleCompany = (id: string) => {
    // A manual company toggle turns OFF "all" (the selection is no longer necessarily the full list) and
    // add/removes the id. Empty selection is allowed mid-edit; the submit gate requires at least one.
    onSelectAll(false);
    const next = new Set(companyIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onCompanyIds([...next]);
  };

  const toggleAll = (checked: boolean) => {
    onSelectAll(checked);
    // "All my companies" is bounded to the provided (already scoped) list — never wider. The server
    // re-resolves "all" to the admin's grants, so this is a convenience mirror of the scoped set.
    onCompanyIds(checked ? companies.map((c) => c.id) : []);
  };

  return (
    <div className="space-y-4">
      <Field label={t('companies')}>
        <div className="space-y-1.5 rounded-lg border border-border p-2">
          <label className="flex items-center gap-1.5 border-b border-border pb-1.5 text-sm font-medium">
            <input
              type="checkbox"
              checked={selectAll || (companies.length > 0 && companyIds.length === companies.length)}
              onChange={(e) => toggleAll(e.target.checked)}
              className="size-4 rounded"
            />
            {t('allMyCompanies')}
          </label>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {companies.map((c) => {
              const already = regularExistsFor(c.id);
              return (
                <label key={c.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(c.id)}
                    onChange={() => toggleCompany(c.id)}
                    className="size-4 rounded"
                  />
                  <span>{c.name}</span>
                  {already && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">({t('alreadyProcessedTag')})</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('payPeriod')}>
          <input
            type="month"
            value={payPeriod}
            onChange={(e) => onPayPeriod(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('cycleLabel')}>
          <select value={cycleId} onChange={(e) => onCycleId(e.target.value)} className={inputCls}>
            {options.length === 0 && <option value="">{t('noCyclesConfigured')}</option>}
            {options.map((o) => (
              <option key={o.id} value={o.id} disabled={o.disabled}>
                {o.label}
                {o.disabled ? ` (${t('cycleDisabled')})` : ''}
              </option>
            ))}
          </select>
          {/* The selected cycle's free-text Processing Behaviour note — business reference for the admin. */}
          {(() => {
            const note = cycleOptions.find((c) => c.id === cycleId)?.description;
            return note ? <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{note}</p> : null;
          })()}
        </Field>
        <Field label={t('paymentDate')}>
          <input
            type="date"
            value={paymentDate || defaultPaymentDate}
            onChange={(e) => onPaymentDate(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      {!multiCycle && (
        <p className="text-xs text-muted-foreground">{t('multiCycleOffNote')}</p>
      )}

      {runsForPeriod.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <div className="mb-1.5 font-medium text-foreground">{t('existingRunsTitle')}</div>
          <ul className="space-y-1">
            {runsForPeriod.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t(`runType.${r.runType}`)} · <span className="capitalize">{r.status}</span>
                </span>
                {/* A DRAFT run resumes into the wizard at Employee Selection (the "who's in this run" step,
                    formerly bypassed for drafts). Processed/closed runs keep their direct read-only link. */}
                <Link
                  href={resumeHref(r.id, r.status)}
                  className="font-medium text-primary hover:underline"
                >
                  {t('resumeDraft')}
                </Link>
              </li>
            ))}
          </ul>
          {regularExists && selectedRunType === 'regular' && (
            <p className="mt-1.5 text-amber-700 dark:text-amber-400">
              {t('regularExistsNote', { period: regularRun?.payPeriod ?? payPeriod })}
            </p>
          )}
        </div>
      )}

      {/* 3653d14b: payroll transactions (allowances, deductions, overtime, claims, adjustments) are a
          PREREQUISITE keyed in on the separate Transactions screen — this workflow only scopes the run and
          executes the calculation. State the boundary so the admin knows transactions must already be done. */}
      <p className="text-xs text-muted-foreground">{t('transactionsPrerequisiteNote')}</p>
    </div>
  );
}
