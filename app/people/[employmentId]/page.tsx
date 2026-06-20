import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isAdmin } from '@/lib/authz';
import {
  assignmentHistory,
  employeeAudit,
  employeeDetail,
  leaveBalances,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  reportingLinesFor,
} from '@/core/read';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, btnPrimary, inputCls } from '@/components/ui';
import { AuditTable } from '@/components/audit-table';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  addReportingLineAction,
  endReportingLineAction,
  setCompensationAction,
  setEmploymentComponentAction,
  setPersonAction,
  setStatutoryAction,
  terminateAction,
  transferAction,
} from './actions';
import { currentCompensation } from '@/core/comp';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { listEmploymentPayComponents, listPayComponents } from '@/core/pay-components';

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
};

function LeaveStatus({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${LEAVE_STATUS[status] ?? ''}`}>
      {label}
    </span>
  );
}

function LineTypeBadge({ type, dottedLabel }: { type: string; dottedLabel: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {type === 'dotted' ? dottedLabel : type}
    </span>
  );
}

export default async function EmployeePage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ error?: string; from?: string }>;
}) {
  const s = await getSession();
  const t = await getTranslations('people.detail');
  const admin = isAdmin(s);
  const { employmentId } = await params;
  const { error, from } = await searchParams;
  // Context-aware back link: came from the org chart (?from=org) → return there; otherwise the
  // people directory. Keeps the `from` param flowing through so nested navigation stays consistent.
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/people', label: t('backToPeople') };

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  const today = new Date().toISOString().slice(0, 10);

  const [history, balances, requests, departments, reporting, employees] = await Promise.all([
    assignmentHistory(s, employmentId),
    leaveBalances(s, employmentId),
    leaveRequestsFor(s, employmentId),
    listDepartments(s),
    reportingLinesFor(s, employmentId),
    listEmployees(s),
  ]);
  // Pay + statutory (salary, IC, bank, tax) are HR-admin-only on this directory page — never load or
  // render them for a manager viewing a direct report (consultant feedback #5). Compensation reads are
  // also tightened to admin-or-self at the RLS layer (migration 0060); this avoids fetching them at all.
  const comp = admin ? await currentCompensation(s, employmentId) : null;
  const statutory = admin ? await getStatutoryProfileMY(s, emp.personId) : null;
  // Typed pay components (Wave 3 #9) — recurring components for this employee + the catalog to add from.
  const payComps = admin ? await listEmploymentPayComponents(s, employmentId) : [];
  const componentCatalog = admin ? await listPayComponents(s) : [];
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);
  const changeHistory = admin ? await employeeAudit(s, employmentId) : [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        back={back}
        title={emp.name}
        description={t('headerDescription', {
          code: emp.employeeCode ?? '—',
          email: emp.email,
          company: emp.company,
          hiredOn: emp.hiredOn,
        })}
        actions={<StatusBadge status={emp.terminatedOn ? 'terminated' : (current?.status ?? null)} />}
      />

      <ErrorBanner message={error} />

      {admin && (
        <Card>
          <SectionHeader title={t('personalDetails')} />
          <form
            action={setPersonAction}
            className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <Field label={t('fullName')}>
              <input name="fullName" required defaultValue={emp.name} className={inputCls} />
            </Field>
            <Field label={t('email')}>
              <input name="primaryEmail" type="email" required defaultValue={emp.email} className={inputCls} />
            </Field>
            <Field label={t('phone')}>
              <input name="phone" defaultValue={emp.phone ?? ''} placeholder="+60…" className={inputCls} />
            </Field>
            <div className="sm:col-span-3 flex justify-end">
              <button className={btnPrimary}>{t('saveDetails')}</button>
            </div>
          </form>
        </Card>
      )}

      {admin && componentCatalog.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('payComponentsTitle')} count={payComps.length} />
          {payComps.length > 0 && (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {payComps.map((pc) => (
                  <tr key={pc.id}>
                    <td className="px-4 py-2.5 font-mono text-xs">{pc.code}</td>
                    <td className="px-4 py-2.5">{pc.name}</td>
                    <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(pc.amount).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form action={setEmploymentComponentAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('payComponent')}>
              <select name="componentId" required className={inputCls}>
                {componentCatalog.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </Field>
            <Field label={t('payComponentAmount')}>
              <input name="amount" type="number" min="0" step="0.01" required className={inputCls} />
            </Field>
            <Field label={t('payComponentEffectiveFrom')}>
              <input name="effectiveFrom" type="date" required defaultValue={emp.hiredOn} className={inputCls} />
            </Field>
            <button className={btnPrimary}>{t('payComponentSave')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('payComponentsHint')}</p>
        </Card>
      )}

      <Card>
        <SectionHeader title={t('leaveBalance')} />
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {balances.map((b) => (
            <div key={b.leaveTypeId} className="p-4">
              <div className="text-xs text-muted-foreground">{b.leaveType}</div>
              <div className="text-2xl font-semibold tabular-nums">
                {b.accrued > 0 || b.balance > 0 ? (
                  <>
                    {b.available}
                    <span className="text-sm font-normal text-muted-foreground"> {t('availableSuffix', { accrued: b.accrued })}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {b.pending > 0
                  ? t('usedWithPending', { taken: b.taken, pending: b.pending })
                  : t('used', { taken: b.taken })}
              </div>
            </div>
          ))}
          {balances.length === 0 && <div className="p-4 text-sm text-muted-foreground">{t('noLeaveRecords')}</div>}
        </div>
      </Card>

      {admin && (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <SectionHeader title={t('compensation')} />
          <div className="p-4">
            {comp ? (
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums">
                  {comp.currency} {Number(comp.basicSalary).toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {Number(comp.monthlyAllowance) > 0
                    ? t('compMetaWithAllowance', {
                        allowance: Number(comp.monthlyAllowance).toLocaleString(),
                        validFrom: comp.validFrom,
                      })
                    : t('compMeta', { validFrom: comp.validFrom })}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('noCompensation')}</p>
            )}
          </div>
          {!emp.terminatedOn && (
            <form
              action={setCompensationAction}
              className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-3"
            >
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <input type="hidden" name="effectiveFrom" value="2026-06-05" />
              <Field label={t('basicSalaryMyr')}>
                <input
                  name="basicSalary"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  defaultValue={comp ? Number(comp.basicSalary) : ''}
                  className={inputCls}
                />
              </Field>
              <Field label={t('allowance')}>
                <input
                  name="monthlyAllowance"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={comp ? Number(comp.monthlyAllowance) : 0}
                  className={inputCls}
                />
              </Field>
              <button className={btnPrimary}>{t('updatePay')}</button>
            </form>
          )}
        </Card>

        <Card>
          <SectionHeader title={t('statutoryMalaysia')} />
          <form action={setStatutoryAction} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <Field label={t('icNumber')}>
              <input name="icNumber" required defaultValue={statutory?.icNumber ?? ''} placeholder="900101011234" className={inputCls} />
            </Field>
            <Field label={t('epfNumber')}>
              <input name="epfNumber" defaultValue={statutory?.epfNumber ?? ''} className={inputCls} />
            </Field>
            <Field label={t('socsoNumber')}>
              <input name="socsoNumber" defaultValue={statutory?.socsoNumber ?? ''} className={inputCls} />
            </Field>
            <Field label={t('taxNumber')}>
              <input name="taxNumber" defaultValue={statutory?.taxNumber ?? ''} className={inputCls} />
            </Field>
            <Field label={t('pcbCategory')}>
              <select name="taxCategory" defaultValue={String(statutory?.taxCategory ?? 1)} className={inputCls}>
                <option value="1">{t('pcbCategory1')}</option>
                <option value="2">{t('pcbCategory2')}</option>
                <option value="3">{t('pcbCategory3')}</option>
              </select>
            </Field>
            <Field label={t('childrenPcbRelief')}>
              <input
                name="numChildren"
                type="number"
                min="0"
                step="1"
                defaultValue={statutory?.numChildren ?? 0}
                className={inputCls}
              />
            </Field>
            <Field label={t('bank')}>
              <input name="bankName" defaultValue={statutory?.bankName ?? ''} className={inputCls} />
            </Field>
            <Field label={t('bankAccount')}>
              <input name="bankAccountNo" defaultValue={statutory?.bankAccountNo ?? ''} className={inputCls} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="eisEligible" defaultChecked={statutory ? statutory.eisEligible : true} className="size-4 rounded" />
              {t('eisEligible')}
            </label>
            <label className="flex items-center gap-2 text-sm" title={t('taxResidentHint')}>
              <input type="checkbox" name="isResident" defaultChecked={statutory ? statutory.isResident : true} className="size-4 rounded" />
              {t('taxResident')}
            </label>
            <div className="sm:col-span-2 border-t border-border pt-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('epfContribTitle')}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{t('epfElectionHint')}</p>
            </div>
            <Field label={t('epfMode')}>
              <select name="epfMode" defaultValue={statutory?.epfMode ?? 'auto'} className={inputCls}>
                <option value="auto">{t('epfModeAuto')}</option>
                <option value="voluntary_excess">{t('epfModeVoluntary')}</option>
                <option value="exempt">{t('epfModeExempt')}</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('epfEmployeeRate')}>
                <input
                  name="epfEmployeeRate"
                  type="number"
                  min="11"
                  max="100"
                  step="0.01"
                  defaultValue={statutory?.epfEmployeeRate ? Number(statutory.epfEmployeeRate) * 100 : ''}
                  placeholder="11"
                  className={inputCls}
                />
              </Field>
              <Field label={t('epfEmployerRate')}>
                <input
                  name="epfEmployerRate"
                  type="number"
                  min="12"
                  max="100"
                  step="0.01"
                  defaultValue={statutory?.epfEmployerRate ? Number(statutory.epfEmployerRate) * 100 : ''}
                  placeholder="13"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="sm:col-span-2 border-t border-border pt-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('tp3SectionTitle')}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('tp3SectionDescription')}
              </p>
            </div>
            <Field label={t('appliesToYear')}>
              <input name="tp3Year" type="number" min="2020" max="2100" defaultValue={statutory?.tp3Year ?? ''} placeholder="2026" className={inputCls} />
            </Field>
            <Field label={t('tp3NetRemuneration')}>
              <input name="tp3NetRemuneration" type="number" min="0" step="0.01" defaultValue={statutory?.tp3NetRemuneration ?? ''} className={inputCls} />
            </Field>
            <Field label={t('tp3EpfClaimed')}>
              <input name="tp3EpfClaimed" type="number" min="0" step="0.01" defaultValue={statutory?.tp3EpfClaimed ?? ''} className={inputCls} />
            </Field>
            <Field label={t('tp3PcbPaid')}>
              <input name="tp3PcbPaid" type="number" min="0" step="0.01" defaultValue={statutory?.tp3PcbPaid ?? ''} className={inputCls} />
            </Field>
            <div className="flex items-end justify-end sm:col-span-2">
              <button className={btnPrimary}>{t('saveStatutory')}</button>
            </div>
          </form>
        </Card>
      </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('assignmentHistory')} count={history.length} />
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">{t('periodValidTime')}</th>
              <th className="px-4 py-2 font-medium">{t('department')}</th>
              <th className="px-4 py-2 font-medium">{t('position')}</th>
              <th className="px-4 py-2 font-medium">{t('status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {history.map((h) => (
              <tr key={h.id} className={!h.validTo ? 'bg-primary/5' : ''}>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {h.validFrom} → {h.validTo ?? t('present')}
                </td>
                <td className="px-4 py-2.5 text-foreground">{h.department ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{h.position ?? '—'}</td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={h.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {admin && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('changeHistory')} count={changeHistory.length} />
          <AuditTable rows={changeHistory} nowMs={Date.now()} />
        </Card>
      )}

      <Card>
        <SectionHeader title={t('reportingLines')} />
        <div className="grid grid-cols-1 divide-border sm:grid-cols-2 sm:divide-x">
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('reportsTo')}</div>
            {reporting.managers.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t('noManagers')}</div>
            ) : (
              <ul className="space-y-2">
                {reporting.managers.map((m) => (
                  <li key={m.id} className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/people/${m.employmentId}`}
                        className="text-foreground hover:text-primary"
                      >
                        {m.name}
                      </Link>
                      <LineTypeBadge type={m.lineType} dottedLabel={t('lineTypeDottedBadge')} />
                    </span>
                    <form action={endReportingLineAction}>
                      <input type="hidden" name="employmentId" value={emp.employmentId} />
                      <input type="hidden" name="reportingLineId" value={m.id} />
                      <input type="hidden" name="endDate" value={today} />
                      <button type="submit" title={t('endReportingLine')} className="text-muted-foreground transition-colors hover:text-red-500">
                        ×
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('directReports')}</div>
            {reporting.reports.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t('noDirectReports')}</div>
            ) : (
              <ul className="space-y-2">
                {reporting.reports.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/people/${r.employmentId}`}
                      className="text-foreground hover:text-primary"
                    >
                      {r.name}
                    </Link>
                    <LineTypeBadge type={r.lineType} dottedLabel={t('lineTypeDottedBadge')} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {!emp.terminatedOn && others.length > 0 && (
          <form
            action={addReportingLineAction}
            className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('manager')}>
              <select name="managerEmploymentId" required className={inputCls}>
                {others.map((o) => (
                  <option key={o.employmentId} value={o.employmentId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('lineType')}>
              <select name="lineType" defaultValue="administrative" className={inputCls}>
                <option value="administrative">{t('lineTypeAdministrative')}</option>
                <option value="functional">{t('lineTypeFunctional')}</option>
                <option value="project">{t('lineTypeProject')}</option>
                <option value="dotted">{t('lineTypeDotted')}</option>
              </select>
            </Field>
            <Field label={t('reportingLineEffectiveFrom')}>
              <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <div>
              <button className={btnPrimary}>{t('addReportingLine')}</button>
            </div>
          </form>
        )}
      </Card>

      {!emp.terminatedOn && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <SectionHeader title={t('transferTitle')} />
            <form action={transferAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <Field label={t('newDepartment')}>
                <select name="departmentId" required className={inputCls}>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('effectiveDate')}>
                <input name="effectiveDate" type="date" required defaultValue={today} className={inputCls} />
              </Field>
              <div className="sm:col-span-2">
                <button className={btnPrimary}>{t('transfer')}</button>
              </div>
            </form>
          </Card>

          <Card>
            <SectionHeader title={t('terminate')} />
            <form action={terminateAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="employmentId" value={emp.employmentId} />
              <Field label={t('terminationDate')}>
                <input name="terminationDate" type="date" required defaultValue={today} className={inputCls} />
              </Field>
              <Field label={t('terminationType')}>
                <select name="terminationType" defaultValue="" className={inputCls}>
                  <option value="">{t('terminationTypeUnspecified')}</option>
                  <option value="voluntary">{t('terminationVoluntary')}</option>
                  <option value="involuntary">{t('terminationInvoluntary')}</option>
                  <option value="retired">{t('terminationRetired')}</option>
                  <option value="contract_end">{t('terminationContractEnd')}</option>
                  <option value="death">{t('terminationDeath')}</option>
                  <option value="other">{t('terminationOther')}</option>
                </select>
              </Field>
              <Field label={t('terminationReason')}>
                <input name="terminationReason" maxLength={200} placeholder={t('terminationReasonHint')} className={`${inputCls} sm:col-span-2`} />
              </Field>
              <div className="sm:col-span-2">
                <ConfirmSubmit
                  title={t('terminateConfirmTitle')}
                  description={t('terminateConfirmDescription', { name: emp.name })}
                  confirmLabel={t('terminate')}
                  size="sm"
                >
                  {t('terminateEmployment')}
                </ConfirmSubmit>
              </div>
            </form>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <SectionHeader title={t('leaveRequests')} count={requests.length} />
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-2.5 text-foreground">{r.leaveType}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {r.startDate} → {r.endDate}
                </td>
                <td className="px-4 py-2.5 tabular-nums">{t('daysCount', { days: Number(r.days) })}</td>
                <td className="px-4 py-2.5">
                  <LeaveStatus status={r.status} label={t(`leaveStatus.${r.status}`)} />
                </td>
              </tr>
            ))}
            {requests.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveRequests')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
