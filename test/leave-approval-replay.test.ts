/**
 * a6fe37fc ROUND 1 — THE APPROVAL REPLAY HARNESS, PROVEN ON EVERY GATE.
 *
 * The Leave Configuration replacement's cutover gate is a promise in the reporter's own words: every one of
 * the 261 approval rules must still reach the same approver, for the same real employee, before and after.
 * `scripts/replay-approval-routing.ts` discharges that against the production database. This file is the
 * SAME harness against the seeded tenant, and it exists because a comparison that runs once by hand on a
 * box is not a test — it is a claim.
 *
 * What it pins, in the order the migration order (§2) sets it out:
 *   • ONE MATCHER, TWO CALLERS. `resolveApprovalDecision` is the ranking; `resolveApprovalChain` is a
 *     one-line wrapper over it. A second ranking of the same rules is the defect this whole item exists to
 *     remove, so the wrapper is asserted to return exactly the decision's levels rather than merely
 *     something equal to them by coincidence.
 *   • THE REPLAY'S SHAPE IS ITS SAFETY. It points at production, so the transaction is READ ONLY by the
 *     database's own account (`readOnlyEnforced`), and it always rolls back.
 *   • §2.4 — THE HARNESS CAN FAIL. A reconciliation that cannot fail is worse than none, because it
 *     certifies the cutover. One targeted rule's `leave_type_id` is blanked inside a transaction that rolls
 *     back, and the diff must NAME the employee, leave type and day count it moved. This is not an
 *     arbitrary corruption: a null `leave_type_id` is read as the company-wide wildcard, so blanking it
 *     silently converts one targeted rule into a rule matching everyone — the exact near-miss of release
 *     three, where grade groups' SET NULL would have re-routed 205 live rules without erroring.
 *   • §2.3 — COVERAGE. A replay over rules that never match proves nothing about them, so the harness
 *     reports which rules ever WIN.
 *   • The script has NO apply mode, refuses malformed options rather than guessing at them, and documents
 *     an invocation that actually runs on the server.
 *
 * ADDED IN THE FIX PASS, and it is the property the whole round exists for:
 *   • A ROUTING CHANGE THAT REACHES ANY LIVE EMPLOYEE MUST FAIL THE VERIFY. That is stronger than "a chain
 *     that moved for a baseline employment who is still a routing subject", and the difference is not
 *     academic: a routing tuple is shared, the baseline names it after ONE arbitrary member, and ordinary
 *     turnover between the baseline and the verify changes which member that is. Matched by employment, a
 *     departed representative took her still-employed colleagues' whole tuple out of the comparison, and
 *     `--verify` printed "✓ every baseline routing case still reaches the same approver" and exited 0 while
 *     the routing had genuinely moved. The `gone` case below used to be tested only with a tuple that had
 *     emptied completely, which is the one shape where matching by employment gives the right answer.
 *   • WHAT IT COSTS THE DATABASE IT IS POINTED AT. A harness that runs against a customer's live database
 *     needs a known cost, so the round-trip count is asserted to be constant in the grid's size.
 */
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  resolveApprovalChain,
  resolveApprovalDecision,
  setLeaveApprovalPolicy,
} from '../core/leave-approval-policy';
import { createApprovalTemplate, setTenantDefaultTemplate } from '../core/leave-approval-template';
import {
  approvalDayProbes,
  approvalRoutingCoverage,
  approvalRoutingSnapshot,
  diffApprovalRouting,
  listRoutingSubjects,
  replayApprovalRouting,
  replayVerdictFails,
  routingTupleKey,
  verifyApprovalRouting,
  type BaselineSubject,
  type RoutingReplay,
} from '../core/leave-approval-consolidation';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let sickTypeId: string;
let adaEmploymentId: string;

const ctx = () => adminCtx(b);
/** The context the SCRIPT uses on the server: system, hr_admin, no user, no exemption marker. */
const systemCtx = (): SessionContext => ({ tenantId: b.tenantId, roles: ['hr_admin'] });

const hire = (name: string, departmentId?: string) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `rp_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    gradeId: null,
    hiredOn: '2024-01-01',
  });

/**
 * EXACTLY what `scripts/replay-approval-routing.ts` writes into the committed baseline file. Written once,
 * here, so these tests cannot accidentally verify against richer material than the file on the box holds —
 * the whole blocker this suite now pins was a baseline that stored too little.
 */
const baselineSubjectsOf = (replay: RoutingReplay): BaselineSubject[] =>
  replay.subjects.map((s) => ({ employmentId: s.employmentId, companyId: s.companyId, attrs: s.attrs }));

/** A `Tx` that counts `select()` calls and otherwise IS the transaction, for the round-trip bound below. */
const countingTx = (tx: Tx, bump: () => void): Tx =>
  ({
    select: (...args: unknown[]) => {
      bump();
      return (tx.select as unknown as (...a: unknown[]) => unknown).apply(tx, args);
    },
  }) as unknown as Tx;

/** A rule that only reaches Finance (deptA) on SICK — the "targeted rule" of §2.4. */
async function seedTargetedRule(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveApprovalPolicy)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      ruleName: 'Finance sick leave',
      leaveTypeId: sickTypeId,
      departmentId: b.deptA,
      levels: ['hr_admin'],
    })
    .returning({ id: schema.leaveApprovalPolicy.id });
  return row.id;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const [sick] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  sickTypeId = sick.id;
  const ada = await hire('Ada');
  adaEmploymentId = ada.employmentId;
});
afterAll(async () => {
  await closeAll();
});

describe('a6fe37fc §2 — one matcher, two callers', () => {
  it('resolveApprovalDecision names the winning rule, and resolveApprovalChain returns exactly its levels', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const ruleId = await seedTargetedRule();

    const { decision, chain } = await withTenant(ctx(), async (tx) => ({
      decision: await resolveApprovalDecision(tx, b.companyId, sickTypeId, { departmentId: b.deptA, days: 1 }),
      chain: await resolveApprovalChain(tx, b.companyId, sickTypeId, { departmentId: b.deptA, days: 1 }),
    }));

    expect(decision.source).toBe('rule');
    expect(decision.ruleId).toBe(ruleId);
    expect(decision.levels).toEqual(['hr_admin']);
    // The wrapper must be the decision's levels — not a second ranking that happens to agree today.
    expect(chain).toEqual(decision.levels);
  });

  it('reports the tenant-default template and the built-in fallback WITHOUT crediting a rule', async () => {
    const bare = await withTenant(ctx(), (tx) =>
      resolveApprovalDecision(tx, b.companyId, b.annualLeaveTypeId, { days: 1 }),
    );
    expect(bare.source).toBe('fallback');
    expect(bare.ruleId).toBeNull();
    expect(bare.levels).toEqual(['direct_manager', 'hr_admin']);

    const tpl = await createApprovalTemplate(ctx(), { name: 'HR only', levels: ['hr_admin'] });
    await setTenantDefaultTemplate(ctx(), tpl.id);
    const viaDefault = await withTenant(ctx(), (tx) =>
      resolveApprovalDecision(tx, b.companyId, b.annualLeaveTypeId, { days: 1 }),
    );
    expect(viaDefault.source).toBe('tenant-default');
    expect(viaDefault.ruleId).toBeNull();
    expect(viaDefault.levels).toEqual(['hr_admin']);
  });
});

describe('a6fe37fc §2.2 — the replay, and the shape that makes it safe against production', () => {
  it('runs in a transaction Postgres itself calls READ ONLY, and covers every active employment', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    await seedTargetedRule();
    await hire('Grace', b.deptB);

    const replay = await replayApprovalRouting(systemCtx());

    // The safety property is asserted from the DATABASE's answer, not from this module's intentions.
    expect(replay.readOnlyEnforced).toBe(true);
    expect(replay.employmentsCovered).toBe(2);
    // Two departments ⇒ two distinct routing tuples; the grid is subjects × leave types × day probes.
    expect(replay.subjects).toHaveLength(2);
    expect(replay.leaveTypeIds.sort()).toEqual([b.annualLeaveTypeId, sickTypeId].sort());
    expect(replay.chains.size).toBe(replay.subjects.length * replay.leaveTypeIds.length * replay.dayProbes.length);
    expect(replay.chains.get(`${adaEmploymentId}|${sickTypeId}|1`)).toBe('hr_admin');
    expect(replay.chains.get(`${adaEmploymentId}|${b.annualLeaveTypeId}|1`)).toBe('direct_manager → hr_admin');
  });

  it('a replay with nothing changed in between reports no differences', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    await seedTargetedRule();

    const before = await replayApprovalRouting(systemCtx());
    const after = await replayApprovalRouting(systemCtx());
    expect(diffApprovalRouting(before.chains, after.chains, after.subjects)).toEqual([]);
  });

  it('unions the baseline grid in, so a leave type added since the baseline cannot drop a case', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const ghostTypeId = randomUUID();

    const replay = await replayApprovalRouting(systemCtx(), { extraLeaveTypeIds: [ghostTypeId], extraDayProbes: [99] });
    expect(replay.leaveTypeIds).toContain(ghostTypeId);
    expect(replay.dayProbes).toContain(99);
    expect(replay.chains.has(`${adaEmploymentId}|${ghostTypeId}|99`)).toBe(true);
  });
});

describe('a6fe37fc §2.4 — proving the harness can FAIL', () => {
  it('blanking one targeted rule\'s leave_type_id is caught, named, and rolled back', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const ruleId = await seedTargetedRule();

    // The injection runs inside ONE transaction that rolls back, exactly as §2.4 describes: snapshot,
    // corrupt, re-snapshot, diff, throw. The corruption is not arbitrary — core/leave-approval-policy.ts
    // reads a null leave_type_id as the company-wide wildcard, so this silently turns one department's SICK
    // rule into a rule that matches every leave type for that department.
    class Rollback extends Error {
      constructor(readonly differences: ReturnType<typeof diffApprovalRouting>) {
        super('rollback');
      }
    }
    let differences: ReturnType<typeof diffApprovalRouting> = [];
    try {
      await withTenant(ctx(), async (tx) => {
        const { subjects } = await listRoutingSubjects(tx);
        const types = await tx.select({ id: schema.leaveType.id }).from(schema.leaveType);
        const leaveTypeIds = types.map((t) => t.id);
        const dayProbes = await approvalDayProbes(tx);

        const before = await approvalRoutingSnapshot(tx, subjects, leaveTypeIds, dayProbes);
        await tx
          .update(schema.leaveApprovalPolicy)
          .set({ leaveTypeId: null })
          .where(eq(schema.leaveApprovalPolicy.id, ruleId));
        const after = await approvalRoutingSnapshot(tx, subjects, leaveTypeIds, dayProbes);

        throw new Rollback(diffApprovalRouting(before, after, subjects));
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      differences = e.differences;
    }

    // THE ASSERTION THE WHOLE ROUND EXISTS FOR: the harness reports a non-empty difference list.
    expect(differences.length).toBeGreaterThan(0);
    const annual = differences.filter((d) => d.leaveTypeId === b.annualLeaveTypeId);
    expect(annual.length).toBeGreaterThan(0);
    // Named, never counted — company, employment, leave type, days, and both chains.
    expect(annual[0].employmentId).toBe(adaEmploymentId);
    expect(annual[0].companyId).toBe(b.companyId);
    expect(annual[0].before).toBe('direct_manager → hr_admin');
    expect(annual[0].after).toBe('hr_admin');

    // …and the injection left nothing behind: the transaction rolled back.
    const [row] = await owner.db
      .select({ leaveTypeId: schema.leaveApprovalPolicy.leaveTypeId })
      .from(schema.leaveApprovalPolicy)
      .where(eq(schema.leaveApprovalPolicy.id, ruleId));
    expect(row.leaveTypeId).toBe(sickTypeId);
  });
});

describe('a6fe37fc §2.2 — the verdict: what a --verify run calls a FAILURE', () => {
  it('a chain that moved for a LIVE employee is a failure, and is named', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baselineSubjectsOf(baseline);

    // The configuration really changes between the two runs — the rule now reaches Finance on ANNUAL.
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      ruleName: 'Finance annual leave',
      leaveTypeId: b.annualLeaveTypeId,
      departmentId: b.deptA,
      levels: ['hr_admin'],
    });

    const after = await replayApprovalRouting(systemCtx());
    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);
    expect(verdict.changed.length).toBeGreaterThan(0);
    expect(verdict.changed[0].employmentId).toBe(adaEmploymentId);
    expect(verdict.changed[0].companyId).toBe(b.companyId);
    expect(verdict.changed[0].before).toBe('direct_manager → hr_admin');
    expect(verdict.changed[0].after).toBe('hr_admin');
    expect(verdict.gone).toEqual([]);
  });

  it('a baseline routing tuple with NO active employment left in it is reported but is NOT a failure', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baselineSubjectsOf(baseline);
    expect(baselineSubjects.map((s) => s.employmentId)).toContain(adaEmploymentId);
    const adaTuple = routingTupleKey(b.companyId, baseline.subjects[0].attrs);

    // Ada leaves, and she was the only employment in her tuple. §2.5: terminated employments are excluded —
    // a terminated employee submits no leave, and a tuple nobody is in routes nobody.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-01-01' })
      .where(eq(schema.employment.id, adaEmploymentId));

    const after = await replayApprovalRouting(systemCtx());
    // THE PRECONDITION that makes `gone` the right answer, asserted rather than assumed: nobody active is
    // in that tuple any more. Without this the test passes for a tuple that merely changed representative.
    expect(after.subjects.some((sub) => sub.tupleKey === adaTuple)).toBe(false);

    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);
    expect(verdict.changed).toEqual([]);
    expect(verdict.gone.length).toBeGreaterThan(0);
    expect(replayVerdictFails(verdict)).toBe(false);
    // Still named — a company, not an empty string — so a suspicious number of them is visible.
    expect(verdict.gone[0].employmentId).toBe(adaEmploymentId);
    expect(verdict.gone[0].companyId).toBe(b.companyId);
  });

  /**
   * THE CASE THE CUTOVER GATE EXISTS FOR, AND THE ONE THAT USED TO PASS WHILE ROUTING HAD MOVED.
   *
   * A routing tuple is shared by everyone with the same scoping attributes, and the baseline names it after
   * ONE arbitrary member (`listRoutingSubjects` keeps whichever row Postgres returned first; there is no
   * ORDER BY). Between a baseline and a verify there is ordinary staff turnover. If a case is matched by the
   * employment it is named after, then the moment that employment leaves, the whole tuple drops out of the
   * comparison — colleagues still in it and all — and `--verify` prints "✓ every baseline routing case still
   * reaches the same approver" and exits 0 while a live employee's approver has genuinely moved.
   */
  it('a routing change is a FAILURE for the colleague still in the tuple, even after the baseline representative has left', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    // Ada and Bob are both Finance (deptA), same grade, same employment type: ONE routing tuple.
    const bob = await hire('Bob');
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baselineSubjectsOf(baseline);
    expect(baseline.subjects).toHaveLength(1);
    expect(baseline.subjects[0].employmentCount).toBe(2);
    const representative = baseline.subjects[0].employmentId;
    const survivor = [adaEmploymentId, bob.employmentId].find((id) => id !== representative);
    expect(survivor).toBeDefined();

    // 1. ORDINARY TURNOVER: whoever the baseline happened to name leaves. Nothing about routing changed.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-01-01' })
      .where(eq(schema.employment.id, representative));

    // 2. A REAL ROUTING BREAK lands on the tuple the survivor is still in: Finance ANNUAL now goes to
    //    payroll instead of the company default chain.
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      ruleName: 'Finance annual leave',
      leaveTypeId: b.annualLeaveTypeId,
      departmentId: b.deptA,
      levels: ['payroll'],
    });

    const after = await replayApprovalRouting(systemCtx());
    // The survivor really is still active and really is still in the same tuple.
    expect(after.subjects).toHaveLength(1);
    expect(after.subjects[0].employmentId).toBe(survivor);
    expect(after.subjects[0].tupleKey).toBe(baseline.subjects[0].tupleKey);

    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);

    // THE PROPERTY: a routing change that reaches ANY live employee fails the verify.
    expect(replayVerdictFails(verdict)).toBe(true);
    const moved = verdict.changed.filter((d) => d.leaveTypeId === b.annualLeaveTypeId);
    expect(moved.length).toBeGreaterThan(0);
    // Named against the employee who is STILL HERE, so the operator can look up somebody who exists.
    expect(moved[0].employmentId).toBe(survivor);
    expect(moved[0].companyId).toBe(b.companyId);
    expect(moved[0].before).toBe('direct_manager → hr_admin');
    expect(moved[0].after).toBe('payroll');
    // …and it is NOT written off as a departure. The tuple still has a live member.
    expect(verdict.gone).toEqual([]);
  });

  it('a change of representative with no routing change is not reported as anything at all', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const bob = await hire('Bob');
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baselineSubjectsOf(baseline);
    const representative = baseline.subjects[0].employmentId;

    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-01-01' })
      .where(eq(schema.employment.id, representative));

    const after = await replayApprovalRouting(systemCtx());
    expect(after.subjects[0].employmentId).toBe([adaEmploymentId, bob.employmentId].find((id) => id !== representative));

    // Matching by tuple must not turn ordinary turnover into noise either: nothing moved, so nothing is
    // reported — not a failure, not a departure, and not a new case.
    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);
    expect(verdict.changed).toEqual([]);
    expect(verdict.gone).toEqual([]);
    expect(verdict.added).toBe(0);
    expect(replayVerdictFails(verdict)).toBe(false);
  });

  it('a baseline case naming an employment the baseline does not list is a FAILURE, never a silent skip', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    // A truncated or hand-edited baseline: a case with no subject to associate it with. It cannot be
    // checked, and an unchecked case must never be reported as passed.
    const verdict = verifyApprovalRouting(baseline.chains, baseline, []);
    expect(verdict.unmatched.length).toBe(baseline.chains.size);
    expect(verdict.gone).toEqual([]);
    expect(replayVerdictFails(verdict)).toBe(true);

    // Two subjects claiming the SAME tuple is the other way a hand-edited baseline becomes unassociable:
    // both would re-key onto one live representative and silently overwrite each other.
    const subjects = baselineSubjectsOf(baseline);
    const duplicated = verifyApprovalRouting(baseline.chains, baseline, [
      ...subjects,
      { ...subjects[0], employmentId: randomUUID() },
    ]);
    expect(duplicated.unmatched.length).toBe(baseline.chains.size);
    expect(duplicated.changed).toEqual([]);
    expect(replayVerdictFails(duplicated)).toBe(true);
  });

  it('a leave type added since the baseline is counted as new, not as a difference', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baselineSubjectsOf(baseline);

    await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'UNPAID', name: 'Unpaid Leave', paid: false });

    const after = await replayApprovalRouting(systemCtx());
    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);
    expect(verdict.changed).toEqual([]);
    expect(verdict.gone).toEqual([]);
    expect(verdict.added).toBe(after.subjects.length * after.dayProbes.length);
  });
});

describe('a6fe37fc §2.3 — coverage: which rules ever WIN', () => {
  it('credits the rule that wins and reports the rule that can never be reached', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const winnerId = await seedTargetedRule();
    // A rule scoped to a grade nobody holds. It is unreachable TODAY, and a clean diff must not be allowed
    // to imply it was checked.
    const [grade] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G99', name: 'Grade 99' })
      .returning({ id: schema.jobGrade.id });
    const [unreachable] = await owner.db
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        ruleName: 'Grade 99 escalation',
        leaveTypeId: sickTypeId,
        gradeId: grade.id,
        levels: ['hr_admin', 'payroll'],
      })
      .returning({ id: schema.leaveApprovalPolicy.id });

    const coverage = await withTenant(systemCtx(), async (tx) => {
      const { subjects } = await listRoutingSubjects(tx);
      const types = await tx.select({ id: schema.leaveType.id }).from(schema.leaveType);
      return approvalRoutingCoverage(tx, subjects, types.map((t) => t.id), await approvalDayProbes(tx));
    });

    const byId = new Map(coverage.rules.map((r) => [r.ruleId, r]));
    expect(byId.get(winnerId)?.wins).toBeGreaterThan(0);
    expect(byId.get(unreachable.id)?.wins).toBe(0);
    expect(byId.get(unreachable.id)?.ruleName).toBe('Grade 99 escalation');
    expect(coverage.bySource.rule).toBeGreaterThan(0);
    expect(coverage.decisions).toBe(coverage.bySource.rule + coverage.bySource['tenant-default'] + coverage.bySource.fallback);
  });

  it('reports coverage through the replay itself when asked, and not when it is not', async () => {
    await seedTargetedRule();
    expect((await replayApprovalRouting(systemCtx())).coverage).toBeNull();
    const withCoverage = await replayApprovalRouting(systemCtx(), { coverage: true });
    expect(withCoverage.coverage?.decisions).toBe(withCoverage.chains.size);
  });
});

describe('a6fe37fc — what the replay COSTS the production database it is pointed at', () => {
  /**
   * A HARNESS THAT RUNS AGAINST A CUSTOMER'S LIVE DATABASE HAS TO HAVE A KNOWN COST.
   *
   * The grid is (routing tuple × leave type × day probe), and the day-probe set grows with the number of
   * distinct min/max bounds across the tenant's rules — with 261 rules it is not 3 probes, it is potentially
   * hundreds. Resolution used to re-read every active rule and every active template PER CELL, and
   * `--coverage` walked the same grid a second time, so the round-trip count was `4 × cells`, unbounded and
   * unmeasured, inside one transaction held open against production.
   *
   * The bound asserted here is the real one: the number of database round-trips does not depend on the
   * grid's size at all. Growing the grid 50-fold must not add a single query.
   */
  it('resolves the whole grid in a CONSTANT number of round-trips, however large the grid', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    await seedTargetedRule();
    await hire('Grace', b.deptB);

    const measure = (dayProbes: number[]) =>
      withTenant(systemCtx(), async (tx) => {
        const { subjects } = await listRoutingSubjects(tx);
        const types = await tx.select({ id: schema.leaveType.id }).from(schema.leaveType);
        const leaveTypeIds = types.map((t) => t.id);
        let snapshotQueries = 0;
        const snap = await approvalRoutingSnapshot(
          countingTx(tx, () => { snapshotQueries += 1; }),
          subjects,
          leaveTypeIds,
          dayProbes,
        );
        let coverageQueries = 0;
        const cov = await approvalRoutingCoverage(
          countingTx(tx, () => { coverageQueries += 1; }),
          subjects,
          leaveTypeIds,
          dayProbes,
        );
        return { cells: snap.size, decisions: cov.decisions, snapshotQueries, coverageQueries };
      });

    const small = await measure([1]);
    const large = await measure(Array.from({ length: 50 }, (_, i) => i));

    // The grid really did grow — otherwise the assertion below is about nothing.
    expect(small.cells).toBeGreaterThan(0);
    expect(large.cells).toBe(small.cells * 50);
    expect(large.decisions).toBe(large.cells);

    // Two reads for a snapshot (the rules, the templates); three for coverage (those two plus the rule
    // listing it names rules by). The same numbers for a 50× larger grid.
    expect(small.snapshotQueries).toBe(2);
    expect(large.snapshotQueries).toBe(2);
    expect(small.coverageQueries).toBe(3);
    expect(large.coverageQueries).toBe(3);
  });

  it('holds its transaction open only for the reads — the grid is resolved after it has rolled back', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    await seedTargetedRule();
    const replay = await replayApprovalRouting(systemCtx(), { coverage: true });
    // Same answers as resolving inside the transaction one cell at a time (the promoted snapshot function,
    // which the 241817ef conversion proof still calls with a `tx`).
    const inTx = await withTenant(systemCtx(), (tx) =>
      approvalRoutingSnapshot(tx, replay.subjects, replay.leaveTypeIds, replay.dayProbes),
    );
    expect([...replay.chains.entries()].sort()).toEqual([...inTx.entries()].sort());
    expect(replay.coverage?.decisions).toBe(replay.chains.size);
  });
});

describe('a6fe37fc — the replay script points at production, so its SHAPE is the safety', () => {
  const source = () => readFileSync(new URL('../scripts/replay-approval-routing.ts', import.meta.url), 'utf8');
  const scriptPath = fileURLToPath(new URL('../scripts/replay-approval-routing.ts', import.meta.url));
  const runScript = (args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, MIGRATION_DATABASE_URL: '' },
    });

  it('has no apply mode and no write, and says so', () => {
    const src = source();
    // scripts/convert-approval-rules.ts has --apply because it converts. This one replays: the flag must
    // not exist, and neither must a quiet escape hatch that writes.
    expect(src).not.toContain('--apply');
    expect(src).not.toMatch(/\.(insert|update|delete)\(/);
    expect(src).toContain('THERE IS NO APPLY MODE');
  });

  it('documents an invocation that actually runs on the server (node v18 has no --env-file)', () => {
    const src = source();
    // `node --env-file=` exits 9 on the box (node v18.19.1) — 23 scripts in scripts/ document that broken
    // form and not one works as written. NAMING the flag to warn about it is fine and this header does;
    // documenting a COMMAND that uses it is what must never happen, so the check is over the commands.
    const invocations = src.split('\n').filter((l) => l.includes('node ') && l.includes('replay-approval-routing.ts'));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) expect(line).not.toContain('--env-file');
    expect(src).toContain('set -a && . ./.env.production && set +a');
    expect(src).toContain('node --import tsx scripts/replay-approval-routing.ts --baseline');
    expect(src).toContain('node --import tsx scripts/replay-approval-routing.ts --verify');
  });

  it('reads production through MIGRATION_DATABASE_URL, exactly as the conversion script does', () => {
    expect(source()).toContain('MIGRATION_DATABASE_URL');
  });

  /**
   * The script's own advertised property is that malformed input is REFUSED, not guessed at — that is the
   * whole reason an operator can be trusted with a tool pointed at production. `--baseline` used to take
   * the next argv element whatever it was, so on the box `--baseline --coverage` would have written a
   * production baseline to a file literally called `--coverage`, with the coverage report silently off.
   */
  it('refuses a --baseline/--verify whose filename is missing, instead of swallowing the next option', () => {
    const swallowed = runScript(['--baseline', '--coverage']);
    expect(swallowed.status).toBe(2);
    expect(swallowed.stderr).toContain('--baseline require(s) a filename');

    const verify = runScript(['--verify', '--coverage']);
    expect(verify.status).toBe(2);
    expect(verify.stderr).toContain('--verify require(s) a filename');

    // …and an unknown option is still refused, which is the property this one was supposed to share.
    const unknown = runScript(['--apply']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown option(s): --apply');

    // A well-formed pair still parses: it gets past the option checks to the connection guard.
    const wellFormed = runScript(['--baseline', '/tmp/a6fe37fc-not-written.json', '--coverage']);
    expect(wellFormed.status).toBe(1);
    expect(wellFormed.stderr).toContain('requires MIGRATION_DATABASE_URL');
  }, 60_000);
});
