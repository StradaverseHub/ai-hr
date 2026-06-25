'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveCompany,
  archiveCostCenter,
  archiveDepartment,
  archiveLeaveType,
  archivePosition,
  assignRole,
  createCompany,
  createCostCenter,
  createDepartment,
  createHoliday,
  createLeavePolicy,
  createLeaveType,
  createPosition,
  deleteHoliday,
  deleteLeavePolicy,
  deleteCompany,
  deleteCostCenter,
  deleteDepartment,
  deleteLeaveType,
  deletePosition,
  revokeRole,
  setCompanyParent,
  setCompanyLeaveCycle,
  createJobGrade,
  archiveJobGrade,
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeavePolicy,
  updateLeaveType,
  updatePosition,
} from '@/core/admin';
import { openLeaveYear, accrueEarnedLeave, type LeaveDurationType } from '@/core/leave';
import { setAttendancePolicy } from '@/core/attendance';
import { setToilPolicy, runToilExpiry } from '@/core/toil';
import type { ToilAccrualBasis, ToilExpiryAction } from '@/db/schema';
import { upsertCompanyBankProfile, removeCompanyBankProfile, type DisbursementBank } from '@/core/bank-profile';
import { packFor } from '@/localization/registry';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';
const ATTENDANCE_POLICY = '/admin/attendance';
const TOIL_POLICY = '/admin/toil';

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
    });
  } catch (e) {
    fail(ORG, e);
  }
  ok(ORG);
}

export async function updateDepartmentAction(formData: FormData) {
  const s = await getSession();
  try {
    await updateDepartment(s, { id: String(formData.get('id')), name: String(formData.get('name') ?? '').trim() });
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

export async function createLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createLeavePolicy(s, {
      leaveTypeId: String(formData.get('leaveTypeId')),
      annualDays: Number(formData.get('annualDays')),
      carryForwardMax: Number(formData.get('carryForwardMax')) || 0,
      carryForwardExpiryMonth: carryExpiryField(formData.get('carryForwardExpiryMonth')),
      carryForwardExpiryDay: carryExpiryField(formData.get('carryForwardExpiryDay')),
      method: String(formData.get('method') || '') || undefined,
      gradeId: String(formData.get('gradeId') || '') || null,
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
      method: String(formData.get('method') || '') || undefined,
      gradeId: String(formData.get('gradeId') || '') || null,
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
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
  try {
    await createHoliday(s, {
      country: String(formData.get('country') ?? 'MY'),
      holidayDate: String(formData.get('holidayDate') ?? ''),
      name: String(formData.get('name') ?? ''),
      state: String(formData.get('state') ?? '') || null,
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
      role: String(formData.get('role')) as 'employee' | 'manager' | 'hr_admin' | 'super_admin',
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
  try {
    await updateLeaveType(s, {
      id: String(fd.get('id')),
      name: String(fd.get('name') ?? '').trim(),
      eligibility,
      durations,
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

// ADR-0033 33-5 — upsert one company's TOIL (leave-in-lieu) policy. Checkboxes ⇒ presence test.
export async function setToilPolicyAction(fd: FormData) {
  const s = await getSession();
  try {
    await setToilPolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      enabled: fd.get('enabled') === 'on',
      accrualBasis: String(fd.get('accrualBasis') ?? 'hours_worked') as ToilAccrualBasis,
      expiryDays: Number(fd.get('expiryDays') ?? 90),
      onExpiry: String(fd.get('onExpiry') ?? 'convert_to_pay') as ToilExpiryAction,
      allowFirstScheduleEligible: fd.get('allowFirstScheduleEligible') === 'on',
    });
  } catch (e) {
    fail(TOIL_POLICY, e);
  }
  ok(TOIL_POLICY);
}

// ADR-0032 C7 — upsert one company's attendance policy (the no-roster default schedule).
export async function setAttendancePolicyAction(fd: FormData) {
  const s = await getSession();
  try {
    await setAttendancePolicy(s, {
      companyId: String(fd.get('companyId') ?? ''),
      workStart: String(fd.get('workStart') ?? ''),
      workEnd: String(fd.get('workEnd') ?? ''),
      breakMinutes: Number(fd.get('breakMinutes') ?? 0),
      lateAfter: String(fd.get('lateAfter') ?? ''),
      halfDayBefore: String(fd.get('halfDayBefore') ?? ''),
      workingDays: fd.getAll('workingDays').map((d) => Number(d)),
    });
  } catch (e) {
    fail(ATTENDANCE_POLICY, e);
  }
  ok(ATTENDANCE_POLICY);
}
