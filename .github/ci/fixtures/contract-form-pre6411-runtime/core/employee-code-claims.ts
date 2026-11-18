/**
 * WHO CURRENTLY CLAIMS AN EMPLOYEE ID — item 06f0cb8f.
 *
 * Until this item there was one answer and one table: an Employee ID was taken iff some `employment`
 * carried it, guarded by `employment_employee_code_uq`. A Draft now HOLDS an ID from the moment it is
 * created (`employee_draft.reserved_employee_code`), so "is this ID free?" has become a question about
 * TWO tables, and every path that could hand out an ID has to ask the same question the same way:
 *   - the hire form and the bulk importer, via `core/org.ts` `assertEmployeeCodeUnique`;
 *   - the Create screen's look-ahead and its Create, via `core/employee-draft.ts`;
 *   - Activate, which re-checks before `hireEmployee` runs.
 *
 * IT LIVES IN ITS OWN MODULE TO AVOID A CYCLE, not out of taste: `core/employee-draft.ts` imports
 * `hireEmployee` from `core/org.ts`, so `core/org.ts` cannot import back from the draft module. A third
 * module both may import is the only shape that keeps ONE definition of the rule — and one definition is
 * the point, because two that disagree would let an ID be issued twice, which is the exact fault the
 * reporter asked to make impossible.
 *
 * The bounded SQL claim owner now answers this one question for all three courses, independently
 * of visibility of another company's private record. It returns only the collision kind, never ids
 * or payloads. Runtime callers join the tenant access/write lock; hire, draft reservation and code
 * correction retain that lock through their writes. The two per-table indexes remain backstops.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';

/** Which table is holding the code, so the caller can say WHY it is refused. */
export type EmployeeCodeClaim = 'employment' | 'draft';

/**
 * Who holds `code` (already normalized) in this tenant, or null when nobody does.
 *
 * `excludeEmploymentId` skips the employment being edited, so re-saving its own unchanged code is not a
 * false collision. `excludeDraftId` skips a draft's OWN reservation — without it, Activate would refuse
 * every draft on the grounds that the number it is about to use is already held, by itself.
 */
export async function findEmployeeCodeClaim(
  tx: Tx,
  tenantId: string,
  code: string,
  opts: { excludeEmploymentId?: string; excludeDraftId?: string } = {},
): Promise<EmployeeCodeClaim | null> {
  const [row]=await tx.execute<{claim:EmployeeCodeClaim|null}>(sql`select app.employee_code_claim(${tenantId}::uuid,${code},${opts.excludeEmploymentId??null}::uuid,${opts.excludeDraftId??null}::uuid) as claim`);
  if(!row||row.claim!==null&&row.claim!=='employment'&&row.claim!=='draft')throw new Error('Employee ID claim lookup unavailable');
  return row.claim;
}
