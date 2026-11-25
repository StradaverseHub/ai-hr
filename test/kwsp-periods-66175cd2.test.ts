/**
 * Board 66175cd2 (plan r1, commit 1) — THE OPEN FORM STEP LISTS ONLY THE MONTHS A KWSP FORM CAN BE PRODUCED FOR.
 *
 * Against a real database, because the claim is about a query: Borang A and BBCD declare `availablePeriods`
 * (localization/my/epf-periods.ts), reached through `reportAvailablePeriods` (core/reporting.ts). Pinned here:
 *
 *  1. EQUIVALENCE WITH THE FORM. Every listed month has a processed payroll cycle (the Payroll Cycle list is
 *     not empty) and produces a Borang A with money on it; every month that is NOT listed is one the form
 *     refuses — no processed cycle, or nothing to file. Checked month by month over two whole years, against
 *     the real generator, so the list and the form cannot drift apart.
 *  2. THE PREDICATE: a draft run, a processed run whose payslips carry no EPF (everybody exempt) and another
 *     company's months are not listed. Newest first.
 *  3. FAILS CLOSED with one answer: a company outside the caller's scope, an unknown form, a form that declares
 *     no list (CP39) and an empty scope all answer [].
 *  4. AT THE SHAPE OF A GROUP (docs/SCALE-AND-RELEASE-RULES.md rule 3): on the fictional 71-company /
 *     1,000-employment fixture, under "All companies" (group administrator) and under one company, every
 *     company's list equals the expected months written down from the fixture plan, and a company with twelve
 *     months costs exactly the statements of a company with none — one set-based read, no per-month loop.
 *
 * All names and numbers are fictional.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { client, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { reportAvailablePeriods, reportPreview } from '../core/reporting';
import { listFilableRunsForPeriod } from '../core/payroll-view';
import { borangAHasContributions } from '../app/payroll/borang-a/query';
import { buildScaleFixture, type ScaleFixture } from './helpers/ai-centre-scale-fixture';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);

const periodsOf = (ctx: SessionContext, companyIds: readonly string[], companyId: string, reportId = 'my.borang-a') =>
  reportAvailablePeriods(ctx, { companyIds, companyId, reportId });

describe('the period list, against the real Borang A', () => {
  let seq = 0;
  const people: { personId: string; employmentId: string; ic: string; epfNumber: string }[] = [];

  async function hire(name: string) {
    seq += 1;
    const a = adminCtx(b);
    const E = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `kp_${seq}_${randomUUID().slice(0, 6)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      positionId: b.positionId,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 4200 + seq * 100, effectiveFrom: '2024-01-01' });
    const ic = `90010101${String(1000 + seq)}`;
    const epfNumber = String(17000000 + seq);
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: ic, epfNumber, taxCategory: 1, numChildren: 0 });
    people.push({ personId: E.personId, employmentId: E.employmentId, ic, epfNumber });
  }

  async function processed(period: string) {
    const a = adminCtx(b);
    const batch = await createBatch(a, { companyId: b.companyId, payPeriod: period });
    await generatePayslips(a, { batchId: batch.batchId });
  }

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    people.length = 0;
    await setCompanyStatutoryMY(adminCtx(b), { companyId: b.companyId, epfEmployerNo: '019632261' });
    await hire('CONTOH SATU BINTI DUA');
    await hire('CONTOH TIGA BIN EMPAT');
    // Three months with EPF, across two years.
    await processed('2025-12');
    await processed('2026-03');
    await processed('2026-05');
    // A month that RAN but charged nobody EPF: both people exempt from June.
    for (const p of people) {
      await setStatutoryProfileMY(adminCtx(b), {
        personId: p.personId,
        icNumber: p.ic,
        epfNumber: p.epfNumber,
        taxCategory: 1,
        numChildren: 0,
        epfMode: 'exempt',
      });
    }
    await processed('2026-06');
    // A month that was opened and never processed: a draft run with no payslip.
    await createBatch(adminCtx(b), { companyId: b.companyId, payPeriod: '2026-07' });
  }, 120_000);

  it('lists the processed EPF months, newest first, and nothing else', async () => {
    const a = adminCtx(b);
    expect(await periodsOf(a, [b.companyId], b.companyId)).toEqual(['2026-05', '2026-03', '2025-12']);
    // BBCD is the cover of the same Borang A: the same list.
    expect(await periodsOf(a, [b.companyId], b.companyId, 'my.borang-bbcd')).toEqual(['2026-05', '2026-03', '2025-12']);
  });

  it('every listed month produces a Borang A, and every unlisted month is one the form refuses', async () => {
    const a = adminCtx(b);
    const listed = new Set(await periodsOf(a, [b.companyId], b.companyId));
    expect(listed.size).toBe(3);
    const months = ['2025', '2026'].flatMap((y) => Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`));
    let producible = 0;
    let refused = 0;
    for (const periodKey of months) {
      // The criteria step's own gate (borang-a/preview/page.tsx): a processed cycle, then something to file.
      const runs = await listFilableRunsForPeriod(a, { companyIds: [b.companyId], companyId: b.companyId, periodKey });
      const form = runs.length > 0 ? await reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey }) : null;
      const opens = form !== null && form.meta.hasBatch === true && borangAHasContributions(form.rows);
      expect(opens, `${periodKey}: listed=${listed.has(periodKey)} but the form ${opens ? 'opens' : 'refuses'}`).toBe(listed.has(periodKey));
      if (opens) producible += 1;
      else refused += 1;
    }
    expect(producible).toBe(3);
    expect(refused).toBe(21);
    // The two months that look closest to filable are refused by name: June ran with no EPF ("nothing to
    // file"), July is a draft with no processed cycle ("no processed payroll cycle").
    const june = await reportPreview(a, { companyId: b.companyId, reportId: 'my.borang-a', periodKey: '2026-06' });
    expect(june.meta.hasBatch).toBe(true);
    expect(borangAHasContributions(june.rows)).toBe(false);
    expect(await listFilableRunsForPeriod(a, { companyIds: [b.companyId], companyId: b.companyId, periodKey: '2026-07' })).toEqual([]);
  });

  it('keeps another company’s months out, and fails closed with one answer', async () => {
    const a = adminCtx(b);
    // A second fictional company with one processed EPF month of its own, written as the owner.
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Contoh Lain Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [person] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'CONTOH LIMA', primaryEmail: `kp_other_${randomUUID().slice(0, 6)}@t.local` })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: person.id, companyId: other.id, employeeCode: 'CL-1', hiredOn: '2024-01-01' })
      .returning({ id: schema.employment.id });
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: other.id, period: '2026-09', status: 'open' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({ tenantId: b.tenantId, companyId: other.id, payPeriodId: pp.id, payPeriod: '2026-09', runSeq: 1, runType: 'regular', batchDate: '2026-09-28', status: 'closed' })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: emp.id,
      basicSalary: '3000.00',
      grossPay: '3000.00',
      totalDeductions: '330.00',
      netPay: '2670.00',
      employerCost: '3390.00',
      statutory: { epfEmployee: 330, epfEmployer: 390 },
    });

    // Each company sees its own months only; a CLOSED run counts as processed.
    expect(await periodsOf(a, [b.companyId, other.id], other.id)).toEqual(['2026-09']);
    expect(await periodsOf(a, [b.companyId, other.id], b.companyId)).toEqual(['2026-05', '2026-03', '2025-12']);
    // FAILS CLOSED, one answer for every refusal.
    expect(await periodsOf(a, [b.companyId], other.id), 'out of scope').toEqual([]);
    expect(await periodsOf(a, [], b.companyId), 'empty scope').toEqual([]);
    expect(await periodsOf(a, [b.companyId], b.companyId, 'my.nope'), 'unknown form').toEqual([]);
    expect(await periodsOf(a, [b.companyId], b.companyId, 'my.cp39'), 'a form with no period list').toEqual([]);
    expect(await periodsOf(a, [b.companyId], b.companyId, 'my.epf'), 'the EPF listing declares none').toEqual([]);
  });
});

// ── At the shape of a group ───────────────────────────────────────────────────────────────────────────

type Trace = { statements: number };
async function traced<T>(run: () => Promise<T>): Promise<{ value: T; trace: Trace }> {
  const options = client.options as { debug?: unknown };
  const previous = options.debug;
  const trace: Trace = { statements: 0 };
  options.debug = () => {
    trace.statements++;
  };
  try {
    return { value: await run(), trace };
  } finally {
    options.debug = previous;
  }
}

const YEAR_2025 = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);

describe('at the shape of a 71-company group', () => {
  let fx: ScaleFixture;
  /** The months each company SHOULD list, written down from the plan below — never read back from the query. */
  const expected = new Map<string, string[]>();
  let busiest = '';
  let silent = '';

  beforeAll(async () => {
    await resetDb();
    b = await seedBase();
    fx = await buildScaleFixture(b, { events: 0 });
    const staff = new Map<string, string[]>();
    for (const e of await owner.db
      .select({ id: schema.employment.id, companyId: schema.employment.companyId })
      .from(schema.employment)
      .where(eq(schema.employment.tenantId, b.tenantId))) {
      (staff.get(e.companyId) ?? staff.set(e.companyId, []).get(e.companyId)!).push(e.id);
    }
    // The plan, per company k (in fixture order) with staff, over 2025:
    //   k % 10 === 3 → every month processed but nobody charged EPF (an exempt workforce): nothing listed;
    //   otherwise every month processed with EPF, EXCEPT April (a draft run, no payslips) and, when
    //   k % 4 === 1, February (processed, EPF zero on every slip). August is CLOSED, not processed.
    // The fixture's own 2026 runs (six companies, processed, no payslips) are never listed either.
    const pps: (typeof schema.payPeriod.$inferInsert)[] = [];
    const plan: { companyId: string; period: string; status: 'draft' | 'processed' | 'closed'; epf: boolean }[] = [];
    fx.companyIds.forEach((companyId, k) => {
      const want: string[] = [];
      if (staff.has(companyId)) {
        for (const period of YEAR_2025) {
          const month = period.slice(5, 7);
          const status = month === '04' ? 'draft' : month === '08' ? 'closed' : 'processed';
          const epf = k % 10 !== 3 && !(k % 4 === 1 && month === '02');
          plan.push({ companyId, period, status, epf });
          pps.push({ tenantId: b.tenantId, companyId, period, status: 'open' });
          if (status !== 'draft' && epf) want.push(period);
        }
      }
      expected.set(companyId, want.reverse());
    });
    const ppIds: string[] = [];
    for (let i = 0; i < pps.length; i += 500) {
      ppIds.push(...(await owner.db.insert(schema.payPeriod).values(pps.slice(i, i + 500)).returning({ id: schema.payPeriod.id })).map((r) => r.id));
    }
    const batchIds: string[] = [];
    const batches = plan.map((p, i) => ({
      tenantId: b.tenantId,
      companyId: p.companyId,
      payPeriodId: ppIds[i],
      payPeriod: p.period,
      runSeq: 1,
      runType: 'regular' as const,
      batchDate: `${p.period}-28`,
      status: p.status,
    }));
    for (let i = 0; i < batches.length; i += 500) {
      batchIds.push(...(await owner.db.insert(schema.payrollBatch).values(batches.slice(i, i + 500)).returning({ id: schema.payrollBatch.id })).map((r) => r.id));
    }
    // One payslip per person per processed or closed run; a draft run has none, as the kernel guarantees.
    const slips = plan.flatMap((p, i) =>
      p.status === 'draft'
        ? []
        : staff.get(p.companyId)!.map((employmentId, n) => ({
            tenantId: b.tenantId,
            batchId: batchIds[i],
            employmentId,
            basicSalary: '3000.00',
            grossPay: '3000.00',
            totalDeductions: '330.00',
            netPay: '2670.00',
            employerCost: '3390.00',
            statutory: p.epf ? { epfEmployee: 330 + (n % 3), epfEmployer: 390 } : { epfEmployee: 0, epfEmployer: 0, socsoEmployee: 14.75 },
          })),
    );
    for (let i = 0; i < slips.length; i += 1000) await owner.db.insert(schema.payslip).values(slips.slice(i, i + 1000));
    const counts = [...expected.entries()].map(([id, list]) => ({ id, n: list.length, staff: staff.get(id)?.length ?? 0 }));
    busiest = [...counts].sort((x, y) => y.n - x.n || y.staff - x.staff)[0].id;
    silent = counts.find((c) => c.n === 0 && c.staff > 0)!.id;
    expect(fx.companyIds.length).toBeGreaterThanOrEqual(70);
    expect(fx.employmentIds.length).toBeGreaterThanOrEqual(1000);
    expect(slips.length).toBeGreaterThan(10_000);
  }, 600_000);

  it('lists exactly the planned months for every company, under All companies', async () => {
    const all = fx.companyIds;
    let nonEmpty = 0;
    for (const companyId of all) {
      const got = await periodsOf(fx.personas.group, all, companyId);
      expect(got, companyId).toEqual(expected.get(companyId));
      if (got.length > 0) nonEmpty += 1;
    }
    // The plan is not vacuous: most companies list something and some list nothing.
    expect(nonEmpty).toBeGreaterThan(40);
    expect(nonEmpty).toBeLessThan(all.length);
  }, 180_000);

  it('answers a single-company administrator for their company only', async () => {
    const one = fx.singleCompanyId;
    expect(await periodsOf(fx.personas.single, [one], one)).toEqual(expected.get(one));
    const elsewhere = fx.companyIds.find((id) => id !== one && (expected.get(id)?.length ?? 0) > 0)!;
    expect(await periodsOf(fx.personas.single, [one], elsewhere)).toEqual([]);
  }, 60_000);

  it('costs the same statements for a full year as for none: one set-based read, no loop', async () => {
    const all = fx.companyIds;
    const full = await traced(() => periodsOf(fx.personas.group, all, busiest));
    const none = await traced(() => periodsOf(fx.personas.group, all, silent));
    expect(full.value).toEqual(expected.get(busiest));
    expect(full.value.length).toBeGreaterThanOrEqual(10);
    expect(none.value).toEqual([]);
    expect(full.trace.statements).toBe(none.trace.statements);
    // A handful of statements (company country, transaction setup, the shared history barrier, the read),
    // never one per month or per run: twelve months of runs would otherwise add at least twelve.
    expect(full.trace.statements).toBeGreaterThan(0);
    expect(full.trace.statements).toBeLessThan(40);
  }, 60_000);
});
