/**
 * Admin / setup services — org structure, leave config, and role management.
 * Each mutation runs via withTenant and appends a domain event (substrate discipline,
 * ADR-0006). RLS (migration 0002) requires an admin role for these writes.
 */
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  appUser,
  company,
  costCenter,
  department,
  leavePolicy,
  leaveType,
  person,
  position,
  roleAssignment,
} from '../db/schema';

type Role = 'employee' | 'manager' | 'hr_admin' | 'super_admin';

export async function createCompany(
  ctx: SessionContext,
  p: { legalName: string; country?: string; currency?: string; registrationNo?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(company)
      .values({
        tenantId: ctx.tenantId,
        legalName: p.legalName,
        country: p.country || 'MY',
        currency: p.currency || 'MYR',
        registrationNo: p.registrationNo || null,
      })
      .returning({ id: company.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: row.id,
      eventType: 'company.created',
      actor: actorOf(ctx),
      payload: { legalName: p.legalName, country: p.country || 'MY' },
    });
    return row;
  });
}

/** Set (or clear) a company's parent in the group tree. Cycles are rejected by a DB trigger. */
export async function setCompanyParent(
  ctx: SessionContext,
  p: { companyId: string; parentCompanyId: string | null },
) {
  return withTenant(ctx, async (tx) => {
    await tx
      .update(company)
      .set({ parentCompanyId: p.parentCompanyId })
      .where(eq(company.id, p.companyId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'company',
      aggregateId: p.companyId,
      eventType: 'company.parent.changed',
      actor: actorOf(ctx),
      payload: { parentCompanyId: p.parentCompanyId },
    });
    return { id: p.companyId };
  });
}

export async function createDepartment(
  ctx: SessionContext,
  p: { companyId: string; name: string; parentDepartmentId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(department)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        name: p.name,
        parentDepartmentId: p.parentDepartmentId || null,
      })
      .returning({ id: department.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'department',
      aggregateId: row.id,
      eventType: 'department.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, name: p.name },
    });
    return row;
  });
}

export async function createPosition(
  ctx: SessionContext,
  p: { companyId: string; title: string; jobFamily?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(position)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, title: p.title, jobFamily: p.jobFamily || null })
      .returning({ id: position.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'position',
      aggregateId: row.id,
      eventType: 'position.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, title: p.title },
    });
    return row;
  });
}

export async function createCostCenter(
  ctx: SessionContext,
  p: { companyId: string; code: string; name: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(costCenter)
      .values({ tenantId: ctx.tenantId, companyId: p.companyId, code: p.code, name: p.name })
      .returning({ id: costCenter.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'cost-center',
      aggregateId: row.id,
      eventType: 'cost-center.created',
      actor: actorOf(ctx),
      payload: { companyId: p.companyId, code: p.code },
    });
    return row;
  });
}

export async function createLeaveType(
  ctx: SessionContext,
  p: { code: string; name: string; paid?: boolean },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(leaveType)
      .values({ tenantId: ctx.tenantId, code: p.code, name: p.name, paid: p.paid ?? true })
      .returning({ id: leaveType.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-type',
      aggregateId: row.id,
      eventType: 'leave-type.created',
      actor: actorOf(ctx),
      payload: { code: p.code, name: p.name },
    });
    return row;
  });
}

export async function createLeavePolicy(
  ctx: SessionContext,
  p: { leaveTypeId: string; annualDays: number; method?: string; validFrom: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(leavePolicy)
      .values({
        tenantId: ctx.tenantId,
        leaveTypeId: p.leaveTypeId,
        accrual: { annualDays: p.annualDays, method: p.method || 'grant_on_hire_prorated' },
        validFrom: p.validFrom,
        validTo: null,
      })
      .returning({ id: leavePolicy.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-policy',
      aggregateId: row.id,
      eventType: 'leave-policy.created',
      actor: actorOf(ctx),
      payload: { leaveTypeId: p.leaveTypeId, annualDays: p.annualDays },
    });
    return row;
  });
}

export async function assignRole(
  ctx: SessionContext,
  p: { appUserId: string; role: Role; companyId?: string },
) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(roleAssignment)
      .values({ tenantId: ctx.tenantId, appUserId: p.appUserId, role: p.role, companyId: p.companyId || null })
      .returning({ id: roleAssignment.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'role-assignment',
      aggregateId: row.id,
      eventType: 'role.assigned',
      actor: actorOf(ctx),
      payload: { appUserId: p.appUserId, role: p.role },
    });
    return row;
  });
}

export async function revokeRole(ctx: SessionContext, p: { roleAssignmentId: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(roleAssignment)
      .where(eq(roleAssignment.id, p.roleAssignmentId))
      .limit(1);
    if (!row) throw new Error('role assignment not found');
    await tx.delete(roleAssignment).where(eq(roleAssignment.id, p.roleAssignmentId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'role-assignment',
      aggregateId: p.roleAssignmentId,
      eventType: 'role.revoked',
      actor: actorOf(ctx),
      payload: { appUserId: row.appUserId, role: row.role },
    });
  });
}

// ── Reads ──────────────────────────────────────────────────────────

export function listPositions(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx.select({ id: position.id, title: position.title, jobFamily: position.jobFamily }).from(position).orderBy(position.title),
  );
}

export function listCostCenters(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx.select({ id: costCenter.id, code: costCenter.code, name: costCenter.name }).from(costCenter).orderBy(costCenter.code),
  );
}

export function listLeavePolicies(ctx: SessionContext) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: leavePolicy.id,
        leaveType: leaveType.name,
        accrual: leavePolicy.accrual,
        validFrom: leavePolicy.validFrom,
      })
      .from(leavePolicy)
      .innerJoin(leaveType, eq(leaveType.id, leavePolicy.leaveTypeId))
      .orderBy(leaveType.name),
  );
}

export function listUsers(ctx: SessionContext) {
  return withTenant(ctx, async (tx) => {
    const users = await tx
      .select({
        id: appUser.id,
        workosUserId: appUser.workosUserId,
        personId: appUser.personId,
        name: person.fullName,
        email: person.primaryEmail,
      })
      .from(appUser)
      .leftJoin(person, eq(person.id, appUser.personId))
      .orderBy(person.fullName);
    const roles = await tx
      .select({ id: roleAssignment.id, appUserId: roleAssignment.appUserId, role: roleAssignment.role })
      .from(roleAssignment);
    return users.map((u) => ({ ...u, roles: roles.filter((r) => r.appUserId === u.id) }));
  });
}
