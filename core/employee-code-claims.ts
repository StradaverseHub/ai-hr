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
 * POSTGRES CANNOT DO THIS FOR US. There is no cross-table unique constraint, so this check is the
 * authority in TypeScript, with each table's own unique index as the race net on its own side
 * (`employment_employee_code_uq`, `employee_draft_reserved_code_uq` from migration 0415). Two writers
 * racing on the SAME table still serialize on its index; two racing across the two tables can in
 * principle both pass this check, and the loser is refused by whichever index it reaches — a clear
 * refusal, never a duplicate.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employeeDraft, employment } from '../db/schema';

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
  const employments = await tx
    .select({ id: employment.id })
    .from(employment)
    .where(and(eq(employment.tenantId, tenantId), eq(employment.employeeCode, code)))
    .limit(2);
  if (employments.some((r) => r.id !== opts.excludeEmploymentId)) return 'employment';

  const drafts = await tx
    .select({ id: employeeDraft.id })
    .from(employeeDraft)
    .where(
      and(
        eq(employeeDraft.tenantId, tenantId),
        eq(employeeDraft.reservedEmployeeCode, code),
        // The exclusion is expressed in SQL as well as in JS so the LIMIT cannot be filled by the very
        // row we are meant to ignore and then hide a genuine second claimant behind it.
        opts.excludeDraftId ? ne(employeeDraft.id, opts.excludeDraftId) : undefined,
      ),
    )
    .limit(1);
  return drafts.length > 0 ? 'draft' : null;
}
