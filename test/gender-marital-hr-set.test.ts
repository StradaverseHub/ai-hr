/**
 * R4 Build #2 — HR/Admin sets gender + marital status on the employee profile so the ALREADY-BUILT
 * leave-eligibility engine (Wave 2A-1) has an admin-set source. Routed through
 * `setPersonComplianceFields` (the approval-gated apply path per ADR-0012 refinement #24), NOT the
 * instant-write `updatePerson`. No new eligibility engine, no migration — these tests pin:
 *  - HR-set applies to `person` + appends a `person.updated` event with `via:'admin-set'` + before/after
 *  - authorization: non-admin is rejected
 *  - invalid values normalise to null (no garbage persisted)
 *  - the HR-set value reaches the shipped engine (isLeaveEligible)
 *  - clearing gender re-hides Maternity (true→false) without mutating existing leave rows
 *  - the employee self-service path (requestProfileChange → decideProfileChange) is unchanged
 *  - setting marital status does NOT auto-change the PCB/tax bracket (a separate statutory field)
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  decideProfileChange,
  requestProfileChange,
  setPersonComplianceFields,
} from '../core/profile';
import { isLeaveEligible, requestLeave, type LeaveEligibility } from '../core/leave';
import { setStatutoryProfileMY, getStatutoryProfileMY } from '../localization/my/statutory';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';

let b: Base;

const MATERNITY_ELIG: LeaveEligibility = { gender: 'female' };
const AS_OF = '2026-07-01';

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

async function personRow(personId: string) {
  const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
  return p;
}

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

describe('R4 #2 — HR-set gender / marital status', () => {
  it('HR sets gender + marital via the approval-gated apply path; person row + audit event updated', async () => {
    const E = await hire('Setter');
    await setPersonComplianceFields(adminCtx(b), {
      employmentId: E.employmentId,
      gender: 'female',
      maritalStatus: 'married',
    });

    const p = await personRow(E.personId);
    expect(p.gender).toBe('female');
    expect(p.maritalStatus).toBe('married');

    // A `person.updated` event fires with provenance `via:'admin-set'` + before/after transitions.
    const payload = await latestEventPayload(b.tenantId, E.personId, 'person.updated');
    expect(payload).toMatchObject({
      via: 'admin-set',
      fields: expect.arrayContaining(['gender', 'maritalStatus']),
      before: { gender: null, maritalStatus: null },
      after: { gender: 'female', maritalStatus: 'married' },
    });
  });

  it('a non-admin session is rejected', async () => {
    const E = await hire('Guarded');
    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uid, personId: E.personId, roles: ['employee'] };
    await expect(
      setPersonComplianceFields(empCtx, { employmentId: E.employmentId, gender: 'male' }),
    ).rejects.toThrow(/admin/i);
    // nothing persisted
    expect((await personRow(E.personId)).gender).toBeNull();
  });

  it('an unrecognised value normalises to null (no garbage persisted, no throw)', async () => {
    const E = await hire('Garbage');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, gender: 'xyz' });
    expect((await personRow(E.personId)).gender).toBeNull();
  });

  it('nothing provided → throws "Nothing to change."', async () => {
    const E = await hire('Empty');
    await expect(setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId })).rejects.toThrow(
      /nothing to change/i,
    );
  });

  it('the HR-set value reaches the shipped eligibility engine (male → Maternity ineligible)', async () => {
    const E = await hire('Reacher');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, gender: 'male' });
    const p = await personRow(E.personId);
    expect(
      isLeaveEligible(MATERNITY_ELIG, { gender: p.gender, marital: p.maritalStatus, hiredOn: '2024-01-01' }, AS_OF),
    ).toBe(false);
  });

  it('clearing gender re-hides Maternity (true → false) without mutating existing leave rows', async () => {
    // A female maternity-eligible employee with an already-approved ANNUAL leave row.
    const E = await hire('Clearer');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, gender: 'female' });
    let p = await personRow(E.personId);
    expect(
      isLeaveEligible(MATERNITY_ELIG, { gender: p.gender, marital: p.maritalStatus, hiredOn: '2024-01-01' }, AS_OF),
    ).toBe(true);

    // A concrete leave request already exists (uses the base ANNUAL type — no eligibility gate on it).
    await requestLeave(adminCtx(b), {
      employmentId: E.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-10',
      endDate: '2026-07-10',
    });
    const before = await owner.db
      .select()
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, E.employmentId));
    expect(before.length).toBe(1);

    // Clear gender back to null.
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, gender: null });
    p = await personRow(E.personId);
    expect(p.gender).toBeNull();
    expect(
      isLeaveEligible(MATERNITY_ELIG, { gender: p.gender, marital: p.maritalStatus, hiredOn: '2024-01-01' }, AS_OF),
    ).toBe(false);

    // The gate only runs at request time — clearing does NOT retroactively touch the existing row.
    const after = await owner.db
      .select()
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, E.employmentId));
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].status).toBe(before[0].status);
  });

  it('the employee self-service path (requestProfileChange → decideProfileChange) is unchanged', async () => {
    const a = adminCtx(b);
    const E = await hire('SelfServe');
    const uid = await createAppUser(b.tenantId, E.personId, 'employee');
    // r261 — spread from adminCtx for the entitlement snapshot requestProfileChange now reads the
    // tenant's field-permission setting from; the principal below is still a plain employee.
    const emp: SessionContext = { ...a, userId: uid, personId: E.personId, roles: ['employee'] };

    const { requestId } = await requestProfileChange(emp, {
      employmentId: E.employmentId,
      proposed: { gender: 'female', maritalStatus: 'married' },
    });
    // Still approval-gated: nothing applies until an admin decides.
    expect((await personRow(E.personId)).gender).toBeNull();

    await decideProfileChange(a, { requestId, decision: 'approved' });
    const p = await personRow(E.personId);
    expect(p.gender).toBe('female');
    expect(p.maritalStatus).toBe('married');
  });

  it('setting marital status does NOT auto-change the PCB/tax bracket (separate statutory field)', async () => {
    const a = adminCtx(b);
    const E = await hire('TaxDecouple');
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101010001', taxCategory: 1 });

    await setPersonComplianceFields(a, { employmentId: E.employmentId, maritalStatus: 'married' });

    expect((await personRow(E.personId)).maritalStatus).toBe('married');
    // taxCategory untouched by the compliance-field write.
    expect((await getStatutoryProfileMY(a, E.personId))?.taxCategory).toBe(1);
  });
});
