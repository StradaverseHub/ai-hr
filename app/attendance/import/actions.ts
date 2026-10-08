'use server';

/**
 * r424 (50ed39e1) — Import Clocking Data. Validate writes nothing; Import re-runs every check on the
 * server (the browser's preview is never trusted) and saves the valid lines. The rules all live in
 * core/attendance-clocking-import.ts; `requireAdmin` is this surface's guard, and RLS is the authority.
 */
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import {
  ClockingImportError,
  commitClockingImport,
  validateClockingImport,
  type ClockingImportOutcome,
  type ClockingImportPreview,
} from '@/packs/attendance/service';

type Refusal = { ok: false; error: ClockingImportError['code'] };

export async function validateClockingImportAction(
  mappingId: string,
  text: string,
): Promise<{ ok: true; preview: ClockingImportPreview } | Refusal> {
  const s = await requireAdmin();
  try {
    return { ok: true, preview: await validateClockingImport(s, { mappingId, text }) };
  } catch (e) {
    if (e instanceof ClockingImportError) return { ok: false, error: e.code };
    throw e;
  }
}

export async function commitClockingImportAction(
  mappingId: string,
  text: string,
  fileName: string,
  fileBytes: number,
): Promise<{ ok: true; outcome: ClockingImportOutcome } | Refusal> {
  const s = await requireAdmin();
  try {
    const outcome = await commitClockingImport(s, { mappingId, text, fileName, fileBytes });
    revalidatePath('/attendance');
    revalidatePath('/attendance/import/logs');
    return { ok: true, outcome };
  } catch (e) {
    if (e instanceof ClockingImportError) return { ok: false, error: e.code };
    throw e;
  }
}
