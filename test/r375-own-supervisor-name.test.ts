/**
 * r375 (board 7c972a40) · AN EMPLOYEE MAY SEE THEIR OWN SUPERVISOR'S NAME — AND STILL NOTHING ELSE.
 *
 * THE DEFECT. Visibility in this product flows DOWNWARD. `app.can_see_employment` (0109) admits admins,
 * self, the recursive administrative down-walk and the head-of-department tree; `app.can_see_person`
 * (0029 / 0099) delegates to it. `reporting_line` SELECT is tenant-wide, so the subordinate sees the
 * EDGE — the joins to `employment` and `person` are what dropped the name. Two readers, two mechanisms:
 *
 *   • `reportingLinesFor` (core/read.ts) — one query, three tables inner-joined. `managers` came back
 *     EMPTY for a plain employee, so the five "Goes to" places fell through to `t('otGoesToUnknown')`.
 *     THAT KEY IS NOT AN UNKNOWN. Its value is "Your HR administrator" — a confident, specific answer,
 *     and the WRONG desk for anybody who has a supervisor. `assertCanDecide` (core/approvals.ts) admits
 *     an hr_admin/super_admin OR the subject's current direct administrative manager OR an active
 *     delegate, so HR is a PERMITTED decider; it is simply not the normal one.
 *   • `administrativeManagerNameTx` (core/roster.ts), called by `myRosterWindow` — NOT one join. It read
 *     `reporting_line` alone first (that half SUCCEEDED, tenant-wide) and then joined employment →
 *     person in a second query, which returned no row. So My Roster printed "speak to your supervisor"
 *     where the approved design prints the name.
 *
 * THE FIX, AND WHAT IT IS NOT. Migration 0498 adds `app.own_reporting_managers(uuid)`, a SECURITY
 * DEFINER reader of display identity only. `app.can_see_person` and `app.can_see_employment` are
 * UNTOUCHED — that function also gates date_of_birth, gender, marital status, religion, RACE (PDPA 2010
 * s.40 sensitive), address_line1..3, personal email and phone, plus the statutory row, dependents, TP1,
 * TP3, the photo and emergency contacts. Migration 0472 refused this exact widening for the leave
 * approver names; this round refuses it again. The negative half of this file is what makes that claim
 * checkable rather than asserted: the same employee session that now READS THE NAME is pointed straight
 * at `compensation`, `employee_statutory_my`, `person` and `employment` AS ai_hr_app, against rows
 * proven to exist, and gets zero.
 *
 * ONE EXPRESSION, TWO PATHS. `ownReportingManagersTx` is the only consumer of the function, and both
 * `reportingLinesFor` and the roster helper read it. The five "Goes to" call sites were not edited at
 * all — they simply start resolving, which is the evidence the rule lives in one place. Section 4 pins
 * that contract across both files (the call expression AND the key's value), because either half alone
 * can be true while the screen says the wrong thing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { ownReportingManagersTx, reportingLinesFor } from '../core/read';
import { myRosterWindow } from '../core/roster';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
/** Derived from the clock, never hardcoded (CLAUDE.md §8). 0498 judges "today" in the tenant's calendar. */
const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A window `assertRosterWindow` accepts, anchored on the clock. */
const WINDOW = () => ({ from: TODAY, to: addDays(TODAY, 6) });

async function hire(fullName: string, role: 'employee' | 'manager' | 'hr_admin', departmentId?: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `r375_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const ctx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, e.personId, role),
    personId: e.personId,
    roles: [role],
    entitlements: harnessSnapshot(b.tenantId),
  } as SessionContext;
  return { ...e, fullName, ctx };
}
type Who = Awaited<ReturnType<typeof hire>>;

/** A STRUCTURAL line, through the service that owns the effective-dating and the supersede event. */
const line = (sub: Who, man: Who, lineType: 'administrative' | 'functional' | 'project' | 'dotted', validFrom: string) =>
  setReportingLine(adminCtx(b), {
    subordinateEmploymentId: sub.employmentId,
    managerEmploymentId: man.employmentId,
    lineType,
    validFrom,
  });

/** A `delegate` edge, inserted as OWNER on purpose: this file tests 0498's FILTER on the row, not the
 *  delegation service's own rules about windows and scope. Returns the id so its existence is provable. */
async function delegateEdge(sub: Who, stand: Who): Promise<string> {
  const [row] = await owner.db
    .insert(schema.reportingLine)
    .values({
      tenantId: b.tenantId,
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2020-01-01',
    })
    .returning({ id: schema.reportingLine.id });
  return row.id;
}

/** An employee code the screens can print. Written as owner so the test is about VISIBILITY, not writes. */
const stampCode = (employmentId: string, code: string) =>
  owner.db.update(schema.employment).set({ employeeCode: code }).where(eq(schema.employment.id, employmentId));

/** The sensitive rows the fix must NOT reach. Written as owner, then PROVEN to exist, so a later zero is
 *  a refusal rather than an absence — the difference between a guard and a tautology. */
async function seedSensitive(who: Who) {
  await owner.db.insert(schema.compensation).values({
    tenantId: b.tenantId,
    employmentId: who.employmentId,
    basicSalary: '13750.00',
    currency: 'MYR',
    validFrom: '2020-01-01',
  });
  await owner.db.insert(schema.employeeStatutoryMy).values({
    tenantId: b.tenantId,
    personId: who.personId,
    icNumber: '880101145566',
    epfNumber: 'EPF-SECRET-1',
  });
}

/** Counts read AS ai_hr_app in the given session — the TABLES, not a service wrapper. A green refusal
 *  through a service may be pinning the service's guard rather than RLS (CLAUDE.md §8). */
async function sensitiveCounts(ctx: SessionContext, who: Who) {
  return withTenant(ctx, async (tx) => {
    const one = async (q: SQL): Promise<number> => {
      const rows = (await tx.execute(q)) as unknown as { n: number | string }[];
      return Number((rows[0] ?? { n: 0 }).n);
    };
    return {
      compensation: await one(
        sql`SELECT count(*)::int AS n FROM compensation WHERE employment_id = ${who.employmentId}::uuid`,
      ),
      statutory: await one(
        sql`SELECT count(*)::int AS n FROM employee_statutory_my WHERE person_id = ${who.personId}::uuid`,
      ),
      person: await one(sql`SELECT count(*)::int AS n FROM person WHERE id = ${who.personId}::uuid`),
      employment: await one(sql`SELECT count(*)::int AS n FROM employment WHERE id = ${who.employmentId}::uuid`),
    };
  });
}

const NOTHING = { compensation: 0, statutory: 0, person: 0, employment: 0 };

const adminManagers = async (ctx: SessionContext, employmentId: string) =>
  (await reportingLinesFor(ctx, employmentId)).managers.filter((m) => m.lineType === 'administrative');

const ownRows = (ctx: SessionContext, employmentId: string) =>
  withTenant(ctx, (tx) => ownReportingManagersTx(tx, employmentId));

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ── 1 · THE EMPLOYEE NOW READS THE NAME, AND STILL NOTHING ELSE ─────────────────────────────────────

describe('an employee reads their own administrative supervisor', () => {
  it('gets the name and the employee ID through reportingLinesFor', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await stampCode(mgr.employmentId, 'EMP-0008');
    await line(emp, mgr, 'administrative', '2020-01-01');

    const admins = await adminManagers(emp.ctx, emp.employmentId);
    expect(admins, 'exactly one administrative supervisor, not the same edge twice').toHaveLength(1);
    expect(admins[0].name, 'THE DEFECT: this was undefined, so the screens printed "Your HR administrator"').toBe(
      'Farid Hassan',
    );
    expect(admins[0].employeeCode, 'the header renders "EMP-0008 – Farid Hassan"').toBe('EMP-0008');
    expect(admins[0].employmentId).toBe(mgr.employmentId);
    expect(admins[0].personId).toBe(mgr.personId);
  });

  it('REFUSES the rest of that manager’s file — read as ai_hr_app, against rows proven to exist', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');
    await seedSensitive(mgr);

    // The same tables, read by somebody who IS entitled — so the zeros below are RLS, not an empty database.
    const asAdmin = await sensitiveCounts(adminCtx(b), mgr);
    expect(asAdmin.compensation, 'sanity: the manager HAS a pay row').toBeGreaterThan(0);
    expect(asAdmin.statutory, 'sanity: the manager HAS a statutory row').toBeGreaterThan(0);
    expect(asAdmin.person, 'sanity: the manager HAS a person row').toBeGreaterThan(0);
    expect(asAdmin.employment, 'sanity: the manager HAS an employment row').toBeGreaterThan(0);

    // Non-vacuous in both directions: the name IS on offer…
    expect((await adminManagers(emp.ctx, emp.employmentId))[0].name).toBe('Farid Hassan');
    // …and every other row of that person is not. `person` and `employment` included: the NAME arrives
    // through the definer function, NEVER because the subordinate may now read the manager's records.
    expect(await sensitiveCounts(emp.ctx, mgr)).toEqual(NOTHING);
  });

  it('My Roster prints the supervisor’s name — the OTHER code path, which had its own helper', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');

    const view = await myRosterWindow(emp.ctx, WINDOW());
    expect(view, 'the employee has an employment, so the screen renders').not.toBeNull();
    expect(view!.employmentId).toBe(emp.employmentId);
    // app/attendance/my-roster/page.tsx prints t('myRoster.supervisorNamed') and t('myRoster.readOnlyNamed')
    // when this is non-null, and the name-free t('myRoster.readOnly') when it is null.
    expect(view!.managerName, 'THE DEFECT: null here is "speak to your supervisor" instead of the name').toBe(
      'Farid Hassan',
    );
  });

  it('keeps the honest fallback when there is genuinely no supervisor', async () => {
    const emp = await hire('Solo Employee', 'employee');
    expect(await adminManagers(emp.ctx, emp.employmentId)).toEqual([]);
    const view = await myRosterWindow(emp.ctx, WINDOW());
    expect(view!.managerName, 'no line ⇒ no name invented; "Your HR administrator" is then TRUE').toBeNull();
  });

  it('returns non-administrative lines too, and NEVER a delegate edge', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    const func = await hire('Priya Functional', 'manager');
    const stand = await hire('Standin Delegate', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');
    await line(emp, func, 'functional', '2020-01-01');
    const delegateId = await delegateEdge(emp, stand);

    const [exists] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, delegateId));
    expect(exists.n, 'sanity: the delegate edge is really there, so its absence below is a FILTER').toBe(1);

    const rows = await ownRows(emp.ctx, emp.employmentId);
    expect(
      rows.map((r) => [r.lineType, r.name]),
      'expected_behavior asks for the reporting line, not only the administrative edge — but a delegate ' +
        'is an approver stand-in, not a supervisor (ADR-0052)',
    ).toEqual([
      ['administrative', 'Farid Hassan'],
      ['functional', 'Priya Functional'],
    ]);
    expect(rows.map((r) => r.name)).not.toContain('Standin Delegate');
    // And the roster, which asks the same helper, still names only the person who plans the roster.
    expect((await myRosterWindow(emp.ctx, WINDOW()))!.managerName).toBe('Farid Hassan');
  });

  it('is CURRENT only: an ended line, a future line and a superseded line are all silent', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const past = await hire('Previous Boss', 'manager');
    const now = await hire('Current Boss', 'manager');
    // The second line CLOSES the first at its own start date (both in the past), which is how a handover
    // is really recorded — so "ended" here is the service's own doing, not a hand-written valid_to.
    await line(emp, past, 'administrative', '2020-01-01');
    await line(emp, now, 'administrative', '2021-01-01');
    expect(
      (await ownRows(emp.ctx, emp.employmentId)).map((r) => r.name),
      'the line in force today, and NOT the one it replaced',
    ).toEqual(['Current Boss']);

    // FUTURE: a different employee whose only line starts a month from now.
    const soon = await hire('Not Yet Employee', 'employee');
    const next = await hire('Next Boss', 'manager');
    await line(soon, next, 'administrative', addDays(TODAY, 30));
    expect(await ownRows(soon.ctx, soon.employmentId), 'a supervisor who has not started is not an answer').toEqual(
      [],
    );
    expect((await myRosterWindow(soon.ctx, WINDOW()))!.managerName).toBeNull();

    // SUPERSEDED: a correction. Stamped directly so the FILTER is what is under test.
    const stamped = await owner.db
      .update(schema.reportingLine)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(schema.reportingLine.subordinateEmploymentId, emp.employmentId),
          eq(schema.reportingLine.managerEmploymentId, now.employmentId),
        ),
      )
      .returning({ id: schema.reportingLine.id });
    expect(stamped.length, 'sanity: a row was really stamped, so the emptiness below means something').toBe(1);
    expect(await ownRows(emp.ctx, emp.employmentId)).toEqual([]);
    expect((await myRosterWindow(emp.ctx, WINDOW()))!.managerName).toBeNull();
  });

  it('is ONE HOP: the employee cannot walk up past their own supervisor', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    const boss = await hire('Bella Boss', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');
    await line(mgr, boss, 'administrative', '2020-01-01');

    // Their own supervisor: named.
    expect((await adminManagers(emp.ctx, emp.employmentId))[0].name).toBe('Farid Hassan');
    // Their supervisor's supervisor: the function is asked directly, with the manager's own employment
    // id, and answers nothing — that employment is not this person's.
    expect(await ownRows(emp.ctx, mgr.employmentId), 'one step up, not the chain above them').toEqual([]);
    expect(await adminManagers(emp.ctx, mgr.employmentId)).toEqual([]);
  });
});

// ── 2 · EVERY OTHER ROLE, INCLUDING THE PEER WHO MUST STILL SEE NOTHING ─────────────────────────────

describe('per role — what each session gets, and the negatives', () => {
  it('a PEER employee still cannot see a colleague’s supervisor', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const peer = await hire('Colin Colleague', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');
    await line(peer, mgr, 'administrative', '2020-01-01');

    // The peer shares the SAME supervisor, so they learn that name legitimately through their OWN line…
    expect((await adminManagers(peer.ctx, peer.employmentId))[0].name).toBe('Farid Hassan');
    // …but asking about the colleague's employment answers nothing: this is not a directory.
    expect(await ownRows(peer.ctx, emp.employmentId)).toEqual([]);
    expect(await adminManagers(peer.ctx, emp.employmentId)).toEqual([]);

    // And a peer with a DIFFERENT supervisor leaks nothing into this employee's read.
    const other = await hire('Other Employee', 'employee');
    const hidden = await hire('Hidden Supervisor', 'manager');
    await line(other, hidden, 'administrative', '2020-01-01');
    const seen = (await adminManagers(emp.ctx, emp.employmentId)).map((m) => m.name);
    expect(seen).toEqual(['Farid Hassan']);
    expect(seen, 'nobody else’s supervisor appears').not.toContain('Hidden Supervisor');
    expect(await ownRows(emp.ctx, other.employmentId)).toEqual([]);
  });

  it('a MANAGER gains nothing new, and keeps the downward visibility they had', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    // THE BOSS SITS IN A DIFFERENT DEPARTMENT ON PURPOSE. `app.heads_department_of` (live def 0121) is
    // true for any caller who manages SOMEBODY and whose department subtree contains the subject — see
    // the "pre-existing" test below — so a boss in the SAME department is already visible for reasons
    // that have nothing to do with r375. Putting them in the sibling department (Operations vs Finance,
    // no parent link) switches that branch off, so the only thing left that can name them is 0498.
    const boss = await hire('Bella Boss', 'manager', b.deptB);
    await line(emp, mgr, 'administrative', '2020-01-01');
    await line(mgr, boss, 'administrative', '2020-01-01');
    await seedSensitive(emp);

    // UNCHANGED, and this is the half a widening would have put at risk: the manager still reads their
    // report's record through RLS, exactly as before.
    expect((await adminManagers(mgr.ctx, emp.employmentId))[0].name).toBe('Farid Hassan');
    const downward = await sensitiveCounts(mgr.ctx, emp);
    expect(downward.employment, 'downward visibility is untouched: can_see_employment admits the report').toBe(1);
    expect(downward.person, 'and can_see_person follows it, which is how the manager screens name them').toBe(1);
    // MEASURED, not assumed, and narrower than this test first claimed: a plain line manager CANNOT read
    // their report's PAY. compensation_rls (0099) asks can_admin_employment / perfcomp / payroll / self —
    // the administrative down-walk is not one of them, and 0109's own header says so ("indirect managers
    // gain employment visibility, NOT pay visibility"). r375 changed neither.
    expect(downward.compensation, 'pay is NOT part of a line manager’s downward visibility').toBe(0);
    expect(downward.statutory, 'nor is the statutory identity row').toBe(0);

    // NEW, and the only new thing: a manager is also somebody's report, so they now read their own boss.
    expect((await adminManagers(mgr.ctx, mgr.employmentId))[0].name).toBe('Bella Boss');
    // …and NOTHING else about that boss opened up — not even the employment or person ROW. This is the
    // assertion that distinguishes "a narrow definer reader" from "we widened the policy".
    expect(await sensitiveCounts(mgr.ctx, boss)).toEqual(NOTHING);
  });

  it('PRE-EXISTING, not r375: a manager already sees same-department colleagues through heads_department_of', async () => {
    // Pinned as an OBSERVATION so nobody later reads it as something this round did, and so that
    // tightening `app.heads_department_of` turns this red rather than silently changing the premise the
    // item was written on.
    //
    // The live definition (0121, unchanged by r375) never consults `department.head_employment_id`. It
    // is true when the caller has a current department assignment, the subject's department is in the
    // caller's company-clamped department subtree, AND the caller is the current administrative manager
    // of AT LEAST ONE person — any person. So in a single-department company every manager already reads
    // every colleague's employment and person row, their own boss included.
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    const sameDeptBoss = await hire('Bella Boss', 'manager'); // deptA, like mgr
    await line(emp, mgr, 'administrative', '2020-01-01');
    await line(mgr, sameDeptBoss, 'administrative', '2020-01-01');
    await seedSensitive(sameDeptBoss);

    const counts = await sensitiveCounts(mgr.ctx, sameDeptBoss);
    expect(counts.employment, 'the department branch, not r375').toBe(1);
    expect(counts.person, 'the department branch, not r375').toBe(1);
    // The important half: it is still NOT a pay or identity leak, and r375 did not make it one.
    expect(counts.compensation).toBe(0);
    expect(counts.statutory).toBe(0);

    // And it requires managing somebody: a PLAIN employee in the same department sees neither row, which
    // is exactly why this item existed at all.
    const plain = await hire('Plain Employee', 'employee');
    await line(plain, mgr, 'administrative', '2020-01-01');
    const asPlain = await sensitiveCounts(plain.ctx, sameDeptBoss);
    expect(asPlain, 'a plain employee manages nobody, so the branch never fires for them').toEqual(NOTHING);
  });

  it('an HR ADMIN reads the same answer it always did (there is no admin branch in the function)', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    const hr = await hire('Hana HR', 'hr_admin');
    await line(emp, mgr, 'administrative', '2020-01-01');

    expect((await adminManagers(hr.ctx, emp.employmentId))[0].name).toBe('Farid Hassan');
    // HR is not this employee's person, so the definer function is silent for them — they never needed it.
    expect(await ownRows(hr.ctx, emp.employmentId)).toEqual([]);
  });

  it('CROSS-TENANT and a forged session read nothing', async () => {
    const empA = await hire('Nadia Employee', 'employee');
    const mgrA = await hire('Farid Hassan', 'manager');
    await line(empA, mgrA, 'administrative', '2020-01-01');

    const bA = b;
    b = await seedBase();
    const empB = await hire('Foreign Employee', 'employee');
    const mgrB = await hire('Foreign Supervisor', 'manager');
    await line(empB, mgrB, 'administrative', '2020-01-01');
    expect(
      (await ownRows(empB.ctx, empB.employmentId)).map((r) => r.name),
      'sanity: tenant B’s own employee reads tenant B’s supervisor',
    ).toEqual(['Foreign Supervisor']);
    b = bA;

    // Tenant A's employee asking for tenant B's employment: nothing.
    expect(await ownRows(empA.ctx, empB.employmentId)).toEqual([]);
    // A context whose tenant GUC does not match its user — the forged-session shape — reads nothing either,
    // in BOTH directions, because the ownership check is tenant-scoped as well as person-scoped.
    const forged = { ...empA.ctx, tenantId: empB.ctx.tenantId } as SessionContext;
    expect(await ownRows(forged, empB.employmentId)).toEqual([]);
    expect(await ownRows(forged, empA.employmentId)).toEqual([]);
  });

  it('a session with no linked login reads nothing, and cannot probe which ids exist', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');
    // Same tenant, a REAL employment id, no user. NO ROWS rather than an error — so a caller learns
    // nothing from the difference between a real id and an invented one.
    const anonymous = { ...emp.ctx, userId: undefined } as unknown as SessionContext;
    expect(await ownRows(anonymous, emp.employmentId)).toEqual([]);
    expect(await ownRows(anonymous, randomUUID())).toEqual([]);
  });
});

// ── 3 · THE FUNCTION ITSELF: SHAPE, PRIVILEGE, AND THE search_path ATTACK ───────────────────────────

describe('migration 0498 — the object, not its behaviour', () => {
  it('returns display identity and the dates its callers need, and NO other column', async () => {
    const cols = (
      await owner.db.execute(sql`
        SELECT unnest(p.proargnames) AS name, unnest(p.proargmodes) AS mode
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'own_reporting_managers'`)
    )
      .filter((r) => (r as { mode: string }).mode === 't')
      .map((r) => (r as { name: string }).name);
    expect(cols, 'a new column here is a widening — it has to be added deliberately, in this list').toEqual([
      'reporting_line_id',
      'line_type',
      'manager_employment_id',
      'manager_person_id',
      'full_name',
      'employee_code',
      'valid_from',
      'valid_to',
    ]);
  });

  it('is SECURITY DEFINER with a pinned search_path, revoked from PUBLIC and granted to ai_hr_app', async () => {
    const meta = await owner.db.execute(sql`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('ai_hr_app', p.oid, 'EXECUTE') AS app_exec,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' AND p.proname = 'own_reporting_managers'`);
    expect(meta.map((m) => ({ ...(m as Record<string, unknown>) }))).toEqual([
      {
        proname: 'own_reporting_managers',
        prosecdef: true,
        // pg_temp named explicitly and LAST — `search_path = public` alone still searches pg_temp FIRST
        // (migration 0312's rule), which is the attack the next test runs.
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        app_exec: true,
        public_exec: false,
      },
    ]);
  });

  it('a TEMP app_user table naming a colleague does NOT reveal that colleague’s supervisor', async () => {
    const attacker = await hire('Adam Attacker', 'employee');
    const victim = await hire('Vera Victim', 'employee');
    const secret = await hire('Secret Supervisor Name', 'manager');
    await line(victim, secret, 'administrative', '2020-01-01');

    // Non-vacuous: the owner of that line IS told the name.
    expect((await ownRows(victim.ctx, victim.employmentId)).map((r) => r.name)).toEqual(['Secret Supervisor Name']);

    const shadowed = await withTenant(attacker.ctx, async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE app_user (id uuid, tenant_id uuid, person_id uuid) ON COMMIT DROP`);
      await tx.execute(
        sql`INSERT INTO pg_temp.app_user VALUES (${attacker.ctx.userId}::uuid, ${b.tenantId}::uuid, ${victim.personId}::uuid)`,
      );
      return ownReportingManagersTx(tx, victim.employmentId);
    });
    expect(shadowed, 'the ownership check reads public.app_user, not whatever the caller created').toEqual([]);
  });

  it('is journalled, so it actually runs', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', 'db/migrations/meta/_journal.json'), 'utf8');
    const journal = JSON.parse(raw) as { entries: { idx: number; tag: string; when: number }[] };
    const mine = journal.entries.find((e) => e.tag === '0498_own_reporting_managers');
    expect(mine, 'a .sql without a journal entry NEVER runs (CLAUDE.md §6)').toBeDefined();
    const position = journal.entries.findIndex((e) => e.tag === '0498_own_reporting_managers');
    expect(position, 'the compared journal prefix must contain the prior migrations').toBeGreaterThan(400);
    const prior = journal.entries.slice(0, position);
    // Compare with the applied prefix, not future migrations appended after this one.
    expect(mine!.idx, 'above all prior migration indices').toBeGreaterThan(Math.max(...prior.map((e) => e.idx)));
    expect(mine!.when, 'above the prior applied watermark, or drizzle silently skips it').toBeGreaterThan(
      Math.max(...prior.map((e) => e.when)),
    );
  });
});

// ── 4 · THE CONTRACT BETWEEN THE FIVE SCREENS AND THE MESSAGE CATALOGUE ─────────────────────────────

describe('the five "Goes to" places — pinned across both files', () => {
  const GOES_TO_FILES = [
    'app/attendance/request-status/page.tsx',
    'app/attendance/request-status/export/route.ts',
    'app/attendance/requests/page.tsx',
    'app/attendance/plan-ot/page.tsx',
    'app/attendance/plan-ot/apply/page.tsx',
  ];

  it('all five still resolve the name through reportingLinesFor, with the fallback behind it', () => {
    expect(GOES_TO_FILES, 'five, per the item — a sixth place would need its own look').toHaveLength(5);
    for (const rel of GOES_TO_FILES) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      // A grep over source asserts NOTHING unless the source was actually read (CLAUDE.md §8). The
      // smallest of these five files is ~8 KB, so 2000 is a floor no real edit crosses.
      expect(src.length, `${rel} must be a real file, not an empty read`).toBeGreaterThan(2000);
      expect(src, `${rel} must still read the shared reporting-line expression`).toContain('reportingLinesFor');
      expect(src, `${rel} must still resolve the administrative manager's name`).toContain(
        "lines.managers.find((m) => m.lineType === 'administrative')?.name ?? t('otGoesToUnknown')",
      );
    }
  });

  it('and the fallback key is NOT an unknown — its value names HR, which is why it had to become rare', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', 'messages/en.json'), 'utf8');
    expect(raw.length, 'sanity: the catalogue was really read').toBeGreaterThan(10_000);
    const en = JSON.parse(raw) as Record<string, unknown>;
    let value: unknown;
    for (const ns of Object.values(en)) {
      if (ns != null && typeof ns === 'object' && 'otGoesToUnknown' in (ns as Record<string, unknown>)) {
        value = (ns as Record<string, unknown>).otGoesToUnknown;
      }
    }
    // RETIRED, NEVER DELETED (CLAUDE.md §8): the key keeps its name AND its value, because an employee
    // with genuinely no supervisor really does have these requests decided by HR (`assertCanDecide`
    // admits an hr_admin / super_admin). What r375 changes is how OFTEN it is reached, not what it says.
    expect(value, 'the misleading NAME is the point: this is a confident answer, not a shrug').toBe(
      'Your HR administrator',
    );
  });

  it('and the name they resolve is the SAME one My Roster prints — one rule, not two', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const mgr = await hire('Farid Hassan', 'manager');
    await line(emp, mgr, 'administrative', '2020-01-01');

    // The exact expression the five screens evaluate.
    const lines = await reportingLinesFor(emp.ctx, emp.employmentId);
    const goesTo = lines.managers.find((m) => m.lineType === 'administrative')?.name;
    const rosterName = (await myRosterWindow(emp.ctx, WINDOW()))!.managerName;
    expect(goesTo).toBe('Farid Hassan');
    expect(rosterName, 'the roster path had its OWN query until r375; a drift here is the whole defect').toBe(goesTo);
  });
});

// ── 5 · NOTHING WAS TAKEN AWAY ──────────────────────────────────────────────────────────────────────

describe('the union is additive', () => {
  it('a future-dated open line stays visible to the admin who could always see it', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const next = await hire('Next Boss', 'manager');
    // `reportingLinesFor` filters `valid_to IS NULL` and never checks valid_from, so this row is part of
    // what an admin sees TODAY. 0498 answers only for the line in force, so the union must keep it: this
    // is the assertion that would have caught "replace the list" instead of "union into it".
    await line(emp, next, 'administrative', addDays(TODAY, 30));

    expect(
      (await adminManagers(adminCtx(b), emp.employmentId)).map((m) => m.name),
      'the admin read is the behaviour it had before the union',
    ).toEqual(['Next Boss']);
    // And the employee does NOT get it — a supervisor who has not started is not an answer to
    // "who decides my request".
    expect(await adminManagers(emp.ctx, emp.employmentId)).toEqual([]);
  });

  it('the `reports` half is unchanged, and no edge is listed twice', async () => {
    const mgr = await hire('Farid Hassan', 'manager');
    const boss = await hire('Bella Boss', 'manager');
    const r1 = await hire('Report One', 'employee');
    const r2 = await hire('Report Two', 'employee');
    await line(mgr, boss, 'administrative', '2020-01-01');
    await line(r1, mgr, 'administrative', '2020-01-01');
    await line(r2, mgr, 'administrative', '2020-01-01');

    const own = await reportingLinesFor(mgr.ctx, mgr.employmentId);
    expect(own.reports.map((r) => r.name).sort(), 'the `reports` half is untouched').toEqual([
      'Report One',
      'Report Two',
    ]);
    // The union is keyed by reporting-line id, so an edge BOTH reads answer for appears once. Asserted on
    // ids rather than on a count of names, because a duplicate would read as a second supervisor.
    const ids = own.managers.map((m) => m.id);
    expect(ids.length, 'no reporting-line id appears twice').toBe(new Set(ids).size);
    expect(own.managers.map((m) => m.name)).toEqual(['Bella Boss']);
  });

  it('a delegate edge is still absent for everybody — delegationsFor still owns it', async () => {
    const emp = await hire('Nadia Employee', 'employee');
    const stand = await hire('Standin Delegate', 'manager');
    const delegateId = await delegateEdge(emp, stand);
    const [exists] = await owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, delegateId));
    expect(exists.n, 'sanity: the delegate edge exists, so the absences below are filters').toBe(1);

    expect((await reportingLinesFor(emp.ctx, emp.employmentId)).managers).toEqual([]);
    expect((await reportingLinesFor(adminCtx(b), emp.employmentId)).managers).toEqual([]);
  });
});
