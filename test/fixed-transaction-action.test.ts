/**
 * Fixed Transaction screen action (feedback b7fc8583) — the createFixedTransactionAction scope-tamper guard.
 * Company scope is an APPLICATION concern (RLS only isolates tenants), so without the action's re-validation
 * an admin could cross-company write by URL-tampering the ?employmentId=. This asserts an out-of-scope id is
 * rejected (redirect ?error=outOfScope, NO write) while an in-scope id writes the row + the cycle.
 *
 * next/navigation redirect + next/cache are stubbed inert (the action returns at each back() so it does not
 * fall through). lib/scope.scopedAdmin is stubbed to a session whose scopeIds cover only company A.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factories (hoisted to top-of-file) can reference them safely.
const { redirect, scope } = vi.hoisted(() => ({
  redirect: vi.fn((_url: string) => undefined),
  // scopedAdmin is stubbed per-test (mutable holder) so each test controls s + scopeIds.
  scope: { s: null as unknown, scopeIds: [] as string[] },
}));
vi.mock('next/navigation', () => ({ redirect, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));

import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { listPayComponents, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createFixedTransactionAction } from '../app/payroll/transactions/fixed/actions';

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function codeId(ctx: SessionContext, code: string): Promise<string> {
  const cat = await listPayComponents(ctx);
  return cat.find((c) => c.code === code)!.id;
}

describe('Fixed Transaction action — scope guard', () => {
  let base: Base;
  let companyB: string;
  let deptB: string;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    // A SECOND company in the same tenant, with its own department — the out-of-scope target.
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' })
      .returning({ id: schema.company.id });
    companyB = c.id;
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: companyB, name: 'Beta Ops' })
      .returning({ id: schema.department.id });
    deptB = d.id;
    redirect.mockClear();
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterEach(() => {
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('rejects an out-of-scope employmentId (redirect error=outOfScope, no row written)', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    // An employee in company B; the admin is scoped to company A only.
    const emp = await hireEmployee(a, {
      person: { fullName: 'Beta One', primaryEmail: `beta${randomUUID()}@acme.test` },
      companyId: companyB,
      departmentId: deptB,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const allowId = await codeId(a, 'ALLOWANCE');
    scope.s = a;
    scope.scopeIds = [base.companyId]; // company A only — company B is out of scope

    await createFixedTransactionAction(
      fd({ employmentId: emp.employmentId, componentId: allowId, runType: 'regular', amount: '100', effectiveFrom: '2026-01-01' }),
    );

    // Redirected with the scope error, and NOTHING was written for that employment.
    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('error=outOfScope'));
    const rows = await owner.db
      .select()
      .from(schema.employmentPayComponent)
      .where(eq(schema.employmentPayComponent.employmentId, emp.employmentId));
    expect(rows).toHaveLength(0);
  });

  it('writes the fixed transaction (with cycle) for an in-scope employmentId', async () => {
    const a = adminCtx(base);
    await seedPayComponentCatalog(a);
    const emp = await hireEmployee(a, {
      person: { fullName: 'Alpha One', primaryEmail: `alpha${randomUUID()}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const allowId = await codeId(a, 'ALLOWANCE');
    scope.s = a;
    scope.scopeIds = [base.companyId];

    await createFixedTransactionAction(
      fd({ employmentId: emp.employmentId, componentId: allowId, runType: 'bonus', amount: '250', effectiveFrom: '2026-01-01' }),
    );

    expect(redirect).toHaveBeenCalledWith(expect.stringContaining('toast=saved'));
    const rows = await owner.db
      .select()
      .from(schema.employmentPayComponent)
      .where(
        and(
          eq(schema.employmentPayComponent.employmentId, emp.employmentId),
          eq(schema.employmentPayComponent.componentId, allowId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(250, 2);
    expect(rows[0].runType).toBe('bonus');
  });
});
