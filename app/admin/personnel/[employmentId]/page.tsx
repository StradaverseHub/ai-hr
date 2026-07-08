import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isAdmin, requireAdmin } from '@/lib/authz';
import {
  assignmentHistory,
  delegationsFor,
  employeeAudit,
  employeeDetail,
  leaveBalances,
  leaveEntitlementBreakdown,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  listJobGrades,
  reportingLinesFor,
} from '@/core/read';
import { Badge, Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, btnPrimary, inputCls } from '@/components/ui';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
import { AuditTable } from '@/components/audit-table';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { EpfElection } from '@/components/epf-election';
import {
  addDelegationAction,
  addReportingLineAction,
  endDelegationAction,
  endReportingLineAction,
  setCompensationAction,
  setComplianceFieldsAction,
  setEmploymentComponentAction,
  setLocationAction,
  setPersonAction,
  setStatutoryAction,
  terminateAction,
  transferAction,
} from './actions';
import { compensationHistoryDetailed, type CompensationHistoryRow } from '@/core/comp';
import { SalaryRevisionConfirm } from '@/components/salary-revision-confirm';
import { SalaryHistoryTable, type SalaryRowView } from '@/components/salary-history-table';
import { listCp38 } from '@/core/cp38';
import { addCp38Action, editCp38Action, terminateCp38Action } from './cp38-actions';
import { listDependents, DEPENDENT_RELATIONSHIPS, DEPENDENT_GENDERS } from '@/core/dependents';
import { addDependentAction, editDependentAction, archiveDependentAction } from './dependent-actions';
import { listAssignablePolicies } from '@/core/payroll-policy';
import { assignPolicyAction } from '@/app/admin/payroll-policy/actions';
import { listShifts } from '@/core/roster';
import { setDefaultShiftAction } from './actions';
import { listHolidayGroups } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listClockingLocations, listEmployeeClockingLocations } from '@/core/clocking-location';
import { setEmployeeClockingLocationsAction, setGeofencingAction } from './actions';
import { ReviewSection } from './review-section';
import { PersonnelTabs } from '@/components/personnel-tabs';
import { getStatutoryProfileMY } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { listEmploymentPayComponents, listPayComponents } from '@/core/pay-components';
import { encashmentSnapshotForEmployment } from '@/core/leave-encashment';
import { unfreezeEncashmentAction, adjustEncashmentAction } from './encashment-actions';

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
  searchParams: Promise<{ error?: string; from?: string; cp38Error?: string; asOf?: string; encashmentError?: string }>;
}) {
  const s = await requireAdmin(); // Admin-only management surface (People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.detail');
  const tp = await getTranslations('payrollPolicy');
  const tc = await getTranslations('people.detail.clocking');
  const admin = isAdmin(s);
  const { employmentId } = await params;
  const { error, from, cp38Error, asOf: spAsOf, encashmentError } = await searchParams;
  // Context-aware back link: came from the org chart (?from=org) → return there; otherwise the
  // people directory. Keeps the `from` param flowing through so nested navigation stays consistent.
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/admin/personnel', label: t('backToPeople') };

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  const today = new Date().toISOString().slice(0, 10);

  const [history, balances, requests, departments, reporting, employees, grades, delegations] = await Promise.all([
    assignmentHistory(s, employmentId),
    leaveBalances(s, employmentId),
    leaveRequestsFor(s, employmentId),
    listDepartments(s),
    reportingLinesFor(s, employmentId),
    listEmployees(s),
    listJobGrades(s),
    delegationsFor(s, employmentId),
  ]);
  // Leave entitlement breakdown (read-only). HR reuses the same component as /me; one ?asOf= drives the
  // whole leave card. RLS scopes every read, so a viewer who can't see this employment's ledger/policy
  // gets a null breakdown (rendered as nothing) rather than a leak. Invalid/empty asOf falls back to today.
  const breakdownAsOf = spAsOf && /^\d{4}-\d{2}-\d{2}$/.test(spAsOf) ? spAsOf : today;
  const breakdowns = await Promise.all(
    balances.map((b) => leaveEntitlementBreakdown(s, employmentId, b.leaveTypeId, breakdownAsOf)),
  );
  const breakdownByType = new Map(breakdowns.filter((x) => x != null).map((x) => [x!.leaveTypeId, x!]));
  // Pay + statutory (salary, IC, bank, tax) are HR-admin-only on this directory page — never load or
  // render them for a manager viewing a direct report (consultant feedback #5). Compensation reads are
  // also tightened to admin-or-self at the RLS layer (migration 0060); this avoids fetching them at all.
  const salaryHistory = admin ? await compensationHistoryDetailed(s, employmentId) : [];
  const statutory = admin ? await getStatutoryProfileMY(s, emp.personId) : null;
  // HR-defined multi-state holiday groups — the second option-group of the unified Holiday calendar field.
  const holidayGroups = admin ? await listHolidayGroups(s) : [];
  // ADR-0054: locations for THIS employee's company (admin-only) — the "Set location" picker options.
  const locations = admin ? await listLocations(s, [emp.companyId]) : [];
  // Current selection of the unified field: a group wins, else a single state, else company default.
  const holidayCalendarValue = emp.holidayGroupId
    ? `group:${emp.holidayGroupId}`
    : emp.workState
      ? `state:${emp.workState}`
      : '';
  // Typed pay components (Wave 3 #9) — recurring components for this employee + the catalog to add from.
  const payComps = admin ? await listEmploymentPayComponents(s, employmentId) : [];
  const componentCatalog = admin ? await listPayComponents(s) : [];
  // 1.2.3 CP38 — per-employee LHDN instalment records (admin-only master data).
  const cp38Records = admin ? await listCp38(s, { employmentId }) : [];
  // ADR-0069 — leave encashment snapshot, admin-only card. Null when no resignation has been frozen
  // (policy off, or the employment was terminated directly bypassing the resignation flow).
  const encashmentSnapshot = admin ? await encashmentSnapshotForEmployment(s, employmentId) : null;
  // Personnel — Family / Dependents (phase 1): per-person benefits/insurance register (admin-only). Keyed
  // on person_id (already loaded on emp), NOT employment_id. Does NOT feed the tax num_children figure.
  const dependents = admin ? await listDependents(s, { personId: emp.personId }) : [];
  // 2.1 Payroll Policy — active policies in THIS employee's company, for the assignment picker (admin-only).
  const assignablePolicies = admin ? await listAssignablePolicies(s, emp.companyId) : [];
  // ec4cbf63 — Default shift picker options: THIS employee's company's shifts. Loaded WITH archived rows so
  // a currently-assigned-but-later-archived shift still renders as the selected option (instead of silently
  // showing "None"), then filtered to live shifts + the assigned one. New assignments of archived shifts
  // are rejected by the service.
  const companyShifts = admin && !emp.terminatedOn ? await listShifts(s, emp.companyId, { includeArchived: true }) : [];
  const assignableShifts = companyShifts.filter((sh) => !sh.archivedAt || sh.id === emp.defaultShiftId);
  // ADR-0070 — Clocking Location & Geofencing: THIS employee's company's active clocking sites (the
  // multi-select options) + their current assignment (admin-only, mirrors the payroll-policy card).
  const clockingLocations = admin ? await listClockingLocations(s, [emp.companyId]) : [];
  const assignedClockingLocations = admin ? await listEmployeeClockingLocations(s, employmentId) : [];
  const assignedClockingLocationIds = new Set(assignedClockingLocations.map((l) => l.id));
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);
  const changeHistory = admin ? await employeeAudit(s, employmentId) : [];

  // Family/Dependents (phase 1): render relationship/gender as STATIC literal i18n keys (a switch, not a
  // dynamic template) so test/i18n-coverage.test.ts (check C) catches a missing Tamil/Thai label instead of
  // silently shipping a raw key. An unknown stored value falls back to the raw string.
  const relationshipLabel = (r: string) => {
    switch (r) {
      case 'spouse': return t('family.rel.spouse');
      case 'child': return t('family.rel.child');
      case 'parent': return t('family.rel.parent');
      case 'sibling': return t('family.rel.sibling');
      case 'other': return t('family.rel.other');
      default: return r;
    }
  };
  const genderLabel = (g: string | null) => {
    switch (g) {
      case 'male': return t('family.gender.male');
      case 'female': return t('family.gender.female');
      case 'undisclosed': return t('family.gender.undisclosed');
      default: return '—';
    }
  };

  // Tab labels (people.detail.tabs.*). Six tabs regrouping the existing sections below; the page still
  // loads all data once, so switching tabs is instant and keeps the viewer on the same employee.
  const tabs: { key: 'profile' | 'family' | 'job' | 'payroll' | 'leave' | 'documents' | 'others'; label: string }[] = [
    { key: 'profile', label: t('tabs.profile') },
    { key: 'family', label: t('tabs.family') },
    { key: 'job', label: t('tabs.job') },
    { key: 'payroll', label: t('tabs.payroll') },
    { key: 'leave', label: t('tabs.leave') },
    { key: 'documents', label: t('tabs.documents') },
    { key: 'others', label: t('tabs.others') },
  ];

  // ── PROFILE ────────────────────────────────────────────────────────────────
  // Personal details (name, email, phone, holiday calendar, grade) + gender/marital compliance fields.
  const profilePanel = admin ? (
    <Card id="section-personal-details">
      <SectionHeader title={t('personalDetails')} />
          <form
            action={setPersonAction}
            className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4"
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
            <Field label={t('holidayCalendar')}>
              <select name="holidayCalendar" defaultValue={holidayCalendarValue} className={inputCls}>
                <option value="">{t('holidayCalendarDefault')}</option>
                {holidayGroups.length > 0 && (
                  <optgroup label={t('holidayCalendarGroupOptgroup')}>
                    {holidayGroups.map((g) => (
                      <option key={g.id} value={`group:${g.id}`}>
                        {g.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={t('holidayCalendarStateOptgroup')}>
                  {MY_STATES.map((st) => (
                    <option key={st} value={`state:${st}`}>
                      {st}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label={t('grade')}>
              <select name="gradeId" defaultValue={emp.gradeId ?? ''} className={inputCls}>
                <option value="">{t('gradeNone')}</option>
                {grades.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-4 flex justify-end">
              <button className={btnPrimary}>{t('saveDetails')}</button>
            </div>
          </form>

          {/* Wave 2A-1 / #24: gender + marital status drive leave eligibility. Kept on their OWN
              submit → setPersonComplianceFields (the approval-gated apply path), separate from the
              instant-write core fields above. */}
          <form
            action={setComplianceFieldsAction}
            className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('gender')}>
              <select name="gender" defaultValue={emp.gender ?? ''} className={inputCls}>
                <option value="">{t('genderNotSet')}</option>
                <option value="male">{t('genderMale')}</option>
                <option value="female">{t('genderFemale')}</option>
                <option value="undisclosed">{t('genderUndisclosed')}</option>
              </select>
            </Field>
            <Field label={t('maritalStatus')}>
              <select name="maritalStatus" defaultValue={emp.marital ?? ''} className={inputCls}>
                <option value="">{t('maritalNotSet')}</option>
                <option value="single">{t('maritalSingle')}</option>
                <option value="married">{t('maritalMarried')}</option>
                <option value="other">{t('maritalOther')}</option>
              </select>
            </Field>
            <p className="text-xs text-muted-foreground sm:col-span-4">{t('maritalPcbNote')}</p>
            <div className="sm:col-span-4 flex justify-end">
              <button className={btnPrimary}>{t('saveComplianceFields')}</button>
            </div>
          </form>
    </Card>
  ) : null;

  // ── PAYROLL ────────────────────────────────────────────────────────────────
  // Pay components, CP38, leave encashment, payroll policy assignment, leave balance, compensation,
  // and the Malaysia statutory profile (salary / bank / tax). All admin-only.
  const payComponentsCard = admin && componentCatalog.length > 0 ? (
    <Card id="section-pay-components" className="overflow-hidden">
      <SectionHeader title={t('payComponentsTitle')} count={payComps.length} />
          {payComps.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('payComponent')}</th>
                  <th className="px-4 py-2 font-medium">{t('colCurrency')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('payComponentAmount')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStart')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEnd')}</th>
                  <th className="px-4 py-2 font-medium">{t('colProrate')}</th>
                  <th className="px-4 py-2 font-medium">{t('colRemarks')}</th>
                  <th className="px-4 py-2 font-medium">{t('status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {payComps.map((pc) => {
                  // An item is ENDED once its inclusive end-date is in the past; otherwise it is ACTIVE.
                  const ended = pc.validTo != null && pc.validTo < today;
                  // Resolved prorate = per-employee override (if set) else the catalog flag.
                  const prorate = pc.prorateOverride ?? pc.prorates;
                  return (
                    <tr key={pc.id}>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs">{pc.code}</span> <span className="text-muted-foreground">{pc.name}</span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">{pc.currency}</td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(pc.amount).toFixed(2)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{pc.validFrom}</td>
                      <td className="px-4 py-2.5 tabular-nums">{pc.validTo ?? '—'}</td>
                      <td className="px-4 py-2.5">{prorate ? t('prorateYes') : t('prorateNo')}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{pc.remarks ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={ended ? 'default' : 'success'}>{ended ? t('statusEnded') : t('statusActive')}</Badge>
                      </td>
                    </tr>
                  );
                })}
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
            <Field label={t('payComponentCurrency')}>
              <select name="currency" defaultValue="MYR" className={inputCls}>
                <option value="MYR">MYR</option>
              </select>
            </Field>
            <Field label={t('payComponentProrate')}>
              <select name="prorate" defaultValue="inherit" className={inputCls}>
                <option value="inherit">{t('prorateInherit')}</option>
                <option value="yes">{t('prorateYes')}</option>
                <option value="no">{t('prorateNo')}</option>
              </select>
            </Field>
            <Field label={t('payComponentEffectiveFrom')}>
              <input name="effectiveFrom" type="date" required defaultValue={emp.hiredOn} className={inputCls} />
            </Field>
            <Field label={t('payComponentEffectiveTo')}>
              <input name="effectiveTo" type="date" className={inputCls} />
            </Field>
            <Field label={t('payComponentRemarks')}>
              <input name="remarks" type="text" placeholder={t('payComponentRemarksPlaceholder')} className={inputCls} />
            </Field>
            <button className={btnPrimary}>{t('payComponentSave')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('payComponentsHint')}</p>
    </Card>
  ) : null;

  const cp38Card = admin ? (
    <Card id="section-cp38" className="overflow-hidden">
      <SectionHeader title={t('cp38Title')} count={cp38Records.length} />
          {cp38Error === 'processed' && (
            <p className="mx-4 mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {t('cp38ProcessedError')}
            </p>
          )}
          {cp38Records.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('cp38Ref')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('cp38Amount')}</th>
                  <th className="px-4 py-2 font-medium">{t('cp38From')}</th>
                  <th className="px-4 py-2 font-medium">{t('cp38To')}</th>
                  <th className="px-4 py-2 font-medium">{t('cp38Remarks')}</th>
                  <th className="px-4 py-2 font-medium">{t('cp38Status')}</th>
                  <th className="px-4 py-2 font-medium">{t('cp38Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cp38Records.map((r) => {
                  // CLOSED once superseded, or once its inclusive end-date is before this month. Otherwise ACTIVE.
                  const closed =
                    r.supersededAt != null || (r.validTo != null && r.validTo < thisMonthStart);
                  // A closed/superseded row's period is historical → its edit/terminate is hidden (the
                  // service guard would also block any processed period).
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-mono text-xs">{r.cp38Ref}</td>
                      <td className="px-4 py-2.5 text-right font-medium tabular-nums">{Number(r.amount).toFixed(2)}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.validFrom}</td>
                      <td className="px-4 py-2.5 tabular-nums">{r.validTo ?? t('cp38Open')}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{r.remarks ?? '—'}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant={closed ? 'default' : 'success'}>
                          {closed ? t('cp38StatusClosed') : t('cp38StatusActive')}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {!closed && (
                          <div className="flex items-center gap-3">
                            <form action={editCp38Action} className="flex flex-wrap items-end gap-1.5">
                              <input type="hidden" name="employmentId" value={emp.employmentId} />
                              <input type="hidden" name="id" value={r.id} />
                              <input
                                name="amount"
                                type="number"
                                min="0"
                                step="0.01"
                                defaultValue={Number(r.amount).toFixed(2)}
                                className={`${inputCls} w-28`}
                                aria-label={t('cp38Amount')}
                              />
                              <button className="text-xs font-medium text-primary hover:underline">{t('cp38Save')}</button>
                            </form>
                            <form action={terminateCp38Action}>
                              <input type="hidden" name="employmentId" value={emp.employmentId} />
                              <input type="hidden" name="id" value={r.id} />
                              <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                                {t('cp38Terminate')}
                              </button>
                            </form>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('cp38None')}</p>
          )}
          <form action={addCp38Action} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-3">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('cp38Ref')}>
              <input name="cp38Ref" required placeholder={t('cp38RefPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('cp38Amount')}>
              <input name="amount" type="number" min="0" step="0.01" required className={inputCls} />
            </Field>
            <Field label={t('cp38Remarks')}>
              <input name="remarks" type="text" placeholder={t('cp38RemarksPlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('cp38From')}>
              <input name="validFrom" type="date" required defaultValue={thisMonthStart} className={inputCls} />
            </Field>
            <Field label={t('cp38To')}>
              <input name="validTo" type="date" className={inputCls} />
            </Field>
            <button className={btnPrimary}>{t('cp38Add')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('cp38Hint')}</p>
    </Card>
  ) : null;

  // ADR-0069 — Leave Encashment: admin-only card, shown once a resignation-approval freeze has
  // happened for this employment. Raw balance, auto figure, effective (override) figure, status,
  // calculated-as-of, and the post-LWD hint; Unfreeze/Adjust actions (mandatory reason, re-locks).
  const encashmentCard = admin && encashmentSnapshot ? (
    <Card id="section-encashment" className="overflow-hidden">
      <SectionHeader title={t('encashmentTitle')} />
          {encashmentError && (
            <p className="mx-4 mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              {encashmentError}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-muted-foreground">{t('encashmentBalance')}</div>
              <div className="font-medium tabular-nums">{encashmentSnapshot.balanceDays}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('encashmentAuto')}</div>
              <div className="font-medium tabular-nums">{encashmentSnapshot.encashableDays}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('encashmentEffective')}</div>
              <div className="font-medium tabular-nums">{encashmentSnapshot.days}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('encashmentAsOf')}</div>
              <div className="font-medium">{encashmentSnapshot.calculatedAsOf}</div>
            </div>
          </div>
          <div className="px-4 pb-2">
            <Badge variant={encashmentSnapshot.status === 'frozen' ? 'success' : 'default'}>
              {encashmentSnapshot.status === 'frozen' ? t('encashmentStatusFrozen') : t('encashmentStatusUnfrozen')}
            </Badge>
            {encashmentSnapshot.overrideDays != null && (
              <span className="ml-2 text-xs text-muted-foreground">{t('encashmentOverridden')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-4 border-t border-border p-4">
            <form action={unfreezeEncashmentAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="snapshotId" value={encashmentSnapshot.id} />
              <Field label={t('encashmentReasonLabel')}>
                <input name="reason" required placeholder={t('encashmentReasonPlaceholder')} className={inputCls} />
              </Field>
              <ConfirmSubmit
                size="sm"
                variant="secondary"
                title={t('encashmentUnfreezeConfirmTitle')}
                description={t('encashmentUnfreezeConfirmDescription')}
                confirmLabel={t('encashmentUnfreezeConfirmLabel')}
              >
                {t('encashmentUnfreeze')}
              </ConfirmSubmit>
            </form>
            <form action={adjustEncashmentAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="employmentId" value={employmentId} />
              <input type="hidden" name="snapshotId" value={encashmentSnapshot.id} />
              <Field label={t('encashmentOverrideDaysLabel')}>
                <input
                  name="overrideDays"
                  type="number"
                  step="0.5"
                  min="0"
                  required
                  defaultValue={encashmentSnapshot.days}
                  className={`${inputCls} w-24`}
                />
              </Field>
              <Field label={t('encashmentReasonLabel')}>
                <input name="reason" required placeholder={t('encashmentReasonPlaceholder')} className={inputCls} />
              </Field>
              <button className={btnPrimary}>{t('encashmentAdjust')}</button>
            </form>
          </div>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('encashmentHint')}</p>
    </Card>
  ) : null;

  // ── FAMILY ─────────────────────────────────────────────────────────────────
  // Personnel — Family & Dependents (phase 1). Per-PERSON benefits/insurance register: name +
  // relationship + DOB + optional beneficiary flag. Admin-maintained (RLS is_admin write); does NOT
  // feed the tax num_children figure and is distinct from the emergency contact.
  const familyPanel = admin ? (
    <Card id="section-family" className="overflow-hidden">
      <SectionHeader title={t('family.title')} count={dependents.length} />
          <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {t('family.note')}
          </p>
          {dependents.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('family.name')}</th>
                  <th className="px-4 py-2 font-medium">{t('family.relationship')}</th>
                  <th className="px-4 py-2 font-medium">{t('family.dateOfBirth')}</th>
                  <th className="px-4 py-2 font-medium">{t('family.genderLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('family.beneficiary')}</th>
                  <th className="px-4 py-2 font-medium">{t('family.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dependents.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5 font-medium">{d.fullName}</td>
                    <td className="px-4 py-2.5">{relationshipLabel(d.relationship)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{d.dateOfBirth ?? '—'}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{genderLabel(d.gender)}</td>
                    <td className="px-4 py-2.5">
                      {d.isBeneficiary ? (
                        <Badge variant="success">{t('family.yes')}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{t('family.no')}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-end gap-3">
                        <form action={editDependentAction} className="flex flex-wrap items-end gap-1.5">
                          <input type="hidden" name="employmentId" value={emp.employmentId} />
                          <input type="hidden" name="id" value={d.id} />
                          <select
                            name="relationship"
                            defaultValue={d.relationship}
                            className={`${inputCls} w-28`}
                            aria-label={t('family.relationship')}
                          >
                            {DEPENDENT_RELATIONSHIPS.map((r) => (
                              <option key={r} value={r}>
                                {relationshipLabel(r)}
                              </option>
                            ))}
                          </select>
                          <input
                            name="dateOfBirth"
                            type="date"
                            defaultValue={d.dateOfBirth ?? ''}
                            className={`${inputCls} w-40`}
                            aria-label={t('family.dateOfBirth')}
                          />
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <input type="checkbox" name="isBeneficiary" defaultChecked={d.isBeneficiary} />
                            {t('family.beneficiary')}
                          </label>
                          <button className="text-xs font-medium text-primary hover:underline">
                            {t('family.save')}
                          </button>
                        </form>
                        <form action={archiveDependentAction}>
                          <input type="hidden" name="employmentId" value={emp.employmentId} />
                          <input type="hidden" name="id" value={d.id} />
                          <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                            {t('family.delete')}
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('family.none')}</p>
          )}
          <form action={addDependentAction} className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-3">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <input type="hidden" name="personId" value={emp.personId} />
            <Field label={t('family.name')}>
              <input name="fullName" required placeholder={t('family.namePlaceholder')} className={inputCls} />
            </Field>
            <Field label={t('family.relationship')}>
              <select name="relationship" required defaultValue="child" className={inputCls}>
                {DEPENDENT_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {relationshipLabel(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('family.dateOfBirth')}>
              <input name="dateOfBirth" type="date" className={inputCls} />
            </Field>
            <Field label={t('family.genderLabel')}>
              <select name="gender" defaultValue="" className={inputCls}>
                <option value="">{t('family.genderUnset')}</option>
                {DEPENDENT_GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {genderLabel(g)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('family.remarks')}>
              <input name="remarks" type="text" placeholder={t('family.remarksPlaceholder')} className={inputCls} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm text-muted-foreground">
              <input type="checkbox" name="isBeneficiary" />
              {t('family.beneficiary')}
            </label>
            <button className={btnPrimary}>{t('family.add')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('family.hint')}</p>
    </Card>
  ) : null;

  // 2.1 Payroll Policy — assign the named pay-processing template applied to this employee. Admin-only;
  // payroll uses it automatically on the next run. Null = monthly default.
  const payrollPolicyCard = admin && !emp.terminatedOn ? (
    <Card id="section-payroll-policy">
      <SectionHeader title={tp('assignTitle')} />
          <form action={assignPolicyAction} className="flex flex-wrap items-end gap-3 p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={tp('assignLabel')}>
              <select name="policyId" defaultValue={emp.payrollPolicyId ?? ''} className={inputCls}>
                <option value="">{tp('assignNone')}</option>
                {assignablePolicies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <button className={btnPrimary}>{tp('assignSave')}</button>
          </form>
          {emp.payrollPolicyId && emp.payrollPolicyStatus !== 'active' && (
            <p className="px-4 pb-3 text-xs text-amber-600 dark:text-amber-400">{tp('assignInactiveNote')}</p>
          )}
          <p className="px-4 pb-4 text-xs text-muted-foreground">{tp('assignHint')}</p>
    </Card>
  ) : null;

  // ec4cbf63 — Default shift: the shift this person NORMALLY works, set once here instead of painting every
  // date on /roster. The attendance/OT engine uses it on any date WITHOUT a dated roster row (roster row →
  // default shift → company policy), so /roster remains the surface for date-specific exceptions. Admin-only,
  // mirrors the payroll-policy assignment card; lives in the Job tab (it describes how the person works).
  const defaultShiftCard = admin && !emp.terminatedOn ? (
    <Card id="section-default-shift">
      <SectionHeader title={t('defaultShiftTitle')} />
          <form action={setDefaultShiftAction} className="flex flex-wrap items-end gap-3 p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('defaultShiftLabel')}>
              <select name="shiftId" defaultValue={emp.defaultShiftId ?? ''} className={inputCls}>
                <option value="">{t('defaultShiftNone')}</option>
                {assignableShifts.map((sh) => (
                  <option key={sh.id} value={sh.id}>
                    {`${sh.code ?? '—'} — ${sh.name} (${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)})`}
                  </option>
                ))}
              </select>
            </Field>
            <button className={btnPrimary}>{t('defaultShiftSave')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('defaultShiftHint')}</p>
    </Card>
  ) : null;

  // ── OTHERS ─────────────────────────────────────────────────────────────────
  // ADR-0070 — Clocking Location & Geofencing. Admin-only, mirrors the payroll-policy card. Multi-select
  // of the company's active clocking sites; geofencing toggle + radius (required when enabling).
  const clockingCard = admin && !emp.terminatedOn ? (
    <Card id="section-clocking-location">
      <SectionHeader title={tc('cardTitle')} />
          <form action={setEmployeeClockingLocationsAction} className="space-y-3 p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={tc('assignedLocations')}>
              <select
                name="clockingLocationIds"
                multiple
                defaultValue={[...assignedClockingLocationIds]}
                className={`${inputCls} h-28`}
              >
                {clockingLocations.map((cl) => (
                  <option key={cl.id} value={cl.id}>{cl.name}</option>
                ))}
              </select>
            </Field>
            {clockingLocations.length === 0 && (
              <p className="text-xs text-muted-foreground">{tc('noSites')}</p>
            )}
            <button className={btnPrimary}>{tc('save')}</button>
          </form>
          <form action={setGeofencingAction} className="flex flex-wrap items-end gap-3 border-t border-border p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <label className="flex items-center gap-2 pb-2 text-sm text-muted-foreground">
              <input type="checkbox" name="enabled" defaultChecked={emp.geofencingEnabled} />
              {tc('geofencingToggle')}
            </label>
            <Field label={tc('radiusLabel')}>
              <input
                name="radiusM"
                type="number"
                min={1}
                max={100000}
                defaultValue={emp.geofenceRadiusM ?? 300}
                className={`${inputCls} w-28`}
              />
            </Field>
            <button className={btnPrimary}>{tc('save')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{tc('hint')}</p>
    </Card>
  ) : null;

  const leaveBalanceCard = (
    <Card id="section-leave-balance">
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
              {breakdownByType.get(b.leaveTypeId) && (
                <EntitlementBreakdown
                  data={breakdownByType.get(b.leaveTypeId)!}
                  asOf={breakdownAsOf}
                  action={`/admin/personnel/${employmentId}`}
                  hiddenParams={from ? { from } : {}}
                />
              )}
            </div>
          ))}
          {balances.length === 0 && <div className="p-4 text-sm text-muted-foreground">{t('noLeaveRecords')}</div>}
        </div>
    </Card>
  );

  // Basic Salary card (feedback 87c82b18 — "Compensation" renamed & rebuilt as salary history). The
  // salary engine (effective-dated CLOSE+INSERT, payroll picks the row in effect per period) already
  // exists in core/comp.ts; this surfaces the FULL history: summary, increment maths, status colours,
  // remarks, and who created each record. Kept in its old Payroll slot; `section-compensation` anchor
  // stays for fragment-URL safety. Stays a server-rendered <Card>/<form> (f2904eeb) — the only
  // interactivity (live increment preview + confirm) is the SalaryRevisionConfirm client island.
  const fmtMoney = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // salaryHistory is newest-first. previous = the next-older row's basic; status is derived from the dates.
  const salaryRows = salaryHistory.map((row: CompensationHistoryRow, i: number) => {
    const basic = Number(row.basicSalary);
    const prevRow = salaryHistory[i + 1];
    const previous = prevRow ? Number(prevRow.basicSalary) : null;
    const incrementAmount = previous != null ? basic - previous : null;
    const incrementPct =
      incrementAmount != null && previous != null && previous > 0 ? (incrementAmount / previous) * 100 : null;
    const isFuture = row.validFrom > today;
    const isActive = !isFuture && (row.validTo == null || row.validTo > today);
    const status: 'active' | 'future' | 'historical' = isFuture ? 'future' : isActive ? 'active' : 'historical';
    // Only the OPEN row (validTo null; already non-superseded from the query) is editable — the latest
    // active OR a future-effective record. Historical (closed) rows stay immutable (Edit flow #4).
    const editable = !emp.terminatedOn && row.validTo == null;
    return { row, basic, previous, incrementAmount, incrementPct, status, editable };
  });
  // Serialized rows for the client history table (search / filter / sort / export / edit). Salary math is
  // derived here on the server; the island only presents + filters (f2904eeb-safe, no client fetch).
  const salaryRowViews: SalaryRowView[] = salaryRows.map((r) => ({
    id: r.row.id,
    employmentId: emp.employmentId,
    effectiveDate: r.row.validFrom,
    currency: r.row.currency,
    basic: r.basic,
    previous: r.previous,
    incrementAmount: r.incrementAmount,
    incrementPct: r.incrementPct,
    status: r.status,
    remarks: r.row.remarks,
    createdByName: r.row.createdByName,
    createdOn: new Date(r.row.recordedAt).toISOString().slice(0, 10),
    updatedByName: r.row.updatedByName,
    updatedOn: r.row.updatedAt ? new Date(r.row.updatedAt).toISOString().slice(0, 10) : null,
    editable: r.editable,
  }));
  // The summary shows the row in effect TODAY (active) — NOT the open row, which may be a future revision.
  const activeDerived = salaryRows.find((r) => r.status === 'active') ?? null;
  const hasFuture = salaryRows.some((r) => r.status === 'future');
  const compensationCard = admin ? (
    <Card id="section-compensation">
      <SectionHeader title={t('compensation')} />
      {/* Summary strip — current active basic, effective-since, latest increment, future chip. */}
      <div className="border-b border-border p-4">
        {activeDerived ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">
                {activeDerived.row.currency} {fmtMoney(activeDerived.basic)}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('compMeta', { validFrom: activeDerived.row.validFrom })}
              </span>
            </div>
            {activeDerived.incrementAmount != null && activeDerived.incrementAmount !== 0 && (
              <span
                className={`text-xs font-medium ${
                  activeDerived.incrementAmount > 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-red-700 dark:text-red-400'
                }`}
              >
                {t('salaryLatestIncrement', {
                  amount: `${activeDerived.row.currency} ${fmtMoney(activeDerived.incrementAmount)}`,
                  pct: activeDerived.incrementPct != null ? activeDerived.incrementPct.toFixed(2) : '—',
                })}
              </span>
            )}
            {hasFuture && <Badge variant="warning">{t('salaryFutureChip')}</Badge>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noCompensation')}</p>
        )}
      </div>

      {/* History table — every revision, with search / status filter / column sort / CSV export, plus an
          inline edit affordance on the latest (open) record. Interactive client island (f2904eeb-safe). */}
      {salaryRowViews.length > 0 && <SalaryHistoryTable rows={salaryRowViews} />}

      {/* Add salary revision — the initial record defaults its effective date to the join date. Allowance
          is no longer maintained here (moved to Pay Components); the action carries it forward. */}
      {!emp.terminatedOn && (
        <form
          action={setCompensationAction}
          className="space-y-3 border-t border-border p-4"
        >
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('effectiveDate')}>
              <input
                name="effectiveFrom"
                type="date"
                required
                defaultValue={salaryRows.length ? today : emp.hiredOn}
                className={inputCls}
              />
              {salaryRows.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">{t('salaryInitialEffectiveHint')}</p>
              )}
            </Field>
            <Field label={t('basicSalaryMyr')}>
              <input name="basicSalary" type="number" min="0" step="0.01" required className={inputCls} />
            </Field>
            <Field label={t('salaryColRemarks')}>
              <input
                name="remarks"
                type="text"
                placeholder={t('salaryRemarksPlaceholder')}
                className={inputCls}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('salaryAllowanceMovedHint')}</p>
          <SalaryRevisionConfirm
            currentBasic={activeDerived ? activeDerived.basic : null}
            currency={activeDerived ? activeDerived.row.currency : 'MYR'}
          />
        </form>
      )}
    </Card>
  ) : null;

  // Statutory (Malaysia) card — relocated to the TOP of the Payroll tab and redesigned as a full-width
  // card (feedback 7524eda1). The layout is regrouped into clearly-labelled sections for readability
  // and future headroom. IMPORTANT: this remains a SINGLE <form action={setStatutoryAction}> — that
  // action is a full-row overwrite, so every named input MUST stay mounted at all times (no accordions /
  // conditional unmounting) or an absent field silently wipes stored data. No server logic changed.
  const statutoryCard = admin ? (
    <Card>
      <SectionHeader title={t('statutoryMalaysia')} />
      <form action={setStatutoryAction} className="flex flex-col gap-6 p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
        <input type="hidden" name="personId" value={emp.personId} />

        {/* Group 1 — Identification & tax */}
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('statutoryGroupIdentity')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('icNumber')}>
              <input name="icNumber" required defaultValue={statutory?.icNumber ?? ''} placeholder="900101011234" className={inputCls} />
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
            <label className="flex items-center gap-2 self-end pb-2 text-sm" title={t('taxResidentHint')}>
              <input type="checkbox" name="isResident" defaultChecked={statutory ? statutory.isResident : true} className="size-4 rounded" />
              {t('taxResident')}
            </label>
          </div>
        </fieldset>

        {/* Group 2 — EPF. Kept at sm:grid-cols-2 because <EpfElection> renders an internal sm:col-span-2
            rate row; leaving that island's grid assumptions untouched is the safe play. */}
        <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('epfContribTitle')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('epfElectionHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('epfNumber')}>
              <input name="epfNumber" defaultValue={statutory?.epfNumber ?? ''} className={inputCls} />
            </Field>
            <Field label={t('epfCitizenship')}>
              <select name="epfCitizenship" defaultValue={statutory?.epfCitizenship ?? 'citizen'} className={inputCls}>
                <option value="citizen">{t('epfCitizenshipCitizen')}</option>
                <option value="pr">{t('epfCitizenshipPr')}</option>
                <option value="non_citizen">{t('epfCitizenshipNonCitizen')}</option>
              </select>
            </Field>
            {/* EPF election (1C): rate fields appear only for voluntary_excess (client island). */}
            <EpfElection
              mode={statutory?.epfMode ?? null}
              employeeRate={statutory?.epfEmployeeRate ? Number(statutory.epfEmployeeRate) * 100 : null}
              employerRate={statutory?.epfEmployerRate ? Number(statutory.epfEmployerRate) * 100 : null}
            />
          </div>
        </fieldset>

        {/* Group 3 — SOCSO & EIS */}
        <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('statutoryGroupSocsoEis')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('socsoNumber')}>
              <input name="socsoNumber" defaultValue={statutory?.socsoNumber ?? ''} className={inputCls} />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" name="eisEligible" defaultChecked={statutory ? statutory.eisEligible : true} className="size-4 rounded" />
              {t('eisEligible')}
            </label>
          </div>
        </fieldset>

        {/* Group 4 — Salary payment (bank) */}
        <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('statutoryGroupBank')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('bank')}>
              <input name="bankName" defaultValue={statutory?.bankName ?? ''} className={inputCls} />
            </Field>
            <Field label={t('bankAccount')}>
              <input name="bankAccountNo" defaultValue={statutory?.bankAccountNo ?? ''} className={inputCls} />
            </Field>
          </div>
        </fieldset>

        {/* Group 5 — Previous employment / TP3 (opening balances) */}
        <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
          <legend className="mb-1 w-full text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('tp3SectionTitle')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('tp3SectionDescription')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          </div>
        </fieldset>

        {/* Zakat election RELOCATED to Payroll > Transactions > Zakat (feedback 58755260 — Module
            Separation Rule): Personnel no longer edits it. The pointer below keeps admins oriented;
            setStatutoryAction passes the current election through unchanged so this form can't wipe it. */}
        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          {t('zakatMoved')}{' '}
          <Link
            href="/payroll/transactions/zakat"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('zakatMovedLink')}
          </Link>
        </p>

        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('saveStatutory')}</button>
        </div>
      </form>
    </Card>
  ) : null;

  // ── DOCUMENTS ──────────────────────────────────────────────────────────────
  // v1 is intentionally thin: there is no general upload-and-store capability yet. We surface the
  // identification/statutory identifiers that qualify as "documents" today (read-only — the editable
  // source of truth stays on the Payroll statutory form, so no server action is forked here), plus a
  // count of the CP38 LHDN instalment records. A true file-attachment store is a separate enhancement.
  const documentsPanel = admin ? (
    <Card id="section-documents">
      <SectionHeader title={t('documents.title')} />
      <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t('documents.note')}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4 border-b border-border pb-2">
          <dt className="text-muted-foreground">{t('icNumber')}</dt>
          <dd className="font-mono">{statutory?.icNumber || '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border pb-2">
          <dt className="text-muted-foreground">{t('taxNumber')}</dt>
          <dd className="font-mono">{statutory?.taxNumber || '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border pb-2">
          <dt className="text-muted-foreground">{t('epfNumber')}</dt>
          <dd className="font-mono">{statutory?.epfNumber || '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border pb-2">
          <dt className="text-muted-foreground">{t('socsoNumber')}</dt>
          <dd className="font-mono">{statutory?.socsoNumber || '—'}</dd>
        </div>
        <div className="flex justify-between gap-4 border-b border-border pb-2">
          <dt className="text-muted-foreground">{t('documents.cp38Records')}</dt>
          <dd className="tabular-nums">{cp38Records.length}</dd>
        </div>
      </dl>
      <p className="px-4 pb-4 text-xs text-muted-foreground">{t('documents.hint')}</p>
    </Card>
  ) : null;

  // ── JOB ────────────────────────────────────────────────────────────────────
  // Assignment (position/department) history, reporting lines, approval delegations, location, and
  // the transfer/terminate controls. Assignment history is not admin-gated (visible to any viewer).
  const assignmentHistoryCard = (
    <Card id="section-assignment-history" className="overflow-hidden">
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
  );

  const changeHistoryCard = admin ? (
    <Card id="section-change-history" className="overflow-hidden">
      <SectionHeader title={t('changeHistory')} count={changeHistory.length} />
      <AuditTable rows={changeHistory} nowMs={Date.now()} />
    </Card>
  ) : null;

  const dataPrivacyCard = admin ? (
    <Card id="section-data-privacy" className="border-rose-200 dark:border-rose-500/30">
      <SectionHeader title={t('dataPrivacyTitle')} />
      <div className="space-y-2 p-4">
        <p className="text-sm text-muted-foreground">{t('dataPrivacyNote')}</p>
        <Link href={`/admin/privacy?subject=${emp.employmentId}`} className={btnPrimary}>
          {t('dataPrivacyLink')}
        </Link>
      </div>
    </Card>
  ) : null;

  const reportingLinesCard = (
    <Card id="section-reporting-lines">
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
                        href={`/admin/personnel/${m.employmentId}`}
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
                      href={`/admin/personnel/${r.employmentId}`}
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
  );

  // Hierarchy Management (ADR-0052): approval delegations. When this employee (a reporting-line
  // holder) is away, they assign a stand-in who can approve on their behalf for a window. This is
  // approver-routing only — the delegate gains NO visibility of the delegator's reports.
  const delegationsCard = (
    <Card id="section-delegations">
      <SectionHeader title={t('delegationsTitle')} />
        <div className="p-4">
          {delegations.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('delegationsEmpty')}</div>
          ) : (
            <ul className="space-y-2">
              {delegations.map((d) => (
                <li key={d.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Link href={`/admin/personnel/${d.delegateEmploymentId}`} className="text-foreground hover:text-primary">
                      {d.delegateName}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {d.validFrom} → {d.validTo ?? '—'}
                    </span>
                  </span>
                  <form action={endDelegationAction}>
                    <input type="hidden" name="employmentId" value={emp.employmentId} />
                    <input type="hidden" name="reportingLineId" value={d.id} />
                    <input type="hidden" name="endDate" value={today} />
                    <button type="submit" title={t('delegationEnd')} className="text-muted-foreground transition-colors hover:text-red-500">
                      ×
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!emp.terminatedOn && others.length > 0 && (
          <form
            action={addDelegationAction}
            className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
          >
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <Field label={t('delegationDelegate')}>
              <select name="delegateEmploymentId" required className={inputCls}>
                {others.map((o) => (
                  <option key={o.employmentId} value={o.employmentId}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('delegationFrom')}>
              <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
            </Field>
            <Field label={t('delegationTo')}>
              <input name="validTo" type="date" className={inputCls} />
            </Field>
            <div>
              <button className={btnPrimary}>{t('delegationAdd')}</button>
            </div>
          </form>
        )}
    </Card>
  );

  const locationCard = admin ? (
    <Card id="section-location">
      <SectionHeader title={t('locationTitle')} />
      <div className="px-4 pt-3 text-sm text-muted-foreground">
        {t('locationCurrent', { location: emp.locationName ? `${emp.locationName} (${emp.locationCode})` : t('locationNone') })}
      </div>
      {!emp.terminatedOn && (
        <form action={setLocationAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <Field label={t('locationSelect')}>
            <select name="locationId" defaultValue={emp.locationId ?? ''} className={inputCls}>
              <option value="">{t('locationNone')}</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code}){l.state ? ` · ${l.state}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('effectiveDate')}>
            <input name="effectiveDate" type="date" required defaultValue={today} className={inputCls} />
          </Field>
          <div>
            <button className={btnPrimary}>{t('setLocation')}</button>
          </div>
        </form>
      )}
    </Card>
  ) : null;

  const transferTerminateCards = !emp.terminatedOn ? (
    <div id="section-transfer-terminate" className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
  ) : null;

  const leaveRequestsCard = (
    <Card id="section-leave-requests" className="overflow-hidden">
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
  );

  // Probation / Contract / Internship review (0110). Admin/manager-managed; hidden once terminated.
  const reviewCard = !emp.terminatedOn && admin ? <ReviewSection s={s} employmentId={employmentId} /> : null;

  // Distribute the pre-built section cards into the six tab panels (mapping per approved plan). Each
  // panel is a fragment of the existing <Card> blocks — nothing about the forms or server actions changed,
  // only where they render. Falsy entries (admin-gated / state-gated nulls) collapse to nothing.
  const panels = {
    // Single-card tabs pass the node directly so a null (defensive; requireAdmin guarantees non-null
    // here) falls through to the shell's empty-state rather than rendering a blank fragment.
    profile: profilePanel,
    family: familyPanel,
    job: (
      <>
        {assignmentHistoryCard}
        {reportingLinesCard}
        {delegationsCard}
        {locationCard}
        {defaultShiftCard}
        {transferTerminateCards}
      </>
    ),
    // Statutory (Malaysia) pinned to the TOP of the Payroll tab (feedback 7524eda1); Compensation keeps
    // its old slot at the bottom. Every other card retains its relative order.
    payroll: (
      <>
        {statutoryCard}
        {payComponentsCard}
        {cp38Card}
        {encashmentCard}
        {payrollPolicyCard}
        {compensationCard}
      </>
    ),
    // Leave Information (feedback d085c6fc): the Leave Balance card — including its entitlement
    // breakdown drill-down — relocated out of Payroll into a dedicated leave-management tab. Same
    // card, same data (loaded once for the page), just a different tab; no leave/payroll logic moved.
    leave: leaveBalanceCard,
    documents: documentsPanel,
    others: (
      <>
        {clockingCard}
        {changeHistoryCard}
        {dataPrivacyCard}
        {leaveRequestsCard}
        {reviewCard}
      </>
    ),
  };

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

      <PersonnelTabs tabs={tabs} panels={panels} emptyLabel={t('tabs.empty')} />
    </div>
  );
}
