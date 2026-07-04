'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveBusinessUnit,
  archiveCostCenter,
  archiveDepartment,
  archivePosition,
  createBusinessUnit,
  createCostCenter,
  createDepartment,
  createPosition,
  deleteCostCenter,
  deleteDepartment,
  deletePosition,
  updateBusinessUnit,
  updateCostCenter,
  updateDepartment,
  updatePosition,
} from '@/core/admin';

// Route-scoped actions for the System Labels admin page. These wrap the SAME core catalog functions the
// Organization page used to call, but every ok()/fail() targets SYSTEM_LABELS — NOT '/admin/organization'
// — so a save/edit/archive/delete keeps the admin on the System Labels page (redirect-target guard, per plan).
const SYSTEM_LABELS = '/admin/settings/system-labels';
// The three catalog tables also back dropdowns on these routes, so revalidate them on every write.
// (People → Personnel rename: the employee directory + import now live under /admin/personnel.)
const REVALIDATE_ALSO = ['/admin/organization', '/admin/personnel', '/admin/personnel/import'];

function fail(path: string, e: unknown): never {
  redirect(`${path}?error=${encodeURIComponent((e as Error).message)}`);
}
function ok(path: string): never {
  revalidatePath(path);
  for (const p of REVALIDATE_ALSO) revalidatePath(p);
  redirect(path);
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();
const archived = (fd: FormData) => fd.get('archived') === 'true';

// ── Departments ──────────────────────────────────────────────────────
export async function createDepartmentAction(fd: FormData) {
  const s = await getSession();
  try {
    await createDepartment(s, {
      companyId: str(fd, 'companyId'),
      name: str(fd, 'name'),
      // Empty string = "— None —" → unassigned (the service treats blank as null).
      businessUnitId: str(fd, 'businessUnitId') || null,
      description: str(fd, 'description') || undefined,
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updateDepartmentAction(fd: FormData) {
  const s = await getSession();
  // businessUnitId is present on the edit row (a select). Empty string clears the link; a value sets it.
  // If the field is absent entirely (undefined), leave the BU untouched (tri-state in the service).
  const buRaw = fd.get('businessUnitId');
  try {
    await updateDepartment(s, {
      id: str(fd, 'id'),
      name: str(fd, 'name'),
      businessUnitId: buRaw === null ? undefined : String(buRaw).trim() || null,
      description: str(fd, 'description'),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function archiveDepartmentAction(fd: FormData) {
  const s = await getSession();
  try {
    await archiveDepartment(s, { id: str(fd, 'id'), archived: archived(fd) });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function deleteDepartmentAction(fd: FormData) {
  const s = await getSession();
  try {
    await deleteDepartment(s, { id: str(fd, 'id') });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

// ── Positions ────────────────────────────────────────────────────────
export async function createPositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await createPosition(s, {
      companyId: str(fd, 'companyId'),
      title: str(fd, 'title'),
      jobFamily: str(fd, 'jobFamily') || undefined,
      description: str(fd, 'description') || undefined,
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updatePositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await updatePosition(s, {
      id: str(fd, 'id'),
      title: str(fd, 'title'),
      jobFamily: str(fd, 'jobFamily') || undefined,
      description: str(fd, 'description'),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function archivePositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await archivePosition(s, { id: str(fd, 'id'), archived: archived(fd) });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function deletePositionAction(fd: FormData) {
  const s = await getSession();
  try {
    await deletePosition(s, { id: str(fd, 'id') });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

// ── Cost centers ─────────────────────────────────────────────────────
export async function createCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await createCostCenter(s, {
      companyId: str(fd, 'companyId'),
      code: str(fd, 'code'),
      name: str(fd, 'name'),
      description: str(fd, 'description') || undefined,
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updateCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await updateCostCenter(s, {
      id: str(fd, 'id'),
      code: str(fd, 'code'),
      name: str(fd, 'name'),
      description: str(fd, 'description'),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function archiveCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await archiveCostCenter(s, { id: str(fd, 'id'), archived: archived(fd) });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function deleteCostCenterAction(fd: FormData) {
  const s = await getSession();
  try {
    await deleteCostCenter(s, { id: str(fd, 'id') });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

// ── Business units ───────────────────────────────────────────────────
export async function createBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try {
    await createBusinessUnit(s, {
      companyId: str(fd, 'companyId'),
      code: str(fd, 'code'),
      name: str(fd, 'name'),
      description: str(fd, 'description') || undefined,
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function updateBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try {
    await updateBusinessUnit(s, {
      id: str(fd, 'id'),
      code: str(fd, 'code'),
      name: str(fd, 'name'),
      description: str(fd, 'description'),
    });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}

export async function archiveBusinessUnitAction(fd: FormData) {
  const s = await getSession();
  try {
    await archiveBusinessUnit(s, { id: str(fd, 'id'), archived: archived(fd) });
  } catch (e) {
    fail(SYSTEM_LABELS, e);
  }
  ok(SYSTEM_LABELS);
}
