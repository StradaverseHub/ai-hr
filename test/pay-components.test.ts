/**
 * Wave 3 #9-2 — pay-component catalog + service. Idempotent seed with the matrix-sourced flags
 * (the backfill-critical codes reproduce the legacy kernel), admin-only catalog writes (RLS), and
 * effective-dated per-employment values.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
} from '../core/pay-components';
import { MY_DEFAULT_PAY_COMPONENTS } from '../localization/my/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('Wave 3 #9-2 — pay-component catalog + service', () => {
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

  it('seeds the MY catalog idempotently with the matrix flags', async () => {
    const a = adminCtx(base);
    const first = await seedPayComponentCatalog(a);
    expect(first.created).toBe(MY_DEFAULT_PAY_COMPONENTS.length);
    const again = await seedPayComponentCatalog(a);
    expect(again.created).toBe(0); // idempotent

    const cat = await listPayComponents(a);
    expect(cat.length).toBe(MY_DEFAULT_PAY_COMPONENTS.length);
    const by = Object.fromEntries(cat.map((c) => [c.code, c]));
    // Backfill-critical flags reproduce the legacy kernel.
    expect(by.BASIC).toMatchObject({ includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: true });
    expect(by.OVERTIME).toMatchObject({ includedInEpf: false, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false });
    expect(by.BONUS).toMatchObject({ includedInEpf: true, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false });
    expect(by.CLAIM).toMatchObject({ includedInEpf: true, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false });
  });

  it('catalog writes are admin-only (RLS)', async () => {
    const manager: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['manager'] };
    await expect(seedPayComponentCatalog(manager)).rejects.toThrow();
  });

  it('effective-dated per-employment component supersedes the prior open value', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const e = await hire(a, base, 'Comp');
    const cat = await listPayComponents(a);
    const basicId = cat.find((c) => c.code === 'BASIC')!.id;

    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 5000, effectiveFrom: '2026-01-01' });
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: basicId, amount: 5500, effectiveFrom: '2026-04-01' });

    const open = await owner.db
      .select()
      .from(schema.employmentPayComponent)
      .where(
        and(
          eq(schema.employmentPayComponent.employmentId, e.employmentId),
          isNull(schema.employmentPayComponent.validTo),
          isNull(schema.employmentPayComponent.supersededAt),
        ),
      );
    expect(open.length).toBe(1);
    expect(Number(open[0].amount)).toBe(5500);
  });
});
