'use server';

/**
 * r424 (50ed39e1) — Import Clocking Data. Validate writes nothing; Import re-runs every check on the
 * server (the browser's preview is never trusted) and saves the valid lines. The rules all live in
 * core/attendance-clocking-import.ts; `requireAdmin` is this surface's guard, and RLS is the authority.
 * Draft 5045: Import admits a background job (core/attendance-clocking-import-job.ts) and returns at once; the
 * import worker decides and adds every line, employee by employee, and the screen follows its progress.
 */
import { requireAdmin } from '@/lib/authz';
import {
  ClockingImportError,
  ClockingImportJobRefused,
  startClockingImportJob,
  validateClockingImport,
  type ClockingImportJobProgress,
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
  operationKey?: string,
): Promise<{ ok: true; job: ClockingImportJobProgress; existing: boolean } | { ok: false; error: ClockingImportError['code'] | string }> {
  const s = await requireAdmin();
  try {
    return { ok: true, ...(await startClockingImportJob(s, { mappingId, text, fileName, fileBytes, operationKey })) };
  } catch (e) {
    if (e instanceof ClockingImportError || e instanceof ClockingImportJobRefused) return { ok: false, error: e.code };
    throw e;
  }
}
