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
  setLeaveHalfDayFullDeduction,
  createJobGrade,
  archiveJobGrade,
  updateBusinessUnit,
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeavePolicy,
  updateLeaveType,
  updatePosition,
} from '@/core/admin';
import {
  openLeaveYear,
  accrueEarnedLeave,
  grantAdHocLeave,
  grantAdHocLeaveMulti,
  type LeaveDurationType,
  type ServiceBand,
} from '@/core/leave';
import { setAttendancePolicy } from '@/core/attendance';
import { createLocation, updateLocation, archiveLocation, restoreLocation } from '@/core/location';
import {
  createClockingLocation,
  updateClockingLocation,
  archiveClockingLocation,
  restoreClockingLocation,
  deleteClockingLocation,
  ClockingLocationInUseError,
} from '@/core/clocking-location';
import { requireAdmin } from '@/lib/authz';
import { setToilPolicy, runToilExpiry, closeReplacementLeaveYear } from '@/core/toil';
import { setEncashmentPolicy } from '@/core/leave-encashment';
import type { ToilAccrualBasis, ToilExpiryAction } from '@/db/schema';
import { upsertCompanyBankProfile, removeCompanyBankProfile, type DisbursementBank } from '@/core/bank-profile';
import { packFor } from '@/localization/registry';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';
const ATTENDANCE_POLICY = '/admin/attendance';
const TOIL_POLICY = '/admin/toil';
const LOCATIONS = '/admin/locations';

function fail(path: string, e: unknown): never {
  redirect(`${path}?error=${encodeURIComponent((e as Error).message)}`);
}
function ok(path: string): never {
  revalidatePath(path);
  redirect(path);
}

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

const DISBURSEMENT_BANKS: DisbursementBank[] = ['maybank', 'cimb', 'public_bank', 'rhb'];

export async function setCompanyBankProfileAction(formData: FormData) {
  const s = await getSession();
  const bank = String(formData.get('bank') ?? '');
  try {
    if (!DISBURSEMENT_BANKS.includes(bank as DisbursementBank)) throw new Error('Select a supported bank');
    await upsertCompanyBankProfile(s, {
      companyId: String(formData.get('companyId')),
      bank: bank as DisbursementBank,
      corporateId: String(formData.get('corporateId') ?? ''),
      debitAccountNo: String(formData.get('debitAccountNo') ?? ''),
      orgName: (formData.get('orgName') as string) || null,
      txnType: (formData.get('txnType') as string) || null,
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
  try {
    await updateDepartment(s, {
      id: String(formData.get('id')),
      name: String(formData.get('name') ?? '').trim(),
      businessUnitId: buRaw === null ? undefined : String(buRaw).trim() || null,
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
  try {
    await createLeaveType(s, {
      code: String(formData.get('code') ?? '').trim().toUpperCase(),
      name: String(formData.get('name') ?? '').trim(),
      paid: formData.get('paid') === 'on',
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
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
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

export async function updateLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateLeavePolicy(s, {
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
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
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

/** ADR-0040 (2D-1): top earned policies up to today's accrued amount. Idempotent — admins can run it
 *  any time; the same call the monthly cron (scripts/accrue-earned.ts) makes. */
export async function runEarnedAccrualAction() {
  const s = await getSession();
  try {
    await accrueEarnedLeave(s, { asOf: new Date().toISOString().slice(0, 10) });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

/** ADR-0040 (2D-2): set a company's earned-accrual cycle (calendar vs hire anniversary). */
export async function setCompanyLeaveCycleAction(formData: FormData) {
  const s = await getSession();
  try {
    await setCompanyLeaveCycle(s, {
      companyId: String(formData.get('companyId')),
      cycle: String(formData.get('cycle') || 'calendar'),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

/** Feedback request 31474452: set a company's half-day leave-deduction toggle (checkbox posts "on" or is
 *  absent — mirrors the existing checkbox-action convention in this file, e.g. autoAccrueOnApproval above). */
export async function setLeaveHalfDayFullDeductionAction(formData: FormData) {
  const s = await getSession();
  try {
    await setLeaveHalfDayFullDeduction(s, {
      companyId: String(formData.get('companyId')),
      enabled: formData.get('enabled') === 'on',
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

/** ADR-0041 (2E): grade catalog — create + archive. */
export async function createJobGradeAction(formData: FormData) {
  const s = await getSession();
  try {
    await createJobGrade(s, {
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      rank: Number(formData.get('rank')) || 0,
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

export async function archiveJobGradeAction(formData: FormData) {
  const s = await getSession();
  try {
    await archiveJobGrade(s, { id: String(formData.get('id')), archived: formData.get('archived') === 'true' });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

export async function deleteLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteLeavePolicy(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
}

// ── Public holidays ──
/** Preserve the active country/year filter across the redirect so the admin stays in context. */
function holidaysPath(formData: FormData): string {
  const sp = new URLSearchParams();
  const country = String(formData.get('filterCountry') ?? '').trim();
  const year = String(formData.get('filterYear') ?? '').trim();
  if (country) sp.set('country', country);
  if (year) sp.set('year', year);
  const qs = sp.toString();
  return qs ? `${HOLIDAYS}?${qs}` : HOLIDAYS;
}

export async function createHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  // Scope drives which fields the service receives (ADR-0055): national → neither, state → state only,
  // group → companyId only. Reading the raw select fields directly and zeroing the irrelevant one keeps
  // the action consistent with the DB CHECK + service validation (single-axis scope).
  const scope = String(formData.get('scope') ?? 'national');
  try {
    await createHoliday(s, {
      country: String(formData.get('country') ?? 'MY'),
      holidayDate: String(formData.get('holidayDate') ?? ''),
      name: String(formData.get('name') ?? ''),
      state: scope === 'state' ? String(formData.get('state') ?? '') || null : null,
      companyId: scope === 'group' ? String(formData.get('companyId') ?? '') || null : null,
      // ADR-0063: a provisional date for a not-yet-gazetted holiday (still counts as a holiday).
      tentative: formData.get('tentative') === 'on',
    });
  } catch (e) {
    fail(path, e);
  }
  ok(path);
}

/** ADR-0063: edit an existing holiday's date + name + tentative flag (scope stays fixed). */
export async function updateHolidayAction(formData: FormData) {
  const s = await getSession();
  const path = holidaysPath(formData);
  try {
    await updateHoliday(s, {
      id: String(formData.get('id')),
      holidayDate: String(formData.get('holidayDate') ?? ''),
      name: String(formData.get('name') ?? ''),
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

// ── Holiday groups (named multi-state bundles, assigned per employee) ──
export async function createHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await createHolidayGroup(s, {
      name: String(formData.get('name') ?? ''),
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
    });
  } catch (e) {
    fail(HOLIDAYS, e);
  }
  ok(HOLIDAYS);
}

export async function updateHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateHolidayGroup(s, {
      id: String(formData.get('id')),
      name: String(formData.get('name') ?? ''),
      states: formData.getAll('states').map(String),
      archetype: String(formData.get('archetype') ?? '') || undefined,
    });
  } catch (e) {
    fail(HOLIDAYS, e);
  }
  ok(HOLIDAYS);
}

export async function deleteHolidayGroupAction(formData: FormData) {
  const s = await getSession();
  try {
    await deleteHolidayGroup(s, { id: String(formData.get('id')) });
  } catch (e) {
    fail(HOLIDAYS, e);
  }
  ok(HOLIDAYS);
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
  try {
    await updateBusinessUnit(s, { id: String(fd.get('id')), code: String(fd.get('code') ?? '').trim(), name: String(fd.get('name') ?? '').trim() });
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
  try {
    await updateCompany(s, {
      id: String(fd.get('id')),
      legalName: String(fd.get('legalName') ?? '').trim(),
      registrationNo: (fd.get('registrationNo') as string) || undefined,
      country: (fd.get('country') as string) || undefined,
      currency: (fd.get('currency') as string) || undefined,
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
  // #25 visibility: the eligibility form posts `eligibility=1` (a marker hidden input) so a name-only
  // rename — which doesn't carry that marker — leaves the rule untouched (tri-state in updateLeaveType).
  const touchEligibility = fd.get('eligibility') === '1';
  const minRaw = String(fd.get('minServiceMonths') ?? '').trim();
  const eligibility = touchEligibility
    ? {
        gender: String(fd.get('gender') ?? '') || undefined,
        maritalStatus: String(fd.get('maritalStatus') ?? '') || undefined,
        minServiceMonths: minRaw === '' ? undefined : Number(minRaw),
      }
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
  // Partial Leave Approval (ADR-0068): its own sub-form posts `partialApproval=1` (marker) so a rename /
  // eligibility / durations / document / payroll / backdating edit that omits it leaves per_date_approval
  // untouched (same tri-state guard). Unchecked-when-rendered ⇒ false; the marker distinguishes that from
  // "block not shown at all" ⇒ leave column.
  const touchPartial = fd.get('partialApproval') === '1';
  const partialFields = touchPartial ? { perDateApproval: fd.get('perDateApproval') === 'on' } : {};
  try {
    await updateLeaveType(s, {
      id: String(fd.get('id')),
      name: String(fd.get('name') ?? '').trim(),
      eligibility,
      durations,
      ...docFields,
      ...payrollFields,
      ...backdatingFields,
      ...partialFields,
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
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
