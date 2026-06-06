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
  createLeavePolicy,
  createLeaveType,
  createPosition,
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
  updateLeaveType,
  updatePosition,
} from '@/core/admin';
import { packFor } from '@/localization/registry';

const ORG = '/admin/organization';
const LEAVE = '/admin/leave';
const USERS = '/admin/users';

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
    await pack.companyStatutory.set(s, {
      companyId: String(formData.get('companyId')),
      epfEmployerNo: (formData.get('epfEmployerNo') as string) || undefined,
      socsoEmployerCode: (formData.get('socsoEmployerCode') as string) || undefined,
      lhdnEmployerNo: (formData.get('lhdnEmployerNo') as string) || undefined,
      myinvoisTin: (formData.get('myinvoisTin') as string) || undefined,
      ssmRegistrationNo: (formData.get('ssmRegistrationNo') as string) || undefined,
    });
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
      validFrom: String(formData.get('validFrom')),
    });
  } catch (e) {
    fail(LEAVE, e);
  }
  ok(LEAVE);
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
