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
  updateCompany,
  updateCostCenter,
  updateDepartment,
  updateLeavePolicy,
  updateLeaveType,
  updatePosition,
} from '@/core/admin';
import { openLeaveYear } from '@/core/leave';
import { upsertCompanyBankProfile, removeCompanyBankProfile, type DisbursementBank } from '@/core/bank-profile';
import { packFor } from '@/localization/registry';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
const USERS = '/admin/users';
const HOLIDAYS = '/admin/holidays';

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

export async function createLeavePolicyAction(formData: FormData) {
  const s = await getSession();
  try {
    await createLeavePolicy(s, {
      leaveTypeId: String(formData.get('leaveTypeId')),
      annualDays: Number(formData.get('annualDays')),
      carryForwardMax: Number(formData.get('carryForwardMax')) || 0,
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
      validFrom: String(formData.get('validFrom')),
    });
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
  try { await updateLeaveType(s, { id: String(fd.get('id')), name: String(fd.get('name') ?? '').trim() }); } catch (e) { fail(LEAVE, e); }
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
