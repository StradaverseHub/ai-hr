/**
 * Board d3ba1e9f — Import History's Error Log of an Information-Only Correction attempt (registered by
 * core/import-error-log-registry.ts). Built from what the attempt already recorded: the sealed plan's rows (at most
 * 200) with their check errors, and the confirmed event's per-row outcome for rows the save refused. Rows are limited
 * exactly as the attempt's Import Log (informationImportLog): the uploader sees every row, anyone else the rows of
 * companies they can view. Bounded reads only; no per-row query and no Access lock.
 */
import type { SessionContext } from '../db/client';
import { getImportAttempt } from './import-history';
import { informationImportLog } from './information-correction-import';
import { informationCorrectionProblemLines, type InformationSaveRow } from '../lib/information-correction-problems';
import type { InformationImportPlan } from '../lib/information-correction';
import type { ImportProblemLine } from '../lib/import-problem-lines';
import { importProblemText } from '../lib/import-problem-rules';

/** `t.problems` is a ROOT translator (getTranslations()). */
export async function informationCorrectionErrorLogFor(
  ctx: SessionContext,
  attemptId: string,
  t: { problems: (key: string, values?: Record<string, unknown>) => string; shared: (key: string) => string },
): Promise<{ lines: ImportProblemLine[]; total: number; truncated: boolean } | null> {
  const item = await getImportAttempt(ctx, attemptId);
  if (!item || item.kind !== 'information_correction') return null;
  const plan = item.plan as unknown as InformationImportPlan;
  const shown = new Set((await informationImportLog(ctx, item)).map(row => row.row));
  const rows = (plan.rows ?? []).filter(row => shown.has(row.row));
  const confirmed = item.events.find(event => event.kind === 'confirmed');
  const saved = Array.isArray(confirmed?.detail.rows) ? (confirmed!.detail.rows as InformationSaveRow[]) : [];
  const lines = informationCorrectionProblemLines({ rows, saved }, importProblemText(t.problems as Parameters<typeof importProblemText>[0]));
  return { lines, total: lines.length, truncated: false };
}
