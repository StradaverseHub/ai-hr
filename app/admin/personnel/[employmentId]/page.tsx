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
import { Avatar, Badge, Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, btnPrimary, inputCls } from '@/components/ui';
import { hasPersonPhoto } from '@/core/person-photo';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
import { AuditTable } from '@/components/audit-table';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { IdentityFields, IdentityProvider, NationalityField } from '@/components/personnel-identity';
import { EpfElection } from '@/components/epf-election';
import { BankInfoCard } from '@/components/bank-info-card';
import { IdentityTaxCard } from '@/components/identity-tax-card';
import { SameAsPermanentAddress } from '@/components/same-as-permanent-address';
import {
  addDelegationAction,
  addReportingLineAction,
  endDelegationAction,
  endReportingLineAction,
  setCompensationAction,
  setComplianceFieldsAction,
  setContactAddressAction,
  setEmergencyContactAction,
  setEmploymentAssignmentAction,
  setEmploymentComponentAction,
  setEmploymentInfoAction,
  setLocationAction,
  setPersonAction,
  setPersonPhotoAction,
  removePersonPhotoAction,
  setStatutoryAction,
  setTp3Action,
  setBankAction,
  setIcAction,
  setPassportAction,
  setTaxAction,
  terminateAction,
  transferAction,
} from './actions';
import { serviceYearsMonthsAt } from '@/core/leave';
import { compensationHistoryDetailed, type CompensationHistoryRow } from '@/core/comp';
import { SalaryRevisionConfirm } from '@/components/salary-revision-confirm';
import { SalaryHistoryTable, type SalaryRowView } from '@/components/salary-history-table';
import { listCp38 } from '@/core/cp38';
import { addCp38Action, editCp38Action, terminateCp38Action } from './cp38-actions';
import { listDependents, eligibleChildReliefCount, DEPENDENT_GENDERS, DEPENDENT_MARRIAGE_STATUSES, type DependentRow } from '@/core/dependents';
import { addDependentAction, editDependentAction, archiveDependentAction } from './dependent-actions';
import { listAssignablePolicies } from '@/core/payroll-policy';
import { assignPolicyAction } from '@/app/admin/payroll-policy/actions';
import { listShiftsForTenant } from '@/core/roster';
import { EmployeeShiftFields } from '@/components/employee-shift-fields';
import { setDefaultShiftAction } from './actions';
import { listHolidayGroups, listPositions } from '@/core/admin';
import { listLocations } from '@/core/location';
import { listClockingLocations, listEmployeeClockingLocations } from '@/core/clocking-location';
import { setEmployeeClockingLocationsAction, setGeofencingAction } from './actions';
import { ReviewSection } from './review-section';
import { DocumentsSection } from './documents-section';
import { PersonnelTabs, type PersonnelTabKey } from '@/components/personnel-tabs';
import { getStatutoryProfileMY, defaultSocsoEisNumber } from '@/localization/my/statutory';
import { MY_STATES } from '@/localization/my/holidays';
import { listAllProfileOptions } from '@/core/profile-options';
import { ProfileOptionSelect } from '@/components/profile-option-select';
import { PhotoEditMenu } from '@/components/photo-edit-menu';
import { listEmploymentPayComponents, listPayComponents } from '@/core/pay-components';
import { encashmentSnapshotForEmployment } from '@/core/leave-encashment';
import { unfreezeEncashmentAction, adjustEncashmentAction } from './encashment-actions';

const LEAVE_STATUS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  rejected: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  cancelled: 'bg-muted text-muted-foreground',
  // R17 600be8ac ask #4: derived "Partially approved" display (approved request with some dates rejected).
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
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
  searchParams: Promise<{
    error?: string;
    from?: string;
    cp38Error?: string;
    asOf?: string;
    encashmentError?: string;
    tab?: string;
  }>;
}) {
  const s = await requireAdmin(); // Admin-only management surface (People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.detail');
  const tp = await getTranslations('payrollPolicy');
  const tc = await getTranslations('people.detail.clocking');
  const admin = isAdmin(s);
  const { employmentId } = await params;
  const { error, from, cp38Error, asOf: spAsOf, encashmentError, tab } = await searchParams;
  // Context-aware back link: came from the org chart (?from=org) → return there; otherwise the
  // people directory. Keeps the `from` param flowing through so nested navigation stays consistent.
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/admin/personnel', label: t('backToPeople') };

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  const today = new Date().toISOString().slice(0, 10);
  // b4682879 — does this employee have a profile photo the viewer may see? (existence only; never the blob).
  const photoExists = await hasPersonPhoto(s, emp.personId);

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
  // Employment tab org-info edit (594323a6): position catalog for the editable Position dropdown. Scoped to
  // THIS employee's company (the assignment's position must belong to the same company). Admin-only.
  const positions = admin ? await listPositions(s, { companyIds: [emp.companyId] }) : [];
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
  // R33 f21d6eee — Default shift picker options: the SHARED tenant-wide shift library (a template may now be
  // assigned to any employee regardless of company). Loaded WITH archived rows so a currently-assigned-but-
  // later-archived shift still renders as the selected option (instead of silently showing "None"), then
  // filtered to live shifts + the assigned one. New assignments of archived shifts are rejected by the service.
  const libraryShifts = admin && !emp.terminatedOn ? await listShiftsForTenant(s, { includeArchived: true }) : [];
  const assignableShifts = libraryShifts.filter((sh) => !sh.archivedAt || sh.id === emp.defaultShiftId);
  // ADR-0070 — Clocking Location & Geofencing: THIS employee's company's active clocking sites (the
  // multi-select options) + their current assignment (admin-only, mirrors the payroll-policy card).
  const clockingLocations = admin ? await listClockingLocations(s, [emp.companyId]) : [];
  const assignedClockingLocations = admin ? await listEmployeeClockingLocations(s, employmentId) : [];
  const assignedClockingLocationIds = new Set(assignedClockingLocations.map((l) => l.id));
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);
  const changeHistory = admin ? await employeeAudit(s, employmentId) : [];
  // 7d309da7 — configurable profile-field dropdown catalogs (religion / race / nationality / state /
  // country / relationship). Active options only for the pickers; the ProfileOptionSelect renders any
  // out-of-catalog stored value as a pre-selected extra so a Save never blanks legacy data.
  const profileOptions = admin
    ? await listAllProfileOptions(s, { activeOnly: true })
    : ({ religion: [], race: [], nationality: [], state: [], country: [], relationship: [] } as Awaited<
        ReturnType<typeof listAllProfileOptions>
      >);

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
  // 4535b733 — marriage-status label as a static switch (same i18n-coverage guarantee as above).
  const marriageStatusLabel = (m: string | null) => {
    switch (m) {
      case 'married': return t('family.marriageStatus.married');
      case 'divorced': return t('family.marriageStatus.divorced');
      case 'widowed': return t('family.marriageStatus.widowed');
      case 'separated': return t('family.marriageStatus.separated');
      default: return '—';
    }
  };

  // Tab labels (people.detail.tabs.*). Six tabs regrouping the existing sections below; the page still
  // loads all data once, so switching tabs is instant and keeps the viewer on the same employee.
  const tabs: { key: 'profile' | 'family' | 'job' | 'careerMovement' | 'attendance' | 'bankStatutory' | 'payroll' | 'leave' | 'documents' | 'others'; label: string }[] = [
    { key: 'profile', label: t('tabs.profile') },
    { key: 'family', label: t('tabs.family') },
    { key: 'job', label: t('tabs.job') },
    // Career Movement (feedback 5296d984): employment lifecycle events — Assignment History, Transfer
    // (Effective-Dated) and Terminate — relocated OUT of the Employment tab into a dedicated home. The
    // Employment tab keeps the "how they work" master data (reporting lines, delegations); the lifecycle
    // "events that change employment over time" now live here. Same cards, same server actions
    // (transferAction / terminateAction keep their existing DomainEvents), only regrouped. Positioned
    // right after Employment so the person's static setup sits next to the actions that move them.
    { key: 'careerMovement', label: t('tabs.careerMovement') },
    // Attendance Information (feedback 1fbe9891): consolidates the attendance-related master data that
    // was previously split across Employment (Work Location + Shift Arrangement) and Others (Clocking
    // Locations & Geofencing) into one dedicated tab. Same cards, same server actions — only regrouped.
    // Positioned right after Employment so the operational attendance setup sits next to the role/posting.
    { key: 'attendance', label: t('tabs.attendance') },
    // Bank & Statutory (feedback 40ef71a0): the Statutory (Malaysia) card — which already co-locates the
    // salary-payment bank fields alongside EPF/SOCSO/EIS/PCB — is relocated here out of the Payroll tab,
    // giving all pay-related master data its own clearly-named home. Positioned before Payroll.
    { key: 'bankStatutory', label: t('tabs.bankStatutory') },
    { key: 'payroll', label: t('tabs.payroll') },
    { key: 'leave', label: t('tabs.leave') },
    { key: 'documents', label: t('tabs.documents') },
    { key: 'others', label: t('tabs.others') },
  ];

  // ── PROFILE ────────────────────────────────────────────────────────────────
  // b4682879 — modular redesign: three organised cards (Personal Details, Contact & Address, Emergency
  // Contact) plus the existing gender/marital/DOB compliance card. Each card stays its OWN <form> (panels
  // stay mounted in the tab shell) and routes through the single writer for its trust class (updatePerson
  // for instant fields, setPersonComplianceFields for the audited compliance fields). The core identity
  // (fullName / primaryEmail / phone) that updatePerson always writes is passed through as hidden fields on
  // the cards that don't visibly own it, so saving one section never wipes another's data.
  const profilePanel = admin ? (
    <>
      {/* Item e3ce0d4d — IdentityProvider lifts the live Nationality selection so the identity block below can
          switch between IC (Malaysian) and Passport (non-Malaysian) fields instantly. The Card shell + all the
          server-action forms stay Server Components; only the nationality picker + identity block are client. */}
      <IdentityProvider initialNationality={emp.nationality}>
      <Card id="section-personal-details">
        <SectionHeader title={t('personalDetails')} />
        <form action={setPersonAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="personId" value={emp.personId} />
          {/* primaryEmail / phone are owned by the Contact card; carried through so this save keeps them. */}
          <input type="hidden" name="primaryEmail" value={emp.email} />
          <input type="hidden" name="phone" value={emp.phone ?? ''} />
          <Field label={t('employeeIdLabel')}>
            <input
              name="employeeCode"
              required
              maxLength={9}
              defaultValue={emp.employeeCode ?? ''}
              placeholder={t('employeeIdPlaceholder')}
              className={inputCls}
            />
          </Field>
          <Field label={t('fullNameIc')}>
            <input name="fullName" required defaultValue={emp.name} className={inputCls} />
          </Field>
          <Field label={t('firstName')}>
            <input name="firstName" defaultValue={emp.firstName ?? ''} className={inputCls} />
          </Field>
          <Field label={t('lastName')}>
            <input name="lastName" defaultValue={emp.lastName ?? ''} className={inputCls} />
          </Field>
          <Field label={t('preferredName')}>
            <input name="preferredName" defaultValue={emp.preferredName ?? ''} className={inputCls} />
          </Field>
          <Field label={t('religion')}>
            <ProfileOptionSelect
              name="religion"
              value={emp.religion}
              options={profileOptions.religion}
              placeholder={t('optionNotSet')}
              legacySuffix={t('optionLegacySuffix')}
            />
          </Field>
          <Field label={t('race')}>
            <ProfileOptionSelect
              name="race"
              value={emp.race}
              options={profileOptions.race}
              placeholder={t('optionNotSet')}
              legacySuffix={t('optionLegacySuffix')}
            />
          </Field>
          <Field label={t('nationality')}>
            {/* 59047802 — searchable combobox over the full ISO 3166-1 nationality set; emits the same
                single `nationality` value (via a hidden input) so setPersonAction is unchanged. e3ce0d4d —
                wrapped as NationalityField so a change also pushes the live value into IdentityProvider,
                driving the IC ⇄ Passport switch in the identity block below without a page reload. */}
            <NationalityField
              name="nationality"
              value={emp.nationality}
              options={profileOptions.nationality.map((o) => ({ value: o.value, label: o.label }))}
              placeholder={t('optionNotSet')}
              searchPlaceholder={t('nationalitySearchPlaceholder')}
              noResultsLabel={t('nationalityNoResults')}
              legacySuffix={t('optionLegacySuffix')}
            />
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

        {/* Wave 2A-1 / #24 + b4682879: gender + marital status (leave eligibility) and date of birth
            (age-band statutory). Kept on their OWN submit → setPersonComplianceFields (the audited path),
            separate from the instant-write core fields above. */}
        <form
          action={setComplianceFieldsAction}
          className="grid grid-cols-1 items-end gap-3 border-t border-border p-4 sm:grid-cols-4"
        >
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <Field label={t('birthDate')}>
            <input id="profile-dob-input" name="dateOfBirth" type="date" defaultValue={emp.dateOfBirth ?? ''} className={inputCls} />
          </Field>
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
              <option value="divorced">{t('maritalDivorced')}</option>
              <option value="widowed">{t('maritalWidowed')}</option>
              <option value="separated">{t('maritalSeparated')}</option>
              <option value="other">{t('maritalOther')}</option>
            </select>
          </Field>
          <p className="text-xs text-muted-foreground sm:col-span-4">{t('maritalPcbNote')}</p>
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveComplianceFields')}</button>
          </div>
        </form>

        {/* Item e3ce0d4d — nationality-conditional identification. IdentityFields (client) reads the live
            nationality from IdentityProvider and renders the IC form (Malaysian: IcDobAutofill, IC mandatory,
            DOB autofill preserved — item 354a500d/8b5334db) OR the passport form (non-Malaysian: number/issue/
            expiry mandatory, remark optional; setPassportAction skips MyKad validation). Both server actions are
            passed in as props (RSC→client pattern); only the relevant card shows so its required fields apply. */}
        <IdentityFields
          employmentId={emp.employmentId}
          personId={emp.personId}
          icDefault={statutory?.icNumber ?? ''}
          passportNumber={statutory?.passportNumber ?? ''}
          passportIssueDate={statutory?.passportIssueDate ?? ''}
          passportExpiryDate={statutory?.passportExpiryDate ?? ''}
          passportRemark={statutory?.passportRemark ?? ''}
          setIcAction={setIcAction}
          setPassportAction={setPassportAction}
        />
      </Card>
      </IdentityProvider>

      <Card id="section-contact-address">
        <SectionHeader title={t('contactAddressTitle')} />
        <form action={setContactAddressAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="personId" value={emp.personId} />
          {/* fullName is owned by the Personal Details card; carried through so this save keeps it. */}
          <input type="hidden" name="fullName" value={emp.name} />
          <Field label={t('workEmail')}>
            <input name="primaryEmail" type="email" required defaultValue={emp.email} className={inputCls} />
          </Field>
          <Field label={t('phone')}>
            <input name="phone" defaultValue={emp.phone ?? ''} placeholder="+60…" className={inputCls} />
          </Field>
          <Field label={t('personalEmail')}>
            <input name="personalEmail" type="email" defaultValue={emp.personalEmail ?? ''} className={inputCls} />
          </Field>

          {/* 3a25f5ee — Contact & Address split into two independent address blocks. Permanent = where the
              employee lives (today's single address backfilled here in migration 0213); Correspondence =
              official mailing / IC-registered address. Each is the same 7 fields; state/country validate
              against the shared profile_option catalog. Field ids (perm- and corr- prefixed) let the "Same
              as Permanent Address" client island copy Permanent to Correspondence (fields stay editable). */}
          <div className="sm:col-span-4 mt-1 grid grid-cols-1 gap-3 sm:grid-cols-4 rounded-lg border border-border/60 p-3">
            <p className="sm:col-span-4 text-sm font-medium text-foreground">{t('permanentAddressTitle')}</p>
            <Field label={t('addressLine1')}>
              <input id="perm-addressLine1" name="permanentAddressLine1" defaultValue={emp.permanentAddressLine1 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('addressLine2')}>
              <input id="perm-addressLine2" name="permanentAddressLine2" defaultValue={emp.permanentAddressLine2 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('addressLine3')}>
              <input id="perm-addressLine3" name="permanentAddressLine3" defaultValue={emp.permanentAddressLine3 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('postcode')}>
              <input id="perm-postcode" name="permanentPostcode" defaultValue={emp.permanentPostcode ?? ''} className={inputCls} />
            </Field>
            <Field label={t('city')}>
              <input id="perm-city" name="permanentCity" defaultValue={emp.permanentCity ?? ''} className={inputCls} />
            </Field>
            <Field label={t('stateLabel')}>
              <ProfileOptionSelect
                id="perm-state"
                name="permanentState"
                value={emp.permanentState}
                options={profileOptions.state}
                placeholder={t('optionNotSet')}
                legacySuffix={t('optionLegacySuffix')}
              />
            </Field>
            <Field label={t('country')}>
              <ProfileOptionSelect
                id="perm-country"
                name="permanentCountry"
                value={emp.permanentCountry}
                options={profileOptions.country}
                placeholder={t('optionNotSet')}
                legacySuffix={t('optionLegacySuffix')}
              />
            </Field>
          </div>

          <div className="sm:col-span-4">
            <SameAsPermanentAddress label={t('sameAsPermanent')} viaInputName="addressCopyVia" />
          </div>

          <div className="sm:col-span-4 grid grid-cols-1 gap-3 sm:grid-cols-4 rounded-lg border border-border/60 p-3">
            <p className="sm:col-span-4 text-sm font-medium text-foreground">{t('correspondenceAddressTitle')}</p>
            <Field label={t('addressLine1')}>
              <input id="corr-addressLine1" name="correspondenceAddressLine1" defaultValue={emp.correspondenceAddressLine1 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('addressLine2')}>
              <input id="corr-addressLine2" name="correspondenceAddressLine2" defaultValue={emp.correspondenceAddressLine2 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('addressLine3')}>
              <input id="corr-addressLine3" name="correspondenceAddressLine3" defaultValue={emp.correspondenceAddressLine3 ?? ''} className={`${inputCls} sm:col-span-4`} />
            </Field>
            <Field label={t('postcode')}>
              <input id="corr-postcode" name="correspondencePostcode" defaultValue={emp.correspondencePostcode ?? ''} className={inputCls} />
            </Field>
            <Field label={t('city')}>
              <input id="corr-city" name="correspondenceCity" defaultValue={emp.correspondenceCity ?? ''} className={inputCls} />
            </Field>
            <Field label={t('stateLabel')}>
              <ProfileOptionSelect
                id="corr-state"
                name="correspondenceState"
                value={emp.correspondenceState}
                options={profileOptions.state}
                placeholder={t('optionNotSet')}
                legacySuffix={t('optionLegacySuffix')}
              />
            </Field>
            <Field label={t('country')}>
              <ProfileOptionSelect
                id="corr-country"
                name="correspondenceCountry"
                value={emp.correspondenceCountry}
                options={profileOptions.country}
                placeholder={t('optionNotSet')}
                legacySuffix={t('optionLegacySuffix')}
              />
            </Field>
          </div>
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveContact')}</button>
          </div>
        </form>
      </Card>

      <Card id="section-emergency-contact">
        <SectionHeader title={t('emergencyTitle')} />
        <form action={setEmergencyContactAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="personId" value={emp.personId} />
          {/* identity trio carried through (pass-through) so an emergency-contact save never wipes it. */}
          <input type="hidden" name="fullName" value={emp.name} />
          <input type="hidden" name="primaryEmail" value={emp.email} />
          <input type="hidden" name="phone" value={emp.phone ?? ''} />
          <Field label={t('emergencyName')}>
            <input name="emergencyContactName" defaultValue={emp.emergencyContactName ?? ''} className={inputCls} />
          </Field>
          <Field label={t('emergencyRelationship')}>
            <ProfileOptionSelect
              name="emergencyContactRelationship"
              value={emp.emergencyContactRelationship}
              options={profileOptions.relationship}
              placeholder={t('optionNotSet')}
              legacySuffix={t('optionLegacySuffix')}
            />
          </Field>
          <Field label={t('emergencyPhone1')}>
            <input name="emergencyContactPhone" defaultValue={emp.emergencyContactPhone ?? ''} className={inputCls} />
          </Field>
          <Field label={t('emergencyPhone2')}>
            <input name="emergencyContactPhone2" defaultValue={emp.emergencyContactPhone2 ?? ''} className={inputCls} />
          </Field>
          <Field label={t('emergencyAddress')}>
            {/* 7d309da7 — address = multi-line long-text (line breaks preserved) instead of a single input. */}
            <textarea
              name="emergencyContactAddress"
              defaultValue={emp.emergencyContactAddress ?? ''}
              rows={3}
              className={`${inputCls} sm:col-span-4`}
            />
          </Field>
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveEmergency')}</button>
          </div>
        </form>
      </Card>
    </>
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
  // Personnel — Family & Dependents. 4535b733 enhancement: the flat register is partitioned server-side
  // into three logical, collapsible sections — Spouse / Children / Other Dependants — each with a
  // full-field Add + Edit + Remove UI. Admin-maintained (RLS is_admin write); does NOT feed the tax
  // num_children figure and is distinct from the emergency contact. Spouse-only (marriage / spouse
  // employment) and child-only (student status / school) fields render only in their own section.
  const spouseDeps = dependents.filter((d) => d.relationship === 'spouse');
  const childDeps = dependents.filter((d) => d.relationship === 'child');
  const otherDeps = dependents.filter((d) => d.relationship !== 'spouse' && d.relationship !== 'child');
  // Multi-line inputs (residential / employer address) — same look as inputCls but taller, auto-height.
  const taCls = `${inputCls.replace('h-9', 'min-h-16')} py-2`;
  type FamilySection = 'spouse' | 'child' | 'other';

  // A tri-state checkbox: a hidden `${name}__present` marker lets the server tell "unticked" (posts
  // nothing) apart from "field absent on this section's form".
  const familyCheckbox = (name: string, checked: boolean, label: string) => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input type="hidden" name={`${name}__present`} value="1" />
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );

  // Shared field inputs for one dependent form. `section` selects which grouped fields appear; `d` is the
  // existing row (null on the Add form). Every control is named exactly as its server-side field.
  const dependentFields = (section: FamilySection, d: DependentRow | null) => (
    <>
      <Field label={t('family.name')}>
        <input name="fullName" required defaultValue={d?.fullName ?? ''} placeholder={t('family.namePlaceholder')} className={inputCls} />
      </Field>
      {section === 'other' ? (
        <Field label={t('family.relationship')}>
          <select name="relationship" required defaultValue={d?.relationship ?? 'other'} className={inputCls}>
            {(['parent', 'sibling', 'other'] as const).map((r) => (
              <option key={r} value={r}>{relationshipLabel(r)}</option>
            ))}
          </select>
        </Field>
      ) : (
        <input type="hidden" name="relationship" value={section} />
      )}
      <Field label={t('family.genderLabel')}>
        <select name="gender" defaultValue={d?.gender ?? ''} className={inputCls}>
          <option value="">{t('family.genderUnset')}</option>
          {DEPENDENT_GENDERS.map((g) => (<option key={g} value={g}>{genderLabel(g)}</option>))}
        </select>
      </Field>
      <Field label={t('family.dateOfBirth')}>
        <input name="dateOfBirth" type="date" defaultValue={d?.dateOfBirth ?? ''} className={inputCls} />
      </Field>
      <Field label={t('family.contactNumber')}>
        <input name="phone" type="tel" defaultValue={d?.phone ?? ''} className={inputCls} />
      </Field>
      <Field label={section === 'child' ? t('family.icOrBirthCert') : t('family.newIc')}>
        <input name="icOrPassport" defaultValue={d?.icOrPassport ?? ''} className={inputCls} />
      </Field>
      {section !== 'child' && (
        <Field label={t('family.passportNumber')}>
          <input name="passportNumber" defaultValue={d?.passportNumber ?? ''} className={inputCls} />
        </Field>
      )}
      {section !== 'child' && (
        <div className="sm:col-span-2">
          <Field label={t('family.residentialAddress')}>
            <textarea name="residentialAddress" rows={2} defaultValue={d?.residentialAddress ?? ''} className={taCls} />
          </Field>
        </div>
      )}
      {section === 'spouse' && (
        <>
          <Field label={t('family.marriageDate')}>
            <input name="marriageDate" type="date" defaultValue={d?.marriageDate ?? ''} className={inputCls} />
          </Field>
          <Field label={t('family.marriageStatusLabel')}>
            <select name="marriageStatus" defaultValue={d?.marriageStatus ?? ''} className={inputCls}>
              <option value="">{t('family.genderUnset')}</option>
              {DEPENDENT_MARRIAGE_STATUSES.map((m) => (<option key={m} value={m}>{marriageStatusLabel(m)}</option>))}
            </select>
          </Field>
          <Field label={t('family.occupation')}>
            <input name="occupation" defaultValue={d?.occupation ?? ''} className={inputCls} />
          </Field>
          <Field label={t('family.companyName')}>
            <input name="companyName" defaultValue={d?.companyName ?? ''} className={inputCls} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t('family.employerAddress')}>
              <textarea name="employerAddress" rows={2} defaultValue={d?.employerAddress ?? ''} className={taCls} />
            </Field>
          </div>
        </>
      )}
      {section === 'other' && (
        <Field label={t('family.occupation')}>
          <input name="occupation" defaultValue={d?.occupation ?? ''} className={inputCls} />
        </Field>
      )}
      {section === 'child' && (
        <Field label={t('family.schoolName')}>
          <input name="schoolName" defaultValue={d?.schoolName ?? ''} className={inputCls} />
        </Field>
      )}
      <Field label={t('family.remarks')}>
        <input name="remarks" type="text" defaultValue={d?.remarks ?? ''} placeholder={t('family.remarksPlaceholder')} className={inputCls} />
      </Field>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
        {familyCheckbox('isBeneficiary', d?.isBeneficiary ?? false, t('family.beneficiary'))}
        {section === 'spouse' && familyCheckbox('spouseWorking', d?.spouseWorking ?? false, t('family.currentlyWorking'))}
        {section === 'child' && familyCheckbox('isStudent', d?.isStudent ?? false, t('family.studentStatus'))}
        {familyCheckbox('isDeceased', d?.isDeceased ?? false, t('family.deceasedStatus'))}
      </div>
    </>
  );

  // One existing record: a collapsible card whose body is the full-field edit form + a Remove form.
  const familyEditCard = (section: FamilySection, d: DependentRow) => (
    <details key={d.id} className="rounded-md border border-border">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium">
        <span>{d.fullName}</span>
        <span className="text-xs text-muted-foreground">{relationshipLabel(d.relationship)}</span>
        {d.isBeneficiary && <Badge variant="success">{t('family.beneficiary')}</Badge>}
        {d.isDeceased && <Badge variant="default">{t('family.deceased')}</Badge>}
      </summary>
      <div className="border-t border-border p-3">
        <form action={editDependentAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="id" value={d.id} />
          {dependentFields(section, d)}
          <div className="sm:col-span-2 flex items-center gap-4">
            <button className={btnPrimary}>{t('family.save')}</button>
          </div>
        </form>
        <form action={archiveDependentAction} className="mt-2">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="id" value={d.id} />
          <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
            {t('family.delete')}
          </button>
        </form>
      </div>
    </details>
  );

  // The Add form for a section (collapsed by default).
  const familyAddCard = (section: FamilySection, addLabel: string) => (
    <details className="rounded-md border border-dashed border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-primary">{addLabel}</summary>
      <div className="border-t border-border p-3">
        <form action={addDependentAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="personId" value={emp.personId} />
          {dependentFields(section, null)}
          <div className="sm:col-span-2">
            <button className={btnPrimary}>{t('family.add')}</button>
          </div>
        </form>
      </div>
    </details>
  );

  const familySection = (
    titleKey: string,
    emptyKey: string,
    addLabelKey: string,
    section: FamilySection,
    rows: DependentRow[],
  ) => (
    <details open className="border-t border-border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
        {t(titleKey)} <span className="font-normal text-muted-foreground">({rows.length})</span>
      </summary>
      <div className="space-y-2 px-4 pb-4">
        {rows.length > 0
          ? rows.map((d) => familyEditCard(section, d))
          : <p className="text-sm text-muted-foreground">{t(emptyKey)}</p>}
        {familyAddCard(section, t(addLabelKey))}
      </div>
    </details>
  );

  const familyPanel = admin ? (
    <Card id="section-family" className="overflow-hidden">
      <SectionHeader title={t('family.title')} count={dependents.length} />
      <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t('family.note')}
      </p>
      <div className="mt-3">
        {familySection('family.spouseSection', 'family.noSpouse', 'family.addSpouse', 'spouse', spouseDeps)}
        {familySection('family.childrenSection', 'family.noChildren', 'family.addChild', 'child', childDeps)}
        {familySection('family.otherSection', 'family.noOther', 'family.addDependant', 'other', otherDeps)}
      </div>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('family.hint')}</p>
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
  // mirrors the payroll-policy assignment card; lives in the Employment tab (it describes how the person works).
  const defaultShiftCard = admin && !emp.terminatedOn ? (
    <Card id="section-default-shift">
      <SectionHeader title={t('shiftTypeTitle')} />
          <form action={setDefaultShiftAction} className="space-y-3 p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            {/* R17 3e8350db — Shift Type (Fixed / Roster) with a conditionally-shown Default shift picker. */}
            <EmployeeShiftFields
              defaultType={emp.shiftType}
              defaultShiftId={emp.defaultShiftId}
              shifts={assignableShifts.map((sh) => ({
                id: sh.id,
                label: `${sh.code ?? '—'} — ${sh.name} (${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)})`,
              }))}
            />
            <button className={btnPrimary}>{t('defaultShiftSave')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{t('shiftTypeHint')}</p>
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
                  summary={{ available: b.available, taken: b.taken, pending: b.pending, ytdEntitled: b.accrued }}
                  // §5 Upcoming Approved Leave — approved + future requests for THIS type (name-matched).
                  upcoming={requests
                    .filter((r) => r.status === 'approved' && r.startDate > today && r.leaveType === b.leaveType)
                    .map((r) => ({ startDate: r.startDate, endDate: r.endDate, days: Number(r.days), durationType: r.durationType }))}
                  visual={{ color: b.color, icon: b.icon, code: b.code }}
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

  // Statutory (Malaysia) card — now the sole card of the dedicated Bank & Statutory tab (feedback
  // 40ef71a0; originally pinned to the top of the Payroll tab under 7524eda1). Full-width card whose
  // layout is regrouped into clearly-labelled sections (identity/tax, EPF, SOCSO/EIS, salary-payment
  // bank, TP3) for readability. IMPORTANT: this remains a SINGLE <form action={setStatutoryAction}> — that
  // action is a full-row overwrite, so every named input MUST stay mounted at all times (no accordions /
  // conditional unmounting) or an absent field silently wipes stored data. No server logic changed.
  const statutoryCard = admin ? (
    <Card>
      <SectionHeader title={t('statutoryMalaysia')} />
      <form action={setStatutoryAction} className="flex flex-col gap-6 p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
        <input type="hidden" name="personId" value={emp.personId} />

        {/* Item 8b5334db — Group 1 (Identification & tax) was split out of this full-row statutory form: the IC
            moved to its own form on the Profile tab (setIcAction), and the tax fields (Tax Number, Tax Category,
            Income Tax Resident, Children/PCB relief, Employer-bears-tax) moved to the dedicated Identification &
            Tax card above (setTaxAction). This form no longer carries any of those inputs; setStatutoryAction
            reads the stored IC + tax values and passes them through so its full-row overwrite can't wipe them. */}

        {/* Group 2 — EPF. Presented as its own visually-distinct information card (rounded border +
            heading + subtle surface) so the EPF election stands apart from the flat identity/SOCSO/bank
            sections — feedback 127dffba. Still inside the single setStatutoryAction form; presentation only.
            Kept at sm:grid-cols-2 because <EpfElection> renders an internal sm:col-span-2 rate row;
            leaving that island's grid assumptions untouched is the safe play. */}
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('epfContribTitle')}
          </legend>
          <p className="text-xs text-muted-foreground">{t('epfElectionHint')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('epfNumber')}>
              <input name="epfNumber" defaultValue={statutory?.epfNumber ?? ''} placeholder="123456789" className={inputCls} />
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
          {/* Item 0d9bb2da — "Employer bears EPF Contribution". Mirrors the employer-bears SOCSO/EIS/tax
              controls: when ticked, the EPF employee + employer legs are still computed + reported in full,
              but the employee's EPF share is funded from employer cost instead of being deducted from net. */}
          <label className="flex items-center gap-2 text-sm" title={t('employerBearsEpfHint')}>
            <input
              type="checkbox"
              name="employerBearsEpf"
              defaultChecked={statutory ? statutory.employerBearsEpf : false}
              className="size-4 rounded"
            />
            {t('employerBearsEpf')}
          </label>
        </fieldset>

        {/* Group 3 — dedicated SOCSO & EIS information card (item 5a461b99): the shared SOCSO & EIS
            registration number, the three "Subject to" eligibility flags, and the three "Employer bears"
            payroll controls. Its own bordered surface so the statutory-control decisions stand apart from the
            flat identity/bank sections. Still inside the single setStatutoryAction form (full-row overwrite),
            so every checkbox stays mounted. `nationality` is a hidden mirror of the profile value so the server
            action can default the number from IC for Malaysians. */}
        <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <legend className="-ml-1 rounded-md bg-card px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-foreground">
            {t('socsoEisCardTitle')}
          </legend>
          <input type="hidden" name="nationality" value={emp.nationality ?? ''} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('socsoEisNumber')}>
              <input
                name="socsoNumber"
                defaultValue={
                  defaultSocsoEisNumber({
                    socsoNumber: statutory?.socsoNumber,
                    icNumber: statutory?.icNumber,
                    nationality: emp.nationality,
                  }) ?? ''
                }
                className={inputCls}
              />
            </Field>
          </div>
          {/* Item a7271737 — SOCSO / EIS contribution CATEGORY selects. Consolidation (reporter-approved): the
              category is the single per-scheme control, replacing the old Subject-to-SOCSO / Subject-to-EIS
              checkboxes ('No contribution' = the scheme off). 'Auto' keeps the automatic PERKESO age/citizenship
              derivation. SKBBK stays its own switch (not part of the SOCSO category). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('socsoCategoryLabel')}>
              <select
                name="socsoCategory"
                defaultValue={statutory?.socsoCategory ?? 'auto'}
                title={t('socsoCategoryHint')}
                className={inputCls}
              >
                <option value="auto">{t('socsoCategoryAuto')}</option>
                <option value="first">{t('socsoCategoryFirst')}</option>
                <option value="second">{t('socsoCategorySecond')}</option>
                <option value="none">{t('socsoCategoryNone')}</option>
              </select>
            </Field>
            <Field label={t('eisCategoryLabel')}>
              <select
                name="eisCategory"
                defaultValue={statutory?.eisCategory ?? 'auto'}
                title={t('eisCategoryHint')}
                className={inputCls}
              >
                <option value="auto">{t('eisCategoryAuto')}</option>
                <option value="none">{t('eisCategoryNone')}</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('subjectToLegend')}</p>
              <label className="flex items-center gap-2 text-sm" title={t('subjectToSkbbkHint')}>
                <input type="checkbox" name="subjectToSkbbk" defaultChecked={statutory ? statutory.subjectToSkbbk : false} className="size-4 rounded" />
                {t('subjectToSkbbk')}
              </label>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" title={t('employerBearsHint')}>
                {t('employerBearsLegend')}
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="employerBearsSocso" defaultChecked={statutory ? statutory.employerBearsSocso : false} className="size-4 rounded" />
                {t('employerBearsSocso')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="employerBearsEis" defaultChecked={statutory ? statutory.employerBearsEis : false} className="size-4 rounded" />
                {t('employerBearsEis')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="employerBearsSkbbk" defaultChecked={statutory ? statutory.employerBearsSkbbk : false} className="size-4 rounded" />
                {t('employerBearsSkbbk')}
              </label>
            </div>
          </div>
        </fieldset>

        {/* Item ef720d3a — the salary-payment bank fields (formerly Group 4) have moved to their OWN dedicated
            Bank Information card (bankCard, rendered above on this tab) with a partial save (setBankAction).
            The bank name is now a pick-from-catalog select and the card adds a custom-payment-holder function.
            Because this statutory form is a full-row overwrite, the bank columns could not simply move into it —
            setStatutoryAction now reads the stored bankName/bankAccountNo and passes them through unchanged so
            relocating the UI can never wipe them (the four custom-holder columns are outside its write set). */}

        {/* Item a6a47698 — the TP3 / opening-balances fieldset (formerly Group 5) and the Zakat pointer
            have moved to the Payroll tab (tp3Card + zakatSummaryCard). They are payroll matters, not
            banking/statutory-registration matters. TP3 now saves through its own setTp3Action (partial
            update of only the four TP3 columns); this statutory form no longer carries them, and its
            full-row overwrite setStatutoryAction passes the stored TP3 + zakat values through unchanged
            so relocating the UI can never wipe them. */}
        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('saveStatutory')}</button>
        </div>
      </form>
    </Card>
  ) : null;

  // ── BANK INFORMATION (Bank & Statutory tab) ─────────────────────────────────
  // Item ef720d3a — the salary-payment bank fields were split out of the full-row statutory form into their
  // OWN dedicated card with a partial save (setBankAction, only the bank + custom-holder columns). The bank
  // name is now a pick-from-catalog select and the card adds the custom-payment-holder function (pay salary
  // to a third party's account). It's a client island (interactive reveal/require) rendered as JSX only, so
  // the RSC server/client boundary is respected.
  const bankCard = admin ? (
    <BankInfoCard
      action={setBankAction}
      employmentId={emp.employmentId}
      personId={emp.personId}
      defaults={{
        bankName: statutory?.bankName ?? null,
        bankAccountNo: statutory?.bankAccountNo ?? null,
        enableCustomHolderName: statutory?.enableCustomHolderName ?? false,
        customHolderName: statutory?.customHolderName ?? null,
        enableCustomHolderId: statutory?.enableCustomHolderId ?? false,
        customHolderId: statutory?.customHolderId ?? null,
      }}
    />
  ) : null;

  // ── IDENTIFICATION & TAX (Bank & Statutory tab) ─────────────────────────────
  // Item 8b5334db — the tax fields were split out of the full-row statutory form into their OWN dedicated card
  // with a partial save (setTaxAction, only the tax columns). IC is gone (relocated to Profile). The card adds
  // Income Tax Resident (resident / non-resident / REP / Knowledge Worker → drives the PCB method), a manual/auto
  // Children (PCB relief) control (auto surfaces a family-derived suggestion for HR to confirm — never silent),
  // and an Employer-bears-tax switch. It's a client island rendered as JSX only, so the RSC boundary is respected.
  // The eligible-child suggestion is derived here (server-side, read-only) from the already-loaded Family records.
  const identityTaxCard = admin ? (
    <IdentityTaxCard
      action={setTaxAction}
      employmentId={emp.employmentId}
      personId={emp.personId}
      derivedChildCount={eligibleChildReliefCount(dependents)}
      defaults={{
        taxNumber: statutory?.taxNumber ?? null,
        taxCategory: statutory?.taxCategory ?? 1,
        taxResidency: statutory?.taxResidency ?? 'resident',
        numChildren: statutory?.numChildren ?? 0,
        childReliefMode: statutory?.childReliefMode ?? 'manual',
        employerBearsTax: statutory?.employerBearsTax ?? false,
      }}
    />
  ) : null;

  // ── TP3 / OPENING BALANCES (Payroll tab) ────────────────────────────────────
  // Item a6a47698 — relocated off the Bank & Statutory card onto the Payroll tab. It is a payroll matter
  // (it seeds the PCB accumulators), not a banking/statutory-registration matter. Because the statutory
  // card is a single full-row-overwrite form, TP3 could not simply move into it — it gets its OWN small
  // form + setTp3Action, a partial update of only the four TP3 columns. All fields + saved data preserved.
  const tp3Card = admin ? (
    <Card id="section-tp3">
      <SectionHeader title={t('tp3SectionTitle')} />
      <form action={setTp3Action} className="flex flex-col gap-3 p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
        <input type="hidden" name="personId" value={emp.personId} />
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
        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('tp3Save')}</button>
        </div>
      </form>
    </Card>
  ) : null;

  // ── ZAKAT SUMMARY (Payroll tab, read-only) ──────────────────────────────────
  // Item a6a47698 — the zakat pointer paragraph moved off Bank & Statutory onto the Payroll tab as a
  // read-only summary of the current election (owned by Payroll → Transactions → Zakat since 58755260).
  // Editing stays SOLELY at that route — single source of truth, no second write path here.
  const zakatSummaryCard = admin ? (
    <Card id="section-zakat-summary">
      <SectionHeader title={t('zakatSummaryTitle')} />
      <div className="flex flex-col gap-4 p-4">
        <p className="text-xs text-muted-foreground">{t('zakatSummaryDescription')}</p>
        {statutory?.zakatActive ? (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakatSummaryStatus')}</dt>
              <dd><Badge variant="success">{t('zakatSummaryActive')}</Badge></dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakatSummaryState')}</dt>
              <dd className="font-medium text-foreground">{statutory.zakatState ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakatSummaryMethod')}</dt>
              <dd className="font-medium text-foreground">
                {statutory.zakatMethod === 'fixed' ? t('zakatSummaryMethodFixed') : t('zakatSummaryMethodPercent')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('zakatSummaryRate')}</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {statutory.zakatMethod === 'fixed'
                  ? `RM ${Number(statutory.zakatFixed ?? 0).toFixed(2)}`
                  : `${(Number(statutory.zakatPercent ?? 0) * 100).toFixed(2)}%`}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t('zakatSummaryInactive')}</p>
        )}
        <div>
          <Link
            href="/payroll/transactions/zakat"
            className="text-sm font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('zakatSummaryManageLink')}
          </Link>
        </div>
      </div>
    </Card>
  ) : null;

  // ── DOCUMENTS ──────────────────────────────────────────────────────────────
  // f018ce8d — redesigned into a real employee document store (upload / categorize / view / download /
  // edit / replace / delete, searchable grid + full audit). The old read-only statutory summary is gone;
  // those identifiers stay editable on the Bank & Statutory tab (unchanged source of truth). The section
  // component RLS-loads its own data + owns its server actions (see documents-section.tsx).
  const documentsPanel = admin ? <DocumentsSection s={s} employmentId={employmentId} /> : null;

  // ── JOB / CAREER MOVEMENT ───────────────────────────────────────────────────
  // Cards defined here feed two tabs: reporting lines + approval delegations stay on the Employment
  // ("job") tab, while assignmentHistoryCard and transferTerminateCards now render on the Career
  // Movement tab (feedback 5296d984). Location + default shift moved to Attendance (feedback 1fbe9891).
  // Assignment history is not admin-gated (visible to any viewer); transfer/terminate are admin actions.
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

  // Employment Information enhancement (2323f671) — the Employment tab's primary master-data card. Groups
  // Employment Dates / Organisation / Job / Reporting into ONE admin-gated <form> → setEmploymentInfoAction.
  // NEW fields (probation/notice periods, confirmation & resignation dates, org dimensions, category, +
  // editable Hire Date) are captured here.
  //
  // 594323a6 — the five organisation fields (Department, Position, Job Grade, Employment Type, Employee
  // Status) are now EDITABLE from this tab via a dedicated sibling <form> → setEmploymentAssignmentAction.
  // Department/Position/Employment Type/Employee Status are effective-dated (CLOSE+INSERT on `assignment`,
  // preserving history + an audited event); Job Grade routes to setEmploymentGrade (owns employment.gradeId).
  // Company stays read-only (moving companies is a distinct lifecycle event, not an inline edit). Two sibling
  // forms in one Card is intentional — HTML forms can't nest, so the assignment editor is its own <form>.
  const EMPLOYMENT_TYPE_OPTIONS: readonly string[] = ['full_time', 'part_time', 'contract', 'intern'];
  const ASSIGNMENT_STATUS_OPTIONS: readonly string[] = ['active', 'on_leave', 'probation', 'offboarding', 'terminated'];
  // 955c7de4 — period unit dropdown options for the redesigned Employment Dates card.
  const PERIOD_UNIT_OPTIONS: readonly string[] = ['month', 'week', 'day'];
  // Length-of-service reference figures (feedback 24c4d02e). Group service reads the Group Join Date (hiredOn);
  // current-company service reads the Join Date, falling back to the group date until a transfer sets it. Both
  // are read-only "XX Years XX Months" against today — display-only, they drive no entitlement.
  const fmtService = (from: string | null | undefined): string | null => {
    if (!from) return null;
    const s = serviceYearsMonthsAt(from, today);
    return t('employmentInfo.serviceLength', { years: s.years, months: s.months });
  };
  const groupServiceLabel = fmtService(emp.hiredOn);
  const currentServiceLabel = fmtService(emp.joinDate ?? emp.hiredOn);
  const employmentInfoCard = admin ? (
    <Card id="section-employment-info">
      <SectionHeader title={t('employmentInfo.title')} />
      {/* 594323a6 — editable organisation assignment. Effective-dated fields + Job Grade in one Save. */}
      <form action={setEmploymentAssignmentAction} className="space-y-3 border-b border-border p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('employmentInfo.assignmentGroup')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('employmentInfo.company')}>
            <input value={emp.company} disabled className={inputCls} aria-readonly="true" />
          </Field>
          <Field label={t('employmentInfo.department')}>
            <select name="departmentId" defaultValue={current?.departmentId ?? ''} className={inputCls}>
              <option value="">{t('employmentInfo.positionNone')}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('employmentInfo.position')}>
            <select name="positionId" defaultValue={current?.positionId ?? ''} className={inputCls}>
              <option value="">{t('employmentInfo.positionNone')}</option>
              {positions.map((pos) => (
                <option key={pos.id} value={pos.id}>
                  {pos.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('employmentInfo.jobGrade')}>
            <select name="gradeId" defaultValue={emp.gradeId ?? ''} className={inputCls}>
              <option value="">{t('employmentInfo.positionNone')}</option>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('employmentInfo.employmentType')}>
            <select name="employmentType" defaultValue={current?.employmentType ?? ''} className={inputCls}>
              {EMPLOYMENT_TYPE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {t(`employmentInfo.employmentType_${v}` as 'employmentInfo.employmentType_full_time')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('employmentInfo.employeeStatus')}>
            <select name="status" defaultValue={current?.status ?? ''} className={inputCls}>
              {ASSIGNMENT_STATUS_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {t(`employmentInfo.status_${v}` as 'employmentInfo.status_active')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('effectiveDate')}>
            <input name="effectiveDate" type="date" required defaultValue={today} className={inputCls} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{t('employmentInfo.assignmentNote')}</p>
        <div className="flex justify-end">
          <button className={btnPrimary}>{t('employmentInfo.saveAssignment')}</button>
        </div>
      </form>

      <form action={setEmploymentInfoAction} className="space-y-6 p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />

        {/* ── Employment Dates (redesigned 955c7de4) ── explicit period UNITS + full lifecycle dates, grouped
            into Joining / Probation / Notice / Resignation sub-sections. Each period is a value + unit dropdown
            (Month/Week/Day); the bare unlabelled month+day pairs are gone. Legacy month values are shown as a
            fallback default so existing data stays visible and migrates to value+unit on the next save. */}
        <fieldset className="space-y-5">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('employmentInfo.datesGroup')}
          </legend>

          {/* Joining (preserved from 24c4d02e): Group Join Date (hiredOn, relabelled) + current-company Join
              Date, each with a read-only Length of Service figure. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('employmentInfo.groupJoinDate')}>
              <input name="hiredOn" type="date" defaultValue={emp.hiredOn ?? ''} className={inputCls} />
              <p className="text-xs text-muted-foreground">
                {t('employmentInfo.groupService')}: {groupServiceLabel ?? '—'}
              </p>
            </Field>
            <Field label={t('employmentInfo.joinDate')}>
              <input name="joinDate" type="date" defaultValue={emp.joinDate ?? ''} className={inputCls} />
              <p className="text-xs text-muted-foreground">
                {t('employmentInfo.currentCompanyService')}: {currentServiceLabel ?? '—'}
              </p>
            </Field>
          </div>

          {/* Probation Information */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">{t('employmentInfo.probationGroup')}</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('employmentInfo.probationPeriod')}>
                <div className="flex gap-2">
                  <input name="probationValue" type="number" min={0} step={1} placeholder={t('employmentInfo.value')} defaultValue={emp.probationValue ?? emp.probationMonths ?? ''} className={inputCls} aria-label={t('employmentInfo.value')} />
                  <select name="probationUnit" defaultValue={emp.probationUnit ?? 'month'} className={inputCls} aria-label={t('employmentInfo.unit')}>
                    {PERIOD_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>{t(`employmentInfo.unit_${u}` as 'employmentInfo.unit_month')}</option>
                    ))}
                  </select>
                </div>
              </Field>
              <Field label={t('employmentInfo.extendedProbationPeriod')}>
                <div className="flex gap-2">
                  <input name="extendedProbationValue" type="number" min={0} step={1} placeholder={t('employmentInfo.value')} defaultValue={emp.extendedProbationValue ?? ''} className={inputCls} aria-label={t('employmentInfo.value')} />
                  <select name="extendedProbationUnit" defaultValue={emp.extendedProbationUnit ?? 'month'} className={inputCls} aria-label={t('employmentInfo.unit')}>
                    {PERIOD_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>{t(`employmentInfo.unit_${u}` as 'employmentInfo.unit_month')}</option>
                    ))}
                  </select>
                </div>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('employmentInfo.confirmationDate')}>
                <input name="confirmationDate" type="date" defaultValue={emp.confirmationDate ?? ''} className={inputCls} />
              </Field>
              <Field label={t('employmentInfo.extendedConfirmationDate')}>
                <input name="extendedConfirmationDate" type="date" defaultValue={emp.extendedConfirmationDate ?? ''} className={inputCls} />
              </Field>
              <Field label={t('employmentInfo.finalConfirmationDate')}>
                {/* Derived (= extended ?? normal), recomputed + audited on save; read-only, not submitted. */}
                <input type="date" disabled value={emp.finalConfirmationDate ?? emp.extendedConfirmationDate ?? emp.confirmationDate ?? ''} className={inputCls} aria-label={t('employmentInfo.finalConfirmationDate')} />
                <p className="text-xs text-muted-foreground">{t('employmentInfo.finalConfirmationNote')}</p>
              </Field>
            </div>
          </div>

          {/* Notice Period Information */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">{t('employmentInfo.noticeGroup')}</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('employmentInfo.noticeBeforeConfirmation')}>
                <div className="flex gap-2">
                  <input name="noticeBeforeConfirmationValue" type="number" min={0} step={1} placeholder={t('employmentInfo.value')} defaultValue={emp.noticeBeforeConfirmationValue ?? emp.resignationNoticeMonths ?? ''} className={inputCls} aria-label={t('employmentInfo.value')} />
                  <select name="noticeBeforeConfirmationUnit" defaultValue={emp.noticeBeforeConfirmationUnit ?? 'month'} className={inputCls} aria-label={t('employmentInfo.unit')}>
                    {PERIOD_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>{t(`employmentInfo.unit_${u}` as 'employmentInfo.unit_month')}</option>
                    ))}
                  </select>
                </div>
              </Field>
              <Field label={t('employmentInfo.noticeAfterConfirmation')}>
                <div className="flex gap-2">
                  <input name="noticeAfterConfirmationValue" type="number" min={0} step={1} placeholder={t('employmentInfo.value')} defaultValue={emp.noticeAfterConfirmationValue ?? emp.shortNoticeMonths ?? ''} className={inputCls} aria-label={t('employmentInfo.value')} />
                  <select name="noticeAfterConfirmationUnit" defaultValue={emp.noticeAfterConfirmationUnit ?? 'month'} className={inputCls} aria-label={t('employmentInfo.unit')}>
                    {PERIOD_UNIT_OPTIONS.map((u) => (
                      <option key={u} value={u}>{t(`employmentInfo.unit_${u}` as 'employmentInfo.unit_month')}</option>
                    ))}
                  </select>
                </div>
              </Field>
            </div>
          </div>

          {/* Resignation Information */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-foreground">{t('employmentInfo.resignationGroup')}</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('employmentInfo.tenderResignationDate')}>
                <input name="tenderResignationDate" type="date" defaultValue={emp.tenderResignationDate ?? ''} className={inputCls} />
              </Field>
              <Field label={t('employmentInfo.resignationDate')}>
                <input name="resignationDate" type="date" defaultValue={emp.resignationDate ?? ''} className={inputCls} />
              </Field>
              <Field label={t('employmentInfo.lastWorkingDate')}>
                <input name="lastWorkingDate" type="date" defaultValue={emp.lastWorkingDate ?? ''} className={inputCls} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">{t('employmentInfo.lifecycleDeferredNote')}</p>
          </div>
        </fieldset>

        {/* ── Organisation ── */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('employmentInfo.orgGroup')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label={t('employmentInfo.branch')}>
              <input name="orgBranch" defaultValue={emp.orgBranch ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.division')}>
              <input name="orgDivision" defaultValue={emp.orgDivision ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.region')}>
              <input name="orgRegion" defaultValue={emp.orgRegion ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.line')}>
              <input name="orgLine" defaultValue={emp.orgLine ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.section')}>
              <input name="orgSection" defaultValue={emp.orgSection ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.team')}>
              <input name="orgTeam" defaultValue={emp.orgTeam ?? ''} className={inputCls} />
            </Field>
            <Field label={t('employmentInfo.base')}>
              <input name="orgBase" defaultValue={emp.orgBase ?? ''} className={inputCls} />
            </Field>
          </div>
        </fieldset>

        {/* ── Job ── (Position / Grade / Type / Status read-only above; Category is new master data) */}
        <fieldset className="space-y-3">
          <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('employmentInfo.jobGroup')}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label={t('employmentInfo.category')}>
              <input name="employmentCategory" defaultValue={emp.employmentCategory ?? ''} className={inputCls} />
            </Field>
          </div>
        </fieldset>

        <p className="text-xs text-muted-foreground">{t('employmentInfo.superiorNote')}</p>
        <div className="flex justify-end">
          <button className={btnPrimary}>{t('employmentInfo.save')}</button>
        </div>
      </form>
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
                {r.status === 'approved' && r.hasRejectedDates ? (
                  <LeaveStatus status="partial" label={t('leaveStatus.partiallyApproved')} />
                ) : (
                  <LeaveStatus status={r.status} label={t(`leaveStatus.${r.status}`)} />
                )}
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
        {employmentInfoCard}
        {reportingLinesCard}
        {delegationsCard}
      </>
    ),
    // Career Movement (feedback 5296d984): the employment-lifecycle cards relocated WHOLE out of the
    // Employment tab. assignmentHistoryCard (position/department history) and transferTerminateCards —
    // which already bundles BOTH the Transfer (Effective-Dated) form and the Terminate form — move here
    // unchanged. The const definitions (assignmentHistoryCard / transferTerminateCards, still defined in
    // the "── JOB ──" section) are untouched: only their render location moved, so transferAction /
    // terminateAction keep their existing effective-date rules and DomainEvents and no data is affected.
    // Order mirrors the lifecycle: past movements (history) first, then the actions that create the next.
    careerMovement: (
      <>
        {assignmentHistoryCard}
        {transferTerminateCards}
      </>
    ),
    // Attendance Information (feedback 1fbe9891): the four attendance-related section cards relocated
    // WHOLE from Employment (locationCard, defaultShiftCard) and Others (clockingCard) into one tab.
    // The const definitions (setLocationAction / setDefaultShiftAction / setEmployeeClockingLocationsAction
    // + setGeofencingAction) are untouched — only their render location moved, so the full-row-overwrite
    // <form>s and every mounted input stay byte-identical and no server logic or event emission changed.
    // Order mirrors an attendance setup flow: Work Location → Shift Arrangement → Clocking & Geofencing.
    attendance: (
      <>
        {locationCard}
        {defaultShiftCard}
        {clockingCard}
      </>
    ),
    // Bank & Statutory (feedback 40ef71a0): the Statutory (Malaysia) card — the single
    // <form action={setStatutoryAction}> that already co-locates the salary-payment bank fields
    // (Group 4) alongside EPF/SOCSO/EIS/PCB — relocated WHOLE out of Payroll into its own tab. The
    // const definition (statutoryCard) is unchanged; only its render location moved, so the
    // full-row-overwrite form and every mounted input stay byte-identical and no server logic changed.
    // Item ef720d3a — the dedicated Bank Information card (bankCard) is pinned FIRST on this tab, above the
    // statutory registration/EPF/SOCSO card. Bank details are the most-referenced payment attribute, and the
    // card is visually separated with its own save (setBankAction), per the redesign request.
    bankStatutory: (
      <>
        {bankCard}
        {/* Item 8b5334db — dedicated Identification & Tax card (tax fields split out of the statutory card, its
            own partial save setTaxAction). Sits between Bank and the EPF/SOCSO statutory registration card. */}
        {identityTaxCard}
        {statutoryCard}
      </>
    ),
    // Payroll tab keeps pay components, CP38, encashment, policy assignment and compensation. The
    // statutory/bank card previously pinned to the top (feedback 7524eda1) now lives on Bank & Statutory.
    // compensationCard (Basic Salary / salary history) is pinned FIRST (feedback 326f0b5e): Basic Salary
    // is the most-referenced payroll attribute, so it opens at the top with no scrolling. Pure JSX order
    // change — every card's definition and behaviour is unchanged.
    // Item a6a47698 — TP3 / opening balances and the Zakat summary relocated here from Bank & Statutory so
    // all payroll-related employee information is centralized on this tab. tp3Card has its own partial save
    // (setTp3Action); zakatSummaryCard is read-only and links to Payroll → Transactions → Zakat to edit.
    payroll: (
      <>
        {compensationCard}
        {payComponentsCard}
        {cp38Card}
        {encashmentCard}
        {tp3Card}
        {zakatSummaryCard}
        {payrollPolicyCard}
      </>
    ),
    // Leave Information (feedback d085c6fc): the Leave Balance card — including its entitlement
    // breakdown drill-down — relocated out of Payroll into a dedicated leave-management tab. Same
    // card, same data (loaded once for the page), just a different tab; no leave/payroll logic moved.
    leave: leaveBalanceCard,
    documents: documentsPanel,
    others: (
      <>
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

      {/* b4682879 — modern profile header: photo (or initials fallback) + key employment info. Admin-only
          upload / replace / remove controls sit under the photo. The photo renders wherever can_see_person
          allows (RLS on the serve route). */}
      <Card className="p-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="flex flex-col items-center gap-3">
            {photoExists ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/personnel/photo/${emp.personId}`}
                alt={emp.name}
                className="size-24 shrink-0 rounded-full object-cover ring-1 ring-border"
              />
            ) : (
              <Avatar name={emp.name} className="size-24 text-2xl" />
            )}
            {admin && (
              // dc23d3b6 — photo controls are now hidden behind a pencil/Edit trigger (PhotoEditMenu, a
              // 'use client' island). The page still BUILDS both forms here (server actions bound as
              // before) and passes them in as children; the island only toggles their visibility, so the
              // RSC boundary is respected. Replacing an EXISTING photo now prompts via ConfirmSubmit;
              // first-time Upload (no photo) submits directly. Removing already confirmed — unchanged.
              <PhotoEditMenu label={t('photoEdit')} hint={t('photoHint')}>
                <form action={setPersonPhotoAction} className="flex w-full flex-col items-stretch gap-1.5">
                  <input type="hidden" name="employmentId" value={emp.employmentId} />
                  <input type="hidden" name="personId" value={emp.personId} />
                  <input
                    type="file"
                    name="photo"
                    accept="image/png,image/jpeg"
                    required
                    className="w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-accent file:px-2 file:py-1 file:text-xs file:text-foreground"
                  />
                  {photoExists ? (
                    <ConfirmSubmit
                      title={t('photoReplace')}
                      description={t('photoReplaceConfirm')}
                      confirmLabel={t('photoReplace')}
                      variant="default"
                      size="sm"
                      className="w-full"
                    >
                      {t('photoReplace')}
                    </ConfirmSubmit>
                  ) : (
                    <button className={`${btnPrimary} h-7 px-2 text-xs`}>{t('photoUpload')}</button>
                  )}
                </form>
                {photoExists && (
                  <form action={removePersonPhotoAction} className="w-full">
                    <input type="hidden" name="employmentId" value={emp.employmentId} />
                    <input type="hidden" name="personId" value={emp.personId} />
                    <ConfirmSubmit
                      title={t('photoRemove')}
                      description={t('photoRemoveConfirm')}
                      confirmLabel={t('photoRemove')}
                      size="sm"
                      className="w-full"
                    >
                      {t('photoRemove')}
                    </ConfirmSubmit>
                  </form>
                )}
              </PhotoEditMenu>
            )}
          </div>
          <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t('employeeIdLabel')}</dt>
              <dd className="font-medium text-foreground">{emp.employeeCode ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerStatus')}</dt>
              <dd>
                <StatusBadge status={emp.terminatedOn ? 'terminated' : (current?.status ?? null)} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerDepartment')}</dt>
              <dd className="font-medium text-foreground">{current?.department ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerPosition')}</dt>
              <dd className="font-medium text-foreground">{current?.position ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerCompany')}</dt>
              <dd className="font-medium text-foreground">{emp.company}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerJoinDate')}</dt>
              <dd className="font-medium text-foreground">{emp.hiredOn}</dd>
            </div>
          </dl>
        </div>
      </Card>

      <ErrorBanner message={error} />

      <PersonnelTabs
        tabs={tabs}
        panels={panels}
        emptyLabel={t('tabs.empty')}
        defaultTab={tab as PersonnelTabKey | undefined}
      />
    </div>
  );
}
