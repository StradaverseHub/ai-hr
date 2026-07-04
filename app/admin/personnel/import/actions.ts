'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import {
  validateEmployeeImport,
  commitEmployeeImport,
  type ImportPreview,
  type ImportResult,
} from '@/core/import';

/** Dry-run validation. Returns a per-row preview; writes nothing. */
export async function validateImportAction(csv: string, companyId: string): Promise<ImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateEmployeeImport(s, { companyId, records });
}

/** Commit the valid rows. Re-validates server-side, so a tampered client preview can't widen
 *  what gets written. */
export async function commitImportAction(csv: string, companyId: string): Promise<ImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitEmployeeImport(s, { companyId, records });
  revalidatePath('/admin/personnel');
  return result;
}
