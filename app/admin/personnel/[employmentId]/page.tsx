import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { isAdmin } from '@/lib/authz';
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
  leaveBalances,
  leaveEntitlementBreakdown,
  leaveRequestsFor,
  listDepartments,
  listEmployees,
  listJobGrades,
  reportingLinesFor,
} from '@/core/read';
import { Avatar, Badge, Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, StatusBadge, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { hasPersonPhoto } from '@/core/person-photo';
import { listEntitlementRecalcAudit } from '@/core/leave';
import { EntitlementBreakdown } from '@/components/leave/EntitlementBreakdown';
import {
  ENTITLEMENT_STATUS_LABEL_KEY,
  ENTITLEMENT_STATUS_TIP_KEY,
  entitlementStatusNeedsNotice,
} from '@/lib/entitlement-status';
import { AuditTable } from '@/components/audit-table';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
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
import { SameAsPermanentAddress } from '@/components/same-as-permanent-address';
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
  setLocationAction,
  setEmploymentHolidayCalendarAction,
  setPersonAction,
  setPersonPhotoAction,
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
// 297ae65a — searchable ISO 4217 Currency select for the Basic Salary form + the company default it preselects.
import { CurrencySelect } from '@/components/currency-select';
import { getCompanyCurrency } from '@/core/read';
import { listCp38 } from '@/core/cp38';
import { addCp38Action, editCp38Action, terminateCp38Action } from './cp38-actions';
import { listDependents, eligibleChildReliefCount, childAgeYears, isChildReliefEligible, DEPENDENT_GENDERS, DEPENDENT_MARRIAGE_STATUSES, DEPENDENT_RELATIONSHIPS, CHILD_RELIEF_CATEGORIES, type DependentRow } from '@/core/dependents';
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
import { PAYMENT_METHODS } from '@/core/org';
import { assignPolicyAction } from '@/app/admin/payroll-policy/actions';
import { listShiftsForTenant } from '@/core/roster';
// 18504ca6 — the dated Shift arrangement ladder behind the card's new Effective date + Shift history list.
import { shiftArrangementHistory } from '@/core/shift-arrangement';
import { EmployeeShiftFields } from '@/components/employee-shift-fields';
import { setDefaultShiftAction } from './actions';
import { listHolidayGroups, listPositions, listBusinessUnits } from '@/core/admin';
import { listLocations, resolveLocationForBranch, branchChangeDateFor } from '@/core/location';
import { listClockingLocations, listEmployeeClockingLocations } from '@/packs/attendance/service';
import { setEmployeeClockingLocationsAction, setGeofencingAction } from './actions';
import { ReviewSection } from './review-section';
import { DocumentsSection } from './documents-section';
import { PersonnelTabs, type PersonnelTabKey } from '@/components/personnel-tabs';
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
  }>;
}) {
  const { s, scopeIds } = await scopedAdmin(); // Admin-only management surface (People→Personnel split). Non-admins redirect home.
  const t = await getTranslations('people.detail');
  // 2f889bae — the Pay items row link reuses Fixed Transactions' OWN labels rather than minting
  // `people.detail` copies, so the two surfaces can never drift into calling the same destination two
  // different things. Both keys already exist and are translated in all six catalogues.
  const tFixed = await getTranslations('payroll.transactions.fixed');
  const tp = await getTranslations('payrollPolicy');
  const tc = await getTranslations('people.detail.clocking');
  const tStatus = await getTranslations('people.employeeStatus');
  // 31e39d74 — the leave-balance card captions a not-yet-generated entitlement with the SAME words the two
  // balance grids use, rather than a third phrasing of the same fact.
  const tBal = await getTranslations('me.leaveBalanceTable');
  const admin = isAdmin(s);
  const { employmentId } = await params;
  // 95d17761 — kept whole (not just destructured) so the Show / Hide link under Employment History can
  // rebuild the CURRENT query string and preserve every param it does not own, rather than dropping the
  // reader back onto a bare tab.
  const rawSearchParams = await searchParams;
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
    childReliefSynced,
    childReliefAlert,
    childReliefTo,
    companyChange,
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

  const [history, balances, requests, departments, reporting, employees, grades, delegations, recalcAudit] = await Promise.all([
    assignmentHistory(s, employmentId),
    // 994a5287: an ADMIN read — `includeHidden` keeps leave types HR has hidden from employee self-service,
    // which is a rule about what the EMPLOYEE sees and never about what HR may look up on this profile.
    leaveBalances(s, employmentId, undefined, { includeHidden: true }),
    leaveRequestsFor(s, employmentId),
    // 570e3311 — departments scoped to THIS employee's company (origin ∪ shared-in ∪ global via the
    // System Labels resolver), matching the Position/BU/Location pickers. Feeds exactly two places:
    // the Organisation Assignment department select and the MovementNewEvent departments prop.
    listDepartments(s, { companyIds: [emp.companyId] }),
    reportingLinesFor(s, employmentId),
    listEmployees(s),
    listJobGrades(s),
    delegationsFor(s, employmentId),
    // R45 7527ea5f — profile-change entitlement recalculation history for the Leave tab.
    listEntitlementRecalcAudit(s, employmentId),
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
  // 7c7c2f80 — periods of CLOSED payroll runs that paid this employee: drives the per-row "deletable"
  // flag on the salary history (records a closed run relied on are payroll evidence and cannot go).
  const closedPayrollPeriods = admin ? await closedPayrollPeriodsFor(s, employmentId) : [];
  // Rung 5c — the acting company's country pack; statutory reads + the SOCSO/EIS default resolve through it.
  const countryPack = packFor('MY');
  // Rung 5c — the holiday-calendar state pick-list comes from the country packs via the registry
  // (union-read, the rung-5a `countryPacks()` precedent). MY-only ⇒ byte-identical to the old MY_STATES.
  const stateOptions = countryPacks().flatMap((p) => p.states);
  const statutory = admin ? ((await countryPack?.statutory.get(s, emp.personId)) ?? null) : null;
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
  // Feedback a949184a — Qualification tab: this employment's academic/professional qualification records
  // (admin-only surface; employment-keyed, unlike the person-keyed Family register). Sorted by the service:
  // most recent graduation first, in-progress (blank graduation date) last.
  const qualifications = admin ? await listQualifications(s, { employmentId }) : [];
  // Feedback 23ad620e — Emergency Contact register: every person to call for this employee, in resolution
  // order (Primary → Secondary → Other). PERSON-keyed like the Family register, so it survives termination
  // and is visible to a second company's admin.
  const emergencyContacts = admin ? await listEmergencyContacts(s, { personId: emp.personId }) : [];
  // 2.1 Payroll Policy — active policies in THIS employee's company, for the assignment picker (admin-only).
  const assignablePolicies = admin ? await listAssignablePolicies(s, emp.companyId) : [];
  // 297ae65a — the company's currency: the Basic Salary form preselects it for a brand-new first record.
  // r79a (4fb8b75a step 3): read from `company.currency` (owned by Organization → General) instead of the
  // duplicate company_payroll_config.default_currency the pair collapsed into it (migration 0324).
  const defaultSalaryCurrency = admin ? await getCompanyCurrency(s, emp.companyId) : 'MYR';
  // R46 79eb7151 — resolve the policy the payroll kernel will ACTUALLY use for this employee (direct
  // assignment → company default → null ⇒ monthly default), so the Salary section can surface its Pay Mode
  // and Payment Term read-only. Resolving rather than reading emp.payrollPolicyId matters: an employee with
  // no direct assignment still computes under the company default, and an assigned-but-inactive policy
  // silently falls back to monthly — both cases would be misreported by the raw column.
  // ADR-0078 — the R46 resolvedPolicyForEmployment read is gone from this page: Pay Mode / Payment Term
  // now live on the employee's own compensation rows (salaryHistory below carries them per revision).
  // R33 f21d6eee — Default shift picker options: the SHARED tenant-wide shift library (a template may now be
  // assigned to any employee regardless of company). Loaded WITH archived rows so a currently-assigned-but-
  // later-archived shift still renders as the selected option (instead of silently showing "None"), then
  // filtered to live shifts + the assigned one. New assignments of archived shifts are rejected by the service.
  const libraryShifts = admin && !emp.terminatedOn ? await listShiftsForTenant(s, { includeArchived: true }) : [];
  const assignableShifts = libraryShifts.filter((sh) => !sh.archivedAt || sh.id === emp.defaultShiftId);
  // 18504ca6 — the dated periods behind the Shift history list, newest first, with the shift CODE and NAME
  // already resolved. Deliberately NOT taken from the Others-tab Change History: that renders the audit
  // payload through lib/audit-format.ts describePayload, which prints defaultShiftId as a raw uuid → uuid pair.
  const shiftHistory = admin ? await shiftArrangementHistory(s, employmentId) : [];
  // ADR-0070 — Clocking Location & Geofencing: THIS employee's company's active clocking sites (the
  // multi-select options) + their current assignment (admin-only, mirrors the payroll-policy card).
  const clockingLocations = admin ? await listClockingLocations(s, [emp.companyId]) : [];
  const assignedClockingLocations = admin ? await listEmployeeClockingLocations(s, employmentId) : [];
  const assignedClockingLocationIds = new Set(assignedClockingLocations.map((l) => l.id));

  // ── 1fff489c PHASE 2 — the Branch proposes a work location, HR confirms it ──────────────────────────
  // ONLY when the open assignment has none. An employee who already has a location is left alone: the
  // suggestion is a first-fill aid, not a nag, and re-proposing over a deliberate manual pick is exactly
  // the "it changed itself" behaviour spec section C forbids. NOTHING here writes — the Confirm button
  // posts the same effective-dated setLocationAction a manual pick does.
  const branchLocationSuggestion =
    admin && !emp.terminatedOn && !emp.locationId
      ? await resolveLocationForBranch(s, emp.companyId, emp.orgBranch)
      : null;
  // The effective date the suggestion offers: the date the Branch last changed, falling back to today.
  // Pre-fill only — the field stays editable, because HR is the one who knows when the move really took
  // effect for payroll.
  const branchChangeDate = branchLocationSuggestion ? await branchChangeDateFor(s, employmentId) : null;
  const suggestedEffectiveDate = branchChangeDate ?? today;
  // 1fff489c step 10 — the clocking pre-fill. Sites whose location_id matches the employee's CONFIRMED
  // location (or, before Confirm, the suggested one) seed the multi-select's defaults. It seeds only: the
  // save is still a full-set replace, so an admin who unticks one gets exactly what they ticked.
  const preTickLocationId = emp.locationId ?? branchLocationSuggestion?.id ?? null;
  const clockingDefaultIds = assignedClockingLocationIds.size
    ? [...assignedClockingLocationIds]
    : preTickLocationId
      ? clockingLocations.filter((cl) => cl.locationId === preTickLocationId).map((cl) => cl.id)
      : [];
  // 1fff489c — how many points sit under the employee's RESOLVED location (confirmed, else suggested).
  // null when no location resolves at all: that is a DIFFERENT empty state, and it is answered on the Work
  // Location card above (branch unmapped / no branch recorded), not by a sentence about clocking points.
  //
  // This is what empty state 3 keys off. It used to key off `clockingLocations.length === 0` — the whole
  // COMPANY having no points — while saying "This location has no clocking points yet", so a company that
  // had points but none under this employee's location (the case the wording describes) showed nothing at
  // all. Mirrors the admin screen's per-location groupNoPoints, which was already right.
  const resolvedLocationPointCount = preTickLocationId
    ? clockingLocations.filter((cl) => cl.locationId === preTickLocationId).length
    : null;
  // …and the mockup's third multi-select line: a mapped location that holds no point yet is LISTED and
  // unselectable ("BU8 · Bandar Utama 8 · no clocking points yet") rather than silently absent, so the
  // admin can see the location exists and why nothing can be ticked under it.
  const locationsWithNoPoints = locations.filter((l) => !clockingLocations.some((cl) => cl.locationId === l.id));
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
  const tabs: { key: 'profile' | 'family' | 'job' | 'careerMovement' | 'attendance' | 'bankStatutory' | 'payroll' | 'leave' | 'documents' | 'qualification' | 'others'; label: string }[] = [
    { key: 'profile', label: t('tabs.profile') },
    { key: 'family', label: t('tabs.family') },
    { key: 'job', label: t('tabs.job') },
    // Movement (5296d984, redesigned by 78853b97): the Employment History timeline — a Hired-first
    // projection over the domain_event ledger — plus a single New Event entry point that folds in the
    // former Transfer / Terminate / Blacklist boxes (their audited services are reused via
    // core/movement.ts). The Employment tab keeps the "how they work" master data (reporting lines,
    // delegations); the "events that change employment over time" live here, right after Employment.
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
    // Qualification (feedback a949184a): the employee's academic / professional qualification history —
    // a list-and-dialog register mirroring the Family tab's table + dialogForm pattern. Placed after
    // Documents per the request's tab-order example.
    { key: 'qualification', label: t('tabs.qualification') },
    { key: 'others', label: t('tabs.others') },
  ];

  // 9d13221c — Age beside Date of Birth: completed whole years from the stored DOB to today, recomputed on
  // every render so each profile open shows that day's exact age (it increments the day the birthday
  // arrives — a 29-Feb birthday increments on 1 Mar in common years). Read-only + display-only: the age is
  // never stored, never an input, and never audited (DOB edits keep their existing audit trail).
  // 35b7af0a group 3 — the derivation and the two Fields moved INTO components/birth-date-fields.tsx, which
  // both this card and the Create New Employee wizard render; only `today` is passed down (this page still
  // owns "what date is it", through the tenant timezone).

  // ── PROFILE ────────────────────────────────────────────────────────────────
  // b4682879 — modular redesign: three organised cards (Personal Details, Contact & Address, Emergency
  // Contact) plus the existing gender/marital/DOB compliance card. Each card stays its OWN <form> (panels
  // stay mounted in the tab shell) and routes through the single writer for its trust class (updatePerson
  // for instant fields, setPersonComplianceFields for the audited compliance fields). The core identity
  // (fullName / primaryEmail / phone) that updatePerson always writes is passed through as hidden fields on
  // the cards that don't visibly own it, so saving one section never wipes another's data.
  // Feedback 23ad620e — Emergency Contact is a REGISTER, not a single form: an employee may need a spouse
  // AND a parent AND a guardian on file, and HR needs to know who to try first. Same list-and-dialog shape
  // as the Family and Qualification tabs (one summary table + one Add/Edit/View dialog + a delete inside
  // the tab shell), so the three registers on this profile behave identically.
  //
  // Priority carries the request's own vocabulary (Primary / Secondary / Other) and only ONE contact can be
  // Primary: choosing it demotes the previous holder to Secondary (core/emergency-contacts.ts, backstopped
  // by a partial unique index). The screens that still show ONE contact (/me, the profile card) resolve to
  // the Primary automatically, so nothing had to be told about the change.
  const emergencyTaCls = `${inputCls.replace('h-9', 'min-h-16')} py-2`;
  // Static literal keys, not a dynamic template — test/i18n-coverage.test.ts can then catch a missing
  // Tamil/Thai label instead of shipping a raw key (the family.rel.* precedent above).
  const emergencyPriorityLabel = (p: string) => {
    switch (p) {
      case 'primary': return t('emergency.priorityPrimary');
      case 'secondary': return t('emergency.prioritySecondary');
      case 'other': return t('emergency.priorityOther');
      default: return p;
    }
  };
  const emergencyFields = (c: EmergencyContactRow | null) => (
    <>
      <Field label={t('emergency.name')}>
        <input name="fullName" required defaultValue={c?.fullName ?? ''} className={inputCls} />
      </Field>
      <Field label={t('emergency.relationship')}>
        <ProfileOptionSelect
          name="relationship"
          value={c?.relationship}
          options={profileOptions.relationship}
          placeholder={t('optionNotSet')}
          legacySuffix={t('optionLegacySuffix')}
        />
      </Field>
      <Field label={t('emergency.mobilePhone')}>
        <input name="mobilePhone" defaultValue={c?.mobilePhone ?? ''} className={inputCls} />
      </Field>
      <Field label={t('emergency.homePhone')}>
        <input name="homePhone" defaultValue={c?.homePhone ?? ''} className={inputCls} />
      </Field>
      <Field label={t('emergency.priority')}>
        <select name="priority" defaultValue={c?.priority ?? 'other'} className={inputCls}>
          {EMERGENCY_CONTACT_PRIORITIES.map((p) => (
            <option key={p} value={p}>{emergencyPriorityLabel(p)}</option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('emergency.address')}>
          {/* 7d309da7 — address = multi-line long-text (line breaks preserved) instead of a single input. */}
          <textarea name="address" rows={3} defaultValue={c?.address ?? ''} className={emergencyTaCls} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label={t('emergency.remarks')}>
          <textarea name="remarks" rows={2} defaultValue={c?.remarks ?? ''} className={emergencyTaCls} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t('emergency.primaryHint')}</p>
    </>
  );
  // One dialog form for Add (c null) and Edit. The STATIC hidden `tab` input keeps the post-save redirect on
  // this tab (Dialog.Portal reparents the form outside the tab shell, so the shell's submit listener never
  // sees it — the Family tab note).
  const emergencyDialogForm = (c: EmergencyContactRow | null) => (
    <form
      action={c ? editEmergencyContactAction : addEmergencyContactAction}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2"
    >
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      <input type="hidden" name="personId" value={emp.personId} />
      {c && <input type="hidden" name="id" value={c.id} />}
      <input type="hidden" name="tab" value="profile" data-tab-tracker="" />
      {emergencyFields(c)}
      <div className="flex justify-end sm:col-span-2">
        <button className={btnPrimary}>{c ? t('emergency.save') : t('emergency.add')}</button>
      </div>
    </form>
  );
  // View: the SAME server-rendered fields, disabled inside a fieldset with no <form> — the read-only view
  // can never drift from the Edit layout, and can never post.
  const emergencyViewBody = (c: EmergencyContactRow) => (
    <fieldset disabled>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">{emergencyFields(c)}</div>
    </fieldset>
  );
  const emergencyContactPanel = (
    <Card id="section-emergency-contact" className="overflow-hidden">
      <SectionHeader title={t('emergencyTitle')} count={emergencyContacts.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <FamilyFormDialog triggerLabel={t('emergency.add')} title={t('emergency.addTitle')}>
            {emergencyDialogForm(null)}
          </FamilyFormDialog>
        </div>
        {emergencyContacts.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('emergency.none')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('emergency.name')}</th>
                  <th className="py-2 pr-3 font-medium">{t('emergency.relationship')}</th>
                  <th className="py-2 pr-3 font-medium">{t('emergency.mobilePhone')}</th>
                  <th className="py-2 pr-3 font-medium">{t('emergency.homePhone')}</th>
                  <th className="py-2 pr-3 font-medium">{t('emergency.priority')}</th>
                  <th className="py-2 text-right font-medium">{t('emergency.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {emergencyContacts.map((c) => (
                  <tr key={c.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-medium">{c.fullName}</td>
                    <td className="py-2 pr-3">{c.relationship ?? '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{c.mobilePhone ?? '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{c.homePhone ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {c.priority === 'primary' ? (
                        <Badge variant="success">{t('emergency.priorityPrimary')}</Badge>
                      ) : (
                        emergencyPriorityLabel(c.priority)
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-2">
                        <FamilyFormDialog
                          triggerLabel={t('emergency.view')}
                          triggerVariant="outline"
                          title={t('emergency.viewTitle')}
                        >
                          {emergencyViewBody(c)}
                        </FamilyFormDialog>
                        <FamilyFormDialog
                          triggerLabel={t('emergency.edit')}
                          triggerVariant="outline"
                          title={t('emergency.editTitle')}
                        >
                          {emergencyDialogForm(c)}
                        </FamilyFormDialog>
                        {/* Delete lives INSIDE the tab shell, so ConfirmSubmit's requestSubmit() fires a
                            bubbling submit the shell's capture listener sees (tab retention for free). */}
                        <form action={deleteEmergencyContactAction}>
                          <input type="hidden" name="employmentId" value={emp.employmentId} />
                          <input type="hidden" name="id" value={c.id} />
                          <ConfirmSubmit
                            size="sm"
                            variant="destructive"
                            title={t('emergency.deleteConfirmTitle')}
                            description={t('emergency.deleteConfirmBody')}
                            confirmLabel={t('emergency.delete')}
                          >
                            {t('emergency.delete')}
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );

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
              maxLength={30}
              defaultValue={emp.employeeCode ?? ''}
              placeholder={t('employeeIdPlaceholder')}
              className={inputCls}
            />
          </Field>
          {/* 8c284478 — Salutation BEFORE Full Name (natural data-entry order). Catalog-backed like
              Religion below: active options from System Labels > Profile Options; an off-catalog stored
              value renders as a pre-selected legacy extra so a Save never blanks it. Optional (blank ⇒ null). */}
          <Field label={t('salutation')}>
            <ProfileOptionSelect
              name="salutation"
              value={emp.salutation}
              options={profileOptions.salutation}
              placeholder={t('optionNotSet')}
              legacySuffix={t('optionLegacySuffix')}
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
          {/* 59047802 — searchable combobox over the full ISO 3166-1 nationality set; emits the same
              single `nationality` value (via a hidden input) so setPersonAction is unchanged. e3ce0d4d —
              wrapped as NationalityField so a change also pushes the live value into IdentityProvider,
              driving the IC ⇄ Passport switch in the identity block below without a page reload.
              35b7af0a group 8 — the label and the four picker captions now live inside the shared group
              (components/identity-fields.tsx), which the Create New Employee wizard renders too, so this
              page passes only what a server component can: the value and the tenant's catalog. */}
          <NationalityField
            name="nationality"
            value={emp.nationality}
            options={profileOptions.nationality.map((o) => ({ value: o.value, label: o.label }))}
          />
          {/* Item 52a30630 — Holiday Calendar RELOCATED to the Attendance tab (holidayCalendarCard →
              setEmploymentHolidayCalendarAction) and Grade RELOCATED to the Leave tab (gradeCard →
              setEmploymentGradeAction). HTML forms can't span tab panels, so both selects physically moved
              into their own forms in the target panels; setPersonAction no longer writes either column. */}
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
          {/* 35b7af0a group 3 — Date of Birth and the read-only Age (9d13221c) are now ONE shared field
              group (components/birth-date-fields.tsx), rendered identically here and on the Create New
              Employee wizard, which previously had a bare DOB box and no Age at all. `mode="form"` keeps
              these inputs exactly what they were: an uncontrolled `name`/`defaultValue` date input inside
              this server-action form, with NO function prop crossing the server→client boundary (the r123
              fault). `inputId` is not cosmetic — components/ic-dob-autofill.tsx finds this field by that id
              and writes the DOB derived from a MyKad number straight onto the DOM node. */}
          <BirthDateFields mode="form" inputId="profile-dob-input" dateOfBirth={emp.dateOfBirth} today={today} />
          {/* 35b7af0a group 1 — Gender and Marital Status are now ONE shared field group
              (components/person-details-fields.tsx), rendered identically here and on the Create New
              Employee wizard. The option lists come from lib/person-vocabulary.ts, the same master lists
              core/profile.ts validates saves against, so a value HR can pick is by construction a value
              the server will accept. `mode="form"` keeps these inputs exactly what they were: uncontrolled
              `name`/`defaultValue` selects inside this server-action form, and NO function prop crosses
              the server→client boundary (the r123 fault). */}
          <PersonDetailsFields mode="form" gender={emp.gender} maritalStatus={emp.marital} />
          <p className="text-xs text-muted-foreground sm:col-span-4">{t('maritalPcbNote')}</p>
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveComplianceFields')}</button>
          </div>
        </form>

        {/* Item e3ce0d4d / 55865c32 — Identity Information. IdentityFields (client) renders BOTH sections for
            every employee: Identity No (NRIC) (IcDobAutofill, DOB autofill preserved — item 354a500d/8b5334db)
            AND Passport Information (number/issue/expiry/issuing country/remark). The live nationality from
            IdentityProvider only toggles which document is REQUIRED (Malaysian → NRIC; non-Malaysian → passport
            trio) — the server re-derives this from the person record on save. Both server actions are passed in
            as props (RSC→client pattern). countryOptions reuses the Nationality picker's catalog source for the
            passport's Issuing Country dropdown. */}
        <IdentityFields
          employmentId={emp.employmentId}
          personId={emp.personId}
          icDefault={statutory?.icNumber ?? ''}
          passportNumber={statutory?.passportNumber ?? ''}
          passportIssueDate={statutory?.passportIssueDate ?? ''}
          passportExpiryDate={statutory?.passportExpiryDate ?? ''}
          passportIssuingCountry={statutory?.passportIssuingCountry ?? ''}
          passportRemark={statutory?.passportRemark ?? ''}
          countryOptions={profileOptions.nationality.map((o) => ({ value: o.value, label: o.label }))}
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
          {/* bf953339 — Phone renamed to Mobile Phone Number (label-only; the stored person.phone value is
              untouched) with an optional Home Phone Number beside it. The Correspondence block below keeps
              its OWN independent pair; the perm-/corr- prefixed ids let the "Same as Permanent Address"
              island copy the pair alongside the seven address fields. */}
          <Field label={t('phone')}>
            <input id="perm-mobile-phone" name="phone" defaultValue={emp.phone ?? ''} placeholder="+60…" className={inputCls} />
          </Field>
          <Field label={t('homePhone')}>
            <input id="perm-home-phone" name="homePhone" defaultValue={emp.homePhone ?? ''} className={inputCls} />
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
            {/* bf953339 — the Correspondence block's OWN Mobile/Home pair, independent of the main pair
                above so the correspondence contact can differ. Copied by the "Same as Permanent Address"
                island together with the address fields (perm-/corr- id pairs). */}
            <Field label={t('phone')}>
              <input id="corr-mobile-phone" name="correspondenceMobilePhone" defaultValue={emp.correspondenceMobilePhone ?? ''} className={inputCls} />
            </Field>
            <Field label={t('homePhone')}>
              <input id="corr-home-phone" name="correspondenceHomePhone" defaultValue={emp.correspondenceHomePhone ?? ''} className={inputCls} />
            </Field>
          </div>
          <div className="sm:col-span-4 flex justify-end">
            <button className={btnPrimary}>{t('saveContact')}</button>
          </div>
        </form>
      </Card>

      {emergencyContactPanel}
    </>
  ) : null;

  // ── PAYROLL ────────────────────────────────────────────────────────────────
  // Pay components, CP38, leave encashment, payroll policy assignment, leave balance, compensation,
  // and the Malaysia statutory profile (salary / bank / tax). All admin-only.
  //
  // Item 18719ded — the three sections a reader thinks of as "the Payroll tab" (Basic Salary, Pay Items,
  // CP38) grew at different times and presented themselves three different ways: one Add form pinned
  // under the table, one Add form under a table with an inline single-field editor, one permanently-open
  // form. They now all wear the QUALIFICATION shape (`qualificationPanel` below, the reference the
  // reporter asked us to match): Card + SectionHeader(title, count) → a header strip whose only control
  // is the Add dialog → a plain full-width table → the hint. Presentation only: every server action,
  // every guard and every figure is the one that was there before.
  //
  // ONE money formatter for the whole tab, declared here because the first card that needs it is this
  // one. It used to sit beside the Basic Salary card 1000 lines down; a `const` arrow is in the temporal
  // dead zone until then, and these JSX consts evaluate eagerly, so reading it from up here would throw
  // at render. Pay Items and CP38 previously each rolled their own `Number(x).toFixed(2)` — which is why
  // "RM 12000.00" read differently from the same figure in Basic Salary ("12,000.00").
  const fmtMoney = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Add Pay Item — the SAME <form action={setEmploymentComponentAction}> and the same control names as
  // before, moved from the bottom of the card into the dialog. The STATIC hidden `tab` input is
  // load-bearing: Dialog.Portal reparents the form outside the PersonnelTabs shell, so the shell's
  // capture-phase submit listener never sees it and cannot inject the tab (see the Family tab note).
  const payComponentDialogForm = (
    <form action={setEmploymentComponentAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      <input type="hidden" name="tab" value="payroll" data-tab-tracker="" />
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
      <div className="sm:col-span-2">
        <Field label={t('payComponentRemarks')}>
          <input name="remarks" type="text" placeholder={t('payComponentRemarksPlaceholder')} className={inputCls} />
        </Field>
      </div>
      <div className="flex justify-end sm:col-span-2">
        <button className={btnPrimary}>{t('payComponentSave')}</button>
      </div>
    </form>
  );

  const payComponentsCard = admin && componentCatalog.length > 0 ? (
    <Card id="section-pay-components" className="overflow-hidden">
      <SectionHeader title={t('payComponentsTitle')} count={payComps.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <FamilyFormDialog triggerLabel={t('payComponentAdd')} title={t('payComponentAddTitle')}>
            {payComponentDialogForm}
          </FamilyFormDialog>
        </div>
        {payComps.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('payComponentNone')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('payComponent')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colCurrency')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('payComponentAmount')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colStart')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colEnd')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colProrate')}</th>
                  <th className="py-2 pr-3 font-medium">{t('colRemarks')}</th>
                  <th className="py-2 pr-3 font-medium">{t('status')}</th>
                  <th className="py-2 text-right font-medium">{tFixed('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {payComps.map((pc) => {
                  // An item is ENDED once its inclusive end-date is in the past; otherwise it is ACTIVE.
                  const ended = pc.validTo != null && pc.validTo < today;
                  // Resolved prorate = per-employee override (if set) else the catalog flag.
                  const prorate = pc.prorateOverride ?? pc.prorates;
                  return (
                    <tr key={pc.id} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3">
                        <span className="font-mono text-xs">{pc.code}</span> <span className="text-muted-foreground">{pc.name}</span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{pc.currency}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums">{fmtMoney(Number(pc.amount))}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{pc.validFrom}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{pc.validTo ?? '—'}</td>
                      <td className="py-2 pr-3">{prorate ? t('prorateYes') : t('prorateNo')}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{pc.remarks ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={ended ? 'default' : 'success'}>{ended ? t('statusEnded') : t('statusActive')}</Badge>
                      </td>
                      <td className="py-2 text-right">
                        {/* 2f889bae — the shortcut the reporter asked for. Edit, Stop and Remove already
                            live on the item's own page; this tab was read-only and gave no way through to
                            it. Same href shape and classes as fixed-list.tsx, so the two entry points stay
                            one destination rather than drifting apart. Every row gets a link, BASIC
                            included — that is what Fixed Transactions itself does, and inventing a filter
                            this item did not ask for would be the surprise. Note Basic Salary also has its
                            own card with its own View/Edit on this tab, so BASIC has two routes to one
                            figure; deliberate, and recorded rather than silently filtered. */}
                        <Link
                          href={`/payroll/transactions/fixed/${pc.id}?employmentId=${encodeURIComponent(employmentId)}`}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          {tFixed('viewEdit')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {/* 2f889bae — THE ROW LINK IS NEW, AND THE REASON THIS TABLE USED TO HAVE NONE IS GONE. Do not
          revert it on the strength of the old comment that stood here.
          That comment said a per-row Edit was omitted because `setEmploymentPayComponent` closed the open
          row AT `effectiveFrom`, leaving BOTH rows inside the period's window so the kernel paid the item
          twice. Two shipped changes retired that reason: r180's `34cc8137` now closes the prior row the
          day BEFORE the new start, and r185's `2aed39d4` added `employment_pay_component_no_overlap`, an
          EXCLUDE constraint that makes two live rows covering one day impossible at the database. The
          one-click duplicate it feared is separately closed — `updateEmploymentPayComponent` passes the
          row's own id as `replacesId`, so re-saving the open form VERSIONS the row instead of cloning it.
          Its recommended alternative was never the safer route either: "Add a dated revision here" posts
          through this page's own actions into the very same writer.
          WHAT IS STILL TRUE, AND IS SOMEONE ELSE'S ITEM: restating an item MID-MONTH still pays both
          lines in full, because two adjacent windows both overlap the month and the kernel pays each
          returned row its full amount. That is pinned as an `it.fails` in test/fixed-transaction.test.ts
          and raised with the reporter as `a3d485f6` — it is a design decision (prorate, latest-row-wins,
          or refuse a mid-period restatement), not something a default value on this link could fix. */}
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('payComponentsHint')}</p>
    </Card>
  ) : null;

  // One dialog form for Add (r null) and Edit — the Qualification tab's dialogForm pattern. Both post to
  // the actions that were already here (addCp38Action / editCp38Action), so the processed-period refusal
  // is untouched: updateCp38 guards BOTH the stored window and the proposed one with
  // assertNoProcessedPeriod, and a Cp38PeriodProcessedError still comes back as `?cp38Error=processed`
  // and paints the banner above the table. Edit now offers the whole record rather than the amount alone
  // — that is not a widening: updateCp38 has always accepted every one of these fields, the old inline
  // editor simply omitted them, so a wrong reference or end date meant deleting the row and re-keying it.
  // Derived from the loader rather than imported, so this restyle adds no new core/* import to the page
  // (ADR-0080 drift ratchet — the allowlist only ever shrinks).
  type Cp38Record = (typeof cp38Records)[number];
  const cp38DialogForm = (r: Cp38Record | null) => (
    <form action={r ? editCp38Action : addCp38Action} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      {r && <input type="hidden" name="id" value={r.id} />}
      <input type="hidden" name="tab" value="payroll" data-tab-tracker="" />
      <Field label={t('cp38Ref')}>
        <input name="cp38Ref" required defaultValue={r?.cp38Ref ?? ''} placeholder={t('cp38RefPlaceholder')} className={inputCls} />
      </Field>
      <Field label={t('cp38Amount')}>
        <input
          name="amount"
          type="number"
          min="0"
          step="0.01"
          required
          defaultValue={r ? Number(r.amount).toFixed(2) : ''}
          className={inputCls}
        />
      </Field>
      <Field label={t('cp38From')}>
        <input name="validFrom" type="date" required defaultValue={r?.validFrom ?? thisMonthStart} className={inputCls} />
      </Field>
      <Field label={t('cp38To')}>
        <input name="validTo" type="date" defaultValue={r?.validTo ?? ''} className={inputCls} />
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('cp38Remarks')}>
          <input name="remarks" type="text" defaultValue={r?.remarks ?? ''} placeholder={t('cp38RemarksPlaceholder')} className={inputCls} />
        </Field>
      </div>
      <div className="flex justify-end sm:col-span-2">
        <button className={btnPrimary}>{r ? t('cp38Save') : t('cp38Add')}</button>
      </div>
    </form>
  );

  // View: the SAME fields, disabled inside a fieldset with no <form> — the Qualification tab's
  // viewDialogBody pattern (a read-only view that can never drift from Edit, and can never post). This is
  // how a CLOSED row is readable at all: its Edit and Terminate are hidden, and before this the only way
  // to see its reference, dates and remarks was to read them off the table.
  const cp38ViewBody = (r: Cp38Record) => (
    <fieldset disabled>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
        <Field label={t('cp38Ref')}>
          <input defaultValue={r.cp38Ref} className={inputCls} />
        </Field>
        <Field label={t('cp38Amount')}>
          <input defaultValue={fmtMoney(Number(r.amount))} className={inputCls} />
        </Field>
        <Field label={t('cp38From')}>
          <input defaultValue={r.validFrom} className={inputCls} />
        </Field>
        <Field label={t('cp38To')}>
          <input defaultValue={r.validTo ?? t('cp38Open')} className={inputCls} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('cp38Remarks')}>
            <input defaultValue={r.remarks ?? ''} className={inputCls} />
          </Field>
        </div>
      </div>
    </fieldset>
  );

  const cp38Card = admin ? (
    <Card id="section-cp38" className="overflow-hidden">
      <SectionHeader title={t('cp38Title')} count={cp38Records.length} />
      {/* The processed-period refusal. Kept ABOVE the table and outside the restyle on purpose:
          cp38Error === 'processed' is a real refusal from the service, not a validation hint. */}
      {cp38Error === 'processed' && (
        <p className="mx-4 mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {t('cp38ProcessedError')}
        </p>
      )}
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <FamilyFormDialog triggerLabel={t('cp38Add')} title={t('cp38AddTitle')}>
            {cp38DialogForm(null)}
          </FamilyFormDialog>
        </div>
        {cp38Records.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('cp38None')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('cp38Ref')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('cp38Amount')}</th>
                  <th className="py-2 pr-3 font-medium">{t('cp38From')}</th>
                  <th className="py-2 pr-3 font-medium">{t('cp38To')}</th>
                  <th className="py-2 pr-3 font-medium">{t('cp38Remarks')}</th>
                  <th className="py-2 pr-3 font-medium">{t('cp38Status')}</th>
                  <th className="py-2 text-right font-medium">{t('cp38Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {cp38Records.map((r) => {
                  // CLOSED once superseded, or once its inclusive end-date is before this month. Otherwise ACTIVE.
                  const closed =
                    r.supersededAt != null || (r.validTo != null && r.validTo < thisMonthStart);
                  // A closed/superseded row's period is historical → its edit/terminate is hidden (the
                  // service guard would also block any processed period).
                  return (
                    <tr key={r.id} className="border-b border-border/60 align-top">
                      <td className="py-2 pr-3 font-mono text-xs">{r.cp38Ref}</td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right font-medium tabular-nums">{fmtMoney(Number(r.amount))}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{r.validFrom}</td>
                      <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{r.validTo ?? t('cp38Open')}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.remarks ?? '—'}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={closed ? 'default' : 'success'}>
                          {closed ? t('cp38StatusClosed') : t('cp38StatusActive')}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <div className="flex items-center justify-end gap-2">
                          <FamilyFormDialog
                            triggerLabel={t('cp38View')}
                            triggerVariant="outline"
                            title={t('cp38ViewTitle')}
                          >
                            {cp38ViewBody(r)}
                          </FamilyFormDialog>
                          {!closed && (
                            <>
                              <FamilyFormDialog
                                triggerLabel={t('cp38Edit')}
                                triggerVariant="outline"
                                title={t('cp38EditTitle')}
                              >
                                {cp38DialogForm(r)}
                              </FamilyFormDialog>
                              {/* Terminate stays a plain submit inside the tab shell (the shell's capture
                                  listener injects the tab). It is NOT wrapped in a confirmation: adding
                                  one would be a behaviour change, and this restyle changes nothing that
                                  writes. */}
                              <form action={terminateCp38Action}>
                                <input type="hidden" name="employmentId" value={emp.employmentId} />
                                <input type="hidden" name="id" value={r.id} />
                                <Button variant="destructive" size="sm">{t('cp38Terminate')}</Button>
                              </form>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('cp38Hint')}</p>
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
  // Personnel — Family & Dependents Information. ea36b7fa: the three per-relationship sections (Spouse /
  // Children / Other Dependants, from 4535b733 → 5988053a → 33a5ce41) are CONSOLIDATED into ONE card: a
  // single table of every family member plus a single Add Family Member dialog where the Relationship is
  // picked FIRST and the form adapts to it (FamilyRelationshipFields island swapping server-rendered field
  // panels). Admin-maintained (RLS is_admin write) and distinct from the emergency contact. Since R46
  // 47146ea3, child rows DO feed employee_statutory_my.num_children when child_relief_mode === 'auto'
  // (syncChildReliefFromFamily); 'manual' persons keep full human control. Spouse-only (marriage / spouse
  // employment) and child-only (education / relief) fields render only in their own panel; custom catalog
  // relationship types get the standard panel (the server NULLs the gated columns for them anyway).
  // Sort: spouse first, then children / parents / siblings, then other + custom types, then by
  // relationship and name — one scannable list, stable across edits.
  const relationshipRank = (r: string) =>
    r === 'spouse' ? 0 : r === 'child' ? 1 : r === 'parent' ? 2 : r === 'sibling' ? 3 : 4;
  const familyMembers = [...dependents].sort(
    (x, y) =>
      relationshipRank(x.relationship) - relationshipRank(y.relationship) ||
      x.relationship.localeCompare(y.relationship) ||
      x.fullName.localeCompare(y.fullName),
  );
  // Multi-line inputs (residential / employer address) — same look as inputCls but taller, auto-height.
  const taCls = `${inputCls.replace('h-9', 'min-h-16')} py-2`;
  type FamilySection = 'spouse' | 'child' | 'other';
  // Which field panel a relationship gets — mirrors core/dependents.ts extraColumnsForAdd: spouse and child
  // have their own panels, EVERYTHING else (built-in or custom catalog type) gets the standard one.
  const panelOf = (r: string): FamilySection => (r === 'spouse' ? 'spouse' : r === 'child' ? 'child' : 'other');
  // ea36b7fa — the Relationship dropdown is catalog-backed (System Labels > Profile Options, category
  // dependentRelationship). Built-in values keep their static i18n labels (6-locale coverage); custom
  // values are data-labelled from the catalog. An unseeded/empty catalog falls back to the five built-ins,
  // so the dropdown never goes blank. Deactivating an option hides it from NEW picks only — an edited row
  // whose stored value is no longer active still renders (and re-saves) via the merge below.
  const dependentRelationshipLabels = new Map(profileOptions.dependentRelationship.map((o) => [o.value, o.label]));
  const familyRelationshipLabel = (r: string) =>
    (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(r)
      ? relationshipLabel(r)
      : (dependentRelationshipLabels.get(r) ?? r);
  const activeRelationshipOptions =
    profileOptions.dependentRelationship.length > 0
      ? profileOptions.dependentRelationship.map((o) => ({
          value: o.value,
          label: (DEPENDENT_RELATIONSHIPS as readonly string[]).includes(o.value) ? relationshipLabel(o.value) : o.label,
        }))
      : DEPENDENT_RELATIONSHIPS.map((r) => ({ value: r, label: relationshipLabel(r) }));
  const relationshipOptionsFor = (d: DependentRow | null) =>
    d && !activeRelationshipOptions.some((o) => o.value === d.relationship)
      ? [...activeRelationshipOptions, { value: d.relationship, label: familyRelationshipLabel(d.relationship) }]
      : activeRelationshipOptions;

  // A tri-state checkbox: a hidden `${name}__present` marker lets the server tell "unticked" (posts
  // nothing) apart from "field absent on this section's form".
  const familyCheckbox = (name: string, checked: boolean, label: string) => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <input type="hidden" name={`${name}__present`} value="1" />
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );

  // Item 5988053a — whole-year age comes from the ONE shared rule in core/dependents.ts (childAgeYears),
  // also used by the isChildReliefEligible predicate, so the form, the table and payroll can never disagree
  // on a child's age. (Formerly a private dobAgeYears copy here.)

  // Dialog fieldset chrome (child Add/Edit dialog only).
  const fieldsetCls = 'rounded-lg border border-border p-3';
  const legendCls = 'px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground';

  // Shared field inputs for one dependent form PANEL. `section` selects which grouped fields appear; `d`
  // is the existing row (null on the Add form). Every control is named exactly as its server-side field —
  // the names (and the `__present` tri-state markers) are load-bearing for dependent-actions.ts.
  // ea36b7fa — the relationship control itself no longer lives here: the unified dialog's
  // FamilyRelationshipFields island renders the single `name="relationship"` select FIRST and swaps these
  // panels beneath it (inactive panels are disabled, so their duplicate field names never post).
  // Item 5988053a — the CHILD section is regrouped into three labelled fieldsets (Personal / Education /
  // Tax Relief); the spouse and other sections keep the original flat two-column grid untouched.
  const dependentFields = (section: FamilySection, d: DependentRow | null) => {
    const nameField = (
      <Field label={t('family.name')}>
        <input name="fullName" required defaultValue={d?.fullName ?? ''} placeholder={t('family.namePlaceholder')} className={inputCls} />
      </Field>
    );
    const genderField = (
      <Field label={t('family.genderLabel')}>
        <select name="gender" defaultValue={d?.gender ?? ''} className={inputCls}>
          <option value="">{t('family.genderUnset')}</option>
          {DEPENDENT_GENDERS.map((g) => (<option key={g} value={g}>{genderLabel(g)}</option>))}
        </select>
      </Field>
    );
    const dobField = (
      <Field label={t('family.dateOfBirth')}>
        <input name="dateOfBirth" type="date" defaultValue={d?.dateOfBirth ?? ''} className={inputCls} />
      </Field>
    );
    const phoneField = (
      <Field label={t('family.contactNumber')}>
        <input name="phone" type="tel" defaultValue={d?.phone ?? ''} className={inputCls} />
      </Field>
    );
    const icField = (
      <Field label={section === 'child' ? t('family.icOrBirthCert') : t('family.newIc')}>
        <input name="icOrPassport" defaultValue={d?.icOrPassport ?? ''} className={inputCls} />
      </Field>
    );
    const remarksField = (
      <Field label={t('family.remarks')}>
        <input name="remarks" type="text" defaultValue={d?.remarks ?? ''} placeholder={t('family.remarksPlaceholder')} className={inputCls} />
      </Field>
    );

    if (section === 'child') {
      return (
        <>
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>{t('family.sectionPersonal')}</legend>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
              {nameField}
              {genderField}
              {dobField}
              {phoneField}
              {icField}
              {remarksField}
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
                {familyCheckbox('isBeneficiary', d?.isBeneficiary ?? false, t('family.beneficiary'))}
                {familyCheckbox('isDeceased', d?.isDeceased ?? false, t('family.deceasedStatus'))}
              </div>
            </div>
          </fieldset>
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>{t('family.sectionEducation')}</legend>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
              <Field label={t('family.schoolName')}>
                <input name="schoolName" defaultValue={d?.schoolName ?? ''} className={inputCls} />
              </Field>
              <Field label={t('family.studyLevel')}>
                <input name="studyLevel" defaultValue={d?.studyLevel ?? ''} className={inputCls} />
              </Field>
              <Field label={t('family.studyCountry')}>
                <ProfileOptionSelect
                  name="studyCountry"
                  value={d?.studyCountry}
                  options={profileOptions.country}
                  placeholder={t('family.genderUnset')}
                  legacySuffix={t('optionLegacySuffix')}
                />
              </Field>
              <div className="flex items-end pb-1">
                {familyCheckbox('isStudent', d?.isStudent ?? false, t('family.studentStatus'))}
              </div>
            </div>
          </fieldset>
          {/* Item 6c635212 → R46 47146ea3 — Malaysia Income Tax Child Relief (PCB / TP1). Per-child relief
              category, claim flag and 100|50 share. Age is derived read-only from DOB to guide the category
              choice (the FamilyFormDialog island refreshes it live while a DOB is typed; the note is static
              guidance and the category is NEVER auto-filled from an age-based guess). Since R46 removed the
              "Use {count}" approval button, when employee_statutory_my.child_relief_mode === 'auto' the
              derived eligible-child head count DOES flow straight into num_children on save (see
              syncChildReliefFromFamily in core/dependents.ts and its four rails); on 'manual' the tax figure
              stays fully human-controlled. */}
          <fieldset className={fieldsetCls}>
            <legend className={legendCls}>
              <span className="inline-flex items-center gap-1.5">
                {t('family.sectionTaxRelief')}
                <span
                  className="inline-flex size-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground"
                  title={t('family.childReliefGuidance')}
                  aria-label={t('family.childReliefGuidance')}
                >
                  i
                </span>
              </span>
            </legend>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
              <Field label={t('family.childReliefCategory')}>
                <select name="childReliefCategory" defaultValue={d?.childReliefCategory ?? ''} className={inputCls}>
                  <option value="">{t('family.childReliefCategoryUnset')}</option>
                  {CHILD_RELIEF_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{t(`family.childReliefCat_${c}`)}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('family.childReliefPercentage')}>
                <select
                  name="childReliefPercentage"
                  defaultValue={d?.childReliefPercentage != null ? String(d.childReliefPercentage) : ''}
                  className={inputCls}
                >
                  <option value="">{t('family.childReliefCategoryUnset')}</option>
                  <option value="100">{t('family.childReliefPct_100')}</option>
                  <option value="50">{t('family.childReliefPct_50')}</option>
                </select>
              </Field>
              <Field label={t('family.childAge')}>
                <input
                  readOnly
                  disabled
                  data-child-age=""
                  value={childAgeYears(d?.dateOfBirth) ?? '—'}
                  className={`${inputCls} bg-muted/50`}
                />
              </Field>
              <div className="flex items-end pb-1">
                {familyCheckbox('childTaxRelief', d?.childTaxRelief ?? false, t('family.childTaxRelief'))}
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('family.ageHint')}</p>
          </fieldset>
        </>
      );
    }

    // Spouse / Other — the original flat two-column grid, unchanged.
    return (
      <>
        {nameField}
        {genderField}
        {dobField}
        {phoneField}
        {icField}
        <Field label={t('family.passportNumber')}>
          <input name="passportNumber" defaultValue={d?.passportNumber ?? ''} className={inputCls} />
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('family.residentialAddress')}>
            <textarea name="residentialAddress" rows={2} defaultValue={d?.residentialAddress ?? ''} className={taCls} />
          </Field>
        </div>
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
        {remarksField}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
          {familyCheckbox('isBeneficiary', d?.isBeneficiary ?? false, t('family.beneficiary'))}
          {section === 'spouse' && familyCheckbox('spouseWorking', d?.spouseWorking ?? false, t('family.currentlyWorking'))}
          {familyCheckbox('isDeceased', d?.isDeceased ?? false, t('family.deceasedStatus'))}
        </div>
      </>
    );
  };

  // ea36b7fa — ONE dialog form for every family member (Add when d is null, Edit otherwise), posting to
  // the SAME server actions as before. The FamilyRelationshipFields island renders the Relationship select
  // FIRST, then swaps the three server-rendered field panels beneath it (spouse grid / child fieldsets /
  // standard grid); inactive panels are disabled+hidden so their duplicate field names and `__present`
  // markers never reach the post. On Add nothing shows until a relationship is chosen.
  // TAB RETENTION (feedback bd2f0bb2): Dialog.Portal reparents this form to document.body — OUTSIDE the
  // PersonnelTabs shell — so the shell's capture-phase submit listener never sees it (shell.contains(form)
  // is false) and would never inject the hidden `tab` field; without the STATIC hidden input below, every
  // dialog save would redirect back to the Profile tab. Giving it data-tab-tracker means that if this form
  // ever does sit inside the shell, the listener finds and reuses this input instead of appending a
  // duplicate `tab` field.
  const dialogForm = (d: DependentRow | null) => (
    <form action={d ? editDependentAction : addDependentAction} className="space-y-4">
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      {d ? (
        <input type="hidden" name="id" value={d.id} />
      ) : (
        <input type="hidden" name="personId" value={emp.personId} />
      )}
      <input type="hidden" name="tab" value="family" data-tab-tracker="" />
      <FamilyRelationshipFields
        label={t('family.relationship')}
        placeholder={t('family.relationshipPlaceholder')}
        options={relationshipOptionsFor(d)}
        initialValue={d?.relationship ?? ''}
        spousePanel={<div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">{dependentFields('spouse', d)}</div>}
        childPanel={<div className="space-y-4">{dependentFields('child', d)}</div>}
        otherPanel={<div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">{dependentFields('other', d)}</div>}
      />
      <div className="flex justify-end">
        <button className={btnPrimary}>{d ? t('family.save') : t('family.add')}</button>
      </div>
    </form>
  );

  // Item 33a5ce41 — View: the SAME server-rendered fields, disabled inside a fieldset, with NO <form>
  // element and no submit button. Rendering exactly the Edit layout means the read-only view can never
  // drift from the form — and with no form it can never post. (The fieldset only carries `disabled`; the
  // layout container is the inner div, since fieldset flex/grid support is historically unreliable.)
  // ea36b7fa — the stored relationship renders as a read-only input (catalog/i18n label), and only the
  // matching panel is rendered, so no island is needed for a static view.
  const viewDialogBody = (d: DependentRow) => {
    const section = panelOf(d.relationship);
    return (
      <fieldset disabled>
        <div className={section === 'child' ? 'space-y-4' : 'grid grid-cols-1 items-end gap-3 sm:grid-cols-2'}>
          <Field label={t('family.relationship')}>
            <input readOnly value={familyRelationshipLabel(d.relationship)} className={inputCls} />
          </Field>
          {dependentFields(section, d)}
        </div>
      </fieldset>
    );
  };

  // ea36b7fa — the ONE consolidated Family & Dependents Information table (replaces the three
  // per-relationship sections). Columns per the request (Name / Relationship / Date of birth / Age /
  // Contact / tax-relief flag / actions); rows are pre-sorted spouse-first (familyMembers above). The
  // tax-relief column uses the SAME per-row predicate the payroll head count uses (core/dependents.ts
  // isChildReliefEligible), so the display can never diverge from what drives tax; non-child rows show a
  // dash. Age is SERVER-derived (childAgeYears): a client derivation would run Date.now() once at SSR and
  // again at hydration, which can differ across midnight or a timezone offset. Per-relationship detail
  // (occupation, education, IC, relief category, …) lives in the View dialog — the row itself stays
  // scannable.
  const familyMembersSection = (
    <section className="border-t border-border">
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
        <FamilyFormDialog triggerLabel={t('family.add')} title={t('family.addFamilyTitle')}>
          {dialogForm(null)}
        </FamilyFormDialog>
      </div>
      {familyMembers.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">{t('family.none')}</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full min-w-[52rem] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">{t('family.name')}</th>
                <th className="py-2 pr-3 font-medium">{t('family.relationship')}</th>
                <th className="py-2 pr-3 font-medium">{t('family.dateOfBirth')}</th>
                <th className="py-2 pr-3 font-medium">{t('family.childAge')}</th>
                <th className="py-2 pr-3 font-medium">{t('family.contactNumber')}</th>
                <th className="py-2 pr-3 font-medium">{t('family.countsTowardRelief')}</th>
                <th className="py-2 text-right font-medium">{t('family.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {familyMembers.map((d) => (
                <tr key={d.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3 font-medium">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {d.fullName}
                      {d.isBeneficiary && <Badge variant="success">{t('family.beneficiary')}</Badge>}
                      {d.isDeceased && <Badge variant="default">{t('family.deceased')}</Badge>}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{familyRelationshipLabel(d.relationship)}</td>
                  <td className="whitespace-nowrap py-2 pr-3">{d.dateOfBirth ?? '—'}</td>
                  <td className="py-2 pr-3">{childAgeYears(d.dateOfBirth) ?? '—'}</td>
                  <td className="py-2 pr-3">{d.phone ?? '—'}</td>
                  <td className="py-2 pr-3">
                    {d.relationship === 'child' ? (isChildReliefEligible(d) ? t('family.yes') : t('family.no')) : '—'}
                  </td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-2">
                      <FamilyFormDialog
                        triggerLabel={t('family.view')}
                        triggerVariant="outline"
                        title={t('family.viewFamilyTitle')}
                      >
                        {viewDialogBody(d)}
                      </FamilyFormDialog>
                      <FamilyFormDialog
                        triggerLabel={t('family.edit')}
                        triggerVariant="outline"
                        title={t('family.editFamilyTitle')}
                      >
                        {dialogForm(d)}
                      </FamilyFormDialog>
                      {/* Delete keeps tab retention with no extra work: this form lives INSIDE the tab
                          shell, and ConfirmSubmit's confirm calls requestSubmit() on it, firing a bubbling
                          submit event the shell's capture listener does see. */}
                      <form action={archiveDependentAction}>
                        <input type="hidden" name="employmentId" value={emp.employmentId} />
                        <input type="hidden" name="id" value={d.id} />
                        <ConfirmSubmit
                          size="sm"
                          variant="destructive"
                          title={t('family.deleteFamilyConfirmTitle')}
                          description={t('family.deleteFamilyConfirmBody')}
                          confirmLabel={t('family.delete')}
                        >
                          {t('family.delete')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const familyPanel = admin ? (
    <Card id="section-family" className="overflow-hidden">
      <SectionHeader title={t('family.title')} count={dependents.length} />
      <p className="mx-4 mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        {t('family.note')}
      </p>
      <div className="mt-3">
        {familyMembersSection}
      </div>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('family.hint')}</p>
    </Card>
  ) : null;

  // ── QUALIFICATION ──────────────────────────────────────────────────────────
  // Feedback a949184a — the employee's academic / professional qualification history, mirroring the Family
  // tab's list-and-dialog pattern: one summary table (Qualification / Institute / Major / Graduation Date /
  // Highest) + a single Add Qualification dialog posting to the event-logged core service. The Qualification
  // dropdown is catalog-backed (System Labels > Profile Options, category qualificationLevel) with the
  // standard legacy-value merge: a stored value whose option was deactivated/renamed still renders (and
  // re-saves) pre-selected. Exactly ONE record can be the Highest Qualification — ticking it on save
  // transfers the flag from the previous holder (core/qualifications.ts, backstopped by a partial unique
  // index). Rows arrive pre-sorted from the service: most recent graduation first, in-progress last.
  const qualificationLevelLabels = new Map(profileOptions.qualificationLevel.map((o) => [o.value, o.label]));
  const qualificationLabelOf = (v: string) => qualificationLevelLabels.get(v) ?? v;
  const qualificationOptions = profileOptions.qualificationLevel.map((o) => ({ value: o.value, label: o.label }));
  const qualificationOptionsFor = (q: QualificationRow | null) =>
    q && !qualificationOptions.some((o) => o.value === q.qualification)
      ? [
          ...qualificationOptions,
          { value: q.qualification, label: `${q.qualification} ${t('optionLegacySuffix')}` },
        ]
      : qualificationOptions;

  // Shared field inputs for one qualification form (Add when q is null, Edit otherwise). Control names are
  // load-bearing for qualification-actions.ts. HTML `required` on the level select + max-length guards are
  // the client-side floor; the service re-validates (active catalog, YYYY-MM periods, From ≤ To,
  // Graduation ≥ From) on save.
  const qualificationFields = (q: QualificationRow | null) => (
    <>
      <Field label={t('qualification.level')}>
        <select name="qualification" required defaultValue={q?.qualification ?? ''} className={inputCls}>
          <option value="">{t('qualification.levelPlaceholder')}</option>
          {qualificationOptionsFor(q).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
      <Field label={t('qualification.institute')}>
        <input name="institute" defaultValue={q?.institute ?? ''} className={inputCls} />
      </Field>
      <Field label={t('qualification.fromYm')}>
        <input name="fromYm" type="month" defaultValue={q?.fromYm ?? ''} className={inputCls} />
      </Field>
      <Field label={t('qualification.toYm')}>
        <input name="toYm" type="month" defaultValue={q?.toYm ?? ''} className={inputCls} />
      </Field>
      <Field label={t('qualification.graduationDate')}>
        <input name="graduationDate" type="date" defaultValue={q?.graduationDate ?? ''} className={inputCls} />
      </Field>
      <Field label={t('qualification.major')}>
        <input name="major" defaultValue={q?.major ?? ''} className={inputCls} />
      </Field>
      <Field label={t('qualification.result')}>
        <input name="result" defaultValue={q?.result ?? ''} placeholder={t('qualification.resultPlaceholder')} className={inputCls} />
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('qualification.description')}>
          <textarea name="description" rows={2} defaultValue={q?.description ?? ''} className={taCls} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 self-end pb-1 sm:col-span-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" name="isHighest" defaultChecked={q?.isHighest ?? false} />
          {t('qualification.highest')}
        </label>
      </div>
      <p className="text-xs text-muted-foreground sm:col-span-2">{t('qualification.highestHint')}</p>
    </>
  );

  // One dialog form for Add (q null) and Edit — the Family tab's dialogForm pattern. The STATIC hidden
  // `tab` input keeps the post-save redirect on this tab (Dialog.Portal reparents the form outside the
  // PersonnelTabs shell, so the shell's submit listener never sees it — see the Family tab note).
  const qualificationDialogForm = (q: QualificationRow | null) => (
    <form action={q ? editQualificationAction : addQualificationAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      {q && <input type="hidden" name="id" value={q.id} />}
      <input type="hidden" name="tab" value="qualification" data-tab-tracker="" />
      {qualificationFields(q)}
      <div className="flex justify-end sm:col-span-2">
        <button className={btnPrimary}>{q ? t('qualification.save') : t('qualification.add')}</button>
      </div>
    </form>
  );

  // View: the SAME server-rendered fields, disabled inside a fieldset with no <form> — the Family tab's
  // viewDialogBody pattern (the read-only view can never drift from the Edit layout, and can never post).
  const qualificationViewBody = (q: QualificationRow) => (
    <fieldset disabled>
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">{qualificationFields(q)}</div>
    </fieldset>
  );

  const qualificationPanel = admin ? (
    <Card id="section-qualification" className="overflow-hidden">
      <SectionHeader title={t('qualification.title')} count={qualifications.length} />
      <section className="border-t border-border">
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <FamilyFormDialog triggerLabel={t('qualification.add')} title={t('qualification.addTitle')}>
            {qualificationDialogForm(null)}
          </FamilyFormDialog>
        </div>
        {qualifications.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('qualification.none')}</p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('qualification.level')}</th>
                  <th className="py-2 pr-3 font-medium">{t('qualification.institute')}</th>
                  <th className="py-2 pr-3 font-medium">{t('qualification.major')}</th>
                  <th className="py-2 pr-3 font-medium">{t('qualification.graduationDate')}</th>
                  <th className="py-2 pr-3 font-medium">{t('qualification.highestColumn')}</th>
                  <th className="py-2 text-right font-medium">{t('qualification.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {qualifications.map((q) => (
                  <tr key={q.id} className="border-b border-border/60 align-top">
                    <td className="py-2 pr-3 font-medium">{qualificationLabelOf(q.qualification)}</td>
                    <td className="py-2 pr-3">{q.institute ?? '—'}</td>
                    <td className="py-2 pr-3">{q.major ?? '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{q.graduationDate ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {q.isHighest ? <Badge variant="success">{t('qualification.highestBadge')}</Badge> : '—'}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center justify-end gap-2">
                        <FamilyFormDialog
                          triggerLabel={t('qualification.view')}
                          triggerVariant="outline"
                          title={t('qualification.viewTitle')}
                        >
                          {qualificationViewBody(q)}
                        </FamilyFormDialog>
                        <FamilyFormDialog
                          triggerLabel={t('qualification.edit')}
                          triggerVariant="outline"
                          title={t('qualification.editTitle')}
                        >
                          {qualificationDialogForm(q)}
                        </FamilyFormDialog>
                        {/* Delete lives INSIDE the tab shell, so ConfirmSubmit's requestSubmit() fires a
                            bubbling submit the shell's capture listener sees (tab retention for free). */}
                        <form action={archiveQualificationAction}>
                          <input type="hidden" name="employmentId" value={emp.employmentId} />
                          <input type="hidden" name="id" value={q.id} />
                          <ConfirmSubmit
                            size="sm"
                            variant="destructive"
                            title={t('qualification.deleteConfirmTitle')}
                            description={t('qualification.deleteConfirmBody')}
                            confirmLabel={t('qualification.delete')}
                          >
                            {t('qualification.delete')}
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="px-4 pb-4 pt-2 text-xs text-muted-foreground">{t('qualification.hint')}</p>
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
  // mirrors the payroll-policy assignment card. (It was relocated OUT of the Employment tab onto the
  // Attendance tab by 1fbe9891 — the note that used to say otherwise here was stale.)
  //
  // 18504ca6 — the card is now EFFECTIVE-DATED, matching the Location card directly above it. Saving adds a
  // dated period instead of overwriting: the previous shift is kept and closed off the day before, and the
  // Shift history list underneath says who moved the employee, from what, and from when.
  const defaultShiftCard = admin && !emp.terminatedOn ? (
    <Card id="section-default-shift">
      <SectionHeader title={t('shiftTypeTitle')} />
          <form action={setDefaultShiftAction} className="space-y-3 p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            {/* R17 3e8350db — Shift Type (Fixed / Roster) with a conditionally-shown Default shift picker.
                18504ca6 — plus the required Effective date, on the same row. */}
            <EmployeeShiftFields
              defaultType={emp.shiftType}
              defaultShiftId={emp.defaultShiftId}
              defaultEffectiveFrom={today}
              shifts={assignableShifts.map((sh) => ({
                id: sh.id,
                label: `${sh.code ?? '—'} — ${sh.name} (${sh.startTime.slice(0, 5)}–${sh.endTime.slice(0, 5)})`,
              }))}
            />
            <button className={btnPrimary}>{t('defaultShiftSave')}</button>
          </form>
          <p className="px-4 pb-3 text-xs text-muted-foreground">{t('shiftTypeHint')}</p>
          {/* 18504ca6 — Shift history: effective date, previous shift, new shift, who, when. The employee is
              the profile already open, so there is no name column. LIVE periods only — a second save for the
              same date REPLACES its entry rather than adding a line. */}
          <section className="border-t border-border">
            <div className="px-4 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shiftHistoryTitle')}
            </div>
            {shiftHistory.length === 0 ? (
              <p className="px-4 pb-4 pt-2 text-sm text-muted-foreground">{t('shiftHistoryEmpty')}</p>
            ) : (
              <div className="overflow-x-auto px-4 pb-4 pt-2">
                <table className="w-full min-w-[52rem] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">{t('shiftHistoryColEffective')}</th>
                      <th className="py-2 pr-3 font-medium">{t('shiftHistoryColPrevious')}</th>
                      <th className="py-2 pr-3 font-medium">{t('shiftHistoryColNew')}</th>
                      <th className="py-2 pr-3 font-medium">{t('shiftHistoryColChangedBy')}</th>
                      <th className="py-2 font-medium">{t('shiftHistoryColChangedOn')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftHistory.map((h) => (
                      <tr key={h.id} className="border-b border-border/60 align-top">
                        <td className="py-2 pr-3 whitespace-nowrap text-foreground">{h.effectiveFrom}</td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {h.previousShiftName
                            ? `${h.previousShiftCode ?? '—'} — ${h.previousShiftName}`
                            : '—'}
                        </td>
                        <td className="py-2 pr-3 text-foreground">
                          {`${h.shiftCode ?? '—'} — ${h.shiftName}`}
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">{h.changedByName ?? '—'}</td>
                        <td className="py-2 whitespace-nowrap text-muted-foreground">
                          {h.recordedOnRelease
                            ? t('shiftHistoryRecordedOnRelease')
                            : h.changedAt.slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
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
                // 1fff489c step 10 — pre-ticked from the confirmed (or suggested) location when the
                // employee has nothing assigned yet. Seeds the control only; the save is still a full-set
                // replace of whatever is ticked at submit time.
                defaultValue={clockingDefaultIds}
                className={`${inputCls} h-28`}
              >
                {clockingLocations.map((cl) => (
                  <option key={cl.id} value={cl.id}>
                    {cl.locationCode ? `${cl.locationCode} · ` : ''}
                    {cl.name}
                    {cl.radiusM != null ? ` · ${tc('withinRadius', { radius: cl.radiusM })}` : ''}
                  </option>
                ))}
                {/* The mockup's third line. A location with no points yet is shown DISABLED — it can
                    never be ticked or submitted (there is nothing to clock at), but leaving it out made
                    a configured location look like it did not exist. */}
                {locationsWithNoPoints.map((l) => (
                  <option key={`nopoints-${l.id}`} value="" disabled>
                    {`${l.code} · ${l.name} · ${tc('noPointsYet')}`}
                  </option>
                ))}
              </select>
            </Field>
            {/* The four distinct empty states (spec section E). Today all four render as one blank field,
                which is the reporter's actual complaint: "No location" cannot be acted on because it does
                not say WHICH thing is missing. States 1, 3 and 4 live here; state 2 (branch not mapped)
                is on the Work Location card above, where the branch is the thing to fix. */}
            {locations.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tc('noCompanyLocations')}</p>
            ) : resolvedLocationPointCount === 0 ? (
              <p className="text-xs text-muted-foreground">{tc('noSites')}</p>
            ) : assignedClockingLocationIds.size === 0 && emp.locationId ? (
              <p className="text-xs text-muted-foreground">{tc('noAssignedSites')}</p>
            ) : null}
            <button className={btnPrimary}>{tc('save')}</button>
          </form>
          <form action={setGeofencingAction} className="flex flex-wrap items-end gap-3 border-t border-border p-4">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <label className="flex items-center gap-2 pb-2 text-sm text-muted-foreground">
              <input type="checkbox" name="enabled" defaultChecked={emp.geofencingEnabled} />
              {tc('geofencingToggle')}
            </label>
            {/* 1fff489c — this is now an OPTIONAL OVERRIDE, not the radius. Each site carries its own
                allowed distance; leaving this blank (the recommended setting, and the new default for an
                employee who has never had one) means "use each site's own radius". Filling it in replaces
                every site's figure FOR THIS PERSON. Hence no defaultValue of 300 any more — pre-filling a
                number here would silently override eight correctly-tuned sites on the next save. */}
            <Field label={tc('radiusOverrideLabel')}>
              <input
                name="radiusM"
                type="number"
                min={1}
                max={100000}
                placeholder={tc('radiusOverridePlaceholder')}
                defaultValue={emp.geofenceRadiusM ?? ''}
                className={`${inputCls} w-36`}
              />
            </Field>
            <button className={btnPrimary}>{tc('save')}</button>
          </form>
          <p className="px-4 pb-4 text-xs text-muted-foreground">{tc('hint')}</p>
    </Card>
  ) : null;

  // Item 52a30630 — Grade RELOCATED here from Profile > Personal Details onto the Leave tab (grade drives
  // grade-scoped leave entitlement), so the number reads next to the entitlement it decides.
  //
  // r78c — the card is now VIEW-ONLY and its server action (setEmploymentGradeAction) is deleted. It was the
  // last direct writer of employment.grade_id outside Movement, and it wrote `employment.grade.changed` — a
  // MOVEMENT_EVENT_TYPE — with no movement tag, so a grade edit made here opened its OWN "Grade Change" row
  // on the Employment History beside the Promotion that had already recorded the same change as a tagged
  // leg. That is the duplicate row the reporter raised. 8ebabbf2 made the Employment tab view-only for the
  // same reason and left this card noted as out of scope; this closes it.
  //
  // The grade still SHOWS here — it is the input to grade-scoped leave entitlement and hiding it would make
  // an unexplained entitlement — with a pointer to the screen that changes it. Movement's Promotion /
  // Demotion / Organisation Assignment Change kinds all carry Job Grade, and createMovementEventAction
  // recomputes entitlement afterwards exactly as this action did (R45 7527ea5f parity).
  const gradeCard = admin ? (
    <Card id="section-grade">
      <SectionHeader title={t('gradeCardTitle')} />
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <Field label={t('grade')}>
          <input
            value={(emp.gradeId ? (grades.find((g) => g.id === emp.gradeId)?.name ?? null) : null) ?? t('gradeNone')}
            disabled
            readOnly
            aria-readonly="true"
            className={inputCls}
          />
        </Field>
        <div className="sm:col-span-3">
          <p className="text-xs text-muted-foreground">
            {t('gradeMovementOnlyNote')}{' '}
            <Link
              href={`/admin/personnel/${emp.employmentId}?tab=careerMovement&newEvent=1`}
              className="text-primary hover:underline"
            >
              {t('movement.newEvent')}
            </Link>
          </p>
        </div>
      </div>
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
              {/* 31e39d74 — "configured but not yet generated" on the HR-side record too. This card shows
                  an em dash rather than 0.00 for an inactive type, which is not a silent zero but is also
                  not an ANSWER: it cannot distinguish a type nobody configured from one whose table is
                  written and waiting for Generate Entitlement. The caption is that distinction. */}
              {(() => {
                const st = breakdownByType.get(b.leaveTypeId)?.entitlementStatus;
                return st && entitlementStatusNeedsNotice(st) ? (
                  <div
                    className="mt-1 text-xs text-amber-700 dark:text-amber-500"
                    title={tBal(ENTITLEMENT_STATUS_TIP_KEY[st]!)}
                  >
                    {tBal(ENTITLEMENT_STATUS_LABEL_KEY[st])}
                  </div>
                ) : null;
              })()}
              {breakdownByType.get(b.leaveTypeId) && (
                <EntitlementBreakdown
                  data={breakdownByType.get(b.leaveTypeId)!}
                  summary={{ available: b.available }}
                  // §5 Upcoming Approved Leave removed from the panel (feedback 11876072).
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

  // R45 7527ea5f — Automatic Leave Entitlement Recalculation history. When a profile change (grade /
  // employment type / hire date / confirmation) moves the resolved entitlement, the engine posts a
  // compensating adjustment and records it here: previous → new entitlement, the reason (which field
  // moved), and the effective date. Admin-only, shown under the Leave tab beneath the balance card.
  // The `reason` column is free text written by whatever triggered the recalc, so this is a COMPUTED key
  // and i18n-coverage check C cannot see it — it only matches literal t('a.b') calls.
  //
  // The fallback here used to be `t(key) === key ? reason : label`, which NEVER FIRED: next-intl returns
  // the FULLY-QUALIFIED path on a miss (people.detail.recalcReason.x) while `key` is relative, so the
  // comparison could not match and the raw path was painted on screen. Measured on production 2026-08-10:
  // 50 of 72 audit rows rendered a key path to the user (leave_type_rules 29, year_cycle_override 11,
  // movement_recorded 9, movement_applied 1).
  //
  // `t.has` is the house idiom for a computed key — app/admin/scheduled-actions/page.tsx does the same.
  // Degrading to the raw reason is deliberate: reasons are added by new code paths faster than labels, and
  // an unlabelled reason must read as a plain word, never as a key path.
  const recalcReasonLabel = (reason: string): string =>
    t.has(`recalcReason.${reason}`) ? t(`recalcReason.${reason}`) : reason;
  const recalcHistoryCard = admin ? (
    <Card id="section-entitlement-recalc">
      <SectionHeader title={t('recalcHistoryTitle')} count={recalcAudit.length} />
      <p className="px-4 pt-3 text-xs text-muted-foreground">{t('recalcHistoryHelp')}</p>
      {recalcAudit.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">{t('recalcHistoryEmpty')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('recalcColEffective')}</th>
                <th className="px-4 py-2 font-medium">{t('recalcColType')}</th>
                <th className="px-4 py-2 font-medium">{t('recalcColReason')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColPrevious')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColNew')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('recalcColChange')}</th>
              </tr>
            </thead>
            <tbody>
              {recalcAudit.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 tabular-nums">{r.effectiveOn}</td>
                  <td className="px-4 py-2">{r.leaveTypeName}</td>
                  <td className="px-4 py-2 text-muted-foreground">{recalcReasonLabel(r.reason)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.previousEntitlement}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.newEntitlement}</td>
                  <td
                    className={`px-4 py-2 text-right tabular-nums font-medium ${
                      r.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : r.delta < 0 ? 'text-red-600 dark:text-red-400' : ''
                    }`}
                  >
                    {r.delta > 0 ? `+${r.delta}` : r.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  ) : null;

  // Basic Salary card (feedback 87c82b18 — "Compensation" renamed & rebuilt as salary history; audit
  // columns removed + edit/delete widened under 7c7c2f80). The salary engine (effective-dated
  // CLOSE+INSERT) lives in core/comp.ts. NOTE on payroll: generatePayslips resolves the CURRENT OPEN
  // row (validTo IS NULL), NOT the row in force during the period being paid — only the opt-in
  // salary-increment proration block is period-aware (core/payroll.ts). That is why removing or
  // re-dating records is blocked against closed payroll periods. Kept in its old Payroll slot;
  // `section-compensation` anchor stays for fragment-URL safety. Stays a server-rendered
  // <Card>/<form> (f2904eeb) — interactivity lives in the SalaryRevisionConfirm / history-table islands.
  // (`fmtMoney` used to be declared here; 18719ded hoisted it to the top of the Payroll section so Pay
  // Items and CP38 read their amounts through the same formatter this card always used.)
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
    // Deletable (7c7c2f80): soft delete is offered only for records whose window no CLOSED payroll run
    // relied on — same rule the service + 0277 trigger enforce, pre-derived so the button can hide.
    const deletable =
      !emp.terminatedOn && !overlapsClosedPeriod(closedPayrollPeriods, row.validFrom, row.validTo);
    return { row, basic, previous, incrementAmount, incrementPct, status, editable, deletable };
  });
  // Serialized rows for the client history table (search / filter / sort / export / edit / delete).
  // Salary math is derived here on the server; the island only presents + filters (f2904eeb-safe, no
  // client fetch). Audit detail (created/updated by/on) is no longer serialized — it belongs to the
  // Audit Trail, not this screen (7c7c2f80).
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
    // ADR-0078 — per-revision salary structure, shown as table columns and editable on the open row.
    payMode: r.row.payMode,
    paymentTerm: r.row.paymentTerm,
    rateAmount: r.row.rateAmount,
    remarks: r.row.remarks,
    editable: r.editable,
    deletable: r.deletable,
  }));
  // The summary shows the row in effect TODAY (active) — NOT the open row, which may be a future revision.
  const activeDerived = salaryRows.find((r) => r.status === 'active') ?? null;
  const hasFuture = salaryRows.some((r) => r.status === 'future');
  // ADR-0078 — the OPEN row (validTo null) is what payroll reads; its pay structure prefills the
  // add-revision form so an untouched save carries the structure forward visibly.
  const openSalaryRow = salaryHistory.find((r: CompensationHistoryRow) => r.validTo == null) ?? null;
  // Add salary revision — the SAME <form action={setCompensationAction}>, the same control names and the
  // same SalaryRevisionConfirm guard as before, moved out from under the table into the section's Add
  // dialog (18719ded). The initial record still defaults its effective date to the join date. Allowance is
  // not maintained here (it moved to Pay Items); the action carries it forward.
  // The STATIC hidden `tab` input is load-bearing — Dialog.Portal reparents the form outside the
  // PersonnelTabs shell, so the shell's submit listener cannot inject the tab (see the Family tab note).
  const salaryAddDialogForm = (
    <form action={setCompensationAction} className="space-y-3">
      <input type="hidden" name="employmentId" value={emp.employmentId} />
      <input type="hidden" name="tab" value="payroll" data-tab-tracker="" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        {/* 297ae65a — the record's salary currency, grouped WITH the amount (searchable ISO 4217 list).
            Preselects the open row's currency (carry-forward made visible) or the company default for
            a brand-new first record; the service validates + carries forward server-side. */}
        <Field label={t('salaryCurrency')}>
          <CurrencySelect name="currency" value={openSalaryRow?.currency ?? defaultSalaryCurrency} />
        </Field>
        <Field label={t('salaryColRemarks')}>
          <input
            name="remarks"
            type="text"
            placeholder={t('salaryRemarksPlaceholder')}
            className={inputCls}
          />
        </Field>
        {/* ADR-0078 (642ecc55) — Pay Mode, Payment Term and the conditional Rate box are saved WITH the
            revision (effective-dated, historical rows keep their own settings). Defaults come from the
            open row so an untouched save carries the structure forward. The service enforces the
            period-boundary rule for pay-mode changes and requires a rate for daily/hourly. */}
        <PayStructureFields
          defaultPayMode={(openSalaryRow?.payMode ?? 'monthly') as PayModeOption}
          defaultPaymentTerm={openSalaryRow?.paymentTerm ?? 'monthly'}
          defaultRateAmount={openSalaryRow?.rateAmount ?? null}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('salaryAllowanceMovedHint')}</p>
      <p className="text-xs text-muted-foreground">{t('payModeBoundaryHint')}</p>
      {/* Confirm-before-save survives the move. It is a ConfirmSubmit (an AlertDialog) inside this
          FamilyFormDialog — a modal over a modal — and it keeps working for a specific reason: the
          trigger Button stays INSIDE this <form>, so its `closest('form').requestSubmit()` still finds
          the form even though Dialog.Portal has reparented the whole thing to document.body. That
          composition is pinned by test/personnel-payroll-tab-dialogs.dom.test.tsx precisely because it
          is the kind of thing that passes tsc, the suite and `next build` and is broken on screen. */}
      <SalaryRevisionConfirm
        currentBasic={activeDerived ? activeDerived.basic : null}
        currency={activeDerived ? activeDerived.row.currency : 'MYR'}
      />
    </form>
  );

  const compensationCard = admin ? (
    <Card id="section-compensation" className="overflow-hidden">
      <SectionHeader title={t('compensation')} count={salaryRowViews.length} />
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

      {/* Same shape as Pay Items and CP38 (and as the Qualification tab): the section's only Add control
          sits in a header strip above the list, not in a form pinned under it. The strip is skipped
          entirely for a terminated employment — there is no Add for it, and an empty strip would just be
          unexplained whitespace. */}
      <section>
        {!emp.terminatedOn && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
            <FamilyFormDialog triggerLabel={t('salaryAdd')} title={t('salaryAddTitle')}>
              {salaryAddDialogForm}
            </FamilyFormDialog>
          </div>
        )}
        {/* History table — every revision, with search / status filter / column sort / CSV export, plus an
            edit affordance on the latest (open) record. Interactive client island (f2904eeb-safe). The
            in-force revision carries its own Active badge and row tint rather than being identified by
            position: this table sorts and filters, so row order is the reader's choice, not the record's
            status. (The summary strip above states the same figure once more, in words.) */}
        {salaryRowViews.length > 0 && <SalaryHistoryTable rows={salaryRowViews} />}
      </section>

      {/* ── R46 79eb7151, SUPERSEDED by ADR-0078 (642ecc55) — How this employee is paid ─────────────────────
          The R46 decision ("surface, do NOT duplicate": Pay Mode ≡ payroll_policy.policy_type and Payment
          Term ≡ PayrollPolicyConfig.frequency, rendered read-only here with a link to the policy) is
          REVERSED: the salary structure now lives on the employee's own effective-dated compensation row
          (pay_mode / payment_term / rate_amount, NOT NULL, no policy fallback), edited via the Basic Salary
          form above and shown per-revision in the history table. The read-only pair this block used to
          render is gone; there is still exactly ONE source of truth per period, so the R46 objection (two
          disagreeing sources + a precedence rule) does not recur. Payment Method was per-employee all along
          and stays exactly where it was, with its own column, event and save. */}
      <div className="space-y-3 border-t border-border p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('payMethodGroup')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Payment Method — a genuinely per-employee setting with a real control and its own Save.
              Bank Transfer is validated server-side against the employee's bank name + account number
              (setEmploymentPaymentMethod); a missing destination is rejected with an explanatory toast
              rather than saved as an unpayable row. */}
          <form action={setPaymentMethodAction} className="flex flex-col gap-1.5">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            <span className="text-xs font-medium text-muted-foreground">{t('paymentMethod')}</span>
            <div className="flex gap-2">
              <select
                name="paymentMethod"
                defaultValue={emp.paymentMethod ?? ''}
                disabled={!!emp.terminatedOn}
                className={inputCls}
              >
                <option value="">{t('paymentMethodNotSet')}</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {t(`paymentMethod_${m}` as 'paymentMethod_bank_transfer')}
                  </option>
                ))}
              </select>
              {!emp.terminatedOn && <button className={btnPrimary}>{t('paymentMethodSave')}</button>}
            </div>
          </form>
        </div>
        <p className="text-xs text-muted-foreground">{t('paymentMethodBankHint')}</p>
      </div>
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
            {/* 35b7af0a group 4 — EPF Number and EPF Citizenship are now ONE shared field group
                (components/epf-registration-fields.tsx), rendered identically here and on the Create New
                Employee wizard. The wizard's private copy said "Citizen / Permanent resident /
                Non-citizen" against this card's "Malaysian citizen / Permanent resident (PR) /
                Non-citizen (foreign worker)", and offered a fourth "— Not set —" option that
                `epf_citizenship NOT NULL DEFAULT 'citizen'` has never been able to store. `mode="form"`
                keeps these inputs exactly what they were: uncontrolled name/defaultValue inputs inside
                this full-row setStatutoryAction form, with no function prop crossing the RSC boundary. */}
            <EpfRegistrationFields
              mode="form"
              epfNumber={statutory?.epfNumber}
              epfCitizenship={statutory?.epfCitizenship}
            />
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
            {/* 35b7af0a group 7 — the SAME group the Create Employee wizard now renders
                (components/socso-eis-fields.tsx). Names, options and the IC-derived number default are
                carried over verbatim; this card still posts socsoNumber / socsoCategory / eisCategory
                exactly as before. The wizard was a whole consolidation behind: it offered the legacy
                "EIS eligible" yes/no that item a7271737 replaced, and no SOCSO category at all. */}
            <SocsoEisFields
              mode="form"
              defaults={{
                socsoNumber: statutory?.socsoNumber,
                socsoCategory: statutory?.socsoCategory,
                eisCategory: statutory?.eisCategory,
              }}
              icNumber={statutory?.icNumber}
              nationality={emp.nationality}
              // This page already resolves its pack as packFor('MY') at the top; passing the same
              // literal keeps behaviour byte-identical. Widening the page to the company's own country
              // is a real change and belongs to whoever does it, not to a field-sharing commit.
              country="MY"
            />
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

      {/* Item df09f22a — Income Tax (PCB) is a Malaysia statutory payroll item, so the Identification & Tax
          island is nested INSIDE this Statutory (Malaysia) card as an "Income Tax (PCB)" section (visual merge).
          It keeps its OWN <form action={setTaxAction}> + Save button (embedded mode) rather than folding into the
          full-row setStatutoryAction form — the two-action design is preserved so one save can't overwrite the
          other. Rendered as a sibling of the statutory form inside the same Card (no nested forms). */}
      {/* 7ee14bbc — `taxNumberSharedWith` (computed above) is the names of the OTHER people in this
          company already filed under this employee's income tax reference number. Shown beside the
          field itself so a duplicate is caught where it is typed rather than on the CP39 at filing
          time. Advisory only: the save is never gated on it. */}
      <IdentityTaxCard
        embedded
        action={setTaxAction}
        employmentId={emp.employmentId}
        personId={emp.personId}
        derivedChildCount={eligibleChildReliefCount(dependents)}
        taxNumberSharedWith={taxNumberSharedWith}
        defaults={{
          taxNumber: statutory?.taxNumber ?? null,
          taxCategory: statutory?.taxCategory ?? 1,
          taxResidency: statutory?.taxResidency ?? 'resident',
          numChildren: statutory?.numChildren ?? 0,
          childReliefMode: statutory?.childReliefMode ?? 'manual',
          employerBearsTax: statutory?.employerBearsTax ?? false,
          // Item d64d0df4 — No unless explicitly claimed, matching the column default and today's PCB.
          disabledIndividual: statutory?.disabledIndividual ?? false,
          disabledSpouse: statutory?.disabledSpouse ?? false,
          // Item d64d0df4 — the 'auto_table' grid. A plain serialisable object (or null) crosses the
          // server/client boundary; the card renders it read-write only in that mode and posts it back
          // as flat scalar fields in every mode.
          childReliefTable:
            (statutory?.childReliefTable as Record<string, { full: number; half: number }> | null) ?? null,
        }}
      />
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

  // Item df09f22a — the standalone Identification & Tax card (item 8b5334db) was merged into the Statutory
  // (Malaysia) card as a nested "Income Tax (PCB)" section (see statutoryCard above). Income tax is a Malaysia
  // statutory payroll item, so all statutory fields now live in one box. The IdentityTaxCard island still owns
  // its own setTaxAction partial save — only its render location + chrome (embedded mode) changed.

  // ── OTHERS STATUTORY (Bank & Statutory tab) ─────────────────────────────────
  // Feedback 0df0c635 — the home for statutory settings that don't belong under EPF, SOCSO, EIS or Tax
  // Information (extensible for future controls without a redesign), starting with the per-employee
  // "Subject to HRDF" control. Its own card with its OWN partial save (setOthersStatutoryAction → the
  // pack's setOthersStatutory), like the Bank/TP3/Tax split-out precedents, so saving it can never touch
  // the full-row statutory form and vice versa. Tri-state per the house convention: the stored value is
  // null until HR picks an explicit Yes/No, and null means "follow the company's HRDF registration
  // default". Feedback 57840a6e — this was a CHECKBOX, which structurally cannot carry three states: an
  // untouched card rendered from the company default (unchecked while the company was not_registered) and
  // saved for any other reason silently PINNED the employee to an explicit No, permanently excluding them
  // from the levy even after the company later set a 0.5%/1.0% rate. It is now a three-option select
  // (gender/maritalStatus precedent on this page): "" ⇒ null (follow the company default), yes ⇒ true,
  // no ⇒ false. Payroll excludes an explicit-false employee from the HRD Corp levy entirely.
  const othersStatutoryCard = admin ? (
    <Card>
      <SectionHeader title={t('othersStatutoryTitle')} />
      <form action={setOthersStatutoryAction} className="flex flex-col gap-3 p-4">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
        <input type="hidden" name="personId" value={emp.personId} />
        <p className="text-xs text-muted-foreground">{t('othersStatutoryHint')}</p>
        <Field label={t('subjectToHrdf')}>
          <select
            name="subjectToHrdf"
            defaultValue={statutory?.subjectToHrdf == null ? '' : statutory.subjectToHrdf ? 'yes' : 'no'}
            className={inputCls}
            title={t('subjectToHrdfHint')}
          >
            <option value="">{t('subjectToHrdfFollowingDefault')}</option>
            <option value="yes">{t('prorateYes')}</option>
            <option value="no">{t('prorateNo')}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{t('subjectToHrdfHint')}</p>
        {/* Feedback efece4ce — the contradiction the reporter hit: an explicit Yes on a company with no HRDF
            Contribution Rate. The save is honest (the flag IS stored, and starts levying the moment the
            company registers), so this is a warning, not a blocker — refusing the save would strand HR who
            are setting employees up ahead of the company registration. What it must never do again is stay
            silent. Rendered from the STORED value, so it survives the post-save redirect and every later
            visit; a null/No employee sees nothing. */}
        {statutory?.subjectToHrdf === true && companyHrdfUnregistered && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            {t('subjectToHrdfCompanyNotRegistered')}
          </p>
        )}
        {/* r79 — the amber warning above only fires on the STORED Yes, i.e. after the operator has already
            chosen it. Where the company is unregistered, say so BEFORE the choice is made too, so picking
            Yes is an informed decision rather than one corrected afterwards. Deliberately muted, not amber:
            nothing is wrong yet, and six of eight live companies are unregistered — an alarm on every one of
            their employees would train the operator to ignore the amber one that does mean something. */}
        {statutory?.subjectToHrdf !== true && companyHrdfUnregistered && (
          <p className="text-xs text-muted-foreground">{t('subjectToHrdfCompanyUnregisteredNote')}</p>
        )}
        <div className="flex items-end justify-end">
          <button className={btnPrimary}>{t('othersStatutorySave')}</button>
        </div>
      </form>
    </Card>
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
  // ("job") tab. Movement tab redesign (78853b97): the old Assignment history table is replaced by
  // employmentHistoryCard — a Hired-first Employment History timeline projected from the domain_event
  // ledger, with per-row View detail and a single New Event entry point that folds in the former
  // Transfer / Terminate / Blacklist boxes. The anchor id stays byte-identical for deep links.

  // Event-type labels via a STATIC key map (never a dynamic t() template) with a humanized fallback for
  // unknown/extensible kinds — nothing can render a raw i18n key in any locale.
  //
  // e6a144d4 — the switch itself now lives in lib/movement-kind-label.ts. The Download Excel route needs
  // the identical caption (476f23ed tenant override included), and two copies of a twenty-case map is how
  // a file and the screen it reproduces start calling the same event different things. This closure is all
  // that stays here: it binds the tenant catalogue and the page's translator.
  const movementKindLabel = (kind: string): string =>
    movementKindLabelOf(kind, movementTypeByCode.get(kind)?.label, t);
  const movementEmpTypeLabel = (v: string | null): string | null =>
    v ? t(`employmentInfo.employmentType_${v}` as 'employmentInfo.employmentType_full_time') : null;

  // New Event is hidden once terminated (the same gate that hid the old Transfer form); the history
  // itself stays viewable. Rehire is a future, separate piece.
  const canCreateMovement = admin && !emp.terminatedOn;

  const employmentHistoryCard = (
    <Card id="section-assignment-history" className="overflow-hidden">
      <SectionHeader title={t('movement.title')} />
      {/* e6a144d4 — the action bar is OUTSIDE the canCreateMovement gate; only New Event is inside it.
          The bar used to disappear wholesale once `emp.terminatedOn` was set, and a terminated employee's
          employment history is exactly the record HR needs for exit paperwork, group HR and auditors. So a
          terminated employment now keeps the download and loses only the button that would write. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-border px-4 py-2">
        {/* A plain link straight at the export route — no client component, no form, no approval step:
            one click and the file downloads. It carries no query string: the file is the COMPLETE
            history and never the filtered view, so there is no view state to hand over.

            A BARE <a>, NOT next/link, AND THAT IS THE POINT. Next 16 prefetches a <Link> when it enters
            the viewport in production, so merely OPENING this tab would fire a background GET at the
            export route — replaying the whole ledger and serialising an entire workbook for a file
            nobody asked for, on every visit. A route handler returning a spreadsheet is not an RSC
            payload, so the prefetch buys nothing and the click still does a hard navigation. The
            payroll grid-export anchor next door is a bare <a> for the same reason; the Leave
            employee-records link is a <Link> and pays this cost today. */}
        <a
          href={`/admin/personnel/${employmentId}/movement-export`}
          className="inline-flex shrink-0 items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('movement.exportExcel')}
        </a>
        {canCreateMovement && (
          <Link
            href={`/admin/personnel/${employmentId}?tab=careerMovement&newEvent=1`}
            className={btnPrimary}
          >
            {t('movement.newEvent')}
          </Link>
        )}
      </div>
      {/* r78c — eight columns no longer fit a narrow viewport, so the table scrolls inside its own
          container rather than squeezing every cell (the Card is overflow-hidden). Same pattern as the
          recalculation-history table above. */}
      <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          {/* r78c — the reporter's requested column set: Event Type, Effective Date, Company, Division,
              Department, Job Title, Basic. End Date and Remarks moved OFF the list (they are not in the
              requested set and seven data columns is already the width of the panel); both still render on
              the row's detail view, one click away via Action, so nothing became unreachable. Action stays:
              it is the affordance, not data, and View / Edit / Roll Back hang off it. */}
          <tr>
            <th className="px-4 py-2 font-medium">{t('movement.columns.eventType')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.effectiveDate')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.company')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.division')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.department')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.jobTitle')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.basic')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.columns.action')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {/* 95d17761 — an employment whose whole history is correction artefacts must say so, not draw a
              bare table head. The hidden-count line below still renders, so the rows are one click away. */}
          {visibleMovements.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t('movement.empty')}
              </td>
            </tr>
          )}
          {visibleMovements.map((m) => (
            // 66a63bd6 — a rolled-back movement KEEPS its line, visibly marked, and loses its actions. It is
            // never removed: the history is the evidence payroll and statutory reporting lean on.
            <tr
              key={m.id}
              className={m.reversed || m.status === 'superseded' ? 'text-muted-foreground' : undefined}
            >
              <td className="px-4 py-2.5 font-medium text-foreground">
                <span className={m.reversed || m.status === 'superseded' ? 'line-through' : undefined}>
                  {movementKindLabel(m.kind)}
                </span>
                {m.reversed && (
                  <span className="ml-2 rounded border border-border px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-muted-foreground">
                    {m.reversed.corrected
                      ? t('movement.correctedBadge')
                      : // bd89ccd8 — a movement undone while still pending never applied, so the badge
                        // says Cancelled and matches the word on the button that undid it.
                        m.reversed.cancelled
                        ? t('movement.cancelledBadge')
                        : t('movement.reversedBadge')}
                  </span>
                )}
                {/* 941c9dac — a movement that has not taken effect says so on its own line. Pending is the
                    only one drawn in an ACTIVE colour: it is the one that still has a future, and the one
                    HR may want to correct before it lands. Superseded is muted like a reversal — it is a
                    dead record kept visible on purpose, never silently dropped. */}
                {!m.reversed && m.status === 'pending' && (
                  <span className="ml-2 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-primary">
                    {t('movement.status.pending')}
                  </span>
                )}
                {!m.reversed && m.status === 'superseded' && (
                  <span className="ml-2 rounded border border-border px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t('movement.status.superseded')}
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs">{m.effectiveDate}</td>
              {/* Reconstructed AS OF the row's effective date in core/movement.ts — never a live read of the
                  employee's current placement, which would print today's values on a row from years ago. */}
              <td className="px-4 py-2.5 text-muted-foreground">{m.company ?? '—'}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{m.division ?? '—'}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{m.department ?? '—'}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{m.jobTitle ?? '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs tabular-nums">{m.basic ?? '—'}</td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    href={`/admin/personnel/${employmentId}?tab=careerMovement&movement=${m.id}`}
                    className="text-primary hover:underline"
                  >
                    {t('movement.view')}
                  </Link>
                  {canCreateMovement && m.canEdit && (
                    <Link
                      href={`/admin/personnel/${employmentId}?tab=careerMovement&editMovement=${m.id}`}
                      className="text-primary hover:underline"
                    >
                      {t('movement.edit')}
                    </Link>
                  )}
                  {canCreateMovement && m.canReverse && (
                    <form action={reverseMovementEventAction} className="inline-flex">
                      <input type="hidden" name="employmentId" value={employmentId} />
                      <input type="hidden" name="movementId" value={m.id} />
                      {/* 10fcf6df — the affordance is ROLLBACK, not Delete. The service behind it has
                          reversed rather than erased since 66a63bd6 (reverseMovementEventAction →
                          reverseMovementEvent), and the confirmation has said so all along; the word on
                          the row was the last thing still promising a deletion that never happened. It is
                          no longer drawn in the destructive colour either — undoing a movement restores
                          the employee's previous values, it does not remove a record.

                          bd89ccd8 — a PENDING row says CANCEL instead, and this is a relabel of the ONE
                          reversal path, never a second writer. A future-dated movement has written
                          nothing; reversing it is the reversal event alone and the sweep then skips it,
                          so "cancel" is the honest word for what happens and "roll back" is not. Wearing
                          the applied wording is what made HR read a wrongly keyed future event as
                          impossible to get rid of, which is the whole of the reported fault. */}
                      <ConfirmSubmit
                        title={
                          m.status === 'pending'
                            ? t('movement.cancelConfirmTitle')
                            : t('movement.rollbackConfirmTitle')
                        }
                        subtitle={`${movementKindLabel(m.kind)} · ${m.effectiveDate}`}
                        description={
                          m.status === 'pending'
                            ? t('movement.cancelConfirmDescription')
                            : m.payrollWarning
                              ? t('movement.rollbackConfirmPayroll')
                              : t('movement.rollbackConfirmDescription')
                        }
                        confirmLabel={m.status === 'pending' ? t('movement.cancel') : t('movement.rollback')}
                        // The reason is MANDATORY (bd89ccd8): Confirm stays disabled until it is typed,
                        // and reverseMovementEvent refuses a blank one regardless — the dialog is not the
                        // only caller, so the control lives in the service and the form only mirrors it.
                        reasonField={{ name: 'reason', label: t('movement.correctionReasonLabel'), required: true }}
                        variant="ghost"
                        size="sm"
                        className="h-auto p-0 text-sm font-normal text-primary hover:bg-transparent hover:underline"
                      >
                        {m.status === 'pending' ? t('movement.cancel') : t('movement.rollback')}
                      </ConfirmSubmit>
                    </form>
                  )}
                  {m.payrollLocked && (
                    <span className="text-xs text-muted-foreground">{t('movement.payrollLocked')}</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {/* 95d17761 — one quiet line under the table. Rolled back, corrected, cancelled and superseded
          entries are OFF the profile by default (nothing is deleted — the ledger and every payroll/EA
          figure built from it are untouched), and Show puts them back exactly as they used to render.
          correctedHidden carries a count placeholder — an ICU contract, so it is called WITH the
          argument; calling it bare throws at render while the route still returns 200. */}
      {correctedMovementCount > 0 && (
        <div className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
          {t('movement.correctedHidden', { count: correctedMovementCount })}{' '}
          <Link href={movementVisibilityHref(true)} className="text-primary hover:underline">
            {t('movement.showCorrected')}
          </Link>
        </div>
      )}
      {showCorrectedMovements && (
        <div className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
          <Link href={movementVisibilityHref(false)} className="text-primary hover:underline">
            {t('movement.hideCorrected')}
          </Link>
        </div>
      )}
    </Card>
  );

  // Detail view (?movement=<id>): event information + a side-by-side Before/After comparison built by
  // as-of reconstruction at the effective date (ids resolved to labels at read time). Salary is shown —
  // this page is admin-only (scopedAdmin, which calls requireAdmin), so no widening of pay visibility.
  const movementComparisonRows = movementDetailData
    ? [
        { key: 'company', label: t('movement.field.company'), before: movementDetailData.before?.company, after: movementDetailData.after.company },
        { key: 'businessUnit', label: t('movement.field.businessUnit'), before: movementDetailData.before?.businessUnit, after: movementDetailData.after.businessUnit },
        { key: 'department', label: t('movement.field.department'), before: movementDetailData.before?.department, after: movementDetailData.after.department },
        { key: 'position', label: t('movement.field.position'), before: movementDetailData.before?.position, after: movementDetailData.after.position },
        { key: 'grade', label: t('movement.field.grade'), before: movementDetailData.before?.grade, after: movementDetailData.after.grade },
        { key: 'employmentType', label: t('movement.field.employmentType'), before: movementEmpTypeLabel(movementDetailData.before?.employmentType ?? null), after: movementEmpTypeLabel(movementDetailData.after.employmentType) },
        { key: 'manager', label: t('movement.field.manager'), before: movementDetailData.before?.manager, after: movementDetailData.after.manager },
        { key: 'salary', label: t('movement.field.salary'), before: movementDetailData.before?.salary, after: movementDetailData.after.salary },
        // 08913328 — the flat, non-dated columns THIS movement moved (Division … Category). They cannot be
        // reconstructed as-of, so they appear only when the movement's own event recorded a before/after —
        // never as today's value pretending to be part of a years-old change.
        ...MOVEMENT_FLAT_FIELDS.flatMap((f) => {
          const c = movementDetailData.flatChanges.find((x) => x.field === f);
          return c ? [{ key: f, label: t(`movement.field.${f}` as 'movement.field.orgDivision'), before: c.before, after: c.after }] : [];
        }),
      ]
    : [];
  const movementDetailCard = movementDetailData ? (
    <Card id="section-movement-detail" className="overflow-hidden">
      <SectionHeader title={t('movement.detail.eventInformation')} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.columns.eventType')}</dt>
          <dd className="font-medium text-foreground">{movementKindLabel(movementDetailData.row.kind)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.columns.effectiveDate')}</dt>
          <dd className="font-medium text-foreground">{movementDetailData.row.effectiveDate}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.columns.endDate')}</dt>
          <dd className="font-medium text-foreground">{movementDetailData.row.endDate ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.detail.recordedBy')}</dt>
          <dd className="font-medium text-foreground">
            {movementDetailData.actorName ?? t('movement.detail.system')}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.detail.recordedAt')}</dt>
          <dd className="font-medium text-foreground">
            {movementDetailData.occurredAt
              ? movementDetailData.occurredAt.toISOString().slice(0, 16).replace('T', ' ')
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('movement.columns.remarks')}</dt>
          <dd className="font-medium text-foreground">{movementDetailData.row.remarks ?? '—'}</dd>
        </div>
      </dl>
      {movementDetailData.row.reversed && (
        // 66a63bd6 — the correction's own trace. The Before/After grid below still shows what the movement
        // DID: it is the record of an event that happened, and the rollback is a second fact about it.
        <div className="border-t border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {movementDetailData.row.reversed.corrected
              ? t('movement.correctedBadge')
              : t('movement.reversedBadge')}
          </span>{' '}
          · {movementDetailData.row.reversed.at.toISOString().slice(0, 16).replace('T', ' ')}
          {/* 10fcf6df — WHO rolled it back, beside WHEN. Resolved in the projection from the reversal
              event's own actor, so this cannot disagree with the audit trail. */}
          {movementDetailData.row.reversed.by
            ? ` · ${t('movement.reversedBy')} ${movementDetailData.row.reversed.by}`
            : ''}
          {movementDetailData.row.reversed.reason ? ` · ${movementDetailData.row.reversed.reason}` : ''}
        </div>
      )}
      <table className="w-full border-t border-border text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">{t('movement.detail.field')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.detail.beforeChanges')}</th>
            <th className="px-4 py-2 font-medium">{t('movement.detail.afterChanges')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {movementComparisonRows.map((r) => {
            // 08913328 — tint the fields this movement actually moved, so "what changed" is readable at a
            // glance instead of being a diff the reader has to perform themselves.
            const changed = !!movementDetailData.before && (r.before ?? null) !== (r.after ?? null);
            return (
              <tr key={r.key} className={changed ? 'bg-primary/5' : undefined}>
                <td className="px-4 py-2.5 text-muted-foreground">{r.label}</td>
                <td className="px-4 py-2.5 text-foreground">
                  {movementDetailData.before ? (r.before ?? '—') : t('movement.detail.firstRecord')}
                </td>
                <td className={`px-4 py-2.5 font-medium ${changed ? 'text-primary' : 'text-foreground'}`}>
                  {r.after ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="p-4">
        <Link href={`/admin/personnel/${employmentId}?tab=careerMovement`} className={btnGhost}>
          {t('movement.detail.backToHistory')}
        </Link>
      </div>
    </Card>
  ) : null;

  // New Event (?newEvent=1): one entry point for every movement, replacing the separate Transfer /
  // Terminate / Blacklist boxes. Option lists reuse the data this page already loads; employment-type
  // and termination-type labels are pre-translated here (parent namespace) and passed down.
  // ae9350f2 — the EXISTING termination-type labels, keyed by enum value. Reused rather than re-worded so
  // the classification a reason derives reads identically to the one turnover analytics already shows.
  const TERMINATION_TYPE_LABEL: Record<string, string> = {
    voluntary: t('terminationVoluntary'),
    involuntary: t('terminationInvoluntary'),
    retired: t('terminationRetired'),
    contract_end: t('terminationContractEnd'),
    death: t('terminationDeath'),
    other: t('terminationOther'),
  };

  const movementFormProps = movementCurrent
    ? {
        employmentId: emp.employmentId,
        today,
        isBlacklisted: !!emp.blacklistedAt,
        // 08913328 — the read-only left column AND the pre-fill of the editable right column. One read,
        // so the two sides cannot disagree about what "current" means.
        current: movementCurrent,
        departments: departments.map((d) => ({ id: d.id, name: d.name })),
        positions: positions.map((pos) => ({ id: pos.id, name: pos.title })),
        businessUnits: businessUnits.map((bu) => ({ id: bu.id, name: bu.name })),
        grades: grades.map((g) => ({ id: g.id, name: g.name })),
        locations: locations.map((l) => ({ id: l.id, name: `${l.name} (${l.code})` })),
        // b7b22514 — `companyId` rides along so the grid can narrow the Direct Superior list to the
        // DESTINATION company on an Entity Transfer. No extra read: listEmployees already returns it.
        // The service refuses a manager outside the destination, so offering one would be an affordance
        // that lies.
        managers: others.map((o) => ({ id: o.employmentId, name: o.name, companyId: o.companyId })),
        // b7b22514 — the destinations, and each destination's org lists (see the read above).
        companies: movementCompanies,
        orgByCompany: movementOrgByCompany,
        employmentTypes: (['full_time', 'part_time', 'contract', 'intern'] as const).map((v) => ({
          value: v,
          label: t(`employmentInfo.employmentType_${v}` as 'employmentInfo.employmentType_full_time'),
        })),
        // ae9350f2 — the built-in exit-reason catalogue, pre-translated here (the island holds no server
        // imports). `typeLabel` reuses the EXISTING termination-type labels, so the classification the
        // reason derives reads the same everywhere it already appears (turnover analytics included).
        terminationReasons: TERMINATION_REASONS.map((r) => ({
          code: r.code,
          category: r.category,
          categoryLabel: t(`movement.terminationReasonCategory.${r.category}` as 'movement.terminationReasonCategory.voluntary'),
          label: t(`movement.terminationReason.${r.code}` as 'movement.terminationReason.resignation'),
          typeLabel: TERMINATION_TYPE_LABEL[r.type],
        })),
        // 476f23ed — the event types this organisation offers, already filtered to the active ones and
        // already labelled. The island holds no server imports, so the catalogue is resolved here; passing
        // `behaviourKind` is what lets the form ask for the right fields for one of their OWN types.
        types: movementTypes
          .filter((r) => r.active)
          .map((r) => ({ code: r.code, label: r.label, behaviourKind: r.behaviourKind })),
        cancelHref: `/admin/personnel/${employmentId}?tab=careerMovement`,
      }
    : null;

  const newEventCard = canCreateMovement && spNewEvent && movementFormProps ? (
    <Card id="section-movement-new-event" className="overflow-hidden">
      <SectionHeader title={t('movement.newEvent')} />
      <MovementNewEvent {...movementFormProps} />
    </Card>
  ) : null;

  // 66a63bd6 — Edit (?editMovement=<id>): the SAME comparison form, pre-filled from the movement being
  // corrected. `canEdit` comes from the service, so a row the service would refuse never renders a form.
  const movementEditRow = spEditMovement ? movements.find((m) => m.id === spEditMovement && m.canEdit) : undefined;
  const editEventCard = canCreateMovement && movementEditRow && movementFormProps ? (
    <Card id="section-movement-edit-event" className="overflow-hidden">
      <SectionHeader title={t('movement.editTitle')} />
      <MovementNewEvent
        {...movementFormProps}
        edit={{
          movementId: movementEditRow.id,
          kind: movementEditRow.kind,
          effectiveDate: movementEditRow.effectiveDate,
          endDate: movementEditRow.endDate,
          remarks: movementEditRow.remarks,
          // A correction may re-classify the movement within its own family (a Transfer that should have
          // been a Promotion), never across it — the service replays the same set of writers either way.
          // 476f23ed — the family is decided by the BEHAVIOUR, not by the code, so a correction of one of
          // the organisation's own types offers the same alternatives its behaviour allows. The list is
          // then expressed back in catalogue codes, so a re-classification cannot pick a type that no
          // longer exists here.
          allowedKinds: (() => {
            const behaviour =
              movementTypeByCode.get(movementEditRow.kind)?.behaviourKind ?? movementEditRow.kind;
            // 3ced1040 — Confirmation renders the comparison grid but is its own family of one: it
            // completes probation, so a correction must not be able to turn it into a Transfer or a
            // Transfer into it. The service refuses the same crossing (crossesConfirmation), so the
            // affordance and the rule cannot drift apart.
            // b7b22514 — Entity Transfer is its own family of one, exactly as Confirmation is, and for a
            // consequence that is larger: it moved a legal entity. The service refuses the crossing in
            // BOTH directions (crossesEntityTransfer), so offering any other type here would render a
            // dropdown whose every other option fails on save. Same shape, same reason, one line down.
            const family =
              behaviour === 'confirmation'
                ? ['confirmation']
                : behaviour === 'entityTransfer'
                  ? ['entityTransfer']
                  : isComparisonKind(behaviour)
                    ? [...INTERCHANGEABLE_COMPARISON_KINDS]
                    : [behaviour, 'secondment', 'actingPosition'];
            const codes = movementTypes
              .filter((r) => r.active && family.includes(r.behaviourKind))
              .map((r) => r.code);
            // The movement's own type always stays selectable, even if it has since been switched off —
            // otherwise correcting it would silently re-classify it.
            return Array.from(new Set([movementEditRow.kind, ...codes]));
          })(),
          payrollWarning: movementEditRow.payrollWarning,
        }}
      />
    </Card>
  ) : null;

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
  // 594323a6 made the organisation fields editable from this tab, and c5ac75fa consolidated them into ONE
  // form with ONE Save (fanning out to setEmploymentAssignment + setEmploymentGrade + setEmploymentInfo in
  // one transaction).
  //
  // 8ebabbf2 REVERSES that direction: the Organisation Assignment section is now VIEW-ONLY and its Save is
  // gone. The reason is not that the consolidated form was wrong, but that it was a SECOND writer — the
  // Movement module records the same facts as dated events, and two writers for one truth is how a record and
  // its own history come to disagree. The consolidation's own mitigation shows the strain: the Save had to
  // carry helper text explaining that its effective date governed only four of the fields beside it. On a
  // movement event there is one effective date and it governs the whole event.
  //
  // 89ea527b removes the last two writers of the service dates from the card below it: Group Join Date and
  // Join Date are view-only too. What REMAINS editable on this tab is the rest of the Employment Dates group
  // — probation, notice and resignation periods/dates — which are lifecycle facts about this employment, not
  // organisation assignment, and have no movement kind that owns them.
  //
  // Employment Dates keeps its OWN sibling <form> (it shared the old organisation form). It is a separate
  // concern with a separate Save, and its action no longer touches the eight org columns.
  const EMPLOYMENT_TYPE_OPTIONS: readonly string[] = ['full_time', 'part_time', 'contract', 'intern'];
  // 955c7de4 — period unit dropdown options for the redesigned Employment Dates card.
  const PERIOD_UNIT_OPTIONS: readonly string[] = ['month', 'week', 'day'];
  // ONE day-precise length-of-service formatter for every service figure this page shows (4ea70bb7).
  //
  // cc681bd5 — the smart format: zero LEADING units drop ("8 Months 15 Days" under a year, "25 Days" for a
  // new joiner) while inner zeros stay ("10 Years 0 Months 5 Days"); days ALWAYS render, so a same-day hire
  // reads "0 Days" rather than blank. Each unit is its own ICU-plural key, which is what gets the singular
  // right ("1 Year 1 Month 1 Day") in every locale.
  //
  // It reuses core/leave's serviceYearsMonthsDaysAt (UTC calendar math, month borrowing, month-end clamp,
  // clamps to zero for a future date) rather than a second piece of date arithmetic. That is the point: the
  // leave service bands read the sibling serviceYearsAt, which this function's .years is contracted to equal,
  // and two calculations meant to agree eventually stop agreeing. Read-only and display-only — nothing here
  // is stored and no entitlement reads it.
  //
  // 4ea70bb7 replaced the whole-years-and-months `employmentInfo.serviceLength` the Employment tab used to
  // render through: it showed a July joiner "0 Years 0 Months" — which reads as no service at all — and said
  // "1 Years 11 Months". That key is DELETED from all six catalogues, so there is no second format left here
  // to drift from this one.
  const fmtServiceYmd = (from: string | null | undefined): string | null => {
    if (!from) return null;
    const s = serviceYearsMonthsDaysAt(from, today);
    const parts: string[] = [];
    if (s.years > 0) parts.push(t('employmentInfo.yearsUnit', { count: s.years }));
    if (s.years > 0 || s.months > 0) parts.push(t('employmentInfo.monthsUnit', { count: s.months }));
    parts.push(t('employmentInfo.daysUnit', { count: s.days }));
    return parts.join(' ');
  };
  // Length-of-service reference figures (feedback 24c4d02e). Group service reads the Group Join Date
  // (hiredOn); current-company service reads the Join Date, falling back to the group date until a transfer
  // sets it — 22 of 40 rows carry no join_date and must not read as empty. The two are computed
  // INDEPENDENTLY from their own dates: neither replaces the other, and on the one employment where the
  // dates differ they are meant to show different figures.
  const groupServiceLabel = fmtServiceYmd(emp.hiredOn);
  const currentServiceLabel = fmtServiceYmd(emp.joinDate ?? emp.hiredOn);
  // cc681bd5 — Year of Service: the same figure as Group Service, from the Group Join Date (hiredOn — fixed
  // through internal transfers; joinDate is deliberately ignored), recomputed on every render so each profile
  // open shows that day's exact figure with no manual refresh. It goes through the SAME formatter as the two
  // above, which is why the summary card and the Employment tab cannot disagree.
  // b75b2a23 — the figure renders on the TOP summary card (after the Group Join Date), not on the Employment
  // Information card; the computation stays here beside the other service figures it shares inputs with.
  const yearOfServiceLabel = fmtServiceYmd(emp.hiredOn);
  const yearOfServiceTooltip = emp.hiredOn
    ? t('employmentInfo.yearOfServiceTooltip', { groupJoinDate: emp.hiredOn, asOf: today })
    : null;
  // 8ebabbf2 / 89ea527b — the view-only renderer for every field that left the Employment tab's forms. A
  // DISABLED <input> rather than plain text on purpose: it keeps the card's existing look and the field's
  // shape (an empty value still reads as a field, not as missing markup), and it carries no `name`, so the
  // value is never submitted by any sibling form. Matches the Company field, which has been read-only here
  // since 9464bd56. aria-readonly (not just `disabled`) keeps it announced to screen readers.
  // A lowercase helper, not a component: defining a component inside render creates a new component type on
  // every render (react-hooks/static-components), and this needs the request-scoped `t` anyway. Same shape as
  // the `row` helper in movement-new-event.tsx.
  const readOnlyValue = (value: string | null | undefined, title?: string) => (
    <input
      value={value ?? t('optionNotSet')}
      disabled
      readOnly
      aria-readonly="true"
      title={title}
      className={inputCls}
    />
  );
  // Movement → New Event, pre-opened. Every "change this through Movement" pointer on the tab links here so
  // the administrator lands on the form that actually performs the change rather than on a tab they must
  // then navigate. Tab-qualified so the panel is already selected.
  const newMovementHref = `/admin/personnel/${emp.employmentId}?tab=careerMovement&newEvent=1`;
  const gradeName = emp.gradeId ? (grades.find((g) => g.id === emp.gradeId)?.name ?? null) : null;
  const employmentTypeLabel =
    current?.employmentType && EMPLOYMENT_TYPE_OPTIONS.includes(current.employmentType)
      ? t(`employmentInfo.employmentType_${current.employmentType}` as 'employmentInfo.employmentType_full_time')
      : (current?.employmentType ?? null);
  /**
   * 941c9dac — the movements that have been recorded but have NOT taken effect yet. The values below are
   * today's, and they stay today's until the effective date arrives; without this note the tab would be
   * correct but misleading, because HR would have keyed a promotion and see no trace of it anywhere on the
   * screen that shows what the promotion changes. Earliest first — the next thing to happen leads.
   */
  const pendingMovements = movements
    .filter((m) => m.status === 'pending')
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : a.effectiveDate > b.effectiveDate ? 1 : 0));
  const employmentInfoCard = admin ? (
    <Card id="section-employment-info">
      <SectionHeader title={t('employmentInfo.title')} />
      {pendingMovements.length > 0 && (
        <div className="border-b border-border px-4 py-3">
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            <p className="font-medium">{t('employmentInfo.pendingMovementTitle')}</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {pendingMovements.map((m) => (
                <li key={m.id}>
                  {t('employmentInfo.pendingMovementItem', {
                    kind: movementKindLabel(m.kind),
                    date: m.effectiveDate,
                  })}
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t('employmentInfo.pendingMovementNote')}
            </p>
          </div>
        </div>
      )}
      {/* 9464bd56 — Company change before any transaction. A SELF-CONTAINED block ABOVE the consolidated
          assignment form (which stays untouched — one form, one Save). Phase 1 (GET) picks a destination the
          admin manages → ?companyChange=; phase 2 (POST) commits the move via changeEmploymentCompanyAction
          with the destination-scoped Department. When neither applies it is a short note: editable → hint;
          locked → the read-only Company field below carries the Movement / Transfer guidance. */}
      {pendingCompany ? (
        <form action={changeEmploymentCompanyAction} className="space-y-3 border-b border-border p-4">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="newCompanyId" value={pendingCompany.id} />
          <input type="hidden" name="tab" value={tab ?? ''} />
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-foreground">
            {t('employmentInfo.companyPendingBanner', { company: pendingCompany.name })}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('employmentInfo.department')}>
              <select name="departmentId" defaultValue="" required className={inputCls}>
                <option value="">{t('employmentInfo.positionNone')}</option>
                {orgDepartments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('employmentInfo.businessUnit')}>
              <select name="businessUnitId" defaultValue="" className={inputCls}>
                <option value="">{t('employmentInfo.positionNone')}</option>
                {orgBusinessUnits.map((bu) => (
                  <option key={bu.id} value={bu.id}>
                    {bu.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('employmentInfo.position')}>
              <select name="positionId" defaultValue="" className={inputCls}>
                <option value="">{t('employmentInfo.positionNone')}</option>
                {orgPositions.map((pos) => (
                  <option key={pos.id} value={pos.id}>
                    {pos.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('locationSelect')}>
              <select name="locationId" defaultValue="" className={inputCls}>
                <option value="">{t('locationNone')}</option>
                {orgLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.code})
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <button className={btnPrimary}>{t('employmentInfo.companyChangeSave')}</button>
            <Link
              href={`/admin/personnel/${emp.employmentId}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`}
              className="text-xs text-primary underline"
            >
              {t('employmentInfo.companyChangeCancel')}
            </Link>
          </div>
        </form>
      ) : companyEditable ? (
        <form method="get" className="space-y-2 border-b border-border p-4">
          <input type="hidden" name="tab" value={tab ?? ''} />
          <Field label={t('employmentInfo.company')}>
            <select name="companyChange" defaultValue={emp.companyId} className={inputCls}>
              {managedCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-3">
            <button className={btnGhost}>{t('employmentInfo.companyChangeContinue')}</button>
          </div>
          <p className="text-xs text-muted-foreground">{t('employmentInfo.companyChangeableHint')}</p>
        </form>
      ) : null}
      {/* 8ebabbf2 — the Organisation Assignment section is VIEW-ONLY. It was a full editing form (its server
          action is deleted; see the note in actions.ts where it stood) that wrote the same facts the Movement
          module records as dated events: two writers for one truth, so the employment history and the employee
          record could disagree and neither said which was right. Every dimension below now changes ONLY through
          Movement → New Event, which attaches an effective date, a reason and a history row to the change.

          The Assignment Effective Date input is GONE with the form: the effective date now exists once, on
          the movement event, instead of on a screen that could date a change nobody recorded.

          What Movement covers, so nothing below lost its writer: Business Unit / Department / Position /
          Work Location / Employment Type (setEmploymentAssignment), Job Grade (setEmploymentGrade), and
          Division / Branch / Region / Line / Section / Team / Base / Category (setEmploymentInfo's flat
          columns) — all reachable from the Transfer / Promotion / Demotion / Organisation Assignment Change /
          Employment Type Change kinds, which submit them as ONE grouped movement (one history row).
          Company is the one exception and keeps its own pre-transaction correction block ABOVE — see the
          note there. */}
      <div className="space-y-3 border-b border-border p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('employmentInfo.assignmentGroup')}</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('employmentInfo.company')}>
            {/* 9464bd56 — read-only here; the correction (pre-transaction only) lives in the block above. When
                the employee has activity the field is locked and points HR to Movement / Transfer. */}
            <input
              value={emp.company}
              disabled
              className={inputCls}
              aria-readonly="true"
              title={!companyEditable ? t('employmentInfo.companyLockedTooltip') : undefined}
            />
            {!companyEditable && (
              <p className="text-xs text-muted-foreground">{t('employmentInfo.companyLockedNote')}</p>
            )}
          </Field>
          {/* 8ebabbf2 — Business Unit / Department / Position / Job Grade / Employment Type are shown as
              STORED, resolved through the same `current` assignment projection the editable selects used, so
              a value that is no longer in its company-scoped option list still displays (the 570e3311
              pinned-current problem disappears entirely once nothing is a <select>). */}
          <Field label={t('employmentInfo.businessUnit')}>
            {readOnlyValue(current?.businessUnit)}
          </Field>
          <Field label={t('employmentInfo.department')}>
            {readOnlyValue(current?.department)}
          </Field>
          <Field label={t('employmentInfo.position')}>
            {readOnlyValue(current?.position)}
          </Field>
          <Field label={t('employmentInfo.jobGrade')}>
            {readOnlyValue(gradeName)}
          </Field>
          <Field label={t('employmentInfo.employmentType')}>
            {readOnlyValue(employmentTypeLabel)}
          </Field>
          {/* R46 b272ab6b — the duplicate read-only Employee Status badge that used to sit here was removed.
              The same derived value already renders TWICE above the fold: on the PageHeader actions slot and
              on the employee summary Card. A third copy inside the form added noise without adding
              information. Blacklisting (the one manual override) now has its own Card on the Movement tab. */}
          {/* 8ebabbf2 — the Assignment Effective Date field was REMOVED here (expected behaviour #1). It only
              ever governed the four effective-dated fields above and had to explain that in helper text; the
              effective date now lives once, on the movement event that makes the change. */}
        </div>

        {/* 8ebabbf2 — the eight flat organisation columns, likewise view-only. They were catalog-backed
            ProfileOptionSelect dropdowns (1001ff61); the stored value is now displayed directly, which is
            what those dropdowns rendered anyway for both catalog and legacy free-text values. Movement's
            comparison form owns them now (core/movement.ts MOVEMENT_FLAT_FIELDS) and keeps the same
            catalog validation, because it writes through the same setEmploymentInfo. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Field label={t('employmentInfo.division')}>
            {readOnlyValue(emp.orgDivision)}
          </Field>
          <Field label={t('employmentInfo.branch')}>
            {readOnlyValue(emp.orgBranch)}
          </Field>
          <Field label={t('employmentInfo.region')}>
            {readOnlyValue(emp.orgRegion)}
          </Field>
          <Field label={t('employmentInfo.line')}>
            {readOnlyValue(emp.orgLine)}
          </Field>
          <Field label={t('employmentInfo.section')}>
            {readOnlyValue(emp.orgSection)}
          </Field>
          <Field label={t('employmentInfo.team')}>
            {readOnlyValue(emp.orgTeam)}
          </Field>
          <Field label={t('employmentInfo.base')}>
            {readOnlyValue(emp.orgBase)}
          </Field>
          <Field label={t('employmentInfo.category')}>
            {readOnlyValue(emp.employmentCategory)}
          </Field>
        </div>

        {/* The pointer that replaces the Save button: where a field used to be editable, the tab says which
            screen changes it now. Without this the section reads as broken rather than as deliberate. */}
        <p className="text-xs text-muted-foreground">
          {t('employmentInfo.assignmentViewOnlyNote')}{' '}
          <Link href={newMovementHref} className="text-primary underline">
            {t('employmentInfo.assignmentViewOnlyLink')}
          </Link>
        </p>
      </div>

      {/* c5ac75fa — Employment Dates is now its own sibling form. It previously shared a form with the
          Organisation fieldset above; that fieldset moved into the assignment form, leaving the dates as the
          sole remaining concern here. setEmploymentInfoAction no longer submits the eight org fields, and its
          helper maps an absent field to `undefined` (untouched) rather than null (clear), so saving dates
          cannot disturb the organisation values. */}
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

          {/* Joining (24c4d02e): Group Join Date (hiredOn, relabelled) + current-company Join Date, each with
              a read-only Length of Service figure.

              89ea527b — BOTH are now VIEW-ONLY. They are set together at hire (hireEmployee seeds
              joinDate = hiredOn, the one-time synchronisation) and afterwards move only through a movement
              event: Join Date Change for a transfer/rehire/restructure, Group Join Date Correction for an
              authorized historical-data fix. The Group Join Date is the one that matters most: it is the
              master service date every leave service band, minimum-service gate and years-of-service figure
              reads (core/leave.ts serviceYearsAt / servedFor), so a free edit here silently re-priced
              somebody's leave entitlement with nothing in the record to say it had happened. Neither input
              carries a `name` any more, and setEmploymentInfo ignores both fields without the matching
              movement tag, so a forged submit cannot set them either. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('employmentInfo.groupJoinDate')}>
              {readOnlyValue(emp.hiredOn)}
              <p className="text-xs text-muted-foreground">
                {t('employmentInfo.groupService')}: {groupServiceLabel ?? '—'}
              </p>
            </Field>
            <Field label={t('employmentInfo.joinDate')}>
              {readOnlyValue(emp.joinDate)}
              <p className="text-xs text-muted-foreground">
                {t('employmentInfo.currentCompanyService')}: {currentServiceLabel ?? '—'}
              </p>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('employmentInfo.joinDatesViewOnlyNote')}{' '}
            <Link href={newMovementHref} className="text-primary underline">
              {t('employmentInfo.assignmentViewOnlyLink')}
            </Link>
          </p>

          {/* b75b2a23 — the cc681bd5 Year of Service ROW moved from here onto the top summary card so the
              figure is visible the moment a profile opens. The label + tooltip are still computed above
              (beside the other service figures) — only the render moved.

              4ea70bb7 — b75b2a23 also said the figure "lives in exactly one place". That stopped being
              true HERE, on this very card: the Group Service caption in the Joining pair at the top of
              this fieldset now prints the SAME string — fmtServiceYmd(emp.hiredOn), character for
              character what the summary card shows as Year of Service. Deliberate, and the same reading as the twin note on the summary
              card: one figure, two captions, ONE calculation. What must stay unique is the calculation,
              not the display — if this page ever needs another service figure, call fmtServiceYmd; never
              add a second piece of date arithmetic. */}

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
            {/* d27961e3 — Extended Confirmation Date and Final Confirmation Date were REMOVED from this card.
                Probation extensions are managed exclusively through the Movement tab (New Event → Probation
                Extension), which records the effective date + remarks in the movement history and remains the
                single mutator of the underlying extended/final columns (kept — they still drive the derived
                probation status). Only the standard Confirmation Date stays editable here. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('employmentInfo.confirmationDate')}>
                <input name="confirmationDate" type="date" defaultValue={emp.confirmationDate ?? ''} className={inputCls} />
              </Field>
            </div>
          </div>

          {/* Contract Information (8590615a) — rendered ONLY for a contract employee, hidden for every other
              type, exactly as the reporter asked. The gate reads the CURRENT open assignment (`current`,
              resolved from the assignment history at the top of this render) because employment_type lives on
              `assignment`, NOT on `employment` — the Employee Type shown read-only above comes from the same
              place. When an employee's type later moves away from Contract the block simply disappears and the
              stored dates and remark are left alone, never erased.

              THE END DATE IS THE PRE-EXISTING employment-review column, not a new one. It was already
              editable, but only as a bare "End Date" row inside Employment Review on the Others tab, which is
              why the reporter could not find it. Both places now write `employment.contract_end_date`, so
              contract-expiry review keeps working on whatever HR types here.

              Contract Start Date pre-fills with the Group Join Date when nothing is recorded yet — a DISPLAY
              default only; nothing is written until HR saves. The end date falls back to provisional_end_on so
              a contract employee hired before this shipped still shows the expiry date the wizard captured. */}
          {current?.employmentType === 'contract' && (
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-foreground">{t('employmentInfo.contractGroup')}</h4>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t('employmentInfo.contractStartDate')}>
                  <input
                    name="contractStartDate"
                    type="date"
                    required
                    defaultValue={emp.contractStartDate ?? emp.hiredOn}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('employmentInfo.contractEndDate')}>
                  <input
                    name="contractEndDate"
                    type="date"
                    required
                    defaultValue={emp.contractEndDate ?? emp.provisionalEndOn ?? ''}
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label={t('employmentInfo.contractRemark')}>
                {/* taCls, not inputCls — inputCls fixes h-9, which collapses a multi-line box to one row.
                    Same constant every other textarea on this page uses. */}
                <textarea
                  name="contractRemark"
                  rows={3}
                  defaultValue={emp.contractRemark ?? ''}
                  className={taCls}
                  placeholder={t('employmentInfo.contractRemarkPlaceholder')}
                />
              </Field>
              <p className="text-xs text-muted-foreground">{t('employmentInfo.contractNote')}</p>
            </div>
          )}

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

        <p className="text-xs text-muted-foreground">{t('employmentInfo.superiorNote')}</p>
        <div className="flex justify-end">
          <button className={btnPrimary}>{t('employmentInfo.save')}</button>
        </div>
      </form>
    </Card>
  ) : null;

  /* Movement tab redesign (78853b97): the former standalone Blacklist card (R46 b272ab6b) is folded
     into the New Event form — kind "Blacklist" routes to the same audited setEmploymentBlacklist
     service (set AND clear), so nothing about the columns or events changed. */

  /* Direct Superior (dce55aff) — replaces the Reporting Lines card. ONE searchable field (Employee ID
     or name) answers the one question the system actually asks: who does this person report to. Saving
     writes the administrative reporting line via setDirectSuperiorAction → setReportingLine (CLOSE +
     INSERT supersede, validFrom = today, cycle + self-assignment refusal, DomainEvents) — the same
     engine every approval/visibility consumer already follows, so the change takes effect everywhere
     immediately. Manager / Line Type / Effective From / multi-line management are gone from the UI;
     existing functional/project/dotted rows remain in the data (org chart still renders them — their
     retirement is a follow-up decision, not decided here). Prior superiors stay visible read-only in
     the compact history disclosure below the field. */
  const directSuperiorCard = (
    <Card id="section-direct-superior">
      <SectionHeader title={t('directSuperiorTitle')} />
      <div className="space-y-4 p-4">
        <div className="text-sm">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('directSuperiorCurrent')}</div>
          {currentSuperior ? (
            <Link href={`/admin/personnel/${currentSuperior.employmentId}`} className="font-medium text-foreground hover:text-primary">
              {superiorLabel(currentSuperior.employeeCode, currentSuperior.name)}
            </Link>
          ) : (
            <span className="text-muted-foreground">{t('directSuperiorNone')}</span>
          )}
        </div>
        {!emp.terminatedOn && others.length > 0 && (
          <form action={setDirectSuperiorAction} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
            <input type="hidden" name="employmentId" value={emp.employmentId} />
            {/* The no-change guard + the "clear → end current line" path both need the current state. */}
            <input type="hidden" name="currentSuperiorEmploymentId" value={currentSuperior?.employmentId ?? ''} />
            <input type="hidden" name="currentLineId" value={currentSuperior?.id ?? ''} />
            <div className="sm:col-span-2">
              <Field label={t('directSuperiorLabel')}>
                <Combobox
                  name="superiorEmploymentId"
                  value={currentSuperior?.employmentId ?? ''}
                  options={superiorOptions}
                  placeholder={t('directSuperiorNone')}
                  searchPlaceholder={t('directSuperiorSearch')}
                  noResultsLabel={t('directSuperiorNoResults')}
                  legacySuffix=""
                />
              </Field>
            </div>
            <div>
              <button className={btnPrimary}>{t('directSuperiorSave')}</button>
            </div>
          </form>
        )}
        {superiorHistory.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('directSuperiorHistory')}
            </summary>
            <ul className="mt-2 space-y-1">
              {superiorHistory.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3">
                  <Link href={`/admin/personnel/${h.managerEmploymentId}`} className="text-foreground hover:text-primary">
                    {superiorLabel(h.employeeCode, h.name)}
                  </Link>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {h.validFrom} → {h.validTo}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-xs text-muted-foreground">{t('directSuperiorHint')}</p>
      </div>
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

  // Item 52a30630 — Holiday Calendar RELOCATED here from Profile > Personal Details. Its own dedicated form
  // + thin server action (setEmploymentHolidayCalendarAction) so the unified state/group selector can no
  // longer be wiped by a Personal Details save (which no longer touches these columns). Same select markup,
  // options (holidayGroups + MY_STATES) and default (holidayCalendarValue) as before — pure relocation.
  const holidayCalendarCard = admin ? (
    <Card id="section-holiday-calendar">
      <SectionHeader title={t('holidayCalendarCardTitle')} />
      <form action={setEmploymentHolidayCalendarAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3">
        <input type="hidden" name="employmentId" value={emp.employmentId} />
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
              {stateOptions.map((st) => (
                <option key={st} value={`state:${st}`}>
                  {st}
                </option>
              ))}
            </optgroup>
          </select>
        </Field>
        <div className="sm:col-span-3 flex justify-end">
          <button className={btnPrimary}>{t('saveDetails')}</button>
        </div>
      </form>
    </Card>
  ) : null;

  const locationCard = admin ? (
    <Card id="section-location">
      <SectionHeader title={t('locationTitle')} />
      <div className="px-4 pt-3 text-sm text-muted-foreground">
        {t('locationCurrent', { location: emp.locationName ? `${emp.locationName} (${emp.locationCode})` : t('locationNone') })}
      </div>

      {/* 1fff489c PHASE 2 — the SUGGESTION. Pre-selected and dated, but it is still a form the admin has to
          submit: spec section C is explicit that a work location moves payroll and OT history, so nothing
          auto-commits. Confirm posts source=branch_derived; the manual form below posts source=manual, and
          the two are told apart on the event stream afterwards (core/location.ts recordLocationSource). */}
      {!emp.terminatedOn && branchLocationSuggestion && (
        <form
          action={setLocationAction}
          className="mx-4 mt-3 grid grid-cols-1 items-end gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 sm:grid-cols-3"
        >
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          <input type="hidden" name="locationId" value={branchLocationSuggestion.id} />
          <input type="hidden" name="source" value="branch_derived" />
          <div className="sm:col-span-3 text-xs font-medium text-primary">
            {t('locationSuggestedFromBranch', { branch: branchLocationSuggestion.branch })}
          </div>
          <Field label={t('locationSelect')}>
            <div className={`${inputCls} bg-muted`}>
              {branchLocationSuggestion.name} ({branchLocationSuggestion.code})
            </div>
          </Field>
          <Field label={t('effectiveDate')}>
            <input name="effectiveDate" type="date" required defaultValue={suggestedEffectiveDate} className={inputCls} />
          </Field>
          <div>
            <button className={btnPrimary}>{t('locationConfirm')}</button>
          </div>
          <p className="sm:col-span-3 text-xs text-muted-foreground">{t('locationSuggestionNote')}</p>
        </form>
      )}

      {/* EMPTY STATE 2 of 4 (spec section E): the employee HAS a branch, but no live location in their own
          company claims it. Today this reads as a bare "No location", which looks identical to the three
          other reasons the field can be blank — naming the branch is what makes it fixable. */}
      {!emp.terminatedOn && !emp.locationId && !branchLocationSuggestion && emp.orgBranch && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t('locationBranchUnmapped', { branch: emp.orgBranch })}
        </p>
      )}
      {!emp.terminatedOn && !emp.locationId && !emp.orgBranch && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">{t('locationNoBranch')}</p>
      )}

      {!emp.terminatedOn && (
        <form action={setLocationAction} className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3">
          <input type="hidden" name="employmentId" value={emp.employmentId} />
          {/* Anything picked here is a deliberate human choice — stamped `manual` so a later report can
              tell a hand-set location from one taken off the Branch. */}
          <input type="hidden" name="source" value="manual" />
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

  /* Movement tab redesign (78853b97): the former Transfer + Terminate cards are folded into the New
     Event form — kinds "Transfer" (via setEmploymentAssignment since 08913328, so location, cost centre
     AND business unit all carry) and "Termination" (via terminateEmployment, confirmation-gated in the
     island) reuse the same audited services and DomainEvents; only the entry point changed. */

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
    // Single-card tabs pass the node directly so a null (defensive; scopedAdmin guarantees non-null
    // here) falls through to the shell's empty-state rather than rendering a blank fragment.
    profile: profilePanel,
    family: familyPanel,
    job: (
      <>
        {employmentInfoCard}
        {directSuperiorCard}
        {delegationsCard}
      </>
    ),
    // Movement tab redesign (78853b97): ONE clean screen — the Employment History timeline (a
    // Hired-first projection over the domain_event ledger) with a single New Event button that folds in
    // the former Transfer / Terminate / Blacklist boxes (their audited services are reused, not
    // rewritten). The detail view (?movement=<id>) and the New Event form (?newEvent=1) render ABOVE
    // the history so opening either never loses the timeline context.
    careerMovement: (
      <>
        {movementDetailCard}
        {newEventCard}
        {editEventCard}
        {employmentHistoryCard}
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
        {/* Item 52a30630 — Holiday Calendar relocated from Profile onto this tab, pinned first. */}
        {holidayCalendarCard}
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
        {/* Item df09f22a — the Identification & Tax card was merged into statutoryCard as a nested "Income Tax
            (PCB)" section (Income tax is a Malaysia statutory item). One box now holds every statutory field. */}
        {statutoryCard}
        {/* Feedback 0df0c635 — Others Statutory pinned BELOW the existing statutory cards (reporter-specified
            order: Statutory (Malaysia) → Tax Information → Others Statutory). */}
        {othersStatutoryCard}
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
    // R46 79eb7151 — payrollPolicyCard moved from LAST to SECOND, directly under compensationCard. It was
    // the layout root cause: Pay Mode and Payment Term both live on the payroll policy, but the card holding
    // it sat below pay components, CP38, encashment, TP3 and zakat, so from the Salary section at the top of
    // the tab they looked absent. Basic Salary and the policy that decides how it is paid now read together.
    // compensationCard stays FIRST (feedback 326f0b5e) — Basic Salary must still open at the top.
    payroll: (
      <>
        {compensationCard}
        {payrollPolicyCard}
        {payComponentsCard}
        {cp38Card}
        {encashmentCard}
        {tp3Card}
        {zakatSummaryCard}
      </>
    ),
    // Leave Information (feedback d085c6fc): the Leave Balance card — including its entitlement
    // breakdown drill-down — relocated out of Payroll into a dedicated leave-management tab. Same
    // card, same data (loaded once for the page), just a different tab; no leave/payroll logic moved.
    leave: (
      <>
        {/* Item 52a30630 — Grade relocated from Profile onto this tab, pinned above the balance card. */}
        {gradeCard}
        {leaveBalanceCard}
        {/* R45 7527ea5f — profile-change entitlement recalculation history. */}
        {recalcHistoryCard}
      </>
    ),
    documents: documentsPanel,
    // Qualification (feedback a949184a): the academic/professional qualification register — a single card
    // mirroring the Family tab's list-and-dialog pattern (see qualificationPanel above).
    qualification: qualificationPanel,
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
          hiredOn: emp.hiredOn,
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
              <dd className="font-medium text-foreground">{emp.hiredOn}</dd>
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
