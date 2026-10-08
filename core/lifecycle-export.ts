/**
 * Lifecycle CSV exports (ADR-0095) — managers and admins only. Identity numbers are MASKED to their last
 * four characters (handover brief 10); the cost centre, bank details and notes never leave in an export.
 * Cells go through lib/csv.ts, which neutralises spreadsheet formula injection.
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import { itAsset, itAssetRequest, itRequisition, lcCase } from '../db/schema';
import { toCsv } from '../lib/csv';
import { maskId } from './lifecycle-rules';
import { LEVEL, requireLevel, withTenant } from './lifecycle-base';

export type ExportKind = 'onboarding' | 'offboarding' | 'requisitions' | 'assets' | 'asset-requests';
const iso = (d: Date | string | null | undefined): string => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ?? ''));

export async function exportLifecycleCsv(ctx: SessionContext, kind: ExportKind, range: { from?: string; to?: string } = {}): Promise<string> {
  return withTenant(ctx, async (tx) => {
    await requireLevel(tx, null, LEVEL.manager, 'only a manager exports');
    const dateRange = (col: Parameters<typeof gte>[0]) => {
      const c = [];
      if (range.from) c.push(gte(col, new Date(`${range.from}T00:00:00Z`) as never));
      if (range.to) c.push(lte(col, new Date(`${range.to}T23:59:59Z`) as never));
      return c.length ? and(...c) : undefined;
    };
    if (kind === 'onboarding' || kind === 'offboarding') {
      const mine = await tx.select().from(lcCase).where(and(eq(lcCase.kind, kind), dateRange(lcCase.createdAt))).orderBy(asc(lcCase.number));
      return toCsv([
        ['Number', 'Status', 'Full name', 'Employee no.', 'ID / passport (masked)', 'Job title', 'Department', 'Supervisor', kind === 'onboarding' ? 'Join date' : 'Resignation date', kind === 'onboarding' ? 'Laptop required' : 'Last working day', kind === 'onboarding' ? 'Car park' : 'Outcome', 'Created'],
        ...mine.map((r) => [r.number, r.status, r.fullName, r.employeeNo, maskId(r.nricPassport), r.jobTitle, r.department, r.supervisor,
          kind === 'onboarding' ? iso(r.joinDate) : iso(r.resignationDate), kind === 'onboarding' ? (r.laptopRequired ? 'Yes' : 'No') : iso(r.lastWorkingDay),
          kind === 'onboarding' ? (r.carparkRequired ? 'Yes' : 'No') : r.outcome, iso(r.createdAt)]),
      ]);
    }
    if (kind === 'requisitions') {
      const rows = await tx.select().from(itRequisition).where(dateRange(itRequisition.createdAt)).orderBy(asc(itRequisition.number));
      return toCsv([['Number', 'Type', 'Status', 'Approval', 'Full name', 'Employee no.', 'Department', 'Created'],
        ...rows.map((r) => [r.number, r.kind, r.status, r.approvalStatus, r.fullName, r.employeeNo, r.department, iso(r.createdAt)])]);
    }
    if (kind === 'assets') {
      const rows = await tx.select().from(itAsset).where(dateRange(itAsset.createdAt)).orderBy(asc(itAsset.code));
      return toCsv([['Code', 'Type', 'Status', 'Manufacturer', 'Model', 'Serial', 'Holder', 'Holder employee no.', 'Warranty end', 'Lease end', 'Location'],
        ...rows.map((r) => [r.code, r.assetType, r.status, r.manufacturer, r.model, r.serialNo, r.userName, r.userEmployeeNo, iso(r.warrantyEnd), iso(r.leaseEnd), r.location])]);
    }
    const rows = await tx.select().from(itAssetRequest).where(dateRange(itAssetRequest.createdAt)).orderBy(asc(itAssetRequest.number));
    return toCsv([['Number', 'Status', 'Requester', 'Employee no.', 'Quantity', 'Preferred date', 'Created'],
      ...rows.map((r) => [r.number, r.status, r.fullName, r.employeeNo, r.quantity, iso(r.preferredDate), iso(r.createdAt)])]);
  });
}
