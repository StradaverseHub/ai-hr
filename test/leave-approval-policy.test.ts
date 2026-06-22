/**
 * ADR-0039 2B-2 — configurable approval policy. The approval chain is data: a per-company `levels` list
 * (optionally per leave-type) drives generateApprovalSteps. setLeaveApprovalPolicy edits the company
 * default and toggles the on/off gate; resolution prefers a leave-type-specific policy, then the company
 * default, then the built-in fallback. The chain shape (order + count) flows straight into the steps a
 * request generates — the 2B-1 state machine is unchanged.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import { getLeaveApprovalPolicy, setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pol_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
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
const request = () =>
  requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  const manager = await hire('Manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0039 2B-2 — configurable approval policy', () => {
  it('a configured chain drives the generated steps and turns the gate on', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels: ['hr_admin'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['hr_admin']); // HR-only, not the 2B-1 default
    const [co] = await owner.db
      .select({ on: schema.company.leaveMultiApproval })
      .from(schema.company)
      .where(eq(schema.company.id, b.companyId));
    expect(co.on).toBe(true);
  });

  it('honors the configured order (HR before manager)', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels: ['hr_admin', 'direct_manager'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['hr_admin', 'direct_manager']);
  });

  it('a leave-type-specific policy overrides the company default', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels: ['hr_admin'] });
    // Type-specific override for annual leave (the editor will do this later; insert directly here).
    await owner.db.insert(schema.leaveApprovalPolicy).values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      leaveTypeId: b.annualLeaveTypeId,
      levels: ['direct_manager', 'hr_admin'],
    });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual(['direct_manager', 'hr_admin']);
  });

  it('disabling the policy reverts to single-step', async () => {
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: false, levels: ['hr_admin'] });
    const { leaveRequestId } = await request();
    expect(await kindsFor(leaveRequestId)).toEqual([]);
  });

  it('rejects an enabled chain with no levels, and getLeaveApprovalPolicy returns the saved chain', async () => {
    await expect(
      setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels: [] }),
    ).rejects.toThrow();
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels: ['direct_manager', 'hr_admin'] });
    expect(await getLeaveApprovalPolicy(adminCtx(b), b.companyId)).toEqual({
      enabled: true,
      levels: ['direct_manager', 'hr_admin'],
    });
    // Sanity: only one company-default row exists (upsert, not duplicate insert).
    const defaults = await owner.db
      .select({ id: schema.leaveApprovalPolicy.id })
      .from(schema.leaveApprovalPolicy)
      .where(and(eq(schema.leaveApprovalPolicy.companyId, b.companyId), isNull(schema.leaveApprovalPolicy.leaveTypeId)));
    expect(defaults).toHaveLength(1);
  });
});
