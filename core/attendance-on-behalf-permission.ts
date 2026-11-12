/** 96a54ed2 — the permission-key half of Request/Approve On Behalf. A leaf (no Attendance owner imports) so the
 * workflow decision owner can ask it inside its own transaction. Company-scoped override rows win over tenant rows,
 * which win over the defaults in lib/payroll-permissions.ts. */
import { and, eq, sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { payrollPermissionGrant } from '../db/schema';
import { decidePayrollPermission } from '../lib/payroll-permissions';

export type AttendanceOnBehalfPurpose = 'request' | 'approve';
export const ATTENDANCE_ON_BEHALF_KEYS = { request: 'attendance.request_on_behalf', approve: 'attendance.approve_on_behalf' } as const;
const KEYS = ATTENDANCE_ON_BEHALF_KEYS;

/** Companies of the tenant where the caller holds the key. One read of override rows and one of company ids. */
export async function permittedCompaniesTx(tx: Tx, ctx: SessionContext, purpose: AttendanceOnBehalfPurpose): Promise<string[]> {
  const key = KEYS[purpose];
  const overrides = await tx.select({ role: payrollPermissionGrant.role, allowed: payrollPermissionGrant.allowed, companyId: payrollPermissionGrant.companyId })
    .from(payrollPermissionGrant).where(and(eq(payrollPermissionGrant.tenantId, ctx.tenantId), eq(payrollPermissionGrant.permissionKey, key)));
  // Roles count only for the company they cover and that the database confirms (app.has_role_for), one set-based
  // statement over the tenant's companies, as core/payroll.ts resolves company-scoped payroll permissions.
  const candidates = ctx.grants ?? (ctx.roles ?? []).map(role => ({ role, companyId: null }));
  const held = await tx.execute<{ id: string; roles: string[] }>(sql`select c.id,coalesce(array_agg(distinct candidate.role) filter (where candidate.role is not null),'{}') as roles
    from company c left join jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb) as candidate(role text,"companyId" uuid)
     on (candidate."companyId" is null or candidate."companyId"=c.id or app.is_company_descendant(c.id,candidate."companyId")) and app.has_role_for(candidate.role,c.id)
    where c.tenant_id=${ctx.tenantId}::uuid group by c.id`);
  const companies = held.map(row => ({ id: row.id, callerRoles: row.roles }));
  return companies.filter(row => decidePayrollPermission({ key, callerRoles: row.callerRoles,
    overrides: overrides.filter(o => o.companyId == null || o.companyId === row.id).map(o => ({ role: o.role, allowed: o.allowed, companyScoped: o.companyId != null })) })).map(row => row.id);
}

/** Permission-key half of Approve On Behalf for one application's company; the SQL owner proves the rest. */
export async function canApproveOnBehalfForCompanyTx(tx: Tx, ctx: SessionContext, companyId: string) {
  return (await permittedCompaniesTx(tx, ctx, 'approve')).includes(companyId);
}
