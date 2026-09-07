'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { grantAssistant, revokeAssistant } from '@/core/assistant-grant';
import {
  archiveBusinessUnit,
  archiveCompany,
  archiveCostCenter,
  archiveDepartment,
  archiveLeaveType,
  archivePosition,
  assignRole,
  createBusinessUnit,
  createCompany,
  createCostCenter,
  createDepartment,
  createHoliday,
  createHolidayGroup,
  createLeaveType,
  createPosition,
  deleteHoliday,
  deleteHolidayGroup,
  updateHoliday,
  updateHolidayGroup,
  deleteCompany,
  deleteCostCenter,
  deleteDepartment,
  deleteLeaveType,
  deletePosition,
  revokeRole,
  setCompanyParent,
  setCompanyDefaultPayrollCycle,
  setCompanyLogo,
  removeCompanyLogo,
  setLeaveHalfDayFullDeductionCompanies,
  updateBusinessUnit,
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeaveType,
  updatePosition,
  setLeaveTypeRules,
  LeaveTypeRuleError,
} from '@/core/admin';
import {
  accrueEarnedLeave,
  asOfForLeaveYear,
  // bc36c768 — the leave-type counterpart of the scheme cohort, fired after an earning-method save clears
  // the NOT-CONFIGURED marker.
  reprojectEntitlementForLeaveTypeCohort,
  todayInKualaLumpur,
  DAY_TYPE_INCLUSION_KEYS,
  type DayTypeInclusion,
  type EarnedAccrualGroup,
  type LeaveDurationType,
  type LeaveEligibility,
  // 8fec719e — one row of the custom rounding table, parsed out of the editor's single JSON field.
  type RoundingBand,
  type ServiceBand,
} from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
// 93249794 — the Generate Entitlement run. `openLeaveYear` is no longer imported here: this file reaches
// the grant sweep THROUGH core/leave-generation.ts, which calls it and writes the processing log, so the
// engine has one entry point from the app layer instead of two.
import { runLeaveGeneration } from '@/packs/leave/service';
import { orgCriteriaFromFields } from '@/core/org-criteria';
// Override Leave Application (56910869): the trigger list the form iterates, so the card and the parser
// cannot disagree about which rows exist.
import { LEAVE_OVERRIDE_TRIGGERS, type LeaveOverrideAction } from '@/core/leave-override';
import { setAttendancePolicy } from '@/packs/attendance/service';
import {
  createLocation,
  updateLocation,
  archiveLocation,
  restoreLocation,
  LocationBranchTakenError,
  LocationCodeTakenError,
} from '@/core/location';
import {
  createClockingLocation,
  updateClockingLocation,
  archiveClockingLocation,
  restoreClockingLocation,
  deleteClockingLocation,
  ClockingLocationInUseError,
  type RadiusAdvisory,
} from '@/packs/attendance/service';
import { countEmployeesInScope } from '@/core/read';
import { ESS_VIEW_COMPONENT_KEYS, type EssViewConfig } from '@/core/ess-view';
import { LEAVE_EXPLANATION_KEYS, type LeaveFormulaConfig } from '@/core/leave-formula';
import { requireAdmin } from '@/lib/authz';
import {
  createGradeGroup,
  updateGradeGroup,
  deleteGradeGroup,
} from '@/core/benefit-scheme';
// r88 1ef1cf95 — shared leave groups are tenant-level now, so their CRUD has its own module rather than
// riding on the benefit-scheme one.
import {
  createLeaveSharedGroup,
  updateLeaveSharedGroup,
  deleteLeaveSharedGroup,
  LeaveTypeAlreadyGroupedError,
  LeaveSharedGroupNameTakenError,
} from '@/core/leave-shared-group';
import { inviteUser, revokeInvitation, setAppUserArchived } from '@/core/auth';
import { setToilPolicy, runToilExpiry, closeReplacementLeaveYear } from '@/core/toil';
import { REPLACEMENT_ELIGIBILITY_CRITERIA, type ReplacementRequestEligibility } from '@/core/replacement-eligibility';
import { setEncashmentPolicy } from '@/core/leave-encashment';
import type { ToilAccrualBasis, ToilExpiryAction, ToilExpiryUnit, ToilReplacementLeaveFrom } from '@/db/schema';
import { upsertCompanyBankProfile, removeCompanyBankProfile, type DisbursementBank } from '@/core/bank-profile';
import { isMyBankKey } from '@/lib/my-banks';
import {
  upsertCompanyStatutoryAuthority,
  removeCompanyStatutoryAuthority,
} from '@/core/statutory-authority';
import { packFor } from '@/localization/registry';
// 4e9a4d59 — the post-action redirect contract lives in a plain module so BOTH this file and
// app/admin/leave-approval/actions.ts share ONE okEntitlements (a 'use server' file can only export
// async functions, so these helpers could never be exported from here).
import { ENTITLEMENTS, GENERATE, SYSTEM_LABELS, fail, ok, okToast, okEntitlements } from './_redirects';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
// 4b0e76ae — the managed Leave-Year table and its five create/edit/open/close/delete/opening-rule actions
// are GONE (cc816207 → 1e4eb8af moved that section twice; this item removed it). The one surviving
// leave-year action is openLeaveYearAction, and it redirects to GENERATE, not here. LEAVE remains the
// redirect target of the leave TYPE master actions on /admin/leave.
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';
// 66b8f5a8 — the Holiday Group tab + its dedicated add/edit pages.
const HOLIDAY_GROUPS = '/admin/holidays/groups';
// R33 f21d6eee — the per-company attendance policy + OT-rates form moved to its own /admin/attendance-policy
// screen (the /admin/attendance route is now the shared shift library). setAttendancePolicyAction redirects here.
// af7a8eb4 — and moved again, one level down: /admin/attendance-policy is now the calculation-rule LIST and
// no longer renders these forms at all, so redirecting there would drop the operator on a screen that does
// not show what they just saved. Only setAttendancePolicyAction reads this constant.
const ATTENDANCE_POLICY = '/admin/attendance-policy/schedule';
// 296fc027 split this route in two. /admin/toil keeps the balance LEDGER and the two settlement sweeps
// (deliberately not entitlement-gated — see core/toil.ts); CONFIGURATION moved to the Leave Config tab
// below, which is where setToilPolicyAction now redirects. Both routes stay registered in lib/permissions.
const TOIL_POLICY = '/admin/toil';
const LEAVE_REPLACEMENT = '/admin/leave/replacement';
const LOCATIONS = '/admin/locations';

export async function createCompanyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createCompany(s, {
      legalName: String(formData.get('legalName') ?? '').trim(),
      country: String(formData.get('country') ?? 'MY'),
      currency: String(formData.get('currency') ?? 'MYR'),
      registrationNo: (formData.get('registrationNo') as string) || undefined,
      // Organization Module (361e3b15): the Default Payroll Cycle picker (pre-set to Monthly). createCompany
      // resolves it against the standard catalog it seeds, defaulting to 'Monthly' for any unknown/blank value.
      defaultPayrollCycle: (formData.get('defaultPayrollCycle') as string) || undefined,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

/**
 * Organization Module — Automatic Payroll Cycle Assignment (361e3b15). Change a company's default payroll
 * cycle later from the company's General settings. The core validates the name resolves to an active cycle in
 * that company and audits the before→after change; a successful save confirms via a localised toast.
 */
export async function updateCompanyDefaultCycleAction(formData: FormData) {
  const s = await getSession();
  try {
    await setCompanyDefaultPayrollCycle(s, {
      companyId: String(formData.get('companyId')),
      cycleName: String(formData.get('defaultPayrollCycle') ?? ''),
    });
  } catch (e) {
    fail(ORG, e);
  }
  const t = await getTranslations('admin.organization');
  okToast(ORG, t('defaultPayrollCycleSaved'));
}

/**
 * Derive a TRUSTWORTHY image mime from the file's leading bytes (fail-closed: unknown signature → null). A
 * local 5-line copy — deliberately NOT the claims sniffMime (which trusts PDF) and NOT extracted into a
 * shared module, so the claims path stays byte-identical. PNG + JPEG only; SVG is never accepted (its
 * scriptable payload survives sniffing as a valid image).
 */
function sniffImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export async function setCompanyLogoAction(formData: FormData) {
  const s = await getSession();
  try {
    const file = formData.get('logo');
    if (!(file instanceof File) || file.size === 0) throw new Error('Choose a logo image to upload');
    // Check size BEFORE buffering, so a 50 MB upload is rejected without reading it all into memory.
    if (file.size > LOGO_MAX_BYTES) throw new Error('Logo exceeds 2 MB');
    const content = Buffer.from(await file.arrayBuffer());
    const mimeType = sniffImageMime(content);
    if (!mimeType) throw new Error('Only PNG or JPG images are allowed');
    await setCompanyLogo(s, {
      companyId: String(formData.get('companyId')),
      content,
      fileName: file.name,
      mimeType,
      sizeBytes: content.byteLength,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function removeCompanyLogoAction(formData: FormData) {
  const s = await getSession();
  try {
    await removeCompanyLogo(s, { companyId: String(formData.get('companyId')) });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function setCompanyParentAction(formData: FormData) {
  const s = await getSession();
  const parent = String(formData.get('parentCompanyId') ?? '');
  try {
    await setCompanyParent(s, {
      companyId: String(formData.get('companyId')),
      parentCompanyId: parent || null,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

/**
 * r226 — read a statutory-identity field ONLY if the submitted form actually carried it.
 *
 * This tiny distinction is what lets the identity row be edited from five different forms without one
 * save blanking the others. `undefined` (the key is absent) means "this form does not own that field —
 * leave the stored value alone"; `''` (the key is present and empty) means "the operator cleared it".
 * `(formData.get(k) as string) || undefined` collapses those two into one, which is exactly the bug:
 * under the old full-row writer it blanked four columns, and under the new partial-patch writer it would
 * make a field impossible to CLEAR. See localization/my/company-statutory.ts.
 */
function postedField(formData: FormData, key: string): string | undefined {
  return formData.has(key) ? String(formData.get(key) ?? '') : undefined;
}

/** The HRDF rate as posted, or undefined when the form did not carry the select at all. */
function postedHrdfStatus(formData: FormData): 'not_registered' | 'mandatory' | 'optional' | undefined {
  const raw = String(formData.get('hrdfStatus') ?? '');
  return raw === 'not_registered' || raw === 'mandatory' || raw === 'optional' ? raw : undefined;
}

export async function setCompanyStatutoryAction(formData: FormData) {
  const s = await getSession();
  const country = String(formData.get('country') ?? 'MY');
  try {
    const pack = packFor(country);
    if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${country}`);
    // Every field is read through postedField, so this action now writes exactly the boxes the form in
    // front of the operator actually had. r226 left only MyInvois + SSM on the Statutory tab's identity
    // list (the rest moved onto their own body's card) — and this action still serves BOTH shapes, which
    // is why it keeps reading all five names rather than shrinking to two.
    await pack.companyStatutory.set(s, {
      companyId: String(formData.get('companyId')),
      epfEmployerNo: postedField(formData, 'epfEmployerNo'),
      socsoEmployerCode: postedField(formData, 'socsoEmployerCode'),
      lhdnEmployerNo: postedField(formData, 'lhdnEmployerNo'),
      myinvoisTin: postedField(formData, 'myinvoisTin'),
      ssmRegistrationNo: postedField(formData, 'ssmRegistrationNo'),
      hrdfStatus: postedHrdfStatus(formData),
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function setCompanyBankProfileAction(formData: FormData) {
  const s = await getSession();
  const bank = String(formData.get('bank') ?? '');
  try {
    // R46 orgbank (84719377): the bank set is the shared Malaysian master (lib/my-banks.ts), not a
    // 4-value enum. The service re-validates — this is the early, friendlier rejection.
    if (!isMyBankKey(bank)) throw new Error('Select a bank from the Malaysian bank list');
    await upsertCompanyBankProfile(s, {
      // Present ⇒ edit that account; absent ⇒ add another (a company may hold several, incl. per bank).
      id: (formData.get('id') as string) || null,
      companyId: String(formData.get('companyId')),
      bank: bank as DisbursementBank,
      corporateId: String(formData.get('corporateId') ?? ''),
      debitAccountNo: String(formData.get('debitAccountNo') ?? ''),
      orgName: (formData.get('orgName') as string) || null,
      // R46: the Payment rail picker is hidden from the form, so this is normally absent and the service
      // keeps the 'IBG' default. The column stays — RENTAS matters for large single payments.
      txnType: (formData.get('txnType') as string) || null,
      accountLabel: (formData.get('accountLabel') as string) || null,
      accountName: (formData.get('accountName') as string) || null,
      accountType: (formData.get('accountType') as string) || null,
      branch: (formData.get('branch') as string) || null,
      swiftCode: (formData.get('swiftCode') as string) || null,
      currency: (formData.get('currency') as string) || null,
      isPrimary: formData.get('isPrimary') === 'on' || formData.get('isPrimary') === 'true',
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function removeCompanyBankProfileAction(formData: FormData) {
  const s = await getSession();
  try {
    await removeCompanyBankProfile(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

// R46 orgbank (84719377) — per-authority statutory payment configuration. One form per authority; the
// service validates the authority code, that the chosen bank account belongs to this company, and that a
// NEWLY chosen signatory is an active employee of it.
export async function setCompanyStatutoryAuthorityAction(formData: FormData) {
  const s = await getSession();
  try {
    await upsertCompanyStatutoryAuthority(s, {
      companyId: String(formData.get('companyId')),
      authority: String(formData.get('authority') ?? ''),
      accountNo: (formData.get('accountNo') as string) || null,
      bankProfileId: (formData.get('bankProfileId') as string) || null,
      addressLine1: (formData.get('addressLine1') as string) || null,
      addressLine2: (formData.get('addressLine2') as string) || null,
      addressLine3: (formData.get('addressLine3') as string) || null,
      city: (formData.get('city') as string) || null,
      state: (formData.get('state') as string) || null,
      postcode: (formData.get('postcode') as string) || null,
      country: (formData.get('country') as string) || null,
      phone: (formData.get('phone') as string) || null,
      email: (formData.get('email') as string) || null,
      signatoryPersonId: (formData.get('signatoryPersonId') as string) || null,
    });

    // r226 — the card is ONE body, so it saves with ONE button, and that means this action writes the
    // body's two halves into their two tables: the payment setup above (company_statutory_authority) and
    // the number that goes on the body's FILED FORM below (company_statutory_my, via the country pack).
    //
    // `filingCountry` is a hidden input the card renders only when it actually has a filing field, and it
    // is deliberately NOT called `country` — that name is already taken on this form by the authority's
    // postal address. Nothing is written unless the form carried a filing field, and the identity write
    // is a PARTIAL PATCH, so saving the EPF card cannot touch SOCSO's, LHDN's, MyInvois's or SSM's number.
    const filingCountry = String(formData.get('filingCountry') ?? '');
    const filing = {
      epfEmployerNo: postedField(formData, 'epfEmployerNo'),
      socsoEmployerCode: postedField(formData, 'socsoEmployerCode'),
      lhdnEmployerNo: postedField(formData, 'lhdnEmployerNo'),
      hrdfStatus: postedHrdfStatus(formData),
    };
    if (filingCountry && Object.values(filing).some((v) => v !== undefined)) {
      const pack = packFor(filingCountry);
      if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${filingCountry}`);
      await pack.companyStatutory.set(s, { companyId: String(formData.get('companyId')), ...filing });
    }
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function removeCompanyStatutoryAuthorityAction(formData: FormData) {
  const s = await getSession();
  try {
    await removeCompanyStatutoryAuthority(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await createDepartment(s, {
      companyId: String(formData.get('companyId')),
      name: String(formData.get('name') ?? '').trim(),
      // Empty string = "— None —" → unassigned (the service treats blank as null).
      businessUnitId: String(formData.get('businessUnitId') ?? '').trim() || null,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function updateDepartmentAction(formData: FormData) {
  const s = await getSession();
  // businessUnitId is present on the edit row (a select). Empty string clears the link; a value sets it.
  // If the field is absent entirely (undefined), leave the BU untouched (tri-state in the service).
  const buRaw = formData.get('businessUnitId');
  // 6fadb036: headEmploymentId is present on the edit row (a select). Absent field ⇒ untouched; empty ⇒ clear.
  const headRaw = formData.get('headEmploymentId');
  try {
    await updateDepartment(s, {
      id: String(formData.get('id')),
      name: String(formData.get('name') ?? '').trim(),
      businessUnitId: buRaw === null ? undefined : String(buRaw).trim() || null,
      headEmploymentId: headRaw === null ? undefined : String(headRaw).trim() || null,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function archiveDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveDepartment(s, {
      id: String(formData.get('id')),
      archived: formData.get('archived') === 'true',
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function deleteDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteDepartment(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createPositionAction(formData: FormData) {
  const s = await getSession();
  try {
    await createPosition(s, {
      companyId: String(formData.get('companyId')),
      title: String(formData.get('title') ?? '').trim(),
      jobFamily: (formData.get('jobFamily') as string) || undefined,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createCostCenterAction(formData: FormData) {
  const s = await getSession();
  try {
    await createCostCenter(s, {
      companyId: String(formData.get('companyId')),
      code: String(formData.get('code') ?? '').trim(),
      name: String(formData.get('name') ?? '').trim(),
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function createLeaveTypeAction(formData: FormData) {
  const s = await getSession();
  let created: { id: string };
  try {
    created = await createLeaveType(s, {
      code: String(formData.get('code') ?? '').trim().toUpperCase(),
      name: String(formData.get('name') ?? '').trim(),
      paid: formData.get('paid') === 'on',
      // Leave Type master page (feedback 097de541): the add-type form now carries an optional Description and
      // a Status select (active|inactive, default active). The service trims the description (empty ⇒ null).
      description: String(formData.get('description') ?? '').trim(),
      active: formData.get('active') !== 'inactive',
      // Leave Unit Configuration (e4980382): the add-type form carries a Day/Hour select beside "Paid".
      // Anything other than 'hour' falls back to 'day' (default), so an absent field ⇒ Day.
      leaveUnit: formData.get('leaveUnit') === 'hour' ? 'hour' : 'day',
    });
  } catch (e) {
    // 8cc268c4: the add form lives in the Entitlements workspace's "Add Leave Type" dialog now, so both
    // outcomes land back on the Entitlements tab (the old ok/fail(LEAVE) pointed at the read-only Types tab).
    // The ?error= banner is mirrored inside the still-open dialog by the page.
    fail(ENTITLEMENTS, e);
  }
  // Success: carry the stay-on-save #type-<id> anchor (the 097de541 deep-link contract) so the workspace
  // selects the just-created type and closes the add dialog.
  revalidatePath(ENTITLEMENTS);
  redirect(`${ENTITLEMENTS}#type-${created.id}`);
}

/** ADR-0038 carry-forward expiry: an empty month/day field means "no expiry" → null. */
const carryExpiryField = (raw: FormDataEntryValue | null): number | null => {
  const n = Number(raw ?? '');
  return raw != null && String(raw) !== '' && Number.isFinite(n) ? n : null;
};

/** R4 Build #1: read the carry-expiry mode from the form, constrained to the two valid values (default
 *  'date' for back-compat when the field is absent). The 1..12 months range is validated in core/admin.ts. */
const carryExpiryMode = (fd: FormData): 'date' | 'months' =>
  fd.get('carryForwardExpiryMode') === 'months' ? 'months' : 'date';

/**
 * Carry-forward enhancement — only send a carry boolean when the carry block was actually rendered for
 * this policy (the ANNUAL-only block emits a hidden `carryBlockRendered=1` marker). With the marker we
 * map an unchecked checkbox to `false`; WITHOUT it we return undefined so the service omits the key and
 * the back-compat `carryForwardMax > 0` default is preserved — preventing a non-ANNUAL edit (which never
 * renders the block) from silently flipping carry off. */
const carryFlagField = (fd: FormData, name: string): boolean | undefined =>
  fd.get('carryBlockRendered') == null ? undefined : fd.get(name) === 'on';

/**
 * Feedback b81d3c52 — Rounding Method (Entitlements → leave type → General → Earning Method). TRI-STATE
 * (this ticket), mirroring `serviceBandsField` exactly, so the Rounding Method REMEMBERS itself on its own
 * instead of riding a hidden input on every unrelated form (the footgun the codebase itself flagged):
 *  - marker `roundingMethodRendered` ABSENT ⇒ `undefined` = PRESERVE (the form did not render the Rounding
 *    dropdown — Carry Forward / Eligibility inline edit — so the writer keeps the stored value);
 *  - marker present + a choosable method ⇒ that value = SET;
 *  - marker present + anything else (incl. 'none') ⇒ `null` = explicit CLEAR (omit the key).
 * Only the form that actually renders the dropdown (Earning Method) posts the marker.
 *
 * 8fec719e narrowed the accepted set to the TWO the reporter now has: 'custom' = SET, anything else
 * (including 'none' and the three retired methods) = CLEAR. The add-entitlement form no longer renders a
 * rounding control at all, so the JSONB surface has no writer left — rounding is a leave-TYPE rule.
 */
const roundingMethodField = (fd: FormData): 'custom' | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const v = String(fd.get('roundingMethod') ?? '');
  return v === 'custom' ? 'custom' : null;
};

/**
 * 8fec719e — the custom rounding table, posted as ONE JSON field and riding the SAME
 * `roundingMethodRendered` marker as the dropdown it belongs to (the `roundingThresholdField` precedent
 * directly below, for the same reason: the table is part of the rounding configuration, not a setting
 * that outlives it).
 *
 * Marker present + rows ⇒ the parsed array. Marker present + blank / `[]` ⇒ null = CLEAR. Marker absent ⇒
 * undefined = PRESERVE.
 *
 * A MALFORMED JSON STRING IS `undefined`, NOT `null` — the `serviceBandsField` precedent verbatim: a
 * client-side bug must not silently wipe a table an administrator spent time building. A table that DOES
 * parse but is self-contradictory is a different case and is refused loudly by `setLeaveTypeRules`.
 */
const roundingBandsField = (fd: FormData): RoundingBand[] | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const raw = fd.get('roundingBands');
  if (raw == null || String(raw) === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.length === 0 ? null : (parsed as RoundingBand[]);
  } catch {
    return undefined;
  }
};

/**
 * Feedback 9f5164d8 — the custom decimal threshold, riding the SAME `roundingMethodRendered` marker as the
 * dropdown it belongs to. It is not a second tri-state: the threshold is part of the rounding
 * configuration, so a form that does not render the rounding control preserves both, and a form that does
 * render it decides both together.
 *
 * Marker present + a parseable number ⇒ SET. Marker present + blank / unparseable ⇒ null = CLEAR, which is
 * exactly what "Customize decimal thresholds" being unticked means: use the standard rule. The bounds are
 * NOT enforced here — `setLeaveTypeRules` throws a readable, localizable error for an out-of-range value,
 * and silently swallowing it here would let a typo save as "standard rule" without telling anyone.
 */
const roundingThresholdField = (fd: FormData): number | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const raw = String(fd.get('roundingThreshold') ?? '').trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Leave Entitlement Rules Engine — the band editor always renders a hidden `serviceBandsRendered=1` marker
 * plus a `serviceBands` JSON field (exact carryBlockRendered/carryFlagField precedent above). Marker absent
 * ⇒ undefined (preserve on update; no-op on create). Marker present + empty array ⇒ null (clear). Marker
 * present + rows ⇒ the parsed array (service validates the shape). A malformed JSON string is treated as
 * undefined (preserve) so a client-side bug can't accidentally wipe existing bands — the replace path's own
 * validation catches a genuinely bad shape that DOES parse.
 */
const serviceBandsField = (fd: FormData): ServiceBand[] | null | undefined => {
  if (fd.get('serviceBandsRendered') == null) return undefined;
  const raw = fd.get('serviceBands');
  if (raw == null || String(raw) === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return undefined;
    if (parsed.length === 0) return null;
    return parsed as ServiceBand[];
  } catch {
    return undefined; // malformed JSON ⇒ preserve rather than silently clear
  }
};


/**
 * Feedback 9d8cf621 — "Employee Selection" fan-out. The add-entitlement form now offers MULTI-select
 * companies + grades (removable chips). On save we create one leave_policy per (company × grade) combination
 * so a single HR action can scope one entitlement to several companies/grades at once. An empty companies
 * axis ⇒ [null] (group default / all companies); an empty grades axis ⇒ [null] (all grades) — i.e. today's
 * single group-default row when nothing is selected. Each createLeavePolicy appends its OWN
 * `leave-policy.created` DomainEvent (substrate discipline — one event per created row, correct by
 * construction). The band editor's per-range Carry-Forward Days / Carry-Forward Expiry / Maximum Balance Days
 * ride the serviceBands JSON untouched.
 */

/**
 * Feedback 9d8cf621 — live "entitled employees" count next to the Employee-Selection chips. READ-ONLY
 * (no DomainEvent). Returns the number of active employees the currently-selected companies/grades cover.
 */
export async function countEmployeesInScopeAction(p: {
  companyIds: string[];
  gradeIds: string[];
}): Promise<number> {
  const s = await getSession();
  return countEmployeesInScope(s, { companyIds: p.companyIds, gradeIds: p.gradeIds });
}

/**
 * THE TYPE-LEVEL RULE EDITOR (9816a5ad step 2). Writes the five consolidated settings to the leave TYPE.
 *
 * This replaces what the Earning Method and Carry Forward Policy sub-steps used to do. They were "front
 * doors" onto a per-company/grade `leave_policy` row; once step 2 repoints the engines at `leave_type`,
 * writing a policy row changes nothing the calculation reads — a form that saves successfully and has no
 * effect, which is worse than no form at all.
 *
 * TRI-STATE, PER SUB-FORM. Earning Method and Carry Forward are separate forms editing disjoint halves of
 * one row, so each posts a marker naming the half it rendered and only that half is forwarded. Without
 * that, an earning-only save would clear the carry configuration. The old front doors solved this by
 * re-posting the other half as hidden inputs; markers are the same idea without the footgun of a stale
 * hidden value overwriting a concurrent edit.
 */
export async function setLeaveTypeRulesAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('admin');
  const id = String(formData.get('leaveTypeId') ?? '');
  const num = (name: string): number | null | undefined => {
    if (formData.get(name) == null) return undefined;
    const raw = String(formData.get(name) ?? '');
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const earningRendered = formData.get('earningRendered') != null;
  const carryRendered = formData.get('carryBlockRendered') != null;

  let saved = { unconfiguredCleared: false };
  try {
    saved = (await setLeaveTypeRules(s, {
      id,
      // Earning half — method + rounding. roundingMethodField already carries its own tri-state marker.
      ...(earningRendered
        ? {
            accrualMethod: String(formData.get('method') ?? '') || null,
            // bc36c768 — the accrual day rides the earningRendered marker, like the method it belongs to.
            // `num` returns undefined when the FIELD IS ABSENT, and the editor renders it only for Monthly
            // Accrual — so `?? null` deliberately CLEARS the stored day whenever the earning form saves
            // any other choice. That is the intent: a credit day that belongs to a cadence this type no
            // longer uses must not linger, waiting to surprise whoever switches back to monthly.
            accrualDay: num('accrualDay') ?? null,
            // NOT `?? null`. roundingMethodField already carries its own tri-state: undefined means the
            // dropdown was not rendered, which the service reads as PRESERVE. Coercing that to null would
            // clear the stored rounding for any form that ever stops rendering the control.
            roundingMethod: roundingMethodField(formData),
            // 9f5164d8 — the threshold rides the same marker as the dropdown, for the same reason and with
            // the same NOT-`?? null` discipline. 8fec719e retired 'nearest_half' as a choice, so the editor
            // no longer renders the field and this now reads as a CLEAR whenever the rounding form saves —
            // deliberately: a threshold that belongs to a method nobody can pick must not linger.
            roundingThreshold: roundingThresholdField(formData),
            // 8fec719e — the custom rounding table, on the SAME marker as the method it belongs to.
            roundingBands: roundingBandsField(formData),
          }
        : {}),
      // Carry half — enable flag, cap, expiry mode and both expiry shapes, plus the max-balance cap.
      ...(carryRendered
        ? {
            carryForwardEnabled: formData.get('carryForwardEnabled') === 'on',
            carryForwardMax: num('carryForwardMax') ?? null,
            // 7cd914b1 — an EMPTY string posts as null, which CLEARS the percentage. That is deliberate:
            // Fixed Maximum and None both post it empty, so a stored percentage cannot survive a switch
            // away from percentage mode and quietly keep winning the resolution.
            carryForwardPercent: num('carryForwardPercent') ?? null,
            carryForwardExpiryMode: carryExpiryMode(formData),
            carryForwardExpiryMonths: carryExpiryField(formData.get('carryForwardExpiryMonths')),
            carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
            carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
            carryForwardIncludeEarned: formData.get('carryForwardIncludeEarned') === 'on',
            maxBalanceDays: num('maxBalanceDays'),
          }
        : {}),
    })) ?? { unconfiguredCleared: false };
  } catch (e) {
    if (e instanceof LeaveTypeRuleError) return fail(ENTITLEMENTS, e.message);
    throw e;
  }
  // bc36c768 — THE CATCH-UP, AFTER THE CONFIG WRITE HAS COMMITTED, never inside it.
  //
  // This is the moment balances move, and it is the promise the NOT-CONFIGURED state is made of: an
  // employee hired while the type was unconfigured was credited +0.00 and lost nothing, because saving
  // the earning method credits everything owed as a single upward top-up, here and now. Without this the
  // under-credit would sit there indefinitely, waiting for some unrelated profile edit to fix it.
  //
  // ORDERING IS LOAD-BEARING, not stylistic: each per-employee recalc inside the cohort opens its OWN
  // transaction and reads the COMMITTED rules. Calling it inside setLeaveTypeRules would have every
  // employee reproject against the configuration this save just replaced. A test asserts the ordering.
  //
  // Best-effort, exactly like the scheme-cohort precedent at upsertSchemeEntitlementAction: the
  // configuration is saved and must stay saved; the recalc is idempotent and self-heals on the next
  // trigger, so a failure here must not turn a successful save into an error banner.
  if (saved.unconfiguredCleared) {
    try {
      await reprojectEntitlementForLeaveTypeCohort(s, { leaveTypeId: id, trigger: 'leave_type_rules' });
    } catch (e) {
      console.error(`leave-type cohort catch-up failed for leave type ${id}:`, e);
    }
  }
  okEntitlements(t('entitlementUpdatedToast'), id);
}


/**
 * Restructure Service-Based Leave Entitlements — save one grade's three service-band figures for a company
 * from the company-driven Service Based Entitlements table. The first save for a company materialises the
 * whole company scope so the untouched grades never silently drop to zero (ADR-0066 short-circuit); the
 * edited grade is recalculated in place. Everything is orchestrated over the existing createLeavePolicy /
 * updateLeavePolicy writers in core (no new writer primitive) — see saveServiceEntitlement.
 *
 * 9816a5ad UNMOUNTED it: Service Based Entitlements maintains BENEFIT SCHEMES now, so no screen posts here.
 * Kept rather than deleted because it is the only writer that materialises a company's whole grade scope on
 * first save — the ADR-0066 short-circuit guard test/service-based-entitlement.test.ts pins — and grade-level
 * policies still resolve for anyone no scheme covers. Delete it together with core/saveServiceEntitlement if
 * a later round retires grade-level entitlement outright.
 */


/** feedback 2c7c6385 (Run Earned Accrual button): the scope the HR admin picked in the review card. An
 *  empty array on any axis ⇒ "all" on that axis (matches countEmployeesInScope). `year` selects the leave
 *  year → asOf (asOfForLeaveYear: current=to-date, past/future=full cycle). */
export type EarnedAccrualScope = {
  year: number;
  companyIds: string[];
  gradeIds: string[];
  leaveTypeIds: string[];
};

/**
 * feedback 2c7c6385 — PREVIEW (dry-run) for the "Run Earned Accrual" review card. Computes the EXACT same
 * grouped breakdown a real run would, WITHOUT writing anything (no ledger rows, no audit event). RLS scopes
 * the underlying reads to the session's visible companies, so a group admin cannot preview outside their
 * companies even if they hand-craft a companyId. READ-ONLY (the dryRun engine appends no event).
 */
export async function previewEarnedAccrualAction(
  scope: EarnedAccrualScope,
): Promise<{ rows?: EarnedAccrualGroup[]; asOf?: string; error?: string }> {
  const s = await getSession();
  try {
    const asOf = asOfForLeaveYear(scope.year, todayInKualaLumpur());
    const { breakdown } = await accrueEarnedLeave(s, {
      asOf,
      companyIds: scope.companyIds,
      gradeIds: scope.gradeIds,
      leaveTypeIds: scope.leaveTypeIds,
      dryRun: true,
    });
    return { rows: breakdown, asOf };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** ADR-0040 (2D-1) + feedback 2c7c6385: top earned policies up to the accrued amount for the selected leave
 *  year, narrowed to the chosen scope. Idempotent — admins can run it any time; a re-run grants nothing more
 *  (the monthly cron scripts/accrue-earned.ts calls the same engine unscoped). Returns {granted, forfeits}
 *  so the review card can surface "N generated" (a 2nd run visibly shows 0). No redirect — the client card
 *  toasts + refreshes — the pattern grantAdHocLeaveAction used before 38f1fd40 retired it. */
export async function runEarnedAccrualAction(
  scope: EarnedAccrualScope,
): Promise<{ granted?: number; forfeits?: number; error?: string }> {
  const s = await getSession();
  try {
    const asOf = asOfForLeaveYear(scope.year, todayInKualaLumpur());
    const { granted, forfeits } = await accrueEarnedLeave(s, {
      asOf,
      companyIds: scope.companyIds,
      gradeIds: scope.gradeIds,
      leaveTypeIds: scope.leaveTypeIds,
    });
    revalidatePath(LEAVE);
    revalidatePath(ENTITLEMENTS);
    return { granted, forfeits };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// 1e4eb8af — setCompanyLeaveCycleAction is GONE with the Application Rules tab that hosted its only form.
// The per-COMPANY calendar-vs-anniversary card was a second place to decide the same thing the per-TYPE
// Leave Year Type override decides (Custom Settings → Leave Year Configuration), and that override's three
// explicit choices (a2a / a2c / c2c) cover every shape the company card offered. Nothing posts the action
// any more, so it is removed rather than left dangling; core/admin.setCompanyLeaveCycle is UNCHANGED and
// still the write path — stored company cycles keep driving types left on "Company default".

/** Feedback request 31474452 / R64 08bc6841: the half-day-deduction toggle, one company per post.
 *  RETIRED BY 10e96227 — the card is now ONE multi-select plus ONE Save, so nothing posts a single
 *  company any more and the action is removed rather than left dangling (the r100
 *  saveLeaveApprovalPolicyAction precedent: a server action retires WITH the screen that was its only
 *  caller). `core/admin.setLeaveHalfDayFullDeduction` is UNCHANGED and deliberately kept — it is the
 *  single-company primitive the behavioural tests drive directly; only its form wrapper is gone.
 *  Replaced by setLeaveHalfDayFullDeductionCompaniesAction below. */

/**
 * 10e96227 — the half-day-deduction card saves the WHOLE company set in one post.
 *
 * The reporter's complaint was arithmetic: eight companies meant eight rows and eight Saves to express
 * one decision. The multi-select posts every selected company under the same `companyIds` field (the
 * house convention — cf. the festive-grant company picker above), so the whole rule arrives as one
 * statement of intent and the core write turns the ones NOT posted off.
 *
 * `getAll` with no selection yields `[]`, which is a MEANINGFUL value here, not a missing one: it means
 * "applies nowhere", the same thing every box unticked meant before. That is why there is no guard
 * rejecting an empty post — treating empty as "nothing to do" would make it impossible to turn the last
 * company off, which is exactly the state the old per-row UI could reach trivially.
 */
export async function setLeaveHalfDayFullDeductionCompaniesAction(formData: FormData) {
  const s = await getSession();
  try {
    await setLeaveHalfDayFullDeductionCompanies(s, {
      companyIds: formData.getAll('companyIds').map(String).filter(Boolean),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

// b1b81a08 — createJobGradeAction / updateJobGradeAction / archiveJobGradeAction / deleteJobGradeAction and
// their gradeReturnAnchor helper are GONE. Grade master data is no longer maintained from Leave Config, so
// there is no leave-type panel to return to: the grid on Settings → System Labels → Organisation Labels
// calls saveJobGradesGridAction / removeJobGradeGridAction (app/admin/settings/actions.ts), which are
// value-returning (per-row errors) rather than redirecting, and which gate on requireAdmin. The core
// mutations in core/admin.ts are unchanged and are what both surfaces have always called.


// ── Public holidays ──
/** Preserve the active country/year/group filter across the redirect so the admin stays in context.
 *  (R18 a519a96e: `group` keeps the per-group effective-calendar view open across row edits.)
 *
 *  9da61c86 — and the PAGE with them. The list pages now, and every row's Save and Delete post through
 *  here; without the page in the redirect, editing the third holiday on page 4 drops the admin back on
 *  page 1 and they have to find their place again. The page rides as `filterPage` / `filterSize` for the
 *  same reason country and year do: a server action reads the form, never the address it was posted
 *  from. The page's hidden fields are the other half of this contract — neither half works alone. */
function holidaysPath(formData: FormData): string {
  const sp = new URLSearchParams();
  const country = String(formData.get('filterCountry') ?? '').trim();
  const year = String(formData.get('filterYear') ?? '').trim();
  const group = String(formData.get('filterGroup') ?? '').trim();
  const page = String(formData.get('filterPage') ?? '').trim();
  const size = String(formData.get('filterSize') ?? '').trim();
  if (country) sp.set('country', country);
  if (year) sp.set('year', year);
  if (group) sp.set('group', group);
  // page 0 is the bare screen, so it is written only when it is not the first page — the same rule the
  // pager's own links follow.
  if (page && page !== '0') sp.set('page', page);
  if (size) sp.set('size', size);
  const qs = sp.toString();
  return qs ? `${HOLIDAYS}?${qs}` : HOLIDAYS;
}

export async function createHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  // 66b8f5a8 — the simplified Holiday-master form no longer collects Scope / State / Business-group /
  // Holiday-group. Every holiday added here is a plain national-country master record; the scope columns
  // stay in the DB (backward compatible) but default to null. The form now collects the master fields.
  // 3e831868 — Holiday Code + Description are no longer collected in the UI; the nullable columns stay in
  // the DB (backward compatible) and simply default to null on new rows.
  try {
    await createHoliday(s, {
      country: String(formData.get('country') ?? 'MY'),
      holidayDate: String(formData.get('holidayDate') ?? ''),
      name: String(formData.get('name') ?? ''),
      holidayType: String(formData.get('holidayType') ?? 'public'),
      active: formData.get('active') === 'on',
      // ADR-0063: a provisional date for a not-yet-gazetted holiday (still counts as a holiday).
      tentative: formData.get('tentative') === 'on',
    });
  } catch (e) {
    fail(path, e);
  }
  ok(path);
}

/** ADR-0063 + 66b8f5a8 + 3e831868: edit a holiday's date + name + type + active + tentative flag. Scope
 *  (state/company/holiday-group) stays fixed on existing rows. Holiday Code + Description are no longer
 *  edited from the UI — omitting them here makes the service PRESERVE their stored values (updateHoliday
 *  treats undefined as "leave unchanged"), so the removed columns keep their data. */
export async function updateHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  try {
    await updateHoliday(s, {
      id: String(formData.get('id')),
      holidayDate: String(formData.get('holidayDate') ?? ''),
      name: String(formData.get('name') ?? ''),
      holidayType: String(formData.get('holidayType') ?? 'public'),
      active: formData.get('active') === 'on',
      tentative: formData.get('tentative') === 'on',
    });
  } catch (e) {
    fail(path, e);
  }
  ok(path);
}

export async function deleteHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  try {
    await deleteHoliday(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(path, e);
  }
  ok(path);
}

// ── Holiday groups (66b8f5a8 — dedicated Holiday Group tab + add/edit pages) ──
// Groups keep their state engine (states/archetype/parentGroupId — MY state auto-resolution + inheritance)
// AND gain the master fields (code/description/active) plus the reporter's tick-list (holidayIds → the
// holiday_group_holiday junction). The resolver UNIONs the ticked holidays with the automatic result.
export async function createHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await createHolidayGroup(s, {
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      active: formData.get('active') === 'on',
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
      // R18 a519a96e: optional parent group — the child inherits the parent's calendar live.
      parentGroupId: String(formData.get('parentGroupId') ?? '') || null,
      // 66b8f5a8: the ticked holidays from the master list.
      holidayIds: formData.getAll('holidayIds').map(String),
    });
  } catch (e) {
    fail(`${HOLIDAY_GROUPS}/new`, e);
  }
  ok(HOLIDAY_GROUPS);
}

export async function updateHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  const id = String(formData.get('id'));
  try {
    await updateHolidayGroup(s, {
      id,
      name: String(formData.get('name') ?? ''),
      code: String(formData.get('code') ?? '') || null,
      description: String(formData.get('description') ?? '') || null,
      active: formData.get('active') === 'on',
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
      // R18 a519a96e: the form always posts the select, so '' means "clear the parent" (service tri-state).
      parentGroupId: String(formData.get('parentGroupId') ?? '') || null,
      holidayIds: formData.getAll('holidayIds').map(String),
    });
  } catch (e) {
    fail(`${HOLIDAY_GROUPS}/${id}`, e);
  }
  ok(HOLIDAY_GROUPS);
}

export async function deleteHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteHolidayGroup(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(HOLIDAY_GROUPS, e);
  }
  ok(HOLIDAY_GROUPS);
}

// 4b0e76ae — GENERATE ENTITLEMENT. The one surviving leave-year action, re-homed onto
// /admin/leave/generate: pick a year, press Generate, and the shipped openLeaveYear grant sweep posts that
// year's entitlement for every eligible employment. The engine is untouched — what never existed was a way
// to reach it. Until this item, the ONLY caller was the Leave Year Configuration screen's Start button
// (through setLeaveYearStatusAction's draft→open transition), and deleting that screen without giving the
// sweep a new home is how a year-end silently fails to open. test/leave-generate-page.test.ts pins that
// this action has exactly ONE caller and that the caller is the Generate page.
//
// ⚠️ requireAdmin(), NOT getSession() — THIS WAS A REAL HOLE, FIXED HERE. Until 4b0e76ae this action opened
// with `const s = await getSession()`, openLeaveYear carries no admin assertion anywhere in its body, and
// leave_ledger RLS gates on can_see_employment rather than on admin. So an ordinary member who POSTed this
// server action directly would have posted accrual grants for every employment they can see. Same
// correction dcd8e32f made on the sibling delete action, for the same reason. The redirect below is a UX
// gate, not authority — the guard is.
//
// Idempotent by construction: openLeaveYear's dedupe set is built from the ledger's existing accrual rows
// at the year start, NOT from any configuration table, so pressing Generate twice never double-grants and
// clearing leave_year_config (migration 0385) cannot cause one either.
// 93249794 GREW THIS ACTION RATHER THAN MINTING A SECOND ONE, and that is a deliberate choice about the
// guard above it. `test/leave-generate-page.test.ts` asserts this action has EXACTLY ONE caller, because
// losing its last caller is a year-end failure discovered in January. A new `runLeaveGenerationAction`
// beside it would have left this one uncalled and the guard asserting a fiction — the wizard would work
// and the assertion protecting the year-open would be protecting nothing. So the wizard posts HERE, the
// unscoped post is byte-identical to the plain button it replaces (no types picked, no criteria ⇒ the
// whole-tenant sweep), and there is still exactly one route from a browser to `openLeaveYear`.
//
// The body delegates to `runLeaveGeneration` (core/leave-generation.ts), which calls the SAME
// `openLeaveYear` and then writes the processing log. It does not re-derive a single day.
export async function openLeaveYearAction(formData: FormData) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const year = Number(formData.get('year'));
  const targetMode = formData.get('targetMode') === 'individual' ? 'individual' : 'criteria';
  let res: Awaited<ReturnType<typeof runLeaveGeneration>>;
  try {
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('Invalid year');
    res = await runLeaveGeneration(s, {
      year,
      // Empty ⇒ every type this sweep grants, exactly as the bare button did.
      leaveTypeIds: formData.getAll('leaveTypeIds').map(String).filter(Boolean),
      targetMode,
      // THE SHARED READER (core/org-criteria.ts). The hand-rolled alternative lists the field names itself,
      // so every axis added there has to be remembered in a second place — and the one that gets forgotten
      // posts fine, resolves to nothing, and narrows nobody.
      criteria:
        targetMode === 'criteria'
          ? orgCriteriaFromFields(
              (name) => formData.getAll(name).map(String),
              (name) => {
                const v = formData.get(name);
                return v == null ? null : String(v);
              },
            )
          : undefined,
      employmentIds:
        targetMode === 'individual'
          ? String(formData.get('employmentIdsRaw') ?? '')
              .split(/[\s,]+/)
              .filter(Boolean)
          : undefined,
    });
  } catch (e) {
    fail(GENERATE, e);
  }
  // Localised HERE before the redirect (the dcd8e32f convention): ToastFromQuery renders the raw string, so
  // an i18n key in the URL would surface to HR verbatim.
  okToast(GENERATE, t('generateToast', { year, granted: res.granted, skipped: res.skipped, forfeits: res.forfeits }));
}

export async function assignRoleAction(formData: FormData) {
  const s = await getSession();
  try {
    await assignRole(s, {
      appUserId: String(formData.get('appUserId')),
      role: String(formData.get('role')) as
        | 'employee'
        | 'manager'
        | 'hr_admin'
        | 'super_admin'
        | 'payroll_partner'
        | 'performance_comp_partner',
      companyId: (formData.get('companyId') as string) || undefined,
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

export async function revokeRoleAction(formData: FormData) {
  const s = await getSession();
  try {
    await revokeRole(s, { roleAssignmentId: String(formData.get('roleAssignmentId')) });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

// ADR-0072 — invitation-only account creation. Invite by email + role (+ optional company scope);
// revoke a still-pending invitation. Group-admin gated in the service; RLS is the backstop.
export async function inviteUserAction(formData: FormData) {
  const s = await getSession();
  try {
    // personId is REQUIRED (0279). It was previously dropped here even though app_invitation.personId
    // exists and inviteUser accepts it, which is how nameless, unattached logins got created. ADR-0072
    // is invitation-only with no self sign-up, so the invitee always already has a person row.
    const personId = String(formData.get('personId') ?? '').trim();
    if (!personId) throw new Error('Select the employee this invitation is for.');
    await inviteUser(s, {
      email: String(formData.get('email') ?? '').trim(),
      role: String(formData.get('role') ?? 'employee'),
      companyId: (formData.get('companyId') as string) || null,
      personId,
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

/** Archive (switch off) or restore a login — group-admin only, guarded in the service, RLS backstop. */
export async function archiveUserAction(formData: FormData) {
  const s = await getSession();
  try {
    await setAppUserArchived(s, {
      appUserId: String(formData.get('appUserId')),
      archived: archived(formData),
    });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

/**
 * ADR-0082 §2.8 — give or take away one person's access to the assistant.
 *
 * A per-user grant ON TOP of the billable module, and both gates fail closed. It lives on the Users
 * screen rather than getting one of its own because "who may use this" is the same question that screen
 * already answers for roles — and a second screen for one toggle is a menu row nobody would find.
 */
export async function setAssistantGrantAction(formData: FormData) {
  const s = await getSession();
  const appUserId = String(formData.get('appUserId'));
  try {
    if (String(formData.get('granted')) === 'true') await grantAssistant(s, { appUserId });
    else await revokeAssistant(s, { appUserId });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

export async function revokeInvitationAction(formData: FormData) {
  const s = await getSession();
  try {
    await revokeInvitation(s, { invitationId: String(formData.get('invitationId')) });
  } catch (e) {
    fail(USERS, e);
  }
  ok(USERS);
}

// ── Edit + state-aware remove actions (department actions are above) ──
const archived = (fd: FormData) => fd.get('archived') === 'true';

export async function updatePositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await updatePosition(s, { id: String(fd.get('id')), title: String(fd.get('title') ?? '').trim(), jobFamily: (fd.get('jobFamily') as string) || undefined });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archivePositionAction(fd: FormData) {
  const s = await getSession();
  try { await archivePosition(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function deletePositionAction(fd: FormData) {
  const s = await getSession();
  try { await deletePosition(s, { id: String(fd.get('id')) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function updateCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await updateCostCenter(s, { id: String(fd.get('id')), code: String(fd.get('code') ?? '').trim(), name: String(fd.get('name') ?? '').trim() });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archiveCostCenterAction(fd: FormData) {
  const s = await getSession();
  try { await archiveCostCenter(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function deleteCostCenterAction(fd: FormData) {
  const s = await getSession();
  try { await deleteCostCenter(s, { id: String(fd.get('id')) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function createBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try {
    await createBusinessUnit(s, {
      companyId: String(fd.get('companyId')),
      code: String(fd.get('code') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
    });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function updateBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  // 6fadb036: headEmploymentId tri-state (absent ⇒ untouched; empty ⇒ clear).
  const headRaw = fd.get('headEmploymentId');
  try {
    await updateBusinessUnit(s, {
      id: String(fd.get('id')),
      code: String(fd.get('code') ?? '').trim(),
      name: String(fd.get('name') ?? '').trim(),
      headEmploymentId: headRaw === null ? undefined : String(headRaw).trim() || null,
    });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archiveBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try { await archiveBusinessUnit(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function updateCompanyAction(fd: FormData) {
  const s = await getSession();
  // Enhance Company General Tab (bc5d4891): read each new field, trim, and treat empty as an explicit
  // clear (empty string -> the service normalizes to null). Website format is validated in the service.
  const str = (k: string) => String(fd.get(k) ?? '').trim();
  try {
    await updateCompany(s, {
      id: String(fd.get('id')),
      legalName: String(fd.get('legalName') ?? '').trim(),
      registrationNo: (fd.get('registrationNo') as string) || undefined,
      country: (fd.get('country') as string) || undefined,
      currency: (fd.get('currency') as string) || undefined,
      // Company Information
      companyLabel: str('companyLabel'),
      industry: str('industry'),
      website: str('website'),
      businessType: str('businessType'),
      // Contact Information
      addressLine1: str('addressLine1'),
      addressLine2: str('addressLine2'),
      addressLine3: str('addressLine3'),
      city: str('city'),
      state: str('state'),
      addressCountry: str('addressCountry'),
      postcode: str('postcode'),
      phone: str('phone'),
      fax: str('fax'),
    });
  } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function archiveCompanyAction(fd: FormData) {
  const s = await getSession();
  try { await archiveCompany(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}
export async function deleteCompanyAction(fd: FormData) {
  const s = await getSession();
  try { await deleteCompany(s, { id: String(fd.get('id')) }); } catch (e) { fail(ORG, e); }
  ok(ORG);
}

export async function updateLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  // Leave Type master page (feedback 097de541): the identity sub-form posts `identity=1` (marker) and edits
  // the free-text description alongside the name. OWN tri-state (mirrors backdating): only when the marker is
  // present do we forward `description`, so any other sub-form save leaves the description column untouched.
  // Empty string ⇒ null (service trims + treats blank as cleared).
  const touchIdentity = fd.get('identity') === '1';
  // Edit Paid/Unpaid on rename (feedback 75953777): the identity/rename sub-form now also carries the
  // Paid/Unpaid checkbox. The `identity=1` marker guarantees the form was submitted, so an unchecked box is a
  // genuine "unpaid" choice (checkbox absent ⇒ 'on' missing ⇒ false), not "untouched". Any OTHER sub-form
  // omits the marker and thus leaves `paid` undefined ⇒ the column stays untouched (tri-state). No new marker.
  // Edit Leave Type Code (feedback a7194511): the identity/rename form now also carries the Code input — but
  // ONLY for NON-statutory types. Statutory (and EMERGENCY) codes keep the field readOnly with NO `name` attr,
  // so `fd.get('code')` is null for them ⇒ newCode stays undefined ⇒ the code column is untouched (tri-state).
  // A non-statutory type always posts its code (even unchanged); the service no-ops when it equals the current
  // code and otherwise normalizes / shape-validates / uniqueness-checks / statutory-guards before persisting.
  const rawCode = fd.get('code');
  const identityFields = touchIdentity
    ? {
        description: String(fd.get('description') ?? '').trim() === '' ? null : String(fd.get('description')).trim(),
        paid: fd.get('paid') === 'on',
        ...(rawCode !== null ? { newCode: String(rawCode) } : {}),
      }
    : {};
  // #25 visibility: the eligibility form posts `eligibility=1` (a marker hidden input) so a name-only
  // rename — which doesn't carry that marker — leaves the rule untouched (tri-state in updateLeaveType).
  const touchEligibility = fd.get('eligibility') === '1';
  const minRaw = String(fd.get('minServiceMonths') ?? '').trim();
  // Min-service unit (#f88f0a63): the eligibility form posts minServiceUnit ('months' | 'days') beside the
  // duration. Absent/blank ⇒ undefined so cleanEligibility defaults it to 'months' (legacy compat). The unit
  // is only persisted alongside a surviving positive minServiceMonths.
  const unitRaw = String(fd.get('minServiceUnit') ?? '').trim();
  // Multi-select (#badc5966): the gender / marital checkbox groups post repeated inputs → getAll yields the
  // selected values as arrays. cleanEligibility de-dupes, validates, and collapses an empty array to "no
  // restriction".
  let eligibility: LeaveEligibility | undefined;
  if (touchEligibility) {
    eligibility = {
      gender: fd.getAll('gender').map(String),
      maritalStatus: fd.getAll('maritalStatus').map(String),
      minServiceMonths: minRaw === '' ? undefined : Number(minRaw),
      minServiceUnit: unitRaw === '' ? undefined : (unitRaw as 'months' | 'days'),
    };
    // Organisation Assignment criteria (Enhance Leave Criteria Configuration): each org field's ChipMultiSelect
    // posts one repeated input per selected value → getAll yields the list. cleanEligibility de-dupes, drops
    // blanks and collapses an empty array to "no restriction" (no catalogue hard-validation, so a value later
    // deactivated still re-saves cleanly). Iterating the single descriptor keeps the action in lock-step.
    for (const c of ORG_ASSIGNMENT_CRITERIA) {
      eligibility[c.key] = fd.getAll(c.key).map(String);
    }
  }
  // Probation eligibility (d6bdbd55): the eligibility sub-form also posts a `probation` select ('' | confirmed_only
  // | probation_only). It rides the SAME `eligibility=1` marker, so an unrelated save leaves the column untouched
  // (undefined). Blank ⇒ null (clears the restriction); a concrete value sets it. The service re-validates against
  // the closed set. Stored in leave_type.probation_eligibility (its own column), not the eligibility jsonb.
  const probationRaw = String(fd.get('probation') ?? '').trim();
  const probationEligibility = touchEligibility
    ? probationRaw === ''
      ? null
      : (probationRaw as 'confirmed_only' | 'probation_only')
    : undefined;
  // ADR-0048: the durations form posts `durations=1` (marker) plus a `duration` checkbox per allowed slot,
  // so a name/eligibility edit that doesn't carry that marker leaves the allow-list untouched (same tri-state).
  const touchDurations = fd.get('durations') === '1';
  const durations = touchDurations
    ? (fd.getAll('duration').map(String) as LeaveDurationType[])
    : undefined;
  // Supporting-document config: the document sub-form posts `document=1` (marker) so a rename / eligibility
  // / durations edit that omits it leaves the doc columns untouched (same tri-state guard).
  const touchDocument = fd.get('document') === '1';
  let docFields: {
    requiresDocument?: boolean;
    mandatoryAfterDays?: number | null;
    allowedMimeTypes?: string[];
    maxDocBytes?: number;
    employeeRemarkRequired?: boolean;
    hrRemarkRequired?: boolean;
  } = {};
  if (touchDocument) {
    const afterRaw = String(fd.get('mandatoryAfterDays') ?? '').trim();
    const mbRaw = String(fd.get('maxFileSizeMb') ?? '').trim();
    docFields = {
      requiresDocument: fd.get('requiresDocument') === 'on',
      mandatoryAfterDays: afterRaw === '' ? null : Number(afterRaw),
      allowedMimeTypes: fd.getAll('allowedMimeType').map(String),
      maxDocBytes: mbRaw === '' ? 10 * 1024 * 1024 : Math.round(Number(mbRaw) * 1024 * 1024),
      employeeRemarkRequired: fd.get('employeeRemarkRequired') === 'on',
      hrRemarkRequired: fd.get('hrRemarkRequired') === 'on',
    };
  }
  // Unpaid payroll-impact: the sub-form posts `payrollImpact=1` (marker) so a rename / eligibility / durations
  // / document edit that omits it leaves send_to_payroll untouched (same tri-state guard). "Affects payroll
  // deduction" is display-only (derived from !paid) and is NOT read/forwarded here.
  const touchPayroll = fd.get('payrollImpact') === '1';
  const payrollFields = touchPayroll ? { sendToPayroll: fd.get('sendToPayroll') === 'on' } : {};
  // Configurable backdated-leave restriction (0133): its own sub-form posts `backdating=1` (marker) so a
  // rename / eligibility / durations / document / payroll edit that omits it leaves backdating_limit_days
  // untouched (same tri-state guard). Empty input ⇒ null (clears the limit ⇒ unrestricted); a number sets it.
  const touchBackdating = fd.get('backdating') === '1';
  const backdatingRaw = String(fd.get('backdatingLimitDays') ?? '').trim();
  const backdatingFields = touchBackdating
    ? { backdatingLimitDays: backdatingRaw === '' ? null : Number(backdatingRaw) }
    : {};
  // Application Limits (feedback c6ffa725): its own sub-form posts `applicationLimits=1` (marker),
  // mirroring the backdating tri-state guard above. Empty input ⇒ null (Unlimited, which is what every
  // existing leave type means and how it behaves today); a number sets the annual application ceiling.
  // ad9cb5c5 adds the PERIOD to the same sub-form and the same marker: the ceiling and the window it is
  // counted over are one decision, and a period posted without a ceiling is refused by the database.
  const touchApplicationLimits = fd.get('applicationLimits') === '1';
  const maxDaysPerLeaveYearRaw = String(fd.get('maxDaysPerLeaveYear') ?? '').trim();
  const maxDaysPeriodRaw = String(fd.get('maxDaysPeriod') ?? '').trim();
  const applicationLimitFields = touchApplicationLimits
    ? {
        maxDaysPerLeaveYear: maxDaysPerLeaveYearRaw === '' ? null : Number(maxDaysPerLeaveYearRaw),
        // Clearing the ceiling clears the period with it — "Unlimited, per calendar year" is not a state.
        maxDaysPeriod: maxDaysPerLeaveYearRaw === '' || maxDaysPeriodRaw === '' ? null : maxDaysPeriodRaw,
      }
    : {};
  // Maximum Consecutive Leave (c6ffa725 rev 2): its own sub-form posts `maxConsecutive=1` (marker), separate
  // from `applicationLimits` above — the two rules answer different questions ("in a year" vs "in one go")
  // and a shared marker would let a save of one silently clear the other. Blank maximum ⇒ Unlimited, and the
  // UNIT IS ONLY FORWARDED WHEN A MAXIMUM IS PRESENT, so a blank save reliably clears BOTH columns as the
  // all-or-nothing pair the DB CHECK requires (leave_type_max_consecutive_pair_ck).
  const touchMaxConsecutive = fd.get('maxConsecutive') === '1';
  const maxConsecutiveRaw = String(fd.get('maxConsecutiveDays') ?? '').trim();
  const maxConsecutiveUnitRaw = String(fd.get('maxConsecutiveUnit') ?? '').trim();
  const maxConsecutiveFields = touchMaxConsecutive
    ? maxConsecutiveRaw === ''
      ? { maxConsecutiveDays: null, maxConsecutiveUnit: null }
      : {
          maxConsecutiveDays: Number(maxConsecutiveRaw),
          maxConsecutiveUnit: (maxConsecutiveUnitRaw === 'working_days' ? 'working_days' : 'calendar_days') as
            | 'calendar_days'
            | 'working_days',
        }
    : {};
  // Minimum advance-notice rule (0159): its own sub-form posts `minAdvance=1` (marker), mirroring the
  // backdating tri-state guard above. Empty input ⇒ null (clears the requirement); a number sets it.
  //
  // Advance Notice — calendar days or working days (7daac043): the Day Type select lives in the SAME
  // sub-form and rides the SAME marker, so the requirement and the unit it is read in save together and a
  // save of any OTHER card can never reset either. THE UNIT IS ONLY FORWARDED WITH A REQUIREMENT: a blank
  // number clears both, because a unit with no figure is inert configuration that looks set. An
  // unrecognised value falls back to 'calendar_days' — today's reading — and the service re-validates it
  // against the closed set behind the DB CHECK.
  const touchMinAdvance = fd.get('minAdvance') === '1';
  const minAdvanceRaw = String(fd.get('minAdvanceDays') ?? '').trim();
  const minAdvanceDayTypeRaw = String(fd.get('minAdvanceDayType') ?? '').trim();
  const minAdvanceFields = touchMinAdvance
    ? minAdvanceRaw === ''
      ? { minAdvanceDays: null, minAdvanceDayType: null }
      : {
          minAdvanceDays: Number(minAdvanceRaw),
          minAdvanceDayType: (minAdvanceDayTypeRaw === 'working_days' ? 'working_days' : 'calendar_days') as
            | 'calendar_days'
            | 'working_days',
        }
    : {};
  // The three REQUEST-VALIDATION rules, pre-merged into one fragment. They stay three independent
  // tri-states; only the assembly is flattened, because the updateLeaveType call below is already at
  // TypeScript's union-complexity ceiling (TS2590) and one more conditional spread tips it over.
  // The ANNOTATION is load-bearing: each `touchX ? {…} : {}` fragment is a two-member union, and spreading
  // enough of them into one literal multiplies out until TypeScript refuses with TS2590. Declaring the
  // merged shape collapses these three to one member.
  const requestRuleFields: {
    backdatingLimitDays?: number | null;
    maxDaysPerLeaveYear?: number | null;
    maxDaysPeriod?: string | null;
    maxConsecutiveDays?: number | null;
    maxConsecutiveUnit?: 'calendar_days' | 'working_days' | null;
    minAdvanceDays?: number | null;
    minAdvanceDayType?: 'calendar_days' | 'working_days' | null;
  } = { ...backdatingFields, ...applicationLimitFields, ...maxConsecutiveFields, ...minAdvanceFields };
  // Partial Leave Approval (ADR-0068): its own sub-form posts `partialApproval=1` (marker) so a rename /
  // eligibility / durations / document / payroll / backdating edit that omits it leaves per_date_approval
  // untouched (same tri-state guard). Unchecked-when-rendered ⇒ false; the marker distinguishes that from
  // "block not shown at all" ⇒ leave column.
  const touchPartial = fd.get('partialApproval') === '1';
  const partialFields = touchPartial ? { perDateApproval: fd.get('perDateApproval') === 'on' } : {};
  // Duplicate Leave Application Restriction (d5e51c34): its own sub-form posts `duplicatePolicy=1` (marker)
  // plus a `duplicatePolicyValue` radio (allow | restrict_same | restrict_any). Any other sub-form save omits
  // the marker ⇒ duplicate_application_policy stays untouched (same tri-state guard as partialApproval). An
  // unrecognised value falls back to 'allow' (the safe, behaviour-preserving default); the service re-validates.
  const touchDuplicatePolicy = fd.get('duplicatePolicy') === '1';
  const duplicatePolicyRaw = String(fd.get('duplicatePolicyValue') || '');
  const duplicatePolicyFields = touchDuplicatePolicy
    ? {
        duplicateApplicationPolicy: (['allow', 'restrict_same', 'restrict_any'].includes(duplicatePolicyRaw)
          ? duplicatePolicyRaw
          : 'allow') as 'allow' | 'restrict_same' | 'restrict_any',
      }
    : {};
  // Configurable Negative Leave Balance Validation (0ef0defd): its own sub-form posts `negativeBalance=1`
  // (marker) plus a Yes/No radio `allowNegativeBalanceValue` (yes ⇒ permit going negative; no ⇒ block over-
  // application). Any other sub-form save omits the marker ⇒ allow_negative_balance stays untouched (same
  // tri-state guard as duplicatePolicy). Forwarded as a concrete boolean; the service persists it.
  // bc512dc3 adds the FLOOR to the same sub-form and the same marker: one switch, one floor, one decision.
  // A blank figure means unbounded (today's behaviour), and turning the switch to No clears any floor —
  // the database refuses a floor with no permission to go negative, so this cannot post that pair.
  const touchNegativeBalance = fd.get('negativeBalance') === '1';
  const allowNegativeBalanceValue = fd.get('allowNegativeBalanceValue') === 'yes';
  const maxNegativeBalanceRaw = String(fd.get('maxNegativeBalance') ?? '').trim();
  const negativeBalanceFields: { allowNegativeBalance?: boolean; maxNegativeBalance?: number | null } =
    touchNegativeBalance
      ? {
          allowNegativeBalance: allowNegativeBalanceValue,
          maxNegativeBalance:
            allowNegativeBalanceValue && maxNegativeBalanceRaw !== '' ? Number(maxNegativeBalanceRaw) : null,
        }
      : {};
  // Balance Deduction Source (cdf9ca48): its own sub-form posts `balanceSource=1` (marker) plus a mode radio
  // (`balanceSourceMode` = own | other) and, for 'other', the chosen `balanceSourceTypeId`. Mode 'own' — and
  // 'other' with nothing picked — both clear the column, so the dropdown can never leave a half-configured
  // "deduct from another type, but which one?" state. Any other sub-form save omits the marker ⇒ the column
  // stays untouched (same tri-state guard as negativeBalance). The service validates self-reference + chains.
  // Both are annotated with an OPTIONAL-property type rather than left to inference: an un-annotated
  // `cond ? {k: v} : {}` is a two-member union, and this call site already spreads ~18 of them — two more
  // doubled the union twice over and tipped tsc into TS2590 ("union type too complex"). One declared type
  // per field object keeps the spread a single shape.
  const touchBalanceSource = fd.get('balanceSource') === '1';
  const balanceSourceModeRaw = String(fd.get('balanceSourceMode') ?? '');
  const balanceSourceIdRaw = String(fd.get('balanceSourceTypeId') ?? '').trim();
  const balanceSourceFields: { balanceSourceTypeId?: string | null } = touchBalanceSource
    ? {
        balanceSourceTypeId:
          balanceSourceModeRaw === 'other' && balanceSourceIdRaw !== '' ? balanceSourceIdRaw : null,
      }
    : {};
  // Allow Unpaid Leave (a7fab30b): its own sub-form posts `allowUpl=1` (marker) plus a Yes/No radio
  // (`allowUnpaidLeaveValue`). Forwarded as a concrete boolean; mirrors negativeBalance exactly.
  const touchAllowUpl = fd.get('allowUpl') === '1';
  const allowUplFields: { allowUnpaidLeave?: boolean } = touchAllowUpl
    ? { allowUnpaidLeave: fd.get('allowUnpaidLeaveValue') === 'yes' }
    : {};
  // Employee Leave View Configuration (65dec703 / dup 1fedb473): the ESS-view checklist posts `essView=1`
  // (marker) plus one checkbox per component (`essView_<key>`). An unchecked box does not post, so we build
  // the COMPLETE map from the closed key list (checked ⇒ true/visible, absent ⇒ false/hidden) and replace
  // the column wholesale. Any other sub-form save omits the marker ⇒ ess_view_config stays untouched.
  // Consolidation (2bc2f2a3): the merged view-configuration sub-form posts BOTH markers (`essView=1` and
  // `formula=1`) in ONE submit — selections land on ess_view_config, explanations on formula_explanations.
  // The two tri-states stay independent so either marker alone still works.
  const touchEssView = fd.get('essView') === '1';
  const essViewFields = touchEssView
    ? {
        essViewConfig: Object.fromEntries(
          ESS_VIEW_COMPONENT_KEYS.map((key) => [key, fd.get(`essView_${key}`) === 'on']),
        ) as EssViewConfig,
      }
    : {};
  // Leave Entitlement Formula Management (79011509, consolidated by 2bc2f2a3, narrowed by ed17a4f9): the
  // view-configuration sub-form posts `formula=1` (marker) plus, per Leave Summary item, two free-text fields
  // (`formula_<key>_description`, `formula_<key>_formula`). We build the COMPLETE { key: entry } map from
  // LEAVE_EXPLANATION_KEYS, which ed17a4f9 reduced to exactly the ess-view key set (the summary's own items);
  // a key the form never rendered posts nothing ⇒ '' ⇒ dropped by the service, which trims + drops blanks +
  // normalises an all-blank map to null (clear). The third "Result / Date (optional)" field is gone at the
  // reporter's request and is no longer read. Any other sub-form save omits the marker ⇒
  // formula_explanations stays untouched (same tri-state guard as essView).
  //
  // Smart content reuse (ed17a4f9 §4) needs NOTHING here, and that is the design: the template only pre-fills
  // the textareas, so what arrives in this FormData is whatever HR reviewed and left in the boxes. There is
  // no separate "apply template" write path that could overwrite wording behind their back.
  const touchFormula = fd.get('formula') === '1';
  const formulaFields = touchFormula
    ? {
        formulaExplanations: Object.fromEntries(
          LEAVE_EXPLANATION_KEYS.map((key) => [
            key,
            {
              description: String(fd.get(`formula_${key}_description`) ?? ''),
              formula: String(fd.get(`formula_${key}_formula`) ?? ''),
            },
          ]),
        ) as LeaveFormulaConfig,
      }
    : {};
  // Day Type Inclusion (feedback ef6d7146): the "Day Type Inclusion" sub-form posts `dayTypeInclusion=1`
  // (marker) plus one checkbox per day type (`dayType_<key>`). An unchecked box does not post, so we build the
  // COMPLETE five-key vector (checked ⇒ true/counted, absent ⇒ false/skipped) and hand it to the service,
  // which normalises an all-false vector to null (inert). Any other sub-form save omits the marker ⇒
  // day_type_inclusion stays untouched (same tri-state guard as essView).
  const touchDayTypeInclusion = fd.get('dayTypeInclusion') === '1';
  const dayTypeInclusionFields = touchDayTypeInclusion
    ? {
        dayTypeInclusion: Object.fromEntries(
          DAY_TYPE_INCLUSION_KEYS.map((key) => [key, fd.get(`dayType_${key}`) === 'on']),
        ) as unknown as DayTypeInclusion,
      }
    : {};
  // Override Leave Application (feedback 56910869): the "Override Leave Application" sub-form posts
  // `overrideRules=1` (marker) plus one row per (trigger, action) pair the card offers — an `override_<t>`
  // select naming the chosen action and an `overrideOn_<t>` checkbox. Any other sub-form save omits the
  // marker ⇒ override_rules stays untouched (same tri-state guard as dayTypeInclusion).
  //
  // ONE ROW PER TRIGGER is what the form collects, which is why the whole set is rebuilt and REPLACED on
  // every save rather than merged: a partial write is how a rule HR believes they turned off stays on. An
  // unticked box does not post, so absent ⇒ enabled:false — the DEFAULT-OFF reading, and the only reading
  // that cannot turn a rule nobody enabled into behaviour. The service validates the vocabulary.
  const touchOverrideRules = fd.get('overrideRules') === '1';
  const overrideRulesFields = touchOverrideRules
    ? {
        overrideRules: LEAVE_OVERRIDE_TRIGGERS.flatMap((trigger) => {
          const action = String(fd.get(`override_${trigger}`) ?? '').trim();
          if (action === '') return [];
          return [
            {
              trigger,
              action: action as LeaveOverrideAction,
              enabled: fd.get(`overrideOn_${trigger}`) === 'on',
            },
          ];
        }),
      }
    : {};
  // Leave Type Visual Configuration Enhancement (639fdf77): the visual sub-form posts `visual=1` (marker) plus
  // `color` (one of the 7 palette tokens, or '' to clear) + `icon` (an icon-registry key, or '' to clear).
  // OWN tri-state (mirrors essView) — any other sub-form save omits the marker ⇒ color/icon stay untouched.
  // Empty string ⇒ null (the service trims + treats blank as cleared). The service rejects out-of-allow-list
  // values. Display-only; never read for entitlement / eligibility / workflow / calculation.
  const touchVisual = fd.get('visual') === '1';
  const visualFields = touchVisual
    ? {
        color: String(fd.get('color') ?? '').trim() === '' ? null : String(fd.get('color')).trim(),
        icon: String(fd.get('icon') ?? '').trim() === '' ? null : String(fd.get('icon')).trim(),
      }
    : {};
  // Leave Unit Configuration (e4980382): its own sub-form posts `leaveUnit=1` (marker) plus a Day/Hour select,
  // so any other sub-form save that omits the marker leaves leave_unit untouched (same tri-state guard). The
  // value is constrained to 'hour' else 'day' (default) — the service also validates against the closed set.
  const touchLeaveUnit = fd.get('leaveUnit') === '1';
  const leaveUnitFields = touchLeaveUnit
    ? { leaveUnit: (fd.get('leaveUnitValue') === 'hour' ? 'hour' : 'day') as 'day' | 'hour' }
    : {};
  // Leave Year Type override (e1a51aea): the General step's "Leave Year Type" sub-step posts `yearCycle=1`
  // (marker) plus a `yearCycleValue` select ('' = company default ⇒ null | a2a | c2c | a2c — all three
  // values are LIVE since 18e15fc1). The raw value is forwarded UNSANITISED so the service rejects any
  // unknown value loudly against its closed set — silently coercing here would store nothing and hide the
  // error. Any other sub-form save omits the marker ⇒ tri-state untouched.
  const touchYearCycle = fd.get('yearCycle') === '1';
  const yearCycleRaw = String(fd.get('yearCycleValue') ?? '').trim();
  const yearCycleFields = touchYearCycle
    ? { yearCycleOverride: yearCycleRaw === '' ? null : yearCycleRaw }
    : {};
  // Leave Type Employee Visibility (7b11f1c1, simplified by 464b58e6): its own sub-form posts `visibility=1`
  // (marker) plus ONE checkbox — `employeeCanApply`, whether employees may apply for this type. A checked box
  // posts 'on', an unchecked box does not post, so with the marker present we forward a concrete boolean:
  // checked ⇒ true, absent ⇒ false. Any other sub-form save omits the marker ⇒ the column stays untouched
  // (same tri-state guard as essView/leaveUnit). The service rejects employeeCanApply=false on a
  // statutory-entitlement type, and the form now shows that switch locked rather than refusing after Save.
  //
  // `visibleToEmployee` IS DELIBERATELY NOT FORWARDED HERE, and re-adding it would be a silent data change,
  // not a tidy-up. Its checkbox is gone from that sub-form, so `fd.get('visibleToEmployee')` is absent on
  // every visibility save — reading it would evaluate to FALSE and HIDE every leave type HR touched from the
  // employee's Leave tab. The column keeps its single writer: the placement sub-form (`placement=1`), whose
  // Hidden option maps onto it in core/admin.ts. core/admin.ts still accepts p.visibleToEmployee — the
  // placement mapping and the service tests use it — only this form stops posting it.
  const touchVisibility = fd.get('visibility') === '1';
  const visibilityFields = touchVisibility ? { employeeCanApply: fd.get('employeeCanApply') === 'on' } : {};
  // Leave grouping visibility (b653ac1b): its own sub-form posts `placement=1` (marker) plus a
  // `placementValue` of primary | secondary | hidden. With the marker present we forward the chosen value so
  // the service maps it onto ess_placement + the shared visible_to_employee switch (hidden ⇒ flag false). Any
  // other sub-form save omits the marker ⇒ ess_placement + the flag stay untouched (same tri-state guard).
  const touchPlacement = fd.get('placement') === '1';
  const placementRaw = String(fd.get('placementValue') || '');
  const placementFields = touchPlacement
    ? {
        essPlacement: (['primary', 'secondary', 'hidden'].includes(placementRaw) ? placementRaw : 'secondary') as
          | 'primary'
          | 'secondary'
          | 'hidden',
      }
    : {};
  // Custom validation messages (custom-messages migration): each rule's "Custom system message" textarea
  // lives in the SAME sub-form as its rule config (backdating ⇒ `backdating=1`; min-advance ⇒ `minAdvance=1`),
  // so each key is read/forwarded only when its own sub-form saved — one sub-form, one atomic save. The
  // service trims + treats blank as "not configured" (removes the key) and MERGES the forwarded keys onto
  // what is stored (read-then-patch-then-write), so saving one rule's message never clobbers the other's.
  // Custom apply-time message (feedback 9d8cf621): its own sub-form posts `applyNotice=1` (marker) plus an
  // "Enable custom message" checkbox + the message textarea. When the checkbox is unchecked the textarea is
  // hidden and we forward an empty string ⇒ the merge in updateLeaveType removes the key (message disabled);
  // a non-empty string stores the notice shown to employees on the leave apply form. Rides the SAME shared
  // customMessages JSONB + merge convention as the two block messages, so saving one never clobbers the others.
  const touchApplyNotice = fd.get('applyNotice') === '1';
  const applyNoticeEnabled = fd.get('enableApplyNotice') === 'on';
  const customMessageFields =
    touchBackdating || touchMinAdvance || touchApplyNotice
      ? {
          customMessages: {
            ...(touchBackdating ? { backdatingLimitDays: String(fd.get('customMessageBackdating') ?? '').trim() } : {}),
            ...(touchMinAdvance ? { minAdvanceDays: String(fd.get('customMessageMinAdvance') ?? '').trim() } : {}),
            ...(touchApplyNotice
              ? { applyNotice: applyNoticeEnabled ? String(fd.get('customMessageApplyNotice') ?? '').trim() : '' }
              : {}),
          },
        }
      : {};
  const leaveTypeId = String(fd.get('id'));
  try {
    await updateLeaveType(s, {
      id: leaveTypeId,
      name: String(fd.get('name') ?? '').trim(),
      ...identityFields,
      eligibility,
      probationEligibility,
      durations,
      ...docFields,
      ...payrollFields,
      ...requestRuleFields,
      ...partialFields,
      ...duplicatePolicyFields,
      ...negativeBalanceFields,
      ...balanceSourceFields,
      ...allowUplFields,
      ...essViewFields,
      ...formulaFields,
      ...dayTypeInclusionFields,
      ...overrideRulesFields,
      ...visualFields,
      ...leaveUnitFields,
      ...yearCycleFields,
      ...visibilityFields,
      ...placementFields,
      ...customMessageFields,
      // 4ec5a940 — optional "why the change was made" note, recorded on the audit event.
      reason: String(fd.get('reason') || '') || null,
    });
  } catch (e) {
    // Edit Leave Type Code (a7194511): the identity/rename form lives on the Entitlements tab (the per-type
    // config panel), so a failed save — e.g. the duplicate-code / statutory-lock validation — returns there so
    // HR sees the error banner + toast without being bounced off the page. (No #type anchor here: fail() appends
    // ?error=, and a fragment before the query string would swallow it.) Other sub-forms keep the LEAVE target.
    // Stay-on-page keystone (b9dac2d1): the per-type config panel lives on the Entitlements tab, so EVERY
    // sub-form save — not just identity/rename — must return there on failure with the error banner + toast,
    // rather than bouncing HR to /admin/leave. (No #type anchor here: fail() appends ?error=, and a fragment
    // before the query string would swallow it.)
    //
    // 464b58e6 — A DRIVER ERROR IS NOT A MESSAGE FOR HR. fail() puts (e as Error).message straight into
    // ?error=, and drizzle wraps a failed statement as `Failed query: <the entire SQL>\nparams: …`
    // (node_modules/drizzle-orm/errors.js) — which is the "Failed to query" banner the reporter photographed.
    // There is nothing in it HR can act on, and a SQL statement has no business in a URL or on a screen.
    // Domain refusals are UNTOUCHED and still surface verbatim: the statutory-apply guard, the duplicate
    // name/code messages and the closed-set validations are all written for HR to read. Only a driver-shaped
    // message is swapped, and it is logged in full server-side first, so nothing is lost — least of all the
    // failure itself, which still stops the save and still says so.
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.startsWith('Failed query:')) {
      console.error('updateLeaveTypeAction — database error while saving a leave type:', e);
      const tErr = await getTranslations('admin.leave');
      fail(ENTITLEMENTS, new Error(tErr('saveDatabaseError')));
    }
    fail(ENTITLEMENTS, e);
  }
  // Stay-on-page keystone (b9dac2d1): on ANY successful sub-form save, stay on the Entitlements config panel,
  // surface a success toast, and preserve the #type-<id> anchor so the edited row re-expands and stays in view
  // (requirement: "display a success message and remain on the current page without redirecting"). The
  // identity/rename save keeps its own leave-type-specific toast; all other sub-forms get the generic "saved".
  const t = await getTranslations('admin.leave');
  revalidatePath(ENTITLEMENTS);
  redirect(
    `${ENTITLEMENTS}?toast=${encodeURIComponent(t(touchIdentity ? 'codeSavedToast' : 'savedToast'))}#type-${leaveTypeId}`,
  );
}
export async function archiveLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  try { await archiveLeaveType(s, { id: String(fd.get('id')), archived: archived(fd) }); } catch (e) { fail(LEAVE, e); }
  ok(LEAVE);
}
export async function deleteLeaveTypeAction(fd: FormData) {
  const s = await getSession();
  try { await deleteLeaveType(s, { id: String(fd.get('id')) }); } catch (e) { fail(LEAVE, e); }
  ok(LEAVE);
}

// ADR-0033 33-4 — run the TOIL expiry sweep for today (manual; a scheduled job will do this later).
//
// requireAdmin(), not getSession() (ADR-0077 slice 3 review). Until slice 3 the service's first line was
// `if (!toilEnabled()) throw`, which was doing duty as the only check on this path — and since
// TOIL_ENABLED is set in no tracked env file it refused everyone. Slice 3 removed that gate deliberately
// (a lapsed entitlement must not strand a settlement the employer already owes), which left a mutating
// statutory sweep behind a bare session on a directly-POSTable server action. Same correction as
// openLeaveYearAction above. The service asserts it too — a redirect is a UX gate, not authority.
export async function runToilExpiryAction() {
  const s = await requireAdmin();
  const today = todayInKualaLumpur();
  let result;
  try {
    result = await runToilExpiry(s, { today });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  revalidatePath(TOIL_POLICY);
  // `skipped` carries core/toil.ts's `skippedOutOfScope` to the banner. Dropping it here would put the
  // partial-sweep signal back where it was: a company-scoped admin would see the same success banner
  // whether nothing was due or another company's statutory settlements were silently left behind.
  redirect(
    `${TOIL_POLICY}?processed=${result!.processed}&converted=${result!.converted}&lapsed=${result!.lapsed}` +
      `&skipped=${result!.skippedOutOfScope}`,
  );
}

// RL Control Engine (0113) — year-end rollover: expire (or carry-forward, per each accrual's frozen flag) the
// replacement-leave balance at the year boundary. Supervised admin click; no cron. `asOf` defaults to this
// year's 31 Dec for calendar tenants (the service recomputes per-employment boundaries for anniversary).
// requireAdmin() for the reason given on runToilExpiryAction, and more sharply here: this writes a
// `replacement-leave-year.closed` marker, and `domain_event` has UPDATE/DELETE REVOKEd from ai_hr_app, so
// a marker written by the wrong caller cannot be undone through the product.
export async function closeReplacementLeaveYearAction() {
  const s = await requireAdmin();
  const asOf = `${new Date().getUTCFullYear()}-12-31`;
  let result;
  try {
    result = await closeReplacementLeaveYear(s, { asOf });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  revalidatePath(TOIL_POLICY);
  redirect(
    `${TOIL_POLICY}?closed=1&closedAlready=${result!.alreadyClosed ? 1 : 0}&closedProcessed=${result!.processed}` +
      `&closedConverted=${result!.converted}&closedLapsed=${result!.lapsed}&closedCarried=${result!.carriedForward}`,
  );
}

// ADR-0033 33-5 — upsert one company's TOIL (leave-in-lieu) policy. Checkboxes ⇒ presence test.
//
// 296fc027: the form this serves MOVED to /admin/leave/replacement, so every redirect target moved with
// it. The action itself did not move — it stays here beside the two sweep actions it is related to, and
// beside `fail`/`ok`, which is what the plan asked for ("move the policy editor form and its
// setToilPolicyAction TARGET"). Redirecting to the old page would have landed the admin on a screen that
// no longer shows the form they just submitted, with their validation error invisible.
//
// 20e759a0 — THE PAGE IS NOW FILTERED TO ONE COMPANY (`?company=`), so every return path out of this
// action has to carry that selection back. It did not, and all three targets dropped it: `saved=1`, the
// premium-equivalent `warning=`, and `fail(LEAVE_REPLACEMENT, e)` on the error path. The consequence is
// worst on the error path — the admin is thrown onto the DEFAULT company's form, where the `?error=`
// banner describes a validation failure in a form that is no longer on screen.
//
// The id comes off the FormData, from the hidden `companyId` input the form already posts, so there is
// nothing new for the page to send. Saving from the "All companies" view therefore lands on the company
// whose Save was pressed rather than back on the stacked list — that is the company being edited, and it
// is where the saved/error banner belongs.
//
// `fail()` cannot be used any more: it appends `?error=` to whatever path it is given, so passing it a
// path that already carries `?company=` would produce two `?`. The redirect is built here instead.
export async function setToilPolicyAction(fd: FormData) {
  const s = await getSession();
  const companyId = String(fd.get('companyId') ?? '');
  const back = (params: string) =>
    `${LEAVE_REPLACEMENT}?${params}${companyId ? `&company=${encodeURIComponent(companyId)}` : ''}`;
  let warning: string | undefined;
  try {
    // 296fc027 — the eligibility criteria, read the way every other multi-select criteria form in this
    // codebase is read: one repeated hidden input per selected value, under the criterion's own key,
    // pulled back with getAll. No JSON round-trip. The key IS the stored JSONB key by construction
    // (core/replacement-eligibility.ts), so this loop needs no per-field wiring and cannot drift from the
    // picker. `setToilPolicy` normalises the result (dedupe, drop blanks, all-empty ⇒ NULL).
    const requestEligibility: ReplacementRequestEligibility = {};
    for (const c of REPLACEMENT_ELIGIBILITY_CRITERIA) {
      requestEligibility[c.key] = fd.getAll(c.key).map(String);
    }
    // Phase-B #14: premium_equivalent + allowing First-Schedule staff returns a banking-risk warning.
    const r = await setToilPolicy(s, {
      companyId,
      enabled: fd.get('enabled') === 'on',
      accrualBasis: String(fd.get('accrualBasis') ?? 'hours_worked') as ToilAccrualBasis,
      expiryDays: Number(fd.get('expiryDays') ?? 90),
      onExpiry: String(fd.get('onExpiry') ?? 'convert_to_pay') as ToilExpiryAction,
      allowFirstScheduleEligible: fd.get('allowFirstScheduleEligible') === 'on',
      autoAccrueOnApproval: fd.get('autoAccrueOnApproval') === 'on',
      carryForwardAtYearEnd: fd.get('carryForwardAtYearEnd') === 'on',
      // Both counts are posted on every save regardless of which unit is selected, so flipping the unit
      // and flipping back does not lose the other count — see the two-column note in migration 0380.
      expiryUnit: String(fd.get('expiryUnit') ?? 'days') as ToilExpiryUnit,
      expiryMonths: Number(fd.get('expiryMonths') ?? 3),
      employeeRequestEnabled: fd.get('employeeRequestEnabled') === 'on',
      replacementLeaveFrom: String(fd.get('replacementLeaveFrom') ?? 'overtime') as ToilReplacementLeaveFrom,
      requestEligibility,
    });
    warning = r.premiumEquivalentWarning;
  } catch (e) {
    redirect(back(`error=${encodeURIComponent((e as Error).message)}`));
  }
  revalidatePath(LEAVE_REPLACEMENT);
  // The warning has been produced since Phase-B #14 but the old target never read the param, so it was
  // dropped on every save. The new page renders it.
  redirect(warning ? back(`warning=${encodeURIComponent(warning)}`) : back('saved=1'));
}

// ADR-0069 — upsert one company's leave encashment policy (Company Leave Settings -> Encashment Policy).
// Checkboxes ⇒ presence test (mirrors setToilPolicyAction).
export async function setLeaveEncashmentPolicyAction(fd: FormData) {
  const s = await getSession();
  try {
    await setEncashmentPolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      enabled: fd.get('enabled') === 'on',
      autoFreeze: fd.get('autoFreeze') === 'on',
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

// ADR-0032 C7 — upsert one company's attendance policy (the no-roster default schedule).
// Feedback 31474452: the page posts one dayType_<1..7> select ("full" | "half" | "rest") per ISO weekday
// instead of a plain workingDays checkbox list — decode those into the two arrays the service expects.
export async function setAttendancePolicyAction(fd: FormData) {
  const s = await getSession();
  const workingDays: number[] = [];
  const halfWorkingDays: number[] = [];
  for (let d = 1; d <= 7; d++) {
    const v = fd.get(`dayType_${d}`);
    if (v === 'full') workingDays.push(d);
    else if (v === 'half') halfWorkingDays.push(d);
  }
  // ADR-0069 + 7c834696: how an approved overtime request's minutes are resolved
  // (requested | system_calculated | smaller_of | greater_of). Anything unrecognised falls back to the
  // default rather than throwing — this is a select, not free text.
  const otRaw = String(fd.get('otApprovalCalculation') ?? 'system_calculated');
  const otApprovalCalculation = (
    otRaw === 'requested' || otRaw === 'smaller_of' || otRaw === 'greater_of' ? otRaw : 'system_calculated'
  ) as 'requested' | 'system_calculated' | 'smaller_of' | 'greater_of';
  try {
    await setAttendancePolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      workStart: String(fd.get('workStart') ?? ''),
      workEnd: String(fd.get('workEnd') ?? ''),
      breakMinutes: Number(fd.get('breakMinutes') ?? 0),
      lateAfter: String(fd.get('lateAfter') ?? ''),
      halfDayBefore: String(fd.get('halfDayBefore') ?? ''),
      workingDays,
      halfWorkingDays,
      otApprovalCalculation,
      // Feedback 5249d43f: registered-device enforcement checkbox (absent when unchecked ⇒ false).
      requireRegisteredDevice: fd.get('requireRegisteredDevice') != null,
    });
  } catch (e) {
    fail(ATTENDANCE_POLICY, e);
  }
  ok(ATTENDANCE_POLICY);
}

// ADR-0054 — Location master data CRUD. requireAdmin gates the route; RLS gates the write per company.
/**
 * 1fff489c — the duplicate banner. core/location.ts turns a 23505 on either partial unique index into a
 * typed error (the shiftUniqueError pattern); the SENTENCE is composed here, because `fail()` puts
 * `(e as Error).message` verbatim into ?error= and only this layer can reach getTranslations. Without it
 * the admin saw drizzle's "Failed query: update "location" set "code" = $1 … params: TWO,Two,MY,,BUKIT
 * JALIL,…" — SQL and parameter values — which is what the reporter's screen actually showed.
 */
async function failLocationSave(e: unknown): Promise<never> {
  if (e instanceof LocationBranchTakenError || e instanceof LocationCodeTakenError) {
    const t = await getTranslations('admin.locations');
    if (e instanceof LocationCodeTakenError) fail(LOCATIONS, new Error(t('codeTaken', { code: e.code })));
    // conflictCode is null only if the holding row vanished between the failure and the follow-up read.
    fail(
      LOCATIONS,
      new Error(
        e.conflictCode
          ? t('branchTaken', { branch: e.branch, code: e.conflictCode })
          : t('branchTakenNoCode', { branch: e.branch }),
      ),
    );
  }
  fail(LOCATIONS, e);
}

export async function createLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await createLocation(user, {
      companyId: String(fd.get('companyId') ?? ''),
      code: String(fd.get('code') ?? ''),
      name: String(fd.get('name') ?? ''),
      country: String(fd.get('country') ?? '') || undefined,
      state: (fd.get('state') as string) || null,
      holidayGroupId: (fd.get('holidayGroupId') as string) || null,
      // 1fff489c — the Branch this location serves. Blank = not mapped (the field is optional).
      branch: (fd.get('branch') as string) || null,
    });
  } catch (e) {
    await failLocationSave(e);
  }
  ok(LOCATIONS);
}

export async function updateLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await updateLocation(user, {
      locationId: String(fd.get('locationId') ?? ''),
      code: String(fd.get('code') ?? ''),
      name: String(fd.get('name') ?? ''),
      country: String(fd.get('country') ?? '') || undefined,
      state: (fd.get('state') as string) || null,
      holidayGroupId: (fd.get('holidayGroupId') as string) || null,
      branch: (fd.get('branch') as string) || null,
    });
  } catch (e) {
    await failLocationSave(e);
  }
  ok(LOCATIONS);
}

export async function archiveLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await archiveLocation(user, { locationId: String(fd.get('locationId') ?? '') });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

export async function restoreLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await restoreLocation(user, { locationId: String(fd.get('locationId') ?? '') });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

// ADR-0070 — Clocking Location Management CRUD. requireAdmin gates the route; RLS gates the write per
// company (tenant-catalog read, admin-of-company write — mirrors 0065 pay_component, NOT `location`).
/**
 * 1fff489c — the radius advisory. The write ALREADY SUCCEEDED when this runs: an unusual radius is a
 * warning, never a refusal (spec section B — some sites genuinely need a bigger circle), so it returns
 * through a success toast rather than the ?error= banner. Null advisory ⇒ the plain ok() redirect,
 * byte-identical to before.
 */
async function okWithRadiusAdvisory(warning: RadiusAdvisory | null): Promise<never> {
  if (!warning) ok(LOCATIONS);
  const t = await getTranslations('admin.locations');
  okToast(
    LOCATIONS,
    warning.code === 'tight'
      ? t('radiusWarningTight', { radius: warning.radiusM })
      : t('radiusWarningWide', { radius: warning.radiusM }),
  );
}

export async function createClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  let warning: RadiusAdvisory | null = null;
  try {
    ({ warning } = await createClockingLocation(user, {
      companyId: String(fd.get('companyId') ?? ''),
      name: String(fd.get('name') ?? ''),
      lat: Number(fd.get('lat')),
      lng: Number(fd.get('lng')),
      // 1fff489c — both REQUIRED by the service. Passed as the raw form strings so a blank field reaches
      // the "Radius is required" / "pick a location" message rather than becoming NaN or ''.
      radiusM: String(fd.get('radiusM') ?? ''),
      locationId: String(fd.get('locationId') ?? ''),
      address: (fd.get('address') as string) || null,
      remarks: (fd.get('remarks') as string) || null,
    }));
  } catch (e) {
    fail(LOCATIONS, e);
  }
  await okWithRadiusAdvisory(warning);
}

export async function updateClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  let warning: RadiusAdvisory | null = null;
  try {
    ({ warning } = await updateClockingLocation(user, {
      clockingLocationId: String(fd.get('clockingLocationId') ?? ''),
      name: String(fd.get('name') ?? ''),
      lat: Number(fd.get('lat')),
      lng: Number(fd.get('lng')),
      radiusM: String(fd.get('radiusM') ?? ''),
      locationId: String(fd.get('locationId') ?? ''),
      address: (fd.get('address') as string) || null,
      remarks: (fd.get('remarks') as string) || null,
    }));
  } catch (e) {
    fail(LOCATIONS, e);
  }
  await okWithRadiusAdvisory(warning);
}

export async function archiveClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await archiveClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

export async function restoreClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await restoreClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

export async function deleteClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  const t = await getTranslations('admin.locations');
  try {
    await deleteClockingLocation(user, { clockingLocationId: String(fd.get('clockingLocationId') ?? '') });
  } catch (e) {
    if (e instanceof ClockingLocationInUseError) {
      fail(LOCATIONS, new Error(t('clockingInUse', { count: e.refs })));
    }
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

// ── Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b) ──────────────────────────────
// All redirect to the Entitlements tab (where the Benefit Scheme subsection lives). requireAdmin gates the
// route; RLS additionally gates the write (WITH CHECK app.is_admin()).

/**
 * ae5b84d5 — after a scheme-side configuration write COMMITS, true up every covered employee's
 * current-cycle balance (reprojectEntitlementForSchemeCohort loops the idempotent per-employee recalc).
 * Best-effort, following the recalcAfterProfileChange pattern in the personnel actions: the config save
 * has already committed and the recalc self-heals on the next trigger, so a hiccup here must never fail
 * the save the admin just made. Runs AFTER the service's own transaction — never inside it.
 */

function parseBands(fd: FormData): import('@/core/leave-compute').ServiceBand[] {
  const raw = String(fd.get('serviceBands') ?? '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* 9a65f808 — ALL THREE GRADE-GROUP WRITES NOW RETURN TO SYSTEM_LABELS.
 *
 * The editor is on Settings → System Labels → Organisation, beside Job Grades (it was on
 * /admin/leave/approval under f12d77e5, and on the Entitlements screen before that). A redirect left
 * behind is not a cosmetic mismatch: the save would have worked and then thrown the admin onto a screen
 * with no grade-group card to show the result. A failure is worse — `fail()` carries the message in
 * `?error=`, so "this grade group is used by one or more leave approval rules" would surface on a page
 * with no grade-group form to attach it to, while the screen the admin was actually looking at silently
 * reloaded unchanged. The services and the FormData contract are untouched; only where the redirect lands
 * moved, with the card. */
export async function createGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createGradeGroup(s, {
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updateGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    const { gradeIds } = await updateGradeGroup(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
    // 6e9a126e release three — the scheme-cohort true-up is GONE with benefit schemes, and NOTHING here
    // reprojects a balance. That conclusion SURVIVES 9a65f808, but its old reason does not, so do not read
    // the old one back in: a grade group is now an Employee Eligibility axis as well as an approval-routing
    // scope. The reason there is still nothing to reproject is the STORAGE, not the absence of a consumer —
    // an eligibility rule stores the group's member grades, expanded at pick time
    // (lib/grade-group-coverage.ts), never the group. So moving a grade between groups changes approval
    // routing immediately and changes no saved rule's criteria at all: there is no cohort to true up.
    // What it does change is whether a saved rule still covers a WHOLE group, and that is surfaced as
    // drift on the eligibility screen rather than silently rewritten from here. `gradeIds` is still
    // returned by the writer and still used by its own event payload.
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function deleteGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteGradeGroup(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    // The refusal an admin is most likely to meet here — "used by one or more leave approval rules" — is
    // shown on the screen the card now lives on. It names a consequence on ANOTHER screen deliberately:
    // a grade group is shared vocabulary (approval routing AND entitlement eligibility since 9a65f808),
    // so its delete guard cannot be explained without naming a consumer.
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}






// SHARED LEAVE GROUPS (r88, feedback 1ef1cf95) — CRUD for the tenant-level groups that pool several leave
// types under one shared allowance. These replace the scheme-level combined-limit actions (create / update /
// delete / move / group-from-drag), which are gone with the tables they wrote: the reporter rejected the
// Benefit Scheme shape outright, so there is no scheme id on any of these forms and no drag-to-group path.

/** r82a 1ef1cf95 — read the OPTIONAL per-application cap out of a form. An empty box means "no cap", which
 *  is a real answer here and must arrive as null: `Number('')` is 0, so the usual Number(fd.get(...)) shape
 *  would turn "left blank" into a zero-day cap that refuses every application. Trim first so whitespace
 *  reads as blank too. A non-blank, non-numeric value stays NaN and the core validator rejects it loudly. */
function maxDaysPerApplicationFrom(fd: FormData): number | null {
  const raw = String(fd.get('maxDaysPerApplication') ?? '').trim();
  return raw === '' ? null : Number(raw);
}

/** The clash a leave type in two groups would be, rendered as a sentence naming BOTH — the plan's promise
 *  that we "tell you which one rather than silently moving it". Localized here, at the action boundary, the
 *  same way every other typed core error is (the core throws structured data, never a display string). */
async function sharedGroupFailure(e: unknown): Promise<never> {
  const t = await getTranslations('admin.leave.sharedGroup');
  if (e instanceof LeaveTypeAlreadyGroupedError) {
    return fail(ENTITLEMENTS, t('errorAlreadyGrouped', { type: e.leaveTypeName, group: e.groupName }));
  }
  if (e instanceof LeaveSharedGroupNameTakenError) {
    return fail(ENTITLEMENTS, t('errorNameTaken', { name: e.groupName }));
  }
  return fail(ENTITLEMENTS, e);
}

export async function createLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createLeaveSharedGroup(s, {
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      maxDaysPerApplication: maxDaysPerApplicationFrom(fd),
      // 46afcc48 — the group's placement on the employee Leave tab. Read BY VALUE from a <select> that is
      // always submitted: reading it by presence would be trap 17 (an always-sent field cannot answer a
      // yes/no question). An absent or tampered value is narrowed to Hidden by the service, not here.
      essPlacement: String(fd.get('essPlacement') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    await sharedGroupFailure(e);
  }
  ok(ENTITLEMENTS);
}

export async function updateLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await updateLeaveSharedGroup(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      maxDaysPerApplication: maxDaysPerApplicationFrom(fd),
      // 46afcc48 — the group's placement on the employee Leave tab. Read BY VALUE from a <select> that is
      // always submitted: reading it by presence would be trap 17 (an always-sent field cannot answer a
      // yes/no question). An absent or tampered value is narrowed to Hidden by the service, not here.
      essPlacement: String(fd.get('essPlacement') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    await sharedGroupFailure(e);
  }
  ok(ENTITLEMENTS);
}

export async function deleteLeaveSharedGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteLeaveSharedGroup(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}
