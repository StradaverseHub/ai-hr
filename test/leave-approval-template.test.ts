/**
 * 6fadb036 (R17) — Approval Workflow Enhancement: reusable approval TEMPLATES, a tenant-wide DEFAULT chain,
 * and bulk (company × leave-type) ASSIGNMENT layered on the ADR-0071 rule matrix. A template-driven
 * assignment writes a leave_approval_policy row (leave-type-scoped, other dims wildcard) with template_id
 * set; resolveApprovalChain reads the template's levels. The tenant-default template sits just above the
 * built-in [direct_manager, hr_admin] fallback.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { resolveApprovalChain, setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  assignApprovalTemplate,
  createApprovalTemplate,
  deleteApprovalTemplate,
  duplicateApprovalTemplate,
  listApprovalTemplates,
  listTemplateAssignments,
  setApprovalTemplateActive,
  setTenantDefaultTemplate,
  unassignApprovalTemplate,
  updateApprovalTemplate,
} from '../core/leave-approval-template';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let sickLeaveTypeId: string;
const ctx = () => adminCtx(b);

const resolve = (leaveTypeId: string | null) =>
  withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, leaveTypeId));

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true })
    .returning({ id: schema.leaveType.id });
  sickLeaveTypeId = sick.id;
});
afterAll(async () => {
  await closeAll();
});

describe('approval templates — CRUD', () => {
  it('creates, lists, updates and duplicates a template', async () => {
    const { id } = await createApprovalTemplate(ctx(), {
      name: 'Standard Leave Approval',
      description: 'Manager then HR',
      levels: ['direct_manager', 'hr_admin'],
    });
    let list = await listApprovalTemplates(ctx());
    expect(list).toHaveLength(1);
    // r293 phase 3 — a level is now a KIND plus, for a named-approver level, the employment it points at.
    // A chain of relationship-resolved kinds names nobody, which is what the null half asserts.
    expect(list[0].levels).toEqual([
      { kind: 'direct_manager', employmentId: null },
      { kind: 'hr_admin', employmentId: null },
    ]);
    expect(list[0].assignedCount).toBe(0);

    await updateApprovalTemplate(ctx(), id, { name: 'Standard', levels: ['hr_admin'] });
    list = await listApprovalTemplates(ctx());
    expect(list[0].name).toBe('Standard');
    expect(list[0].levels).toEqual([{ kind: 'hr_admin', employmentId: null }]);

    await duplicateApprovalTemplate(ctx(), id);
    list = await listApprovalTemplates(ctx());
    expect(list.map((t) => t.name).sort()).toEqual(['Standard', 'Standard (copy)']);
  });

  it('rejects a duplicate (case-insensitive) name and an empty chain', async () => {
    await createApprovalTemplate(ctx(), { name: 'Payroll Approval', levels: ['hr_admin'] });
    await expect(
      createApprovalTemplate(ctx(), { name: 'payroll approval', levels: ['hr_admin'] }),
    ).rejects.toThrow(/already exists/i);
    await expect(createApprovalTemplate(ctx(), { name: 'Empty', levels: [] })).rejects.toThrow(/at least one/i);
  });

  it('appends a domain event on create', async () => {
    const { id } = await createApprovalTemplate(ctx(), { name: 'T', levels: ['hr_admin'] });
    const ev = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.aggregateType, 'leave-approval-template'),
          eq(schema.domainEvent.aggregateId, id),
        ),
      );
    expect(ev.map((e) => e.eventType)).toContain('leave-approval-template.created');
  });
});

describe('approval templates — assignment resolves the template chain', () => {
  it('bulk-assigns across leave types and resolution reads the template levels', async () => {
    const { id } = await createApprovalTemplate(ctx(), { name: 'Std', levels: ['direct_manager', 'hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId, sickLeaveTypeId],
    });
    expect(ruleIds).toHaveLength(2);
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['direct_manager', 'hr_admin']);
    expect(await resolve(sickLeaveTypeId)).toEqual(['direct_manager', 'hr_admin']);

    // Editing the template changes future resolution.
    await updateApprovalTemplate(ctx(), id, { name: 'Std', levels: ['hr_admin'] });
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['hr_admin']);

    const assigns = await listTemplateAssignments(ctx());
    expect(assigns).toHaveLength(2);
    expect(assigns.every((a) => a.templateId === id)).toBe(true);
  });

  it('re-assigning REPOINTS the existing wildcard-bucket row (no duplicate, no unique-index violation)', async () => {
    const a = await createApprovalTemplate(ctx(), { name: 'A', levels: ['direct_manager'] });
    const c = await createApprovalTemplate(ctx(), { name: 'C', levels: ['hr_admin'] });
    await assignApprovalTemplate(ctx(), { templateId: a.id, companyIds: [b.companyId], leaveTypeIds: [b.annualLeaveTypeId] });
    await assignApprovalTemplate(ctx(), { templateId: c.id, companyIds: [b.companyId], leaveTypeIds: [b.annualLeaveTypeId] });
    const rows = await owner.db
      .select()
      .from(schema.leaveApprovalPolicy)
      .where(and(eq(schema.leaveApprovalPolicy.companyId, b.companyId), eq(schema.leaveApprovalPolicy.active, true)));
    // Only ONE active assignment row for that leave type, now pointing at C.
    expect(rows).toHaveLength(1);
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['hr_admin']);
  });

  it('unassign archives the row and resolution falls back to the built-in chain', async () => {
    const { id } = await createApprovalTemplate(ctx(), { name: 'Std', levels: ['hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    await unassignApprovalTemplate(ctx(), ruleIds[0], b.companyId);
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['direct_manager', 'hr_admin']);
  });
});

describe('approval templates — tenant default + precedence + guards', () => {
  it('the tenant default applies when no rule matches, and a scoped assignment wins over it', async () => {
    const def = await createApprovalTemplate(ctx(), { name: 'Default', levels: ['hr_admin'] });
    await setTenantDefaultTemplate(ctx(), def.id);
    // No rule for sick leave → tenant default.
    expect(await resolve(sickLeaveTypeId)).toEqual(['hr_admin']);

    const std = await createApprovalTemplate(ctx(), { name: 'Std', levels: ['direct_manager', 'hr_admin'] });
    await assignApprovalTemplate(ctx(), { templateId: std.id, companyIds: [b.companyId], leaveTypeIds: [b.annualLeaveTypeId] });
    // Annual has a specific assignment → wins; sick still uses the tenant default.
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['direct_manager', 'hr_admin']);
    expect(await resolve(sickLeaveTypeId)).toEqual(['hr_admin']);
  });

  it('company default rule wins over the tenant default template', async () => {
    const def = await createApprovalTemplate(ctx(), { name: 'Default', levels: ['hr_admin'] });
    await setTenantDefaultTemplate(ctx(), def.id);
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager'] });
    expect(await resolve(sickLeaveTypeId)).toEqual(['direct_manager']);
  });

  it('only one tenant default at a time; an inactive template cannot be the default', async () => {
    const a = await createApprovalTemplate(ctx(), { name: 'A', levels: ['hr_admin'] });
    const c = await createApprovalTemplate(ctx(), { name: 'C', levels: ['direct_manager'] });
    await setTenantDefaultTemplate(ctx(), a.id);
    await setTenantDefaultTemplate(ctx(), c.id);
    const list = await listApprovalTemplates(ctx());
    expect(list.filter((t) => t.isTenantDefault).map((t) => t.name)).toEqual(['C']);

    const inactive = await createApprovalTemplate(ctx(), { name: 'Z', levels: ['hr_admin'] });
    await setApprovalTemplateActive(ctx(), inactive.id, false);
    await expect(setTenantDefaultTemplate(ctx(), inactive.id)).rejects.toThrow(/activate/i);
  });

  it('blocks deactivation while an active rule references the template, and blocks delete while referenced', async () => {
    const { id } = await createApprovalTemplate(ctx(), { name: 'Std', levels: ['hr_admin'] });
    const { ruleIds } = await assignApprovalTemplate(ctx(), {
      templateId: id,
      companyIds: [b.companyId],
      leaveTypeIds: [b.annualLeaveTypeId],
    });
    await expect(setApprovalTemplateActive(ctx(), id, false)).rejects.toThrow(/reassign/i);
    await expect(deleteApprovalTemplate(ctx(), id)).rejects.toThrow(/unassign/i);
    // After unassigning, deactivate + delete succeed.
    await unassignApprovalTemplate(ctx(), ruleIds[0], b.companyId);
    // The archived row still references it, so delete is still blocked (FK-safety); reactivation is fine.
    await expect(deleteApprovalTemplate(ctx(), id)).rejects.toThrow(/unassign/i);
    await setApprovalTemplateActive(ctx(), id, false); // no ACTIVE rule now → allowed
    const list = await listApprovalTemplates(ctx());
    expect(list.find((t) => t.id === id)?.active).toBe(false);
  });
});
