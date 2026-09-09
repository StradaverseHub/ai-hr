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
 *   • The script has NO apply mode and documents an invocation that actually runs on the server.
 */
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
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
  verifyApprovalRouting,
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
    const baselineSubjects = baseline.subjects.map((s) => ({ employmentId: s.employmentId, companyId: s.companyId }));

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

  it('a baseline employment that is no longer a routing subject is reported but is NOT a failure', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baseline.subjects.map((s) => ({ employmentId: s.employmentId, companyId: s.companyId }));
    expect(baselineSubjects.map((s) => s.employmentId)).toContain(adaEmploymentId);

    // Ada leaves. §2.5: terminated employments are excluded — a terminated employee submits no leave.
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-01-01' })
      .where(eq(schema.employment.id, adaEmploymentId));

    const after = await replayApprovalRouting(systemCtx());
    const verdict = verifyApprovalRouting(baseline.chains, after, baselineSubjects);
    expect(verdict.changed).toEqual([]);
    expect(verdict.gone.length).toBeGreaterThan(0);
    // Still named — a company, not an empty string — so a suspicious number of them is visible.
    expect(verdict.gone[0].employmentId).toBe(adaEmploymentId);
    expect(verdict.gone[0].companyId).toBe(b.companyId);
  });

  it('a leave type added since the baseline is counted as new, not as a difference', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const baseline = await replayApprovalRouting(systemCtx());
    const baselineSubjects = baseline.subjects.map((s) => ({ employmentId: s.employmentId, companyId: s.companyId }));

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

describe('a6fe37fc — the replay script points at production, so its SHAPE is the safety', () => {
  const source = () => readFileSync(new URL('../scripts/replay-approval-routing.ts', import.meta.url), 'utf8');

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
});
