/**
 * MY PROFILE — THE EMPLOYEE-SCOPED READ.
 *
 * r259 stage one (board item 9583deac). One function, and the security property of the whole screen is
 * the first three lines of it: the employment being read is resolved FROM THE SESSION, through
 * `myEmployment(ctx)`, which matches on `ctx.personId`. There is no employmentId parameter, so there is
 * no parameter for a client to change — the /me route takes no id segment and no id search param, and
 * `myProfileRecord` refuses to accept one. That is deliberate and is pinned by
 * test/me-profile-scope.test.ts.
 *
 * ── RLS DOES THE WORK, NOT A FILTER IN THE PAGE ─────────────────────────────────────────────────────
 * Every read below runs under `withTenant`, so `employment_rls` / `employee_statutory_my_rls` /
 * `employee_dependent_rls` / `person_emergency_contact_rls` / `compensation_rls` decide what comes back.
 * For a plain employee `app.can_see_employment(id)` resolves to their OWN employment only (migration
 * 0016: admin-for-company ∪ self ∪ administrative-manager-of). So even if a future caller handed this
 * module somebody else's id, the database would return nothing — the scope is not a `.where()` in a page
 * that a refactor could drop. The DB half of that claim is asserted against a live cluster in
 * test/me-profile-scope.test.ts by calling `employeeDetail` with a colleague's id under an employee
 * session and getting null.
 *
 * NOTE ON `server-only`: deliberately NOT imported. That package THROWS outside a React Server Component
 * environment (see the note on core/auth.ts about lib/workos), and test/me-profile-scope.test.ts calls
 * `myProfileRecord` directly against a live cluster — which is the only way to prove the RLS scope rather
 * than describe it. Every module this file imports is already server-side (db/client opens a connection),
 * so a client component that reached for it would fail to build regardless.
 *
 * ── WHY THE PROJECTION IS EXPLICIT ──────────────────────────────────────────────────────────────────
 * `employeeDetail` and `getStatutoryProfileMY` return the ADMINISTRATOR'S view of the record — the whole
 * row, blacklist reason and all. Spreading either straight into the page would put the hidden fields one
 * careless object-spread away from the screen — which is why there is none, and why
 * test/me-profile-visibility.test.ts greps for the two that would do it. Every field an employee may see is therefore named here, once,
 * and the list of what is withheld and why is app/me/visible-fields.ts + docs/me-profile-field-visibility.md.
 */

import { compensationHistoryDetailed } from '@/core/comp';
import { listDependents } from '@/core/dependents';
import { listEmergencyContacts } from '@/core/emergency-contacts';
import { assignmentHistory, employeeDetail, myEmployment, reportingLinesFor } from '@/core/read';
import type { SessionContext } from '@/db/client';
import { packFor } from '@/localization/registry';

export type MyProfileRecord = NonNullable<Awaited<ReturnType<typeof myProfileRecord>>>;

/**
 * The caller's own personnel record, redacted to what an employee may see.
 *
 * Takes NO employment id. Returns null when the principal is linked to no active employment (a platform
 * login, or a person who was never hired) — the page renders its "not linked" card for that.
 */
export async function myProfileRecord(ctx: SessionContext) {
  const me = await myEmployment(ctx);
  if (!me) return null;
  const employmentId = me.employmentId;

  // RLS-gated by `employment_rls`; the id came from myEmployment, i.e. from ctx.personId.
  const emp = await employeeDetail(ctx, employmentId);
  if (!emp) return null;

  const pack = packFor('MY');
  const [statutoryRow, dependentRows, emergencyRows, salaryRows, lines, assignments] = await Promise.all([
    pack?.statutory.get(ctx, emp.personId) ?? Promise.resolve(null),
    listDependents(ctx, { personId: emp.personId }),
    listEmergencyContacts(ctx, { personId: emp.personId }),
    compensationHistoryDetailed(ctx, employmentId),
    reportingLinesFor(ctx, employmentId),
    // Department / Position / Business Unit / Employment Type live on the dated ASSIGNMENT, not on the
    // employment row — the same place the Personnel screen reads them from (`const current` there).
    assignmentHistory(ctx, employmentId),
  ]);
  const currentAssignment = assignments.find((a) => !a.validTo) ?? assignments[0] ?? null;

  // The CURRENT salary only. The revision history carries HR's remark on each increment, which is on the
  // withheld list — so it is not projected at all rather than projected and then not rendered.
  const current = salaryRows.find((r) => r.validTo == null) ?? salaryRows[0] ?? null;

  // Direct Superior: the administrative line. Name + employee code only — never the manager's contact
  // details, and never the `reports` half of `reportingLinesFor` (that is who reports to THIS person,
  // which is a management view and not part of one's own record).
  const superior =
    lines.managers.find((m) => m.lineType === 'administrative') ?? lines.managers[0] ?? null;

  return {
    employmentId,
    personId: emp.personId,

    // ── Profile ─────────────────────────────────────────────────────────────────────────────────────
    profile: {
      employeeCode: emp.employeeCode,
      salutation: emp.salutation,
      fullName: emp.name,
      firstName: emp.firstName,
      lastName: emp.lastName,
      preferredName: emp.preferredName,
      nationality: emp.nationality,
      religion: emp.religion,
      race: emp.race,
      gender: emp.gender,
      maritalStatus: emp.marital,
      dateOfBirth: emp.dateOfBirth,
      icNumber: statutoryRow?.icNumber ?? null,
      oldIcNumber: statutoryRow?.oldIcNumber ?? null,
      passportNumber: statutoryRow?.passportNumber ?? null,
      passportIssueDate: statutoryRow?.passportIssueDate ?? null,
      passportExpiryDate: statutoryRow?.passportExpiryDate ?? null,
      passportIssuingCountry: statutoryRow?.passportIssuingCountry ?? null,
    },
    contact: {
      workEmail: emp.email,
      mobilePhone: emp.phone,
      homePhone: emp.homePhone,
      personalEmail: emp.personalEmail,
      /**
       * ── ONE ADDRESS, AND IT IS THE ONE THE SAVE BUTTON CHANGES ────────────────────────────────────
       *
       * `person` carries THREE address column families today: the legacy `address_line1..country` block
       * that `core/profile.ts updateOwnContact` writes (the employee's own self-edit, ADR-0012 path one),
       * and the `permanent_*` / `correspondence_*` pair that 3a25f5ee split out and that the Personnel
       * Contact & Address card writes. Migration 0213 backfilled the legacy block INTO permanent, and the
       * two have been free to diverge ever since.
       *
       * The first cut of this round projected the permanent/correspondence pair and rendered it read-only
       * ABOVE the self-edit fold-out, which still posts the legacy names. That put two different addresses
       * on one card under a Save button that moved neither of the ones displayed — the employee edits
       * their address, saves, and the address printed on that same card does not move, while the phone
       * and personal email beside it do (those columns are shared). It also broke the plan's own promise
       * to the reporter: "My Profile will not hold a second copy of anybody's information ... there is
       * only ever one master."
       *
       * So My Profile projects ONE family: the one the employee can actually change. Unifying the columns
       * needs a migration and a decision about which family wins, which is neither this round's scope nor
       * something to decide inside a read surface. Until then the card is honest — what it displays is
       * what its Save button writes — and docs/me-profile-field-visibility.md tells the reporter, in their
       * own language, that HR's Permanent / Correspondence address is not on this screen yet and why.
       *
       * The KEYS below are the form's `name=` attributes on purpose: app/me/page.tsx binds both the
       * read-only fields and the fold-out's inputs to this one object, and
       * test/me-profile-visibility.test.ts walks the form's own `name=` list and requires each address
       * field to be displayed from it. Rename one here and the guard names the field that fell out.
       */
      homeAddress: {
        addressLine1: emp.addressLine1,
        addressLine2: emp.addressLine2,
        addressLine3: emp.addressLine3,
        postcode: emp.postcode,
        city: emp.city,
        state: emp.state,
        country: emp.country,
      },
    },
    // `remarks` is withheld (an HR note about the contact, not about the employee). `address` IS carried:
    // the contact self-edit posts `emergencyContactAddress`, so it has to be on screen — a field that can
    // be saved and cannot be seen is the same defect as an address that can be seen and cannot be saved.
    emergencyContacts: emergencyRows.map((c) => ({
      id: c.id,
      fullName: c.fullName,
      relationship: c.relationship,
      mobilePhone: c.mobilePhone,
      homePhone: c.homePhone,
      address: c.address,
      priority: c.priority,
    })),

    // ── Employment ──────────────────────────────────────────────────────────────────────────────────
    // NOT projected, deliberately: blacklistedAt / blacklistReason, contractRemark, holidayGroupId,
    // geofencing settings, payrollPolicyId/Name, defaultShiftId. See app/me/visible-fields.ts.
    employment: {
      company: emp.company,
      department: currentAssignment?.department ?? null,
      position: currentAssignment?.position ?? null,
      businessUnit: currentAssignment?.businessUnit ?? null,
      employmentType: currentAssignment?.employmentType ?? null,
      locationName: emp.locationName,
      gradeName: emp.gradeName,
      employmentCategory: emp.employmentCategory,
      orgDivision: emp.orgDivision,
      orgBranch: emp.orgBranch,
      orgRegion: emp.orgRegion,
      orgLine: emp.orgLine,
      orgSection: emp.orgSection,
      orgTeam: emp.orgTeam,
      orgBase: emp.orgBase,
      hiredOn: emp.hiredOn,
      joinDate: emp.joinDate,
      confirmationDate: emp.finalConfirmationDate ?? emp.confirmationDate,
      contractStartDate: emp.contractStartDate,
      contractEndDate: emp.contractEndDate,
      tenderResignationDate: emp.tenderResignationDate,
      resignationDate: emp.resignationDate,
      lastWorkingDate: emp.lastWorkingDate,
      superiorName: superior?.name ?? null,
      superiorCode: superior?.employeeCode ?? null,
    },

    // ── Bank & Statutory ────────────────────────────────────────────────────────────────────────────
    // NOT projected: employerBearsEpf / employerBearsSocso / employerBearsEis / employerBearsSkbbk /
    // employerBearsTax (the employer's cost position) and childReliefTable (tenant tax configuration).
    statutory: {
      bankName: statutoryRow?.bankName ?? null,
      bankAccountNo: statutoryRow?.bankAccountNo ?? null,
      epfNumber: statutoryRow?.epfNumber ?? null,
      epfCitizenship: statutoryRow?.epfCitizenship ?? null,
      socsoNumber: statutoryRow?.socsoNumber ?? null,
      socsoCategory: statutoryRow?.socsoCategory ?? null,
      eisCategory: statutoryRow?.eisCategory ?? null,
      taxNumber: statutoryRow?.taxNumber ?? null,
      taxCategory: statutoryRow?.taxCategory ?? null,
      isResident: statutoryRow?.isResident ?? null,
      numChildren: statutoryRow?.numChildren ?? null,
      disabledIndividual: statutoryRow?.disabledIndividual ?? null,
      disabledSpouse: statutoryRow?.disabledSpouse ?? null,
      subjectToHrdf: statutoryRow?.subjectToHrdf ?? null,
    },

    // ── Payroll ─────────────────────────────────────────────────────────────────────────────────────
    // `remarks` and `createdByName` are on the withheld list and are not carried across.
    compensation: current
      ? {
          basicSalary: current.basicSalary,
          currency: current.currency,
          monthlyAllowance: current.monthlyAllowance,
          payMode: current.payMode,
          paymentTerm: current.paymentTerm,
          rateAmount: current.rateAmount,
          validFrom: current.validFrom,
        }
      : null,
    paymentMethod: emp.paymentMethod,

    // ── Family ──────────────────────────────────────────────────────────────────────────────────────
    // `remarks`, `occupation`, `companyName` and `employerAddress` are withheld (HR notes about a family
    // member, and a third party's employer).
    // `childTaxRelief` / `isStudent` / `archivedAt` are carried because `isChildReliefEligible` needs
    // them to answer the "Counts toward relief" column — the SAME predicate the Personnel table uses, so
    // the two screens cannot disagree about whether a child is counted.
    dependents: dependentRows.map((d) => ({
      id: d.id,
      fullName: d.fullName,
      relationship: d.relationship,
      dateOfBirth: d.dateOfBirth,
      phone: d.phone,
      isBeneficiary: d.isBeneficiary,
      isDeceased: d.isDeceased,
      isStudent: d.isStudent,
      childTaxRelief: d.childTaxRelief,
      archivedAt: d.archivedAt,
    })),
  };
}
