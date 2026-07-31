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
 *  what gets written. `fileName` is a LABEL for the history row (cf43c909) — the file's contents
 *  always arrive as the same CSV text a paste would produce, so there is still exactly one write path,
 *  and the file itself is never uploaded or stored. */
export async function commitImportAction(
  csv: string,
  companyId: string,
  fileName?: string,
): Promise<ImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitEmployeeImport(s, { companyId, records, fileName: fileName ?? '' });
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/import');
  return result;
}
