'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/authz';
import { parseCsvRecords } from '@/lib/csv';
import { commitSectionImport, validateSectionImport } from '@/core/import-sections';
import {
  isImportSection,
  type SectionImportPreview,
  type SectionImportResult,
} from '@/lib/import-sections';

/**
 * Item 2983802f — the per-section importer's two server actions.
 *
 * They mirror the wide importer's exactly (`./actions.ts`): the browser sends CSV TEXT, never a file
 * and never a parsed preview, and the server re-validates everything. The one addition is `section`,
 * which arrives as a plain string from a client control and is therefore CHECKED here rather than
 * trusted — a section is the fence, and a fence that can be renamed by whoever is climbing it is not
 * one. An unrecognised value is refused outright instead of falling back to a default, because every
 * default would be somebody's data being written by the wrong rules.
 */
function assertSection(section: string) {
  if (!isImportSection(section)) throw new Error('Unknown import section.');
  return section;
}

/** Dry-run validation for one section file. Returns a per-row verdict; writes nothing. */
export async function validateSectionAction(section: string, csv: string): Promise<SectionImportPreview> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  return validateSectionImport(s, { section: assertSection(section), records });
}

/**
 * Apply one section file. Re-validates server-side, so a tampered client preview cannot widen what is
 * written. `fileName` is a LABEL for the history row (cf43c909) — the file itself never leaves the
 * browser; only the CSV text a paste would have produced is sent.
 */
export async function commitSectionAction(
  section: string,
  csv: string,
  fileName?: string,
): Promise<SectionImportResult> {
  const s = await requireAdmin();
  const { records } = parseCsvRecords(csv);
  const result = await commitSectionImport(s, {
    section: assertSection(section),
    records,
    fileName: fileName ?? '',
  });
  revalidatePath('/admin/personnel');
  revalidatePath('/admin/personnel/import');
  return result;
}
