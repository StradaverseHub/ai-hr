'use client';

import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorBanner, inputCls, btnPrimary } from '@/components/ui';
import { DelegationScopePicker } from '@/components/delegation-scope-picker';
import {
  DelegationOrgScopePicker,
  candidateInScope,
  type OrgScopeMasters,
  type OrgScopeSelection,
} from '@/components/delegation-org-scope-picker';
import {
  createSelfDelegationAction,
  hrCreateDelegationAction,
  loadEligibleDelegatesAction,
  type DelegationActionResult,
} from '@/app/delegations/actions';

/**
 * R51 (baf56348) — the delegation CREATE forms, now rank-aware + coverage-aware. One client component, two
 * modes sharing the cascade + candidate filtering:
 *   • self — the caller's same-level candidates are computed at page render and passed in.
 *   • hr   — candidates load ONCE when HR picks the delegator (loadEligibleDelegatesAction); coverage
 *     changes only re-filter client-side (useMemo — the step-selection pattern, no round-trips).
 * The candidate list is the SECURITY-DEFINER eligible list (same highest approval level as the delegator,
 * across the whole organisation); choosing a coverage area narrows it further. The engine's same-level
 * guard re-validates server-side, so this UI is a convenience, not the enforcement.
 *
 * Popup parity (29fe2d45): submits through useActionState (precedent components/claim-form.tsx) — the
 * action returns { ok } / { ok: false, error } and the outcome renders INLINE (a localized saved banner or
 * an error banner), so the form works identically inside the command-bar popup and on the full page with
 * no navigation. `onSaved` lets the surface (DelegationManager) refetch the list + router.refresh().
 */

export type DelegateCandidate = {
  employmentId: string;
  name: string;
  companyId: string;
  businessUnitId: string | null;
  departmentId: string | null;
  level: string;
};

type DelegatorOption = { employmentId: string; name: string; employeeCode: string | null };

const EMPTY_SCOPE: OrgScopeSelection = { companyId: null, businessUnitId: null, departmentId: null };

export function DelegationCreateForm({
  mode,
  today,
  masters,
  delegatorOptions = [],
  initialCandidates = [],
  onSaved,
}: {
  mode: 'hr' | 'self';
  today: string;
  masters: OrgScopeMasters;
  /** hr mode: the "delegate from" picker (all active employments). */
  delegatorOptions?: DelegatorOption[];
  /** self mode: the caller's same-level candidates, computed at page render. */
  initialCandidates?: DelegateCandidate[];
  /** Fired after a successful create so the surface can refetch its list (popup parity, 29fe2d45). */
  onSaved?: () => void;
}) {
  const t = useTranslations('delegations');
  const [candidates, setCandidates] = useState<DelegateCandidate[]>(initialCandidates);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [scope, setScope] = useState<OrgScopeSelection>(EMPTY_SCOPE);
  const [state, formAction, isPending] = useActionState<DelegationActionResult | null, FormData>(
    mode === 'hr' ? hrCreateDelegationAction : createSelfDelegationAction,
    null,
  );
  // onSaved goes through a ref so the effect fires exactly once per RESULT (each submit returns a fresh
  // state object) — a parent re-render handing down a new callback identity must not re-trigger it.
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  });
  useEffect(() => {
    if (state?.ok) onSavedRef.current?.();
  }, [state]);

  const visibleCandidates = useMemo(
    () => candidates.filter((c) => candidateInScope(c, scope)),
    [candidates, scope],
  );

  const onDelegatorChange = (employmentId: string) => {
    if (!employmentId) {
      setCandidates([]);
      return;
    }
    setLoadingCandidates(true);
    loadEligibleDelegatesAction(employmentId)
      .then((rows) => setCandidates(rows))
      .catch(() => setCandidates([]))
      .finally(() => setLoadingCandidates(false));
  };

  const cols = mode === 'hr' ? 'sm:grid-cols-5' : 'sm:grid-cols-4';
  const span = mode === 'hr' ? 'sm:col-span-5' : 'sm:col-span-4';

  return (
    <form action={formAction} className={`grid grid-cols-1 items-end gap-3 p-4 ${cols}`}>
      {state && !state.ok ? (
        <div className={span}>
          <ErrorBanner message={state.error} />
        </div>
      ) : null}
      {state?.ok ? (
        <div
          className={`rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300 ${span}`}
        >
          {t('saved')}
        </div>
      ) : null}
      {mode === 'self' ? <p className={`text-sm text-muted-foreground ${span}`}>{t('selfHint')}</p> : null}
      {mode === 'hr' ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('colFrom')}</span>
          <select
            name="delegatorEmploymentId"
            required
            defaultValue=""
            onChange={(e) => onDelegatorChange(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              {t('choose')}
            </option>
            {delegatorOptions.map((p) => (
              <option key={p.employmentId} value={p.employmentId}>
                {p.name}
                {p.employeeCode ? ` (${p.employeeCode})` : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('delegateTo')}</span>
        <select name="delegateEmploymentId" required defaultValue="" className={inputCls}>
          <option value="" disabled>
            {loadingCandidates ? t('loadingCandidates') : t('choose')}
          </option>
          {visibleCandidates.map((p) => (
            <option key={p.employmentId} value={p.employmentId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('start')}</span>
        <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t('end')}</span>
        <input name="validTo" type="date" className={inputCls} />
      </label>
      <p className={`text-xs text-muted-foreground ${span}`}>{t('eligibleHint')}</p>
      <div className={span}>
        <DelegationOrgScopePicker masters={masters} onChange={setScope} />
      </div>
      <div className={span}>
        <DelegationScopePicker />
      </div>
      <div className={span}>
        <button className={btnPrimary} disabled={isPending}>
          {t('create')}
        </button>
      </div>
    </form>
  );
}
