/**
 * 241817ef — CONVERT FIRST, REMOVE SECOND.
 *
 * Before the Approval Workflows and Company base approval chain sections can leave the Approval tab,
 * every rule those sections are the only editor for has to become an ordinary template-driven,
 * leave-type-scoped assignment. `convertLegacyApprovalRules` does that rewrite and PROVES, inside the same
 * transaction, that no employee's resolved approver chain moved.
 *
 * What these tests pin:
 *   • the enumeration finds exactly the rows the assignment screen cannot own (no template, or any-type);
 *   • the per-company base chain becomes one assignment per leave type, resolving IDENTICALLY;
 *   • a leave type already covered by an identically-scoped rule is left alone (that rule wins today);
 *   • a rule carrying its own chain is repointed at a template with the same steps, reusing an existing
 *     template when one matches;
 *   • a dry run writes NOTHING while still doing the work and the proof;
 *   • a rewrite that WOULD move an approver throws and rolls back — the fail-loud path is the point.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { resolveApprovalChain, setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { createApprovalTemplate, listTemplateAssignments } from '../core/leave-approval-template';
import {
  ApprovalRoutingChangedError,
  convertLegacyApprovalRules,
  listLegacyApprovalRules,
} from '../core/leave-approval-consolidation';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let sickTypeId: string;
const ctx = () => adminCtx(b);

const resolve = (leaveTypeId: string, attrs = {}) =>
  withTenant(ctx(), (tx) => resolveApprovalChain(tx, b.companyId, leaveTypeId, attrs));

const legacy = () => withTenant(ctx(), (tx) => listLegacyApprovalRules(tx));

const activeRules = () =>
  owner.db
    .select({
      id: schema.leaveApprovalPolicy.id,
      leaveTypeId: schema.leaveApprovalPolicy.leaveTypeId,
      templateId: schema.leaveApprovalPolicy.templateId,
      departmentId: schema.leaveApprovalPolicy.departmentId,
    })
    .from(schema.leaveApprovalPolicy)
    .where(
      and(
        eq(schema.leaveApprovalPolicy.companyId, b.companyId),
        eq(schema.leaveApprovalPolicy.active, true),
      ),
    );

const hire = (name: string, departmentId?: string) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `cv_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    gradeId: null,
    hiredOn: '2024-01-01',
  });

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
  await hire('Ada');
});
afterAll(async () => {
  await closeAll();
});

describe('241817ef — enumerating what the Assignment Template screen cannot own', () => {
  it('finds the base chain and a custom-chain rule, and ignores an ordinary assignment', async () => {
    // The per-company base chain: fully wildcard, its own levels, no template.
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    // An ordinary template assignment — the shape the screen already owns.
    const tpl = await createApprovalTemplate(ctx(), { name: 'HR only', levels: ['hr_admin'] });
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      templateId: tpl.id,
      levels: [],
    });

    const rows = await legacy();
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBeNull();
    expect(rows[0].reasons.sort()).toEqual(['any-leave-type', 'no-template']);
  });

  it('a leave-type-scoped rule with its own chain is legacy for ONE reason only', async () => {
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: sickTypeId,
      levels: ['hr_admin'],
    });
    const rows = await legacy();
    expect(rows).toHaveLength(1);
    expect(rows[0].reasons).toEqual(['no-template']);
  });
});

describe('241817ef — converting the per-company base chain', () => {
  it('writes one assignment per leave type and resolves identically', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const beforeAnnual = await resolve(b.annualLeaveTypeId);
    const beforeSick = await resolve(sickTypeId);

    const report = await convertLegacyApprovalRules(ctx(), { apply: true });
    expect(report.applied).toBe(true);
    expect(report.routingChecks).toBeGreaterThan(0);
    expect(report.employmentsCovered).toBeGreaterThan(0);

    // The wildcard source is archived; one leave-type-scoped, template-driven row per type replaces it.
    const rows = await activeRules();
    expect(rows.map((r) => r.leaveTypeId).sort()).toEqual([b.annualLeaveTypeId, sickTypeId].sort());
    expect(rows.every((r) => r.templateId !== null)).toBe(true);

    // Resolution is unchanged — which is the whole point of doing this before removing the editor.
    expect(await resolve(b.annualLeaveTypeId)).toEqual(beforeAnnual);
    expect(await resolve(sickTypeId)).toEqual(beforeSick);

    // …and every converted row now shows up on the Assignment Template screen.
    const assignments = await listTemplateAssignments(ctx());
    expect(assignments.map((a) => a.leaveTypeId).sort()).toEqual([b.annualLeaveTypeId, sickTypeId].sort());

    // Re-running finds nothing left to do.
    expect(await legacy()).toHaveLength(0);
  });

  it('leaves a leave type alone when an identically-scoped rule already covers it', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const tpl = await createApprovalTemplate(ctx(), { name: 'HR only', levels: ['hr_admin'] });
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: sickTypeId,
      templateId: tpl.id,
      levels: [],
    });

    const report = await convertLegacyApprovalRules(ctx(), { apply: true });
    const skipped = report.actions.filter((a) => a.kind === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ leaveTypeId: sickTypeId });
    // SICK keeps the chain it already had; ANNUAL inherits the base chain explicitly.
    expect(await resolve(sickTypeId)).toEqual(['hr_admin']);
    expect(await resolve(b.annualLeaveTypeId)).toEqual(['direct_manager', 'hr_admin']);
  });
});

describe('241817ef — converting a rule that carries its own chain', () => {
  it('repoints it at a NEW template with the same steps', async () => {
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: sickTypeId,
      levels: ['hr_admin', 'payroll'],
    });
    const report = await convertLegacyApprovalRules(ctx(), { apply: true });
    expect(report.actions.some((a) => a.kind === 'template-created')).toBe(true);

    const [row] = await activeRules();
    expect(row.templateId).not.toBeNull();
    const [tpl] = await owner.db
      .select({ levels: schema.leaveApprovalTemplate.levels })
      .from(schema.leaveApprovalTemplate)
      .where(eq(schema.leaveApprovalTemplate.id, row.templateId!));
    expect(tpl.levels).toEqual(['hr_admin', 'payroll']);
    expect(await resolve(sickTypeId)).toEqual(['hr_admin', 'payroll']);
  });

  it('REUSES an existing active template whose chain already matches, instead of minting a duplicate', async () => {
    const existing = await createApprovalTemplate(ctx(), { name: 'Payroll sign-off', levels: ['hr_admin', 'payroll'] });
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: sickTypeId,
      levels: ['hr_admin', 'payroll'],
    });
    const report = await convertLegacyApprovalRules(ctx(), { apply: true });
    expect(report.actions.some((a) => a.kind === 'template-created')).toBe(false);
    expect(report.actions).toContainEqual(
      expect.objectContaining({ kind: 'template-reused', templateId: existing.id }),
    );
    const templates = await owner.db.select({ id: schema.leaveApprovalTemplate.id }).from(schema.leaveApprovalTemplate);
    expect(templates).toHaveLength(1);
  });
});

describe('241817ef — the dry run and the proof', () => {
  it('a dry run reports the full plan and writes NOTHING', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const rulesBefore = await activeRules();

    const report = await convertLegacyApprovalRules(ctx(), {});
    expect(report.applied).toBe(false);
    // It really did the work — the plan is measured, not predicted.
    expect(report.actions.filter((a) => a.kind === 'expanded')).toHaveLength(2);
    expect(report.routingChecks).toBeGreaterThan(0);

    const rulesAfter = await activeRules();
    expect(rulesAfter.map((r) => r.id).sort()).toEqual(rulesBefore.map((r) => r.id).sort());
    expect(rulesAfter.every((r) => r.templateId === null)).toBe(true);
    // No template was left behind by the rolled-back run either.
    const templates = await owner.db.select({ id: schema.leaveApprovalTemplate.id }).from(schema.leaveApprovalTemplate);
    expect(templates).toHaveLength(0);
  });

  it('THROWS and rolls back when the rewrite would move an approver', async () => {
    // An "any leave type" rule scoped to a department (specificity 1) and a leave-type-scoped rule with
    // no other scope (also specificity 1). The newer of the two wins the tie for a Finance employee
    // asking for ANNUAL. Expanding the department rule to ANNUAL makes it specificity 2 — it would start
    // winning, which is exactly the silent re-route this conversion exists to prevent.
    //
    // r281 53e914fe — THE TIMESTAMPS ARE SET EXPLICITLY, and that is the whole fix to this test. It used
    // to lean on two consecutive inserts landing on two different `created_at` values. They do differ in
    // the DATABASE (microseconds), but `beats` compares them as JS `Date`s, whose `getTime()` is
    // MILLISECONDS — so two inserts inside one millisecond tied, the ranking separated nothing, and the
    // winner fell through to row order. That is why this line went red once inside a loaded gate chunk
    // and green on re-run at the same commit. Sixty and thirty seconds ago, derived from the clock, put
    // the pair a comfortable distance apart on the term this test is actually about: RECENCY. The tie
    // case itself is pinned on purpose in test/r281-approval-tie-order.test.ts.
    const now = Date.now();
    const deptTpl = await createApprovalTemplate(ctx(), { name: 'Dept chain', levels: ['department_head'] });
    const typeTpl = await createApprovalTemplate(ctx(), { name: 'Type chain', levels: ['payroll'] });
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: null,
      departmentId: b.deptA,
      templateId: deptTpl.id,
      levels: [],
      createdAt: new Date(now - 60_000),
    });
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      templateId: typeTpl.id,
      levels: [],
      createdAt: new Date(now - 30_000),
    });

    const attrs = { departmentId: b.deptA };
    const before = await resolve(b.annualLeaveTypeId, attrs);
    expect(before).toEqual(['payroll']); // the NEWER of the two equally-specific rules wins — by 30s, not by luck

    const err = await convertLegacyApprovalRules(ctx(), { apply: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRoutingChangedError);
    expect((err as ApprovalRoutingChangedError).differences.length).toBeGreaterThan(0);
    expect((err as ApprovalRoutingChangedError).differences[0]).toMatchObject({
      before: 'payroll',
      after: 'department_head',
    });

    // Nothing was written: the any-type rule is still active and still unconverted.
    expect(await resolve(b.annualLeaveTypeId, attrs)).toEqual(before);
    const stillLegacy = await legacy();
    expect(stillLegacy).toHaveLength(1);
    expect(stillLegacy[0].leaveTypeId).toBeNull();
  });
});

describe('241817ef — what the before/after proof cannot see', () => {
  it('reports the future-leave-type caveat for every company whose any-type rule was expanded', async () => {
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const report = await convertLegacyApprovalRules(ctx(), {});
    expect(report.caveats).toHaveLength(1);
    expect(report.caveats[0].companyId).toBe(b.companyId);
    expect(report.caveats[0].note).toMatch(/added later/);
  });

  it('says nothing when there was no any-type rule to expand', async () => {
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: sickTypeId,
      levels: ['hr_admin'],
    });
    const report = await convertLegacyApprovalRules(ctx(), {});
    expect(report.actions.some((a) => a.kind === 'rule-templated')).toBe(true);
    expect(report.caveats).toEqual([]);
  });

  it('REFUSES to archive an any-type rule when the tenant has no leave types to expand into', async () => {
    // Archiving it anyway would drop the chain with the proof seeing nothing — it iterates leave types,
    // and there are none. The rule survives, unconverted, and is reported.
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['hr_admin'] });
    await owner.db.delete(schema.leaveApprovalPolicy).where(
      and(
        eq(schema.leaveApprovalPolicy.companyId, b.companyId),
        eq(schema.leaveApprovalPolicy.active, true),
        isNull(schema.leaveApprovalPolicy.leaveTypeId),
      ),
    );
    // Re-create it directly so no leave-type-scoped rows reference the types we are about to remove.
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: null,
      levels: ['hr_admin'],
    });
    await owner.db.delete(schema.leaveType).where(eq(schema.leaveType.tenantId, b.tenantId));

    const report = await convertLegacyApprovalRules(ctx(), { apply: true });
    const skipped = report.actions.filter((a) => a.kind === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ reason: expect.stringContaining('no leave types') });
    // Still active, still the company's chain.
    const rows = await activeRules();
    expect(rows).toHaveLength(1);
    expect(rows[0].leaveTypeId).toBeNull();
  });
});

describe('241817ef — routing subjects', () => {
  it('a terminated employment is not a routing subject', async () => {
    const second = await hire('Grace', b.deptB);
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2025-01-01' })
      .where(eq(schema.employment.id, second.employmentId));
    await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['hr_admin'] });

    const report = await convertLegacyApprovalRules(ctx(), {});
    // Ada only — the terminated employment is out of scope, exactly as it is for a leave request.
    expect(report.employmentsCovered).toBe(1);
    const stillOpen = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .where(isNull(schema.employment.terminatedOn));
    expect(stillOpen).toHaveLength(1);
  });
});
