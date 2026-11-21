'use server';

import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { analyzeRosterImport, type RosterImportResult } from '@/core/roster-import';
import { enqueueRosterImportJob, RosterBulkJobError } from '@/core/roster-bulk-job';
import { ROSTER_BULK_ALREADY_RUNNING, rosterReadableError, type RosterBulkJobView } from '@/lib/roster-bulk-job';

/** Dry run: read the month grid, check every cell, return the preview. Writes nothing. */
export async function dryRunRosterImportAction(input: {
  csvText: string;
  month: string;
  companyId: string;
  fileName?: string;
}): Promise<RosterImportResult> {
  const s = await requireAdmin();
  return analyzeRosterImport(s, { ...input, dryRun: true });
}

/** Commit. Queues the upload as a background roster job: the worker RE-ANALYZES the same file server-side — the
 *  client preview is a display, never an input to the write — then writes the accepted cells in short
 *  transactions and files ONE `roster.bulk.uploaded` audit entry for the upload. The screen shows the job's
 *  progress and then the same result panel (core/roster-bulk-worker.ts). */
export async function commitRosterImportAction(input: {
  csvText: string;
  month: string;
  companyId: string;
  fileName?: string;
  operationKey?: string;
}): Promise<{ ok: true; job: RosterBulkJobView } | { ok: false; error: string }> {
  const s = await requireAdmin();
  try {
    return { ok: true, job: await enqueueRosterImportJob(s, input) };
  } catch (e) {
    if (e instanceof RosterBulkJobError && e.message === ROSTER_BULK_ALREADY_RUNNING) return { ok: false, error: (await getTranslations('bulkJobs.roster'))('otherRunning') };
    return { ok: false, error: rosterReadableError(e) };
  }
}
