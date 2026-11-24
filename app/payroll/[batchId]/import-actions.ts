'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { payItemIssueMessage } from '@/lib/pay-item-import-messages';
import { importBatchComponents, type ComponentImportResult } from '@/core/pay-components';

/** 8edeef41 — a refused taxable/non-cash row is explained from the shared pay-item import catalogue, so the
 *  CSV preview, the Pay Item workbook import and the Pay Item screen give the same reason in the reader's language. */
async function explained(result: ComponentImportResult): Promise<ComponentImportResult> {
  if (!result.rows.some(row => row.taxableReason)) return result;
  const [t, rule] = await Promise.all([getTranslations('payComponents'), getTranslations('payRule')]);
  return { ...result, rows: result.rows.map(row => row.taxableReason
    ? { ...row, error: `${row.error ?? ''} ${payItemIssueMessage(row.taxableReason, t, rule)}`.trim() }
    : row) };
}

/** Dry-run reconcile of a pay-component CSV against a draft batch. Writes nothing. */
export async function dryRunComponentImportAction(batchId: string, csvText: string): Promise<ComponentImportResult> {
  const s = await requireAdmin();
  return explained(await importBatchComponents(s, { batchId, csvText, dryRun: true }));
}

/** Commit the reconciled rows (re-reconciles server-side; the client preview is never trusted). */
export async function commitComponentImportAction(batchId: string, csvText: string): Promise<ComponentImportResult> {
  const s = await requireAdmin();
  const r = await importBatchComponents(s, { batchId, csvText, dryRun: false });
  revalidatePath(`/payroll/${batchId}`);
  return explained(r);
}
