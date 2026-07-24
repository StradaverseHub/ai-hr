'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
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
  createLeavePolicy,
  createLeaveType,
  createPosition,
  deleteHoliday,
  deleteHolidayGroup,
  deleteLeavePolicy,
  updateHoliday,
  updateHolidayGroup,
  deleteCompany,
  deleteCostCenter,
  deleteDepartment,
  deleteLeaveType,
  deletePosition,
  revokeRole,
  setCompanyParent,
  setCompanyLeaveCycle,
  setCompanyLogo,
  removeCompanyLogo,
  setLeaveHalfDayFullDeduction,
  updateBusinessUnit,
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeavePolicy,
  saveServiceEntitlement,
  updateLeaveType,
  updatePosition,
} from '@/core/admin';
import {
  openLeaveYear,
  upsertLeaveYearConfig,
  setLeaveYearStatus,
  saveFutureOpeningRule,
  deleteLeaveYear,
  LeaveYearDeleteError,
  isLeaveYearStatus,
  accrueEarnedLeave,
  asOfForLeaveYear,
  grantAdHocLeave,
  grantAdHocLeaveMulti,
  reprojectEntitlementForSchemeCohort,
  todayInKualaLumpur,
  DAY_TYPE_INCLUSION_KEYS,
  type DayTypeInclusion,
  type EarnedAccrualGroup,
  type LeaveDurationType,
  type LeaveEligibility,
  type ServiceBand,
} from '@/core/leave';
import { ORG_ASSIGNMENT_CRITERIA } from '@/core/leave-org-criteria';
import { setAttendancePolicy } from '@/packs/attendance/service';
import { createLocation, updateLocation, archiveLocation, restoreLocation } from '@/core/location';
import {
  createClockingLocation,
  updateClockingLocation,
  archiveClockingLocation,
  restoreClockingLocation,
  deleteClockingLocation,
  ClockingLocationInUseError,
} from '@/packs/attendance/service';
import { countEmployeesInScope } from '@/core/read';
import { ESS_VIEW_COMPONENT_KEYS, type EssViewConfig } from '@/core/ess-view';
import { LEAVE_EXPLANATION_KEYS, type LeaveFormulaConfig } from '@/core/leave-formula';
import { requireAdmin } from '@/lib/authz';
import {
  createGradeGroup,
  updateGradeGroup,
  deleteGradeGroup,
  createBenefitScheme,
  updateBenefitScheme,
  deleteBenefitScheme,
  upsertSchemeEntitlement,
  deleteSchemeEntitlement,
  copySchemeEntitlements,
  createSchemeCombinedLimit,
  updateSchemeCombinedLimit,
  deleteSchemeCombinedLimit,
  moveCombinedLimitMember,
  groupSchemeLeaveTypes,
} from '@/core/benefit-scheme';
import { inviteUser, revokeInvitation, setAppUserArchived } from '@/core/auth';
import { setToilPolicy, runToilExpiry, closeReplacementLeaveYear } from '@/core/toil';
import { setEncashmentPolicy } from '@/core/leave-encashment';
import type { ToilAccrualBasis, ToilExpiryAction } from '@/db/schema';
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
import { ENTITLEMENTS, fail, ok, okToast, okEntitlements } from './_redirects';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
// R45 cc816207 — the managed Leave-Year table RELOCATED from the Entitlements tab to the Application Rules
// tab, so its create/edit/open/close/delete/opening-rule actions revalidate/redirect HERE (the page reads
// ?error= for the ErrorBanner).
const APPLICATION_RULES = '/admin/leave/application-rules';
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';
// 66b8f5a8 — the Holiday Group tab + its dedicated add/edit pages.
const HOLIDAY_GROUPS = '/admin/holidays/groups';
// R33 f21d6eee — the per-company attendance policy + OT-rates form moved to its own /admin/attendance-policy
// screen (the /admin/attendance route is now the shared shift library). setAttendancePolicyAction redirects here.
const ATTENDANCE_POLICY = '/admin/attendance-policy';
const TOIL_POLICY = '/admin/toil';
const LOCATIONS = '/admin/locations';

export async function createCompanyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createCompany(s, {
      legalName: String(formData.get('legalName') ?? '').trim(),
      country: String(formData.get('country') ?? 'MY'),
      currency: String(formData.get('currency') ?? 'MYR'),
      registrationNo: (formData.get('registrationNo') as string) || undefined,
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
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

export async function setCompanyStatutoryAction(formData: FormData) {
  const s = await getSession();
  const country = String(formData.get('country') ?? 'MY');
  try {
    const pack = packFor(country);
    if (!pack?.companyStatutory) throw new Error(`No statutory pack for ${country}`);
    const hrdfRaw = String(formData.get('hrdfStatus') ?? '');
    const hrdfStatus =
      hrdfRaw === 'not_registered' || hrdfRaw === 'mandatory' || hrdfRaw === 'optional' ? hrdfRaw : undefined;
    await pack.companyStatutory.set(s, {
      companyId: String(formData.get('companyId')),
      epfEmployerNo: (formData.get('epfEmployerNo') as string) || undefined,
      socsoEmployerCode: (formData.get('socsoEmployerCode') as string) || undefined,
      lhdnEmployerNo: (formData.get('lhdnEmployerNo') as string) || undefined,
      myinvoisTin: (formData.get('myinvoisTin') as string) || undefined,
      ssmRegistrationNo: (formData.get('ssmRegistrationNo') as string) || undefined,
      hrdfStatus,
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
 *  - marker present + 'up' / 'down' ⇒ that value = SET;
 *  - marker present + anything else (incl. 'none') ⇒ `null` = explicit CLEAR (omit the key).
 * Only the forms that actually render the dropdown (Earning Method, the multi-scope add form) post the marker.
 */
const roundingMethodField = (fd: FormData): 'up' | 'down' | null | undefined => {
  if (fd.get('roundingMethodRendered') == null) return undefined;
  const v = String(fd.get('roundingMethod') ?? '');
  return v === 'up' || v === 'down' ? v : null;
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

export async function createLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createLeavePolicy(s, {
      leaveTypeId: String(formData.get('leaveTypeId')),
      annualDays: Number(formData.get('annualDays')),
      carryForwardMax: Number(formData.get('carryForwardMax')) || 0,
      carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
      carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
      carryForwardExpiryMode: carryExpiryMode(formData),
      carryForwardExpiryMonths: carryExpiryField(formData.get('carryForwardExpiryMonths')),
      carryForwardEnabled: carryFlagField(formData, 'carryForwardEnabled'),
      carryForwardIncludeEarned: carryFlagField(formData, 'carryForwardIncludeEarned'),
      method: String(formData.get('method') || '') || undefined,
      gradeId: String(formData.get('gradeId') || '') || null,
      companyId: String(formData.get('companyId') || '') || null,
      serviceBands: serviceBandsField(formData),
      roundingMethod: roundingMethodField(formData),
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

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
export async function createLeavePoliciesMultiAction(formData: FormData) {
  const s = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId') ?? '');
  const companyIds = formData.getAll('companyIds').map(String).filter(Boolean);
  const gradeIds = formData.getAll('gradeIds').map(String).filter(Boolean);
  const companies: (string | null)[] = companyIds.length ? companyIds : [null];
  const grades: (string | null)[] = gradeIds.length ? gradeIds : [null];
  const bands = serviceBandsField(formData);
  // b81d3c52: read the Rounding Method ONCE — every fanned-out (company × grade) row gets the same value.
  const rounding = roundingMethodField(formData);
  try {
    for (const companyId of companies) {
      for (const gradeId of grades) {
        await createLeavePolicy(s, {
          leaveTypeId,
          annualDays: Number(formData.get('annualDays')),
          carryForwardMax: Number(formData.get('carryForwardMax')) || 0,
          carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
          carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
          carryForwardExpiryMode: carryExpiryMode(formData),
          carryForwardExpiryMonths: carryExpiryField(formData.get('carryForwardExpiryMonths')),
          carryForwardEnabled: carryFlagField(formData, 'carryForwardEnabled'),
          carryForwardIncludeEarned: carryFlagField(formData, 'carryForwardIncludeEarned'),
          method: String(formData.get('method') || '') || undefined,
          gradeId,
          companyId,
          serviceBands: bands,
          roundingMethod: rounding,
          validFrom: String(formData.get('validFrom')),
        });
      }
    }
  } catch (e) {
    // 9b0503ac — the add-entitlement form lives inside a leave type's Entitlements config panel; a failed
    // save must surface its error banner THERE, not bounce HR to /admin/leave (no #type anchor: fail()
    // appends ?error=, and a fragment before the query string would swallow it — the b9dac2d1 precedent).
    fail(ENTITLEMENTS, e);
  }
  // 9b0503ac — stay on the same leave type's panel with the success toast (no re-navigation between
  // adjustments); the form's hidden leaveTypeId is the workspace's selection anchor.
  const t = await getTranslations('admin.leave');
  okEntitlements(t('entitlementUpdatedToast'), leaveTypeId);
}

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

export async function updateLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  // Feedback 49809272: an in-place correction re-projects affected employees' CURRENT cycle and posts
  // compensating ledger adjustments. The action anchors "today" in tenant-local MYT (the requestLeave
  // convention) and surfaces the blast radius as a toast (ToastFromQuery renders the raw string, so the
  // text is localised HERE, not a code).
  const t = await getTranslations('admin.leave');
  let recalc = { affected: 0, totalDelta: 0 };
  try {
    recalc = await updateLeavePolicy(s, {
      id: String(formData.get('id')),
      annualDays: Number(formData.get('annualDays')),
      carryForwardMax: Number(formData.get('carryForwardMax')) || 0,
      carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
      carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
      carryForwardExpiryMode: carryExpiryMode(formData),
      carryForwardExpiryMonths: carryExpiryField(formData.get('carryForwardExpiryMonths')),
      carryForwardEnabled: carryFlagField(formData, 'carryForwardEnabled'),
      carryForwardIncludeEarned: carryFlagField(formData, 'carryForwardIncludeEarned'),
      method: String(formData.get('method') || '') || undefined,
      gradeId: String(formData.get('gradeId') || '') || null,
      companyId: String(formData.get('companyId') || '') || null,
      serviceBands: serviceBandsField(formData),
      roundingMethod: roundingMethodField(formData),
      validFrom: String(formData.get('validFrom')),
      asOf: todayInKualaLumpur(),
      // 4ec5a940 — optional "why the change was made" note, recorded on the audit event.
      reason: String(formData.get('reason') || '') || null,
    });
  } catch (e) {
    // 9b0503ac — every policy edit form (Eligibility inline edit + the Earning/Carry front doors) lives
    // inside a type's Entitlements config panel; fail back THERE so the error banner is visible in place
    // (no #type anchor: a fragment before ?error= would swallow it — the b9dac2d1 precedent).
    fail(ENTITLEMENTS, e);
  }
  // 9b0503ac — stay exactly where the admin was: the Entitlements panel, same leave type (the form's
  // hidden leaveTypeId → #type-<id> anchor). The 49809272 blast-radius toast stays when employees were
  // recalculated; the no-recalc case shows the reporter's requested plain success confirmation.
  const delta = `${recalc.totalDelta > 0 ? '+' : ''}${recalc.totalDelta}`;
  okEntitlements(
    recalc.affected > 0 ? t('recalcToast', { count: recalc.affected, delta }) : t('entitlementUpdatedToast'),
    String(formData.get('leaveTypeId') ?? ''),
  );
}

/**
 * Restructure Service-Based Leave Entitlements — save one grade's three service-band figures for a company
 * from the company-driven Service Based Entitlements table. The first save for a company materialises the
 * whole company scope so the untouched grades never silently drop to zero (ADR-0066 short-circuit); the
 * edited grade is recalculated in place. Everything is orchestrated over the existing createLeavePolicy /
 * updateLeavePolicy writers in core (no new writer primitive) — see saveServiceEntitlement.
 */
export async function saveServiceEntitlementAction(formData: FormData) {
  const s = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId') ?? '');
  const t = await getTranslations('admin.leave');
  let recalc = { affected: 0, totalDelta: 0 };
  try {
    recalc = await saveServiceEntitlement(s, {
      leaveTypeId,
      companyId: String(formData.get('companyId') ?? ''),
      gradeId: String(formData.get('gradeId') ?? ''),
      under2: Number(formData.get('under2')),
      mid: Number(formData.get('mid')),
      over: Number(formData.get('over')),
      asOf: todayInKualaLumpur(),
    });
  } catch (e) {
    // 9b0503ac — surface the error on the Entitlements panel, not a bounce to /admin/leave.
    fail(ENTITLEMENTS, e);
  }
  const delta = `${recalc.totalDelta > 0 ? '+' : ''}${recalc.totalDelta}`;
  okEntitlements(
    recalc.affected > 0 ? t('recalcToast', { count: recalc.affected, delta }) : t('entitlementUpdatedToast'),
    leaveTypeId,
  );
}

/** ADR-0066 (re-plan round 5): festive / one-off leave grant. Returns the affected-employee count for the
 *  confirm step (no redirect — a client card shows the count + toast, then refreshes). Branches on the
 *  `groupWide` checkbox: when set, reuses the shipped single-company-shaped `grantAdHocLeave` with
 *  companyId=null (byte-identical path, group admins only); otherwise reads `companyIds` (multi-select
 *  checkboxes, formData.getAll) and calls the new `grantAdHocLeaveMulti`. */
export async function grantAdHocLeaveAction(
  formData: FormData,
): Promise<{ granted?: number; targeted?: number; companies?: number; skipped?: number; error?: string }> {
  const s = await getSession();
  const leaveTypeId = String(formData.get('leaveTypeId') || '');
  const days = Number(formData.get('days'));
  const reason = String(formData.get('reason') || '');
  const effectiveOn = String(formData.get('effectiveOn') || '');
  const expiresOn = String(formData.get('expiresOn') || '') || null;
  try {
    if (formData.get('groupWide')) {
      const res = await grantAdHocLeave(s, {
        companyId: null,
        leaveTypeId,
        days,
        reason,
        effectiveOn,
        expiresOn,
      });
      revalidatePath(LEAVE);
      return { granted: res.granted, targeted: res.targeted };
    }
    const companyIds = formData.getAll('companyIds').map(String);
    const res = await grantAdHocLeaveMulti(s, {
      companyIds,
      leaveTypeId,
      days,
      reason,
      effectiveOn,
      expiresOn,
    });
    revalidatePath(LEAVE);
    return { granted: res.granted, targeted: res.targeted, companies: res.companies, skipped: res.skipped };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

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
 *  toasts + refreshes, mirroring grantAdHocLeaveAction. */
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

/** ADR-0040 (2D-2): set a company's earned-accrual cycle (calendar vs hire anniversary).
 *  R61 d778d2d3 — the Leave Cycle card RELOCATED from the Entitlements tab to the Application Rules tab,
 *  so this redirects/revalidates THERE (mirroring the R45 cc816207 leave-year precedent; the page reads
 *  ?error= for its ErrorBanner). The cycle write itself (core setCompanyLeaveCycle) is untouched. */
export async function setCompanyLeaveCycleAction(formData: FormData) {
  const s = await getSession();
  try {
    await setCompanyLeaveCycle(s, {
      companyId: String(formData.get('companyId')),
      cycle: String(formData.get('cycle') || 'calendar'),
    });
  } catch (e) {
    fail(APPLICATION_RULES, e);
  }
  ok(APPLICATION_RULES);
}

/** Feedback request 31474452: set a company's half-day leave-deduction toggle (checkbox posts "on" or is
 *  absent — mirrors the existing checkbox-action convention in this file, e.g. autoAccrueOnApproval above). */
// R64 08bc6841 — the half-day-deduction card's single home is now the Entitlements tab (the Condition
// step's Leave Application Rules grid), so this action redirects THERE (the R45 cc816207 / R61 d778d2d3
// relocation precedent). The setLeaveHalfDayFullDeduction write itself is unchanged.
export async function setLeaveHalfDayFullDeductionAction(formData: FormData) {
  const s = await getSession();
  try {
    await setLeaveHalfDayFullDeduction(s, {
      companyId: String(formData.get('companyId')),
      enabled: formData.get('enabled') === 'on',
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

export async function deleteLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteLeavePolicy(s, { id: String(formData.get('id')) });
  } catch (e) {
    // 9b0503ac — the remove button sits in the same Entitlements config panel; stay there on failure too.
    fail(ENTITLEMENTS, e);
  }
  // 9b0503ac — removing a dated entitlement row keeps the admin on the same type's panel (consistent with
  // the neighbouring policy add/edit saves), with its own removal wording.
  const t = await getTranslations('admin.leave');
  okEntitlements(t('entitlementRemovedToast'), String(formData.get('leaveTypeId') ?? ''));
}

// ── Public holidays ──
/** Preserve the active country/year/group filter across the redirect so the admin stays in context.
 *  (R18 a519a96e: `group` keeps the per-group effective-calendar view open across row edits.) */
function holidaysPath(formData: FormData): string {
  const sp = new URLSearchParams();
  const country = String(formData.get('filterCountry') ?? '').trim();
  const year = String(formData.get('filterYear') ?? '').trim();
  const group = String(formData.get('filterGroup') ?? '').trim();
  if (country) sp.set('country', country);
  if (year) sp.set('year', year);
  if (group) sp.set('group', group);
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

export async function openLeaveYearAction(formData: FormData) {
  const s = await getSession();
  const year = Number(formData.get('year'));
  let res = { granted: 0, skipped: 0, forfeits: 0 };
  try {
    if (!Number.isInteger(year) || year < 2020 || year > 2100) throw new Error('Invalid year');
    res = await openLeaveYear(s, { year });
  } catch (e) {
    fail(LEAVE, e);
  }
  revalidatePath(LEAVE);
  redirect(
    `${LEAVE}?toast=${encodeURIComponent(
      `Leave year ${year}: ${res.granted} grant${res.granted === 1 ? '' : 's'} posted` +
        (res.skipped ? `, ${res.skipped} already open` : '') +
        (res.forfeits ? `, ${res.forfeits} forfeit${res.forfeits === 1 ? '' : 's'}` : ''),
    )}`,
  );
}

// Leave Year Configuration (9aa894a4): create/edit a managed leave-year record's two control dates. Status
// is NOT changed here (setLeaveYearStatusAction moves the lifecycle). Empty date inputs post '' → cleared.
// dcd8e32f: a successful save now confirms via okToast (localised HERE) so the admin knows the edit took.
export async function upsertLeaveYearConfigAction(formData: FormData) {
  const s = await getSession();
  const t = await getTranslations('admin.leave');
  try {
    await upsertLeaveYearConfig(s, {
      year: Number(formData.get('year')),
      openLeaveYearDate: String(formData.get('openLeaveYearDate') ?? '') || null,
      employeeApplicationStartDate: String(formData.get('employeeApplicationStartDate') ?? '') || null,
    });
  } catch (e) {
    fail(APPLICATION_RULES, e);
  }
  okToast(APPLICATION_RULES, t('leaveYearSavedToast'));
}

// Leave Year Configuration (9aa894a4): transition a managed leave-year's status. →open runs the existing
// openLeaveYear grant sweep (idempotent) + stamps opened_at/by, keeping the record and ledger in lockstep.
// This is the repointed "Open leave year" action — the button posts status='open' through the record.
export async function setLeaveYearStatusAction(formData: FormData) {
  const s = await getSession();
  const year = Number(formData.get('year'));
  const status = String(formData.get('status') ?? '');
  let res: Awaited<ReturnType<typeof setLeaveYearStatus>> | null = null;
  try {
    if (!isLeaveYearStatus(status)) throw new Error('Invalid leave-year status');
    res = await setLeaveYearStatus(s, { year, status });
  } catch (e) {
    fail(APPLICATION_RULES, e);
  }
  revalidatePath(APPLICATION_RULES);
  const opened = res?.opened;
  redirect(
    `${APPLICATION_RULES}?toast=${encodeURIComponent(
      opened
        ? `Leave year ${year} opened: ${opened.granted} grant${opened.granted === 1 ? '' : 's'} posted` +
            (opened.skipped ? `, ${opened.skipped} already open` : '') +
            (opened.forfeits ? `, ${opened.forfeits} forfeit${opened.forfeits === 1 ? '' : 's'}` : '')
        : `Leave year ${year} status set to ${status}`,
    )}`,
  );
}

// Future Leave Year Opening Rule (d9e41725): persist the advance-opening policy for a leave year. Posted by
// the per-row "Advanced leave year rules" dialog (37088a65), whose hidden `year` input pins the save to the
// clicked record. `enable` is a plain checkbox — present when checked, absent ⇒ disable the rule (no marker
// field exists; disabling works purely from the checkbox's absence). When enabled, the service computes +
// stamps open_leave_year_date = Jan-1-minus-window (v1 is COMPUTE-ONLY; no auto-open cron).
export async function saveFutureOpeningRuleAction(formData: FormData) {
  const s = await getSession();
  try {
    const enabled = formData.get('enable') != null;
    const rawAmount = String(formData.get('openBeforeAmount') ?? '').trim();
    await saveFutureOpeningRule(s, {
      year: Number(formData.get('year')),
      enabled,
      amount: rawAmount === '' ? null : Number(rawAmount),
      unit: String(formData.get('openBeforeUnit') ?? '') || null,
    });
  } catch (e) {
    fail(APPLICATION_RULES, e);
  }
  ok(APPLICATION_RULES);
}

// R45 fd71fa38 — delete a mistakenly-created DRAFT leave-year record. The service enforces the guard (draft
// only + no leave ledger / live requests referencing the year) and throws LeaveYearDeleteError. dcd8e32f:
// admin-gated with requireAdmin() (getSession() left ordinary members through to a service with no admin
// assertion), and the refusal reason is LOCALISED here from the error's stable code before fail() redirects
// (ErrorBanner renders the raw string — never pass a code in the URL; app/admin/payroll-cycle/actions.ts
// documents the same convention). The actor threads through the admin session, so the leave-year.deleted
// event carries a real user, not SYSTEM.
export async function deleteLeaveYearAction(formData: FormData) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.leave');
  const year = Number(formData.get('year'));
  // f1701466 — the two-step confirm dialog mirrors each checked deletion reason as a hidden input named
  // `reasons`; getAll collects them all (filter guards stray empty values — the companyIds convention).
  // The service validates against its allowlist LAST, after the block guards (UI disable is not authority).
  const reasons = formData.getAll('reasons').map(String).filter(Boolean);
  try {
    await deleteLeaveYear(s, { year, reasons });
  } catch (e) {
    const localised =
      e instanceof LeaveYearDeleteError
        ? e.code === 'leaveYearNotFound'
          ? t('deleteLeaveYearNotFound')
          : e.code === 'leaveYearNotDraft'
            ? t('deleteLeaveYearBlockedOpened')
            : e.code === 'leaveYearHasLedger'
              ? t('deleteLeaveYearBlockedRecords')
              : e.code === 'leaveYearHasRequests'
                ? t('deleteLeaveYearBlockedRequests')
                : null
        : null;
    fail(APPLICATION_RULES, localised ? new Error(localised) : e);
  }
  // Success toast stays plain English by this file's convention (mirrors setLeaveYearStatusAction).
  okToast(APPLICATION_RULES, `Leave year ${year} deleted`);
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
  // Minimum advance-notice rule (0159): its own sub-form posts `minAdvance=1` (marker), mirroring the
  // backdating tri-state guard above. Empty input ⇒ null (clears the requirement); a number sets it.
  const touchMinAdvance = fd.get('minAdvance') === '1';
  const minAdvanceRaw = String(fd.get('minAdvanceDays') ?? '').trim();
  const minAdvanceFields = touchMinAdvance
    ? { minAdvanceDays: minAdvanceRaw === '' ? null : Number(minAdvanceRaw) }
    : {};
  // Leave Type Expiry Field (fec49317): its own sub-form posts `expiry=1` (marker) so any other save leaves
  // expiry_value / expiry_unit untouched (same tri-state guard). A blank value clears the pair (both null ⇒
  // no expiry); a number + unit configures age-from-earning expiry. The service normalizes/validates and
  // rejects a half-configured pair. The unit is only forwarded when a value is present, so a blank save
  // reliably clears both columns.
  const touchExpiry = fd.get('expiry') === '1';
  const expiryRaw = String(fd.get('expiryValue') ?? '').trim();
  const expiryUnitRaw = String(fd.get('expiryUnit') ?? '').trim();
  const expiryFields = touchExpiry
    ? expiryRaw === ''
      ? { expiryValue: null, expiryUnit: null }
      : { expiryValue: Number(expiryRaw), expiryUnit: (expiryUnitRaw === 'days' ? 'days' : 'months') as 'months' | 'days' }
    : {};
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
  const touchNegativeBalance = fd.get('negativeBalance') === '1';
  const negativeBalanceFields = touchNegativeBalance
    ? { allowNegativeBalance: fd.get('allowNegativeBalanceValue') === 'yes' }
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
  // Leave Entitlement Formula Management (79011509, consolidated by 2bc2f2a3): the merged view-configuration
  // sub-form posts `formula=1` (marker) plus, per component, up to three free-text fields
  // (`formula_<key>_description`, `formula_<key>_formula`, `formula_<key>_result`). We build the COMPLETE
  // { key: entry } map from the closed key list — WIDENED (2bc2f2a3) from the 7 legacy calc-breakdown keys to
  // LEAVE_EXPLANATION_KEYS (legacy 7 ∪ every ess-view key) so any configurable view item can be annotated; a
  // key the form never rendered posts nothing ⇒ '' ⇒ dropped by the service, which trims + drops blanks +
  // normalises an all-blank map to null (clear). Any other sub-form save omits the marker ⇒
  // formula_explanations stays untouched (same tri-state guard as essView).
  const touchFormula = fd.get('formula') === '1';
  const formulaFields = touchFormula
    ? {
        formulaExplanations: Object.fromEntries(
          LEAVE_EXPLANATION_KEYS.map((key) => [
            key,
            {
              description: String(fd.get(`formula_${key}_description`) ?? ''),
              formula: String(fd.get(`formula_${key}_formula`) ?? ''),
              result: String(fd.get(`formula_${key}_result`) ?? ''),
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
  // Leave Type Employee Visibility (7b11f1c1): its own sub-form posts `visibility=1` (marker) plus two
  // checkboxes — `visibleToEmployee` (whether the type shows on the /me Leave tab) and `employeeCanApply`
  // (whether employees may apply for it). A checked box posts 'on', an unchecked box does not post, so with
  // the marker present we forward a concrete boolean for each: checked ⇒ true, absent ⇒ false. Any other
  // sub-form save omits the marker ⇒ both columns stay untouched (same tri-state guard as essView/leaveUnit).
  // The service rejects employeeCanApply=false on a statutory-entitlement code.
  const touchVisibility = fd.get('visibility') === '1';
  const visibilityFields = touchVisibility
    ? {
        visibleToEmployee: fd.get('visibleToEmployee') === 'on',
        employeeCanApply: fd.get('employeeCanApply') === 'on',
      }
    : {};
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
      ...backdatingFields,
      ...minAdvanceFields,
      ...expiryFields,
      ...partialFields,
      ...duplicatePolicyFields,
      ...negativeBalanceFields,
      ...essViewFields,
      ...formulaFields,
      ...dayTypeInclusionFields,
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
export async function runToilExpiryAction() {
  const s = await getSession();
  const today = new Date().toISOString().slice(0, 10);
  let result;
  try {
    result = await runToilExpiry(s, { today });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  revalidatePath(TOIL_POLICY);
  redirect(`${TOIL_POLICY}?processed=${result!.processed}&converted=${result!.converted}&lapsed=${result!.lapsed}`);
}

// RL Control Engine (0113) — year-end rollover: expire (or carry-forward, per each accrual's frozen flag) the
// replacement-leave balance at the year boundary. Supervised admin click; no cron. `asOf` defaults to this
// year's 31 Dec for calendar tenants (the service recomputes per-employment boundaries for anniversary).
export async function closeReplacementLeaveYearAction() {
  const s = await getSession();
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
export async function setToilPolicyAction(fd: FormData) {
  const s = await getSession();
  let warning: string | undefined;
  try {
    // Phase-B #14: premium_equivalent + allowing First-Schedule staff returns a banking-risk warning.
    const r = await setToilPolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      enabled: fd.get('enabled') === 'on',
      accrualBasis: String(fd.get('accrualBasis') ?? 'hours_worked') as ToilAccrualBasis,
      expiryDays: Number(fd.get('expiryDays') ?? 90),
      onExpiry: String(fd.get('onExpiry') ?? 'convert_to_pay') as ToilExpiryAction,
      allowFirstScheduleEligible: fd.get('allowFirstScheduleEligible') === 'on',
      autoAccrueOnApproval: fd.get('autoAccrueOnApproval') === 'on',
      carryForwardAtYearEnd: fd.get('carryForwardAtYearEnd') === 'on',
    });
    warning = r.premiumEquivalentWarning;
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  if (warning) {
    revalidatePath(TOIL_POLICY);
    redirect(`${TOIL_POLICY}?warning=${encodeURIComponent(warning)}`);
  }
  ok(TOIL_POLICY);
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
  // ADR-0069: how an approved overtime request's minutes are resolved (requested | system_calculated | smaller_of).
  const otRaw = String(fd.get('otApprovalCalculation') ?? 'system_calculated');
  const otApprovalCalculation = (
    otRaw === 'requested' || otRaw === 'smaller_of' ? otRaw : 'system_calculated'
  ) as 'requested' | 'system_calculated' | 'smaller_of';
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
    });
  } catch (e) {
    fail(LOCATIONS, e);
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
    });
  } catch (e) {
    fail(LOCATIONS, e);
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
export async function createClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await createClockingLocation(user, {
      companyId: String(fd.get('companyId') ?? ''),
      name: String(fd.get('name') ?? ''),
      lat: Number(fd.get('lat')),
      lng: Number(fd.get('lng')),
      address: (fd.get('address') as string) || null,
      remarks: (fd.get('remarks') as string) || null,
    });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
}

export async function updateClockingLocationAction(fd: FormData) {
  const user = await requireAdmin();
  try {
    await updateClockingLocation(user, {
      clockingLocationId: String(fd.get('clockingLocationId') ?? ''),
      name: String(fd.get('name') ?? ''),
      lat: Number(fd.get('lat')),
      lng: Number(fd.get('lng')),
      address: (fd.get('address') as string) || null,
      remarks: (fd.get('remarks') as string) || null,
    });
  } catch (e) {
    fail(LOCATIONS, e);
  }
  ok(LOCATIONS);
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
async function recalcSchemeCohort(
  s: Awaited<ReturnType<typeof requireAdmin>>,
  p: { schemeId?: string; gradeIds?: string[]; trigger: string },
): Promise<void> {
  try {
    await reprojectEntitlementForSchemeCohort(s, p);
  } catch {
    // non-fatal — idempotent, re-runs on the next config or profile trigger.
  }
}

function parseBands(fd: FormData): import('@/core/leave-compute').ServiceBand[] {
  const raw = String(fd.get('serviceBands') ?? '[]');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createGradeGroup(s, {
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function updateGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    const { gradeIds } = await updateGradeGroup(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      gradeIds: fd.getAll('gradeIds').map((v) => String(v)).filter(Boolean),
    });
    // ae5b84d5: membership moved ⇒ true up BOTH cohorts (the union of before/after grade ids) — a grade
    // moved into another group re-matches its employees to that group's scheme immediately.
    await recalcSchemeCohort(s, { gradeIds, trigger: 'grade_group_changed' });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function deleteGradeGroupAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteGradeGroup(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function createBenefitSchemeAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createBenefitScheme(s, {
      companyId: String(fd.get('companyId') ?? ''),
      employmentType: String(fd.get('employmentType') ?? ''),
      gradeGroupId: (String(fd.get('gradeGroupId') ?? '') || null),
      name: String(fd.get('name') ?? ''),
      status: String(fd.get('status') ?? 'active'),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function updateBenefitSchemeAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    const schemeId = String(fd.get('id') ?? '');
    const { changed } = await updateBenefitScheme(s, {
      id: schemeId,
      companyId: String(fd.get('companyId') ?? ''),
      employmentType: String(fd.get('employmentType') ?? ''),
      gradeGroupId: (String(fd.get('gradeGroupId') ?? '') || null),
      name: String(fd.get('name') ?? ''),
      status: String(fd.get('status') ?? 'active'),
    });
    // ae5b84d5: only a match-identity/usability change (status / employment type / grade group / company)
    // re-shuffles coverage — activate/deactivate included, so a mass-revert lands NOW with an honest
    // scheme_updated audit trigger instead of dripping out of later unrelated runs. Renames skip.
    if (changed) await recalcSchemeCohort(s, { schemeId, trigger: 'scheme_updated' });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function deleteBenefitSchemeAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteBenefitScheme(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function upsertSchemeEntitlementAction(fd: FormData) {
  const s = await requireAdmin();
  const leaveTypeId = String(fd.get('leaveTypeId') ?? '');
  try {
    const benefitSchemeId = String(fd.get('benefitSchemeId') ?? '');
    await upsertSchemeEntitlement(s, {
      benefitSchemeId,
      leaveTypeId,
      serviceBands: parseBands(fd),
    });
    // ae5b84d5: band edits flow through to covered employees immediately — up AND down (a downward earned
    // correction can only land here; the monthly run never posts negatives). Idempotent: re-saving the
    // same values computes delta 0 for everyone and posts nothing.
    await recalcSchemeCohort(s, { schemeId: benefitSchemeId, trigger: 'scheme_entitlement_changed' });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  // 9b0503ac — the reporter's exact flow: saving the service-band day values (under 2 / 2–5 / over 5 yrs)
  // must keep the admin on the same leave type's panel and confirm with a success toast. The form always
  // posts leaveTypeId (hidden when editing, the select when adding) — it anchors the redirect.
  const t = await getTranslations('admin.leave');
  okEntitlements(t('entitlementUpdatedToast'), leaveTypeId);
}

export async function deleteSchemeEntitlementAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    const { benefitSchemeId } = await deleteSchemeEntitlement(s, { id: String(fd.get('id') ?? '') });
    // ae5b84d5: covered employees revert to grade-policy/floor days — true them up now.
    if (benefitSchemeId) {
      await recalcSchemeCohort(s, { schemeId: benefitSchemeId, trigger: 'scheme_entitlement_changed' });
    }
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

// Copy / Duplicate Leave Entitlements (R44 ba494b21) — bring a source scheme's entitlements into the target,
// skipping any leave type already configured on the target (no overwrite).
export async function copySchemeEntitlementsAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await copySchemeEntitlements(s, {
      sourceSchemeId: String(fd.get('sourceSchemeId') ?? ''),
      targetSchemeId: String(fd.get('targetSchemeId') ?? ''),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

// Combined Leave Type Limit (R44 4c48fd1f) — CRUD for the shared per-cycle caps pooling several leave types.
export async function createSchemeCombinedLimitAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await createSchemeCombinedLimit(s, {
      benefitSchemeId: String(fd.get('benefitSchemeId') ?? ''),
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function updateSchemeCombinedLimitAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await updateSchemeCombinedLimit(s, {
      id: String(fd.get('id') ?? ''),
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function deleteSchemeCombinedLimitAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await deleteSchemeCombinedLimit(s, { id: String(fd.get('id') ?? '') });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

// R47 d6f88c2f — drag-and-drop grouping in the entitlement table. One drag = one narrow write: either move
// a leave type between pools (empty toCombinedLimitId = ungroup), or create a pool from the dragged rows
// (detaching them from any previous pool server-side).
export async function moveCombinedLimitMemberAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await moveCombinedLimitMember(s, {
      benefitSchemeId: String(fd.get('benefitSchemeId') ?? ''),
      leaveTypeId: String(fd.get('leaveTypeId') ?? ''),
      toCombinedLimitId: String(fd.get('toCombinedLimitId') ?? '') || null,
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}

export async function groupSchemeLeaveTypesAction(fd: FormData) {
  const s = await requireAdmin();
  try {
    await groupSchemeLeaveTypes(s, {
      benefitSchemeId: String(fd.get('benefitSchemeId') ?? ''),
      name: String(fd.get('name') ?? ''),
      totalLimitDays: Number(fd.get('totalLimitDays') ?? ''),
      leaveTypeIds: fd.getAll('leaveTypeIds').map((v) => String(v)).filter(Boolean),
    });
  } catch (e) {
    fail(ENTITLEMENTS, e);
  }
  ok(ENTITLEMENTS);
}
