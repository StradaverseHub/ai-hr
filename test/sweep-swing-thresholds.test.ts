/**
 * The scheduled anomaly sweep judges each company by its OWN net-swing threshold (owner follow-on to the 11 November
 * 2026 interim; draft migration 9760 app.sweep_swing_thresholds). The sweep runs with no login, so row security hides the
 * Salary payroll loop setting from it; the narrow reader returns the threshold of each requested company's latest setting
 * version, for the session's own tenant, to a system session only, and nothing else.
 *
 * Proven here against a real database: two companies with different thresholds in ONE sweep run, the 15% default for a
 * company with no setting, the reader's shape and privileges, no cross-tenant answer, no answer to a login, and one
 * set-wise call over 70+ companies equal to the row-secured reader an administrator uses.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { terasPayrollLoopSetting } from '../db/teras-payroll-cycle-schema';
import { withTenant, type SessionContext } from '../db/client';
import { payrollLoopSettingsTx } from '../core/loops/payroll-loop-settings';
import { thresholdsInForce } from '../core/payroll-anomaly';
import { anomalySweep } from '../scripts/anomaly-sweep';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base, other: Base, admin: SessionContext, sweep: SessionContext, otherSweep: SessionContext;
let companyA: string, companyB: string, companyC: string;

async function addCompany(tenantId: string, legalName: string) {
  const [c] = await owner.db.insert(schema.company).values({ tenantId, legalName }).returning({ id: schema.company.id });
  return c.id;
}

const setThreshold = (base: Base, companyId: string, version: number, thresholdBp: number) =>
  owner.db.insert(terasPayrollLoopSetting).values({
    tenantId: base.tenantId, companyId, version, checkInterval: 'daily', swingThresholdBp: thresholdBp, swingExclusions: [],
    remindersEnabled: true, source: 'admin', changedByUserId: base.adminUserId,
  });

async function makeBatch(companyId: string, period: string, status: 'processed' | 'closed') {
  const [pp] = await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId, period, status: 'open' })
    .returning({ id: schema.payPeriod.id });
  const [batch] = await owner.db.insert(schema.payrollBatch).values({
    tenantId: b.tenantId, companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-28`, status,
    ...(status === 'closed' ? { closedAt: new Date() } : {}),
  }).returning({ id: schema.payrollBatch.id });
  return batch.id;
}

const slip = (batchId: string, employmentId: string, netPay: string) => ({
  tenantId: b.tenantId, batchId, employmentId, basicSalary: '5000.00', grossPay: '5000.00', totalDeductions: '800.00', netPay,
  employerCost: '5700.00', daysWorked: '31.00', statutory: { epfEmployee: 550, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 215 },
});

/** A closed April and a processed May for one company, with one person per May net pay (April paid 4,000 each). */
async function companyRun(companyId: string, mayNetPays: string[]) {
  const april = await makeBatch(companyId, '2026-04', 'closed');
  const may = await makeBatch(companyId, '2026-05', 'processed');
  const employments: string[] = [];
  for (const [i, current] of mayNetPays.entries()) {
    const [p] = await owner.db.insert(schema.person).values({ tenantId: b.tenantId, fullName: `Mover ${i}`, primaryEmail: `${randomUUID()}@sweep.test` })
      .returning({ id: schema.person.id });
    await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: b.tenantId, personId: p.id, bankName: 'Maybank', bankAccountNo: '1234567890' });
    const [e] = await owner.db.insert(schema.employment).values({ tenantId: b.tenantId, personId: p.id, companyId, hiredOn: '2020-01-01', paymentMethod: 'bank_transfer' })
      .returning({ id: schema.employment.id });
    await owner.db.insert(schema.attendance).values({ tenantId: b.tenantId, employmentId: e.id, attendanceDate: '2026-05-04', workedMinutes: 480 });
    await owner.db.insert(schema.payslip).values(slip(april, e.id, '4000.00'));
    await owner.db.insert(schema.payslip).values(slip(may, e.id, current));
    employments.push(e.id);
  }
  return { may, employments };
}

/** The net-swing facts of each employment's live verdict in one batch. */
async function swingFacts(batchId: string) {
  const out = new Map<string, Record<string, string | number>>();
  const verdicts = await owner.db.select().from(schema.payrollAnomalyVerdict)
    .where(and(eq(schema.payrollAnomalyVerdict.batchId, batchId), isNull(schema.payrollAnomalyVerdict.supersededAt)));
  for (const v of verdicts) {
    const findings = await owner.db.select().from(schema.payrollAnomalyFinding).where(eq(schema.payrollAnomalyFinding.verdictId, v.id));
    for (const f of findings) if (f.detectorId === 'net-swing') out.set(v.employmentId, f.facts as Record<string, string | number>);
  }
  return out;
}

const read = (ctx: SessionContext, companies: string[]) =>
  withTenant(ctx, (tx) => tx.execute(sql`select * from app.sweep_swing_thresholds(${`{${companies.join(',')}}`}::uuid[]) order by company_id`))
    .then((rows) => [...(rows as unknown as Record<string, unknown>[])]);

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  other = await seedBase();
  admin = await entitledCtx(b);
  const entitlements = admin.entitlements;
  // The sweep's own carrier (scripts/anomaly-sweep.ts): no login, no agent, the group-wide hr_admin role.
  sweep = { tenantId: b.tenantId, roles: ['hr_admin'], entitlements };
  otherSweep = { tenantId: other.tenantId, roles: ['hr_admin'], entitlements: (await entitledCtx(other)).entitlements };
  companyA = b.companyId;
  companyB = await addCompany(b.tenantId, 'Beta Sdn Bhd');
  companyC = await addCompany(b.tenantId, 'Gamma Sdn Bhd');
  await setThreshold(b, companyA, 1, 1000);
  // Company B tightened to 5%, then set 25%: the latest version is the one in force.
  await setThreshold(b, companyB, 1, 500);
  await setThreshold(b, companyB, 2, 2500);
  // Another tenant's company carries a setting the first tenant must never be answered with.
  await setThreshold(other, other.companyId, 1, 4000);
});
afterAll(closeAll);

describe('the scheduled sweep uses each company\'s own net-swing threshold', () => {
  it('judges company A at its 10% and company B at its 25% in the same run, and an unset company at 15%', async () => {
    // +12%: over A's 10%; +20%: inside B's 25%, +30% over it; C (no setting): +12% inside 15%, +20% over it.
    const a = await companyRun(companyA, ['4480.00']);
    const bRun = await companyRun(companyB, ['4800.00', '5200.00']);
    const c = await companyRun(companyC, ['4480.00', '4800.00']);

    const out = await anomalySweep(process.env.TEST_MIGRATION_DATABASE_URL!);
    expect(out.failures).toBe(0);
    expect(out.batches).toBeGreaterThanOrEqual(3);

    const inA = await swingFacts(a.may);
    expect(inA.get(a.employments[0])).toMatchObject({ thresholdPct: 10, thresholdSource: 'company', movementPct: 12 });

    const inB = await swingFacts(bRun.may);
    expect(inB.has(bRun.employments[0])).toBe(false);
    expect(inB.get(bRun.employments[1])).toMatchObject({ thresholdPct: 25, thresholdSource: 'company', movementPct: 30 });

    // The fallback: no setting for C, so the 15% default — read, not "unreadable".
    const inC = await swingFacts(c.may);
    expect(inC.has(c.employments[0])).toBe(false);
    expect(inC.get(c.employments[1])).toMatchObject({ thresholdPct: 15, thresholdSource: 'company', movementPct: 20 });

    // The disclosure on the run's page says the same as the sweep's findings.
    const net = async (batchId: string) => (await thresholdsInForce(sweep, { batchId })).thresholds.find((t) => t.detectorId === 'net-swing');
    expect(await net(a.may)).toMatchObject({ params: { netSwingPct: 10 }, source: 'configured' });
    expect(await net(bRun.may)).toMatchObject({ params: { netSwingPct: 25 }, source: 'configured' });
    expect(await net(c.may)).toMatchObject({ params: { netSwingPct: 15 }, source: 'untuned_default' });
  });
});

describe('app.sweep_swing_thresholds discloses only the threshold, to the sweep, for its own tenant', () => {
  it('is a narrow definer function returning only company and threshold, executable by the app role alone', async () => {
    const [fn] = await owner.client<{ definer: boolean; volatility: string; config: string[] | null; result: string; public_exec: boolean; app_exec: boolean }[]>`
      select p.prosecdef as definer, p.provolatile as volatility, p.proconfig as config, pg_get_function_result(p.oid) as result,
        has_function_privilege('public', p.oid, 'EXECUTE') as public_exec, has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') as app_exec
      from pg_proc p where p.oid = 'app.sweep_swing_thresholds(uuid[])'::regprocedure`;
    expect(fn).toMatchObject({ definer: true, volatility: 's', public_exec: false, app_exec: true, result: 'TABLE(company_id uuid, threshold_bp integer)' });
    expect(fn.config?.join(',').replace(/\s/g, '')).toContain('search_path=pg_catalog,public,pg_temp');

    const rows = await read(sweep, [companyA, companyB, companyC]);
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([['company_id', 'threshold_bp'], ['company_id', 'threshold_bp']]);
    expect(new Map(rows.map((r) => [r.company_id, r.threshold_bp]))).toEqual(new Map([[companyA, 1000], [companyB, 2500]]));
  });

  it('never answers with another tenant\'s company, in either direction', async () => {
    expect(await read(sweep, [other.companyId])).toEqual([]);
    expect((await read(sweep, [companyA, other.companyId])).map((r) => r.company_id)).toEqual([companyA]);
    expect(await read(otherSweep, [companyA, companyB])).toEqual([]);
    expect(await read(otherSweep, [other.companyId])).toEqual([{ company_id: other.companyId, threshold_bp: 4000 }]);
  });

  it('answers no login (they keep their own row-secured read) and no empty or oversized request', async () => {
    expect(await read(admin, [companyA, companyB])).toEqual([]);
    expect(await read(sweep, [])).toEqual([]);
    expect(await read(sweep, Array.from({ length: 501 }, (_, i) => (i === 0 ? companyA : randomUUID())))).toEqual([]);
  });

  it('answers 70+ companies in one call, equal to the administrator\'s row-secured reader', async () => {
    const many: string[] = [];
    for (let i = 0; i < 72; i++) many.push(await addCompany(b.tenantId, `Group Company ${i}`));
    for (const [i, id] of many.entries()) {
      if (i % 9 === 0) continue; // some companies have never been set
      await setThreshold(b, id, 1, 100 + i * 10);
      if (i % 4 === 0) await setThreshold(b, id, 2, 3000 + i);
    }
    const all = [companyA, companyB, companyC, ...many];
    const rows = await read(sweep, all);
    const fromReader = new Map(rows.map((r) => [r.company_id as string, r.threshold_bp as number]));
    const settings = await withTenant(admin, (tx) => payrollLoopSettingsTx(tx, b.tenantId, all));
    const fromAdmin = new Map([...settings.values()].filter((s) => s.version > 0).map((s) => [s.companyId, s.thresholdBp]));
    expect(fromReader.size).toBe(2 + 64);
    expect(fromReader).toEqual(fromAdmin);
  });
});
