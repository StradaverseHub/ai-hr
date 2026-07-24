'use client';

import { useActionState, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Card, ErrorBanner, Field, SectionHeader, inputCls, btnPrimary } from '@/components/ui';
import { delegationStatus, formatDelegationScope, isRevocable } from '@/lib/delegation-format';
import { DelegationScopePicker } from '@/components/delegation-scope-picker';
import { DelegationCreateForm } from '@/components/delegation-create-form';
import { DelegationOrgScopePicker, type OrgScopeMasters } from '@/components/delegation-org-scope-picker';
import {
  hrEditDelegationAction,
  hrRevokeDelegationAction,
  loadDelegationContextAction,
  revokeSelfDelegationAction,
  type DelegationActionResult,
  type DelegationContext,
} from '@/app/delegations/actions';

/**
 * Popup parity (feedback 29fe2d45) — ONE building block for BOTH delegation surfaces: the /delegations
 * page and the command-bar quick popup render this same component, so fields, rules and capabilities can
 * never drift apart again. It composes:
 *   • create — DelegationCreateForm (hr + self modes, coverage cascade, rank-aware candidates), or the
 *     noDownline message. The message replaces only the CREATE form — the LIST below renders for every
 *     authenticated user (a stand-in sees the delegations they are covering, via app.self_delegations).
 *   • list — the full-page table (status badges, scope column, history toggle for admins) with per-row
 *     admin edit (delegate picker, dates, coverage cascade prefilled from the stored row, scope picker)
 *     and revoke (admin any row, self-service their own).
 * Rows are keyed by delegation id so a refetch reconciles WITHOUT remounting — another row's open edit
 * <details> survives a save elsewhere. After any successful save the manager refetches its context AND
 * calls router.refresh() so an already-mounted /delegations behind the popup re-renders too
 * (revalidatePath alone does not repaint a mounted page). History toggling refetches client-side on both
 * surfaces; the URL never changes (?history=1 is just the page's initial value).
 */

type Row = DelegationContext['rows'][number];

export function DelegationManager({
  surface,
  initialContext,
  initialHistory = false,
}: {
  surface: 'page' | 'popup';
  initialContext: DelegationContext;
  initialHistory?: boolean;
}) {
  const t = useTranslations('delegations');
  const router = useRouter();
  const [ctx, setCtx] = useState(initialContext);
  const [history, setHistory] = useState(initialHistory);
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const refetch = useCallback(async (nextHistory: boolean) => {
    try {
      setCtx(await loadDelegationContextAction(nextHistory));
    } catch {
      // Transient refetch failure: keep showing the last good data rather than blanking the view.
    }
  }, []);

  // A server re-render (router.refresh() from the OTHER surface, or any navigation) hands down a fresh
  // initialContext. Adopt it so a mounted page behind the popup repaints after a popup save — unless this
  // instance has client-toggled history away from what the server fetched, in which case refetch instead.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (historyRef.current === initialHistory) setCtx(initialContext);
    else void refetch(historyRef.current);
  }, [initialContext, initialHistory, refetch]);

  const onSaved = useCallback(() => {
    void refetch(historyRef.current);
    router.refresh();
  }, [refetch, router]);

  const toggleHistory = () => {
    const next = !history;
    setHistory(next);
    void refetch(next);
  };

  const myIds = new Set(ctx.myEmploymentIds);
  const statusLabel = (status: 'active' | 'scheduled' | 'ended') =>
    status === 'active' ? t('statusActive') : status === 'scheduled' ? t('statusScheduled') : t('statusEnded');
  const statusVariant = (status: 'active' | 'scheduled' | 'ended'): 'success' | 'info' | 'default' =>
    status === 'active' ? 'success' : status === 'scheduled' ? 'info' : 'default';

  return (
    <div className={surface === 'popup' ? 'space-y-4' : 'space-y-6'}>
      {/* Create */}
      <Card>
        <SectionHeader title={t('createTitle')} />
        {ctx.admin ? (
          <DelegationCreateForm
            mode="hr"
            today={ctx.today}
            masters={ctx.masters}
            delegatorOptions={ctx.delegatorOptions}
            onSaved={onSaved}
          />
        ) : ctx.canSelfDelegate ? (
          <DelegationCreateForm
            mode="self"
            today={ctx.today}
            masters={ctx.masters}
            initialCandidates={ctx.initialCandidates}
            onSaved={onSaved}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">{t('noDownline')}</div>
        )}
      </Card>

      {/* List */}
      <Card>
        <div className="flex items-center justify-between px-4 pt-4">
          <SectionHeader title={t('listTitle')} count={ctx.rows.length} />
          {ctx.admin ? (
            <button type="button" onClick={toggleHistory} className="text-sm text-primary hover:underline">
              {history ? t('hideHistory') : t('showHistory')}
            </button>
          ) : null}
        </div>
        <div className="overflow-x-auto p-4">
          {ctx.rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('empty')}</div>
          ) : (
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3">{t('colFrom')}</th>
                  <th className="py-2 pr-3">{t('colTo')}</th>
                  <th className="py-2 pr-3">{t('colModule')}</th>
                  <th className="py-2 pr-3">{t('colStart')}</th>
                  <th className="py-2 pr-3">{t('colEnd')}</th>
                  <th className="py-2 pr-3">{t('colStatus')}</th>
                  <th className="py-2 pr-3 text-right">{t('colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {ctx.rows.map((r) => {
                  const status = delegationStatus(r, ctx.today);
                  const revocable = isRevocable(r, ctx.today);
                  const canRevokeSelf = !ctx.admin && myIds.has(r.delegatorEmploymentId);
                  return (
                    <tr key={r.id} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3">{r.delegatorName}</td>
                      <td className="py-2 pr-3">{r.delegateName}</td>
                      <td className="py-2 pr-3 text-muted-foreground" title={r.reason ?? undefined}>
                        {formatDelegationScope(r.scopes, t)}
                      </td>
                      <td className="py-2 pr-3">{r.validFrom}</td>
                      <td className="py-2 pr-3">{r.validTo ?? t('ongoing')}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-col items-end gap-2">
                          {ctx.admin && revocable ? (
                            <DelegationEditForm
                              row={r}
                              masters={ctx.masters}
                              delegatorOptions={ctx.delegatorOptions}
                              onSaved={onSaved}
                            />
                          ) : null}
                          {revocable && (ctx.admin || canRevokeSelf) ? (
                            <DelegationRevokeForm reportingLineId={r.id} admin={ctx.admin} onSaved={onSaved} />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Bridge a parent callback into a once-per-result effect: useActionState returns a FRESH state object per
 *  submit, so [state] fires exactly once per outcome regardless of the callback's render identity. */
function useOnSaved(state: DelegationActionResult | null, onSaved?: () => void) {
  const ref = useRef(onSaved);
  useEffect(() => {
    ref.current = onSaved;
  });
  useEffect(() => {
    if (state?.ok) ref.current?.();
  }, [state]);
}

/**
 * Per-row admin edit form (extracted from the R51 page markup). Its OWN useActionState — the hook is
 * per-form, so N rows carry N independent pending/error states. Coverage defaults come from the stored row.
 */
function DelegationEditForm({
  row: r,
  masters,
  delegatorOptions,
  onSaved,
}: {
  row: Row;
  masters: OrgScopeMasters;
  delegatorOptions: DelegationContext['delegatorOptions'];
  onSaved: () => void;
}) {
  const t = useTranslations('delegations');
  const [state, formAction, isPending] = useActionState<DelegationActionResult | null, FormData>(
    hrEditDelegationAction,
    null,
  );
  useOnSaved(state, onSaved);

  return (
    <details className="w-full">
      <summary className="cursor-pointer text-right text-primary hover:underline">{t('edit')}</summary>
      {/* Capped width: this form lives inside the Actions <td>, and its sm:grid-cols-2 + the org-scope
          picker's sm:grid-cols-3 of full-width selects are VIEWPORT queries, not container queries — so an
          open row would otherwise explode the cell's intrinsic width and push the table sideways. A closed
          <details> is display:none and contributes nothing, so collapsed rows are unaffected. */}
      <form
        action={formAction}
        className="mt-2 grid w-[32rem] max-w-full grid-cols-1 items-end gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
      >
        {state && !state.ok ? (
          <div className="sm:col-span-2">
            <ErrorBanner message={state.error} />
          </div>
        ) : null}
        {state?.ok ? (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300 sm:col-span-2">
            {t('saved')}
          </div>
        ) : null}
        <input type="hidden" name="reportingLineId" value={r.id} />
        <Field label={t('delegateTo')}>
          <select name="delegateEmploymentId" required className={inputCls} defaultValue={r.delegateEmploymentId}>
            {delegatorOptions
              .filter((p) => p.employmentId !== r.delegatorEmploymentId)
              .map((p) => (
                <option key={p.employmentId} value={p.employmentId}>
                  {p.name}
                  {p.employeeCode ? ` (${p.employeeCode})` : ''}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('start')}>
          <input name="validFrom" type="date" required defaultValue={r.validFrom} className={inputCls} />
        </Field>
        <Field label={t('end')}>
          <input name="validTo" type="date" defaultValue={r.validTo ?? ''} className={inputCls} />
        </Field>
        <div className="sm:col-span-2">
          {/* R51: coverage defaults come from the stored row (delegationsScoped). */}
          <DelegationOrgScopePicker
            masters={masters}
            defaultScope={{
              companyId: r.orgScope.companyId,
              businessUnitId: r.orgScope.businessUnitId,
              departmentId: r.orgScope.departmentId,
            }}
          />
        </div>
        <div className="sm:col-span-2">
          <DelegationScopePicker defaultReason={r.reason ?? ''} defaultScopes={r.scopes} />
        </div>
        <div className="sm:col-span-2">
          <button className={btnPrimary} disabled={isPending}>
            {t('save')}
          </button>
        </div>
      </form>
    </details>
  );
}

/**
 * Per-row revoke. No hidden endDate input (popup parity): the action defaults the end date to the server's
 * Kuala-Lumpur today, so a view left open past midnight can never post yesterday's date.
 */
function DelegationRevokeForm({
  reportingLineId,
  admin,
  onSaved,
}: {
  reportingLineId: string;
  admin: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations('delegations');
  const [state, formAction, isPending] = useActionState<DelegationActionResult | null, FormData>(
    admin ? hrRevokeDelegationAction : revokeSelfDelegationAction,
    null,
  );
  useOnSaved(state, onSaved);

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="reportingLineId" value={reportingLineId} />
      <button
        type="submit"
        disabled={isPending}
        className="text-xs text-muted-foreground transition-colors hover:text-red-500 disabled:opacity-50"
      >
        {t('revoke')}
      </button>
      {state && !state.ok ? <span className="max-w-56 text-right text-xs text-red-500">{state.error}</span> : null}
    </form>
  );
}
