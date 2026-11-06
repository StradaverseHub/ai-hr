/** Shared row eligibility for Lifecycle lists and count-only hub tiles. Table RLS still applies. */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { itAssetRequest, itRequisition, lcCase } from '../db/schema';
import { atLeast, LEVEL } from './lifecycle-base';
import type { CaseKind } from './lifecycle-defaults';
import type { RequisitionKind } from './lifecycle-it';

export const LIFECYCLE_LIST_LIMIT = 1_000;

export function lifecycleCaseListFilter(kind: CaseKind, f: { companyId?: string; history?: boolean }) {
  return and(
    eq(lcCase.kind, kind),
    f.history ? inArray(lcCase.status, ['completed', 'cancelled']) : eq(lcCase.status, 'in_progress'),
    // The history lists are manager-only in each company, irrespective of the caller's best level.
    f.history ? atLeast(lcCase.companyId, LEVEL.manager) : undefined,
    f.companyId ? eq(lcCase.companyId, f.companyId) : undefined,
  )!;
}

export function lifecycleRequisitionListFilter(f: { companyId?: string; kind?: RequisitionKind; status?: string; approval?: string }) {
  return and(
    f.companyId ? eq(itRequisition.companyId, f.companyId) : undefined,
    f.kind ? eq(itRequisition.kind, f.kind) : undefined,
    f.status ? eq(itRequisition.status, f.status) : undefined,
    f.approval ? eq(itRequisition.approvalStatus, f.approval) : undefined,
  );
}

// Only the companies where the caller can decide, even if RLS also shows their own requests elsewhere.
export const pendingLifecycleRequisitionFilter = () => and(
  inArray(itRequisition.approvalStatus, ['pending', 'pending_l2']),
  sql`${itRequisition.status} <> 'cancelled'`, atLeast(itRequisition.companyId, LEVEL.manager),
)!;
export const pendingLifecycleAssetRequestFilter = () => and(
  inArray(itAssetRequest.status, ['requested', 'pending_approval']), atLeast(itAssetRequest.companyId, LEVEL.manager),
)!;
