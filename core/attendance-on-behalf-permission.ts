/** 96a54ed2 — the permission-key half of Request/Approve On Behalf. A leaf (no Attendance owner imports) so the
 * workflow decision owner can ask it inside its own transaction. Company-scoped override rows win over tenant rows,
 * which win over the defaults in lib/payroll-permissions.ts. */
import { and, eq } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { company, payrollPermissionGrant } from '../db/schema';
import { decidePayrollPermission } from '../lib/payroll-permissions';

export type AttendanceOnBehalfPurpose = 'request' | 'approve';
export const ATTENDANCE_ON_BEHALF_KEYS = { request: 'attendance.request_on_behalf', approve: 'attendance.approve_on_behalf' } as const;
const KEYS = ATTENDANCE_ON_BEHALF_KEYS;

/** Companies of the tenant where the caller holds the key. One read of override rows and one of company ids. */
export async function permittedCompaniesTx(tx: Tx, ctx: SessionContext, purpose: AttendanceOnBehalfPurpose): Promise<string[]> {
  const key = KEYS[purpose];
  const overrides = await tx.select({ role: payrollPermissionGrant.role, allowed: payrollPermissionGrant.allowed, companyId: payrollPermissionGrant.companyId })
    .from(payrollPermissionGrant).where(and(eq(payrollPermissionGrant.tenantId, ctx.tenantId), eq(payrollPermissionGrant.permissionKey, key)));
  const callerRoles = [...(ctx.roles ?? []), ...(ctx.grants ?? []).map(grant => grant.role)];
  const companies = await tx.select({ id: company.id }).from(company).where(eq(company.tenantId, ctx.tenantId));
  return companies.filter(row => decidePayrollPermission({ key, callerRoles,
    overrides: overrides.filter(o => o.companyId == null || o.companyId === row.id).map(o => ({ role: o.role, allowed: o.allowed, companyScoped: o.companyId != null })) })).map(row => row.id);
}

/** Permission-key half of Approve On Behalf for one application's company; the SQL owner proves the rest. */
export async function canApproveOnBehalfForCompanyTx(tx: Tx, ctx: SessionContext, companyId: string) {
  return (await permittedCompaniesTx(tx, ctx, 'approve')).includes(companyId);
}
