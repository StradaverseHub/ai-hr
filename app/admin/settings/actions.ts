'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { requireAdmin } from '@/lib/authz';
import {
  ArchivedGradeCodeError,
  archiveBusinessUnit,
  archiveCostCenter,
  archiveDepartment,
  archiveJobGrade,
  archivePosition,
  bulkSaveLabels,
  createJobGrade,
  deleteJobGrade,
  updateJobGrade,
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
// r224 — the restore action reads the grade back through the SAME projection the page renders from, so
// the row it hands the grid (inUse included) cannot disagree with the one a reload would produce.
import { listJobGrades } from '@/core/read';

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

// ── Grades (b1b81a08) ────────────────────────────────────────────────────────────────────────────────
// Grade master data moved OUT of Leave Config into the System Labels Organisation-Labels rail. job_grade is
// TENANT-GLOBAL (no company_id, no is_global, no label_company_assignment row), so it is NOT a fifth
// LabelKindStr and these do NOT go through bulkSaveLabels.
//
// Deliberately a FAN-OUT over the existing per-row core mutations — the saveProfileOptionsAction pattern —
// rather than a new bulk service. db/client.ts withTenant opens ONE transaction with no savepoints, so
// bulkSaveLabels' catch-and-continue keeps issuing statements in an already-aborted transaction and the
// next one raises 25P02 (which is neither a unique nor a privilege violation, so it escapes as a raw
// Postgres string with nothing highlighted and nothing saved). Giving each row its own withTenant
// transaction removes that failure class entirely: good rows commit, bad rows come back as row errors.
//
// Both entry points call requireAdmin, NOT a bare getSession. Migration 0090's job_grade policy is
// `FOR ALL USING (tenant_id = current_tenant) WITH CHECK (tenant_id = current_tenant AND app.is_admin())`,
// and WITH CHECK does not apply to DELETE — so DELETE on job_grade is gated by tenant membership alone.
// Server actions are addressable, so these get their own explicit gate. (Tightening the policy itself is a
// separate security item; it is NOT bundled here, which keeps this change migration-free.)
/**
 * r224 — `restoreArchivedId` is the one addition to the row-error shape. It is set ONLY when the create
 * was refused because the typed code belongs to an archived grade, and it names that grade so the grid can
 * render "restore it instead" as a button rather than as advice. Every other row error leaves it undefined,
 * so the grid's existing handling is unchanged.
 */
export type GradeGridRowError = { key: string; field?: string; message: string; restoreArchivedId?: string };

export type GradeGridSaveResult =
  | { ok: true; created: number; updated: number; createdIds: { key: string; id: string }[] }
  | { ok: false; rowErrors: GradeGridRowError[]; message?: string };

/** The grade row the grid re-renders after a restore — exactly core/read.ts `listJobGrades`' shape. */
export type GradeGridRestoreResult =
  | {
      ok: true;
      row: {
        id: string;
        code: string;
        name: string;
        description: string | null;
        rank: number;
        archivedAt: Date | null;
        inUse: boolean;
      };
    }
  | { ok: false; message: string };

export type GradeGridCreate = { key: string; code: string; name: string; description: string; rank: string };
export type GradeGridUpdate = {
  key: string;
  id: string;
  code: string;
  name: string;
  description: string;
  rank: string;
  setArchived: boolean | null;
};

/**
 * Parse a grid rank cell into a real int4. createJobGrade/updateJobGrade both gate on
 * `Number.isFinite(p.rank)` and `Number.isFinite('3')` is FALSE, so passing the raw string through would
 * silently persist every rank as 0. Anything non-integer or outside int4 is a row error on the rank field
 * (guards both `'ten'` quietly becoming 0 and 9999999999 raising 22003 as a raw banner).
 */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
function parseRank(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < INT4_MIN || n > INT4_MAX) return null;
  return n;
}

/** Batched Save for the Grades grid: one transaction PER ROW, so a bad row never poisons the good ones. */
export async function saveJobGradesGridAction(payload: {
  creates: GradeGridCreate[];
  updates: GradeGridUpdate[];
}): Promise<GradeGridSaveResult> {
  const s = await requireAdmin();
  const rowErrors: GradeGridRowError[] = [];
  const createdIds: { key: string; id: string }[] = [];
  let created = 0;
  let updated = 0;

  for (const c of payload.creates) {
    const rank = parseRank(c.rank);
    if (rank === null) {
      rowErrors.push({ key: c.key, field: 'rank', message: RANK_ERROR });
      continue;
    }
    try {
      // Each of these is its own withTenant transaction. Every throw class becomes a row error on the
      // right field: DuplicateError (code or name), the /^[A-Z][A-Z0-9_]{0,31}$/ format Error (typing
      // "G-1" or "Band 1a" is the single most likely HR input), and cleanName's blank/oversize Error.
      const { id } = await createJobGrade(s, { code: c.code, name: c.name, rank, description: c.description });
      createdIds.push({ key: c.key, id });
      created += 1;
    } catch (e) {
      // r224 — the archived-code refusal is matched by CLASS, before fieldOfGradeError's message regexes
      // get a look at it. Its message names the archived grade, and fieldOfGradeError's "message contains
      // the row's name ⇒ blame the name cell" arm would mis-highlight whenever the draft happens to be
      // named after the grade it collides with. It is a code clash; it highlights the code cell.
      if (e instanceof ArchivedGradeCodeError) {
        rowErrors.push({ key: c.key, field: 'code', message: e.message, restoreArchivedId: e.archivedId });
        continue;
      }
      rowErrors.push({ key: c.key, field: fieldOfGradeError(e, c.name), message: (e as Error).message });
    }
  }

  for (const u of payload.updates) {
    const rank = parseRank(u.rank);
    if (rank === null) {
      rowErrors.push({ key: u.key, field: 'rank', message: RANK_ERROR });
      continue;
    }
    try {
      await updateJobGrade(s, { id: u.id, code: u.code, name: u.name, rank, description: u.description });
      // Archive lives on its own core mutation (its own archived/unarchived event); only fire it when the
      // row's archived state actually CHANGED, so a plain rename never emits a spurious status event.
      if (u.setArchived !== null) {
        await archiveJobGrade(s, { id: u.id, archived: u.setArchived });
      }
      updated += 1;
    } catch (e) {
      rowErrors.push({ key: u.key, field: fieldOfGradeError(e, u.name), message: (e as Error).message });
    }
  }

  if (rowErrors.length > 0) return { ok: false, rowErrors };
  revalidateGrades();
  return { ok: true, created, updated, createdIds };
}

/**
 * r224 — RESTORE INSTEAD OF DUPLICATE, the second half.
 *
 * `createJobGrade` refuses a code that belongs to an archived grade and hands back that grade's id; this is
 * what the grid calls when the operator takes the offer. It is `archiveJobGrade(archived:false)` — the same
 * toggle the grid's own Restore icon batches into Save — so the grade comes back IN PLACE: same id, same
 * history, same employment / eligibility-rule / grade-group references, which is exactly what creating a
 * second row would have thrown away.
 *
 * It returns the restored ROW, not just ok, because the draft the operator typed has to become that grade
 * on screen. Read back through `listJobGrades` rather than assembled here so `inUse` and the projection
 * cannot drift from what a page reload would show.
 *
 * requireAdmin, like its two siblings: 0090's job_grade policy gates writes on `app.is_admin()`, but a
 * server action is addressable and gets its own explicit gate rather than trusting RLS alone.
 */
export async function restoreJobGradeGridAction(id: string): Promise<GradeGridRestoreResult> {
  const s = await requireAdmin();
  try {
    await archiveJobGrade(s, { id, archived: false });
    const row = (await listJobGrades(s, { includeArchived: true })).find((r) => r.id === id);
    // No row ⇒ the id did not resolve in this tenant (archiveJobGrade updates zero rows rather than
    // throwing, so this is the only place that can notice).
    if (!row) return { ok: false, message: 'That grade no longer exists.' };
    revalidateGrades();
    return { ok: true, row };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Delete one grade from the grid's row action. Blocked server-side when the grade is referenced. */
export async function removeJobGradeGridAction(id: string): Promise<ScopeActionResult> {
  const s = await requireAdmin();
  try {
    await deleteJobGrade(s, { id });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  revalidateGrades();
  return { ok: true };
}

const RANK_ERROR = 'Rank must be a whole number.';

// Grades feed the Leave Config scope pickers, the benefit-scheme grade groups and the Personnel grade
// selector, so a grade write revalidates those routes alongside System Labels.
const GRADE_REVALIDATE_ALSO = ['/admin/leave/entitlements', '/admin/personnel'];
function revalidateGrades() {
  revalidatePath(SYSTEM_LABELS);
  for (const p of GRADE_REVALIDATE_ALSO) revalidatePath(p);
}

/**
 * Which grid cell to highlight for a grade write failure. The core throws plain Errors / DuplicateErrors
 * carrying the offending value in the message, so match on that: a name clash names the row's name, a code
 * clash / format rejection is the code cell. Anything unrecognised highlights the whole row (no field).
 */
function fieldOfGradeError(e: unknown, name: string): string | undefined {
  const msg = (e as Error).message ?? '';
  if (/Grade name/i.test(msg)) return 'name';
  if (/Grade code/i.test(msg)) return 'code';
  if (name && msg.includes(`“${name}”`)) return 'name';
  if (/grade with code/i.test(msg)) return 'code';
  if (/grade named/i.test(msg)) return 'name';
  return undefined;
}
