/**
 * 2a237f5f (r332) — THE LEAVE CREDIT REQUEST'S LEAVE TYPE IS ALWAYS REPLACEMENT LEAVE.
 *
 * The reported defect: My Leave → Leave Credit Request offered a Leave type dropdown listing every type the
 * employee was eligible for. THE POSTED VALUE WAS ALREADY DEAD, which is the finding under the finding —
 * `core/replacement-request.ts` stores it on `replacement_leave_request.leave_type_id` and nothing reads it
 * back; `core/toil.ts` credits `ensureReplacementLeaveType(tx, ctx.tenantId)` whatever was posted, and the
 * reversal path takes the type off the ledger row the credit wrote. So the form was collecting an answer the
 * engine discards — the same defect class as the Shift form's working days (aec53564, r331).
 *
 * WHAT THIS FILE DEFENDS IS THE RESOLVER, not the markup (the dialog itself is pinned in
 * test/r332-leave-credit-fixed-type.dom.test.tsx). Two claims, and they are the ones a screen can get wrong:
 *
 *   1. IT RESOLVES THE RIGHT TYPE. Matching on the code alone would miss production's own replacement type,
 *      which is coded `RL` under `role = 'replacement'` (5ff7daff). The canonical predicate is role-first
 *      with the seeded code as the fallback for an unclassified row, and it is stated twice — in SQL
 *      (`findReplacementLeaveTypeIdTx`) and in memory (`pickReplacementLeaveType`, for callers that have
 *      already loaded the catalogue, because core/ess-view.ts must stay importable by client components).
 *      Every case below asserts BOTH, and asserts they agree: two statements of one rule is exactly the
 *      shape that drifts, so the agreement is the thing under test, not a bonus.
 *
 *   2. IT NEVER CREATES ANYTHING. `ensureReplacementLeaveType` is `ensure`, not `find`: on a miss it INSERTS
 *      a leave type. That is right at approval time and is not acceptable as a side effect of drawing a
 *      page. The zero case below counts `leave_type` across the read and asserts the count did not move —
 *      and then makes a real accrual on the SAME tenant and asserts the count DOES move, so the read-only
 *      claim is a measured difference rather than a count that was never going to change.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { checkIn, checkOut } from '../core/attendance';
import { accrueToil, findReplacementLeaveTypeIdTx, setToilPolicy, type ToilPolicyInput } from '../core/toil';
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '../core/replacement-request';
import { pickReplacementLeaveType } from '../core/ess-view';
import { listLeaveTypes } from '../core/read';

let b: Base;
let ctx: SessionContext;

const REST_DAY = '2026-07-04'; // a Saturday; setRestDay makes it a rostered rest day regardless
const uniqEmail = () => `r332_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/** How many leave types this tenant holds, read as the MIGRATION role: a count taken through RLS with no
 *  tenant context is 0, which would make "unchanged" true for the wrong reason (CLAUDE.md §5). */
async function leaveTypeCount(): Promise<number> {
  const [row] = await owner.db
    .select({ n: sql<string>`count(*)` })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.tenantId, b.tenantId));
  return Number(row?.n ?? 0);
}

/** Add one leave type to the base tenant's catalogue, exactly as an HR admin's own catalogue would carry it. */
async function addType(p: { code: string; name: string; role?: string | null; archived?: boolean }): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: p.code,
      name: p.name,
      role: (p.role ?? null) as never,
      paid: true,
      archivedAt: p.archived ? new Date() : null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** The SQL resolver the ENGINE's `ensureReplacementLeaveType` is built on, run for this tenant. */
const resolvedBySql = () => withTenant(ctx, (tx) => findReplacementLeaveTypeIdTx(tx, b.tenantId));

/** The in-memory resolver the LEAVE PAGE uses, over the same catalogue read the page makes. */
async function resolvedInMemory() {
  const types = await listLeaveTypes(ctx, { includeArchived: false });
  return pickReplacementLeaveType(types);
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
  await setModule(b.tenantId, 'toil', 'active');
  ctx = await entitledCtx(b);
});

describe('2a237f5f: which leave type the Leave Credit request names', () => {
  it('picks the replacement type and NO other, out of a catalogue full of types the employee holds', async () => {
    // The reported screen listed every one of these. An employee eligible for six types must still be
    // offered exactly one credit target, and it must be the replacement one.
    await addType({ code: 'SICK', name: 'Sick Leave' });
    await addType({ code: 'MATERNITY', name: 'Maternity Leave' });
    await addType({ code: 'UNPAID', name: 'Unpaid Leave' });
    await addType({ code: 'COMPASSIONATE', name: 'Compassionate Leave' });
    const rlId = await addType({ code: 'REPLACEMENT', name: 'Replacement Leave' });

    const catalogue = await listLeaveTypes(ctx, { includeArchived: false });
    expect(catalogue.length, 'the catalogue really does hold several types').toBeGreaterThanOrEqual(6);

    const picked = await resolvedInMemory();
    expect(picked?.id).toBe(rlId);
    expect(picked?.name).toBe('Replacement Leave');
    // …and the ENGINE would credit the very same row. Two resolvers, one answer.
    expect(await resolvedBySql()).toBe(rlId);
  });

  it('resolves a tenant whose replacement type carries the ROLE under a RENAMED code', async () => {
    // Production's own type is coded `RL`, not `REPLACEMENT` (5ff7daff). A screen filtering by code alone
    // would find nothing here and offer the employee no credit target at all — precisely the drift the
    // role marker exists to survive. The NAME matters as much as the id: the fixed box reads the tenant's
    // own words, so a customer who calls it "Off in Lieu" must not be shown "Replacement Leave".
    const rlId = await addType({ code: 'RL', role: 'replacement', name: 'Off in Lieu' });

    const picked = await resolvedInMemory();
    expect(picked?.id).toBe(rlId);
    expect(picked?.name).toBe('Off in Lieu');
    expect(await resolvedBySql()).toBe(rlId);
  });

  it('breaks a tie ROLE-FIRST when a tenant carries both a classified and an unclassified candidate', async () => {
    // 5ff7daff's own wreckage: the auto-created `REPLACEMENT` type sitting beside the customer's classified
    // one. Both satisfy the predicate, so "the first match" is not an answer — the ORDER is the rule. The
    // unclassified row is added FIRST and sorts first alphabetically ("Aged…"), so a resolver that took the
    // head of the page's name-sorted catalogue would pick it and this case would fail.
    await addType({ code: 'REPLACEMENT', name: 'Aged auto-created Replacement Leave (in lieu)' });
    const classified = await addType({ code: 'RL', role: 'replacement', name: 'Zulu Replacement Leave' });

    const picked = await resolvedInMemory();
    expect(picked?.id).toBe(classified);
    expect(await resolvedBySql()).toBe(classified);
  });

  it('ignores an ARCHIVED replacement type, exactly as the engine does', async () => {
    await addType({ code: 'RL', role: 'replacement', name: 'Retired Off in Lieu', archived: true });
    expect(await resolvedInMemory()).toBeNull();
    expect(await resolvedBySql()).toBeNull();
  });
});

describe('2a237f5f: a tenant with no Replacement Leave type', () => {
  it('resolves to null — which is what leaves the dialog unrendered rather than empty', async () => {
    // The base fixture's catalogue is Annual Leave and nothing else. Before this item the dialog rendered
    // here anyway, with a <select> carrying neither `required` nor a placeholder, so it offered Annual
    // Leave as a "credit target" and would post an id the engine ignores. Now there is nothing to name,
    // the page's `replacementLeaveType != null` guard is false, and no control is drawn at all.
    await addType({ code: 'SICK', name: 'Sick Leave' });
    expect(await resolvedInMemory()).toBeNull();
    expect(await resolvedBySql()).toBeNull();
  });

  it('AND THE READ CREATES NOTHING — the count is unchanged, and an accrual on the same tenant moves it', async () => {
    // `ensure` is not `find`. This is the difference stated as a measurement rather than as a comment:
    // the resolver the render path calls leaves the catalogue exactly as it found it, and the approval
    // path — which calls `ensureReplacementLeaveType` — adds the row the read declined to add.
    const before = await leaveTypeCount();
    // The count is asserted IMMEDIATELY after each read, so it is this read that is on trial. Asserting it
    // once at the end would let a later read see a row the earlier one wrote and fail on the wrong line.
    expect(await resolvedBySql()).toBeNull();
    expect(await leaveTypeCount(), 'the SQL resolver must not create a leave type').toBe(before);
    expect(await resolvedInMemory()).toBeNull();
    expect(await leaveTypeCount(), 'drawing the page must not create a leave type').toBe(before);

    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Lieu Worker', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 8000, // above the First Schedule ceiling: no consent gate in the way of this measurement
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
    await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
    await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
    await setToilPolicy(ctx, policy(b.companyId));
    await accrueToil(ctx, { employmentId: e.employmentId, workedDate: REST_DAY });

    expect(await leaveTypeCount(), 'the APPROVAL path is what creates it').toBe(before + 1);
    // …and now that it exists, the read-only resolvers find it — still without writing anything.
    const created = await resolvedBySql();
    expect(created).not.toBeNull();
    expect((await resolvedInMemory())?.id).toBe(created);
    expect(await leaveTypeCount()).toBe(before + 1);
  });
});

describe('2a237f5f: the stored leave_type_id, and why the form still posts one', () => {
  /** Hire above the First Schedule ceiling and switch employee requests on. */
  async function requester() {
    const e = await hireEmployee(ctx, {
      person: { fullName: 'RL Requester', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: e.employmentId,
      basicSalary: 8000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });
    await setToilPolicy(ctx, policy(b.companyId, { employeeRequestEnabled: true }));
    return e.employmentId;
  }

  it('a request submitted with the RESOLVED id stores that id — the row keeps naming its type', async () => {
    // THE ONE DELIBERATE DIFFERENCE from the HR-side dialog, which posts nothing at all: this form still
    // sends the resolved id, because `replacement_leave_request.leave_type_id` is populated on the rows
    // already in production and nulling it on new rows would quietly change stored data nobody asked to
    // change. A regression that dropped the hidden input would write null here.
    const rlId = await addType({ code: 'RL', role: 'replacement', name: 'Off in Lieu' });
    expect(await resolvedBySql()).toBe(rlId);

    const employmentId = await requester();
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      leaveTypeId: rlId, // exactly what the dialog's hidden input carries
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1 }],
      today: '2026-07-20',
    });

    const [row] = await owner.db
      .select({ leaveTypeId: schema.replacementLeaveRequest.leaveTypeId })
      .from(schema.replacementLeaveRequest)
      .where(eq(schema.replacementLeaveRequest.id, requestId));
    expect(row.leaveTypeId).toBe(rlId);
  });

  it('…and the posted value never decided the credit, which is the finding the form was hiding', async () => {
    // THE DEFECT, MEASURED. Submit naming Sick Leave — something the old dropdown would happily have
    // offered — and the approved credit still lands on the replacement type. Nothing reads the stored
    // column for the grant: `core/toil.ts` resolves the tenant's replacement type itself. This is why
    // taking the dropdown away changes no behaviour at all; it only stops the form asking a dead question.
    const rlId = await addType({ code: 'RL', role: 'replacement', name: 'Off in Lieu' });
    const sickId = await addType({ code: 'SICK', name: 'Sick Leave' });

    const employmentId = await requester();
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      leaveTypeId: sickId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1 }],
      today: '2026-07-20',
    });
    await decideReplacementLeaveRequest(ctx, {
      requestId,
      decision: 'approved',
      decidedAt: new Date('2026-07-25T03:00:00.000Z'),
    });

    const ledger = await owner.db
      .select({ leaveTypeId: schema.leaveLedger.leaveTypeId, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.entryType, 'in_lieu_accrual')));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].leaveTypeId, 'the engine credits the replacement type, never the posted one').toBe(rlId);
    expect(ledger[0].leaveTypeId).not.toBe(sickId);
    // …while the request row still records what was posted, untouched by the grant.
    const [req] = await owner.db
      .select({ leaveTypeId: schema.replacementLeaveRequest.leaveTypeId })
      .from(schema.replacementLeaveRequest)
      .where(eq(schema.replacementLeaveRequest.id, requestId));
    expect(req.leaveTypeId).toBe(sickId);
  });
});
