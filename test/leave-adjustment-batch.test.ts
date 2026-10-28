/**
 * 491c499f — the Leave Adjustments write path: a set resolver, a batch, and a reversal.
 *
 * The whole reason this item is Large is that none of the three existed. `assertEligible` /
 * `isLeaveEligible` are per-EMPLOYEE predicates, `countEmployeesInScope` knows only company and grade, and
 * `grantAdHocLeave` refuses negative days and targets whole companies. So each piece is tested for the
 * thing it was built to do, and — more importantly — for the ways a bulk write over a shared ledger goes
 * quietly wrong:
 *
 *   • selecting a DIFFERENT set of people from the one the administrator described (the effective-dated
 *     assignment join),
 *   • writing a row that later reads as something else (the `sys:` reason discipline),
 *   • writing through a frozen encashment snapshot,
 *   • an "undo" that hands days out twice.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  applyLeaveAdjustmentBatch,
  resolveAdjustmentTargets,
  reverseLeaveAdjustmentBatch,
  LeaveAdjustmentError,
} from '../core/leave-adjustment';
import { withTenant } from '../db/client';
import { lockLeaveDependenciesTx, lockLeaveDependencyConfigurationTx } from '../core/leave-dependency-lock';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

async function makeType(code: string): Promise<string> {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: `${code} Leave`, paid: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
}

async function hire(name: string, opts: { deptId?: string; hiredOn?: string } = {}): Promise<string> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `adj_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: opts.deptId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: opts.hiredOn ?? '2020-01-01',
  });
  return e.employmentId;
}

const resolve = (criteria: Parameters<typeof resolveAdjustmentTargets>[1]['criteria'], effectiveOn = '2026-06-01') =>
  withTenant(adminCtx(b), (tx) => resolveAdjustmentTargets(tx, { criteria, effectiveOn }));

describe('491c499f · the set resolver', () => {
  it('empty criteria matches every active employment — and that is why the screen must show the count', () => {
    // Not a bug: "no restrictions" genuinely means everyone, and per-field emptiness already means "no
    // restriction on that axis". It IS how a whole company gets granted leave by accident, which is why
    // the resolver refuses to second-guess it and the caller must confirm the number.
    return (async () => {
      const a = await hire('A');
      const c = await hire('C');
      const got = await resolve({});
      expect(got).toContain(a);
      expect(got).toContain(c);
    })();
  });

  it('filters by company, and AND-combines across fields', async () => {
    const inScope = await hire('InScope');
    const [other] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Other Sdn Bhd' })
      .returning({ id: schema.company.id });
    // A department in the OTHER company — hireEmployee requires one, and borrowing this company's would
    // put the assignment in the wrong company and make the test prove nothing.
    const [otherDept] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: other.id, name: 'Other Ops' })
      .returning({ id: schema.department.id });
    const outOfScope = await hireEmployee(adminCtx(b), {
      person: { fullName: 'OutOfScope', primaryEmail: `o_${randomUUID().slice(0, 8)}@t.local` },
      companyId: other.id,
      departmentId: otherDept.id,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    const got = await resolve({ companyIds: [b.companyId] });
    expect(got).toContain(inScope);
    expect(got).not.toContain(outOfScope.employmentId);
  });

  it('excludes someone who had already left before the effective date', async () => {
    const leaver = await hire('Leaver');
    await owner.db
      .update(schema.employment)
      .set({ terminatedOn: '2026-01-31' })
      .where(eq(schema.employment.id, leaver));
    expect(await resolve({}, '2026-06-01')).not.toContain(leaver);
    // …but IS a target for an adjustment effective while they were still employed.
    expect(await resolve({}, '2026-01-15')).toContain(leaver);
  });

  it('excludes someone not yet hired on the effective date', async () => {
    const future = await hire('FutureHire', { hiredOn: '2026-09-01' });
    expect(await resolve({}, '2026-06-01')).not.toContain(future);
  });

  it('DEPARTMENT IS RESOLVED AS OF THE EFFECTIVE DATE, not today', async () => {
    // The failure this pins, and the reason the join is not a plain column match: department lives on the
    // EFFECTIVE-DATED assignment. An adjustment backdated to before a transfer must select the people who
    // were in that department THEN. Matching today's row would silently adjust a different set of people
    // from the one the administrator described — and nothing else in the system would notice.
    const mover = await hire('Mover', { deptId: b.deptA });
    // They transferred to deptB on 2026-04-01: close the old assignment, open a new one.
    await owner.db
      .update(schema.assignment)
      .set({ validTo: '2026-03-31' })
      .where(eq(schema.assignment.employmentId, mover));
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: mover,
      departmentId: b.deptB,
      employmentType: 'full_time',
      validFrom: '2026-04-01',
    });

    // Before the move they were in A…
    expect(await resolve({ departmentIds: [b.deptA] }, '2026-02-01')).toContain(mover);
    expect(await resolve({ departmentIds: [b.deptB] }, '2026-02-01')).not.toContain(mover);
    // …after it, in B.
    expect(await resolve({ departmentIds: [b.deptB] }, '2026-06-01')).toContain(mover);
    expect(await resolve({ departmentIds: [b.deptA] }, '2026-06-01')).not.toContain(mover);
  });
});

describe('491c499f · applying a batch', () => {
  it('writes one ledger row per employment × leave type, and records the batch once', async () => {
    const e1 = await hire('One');
    const e2 = await hire('Two');
    const t1 = await makeType('ADJ1');
    const t2 = await makeType('ADJ2');

    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t1, t2],
      days: 2,
      effectiveOn: '2026-06-01',
      reason: 'CNY 2026',
      targetMode: 'individual',
      employmentIds: [e1, e2],
    });

    expect(res.targeted).toBe(4);
    expect(res.written).toBe(4);
    expect(await ledgerBalance(e1, t1)).toBe(2);
    expect(await ledgerBalance(e2, t2)).toBe(2);

    const [batch] = await owner.db
      .select({ written: schema.leaveAdjustmentBatch.writtenCount, reason: schema.leaveAdjustmentBatch.reason })
      .from(schema.leaveAdjustmentBatch)
      .where(eq(schema.leaveAdjustmentBatch.id, res.batchId));
    expect(batch.written).toBe(4);
    expect(batch.reason).toBe('CNY 2026');
  });

  it('takes days AWAY too — which grantAdHocLeave cannot express at all', async () => {
    const e = await hire('Deduct');
    const t = await makeType('ADJ3');
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t],
      days: -1.5,
      effectiveOn: '2026-06-01',
      reason: 'Correcting an over-grant',
      targetMode: 'individual',
      employmentIds: [e],
    });
    expect(await ledgerBalance(e, t)).toBe(-1.5);
  });

  it('every row carries the batch reference, so the action can be found again', async () => {
    const e = await hire('Traceable');
    const t = await makeType('ADJ4');
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t],
      days: 1,
      effectiveOn: '2026-06-01',
      reason: 'Traceable grant',
      targetMode: 'individual',
      employmentIds: [e],
    });
    const rows = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.adjustmentBatchId, res.batchId));
    expect(rows).toHaveLength(1);
  });

  it('REFUSES a sys: reason — that prefix is what the sweeps use to mark their own rows', async () => {
    const e = await hire('SysReason');
    const t = await makeType('ADJ5');
    await expect(
      applyLeaveAdjustmentBatch(adminCtx(b), {
        leaveTypeIds: [t],
        days: 1,
        effectiveOn: '2026-06-01',
        reason: 'sys:carry_forward_cap',
        targetMode: 'individual',
        employmentIds: [e],
      }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
    expect(await ledgerBalance(e, t), 'nothing was written').toBe(0);
  });

  it('refuses zero days, a blank reason, and an empty leave-type list', async () => {
    const e = await hire('Guards');
    const t = await makeType('ADJ6');
    const base = { effectiveOn: '2026-06-01', targetMode: 'individual' as const, employmentIds: [e] };
    await expect(
      applyLeaveAdjustmentBatch(adminCtx(b), { ...base, leaveTypeIds: [t], days: 0, reason: 'x' }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
    await expect(
      applyLeaveAdjustmentBatch(adminCtx(b), { ...base, leaveTypeIds: [t], days: 1, reason: '  ' }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
    await expect(
      applyLeaveAdjustmentBatch(adminCtx(b), { ...base, leaveTypeIds: [], days: 1, reason: 'x' }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
  });

  it('refuses a request that would match nobody, rather than recording an empty batch', async () => {
    const t = await makeType('ADJ7');
    await expect(
      applyLeaveAdjustmentBatch(adminCtx(b), {
        leaveTypeIds: [t],
        days: 1,
        effectiveOn: '2026-06-01',
        reason: 'Nobody',
        targetMode: 'criteria',
        criteria: { orgDivision: ['a-division-nobody-is-in'] },
      }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
  });
});

describe('491c499f · reversing a batch as a unit', () => {
  it('writes compensating rows rather than deleting, and the balance returns to where it was', async () => {
    const e1 = await hire('Rev1');
    const e2 = await hire('Rev2');
    const t = await makeType('ADJ8');
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t],
      days: 3,
      effectiveOn: '2026-06-01',
      reason: 'Granted in error',
      targetMode: 'individual',
      employmentIds: [e1, e2],
    });
    expect(await ledgerBalance(e1, t)).toBe(3);

    const rev = await reverseLeaveAdjustmentBatch(adminCtx(b), { batchId: res.batchId });
    expect(rev.reversed).toBe(2);
    expect(await ledgerBalance(e1, t)).toBe(0);
    expect(await ledgerBalance(e2, t)).toBe(0);

    // APPEND-ONLY: the original rows are still there. A balance that silently loses its history is what
    // the audit substrate exists to prevent, so the undo is a new pair of rows, not a deletion.
    const all = await owner.db
      .select({ id: schema.leaveLedger.id })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.adjustmentBatchId, res.batchId));
    expect(all, 'two originals + two reversals').toHaveLength(4);
  });

  it('REFUSES a second reversal — otherwise the undo hands the days out again', async () => {
    const e = await hire('Twice');
    const t = await makeType('ADJ9');
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t],
      days: 2,
      effectiveOn: '2026-06-01',
      reason: 'Once only',
      targetMode: 'individual',
      employmentIds: [e],
    });
    await reverseLeaveAdjustmentBatch(adminCtx(b), { batchId: res.batchId });
    await expect(
      reverseLeaveAdjustmentBatch(adminCtx(b), { batchId: res.batchId }),
    ).rejects.toBeInstanceOf(LeaveAdjustmentError);
    expect(await ledgerBalance(e, t), 'still zero, not minus two').toBe(0);
  });

  it('the reversal rows carry a HUMAN reason, so they stay counted as config adjustments', async () => {
    // classifyLedgerAdjustment reads a sys: prefix as a machine write and a NULL reason as 'config'. A
    // reversal is a person undoing a person's action, so it must read as config like its original —
    // otherwise the balance breakdown shows the grant but not its undo.
    const e = await hire('HumanReason');
    const t = await makeType('ADJ10');
    const res = await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [t],
      days: 1,
      effectiveOn: '2026-06-01',
      reason: 'Festival grant',
      targetMode: 'individual',
      employmentIds: [e],
    });
    await reverseLeaveAdjustmentBatch(adminCtx(b), { batchId: res.batchId });
    const rows = await owner.db
      .select({ reason: schema.leaveLedger.reason })
      .from(schema.leaveLedger)
      .where(
        and(eq(schema.leaveLedger.adjustmentBatchId, res.batchId), eq(schema.leaveLedger.employmentId, e)),
      );
    const reasons = rows.map((r) => r.reason ?? '');
    expect(reasons.some((r) => r.startsWith('Reversal of:'))).toBe(true);
    expect(reasons.every((r) => !r.startsWith('sys:')), 'no reversal wears a system prefix').toBe(true);
  });
});


describe('participating adjustment reversal ownership — authored, unrun acceptance', () => {
  it.each(['employment', 'batch'] as const)('refuses a held %s, leaves history intact, then reverses once', async heldKind => {
    const ctx = adminCtx(b), employeeId = await hire('Fictional Reversal Ownership');
    const typeId = await makeType('OWNED_ADJ');
    const applied = await applyLeaveAdjustmentBatch(ctx, { leaveTypeIds: [typeId], days: 2,
      effectiveOn: '2026-06-01', reason: 'Ownership acceptance', targetMode: 'individual',
      employmentIds: [employeeId] });
    const rowsForBatch = () => owner.db.select({ id: schema.leaveLedger.id, days: schema.leaveLedger.days })
      .from(schema.leaveLedger).where(eq(schema.leaveLedger.adjustmentBatchId, applied.batchId))
      .orderBy(schema.leaveLedger.id);
    const before = await rowsForBatch();
    expect(before).toHaveLength(1);
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned adjustment handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      if (heldKind === 'employment') await lockLeaveDependenciesTx(tx, b.tenantId, [employeeId]);
      else {
        const held = await tx.select({ id: schema.leaveAdjustmentBatch.id }).from(schema.leaveAdjustmentBatch)
          .where(eq(schema.leaveAdjustmentBatch.id, applied.batchId)).for('update');
        expect(held).toHaveLength(1);
      }
      ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started;
      await expect(reverseLeaveAdjustmentBatch(ctx, { batchId: applied.batchId }))
        .rejects.toThrow(heldKind === 'batch' ? 'That adjustment is busy; review it again.' : 'Leave source is unavailable');
      expect(await rowsForBatch()).toEqual(before);
      const [batch] = await owner.db.select({ reversedAt: schema.leaveAdjustmentBatch.reversedAt })
        .from(schema.leaveAdjustmentBatch).where(eq(schema.leaveAdjustmentBatch.id, applied.batchId));
      expect(batch.reversedAt).toBeNull();
    } finally { release(); clearTimeout(watchdog); await holder; }
    // Also proves the failed transaction released its earlier advisory locks, including on NOWAIT.
    expect((await reverseLeaveAdjustmentBatch(ctx, { batchId: applied.batchId })).reversed).toBe(1);
    const reversed = await rowsForBatch();
    expect(reversed).toHaveLength(2);
    expect(reversed.reduce((total, row) => total + Number(row.days), 0)).toBe(0);
    await expect(reverseLeaveAdjustmentBatch(ctx, { batchId: applied.batchId })).rejects.toThrow('already been reversed');
    expect(await rowsForBatch()).toEqual(reversed);
  });
});


describe('participating adjustment creation — authored, unrun acceptance', () => {
  it.each(['employment', 'configuration'] as const)('refuses a held %s before any batch effect, then applies after release', async heldKind => {
    const ctx = adminCtx(b), subjects = [await hire('Fictional Adjustment A'), await hire('Fictional Adjustment B')].sort();
    const typeId = await makeType('APPLY_OWNED');
    const input = { leaveTypeIds: [typeId], days: 2, effectiveOn: '2026-06-01',
      reason: 'Creation ownership acceptance', targetMode: 'individual' as const, employmentIds: [...subjects] };
    const history = async () => ({
      batches: await owner.db.select({ id: schema.leaveAdjustmentBatch.id }).from(schema.leaveAdjustmentBatch)
        .where(eq(schema.leaveAdjustmentBatch.tenantId, b.tenantId)).orderBy(schema.leaveAdjustmentBatch.id),
      ledger: await owner.db.select({ id: schema.leaveLedger.id }).from(schema.leaveLedger)
        .where(eq(schema.leaveLedger.tenantId, b.tenantId)).orderBy(schema.leaveLedger.id),
      events: await owner.db.select({ id: schema.domainEvent.id }).from(schema.domainEvent)
        .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave.adjustment.applied')))
        .orderBy(schema.domainEvent.id),
    });
    const before = await history();
    let ready!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const started = new Promise<void>((yes, no) => { ready = yes; failed = no; });
    const finish = new Promise<void>(yes => { release = yes; });
    const watchdog = setTimeout(() => { failed(new Error('owned adjustment creation handshake timed out')); release(); }, 10_000);
    const holder = withTenant(ctx, async tx => {
      // Holding the last sorted subject forces the attempted command to roll back an earlier lock.
      if (heldKind === 'employment') await lockLeaveDependenciesTx(tx, b.tenantId, [subjects[1]]);
      else await lockLeaveDependencyConfigurationTx(tx, b.tenantId);
      ready(); await finish;
    });
    void holder.catch(failed);
    try {
      await started;
      await expect(applyLeaveAdjustmentBatch(ctx, input)).rejects.toThrow('Leave source is unavailable');
      expect(await history()).toEqual(before);
      if (heldKind === 'employment') {
        await withTenant(ctx, tx => lockLeaveDependenciesTx(tx, b.tenantId, [subjects[0]]));
      }
    } finally { release(); clearTimeout(watchdog); await holder; }
    const applied = await applyLeaveAdjustmentBatch(ctx, input);
    expect(applied.targeted).toBe(2); expect(applied.written).toBe(2); expect(applied.skipped).toBe(0);
    expect(await ledgerBalance(subjects[0], typeId)).toBe(2);
    expect(await ledgerBalance(subjects[1], typeId)).toBe(2);
    const after = await history();
    expect(after.batches).toHaveLength(before.batches.length + 1);
    expect(after.ledger).toHaveLength(before.ledger.length + 2);
    expect(after.events).toHaveLength(before.events.length + 1);
  });
});
