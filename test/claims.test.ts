/**
 * Claims catalog + policy service (ADR-0021, Slice 2) — CRUD + domain events + effective-dated budgets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import {
  archiveClaimType,
  createClaimType,
  getActiveClaimPolicy,
  listClaimTypes,
  setClaimPolicy,
  updateClaimType,
} from '../core/claims';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, resetDb, seedBase, type Base } from './harness';

describe('ADR-0021 — claims catalog + policy', () => {
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

  it('creates / updates / archives a claim type with events', async () => {
    const { id } = await createClaimType(adminCtx(base), { code: 'medical', name: 'Medical', defaultTaxable: false, requiresReceipt: true });
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-type.created');

    let list = await listClaimTypes(adminCtx(base));
    expect(list.find((t) => t.code === 'MEDICAL')?.name).toBe('Medical'); // code upper-cased
    expect(list[0].policy).toBeNull();

    await updateClaimType(adminCtx(base), { id, name: 'Medical & Dental', defaultTaxable: false, requiresReceipt: false });
    list = await listClaimTypes(adminCtx(base));
    expect(list.find((t) => t.id === id)?.name).toBe('Medical & Dental');
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-type.updated');

    await archiveClaimType(adminCtx(base), id);
    list = await listClaimTypes(adminCtx(base));
    expect(list.find((t) => t.id === id)).toBeUndefined(); // archived → excluded
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-type.archived');
  });

  it('resolves the effective-dated budget policy (latest validFrom ≤ asOf)', async () => {
    const { id } = await createClaimType(adminCtx(base), { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: true });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 5000, perClaimCap: 500, effectiveFrom: '2026-01-01' });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 6000, perClaimCap: 600, effectiveFrom: '2026-06-01' });

    const at = (asOf: string) => withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, id, asOf));
    expect((await at('2026-03-01'))?.annualBudget).toBe(5000); // first version
    expect((await at('2026-07-01'))?.annualBudget).toBe(6000); // second supersedes
    expect((await at('2025-12-01'))).toBeNull(); // before any policy

    // The active policy surfaces in the catalog list.
    const t = (await listClaimTypes(adminCtx(base), { asOf: '2026-07-01' })).find((x) => x.id === id);
    expect(t?.policy?.annualBudget).toBe(6000);
    expect(t?.policy?.perClaimCap).toBe(600);
  });

  it('rejects a negative budget/cap', async () => {
    const { id } = await createClaimType(adminCtx(base), { code: 'MEALS', name: 'Meals', defaultTaxable: true, requiresReceipt: true });
    await expect(setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: -1, perClaimCap: null, effectiveFrom: '2026-01-01' })).rejects.toThrow();
  });
});
