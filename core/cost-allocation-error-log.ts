/**
 * Board d3ba1e9f — Import History's Error Log of a Cost Center Allocations attempt (registered by
 * core/import-error-log-registry.ts). Built from what the attempt already recorded: the sealed plan (file problems and
 * every set's check errors) and the failed items the save wrote. Bounded: one attempt read (at most 5,000 sets) and one
 * set-based company-visibility read; no per-row query and no Access lock.
 *
 * Visibility, as the attempt page: the attempt must be visible (getImportAttempt). The person who uploaded the file sees
 * every line (they saw them at the check); anyone else sees the sets of companies they can view.
 */
import type { SessionContext } from '../db/client';
import { getImportAttempt } from './import-history';
import { workforceCompanies } from './workforce-access';
import { costAllocationProblemLines, type AllocationProblemGroup } from '../lib/cost-allocation-import-problems';
import type { CostAllocationImportPlan } from '../lib/cost-allocation-import';
import type { ImportProblemLine } from '../lib/import-problem-lines';
import { importProblemText } from '../lib/import-problem-rules';

/** `t.problems` is a ROOT translator (getTranslations()). */
export async function costAllocationErrorLogFor(
  ctx: SessionContext,
  attemptId: string,
  t: { problems: (key: string, values?: Record<string, unknown>) => string; shared: (key: string) => string },
): Promise<{ lines: ImportProblemLine[]; total: number; truncated: boolean } | null> {
  const item = await getImportAttempt(ctx, attemptId);
  if (!item || item.kind !== 'cost_allocations') return null;
  const plan = item.plan as unknown as CostAllocationImportPlan;
  const own = !!ctx.userId && item.createdBy === ctx.userId;
  const visible = own ? null : new Set(await workforceCompanies(ctx, 'view'));
  const groups: AllocationProblemGroup[] = (plan.groups ?? []).filter(g => !visible || (!!g.companyId && visible.has(g.companyId)));
  const keys = new Set(groups.map(g => g.key));
  const saveFailures = item.items
    .filter(i => i.status === 'failed' && keys.has(i.itemKey) && (!visible || visible.has(i.companyId)))
    .map(i => { const g = groups.find(x => x.key === i.itemKey)!; return { key: i.itemKey, employeeCode: g.employeeCode, rowNums: g.rowNums, errors: i.errors }; });
  const lines = costAllocationProblemLines({ issues: plan.issues ?? [], groups, saveFailures }, importProblemText(t.problems as Parameters<typeof importProblemText>[0]));
  return { lines, total: lines.length, truncated: false };
}
