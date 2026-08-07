/**
 * 2ef69d1e — a Back Pay run is COMPANY-SCOPED, on read and on every state transition.
 *
 * WHY THIS FILE EXISTS. The build shipped `tsc`-clean, its own targeted tests green, and with a
 * cross-company hole in four places: the page loaded `backPayRunDetail` without checking the run's
 * company (two lines below a correctly-scoped `listBackPayRuns`), the export route used bare `isAdmin`,
 * all four actions were `requireAdmin()` only, and `calculateBackPayAction` passed a FORM-SUPPLIED
 * companyId straight through. Migration 0413 named `payroll_batch_component` as its RLS precedent while
 * carrying `app.is_admin()` — which is true for an hr_admin grant on ANY company in the tenant.
 *
 * So a Company A admin could read Company B's employee names, codes and per-month salary differences,
 * export them, and cancel the run. The money POST was stopped downstream by payroll_individual_txn's own
 * RLS — but a cancelled run is a real loss to whoever was waiting on it.
 *
 * EVERY ASSERTION HERE IS A REFUSAL. The happy path passing proves nothing about a boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let otherCompanyId: string;
let runId: string;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: `Other ${randomUUID().slice(0, 6)}`, country: 'MY' })
    .returning({ id: schema.company.id });
  otherCompanyId = c.id;
  // A run belonging to the OTHER company, inserted as owner so the fixture itself is not the thing
  // under test.
  const [r] = await owner.db
    .insert(schema.backPayRun)
    .values({
      tenantId: b.tenantId,
      companyId: otherCompanyId,
      targetPayPeriod: '2026-08',
      status: 'draft',
    })
    .returning({ id: schema.backPayRun.id });
  runId = r.id;
});
afterAll(async () => {
  await closeAll();
});

/** An admin scoped to the BASE company only — not to `otherCompanyId`. */
const scopedToBase = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: b.companyId }],
});

/** An admin scoped to the OTHER company — the legitimate owner of the run. */
const scopedToOther = (): SessionContext => ({
  tenantId: b.tenantId,
  userId: b.adminUserId,
  roles: ['hr_admin'],
  grants: [{ role: 'hr_admin', companyId: otherCompanyId }],
});

const readRun = (ctx: SessionContext) =>
  withTenant(ctx, async (tx) => {
    const rows = await tx.execute(sql`select id from back_pay_run where id = ${runId}::uuid`);
    return (rows as unknown as { id: string }[]).length;
  });

describe('2ef69d1e — a back pay run is fenced to its own company', () => {
  it('RLS REFUSES the read: an admin scoped elsewhere sees no row at all', async () => {
    // Not an error — no row. The row simply is not theirs, which is what USING is for.
    expect(await readRun(scopedToBase())).toBe(0);
  });

  it('RLS ALLOWS the read for the company that owns it — the fence is not just "deny everything"', async () => {
    expect(await readRun(scopedToOther())).toBe(1);
  });

  it('RLS REFUSES a cross-company STATE TRANSITION — the half the downstream money guard never covered', async () => {
    const err = await withTenant(scopedToBase(), async (tx) => {
      await tx.execute(sql`update back_pay_run set status = 'cancelled' where id = ${runId}::uuid`);
    }).then(
      () => null,
      (e: Error) => e,
    );
    // An UPDATE that matches no row under USING is not an error — so assert the row DID NOT MOVE.
    const [row] = (await owner.db.execute(
      sql`select status from back_pay_run where id = ${runId}::uuid`,
    )) as unknown as { status: string }[];
    expect(row.status, `cancel from another company must not take effect (err=${err?.message ?? 'none'})`).toBe(
      'draft',
    );
  });

  it('a back_pay_line is fenced THROUGH its run, which is where the company lives', async () => {
    // Asserted on the POLICY rather than through a data round trip, deliberately: back_pay_line needs
    // five NOT NULL columns including a real compensation row, and a fixture that heavy fails on its own
    // constraints long before it reaches the policy — which is exactly how the first version of the case
    // above passed for the wrong reason. The claim here is that the line reaches through its run for the
    // company term, the same shape payroll_batch_component (0065) uses, and that is what this reads.
    const [row] = (await owner.db.execute(
      sql`select pg_get_expr(polqual, polrelid) as q from pg_policy where polname = 'back_pay_line_rls'`,
    )) as unknown as { q: string }[];
    expect(row, 'the line policy must exist').toBeTruthy();
    expect(row.q).toMatch(/back_pay_run/);
    expect(row.q).toMatch(/is_admin_for/);
    expect(row.q, 'a bare is_admin() is the hole this closes').not.toMatch(/is_admin\(\)/);
  });

  it('the page and the export route re-check the company in APPLICATION code, not only in RLS', () => {
    // RLS is the backstop; the house convention (app/payroll/[batchId]/export/route.ts) is that the
    // route re-checks too, so a guessed id 404s identically to one that does not exist and cannot be
    // used to probe which run ids are real. Source-level because that is where the omission was.
    const read = (p: string) => require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', p), 'utf8');
    const page = read('app/payroll/back-pay/page.tsx');
    const route = read('app/payroll/back-pay/export/route.ts');
    const actions = read('app/payroll/back-pay/actions.ts');
    expect(page, 'page must fence the run detail').toMatch(/scopeIds\.includes\(\s*detailRaw\.run\.companyId/);
    expect(route, 'export route must use scopedAdmin, not bare isAdmin').toContain('scopedAdmin()');
    expect(route, 'export route must re-check the company').toMatch(/scopeIds\.includes\(detail\.run\.companyId\)/);
    expect(actions, 'every action resolves the run through the scoped helper').toContain('scopedRun(');
    expect(actions, 'calculate must check the FORM-supplied companyId').toMatch(/scopeIds\.includes\(companyId\)/);
  });
});
