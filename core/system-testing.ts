import type { Tx as AiReadTx } from '../db/client';
import { withCanonicalAiReadTx } from './ai-read-transaction';
/**
 * System Testing (e6be5a3b, r330) — the test-case library and its execution record.
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────────────────────────────
 *
 * The reporter asked for a test-case register whose fields were Title, Description, Expected Behaviour,
 * Expected Function, Status, Remarks, Created By, Created Date. That list IS `feedback_request` — the
 * form they were typing the request into. The DEFECT half of what they described is built and in daily
 * use (core/feedback.ts, app/(app)/feedback), so this service does not model a second one, does not copy its
 * columns and never writes to it except through its own public writer.
 *
 * What the board has no concept of, and what this adds, is the pair:
 *   · a CASE — a reusable script: preconditions, ordered steps, what should happen;
 *   · a RUN  — one execution of one case, with an outcome and what actually happened.
 *
 * ── THE TWO GATES, IN THIS ORDER, AND WHY ───────────────────────────────────────────────────────────
 *
 * MODULE FIRST (ADR-0077 D3). A tenant nobody sold this to has no such feature, so
 * `ModuleNotEnabledError` is the true answer for everyone in that tenant — an employee poking at the URL
 * learns exactly what an admin would, which is nothing about who is privileged here. Checking the role
 * first would answer "you are not an admin" and thereby confirm the feature exists.
 *
 * ROLE SECOND, IN THE SERVICE and not only in the page. `requireAdmin` protects the route; this protects
 * the function, which is where D3 puts enforcement.
 *
 * AND THE DATABASE BEHIND BOTH. `test_case` / `test_run` RLS is `app.is_admin()` on read and write
 * (0482), so the role half is enforced twice. The MODULE half is enforced ONLY here — RLS cannot see an
 * entitlement — which is why the refusal test in test/system-testing.test.ts uses an ADMIN session that
 * sails through every policy: a green refusal from a non-admin would be pinning RLS, not this gate
 * (CLAUDE.md §8).
 */
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { isAdmin } from '../lib/authz-model';
import { MODULE_CATALOG } from '../packs/catalog';
import { assertModuleEnabled, isModuleEnabled } from './entitlements';
import { submitFeedback } from './feedback';
import { tenantCounter, testCase, testRun, type TestRunOutcome } from '../db/schema';

/** The catalog code this module is sold as (ADR-0077). Default OFF: a tenant with no row cannot use it. */
export const SYSTEM_TESTING_MODULE = 'system_testing';

/**
 * The one module value that is NOT a catalogue code.
 *
 * The reporter's list ends in "Cross-Module" — a test that walks Leave into Payroll belongs to neither.
 * It cannot be a catalogue row: the catalogue is the COMMERCIAL inventory and
 * `test/module-catalog-drift.test.ts` pins it against the pack registry in both directions, so inventing
 * a product nobody sells to hold a UI option would corrupt the thing the list is derived from. So it is
 * a literal, here, named once.
 */
export const CROSS_MODULE_CODE = 'cross_module';

/**
 * Catalogue-as-text, constrained here rather than by a Postgres enum — the `employee_loan.loan_type`
 * precedent, and CLAUDE.md §6 (enforce how a row is decided in the service that decides it).
 *
 * ⚠️ NEITHER LIST CAME FROM THE REPORTER. The request named `test_type` and `priority` as fields and
 * gave no values for either, so these are this round's proposal, not a recorded requirement — which is
 * exactly why they are app-side: changing them is a code edit and six translations, not a migration
 * against a table that already has rows in it.
 */
export const TEST_TYPES = ['functional', 'negative', 'integration', 'regression', 'ui'] as const;
export type TestType = (typeof TEST_TYPES)[number];

export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Every outcome, in the order the UI offers them. `not_tested` is also the derived state of a case with no runs. */
export const OUTCOMES: readonly TestRunOutcome[] = ['pass', 'fail', 'blocked', 'partial', 'not_tested'];

/**
 * The outcomes that may be raised as a board item.
 *
 * The approved plan says "when a test FAILS, one press raises it". `blocked` and `partial` are included
 * too, and the reason is not generosity: all three mean the script did not pass, and a blocked run ("the
 * page 500s before step 3") is usually the most urgent of the three. `pass` and `not_tested` are refused
 * — there is nothing to report, and an item raised from a passing test would arrive at the board with a
 * description that contradicts itself.
 */
export const RAISEABLE_OUTCOMES: readonly TestRunOutcome[] = ['fail', 'blocked', 'partial'];

/** The counter kind `tenant_counter` issues case numbers under (the EMP- code idiom, core/comp.ts). */
const CASE_COUNTER_KIND = 'test_case_no';

export class SystemTestingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemTestingError';
  }
}

/** Old request shapes cannot establish instruction or assigned-execution provenance. */
export class SystemTestingMigrationRequiredError extends SystemTestingError {
  constructor(readonly code: 'versioned_authoring_required' | 'assigned_execution_required') {
    super(code === 'versioned_authoring_required'
      ? 'Use the versioned instruction editor to save and publish this case.'
      : 'Open your assigned instruction version and save an execution observation.');
    this.name = 'SystemTestingMigrationRequiredError';
  }
}

/** Refused when the caller is authenticated but not an administrator of this tenant. */
export class NotAdminError extends Error {
  constructor(message = 'Only an administrator can open System Testing.') {
    super(message);
    this.name = 'NotAdminError';
  }
}

/** See the header: module first, role second. Every exported read and write calls this first. */
function assertTestingAccess(ctx: SessionContext): void {
  assertModuleEnabled(ctx, SYSTEM_TESTING_MODULE);
  if (!isAdmin(ctx)) throw new NotAdminError();
}

export type TestableModule = { code: string; name: string };

/**
 * THE CONTROLLED MODULE LIST, DERIVED — never hardcoded.
 *
 * A test case filed against a module the tenant does not own is noise: nobody can run it, and it inflates
 * every coverage count with work that will never happen. So the options are the catalogue rows this
 * tenant actually resolves TRUE for — core modules included, since those are on for everyone — plus the
 * `cross_module` literal, always last because it is the fallback rather than a module.
 *
 * ⚠️ TWO OF THE EIGHT AREAS THE REPORTER NAMED ARE NOT CATALOGUE MODULES, and this function cannot
 * invent them. "Dashboard" and "Notice Board" are SCREENS, not things anyone buys — there is no
 * `MODULE_CATALOG` row for either, and adding one would assert a product that does not exist. Until the
 * reporter decides whether they want a second, non-commercial "area" taxonomy, a test about either is
 * filed as `cross_module`. Said out loud rather than papered over with a hardcoded pair of strings,
 * which is the version of this list the brief explicitly refused.
 *
 * Sorted by the catalogue's own `sortOrder` so the picker's order is the product's order, and stable as
 * modules come and go.
 */
export function listTestableModules(ctx: SessionContext): TestableModule[] {
  const enabled = [...MODULE_CATALOG]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((m) => {
      // A malformed or unresolved snapshot must not take the picker down: treat "cannot tell" as "not
      // offered" for that one code. The gate above has already decided the caller may be here at all.
      try {
        return isModuleEnabled(ctx, m.code);
      } catch {
        return false;
      }
    })
    .map((m) => ({ code: m.code, name: m.name }));
  return [...enabled, { code: CROSS_MODULE_CODE, name: 'Cross-Module' }];
}

/** Is `code` a legal `test_case.module_code` for THIS tenant right now? */
export function isTestableModule(ctx: SessionContext, code: string): boolean {
  return listTestableModules(ctx).some((m) => m.code === code);
}

export type TestCaseSummary = {
  id: string;
  caseNo: number;
  moduleCode: string;
  title: string;
  testType: string;
  priority: string;
  /** DERIVED from the newest run — never stored. `not_tested` when the case has never been run. */
  latestOutcome: TestRunOutcome;
  latestRunAt: Date | null;
  runCount: number;
};

export type TestCaseDetail = {
  id: string;
  caseNo: number;
  moduleCode: string;
  title: string;
  precondition: string | null;
  steps: string[];
  testType: string;
  priority: string;
  expectedBehavior: string | null;
  expectedFunction: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TestRunRow = {
  id: string;
  runNo: number;
  outcome: TestRunOutcome;
  actualResult: string | null;
  runAt: Date;
  feedbackRequestId: string | null;
};

/** Per-module tally for the progress strip: how many exist, how many have been run, how many fail. */
export type ModuleProgress = {
  moduleCode: string;
  total: number;
  run: number;
  failing: number;
};

/**
 * The library, newest-run state included.
 *
 * ONE QUERY, and the derived status is computed by the DATABASE rather than by a second round trip per
 * case. The `order by run_no desc limit 1` inside the lateral is the ordering CLAUDE.md §8 demands —
 * and it is `run_no`, not `run_at`, because `now()` is the transaction timestamp: two runs recorded in
 * one transaction share a `run_at` to the microsecond and "the newest" would be whatever the planner
 * felt like returning. The outer `order by case_no` pins the returned array the same way.
 */
export async function listTestCases(
  ctx: SessionContext,
  p: { moduleCode?: string | null } = {}, existingTx?: AiReadTx
): Promise<TestCaseSummary[]> {
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(grant => ({ ...grant })) };
  p = { moduleCode: p.moduleCode };

  assertTestingAccess(ctx);
  const filter = p.moduleCode?.trim() || null;
  return withCanonicalAiReadTx(ctx, existingTx, 'system_testing', withTenant, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT c.id,
             c.case_no,
             c.module_code,
             c.title,
             c.test_type,
             c.priority,
             r.outcome    AS latest_outcome,
             r.run_at     AS latest_run_at,
             COALESCE(n.run_count, 0) AS run_count
        FROM test_case c
        LEFT JOIN LATERAL (
               SELECT outcome, run_at
                 FROM test_run
                WHERE test_case_id = c.id
                ORDER BY run_no DESC
                LIMIT 1
             ) r ON TRUE
        LEFT JOIN LATERAL (
               SELECT count(*)::int AS run_count FROM test_run WHERE test_case_id = c.id
             ) n ON TRUE
       WHERE c.tenant_id = ${ctx.tenantId}
         AND (${filter}::text IS NULL OR c.module_code = ${filter})
       ORDER BY c.case_no
    `)) as unknown as {
      id: string;
      case_no: number;
      module_code: string;
      title: string;
      test_type: string;
      priority: string;
      latest_outcome: TestRunOutcome | null;
      // `string | Date`, and NOT `Date`, because that is what the driver actually returns for a
      // timestamptz read through raw SQL. Typing it `Date` here is the lie that produced the 500 the
      // mapper below now documents — so the honest type stays, and the coercion is forced.
      latest_run_at: string | Date | null;
      run_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      caseNo: Number(r.case_no),
      moduleCode: r.module_code,
      title: r.title,
      testType: r.test_type,
      priority: r.priority,
      // The ONE place the derived status is decided. A case with no runs is `not_tested` — the honest
      // answer, and the reason `not_tested` is in the outcome vocabulary at all.
      latestOutcome: r.latest_outcome ?? 'not_tested',
      /**
       * ⚠️ COERCED, AND THE COERCION IS LOAD-BEARING. A column selected through `tx.execute(sql`…`)`
       * comes back as the DRIVER decodes it, with none of the column-type mapping the drizzle query
       * builder applies — so `timestamptz` arrives here as a STRING while the declared type says
       * `Date`. TypeScript cannot see the difference (the cast above asserts the shape), so the lie
       * survived tsc, the suite and `next build`, and surfaced as `RangeError: Invalid time value` from
       * `Intl.DateTimeFormat` the first time the list page rendered a case that had actually been run —
       * a 500 on the feature's main screen, found only by rendering it (CLAUDE.md §8).
       *
       * `new Date(…)` is idempotent for a Date, so this is correct whichever the driver hands back.
       */
      latestRunAt: r.latest_run_at == null ? null : new Date(r.latest_run_at),
      runCount: Number(r.run_count),
    }));
  });
}

/**
 * Per-module progress, folded from the same rows the list renders.
 *
 * Deliberately NOT a second aggregate query: two queries answering "how many are failing" is two places
 * for the definition of failing to drift, and the definition here — the DERIVED latest outcome, not any
 * historical one — is the whole point. Ordered by module code so the strip is stable.
 */
export function summarizeByModule(rows: readonly TestCaseSummary[]): ModuleProgress[] {
  const acc = new Map<string, ModuleProgress>();
  for (const row of rows) {
    const cur = acc.get(row.moduleCode) ?? { moduleCode: row.moduleCode, total: 0, run: 0, failing: 0 };
    cur.total += 1;
    if (row.runCount > 0) cur.run += 1;
    if (row.latestOutcome === 'fail') cur.failing += 1;
    acc.set(row.moduleCode, cur);
  }
  return [...acc.values()].sort((a, b) => a.moduleCode.localeCompare(b.moduleCode));
}

/** One case with its whole run history, newest first. Null when the id is not this tenant's. */
export async function getTestCase(
  ctx: SessionContext,
  caseId: string,
): Promise<{ testCase: TestCaseDetail; runs: TestRunRow[] } | null> {
  assertTestingAccess(ctx);
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.select().from(testCase).where(eq(testCase.id, caseId)).limit(1);
    if (!row) return null;
    const runs = await tx
      .select({
        id: testRun.id,
        runNo: testRun.runNo,
        outcome: testRun.outcome,
        actualResult: testRun.actualResult,
        runAt: testRun.runAt,
        feedbackRequestId: testRun.feedbackRequestId,
      })
      .from(testRun)
      .where(eq(testRun.testCaseId, caseId))
      // run_no, not run_at — see the header of 0482. Newest first is what the screen reads top-down.
      .orderBy(sql`${testRun.runNo} DESC`);
    return {
      testCase: {
        id: row.id,
        caseNo: row.caseNo,
        moduleCode: row.moduleCode,
        title: row.title,
        precondition: row.precondition,
        steps: row.steps ?? [],
        testType: row.testType,
        priority: row.priority,
        expectedBehavior: row.expectedBehavior,
        expectedFunction: row.expectedFunction,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      runs,
    };
  });
}

function validateCaseInput(
  ctx: SessionContext,
  p: { moduleCode: string; title: string; testType?: string; priority?: string },
): { moduleCode: string; title: string; testType: TestType; priority: Priority } {
  const title = p.title?.trim();
  if (!title) throw new SystemTestingError('A title is required.');
  const moduleCode = p.moduleCode?.trim();
  if (!moduleCode) throw new SystemTestingError('A module is required.');
  if (!isTestableModule(ctx, moduleCode)) {
    // Named, not a generic "invalid": the likeliest cause is a module this tenant is not entitled to,
    // and the tester needs to know that rather than hunt for a typo.
    throw new SystemTestingError(
      `'${moduleCode}' is not a module this account can file a test against. Choose one of the modules on your plan, or Cross-Module.`,
    );
  }
  const testType = (p.testType?.trim() || 'functional') as TestType;
  if (!TEST_TYPES.includes(testType)) throw new SystemTestingError(`Unknown test type '${testType}'.`);
  const priority = (p.priority?.trim() || 'medium') as Priority;
  if (!PRIORITIES.includes(priority)) throw new SystemTestingError(`Unknown priority '${priority}'.`);
  return { moduleCode, title, testType, priority };
}

/**
 * The visible case number.
 *
 * `tenant_counter` with the same atomic `ON CONFLICT DO UPDATE … value + 1` that issues EMP- codes
 * (core/comp.ts issueLegacyEmployeeCode). Two admins creating a case at the same instant cannot be
 * handed the same number, and the unique index on (tenant_id, case_no) turns any path that escapes this
 * into a loud error rather than two "TC-0007"s.
 */
export async function nextTestCaseNoTx(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .insert(tenantCounter)
    .values({ tenantId, kind: CASE_COUNTER_KIND, value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounter.tenantId, tenantCounter.kind],
      set: { value: sql`${tenantCounter.value} + 1` },
    })
    .returning({ value: tenantCounter.value });
  return Number(row.value);
}

export async function createTestCase(
  ctx: SessionContext,
  p: {
    moduleCode: string;
    title: string;
    precondition?: string | null;
    steps?: string[];
    testType?: string;
    priority?: string;
    expectedBehavior?: string | null;
    expectedFunction?: string | null;
  },
): Promise<{ id: string; caseNo: number }> {
  assertTestingAccess(ctx);
  validateCaseInput(ctx, p);
  throw new SystemTestingMigrationRequiredError('versioned_authoring_required');
}

/**
 * Edit the script. The case NUMBER and its run history are not editable — a script people have run
 * against is a thing with provenance, and renumbering it would orphan every run record that cites it.
 */
export async function updateTestCase(
  ctx: SessionContext,
  p: {
    caseId: string;
    moduleCode: string;
    title: string;
    precondition?: string | null;
    steps?: string[];
    testType?: string;
    priority?: string;
    expectedBehavior?: string | null;
    expectedFunction?: string | null;
  },
): Promise<void> {
  assertTestingAccess(ctx);
  validateCaseInput(ctx, p);
  throw new SystemTestingMigrationRequiredError('versioned_authoring_required');
}

/**
 * Record one execution.
 *
 * `run_no` is allocated under an advisory transaction lock keyed on the case — the core/claims.ts idiom
 * — so two testers recording a run at the same moment serialise instead of both reading `max = 2`. The
 * unique index on (test_case_id, run_no) is the backstop that makes a race an error rather than a
 * silently reordered history.
 */
export async function recordTestRun(
  ctx: SessionContext,
  p: { caseId: string; outcome: TestRunOutcome; actualResult?: string | null },
): Promise<{ id: string; runNo: number }> {
  assertTestingAccess(ctx);
  if (!OUTCOMES.includes(p.outcome)) throw new SystemTestingError(`Unknown outcome '${p.outcome}'.`);
  throw new SystemTestingMigrationRequiredError('assigned_execution_required');
}

/**
 * The description the raised board item carries.
 *
 * Exported so the test can pin it without going through the database, and so the one place that decides
 * what a tester does NOT have to re-type is readable on its own. PLAIN TEXT: the board renders plans and
 * descriptions raw for a non-technical reader (CLAUDE.md §9), so no Markdown.
 */
export function composeFeedbackDescription(c: TestCaseDetail, run: TestRunRow): string {
  const lines = [
    `Raised from System Testing: test case TC-${String(c.caseNo).padStart(4, '0')} (${c.moduleCode}), run #${run.runNo} — ${run.outcome}.`,
    '',
  ];
  if (c.precondition) lines.push('Precondition:', c.precondition, '');
  if (c.steps.length > 0) {
    lines.push('Steps carried out:');
    c.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  lines.push('What actually happened:', run.actualResult?.trim() || '(not recorded)');
  return lines.join('\n');
}

/**
 * THE DEFECT LINK — a RAISE, not a typed ID.
 *
 * A hand-keyed "Defect ID" box is a second source of truth that can point at nothing (CLAUDE.md §1) and
 * makes the tester re-type the steps they just carried out. This raises the item on the EXISTING board
 * through `submitFeedback` — the same writer app/(app)/feedback/actions.ts calls, not a second one — and
 * stores the id it returns as a real foreign key.
 *
 * ADR0128 adds an explicit transaction seam to the canonical Feedback writer. The run lock, Feedback
 * insert/event and exact link now commit together. A repeated request returns the existing link.
 *
 * NO `reporter_label`. The plan's build notes suggested stamping it "the same mechanism that stamps
 * CLAUDE AI". That mechanism exists to show who actually wrote an item when the improvement loop borrows
 * a human's employment (0348) — here a real person pressed a real button, so their own name IS the
 * correct display name, and overwriting it would hide the author of a genuine in-app submission. The
 * item's origin is carried by the FK and by the first line of the description instead.
 */
export async function raiseRunAsFeedback(
  ctx: SessionContext,
  p: { runId: string; reporterEmploymentId?: string | null },
): Promise<{ feedbackId: string }> {
  assertTestingAccess(ctx);

  return withTenant(ctx, async (tx) => {
    const [run] = await tx.select().from(testRun).where(eq(testRun.id, p.runId)).for('update');
    if (!run) throw new SystemTestingError('That test run no longer exists.');
    if (run.executionId) throw new SystemTestingError('Raise personal execution feedback from its own execution review.');
    if (run.feedbackRequestId) return { feedbackId: run.feedbackRequestId };
    if (!RAISEABLE_OUTCOMES.includes(run.outcome)) throw new SystemTestingError(`A run recorded as '${run.outcome}' has nothing to report. Only a failed, blocked or partial run can be raised.`);
    const [c] = await tx.select().from(testCase).where(eq(testCase.id, run.testCaseId)).limit(1);
    if (!c) throw new SystemTestingError('That test case no longer exists.');
    const detail: TestCaseDetail = {
      id: c.id,
      caseNo: c.caseNo,
      moduleCode: c.moduleCode,
      title: c.title,
      precondition: c.precondition,
      steps: c.steps ?? [],
      testType: c.testType,
      priority: c.priority,
      expectedBehavior: c.expectedBehavior,
      expectedFunction: c.expectedFunction,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    };
    const runRow: TestRunRow = {
      id: run.id,
      runNo: run.runNo,
      outcome: run.outcome,
      actualResult: run.actualResult,
      runAt: run.runAt,
      feedbackRequestId: run.feedbackRequestId,
    };


    const { id: feedbackId } = await submitFeedback(ctx, {
      reporterEmploymentId: p.reporterEmploymentId, category: 'issue', title: detail.title,
      description: 'Original instruction version is unknown for this legacy observation. The following guide is the current library reference.\n\n' + composeFeedbackDescription(detail, runRow),
      expectedBehavior: detail.expectedBehavior, expectedFunction: detail.expectedFunction,
    }, tx);
    await tx.update(testRun).set({ feedbackRequestId: feedbackId }).where(eq(testRun.id, run.id));
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'test_case', aggregateId: c.id, eventType: 'test_run.raised', actor: actorOf(ctx), payload: { runId: run.id, runNo: run.runNo, feedbackRequestId: feedbackId } });
    return { feedbackId };
  });
}

// ADR0128: the versioned/personal extension shares this case identity and counter owner.
export * from './system-testing-workspace';
export * from './system-testing-catalogue';
export * from './system-testing-library';
