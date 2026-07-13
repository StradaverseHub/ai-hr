'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

// Inlined from components/ui (server module) so this stays a clean client island.
const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * EPF election (ADR-0035 §4, ADR-0046, #2). The consultant's five named categories are surfaced as five
 * UI options, each mapped at the server boundary onto the THREE lawful KWSP enum values:
 *   • Auto                     → auto            (statutory Third Schedule banding; no rates)
 *   • Manual (By Percentage)   → voluntary_excess (employee% + employer% elected, each ≥ statutory)
 *   • Semi-Auto                → voluntary_excess (employee% elected; employer stays statutory — null)
 *   • Manual (By Fixed Amount) → DEFERRED         (no KWSP fixed-amount election; ADR-0046 §"deferred")
 *   • No Contribution          → exempt           (zeroes both sides; exempt employees only)
 * The manual rate inputs show only for the percentage paths; the server (actions.ts) maps the UI value
 * down to the enum and nulls the irrelevant rates. KWSP has no below-statutory or fixed-amount election.
 */
type UiMode = 'auto' | 'manual_percentage' | 'semi_auto' | 'manual_fixed' | 'none';

/** Derive the initial UI selection from the persisted enum + rate shape (the category is not stored). */
function uiModeFrom(mode: string | null, employeeRate: number | null, employerRate: number | null): UiMode {
  if (mode === 'exempt') return 'none';
  if (mode === 'voluntary_excess') {
    // Semi-Auto = employee side elected, employer side left statutory (null).
    return employeeRate != null && employerRate == null ? 'semi_auto' : 'manual_percentage';
  }
  return 'auto';
}

export function EpfElection({
  mode,
  employeeRate,
  employerRate,
}: {
  mode: string | null;
  employeeRate: number | null; // already in percent (e.g. 11), or null
  employerRate: number | null;
}) {
  const t = useTranslations('people.detail');
  const [m, setM] = useState<UiMode>(uiModeFrom(mode, employeeRate, employerRate));
  const showEmployeeRate = m === 'manual_percentage' || m === 'semi_auto';
  const showEmployerRate = m === 'manual_percentage';
  return (
    <>
      <Field label={t('epfMode')}>
        <select name="epfMode" value={m} onChange={(e) => setM(e.target.value as UiMode)} className={inputCls}>
          <option value="auto">{t('epfModeAuto')}</option>
          <option value="manual_percentage">{t('epfModeManualPercentage')}</option>
          <option value="semi_auto">{t('epfModeSemiAuto')}</option>
          {/* manual_fixed (deferred per ADR-0046 — no KWSP fixed-amount election) removed from the
              dropdown per feedback 127dffba; the UiMode union still tolerates it defensively but it is
              never offered or persisted. */}
          <option value="none">{t('epfModeExempt')}</option>
        </select>
      </Field>
      {(showEmployeeRate || showEmployerRate) && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          {showEmployeeRate && (
            <Field label={t('epfEmployeeRate')}>
              <input name="epfEmployeeRate" type="number" min="11" max="100" step="0.01" defaultValue={employeeRate ?? ''} placeholder="11" className={inputCls} />
            </Field>
          )}
          {showEmployerRate && (
            <Field label={t('epfEmployerRate')}>
              <input name="epfEmployerRate" type="number" min="12" max="100" step="0.01" defaultValue={employerRate ?? ''} placeholder="13" className={inputCls} />
            </Field>
          )}
          {m === 'semi_auto' ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfSemiAutoHint')}</p>
          ) : (
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfVoluntaryHint')}</p>
          )}
        </div>
      )}
    </>
  );
}
