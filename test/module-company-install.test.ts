/**
 * ADR-0077 slice 5 — TOIL's activator, and the per-company install hook.
 *
 * THE BUG THIS PREVENTS is quiet and slow to surface. A tenant buys TOIL; every company it has at that
 * moment gets a policy row. Six weeks later they add company #2 — and without the hook it is born with
 * no TOIL policy, so the config screen is empty and nothing accrues. Nobody connects that to a purchase
 * made last month, and the symptom ("TOIL doesn't work for the new company") points nowhere near it.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { Tx } from '../db/client';
import { createCompany } from '../core/admin';
import { applyModuleChange } from '../scripts/module-change-runner';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // `toil` is a REAL catalog row shipped by the migrations — billable, and depending on core `leave`.
  // The fixture therefore does not define it; it records the SALE, which is what activation requires
  // (D-15). Using the real row on purpose: an invented one would not have caught that a core
  // dependency has no tenant_module row to find.
  await owner.db.insert(schema.subscriptionLine).values({ tenantId: b.tenantId, moduleCode: 'toil' });
});
afterAll(async () => {
  await closeAll();
});

const activate = () =>
  owner.db.transaction((tx) =>
    applyModuleChange(tx as unknown as Tx, {
      id: randomUUID(),
      tenantId: b.tenantId,
      moduleCode: 'toil',
      companyId: null,
      action: 'activate',
      status: 'pending',
      currentStep: null,
      error: null,
      claimedAt: null,
      requestedBy: 'operator@stradaverse.test',
      disposition: null,
      createdAt: new Date(),
      decidedAt: null,
    } as typeof schema.moduleChangeRequest.$inferSelect),
  );

const policiesFor = (companyId: string) =>
  owner.db.select().from(schema.toilPolicy).where(eq(schema.toilPolicy.companyId, companyId));

describe('TOIL activation seeds a disabled-but-present policy', () => {
  it('creates the policy DISABLED — visible module, nothing accruing', async () => {
    const out = await activate();
    const [policy] = await policiesFor(b.companyId);
    expect(policy, 'the config screen has nothing to render without this row').toBeTruthy();
    expect(policy.enabled, 'seeding must not switch a module ON for the customer').toBe(false);
    expect(out.detail.join(' ')).toMatch(/toil_policy: seeded disabled/);
  });

  // D4 again, at the activator level: a customer who configured TOIL keeps their configuration.
  it('leaves an existing policy untouched on reactivation', async () => {
    await activate();
    await owner.db
      .update(schema.toilPolicy)
      .set({ enabled: true, expiryDays: 30 })
      .where(eq(schema.toilPolicy.companyId, b.companyId));

    const out = await activate();
    const [policy] = await policiesFor(b.companyId);
    expect(policy.enabled, 'a reinstall must not switch the module back off').toBe(true);
    expect(policy.expiryDays, 'nor revert an edited default').toBe(30);
    expect(out.detail.join(' ')).toMatch(/already present, left untouched/);
  });
});

// r299 (3fb1a611) — the plan told the reporter "Leave Credit starts switched off … nothing uses it until you do".
describe('a policy saved BEFORE the module was ever installed', () => {
  it('is kept on FIRST install, but its three live switches are turned off for review', async () => {
    await owner.db.insert(schema.toilPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      enabled: true,
      employeeRequestEnabled: true,
      autoAccrueOnApproval: true,
      expiryDays: 45,
    });
    const out = await activate();
    const [policy] = await policiesFor(b.companyId);
    expect(policy.enabled).toBe(false);
    expect(policy.employeeRequestEnabled).toBe(false);
    expect(policy.autoAccrueOnApproval).toBe(false);
    expect(policy.expiryDays, 'every other saved setting is kept').toBe(45);
    expect(out.detail.join(' ')).toMatch(/switched off for review/);
  });

  // r300 — first install is judged across EVERY scope (verifier measured both orders switching a live policy off).
  for (const order of ['tenant-wide, then one company', 'one company, then tenant-wide'] as const) {
    it(`a second activation at a DIFFERENT scope is not a first install (${order})`, async () => {
      const act = (companyId: string | null) =>
        owner.db.transaction((tx) =>
          applyModuleChange(tx as unknown as Tx, {
            id: randomUUID(), tenantId: b.tenantId, moduleCode: 'toil', companyId, action: 'activate', status: 'pending',
            currentStep: null, error: null, claimedAt: null, requestedBy: 'operator@stradaverse.test', disposition: null,
            createdAt: new Date(), decidedAt: null,
          } as typeof schema.moduleChangeRequest.$inferSelect),
        );
      await act(order.startsWith('tenant') ? null : b.companyId);
      await owner.db.update(schema.toilPolicy).set({ enabled: true, employeeRequestEnabled: true }).where(eq(schema.toilPolicy.companyId, b.companyId));
      await act(order.startsWith('tenant') ? b.companyId : null);
      const [policy] = await policiesFor(b.companyId);
      expect(policy.enabled, 'HR switched it on while owning the module; a scope change must not switch it off').toBe(true);
      expect(policy.employeeRequestEnabled).toBe(true);
    });
  }

  it('a REACTIVATION still touches nothing (D4)', async () => {
    await activate();
    await owner.db
      .update(schema.toilPolicy)
      .set({ enabled: true, employeeRequestEnabled: true })
      .where(eq(schema.toilPolicy.companyId, b.companyId));
    await activate();
    const [policy] = await policiesFor(b.companyId);
    expect(policy.enabled).toBe(true);
    expect(policy.employeeRequestEnabled).toBe(true);
  });
});

describe('a company created LATER is born configured', () => {
  it('gives a new company the defaults of every already-active module', async () => {
    await activate();
    const created = await createCompany(adminCtx(b), { legalName: `Second Sdn Bhd ${randomUUID().slice(0, 6)}` });
    const [policy] = await policiesFor(created.id);
    expect(policy, 'company #2 must not be born missing what company #1 got').toBeTruthy();
    expect(policy.enabled).toBe(false);
  });

  it('records what it installed on company.created, so the row is explainable later', async () => {
    await activate();
    const created = await createCompany(adminCtx(b), { legalName: `Third Sdn Bhd ${randomUUID().slice(0, 6)}` });
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, created.id), eq(schema.domainEvent.eventType, 'company.created')));
    expect((ev.payload as { modulesInstalled: string[] }).modulesInstalled).toContain('toil');
  });

  it('installs nothing when the tenant has no active modules', async () => {
    const created = await createCompany(adminCtx(b), { legalName: `Bare Sdn Bhd ${randomUUID().slice(0, 6)}` });
    expect(await policiesFor(created.id)).toHaveLength(0);
  });

  // A grant already scoped to ONE company is not about a different one.
  it('ignores a company-scoped grant when creating another company', async () => {
    await owner.db.insert(schema.tenantModule).values({
      tenantId: b.tenantId,
      moduleCode: 'toil',
      companyId: b.companyId,
      status: 'active',
    });
    const created = await createCompany(adminCtx(b), { legalName: `Scoped Sdn Bhd ${randomUUID().slice(0, 6)}` });
    // The assertion is about the NEW company, not about the tenant's grant inventory: a scoped grant
    // names one company, and creating a different one must not inherit it.
    expect(await policiesFor(created.id)).toHaveLength(0);
    expect(await policiesFor(b.companyId), 'the scoped company is untouched by this path').toHaveLength(0);
  });
});
