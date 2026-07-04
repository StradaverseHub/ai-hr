import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { scopedSession } from '@/lib/scope';
import {
  listCompanies,
  listDepartments,
  listEmployeesPage,
  listJobGrades,
  listManagerCandidates,
} from '@/core/read';
import { listPositions, listCostCenters, listBusinessUnits } from '@/core/admin';
import { computeProvisionalEndOn, resolveProbationMonths } from '@/core/org';
import { getPayrollConfig } from '@/core/payroll-config';
import { listProfileChangeRequests } from '@/core/profile';
import { Avatar, Button, Card, EmployeeCode, Field, PageHeader, StatusBadge, inputCls } from '@/components/ui';
import { decideProfileChangeAction, hireAction } from './actions';

/** Render a pay-affecting change bundle as human-readable "field → value" pairs. */
function describeProposed(
  p: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>,
): string {
  const PCB_LABEL: Record<number, string> = {
    1: t('pcbSingle'),
    2: t('pcbMarriedSpouseNotWorking'),
    3: t('pcbMarriedSpouseWorking'),
  };
  const o = (p ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (o.bankName != null) parts.push(`${t('fieldBank')} → ${o.bankName}`);
  if (o.bankAccountNo != null) parts.push(`${t('fieldAccount')} → ${o.bankAccountNo}`);
  if (o.taxCategory != null)
    parts.push(`${t('fieldPcb')} → ${PCB_LABEL[Number(o.taxCategory)] ?? o.taxCategory}`);
  if (o.numChildren != null) parts.push(`${t('fieldChildren')} → ${o.numChildren}`);
  return parts.length ? parts.join(' · ') : t('noChanges');
}

const PAGE = 25;

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    q?: string;
    page?: string;
    company?: string;
    dept?: string;
    status?: string;
    type?: string;
  }>;
}) {
  await requireAdmin(); // Admin-only management surface (ADR: People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.list');
  const { s: session, scopeIds } = await scopedSession();
  const today = new Date().toISOString().slice(0, 10);
  const isAdmin = (session.roles ?? []).some((r) => r === 'hr_admin' || r === 'super_admin');
  const { error, q, page: pageParam, company, dept, status, type } = await searchParams;
  const page = Math.max(0, Number(pageParam) || 0);
  const statusFilter = status === 'active' || status === 'terminated' ? status : undefined;
  const hasFilters = !!(q || company || dept || status || type);
  const [
    { rows: employees, total },
    companies,
    departments,
    profileChanges,
    positions,
    costCenters,
    businessUnits,
    grades,
    managerCandidates,
  ] = await Promise.all([
    listEmployeesPage(session, {
      companyIds: scopeIds,
      q,
      companyId: company || undefined,
      departmentId: dept || undefined,
      status: statusFilter,
      employmentType: type || undefined,
      limit: PAGE,
      offset: page * PAGE,
    }),
    listCompanies(session),
    listDepartments(session),
    isAdmin
      ? listProfileChangeRequests(session, { companyIds: scopeIds, status: 'pending' })
      : Promise.resolve([]),
    // Hire-form pickers — admin-gated like the hire form itself.
    isAdmin ? listPositions(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listCostCenters(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listBusinessUnits(session, { companyIds: scopeIds }) : Promise.resolve([]),
    isAdmin ? listJobGrades(session) : Promise.resolve([]),
    isAdmin ? listManagerCandidates(session, { companyIds: scopeIds }) : Promise.resolve([]),
  ]);
  // full_time default provisional end for the server-rendered date field default. Uses the company shown
  // first in the hire form's company dropdown (companies[0]) so the default reflects that company's
  // configured probation months (null config → EA default 3).
  const defaultCompanyId = companies[0]?.id;
  const defaultProbationMonths =
    isAdmin && defaultCompanyId
      ? resolveProbationMonths((await getPayrollConfig(session, defaultCompanyId))?.probationMonths)
      : 3;
  const fullTimeProvisionalDefault =
    computeProvisionalEndOn(today, 'full_time', defaultProbationMonths) ?? today;
  const hasNext = (page + 1) * PAGE < total;
  const qs = (over: Record<string, string | number | undefined>) => {
    const merged: Record<string, string | number | undefined> = { q, company, dept, status, type, page: pageParam, ...over };
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, String(v));
    const s = sp.toString();
    return s ? `/admin/personnel?${s}` : '/admin/personnel';
  };
  const EMPLOYMENT_TYPES = [
    { value: 'full_time', labelKey: 'employmentFullTime' },
    { value: 'part_time', labelKey: 'employmentPartTime' },
    { value: 'contract', labelKey: 'employmentContract' },
    { value: 'intern', labelKey: 'employmentIntern' },
  ] as const;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {t('employeeCount', { count: total })}
            </span>
            {isAdmin && (
              <Link
                href="/admin/personnel/import"
                data-tour="people-import"
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                {t('importCsv')}
              </Link>
            )}
          </div>
        }
      />

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {isAdmin && profileChanges.length > 0 && (
        <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
          <div className="flex items-center gap-2 border-b border-border bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <h2 className="text-sm font-semibold">{t('profileChangeRequests')}</h2>
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {t('pendingCount', { count: profileChanges.length })}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {profileChanges.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{r.employee}</div>
                  <div className="text-xs text-muted-foreground">{describeProposed(r.proposed, t)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="approved" />
                    <Button type="submit" size="sm">
                      {t('approve')}
                    </Button>
                  </form>
                  <form action={decideProfileChangeAction}>
                    <input type="hidden" name="requestId" value={r.id} />
                    <input type="hidden" name="decision" value="rejected" />
                    <Button type="submit" size="sm" variant="outline">
                      {t('reject')}
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {t('profileChangeHint')}
          </p>
        </Card>
      )}

      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder={t('searchPlaceholder')}
          data-tour="people-search"
          className={`${inputCls} max-w-xs`}
          aria-label={t('searchAriaLabel')}
        />
        <select name="company" defaultValue={company ?? ''} aria-label={t('filterCompany')} className={`${inputCls} w-auto`}>
          <option value="">{t('allCompanies')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select name="dept" defaultValue={dept ?? ''} aria-label={t('filterDepartment')} className={`${inputCls} w-auto`}>
          <option value="">{t('allDepartments')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ''} aria-label={t('filterStatus')} className={`${inputCls} w-auto`}>
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('statusActive')}</option>
          <option value="terminated">{t('statusTerminated')}</option>
        </select>
        <select name="type" defaultValue={type ?? ''} aria-label={t('filterType')} className={`${inputCls} w-auto`}>
          <option value="">{t('allTypes')}</option>
          {EMPLOYMENT_TYPES.map((et) => (
            <option key={et.value} value={et.value}>
              {t(et.labelKey)}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary" size="sm">
          {t('search')}
        </Button>
        {hasFilters && (
          <Link href="/admin/personnel" className="text-sm text-muted-foreground hover:text-foreground">
            {t('clear')}
          </Link>
        )}
      </form>

      <Card className="overflow-hidden" data-tour="people-table">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t('colCode')}</th>
              <th className="px-4 py-3 font-medium">{t('colName')}</th>
              <th className="px-4 py-3 font-medium">{t('colDepartment')}</th>
              <th className="px-4 py-3 font-medium">{t('colCompany')}</th>
              <th className="px-4 py-3 font-medium">{t('colStatus')}</th>
              <th className="px-4 py-3 font-medium">{t('colHired')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {employees.map((e) => (
              <tr key={e.employmentId} className="hover:bg-muted/40">
                <td className="px-4 py-3">
                  <EmployeeCode code={e.employeeCode} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={e.name} />
                    <div className="min-w-0">
                      <Link
                        href={`/admin/personnel/${e.employmentId}?from=personnel`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {e.name}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">{e.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.department ?? '—'}</td>
                <td className="px-4 py-3 text-muted-foreground">{e.company}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.terminatedOn ? 'terminated' : e.status} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{e.hiredOn}</td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                  {q ? t('emptySearch', { q }) : hasFilters ? t('emptyFiltered') : t('emptyNoEmployees')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {(page > 0 || hasNext) && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm">
            {page > 0 ? (
              <Link href={qs({ page: page - 1 || undefined })} className="text-primary hover:underline">
                {t('newer')}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-muted-foreground">
              {t('rangeOf', {
                from: page * PAGE + 1,
                to: Math.min((page + 1) * PAGE, total),
                total,
              })}
            </span>
            {hasNext ? (
              <Link href={qs({ page: page + 1 })} className="text-primary hover:underline">
                {t('older')}
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}
      </Card>

      <Card data-tour="people-hire">
        <details>
          <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
            {t('hireAnEmployee')}
          </summary>
          <form action={hireAction} className="space-y-6 border-t border-border p-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('fullName')}>
                <input name="fullName" required className={inputCls} placeholder={t('fullNamePlaceholder')} />
              </Field>
              <Field label={t('email')}>
                <input name="primaryEmail" type="email" required className={inputCls} placeholder={t('emailPlaceholder')} />
              </Field>
            </div>

            <fieldset className="space-y-4">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('orgInfoHeading')}
              </legend>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('company')}>
                  <select name="companyId" required className={inputCls}>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('businessUnit')}>
                  <select
                    name="businessUnitId"
                    id="hire-business-unit"
                    defaultValue=""
                    data-hire-bu-select
                    className={inputCls}
                  >
                    <option value="">{t('businessUnitNone')}</option>
                    {businessUnits.map((bu) => (
                      <option key={bu.id} value={bu.id}>
                        {bu.code} — {bu.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('department')}>
                  {/* Each department option carries its BU id (empty = unassigned). A tiny inline script
                      narrows this list to the chosen BU's departments; unassigned (NULL-BU) departments
                      stay visible under every BU choice (the day-one common case). */}
                  <select name="departmentId" id="hire-department" required className={inputCls}>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id} data-business-unit={d.businessUnitId ?? ''}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('position')}>
                  <select name="positionId" className={inputCls}>
                    <option value="">{t('positionNone')}</option>
                    {positions.map((pos) => (
                      <option key={pos.id} value={pos.id}>
                        {pos.title}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('jobGrade')}>
                  <select name="gradeId" className={inputCls}>
                    <option value="">{t('jobGradeNone')}</option>
                    {grades.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('reportingManager')}>
                  <select name="reportingManagerEmploymentId" defaultValue="" className={inputCls}>
                    <option value="">{t('noManager')}</option>
                    {managerCandidates.map((m) => (
                      <option key={m.employmentId} value={m.employmentId}>
                        {m.name}
                        {m.employeeCode ? ` (${m.employeeCode})` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('costCenter')}>
                  <select name="costCenterId" className={inputCls}>
                    <option value="">{t('costCenterNone')}</option>
                    {costCenters.map((cc) => (
                      <option key={cc.id} value={cc.id}>
                        {cc.code} — {cc.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-4">
              <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('employmentInfoHeading')}
              </legend>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('employmentType')}>
                  <select name="employmentType" defaultValue="full_time" className={inputCls}>
                    <option value="full_time">{t('employmentFullTime')}</option>
                    <option value="part_time">{t('employmentPartTime')}</option>
                    <option value="contract">{t('employmentContract')}</option>
                    <option value="intern">{t('employmentIntern')}</option>
                  </select>
                </Field>
                <Field label={t('hireDate')}>
                  <input name="hiredOn" type="date" required defaultValue={today} className={inputCls} />
                </Field>
                <Field label={t('provisionalEndDate')}>
                  <input
                    name="provisionalEndOn"
                    type="date"
                    defaultValue={fullTimeProvisionalDefault}
                    className={inputCls}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t('provisionalEndHint')}</p>
                </Field>
              </div>
            </fieldset>

            <Button type="submit">{t('hire')}</Button>
          </form>
          {/* Department-by-BU cascading filter (no React client island): show departments whose BU matches
              the chosen Business Unit, always keeping unassigned (empty-BU) departments visible. Reset the
              department selection when its option becomes hidden. Pure DOM, ~server-rendered-safe. */}
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){
  var bu=document.getElementById('hire-business-unit');
  var dept=document.getElementById('hire-department');
  if(!bu||!dept)return;
  function apply(){
    var v=bu.value;var firstVisible=null;
    for(var i=0;i<dept.options.length;i++){
      var o=dept.options[i];var b=o.getAttribute('data-business-unit')||'';
      var show=!v||b===''||b===v;
      o.hidden=!show;o.disabled=!show;
      if(show&&firstVisible===null)firstVisible=o;
    }
    var cur=dept.options[dept.selectedIndex];
    if(!cur||cur.hidden){dept.value=firstVisible?firstVisible.value:'';}
  }
  bu.addEventListener('change',apply);apply();
})();`,
            }}
          />
        </details>
      </Card>
    </div>
  );
}
