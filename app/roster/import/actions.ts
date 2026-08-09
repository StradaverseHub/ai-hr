'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { analyzeRosterImport, type RosterImportResult } from '@/core/roster-import';

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

/** Commit. RE-ANALYZES server-side — the client preview is a display, never an input to the write —
 *  then writes the accepted cells and files ONE `roster.bulk.uploaded` audit entry for the upload. */
export async function commitRosterImportAction(input: {
  csvText: string;
  month: string;
  companyId: string;
  fileName?: string;
}): Promise<RosterImportResult> {
  const s = await requireAdmin();
  const result = await analyzeRosterImport(s, { ...input, dryRun: false });
  revalidatePath('/roster');
  return result;
}
