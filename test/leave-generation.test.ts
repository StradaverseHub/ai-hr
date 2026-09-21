/**
 * 93249794 — Generate Entitlement: the scope, the dry run, and the log.
 *
 * WHAT THIS ITEM CAN GET WRONG IS NOT ARITHMETIC. The arithmetic already existed and is already covered
 * (test/leave-carry-forward-expiry.test.ts, test/leave-entitlement-recalc.test.ts, r77-join-dates). What is
 * NEW here is a way to AIM that arithmetic at a subset, a preview that claims to predict it, and a written
 * record of what happened. Each of those has a specific way of being quietly wrong, and each gets a test:
 *
 *   • THE PREVIEW LIES. A validation step computed separately from the run agrees on the day it is written
 *     and drifts afterwards. The defence is that they are the SAME CALL — so the test that matters compares
 *     a dry run's counters and per-employee verdicts against the real run's, on the same fixture, and also
 *     proves the dry run left no trace at all.
 *   • AN EMPTY SCOPE MEANS EVERYONE. `resolveOrgCriteriaTargets` reads an empty axis as "no restriction",
 *     and `openLeaveYear` reads an empty `employmentIds` the same way. Compose those two naively and
 *     criteria that match NOBODY generate for the WHOLE TENANT. That is the single most expensive bug
 *     available in this file.
 *   • THE SCOPE WIDENS INSTEAD OF NARROWING. A leave type that the unscoped sweep would not grant must not
 *     become grantable by being ticked on a form.
 *   • A SECOND DEFINITION OF ENTITLEMENT appears. Guarded statically: this module may not import or call
 *     any of the composition helpers, because a module that cannot reach them cannot re-derive a day.
 *   • A COMPUTED i18n KEY IS INVISIBLE TO THE GUARD. `test/i18n-coverage.test.ts` check C only matches
 *     LITERAL keys, so `t(`generateOutcome_${outcome}`)` is invisible to it and renders as the raw key path
 *     on screen. Every value the union can take is checked here, in all six locales.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { openLeaveYear } from '../core/leave';
import { previewLeaveGeneration, runLeaveGeneration, listLeaveGenerationRuns, leaveGenerationRunCsv } from '../core/leave-generation';
import { ORG_CRITERIA_FIELDS, ORG_CRITERIA_RANGE_FIELDS } from '../core/org-criteria';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'zh', 'ms', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`));

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

const hire = (name: string, opts: { deptId?: string; hiredOn?: string } = {}) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `gen_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: opts.deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2020-01-01',
  });

const addType = async (code: string, name: string) => {
  const [t] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  return t.id;
};

/** 6e9a126e RELEASE THREE — the same "this type grants N days" fixture, on the entitlement template layer.
 *  Nothing else about it changes: no carry cap (an unruled type with no per-band carry resolves to 0, the
 *  old `carryForwardMax: 0`), and a validFrom well before every hire date so it is in force throughout. */
const policyFor = (leaveTypeId: string, annualDays: number) =>
  seedEntitlement(adminCtx(b), { leaveTypeId, annualDays, validFrom: '2020-01-01' });

/** Every accrual row this tenant's ledger holds at a year start — the thing a dry run must not create. */
const accrualRowsAt = async (effectiveOn: string): Promise<number> => {
  const [r] = await owner.db
    .select({ n: sql<string>`count(*)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.entryType, 'accrual'), eq(schema.leaveLedger.effectiveOn, effectiveOn)));
  return Number(r.n);
};

const runRowCount = async (): Promise<number> => {
  const [r] = await owner.db.select({ n: sql<string>`count(*)` }).from(schema.leaveGenerationRun);
  return Number(r.n);
};

const eventCount = async (eventType: string): Promise<number> => {
  const [r] = await owner.db
    .select({ n: sql<string>`count(*)` })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.eventType, eventType));
  return Number(r.n);
};

// ── A. THE PREVIEW IS THE RUN ────────────────────────────────────────────────────────────────────────

describe('93249794 · A. the dry run IS the run — one composition, one pass', () => {
  it('a preview writes NOTHING: no ledger row, no run row, no domain event', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    await hire('Mei Ling');
    await hire('Daniel Tan');

    const before = await accrualRowsAt('2026-01-01');
    const preview = await previewLeaveGeneration(adminCtx(b), { year: 2026, targetMode: 'criteria', criteria: {} });

    expect(preview.employeesSelected).toBe(2);
    expect(preview.granted).toBe(2);
    // The three traces a real run leaves, all absent.
    expect(await accrualRowsAt('2026-01-01')).toBe(before);
    expect(await runRowCount()).toBe(0);
    expect(await eventCount('leave-year.opened')).toBe(0);
    expect(await eventCount('leave-generation.run')).toBe(0);
    expect(preview.runId).toBeUndefined();
  });

  it('THE PREVIEW CANNOT LIE: its counters and per-employee verdicts equal the real run’s, exactly', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const sick = await addType('SICK', 'Sick Leave');
    await policyFor(sick, 14);
    // ⚠️ A TYPE WITH NO CONFIGURATION AT ALL IS NEVER VISITED — found by watching this test fail.
    // openLeaveYear's type set is "the statutory standing codes PLUS any type carrying a live policy or
    // scheme entitlement" (783bf55a / baea8e5b), so a type nobody has configured produces no line at all
    // rather than a `no_entitlement` line. To reach that outcome the type must be CONFIGURED and resolve
    // to nothing — here, a policy that explicitly says zero days.
    const zeroDays = await addType('STUDY', 'Study Leave');
    await policyFor(zeroDays, 0);
    await hire('Mei Ling');
    await hire('Daniel Tan');
    await hire('Farah');

    const req = { year: 2026, targetMode: 'criteria' as const, criteria: {} };
    const preview = await previewLeaveGeneration(adminCtx(b), req);
    const real = await runLeaveGeneration(adminCtx(b), req);

    // Not "roughly the same" — identical, because they are the same function call with one flag flipped.
    expect(real.granted).toBe(preview.granted);
    expect(real.skipped).toBe(preview.skipped);
    expect(real.forfeits).toBe(preview.forfeits);
    expect(real.employeesSelected).toBe(preview.employeesSelected);
    expect(real.employeesPassed).toBe(preview.employeesPassed);
    expect(real.employeesFailed).toBe(preview.employeesFailed);

    const key = (l: { employmentId: string; leaveTypeId: string; outcome: string; days: number }) =>
      `${l.employmentId}|${l.leaveTypeId}|${l.outcome}|${l.days}`;
    expect(real.lines.map(key).sort()).toEqual(preview.lines.map(key).sort());
    // …and the fixture really does exercise more than one outcome, or the equality above proves little.
    expect(new Set(preview.lines.map((l) => l.outcome)).size).toBeGreaterThan(1);
    expect(preview.lines.some((l) => l.leaveTypeId === zeroDays && l.outcome === 'no_entitlement')).toBe(true);
  });

  it('a second real run is idempotent: every pair reads already_open and no new accrual row is posted', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const emp = await hire('Mei Ling');
    const req = { year: 2026, targetMode: 'criteria' as const, criteria: {} };

    await runLeaveGeneration(adminCtx(b), req);
    const rowsAfterFirst = await accrualRowsAt('2026-01-01');
    const balanceAfterFirst = await ledgerBalance(emp.employmentId, b.annualLeaveTypeId);

    const second = await runLeaveGeneration(adminCtx(b), req);
    expect(second.granted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.lines.every((l) => l.outcome === 'already_open')).toBe(true);
    expect(await accrualRowsAt('2026-01-01')).toBe(rowsAfterFirst);
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(balanceAfterFirst);
    // ⚠️ AND THEY ARE NOT REPORTED AS FAILURES. A re-run is the normal way this screen is used; counting
    // `already_open` as failed would tell HR the whole company failed while the ledger is perfectly
    // correct. This is the assertion that would have caught the first cut of that summary.
    expect(second.employeesPassed).toBe(1);
    expect(second.employeesFailed).toBe(0);
  });
});

// ── B. THE SCOPE NARROWS, AND AN EMPTY SET IS NOT EVERYONE ───────────────────────────────────────────

describe('93249794 · B. the scope', () => {
  it('⚠️ criteria that match NOBODY generate for nobody — an empty target set is not "everyone"', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    await hire('Mei Ling', { deptId: b.deptA });
    await hire('Daniel Tan', { deptId: b.deptA });

    // deptB exists and has no employees. `resolveOrgCriteriaTargets` returns []; `openLeaveYear` reads an
    // empty employmentIds as NO RESTRICTION, so a naive pass-through would grant the whole tenant here.
    const res = await runLeaveGeneration(adminCtx(b), {
      year: 2026,
      targetMode: 'criteria',
      criteria: { departmentIds: [b.deptB] },
    });
    expect(res.employeesSelected).toBe(0);
    expect(res.granted).toBe(0);
    expect(res.lines).toEqual([]);
    expect(await accrualRowsAt('2026-01-01')).toBe(0);
  });

  it('an employee scope reaches only the selected employee', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const mei = await hire('Mei Ling', { deptId: b.deptA });
    const dan = await hire('Daniel Tan', { deptId: b.deptB });

    const res = await runLeaveGeneration(adminCtx(b), {
      year: 2026,
      targetMode: 'criteria',
      criteria: { departmentIds: [b.deptA] },
    });
    expect(res.employeesSelected).toBe(1);
    expect(res.lines.every((l) => l.employmentId === mei.employmentId)).toBe(true);
    expect(await ledgerBalance(dan.employmentId, b.annualLeaveTypeId)).toBe(0);
    expect(await ledgerBalance(mei.employmentId, b.annualLeaveTypeId)).toBe(12);
  });

  it('a leave-type scope narrows, and CANNOT widen what the unscoped sweep would grant', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const sick = await addType('SICK', 'Sick Leave');
    await policyFor(sick, 14);
    const unconfigured = await addType('STUDY', 'Study Leave');
    const emp = await hire('Mei Ling');

    const scoped = await runLeaveGeneration(adminCtx(b), {
      year: 2026,
      leaveTypeIds: [sick],
      targetMode: 'criteria',
      criteria: {},
    });
    expect(new Set(scoped.lines.map((l) => l.leaveTypeId))).toEqual(new Set([sick]));
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(0);
    expect(await ledgerBalance(emp.employmentId, sick)).toBe(14);

    // Ticking a type with NO entitlement configured does not conjure one. The scope INTERSECTS the set
    // the sweep already computed; it does not replace it. STUDY carries no policy and no scheme, so it is
    // not in that set at all and the run produces no line for it — asserted as EMPTY rather than with
    // `.every()`, which would pass vacuously on an empty array and prove nothing (it did, until this test
    // was run against a deliberately broken build).
    const widen = await previewLeaveGeneration(adminCtx(b), {
      year: 2027,
      leaveTypeIds: [unconfigured],
      targetMode: 'criteria',
      criteria: {},
    });
    expect(widen.granted).toBe(0);
    expect(widen.lines).toEqual([]);
  });

  it('individual mode still applies the shared active-in-the-year rule, not a second one', async () => {
    // ⚠️ r193 REVERSED HALF OF THIS CASE, DELIBERATELY, AND THE OTHER HALF STILL STANDS.
    //
    // As written, this asserted that somebody hired 2026-06-01 was "named explicitly, and still not a
    // target for 2026". That was the behaviour item a9d0a94a was raised against: on the reporting account
    // 18 of 40 active employments joined during the year and were dropped by this very selection, before
    // the engine was called, so Generate Entitlement gave them nothing and could not be made to. A mid-year
    // joiner IS a member of that leave year now, granted from their join date.
    //
    // What this case exists to prove is UNCHANGED and is still checked below: individual mode inherits the
    // ONE shared `resolveOrgCriteriaTargets` predicate rather than a second hand-written one, so naming
    // somebody who is genuinely outside the year does not force them in. The example simply had to move to
    // an employment that is genuinely outside it — hired after the year ENDS.
    await policyFor(b.annualLeaveTypeId, 12);
    const serving = await hire('Mei Ling', { hiredOn: '2020-01-01' });
    // Joined DURING 2026: a target now, and granted from their join date (r193 fault 2).
    const joiner = await hire('Newcomer', { hiredOn: '2026-06-01' });
    // Hired after 2026 ended: named explicitly, and still not a target for that year.
    const future = await hire('Next year', { hiredOn: '2027-06-01' });

    const res = await previewLeaveGeneration(adminCtx(b), {
      year: 2026,
      targetMode: 'individual',
      employmentIds: [serving.employmentId, joiner.employmentId, future.employmentId],
    });
    expect(res.employeesSelected).toBe(2);
    expect(res.lines.some((l) => l.employmentId === serving.employmentId)).toBe(true);
    expect(res.lines.some((l) => l.employmentId === joiner.employmentId)).toBe(true);
    expect(res.lines.every((l) => l.employmentId !== future.employmentId)).toBe(true);
  });

  it('the UNSCOPED call is byte-identical to the bare year-open it replaces', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    await hire('Mei Ling');
    await hire('Daniel Tan');

    // The engine, called the old way, on a fixture the wizard never touched.
    const direct = await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(direct.granted).toBe(2);
    // …and re-run through the module with no scope at all: same idempotent answer, nothing extra granted.
    const viaModule = await runLeaveGeneration(adminCtx(b), { year: 2026, targetMode: 'criteria', criteria: {} });
    expect(viaModule.granted).toBe(0);
    expect(viaModule.skipped).toBe(2);
  });
});

// ── C. THE PROCESSING LOG ────────────────────────────────────────────────────────────────────────────

describe('93249794 · C. the processing log records the run and decides nothing', () => {
  it('writes one run row plus one item per (employment, leave type), with the ENGINE’s own counts', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const sick = await addType('SICK', 'Sick Leave');
    await policyFor(sick, 14);
    await hire('Mei Ling');
    await hire('Daniel Tan');

    const res = await runLeaveGeneration(adminCtx(b), { year: 2026, targetMode: 'criteria', criteria: {} });
    expect(res.runId).toBeTruthy();

    const [run] = await owner.db
      .select()
      .from(schema.leaveGenerationRun)
      .where(eq(schema.leaveGenerationRun.id, res.runId!));
    expect(run.leaveYear).toBe(2026);
    expect(run.granted).toBe(res.granted);
    expect(run.skipped).toBe(res.skipped);
    expect(run.forfeits).toBe(res.forfeits);
    expect(run.employeesSelected).toBe(2);
    expect(run.employeesPassed).toBe(res.employeesPassed);
    expect(run.employeesFailed).toBe(res.employeesFailed);

    const items = await owner.db
      .select()
      .from(schema.leaveGenerationRunItem)
      .where(eq(schema.leaveGenerationRunItem.runId, res.runId!));
    expect(items).toHaveLength(res.lines.length);
    expect(items.length).toBe(2 * 2); // two employees × two configured types
    // One summary event, carrying the axis NAMES and never the criteria VALUES (ADR-0030 Layer 0).
    expect(await eventCount('leave-generation.run')).toBe(1);
  });

  it('the criteria are stored as ASKED, and sensitive demographic VALUES never enter the event log', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    const emp = await hire('Mei Ling');

    // ⚠️ THE CRITERIA MUST ACTUALLY MATCH, or this test proves nothing. A demographic axis nobody carries
    // resolves to an EMPTY target set, which (correctly) returns before the engine and writes no run row
    // at all — so the assertions below would fail on a missing row rather than on the payload. Found by
    // running it. The race is set explicitly here for that reason.
    await owner.db
      .update(schema.person)
      .set({ race: 'malay' })
      .where(eq(schema.person.id, emp.personId));
    const criteria = { departmentIds: [b.deptA], races: ['malay'] };
    const res = await runLeaveGeneration(adminCtx(b), { year: 2026, targetMode: 'criteria', criteria });
    expect(res.runId, 'the criteria must match somebody or this test is vacuous').toBeTruthy();
    const [run] = await owner.db
      .select({ criteria: schema.leaveGenerationRun.criteria })
      .from(schema.leaveGenerationRun)
      .where(eq(schema.leaveGenerationRun.id, res.runId!));
    expect(run.criteria).toEqual(criteria);

    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'leave-generation.run'));
    const payload = JSON.stringify(ev.payload);
    // The AXIS is logged so the run is explainable; the VALUE is not, because domain_event is immutable
    // and PDPA s.40 demographics written there could never be erased.
    expect(payload).toContain('races');
    expect(payload).not.toContain('malay');
  });

  it('the log is listable and downloads as a CSV naming the employee and the verdict', async () => {
    await policyFor(b.annualLeaveTypeId, 12);
    await hire('Mei Ling');
    const res = await runLeaveGeneration(adminCtx(b), { year: 2026, targetMode: 'criteria', criteria: {} });

    const runs = await listLeaveGenerationRuns(adminCtx(b), { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(res.runId);

    const csv = await leaveGenerationRunCsv(adminCtx(b), { runId: res.runId! });
    expect(csv.filename).toContain('leave-generation-2026-');
    expect(csv.content.split('\n')[0]).toContain('Outcome');
    expect(csv.content).toContain('Mei Ling');
    expect(csv.content).toContain('granted');
  });
});

// ── D. STATIC GUARDS — the two invariants a behaviour test cannot see ────────────────────────────────

describe('93249794 · D. no second entitlement definition, no second criteria engine', () => {
  const moduleSrc = read('core/leave-generation.ts');
  /** Source with comment lines dropped: this file's prose NAMES the things it must not call. */
  const code = moduleSrc
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('the module re-derives no days: it cannot even reach the composition helpers', () => {
    // If it cannot call them, it cannot compose a second answer. The engine composes; this module aims it.
    for (const forbidden of [
      'entitledDays',
      'bandFor',
      'schemeBandDays',
      'resolveGradePolicy',
      'applyLeaveTypeRules',
      'applyRounding',
      'applyMaxBalance',
      'resolveCarryAllowance',
      'buildSchemeEntitlementResolver',
      'projectExpectedEntitlement',
      'serviceYearsAt',
    ]) {
      expect(code.includes(forbidden), `core/leave-generation.ts must not reach ${forbidden}`).toBe(false);
    }
    // …and it writes no ledger row of its own. The engine owns the ledger.
    expect(code.includes('leaveLedger'), 'the generation module must never post a ledger row').toBe(false);
  });

  it('the preview and the run are ONE call differing only by `dryRun`', () => {
    // Two call sites would be two code paths, and two code paths drift. There is exactly one.
    expect(code.match(/openLeaveYear\(/g) ?? []).toHaveLength(1);
    // …and that ONE call is handed the flag rather than a literal, so neither entry point can pin it.
    // Asserted on MEANING, not on formatting: an earlier revision looked for the string `dryRun,` and
    // broke the moment the call was reformatted onto a single line, which protected nothing.
    expect(code).toMatch(/openLeaveYear\(ctx,\s*\{[^}]*\bdryRun\b[^}]*\}\)/);
    expect(code.includes('dryRun: true'), 'the flag is a parameter, never hardcoded at the call').toBe(false);
    expect(code.includes('dryRun: false')).toBe(false);
    for (const entry of ['previewLeaveGeneration', 'runLeaveGeneration']) {
      expect(code).toContain(`export async function ${entry}`);
    }
    expect(code).toContain('return generate(ctx, p, true);');
    expect(code).toContain('return generate(ctx, p, false);');
  });

  it('"who does this apply to" is the SHARED resolver, not a matcher of its own', () => {
    expect(code).toContain('resolveOrgCriteriaTargets');
    // CORRECTED after watching this fail: an earlier revision asserted the module never reads the
    // `employment` table at all. That is wrong and the test said so — `nameLines` joins employment→person
    // to put a NAME beside each verdict, which is a display lookup, not a matcher. What must not exist is
    // knowledge of the criteria VOCABULARY: a forked matcher has to name the axes it filters on, and this
    // module names none of them. Every axis below is checked, not a sample.
    for (const axis of [...ORG_CRITERIA_FIELDS, ...ORG_CRITERIA_RANGE_FIELDS]) {
      expect(code.includes(axis), `${axis} must live only in core/org-criteria.ts`).toBe(false);
    }
    // …and it filters no employment set of its own: the only WHERE it builds against employment is the
    // id-list lookup in nameLines.
    expect((code.match(/\.from\(employment\)/g) ?? []).length, 'one employment read: the name lookup').toBe(1);
  });

  it('RECALCULATE PREVIOUS YEAR is not in this release, and nothing here can rewrite a closed year', () => {
    // The plan calls it "the most sensitive thing in this request" and defers it. A parameter that quietly
    // existed would be the whole hazard, ready to be wired up by the next edit.
    for (const forbidden of ['recalculatePrevious', 'recalcPrevious', 'previousYear']) {
      expect(code.includes(forbidden), `${forbidden} must not exist yet`).toBe(false);
    }
    // No UPDATE of a ledger row anywhere in the module, and no sys: reason minted here.
    expect(code.includes('sys:')).toBe(false);
  });

  it('both screens build their criteria from the ONE shared builder', () => {
    // a6fe37fc Round 5 moved BOTH screens into /admin/leave-config/; the old pages are redirect stubs
    // that build no criteria at all, so the assertion follows the screens. The property is unchanged and
    // is the one that matters: two screens, ONE section list, so they cannot select different people
    // from the same words.
    for (const page of [
      'app/admin/leave-config/adjustments/page.tsx',
      'app/admin/leave-config/generate/page.tsx',
    ]) {
      expect(read(page), `${page} must call the shared builder`).toContain('buildOrgCriteriaSections');
    }
    // …and the builder is the only place the section list lives.
    const builder = read('core/org-criteria-form.ts');
    expect(builder).toContain('export function buildOrgCriteriaSections');
    for (const section of ['sectionCompany', 'sectionEmployment', 'sectionEmployee', 'sectionService']) {
      expect(builder).toContain(`t.crit('${section}')`);
    }
  });
});

// ── E. THE COMPUTED i18n KEYS — invisible to the coverage guard ──────────────────────────────────────

describe('93249794 · E. every computed message key resolves in all six locales', () => {
  /** The engine's outcome union, read from the SOURCE so a new branch cannot be added without a label. */
  const outcomes = (() => {
    const src = read('core/leave.ts');
    const start = src.indexOf('export type LeaveYearGrantOutcome =');
    const end = src.indexOf(';', src.indexOf("| 'pack_blocked'", start));
    return [...src.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  })();

  it('the union really was parsed (guards the test itself)', () => {
    expect(outcomes).toEqual([
      'granted',
      'unconfigured_method',
      'already_open',
      'frozen',
      'earned_method',
      'no_entitlement',
      'pack_blocked',
      // 508d3acd (r315) — the leave type's own identity conditions exclude this employee. Declared here
      // so the two assertions below cover it: the union really was parsed, and a label exists in all six
      // locales (the key is COMPUTED, so a missing one renders the raw key path behind a green suite).
      'not_eligible',
    ]);
  });

  it('generateOutcome_<value> exists for every outcome, in every locale', () => {
    // `t(`generateOutcome_${l.outcome}`)` is a COMPUTED key. test/i18n-coverage.test.ts check C only
    // matches literal keys, so a missing one renders the raw key path on screen behind a green suite.
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      for (const o of outcomes) {
        expect(typeof leave[`generateOutcome_${o}`], `${loc} admin.leave.generateOutcome_${o}`).toBe('string');
      }
    }
  });

  it('the three Generation Settings notes exist for every locale (also computed keys)', () => {
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      for (const k of ['Prorate', 'UntilMonth', 'Recalc']) {
        expect(typeof leave[`generateSetting${k}`], `${loc} generateSetting${k}`).toBe('string');
        expect(typeof leave[`generateSetting${k}Note`], `${loc} generateSetting${k}Note`).toBe('string');
      }
    }
  });

  it('every ICU key the flow interpolates carries its placeholders in every locale', () => {
    // A key containing {braces} is a FORMATTING CONTRACT. Calling it with no arguments throws
    // FORMATTING_ERROR at render while the route still returns 200 — the r140 hole. These five are called
    // WITH arguments; a locale that dropped a placeholder would silently print the wrong sentence.
    const contracts: Record<string, string[]> = {
      generateMatched: ['count'],
      generateReviewTypeCount: ['count'],
      generateDecidedByLine: ['rule', 'template', 'also'],
      generateRunsHeading: ['year'],
      generateRunsLine: ['selected', 'passed', 'failed', 'granted', 'forfeits'],
    };
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      for (const [key, placeholders] of Object.entries(contracts)) {
        const value = String(leave[key] ?? '');
        expect(value.length, `${loc} admin.leave.${key} missing`).toBeGreaterThan(0);
        for (const ph of placeholders) {
          expect(value.includes(`{${ph}`), `${loc} admin.leave.${key} must interpolate {${ph}}`).toBe(true);
        }
      }
    }
  });

  it('the plain new keys the flow reads exist in every locale', () => {
    const keys = [
      'generateFlowAria', 'generateStepTypes', 'generateStepSettings', 'generateStepWho',
      'generateStepValidate', 'generateStepProcess', 'generateAllTypesNote', 'generateSettingsIntro',
      'generateAsAtNote', 'generateEveryoneWarning', 'generateValidationHelp', 'generateValidationSelected',
      'generateValidationPassed', 'generateValidationFailed', 'generateIssuesNone', 'generateIssuesEmployee',
      'generateIssuesType', 'generateIssuesReason', 'generateDecidedByTitle', 'generateDecidedByNote',
      'generateReviewAllTypes', 'generateProcessNote', 'generateNothingToProcess', 'generateRunsTitle',
      'generateRunsNone', 'generateRunsDownload',
    ];
    for (const loc of LOCALES) {
      const leave = msgs(loc)?.admin?.leave ?? {};
      const missing = keys.filter((k) => typeof leave[k] !== 'string' || !String(leave[k]).length);
      expect(missing, `${loc} admin.leave is missing: ${missing.join(', ')}`).toEqual([]);
    }
  });
});
