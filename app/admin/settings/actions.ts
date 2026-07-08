'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import {
  archiveBusinessUnit,
  archiveCostCenter,
  archiveDepartment,
  archivePosition,
  bulkSaveLabels,
  createBusinessUnit,
  createCostCenter,
  createDepartment,
  createPosition,
  deleteCostCenter,
  deleteDepartment,
  deletePosition,
  LabelBulkError,
  setCompanySharedLabels,
  updateBusinessUnit,
  updateCostCenter,
  updateDepartment,
  updatePosition,
  type LabelCreateInput,
  type LabelKindStr,
  type LabelRowError,
  type LabelUpdateInput,
} from '@/core/admin';
import {
  assignLabelToCompanies,
  LabelInUseError,
  setLabelGlobal,
  unassignLabelFromCompanies,
} from '@/core/system-labels';

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

// ── System Labels grid (62de487d): return-value actions (NOT redirects) — the client grid needs the
// structured result (per-row validation errors) to highlight cells, so these are invoked directly from
// the 'use client' component and return a plain object. On success they revalidate the affected routes.
function revalidateLabels() {
  revalidatePath(SYSTEM_LABELS);
  for (const p of REVALIDATE_ALSO) revalidatePath(p);
}

export type GridSaveResult =
  | { ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] }
  | { ok: false; rowErrors: LabelRowError[]; message?: string };

/** Atomic Save for one category grid: all creates + updates in a single transaction. */
export async function saveLabelsGridAction(
  kind: LabelKindStr,
  payload: { creates: LabelCreateInput[]; updates: LabelUpdateInput[] },
): Promise<GridSaveResult> {
  const s = await getSession();
  try {
    const r = await bulkSaveLabels(s, kind, payload);
    revalidateLabels();
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof LabelBulkError) return { ok: false, rowErrors: e.rowErrors };
    return { ok: false, rowErrors: [], message: (e as Error).message };
  }
}

export type ScopeActionResult = { ok: true } | { ok: false; message: string };

/** Assign a label to companies (company-specific scope). */
export async function assignLabelCompaniesAction(
  kind: LabelKindStr,
  labelId: string,
  companyIds: string[],
): Promise<ScopeActionResult> {
  const s = await getSession();
  try {
    await assignLabelToCompanies(s, { kind, labelId, companyIds });
    revalidateLabels();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Remove a label from companies. Refuses (LabelInUseError) if a removed company still uses it. */
export async function unassignLabelCompaniesAction(
  kind: LabelKindStr,
  labelId: string,
  companyIds: string[],
): Promise<ScopeActionResult> {
  const s = await getSession();
  try {
    await unassignLabelFromCompanies(s, { kind, labelId, companyIds });
    revalidateLabels();
    return { ok: true };
  } catch (e) {
    if (e instanceof LabelInUseError) return { ok: false, message: e.message };
    return { ok: false, message: (e as Error).message };
  }
}

/** Set/clear a label's Global ("All Companies") scope. Group-admin-only (DB trigger backstops). */
export async function setLabelGlobalAction(
  kind: LabelKindStr,
  labelId: string,
  isGlobal: boolean,
): Promise<ScopeActionResult> {
  const s = await getSession();
  try {
    await setLabelGlobal(s, { kind, labelId, isGlobal });
    revalidateLabels();
    return { ok: true };
  } catch (e) {
    if (e instanceof LabelInUseError) return { ok: false, message: e.message };
    return { ok: false, message: (e as Error).message };
  }
}

/** Toolbar bulk action: assign the selected labels to the selected companies in one go. */
export async function copyLabelsToCompaniesAction(
  kind: LabelKindStr,
  labelIds: string[],
  companyIds: string[],
): Promise<ScopeActionResult> {
  const s = await getSession();
  try {
    for (const labelId of labelIds) {
      await assignLabelToCompanies(s, { kind, labelId, companyIds });
    }
    revalidateLabels();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Turn a company's Shared System Labels feature on/off (the resolver switch). */
export async function setCompanySharedLabelsAction(
  companyId: string,
  enabled: boolean,
): Promise<ScopeActionResult> {
  const s = await getSession();
  try {
    await setCompanySharedLabels(s, { companyId, enabled });
    revalidateLabels();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
