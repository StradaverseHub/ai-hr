/** 467664c3: app-role activation is one atomic, scoped transition, including late owner failures. */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { addDependent, assertDependentsValid, DependentValidationError, type DependentInput } from '../core/dependents';
import * as schema from '../db/schema';
import type { EmployeeDraftData } from '../lib/employee-draft-schema';
import {
  completeEmployeeDraft, createEmployeeDraftWithReservedCode, draftActivationValidation,
  DraftActivationValidationError, saveEmployeeDraft,
} from '../core/employee-draft';
import { createConfig } from '../core/employee-id-config';
import { hireEmployee } from '../core/org';
import { setLabelGlobal } from '../core/system-labels';
import { createPolicy } from '../packs/payroll/service';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); b = await seedBase(); });
afterAll(closeAll);

function input(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: { fullName: 'Atomic Activation', primaryEmail: `activation.${randomUUID()}@demo.test`,
      preferredName: 'Atomic', gender: 'female', dateOfBirth: '1990-04-05',
      phone: '00123456789', permanentPostcode: '00120' },
    employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-03-01' },
    statutory: { bankName: 'Test Bank', bankAccountNo: '0000123456', subjectToHrdf: 'no', childReliefMode: 'auto' },
    payroll: { basicSalary: '3000', paymentMethod: 'bank_transfer' },
    family: [
      { fullName: 'First Child', relationship: 'child', dateOfBirth: '2018-03-04', childTaxRelief: true, childReliefCategory: 'under_18', childReliefPercentage: '100' },
      { fullName: 'Second Child', relationship: 'child', dateOfBirth: '2020-05-06', childTaxRelief: true, childReliefCategory: 'under_18', childReliefPercentage: '100' },
    ],
    ...over,
  };
}
async function held(data = input()) {
  const ctx = adminCtx(b);
  await createConfig(ctx, { companyId: b.companyId, prefix: 'ACT', startNumber: 7, numberLength: 5, increment: 1, allowManualOverride: true });
  const created = await createEmployeeDraftWithReservedCode(ctx, {
    companyId: b.companyId, fullName: data.profile!.fullName!, primaryEmail: data.profile!.primaryEmail!,
  });
  await saveEmployeeDraft(ctx, { id: created.id, data, currentStep: 6 });
  return { ctx, ...created };
}
/** Include existing data, every activation table and audit, not merely the new employment count. */
async function state() {
  const tables = ['person', 'employment', 'assignment', 'reporting_line', 'employee_statutory_my',
    'employment_tax_selection_my', 'compensation', 'employee_dependent', 'leave_ledger',
    'employee_draft', 'employee_id_config', 'tenant_counter', 'domain_event',
    'performance_assessment_reminder_epoch'] as const;
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const [row] = await owner.client.unsafe<{ rows: unknown }[]>(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as rows from ${table} t where tenant_id=$1`, [b.tenantId]);
    result[table] = row.rows;
  }
  return result;
}
/** Test-owned database faults reach the real app-role owner path; no production table is targeted. */
async function withFailure(table: string, condition: string, run: () => Promise<void>) {
  const allowed = new Set(['person', 'employee_dependent', 'employee_statutory_my', 'domain_event']);
  if (!allowed.has(table)) throw new Error('Unrecognized fixture table');
  await owner.client.unsafe(`create function public.board15_activation_fail() returns trigger language plpgsql as $$begin if ${condition} then raise exception 'private fixture failure: bank 0000123456' using errcode='23514'; end if; return new; end$$`);
  try {
    await owner.client.unsafe(`create trigger board15_activation_fail before insert or update on ${table} for each row execute function public.board15_activation_fail()`);
    await run();
  } finally {
    await owner.client.unsafe(`drop trigger if exists board15_activation_fail on ${table}`);
    await owner.client.unsafe('drop function if exists public.board15_activation_fail()');
  }
}
async function rejectedWithoutChanges(ctx: SessionContext, id: string, code?: string) {
  const before = await state();
  let failure: unknown;
  try { await completeEmployeeDraft(ctx, id); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  if (code) expect(draftActivationValidation(failure)?.code).toBe(code);
  else expect(draftActivationValidation(failure)).toBeNull();
  expect(await state()).toEqual(before);
  return failure;
}

describe('atomic Draft activation', () => {
  it.each([
    ['employee_dependent', "new.full_name='Second Child'", 'after the first Family member'],
    ['domain_event', "new.event_type='employee-draft.completed'", 'after Draft deletion and every owner write'],
    ['person', "new.gender='female'", 'in the compliance writer previously swallowed'],
    ['employee_statutory_my', "tg_op='UPDATE' and new.num_children>0", 'in Family derived-tax synchronization'],
  ])('rolls back %s failure %s (%s), preserving the exact Draft/reservation and all prior facts', async (table, condition) => {
    const { ctx, id } = await held();
    await hireEmployee(ctx, { person: { fullName: 'Existing Employee', primaryEmail: 'existing.activation@demo.test' },
      employeeCode: 'EXISTING-001', companyId: b.companyId, departmentId: b.deptB, employmentType: 'full_time', hiredOn: '2026-02-01' });
    await withFailure(table, condition, async () => { await rejectedWithoutChanges(ctx, id); });
    // Removing the injected fault permits the SAME Draft and held ID to complete.
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(emp.employeeCode).toBe('ACT00007');
  });

  it('commits all owner facts, consumes the held ID once, and records completion only once', async () => {
    const { ctx, id, employeeCode } = await held();
    const [beforeConfig] = await owner.db.select().from(schema.employeeIdConfig).where(eq(schema.employeeIdConfig.tenantId, b.tenantId)).orderBy(asc(schema.employeeIdConfig.id));
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(emp.employeeCode).toBe(employeeCode);
    expect(emp.paymentMethod).toBe('bank_transfer');
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, emp.personId));
    expect(p).toMatchObject({ preferredName: 'Atomic', gender: 'female', dateOfBirth: '1990-04-05', phone: '00123456789', permanentPostcode: '00120' });
    const [s] = await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(s).toMatchObject({ bankAccountNo: '0000123456', subjectToHrdf: false, numChildren: 2 });
    const family = await owner.db.select().from(schema.employeeDependent).where(eq(schema.employeeDependent.personId, emp.personId)).orderBy(asc(schema.employeeDependent.fullName));
    expect(family.map(member => member.fullName)).toEqual(['First Child', 'Second Child']);
    expect(await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, employmentId))).toHaveLength(1);
    expect(await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id))).toHaveLength(0);
    const [afterConfig] = await owner.db.select().from(schema.employeeIdConfig).where(eq(schema.employeeIdConfig.id, beforeConfig.id));
    expect(afterConfig.currentRunningNumber).toBe(beforeConfig.currentRunningNumber);
    const events = await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId, id), eq(schema.domainEvent.eventType, 'employee-draft.completed'))).orderBy(asc(schema.domainEvent.id));
    expect(events).toHaveLength(1);
    expect(events[0].subjectEmploymentId).toBe(employmentId);
    await rejectedWithoutChanges(ctx, id, 'draft_unavailable');
  });

  it('serializes two Activate attempts and refuses the second without a second hire', async () => {
    const { ctx, id } = await held();
    const attempts = await Promise.allSettled([completeEmployeeDraft(ctx, id), completeEmployeeDraft(ctx, id)]);
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
    const failed = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(draftActivationValidation(failed[0].reason)?.code).toBe('draft_unavailable');
    const [counts] = await owner.db.select({ count: sql<number>`count(*)::int` }).from(schema.employment).where(eq(schema.employment.employeeCode, 'ACT00007'));
    expect(counts.count).toBe(1);
    await rejectedWithoutChanges(ctx, id, 'draft_unavailable');
  });

  it('keeps optional groups blank and uses the existing explicit zero-salary rule', async () => {
    const data = input({ statutory: {}, family: [], payroll: { basicSalary: '', remarks: 'Quarterly director fees' } });
    const { ctx, id } = await held(data);
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, emp.personId))).toHaveLength(0);
    const [comp] = await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId, employmentId));
    expect(Number(comp.basicSalary)).toBe(0);
    expect(comp.remarks).toBe('Quarterly director fees');
  });

  it.each([
    ['employmentType', 'not-an-employment-type', 'invalid_data', 'job', 'employmentType'],
    ['payMode', 'not-a-pay-mode', 'payroll_invalid', 'payroll', 'payMode'],
    ['paymentTerm', 'not-a-term', 'payroll_invalid', 'payroll', 'paymentTerm'],
    ['monthlyAllowance', 'not-an-amount', 'payroll_invalid', 'payroll', 'monthlyAllowance'],
    ['rateAmount', 'not-an-amount', 'payroll_invalid', 'payroll', 'rateAmount'],
  ])('returns a safe field pointer for invalid persisted %s and rolls back owner writes', async (field, value, code, tab, pointer) => {
    const data = input();
    if (field === 'employmentType') data.employment!.employmentType = value;
    else data.payroll = { ...data.payroll, [field]: value };
    const { ctx, id } = await held(data);
    const error = await rejectedWithoutChanges(ctx, id, code);
    expect(draftActivationValidation(error)?.fields).toEqual([{ tab, field: pointer }]);
  });

  it.each([
    ['fullName', '', 'child', 'familyMemberName'],
    ['relationship', 'not-a-relationship', 'child', 'familyMemberRelationship'],
    ['gender', 'not-a-gender', 'child', 'gender'],
    ['marriageStatus', 'not-a-marriage-status', 'spouse', 'marriageStatus'],
    ['childReliefCategory', 'not-a-category', 'child', 'childReliefCategory'],
    ['childReliefPercentage', 75, 'child', 'childReliefPercentage'],
  ] as const)('preserves canonical %s refusal metadata through Family preflight and safe Draft projection', async (field, value, relationship, pointer) => {
    const ctx = adminCtx(b);
    const existing = await hireEmployee(ctx, { person: { fullName: 'Existing Family Owner', primaryEmail: 'family.owner@demo.test' },
      employeeCode: 'FAMILY-OWNER', companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-02-01' });
    const member: DependentInput = { fullName: 'Private Family Name', relationship, dateOfBirth: '2018-03-04', [field]: value };
    const before = await state();
    for (const attempt of [
      () => addDependent(ctx, { personId: existing.personId, ...member }),
      () => withTenant(ctx, tx => assertDependentsValid(ctx, [member], tx)),
      () => assertDependentsValid(ctx, [member]),
    ]) {
      let failure: unknown;
      try { await attempt(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(DependentValidationError);
      expect((failure as DependentValidationError).field).toBe(field);
      expect(draftActivationValidation(failure)).toEqual({ code: 'family_invalid', fields: [{ tab: 'family', field: pointer }] });
      expect(JSON.stringify(draftActivationValidation(failure))).not.toContain('Private Family Name');
      expect(await state()).toEqual(before);
    }
    // The persisted wizard values use a string share. Activate must retain the same field, too;
    // a blank name is caught earlier by the existing required-field check rather than the owner.
    const data = input({ family: [{ fullName: 'Private Family Name', relationship, dateOfBirth: '2018-03-04', [field]: String(value) }] });
    const { id } = await held(data);
    const failure = await rejectedWithoutChanges(ctx, id, field === 'fullName' ? 'required_fields' : 'family_invalid');
    expect(draftActivationValidation(failure)?.fields).toEqual([{ tab: 'family', field: pointer }]);
  });

  it('revalidates missing required values and provides finite tab/field pointers', async () => {
    const data = input(); data.employment!.departmentId = '';
    const { ctx, id } = await held(data);
    const failure = await rejectedWithoutChanges(ctx, id, 'required_fields');
    expect(draftActivationValidation(failure)?.fields).toContainEqual({ tab: 'job', field: 'department' });
  });

  it.each([
    ['section', { payroll: 'not-an-object' }],
    ['cell', { profile: { fullName: ['private'] } }],
    ['family', { family: { fullName: 'would previously disappear' } }],
    ['member', { family: [null] }],
    ['checkbox', { family: [{ fullName: 'Child', relationship: 'child', childTaxRelief: 'yes' }] }],
  ])('refuses malformed persisted %s input before creating any employee', async (_name, malformed) => {
    const { ctx, id } = await held();
    const [draft] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id));
    await owner.db.update(schema.employeeDraft).set({ data: { ...draft.data, ...malformed } as EmployeeDraftData }).where(eq(schema.employeeDraft.id, id));
    await rejectedWithoutChanges(ctx, id, 'invalid_data');
  });

  it('refuses a deleted Department selected before activation', async () => {
    const [dept] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: b.companyId, name: 'Temporary Department' }).returning();
    const data = input(); data.employment!.departmentId = dept.id;
    const { ctx, id } = await held(data);
    await owner.db.delete(schema.department).where(eq(schema.department.id, dept.id));
    const failure = await rejectedWithoutChanges(ctx, id, 'reference_invalid');
    expect(draftActivationValidation(failure)?.fields).toEqual([{ tab: 'job', field: 'department' }]);
  });

  it('refuses a selected Department moved outside the company eligibility rule', async () => {
    const { ctx, id } = await held();
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Company' }).returning();
    await owner.db.update(schema.department).set({ companyId: other.id }).where(eq(schema.department.id, b.deptA));
    await rejectedWithoutChanges(ctx, id, 'reference_invalid');
  });

  it('retains canonical global-label eligibility instead of imposing a same-origin-company rule', async () => {
    const ctx = adminCtx(b);
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Label Origin' }).returning();
    const [dept] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: other.id, name: 'Shared Hiring Department' }).returning();
    await setLabelGlobal(ctx, { kind: 'department', labelId: dept.id, isGlobal: true });
    const data = input(); data.employment!.departmentId = dept.id;
    const { id } = await held(data);
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const [assignment] = await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)).orderBy(asc(schema.assignment.id));
    expect(assignment.departmentId).toBe(dept.id);
  });

  it('refuses a newly archived Company and preserves its held number', async () => {
    const { ctx, id } = await held();
    await owner.db.update(schema.company).set({ archivedAt: new Date() }).where(eq(schema.company.id, b.companyId));
    await rejectedWithoutChanges(ctx, id, 'company_unavailable');
  });

  it('refuses a changed company in a hand-edited Draft instead of moving the reservation', async () => {
    const { ctx, id } = await held();
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Other Company' }).returning();
    const [draft] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id));
    await owner.db.update(schema.employeeDraft).set({ data: { ...draft.data, employment: { ...draft.data.employment, companyId: other.id } } }).where(eq(schema.employeeDraft.id, id));
    await rejectedWithoutChanges(ctx, id, 'company_changed');
  });

  it('refuses a Payroll policy deactivated since the Draft was saved, using its typed owner error', async () => {
    const { ctx, id } = await held();
    const { id: policyId } = await createPolicy(ctx, { companyId: b.companyId, name: 'Selected Monthly', policyType: 'monthly' });
    const [draft] = await owner.db.select().from(schema.employeeDraft).where(eq(schema.employeeDraft.id, id));
    await saveEmployeeDraft(ctx, { id, data: { ...draft.data, payroll: { ...draft.data.payroll, payrollPolicyId: policyId } }, currentStep: 4 });
    await owner.db.update(schema.payrollPolicy).set({ status: 'draft' }).where(eq(schema.payrollPolicy.id, policyId));
    const error = await rejectedWithoutChanges(ctx, id, 'payroll_invalid');
    expect(error).toMatchObject({ reason: 'policy_inactive' });
    expect(draftActivationValidation(error)?.fields).toEqual([{ tab: 'payroll', field: 'payrollPolicyId' }]);
  });

  it.each(['departmentId', 'positionId', 'costCenterId', 'gradeId', 'reportingManagerEmploymentId'] as const)('refuses a missing %s before hire', async field => {
    const data = input(); data.employment![field] = randomUUID();
    const { ctx, id } = await held(data);
    await rejectedWithoutChanges(ctx, id, 'reference_invalid');
  });

  it('refuses an actual other-tenant Department stored on the Draft without revealing its record', async () => {
    const foreign = await seedBase();
    const data = input(); data.employment!.departmentId = foreign.deptA;
    const { ctx, id } = await held(data);
    const error = await rejectedWithoutChanges(ctx, id, 'reference_invalid');
    expect(JSON.stringify(draftActivationValidation(error))).not.toContain(foreign.deptA);
  });

  it('refuses employee/manager, other-company HR and another tenant without changing any activation fact', async () => {
    const { ctx, id } = await held();
    for (const role of ['employee', 'manager']) await rejectedWithoutChanges({ ...ctx, roles: [role] }, id, 'permission');
    const [other] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Scope Other' }).returning();
    const [user] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `activation-scoped-${randomUUID()}` }).returning();
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: user.id, companyId: other.id, role: 'hr_admin' });
    await rejectedWithoutChanges({ ...ctx, userId: user.id, grants: [{ role: 'hr_admin', companyId: other.id }] }, id, 'draft_unavailable');
    const foreign = await seedBase();
    await rejectedWithoutChanges(adminCtx(foreign), id, 'draft_unavailable');
  });

  it('permits HR scoped to the exact Draft company with canonical owner writes', async () => {
    const { ctx, id } = await held();
    const [user] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `activation-owner-${randomUUID()}` }).returning();
    await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: user.id, companyId: b.companyId, role: 'hr_admin' });
    const result = await completeEmployeeDraft({ ...ctx, userId: user.id, grants: [{ role: 'hr_admin', companyId: b.companyId }] }, id);
    expect(result.employmentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
