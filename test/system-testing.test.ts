/**
 * System Testing (e6be5a3b, r330) — the test-case library and its execution record.
 *
 * Six properties are worth pinning, and "the insert returned a row" is none of them:
 *
 *   1. THE MODULE IS THE CONTROL, NOT THE MENU. A hidden nav row is decoration; if the SERVICE stops
 *      throwing, the feature is reachable by typing its address. Every refusal below is asserted from an
 *      ADMIN session, which sails through `test_case`/`test_run` RLS — so a green refusal cannot be RLS
 *      wearing the gate's coat (CLAUDE.md §8). The RLS half is asserted separately, against pg_policy.
 *   2. STATUS BELONGS TO THE RUN. The reporter asked for Status and Actual Result as CASE fields. The
 *      schema is asserted to have neither, and "passed in September, failed in October" is asserted to
 *      be answerable — the question that modelling would have destroyed.
 *   3. "NEWEST" IS `run_no`, NOT `run_at`. Two runs sharing a `run_at` to the microsecond (which is what
 *      `now()` produces inside one transaction) must still derive one unambiguous latest outcome. That
 *      case is constructed deliberately, because it is the one an ordinary fixture never reaches.
 *   4. THE DEFECT LINK IS A RAISE, NOT A TYPED ID. A failed run produces a REAL `feedback_request`
 *      through the board's OWN writer, and the id comes back as a foreign key. The absence of a second
 *      writer is asserted against the source, not assumed.
 *   5. THE MODULE LIST IS DERIVED. A tenant without Payroll cannot file a test against Payroll, and the
 *      moment they are sold it, they can.
 *   6. IT IS OFF UNTIL SOLD, and the wiring that makes the rail agree with the route agrees in all
 *      three places that cannot see each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  CROSS_MODULE_CODE,
  NotAdminError,
  RAISEABLE_OUTCOMES,
  SYSTEM_TESTING_MODULE,
  SystemTestingError,
  composeFeedbackDescription,
  createTestCase,
  getTestCase,
  listTestCases,
  listTestableModules,
  raiseRunAsFeedback,
  recordTestRun,
  summarizeByModule,
  updateTestCase,
} from '../core/system-testing';
import { ModuleNotEnabledError } from '../core/entitlements';
import { getFeedback } from '../core/feedback';
import { hireEmployee } from '../core/org';
import {
  DEFAULT_PROVISION_MODULE_CODES,
  LEGACY_ENABLED_MODULE_CODES,
  LEGACY_MODULE_ENV_GATES,
  MODULE_CATALOG,
} from '../packs/catalog';
import { MODULE_CODES_WITH_NAV } from '../lib/nav-entitlements';
import { SCREENS } from '../lib/permissions';
import { testRun } from '../db/schema';
import {
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

const ROOT = path.resolve(__dirname, '..');
const LIST_PAGE = 'app/admin/system-testing/page.tsx';
const NEW_PAGE = 'app/admin/system-testing/new/page.tsx';
const DETAIL_PAGE = 'app/admin/system-testing/[id]/page.tsx';
const PAGES = [LIST_PAGE, NEW_PAGE, DETAIL_PAGE] as const;
const HREF = '/admin/system-testing';
const readRepo = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A tenant that HAS bought the module, with an admin session resolved from its real rows. */
async function entitledAdmin(base: Base): Promise<SessionContext> {
  await setModule(base.tenantId, SYSTEM_TESTING_MODULE, 'active');
  // AFTER setModule — the snapshot is a point-in-time read, exactly as it is for a real session.
  return entitledCtx(base);
}

/**
 * An admin who is also a real EMPLOYEE, which is what raising a board item needs: `feedback_request` is
 * keyed on the reporter's employment and its RLS reads `can_see_employment(reporter_employment_id)`.
 */
async function entitledEmployedAdmin(base: Base): Promise<SessionContext & { employmentId: string }> {
  const s = await entitledAdmin(base);
  const hired = await hireEmployee(s, {
    person: { fullName: 'Tester One', primaryEmail: `tester_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  const userId = await createAppUser(base.tenantId, hired.personId, 'hr_admin');
  return { ...s, userId, personId: hired.personId, employmentId: hired.employmentId };
}

/** ONE SET OF HOOKS AT MODULE SCOPE — `closeAll` inside a describe would end the shared clients early. */
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await closeAll();
});

describe('e6be5a3b — THE GATE: the service refuses, not the menu', () => {
  it('is OFF for a tenant nobody sold it to — asserted against a real seeded tenant', async () => {
    // seedBase grants `legacyEnabledModulesIn(process.env)`, i.e. this deployment's parity set. If
    // system_testing ever creeps into that set this fails BEFORE the service assertions below can pass
    // for the wrong reason.
    const base = await seedBase();
    const rows = (await owner.db.execute(
      sql`select module_code from tenant_module where tenant_id = ${base.tenantId}`,
    )) as unknown as { module_code: string }[];
    expect(rows.map((r) => r.module_code)).not.toContain(SYSTEM_TESTING_MODULE);
  });

  it('THE CONTROL: an ADMIN of an unentitled tenant is refused BY NAME, on every entry point', async () => {
    const base = await seedBase();
    // hr_admin, no system_testing row. An ADMIN deliberately: this session passes every RLS policy on
    // test_case / test_run, so the refusal below can only be the module gate.
    const s = await entitledCtx(base);
    const calls = [
      () => listTestCases(s),
      () => getTestCase(s, randomUUID()),
      () => createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'x' }),
      () => updateTestCase(s, { caseId: randomUUID(), moduleCode: CROSS_MODULE_CODE, title: 'x' }),
      () => recordTestRun(s, { caseId: randomUUID(), outcome: 'pass' }),
      () => raiseRunAsFeedback(s, { runId: randomUUID(), reporterEmploymentId: randomUUID() }),
    ];
    for (const call of calls) {
      // Asserted by NAME and by moduleCode, not merely "something threw": a rejects.toThrow() here
      // would pass just as happily on a typo'd import or an unrelated database error — which is exactly
      // how a gate quietly becomes decorative.
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, 'the service must refuse an unentitled tenant').not.toBeNull();
      expect((err as Error).name).toBe('ModuleNotEnabledError');
      expect(err).toBeInstanceOf(ModuleNotEnabledError);
      expect((err as ModuleNotEnabledError).moduleCode).toBe(SYSTEM_TESTING_MODULE);
    }
    // …and it is a REFUSAL, not a quiet no-op: nothing was written.
    const [{ n }] = (await owner.db.execute(
      sql`select count(*)::int as n from test_case where tenant_id = ${base.tenantId}`,
    )) as unknown as { n: number }[];
    expect(Number(n)).toBe(0);
  });

  it('…and DISCRIMINATES: the same admin succeeds once the module is granted', async () => {
    // Without this the test above would pass for a service that always threw.
    const base = await seedBase();
    const s = await entitledAdmin(base);
    expect(await listTestCases(s)).toEqual([]);
    const { id } = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'Log in' });
    expect((await getTestCase(s, id))!.testCase.title).toBe('Log in');
  });

  it('an expired grant is not a grant — the row alone does not open the door', async () => {
    const base = await seedBase();
    await setModule(base.tenantId, SYSTEM_TESTING_MODULE, 'active', null, new Date(Date.now() - 60_000));
    const s = await entitledCtx(base);
    const err = await listTestCases(s).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('ModuleNotEnabledError');
  });

  it('refuses a non-admin of an ENTITLED tenant, by name', async () => {
    const base = await seedBase();
    await setModule(base.tenantId, SYSTEM_TESTING_MODULE, 'active');
    const employee = await entitledCtx(base, ['employee']);
    const err = await listTestCases(employee).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('NotAdminError');
    expect(err).toBeInstanceOf(NotAdminError);
  });

  it('checks the MODULE before the role, so a refusal never confirms who is privileged', async () => {
    // An unentitled tenant answers "no such module" to everyone. Answering "you are not an admin" would
    // tell an employee the feature exists and that someone else can reach it.
    const base = await seedBase();
    const employee = await entitledCtx(base, ['employee']);
    const err = await listTestCases(employee).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).name).toBe('ModuleNotEnabledError');
  });

  it('RLS is the SECOND lock on the role, and it is admin-only on read AND write', async () => {
    // The gate above is application code. This asserts the database's own answer, so the report can say
    // which layer refuses what instead of guessing: the module is the service's, the role is both.
    const rows = (await owner.db.execute(sql`
      select c.relname as table_name, p.polname as policy, pg_get_expr(p.polqual, p.polrelid) as using_expr,
             pg_get_expr(p.polwithcheck, p.polrelid) as check_expr, c.relrowsecurity as rls_on
        from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relname in ('test_case', 'test_run')
    `)) as unknown as {
      table_name: string;
      policy: string;
      using_expr: string;
      check_expr: string;
      rls_on: boolean;
    }[];
    expect(rows.map((r) => r.table_name).sort()).toEqual(['test_case', 'test_run']);
    for (const r of rows) {
      expect(r.rls_on, `${r.table_name} has RLS enabled`).toBe(true);
      for (const expr of [r.using_expr, r.check_expr]) {
        expect(expr, `${r.table_name}.${r.policy} is tenant-scoped`).toContain('current_tenant_id');
        expect(expr, `${r.table_name}.${r.policy} is admin-only`).toContain('is_admin');
      }
    }
  });

  it('the app role was GRANTed on both new tables — invisible on this suite otherwise', async () => {
    // The suite connects as the OWNER and production has ALTER DEFAULT PRIVILEGES, so a missing GRANT
    // surfaces only on a restored developer cluster, after the deploy (0345 / 0354 / 0480).
    const rows = (await owner.db.execute(sql`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'ai_hr_app' and table_name in ('test_case', 'test_run')
    `)) as unknown as { table_name: string; privilege_type: string }[];
    for (const t of ['test_case', 'test_run']) {
      const got = rows.filter((r) => r.table_name === t).map((r) => r.privilege_type).sort();
      expect(got, `${t} grants to ai_hr_app`).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });
});

describe('e6be5a3b — status belongs to the RUN, not the CASE', () => {
  it('the CASE table carries no status and no actual_result — the modelling decision, pinned', async () => {
    // This is the assertion that stops a well-meaning "the request asked for a Status field" patch. With
    // a status on the case, every earlier execution is overwritten and the history below is impossible.
    const cols = (await owner.db.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'test_case'
    `)) as unknown as { column_name: string }[];
    const names = cols.map((c) => c.column_name);
    expect(names.length, 'test_case exists').toBeGreaterThan(5);
    expect(names).not.toContain('status');
    expect(names).not.toContain('outcome');
    expect(names).not.toContain('actual_result');
    // …and the RUN carries exactly those two.
    const runCols = (await owner.db.execute(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'test_run'
    `)) as unknown as { column_name: string }[];
    expect(runCols.map((c) => c.column_name)).toEqual(expect.arrayContaining(['outcome', 'actual_result']));
  });

  it('"passed in September, failed in October" is answerable — both runs survive', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const { id } = await createTestCase(s, {
      moduleCode: CROSS_MODULE_CODE,
      title: 'Payslip totals',
      steps: ['Open a payslip', 'Read the net pay'],
    });
    await recordTestRun(s, { caseId: id, outcome: 'pass', actualResult: 'Net pay matched.' });
    await recordTestRun(s, { caseId: id, outcome: 'fail', actualResult: 'Net pay was 12.00 short.' });

    const { runs } = (await getTestCase(s, id))!;
    // Newest first, by run_no — an invariant of the data, not a position in an unordered result.
    expect(runs.map((r) => r.runNo)).toEqual([2, 1]);
    expect(runs.map((r) => r.outcome)).toEqual(['fail', 'pass']);
    expect(runs[1].actualResult).toBe('Net pay matched.');

    // The DERIVED status is the newest one, and only the newest one.
    const [row] = await listTestCases(s);
    expect(row.latestOutcome).toBe('fail');
    expect(row.runCount).toBe(2);

    /**
     * `latestRunAt` IS A REAL Date — the assertion that catches a 500 nothing else can see.
     *
     * The list is built with `tx.execute(sql`…`)`, which bypasses drizzle's column-type mapping, so a
     * `timestamptz` arrives as a STRING while the declared type says `Date`. tsc, the suite and
     * `next build` all passed over that; the screen threw `RangeError: Invalid time value` out of
     * `Intl.DateTimeFormat` the first time it rendered a case that had been run. Asserted by BEHAVIOUR
     * as well as by type, because `toBeInstanceOf(Date)` alone would still pass for an Invalid Date.
     */
    expect(row.latestRunAt).toBeInstanceOf(Date);
    expect(Number.isNaN(row.latestRunAt!.getTime()), 'not an Invalid Date').toBe(false);
    expect(todayInKualaLumpur(row.latestRunAt!)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a case that has never been run derives to not_tested, not to a blank', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'Never run' });
    const [row] = await listTestCases(s);
    expect(row.latestOutcome).toBe('not_tested');
    expect(row.latestRunAt).toBeNull();
    expect(row.runCount).toBe(0);
  });

  it('TWO RUNS WITH AN IDENTICAL run_at still derive ONE latest — this is why run_no exists', async () => {
    // `now()` is the TRANSACTION timestamp, so any two runs written in one transaction share a run_at to
    // the microsecond. Ordering by run_at would make "the newest" whatever the planner returned. The
    // rows are written as the OWNER so the collision can be constructed exactly, rather than hoped for.
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const { id } = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'Tie-break' });
    const sameInstant = new Date('2026-09-20T02:15:00.000Z');
    await owner.db.insert(testRun).values([
      { tenantId: base.tenantId, testCaseId: id, runNo: 1, outcome: 'fail', runAt: sameInstant },
      { tenantId: base.tenantId, testCaseId: id, runNo: 2, outcome: 'pass', runAt: sameInstant },
    ]);
    const [row] = await listTestCases(s);
    expect(row.latestOutcome, 'run_no decides, not run_at').toBe('pass');
    expect((await getTestCase(s, id))!.runs.map((r) => r.runNo)).toEqual([2, 1]);
  });

  it('the list and the per-module tally agree, and "failing" means the LATEST run failed', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const a = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'A' });
    const b = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'B' });
    await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'C' }); // never run
    await recordTestRun(s, { caseId: a.id, outcome: 'fail' });
    await recordTestRun(s, { caseId: a.id, outcome: 'pass' }); // fixed since — no longer failing
    await recordTestRun(s, { caseId: b.id, outcome: 'fail' });

    const rows = await listTestCases(s);
    expect(rows.map((r) => r.caseNo)).toEqual([1, 2, 3]); // ORDER BY case_no, pinned
    const [tally] = summarizeByModule(rows);
    expect(tally).toEqual({ moduleCode: CROSS_MODULE_CODE, total: 3, run: 2, failing: 1 });
  });

  it('case numbers are per-tenant, monotonic and unique', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const one = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'one' });
    const two = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'two' });
    expect([one.caseNo, two.caseNo]).toEqual([1, 2]);

    // A SECOND tenant starts at 1 again — the counter is per-tenant, not global.
    const other = await seedBase();
    const s2 = await entitledAdmin(other);
    expect((await createTestCase(s2, { moduleCode: CROSS_MODULE_CODE, title: 'theirs' })).caseNo).toBe(1);
  });

  it('steps keep their order and drop blanks; editing the script does not touch the runs', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const { id } = await createTestCase(s, {
      moduleCode: CROSS_MODULE_CODE,
      title: 'Ordered',
      steps: ['third'.replace('third', 'one'), '', 'two', '   ', 'three'],
    });
    await recordTestRun(s, { caseId: id, outcome: 'blocked' });
    expect((await getTestCase(s, id))!.testCase.steps).toEqual(['one', 'two', 'three']);

    await updateTestCase(s, {
      caseId: id,
      moduleCode: CROSS_MODULE_CODE,
      title: 'Ordered, revised',
      steps: ['one', 'two'],
      priority: 'high',
    });
    const after = (await getTestCase(s, id))!;
    expect(after.testCase.title).toBe('Ordered, revised');
    expect(after.testCase.steps).toEqual(['one', 'two']);
    expect(after.testCase.caseNo, 'the number a run cites cannot move').toBe(1);
    expect(after.runs).toHaveLength(1);
  });
});

describe('e6be5a3b — the controlled module list is DERIVED, not hardcoded', () => {
  /**
   * A module the suite's tenant genuinely does NOT have.
   *
   * NOT `payroll` — `seedBase` seeds this deployment's parity set, which includes it, and the first
   * draft of these two tests asserted otherwise and went red. `system_explorer` is the right choice for
   * a reason rather than by elimination: its env gate is a reserved name no tracked file sets, so it is
   * rowless for every tenant by construction, and test/system-explorer.test.ts pins that independently.
   */
  const NOT_SOLD = 'system_explorer';

  it('offers only what the tenant owns, plus Cross-Module — and grows when they buy one', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const before = listTestableModules(s).map((m) => m.code);
    // Core modules are on for everyone and take no row at all, so they are always offered.
    expect(before).toEqual(expect.arrayContaining(['employees', 'org', 'leave']));
    // …and a BILLABLE module the tenant does have is offered too, so this is not just the core list.
    expect(before).toContain('payroll');
    expect(before).toContain(CROSS_MODULE_CODE);
    expect(before[before.length - 1], 'the fallback is last').toBe(CROSS_MODULE_CODE);

    // ASSERTED OFF, not assumed off: the absence below follows from the tenant's own rows.
    const rows = (await owner.db.execute(
      sql`select 1 from tenant_module where tenant_id = ${base.tenantId} and module_code = ${NOT_SOLD}`,
    )) as unknown as unknown[];
    expect(rows).toHaveLength(0);
    expect(before).not.toContain(NOT_SOLD);

    await setModule(base.tenantId, NOT_SOLD, 'active');
    const s2 = await entitledCtx(base);
    expect(listTestableModules(s2).map((m) => m.code), 'a module they just bought becomes testable').toContain(
      NOT_SOLD,
    );
  });

  it('refuses a case filed against a module the tenant does not own, by name', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    const err = await createTestCase(s, { moduleCode: NOT_SOLD, title: 'Dependency map' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SystemTestingError);
    expect((err as Error).message).toContain(NOT_SOLD);
  });

  it('refuses an unknown test type and an unknown priority', async () => {
    const base = await seedBase();
    const s = await entitledAdmin(base);
    for (const bad of [{ testType: 'smoke' }, { priority: 'urgent' }]) {
      const err = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'x', ...bad }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SystemTestingError);
    }
  });
});

describe('e6be5a3b — the defect link is a RAISE, not a typed ID', () => {
  it('a failed run raises a REAL board item through the board own writer, and stores the id as an FK', async () => {
    const base = await seedBase();
    const s = await entitledEmployedAdmin(base);
    const { id } = await createTestCase(s, {
      moduleCode: CROSS_MODULE_CODE,
      title: 'Leave balance after cancellation',
      precondition: 'One approved leave request exists.',
      steps: ['Cancel the approved request', 'Reopen the balance card'],
      expectedBehavior: 'The balance returns to what it was.',
      expectedFunction: 'Cancelling an approved request gives the days back.',
    });
    const run = await recordTestRun(s, {
      caseId: id,
      outcome: 'fail',
      actualResult: 'The balance stayed one day short.',
    });

    const { feedbackId } = await raiseRunAsFeedback(s, {
      runId: run.id,
      reporterEmploymentId: s.employmentId,
    });

    // The item exists ON THE BOARD, read back through the board's own reader.
    const item = await getFeedback(s, feedbackId);
    expect(item, 'the raised item is a real feedback_request').not.toBeNull();
    expect(item!.title).toBe('Leave balance after cancellation');
    expect(item!.category).toBe('issue');
    expect(item!.status).toBe('open');
    expect(item!.expectedBehavior).toBe('The balance returns to what it was.');
    expect(item!.expectedFunction).toBe('Cancelling an approved request gives the days back.');
    // Nothing was re-typed: the steps and what actually happened rode along.
    expect(item!.description).toContain('Cancel the approved request');
    expect(item!.description).toContain('The balance stayed one day short.');
    expect(item!.description).toContain('TC-0001');

    // …and the link is a REAL foreign key on the run, not a hand-keyed string.
    const after = (await getTestCase(s, id))!;
    expect(after.runs[0].feedbackRequestId).toBe(feedbackId);
    const [{ ok }] = (await owner.db.execute(sql`
      select count(*)::int as ok from test_run r
        join feedback_request f on f.id = r.feedback_request_id
       where r.id = ${run.id}
    `)) as unknown as { ok: number }[];
    expect(Number(ok), 'the FK resolves to a row that exists').toBe(1);
  });

  it('the reporter keeps their own name — no CLAUDE AI label on a human submission', async () => {
    // reporter_label exists to show who WROTE an item when the improvement loop borrows a human's
    // employment (0348). A person pressing this button IS the author, so stamping it would hide them.
    const base = await seedBase();
    const s = await entitledEmployedAdmin(base);
    const { id } = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'Labelled?' });
    const run = await recordTestRun(s, { caseId: id, outcome: 'fail', actualResult: 'nope' });
    const { feedbackId } = await raiseRunAsFeedback(s, { runId: run.id, reporterEmploymentId: s.employmentId });
    const [row] = (await owner.db.execute(
      sql`select reporter_label from feedback_request where id = ${feedbackId}`,
    )) as unknown as { reporter_label: string | null }[];
    expect(row.reporter_label).toBeNull();
  });

  it('refuses to raise the same run twice, and refuses a run that passed', async () => {
    const base = await seedBase();
    const s = await entitledEmployedAdmin(base);
    const { id } = await createTestCase(s, { moduleCode: CROSS_MODULE_CODE, title: 'Twice' });
    const failed = await recordTestRun(s, { caseId: id, outcome: 'fail', actualResult: 'bad' });
    await raiseRunAsFeedback(s, { runId: failed.id, reporterEmploymentId: s.employmentId });

    const again = await raiseRunAsFeedback(s, { runId: failed.id, reporterEmploymentId: s.employmentId }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(again).toBeInstanceOf(SystemTestingError);
    expect((again as Error).message).toContain('already');

    const passed = await recordTestRun(s, { caseId: id, outcome: 'pass' });
    const refused = await raiseRunAsFeedback(s, { runId: passed.id, reporterEmploymentId: s.employmentId }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(SystemTestingError);
    expect((refused as Error).message).toContain('pass');

    // Exactly ONE item was raised across all three attempts.
    const [{ n }] = (await owner.db.execute(
      sql`select count(*)::int as n from feedback_request where tenant_id = ${base.tenantId}`,
    )) as unknown as { n: number }[];
    expect(Number(n)).toBe(1);
  });

  it('every raiseable outcome is one that did not pass', () => {
    expect([...RAISEABLE_OUTCOMES].sort()).toEqual(['blocked', 'fail', 'partial']);
    expect(RAISEABLE_OUTCOMES).not.toContain('pass');
    expect(RAISEABLE_OUTCOMES).not.toContain('not_tested');
  });

  it('THERE IS NO SECOND WRITER: the service never inserts into feedback_request itself', () => {
    // The whole design rests on reusing the board's writer. A hand-rolled INSERT here would type-check,
    // pass every test above, and quietly stop appending `feedback.submitted` / honouring the category
    // vocabulary. Comments stripped, because this file's own header argues at length about the rule.
    const src = strip(readRepo('core/system-testing.ts'));
    expect(src).toMatch(/import\s*\{[^}]*submitFeedback[^}]*\}\s*from\s*'\.\/feedback'/);
    expect(src).not.toMatch(/insert\s*\(\s*feedbackRequest/);
    expect(src).not.toMatch(/INSERT\s+INTO\s+feedback_request/i);
    // …and no other surface of this feature writes the board either.
    for (const f of [...PAGES, 'app/admin/system-testing/actions.ts']) {
      expect(strip(readRepo(f)), `${f} must not write feedback_request`).not.toMatch(/insert\s*\(\s*feedbackRequest/);
    }
  });

  it('the pre-filled description is plain text and names the case, the run and the outcome', () => {
    // Pinned without a database, because this string is what the reporter reads on the board and the
    // board renders it RAW (CLAUDE.md §9) — any Markdown would ship as literal asterisks.
    const text = composeFeedbackDescription(
      {
        id: 'x',
        caseNo: 7,
        moduleCode: 'leave',
        title: 'T',
        precondition: 'P',
        steps: ['first', 'second'],
        testType: 'functional',
        priority: 'high',
        expectedBehavior: null,
        expectedFunction: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { id: 'r', runNo: 3, outcome: 'fail', actualResult: 'It did not.', runAt: new Date(), feedbackRequestId: null },
    );
    expect(text).toContain('TC-0007');
    expect(text).toContain('run #3');
    expect(text).toContain('fail');
    expect(text).toContain('1. first');
    expect(text).toContain('2. second');
    expect(text).toContain('It did not.');
    expect(text, 'the board renders raw text — no Markdown').not.toMatch(/\*\*|^#\s|^- /m);
  });
});

describe('e6be5a3b — the module, the placement, and the wiring', () => {
  it('is catalogued as sellable, non-core, and OFF for everyone by default', () => {
    const row = MODULE_CATALOG.find((m) => m.code === SYSTEM_TESTING_MODULE);
    expect(row, 'system_testing is in the module catalog').toBeDefined();
    expect(row!.isCore, 'core modules are on for every tenant — this must not be one').toBe(false);
    expect(row!.billable).toBe(true);
    expect(row!.packBacked, 'it registers no pack').toBe(false);
    // THE DEFAULT-OFF PROOF at the catalog level, in all three places it could leak on:
    //   - not in the parity set  ⇒ migration 0313 grants it to no existing tenant,
    //   - a named (unset) gate   ⇒ `legacyEnabledModulesIn` never emits it for db/seed or the harness,
    //   - not pre-ticked         ⇒ the provisioning form does not sell it by accident.
    expect(LEGACY_ENABLED_MODULE_CODES).not.toContain(SYSTEM_TESTING_MODULE);
    expect(LEGACY_MODULE_ENV_GATES[SYSTEM_TESTING_MODULE], 'null would mean "on for everyone"').toBe(
      'SYSTEM_TESTING_ENABLED',
    );
    expect(DEFAULT_PROVISION_MODULE_CODES).not.toContain(SYSTEM_TESTING_MODULE);
  });

  it('every page carries BOTH guards — the admin gate and the module gate', () => {
    for (const p of PAGES) {
      const src = readRepo(p);
      // requireAdmin is also what makes the route visible to test/function-access.test.ts's guard scan,
      // which is how it earns a permission-matrix column instead of being an undescribable screen.
      expect(src, `${p} calls requireAdmin`).toContain('requireAdmin()');
      expect(src, `${p} calls requireModule`).toContain("requireModule('system_testing')");
    }
  });

  it('has a permission-matrix column covering all three routes', () => {
    const screen = SCREENS.find((s) => s.screenKey === 'systemTesting');
    expect(screen, 'a screen with no column is one the access grid silently omits').toBeDefined();
    expect(screen!.guard).toBe('requireAdmin');
    expect(screen!.href).toBe(HREF);
    expect([...screen!.routes].sort()).toEqual([HREF, `${HREF}/[id]`, `${HREF}/new`]);
  });

  it('the rail gates the row, and the hand-written href map agrees with the row and the route', () => {
    // MODULE_OF_HREF is derived from pack descriptors for every other module; this one has no pack, so
    // its entry is a literal. Three things must agree and none of them can see the others.
    expect(MODULE_CODES_WITH_NAV as readonly string[]).toContain(SYSTEM_TESTING_MODULE);
    const sidebar = readRepo('components/sidebar.tsx');
    expect(sidebar).toContain(`['${HREF}', '${SYSTEM_TESTING_MODULE}'] as const`);
    // Exactly once, so the row cannot be duplicated into an ungated position.
    expect(sidebar.split(`href: '${HREF}'`).length - 1, 'one nav row for System Testing').toBe(1);
    expect(sidebar).toContain(`labelKey: 'systemTesting'`);
    for (const p of PAGES) {
      expect(fs.existsSync(path.join(ROOT, p)), `${p} exists on disk`).toBe(true);
    }
  });

  it('NO SERVER ACTION CROSSES INTO A CLIENT ISLAND', () => {
    // The failure this guards against passes tsc, passes `next build`, and 500s at runtime. Two halves:
    // none of this feature's own files is a client component, and no 'use client' file anywhere imports
    // its actions module.
    for (const f of [...PAGES, 'app/admin/system-testing/actions.ts']) {
      const src = readRepo(f);
      if (f.endsWith('actions.ts')) expect(src.trimStart().startsWith("'use server'")).toBe(true);
      else expect(src, `${f} must stay a server component`).not.toMatch(/^\s*'use client'/m);
    }
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (/^\s*'use client'/m.test(src) && /system-testing\/actions/.test(src)) {
            offenders.push(path.relative(ROOT, p));
          }
        }
      }
    };
    for (const d of ['app', 'components']) walk(path.join(ROOT, d));
    expect(offenders, 'a client island importing these actions would 500 at runtime').toEqual([]);
  });

  it('a date from an instant goes through todayInKualaLumpur, on every screen that prints one', () => {
    // CLAUDE.md §8. `toISOString().slice(0,10)` is the shape that reads right on this box and prints
    // yesterday for a run recorded at 00:30 MYT.
    for (const p of [LIST_PAGE, DETAIL_PAGE]) {
      const src = strip(readRepo(p));
      expect(src, `${p} formats dates in the tenant's calendar`).toContain('todayInKualaLumpur(');
      expect(src, `${p} must not slice an ISO string into a date`).not.toMatch(/toISOString\(\)\s*\.slice/);
    }
  });
});

describe('e6be5a3b — i18n, in all six locales', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  type Bundle = { admin: { systemTesting: Record<string, string> }; nav: Record<string, string> };
  const dict = Object.fromEntries(
    LOCALES.map((l) => [l, JSON.parse(readRepo(`messages/${l}.json`)) as Bundle]),
  ) as Record<(typeof LOCALES)[number], Bundle>;

  /**
   * Every literal key the three screens render, DERIVED from their source.
   *
   * The same regex test/i18n-coverage.test.ts check C uses, so this list cannot disagree with what that
   * check sees — and comments are stripped first, because the list page's header quotes a dynamic key in
   * prose and a coverage list that fires on prose is one people delete.
   */
  const usedKeys = (): string[] => {
    const keys = new Set<string>();
    for (const p of PAGES) {
      for (const m of strip(readRepo(p)).matchAll(/\bt(?:\.rich)?\(\s*['"]([a-z][a-zA-Z0-9_.]*)['"]/g)) {
        keys.add(m[1]);
      }
    }
    return [...keys].sort();
  };

  it('every key the screens render exists and is non-empty in every locale', () => {
    const keys = usedKeys();
    // A tripwire on the derivation itself: if the scan finds nothing, the assertions below are vacuous.
    expect(keys.length, 'the key scan has drifted').toBeGreaterThan(50);
    for (const l of LOCALES) {
      const block = dict[l].admin.systemTesting;
      expect(block, `${l}: admin.systemTesting exists`).toBeDefined();
      for (const k of keys) {
        expect(typeof block[k], `${l}: admin.systemTesting.${k}`).toBe('string');
        expect(block[k].trim().length, `${l}: admin.systemTesting.${k} non-empty`).toBeGreaterThan(0);
      }
      expect(typeof dict[l].nav.systemTesting, `${l}: nav.systemTesting`).toBe('string');
      expect(dict[l].nav.systemTesting.trim().length, `${l}: nav.systemTesting non-empty`).toBeGreaterThan(0);
    }
  });

  it('no key is pinned that nothing renders — the bundle matches the screens exactly', () => {
    // Derived from the source, so a renamed key fails here rather than leaving a translated string
    // behind that no screen reads — which is how a message bundle stops meaning anything.
    expect(Object.keys(dict.en.admin.systemTesting).sort()).toEqual(usedKeys());
  });

  it('the strings are actually TRANSLATED, not English pasted six times', () => {
    // i18n-coverage only fails on missing/empty keys, so copying en into all six ships five locales in
    // English with a green build — the single most likely failure mode of a change like this.
    const en = dict.en;
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      for (const k of ['title', 'description', 'progressNote', 'recordRunNote', 'raise'] as const) {
        expect(dict[l].admin.systemTesting[k], `${l}: ${k} differs from en`).not.toBe(en.admin.systemTesting[k]);
      }
      expect(dict[l].nav.systemTesting, `${l}: nav.systemTesting differs from en`).not.toBe(en.nav.systemTesting);
    }
  });
});
