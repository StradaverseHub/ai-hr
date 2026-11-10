/**
 * 7076f8af test 2b, restored for the background run group. The synchronous wizard generated each company inside a
 * try, so a company whose run threw rendered as a REASON ROW on the result page, never as a thrown page, and the
 * other companies' outcomes still rendered. Each company now processes as its own payroll_process job inside a run
 * group (core/payroll-run-group-store.ts), so the same guarantee is proved end to end on the real worker: a company
 * job that fails INSIDE the run (after its first employee was already paid, which the discard takes back) and a
 * company job refused when it prepares both settle to the reason code the synchronous catch gave them
 * (`reasonForPayrollError`), and the result page renders that row beside the company that succeeded.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { setCompensation } from '../core/comp';
import { hireEmployee } from '../core/org';
import { seedPayrollCycleCatalog } from '../core/payroll-cycle';
import { startMultiCompanyPayroll, type RunGroupResult } from '../core/payroll-run-group';
import { readRunGroup, settleRunGroupsForJob } from '../core/payroll-run-group-store';
import { runBulkJobTick } from '../core/bulk-job-worker';
import { payrollProcessJobHandler } from '../core/payroll-processing-job';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { drainRunGroup } from './payroll-run-group-helpers';

let scope: { s: SessionContext; scopeIds: string[] };
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  getLocale: async () => 'en',
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type FC, type ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import ResultPage from '../app/payroll/process/result/page';

const tick = () => runBulkJobTick(owner.client, { handlers: [payrollProcessJobHandler] });
/** The result page exactly as the browser asks for it after the wizard's redirect (`?g=<group>`). */
async function renderResult(groupId: string) {
  const page = await ResultPage({ searchParams: Promise.resolve({ g: groupId }) });
  const Provider = NextIntlClientProvider as unknown as FC<{ locale: string; messages: unknown; children?: ReactNode }>;
  return renderToStaticMarkup(createElement(Provider, { locale: 'en', messages }, page));
}
/** The <tr> of one company in the per-company outcome table. */
function rowOf(html: string, companyName: string) {
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((r) => r.includes(`>${companyName}<`));
  expect(row, `no outcome row for ${companyName}`).toBeTruthy();
  return row!;
}

describe('a company job that fails inside a wizard run group renders as its reason row', () => {
  let base: Base;
  let companyB: string;
  let deptB: string;
  let entitlements: SessionContext['entitlements'];
  const groupAdmin = (): SessionContext => ({ tenantId: base.tenantId, userId: base.adminUserId, grants: [{ role: 'hr_admin', companyId: null }], entitlements });
  async function paid(ctx: SessionContext, companyId: string, departmentId: string, name: string) {
    const e = await hireEmployee(ctx, { person: { fullName: name, primaryEmail: `${name.toLowerCase()}.${randomUUID().slice(0, 6)}@rg.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: '2026-01-01' });
    await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    return e.employmentId;
  }
  async function regularCycleId(companyId: string) {
    const [row] = await owner.db.select({ id: schema.payrollCycle.id }).from(schema.payrollCycle)
      .where(and(eq(schema.payrollCycle.companyId, companyId), eq(schema.payrollCycle.runType, 'regular')));
    return row.id;
  }
  const jobOf = async (batchCompany: string) => {
    const [row] = await owner.client<{ job: string | null; status: string }[]>`select processing_job_id as job,status::text as status from payroll_batch where company_id=${batchCompany}::uuid and pay_period='2026-05'`;
    return row;
  };

  beforeAll(async () => { await migrateTestDb(); });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    entitlements = (await entitledCtx(base)).entitlements;
    const a = groupAdmin();
    scope = { s: a, scopeIds: [] };
    const [c2] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Beta Sdn Bhd' }).returning({ id: schema.company.id });
    companyB = c2.id;
    const [dB] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: companyB, name: 'Beta Ops' }).returning({ id: schema.department.id });
    deptB = dB.id;
    await seedPayrollCycleCatalog(a, base.companyId);
    await seedPayrollCycleCatalog(a, companyB);
  });
  afterEach(() => {
    delete process.env.PAYROLL_PROCESS_STEP_EMPLOYEES;
    delete process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS;
  });
  afterAll(async () => { await closeAll(); });

  it('fails mid-run after paying an employee: the run is discarded and the row says PRE_PROCESS_BLOCKED beside the company that succeeded', async () => {
    const a = groupAdmin();
    await paid(a, base.companyId, base.deptA, 'Alice');
    const bob = await paid(a, companyB, deptB, 'Bob');
    const carl = await paid(a, companyB, deptB, 'Carl');
    // One employee per step and one step per chunk, so Beta's run pays its first employee and commits before the
    // second one is reached.
    process.env.PAYROLL_PROCESS_STEP_EMPLOYEES = '1';
    process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS = '1';
    const { groupId } = await startMultiCompanyPayroll(a, { companyIds: [base.companyId, companyB], payPeriod: '2026-05', payrollCycleId: await regularCycleId(base.companyId), employmentIds: [] });
    const betaJob = (await jobOf(companyB)).job!;
    // Drive the worker until Beta's run has paid exactly one employee.
    let first: string | null = null;
    for (let i = 0; i < 2000 && !first; i++) {
      await tick();
      const [row] = await owner.client<{ employment_id: string }[]>`select p.employment_id from payslip p join payroll_batch b on b.id=p.batch_id
        where b.company_id=${companyB}::uuid and b.pay_period='2026-05'`;
      first = row?.employment_id ?? null;
    }
    expect(first).not.toBeNull();
    expect((await owner.client<{ state: string }[]>`select state from bulk_job where id=${betaJob}::uuid`)[0].state).toBe('running');
    // The second employee's salary record stops covering the month while the run is processing (it now starts in
    // July): that employee's chunk re-asserts the readiness gate and refuses, exactly as the synchronous generation
    // refused the whole run with no period-effective salary in scope.
    const second = first === bob ? carl : bob;
    await owner.db.update(schema.compensation).set({ validFrom: '2026-07-01' }).where(eq(schema.compensation.employmentId, second));

    const result: RunGroupResult = await drainRunGroup(groupId);
    expect(result.overallStatus).toBe('partial');
    const beta = result.perCompany.find((c) => c.companyId === companyB)!;
    // The synchronous catch's row for a company whose generation threw: nothing selected, nothing paid, the reason.
    expect(beta).toEqual({ companyId: companyB, companyName: 'Beta Sdn Bhd', status: 'failed', employeesSelected: 0, employeesSucceeded: 0, reason: 'PRE_PROCESS_BLOCKED' });
    expect(result.perCompany.find((c) => c.companyId === base.companyId)).toMatchObject({ status: 'succeeded', employeesSucceeded: 1 });
    // The failure happened inside the job and the discard took the paid employee back: the run is a draft again.
    expect(await jobOf(companyB)).toEqual({ job: null, status: 'draft' });
    expect(await owner.client`select 1 from payslip p join payroll_batch b on b.id=p.batch_id where b.company_id=${companyB}::uuid`).toHaveLength(0);

    // The result page renders, with the failed company as its reason row and the other company's outcome.
    const html = await renderResult(groupId);
    const betaRow = rowOf(html, 'Beta Sdn Bhd');
    expect(betaRow).toContain('companyFailed');
    expect(betaRow).toContain('reason.PRE_PROCESS_BLOCKED');
    const acmeName = result.perCompany.find((c) => c.companyId === base.companyId)!.companyName;
    const acmeRow = rowOf(html, acmeName);
    expect(acmeRow).toContain('companySucceeded');
    expect(acmeRow).toContain(`/payroll/${result.perCompany.find((c) => c.companyId === base.companyId)!.batchId}`);
    expect(html).toContain('overall.partial');
    expect(html).not.toContain('resultExpired');
  });

  it('a settlement that fails is retried by the kernel: the group settles once, with one completed event, before the notice', async () => {
    const a = groupAdmin();
    await paid(a, base.companyId, base.deptA, 'Alice');
    await paid(a, companyB, deptB, 'Bob');
    // The first attempt to settle the group fails (a sequence survives the rolled-back attempt); later ones succeed.
    await owner.client.unsafe(`create sequence if not exists test_settle_attempt;
      create or replace function test_settle_refuse_once() returns trigger language plpgsql as $$
       begin if nextval('test_settle_attempt')=1 then raise exception 'settlement refused once'; end if; return new; end $$;
      create trigger test_settle_refuse_once before update of ended_at on payroll_run_group for each row execute function test_settle_refuse_once();`);
    try {
      const { groupId } = await startMultiCompanyPayroll(a, { companyIds: [base.companyId, companyB], payPeriod: '2026-05', payrollCycleId: await regularCycleId(base.companyId), employmentIds: [] });
      const lastJob = (await jobOf(companyB)).job!;
      const job = async () => (await owner.client<{ state: string; settled: boolean; notified: boolean; failures: number | null }[]>`select state,settled_at is not null as settled,
        notified_at is not null as notified,(metrics->>'settleFailures')::int as failures from bulk_job where id=${lastJob}::uuid`)[0];
      // Run until the last company's job is terminal: its first settle has failed, so it is neither settled nor notified.
      for (let i = 0; i < 4000 && !['completed', 'failed'].includes((await job()).state); i++) if (!(await tick())) await new Promise((r) => setTimeout(r, 20));
      expect(await job()).toMatchObject({ state: 'completed', settled: false, notified: false, failures: 1 });
      expect((await owner.client<{ ended: boolean }[]>`select ended_at is not null as ended from payroll_run_group where id=${groupId}::uuid`)[0].ended).toBe(false);
      // The kernel retries it on a later tick (after its backoff) and the group settles exactly once.
      const result = await drainRunGroup(groupId);
      expect(result).toMatchObject({ overallStatus: 'succeeded', totalCompanies: 2, totalEmployeesSucceeded: 2 });
      for (let i = 0; i < 200 && !(await job()).notified; i++) if (!(await tick())) await new Promise((r) => setTimeout(r, 20));
      expect(await job()).toMatchObject({ settled: true, notified: true });
      const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'payroll-run-group.completed'));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: 'user', actorId: base.adminUserId, aggregateType: 'payroll-run-group' });
      expect(events[0].payload).toMatchObject({ overallStatus: 'succeeded', startedAt: result.startedAt, endedAt: result.endedAt, companyIds: [base.companyId, companyB] });
      const [group] = await owner.client<{ event_id: string }[]>`select event_id from payroll_run_group where id=${groupId}::uuid`;
      expect(group.event_id).toBe(events[0].id);
      // Idempotent: settling the same job again changes nothing.
      const reserved = await owner.client.reserve();
      try { await settleRunGroupsForJob(reserved, { id: lastJob, tenant_id: base.tenantId, created_by: base.adminUserId }); } finally { reserved.release(); }
      expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'payroll-run-group.completed'))).toHaveLength(1);
      expect((await readRunGroup(a, groupId))?.result).toEqual(result);
    } finally {
      await owner.client.unsafe('drop trigger if exists test_settle_refuse_once on payroll_run_group; drop function if exists test_settle_refuse_once(); drop sequence if exists test_settle_attempt;');
    }
  });

  it('is refused when its job prepares: the same reason row, and the page still renders the other company', async () => {
    const a = groupAdmin();
    await paid(a, base.companyId, base.deptA, 'Alice');
    const bob = await paid(a, companyB, deptB, 'Bob');
    const { groupId } = await startMultiCompanyPayroll(a, { companyIds: [base.companyId, companyB], payPeriod: '2026-05', payrollCycleId: await regularCycleId(base.companyId), employmentIds: [] });
    // Admitted (nothing is computed in the request), then made unready before its job prepares.
    expect((await jobOf(companyB)).status).toBe('processing');
    await owner.db.update(schema.compensation).set({ validFrom: '2026-07-01' }).where(eq(schema.compensation.employmentId, bob));
    // While Alpha's run is processing and Beta's has already failed, the screen shows progress, not a page error.
    const waiting = await readRunGroup(a, groupId);
    expect(waiting?.done).toBe(false);

    const result = await drainRunGroup(groupId);
    expect(result.perCompany.find((c) => c.companyId === companyB)).toEqual({ companyId: companyB, companyName: 'Beta Sdn Bhd', status: 'failed', employeesSelected: 0, employeesSucceeded: 0, reason: 'PRE_PROCESS_BLOCKED' });
    const html = await renderResult(groupId);
    expect(rowOf(html, 'Beta Sdn Bhd')).toContain('reason.PRE_PROCESS_BLOCKED');
    expect(rowOf(html, result.perCompany.find((c) => c.companyId === base.companyId)!.companyName)).toContain('companySucceeded');
  });
});
