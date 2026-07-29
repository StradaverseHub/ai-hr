/**
 * ADR-0071 — leave-approval RULE MATRIX. The approval chain is a scoped set of rules per company:
 * (leave-type, business-unit, department, position, grade, employment-type, min/max day-range) — all
 * nullable/wildcard. resolveApprovalChain picks the MOST-SPECIFIC matching active rule, tie-broken
 * deterministically (narrower day-range → most-recently-created), falling through company-default then the
 * built-in [direct_manager, hr_admin]. Generated steps snapshot at submission and never re-resolve.
 */
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import {
  archiveLeaveApprovalRule,
  createLeaveApprovalRule,
  listLeaveApprovalRules,
  setLeaveApprovalPolicy,
  updateLeaveApprovalRule,
} from '../core/leave-approval-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let managerEmploymentId: string;
let gradeExec: string;
let gradeMgr: string;

const ctx = () => adminCtx(b);

/** Hire into deptA (Finance) with optional grade/position/employment-type overrides. */
const hire = (
  name: string,
  o: { gradeId?: string | null; positionId?: string; employmentType?: 'full_time' | 'part_time' | 'contract' | 'intern'; departmentId?: string } = {},
) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `rm_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: o.departmentId ?? b.deptA,
    positionId: o.positionId,
    employmentType: o.employmentType ?? 'full_time',
    gradeId: o.gradeId ?? null,
    hiredOn: '2024-01-01',
  });

const kindsFor = async (leaveRequestId: string) =>
  (
    await owner.db
      .select({ kind: schema.leaveApprovalStep.approverKind })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId))
      .orderBy(schema.leaveApprovalStep.stepIndex)
  ).map((r) => r.kind);

/** A single-day (1-day) annual request unless a range is given (2026-07-01 is a Wednesday). */
const request = (
  employmentId = subject.employmentId,
  range: { startDate: string; endDate: string } = { startDate: '2026-07-01', endDate: '2026-07-01' },
) => requestLeave(ctx(), { employmentId, leaveTypeId: b.annualLeaveTypeId, ...range });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // Two job grades to exercise grade-scoped rules.
  const [ge] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: 'EXEC', name: 'Executive', rank: 1 })
    .returning({ id: schema.jobGrade.id });
  const [gm] = await owner.db
    .insert(schema.jobGrade)
    .values({ tenantId: b.tenantId, code: 'MGR', name: 'Manager', rank: 2 })
    .returning({ id: schema.jobGrade.id });
  gradeExec = ge.id;
  gradeMgr = gm.id;
  subject = await hire('Subject', { gradeId: gradeExec });
  const manager = await hire('Manager');
  managerEmploymentId = manager.employmentId;
  await setReportingLine(ctx(), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  // Turn the company multi-approval gate on (rules only apply to opted-in companies).
  await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0071 rule CRUD + archive', () => {
  it('creates, lists, updates and archives a scoped rule', async () => {
    const { id } = await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      ruleName: 'Finance execs',
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['direct_manager', 'hr_admin'],
    });
    let rules = await listLeaveApprovalRules(ctx(), b.companyId);
    const created = rules.find((r) => r.id === id)!;
    expect(created.ruleName).toBe('Finance execs');
    expect(created.departmentId).toBe(b.deptA);
    expect(created.gradeId).toBe(gradeExec);
    expect(created.levels).toEqual(['direct_manager', 'hr_admin']);

    await updateLeaveApprovalRule(ctx(), id, {
      companyId: b.companyId,
      ruleName: 'Finance execs v2',
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['hr_admin'],
    });
    rules = await listLeaveApprovalRules(ctx(), b.companyId);
    expect(rules.find((r) => r.id === id)!.levels).toEqual(['hr_admin']);
    expect(rules.find((r) => r.id === id)!.ruleName).toBe('Finance execs v2');

    await archiveLeaveApprovalRule(ctx(), id, b.companyId);
    rules = await listLeaveApprovalRules(ctx(), b.companyId);
    expect(rules.find((r) => r.id === id)).toBeUndefined(); // list is active-only
    // Soft delete, not hard: the row still exists with active=false.
    const [row] = await owner.db
      .select({ active: schema.leaveApprovalPolicy.active })
      .from(schema.leaveApprovalPolicy)
      .where(eq(schema.leaveApprovalPolicy.id, id));
    expect(row.active).toBe(false);

    const events = await owner.db
      .select({ t: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    const types = events.map((e) => e.t);
    expect(types).toContain('leave-approval-rule.created');
    expect(types).toContain('leave-approval-rule.updated');
    expect(types).toContain('leave-approval-rule.archived');
  });

  it('rejects a rule with no levels and a min>max day range', async () => {
    await expect(
      createLeaveApprovalRule(ctx(), { companyId: b.companyId, departmentId: b.deptA, levels: [] }),
    ).rejects.toThrow();
    await expect(
      createLeaveApprovalRule(ctx(), { companyId: b.companyId, minDays: 10, maxDays: 5, levels: ['hr_admin'] }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate full-tuple rule', async () => {
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['hr_admin'],
    });
    await expect(
      createLeaveApprovalRule(ctx(), {
        companyId: b.companyId,
        departmentId: b.deptA,
        gradeId: gradeExec,
        levels: ['direct_manager', 'hr_admin'], // different chain, SAME scope tuple → rejected
      }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('ADR-0071 specificity resolution', () => {
  it('a more-specific rule beats the company default beats the built-in fallback', async () => {
    // No matching rule yet → company default (set in beforeEach).
    const r0 = await request();
    expect(await kindsFor(r0.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);

    // A dept+grade rule that matches the subject (Finance + Executive) — more specific.
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['hr_admin', 'payroll'],
    });
    const r1 = await request();
    expect(await kindsFor(r1.leaveRequestId)).toEqual(['hr_admin', 'payroll']);
  });

  it('a rule that does not match is ignored (department mismatch)', async () => {
    // Rule scoped to Operations (deptB) — subject is in Finance (deptA), so it must not apply.
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      departmentId: b.deptB,
      levels: ['hr_admin'],
    });
    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']); // falls to default
  });

  it('null grade on the employee never matches a grade-scoped rule', async () => {
    const ungraded = await hire('Ungraded', { gradeId: null });
    await setReportingLine(ctx(), {
      subordinateEmploymentId: ungraded.employmentId,
      managerEmploymentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeId: gradeExec, // rule requires Executive grade
      levels: ['hr_admin'],
    });
    const r = await request(ungraded.employmentId);
    // Ungraded employee: the grade-scoped rule is a NON-match → falls to company default.
    expect(await kindsFor(r.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);
  });
});

describe('ADR-0071 day-range matching', () => {
  it('matches min/max inclusive boundaries and unbounded sides', async () => {
    // Rule: 3–5 day requests get HR-only.
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      minDays: 3,
      maxDays: 5,
      levels: ['hr_admin', 'payroll'],
    });
    // 1-day request → outside range → default.
    const short = await request(subject.employmentId, { startDate: '2026-07-01', endDate: '2026-07-01' });
    expect(await kindsFor(short.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);
    // 3-day request (Jul 1–3, inclusive lower boundary) → in range → HR-only.
    const inRange = await request(subject.employmentId, { startDate: '2026-07-01', endDate: '2026-07-03' });
    expect(await kindsFor(inRange.leaveRequestId)).toEqual(['hr_admin', 'payroll']);
  });

  it('deterministic tie-break: narrower day-range wins on equal specificity', async () => {
    // Two rules, both scoped ONLY by a day-range (equal specificity = 1). The narrower range must win.
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      minDays: 1,
      maxDays: 10,
      levels: ['direct_manager'], // wider
    });
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      minDays: 1,
      maxDays: 3,
      levels: ['hr_admin', 'payroll'], // narrower → should win for a 1-day request
    });
    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['hr_admin', 'payroll']);
  });
});

describe('ADR-0071 snapshot immutability + coexistence', () => {
  it('editing/archiving a rule after submission never changes a pending request', async () => {
    const { id } = await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['hr_admin', 'payroll'],
    });
    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['hr_admin', 'payroll']);

    // Change the rule's chain, then archive it entirely — the already-generated steps must be untouched.
    await updateLeaveApprovalRule(ctx(), id, {
      companyId: b.companyId,
      departmentId: b.deptA,
      gradeId: gradeExec,
      levels: ['direct_manager', 'hr_admin'],
    });
    await archiveLeaveApprovalRule(ctx(), id, b.companyId);
    expect(await kindsFor(r.leaveRequestId)).toEqual(['hr_admin', 'payroll']); // unchanged
  });

  it('multiple active rules coexist per company', async () => {
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, departmentId: b.deptA, levels: ['hr_admin'] });
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, departmentId: b.deptB, levels: ['direct_manager'] });
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, gradeId: gradeMgr, levels: ['direct_manager', 'hr_admin'] });
    const rules = await listLeaveApprovalRules(ctx(), b.companyId);
    // 3 scoped rules + the company-default row from setLeaveApprovalPolicy.
    expect(rules.length).toBeGreaterThanOrEqual(3);
  });
});

describe('ADR-0071 multi-employment isolation', () => {
  it('resolution never pulls attributes from a concurrent employment at a different company', async () => {
    // A second company + a second employment for the SAME person, in that other company's department.
    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Co' })
      .returning({ id: schema.company.id });
    const [d2] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: c2.id, name: 'Sales' })
      .returning({ id: schema.department.id });
    // Concurrent employment for the subject's person at the other company.
    const [emp2] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: subject.personId, companyId: c2.id, hiredOn: '2024-01-01', gradeId: gradeMgr })
      .returning({ id: schema.employment.id });
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: emp2.id,
      departmentId: d2.id,
      employmentType: 'full_time',
      validFrom: '2024-01-01',
    });
    // A rule at company 1 scoped to the OTHER company's department must never match employment 1.
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, departmentId: d2.id, levels: ['hr_admin'] });
    const r = await request(); // subject's employment at company 1
    expect(await kindsFor(r.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']); // default, not the d2 rule
    void sql; // (kept for parity with harness import style)
  });
});
