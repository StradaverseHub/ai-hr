'use server';

/**
 * r424 (50ed39e1) · Attendance › File Structure Mapping — save, duplicate, (de)activate, delete.
 *
 * NOTHING IS DECIDED HERE. core/attendance-clocking-import.ts owns every rule: the six required fields,
 * unique names, delete-only-if-never-used. `requireAdmin` is this surface's own guard, not the authority —
 * a server action is one POST away from being called directly, and the service runs under RLS that admits
 * administrators only.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import {
  ClockingMappingError,
  createClockingMapping,
  deleteClockingMapping,
  duplicateClockingMapping,
  setClockingMappingActive,
  updateClockingMapping,
  type ClockingMappingInput,
} from '@/packs/attendance/service';
import type { ClockingField, MappingProblem } from '@/lib/clocking-file';

const LIST = '/admin/attendance/file-mappings';
const str = (v: FormDataEntryValue | null) => String(v ?? '').trim();

export type SaveMappingResult =
  | { ok: true; id: string }
  | { ok: false; code: ClockingMappingError['code'] | 'unknown'; missing: ClockingField[]; problems: MappingProblem[] };

/** Called by the form with its whole state; returns the refusal as data so the form can show it in place. */
export async function saveClockingMappingAction(
  mappingId: string | null,
  input: ClockingMappingInput,
): Promise<SaveMappingResult> {
  const s = await requireAdmin();
  try {
    const id = mappingId ? (await updateClockingMapping(s, mappingId, input), mappingId) : await createClockingMapping(s, input);
    revalidatePath(LIST);
    return { ok: true, id };
  } catch (e) {
    if (e instanceof ClockingMappingError) return { ok: false, code: e.code, missing: e.missing, problems: e.problems };
    return { ok: false, code: 'unknown', missing: [], problems: [] };
  }
}

async function refusal(e: unknown): Promise<string> {
  const t = await getTranslations('clockingFile.form');
  if (e instanceof ClockingMappingError && (e.code === 'inUse' || e.code === 'notFound' || e.code === 'nameTaken')) return t(e.code);
  throw e;
}

export async function duplicateClockingMappingAction(formData: FormData) {
  const s = await requireAdmin();
  const id = str(formData.get('mappingId'));
  const t = await getTranslations('clockingFile.list');
  let err: string | null = null;
  try {
    await duplicateClockingMapping(s, id, t('copyWord'));
  } catch (e) {
    err = await refusal(e);
  }
  revalidatePath(LIST);
  redirect(err ? `${LIST}?error=${encodeURIComponent(err)}` : LIST);
}

export async function setClockingMappingActiveAction(formData: FormData) {
  const s = await requireAdmin();
  const id = str(formData.get('mappingId'));
  const active = str(formData.get('active')) === 'true';
  let err: string | null = null;
  try {
    await setClockingMappingActive(s, id, active);
  } catch (e) {
    err = await refusal(e);
  }
  revalidatePath(LIST);
  redirect(err ? `${LIST}?error=${encodeURIComponent(err)}` : LIST);
}

export async function deleteClockingMappingAction(formData: FormData) {
  const s = await requireAdmin();
  const id = str(formData.get('mappingId'));
  let err: string | null = null;
  try {
    await deleteClockingMapping(s, id);
  } catch (e) {
    err = await refusal(e);
  }
  revalidatePath(LIST);
  redirect(err ? `${LIST}?error=${encodeURIComponent(err)}` : LIST);
}
