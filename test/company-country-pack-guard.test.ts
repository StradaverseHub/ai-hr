/**
 * F7 — a company may not exist in a country this installation cannot compute.
 *
 * `isoCode()` is a SHAPE check: it uppercases and asserts two letters, so 'ZZ' and 'XX' sail through.
 * A company created (or moved) into a country with no statutory pack fails in two different ways, and
 * the dangerous one is the quiet one:
 *   - PAYROLL fails closed and says so (core/payroll.ts's requirePackFor).
 *   - LEAVE fails SILENT — core/leave.ts's accrual engines do `const pack = packFor(e.country); if
 *     (!pack) continue;`, and the holiday resolver yields an empty calendar. The employee accrues
 *     nothing, forever, and nobody is told.
 *
 * BOTH DOORS ARE TESTED HERE, deliberately. The guard shipped on createCompany alone, and create is the
 * HARDER path to reach a bad country through — its form is a free-text two-letter box, while the edit
 * form (components/company-panel.tsx) is a select over the complete ISO list. "Create as MY, open the
 * panel, pick Singapore, save" would have walked straight around a create-only guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { createCompany, updateCompany } from '../core/admin';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';

describe('F7 — the statutory-pack guard on company country', () => {
  let base: Base;
  let ctx: SessionContext;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ctx = {
      tenantId: base.tenantId,
      userId: base.adminUserId,
      roles: ['hr_admin'],
      grants: [{ role: 'hr_admin', companyId: null }],
    };
  });
  afterAll(async () => {
    await closeAll();
  });

  it('createCompany refuses a country with no registered pack', async () => {
    await expect(
      createCompany(ctx, { legalName: 'Nowhere Sdn Bhd', country: 'ZZ', currency: 'MYR' }),
    ).rejects.toThrow(/pack/i);
    const rows = await owner.db
      .select({ id: schema.company.id })
      .from(schema.company)
      .where(eq(schema.company.legalName, 'Nowhere Sdn Bhd'));
    expect(rows, 'no packless company may be created').toHaveLength(0);
  });

  it('createCompany still accepts a registered country', async () => {
    await createCompany(ctx, { legalName: 'Real Sdn Bhd', country: 'MY', currency: 'MYR' });
    const rows = await owner.db
      .select({ country: schema.company.country })
      .from(schema.company)
      .where(eq(schema.company.legalName, 'Real Sdn Bhd'));
    expect(rows).toHaveLength(1);
    expect(rows[0].country).toBe('MY');
  });

  it('updateCompany refuses MOVING a company into a country with no registered pack', async () => {
    // The seam a create-only guard leaves open, and the one the more discoverable form reaches.
    await expect(
      updateCompany(ctx, { id: base.companyId, legalName: 'Acme', country: 'ZZ', currency: 'MYR' }),
    ).rejects.toThrow(/pack/i);
    const [row] = await owner.db
      .select({ country: schema.company.country, legalName: schema.company.legalName })
      .from(schema.company)
      .where(eq(schema.company.id, base.companyId));
    expect(row.country, 'the company must not have moved').toBe('MY');
    expect(row.legalName, 'and nothing else on the form may have been written either').not.toBe('Acme');
  });

  it('updateCompany still saves an UNCHANGED packless country — legacy rows stay editable', async () => {
    // Guarded on CHANGE, not on every save. A company already sitting in a packless country (legacy
    // data, or a direct insert like the SG fixtures in test/org-holidays.test.ts) must keep being
    // editable: refusing to save its phone number because of its country would be a new outage, not a
    // fix. What is refused is MOVING a company into a jurisdiction we cannot compute.
    const [legacy] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Legacy Pte Ltd', country: 'SG', currency: 'SGD' })
      .returning({ id: schema.company.id });

    await updateCompany(ctx, { id: legacy.id, legalName: 'Legacy Pte Ltd', country: 'SG', currency: 'SGD', city: 'Singapore' });
    const [row] = await owner.db
      .select({ country: schema.company.country, city: schema.company.city })
      .from(schema.company)
      .where(eq(schema.company.id, legacy.id));
    expect(row.country).toBe('SG');
    expect(row.city, 'the unrelated edit must have gone through').toBe('Singapore');
  });
});
