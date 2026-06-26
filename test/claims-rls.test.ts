/**
 * Claims RLS (ADR-0021, Slice 1) — the catalog is member-read / admin-write; claim requests + attachments
 * are employment-scoped (subject + administrative manager + admin) via app.can_see_employment.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, setReportingLine } from '../core/org';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('ADR-0021 §5 — claims RLS', () => {
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

  it('claim_type / claim_policy: members read, only admins write', async () => {
    const E = await hire(adminCtx(base), base, 'Emp');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    // Admin can create a claim type.
    const [ct] = await withTenant(adminCtx(base), (tx) =>
      tx.insert(schema.claimType).values({ tenantId: base.tenantId, code: 'MEDICAL', name: 'Medical' }).returning({ id: schema.claimType.id }),
    );
    expect(ct.id).toBeTruthy();

    // A non-admin can READ it…
    const seen = await withTenant(empCtx, (tx) => tx.select().from(schema.claimType));
    expect(seen.map((r) => r.code)).toContain('MEDICAL');

    // …but cannot WRITE the catalog (WITH CHECK requires app.is_admin()).
    await expect(
      withTenant(empCtx, (tx) => tx.insert(schema.claimType).values({ tenantId: base.tenantId, code: 'TRAVEL', name: 'Travel' })),
    ).rejects.toThrow();
    await expect(
      withTenant(empCtx, (tx) =>
        tx.insert(schema.claimPolicy).values({ tenantId: base.tenantId, claimTypeId: ct.id, validFrom: '2026-01-01' }),
      ),
    ).rejects.toThrow();
  });

  it('a claim request is visible to the subject + manager + admin, not a peer', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Subject');
    const M = await hire(a, base, 'Manager');
    const X = await hire(a, base, 'Peer');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });

    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: 'MEDICAL', name: 'Medical' })
      .returning({ id: schema.claimType.id });
    const [claim] = await owner.db
      .insert(schema.claimRequest)
      .values({ tenantId: base.tenantId, employmentId: E.employmentId, claimTypeId: ct.id, amount: '120.00', incurredOn: '2026-06-01' })
      .returning({ id: schema.claimRequest.id });
    await owner.db.insert(schema.claimAttachment).values({
      tenantId: base.tenantId,
      claimRequestId: claim.id,
      employmentId: E.employmentId,
      content: Buffer.from('receipt'),
      fileName: 'r.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 7,
    });

    const sees = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select().from(schema.claimRequest).where(eq(schema.claimRequest.employmentId, E.employmentId)));
    const seesAttach = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select().from(schema.claimAttachment).where(eq(schema.claimAttachment.claimRequestId, claim.id)));

    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'] };

    expect((await sees(empCtx)).length).toBe(1); // own
    expect((await sees(mgrCtx)).length).toBe(1); // manager
    expect((await sees(a)).length).toBe(1); // admin
    expect((await sees(peerCtx)).length).toBe(0); // peer: blocked

    expect((await seesAttach(empCtx)).length).toBe(1);
    expect((await seesAttach(peerCtx)).length).toBe(0);
  });

  it('claim_item: members read, only admins write; a different tenant is blocked', async () => {
    const E = await hire(adminCtx(base), base, 'Emp');
    const uE = await createAppUser(base.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'] };

    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: 'TRAVEL', name: 'Travel' })
      .returning({ id: schema.claimType.id });

    // Admin can create a claim item.
    const [it] = await withTenant(adminCtx(base), (tx) =>
      tx.insert(schema.claimItem).values({ tenantId: base.tenantId, claimTypeId: ct.id, code: 'PARKING', name: 'Parking' }).returning({ id: schema.claimItem.id }),
    );
    expect(it.id).toBeTruthy();

    // A non-admin can READ it…
    const seen = await withTenant(empCtx, (tx) => tx.select().from(schema.claimItem));
    expect(seen.map((r) => r.code)).toContain('PARKING');

    // …but cannot WRITE the catalog (WITH CHECK requires app.is_admin()).
    await expect(
      withTenant(empCtx, (tx) => tx.insert(schema.claimItem).values({ tenantId: base.tenantId, claimTypeId: ct.id, code: 'TOLL', name: 'Toll' })),
    ).rejects.toThrow();

    // A different tenant cannot see it (tenant isolation).
    const other = await seedBase();
    const otherSees = await withTenant(adminCtx(other), (tx) => tx.select().from(schema.claimItem));
    expect(otherSees.length).toBe(0);
  });

  it('a different tenant cannot see the claim', async () => {
    const other = await seedBase();
    const E = await hire(adminCtx(base), base, 'Subject');
    const [ct] = await owner.db
      .insert(schema.claimType)
      .values({ tenantId: base.tenantId, code: 'MEDICAL', name: 'Medical' })
      .returning({ id: schema.claimType.id });
    await owner.db
      .insert(schema.claimRequest)
      .values({ tenantId: base.tenantId, employmentId: E.employmentId, claimTypeId: ct.id, amount: '50.00', incurredOn: '2026-06-01' });

    const rows = await withTenant(adminCtx(other), (tx) => tx.select().from(schema.claimRequest));
    expect(rows.length).toBe(0);
  });
});
