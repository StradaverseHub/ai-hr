/**
 * Edit / cancel own leave by status (item c9a19e34).
 *
 * Employee self-service on their OWN leave, status-gated (Option A):
 *   • PENDING  → editLeaveRequest (modify details, stays pending) + cancelOwnLeave (immediate self-withdraw).
 *   • APPROVED → cancelOwnLeave is REFUSED (routed to the manager-approved give-back requestLeaveCancellation).
 *   • REJECTED → view-only (both writes refused).
 * Auth is subject-only (enforced in code, not RLS). Pending leave has no ledger debit, so an edit / withdraw
 * moves no balance. Every write appends a distinct DomainEvent (leave-request.edited / .self-cancelled).
 *
 * Future dates (Aug 2026) so no backdating/advance-notice gate interferes. 2026-08-10..12 = Mon–Wed (3 wd).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  cancelOwnLeave,
  cancelOwnLeaveFromBrowser,
  decideLeave,
  editLeaveRequest,
  requestLeave,
  requestLeaveCancellation,
  LeaveCancellationNotAllowedError,
  LeaveEditNotAllowedError,
} from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import { leaveRequestsFor } from '../core/read';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let other: { personId: string; employmentId: string };
let otherCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ecs_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function grantAnnual(employmentId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

async function pendingThreeDay(ctx = subjectCtx, employmentId = subject.employmentId) {
  const res = await requestLeave(ctx, {
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: '2026-08-10',
    endDate: '2026-08-12',
  });
  return res.leaveRequestId;
}

async function rowOf(id: string) {
  const [r] = await owner.db
    .select({ status: schema.leaveRequest.status, days: schema.leaveRequest.days, start: schema.leaveRequest.startDate, end: schema.leaveRequest.endDate, reason: schema.leaveRequest.reason })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, id));
  return r;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // r79 0322 — single- vs multi-step approval is now decided by the company's resolved chain, not by
  // company.leave_multi_approval (which is gone). These cases are whole-request single-approver flows —
  // the shape the old opted-out default produced — so the company is put on an explicit ONE-step chain.
  // Without it the built-in direct_manager → hr_admin fallback applies and an approval stops at step 1.
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  subject = await hire('Subject');
  const u = await createAppUser(b.tenantId, subject.personId, 'employee');
  subjectCtx = { tenantId: b.tenantId, userId: u, personId: subject.personId, roles: ['employee'] };
  other = await hire('Other');
  const uO = await createAppUser(b.tenantId, other.personId, 'manager');
  // Make `other` the subject's manager so RLS lets them SEE the subject's leave — the subject-only rule must
  // still block them in code (RLS being symmetric is the whole reason the check lives in the service).
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: other.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  otherCtx = { tenantId: b.tenantId, userId: uO, personId: other.personId, roles: ['manager'] };
  await grantAnnual(subject.employmentId, '20.00');
});
afterAll(async () => {
  await closeAll();
});

it('submits own annual leave while another transaction shares the Access lock', async () => {
  let submission: ReturnType<typeof requestLeave> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await owner.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:' + b.tenantId},0))`);
      submission = requestLeave(subjectCtx, {
        employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10', endDate: '2026-08-12',
        hasDocument: false, unpaidConsent: false, overrideConsent: [],
      });
      const result = await Promise.race([submission, new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), 5000);
      })]);
      expect(result).toMatchObject({leaveRequestId: expect.any(String)});
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    await submission?.catch(() => undefined);
  }
});

async function waitForWithdrawalAccess(
  tx: Tx, writerPid: number, mode: 'ShareLock' | 'ExclusiveLock', granted: boolean,
) {
  const deadline = performance.now() + 5_000;
  do {
    const [row] = await tx.execute<{ pid: number }>(sql`
      select l.pid from pg_locks l
        where l.locktype = 'advisory' and l.mode = ${mode} and l.granted = ${granted}
          and l.objsubid = 1
          and ((l.classid::bigint << 32) | l.objid::bigint) =
            hashtextextended(${'access-configuration:' + b.tenantId}, 0)
          and ${writerPid}::integer = any(pg_blocking_pids(l.pid))
        limit 1
    `);
    if (row) return row.pid;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  throw new Error('Expected withdrawal Access lock was not observed');
}

async function ownWithdrawEvent(requestId: string) {
  return owner.db.select().from(schema.domainEvent).where(and(
    eq(schema.domainEvent.aggregateId, requestId),
    eq(schema.domainEvent.eventType, 'leave-request.self-cancelled'),
  ));
}

it('lets different own browser withdrawals hold shared Access without changing native effects', async () => {
  const firstId = await pendingThreeDay();
  const second = await hire('Second browser subject');
  const secondUser = await createAppUser(b.tenantId, second.personId, 'employee');
  const secondCtx: SessionContext = {
    tenantId: b.tenantId, userId: secondUser, personId: second.personId, roles: ['employee'],
  };
  await grantAnnual(second.employmentId, '20.00');
  const secondId = await pendingThreeDay(secondCtx, second.employmentId);
  let first: ReturnType<typeof cancelOwnLeaveFromBrowser> | undefined;
  let next: ReturnType<typeof cancelOwnLeaveFromBrowser> | undefined;
  let repeat: ReturnType<typeof cancelOwnLeaveFromBrowser> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await owner.db.transaction(async tx => {
      await tx.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, firstId)).for('update');
      const [writer] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      first = cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: firstId});
      void first.catch(() => undefined);
      const firstPid = await waitForWithdrawalAccess(tx, writer.pid, 'ShareLock', true);

      next = cancelOwnLeaveFromBrowser(secondCtx, {leaveRequestId: secondId});
      const result = await Promise.race([next, new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), 5_000);
      })]);
      expect(result).toEqual({previousStatus: 'pending', restoredDays: 0});
      expect((await rowOf(firstId)).status).toBe('pending');
      expect(await ownWithdrawEvent(firstId)).toHaveLength(0);

      repeat = cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: firstId});
      await Promise.race([
        waitForWithdrawalAccess(tx, firstPid, 'ExclusiveLock', false),
        repeat.then(() => { throw new Error('Duplicate withdrawal committed while the first request was locked'); }),
      ]);
    });
    await expect(first).resolves.toEqual({previousStatus: 'pending', restoredDays: 0});
    await expect(repeat).rejects.toMatchObject({refusal: 'already_final'});
    for (const id of [firstId, secondId]) {
      expect((await rowOf(id)).status).toBe('cancelled');
      const events = await ownWithdrawEvent(id);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({previousStatus: 'pending', newStatus: 'cancelled', restoredDays: 0});
      expect(await owner.db.select().from(schema.notificationEventProcessing).where(and(
        eq(schema.notificationEventProcessing.eventId, events[0].id),
        eq(schema.notificationEventProcessing.consumer, 'notifications'),
      ))).toHaveLength(1);
      expect(await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.sourceRequestId, id)))
        .toHaveLength(0);
    }
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.allSettled([first, next, repeat]);
  }
});

it('reproves the actual principal after native role revocation wins Access', async () => {
  const id = await pendingThreeDay();
  let withdrawal: ReturnType<typeof cancelOwnLeaveFromBrowser> | undefined;
  try {
    await withTenant(adminCtx(b), async tx => {
      await tx.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId, subjectCtx.userId!));
      const [writer] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      withdrawal = cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: id});
      void withdrawal.catch(() => undefined);
      await waitForWithdrawalAccess(tx, writer.pid, 'ShareLock', false);
    });
    await expect(withdrawal).rejects.toMatchObject({refusal: 'not_yours'});
    expect((await rowOf(id)).status).toBe('pending');
    expect(await ownWithdrawEvent(id)).toHaveLength(0);
  } finally {
    await withdrawal?.catch(() => undefined);
  }
});

it('keeps the browser grouped and approved refusal order without audit or balance effects', async () => {
  const id = await pendingThreeDay();
  await owner.db.update(schema.leaveRequest).set({parentGroupId: randomUUID()})
    .where(eq(schema.leaveRequest.id, id));
  await expect(cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: id}))
    .rejects.toMatchObject({refusal: 'grouped'});
  await owner.db.update(schema.leaveRequest).set({status: 'approved'})
    .where(eq(schema.leaveRequest.id, id));
  await expect(cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: id}))
    .rejects.toMatchObject({refusal: 'already_approved'});
  expect((await rowOf(id)).status).toBe('approved');
  expect(await ownWithdrawEvent(id)).toHaveLength(0);
  expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);
});

it.each([
  {name: 'legacy net debit', days: ['-2.00'], restoredDays: 2},
  {name: 'balanced legacy history', days: ['-2.00', '2.00'], restoredDays: 0},
])('rolls back shared admission before $name uses exclusive Access', async ({days, restoredDays}) => {
  const id = await pendingThreeDay();
  await owner.db.insert(schema.leaveLedger).values(days.map(amount => ({
    tenantId: b.tenantId, employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId,
    entryType: 'debit' as const, days: amount, sourceRequestId: id, effectiveOn: '2026-08-10',
  })));
  const releaseRequestRow = new Error('Release the row holder savepoint');
  let withdrawal: ReturnType<typeof cancelOwnLeaveFromBrowser> | undefined;
  try {
    await owner.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:' + b.tenantId},0))`);
      const [writer] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      try {
        await tx.transaction(async rowHolder => {
          await rowHolder.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)).for('update');
          withdrawal = cancelOwnLeaveFromBrowser(subjectCtx, {leaveRequestId: id});
          void withdrawal.catch(() => undefined);
          await waitForWithdrawalAccess(rowHolder, writer.pid, 'ShareLock', true);
          throw releaseRequestRow;
        });
      } catch (error) {
        if (error !== releaseRequestRow) throw error;
      }
      await waitForWithdrawalAccess(tx, writer.pid, 'ExclusiveLock', false);
      expect((await rowOf(id)).status).toBe('pending');
      expect(await ownWithdrawEvent(id)).toHaveLength(0);
    });
    await expect(withdrawal).resolves.toEqual({previousStatus: 'pending', restoredDays});
    expect((await rowOf(id)).status).toBe('cancelled');
    const ledger = await owner.db.select({days: schema.leaveLedger.days}).from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.sourceRequestId, id));
    expect(ledger.map(row => row.days).sort()).toEqual(['-2.00', '2.00']);
    expect(await ownWithdrawEvent(id)).toHaveLength(1);
  } finally {
    await withdrawal?.catch(() => undefined);
  }
});

describe('editLeaveRequest — pending edit', () => {
  it('allows an own pending edit while another transaction shares the Access lock', async () => {
    const id = await pendingThreeDay();
    let edit: ReturnType<typeof editLeaveRequest> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await owner.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:' + b.tenantId},0))`);
        edit = editLeaveRequest(subjectCtx, {
          leaveRequestId: id, leaveTypeId: b.annualLeaveTypeId,
          startDate: '2026-08-10', endDate: '2026-08-11',
        });
        const result = await Promise.race([edit, new Promise<null>(resolve => {
          timeout = setTimeout(() => resolve(null), 5000);
        })]);
        expect(result).toEqual({leaveRequestId: id, days: 2});
      });
    } finally {
      if (timeout) clearTimeout(timeout);
      await edit?.catch(() => undefined);
    }
  });

  it('waits for the exclusive Access writer before reading or editing the request', async () => {
    const id = await pendingThreeDay();
    let edit: ReturnType<typeof editLeaveRequest> | undefined;
    try {
      await owner.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:' + b.tenantId},0))`);
        const [writer] = await tx.execute<{pid: number}>(sql`select pg_backend_pid() as pid`);
        edit = editLeaveRequest(subjectCtx, {
          leaveRequestId: id, leaveTypeId: b.annualLeaveTypeId,
          startDate: '2026-08-10', endDate: '2026-08-11',
        });
        void edit.catch(() => undefined);
        let blocked = false;
        const deadline = performance.now() + 5000;
        while (!blocked && performance.now() < deadline) {
          const [state] = await tx.execute<{blocked: boolean}>(sql`
            select exists(select 1 from pg_locks l
              where l.locktype = 'advisory' and l.mode = 'ShareLock' and not l.granted
                and ${writer.pid}::integer = any(pg_blocking_pids(l.pid))) as blocked
          `);
          blocked = state.blocked;
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
      });
      await expect(edit).resolves.toEqual({leaveRequestId: id, days: 2});
    } finally {
      await edit?.catch(() => undefined);
    }
  });

  it('edits a pending leave in place, keeps it pending, recomputes days, appends leave-request.edited', async () => {
    const id = await pendingThreeDay();
    expect((await rowOf(id)).days).toBe('3.00');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20); // no debit on submit

    const out = await editLeaveRequest(subjectCtx, {
      leaveRequestId: id,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-11', // 2 working days now
      reason: 'shorter trip',
    });
    expect(out.days).toBe(2);

    const r = await rowOf(id);
    expect(r.status).toBe('pending'); // stays pending
    expect(r.days).toBe('2.00');
    expect(r.end).toBe('2026-08-11');
    expect(r.reason).toBe('shorter trip');
    // ledger untouched (pending never debits)
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);

    expect(await eventTypesFor(b.tenantId, id)).toContain('leave-request.edited');
    const payload = (await latestEventPayload(b.tenantId, id, 'leave-request.edited')) as any;
    expect(payload?.before?.endDate).toBe('2026-08-12');
    expect(payload?.after?.endDate).toBe('2026-08-11');
    expect(payload?.diff?.endDate?.after).toBe('2026-08-11');
  });

  it('refuses to edit an APPROVED leave (only pending is editable)', async () => {
    const id = await pendingThreeDay();
    await decideLeave(adminCtx(b), { leaveRequestId: id, decision: 'approved' });
    await expect(
      editLeaveRequest(subjectCtx, {
        leaveRequestId: id,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-11',
      }),
    ).rejects.toBeInstanceOf(LeaveEditNotAllowedError);
    expect((await rowOf(id)).status).toBe('approved');
  });

  it('subject-only: a manager who can SEE the leave still cannot edit it', async () => {
    const id = await pendingThreeDay();
    await expect(
      editLeaveRequest(otherCtx, {
        leaveRequestId: id,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-11',
      }),
    ).rejects.toBeInstanceOf(LeaveEditNotAllowedError);
    expect((await rowOf(id)).days).toBe('3.00'); // unchanged
  });
});

describe('cancelOwnLeave — pending withdraw', () => {
  it('withdraws a pending leave (→ cancelled), no ledger movement, appends leave-request.self-cancelled', async () => {
    const id = await pendingThreeDay();
    const out = await cancelOwnLeave(subjectCtx, { leaveRequestId: id });
    expect(out.previousStatus).toBe('pending');
    expect(out.restoredDays).toBe(0);
    expect((await rowOf(id)).status).toBe('cancelled');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);

    expect(await eventTypesFor(b.tenantId, id)).toContain('leave-request.self-cancelled');
    const payload = (await latestEventPayload(b.tenantId, id, 'leave-request.self-cancelled')) as any;
    expect(payload?.previousStatus).toBe('pending');
    expect(payload?.newStatus).toBe('cancelled');
    // Audit shows the employee themselves as actor.
    const [ev] = await owner.db
      .select({ actorId: schema.domainEvent.actorId })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    // (multiple events on the aggregate; assert the self-cancelled one carries the subject user)
    const [sc] = await owner.db
      .select({ actorId: schema.domainEvent.actorId, subj: schema.domainEvent.subjectEmploymentId })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'leave-request.self-cancelled'));
    expect(sc.actorId).toBe(subjectCtx.userId);
    expect(sc.subj).toBe(subject.employmentId);
    void ev;
  });

  it('refuses to self-cancel an APPROVED leave (routed to the give-back flow instead)', async () => {
    const id = await pendingThreeDay();
    await decideLeave(adminCtx(b), { leaveRequestId: id, decision: 'approved' });
    await expect(cancelOwnLeave(subjectCtx, { leaveRequestId: id })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    expect((await rowOf(id)).status).toBe('approved');

    // The give-back path (manager-approved) is still open for the approved leave — subject can request it.
    const gb = await requestLeaveCancellation(subjectCtx, { today: '2026-08-01', leaveRequestId: id, cancelDates: ['2026-08-11'] });
    expect(gb.cancellationRequestId).toBeTruthy();
  });

  it('subject-only: a manager who can SEE the leave cannot self-cancel it', async () => {
    const id = await pendingThreeDay();
    await expect(cancelOwnLeave(otherCtx, { leaveRequestId: id })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    expect((await rowOf(id)).status).toBe('pending');
  });
});

describe('cancelOwnLeave — notification (req 4.v: notify the approver and HR)', () => {
  it('fans out one leave.self-cancelled notice to the manager; the withdrawing employee holds none', async () => {
    // ADR-0077 slice 3: the notifications gate is a per-tenant entitlement row, not NOTIFICATIONS_ENABLED.
    // Grant it explicitly rather than leaning on seedBase's parity set — that set narrows by the LIVE env,
    // so whether this tenant gets a notifications row depends on the machine's .env.local. This test is
    // about the fan-out, so it states its own precondition. (No teardown: resetDb truncates tenant_module.)
    await setModule(b.tenantId, 'notifications', 'active');
    const id = await pendingThreeDay();
    await cancelOwnLeave(subjectCtx, { leaveRequestId: id });
    // A REAL snapshot resolved AFTER the grant, not adminCtx: adminCtx's snapshot is derived from
    // process.env, so it would neither see this row nor be trustworthy in an environment where the old
    // flag happens to be unset.
    await dispatchNotifications(await entitledCtx(b));

    const notes = await owner.db
      .select({ recipient: schema.notification.recipientEmploymentId })
      .from(schema.notification)
      .where(eq(schema.notification.kind, 'leave.self-cancelled'));
    const recipients = notes.map((n) => n.recipient);
    expect(recipients).toContain(other.employmentId); // the approver (subject's manager)
    expect(recipients).not.toContain(subject.employmentId); // never the person who withdrew
  });
});

describe('leaveRequestsFor — read surfaces the fields the ESS actions need', () => {
  it('returns leaveTypeId + reason so the Edit dialog can prefill', async () => {
    const id = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      reason: 'family',
    });
    const rows = await leaveRequestsFor(subjectCtx, subject.employmentId);
    const row = rows.find((r) => r.id === id.leaveRequestId)!;
    expect(row.leaveTypeId).toBe(b.annualLeaveTypeId);
    expect(row.reason).toBe('family');
    expect(row.status).toBe('pending');
  });
});
