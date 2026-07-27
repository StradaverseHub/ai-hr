/**
 * Fixed Transaction screen action (feedback b7fc8583) — the createFixedTransactionAction scope-tamper guard.
 * Company scope is an APPLICATION concern (RLS only isolates tenants), so without the action's re-validation
 * an admin could cross-company write by URL-tampering the ?employmentId=. This asserts an out-of-scope id is
 * rejected (redirect ?error=outOfScope, NO write) while an in-scope id writes the row + the cycle.
 *
 * next/navigation redirect + next/cache are stubbed inert (the action returns at each back() so it does not
 * fall through). lib/scope.scopedAdmin is stubbed to a session whose scopeIds cover only company A.
 *
 * TYPED PAY COMPONENTS (ADR-0077 slice 3) — WHY THERE IS NO GATE CALL IN THIS FILE.
 * The beforeEach/afterEach used to clear the TYPED_PAY_COMPONENTS_ENABLED flag (spelled without the
 * `process.env.` prefix on purpose: the slice-3 worklist scan in test/module-catalog-drift.test.ts greps
 * this tree for env-gate mutations, and a comment quoting one verbatim would re-list this file as still
 * unconverted). Those two lines are DELETED rather than translated into a setModule() call, and the
 * reason is stronger than "a missing row is already disabled":
 *
 *   nothing on this file's code path reads that gate at all. `createFixedTransactionAction` →
 *   `listEmployees` (the scope re-validation) → `setEmploymentPayComponent` contain no
 *   `isModuleEnabled` check; the typed-components gate lives on the payroll KERNEL (core/payroll.ts
 *   earningsOf / pre-processing) and on the Fixed Transaction PAGE's read model
 *   (app/payroll/transactions/fixed/page.tsx), neither of which this file exercises. The env writes were
 *   therefore inert hygiene even before slice 3, and both assertions below (the out-of-scope refusal and
 *   the in-scope write) are decided purely by the scope guard.
 *
 * Consequently the OFF state is now the fixture baseline by construction: seedBase seeds no
 * `tenant_module` row for this code under the suite's env, a missing row is disabled (C7), and resetDb()
 * truncates `tenant_module` between tests so nothing can leak in from an earlier file.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
