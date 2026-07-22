/**
 * Leave Year Configuration (9aa894a4).
 *
 * A managed leave_year_config record per (tenant, year): Draft → Open → Closed, with two independent control
 * dates (open_leave_year_date, employee_application_start_date). Covers: RLS (member read / admin write /
 * cross-tenant deny); the pure application gate (leaveYearOpenForApplication) across before/on/after the
 * app-start date and each status; status→open running openLeaveYear idempotently + stamping opened_at/by +
 * emitting substrate events; and the request-path gate (future-year rejection for employees, admin override
 * stamped, current-year back-compat unchanged, on/after app-start passes).
 *
 * Cluster dcd8e32f appended the delete block: admin-only delete (service assertAdmin + 0282 RESTRICTIVE
 * FOR DELETE RLS), every guard branch by stable code, the rejected/cancelled carve-out, the
 * leaveYearsWithRecords ⇄ deleteLeaveYear consistency contract, audit events (plain + hash-chained), and
 * the open→close→reopen→delete sequence.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  leaveYearOpenForApplication,
  upsertLeaveYearConfig,
  setLeaveYearStatus,
  listLeaveYearConfigs,
  deleteLeaveYear,
  leaveYearsWithRecords,
  LeaveYearNotOpenError,
} from '../core/leave';
import { withTenant, type SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Hire an employee (as admin) and return its OWN non-admin employee ctx + ids. Hired long ago so any
 *  leave year is "opened" for it (openLeaveYear posts grants for pre-1-Jan hires). */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'LY', primaryEmail: `ly_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** A calendar-counted leave type so the day math is trivial (no weekend/holiday interaction). */
async function calendarLeaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code: `LY_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`,
      name: 'LY Type',
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function configRow(year: number) {
  const [row] = await owner.db
    .select()
    .from(schema.leaveYearConfig)
    .where(and(eq(schema.leaveYearConfig.tenantId, b.tenantId), eq(schema.leaveYearConfig.year, year)));
  return row;
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ── Pure gate ────────────────────────────────────────────────────────────────
describe('leaveYearOpenForApplication (pure gate)', () => {
  it('no config ⇒ not open', () => {
    expect(leaveYearOpenForApplication(null, 2027, '2026-12-18')).toBe(false);
  });
  it('config for a different year ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2028, status: 'open', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(false);
  });
  it('draft ⇒ not open even with a past app-start', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'draft', employeeApplicationStartDate: '2026-01-01' }, 2027, '2026-12-18'),
    ).toBe(false);
  });
  it('open + null app-start ⇒ open immediately', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(true);
  });
  it('open but before app-start ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: '2026-12-18' }, 2027, '2026-12-17'),
    ).toBe(false);
  });
  it('open on the app-start date ⇒ open (inclusive)', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'open', employeeApplicationStartDate: '2026-12-18' }, 2027, '2026-12-18'),
    ).toBe(true);
  });
  it('closed ⇒ not open', () => {
    expect(
      leaveYearOpenForApplication({ year: 2027, status: 'closed', employeeApplicationStartDate: null }, 2027, '2026-12-18'),
    ).toBe(false);
  });
});

// ── RLS ──────────────────────────────────────────────────────────────────────
describe('leave_year_config RLS', () => {
  it('members read, only admins write', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-18', employeeApplicationStartDate: '2026-12-18' });

    const { ctx: empCtx } = await hireEmployeeCtx();
    // Member CAN read via the service.
    const rows = await listLeaveYearConfigs(empCtx);
    expect(rows.map((r) => r.year)).toContain(2027);

    // Member CANNOT write (RLS WITH CHECK app.is_admin()).
    await expect(upsertLeaveYearConfig(empCtx, { year: 2028 })).rejects.toThrow();
  });

  it('a tenant cannot see another tenant’s config', async () => {
    await upsertLeaveYearConfig(adminCtx(b), { year: 2029 });
    const other = await seedBase();
    const rows = await listLeaveYearConfigs(adminCtx(other));
    expect(rows.map((r) => r.year)).not.toContain(2029);
  });
});

// ── Service: upsert + status transition ────────────────────────────────────────
describe('leave-year config service', () => {
  it('upsert creates a draft, edit updates dates + keeps status, both append leave-year.configured', async () => {
    const a = adminCtx(b);
    const { id } = await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-15' });
    let row = await configRow(2027);
    expect(row.status).toBe('draft');
    expect(row.openLeaveYearDate).toBe('2026-12-01');

    // Edit the dates — status stays draft.
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-05', employeeApplicationStartDate: '2026-12-20' });
    row = await configRow(2027);
    expect(row.status).toBe('draft');
    expect(row.employeeApplicationStartDate).toBe('2026-12-20');

    const payload = await latestEventPayload(b.tenantId, id, 'leave-year.configured');
    expect(payload).toBeTruthy();
  });

  it('setLeaveYearStatus(open) runs openLeaveYear (grants posted), stamps opened_at/by, emits leave-year.opened', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx(); // hired 2020 ⇒ eligible for a 2027 grant
    await upsertLeaveYearConfig(a, { year: 2027 });

    const before = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    const res = await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    expect(res.status).toBe('open');
    expect(res.opened).toBeTruthy();

    const row = await configRow(2027);
    expect(row.status).toBe('open');
    expect(row.openedAt).not.toBeNull();
    expect(row.openedBy).toBe(b.adminUserId);

    // The Jan-1 grant for 2027 was posted (balance increased for the pre-2027 hire).
    const after = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after).toBeGreaterThan(before);

    // Idempotent: opening again does not double-post (the same accrual row is skipped).
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const after2 = await ledgerBalance(employmentId, b.annualLeaveTypeId);
    expect(after2).toBe(after);

    // Substrate: the grant sweep emitted leave-year.opened.
    const openedEvents = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave-year.opened')));
    expect(openedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Request-path gate ───────────────────────────────────────────────────────────
describe('requestLeave — future leave-year gate', () => {
  const TODAY = '2026-12-18';

  it('rejects an employee applying for a not-yet-open future year (persists nothing)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // No 2027 config at all ⇒ future year is not open.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2027-01-05', endDate: '2027-01-05', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearNotOpenError);
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows.length).toBe(0);
  });

  it('rejects when the year is open but today is before the employee-application-start date', async () => {
    const a = adminCtx(b);
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-20' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    // today 2026-12-18 is before app-start 2026-12-20.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: '2027-01-05', endDate: '2027-01-05', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearNotOpenError);
  });

  it('passes for an employee once the year is open and today is on/after the app-start date', async () => {
    const a = adminCtx(b);
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-01', employeeApplicationStartDate: '2026-12-18' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY, // == app-start ⇒ allowed
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('back-compat: a CURRENT-year request is never gated (no config needed)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // targetYear 2026 == currentYear ⇒ ungated even with no leave_year_config anywhere.
    const res = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2026-12-20',
      endDate: '2026-12-20',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
  });

  it('an HR admin overrides a not-yet-open future year and the override is stamped on the submitted event', async () => {
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    // No 2027 config ⇒ not open, but adminCtx (hr_admin) bypasses.
    const res = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY,
    });
    expect(res.leaveRequestId).toBeTruthy();
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveYearNotOpenOverride).toBe(true);
    expect(payload?.targetLeaveYear).toBe(2027);
  });

  it('does NOT stamp the override when the future year is properly open', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    const ltId = await calendarLeaveType();
    await upsertLeaveYearConfig(a, { year: 2027, employeeApplicationStartDate: '2026-12-18' });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    const res = await requestLeave(a, {
      employmentId,
      leaveTypeId: ltId,
      startDate: '2027-01-05',
      endDate: '2027-01-05',
      today: TODAY,
    });
    const payload = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.submitted');
    expect(payload?.leaveYearNotOpenOverride).toBeUndefined();
    expect(payload?.targetLeaveYear).toBeUndefined();
  });
});

// ── Delete + blocked-set consistency (cluster dcd8e32f) ──────────────────────
// The delete path had ZERO coverage before this block — which is exactly how the 0190 FOR ALL policy's
// missing DELETE guard (WITH CHECK applies to INSERT/UPDATE only) went unnoticed. Covers: the non-admin
// refusal (service assertAdmin + the 0282 RESTRICTIVE FOR DELETE RLS backstop), every guard branch with
// its stable error code, the rejected/cancelled carve-out, the leaveYearsWithRecords ⇄ deleteLeaveYear
// lockstep (the UI's blocked set and the service guard were previously two divergent implementations),
// the audit event (plain + hash-chained), and the open→close→reopen→delete sequence.
describe('deleteLeaveYear + leaveYearsWithRecords (dcd8e32f)', () => {
  async function insertLedgerRow(employmentId: string, effectiveOn: string) {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'adjustment',
      days: '1.00',
      effectiveOn,
    });
  }
  async function insertRequest(
    employmentId: string,
    startDate: string,
    endDate: string,
    status: 'pending' | 'approved' | 'rejected' | 'cancelled',
  ) {
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate,
      endDate,
      days: '1.00',
      status,
    });
  }

  it('a non-admin member is refused by the service AND by RLS on a raw DELETE (0282)', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2031 });
    const { ctx: empCtx } = await hireEmployeeCtx();

    // Service layer: assertAdmin fires before any query. FAILED before this cluster (no admin check).
    await expect(deleteLeaveYear(empCtx, { year: 2031, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      name: 'LeaveYearDeleteError',
      code: 'leaveYearNotAdmin',
    });

    // DB backstop: the 0282 RESTRICTIVE FOR DELETE policy filters the row out for a member issuing raw
    // SQL — 0 rows affected, no error, row survives. (RLS USING on DELETE filters; it does not throw.)
    await withTenant(empCtx, (tx) =>
      tx
        .delete(schema.leaveYearConfig)
        .where(and(eq(schema.leaveYearConfig.tenantId, b.tenantId), eq(schema.leaveYearConfig.year, 2031))),
    );
    expect(await configRow(2031)).toBeTruthy();

    // The admin branch still passes the restrictive policy.
    await deleteLeaveYear(a, { year: 2031, reasons: ['wrongly_created'] });
    expect(await configRow(2031)).toBeUndefined();
  });

  it('a pristine draft year deletes and appends leave-year.deleted (audit survives the row delete)', async () => {
    const a = adminCtx(b);
    const { id } = await upsertLeaveYearConfig(a, { year: 2027, openLeaveYearDate: '2026-12-18' });
    const res = await deleteLeaveYear(a, { year: 2027, reasons: ['wrongly_created'] });
    expect(res).toEqual({ deleted: true, year: 2027 });
    expect(await configRow(2027)).toBeUndefined();
    // domain_event.aggregate_id carries no FK to leave_year_config, so appending with the just-deleted
    // row's id inside the same transaction must hold — the audit trail outlives the record.
    const payload = await latestEventPayload(b.tenantId, id, 'leave-year.deleted');
    expect(payload?.year).toBe(2027);
    expect(payload?.reasons).toEqual(['wrongly_created']);
    expect((payload?.before as { status?: string } | null)?.status).toBe('draft');
  });

  it('an opened year is refused (leaveYearNotDraft)', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2027 });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    await expect(deleteLeaveYear(a, { year: 2027, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearNotDraft',
    });
    expect(await configRow(2027)).toBeTruthy();
  });

  it('a ledger row dated inside the year blocks deletion (leaveYearHasLedger)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    await upsertLeaveYearConfig(a, { year: 2027 });
    await insertLedgerRow(employmentId, '2027-06-01');
    await expect(deleteLeaveYear(a, { year: 2027, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearHasLedger',
    });
  });

  it('an overlapping PENDING or APPROVED request blocks deletion (leaveYearHasRequests)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    await upsertLeaveYearConfig(a, { year: 2027 });
    await upsertLeaveYearConfig(a, { year: 2028 });
    await insertRequest(employmentId, '2027-02-10', '2027-02-11', 'pending');
    await insertRequest(employmentId, '2028-03-05', '2028-03-05', 'approved');
    await expect(deleteLeaveYear(a, { year: 2027, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearHasRequests',
    });
    await expect(deleteLeaveYear(a, { year: 2028, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearHasRequests',
    });
  });

  it('REJECTED / CANCELLED-only requests do NOT block deletion (the Step-7 carve-out, tested both ways)', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    await upsertLeaveYearConfig(a, { year: 2029 });
    await insertRequest(employmentId, '2029-04-01', '2029-04-02', 'rejected');
    await insertRequest(employmentId, '2029-07-01', '2029-07-01', 'cancelled');
    // A dead application must not permanently pin an otherwise pristine draft year.
    const res = await deleteLeaveYear(a, { year: 2029, reasons: ['wrongly_created'] });
    expect(res.deleted).toBe(true);
    expect(await configRow(2029)).toBeUndefined();
  });

  it('deleting a year with no record hits the not-found branch (leaveYearNotFound — the double-delete race)', async () => {
    await expect(deleteLeaveYear(adminCtx(b), { year: 2077, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearNotFound',
      message: 'This leave year no longer exists.',
    });
  });

  it('CONSISTENCY: leaveYearsWithRecords equals exactly the set deleteLeaveYear refuses', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hireEmployeeCtx();
    // All years draft, so refusal ⇔ records exist — the two implementations must agree per record kind:
    //   2027 clean · 2028 ledger row · 2029 pending request · 2030 rejected-only (must NOT block) ·
    //   2032 covered only by the MIDDLE of a multi-year request (the old EXTRACT(YEAR) start/end
    //   derivation missed exactly this year while the service still refused it).
    for (const year of [2027, 2028, 2029, 2030, 2032]) await upsertLeaveYearConfig(a, { year });
    await insertLedgerRow(employmentId, '2028-03-01');
    await insertRequest(employmentId, '2029-05-05', '2029-05-06', 'pending');
    await insertRequest(employmentId, '2030-02-02', '2030-02-03', 'rejected');
    await insertRequest(employmentId, '2031-12-30', '2033-01-02', 'pending');

    const blockedList = (await leaveYearsWithRecords(a)).sort();
    const refused: number[] = [];
    for (const year of [2027, 2028, 2029, 2030, 2032]) {
      try {
        await deleteLeaveYear(a, { year, reasons: ['wrongly_created'] });
      } catch {
        refused.push(year);
      }
    }
    expect(blockedList).toEqual([2028, 2029, 2032]);
    expect(refused).toEqual(blockedList);
  });

  it('AUDIT_HASH_CHAIN_ENABLED: leave-year.deleted joins the tenant hash chain', async () => {
    const a = adminCtx(b);
    const { id } = await upsertLeaveYearConfig(a, { year: 2034 });
    const saved = process.env.AUDIT_HASH_CHAIN_ENABLED;
    process.env.AUDIT_HASH_CHAIN_ENABLED = '1';
    try {
      await deleteLeaveYear(a, { year: 2034, reasons: ['duplicate'] });
    } finally {
      if (saved === undefined) delete process.env.AUDIT_HASH_CHAIN_ENABLED;
      else process.env.AUDIT_HASH_CHAIN_ENABLED = saved;
    }
    const rows = await owner.db
      .select({ hash: schema.domainEvent.hash, chainSeq: schema.domainEvent.chainSeq })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.aggregateId, id),
          eq(schema.domainEvent.eventType, 'leave-year.deleted'),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].chainSeq).not.toBeNull();
  });

  it('open → close → reopen: Guard 1 (ledger) still blocks deleting the re-drafted year', async () => {
    const a = adminCtx(b);
    await hireEmployeeCtx(); // pre-2027 hire ⇒ opening 2027 posts a grant at 2027-01-01
    await upsertLeaveYearConfig(a, { year: 2027 });
    await setLeaveYearStatus(a, { year: 2027, status: 'open' });
    await setLeaveYearStatus(a, { year: 2027, status: 'closed' });
    await setLeaveYearStatus(a, { year: 2027, status: 'draft' }); // the row's "Reopen" action
    // The reopened year passes the STATUS check again, so its safety rests ENTIRELY on Guard 1 finding
    // the grant-sweep ledger rows. openLeaveYear posts grants at effectiveOn = 1-Jan-of-year, so the
    // guard holds today — but if a future grant path (pro-rated joiner, advance-window automation) ever
    // dates a row OUTSIDE the calendar year, this guard silently opens and deleting the year orphans
    // those grants with no FK to catch it. That is why this sequence is pinned here.
    await expect(deleteLeaveYear(a, { year: 2027, reasons: ['wrongly_created'] })).rejects.toMatchObject({
      code: 'leaveYearHasLedger',
    });
    expect(await configRow(2027)).toBeTruthy();
  });
});

// ── Deletion reasons (feedback f1701466) ─────────────────────────────────────
// Every delete now requires ≥1 allow-listed reason ('wrongly_created' / 'duplicate'), validated LAST —
// after the block guards — so a genuinely blocked year always reports its true block message even on a
// forged/reason-less POST, and a stale blocked-rendered button that posts against a now-deletable year
// hits the reasons error instead of silently deleting. The deduped reasons are recorded on the
// leave-year.deleted event (deleted-by + timestamp already ride the DomainEvent actor/createdAt).
describe('deleteLeaveYear — deletion reasons (f1701466)', () => {
  it('a far-future draft year deletes with a valid reason; payload carries reasons + before-state; actor is the admin', async () => {
    const a = adminCtx(b);
    // 2098: Guard 1 scans the tenant's ENTIRE calendar year (not scoped to the config row), so a
    // far-future year keeps the happy path clear of any ledger rows other setup might seed.
    const { id } = await upsertLeaveYearConfig(a, { year: 2098 });
    const res = await deleteLeaveYear(a, { year: 2098, reasons: ['wrongly_created'] });
    expect(res).toEqual({ deleted: true, year: 2098 });
    expect(await configRow(2098)).toBeUndefined();
    const payload = await latestEventPayload(b.tenantId, id, 'leave-year.deleted');
    expect(payload?.reasons).toEqual(['wrongly_created']);
    expect((payload?.before as { status?: string } | null)?.status).toBe('draft');
    // Audit trail: deleted-by is the acting admin (not SYSTEM), timestamp rides created_at.
    const [ev] = await owner.db
      .select({ actorType: schema.domainEvent.actorType, actorId: schema.domainEvent.actorId })
      .from(schema.domainEvent)
      .where(
        and(
          eq(schema.domainEvent.tenantId, b.tenantId),
          eq(schema.domainEvent.aggregateId, id),
          eq(schema.domainEvent.eventType, 'leave-year.deleted'),
        ),
      );
    expect(ev.actorType).toBe('user');
    expect(ev.actorId).toBe(b.adminUserId);
  });

  it('empty reasons are refused (leaveYearReasonsRequired) and the row survives', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2098 });
    await expect(deleteLeaveYear(a, { year: 2098, reasons: [] })).rejects.toMatchObject({
      name: 'LeaveYearDeleteError',
      code: 'leaveYearReasonsRequired',
      message: 'Select at least one deletion reason.',
    });
    expect(await configRow(2098)).toBeTruthy();
  });

  it('a non-allowlist reason is refused; a duplicated reason dedupes to one in the payload', async () => {
    const a = adminCtx(b);
    const { id } = await upsertLeaveYearConfig(a, { year: 2098 });
    await expect(deleteLeaveYear(a, { year: 2098, reasons: ['bogus'] })).rejects.toMatchObject({
      code: 'leaveYearReasonsRequired',
    });
    expect(await configRow(2098)).toBeTruthy();
    // Dedupe: the same reason posted twice (forged form) records once.
    await deleteLeaveYear(a, { year: 2098, reasons: ['wrongly_created', 'wrongly_created'] });
    const payload = await latestEventPayload(b.tenantId, id, 'leave-year.deleted');
    expect(payload?.reasons).toEqual(['wrongly_created']);
  });

  it('an OPEN and a CLOSED year are both refused with the reworded not-draft message', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2098 });
    await upsertLeaveYearConfig(a, { year: 2099 });
    await setLeaveYearStatus(a, { year: 2098, status: 'open' });
    await setLeaveYearStatus(a, { year: 2099, status: 'open' });
    await setLeaveYearStatus(a, { year: 2099, status: 'closed' });
    const expected = {
      code: 'leaveYearNotDraft',
      message:
        'This leave year cannot be deleted because it has been opened or closed. Only a draft year can be removed.',
    };
    await expect(deleteLeaveYear(a, { year: 2098, reasons: ['wrongly_created'] })).rejects.toMatchObject(expected);
    await expect(deleteLeaveYear(a, { year: 2099, reasons: ['duplicate'] })).rejects.toMatchObject(expected);
  });

  it('GUARD ORDER: an open year + empty reasons reports the open-block message, not the reasons error', async () => {
    const a = adminCtx(b);
    await upsertLeaveYearConfig(a, { year: 2098 });
    await setLeaveYearStatus(a, { year: 2098, status: 'open' });
    await expect(deleteLeaveYear(a, { year: 2098, reasons: [] })).rejects.toMatchObject({
      code: 'leaveYearNotDraft',
    });
  });
});
