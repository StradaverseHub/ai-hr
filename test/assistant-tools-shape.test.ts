/**
 * ADR-0082 slice 2 — the assistant's tool registry (core/assistant-tools.ts).
 *
 * THREE KINDS OF ASSERTION LIVE HERE, and they are here together on purpose because each is invisible to
 * the other two:
 *
 *   1. THE CROSS-SCOPE REFUSAL, against REAL POLICIES on a real database — never a stub. This is the test
 *      of the slice. The whole security argument of ADR-0082 is "the tool inherits the caller's scope
 *      because it is the caller's own session", and a mocked read proves that argument to itself.
 *   2. THE SOURCE-SHAPE GUARD — properties of the REGISTRY, not of any tool: that no tool assembles its
 *      own session, reaches for an elevated pool, or contains a path that changes anything. A per-tool
 *      unit test structurally cannot see these; a tenth tool added next year that breaks one of them
 *      would pass every test that exists except this one.
 *   3. THE SPEC SHAPE — strict schemas, stable names, and the ARRAY ORDER, which is load-bearing for
 *      prompt caching and reports nothing at all when it breaks (it just costs ~10x per request).
 *
 * ⚠️ The guard in part 2 reads exactly ONE file — core/assistant-tools.ts — and does NOT strip comments,
 * following the documented trade in test/helpers/import-ratchet.ts (a regex stripper mangles '//' inside
 * string literals and starts MISSING real edges; for a leak guard, failing loud in the safe direction is
 * the correct bias). Because the scan target is that one path, nothing written in THIS file can trip it.
 * If it fires, open the flagged file and check whether the match is inside a comment before believing it.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  ASSISTANT_TOOLS,
  EMPLOYEE_PROFILE_FIELDS,
  specsFor,
  toolByName,
  toolsFor,
  type AssistantTool,
  type ToolOutcome,
} from '../core/assistant-tools';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import {
  adminCtx,
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

const SOURCE = readFileSync(new URL('../core/assistant-tools.ts', import.meta.url), 'utf8');

// ONE lifecycle for the WHOLE FILE, not one per describe. Two describes each calling closeAll() in
// their own afterAll tore the pool down after the first of them finished, and every later case died
// with `write CONNECTION_ENDED` — including a purely synchronous one that touches no database at all,
// which is what makes this look like a logic failure rather than a harness misuse.
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 1. THE SOURCE-SHAPE GUARD
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Patterns assembled from fragments so this file can name what it forbids without any single line of it
 * reading as the forbidden thing. Each entry says WHAT it catches and WHY that thing would be fatal.
 */
const FORBIDDEN: { why: string; re: RegExp }[] = [
  {
    why: 'assembles a session object (a tool must thread the CALLER’s context through unchanged)',
    re: new RegExp(`\\b(?:${['tenant', 'Id'].join('')}|roles|grants)\\s*:`),
  },
  {
    why: 'names a session escape hatch (an exemption marker or a suspended-tenant write override)',
    re: new RegExp(['entitlements', 'Exempt', '|', 'statutory', 'Override'].join('')),
  },
  {
    why: 'reaches for a database pool of its own (only the caller’s scoped session may reach data)',
    re: new RegExp(['create', 'Db', '|', 'MIGRATION_', 'DATABASE_URL'].join('')),
  },
  {
    why: 'opens its own transaction (a tool that can open one can run raw SQL beside a read)',
    re: new RegExp(['with', 'Tenant'].join('')),
  },
  {
    why: 'contains a path that changes stored data',
    re: new RegExp(
      ['\\.', 'insert', '\\(', '|\\.', 'update', '\\(', '|\\.', 'delete', '\\(', '|', 'append', 'Event', '|\\.', 'execute', '\\('].join(''),
    ),
  },
  {
    why: 'imports a pack implementation (a core/ file may only reach a pack through its service facade)',
    re: /from '[^']*packs\/(?!.*\/service')/,
  },
];

describe('ADR-0082 §2.3 — the registry cannot do what it must not do', () => {
  for (const { why, re } of FORBIDDEN) {
    it(`core/assistant-tools.ts never ${why}`, () => {
      const hits = SOURCE.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => re.test(line));
      expect(
        hits.map((h) => `L${h.n}: ${h.line.trim()}`),
        `core/assistant-tools.ts ${why}. NOTE: this scan does NOT strip comments (see the header of ` +
          `test/helpers/import-ratchet.ts for why that trade is deliberate) — if the match below is ` +
          `inside a comment, reword the COMMENT, never weaken the scan.`,
      ).toEqual([]);
    });
  }

  it('reaches the database only through core/read.ts, and holds no database handle at runtime', () => {
    // The type-only form is the property: at runtime this module imports nothing from db/client at all,
    // so there is no object through which a query could be issued outside a wrapped read.
    expect(SOURCE).toMatch(/import type \{ SessionContext \} from '\.\.\/db\/client';/);
    const dataImports = [...SOURCE.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)]
      .map((m) => m[1])
      .filter((s) => s.startsWith('.'));
    // entitlements is the module gate; read is the data; hr-date is the clock; ai/types is the contract.
    expect(dataImports.sort()).toEqual(
      ['../db/client', '../lib/ai/types', '../lib/hr-date', './entitlements', './read'].sort(),
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 2. SPEC SHAPE — strict schemas, stable names, load-bearing order
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('ADR-0082 §2.2 mechanic 4 — every tool spec is strict-shaped', () => {
  it('is exactly the nine tools, IN THIS ORDER', () => {
    // ORDER IS PINNED, not just membership. `tools` renders before `system` in the cacheable prefix and
    // caching is a PREFIX match, so a reordering silently multiplies the cost of every request while
    // changing no behaviour and failing no other assertion. New tools are APPENDED to this list.
    expect(ASSISTANT_TOOLS.map((t) => t.spec.name)).toEqual([
      'my_leave_balances',
      'my_leave_requests',
      'leave_entitlement_explain',
      'upcoming_holidays',
      'who_is_away',
      'team_leave_summary',
      'employee_profile',
      'my_reporting_line',
      'my_payslip_summary',
    ]);
  });

  it.each(ASSISTANT_TOOLS.map((t) => [t.spec.name, t] as const))(
    '%s: object schema, additionalProperties false, every property required',
    (_name, tool: AssistantTool) => {
      const s = tool.spec.inputSchema;
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      // EVERY property required — OpenAI's strict mode demands it, and a half-specified call becomes a
      // query parameter against a scope-enforced table.
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
      for (const [key, prop] of Object.entries(s.properties)) {
        expect(prop, `${tool.spec.name}.${key} must declare a type`).toHaveProperty('type');
      }
    },
  );

  it('names are unique, snake_case, and each description tells the model what it will NOT answer', () => {
    const names = ASSISTANT_TOOLS.map((t) => t.spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const t of ASSISTANT_TOOLS) {
      expect(t.spec.description.length, `${t.spec.name} needs a real description`).toBeGreaterThan(120);
      expect(toolByName(t.spec.name)).toBe(t);
    }
    expect(toolByName('no_such_tool')).toBeUndefined();
  });

  it('the five self-bound tools accept NO subject argument at all — that is the control, not ergonomics', () => {
    // A tool with no employee argument cannot be pointed at anybody. Five of the nine are shaped that
    // way, and it is what makes them incapable of being aimed. `my_reporting_line` is on this list
    // specifically because reporting_line's own policy is tenant-wide and never checks the SUBJECT.
    for (const name of [
      'my_leave_balances',
      'my_leave_requests',
      'my_reporting_line',
      'upcoming_holidays',
      'my_payslip_summary',
    ]) {
      const props = Object.keys(toolByName(name)!.spec.inputSchema.properties);
      expect(props, `${name} must take no employee/person argument`).not.toContain('employment_id');
      expect(props).not.toContain('person_id');
      expect(props).not.toContain('employee_code');
    }
    expect(Object.keys(toolByName('my_leave_balances')!.spec.inputSchema.properties)).toEqual([]);
    expect(Object.keys(toolByName('my_reporting_line')!.spec.inputSchema.properties)).toEqual([]);
  });

  it('declares pay and identity sensitivity where it exists', () => {
    expect(toolByName('my_payslip_summary')!.sensitivity).toBe('pay');
    expect(toolByName('employee_profile')!.sensitivity).toBe('identity');
    expect(toolByName('my_payslip_summary')!.module).toBe('payroll');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 3. BEHAVIOUR, against real policies on a real database
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

let base: Base;
let icSeq = 0;
const nextIc = () => `9107070${String(30000 + icSeq++).slice(-5)}`;

const hire = (name: string) =>
  hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

/**
 * A real session for a hired person. Derived from `adminCtx` ONLY for its entitlement snapshot (the
 * tenant's, not the admin's) — the identity fields are all overridden, so this is an ordinary employee
 * in every way the policies can observe.
 */
function sessionFor(userId: string, personId: string, roles: string[]): SessionContext {
  return { ...adminCtx(base), userId, personId, roles };
}

const call = (name: string, ctx: SessionContext, input: unknown = {}): Promise<ToolOutcome> =>
  toolByName(name)!.run(ctx, input);

/** Narrow a refusal so the assertion reads the code rather than `('refusal' in r)` at every site. */
const refusalOf = (r: ToolOutcome): string | null => (r.ok ? null : r.refusal);

const seedLeave = (employmentId: string, from: string, to: string, days: string, status: 'approved' | 'pending') =>
  owner.db.insert(schema.leaveRequest).values({
    tenantId: base.tenantId,
    employmentId,
    leaveTypeId: base.annualLeaveTypeId,
    startDate: from,
    endDate: to,
    days,
    status,
  });

describe('ADR-0082 §5 — a tool cannot see what its caller cannot see', () => {
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });

  it('employee_profile: a peer is refused with not_visible, and the SAME code covers a nonexistent id', async () => {
    const E = await hire('Scope Ellen');
    const X = await hire('Scope Xavier');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);

    // POSITIVE LEG FIRST: the tool works at all for the caller's own record. Without this, every negative
    // below would also pass if the tool were simply broken.
    const own = await call('employee_profile', eCtx, { employment_id: E.employmentId });
    expect(own.ok).toBe(true);

    const peer = await call('employee_profile', eCtx, { employment_id: X.employmentId });
    expect(refusalOf(peer)).toBe('not_visible');

    // THE EXISTENCE ORACLE IS CLOSED: an id that does not exist at all returns the same code and the
    // same sentence, so a caller cannot enumerate which ids are real one refusal at a time.
    const ghost = await call('employee_profile', eCtx, {
      employment_id: '00000000-0000-0000-0000-0000000000ff',
    });
    expect(refusalOf(ghost)).toBe('not_visible');
    expect(peer).toEqual(ghost);

    // And an admin CAN see the same record — proving the refusal was the policy, not a broken query.
    const asAdmin = await call('employee_profile', adminCtx(base), { employment_id: X.employmentId });
    expect(asAdmin.ok).toBe(true);
  });

  it('employee_profile returns EXACTLY the ten whitelisted fields — no identity column rides along', async () => {
    const E = await hire('Narrow Nina');
    // Everything the projection must NOT carry is really on the row underneath it.
    await owner.db
      .update(schema.person)
      .set({ dateOfBirth: '1990-04-04', race: 'Malay', religion: 'Islam', personalEmail: 'nina@home.test' })
      .where(eq(schema.person.id, E.personId));
    const res = await call('employee_profile', adminCtx(base), { employment_id: E.employmentId });
    if (!res.ok) throw new Error('expected a result');
    const employee = res.employee as Record<string, unknown>;
    expect(Object.keys(employee).sort()).toEqual([...EMPLOYEE_PROFILE_FIELDS].sort());
    const serialized = JSON.stringify(res);
    for (const leak of ['1990-04-04', 'Malay', 'Islam', 'nina@home.test']) {
      expect(serialized, `${leak} must not reach the model`).not.toContain(leak);
    }
  });

  it('team_leave_summary: not_your_report for a peer, real figures for a genuine manager', async () => {
    const E = await hire('Report Rita');
    const M = await hire('Manager Musa');
    const X = await hire('Peer Priya');
    await setReportingLine(adminCtx(base), {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);
    const mCtx = sessionFor(await createAppUser(base.tenantId, M.personId, 'manager'), M.personId, ['manager']);

    const asManager = await call('team_leave_summary', mCtx, { employment_id: E.employmentId });
    expect(asManager.ok).toBe(true);

    // A peer, and the manager's own manager-less peer, both get the same refusal.
    expect(refusalOf(await call('team_leave_summary', eCtx, { employment_id: X.employmentId }))).toBe(
      'not_your_report',
    );
    // AND THE SUBORDINATE CANNOT LOOK UP THE CHAIN either — the read's gate is narrower than the
    // policy on purpose (self and plain admins get nothing too), and that must not be "fixed".
    expect(refusalOf(await call('team_leave_summary', eCtx, { employment_id: M.employmentId }))).toBe(
      'not_your_report',
    );
  });

  it('who_is_away lists only people the caller may see, and never presents the whole company', async () => {
    const E = await hire('Away Aisha');
    const X = await hire('Away Xander');
    await seedLeave(E.employmentId, '2026-06-01', '2026-06-03', '3.00', 'approved');
    await seedLeave(X.employmentId, '2026-06-01', '2026-06-03', '3.00', 'approved');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);

    const mine = await call('who_is_away', eCtx, { from: '2026-06-01', to: '2026-06-30' });
    if (!mine.ok) throw new Error('expected a list');
    const names = (mine.rows as { personName: string }[]).map((r) => r.personName);
    expect(names).toEqual(['Away Aisha']);

    // The admin sees BOTH — so the employee's short list was the policy trimming rows, not an empty read.
    const all = await call('who_is_away', adminCtx(base), { from: '2026-06-01', to: '2026-06-30' });
    if (!all.ok) throw new Error('expected a list');
    expect((all.rows as { personName: string }[]).map((r) => r.personName).sort()).toEqual([
      'Away Aisha',
      'Away Xander',
    ]);
  });

  it('who_is_away lists only people who are ACTUALLY AWAY, not everyone the caller can see', async () => {
    // The underlying read returns one row per visible person INCLUDING people with no leave in the
    // window (its calendar caller needs the empty rows to draw them). Without the wrapper's filter this
    // tool would answer "who is away" with the entire headcount, and its count branch would trip on
    // tenant size rather than on absences.
    const A = await hire('Present Pete');
    const B = await hire('Absent Anna');
    await seedLeave(B.employmentId, '2026-07-06', '2026-07-08', '3.00', 'approved');
    const res = await call('who_is_away', adminCtx(base), { from: '2026-07-01', to: '2026-07-31' });
    if (!res.ok) throw new Error('expected a list');
    const names = (res.rows as { personName: string }[]).map((r) => r.personName);
    expect(names).toEqual(['Absent Anna']);
    expect(names).not.toContain('Present Pete');
    expect(res.totalRows).toBe(1);
    expect(A.employmentId).toBeTruthy();
  });

  it('who_is_away refuses a window it will not answer, and refuses nonsense dates', async () => {
    const a = adminCtx(base);
    expect(refusalOf(await call('who_is_away', a, { from: '2026-01-01', to: '2026-12-31' }))).toBe('out_of_range');
    expect(refusalOf(await call('who_is_away', a, { from: '2026-06-10', to: '2026-06-01' }))).toBe('invalid_input');
    expect(refusalOf(await call('who_is_away', a, { from: 'last Tuesday', to: '2026-06-01' }))).toBe('invalid_input');
    // Well-shaped but impossible — the pattern alone admits it; the parse is what rejects it.
    expect(refusalOf(await call('who_is_away', a, { from: '2026-02-30', to: '2026-03-01' }))).toBe('invalid_input');
    // The boundary itself is answerable, so the refusal above is the WIDTH and not the tool being broken.
    expect((await call('who_is_away', a, { from: '2026-06-01', to: '2026-08-02' })).ok).toBe(true);
  });

  it('my_reporting_line ignores any subject the model tries to supply and answers about the caller', async () => {
    const M = await hire('Line Manager');
    const E = await hire('Line Employee');
    const X = await hire('Line Outsider');
    await setReportingLine(adminCtx(base), {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const mCtx = sessionFor(await createAppUser(base.tenantId, M.personId, 'manager'), M.personId, ['manager']);

    // An extra argument is not in the schema, so a provider that sends one anyway changes nothing.
    const res = await call('my_reporting_line', mCtx, { employment_id: X.employmentId });
    if (!res.ok) throw new Error('expected a result');
    expect(res.employmentId).toBe(M.employmentId);
    expect((res.reports as { name: string }[]).map((r) => r.name)).toEqual(['Line Employee']);

    // THE OTHER HALF, pinned because it is surprising and a later reader might "fix" it wrongly: an
    // ordinary employee cannot see their own manager's employment row, so the inner join drops it and
    // `managers` comes back empty even though the line exists. The tool's description carries the
    // instruction that keeps the model from reporting that as "you have no manager".
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);
    const asEmployee = await call('my_reporting_line', eCtx);
    if (!asEmployee.ok) throw new Error('expected a result');
    expect(asEmployee.managers).toEqual([]);
    expect(toolByName('my_reporting_line')!.spec.description).toMatch(/not "this person reports to nobody"/i);
  });

  it('the self-bound tools refuse with no_employment for a login with no employee record', async () => {
    // The base admin user has no linked person — an HR admin, an operator or a support login.
    const a = adminCtx(base);
    for (const name of ['my_leave_balances', 'my_reporting_line']) {
      expect(refusalOf(await call(name, a)), name).toBe('no_employment');
    }
    expect(refusalOf(await call('my_leave_requests', a, { limit: 5 }))).toBe('no_employment');
    expect(refusalOf(await call('my_payslip_summary', a, { limit: 5 }))).toBe('no_employment');
    expect(refusalOf(await call('upcoming_holidays', a, { from: '2026-01-01', limit: 5 }))).toBe('no_employment');
  });

  it('my_leave_balances and my_leave_requests answer only about the caller', async () => {
    const E = await hire('Balance Bella');
    const X = await hire('Balance Xin');
    await seedLeave(E.employmentId, '2026-05-04', '2026-05-05', '2.00', 'pending');
    await seedLeave(X.employmentId, '2026-05-04', '2026-05-05', '2.00', 'pending');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);

    const bal = await call('my_leave_balances', eCtx);
    if (!bal.ok) throw new Error('expected balances');
    const employments = bal.employments as { employmentId: string; balances: unknown[] }[];
    expect(employments.map((b) => b.employmentId)).toEqual([E.employmentId]);
    expect(JSON.stringify(bal)).not.toContain(X.employmentId);

    const reqs = await call('my_leave_requests', eCtx, { limit: 25 });
    if (!reqs.ok) throw new Error('expected requests');
    expect(reqs.totalRows).toBe(1);
    // `days` arrives from the driver as a string; a model handed "2.00" for one read and 2 for another
    // will eventually do arithmetic on the wrong one.
    expect((reqs.rows as { days: unknown }[])[0].days).toBe(2);
  });

  it('my_leave_requests and my_payslip_summary refuse a limit outside the declared bounds', async () => {
    const E = await hire('Bound Bruno');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);
    expect(refusalOf(await call('my_leave_requests', eCtx, { limit: 0 }))).toBe('invalid_input');
    expect(refusalOf(await call('my_leave_requests', eCtx, { limit: 99 }))).toBe('invalid_input');
    expect(refusalOf(await call('my_leave_requests', eCtx, {}))).toBe('invalid_input');
    expect(refusalOf(await call('my_leave_requests', eCtx, { limit: 'lots' }))).toBe('invalid_input');
    // A digit STRING is accepted — the SDKs disagree about number fidelity and spending a turn on that
    // disagreement helps nobody.
    expect((await call('my_leave_requests', eCtx, { limit: '5' })).ok).toBe(true);
  });

  it('leave_entitlement_explain is bound to the caller and validates its date', async () => {
    const E = await hire('Explain Emma');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);
    expect(
      refusalOf(await call('leave_entitlement_explain', eCtx, { leave_type_id: base.annualLeaveTypeId, as_of: 'soon' })),
    ).toBe('invalid_input');
    const ok = await call('leave_entitlement_explain', eCtx, {
      leave_type_id: base.annualLeaveTypeId,
      as_of: '2026-06-30',
    });
    if (!ok.ok) throw new Error('expected a breakdown');
    // ONE BLOCK PER EMPLOYMENT, and every figure inside it. A single top-level employmentId beside a
    // list was the concurrent-employment defect: `leave_type` is tenant-scoped, so the id alone cannot
    // say which employment it came from, and binding to emps[0] answered about the wrong company.
    const blocks = ok.employments as { employmentId: string; cycleStart: unknown }[];
    expect(blocks.map((e) => e.employmentId)).toEqual([E.employmentId]);
    expect(ok).not.toHaveProperty('cycleStart');
    expect(blocks[0]).toHaveProperty('cycleStart');
    // The HR-authored per-component prose is dropped: it is large, and the model must not narrate a
    // formula nobody asked about.
    expect(ok).not.toHaveProperty('formulaExplanations');
  });

  it('leave_entitlement_explain answers for EVERY concurrent employment, not just the earliest', async () => {
    // THE CASE THE SINGLE-EMPLOYMENT TEST ABOVE STRUCTURALLY CANNOT SEE. With one employment `emps` and
    // `emps.slice(0,1)` are the same list, so the original defect — binding the breakdown to the
    // EARLIEST employment — passed every assertion in this file. `leave_type` is TENANT-scoped, so a
    // leaveTypeId taken from my_leave_balances cannot say which employment it came from; a
    // shared-services employee asking about Company B was answered with Company A's cycle start and
    // entitlement, silently and with no way for the model to ask for the other one.
    const first = await hire('Dual Dahlia');
    const second = await hireEmployee(adminCtx(base), {
      person: { id: first.personId },
      companyId: base.companyId,
      departmentId: base.deptB,
      employmentType: 'full_time',
      hiredOn: '2026-03-01',
    });
    expect(second.employmentId).not.toBe(first.employmentId);

    const ctx = sessionFor(
      await createAppUser(base.tenantId, first.personId, 'employee'),
      first.personId,
      ['employee'],
    );
    const out = await call('leave_entitlement_explain', ctx, {
      leave_type_id: base.annualLeaveTypeId,
      as_of: '2026-06-30',
    });
    if (!out.ok) throw new Error('expected a breakdown');
    const seen = (out.employments as { employmentId: string }[]).map((e) => e.employmentId).sort();
    expect(seen).toEqual([first.employmentId, second.employmentId].sort());
  });

  it('my_payslip_summary drops an UNRELEASED payslip and drops the statutory breakdown', async () => {
    const a = adminCtx(base);
    const E = await hire('Payslip Pam');
    await setCompensation(a, {
      employmentId: E.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: nextIc() });
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-03' });
    await generatePayslips(a, { batchId }); // processed, NOT released

    // THE READ UNDERNEATH RETURNS THIS ROW. It stamps a `released` flag and leaves the filtering to its
    // caller — so an empty result here is the wrapper doing its job, not an empty database.
    const before = await call('my_payslip_summary', eCtx, { limit: 12 });
    if (!before.ok) throw new Error('expected a result');
    expect(before.totalRows).toBe(0);
    const [slip] = await owner.db
      .select({ id: schema.payslip.id })
      .from(schema.payslip)
      .where(eq(schema.payslip.batchId, batchId));
    expect(slip, 'the payslip must EXIST but be withheld — otherwise this asserts nothing').toBeTruthy();

    await closeBatch(a, { batchId });

    const after = await call('my_payslip_summary', eCtx, { limit: 12 });
    if (!after.ok) throw new Error('expected a result');
    expect(after.totalRows).toBe(1);
    const row = (after.rows as Record<string, unknown>[])[0];
    expect(Object.keys(row).sort()).toEqual(['company', 'deductions', 'gross', 'net', 'payPeriod', 'runType']);
    expect(typeof row.gross).toBe('number');
    // EPF/SOCSO/EIS/PCB and the TP1 relief record never reach the model.
    expect(after).not.toHaveProperty('statutory');
    expect(JSON.stringify(after)).not.toContain('epf');
  });

  it('upcoming_holidays returns only the dates this employment actually observes', async () => {
    const E = await hire('Holiday Hana');
    const eCtx = sessionFor(await createAppUser(base.tenantId, E.personId, 'employee'), E.personId, ['employee']);
    // A national day the employee observes, and one recorded for a state they do not work in. The
    // tenant-wide read returns BOTH; the per-employment resolver is what removes the second.
    await owner.db.insert(schema.holiday).values([
      { tenantId: base.tenantId, name: 'National Day', holidayDate: '2026-08-31', country: 'MY' },
      { tenantId: base.tenantId, name: 'Sarawak Day', holidayDate: '2026-07-22', country: 'MY', state: 'Sarawak' },
    ]);
    const res = await call('upcoming_holidays', eCtx, { from: '2026-07-01', limit: 10 });
    if (!res.ok) throw new Error('expected holidays');
    const dates = (res.holidays as { date: string }[]).map((h) => h.date);
    expect(dates).toContain('2026-08-31');
    expect(dates, 'a holiday for a state this employee does not work in must not be listed').not.toContain(
      '2026-07-22',
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
 * 4. MODULE GATING
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('ADR-0077 — a tool whose module the tenant does not hold is not offered', () => {
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });

  it('drops my_payslip_summary when payroll is off, and keeps the other eight', async () => {
    const withPayroll = await entitledCtx(base);
    expect(toolsFor(withPayroll).map((t) => t.spec.name)).toContain('my_payslip_summary');
    expect(toolsFor(withPayroll)).toHaveLength(9);

    await setModule(base.tenantId, 'payroll', null);
    const without = await entitledCtx(base);
    const offered = toolsFor(without).map((t) => t.spec.name);
    expect(offered).not.toContain('my_payslip_summary');
    expect(offered).toHaveLength(8);
    // The specs the gateway would send match the tools, and stay in registry order.
    expect(specsFor(without).map((s) => s.name)).toEqual(offered);
  });

  it('payroll is the ONLY axis the offered list varies on today, and that is worth knowing', () => {
    // Eight of the nine name a CORE module, which answers enabled without consulting any snapshot. So
    // ADR-0082 §2.8's "each tool is gated by its own module" is true of exactly one tool right now. It is
    // not a defect — it is what keeps the cacheable prefix stable per tenant — but a reader who assumes
    // seven live gates will design around one that does not exist.
    const gated = ASSISTANT_TOOLS.filter((t) => t.module !== null).map((t) => t.module);
    expect(new Set(gated)).toEqual(new Set(['leave', 'org', 'employees', 'payroll']));
    expect(ASSISTANT_TOOLS.filter((t) => t.module === 'payroll')).toHaveLength(1);
  });
});
