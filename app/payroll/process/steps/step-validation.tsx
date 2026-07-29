'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { checkPayrollCycleReadiness, validatePayrollSelection } from '../actions';
import type { PreProcessAdvisory } from '@/core/payroll';
import type { IntendedRunType } from '@/core/payroll-run-group';

/**
 * Payroll Process wizard — Validation step (R37 70764928). Renders the pre-processing checks as an explicit
 * "is everything ready?" checkpoint BEFORE the terminal Process action, mirroring the reporter's requested
 * green / amber / red states (expected_behavior §4). It fetches the advisory for the CURRENT wizard
 * selection via the `validatePayrollSelection` server action, which reuses the exact same core check as the
 * batch-page card — so what you see here is what the run will enforce.
 *
 * Blocker rows (no salary record covering the period / zero basic-or-rate — feedback 64fb5e48: the
 * Personnel Basic Salary record is authoritative, a BASIC pay item is never required) turn the panel RED
 * and the parent disables Process. Warning rows (missing statutory profile / incomplete bank / stale BASIC
 * pay item) turn it AMBER — Process is still allowed. All-clear is GREEN. Status is reported up via
 * `onStatusChange` so the wizard footer can gate the Process button (and keep it disabled while the check
 * is still loading).
 *
 * Type-only import from '@/core/payroll' is erased at compile time (no server code pulled into the client
 * bundle), the same pattern the sibling steps use for their row types.
 */
export function StepValidation({
  companyIds,
  payPeriod,
  employmentIds,
  intendedRunType,
  onStatusChange,
}: {
  companyIds: string[];
  payPeriod: string;
  employmentIds?: string[];
  // Organization Module (361e3b15) — the run's intended cycle type, driving the missing-cycle pre-flight.
  // Omitted (e.g. resume mode, where the batch's cycle is already fixed) ⇒ the pre-flight is skipped.
  intendedRunType?: IntendedRunType;
  onStatusChange: (s: { loading: boolean; hasBlockers: boolean }) => void;
}) {
  const t = useTranslations('payroll.process');
  const [advisory, setAdvisory] = useState<PreProcessAdvisory | null>(null);
  const [loading, setLoading] = useState(true);
  // Organization Module (361e3b15) — companies with no active cycle of the intended run type (pre-flight).
  const [missingCycle, setMissingCycle] = useState<{ companyId: string; companyName: string }[]>([]);

  // A stable, order-independent key for the selection so the effect refires when the admin goes back and
  // changes companies / period / who is included — never on a bare array-reference change.
  const key = `${[...companyIds].sort().join(',')}|${payPeriod}|${[...(employmentIds ?? [])].sort().join(',')}|${intendedRunType ?? ''}`;

  useEffect(() => {
    let live = true;
    // Organization Module (361e3b15) — fire the missing-cycle pre-flight alongside the advisory (skipped when
    // no intended run type is supplied, e.g. resume mode). Purely informational: it names un-runnable
    // companies BEFORE submit; it does not itself block Process (the run reports them per-company too).
    if (intendedRunType) {
      checkPayrollCycleReadiness({ companyIds, intendedRunType })
        .then((rows) => {
          if (live) setMissingCycle(rows);
        })
        .catch(() => {
          if (live) setMissingCycle([]);
        });
    } else {
      setMissingCycle([]);
    }
    setLoading(true);
    onStatusChange({ loading: true, hasBlockers: false });
    validatePayrollSelection({ companyIds, payPeriod, employmentIds })
      .then((a) => {
        if (!live) return;
        setAdvisory(a);
        const hasBlockers = a.missingCompensation.length + (a.zeroBasic?.length ?? 0) > 0;
        onStatusChange({ loading: false, hasBlockers });
      })
      .catch(() => {
        if (!live) return;
        // A failed check must NOT silently unblock the run — treat it as loading-not-cleared so Process
        // stays disabled and the operator retries (going back and forward re-runs the check).
        setAdvisory(null);
        onStatusChange({ loading: false, hasBlockers: true });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable dependency for the selection
  }, [key]);

  if (loading) {
    return <p className="py-6 text-sm text-muted-foreground">{t('validationRunning')}</p>;
  }

  if (!advisory) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
        {t('validationFailed')}
      </div>
    );
  }

  const blockers = advisory.missingCompensation.length + (advisory.zeroBasic?.length ?? 0);
  // 297ae65a — a non-MYR/mixed-currency salary is an AMBER warning (Process stays allowed).
  // r79 — an explicit "Subject to HRDF = Yes" at an unregistered company is AMBER for the same reason:
  // the run is honest work that must not be blocked, but the contradiction has to be seen before Process.
  const warnings =
    advisory.missingStatutory.length +
    advisory.missingBank.length +
    (advisory.staleBasicComponent?.length ?? 0) +
    (advisory.currencyMismatch?.length ?? 0) +
    (advisory.hrdfSubjectUnregistered?.length ?? 0);

  // Organization Module (361e3b15) — a per-company AMBER note naming any selected company with no active cycle
  // of the intended run type. Rendered above the salary/statutory advisory so a payroll-ready company that is
  // nonetheless missing its cycle is never silently skipped.
  const missingCycleBanner =
    missingCycle.length > 0 ? (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
        <p className="font-medium">⚠ {t('validationMissingCycleTitle', { n: missingCycle.length })}</p>
        <ul className="mt-1 space-y-0.5 text-xs">
          {missingCycle.map((m) => (
            <li key={m.companyId}>{t('payrollCycleMissingForCompany', { company: m.companyName })}</li>
          ))}
        </ul>
      </div>
    ) : null;

  if (blockers + warnings === 0) {
    return (
      <div className="space-y-4">
        {missingCycleBanner}
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <span aria-hidden>✓</span> {t('validationAllClear')}
          </p>
          <p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-400/80">{t('validationAllClearHint')}</p>
        </div>
      </div>
    );
  }

  const groups: [keyof PreProcessAdvisory, typeof advisory.missingCompensation, boolean][] = [
    ['missingCompensation', advisory.missingCompensation, true],
    ['zeroBasic', advisory.zeroBasic ?? [], true],
    ['missingStatutory', advisory.missingStatutory, false],
    ['missingBank', advisory.missingBank, false],
    ['staleBasicComponent', advisory.staleBasicComponent ?? [], false],
    ['currencyMismatch', advisory.currencyMismatch ?? [], false],
    ['hrdfSubjectUnregistered', advisory.hrdfSubjectUnregistered ?? [], false],
  ];

  return (
    <div className="space-y-4">
      {missingCycleBanner}
      {blockers > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <p className="font-medium">✗ {t('validationBlockerTitle', { n: blockers })}</p>
          <p className="mt-0.5 text-xs">{t('validationBlockerHint')}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <p className="font-medium">⚠ {t('validationWarningTitle', { n: warnings })}</p>
          <p className="mt-0.5 text-xs">{t('validationWarningHint')}</p>
        </div>
      )}

      {groups.map(([groupKey, rows, isBlocker]) =>
        rows.length === 0 ? null : (
          <div key={groupKey}>
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                  isBlocker
                    ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                }`}
              >
                {isBlocker ? t('validationBlockerBadge') : t('validationWarningBadge')}
              </span>
              <span className="text-xs font-semibold text-foreground">
                {t(`validationCheck.${groupKey}`)} · {rows.length}
              </span>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {rows.map((r) => (
                <li key={r.employmentId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  {r.employeeCode && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {r.employeeCode}
                    </span>
                  )}
                  <span className="font-medium">{r.name}</span>
                </li>
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}
