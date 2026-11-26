'use server';

import { scopedAdmin } from '@/lib/scope';
import { BULK_JOB_ALREADY_RUNNING, BULK_JOB_BEING_INSTALLED, BulkJobError } from '@/core/bulk-job';
import { confirmTp3Import, queueTp3ImportCheck, readTp3Import, type Tp3ImportDetail } from '@/core/tp3-import-job';

/**
 * 5084d02e — the Form TP3 Excel import's three actions. Each is guarded like the screen (`scopedAdmin`) and passes
 * the caller's company scope to the import owner (core/tp3-import-job.ts), which checks it again
 * (`app.is_admin_for`) inside the same transaction as the job it admits or reads.
 *
 * A refusal comes back as a stable code the dialog translates (`payroll.tp3Import.error.*`), never a raw message.
 */
type Refusal = { ok: false; error: string };
const CODES = new Set(['fileTooLarge', 'invalidFormat', 'operationChanged', 'importAccessDenied', 'checkUnavailable', 'checkChanged', 'noReadyRows']);
function refusal(error: unknown): Refusal {
  if (!(error instanceof BulkJobError)) throw error;
  if (error.message === BULK_JOB_ALREADY_RUNNING) return { ok: false, error: 'alreadyRunning' };
  if (error.message === BULK_JOB_BEING_INSTALLED) return { ok: false, error: 'beingInstalled' };
  if (CODES.has(error.message)) return { ok: false, error: error.message };
  return { ok: false, error: 'unavailable' };
}

/** Upload: queue the CHECK of the file (the first sheet as CSV, converted in the browser). */
export async function checkTp3ImportAction(input: { csv: string; fileName: string; operationKey: string }): Promise<{ ok: true; id: string } | Refusal> {
  const { s, scopeIds } = await scopedAdmin();
  try {
    return { ok: true, id: await queueTp3ImportCheck(s, { ...input, companyIds: scopeIds }) };
  } catch (error) {
    return refusal(error);
  }
}

/** The dialog follows a check (or a save) it started: its state, counts and row outcomes. */
export async function readTp3ImportAction(id: string): Promise<{ ok: true; job: Tp3ImportDetail } | Refusal> {
  const { s, scopeIds } = await scopedAdmin();
  try {
    return { ok: true, job: await readTp3Import(s, id, scopeIds) };
  } catch (error) {
    return refusal(error);
  }
}

/** Confirm: save the ready rows of a completed check. The browser sends the same file again. */
export async function confirmTp3ImportAction(input: { checkJobId: string; csv: string; fileName: string }): Promise<{ ok: true; id: string } | Refusal> {
  const { s, scopeIds } = await scopedAdmin();
  try {
    return { ok: true, id: await confirmTp3Import(s, { ...input, companyIds: scopeIds }) };
  } catch (error) {
    return refusal(error);
  }
}
