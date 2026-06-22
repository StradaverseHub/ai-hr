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
 * EPF election (ADR-0035 1C, #2). The 3 lawful KWSP modes; the manual employee/employer rate inputs show
 * ONLY for voluntary_excess (i-Topup) — for auto/exempt they're irrelevant and the service nulls them.
 * Maps the consultant's Auto / Manual-% / Manual-fixed / Semi-Auto / None onto the legislated three: rates
 * are at-or-above statutory; KWSP has no fixed-amount or below-statutory election (see ADR-0035 §4).
 */
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
  const [m, setM] = useState(mode ?? 'auto');
  const showRates = m === 'voluntary_excess';
  return (
    <>
      <Field label={t('epfMode')}>
        <select name="epfMode" value={m} onChange={(e) => setM(e.target.value)} className={inputCls}>
          <option value="auto">{t('epfModeAuto')}</option>
          <option value="voluntary_excess">{t('epfModeVoluntary')}</option>
          <option value="exempt">{t('epfModeExempt')}</option>
        </select>
      </Field>
      {showRates && (
        <div className="grid grid-cols-2 gap-3 sm:col-span-2">
          <Field label={t('epfEmployeeRate')}>
            <input name="epfEmployeeRate" type="number" min="11" max="100" step="0.01" defaultValue={employeeRate ?? ''} placeholder="11" className={inputCls} />
          </Field>
          <Field label={t('epfEmployerRate')}>
            <input name="epfEmployerRate" type="number" min="12" max="100" step="0.01" defaultValue={employerRate ?? ''} placeholder="13" className={inputCls} />
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('epfVoluntaryHint')}</p>
        </div>
      )}
    </>
  );
}
