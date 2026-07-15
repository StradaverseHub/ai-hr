/**
 * R41 72800eda — Approval Workflow Configuration Enhancement.
 *
 * Two new capabilities on the leave-approval rule matrix, verified end-to-end through resolveApprovalChain
 * (via requestLeave, which snapshots the generated steps):
 *   (1) GRADE-GROUP scoping — a rule may scope by grade_group; the requester's individual grade is mapped to
 *       its group (grade_group_member) at submit time. Individual grade_id scoping keeps working alongside it.
 *   (2) DEFAULT WORKFLOW — a rule may draw its ordered chain from a reusable approval TEMPLATE (template_id)
 *       instead of its own levels; CUSTOM rules keep carrying their own levels.
 *   (3) The existing min/max day-range keeps resolving as the "Leave Duration" condition.
 * Plus the CRUD round-trip of gradeGroupId + templateId through create/list/update.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import {
  createLeaveApprovalRule,
  listLeaveApprovalRules,
  setLeaveApprovalPolicy,
  updateLeaveApprovalRule,
} from '../core/leave-approval-policy';
import { createApprovalTemplate } from '../core/leave-approval-template';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let managerEmploymentId: string;
let gradeExec: string;
let gradeMgr: string;
let bandExecId: string; // grade group containing gradeExec only

const ctx = () => adminCtx(b);

const hire = (name: string, o: { gradeId?: string | null } = {}) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `gg_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
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
  // A grade group holding ONLY the Executive grade.
  const [grp] = await owner.db
    .insert(schema.gradeGroup)
    .values({ tenantId: b.tenantId, name: 'Band Exec' })
    .returning({ id: schema.gradeGroup.id });
  bandExecId = grp.id;
  await owner.db
    .insert(schema.gradeGroupMember)
    .values({ tenantId: b.tenantId, gradeGroupId: bandExecId, gradeId: gradeExec });

  subject = await hire('Subject', { gradeId: gradeExec });
  const manager = await hire('Manager');
  managerEmploymentId = manager.employmentId;
  await setReportingLine(ctx(), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  await setLeaveApprovalPolicy(ctx(), { companyId: b.companyId, enabled: true, levels: ['direct_manager', 'hr_admin'] });
});
afterAll(async () => {
  await closeAll();
});

describe('grade-group scoping', () => {
  it('a grade-group-scoped rule matches a requester whose grade is in that group', async () => {
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: bandExecId,
      levels: ['payroll'],
    });
    // subject's grade (Executive) belongs to Band Exec → the group rule wins over the company default.
    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['payroll']);
  });

  it('a requester whose grade is NOT in the group falls back to the company default', async () => {
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: bandExecId,
      levels: ['payroll'],
    });
    const other = await hire('OtherGrade', { gradeId: gradeMgr }); // gradeMgr is not a member of Band Exec
    await setReportingLine(ctx(), {
      subordinateEmploymentId: other.employmentId,
      managerEmploymentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const r = await request(other.employmentId);
    expect(await kindsFor(r.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);
  });

  it('an individual grade rule and a grade-group rule coexist (grade rule is more specific → wins)', async () => {
    // group rule (specificity 1)
    await createLeaveApprovalRule(ctx(), { companyId: b.companyId, gradeGroupId: bandExecId, levels: ['payroll'] });
    // individual-grade + group rule (specificity 2) — both dims match the subject, so it is more specific.
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeId: gradeExec,
      gradeGroupId: bandExecId,
      levels: ['hr_admin'],
    });
    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['hr_admin']);
  });

  it('round-trips gradeGroupId through create + list + update', async () => {
    const { id } = await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: bandExecId,
      levels: ['hr_admin'],
    });
    let rules = await listLeaveApprovalRules(ctx(), b.companyId);
    expect(rules.find((r) => r.id === id)!.gradeGroupId).toBe(bandExecId);

    // Clear the group but scope by individual grade instead (so the row is not the fully-wildcard default).
    await updateLeaveApprovalRule(ctx(), id, { companyId: b.companyId, gradeGroupId: null, gradeId: gradeExec, levels: ['payroll'] });
    rules = await listLeaveApprovalRules(ctx(), b.companyId);
    const updated = rules.find((r) => r.id === id)!;
    expect(updated.gradeGroupId).toBeNull();
    expect(updated.gradeId).toBe(gradeExec);
  });
});

describe('default workflow (template-driven rule)', () => {
  it('a rule with a templateId draws its chain from the template', async () => {
    const { id: templateId } = await createApprovalTemplate(ctx(), {
      name: 'Two-step default',
      levels: ['direct_manager', 'payroll'],
    });
    const { id: ruleId } = await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: bandExecId,
      templateId,
      levels: [], // ignored — template is the source of truth
    });
    // The rule stored no own levels; its effective chain comes from the template.
    const rules = await listLeaveApprovalRules(ctx(), b.companyId);
    const stored = rules.find((r) => r.id === ruleId)!;
    expect(stored.templateId).toBe(templateId);
    expect(stored.levels).toEqual([]);

    const r = await request();
    expect(await kindsFor(r.leaveRequestId)).toEqual(['direct_manager', 'payroll']);
  });

  it('rejects a rule that is neither template-driven nor carries its own levels', async () => {
    await expect(
      createLeaveApprovalRule(ctx(), { companyId: b.companyId, gradeGroupId: bandExecId, levels: [] }),
    ).rejects.toThrow();
  });
});

describe('leave-duration condition (min/max) still resolves', () => {
  it('a min-days rule matches only when the request is long enough', async () => {
    await createLeaveApprovalRule(ctx(), {
      companyId: b.companyId,
      gradeGroupId: bandExecId,
      minDays: 3,
      levels: ['payroll'],
    });
    // A 1-day request does not clear the 3-day floor → company default.
    const short = await request(subject.employmentId, { startDate: '2026-07-01', endDate: '2026-07-01' });
    expect(await kindsFor(short.leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);

    // A 3-day request (Jul 1–3, inclusive) clears the floor → the condition rule wins.
    const long = await request(subject.employmentId, { startDate: '2026-07-01', endDate: '2026-07-03' });
    expect(await kindsFor(long.leaveRequestId)).toEqual(['payroll']);
  });
});
