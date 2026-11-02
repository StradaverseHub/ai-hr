import {lockAccessConfigurationTx} from './access-configuration-lock';
import {assertAiPrincipalTx} from './ai-principal';
/**
 * Granular payroll permission-grant administration (feedback 9bc442bc, reporter expected_function:
 * "configurable per company/tenant"). CRUD over the `payroll_permission_grant` override table that the
 * kernel resolver (resolvePayrollPermission in core/payroll.ts) reads. Every write appends a DomainEvent
 * (substrate discipline). Admin-scoped via RLS (the grant table's write policy is is_admin()).
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { payrollPermissionGrant } from '../db/schema';
import { PAYROLL_PERMISSION_KEYS, isPayrollPermissionKey } from '../lib/payroll-permissions';

export function payrollPermissionManagementAccess(ctx:SessionContext) {
  return withTenant(ctx,async tx=>{
    const [row]=await tx.execute<{view:boolean;add:boolean;edit:boolean}>(sql`select
      app.financial_setup_catalog_function('payComponents.catalogue','view') as view,
      app.financial_setup_catalog_function('payComponents.catalogue','add') as add,
      app.financial_setup_catalog_function('payComponents.catalogue','edit') as edit`);
    return {canView:row?.view===true,canSave:row?.add===true||row?.edit===true};
  });
}

export function listPayrollPermissionGrants(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: payrollPermissionGrant.id,
        companyId: payrollPermissionGrant.companyId,
        permissionKey: payrollPermissionGrant.permissionKey,
        role: payrollPermissionGrant.role,
        allowed: payrollPermissionGrant.allowed,
        canRemove: sql<boolean>`app.payroll_permission_grant_can_remove_current(${payrollPermissionGrant.id})`,
      })
      .from(payrollPermissionGrant)
      .where(sql`app.financial_setup_catalog_function('payComponents.catalogue','view')`)
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
  p={...p};ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await assertAiPrincipalTx(tx,ctx);
    const [admin]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);
    if(admin?.allowed!==true)throw new Error('Payroll permission administration required.');
    if (p.permissionKey === 'leave.apply_on_behalf') {
      const [written] = await tx.execute<{ id: string }>(sql`select app.leave_on_behalf_grant_set(${companyId}::uuid, ${p.role}, ${p.allowed}) as id`);
      if (!written?.id) throw new Error('Leave permission write unavailable.');
      return { id: written.id };
    }
    if (p.permissionKey.startsWith('report.read.')) {
      const [written]=await tx.execute<{id:string|null}>(sql`select app.report_permission_grant_set(${companyId}::uuid,${p.permissionKey},${p.role},${p.allowed}) as id`);
      if(!written?.id)throw new Error('Report permission write unavailable.');
      return {id:written.id};
    }
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
  p={...p};ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
  return withTenant(ctx, async (tx) => {
    await lockAccessConfigurationTx(tx,ctx.tenantId);
    await assertAiPrincipalTx(tx,ctx);
    const [admin]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);
    if(admin?.allowed!==true)throw new Error('Payroll permission administration required.');
    const [existing] = await tx.select({ permissionKey: payrollPermissionGrant.permissionKey })
      .from(payrollPermissionGrant).where(eq(payrollPermissionGrant.id, p.id)).for('update');
    if (existing?.permissionKey === 'leave.apply_on_behalf') {
      const [written] = await tx.execute<{ deleted: boolean }>(sql`select app.leave_on_behalf_grant_delete(${p.id}::uuid) as deleted`);
      return { deleted: written?.deleted === true };
    }
    if(existing?.permissionKey.startsWith('report.read.')&&isPayrollPermissionKey(existing.permissionKey)){
      const [written]=await tx.execute<{deleted:boolean}>(sql`select app.report_permission_grant_delete(${p.id}::uuid) as deleted`);
      return {deleted:written?.deleted===true};
    }
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
