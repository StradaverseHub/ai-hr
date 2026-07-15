import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { delegationsScoped, employmentPickerList, myEmployments } from '@/core/read';
import { hasDownline } from '@/core/org';
import { todayInKualaLumpur } from '@/core/leave';
import { Badge, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, btnPrimary } from '@/components/ui';
import { delegationStatus, formatDelegationScope, isRevocable } from '@/lib/delegation-format';
import { DelegationScopePicker } from '@/components/delegation-scope-picker';
import {
  createSelfDelegationAction,
  hrCreateDelegationAction,
  hrEditDelegationAction,
  hrRevokeDelegationAction,
  revokeSelfDelegationAction,
} from './actions';

/**
 * Global Delegation Management (Phase 1). A single screen listing who is covering approvals for whom, with
 * self-service (managers) and HR management (any employment, plus history). Server Component — it RENDERS
 * server-action forms and calls only pure helpers (delegationStatus / isRevocable) from a non-'use client'
 * module, so it stays on the safe side of the RSC boundary guard. No sidebar entry (per the request).
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string; history?: string }>;
}) {
  const { error, toast, history: historyParam } = await searchParams;
  const t = await getTranslations('delegations');
  // scopedSession (not a bare getSession) is the page guard the access matrix records: every authenticated
  // role reaches /delegations; the DATA is scoped in the reads (HR sees the tenant, a self-service user only
  // their own rows). We don't filter the delegation list by company scope — a delegation is a person↔person
  // handover, not a company-scoped list.
  const { s } = await scopedSession();
  const admin = isAdmin(s);
  const today = todayInKualaLumpur();
  const history = admin && historyParam === '1';

  const [rows, pickerRaw, mine] = await Promise.all([
    delegationsScoped(s, { isAdmin: admin, history, asOf: today }),
    employmentPickerList(s),
    admin ? Promise.resolve([]) : myEmployments(s),
  ]);
  const myIds = new Set(mine.map((m) => m.employmentId));
  // Self-service create is offered only to a manager (a caller employment with a downline).
  let selfCanDelegate = false;
  if (!admin) {
    for (const m of mine) {
      if (await hasDownline(s, m.employmentId, today)) {
        selfCanDelegate = true;
        break;
      }
    }
  }
  // The stand-in picker excludes the caller's own employments (no self-delegation).
  const delegateOptions = pickerRaw.filter((p) => !myIds.has(p.employmentId));

  const statusLabel = (status: 'active' | 'scheduled' | 'ended') =>
    status === 'active' ? t('statusActive') : status === 'scheduled' ? t('statusScheduled') : t('statusEnded');
  const statusVariant = (status: 'active' | 'scheduled' | 'ended'): 'success' | 'info' | 'default' =>
    status === 'active' ? 'success' : status === 'scheduled' ? 'info' : 'default';

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />
      {error ? <ErrorBanner message={error} /> : null}
      {toast ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {toast}
        </div>
      ) : null}

      {/* Create */}
      <Card>
        <SectionHeader title={t('createTitle')} />
        {admin ? (
          <form action={hrCreateDelegationAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-5">
            <Field label={t('colFrom')}>
              <select name="delegatorEmploymentId" required className={inputCls} defaultValue="">
                <option value="" disabled>
                  {t('choose')}
                </option>
                {pickerRaw.map((p) => (
                  <option key={p.employmentId} value={p.employmentId}>
                    {p.name}
                    {p.employeeCode ? ` (${p.employeeCode})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('colTo')}>
              <select name="delegateEmploymentId" required className={inputCls} defaultValue="">
                <option value="" disabled>
                  {t('choose')}
                </option>
                {pickerRaw.map((p) => (
                  <option key={p.employmentId} value={p.employmentId}>
                    {p.name}
                    {p.employeeCode ? ` (${p.employeeCode})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('start')}>
              <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label={t('end')}>
              <input name="validTo" type="date" className={inputCls} />
            </Field>
            <div className="sm:col-span-5">
              <DelegationScopePicker />
            </div>
            <div className="sm:col-span-5">
              <button className={btnPrimary}>{t('create')}</button>
            </div>
          </form>
        ) : selfCanDelegate ? (
          <form action={createSelfDelegationAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
            <p className="text-sm text-muted-foreground sm:col-span-4">{t('selfHint')}</p>
            <Field label={t('delegateTo')}>
              <select name="delegateEmploymentId" required className={inputCls} defaultValue="">
                <option value="" disabled>
                  {t('choose')}
                </option>
                {delegateOptions.map((p) => (
                  <option key={p.employmentId} value={p.employmentId}>
                    {p.name}
                    {p.employeeCode ? ` (${p.employeeCode})` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('start')}>
              <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label={t('end')}>
              <input name="validTo" type="date" className={inputCls} />
            </Field>
            <div className="sm:col-span-4">
              <DelegationScopePicker />
            </div>
            <div className="sm:col-span-4">
              <button className={btnPrimary}>{t('create')}</button>
            </div>
          </form>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">{t('noDownline')}</div>
        )}
      </Card>

      {/* List */}
      <Card>
        <div className="flex items-center justify-between px-4 pt-4">
          <SectionHeader title={t('listTitle')} count={rows.length} />
          {admin ? (
            <a
              href={history ? '/delegations' : '/delegations?history=1'}
              className="text-sm text-primary hover:underline"
            >
              {history ? t('hideHistory') : t('showHistory')}
            </a>
          ) : null}
        </div>
        <div className="overflow-x-auto p-4">
          {rows.length === 0 ? (
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
                {rows.map((r) => {
                  const status = delegationStatus(r, today);
                  const revocable = isRevocable(r, today);
                  const canRevokeSelf = !admin && myIds.has(r.delegatorEmploymentId);
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
                          {admin && revocable ? (
                            <details className="w-full">
                              <summary className="cursor-pointer text-right text-primary hover:underline">
                                {t('edit')}
                              </summary>
                              <form
                                action={hrEditDelegationAction}
                                className="mt-2 grid grid-cols-1 items-end gap-2 rounded-md border border-border p-3 sm:grid-cols-2"
                              >
                                <input type="hidden" name="reportingLineId" value={r.id} />
                                <Field label={t('delegateTo')}>
                                  <select name="delegateEmploymentId" required className={inputCls} defaultValue={r.delegateEmploymentId}>
                                    {pickerRaw
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
                                  <DelegationScopePicker defaultReason={r.reason ?? ''} defaultScopes={r.scopes} />
                                </div>
                                <div className="sm:col-span-2">
                                  <button className={btnPrimary}>{t('save')}</button>
                                </div>
                              </form>
                            </details>
                          ) : null}
                          {revocable && (admin || canRevokeSelf) ? (
                            <form action={admin ? hrRevokeDelegationAction : revokeSelfDelegationAction}>
                              <input type="hidden" name="reportingLineId" value={r.id} />
                              <input type="hidden" name="endDate" value={today} />
                              <button
                                type="submit"
                                className="text-xs text-muted-foreground transition-colors hover:text-red-500"
                              >
                                {t('revoke')}
                              </button>
                            </form>
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
