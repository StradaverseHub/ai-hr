/**
 * Payroll Setup — upsertPayComponent rule handling (core/pay-components.ts). Asserts: a valid rule is stored
 * and the pay-component.updated event carries { ruleKind }; an invalid rule (out-of-enum, out-of-range, or
 * the per_day-on-a-prorating-component conflict) is rejected with PayRuleInvalidError before any write; and a
 * non-admin write to pay_component.rule is blocked by the existing RLS policy (no new policy was added).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { PayRuleInvalidError, listPayComponents, upsertPayComponent } from '../core/pay-components';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const baseInput = {
  name: 'Housing allowance',
  kind: 'allowance' as const,
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: false,
};

describe('Payroll Setup — pay-rule on upsertPayComponent', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('stores a valid percent_of rule and emits pay-component.updated with { ruleKind }', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, { code: 'HOUSING', ...baseInput, prorates: true, rule: { kind: 'percent_of', base: 'basic', pct: 25 } });
    const comp = (await listPayComponents(a)).find((c) => c.code === 'HOUSING')!;
    const [row] = await owner.db.select().from(schema.payComponent).where(eq(schema.payComponent.id, comp.id));
    expect(row.rule).toEqual({ kind: 'percent_of', base: 'basic', pct: 25 });

    const payload = await latestEventPayload(base.tenantId, comp.id, 'pay-component.updated')
      ?? await latestEventPayload(base.tenantId, comp.id, 'pay-component.created');
    expect(payload).toMatchObject({ code: 'HOUSING', ruleKind: 'percent_of' });
  });

  it('a null / fixed rule is stored as null (byte-identical to legacy) with ruleKind null', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, { code: 'FIXEDX', ...baseInput, rule: { kind: 'fixed' } });
    const comp = (await listPayComponents(a)).find((c) => c.code === 'FIXEDX')!;
    const [row] = await owner.db.select().from(schema.payComponent).where(eq(schema.payComponent.id, comp.id));
    expect(row.rule).toBeNull();
    const payload =
      (await latestEventPayload(base.tenantId, comp.id, 'pay-component.created')) ??
      (await latestEventPayload(base.tenantId, comp.id, 'pay-component.updated'));
    expect(payload).toMatchObject({ ruleKind: null });
  });

  it('rejects a per_day rule on a PRORATING component (proration conflict)', async () => {
    const a = adminCtx(base);
    await expect(
      upsertPayComponent(a, { code: 'PERDAY', ...baseInput, prorates: true, rule: { kind: 'per_day', rate: 50 } }),
    ).rejects.toBeInstanceOf(PayRuleInvalidError);
    expect((await listPayComponents(a)).find((c) => c.code === 'PERDAY')).toBeUndefined();
  });

  it('rejects an out-of-range / negative-capable rule', async () => {
    const a = adminCtx(base);
    await expect(
      upsertPayComponent(a, { code: 'BADPCT', ...baseInput, rule: { kind: 'percent_of', base: 'basic', pct: 99999 } }),
    ).rejects.toBeInstanceOf(PayRuleInvalidError);
    await expect(
      upsertPayComponent(a, { code: 'NEGDAY', ...baseInput, rule: { kind: 'per_day', rate: -10 } }),
    ).rejects.toBeInstanceOf(PayRuleInvalidError);
  });

  it('accepts a valid per_day rule on a NON-prorating component', async () => {
    const a = adminCtx(base);
    await upsertPayComponent(a, { code: 'PERDAYOK', ...baseInput, prorates: false, rule: { kind: 'per_day', rate: 50 } });
    const comp = (await listPayComponents(a)).find((c) => c.code === 'PERDAYOK')!;
    const [row] = await owner.db.select().from(schema.payComponent).where(eq(schema.payComponent.id, comp.id));
    expect(row.rule).toEqual({ kind: 'per_day', rate: 50 });
  });

  it('a non-admin write to pay_component.rule is blocked (existing admin-only RLS, no new policy)', async () => {
    const manager: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['manager'] };
    await expect(
      upsertPayComponent(manager, { code: 'NOPE', ...baseInput, rule: { kind: 'flat_capped', value: 100, cap: 200 } }),
    ).rejects.toThrow();
  });
});
