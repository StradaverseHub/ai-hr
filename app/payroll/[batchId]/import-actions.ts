'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { importBatchComponents, type ComponentImportResult } from '@/core/pay-components';

/** Dry-run reconcile of a pay-component CSV against a draft batch. Writes nothing. */
export async function dryRunComponentImportAction(batchId: string, csvText: string): Promise<ComponentImportResult> {
  const s = await requireAdmin();
  return importBatchComponents(s, { batchId, csvText, dryRun: true });
}

/** Commit the reconciled rows (re-reconciles server-side; the client preview is never trusted). */
export async function commitComponentImportAction(batchId: string, csvText: string): Promise<ComponentImportResult> {
  const s = await requireAdmin();
  const r = await importBatchComponents(s, { batchId, csvText, dryRun: false });
  revalidatePath(`/payroll/${batchId}`);
  return r;
}
