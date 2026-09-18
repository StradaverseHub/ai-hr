/**
 * 39136455 — Emergency Leave: stop mirroring the pool's figures, and show the transfer as its own columns.
 *
 * THIS PARTLY REVERSES r209, AND THE REVERSAL IS THE POINT. r209 gave every member of a pooled balance the
 * SOURCE's figures, because before it a borrower showed its own permanently empty ledger (Emergency Leave
 * 0.00, beside an Annual balance it could in fact spend) with nothing naming the connection. That fixed the
 * readable half and made the other half impossible: with Annual's figures mirrored onto it, there was no way
 * to see how much Emergency Leave anybody had actually taken. Share / Pending Share carry what the mirroring
 * hid, so the two halves ship together.
 *
 * ⚠️ MONEY-ADJACENT. Annual leave feeds encashment and final pay. NOTHING about the LEDGER changes here —
 * this is an attribution and a display, and the tests below assert that in both directions: the pool's own
 * ledger total must be byte-identical, and the members' balances must sum to it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { decideLeave, requestLeave } from '../core/leave';

let b: Base;

const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; balanceSourceTypeId?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      // `code` is NOT NULL and unique per tenant; the seed already owns AL / ML / EL, so these are their own.
      code: `P${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Pool Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Pooled', primaryEmail: `pool_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

/** The signed ledger total for one (employment, leave type) — the authoritative figure nothing here may move. */
const ledgerTotal = async (employmentId: string, leaveTypeId: string): Promise<number> => {
  const [row] = await owner.db
    .select({ n: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)),
    );
  return Number(row.n);
};

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

/** A pool of 16 days with one borrower, the production shape (Emergency Leave drawing on Annual Leave). */
async function poolOf16() {
  // Unique names: the seed already holds an Annual and a Medical type, and leave_type names are unique
  // per tenant. The pooling behaviour under test is keyed on balance_source_type_id, never on a name.
  const pool = await leaveTypeRow({ name: uniq('Pool Annual') });
  const borrower = await leaveTypeRow({ name: uniq('Pool Emergency'), balanceSourceTypeId: pool });
  const { employmentId } = await hire();
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: pool,
    entryType: 'accrual',
    days: '16.00',
    effectiveOn: '2026-01-01',
  });
  return { pool, borrower, employmentId };
}

const rowsById = async (employmentId: string) => {
  const rows = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true });
  return new Map(rows.map((r) => [r.leaveTypeId, r]));
};

describe('39136455 · the borrower stops wearing the pool’s entitlement', () => {
  it('Full Entitlement and Earned to Date are the borrower’s OWN — which is nothing', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    const byId = await rowsById(employmentId);

    expect(byId.get(borrower)!.accrued, 'a borrower has earned nothing of its own').toBe(0);
    expect(byId.get(borrower)!.balance, 'a borrower holds no balance of its own').toBe(0);
    expect(byId.get(pool)!.accrued, 'the pool keeps its own').toBe(16);
    expect(byId.get(pool)!.balance).toBe(16);
  });

  /**
   * THE TRAP THIS CHANGE IS ONE CARELESS LINE AWAY FROM. `balance` and `available` answer different
   * questions: `balance` is "what does this code hold" (nothing — it borrows) and `available` is "how much
   * can this person still book against it" (the pool's). The submit guard and the apply form read
   * `available`; zeroing it alongside `balance` would make Emergency Leave unapplyable for everybody.
   */
  it('AVAILABLE STAYS POOLED even though Balance is 0 — or nobody could apply for the borrowing type', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    const byId = await rowsById(employmentId);
    expect(byId.get(borrower)!.available, 'the borrower can still book the pool').toBe(16);
    expect(byId.get(pool)!.available).toBe(16);
  });
});

describe('39136455 · Taken lands on the code it was filed under, and Share carries the transfer', () => {
  it('an approved application on the BORROWER counts as the borrower’s Taken, not the pool’s', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    const ctx = adminCtx(b);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: borrower,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    const byId = await rowsById(employmentId);
    expect(byId.get(borrower)!.taken, 'the days show on the code the employee chose').toBe(2);
    expect(byId.get(pool)!.taken, 'and NOT on the pool, which is the whole complaint').toBe(0);

    // …and the transfer is visible from both sides, equal and opposite.
    expect(byId.get(borrower)!.share).toBe(2);
    expect(byId.get(pool)!.share).toBe(-2);
  });

  it('a PENDING application shows as Pending Share, not yet as Share', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId: borrower,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: '2026-05-01',
    });

    const byId = await rowsById(employmentId);
    expect(byId.get(borrower)!.pendingShare).toBe(3);
    expect(byId.get(pool)!.pendingShare).toBe(-3);
    expect(byId.get(borrower)!.share, 'nothing is finalised until it is approved').toBe(0);
    expect(byId.get(pool)!.share).toBe(0);
    // Pending is the reservation filed under THIS code…
    expect(byId.get(borrower)!.pending).toBe(3);
    expect(byId.get(pool)!.pending, 'the pool reserved nothing of its own').toBe(0);
    // …but it still reduces what EVERY member can book, which is r209's claim and still true.
    expect(byId.get(pool)!.available).toBe(13);
    expect(byId.get(borrower)!.available).toBe(13);
  });

  it('an application on the POOL itself is the pool’s Taken and is no share at all', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    const ctx = adminCtx(b);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: pool,
      startDate: '2026-06-01',
      endDate: '2026-06-01',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    const byId = await rowsById(employmentId);
    expect(byId.get(pool)!.taken).toBe(1);
    expect(byId.get(pool)!.share, 'the pool lent nothing out').toBe(0);
    expect(byId.get(borrower)!.share).toBe(0);
  });
});

describe('39136455 · nothing about the money moved', () => {
  /**
   * THE INVARIANT. Across a pool the shares cancel — the source's −N is exactly the borrowers' +N — so the
   * members' balances sum to the pool's own ledger total. If this ever fails, the derivation invented or
   * destroyed days, which on Annual Leave reaches encashment and final pay.
   */
  it('the members’ balances sum to the pool’s ledger total, before and after a borrowed day', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    const ctx = adminCtx(b);

    let byId = await rowsById(employmentId);
    expect(byId.get(pool)!.balance + byId.get(borrower)!.balance).toBe(await ledgerTotal(employmentId, pool));

    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: borrower,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
      today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    byId = await rowsById(employmentId);
    const ledger = await ledgerTotal(employmentId, pool);
    expect(ledger, 'the pool’s ledger is where the days actually live').toBe(14);
    expect(byId.get(pool)!.balance + byId.get(borrower)!.balance, 'shares cancel across the pool').toBe(ledger);
    // The borrower's own arithmetic closes too: 0 entitlement + 2 shared in − 2 taken = 0.
    const bor = byId.get(borrower)!;
    expect(bor.balance).toBe(bor.accrued + bor.share - bor.taken);
  });

  it('a leave type OUTSIDE any pool is untouched — it shares nothing, in either column', async () => {
    const outsider = await leaveTypeRow({ name: uniq('Unpooled Medical') });
    const { employmentId } = await hire();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: outsider,
      entryType: 'accrual',
      days: '14.00',
      effectiveOn: '2026-01-01',
    });

    const byId = await rowsById(employmentId);
    const row = byId.get(outsider)!;
    expect(row.balance, 'its own ledger, exactly as before').toBe(14);
    expect(row.share, 'an honest 0.00, not a null').toBe(0);
    expect(row.pendingShare).toBe(0);
    expect(row.sharedBalance).toBeNull();
  });

  it('a ledger row with NO request behind it (a grant, a carry) belongs to the pool, never to a share', async () => {
    const { pool, borrower, employmentId } = await poolOf16();
    // An HR adjustment on the pool: no source_request_id, so it can be nobody's share.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId,
      leaveTypeId: pool,
      entryType: 'adjustment',
      days: '2.00',
      effectiveOn: '2026-02-01',
    });

    const byId = await rowsById(employmentId);
    expect(byId.get(pool)!.balance).toBe(18);
    expect(byId.get(pool)!.share, 'an adjustment is not a transfer').toBe(0);
    expect(byId.get(borrower)!.share).toBe(0);
    expect(byId.get(borrower)!.balance).toBe(0);
  });
});
