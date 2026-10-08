/**
 * r424 (50ed39e1) — the shape the retired `importAttendancePunches` gave its callers, over its replacement.
 *
 * Several suites (card assignment, plan OT, device gate, geofence, recompute) use a terminal file only as
 * the REAL write path that puts a day on the books; what they assert is about that day, not about the
 * importer. This drives the built-in "AIHR Standard Template" mapping through Validate + Import
 * (core/attendance-clocking-import.ts) and reports what those suites read:
 *   imported      — attendance DAYS the import changed (the old `imported` counted days, not lines),
 *   unmatchedRefs — distinct references no employee answered (unmatched card / not employed on the date).
 * The import's own rules are pinned in test/clocking-import.test.ts, not here.
 */
import type { SessionContext } from '../../db/client';
import { commitClockingImport, validateClockingImport, type ClockingImportOutcome } from '../../core/attendance-clocking-import';
import { BUILTIN_MAPPING_ID } from '../../lib/clocking-file';

export async function importPunchCsv(
  ctx: SessionContext,
  csvText: string,
): Promise<{ imported: number; punches: number; unmatchedRefs: string[]; outcome: ClockingImportOutcome }> {
  const preview = await validateClockingImport(ctx, { mappingId: BUILTIN_MAPPING_ID, text: csvText });
  const outcome = await commitClockingImport(ctx, {
    mappingId: BUILTIN_MAPPING_ID,
    text: csvText,
    fileName: 'test.csv',
    fileBytes: Buffer.byteLength(csvText),
  });
  if (outcome.status === 'failed') throw new Error(`import failed: ${outcome.failureReason}`);
  const unmatchedRefs = [
    ...new Set(
      preview.errorRows.filter((r) => r.result === 'unmatched_card' || r.result === 'not_employed_on_date').map((r) => r.cardRef),
    ),
  ];
  return { imported: outcome.daysUpdated, punches: outcome.imported, unmatchedRefs, outcome };
}

/** The old `dryRun: true`: Validate, which writes nothing. */
export function previewPunchCsv(ctx: SessionContext, csvText: string) {
  return validateClockingImport(ctx, { mappingId: BUILTIN_MAPPING_ID, text: csvText });
}
