/**
 * ADR-0077 slice 6 — country modules granted to the tenants that already operate them.
 *
 * SHIPPED INERT: nothing resolves against `country-*` rows yet. These assertions are about the grant
 * being correct and repeatable, so the slice that DOES read them starts from trustworthy data.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { backfillCountryModules, countryModuleCode } from '../scripts/backfill-country-modules';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const url = process.env.TEST_MIGRATION_DATABASE_URL!;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const countryRows = () =>
  owner.db
    .select()
    .from(schema.tenantModule)
    .where(and(eq(schema.tenantModule.moduleCode, 'country-my'), isNull(schema.tenantModule.companyId)));

describe('countryModuleCode', () => {
  // 'MY' and 'my' must not become two modules — the code is the join key.
  it('lower-cases and trims so one country is one module', () => {
    expect(countryModuleCode('MY')).toBe('country-my');
    expect(countryModuleCode(' my ')).toBe('country-my');
  });
});

describe('backfillCountryModules', () => {
  it('grants the tenant a TENANT-WIDE row for the country its company operates in', async () => {
    const r = await backfillCountryModules(url);
    expect(r.granted).toBeGreaterThan(0);
    const rows = await countryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId, 'the entitlement is "may operate MY", not "this company is MY"').toBeNull();
    expect(rows[0].status).toBe('active');
  });

  // It runs on EVERY deploy, so a second pass must be a no-op rather than a duplicate.
  it('is idempotent — a second run grants nothing and duplicates nothing', async () => {
    await backfillCountryModules(url);
    const second = await backfillCountryModules(url);
    expect(second.granted).toBe(0);
    expect(second.alreadyPresent).toBeGreaterThan(0);
    expect(await countryRows()).toHaveLength(1);
  });

  // Several companies in one country are one entitlement, not one per company.
  it('grants ONE row however many companies share the country', async () => {
    await owner.db.insert(schema.company).values({
      tenantId: b.tenantId,
      legalName: `Second ${randomUUID().slice(0, 6)}`,
      country: 'MY',
      currency: 'MYR',
    });
    const r = await backfillCountryModules(url);
    expect(r.granted).toBe(1);
    expect(await countryRows()).toHaveLength(1);
  });

  /**
   * A company whose country has no registered pack is REPORTED, not granted and not fatal. That set is
   * the input to slice 6's non-statutory tier; failing the deploy on it today would block a release
   * over a state nobody currently has a way to resolve.
   */
  it('reports a company whose country has no pack, and grants it nothing', async () => {
    await owner.db.insert(schema.company).values({
      tenantId: b.tenantId,
      legalName: 'Bangkok Plant',
      country: 'TH',
      currency: 'THB',
    });
    const r = await backfillCountryModules(url);
    expect(r.unpacked.map((u) => u.country)).toContain('TH');
    const th = await owner.db
      .select()
      .from(schema.tenantModule)
      .where(eq(schema.tenantModule.moduleCode, 'country-th'));
    expect(th, 'no pack means no entitlement — silently granting one would be worse').toHaveLength(0);
  });
});
