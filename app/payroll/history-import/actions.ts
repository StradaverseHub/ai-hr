'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validatePayrollHistoryImport,
  commitPayrollHistoryImport,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '@/core/payroll-history-import';

/**
 * Dry-run validation. Returns the per-line issue list + the folded employee-months; writes nothing.
 *
 * The client parses an uploaded .xlsx into CSV TEXT in the browser (lib/spreadsheet.ts) and sends that,
 * so the server never parses a workbook and there is one ingest path for pasted text, an uploaded .csv
 * and an uploaded .xlsx alike.
 */
export async function validateHistoryImportAction(csv: string, companyId: string): Promise<HistoryImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validatePayrollHistoryImport(s, { companyId, records });
}

/** Commit. Re-validates server-side, so a tampered client preview can't widen what gets written. */
export async function commitHistoryImportAction(csv: string, companyId: string): Promise<HistoryImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitPayrollHistoryImport(s, { companyId, records });
  revalidatePath('/payroll');
  return result;
}
