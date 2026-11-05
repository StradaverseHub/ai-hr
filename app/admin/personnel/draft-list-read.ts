import type { SessionContext } from '@/db/client';
import { countEmployeeDrafts, listEmployeeDrafts, type DraftListScope, type EmployeeDraftRow } from '@/core/employee-draft';
import { draftFiltersPermitRows, draftMatchesQuery, type PersonnelListQuery } from './list-query';

/** The Draft card replaces the employment bucket. Keep its exact count while reading full draft
 * details only when the current view actually renders those drafts. */
export async function readPersonnelDraftList(
  ctx: SessionContext, scope: DraftListScope, query: PersonnelListQuery, renderRows: boolean,
): Promise<{ rows: EmployeeDraftRow[]; count: number }> {
  const cardQuery = { ...query, bucket: undefined };
  if (!draftFiltersPermitRows(cardQuery)) return { rows: [], count: 0 };
  // This is the same strict company equality as draftMatchesQuery. It only narrows the existing
  // server-resolved scope; the native draft RLS policy remains the authority.
  const narrowed = query.company
    ? { companyIds: scope.companyIds.filter(id => id === query.company), includeWithoutCompany: false }
    : scope;
  const matches = query.q ? (row: Parameters<typeof draftMatchesQuery>[0]) => draftMatchesQuery(row, cardQuery) : undefined;
  if (renderRows && draftFiltersPermitRows(query)) {
    const rows = await listEmployeeDrafts(ctx, narrowed, matches);
    return { rows, count: rows.length };
  }
  return { rows: [], count: await countEmployeeDrafts(ctx, narrowed, matches) };
}
