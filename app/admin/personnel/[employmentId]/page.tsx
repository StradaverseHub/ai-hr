import Link from 'next/link';
import {HolidayCalendarAssignments} from './holiday-calendar-assignments';
import {employmentHolidayCalendarHistory,holidayCalendarInclusiveEnd} from '@/core/holiday-calendar-assignment';
import { notFound, redirect } from 'next/navigation';
import { RETIRED_PERSONNEL_TABS } from '@/lib/personnel-tab-sections';
import { getTranslations } from 'next-intl/server';
import { isAdmin } from '@/lib/authz';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
// c002b3c3 — `scopedAdmin` is `requireAdmin` PLUS the active company context. Same admin gate as before
// (it redirects non-admins identically); the scope ids are what the Search Employee box is narrowed to.
import { scopedAdmin } from '@/lib/scope';
import {
  adminCompanies,
  assignmentHistory,
  delegationsFor,
  directSuperiorHistoryFor,
  employeeAudit,
  employeeDetail,
  employmentCompanyEditable,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  listJobGrades,
  reportingLinesFor,
} from '@/core/read';
import { PersonnelField } from '@/components/personnel-field';
import { personnelControl, personnelInput, personnelFormName, personnelFormLabel, personnelFormChoices, personnelDisplay, personnelCarry, personnelPresence, personnelRadio, personnelWorkflowCarry } from '@/lib/personnel-form-contract';
import { Avatar, Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { LocationAssignment } from '@/components/attendance/location-assignment';
import { hasPersonPhoto } from '@/core/person-photo';
import { PhotoLightbox } from './photo-lightbox';
// 4da751c6 — the DERIVED Benefit Scheme readout. Stores nothing; asks the entitlement engine what it
// already decided. See core/entitlement-scheme-view.ts for why there is no table behind it.
import { benefitSchemeView } from '@/core/entitlement-scheme-view';
// 6aee1d91 fix pass (m3) — the card's two links to the Leave types screen resolve through the module's one
// list of addresses, so a link whose job is "go and change the schemes" cannot disagree with the menu.
import { leaveConfigScreenHref } from '@/components/leave-config-map';
import { AuditTable } from '@/components/audit-table';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { DateField } from '@/components/ui/date-field';
import { formatDmy, formatDmyTime } from '@/lib/date-display';
import { IdentityFields, IdentityProvider, NationalityField } from '@/components/personnel-identity';
// 35b7af0a group 1 — the Gender + Marital Status field group, shared with the Create New Employee wizard.
import { PersonDetailsFields } from '@/components/person-details-fields';
// 35b7af0a group 3 — the Date of Birth + read-only Age field group, shared with the same wizard.
import { BirthDateFields } from '@/components/birth-date-fields';
// 35b7af0a group 4 — the EPF Number + EPF Citizenship field group, shared with the same wizard.
import { EpfRegistrationFields } from '@/components/epf-registration-fields';
// Direct Superior (dce55aff): the searchable employee picker reuses the shared Combobox — its label
// carries "EMP-0008 – John Tan" so type-ahead matches Employee ID and name alike.
import { Combobox } from '@/components/ui/combobox';
import { EpfElection } from '@/components/epf-election';
import { BankInfoCard } from '@/components/bank-info-card';
import { IdentityTaxCard } from '@/components/identity-tax-card';
import { SocsoEisFields } from '@/components/socso-eis-fields';
// a72610af — the field groups this screen now SHARES with the Create New Employee draft, so a draft and
// the record it becomes ask the same questions in the same words. Each has a `mode`; this screen is 'form'.
import { PersonNameFields, PersonContactExtraFields } from '@/components/person-name-fields';
import { ConfirmationDateField, EmploymentPeriodField } from '@/components/employment-period-fields';
import { EmployerBearsSwitch } from '@/components/employer-bears-fields';
import { HrdfSubjectField } from '@/components/tax-relief-fields';
import { SameAsPermanentAddress } from '@/components/same-as-permanent-address';
// da7463b4 — the seven-field address block, shared with the Create New Employee draft.
import { AddressBlockFields } from '@/components/address-fields';
import {
  addDelegationAction,
  endDelegationAction,
  setCompensationAction,
  setDirectSuperiorAction,
  setComplianceFieldsAction,
  setContactAddressAction,
  changeEmploymentCompanyAction,
  setPaymentMethodAction,
  setEmploymentComponentAction,
  setEmploymentInfoAction,
  setEmploymentScheduleGroupAction,
  setPersonAction,
  setPersonPhotoAction,
  // 420ebab5 part two — the Profile tab's consolidated Save. Calls the SAME per-section services, in order.
  saveProfileTabAction,
  saveBankStatutoryTabAction,
  saveAttendanceTabAction,
  saveCardIdFieldAction,
  saveJobTabAction,
  savePayrollTabAction,
  removePersonPhotoAction,
  setStatutoryAction,
  setTp3Action,
  setBankAction,
  setIcAction,
  setPassportAction,
  setTaxAction,
  setOthersStatutoryAction,
  // 66a63bd6 — Employment History Delete (Rollback); Edit posts from the movement form island itself.
  reverseMovementEventAction,
} from './actions';
// Movement tab redesign (78853b97): Employment History projection + New Event dispatcher.
import {
  movementHistory,
  movementDetail,
  movementCurrentState,
  INTERCHANGEABLE_COMPARISON_KINDS,
  isComparisonKind,
  MOVEMENT_FLAT_FIELDS,
} from '@/core/movement';
// 95d17761 — the DEFAULT Employment History view drops the correction artefacts. A pure view filter, so
// it lives beside the screen and never touches the ledger projection above.
import { partitionMovementRows } from '@/lib/movement-visibility';
// e6a144d4 — the Employment History event-type caption, shared with the Download Excel route so the file
// and the screen cannot print different names for the same event.
import { movementKindLabel as movementKindLabelOf } from '@/lib/movement-kind-label';
// ae9350f2 — the built-in exit-reason catalogue behind the Termination movement.
import { TERMINATION_REASONS } from '@/core/termination-reason';
// 476f23ed — the tenant's configurable movement event-type catalogue.
import { listMovementEventTypes } from '@/core/movement-type';
import { MovementNewEvent } from './movement-new-event';
// c063eea9 — "Correct hire details" on the Hired row: the read behind the form, and its client island.
import { HireCorrectionError, hireCorrectionView, type HireCorrectionField } from '@/core/hire-correction';
import { HireCorrectionForm, type HireCorrectionFormField } from './hire-correction-form';
import { serviceYearsMonthsDaysAt } from '@/core/leave';
// 9d13221c — the Age figure beside Date of Birth no longer needs an import here at all: 35b7af0a group 3
// moved both the derivation and the two Fields into components/birth-date-fields.tsx, which reads the same
// counter from the client-safe lib/completed-years.ts so the wizard can render it too.
import { deriveEmploymentStatus } from '@/core/employment-status';
import {
  closedPayrollPeriodsFor,
  compensationHistoryDetailed,
  overlapsClosedPeriod,
  type CompensationHistoryRow,
} from '@/core/comp';
import { SalaryRevisionConfirm } from '@/components/salary-revision-confirm';
import { SalaryHistoryTable, type SalaryRowView } from '@/components/salary-history-table';
import { PayStructureFields, type PayModeOption } from '@/components/pay-structure-fields';
import { PERSONNEL_PAY_MODES, PERSONNEL_PAYMENT_TERMS } from '@/lib/personnel-choice-vocabulary';
// 297ae65a — searchable ISO 4217 Currency select for the Basic Salary form + the company default it preselects.
import { CurrencySelect } from '@/components/currency-select';
import { getCompanyCurrency } from '@/core/read';
import { listCp38 } from '@/core/cp38';
import { addCp38Action, editCp38Action, terminateCp38Action } from './cp38-actions';
import { listDependents, qualifyingChildReliefFor, childAgeYears, isChildReliefEligible, DEPENDENT_GENDERS, DEPENDENT_MARRIAGE_STATUSES, DEPENDENT_RELATIONSHIPS, CHILD_RELIEF_CATEGORIES, type DependentRow } from '@/core/dependents';
import { addDependentAction, editDependentAction, archiveDependentAction } from './dependent-actions';
// Feedback a949184a — Qualification tab: per-employment academic/professional qualification register.
import { listQualifications, type QualificationRow } from '@/core/qualifications';
import { addQualificationAction, editQualificationAction, archiveQualificationAction } from './qualification-actions';
// Feedback 23ad620e — Emergency Contact register: a person may have several contacts, not one.
import { EMERGENCY_CONTACT_PRIORITIES, listEmergencyContacts, type EmergencyContactRow } from '@/core/emergency-contacts';
import { addEmergencyContactAction, editEmergencyContactAction, deleteEmergencyContactAction } from './emergency-contact-actions';
import { FamilyFormDialog } from '@/components/family-form-dialog';
import { FamilyRelationshipFields } from '@/components/family-relationship-fields';
import { listAssignablePolicies } from '@/core/payroll-policy';
// r393 (685d2380 step 2) — Payment Method and Payroll Policy are shared field groups now, rendered here in
// form mode and on the draft employee's Payroll tab in controlled mode.
import { PaymentMethodField } from '@/components/payment-method-field';
import { PayrollPolicyField } from '@/components/payroll-policy-field';
import { assignPolicyAction } from '@/app/admin/payroll-policy/actions';
import { employmentScheduleGroupId, listShiftsForTenant } from '@/core/roster';
// 18504ca6 — the dated Shift arrangement ladder behind the card's new Effective date + Shift history list.
import { EmployeeShiftFields } from '@/components/employee-shift-fields';
import { listHolidayGroups, listPositions, listBusinessUnits, listCostCenters } from '@/core/admin';
import { listLocations } from '@/core/location';
// f513ec02 adds listAttendanceRules — the Schedule Group picker's options. The tenant's attendance_rule
// library IS the Schedule Group library (870b79e2); there is no second table behind the name. Taken from
// the PACK FACADE, not core/attendance-rule: the ADR-0080 D9 ratchet (test/attendance-pack-drift.test.ts)
// refuses a new direct importer of the attendance implementation, and the allowlist only ever shrinks.
import { getScheduleRotation,listAttendanceRules, listClockingLocations, listEmployeeClockingLocations } from '@/packs/attendance/service';
import { setClockingControlAction } from './actions';
import { ReviewSection } from './review-section';
import { DocumentsSection } from './documents-section';
import { PersonnelTabs, type PersonnelTabKey } from '@/components/personnel-tabs';
// 420ebab5 part two — the Profile tab's one Save/Discard, and the consolidated action behind it.
import { TabSaveScope } from '@/components/tab-save-scope';
// c002b3c3 — the Personnel module's Search Employee switcher (shared with the listing).
import { EmployeeSwitcher } from '../employee-switcher';
// Rung 5c (ADR-0080 D1) — statutory profile reads, the SOCSO/EIS default and the state pick-list all
// resolve through the pack registry; this generic personnel screen no longer imports localization/my.
// (Feedback 0df0c635 — the Others Statutory card also reads the company HRDF band via the pack.)
import { countryPacks, packFor } from '@/localization/registry';
import { listAllProfileOptions } from '@/core/profile-options';
import { ProfileOptionSelect } from '@/components/profile-option-select';
import { PhotoEditMenu } from '@/components/photo-edit-menu';
import { listEmploymentPayComponents, listPayComponents } from '@/core/pay-components';
import { encashmentSnapshotForEmployment } from '@/core/leave-encashment';
import { unfreezeEncashmentAction, adjustEncashmentAction } from './encashment-actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

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
    // Movement tab redesign (78853b97): `movement=<domainEventId|hired>` opens the detail view;
    // `newEvent=1` opens the New Event form. Both render inside the careerMovement panel.
    movement?: string;
    newEvent?: string;
    // 66a63bd6: `editMovement=<domainEventId>` reopens that movement for correction (same comparison form).
    editMovement?: string;
    // c063eea9: `correctHire=1` opens the Correct hire details form for the Hired row.
    correctHire?: string;
    // 95d17761: `showCorrected=1` puts the correction artefacts (reversed / corrected / cancelled /
    // superseded rows) back on the Employment History list. Absent — the default — they are hidden
    // behind a one-line count. A VIEW filter only: movementHistory still returns every row and the
    // detail view (?movement=<id>) still resolves a hidden one by id.
    showCorrected?: string;
    // R46 47146ea3 — Children (PCB Relief) auto-sync feedback. `childReliefSynced` = the count moved
    // quietly (to this value); `childReliefAlert` = it moved while a payroll batch for that 'YYYY-MM'
    // period was still open, which is the case HR must actually see (rail (d): alert, never block).
    childReliefSynced?: string;
    childReliefAlert?: string;
    childReliefTo?: string;
    // Company change before any transaction (9464bd56): `companyChange=<companyId>` is phase 1's PENDING
    // destination — it re-scopes the Organisation Assignment dropdowns to that company and shows a banner.
    // Nothing is committed until phase 2's Save (changeEmploymentCompanyAction).
    companyChange?: string;
    incentiveError?: string;
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin(); // Admin-only management surface (People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.detail');
  const tPersonnel=await getTranslations();
  const personnelLabel=(id:string)=>personnelFormLabel(id,(key,fallback)=>tPersonnel.has(key)?tPersonnel(key):fallback);
  // 2f889bae — the Pay items row link reuses Fixed Transactions' OWN labels rather than minting
  // `people.detail` copies, so the two surfaces can never drift into calling the same destination two
  // different things. Both keys already exist and are translated in all six catalogues.
  const tFixed = await getTranslations('payroll.transactions.fixed');
  const tp = await getTranslations('payrollPolicy');
  const tc = await getTranslations('people.detail.clocking');
  // 44bc1c33 — the Card ID field reuses the Attendance namespace's strings rather than minting a second
  // wording for one field that appears on two screens.
  const ta = await getTranslations('attendance');
  const tStatus = await getTranslations('people.employeeStatus');
  // 31e39d74 — the leave-balance card captions a not-yet-generated entitlement with the SAME words the two
  // balance grids use, rather than a third phrasing of the same fact.
  const admin = isAdmin(s);
  /**
   * r298 (board ceb1c560) — DOES THIS TENANT HOLD PAYROLL? Asked ONCE, here, and every Payroll-owned
   * section below is gated on it at its READ, not only at its render: Pay Items (core/pay-components.ts),
   * CP38 (core/cp38.ts) and the Payroll Policy picker (core/payroll-policy.ts). Personnel is a CORE screen;
   * those three are the Payroll pack's (packs/payroll/index.ts), and the unconditional reads were what
   * core/module-gate.ts names as stopping pay-components and cp38 from being bound at the service.
   *
   * Tenant-wide, with no companyId, for the reason core/module-gate.ts's COMPANY SCOPE paragraph gives —
   * the rail, the route guard and the service gate all ask tenant-wide. The QUIET form, because what to
   * draw is a display decision (core/entitlements.ts, isModuleEnabledOrFalse).
   *
   * Everything else on the Payroll tab stays: Basic Salary and Payment Method are core/comp.ts (spine),
   * TP3 and the zakat summary read the country statutory profile, and leave encashment is Leave's.
   */
  const payrollOn = isModuleEnabledOrFalse(s, 'payroll');
  const { employmentId } = await params;
  // 95d17761 — kept whole (not just destructured) so the Show / Hide link under Employment History can
  // rebuild the CURRENT query string and preserve every param it does not own, rather than dropping the
  // reader back onto a bare tab.
  const rawSearchParams = await searchParams;
  const retiredDestination = rawSearchParams.tab === 'others' ? RETIRED_PERSONNEL_TABS.others : undefined;
  if (retiredDestination) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rawSearchParams)) if (value != null) query.set(key, value);
    query.set('tab', retiredDestination);
    redirect(`/admin/personnel/${encodeURIComponent(employmentId)}?${query}`);
  }
  const {
    error,
    from,
    cp38Error,
    asOf: spAsOf,
    encashmentError,
    tab,
    movement: spMovement,
    newEvent: spNewEvent,
    editMovement: spEditMovement,
    correctHire: spCorrectHire,
    childReliefSynced,
    childReliefAlert,
    childReliefTo,
    companyChange,
    incentiveError,
    showCorrected: spShowCorrected,
  } = rawSearchParams;
  // Context-aware back link: came from the org chart (?from=org) → return there; otherwise the admin
  // list. Keeps the `from` param flowing through so nested navigation stays consistent.
  // 4ea70bb7 — `backToPersonnelAdmin`, NOT `backToPeople`. people.detail is a SHARED namespace: the
  // employee-facing profile (app/personnel/[employmentId]/page.tsx) renders backToPeople for its own link
  // to /personnel, the directory that is still called Personnel. Renaming that key in place would have
  // renamed a screen this item never mentioned — the same trap as people.list.title. This link lands on
  // /admin/personnel, so it has to carry that module's name: a back link labelled "People" arriving at a
  // page headed "Personnel Management" is the inconsistency the item exists to remove.
  const back =
    from === 'org'
      ? { href: '/org', label: t('backToOrg') }
      : { href: '/admin/personnel', label: t('backToPersonnelAdmin') };

  // c002b3c3 — reproduced while asserting the scope guard, and PRE-EXISTING (unchanged from main): a
  // route segment that is not a uuid reached the query verbatim, so `/admin/personnel/not-a-uuid` came
  // back as a Postgres `invalid input syntax for type uuid` and a 500 error screen, where every other
  // unreachable id gives a 404. The shape check is not the access control — `employeeDetail` still is,
  // and it is what refuses a well-formed id belonging to a company outside the session's scope. This
  // only stops a malformed id from becoming a crash instead of the "no such employee" it means. Worth
  // fixing here because this item puts a control on the page whose whole job is to hand this route ids.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(employmentId)) notFound();

  const emp = await employeeDetail(s, employmentId);
  if (!emp) notFound();
  const today = todayInKualaLumpur();
  // Employee Status redesign (R43 c26c3ce5): Employee Status is SYSTEM-DERIVED read-time from the employment
  // lifecycle dates (+ the manual Blacklist override) — never a stored manual field. Computed once here and
  // rendered as a read-only badge everywhere the current status is shown.
  const derivedStatus = deriveEmploymentStatus(emp, today);
  const derivedStatusLabel = tStatus(derivedStatus);
  // b4682879 — does this employee have a profile photo the viewer may see? (existence only; never the blob).
  const photoExists = await hasPersonPhoto(s, emp.personId);

  // Company change before any transaction (9464bd56) — admin-only inline correction of a mis-picked Company
  // while the employee has NO operational activity. `companyEditable` is the pre-transaction gate; when it is
  // false the Company field stays locked and points HR to Movement / Transfer. Phase 1 lets HR pick a
  // destination (companyChange param) which re-scopes the org dropdowns + shows a banner (nothing committed);
  // phase 2 Saves via changeEmploymentCompanyAction.
  const companyEditable = admin ? await employmentCompanyEditable(s, employmentId) : false;
  // Destinations HR may pick = companies they administer (the writer requires is_admin_for(destination), so
  // offering only these keeps offered == acceptable). Only fetched when the field is actually editable.
  const managedCompanies = companyEditable ? await adminCompanies(s) : [];
  // The PENDING destination: editable, admin-managed, and different from the current company. Null otherwise.
  const pendingCompany =
    companyEditable && companyChange && companyChange !== emp.companyId
      ? (managedCompanies.find((c) => c.id === companyChange) ?? null)
      : null;
  // The org-assignment dropdowns scope to the PENDING company when one is chosen, else the current company.
  const orgScopeCompanyId = pendingCompany?.id ?? emp.companyId;

  const [history, requests, departments, reporting, employees, grades, delegations] = await Promise.all([
    assignmentHistory(s, employmentId),
    leaveRequestsFor(s, employmentId),
    // 570e3311 — departments scoped to THIS employee's company (origin ∪ shared-in ∪ global via the
    // System Labels resolver), matching the Position/BU/Location pickers. Feeds exactly two places:
    // the Organisation Assignment department select and the MovementNewEvent departments prop.
    listDepartments(s, { companyIds: [emp.companyId] }),
    reportingLinesFor(s, employmentId),
    listEmployees(s),
    listJobGrades(s),
    delegationsFor(s, employmentId),
  ]);
  // The retained Benefit Scheme readout keeps its dated source; balances are read in Leave Inquiry.
  const schemeAsOf = spAsOf && /^\d{4}-\d{2}-\d{2}$/.test(spAsOf) ? spAsOf : today;
  const scheme = admin ? await benefitSchemeView(s, employmentId, schemeAsOf) : null;
  // Pay + statutory (salary, IC, bank, tax) are HR-admin-only on this directory page — never load or
  // render them for a manager viewing a direct report (consultant feedback #5). Compensation reads are
  // also tightened to admin-or-self at the RLS layer (migration 0060); this avoids fetching them at all.
  const salaryHistory = admin ? await compensationHistoryDetailed(s, employmentId) : [];
  // 7c7c2f80 — periods of CLOSED payroll runs that paid this employee: drives the per-row "deletable"
  // flag on the salary history (records a closed run relied on are payroll evidence and cannot go).
  const closedPayrollPeriods = admin ? await closedPayrollPeriodsFor(s, employmentId) : [];
  // Rung 5c — the acting company's country pack; statutory reads + the SOCSO/EIS default resolve through it.
  const countryPack = packFor('MY');
  // This scoped service verifies the owning company is MY; a person-level tax flag is not approval.
  const taxSelection = admin && payrollOn
    ? await countryPack?.statutory.getTaxSelection?.(s, emp.employmentId) ?? null : null;
  // Rung 5c — the holiday-calendar state pick-list comes from the country packs via the registry
  // (union-read, the rung-5a `countryPacks()` precedent). MY-only ⇒ byte-identical to the old MY_STATES.
  const stateOptions = countryPacks().flatMap((p) => p.states);
  const statutory = admin ? ((await countryPack?.statutory.get(s, emp.personId)) ?? null) : null;
  // 04b88724 — the QUALIFYING-CHILDREN figure and its working. `num_children` (the head count Form E, CP8D
  // and the EA statement read) and C (what the projection of P counts in) are two different numbers, and the
  // card used to show one of them under a caption that implied both. This resolves the ruleset and returns
  // the pack's own prices plus the Family register's child rows; the card multiplies those prices by the
  // counts on screen so the figure stays true while the admin types. null ⇒ no pack / no PCB reliefs, and
  // the card then names no figure rather than inventing a rate. 'MY' matches this page's own packFor('MY').
  const qualifyingChildRelief = admin
    ? await qualifyingChildReliefFor(s, { personId: emp.personId, country: 'MY', asOf: today })
    : null;
  // r351 — THE ONE INSTANT THE FAMILY TAB'S AGE AND RELIEF COLUMNS ARE TAKEN AT, and it is the same date the
  // figure above was priced at. `childAgeYears` parses a DOB as `${dob}T00:00:00Z`, so the other endpoint is
  // built the same way (the reasoning core/dependents.ts and core/child-relief-review.ts both record): an
  // eight-hour offset would otherwise flip a child's whole-year age on their birthday — the one day the
  // eligibility rule turns on — and make the Family tab disagree with the Bank & Statutory tab for eight
  // hours out of every twenty-four.
  const familyAsOf = new Date(`${today}T00:00:00Z`);
  // 7ee14bbc — the duplicate income-tax-reference warning AT THE POINT OF ENTRY. The CP39 preview warns
  // at filing time; the approved plan asks for the same warning on the screen where the number is typed,
  // because five of the reporter's numbers are each filed against two or three different people and they
  // only found out when the statement was produced. ADVISORY: it never gates the save (LHDN decides
  // whose number is right, and HR must still be able to record what an employee's EA form says).
  // OTHER PEOPLE only — the pack read excludes this person, so a second concurrent employment of the
  // same person, which shares one tax record by construction, is not reported as a duplicate.
  const taxNumberSharedWith =
    admin && statutory?.taxNumber
      ? ((await countryPack?.statutory.taxNumberSharedWith(s, {
          personId: emp.personId,
          companyId: emp.companyId,
          taxNumber: statutory.taxNumber,
        })) ?? [])
      : [];
  // Feedback 57840a6e — the company's HRDF registration band never again feeds the Others Statutory
  // control's defaultValue. Pre-ticking its checkbox from that band is exactly how an untouched card pinned
  // an employee to an explicit No while the company was not_registered. The control is a tri-state select
  // whose "" option persists null (follow the company default, resolved at payroll time), so the page needs
  // no company-side default at all.
  // Feedback efece4ce — the band IS read again, for DISPLAY ONLY: an explicit "Subject to HRDF = Yes" on a
  // company with no HRDF Contribution Rate is accepted by the save and then silently discarded at payroll
  // time (pack.payroll.hrdfSubject honours the flag, but hrdfLevy rates not_registered to 0). HR set
  // something and nothing happened, with nothing on any screen saying why. Must NOT touch defaultValue.
  const companyHrdf = admin ? ((await countryPack?.companyStatutory.get(s, emp.companyId)) ?? null) : null;
  const companyHrdfUnregistered = (companyHrdf?.hrdfStatus ?? 'not_registered') === 'not_registered';
  // HR-defined multi-state holiday groups — the second option-group of the unified Holiday calendar field.
  const holidayGroups = admin ? await listHolidayGroups(s) : [];
  const holidayCalendarRows=admin?await employmentHolidayCalendarHistory(s,employmentId):[];
  /**
   * f513ec02 — THE SCHEDULE GROUP PICKER'S OPTIONS AND ITS CURRENT VALUE.
   *
   * The options are the tenant's ACTIVE attendance_rule rows, matching the shift editor's own convention
   * ("inactive rules stay assigned but are hidden from the picker", db/schema.ts attendance_rule.status).
   *
   * ⚠️ THE ASSIGNED RULE IS ADDED BACK EVEN WHEN IT IS INACTIVE, and that is not cosmetic. A select whose
   * stored value is absent from its options renders the FIRST option instead — here, the blank one — so
   * an employee whose group was later deactivated would show "no group" and the next save of this tab
   * would write that lie into the column. It is the same defect as feedback 57840a6e (a control rendering
   * something other than what is stored, then persisting it), reached by a different route. The extra
   * option is marked inactive so the reader is told why it is there.
   */
  const scheduleGroupCurrentId = admin ? await employmentScheduleGroupId(s, employmentId) : null;
  const attendanceRules = admin ? await listAttendanceRules(s) : [];
  const scheduleGroupOptions = attendanceRules.filter(
    (r) => r.status === 'active' || r.id === scheduleGroupCurrentId,
  );
  // Employment tab org-info edit (594323a6): position catalog for the editable Position dropdown. Scoped to
  // THIS employee's company (the assignment's position must belong to the same company). Admin-only.
  const positions = admin ? await listPositions(s, { companyIds: [emp.companyId] }) : [];
  // 1001ff61 — Business Units for THIS employee's company (admin-only) — the Organisation Assignment BU picker
  // options. Sourced company-scoped (origin ∪ shared ∪ global), mirroring the Position/Location pickers.
  const businessUnits = admin ? await listBusinessUnits(s, { companyIds: [emp.companyId] }) : [];
  // ADR-0054: locations for THIS employee's company (admin-only) — the "Set location" picker options.
  const locations = admin ? await listLocations(s, [emp.companyId]) : [];
  // Company change (9464bd56) — the Organisation Assignment selects re-scope to the PENDING company during a
  // company change; everything else (MovementNewEvent, the Set-location picker) keeps the current-company
  // lists. When no company is pending these ARE the current-company lists (byte-identical to before).
  const orgDepartments = pendingCompany ? await listDepartments(s, { companyIds: [orgScopeCompanyId] }) : departments;
  const orgPositions = pendingCompany ? await listPositions(s, { companyIds: [orgScopeCompanyId] }) : positions;
  const orgBusinessUnits = pendingCompany ? await listBusinessUnits(s, { companyIds: [orgScopeCompanyId] }) : businessUnits;
  const orgLocations = pendingCompany ? await listLocations(s, [orgScopeCompanyId]) : locations;
  // Typed pay components (Wave 3 #9) — recurring components for this employee + the catalog to add from.
  // r298 — Payroll-owned: not read at all for a tenant without Payroll (see `payrollOn`).
  const payComps = admin && payrollOn ? await listEmploymentPayComponents(s, employmentId) : [];
  const componentCatalog = admin && payrollOn ? await listPayComponents(s, { readyOnly: true }) : [];
  // 1.2.3 CP38 — per-employee LHDN instalment records (admin-only master data). r298 — Payroll-owned.
  const cp38Records = admin && payrollOn ? await listCp38(s, { employmentId }) : [];
  // ADR-0069 — leave encashment snapshot, admin-only card. Null when no resignation has been frozen
  // (policy off, or the employment was terminated directly bypassing the resignation flow).
  const encashmentSnapshot = admin ? await encashmentSnapshotForEmployment(s, employmentId) : null;
  // Personnel — Family / Dependents (phase 1): per-person benefits/insurance register (admin-only). Keyed
  // on person_id (already loaded on emp), NOT employment_id. Does NOT feed the tax num_children figure.
  const dependents = admin ? await listDependents(s, { personId: emp.personId }) : [];
  // Feedback a949184a — Qualification tab: this employment's academic/professional qualification records
  // (admin-only surface; employment-keyed, unlike the person-keyed Family register). Sorted by the service:
  // most recent graduation first, in-progress (blank graduation date) last.
  const qualifications = admin ? await listQualifications(s, { employmentId }) : [];
  // Feedback 23ad620e — Emergency Contact register: every person to call for this employee, in resolution
  // order (Primary → Secondary → Other). PERSON-keyed like the Family register, so it survives termination
  // and is visible to a second company's admin.
  const emergencyContacts = admin ? await listEmergencyContacts(s, { personId: emp.personId }) : [];
  // 2.1 Payroll Policy — active policies in THIS employee's company, for the assignment picker (admin-only).
  // r298 — Payroll-owned (core/payroll-policy.ts): not read for a tenant without Payroll.
  const assignablePolicies = admin && payrollOn ? await listAssignablePolicies(s, emp.companyId) : [];
  // 297ae65a — the company's currency: the Basic Salary form preselects it for a brand-new first record.
  // r79a (4fb8b75a step 3): read from `company.currency` (owned by Organization → General) instead of the
  // duplicate company_payroll_config.default_currency the pair collapsed into it (migration 0324).
  const defaultSalaryCurrency = admin ? await getCompanyCurrency(s, emp.companyId) : 'MYR';
  // ADR-0070 — Clocking Location & Geofencing: the picker's options + this employee's current assignment
  // (admin-only). r423 (83c0d3c8) REVERSES f9afd1ce's "every active site in the tenant": the picker offers
  // only the ACTIVE locations OPEN TO THIS EMPLOYEE'S COMPANY (clocking_location_company). The service
  // (setClockingControl) refuses anything else, so this filter is the courtesy and the service the rule.
  const clockingLocations = admin ? await listClockingLocations(s, { companyId: emp.companyId }) : [];
  const assignedClockingLocations = admin ? await listEmployeeClockingLocations(s, employmentId) : [];
  const assignedClockingLocationIds = new Set(assignedClockingLocations.map((l) => l.id));
  /**
   * r272 (0e8cf366) — THE PRE-TICK IS GONE, AND ITS REMOVAL IS THE POINT OF THE ITEM.
   *
   * 1fff489c step 10 seeded this control from the sites linked to the employee's confirmed (or
   * branch-suggested) work location whenever nothing was assigned. It seeded the CONTROL only — the save
   * has always been a full-set replace of what is ticked, and `components/tab-save-scope.tsx` never posts
   * a section the user did not touch, so it could not write on its own.
   *
   * It still had to go. The reporter filed a redesign asking us to "remove the dependency on Company,
   * State, Holiday Calendar and Branch" for clocking locations — a dependency that has never existed in
   * the engine (`resolveGeofence`, core/attendance.ts:194, joins the assignment table and nothing else).
   * This pre-fill is what made them believe in it: open an employee with nothing assigned and the system
   * appears to have chosen their sites from their branch. An empty assignment now renders empty and says
   * what that means.
   */
  const clockingDefaultIds = [...assignedClockingLocationIds];
  // 1fff489c — how many points sit under the employee's RESOLVED location (confirmed, else suggested).
  // null when no location resolves at all: that is a DIFFERENT empty state, and it is answered on the Work
  // Location card above (branch unmapped / no branch recorded), not by a sentence about clocking points.
  //
  // This is what empty state 3 keys off. It used to key off `clockingLocations.length === 0` — the whole
  // COMPANY having no points — while saying "This location has no clocking points yet", so a company that
  // had points but none under this employee's location (the case the wording describes) showed nothing at
  // all. Mirrors the admin screen's per-location groupNoPoints, which was already right.
  /** r272 — the point count that explained the pre-tick goes with it. "N clocking points are linked to
   *  this employee's work location" is a sentence ABOUT the branch coupling, on the card whose whole
   *  complaint is that the coupling appears to exist. The assignment now speaks for itself. */
  /** r272 — `locationsWithNoPoints` went with the multi-select. It rendered DISABLED options for company
   *  locations holding no clocking point, so a configured location did not look absent. The picker lists
   *  clocking sites only, and a location with no site is not a thing an employee can be assigned to; the
   *  admin screen's own per-location empty state is where that gap belongs. */
  const thisMonthStart = `${today.slice(0, 7)}-01`;
  const current = history.find((h) => !h.validTo) ?? history[0];
  const others = employees.filter((e) => e.employmentId !== employmentId && !e.terminatedOn);
  // c002b3c3 — Search Employee. NO NEW READ: this is the `listEmployees(s)` set already loaded above for
  // the Direct Superior picker, narrowed to the active company context. Two consequences worth stating.
  // (1) The search cannot be broader than what this page may already see, because it is literally the
  // same rows — there is no second, looser query to drift. (2) Picking a result only changes the URL;
  // the next request re-runs `employeeDetail(s, employmentId)` at the top of this file, which returns
  // null for anything out of scope and 404s. So the list is a convenience and the route is the guard,
  // and an id typed straight into the address bar is refused exactly as it was before this box existed.
  // Terminated employments stay IN: HR looks up leavers on this screen constantly (final pay, letters).
  const switcherEmployees = employees
    .filter((e) => scopeIds.includes(e.companyId))
    .map((e) => ({
      employmentId: e.employmentId,
      name: e.name,
      employeeCode: e.employeeCode,
      company: e.company,
      department: e.department,
    }));
  // Direct Superior (dce55aff): the CURRENT superior is the active administrative reporting line (the
  // one relationship every downstream consumer — approvals, visibility, calendars — actually follows).
  // The closed lines feed the read-only history disclosure; the storage stays effective-dated underneath.
  const currentSuperior = reporting.managers.find((m) => m.lineType === 'administrative') ?? null;
  const superiorHistory = admin ? await directSuperiorHistoryFor(s, employmentId) : [];
  // "EMP-0008 – John Tan" labels: the Combobox filters on the label, so one picker searches Employee ID
  // and name alike. Active employees only (`others` already excludes self + terminated); the current
  // superior is prepended if no longer in that set (e.g. terminated) so the field never shows a raw id.
  const superiorLabel = (code: string | null, name: string) => (code ? `${code} – ${name}` : name);
  const superiorOptions = others.map((o) => ({ value: o.employmentId, label: superiorLabel(o.employeeCode, o.name) }));
  if (currentSuperior && !superiorOptions.some((o) => o.value === currentSuperior.employmentId)) {
    superiorOptions.unshift({
      value: currentSuperior.employmentId,
      label: superiorLabel(currentSuperior.employeeCode, currentSuperior.name),
    });
  }
  const changeHistory = admin ? await employeeAudit(s, employmentId) : [];
  // Movement tab redesign (78853b97): Employment History is a read-model projection over the
  // domain_event ledger — Hired-first, date-ascending, no second record-keeping system. The detail view
  // (?movement=<id>) adds an as-of Before/After reconstruction at the event's effective date.
  const movements = admin ? await movementHistory(s, employmentId) : [];
  // 95d17761 — the DEFAULT view drops the correction artefacts (rolled back / corrected / cancelled /
  // superseded) so the tab reads as a career rather than a list of mistakes. Nothing is deleted and the
  // projection above is untouched: `movements` stays the complete history and is what the Edit lookup,
  // the pending-movement banner and the detail view keep reading. Only the TABLE draws `visibleMovements`.
  const showCorrectedMovements = spShowCorrected === '1';
  const { visible: visibleMovements, hiddenCount: correctedMovementCount } = partitionMovementRows(
    movements,
    showCorrectedMovements,
  );
  // The Show / Hide link keeps the reader exactly where they are: same tab, same open detail view, same
  // every other param. Only `showCorrected` is rewritten.
  const movementVisibilityHref = (show: boolean): string => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rawSearchParams)) {
      if (k === 'showCorrected' || v === undefined) continue;
      qs.set(k, v);
    }
    qs.set('tab', 'careerMovement');
    if (show) qs.set('showCorrected', '1');
    return `/admin/personnel/${employmentId}?${qs.toString()}`;
  };
  // 476f23ed — the tenant's movement event-type catalogue. Read UNFILTERED, because Employment History has
  // to label a movement recorded under a type that has since been switched off; the New Event form filters
  // to the active ones below. A tenant that has configured nothing gets the built-in list unchanged.
  const movementTypes = admin ? await listMovementEventTypes(s) : [];
  const movementTypeByCode = new Map(movementTypes.map((r) => [r.code, r]));
  const movementDetailData = admin && spMovement ? await movementDetail(s, employmentId, spMovement) : null;
  /**
   * c063eea9 — the Correct hire details form (?correctHire=1). Read ONLY while it is open, and only where
   * Movement may write at all (the same `admin && !terminatedOn` gate `canCreateMovement` applies below).
   *
   * The option lists are scoped to the company the employee was HIRED INTO — the hire version's company —
   * which after an Entity Transfer is not today's company. A hire label must be one THAT company may use,
   * the service refuses anything else (and checks every later version it carries the value into against
   * that version's own company), so offering today's company's labels would offer values it then refuses.
   */
  const hireCorrection =
    admin && !emp.terminatedOn && spCorrectHire === '1'
      ? // An employment with no assignment at all (legacy data) has nothing to correct: no form, rather
        // than an error page. Any other failure is a real one and still surfaces.
        await hireCorrectionView(s, employmentId).catch((e) => {
          if (e instanceof HireCorrectionError) return null;
          throw e;
        })
      : null;
  const hireCorrectionOptions = hireCorrection
    ? await (async () => {
        const scope = [hireCorrection.companyId];
        const [deps, poss, bus, ccs, locs] = await Promise.all([
          listDepartments(s, { companyIds: scope }),
          listPositions(s, { companyIds: scope }),
          listBusinessUnits(s, { companyIds: scope }),
          listCostCenters(s, { companyIds: scope }),
          listLocations(s, scope),
        ]);
        const byField: Record<HireCorrectionField, { id: string; name: string }[]> = {
          departmentId: deps.map((d) => ({ id: d.id, name: d.name })),
          positionId: poss.map((pos) => ({ id: pos.id, name: pos.title })),
          businessUnitId: bus.map((bu) => ({ id: bu.id, name: bu.name })),
          costCenterId: ccs.map((cc) => ({ id: cc.id, name: `${cc.code} — ${cc.name}` })),
          locationId: locs.map((l) => ({ id: l.id, name: `${l.name} (${l.code})` })),
          // Reporting lines may cross companies by design (hireEmployee allows a cross-company manager), so
          // the manager list is the same one the Direct Superior field offers.
          managerEmploymentId: others.map((o) => ({ id: o.employmentId, name: o.name })),
        };
        return byField;
      })()
    : null;
  // 08913328 — the Current column of the New Event comparison screen. Only read when that screen is open.
  // 66a63bd6 — the Edit screen is the same form, so it reads the same Current column: a correction is
  // only offered on the LATEST movement, where "current" and "what this movement set" are the same values.
  const movementCurrent =
    admin && (spNewEvent || spEditMovement) ? await movementCurrentState(s, employmentId) : null;
  /**
   * b7b22514 — Entity Transfer's destination list, and the org option lists of every destination.
   *
   * WHY THE LISTS AND NOT JUST THE COMPANIES. The comparison grid's Department / Position / Business Unit /
   * Location pickers are scoped to the employee's CURRENT company. The moment HR picks a destination those
   * options are the wrong company's, and a form that lets someone keep a Johor department while moving to a
   * KL company is a form that produces the exact cross-company incoherence the service then has to refuse.
   * Shipping each destination's lists lets the grid re-scope in the browser, so the incoherent combination
   * is never offered rather than offered and rejected.
   *
   * Read ONLY while the New Event / Edit screen is open, and only for companies the actor ADMINISTERS —
   * which is also exactly the set the writer will accept (it requires is_admin_for(destination)), so what
   * the form offers and what the service permits cannot drift apart. Each list is resolved per company
   * rather than filtered from one query on purpose: a System Label may be SHARED into a company it does not
   * originate in, so "usable by company X" is a question only the resolver can answer.
   */
  const movementCompanies =
    // Gated on movementCurrent, which is itself gated on New Event OR Edit: a correction of an Entity
    // Transfer renders this same form and needs the same destination list, or its Company select would
    // have one option and silently re-affirm the move it is meant to be able to fix.
    movementCurrent
      ? await (async () => {
          const managed = await adminCompanies(s);
          // The current company leads and is always present, even for an actor who does not administer it:
          // it is the select's initial value, and a control whose value matches no option is a broken one.
          return [
            { id: emp.companyId, name: movementCurrent.companyName ?? '' },
            ...managed.filter((c) => c.id !== emp.companyId),
          ];
        })()
      : [];
  const movementOrgByCompany = Object.fromEntries(
    await Promise.all(
      movementCompanies.map(async (c) => {
        const [deps, poss, bus, locs] = await Promise.all([
          listDepartments(s, { companyIds: [c.id] }),
          listPositions(s, { companyIds: [c.id] }),
          listBusinessUnits(s, { companyIds: [c.id] }),
          listLocations(s, [c.id]),
        ]);
        return [
          c.id,
          {
            departments: deps.map((d) => ({ id: d.id, name: d.name })),
            positions: poss.map((pos) => ({ id: pos.id, name: pos.title })),
            businessUnits: bus.map((bu) => ({ id: bu.id, name: bu.name })),
            locations: locs.map((l) => ({ id: l.id, name: `${l.name} (${l.code})` })),
          },
        ] as const;
      }),
    ),
  );
  // 7d309da7 — configurable profile-field dropdown catalogs (religion / race / nationality / state /
  // country / relationship). Active options only for the pickers; the ProfileOptionSelect renders any
  // out-of-catalog stored value as a pre-selected extra so a Save never blanks legacy data.
  const profileOptions = admin
    ? await listAllProfileOptions(s, { activeOnly: true })
    : ({
        religion: [],
        race: [],
        nationality: [],
        state: [],
        country: [],
        relationship: [],
        // 8c284478 — Salutation catalog (Personal Details, before Full Name).
        salutation: [],
        // 1001ff61 — org/job catalog categories (non-admin viewers never render these forms).
        division: [],
        branch: [],
        region: [],
        line: [],
        section: [],
        team: [],
        base: [],
        category: [],
        // ea36b7fa — Family tab Relationship catalog (admin-only surface; empty ⇒ built-in fallback).
        dependentRelationship: [],
        // a949184a — Qualification tab level catalog (non-admin viewers never render the form).
        qualificationLevel: [],
      } as Awaited<ReturnType<typeof listAllProfileOptions>>);

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
  const tabs: { key: 'profile' | 'family' | 'job' | 'careerMovement' | 'attendance' | 'bankStatutory' | 'payroll' | 'leave' | 'documents' | 'qualification'; label: string }[] = [
    { key: 'profile', label: t('tabs.profile') },
    { key: 'family', label: t('tabs.family') },
    { key: 'job', label: t('tabs.job') },
    // Movement (5296d984, redesigned by 78853b97): the Employment History timeline — a Hired-first
    // projection over the domain_event ledger — plus a single New Event entry point that folds in the
    // former Transfer / Terminate / Blacklist boxes (their audited services are reused via
    // core/movement.ts). The Employment tab keeps the "how they work" master data (reporting lines,
    // delegations); the "events that change employment over time" live here, right after Employment.
    { key: 'careerMovement', label: t('tabs.careerMovement') },
    // Dated Calendar stays first and owns its versioned Save. Schedule Group and the modern clocking /
    // Location Assignment controls share the field-edit Save below it; obsolete editors are removed.
    attendance: (
      <>
        {holidayCalendarCard}
        {admin && (
          <TabSaveScope
            tabKey="attendance"
            identity={{ employmentId: emp.employmentId }}
            saveAction={saveAttendanceTabAction}
            covers={tabSaveCovers.attendance}
          >
            {/* f513ec02 — the Schedule Group assignment, directly under the Holiday Group it is modelled
                on, and above Clocking so the two "which rules judge this person" cards read together. */}
            {scheduleGroupCard}
            {clockingCard}
            {/* r430 — Web Clocking's Attendance Photo setting, directly after Clocking & Geofencing: both
                are "what does this employee's own self-capture clocking require" cards. */}
            {webClockingPhotoCard}
          </TabSaveScope>
        )}
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
    // 420ebab5 part two (r255) — this is the ONLY tab with no bucket (b) form on it at all, so its one
    // "Save Changes" covers the whole tab with nothing left over and the reading order is untouched. All
    // four cards are plain field edits; the ORDER THEY ARE WRITTEN IN is not this JSX order but the
    // declared one in lib/personnel-tab-sections.ts (statutory → tax → bank → others), because the
    // statutory form is a FULL-ROW overwrite whose pass-throughs read the stored row at the moment it
    // runs, so it goes first and the partial writers land their own values on top of it.
    bankStatutory: (
      <>
        {admin && (
          <TabSaveScope
            tabKey="bankStatutory"
            identity={{ employmentId: emp.employmentId }}
            saveAction={saveBankStatutoryTabAction}
            covers={tabSaveCovers.bankStatutory}
          >
            {bankCard}
            {/* Item df09f22a — the Identification & Tax card was merged into statutoryCard as a nested "Income Tax
                (PCB)" section (Income tax is a Malaysia statutory item). One box now holds every statutory field. */}
            {statutoryCard}
            {/* Feedback 0df0c635 — Others Statutory pinned BELOW the existing statutory cards (reporter-specified
                order: Statutory (Malaysia) → Tax Information → Others Statutory). */}
            {othersStatutoryCard}
          </TabSaveScope>
        )}

      </>
    ),
    // Payroll tab keeps pay components, CP38, encashment, policy assignment and compensation. The
    // statutory/bank card previously pinned to the top (feedback 7524eda1) now lives on Bank & Statutory.
    // compensationCard (Basic Salary / salary history) is pinned FIRST (feedback 326f0b5e): Basic Salary
    // is the most-referenced payroll attribute, so it opens at the top with no scrolling. Pure JSX order
    // change — every card's definition and behaviour is unchanged.
    // Item a6a47698 — TP3 / opening balances and the Zakat summary relocated here from Bank & Statutory so
    // all payroll-related employee information is centralized on this tab. tp3Card has its own partial save
    // (setTp3Action); zakatSummaryCard is read-only and links to Payroll → Transaction Entry → Zakat to edit.
    // R46 79eb7151 — payrollPolicyCard moved from LAST to SECOND, directly under compensationCard. It was
    // the layout root cause: Pay Mode and Payment Term both live on the payroll policy, but the card holding
    // it sat below pay components, CP38, encashment, TP3 and zakat, so from the Salary section at the top of
    // the tab they looked absent. Basic Salary and the policy that decides how it is paid now read together.
    // compensationCard stays FIRST (feedback 326f0b5e) — Basic Salary must still open at the top.
    //
    // 420ebab5 part two (r256) — THE LAST TAB TO GET ONE SAVE, and the order moved to make it possible.
    // The audit (docs/audits/420ebab5-personnel-save-classification.md, finding 3) held this tab back
    // twice on two grounds. The first is answered: `covers` names the cards the bar owns, and the fence
    // is the MARKER not the subtree, so Payment Method living INSIDE compensationCard puts nothing else
    // in that card under the tab's Save — setCompensationAction's revision dialog carries no marker and
    // is never read, packed or reset. The second is not answered but ACCEPTED and is the visible change:
    // a tab Save can only enclose a CONTIGUOUS run, so the three field-edit cards lead the tab and TP3
    // moves up from sixth to third, past Pay Items, CP38 and Leave Encashment.
    //
    // NOTHING PINNED IS REVERSED. compensationCard stays FIRST (feedback 326f0b5e — Basic Salary must
    // open at the top with no scrolling) and payrollPolicyCard stays SECOND (R46 79eb7151 — Pay Mode and
    // Payment Term read together with the salary they govern). TP3's sixth slot was never a decision:
    // item a6a47698 appended it when it relocated here from Bank & Statutory, and no guard held it.
    // test/personnel-payroll-tab-order.test.ts now pins the new run so this cannot drift back silently.
    //
    // The four cards BELOW the scope keep their own buttons and their own confirmations, and every one of
    // them is bucket (b) or read-only: pay items (a dated fixed transaction), CP38 (a court-ordered
    // deduction, added and terminated), leave encashment (adjust / unfreeze — money out), and the zakat
    // summary, which is read-only and edited solely at /payroll/transactions/zakat.
    payroll: (
      <>
        {admin && (
          <TabSaveScope
            tabKey="payroll"
            identity={{ employmentId: emp.employmentId }}
            saveAction={savePayrollTabAction}
            covers={tabSaveCovers.payroll}
          >
            {compensationCard}
            {payrollPolicyCard}
            {tp3Card}
          </TabSaveScope>
        )}
        {payComponentsCard}
        {cp38Card}
        {encashmentCard}
        {zakatSummaryCard}
      </>
    ),
    // 39306a9e: retain grade, scheme and requests. Balance and recalculation review live in Leave.
    leave: (
      <>
        {/* Grade and Benefit Scheme keep their existing owners and actions. */}
        {gradeCard}
        {benefitSchemeCard}
        {leaveRequestsCard}
      </>
    ),
    documents: documentsPanel,
    // Qualification (feedback a949184a): the academic/professional qualification register — a single card
    // mirroring the Family tab's list-and-dialog pattern (see qualificationPanel above).
    qualification: qualificationPanel,

  };

  return (
    // c002b3c3 — the profile was the NARROWEST page in the module (max-w-4xl) while carrying the most on
    // it, which is backwards; it now uses the SAME container as the listing and as the wide screens this
    // codebase already settled on. One value, applied identically in both places on purpose — the whole
    // module widening to two slightly different caps is the report this is meant to prevent. Nothing
    // inside is re-laid-out: every card and tab already flows to its container.
    <div className="mx-auto max-w-[100rem] space-y-6">
      <PageHeader
        back={back}
        title={emp.name}
        description={t('headerDescription', {
          code: emp.employeeCode ?? '—',
          email: emp.email,
          company: emp.company,
          hiredOn: formatDmy(emp.hiredOn),
        })}
        actions={
          <>
            {/* c002b3c3 — Search Employee, in the SAME top-right position it holds on the listing, so the
                control does not move as you navigate. `tab` rides along so jumping to the next person
                keeps the tab you were reading instead of resetting to Profile. */}
            <EmployeeSwitcher
              employees={switcherEmployees}
              currentEmploymentId={emp.employmentId}
              tab={tab ?? null}
            />
            <StatusBadge status={derivedStatus} label={derivedStatusLabel} />
          </>
        }
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
            {/* 597c810a point 3 — VIEW. Only when there IS a photo: a View control over an initials
                placeholder is a button that can only disappoint. It sits with the Edit trigger under the
                avatar, and it is available to EVERY reader of this record, not only an admin — inspecting
                a photo is a read, and the read rule is can_see_person, which this reader has already
                passed to be on this page at all. The island holds no t(): every caption is resolved here
                (see components/photo-edit-menu.tsx for why that matters to the i18n guard). */}
            {photoExists && (
              <PhotoLightbox
                src={`/personnel/photo/${emp.personId}`}
                viewLabel={t('photoView')}
                closeLabel={t('photoViewClose')}
                dialogLabel={t('photoViewTitle', { name: emp.name })}
                alt={emp.name}
              />
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

                    {...personnelInput('profile.personal_details.photo')}
                    accept="image/png,image/jpeg"
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
                <StatusBadge status={derivedStatus} label={derivedStatusLabel} />
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
            {/* Item 7a504619 — Direct Superior read straight from the active administrative reporting line
                (already loaded via reportingLinesFor). Read-only mirror of the Employment tab; a change there
                shows here automatically. Dash when no manager is assigned. dce55aff: shows the superior's
                Employee ID alongside the full name ("EMP-0008 – John Tan"). */}
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerSuperior')}</dt>
              <dd className="font-medium text-foreground">
                {currentSuperior ? superiorLabel(currentSuperior.employeeCode, currentSuperior.name) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('headerCompany')}</dt>
              <dd className="font-medium text-foreground">{emp.company}</dd>
            </div>
            <div>
              {/* 4ea70bb7 — this pair has always rendered emp.hiredOn, which is the GROUP join date; the
                  label said "Join date", the name the Employment tab gives the OTHER column (emp.joinDate).
                  Labelled Group Join Date so the summary card and the Employment tab name the same date the
                  same way. The value is unchanged and neither date moved. */}
              <dt className="text-xs text-muted-foreground">{t('headerGroupJoinDate')}</dt>
              <dd className="font-medium text-foreground">{formatDmy(emp.hiredOn)}</dd>
            </div>
            {/* b75b2a23 — Year of Service, moved here from the Employment tab so service length is visible
                the moment a profile opens. Same read-only Y/M/D figure from the Group Join Date (computed
                above with the other service figures), same i-badge tooltip carrying the underlying dates,
                same "Not Available" fallback. Placed after the Group Join Date — the two read together —
                and as the 8th pair it keeps the 2-column grid even. This is the row's ONLY display; the
                Employment Information card row was removed.
                4ea70bb7 — the Employment tab's Group Service caption now prints the SAME string from the
                SAME formatter (fmtServiceYmd on the same emp.hiredOn). That is deliberate: one figure, two
                captions, one calculation — it is a second caption, not a second answer. */}
            <div>
              <dt className="text-xs text-muted-foreground">{t('employmentInfo.yearOfService')}</dt>
              <dd className="font-medium text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span>{yearOfServiceLabel ?? t('employmentInfo.notAvailable')}</span>
                  {yearOfServiceTooltip && (
                    <span
                      className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground"
                      title={yearOfServiceTooltip}
                      aria-label={yearOfServiceTooltip}
                    >
                      i
                    </span>
                  )}
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <ErrorBanner message={error} />

      {/* R46 47146ea3 — Children (PCB Relief) auto-sync feedback. The manual "Use {count}" confirmation is
          gone: a Family-record change now moves the PCB child count by itself whenever Child Relief Mode is
          'Auto'. Because that silently changes a TAX input, the person who made the edit is told what moved.

          The AMBER case is rail (d): the count changed while a payroll batch for that period was still open
          (draft/processed). We deliberately allow the edit — blocking would leave HR unable to correct a
          family record for as long as payroll stays open — but a regenerate would now produce a different
          PCB, so the payroll team has to know. Closed batches are unaffected: their payslips are frozen
          snapshots and closed-batch immutability is enforced by DB triggers.

          The NEUTRAL case is the quiet confirmation that the count moved with no payroll run in flight.
          Both are transient; the permanent record is the `employee.tax.updated` event, stamped auto: true. */}
      {childReliefAlert ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          {t('childReliefAutoSyncedPayrollAlert', {
            count: Number(childReliefTo ?? 0),
            period: childReliefAlert,
          })}
        </div>
      ) : childReliefSynced ? (
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {t('childReliefAutoSynced', { count: Number(childReliefSynced) })}
        </div>
      ) : null}

      <PersonnelTabs
        tabs={tabs}
        panels={panels}
        emptyLabel={t('tabs.empty')}
        defaultTab={tab as PersonnelTabKey | undefined}
      />
    </div>
  );
}
