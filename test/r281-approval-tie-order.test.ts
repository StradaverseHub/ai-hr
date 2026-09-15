/**
 * r281 53e914fe — WHO APPROVES A PERSON'S LEAVE MUST NOT DEPEND ON THE QUERY PLAN.
 *
 * `decideApproval` ranks matching rules by specificity, then by day-range width, then by `created_at`.
 * When all three terms tie it kept `matching[0]` — the first row the query handed back — and the routing
 * read (`loadApprovalRuleSet`) carried NO `ORDER BY` at all. So the tie-break was row order, which
 * Postgres does not promise and which changes with the plan, the row count and a vacuum.
 *
 * TWO INDEPENDENT WAYS THE THIRD TERM TIES, and this file pins both:
 *   1. Postgres `now()` is TRANSACTION-START time, so two rules written in one transaction (a seed, an
 *      import, a scripted conversion, one server action that writes a pair) share a byte-identical
 *      `created_at`. The first test below proves the tie is real rather than assumed.
 *   2. The driver hands `created_at` back as a JS `Date`, whose `getTime()` is MILLISECONDS, while the
 *      column holds MICROseconds. Two rows written 300µs apart tie in JS and not in SQL. This is why the
 *      flake at test/leave-approval-consolidation.test.ts did not need one transaction to happen.
 *
 * WHAT IS ASSERTED, and deliberately not: the point is STABILITY, not a particular winner. Asserting a
 * specific approver is what made the consolidation assertion flaky rather than wrong. The invariant here
 * is that the answer does not move — across repeated calls, and across the order the rows arrive in.
 * Which of a tied pair wins is arbitrary-but-permanent (`id` ascending, matching the read's ORDER BY);
 * where a winner IS named below it is DERIVED from the ids the test just inserted, never hardcoded.
 *
 * NON-VACUITY: `decideApproval does not depend on the order the rules arrive in` fails immediately if the
 * `id` term is removed from `beats` — it feeds the same rules to the one matcher in both orders and the
 * old comparator separated nothing. A stability-across-calls assertion alone would NOT have failed:
 * repeated identical queries against an unchanged table return the same heap order, so it would have been
 * green against the defect. That is the whole reason this file ranks the array itself rather than the DB.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { listLegacyApprovalRules } from '../core/leave-approval-consolidation';
import {
  decideApproval,
  loadApprovalRuleSet,
  resolveApprovalChain,
  listLeaveApprovalRules,
  type ApprovalRuleSet,
} from '../core/leave-approval-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const ctx = () => adminCtx(b);

/** The request both rules below match: an ANNUAL request from someone in department A. */
const attrs = () => ({ departmentId: b.deptA });
const resolve = () => withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, b.annualLeaveTypeId, attrs()));
const ruleSet = () => withTenant(ctx(), (tx) => loadApprovalRuleSet(tx, b.companyId));

/**
 * Two rules that are EQUALLY SPECIFIC (one dimension each) and that BOTH match an annual request from
 * department A, so nothing but the tie-break separates them:
 *   • the DEPT rule scopes by department and leaves the leave type open;
 *   • the TYPE rule scopes by leave type and leaves the org scope open.
 * Written in ONE transaction, so `now()` — and therefore `created_at` — is identical to the microsecond.
 */
async function insertTiedPair(): Promise<{ deptRuleId: string; typeRuleId: string }> {
  return owner.db.transaction(async (tx) => {
    const [dept] = await tx
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: null,
        departmentId: b.deptA,
        levels: ['department_head'],
      })
      .returning({ id: schema.leaveApprovalPolicy.id });
    const [type] = await tx
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: b.annualLeaveTypeId,
        levels: ['payroll'],
      })
      .returning({ id: schema.leaveApprovalPolicy.id });
    return { deptRuleId: dept.id, typeRuleId: type.id };
  });
}

/** `created_at` as the DATABASE holds it — microseconds, not the millisecond a JS `Date` survives with. */
const exactCreatedAt = async (id: string): Promise<string> => {
  const [row] = await owner.db
    .select({ exact: sql<string>`${schema.leaveApprovalPolicy.createdAt}::text` })
    .from(schema.leaveApprovalPolicy)
    .where(eq(schema.leaveApprovalPolicy.id, id));
  return row.exact;
};

/** The same rule set with one company's rules handed to the matcher BACK TO FRONT. */
const reversed = (set: ApprovalRuleSet): ApprovalRuleSet => ({
  ...set,
  rulesByCompany: new Map([...set.rulesByCompany].map(([k, v]) => [k, [...v].reverse()])),
});

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('r281 53e914fe — the tie is real', () => {
  it('two rules written in ONE transaction share a byte-identical created_at', async () => {
    const { deptRuleId, typeRuleId } = await insertTiedPair();
    // If this ever stops holding, every other assertion in this file is proving something else.
    expect(await exactCreatedAt(deptRuleId)).toBe(await exactCreatedAt(typeRuleId));
  });

  it('both rules really do match the same request, at the same specificity', async () => {
    const { deptRuleId, typeRuleId } = await insertTiedPair();
    const set = await ruleSet();
    const winner = decideApproval(set, b.companyId, b.annualLeaveTypeId, attrs());
    // A tie only means something if BOTH candidates are live: the winner must be one of the pair, and
    // removing it must hand the decision to the other — not to the fallback chain.
    expect([deptRuleId, typeRuleId]).toContain(winner.ruleId);
    const loser = winner.ruleId === deptRuleId ? typeRuleId : deptRuleId;
    await owner.db
      .update(schema.leaveApprovalPolicy)
      .set({ active: false })
      .where(eq(schema.leaveApprovalPolicy.id, winner.ruleId!));
    const next = decideApproval(await ruleSet(), b.companyId, b.annualLeaveTypeId, attrs());
    expect(next.ruleId).toBe(loser);
    expect(next.source).toBe('rule');
  });
});

describe('r281 53e914fe — the resolution is stable', () => {
  it('repeated resolution of a tied pair never moves the approver', async () => {
    await insertTiedPair();
    const first = await resolve();
    for (let i = 0; i < 6; i++) expect(await resolve()).toEqual(first);
    // And it is one of the two configured chains, not the built-in fallback.
    expect([['department_head'], ['payroll']]).toContainEqual(first);
  });

  it('decideApproval does not depend on the order the rules arrive in', async () => {
    // ⚠️ THE NON-VACUITY LEVER. Drop the `id` term from `beats` and this fails on the spot: with the
    // three ranked terms all tied the old comparator returned false in both directions, so the winner
    // was whichever rule sat at index 0 — and here that is a different rule in each direction.
    // (The pair has to be INSERTED for that to mean anything: with an empty table both sides fall to the
    //  built-in chain and agree for the wrong reason. The r281 verify pass caught exactly that omission.)
    await insertTiedPair();
    const set = await ruleSet();
    const forwards = decideApproval(set, b.companyId, b.annualLeaveTypeId, attrs());
    const backwards = decideApproval(reversed(set), b.companyId, b.annualLeaveTypeId, attrs());
    expect(backwards.ruleId).toBe(forwards.ruleId);
    expect(backwards.levels).toEqual(forwards.levels);
  });

  it('the winner of a tie is the lower id — arbitrary, but the same one forever', async () => {
    const { deptRuleId, typeRuleId } = await insertTiedPair();
    // DERIVED from the ids just inserted, never hardcoded: which uuid is lower is random per run. This
    // says only that the documented term is the one doing the deciding.
    const expected = deptRuleId < typeRuleId ? deptRuleId : typeRuleId;
    const set = await ruleSet();
    expect(decideApproval(set, b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(expected);
    expect(decideApproval(reversed(set), b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(expected);
  });

  it('the routing read hands the matcher a totally ordered list', async () => {
    await insertTiedPair();
    // Four more rules, in TWO tied groups of two. All of them are org-scoped, which keeps them clear of
    // `leave_approval_policy_wildcard_uq` — the partial unique index that makes the FULLY-wildcard
    // (company, leave-type) row a singleton, and which is why a tied pair has to be built out of rules
    // that differ on some dimension in the first place.
    const now = Date.now();
    await owner.db.transaction(async (tx) => {
      for (const [i, dept] of [b.deptA, b.deptB].entries()) {
        for (const employmentType of ['full_time', 'part_time'] as const) {
          await tx.insert(schema.leaveApprovalPolicy).values({
            tenantId: b.tenantId,
            companyId: b.companyId,
            leaveTypeId: b.annualLeaveTypeId,
            departmentId: dept,
            employmentType,
            levels: ['hr_admin'],
            createdAt: new Date(now - 60_000 + i * 30_000),
          });
        }
      }
    });
    const rows = (await ruleSet()).rulesByCompany.get(b.companyId) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // (created_at, id) ascending, with no exception — the property the ORDER BY exists to provide, read
    // back off the array the matcher is actually handed rather than off the SQL that produced it.
    const key = (r: { createdAt: Date; id: string }) => `${r.createdAt.toISOString()}|${r.id}`;
    expect(rows.map(key)).toEqual([...rows.map(key)].sort());
  });
});

describe('r281 53e914fe — nothing that was already decided moves', () => {
  it('an UNTIED pair still resolves by recency, in either arrival order', async () => {
    // Timestamps set explicitly and derived from the clock, far enough apart to survive the millisecond
    // truncation a JS `Date` imposes. The newer rule must win — that is the pre-existing rule and the
    // `id` term must never reach into a pair `created_at` already separated.
    const now = Date.now();
    const [older] = await owner.db
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: null,
        departmentId: b.deptA,
        levels: ['department_head'],
        createdAt: new Date(now - 60_000),
      })
      .returning({ id: schema.leaveApprovalPolicy.id });
    const [newer] = await owner.db
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: b.annualLeaveTypeId,
        levels: ['payroll'],
        createdAt: new Date(now - 30_000),
      })
      .returning({ id: schema.leaveApprovalPolicy.id });
    expect(older.id).not.toBe(newer.id);

    const set = await ruleSet();
    expect(decideApproval(set, b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(newer.id);
    expect(decideApproval(reversed(set), b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(newer.id);
    expect(await resolve()).toEqual(['payroll']);
  });

  it('a MORE SPECIFIC rule still wins outright, tie-break or not', async () => {
    const { deptRuleId } = await insertTiedPair();
    // Specificity 2 (leave type + department), written in the same breath as the tied pair.
    const [both] = await owner.db
      .insert(schema.leaveApprovalPolicy)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        leaveTypeId: b.annualLeaveTypeId,
        departmentId: b.deptA,
        levels: ['hr_admin'],
      })
      .returning({ id: schema.leaveApprovalPolicy.id });
    expect(both.id).not.toBe(deptRuleId);
    const set = await ruleSet();
    expect(decideApproval(set, b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(both.id);
    expect(decideApproval(reversed(set), b.companyId, b.annualLeaveTypeId, attrs()).ruleId).toBe(both.id);
    expect(await resolve()).toEqual(['hr_admin']);
  });

  it('a NARROWER day range still wins a created_at tie, before id is ever consulted', async () => {
    // Both specificity 1 (a day range counts once), written in one transaction so `created_at` ties.
    const { narrow, wide } = await owner.db.transaction(async (tx) => {
      const [n] = await tx
        .insert(schema.leaveApprovalPolicy)
        .values({
          tenantId: b.tenantId,
          companyId: b.companyId,
          leaveTypeId: null,
          minDays: 1,
          maxDays: 2,
          levels: ['payroll'],
        })
        .returning({ id: schema.leaveApprovalPolicy.id });
      const [w] = await tx
        .insert(schema.leaveApprovalPolicy)
        .values({
          tenantId: b.tenantId,
          companyId: b.companyId,
          leaveTypeId: null,
          minDays: 1,
          maxDays: 9,
          levels: ['department_head'],
        })
        .returning({ id: schema.leaveApprovalPolicy.id });
      return { narrow: n.id, wide: w.id };
    });
    expect(await exactCreatedAt(narrow)).toBe(await exactCreatedAt(wide));
    const set = await ruleSet();
    const dec = (s: ApprovalRuleSet) => decideApproval(s, b.companyId, b.annualLeaveTypeId, { ...attrs(), days: 2 });
    expect(dec(set).ruleId).toBe(narrow);
    expect(dec(reversed(set)).ruleId).toBe(narrow);
  });
});

describe('r281 53e914fe — the listings are totally ordered too', () => {
  it('the rule-builder listing and the legacy report both name a tied pair in a fixed order', async () => {
    const { deptRuleId, typeRuleId } = await insertTiedPair();
    const lo = deptRuleId < typeRuleId ? deptRuleId : typeRuleId;
    const hi = deptRuleId < typeRuleId ? typeRuleId : deptRuleId;

    // listLeaveApprovalRules re-sorts by specificity in JS; Array.prototype.sort is stable, so within one
    // specificity band the rows keep the order the query gave them — which is now (created_at, id).
    const builder = await listLeaveApprovalRules(ctx(), b.companyId);
    const builderIds = builder.map((r) => r.id);
    expect(await listLeaveApprovalRules(ctx(), b.companyId).then((r) => r.map((x) => x.id))).toEqual(builderIds);
    expect(builderIds.indexOf(lo)).toBeLessThan(builderIds.indexOf(hi));

    // listLegacyApprovalRules enumerates the same rows for the conversion report. Both of this pair are
    // legacy (no template), so both appear, and the report must read the same way every time it is run.
    const legacyIds = await withTenant(ctx(), (tx) => listLegacyApprovalRules(tx)).then((r) => r.map((x) => x.id));
    expect(legacyIds).toContain(lo);
    expect(legacyIds).toContain(hi);
    expect(legacyIds.indexOf(lo)).toBeLessThan(legacyIds.indexOf(hi));
  });
});
