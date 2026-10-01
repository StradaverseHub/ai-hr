/**
 * 2166ef79 · My Attendance stage one — what the REQUEST RECORD gained, and what it must keep refusing.
 *
 * The record is NOT new and deliberately is not: an attendance request already IS an
 * attendance_correction (ADR-0069), which is why it already has the request → approve route, the
 * approvals inbox, assertCanDecide routing, RLS, the four statuses and the audit trail. Migration 0434
 * adds three things and nothing else — a remark, a stored request_kind, and one optional supporting file.
 *
 * WHAT THIS FILE PINS, in the order the risk sits:
 *
 *  1 · THE GRANT. A CREATE TABLE migration must also GRANT, because production's ALTER DEFAULT PRIVILEGES
 *      masks the omission and the failure would first appear on a dev cluster restored from a dump, as
 *      "permission denied for table attendance_correction_attachment" on the first render after a deploy.
 *      Every attachment assertion below runs through the app role, so a missing GRANT fails here first.
 *  2 · The two REFUSALS the Fix panel's prefill is shaped around, restated at the service: at most one
 *      PENDING request per (employment, date), and a proposed clock-out with no clock-in.
 *  3 · The stored kind survives the fix. The moment a missing clock-out is approved the day stops being an
 *      Incomplete Entry, so a request list that re-derived its type would relabel its own history.
 *  4 · Cancelling is SUBJECT-ONLY and PENDING-ONLY for a clock correction, and refuses an overtime plan —
 *      approving a plan touches no day, approving a correction rewrites one, so the two states differ.
 *  5 · Nothing was widened by accident: an existing hours-only, remark-less request is byte-identical.
 *
 * Assertions are on the MESSAGE, never on `rejects.toThrow()` alone — a bare toThrow passes on the wrong
 * throw, which is how a refusal test ends up pinning something other than the refusal it was written for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base, harnessSnapshot } from './harness';
import { hireEmployee } from '../core/org';
import {
  AttendanceCorrectionPendingError,
  AttendanceCorrectionFutureDateError,
  addAttendanceCorrectionAttachment,
  cancelOwnAttendanceCorrection,
  checkIn,
  decideAttendanceCorrection,
  getAttendanceCorrectionAttachment,
  myAttendanceCorrections,
  requestAttendanceCorrection,
} from '../core/attendance';
import type { SessionContext } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;
const DATE = '2026-07-27'; // the mockup's own subject day: clocked in, never clocked out.

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

const uniqEmail = () => `att_${Math.random().toString(36).slice(2, 10)}@t.local`;

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Request Record Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return { a, employmentId: e.employmentId, personId: e.personId };
}

/** The employee themselves — cancellation is subject-only, so it cannot be exercised as the admin. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  // r292 — a REAL snapshot: core/attendance.ts is module-gated now (core/module-gate.ts) and a context
  // with neither entitlements nor an exemption marker is the EntitlementsUnresolvedError state.
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) } as SessionContext;
}

const png = () => Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * Assert that a statement is refused BY A NAMED DATABASE CONSTRAINT.
 *
 * `rejects.toThrow(/name/)` cannot do this job: drizzle wraps a driver error and its own `message` is only
 * "Failed query: …", so the pattern would never match and — worse — a plain `rejects.toThrow()` with no
 * pattern would pass on any throw at all, including one from the fixture. The constraint name lives on the
 * driver error hanging off `cause`, so that is what is read.
 */
async function refusedByConstraint(fn: () => Promise<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `the statement must be refused by ${constraint}`).toBeDefined();
  const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
  const text = [(caught as Error).message, cause?.message, cause?.constraint].filter(Boolean).join(' | ');
  expect(text, `refused, but not by ${constraint}`).toContain(constraint);
}

describe('2166ef79 — the remark and the stored kind', () => {
  it('stores both, and reads them back on the request list', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock out',
      remark: 'The site gate log will show 18:04',
      requestKind: 'incomplete_entry',
    });
    const [row] = await myAttendanceCorrections(a, employmentId);
    expect(row.id).toBe(correctionId);
    expect(row.remark).toBe('The site gate log will show 18:04');
    expect(row.requestKind).toBe('incomplete_entry');
    expect(row.reason).toBe('Forgot to clock out');
    expect(row.hasAttachment).toBe(false);
  });

  it('the remark is OPTIONAL — blank stores NULL, not an empty note nobody wrote', async () => {
    const { a, employmentId } = await hire();
    await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock out',
      remark: '   ',
    });
    const [row] = await myAttendanceCorrections(a, employmentId);
    expect(row.remark).toBeNull();
    // Not "the kind is missing" either — an omitted kind is NULL and the screen labels it generically.
    expect(row.requestKind).toBeNull();
  });

  it('THE REASON IS STILL MANDATORY — stage one adds an optional remark, it does not soften the reason', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, checkIn: '09:00', remark: 'only a remark' }),
    ).rejects.toThrow('A reason is required.');
  });

  it('the DB refuses a kind outside the vocabulary (the CHECK, not just the action-layer filter)', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      reason: 'r',
      requestKind: 'incomplete_entry',
    });
    await refusedByConstraint(
      () =>
        owner.db.execute(
          sql`UPDATE attendance_correction SET request_kind = 'made_up' WHERE id = ${correctionId}::uuid`,
        ),
      'attendance_correction_request_kind_ck',
    );
  });

  it('THE KIND SURVIVES THE FIX — an approved Incomplete Entry is still labelled one', async () => {
    // The whole reason the kind is STORED rather than derived. Approving writes the punches onto the day,
    // so the day stops being incomplete; a re-derived label would silently relabel its own history.
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:00:00' });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock out',
      requestKind: 'incomplete_entry',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    const [row] = await myAttendanceCorrections(a, employmentId);
    expect(row.status).toBe('approved');
    expect(row.requestKind).toBe('incomplete_entry');
  });
});

describe('2166ef79 — the two refusals the Fix panel is shaped around', () => {
  it('a clock-out with no clock-in has no anchor, so the prefill must always carry the clock-in', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: DATE, checkOut: '18:00', reason: 'r' }),
    ).rejects.toThrow('A clock-out time also needs a clock-in time.');
  });

  it('one PENDING request per employee-day — which is why the row shows "Requested" instead of Fix this', async () => {
    const { a, employmentId } = await hire();
    await requestAttendanceCorrection(a, { employmentId, date: DATE, checkIn: '09:00', checkOut: '18:00', reason: 'first' });
    await expect(requestAttendanceCorrection(a, {
      employmentId, date: DATE, checkIn: '09:00', checkOut: '17:00', reason: 'second',
    })).rejects.toBeInstanceOf(AttendanceCorrectionPendingError);
    expect(await myAttendanceCorrections(a, employmentId, { date: DATE, status: 'pending' })).toHaveLength(1);
  });
});

describe('employee day correction date boundary', () => {
  it('refuses future clock corrections but accepts a future OT-only plan', async () => {
    const { a, employmentId } = await hire();
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 2);
    const date = todayInKualaLumpur(future);
    await expect(requestAttendanceCorrection(a, { employmentId, date, checkIn: '09:00', reason: 'clock fix' }))
      .rejects.toBeInstanceOf(AttendanceCorrectionFutureDateError);
    expect(await myAttendanceCorrections(a, employmentId, { date })).toHaveLength(0);
    await requestAttendanceCorrection(a, { employmentId, date, requestedOtMinutes: 60, reason: 'planned work' });
    expect(await myAttendanceCorrections(a, employmentId, { date, status: 'pending' })).toHaveLength(1);
  });
});

describe('2166ef79 — the attachment (and, first of all, its GRANT)', () => {
  it('attaches a file and streams it back through the app role', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'Forgot to clock out',
      requestKind: 'incomplete_entry',
    });
    // Every statement below runs as ai_hr_app. A missing GRANT on the new table fails HERE — which is the
    // whole point of asserting it rather than trusting production's ALTER DEFAULT PRIVILEGES to hide it.
    await addAttendanceCorrectionAttachment(a, {
      correctionId,
      fileName: 'gate-log.png',
      mimeType: 'image/png',
      content: png(),
    });
    const att = await getAttendanceCorrectionAttachment(a, correctionId);
    expect(att?.fileName).toBe('gate-log.png');
    expect(att?.mimeType).toBe('image/png');
    expect(Buffer.from(att!.content).equals(png())).toBe(true);
    const [row] = await myAttendanceCorrections(a, employmentId);
    expect(row.hasAttachment).toBe(true);
  });

  it('refuses an empty file, an oversized file and a type nobody asked for', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      reason: 'r',
    });
    const base = { correctionId, fileName: 'x', mimeType: 'image/png' };
    await expect(addAttendanceCorrectionAttachment(a, { ...base, content: Buffer.alloc(0) })).rejects.toThrow(
      'That file is empty.',
    );
    await expect(
      addAttendanceCorrectionAttachment(a, { ...base, content: Buffer.alloc(5 * 1024 * 1024 + 1) }),
    ).rejects.toThrow('That file is larger than 5 MB.');
    await expect(
      addAttendanceCorrectionAttachment(a, { ...base, mimeType: 'application/zip', content: png() }),
    ).rejects.toThrow('That file type is not accepted — attach a photo or a PDF.');
  });

  it('refuses a file added after the approver has already decided', async () => {
    // Evidence the approver never saw, filed under their decision. Leave refuses it for the same reason.
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: DATE, time: '09:00:00' });
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'r',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await expect(
      addAttendanceCorrectionAttachment(a, { correctionId, fileName: 'late.png', mimeType: 'image/png', content: png() }),
    ).rejects.toThrow('A file can only be attached while the request is waiting.');
  });
});

describe('2166ef79 — the status filter, and cancelling your own request', () => {
  it('filters by status, and returns every kind of request when unfiltered', async () => {
    const { a, employmentId } = await hire();
    const pending = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-07-20',
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'pending one',
      requestKind: 'short_hours',
    });
    const ot = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2026-07-21',
      requestedOtMinutes: 120,
      reason: 'overtime one',
      requestKind: 'self_overtime',
    });
    await decideAttendanceCorrection(a, { correctionId: ot.correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });

    const all = await myAttendanceCorrections(a, employmentId);
    expect(all.map((r) => r.id).sort()).toEqual([pending.correctionId, ot.correctionId].sort());
    expect((await myAttendanceCorrections(a, employmentId, { status: 'pending' })).map((r) => r.id)).toEqual([
      pending.correctionId,
    ]);
    expect((await myAttendanceCorrections(a, employmentId, { status: 'rejected' })).map((r) => r.id)).toEqual([
      ot.correctionId,
    ]);
    expect(await myAttendanceCorrections(a, employmentId, { status: 'cancelled' })).toEqual([]);
  });

  it('the subject cancels their own pending correction; nobody else can', async () => {
    const { a, employmentId, personId } = await hire();
    const other = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'r',
      requestKind: 'incomplete_entry',
    });

    const stranger = await employeeCtx(other.personId);
    await expect(cancelOwnAttendanceCorrection(stranger, { correctionId })).rejects.toThrow(
      /Only the employee who filed a request can cancel it\.|not found/,
    );

    const me = await employeeCtx(personId);
    expect(await cancelOwnAttendanceCorrection(me, { correctionId })).toEqual({ status: 'cancelled' });
    const [row] = await myAttendanceCorrections(a, employmentId);
    expect(row.status).toBe('cancelled');
    // Nothing is deleted: what was asked for, and that it was taken back, both stay readable.
    expect(row.reason).toBe('r');
  });

  it('refuses a decided correction, and refuses an overtime plan outright', async () => {
    const { a, employmentId, personId } = await hire();
    const me = await employeeCtx(personId);

    await checkIn(a, { employmentId, date: DATE, time: '09:00:00' });
    const decided = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'r',
    });
    await decideAttendanceCorrection(a, { correctionId: decided.correctionId, decision: 'approved' });
    // r363 — THE REFUSAL NO LONGER NAMES THE PRIOR STATE, and that is the point rather than a
    // loosening. It used to interpolate the stored enum: `This request has already been ${status}…`.
    // 4c8aae68 made `cancelled` read "Withdrawn" everywhere the employee can see it, so on a
    // taken-back row that sentence became "already been cancelled, so it can no longer be withdrawn"
    // — two words for one state, in one sentence, created by the round that unified them. Naming the
    // state is not what the sentence is for; "no longer waiting for a decision" is true of approved,
    // rejected and withdrawn alike, and leaks no enum.
    await expect(cancelOwnAttendanceCorrection(me, { correctionId: decided.correctionId })).rejects.toThrow(
      'This request is no longer waiting for a decision, so it can no longer be withdrawn.',
    );
    // And it must not name it by accident either — this is the assertion that would catch a future
    // edit reinstating the interpolation.
    await expect(cancelOwnAttendanceCorrection(me, { correctionId: decided.correctionId })).rejects.not.toThrow(
      /approved|cancelled|rejected|pending/,
    );

    // An OT plan has its own state rule (approved-but-not-yet-counted may still be withdrawn), so it is
    // sent to withdraw rather than silently cancelled under the wrong one.
    const plan = await requestAttendanceCorrection(a, {
      employmentId,
      date: '2027-06-02',
      requestedOtMinutes: 120,
      reason: 'ot',
      requestKind: 'self_overtime',
    });
    await expect(cancelOwnAttendanceCorrection(me, { correctionId: plan.correctionId })).rejects.toThrow(
      'This is an overtime plan — withdraw it from the Self Overtime list.',
    );
  });
});

describe('2166ef79 — nothing was widened by accident', () => {
  it('a request filed the old way stores NULL remark, NULL kind and no attachment row', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: DATE,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'unchanged path',
    });
    const [stored] = await owner.db
      .select()
      .from(schema.attendanceCorrection)
      .where(eq(schema.attendanceCorrection.id, correctionId));
    expect(stored.remark).toBeNull();
    expect(stored.requestKind).toBeNull();
    expect(stored.status).toBe('pending');
    const files = await owner.db
      .select()
      .from(schema.attendanceCorrectionAttachment)
      .where(and(eq(schema.attendanceCorrectionAttachment.attendanceCorrectionId, correctionId)));
    expect(files).toEqual([]);
  });
});
