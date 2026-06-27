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

/** Dry-run validation. Returns a per-row preview; writes nothing. */
export async function validateHistoryImportAction(csv: string, companyId: string): Promise<HistoryImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validatePayrollHistoryImport(s, { companyId, records });
}

/** Commit the valid rows. Re-validates server-side, so a tampered client preview can't widen
 *  what gets written. */
export async function commitHistoryImportAction(csv: string, companyId: string): Promise<HistoryImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitPayrollHistoryImport(s, { companyId, records });
  revalidatePath('/payroll');
  return result;
}
