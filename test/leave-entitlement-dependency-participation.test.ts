/** Authored two-connection business-owner acceptance; all cases UNRUN pending coordinated runtime. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { createLeaveType } from '../core/admin';
import { hireEmployee } from '../core/org';
import { lockLeaveDependenciesTx } from '../core/leave-dependency-lock';
import { createEntitlementTemplate, updateEntitlementTemplate, retireEntitlementTemplate, deleteEntitlementTemplate,
  createEligibilityRule, updateEligibilityRule, retireEligibilityRule, deleteEligibilityRule,
  setLeaveTypeDefaultTemplate } from '../core/entitlement-template';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);
const afterDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const commands = ['template-create', 'template-update', 'template-retire', 'template-delete',
  'rule-create', 'rule-update', 'rule-retire', 'rule-delete', 'default'] as const;

describe('participating canonical entitlement configuration commands', () => {
  it.each(commands)('%s refuses a protected employee interval without effects, then succeeds', async command => {
    const ctx = adminCtx(b), today = todayInKualaLumpur(), future = afterDays(today, 30), stop = afterDays(future, 30);
    const employee = await hireEmployee(ctx, { person: { fullName: 'Fictional Entitlement Participation',
      primaryEmail: `entitlement-${randomUUID()}@t.local` }, companyId: b.companyId,
      departmentId: b.deptA, employmentType: 'full_time', hiredOn: afterDays(today, -800) });
    const type = await createLeaveType(ctx, { code: 'CFG_ENT', name: 'Fictional Entitlement Type' });
    const bands = [{ fromYears: 0, toYears: null, days: 12 }];
    const template = await createEntitlementTemplate(ctx, { leaveTypeId: type.id, name: 'Fictional Target Table', serviceBands: bands, validFrom: future });
    const ruleTemplate = await createEntitlementTemplate(ctx, { leaveTypeId: type.id, name: 'Fictional Rule Table', serviceBands: bands, validFrom: future });
    const rule = await createEligibilityRule(ctx, { name: 'Fictional Existing Rule', templateLineageId: ruleTemplate.lineageId,
      criteria: { companyIds: [b.companyId] }, validFrom: future });
    const mutate = async () => {
      switch (command) {
        case 'template-create': return createEntitlementTemplate(ctx, { leaveTypeId: type.id, name: 'Fictional New Table', serviceBands: bands, validFrom: future });
        case 'template-update': return updateEntitlementTemplate(ctx, { lineageId: template.lineageId, name: 'Fictional Renamed Table', validFrom: future });
        case 'template-retire': return retireEntitlementTemplate(ctx, { lineageId: template.lineageId, validTo: stop });
        case 'template-delete': return deleteEntitlementTemplate(ctx, { lineageId: template.lineageId });
        case 'rule-create': return createEligibilityRule(ctx, { name: 'Fictional New Rule', templateLineageId: ruleTemplate.lineageId, criteria: { companyIds: [b.companyId] }, validFrom: future });
        case 'rule-update': return updateEligibilityRule(ctx, { lineageId: rule.lineageId, name: 'Fictional Renamed Rule', validFrom: future });
        case 'rule-retire': return retireEligibilityRule(ctx, { lineageId: rule.lineageId, validTo: stop });
        case 'rule-delete': return deleteEligibilityRule(ctx, { lineageId: rule.lineageId });
        case 'default': return setLeaveTypeDefaultTemplate(ctx, { leaveTypeId: type.id, templateLineageId: template.lineageId });
      }
    };
    const state = async () => ({
      templates: await owner.db.select().from(schema.entitlementTemplate).where(eq(schema.entitlementTemplate.tenantId, b.tenantId)).orderBy(schema.entitlementTemplate.id),
      rules: await owner.db.select().from(schema.entitlementEligibilityRule).where(eq(schema.entitlementEligibilityRule.tenantId, b.tenantId)).orderBy(schema.entitlementEligibilityRule.id),
      types: await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.tenantId, b.tenantId)).orderBy(schema.leaveType.id),
      events: await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
        .where(eq(schema.domainEvent.tenantId, b.tenantId)).orderBy(schema.domainEvent.id),
    });
    const before = await state();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned entitlement handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      await lockLeaveDependenciesTx(tx, b.tenantId, [employee.employmentId]); ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started;
      await expect(mutate()).rejects.toThrow('Leave source is unavailable');
      expect(await state()).toEqual(before);
    } finally { release(); clearTimeout(watchdog); await holder; }
    await mutate();
    const after = await state(), table = after.templates.find(row => row.lineageId === template.lineageId),
      savedRule = after.rules.find(row => row.lineageId === rule.lineageId);
    switch (command) {
      case 'template-create': expect(after.templates.find(row => row.name === 'Fictional New Table')).toBeDefined(); break;
      case 'template-update': expect(table?.name).toBe('Fictional Renamed Table'); break;
      case 'template-retire': expect(table?.validTo).toBe(stop); break;
      case 'template-delete': expect(table).toBeUndefined(); break;
      case 'rule-create': expect(after.rules.find(row => row.name === 'Fictional New Rule')).toBeDefined(); break;
      case 'rule-update': expect(savedRule?.name).toBe('Fictional Renamed Rule'); break;
      case 'rule-retire': expect(savedRule?.validTo).toBe(stop); break;
      case 'rule-delete': expect(savedRule).toBeUndefined(); break;
      case 'default': expect(after.types.find(row => row.id === type.id)?.defaultEntitlementTemplateLineageId).toBe(template.lineageId); break;
    }
    expect(after.events).toHaveLength(before.events.length + 1);
  });
});
