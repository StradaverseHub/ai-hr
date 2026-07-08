/**
 * Granular payroll permission-grant administration (feedback 9bc442bc, reporter expected_function:
 * "configurable per company/tenant"). CRUD over the `payroll_permission_grant` override table that the
 * kernel resolver (resolvePayrollPermission in core/payroll.ts) reads. Every write appends a DomainEvent
 * (substrate discipline). Admin-scoped via RLS (the grant table's write policy is is_admin()).
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { payrollPermissionGrant } from '../db/schema';
import { PAYROLL_PERMISSION_KEYS, isPayrollPermissionKey } from '../lib/payroll-permissions';

export function listPayrollPermissionGrants(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollPermissionGrant.id,
        companyId: payrollPermissionGrant.companyId,
        permissionKey: payrollPermissionGrant.permissionKey,
        role: payrollPermissionGrant.role,
        allowed: payrollPermissionGrant.allowed,
      })
      .from(payrollPermissionGrant)
      .orderBy(desc(payrollPermissionGrant.createdAt)),
  );
}

const VALID_ROLES = new Set(['employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner']);

/** Upsert an override for a (companyId|null, permissionKey, role) triple. */
export async function setPayrollPermissionGrant(
  ctx: SessionContext,
  p: { companyId?: string | null; permissionKey: string; role: string; allowed: boolean },
) {
  if (!isPayrollPermissionKey(p.permissionKey)) throw new Error('Unknown payroll permission key.');
  if (!VALID_ROLES.has(p.role)) throw new Error('Unknown role.');
  const companyId = p.companyId || null;
  return withTenant(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: payrollPermissionGrant.id })
      .from(payrollPermissionGrant)
      .where(
        and(
          eq(payrollPermissionGrant.permissionKey, p.permissionKey),
          eq(payrollPermissionGrant.role, p.role),
          companyId ? eq(payrollPermissionGrant.companyId, companyId) : isNull(payrollPermissionGrant.companyId),
        ),
      )
      .limit(1);
    let id: string;
    if (existing) {
      await tx
        .update(payrollPermissionGrant)
        .set({ allowed: p.allowed, updatedAt: new Date() })
        .where(eq(payrollPermissionGrant.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx
        .insert(payrollPermissionGrant)
        .values({ tenantId: ctx.tenantId, companyId, permissionKey: p.permissionKey, role: p.role, allowed: p.allowed })
        .returning({ id: payrollPermissionGrant.id });
      id = row.id;
    }
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'payroll-permission-grant',
      aggregateId: id,
      eventType: existing ? 'payroll-permission-grant.updated' : 'payroll-permission-grant.created',
      actor: actorOf(ctx),
      payload: { companyId, permissionKey: p.permissionKey, role: p.role, allowed: p.allowed },
    });
    return { id };
  });
}

export async function deletePayrollPermissionGrant(ctx: SessionContext, p: { id: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .delete(payrollPermissionGrant)
      .where(eq(payrollPermissionGrant.id, p.id))
      .returning({ id: payrollPermissionGrant.id, permissionKey: payrollPermissionGrant.permissionKey, role: payrollPermissionGrant.role });
    if (row) {
      await appendEvent(tx, {
        tenantId: ctx.tenantId,
        aggregateType: 'payroll-permission-grant',
        aggregateId: row.id,
        eventType: 'payroll-permission-grant.deleted',
        actor: actorOf(ctx),
        payload: { permissionKey: row.permissionKey, role: row.role },
      });
    }
    return { deleted: !!row };
  });
}

export const PAYROLL_PERMISSION_KEY_LIST = PAYROLL_PERMISSION_KEYS;
