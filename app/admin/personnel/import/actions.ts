'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parsePersonnelImportCsv } from '@/lib/personnel-import-contract';
import { personnelImportLabelResolvers } from '@/lib/personnel-import-labels.server';
import { IMPORT_COLUMNS, DEPENDENT_IMPORT_COLUMNS } from '@/lib/import-schema';
const parseEmployee=(text:string)=>parsePersonnelImportCsv(text,{columns:[...IMPORT_COLUMNS.required,...IMPORT_COLUMNS.optional],resolvers:personnelImportLabelResolvers});
const parseFamily=(text:string)=>parsePersonnelImportCsv(text,{columns:[...DEPENDENT_IMPORT_COLUMNS.required,...DEPENDENT_IMPORT_COLUMNS.optional],sheet:'family',resolvers:personnelImportLabelResolvers});
import {
  validateEmployeeImport,
  commitEmployeeImport,
  type ImportPreview,
  type ImportResult,
} from '@/core/import';

/** Item 2983802f — the Family sheet arrives as its own CSV text, decoded in the browser from the SAME
 *  workbook, and is parsed here by the SAME parser. Empty string (a CSV upload, a paste, or a workbook
 *  with no Family sheet) means no family rows, which is every file that imports today. */
function familyRecords(dependentsCsv?: string) {
  const text = (dependentsCsv ?? '').trim();
  return text === '' ? [] : parseFamily(text).records;
}

/** Dry-run validation. Returns a per-row preview; writes nothing. */
export async function validateImportAction(
  csv: string,
  companyId: string,
  dependentsCsv?: string,
): Promise<ImportPreview> {
  const s = await requireAdmin();
  const { records, warnings } = parseEmployee(csv);
  const preview=await validateEmployeeImport(s, { companyId, records, dependentRecords: familyRecords(dependentsCsv) });
  for(const row of preview.rows) row.warnings.push(...warnings);
  const familyWarnings=(dependentsCsv??'').trim()?parseFamily(dependentsCsv!).warnings:[];
  for(const row of preview.rows) row.warnings.push(...familyWarnings.map(warning=>`Family: ${warning}`));
  return preview;
}

/** Commit the valid rows. Re-validates server-side, so a tampered client preview can't widen
 *  what gets written. `fileName` is a LABEL for the history row (cf43c909) — the file's contents
 *  always arrive as the same CSV text a paste would produce, so there is still exactly one write path,
 *  and the file itself is never uploaded or stored. */
export async function commitImportAction(
  csv: string,
  companyId: string,
  fileName?: string,
  dependentsCsv?: string,
): Promise<ImportResult> {
  const s = await requireAdmin();
  const { records } = parseEmployee(csv);
  const result = await commitEmployeeImport(s, {
    companyId,
    records,
    dependentRecords: familyRecords(dependentsCsv),
    fileName: fileName ?? '',
  });
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/import');
  return result;
}
