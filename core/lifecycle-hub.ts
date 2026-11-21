/** Count-only Lifecycle staff tiles; detail, progress, and requester data stay in their own readers. */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { itAssetRequest, itRequisition, lcCase } from '../db/schema';
import { LEVEL, requireLevel, withTenant } from './lifecycle-base';
import {
  LIFECYCLE_LIST_LIMIT, lifecycleCaseListFilter, lifecycleRequisitionListFilter,
  pendingLifecycleAssetRequestFilter, pendingLifecycleRequisitionFilter,
} from './lifecycle-list-filters';

type TileCount = { count: number; overflow: boolean };
const summarize = (count: number): TileCount => ({ count: Math.min(LIFECYCLE_LIST_LIMIT, count), overflow: count > LIFECYCLE_LIST_LIMIT });
const boundedCount = (table: SQLWrapper, predicate: SQL) => sql`
  (select count(*)::int from (select 1 from ${table} where ${predicate} limit ${LIFECYCLE_LIST_LIMIT + 1}) as admitted)
`;
const exactCount = (table: SQLWrapper, predicate: SQL) => sql`(select count(*)::int from ${table} where ${predicate})`;

export function lifecycleHubTileCounts(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    // The list readers use this same staff gate. Pending tiles additionally require manager here AND
    // in the company of each row. All subqueries run with ordinary tenant/company RLS.
    const level = await requireLevel(tx, null, LEVEL.agent, 'only staff read cases');
    const canSeePending = level >= LEVEL.manager;
    const [counts] = await tx.execute<{ onboarding: number; offboarding: number; open: number; pending: number }>(sql`
      select
        ${boundedCount(lcCase, lifecycleCaseListFilter('onboarding', {}))} as onboarding,
        ${boundedCount(lcCase, lifecycleCaseListFilter('offboarding', {}))} as offboarding,
        ${boundedCount(itRequisition, lifecycleRequisitionListFilter({ status: 'open' })!)} as "open",
        ${canSeePending
          ? sql`${exactCount(itRequisition, pendingLifecycleRequisitionFilter())} + ${exactCount(itAssetRequest, pendingLifecycleAssetRequestFilter())}`
          : sql`0`} as pending
    `);
    // The first three linked lists cap at 1,000. One extra authorized match distinguishes 1,000 from
    // 1,000+, without unbounded scans. The approval tile counts its complete authorized queue.
    return { onboarding: summarize(counts.onboarding), offboarding: summarize(counts.offboarding), open: summarize(counts.open), pending: counts.pending };
  });
}
