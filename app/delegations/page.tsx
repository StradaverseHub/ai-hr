import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { isAdmin } from '@/lib/authz';
import { delegationsScoped, eligibleDelegates, employmentPickerList, listCompanies, listDepartments, myEmployments } from '@/core/read';
import { listBusinessUnits } from '@/core/admin';
import { approverLevelOf, hasDownline } from '@/core/org';
import { todayInKualaLumpur } from '@/core/leave';
import { Badge, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, btnPrimary } from '@/components/ui';
import { delegationStatus, formatDelegationScope, isRevocable } from '@/lib/delegation-format';
import { DelegationScopePicker } from '@/components/delegation-scope-picker';
import { DelegationCreateForm, type DelegateCandidate } from '@/components/delegation-create-form';
import { DelegationOrgScopePicker, type OrgScopeMasters } from '@/components/delegation-org-scope-picker';
import {
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

  const [rows, pickerRaw, mine, companiesRaw, businessUnitsRaw, departmentsRaw] = await Promise.all([
    delegationsScoped(s, { isAdmin: admin, history, asOf: today }),
    employmentPickerList(s),
    admin ? Promise.resolve([]) : myEmployments(s),
    // R51 (baf56348): coverage cascade masters (tenant-readable under RLS, so self-service works too).
    listCompanies(s),
    listBusinessUnits(s),
    listDepartments(s),
  ]);
  const myIds = new Set(mine.map((m) => m.employmentId));
  const masters: OrgScopeMasters = {
    companies: companiesRaw.map((c) => ({ id: c.id, name: c.name })),
    businessUnits: businessUnitsRaw.map((b) => ({ id: b.id, name: b.name, companyId: b.companyId })),
    departments: departmentsRaw.map((d) => ({
      id: d.id,
      name: d.name,
      companyId: d.companyId,
      businessUnitId: d.businessUnitId,
    })),
  };
  // Self-service create is offered to an APPROVER: a caller employment with a downline OR (R51) a
  // department/BU headship — a pure head with no administrative reports clearly holds approval duties.
  let selfDelegator: string | null = null;
  if (!admin) {
    for (const m of mine) {
      if (
        (await hasDownline(s, m.employmentId, today)) ||
        (await approverLevelOf(s, m.employmentId, today)) !== 'none'
      ) {
        selfDelegator = m.employmentId;
        break;
      }
    }
  }
  const selfCanDelegate = selfDelegator != null;
  // R51: the "delegate to" list is RANK-aware — same-level candidates from the SECURITY-DEFINER eligible
  // list (siblings across the org the caller cannot see under plain RLS), computed at page render.
  const selfCandidates: DelegateCandidate[] = selfDelegator ? await eligibleDelegates(s, selfDelegator) : [];

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
          <DelegationCreateForm mode="hr" today={today} masters={masters} delegatorOptions={pickerRaw} />
        ) : selfCanDelegate ? (
          <DelegationCreateForm
            mode="self"
            today={today}
            masters={masters}
            initialCandidates={selfCandidates.filter((c) => !myIds.has(c.employmentId))}
          />
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
