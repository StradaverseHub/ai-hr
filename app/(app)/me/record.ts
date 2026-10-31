/** Own Personnel projection. Explicit employment selection is intersected with the session's own
 * subjects before canonical RLS reads; no administrator row is spread into the screen. */
import { compensationHistoryDetailed } from '@/core/comp';
import { listDependents } from '@/core/dependents';
import { listEmergencyContacts } from '@/core/emergency-contacts';
import { assignmentHistory, employeeDetail, myEmployment, myOwnEmploymentSubjects, ownReportingManagersTx } from '@/core/read';
import {withTenant,type SessionContext} from '@/db/client';
import {todayInKualaLumpur} from '@/lib/hr-date';
import { packFor } from '@/localization/registry';

export type MyProfileRecord = NonNullable<Awaited<ReturnType<typeof myProfileRecord>>>;

/**
 * The caller's own personnel record, redacted to what an employee may see.
 *
 * A supplied employment ID must be one of this person’s own employments. Ambiguous unselected multiple
 * employments return null so the page offers an explicit picker.
 */
export async function myProfileRecord(ctx: SessionContext,selectedEmploymentId?:string) {
  const own=await myOwnEmploymentSubjects(ctx);
  const me=selectedEmploymentId?own.find(row=>row.employmentId===selectedEmploymentId):own.length===1?own[0]:null;
  if (!me) return null;
  const employmentId = me.employmentId;

  // RLS-gated by `employment_rls`; the id came from myEmployment, i.e. from ctx.personId.
  const emp = await employeeDetail(ctx, employmentId);
  if (!emp) return null;

  const pack = packFor(me.country);
  const [statutoryRow, dependentRows, emergencyRows, salaryRows, lines, assignments] = await Promise.all([
    pack?.statutory.get(ctx, emp.personId) ?? Promise.resolve(null),
    listDependents(ctx, { personId: emp.personId }),
    listEmergencyContacts(ctx, { personId: emp.personId }),
    compensationHistoryDetailed(ctx, employmentId),
    withTenant(ctx,tx=>ownReportingManagersTx(tx,employmentId)),
    // Department / Position / Business Unit / Employment Type live on the dated ASSIGNMENT, not on the
    // employment row — the same place the Personnel screen reads them from (`const current` there).
    assignmentHistory(ctx, employmentId),
  ]);
  const today=todayInKualaLumpur();
  const applicableAssignments=assignments.filter(row=>row.validFrom<=today&&(!row.validTo||row.validTo>today));
  const currentAssignment=applicableAssignments.length===1?applicableAssignments[0]:null;

  // The CURRENT salary only. The revision history carries HR's remark on each increment, which is on the
  // withheld list — so it is not projected at all rather than projected and then not rendered.
  const applicableSalary=salaryRows.filter(row=>row.validFrom<=today&&(!row.validTo||row.validTo>today));
  const current=applicableSalary.length===1?applicableSalary[0]:null;

  // Direct Superior: the administrative line. Name + employee code only — never the manager's contact
  // details, and never the `reports` half of `ownReportingManagersTx` (that is who reports to THIS person,
  // which is a management view and not part of one's own record).
  const administrative=lines.filter(row=>row.lineType==='administrative');
  const superior=administrative.length===1?administrative[0]:null;

  return {
    employmentId,
    country:me.country,
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
      // Retained legacy address for explicit reconciliation; the new editor owns canonical addresses.
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
    // geofencing settings, payrollPolicyId/Name, defaultShiftId. See app/(app)/me/visible-fields.ts.
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
      taxCircumstance:statutoryRow?.taxCircumstance??null,
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
