/**
 * 18103ba4 — Step 4's automatic validation: `previewLeaveAdjustmentBatch`.
 *
 * The reporter's Review & Process step asks for validation to run automatically and to name the problems
 * before anything is processed — "3 employees have no Annual Leave entitlement · 2 employees are inactive ·
 * 1 employee does not match the selected criteria". This is the function that answers that, and it is a DRY
 * RUN of the write path rather than a second opinion about it: it shares `resolveAdjustmentTargets` and
 * `frozenAdjustmentKeys` with `applyLeaveAdjustmentBatch`, so "48 records, 2 skipped" describes the write
 * that will actually happen.
 *
 * WHAT THESE TESTS ARE REALLY FOR: a review that lies is worse than no review. Each case below is a way for
 * the summary and the write to disagree —
 *   • a count that includes people the write will silently drop (an unrecognised id),
 *   • a count taken as of TODAY while the write resolves as of the EFFECTIVE DATE,
 *   • a "nothing to flag" over a set that will half-fail (a frozen encashment balance),
 *   • an eligibility judgement made against today's rules for a backdated grant.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { applyLeaveAdjustmentBatch, previewLeaveAdjustmentBatch } from '../core/leave-adjustment';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

async function hire(name: string, hiredOn = '2020-01-01'): Promise<string> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `prev_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return e.employmentId;
}

async function makeType(code: string, eligibility?: unknown): Promise<string> {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: `${code} Leave`,
      paid: true,
      ...(eligibility ? { eligibility: eligibility as never } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return lt.id;
}

const preview = (p: Parameters<typeof previewLeaveAdjustmentBatch>[1]) => previewLeaveAdjustmentBatch(adminCtx(b), p);
const kinds = (issues: { kind: string }[]) => issues.map((i) => i.kind).sort();

describe('18103ba4 · the counts describe the write that will happen', () => {
  it('targets employees × leave types, and says so', async () => {
    const a = await hire('A');
    const c = await hire('C');
    const t1 = await makeType('T1');
    const t2 = await makeType('T2');
    const got = await preview({
      leaveTypeIds: [t1, t2],
      effectiveOn: '2026-06-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(got.employees).toBe(2);
    expect(got.targeted).toBe(4);
    expect(got.willWrite).toBe(4);
    expect(got.issues).toEqual([]);
    // …and that is exactly what the WRITE then reports, which is the whole contract of a dry run.
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t1, t2],
      days: 1,
      effectiveOn: '2026-06-01',
      reason: 'preview parity',
      targetMode: 'criteria',
      criteria: {},
    });
    expect([res.targeted, res.written]).toEqual([got.targeted, got.willWrite]);
    expect([a, c].length).toBe(2);
  });

  it('a bad effective date answers nothing rather than guessing', async () => {
    await hire('A');
    expect(await preview({ leaveTypeIds: [], effectiveOn: '', targetMode: 'criteria', criteria: {} })).toEqual({
      employees: 0,
      targeted: 0,
      willWrite: 0,
      issues: [],
    });
  });
});

describe('18103ba4 · the issues, and which mode each belongs to', () => {
  it('INDIVIDUAL: an unrecognised employment reference is reported, not silently dropped', async () => {
    // applyLeaveAdjustmentBatch filters unknown ids out through RLS without a word. The operator PASTED
    // them; being told they went nowhere is the difference between a batch of 9 and a batch of 10.
    const a = await hire('A');
    const t1 = await makeType('T1');
    const got = await preview({
      leaveTypeIds: [t1],
      effectiveOn: '2026-06-01',
      targetMode: 'individual',
      employmentIds: [a, '00000000-0000-0000-0000-000000000001'],
    });
    expect(got.employees).toBe(1);
    expect(got.issues).toEqual([{ kind: 'not_found', count: 1 }]);
  });

  it('INDIVIDUAL: someone not employed on the effective date is flagged — and still adjusted', async () => {
    // Pre-existing behaviour this item deliberately does NOT change: individual mode takes the ids
    // verbatim. Which is precisely why it has to be said out loud on the review.
    const leaver = await hire('Leaver');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-01-31' })
      .where(eq(schema.employment.id, leaver));
    const t1 = await makeType('T1');
    const got = await preview({
      leaveTypeIds: [t1],
      effectiveOn: '2026-06-01',
      targetMode: 'individual',
      employmentIds: [leaver],
    });
    expect(got.issues).toEqual([{ kind: 'inactive', count: 1 }]);
    expect(got.targeted).toBe(1);
  });

  it('CRITERIA: never reports inactive or not_found, because the resolver already excluded them', async () => {
    // Reporting "0 inactive" on every criteria batch is noise, and noise is what stops people reading a
    // validation summary at all.
    const leaver = await hire('Leaver');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-01-31' })
      .where(eq(schema.employment.id, leaver));
    await hire('Active');
    const t1 = await makeType('T1');
    const got = await preview({
      leaveTypeIds: [t1],
      effectiveOn: '2026-06-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(got.employees).toBe(1);
    expect(kinds(got.issues)).not.toContain('inactive');
    expect(kinds(got.issues)).not.toContain('not_found');
  });

  it('flags employees who do not QUALIFY for a chosen leave type, per type', async () => {
    // The honest reading of the mock's "3 employees have no Annual Leave entitlement": the ledger would
    // take the row, but the employee cannot take that leave, so the days go somewhere unspendable.
    const her = await hire('Her');
    const him = await hire('Him');
    for (const [emp, gender] of [
      [her, 'female'],
      [him, 'male'],
    ] as const) {
      const [row] = await owner.db
        .select({ personId: schema.employment.personId })
        .from(schema.employment)
        .where(eq(schema.employment.id, emp));
      await owner.db.update(schema.person).set({ gender }).where(eq(schema.person.id, row.personId));
    }
    const maternity = await makeType('MAT', { gender: ['female'] });
    const open = await makeType('OPEN');

    const got = await preview({
      leaveTypeIds: [maternity, open],
      effectiveOn: '2026-06-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(got.employees).toBe(2);
    // Exactly one issue, naming the type it belongs to — the open type contributes none.
    expect(got.issues).toEqual([{ kind: 'not_eligible', count: 1, leaveTypeName: 'MAT Leave' }]);
  });

  it('ELIGIBILITY IS JUDGED AS AT THE EFFECTIVE DATE, not today', async () => {
    // A grant backdated to before somebody had served long enough must judge them by where they stood
    // THEN — the same as-of discipline the target resolution follows. Judging it as of "now" makes the
    // review disagree with the effective date the operator chose.
    const newish = await hire('Newish', '2026-01-01');
    const service = await makeType('SVC', { minServiceMonths: 6 });

    const early = await preview({
      leaveTypeIds: [service],
      effectiveOn: '2026-03-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(early.issues).toEqual([{ kind: 'not_eligible', count: 1, leaveTypeName: 'SVC Leave' }]);

    const later = await preview({
      leaveTypeIds: [service],
      effectiveOn: '2026-09-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(later.issues).toEqual([]);
    expect(newish).toBeTruthy();
  });

  it('predicts the FROZEN skip, so targeted vs written is known before the button rather than after', async () => {
    // ADR-0069: a frozen encashment snapshot makes that (employment, type) balance immutable and the write
    // path SKIPS it. The gap between targeted and written is the number that makes a bulk write
    // trustworthy — discovering it in the toast afterwards is too late to decide anything.
    const emp = await hire('Frozen');
    const t1 = await makeType('T1');
    const [p] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, emp));
    const [req] = await owner.db
      .insert(schema.resignationRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: emp,
        personId: p.personId,
        lastWorkingDay: '2026-12-31',
        // 'accepted' is this enum's approved state; the snapshot only needs a parent row to hang off.
        status: 'accepted',
      })
      .returning({ id: schema.resignationRequest.id });
    await owner.db.insert(schema.leaveEncashmentSnapshot).values({
      tenantId: b.tenantId,
      employmentId: emp,
      resignationRequestId: req.id,
      leaveTypeId: t1,
      balanceDays: '5.00',
      encashableDays: '5.00',
      calculatedAsOf: '2026-06-01',
      status: 'frozen',
    });

    const got = await preview({
      leaveTypeIds: [t1],
      effectiveOn: '2026-06-01',
      targetMode: 'criteria',
      criteria: {},
    });
    expect(got.targeted).toBe(1);
    expect(got.willWrite).toBe(0);
    expect(got.issues).toEqual([{ kind: 'frozen', count: 1, leaveTypeName: 'T1 Leave' }]);

    // …and the WRITE agrees, which is the property that makes this a dry run rather than a second opinion.
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t1],
      days: 1,
      effectiveOn: '2026-06-01',
      reason: 'frozen parity',
      targetMode: 'criteria',
      criteria: {},
    });
    expect([res.targeted, res.written]).toEqual([got.targeted, got.willWrite]);
  });
});
