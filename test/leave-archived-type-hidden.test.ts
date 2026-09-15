/**
 * ec991c2a — "Archived Leave Types Must Not Appear Anywhere".
 *
 * An administrator archived Annual Leave and it kept appearing in the employee's My Leave balance list.
 * `leaveBalances`' two ledger/pending selects join `leave_type` with no `archived_at` predicate, so any
 * type the employee had HISTORY under kept sitting beside the live ones. (The third tail — eligible but
 * inactive — has read the non-archived catalogue since R18, so it was never the leak.)
 *
 * WHAT THESE TESTS PIN, and the boundary matters as much as the fix:
 *
 *   ABSENT   an archived type is gone from the employee's balance list, whether it got there by ledger
 *            row or by pending request, and gone from the Apply Leave dropdown.
 *   PRESENT  an ACTIVE type with a ZERO balance is still listed. Hiding zero-balance types would be a
 *            different and unrequested change, and on production `*Medical Leave` sits at 0.00 for most
 *            people — so this arm is not hypothetical.
 *   ADMIN    `includeArchived: true` still returns the archived type WITH its real figure. Production has
 *            ANNUAL archived with 759 days across 55 employments; HR must still be able to look them up.
 *   HISTORY  a past APPROVED request under the archived type still appears in leave history. This item
 *            hides a type from the lists an employee CHOOSES from; it does not rewrite what they took.
 *
 * THE APPLY-DROPDOWN ARM WAS ALREADY CORRECT BEFORE THIS CHANGE, and is pinned here anyway rather than
 * claimed as new work: `listEligibleLeaveTypesFor` has carried `isNull(leaveType.archivedAt)` in its own
 * `where` all along, and the item's build notes misread `app/leave/page.tsx`'s `listLeaveTypes` call as
 * the dropdown's source — that call feeds `unpaidTypeName`, the EditLeaveDialog list and the
 * replacement-leave notice, and `listLeaveTypes` excludes archived types by default anyway. The guard is
 * a regression guard on a behaviour two independent reads now depend on, and it does fail if that
 * predicate is removed (verified by reverting it).
 */
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances, leaveRequestsFor, listEligibleLeaveTypesFor } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

/** Codes are unique to this file so nothing collides with whatever `seedBase` puts in the catalogue. */
const ARCHIVED = 'R287_ARCH'; // archived, and the employee HAS history under it
const ACTIVE_ZERO = 'R287_ZERO'; // active, no ledger row at all → must still list at 0.00
const ACTIVE_HELD = 'R287_HELD'; // active, with a ledger balance → the control

async function hire() {
  return hireEmployee(adminCtx(b), {
    person: { fullName: 'Arch', primaryEmail: `arch_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

async function makeType(code: string, archived: boolean) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
      // The ONE difference between these types. Everything else is identical, so a row that is present for
      // one and absent for the other cannot be explained by anything but the archive flag.
      archivedAt: archived ? new Date('2026-09-15T00:00:00Z') : null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function accrue(employmentId: string, leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

const balanceNames = async (employmentId: string, includeArchived?: boolean) =>
  new Set(
    (
      await leaveBalances(
        adminCtx(b),
        employmentId,
        undefined,
        includeArchived == null ? {} : { includeArchived },
      )
    ).map((r) => r.leaveType),
  );

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

describe('ec991c2a — the employee balance list drops archived types and keeps zero-balance active ones', () => {
  it('BOTH ARMS: archived-with-a-balance is ABSENT, active-at-zero is PRESENT', async () => {
    const emp = await hire();
    const archivedId = await makeType(ARCHIVED, true);
    await makeType(ACTIVE_ZERO, false);
    const heldId = await makeType(ACTIVE_HELD, false);
    await accrue(emp.employmentId, archivedId, '6.00');
    await accrue(emp.employmentId, heldId, '8.00');

    const rows = await leaveBalances(adminCtx(b), emp.employmentId);
    const names = new Set(rows.map((r) => r.leaveType));

    // ARM 1 — the defect. Six days of a retired type were being shown beside the live ones.
    expect(names.has(ARCHIVED)).toBe(false);

    // ARM 2 — the boundary. An ACTIVE type nobody has accrued anything under is still on the list at 0.00.
    // Asserted on the ROW and not just on membership: "present" has to mean present with its real figure,
    // or a future change that zeroed every row would still pass this.
    expect(names.has(ACTIVE_ZERO)).toBe(true);
    const zero = rows.find((r) => r.leaveType === ACTIVE_ZERO)!;
    expect(zero.balance).toBe(0);
    expect(zero.available).toBe(0);

    // …and the ordinary case is untouched: an active type with a balance still reads its balance.
    const held = rows.find((r) => r.leaveType === ACTIVE_HELD)!;
    expect(held.balance).toBe(8);
    expect(held.available).toBe(8);
  });

  it('the PENDING-only tail is covered too — an archived type reached by request alone is ABSENT', async () => {
    // `out` has three entry points and the gate is one choke point; this is the second of them. A type with
    // a pending request but no ledger row was pushed by the pending tail, not by the ledger select, so a
    // fix written into the ledger `where` alone would pass the test above and fail here.
    const emp = await hire();
    const archivedId = await makeType(ARCHIVED, true);
    await makeType(ACTIVE_ZERO, false);
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: archivedId,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      days: '2.00',
      status: 'pending',
    });

    const names = await balanceNames(emp.employmentId);
    expect(names.has(ARCHIVED)).toBe(false);
    expect(names.has(ACTIVE_ZERO)).toBe(true);
  });

  it('ADMIN reads are NOT filtered: includeArchived returns the archived type with its real figure', async () => {
    const emp = await hire();
    const archivedId = await makeType(ARCHIVED, true);
    await accrue(emp.employmentId, archivedId, '6.00');

    const rows = await leaveBalances(adminCtx(b), emp.employmentId, undefined, {
      includeHidden: true,
      includeArchived: true,
    });
    const row = rows.find((r) => r.leaveType === ARCHIVED);
    expect(row).toBeDefined();
    expect(row!.balance).toBe(6);
    expect(row!.available).toBe(6);

    // And the flag is genuinely doing the work — the same read without it does not carry the row.
    expect((await balanceNames(emp.employmentId, false)).has(ARCHIVED)).toBe(false);
  });
});

describe('ec991c2a — the Apply Leave dropdown', () => {
  it('offers the active type and never the archived one', async () => {
    const emp = await hire();
    await makeType(ARCHIVED, true);
    await makeType(ACTIVE_ZERO, false);

    const offered = new Set(
      (await listEligibleLeaveTypesFor(adminCtx(b), emp.employmentId)).map((t) => t.name),
    );
    expect(offered.has(ARCHIVED)).toBe(false);
    // The same boundary as the balance list: a type with no accrual is still applicable for.
    expect(offered.has(ACTIVE_ZERO)).toBe(true);
  });
});

describe('ec991c2a — history is NOT touched', () => {
  it('a past APPROVED request under an archived type still appears in leave history', async () => {
    // The reporter was told, in the approved plan, that "any leave already applied for or approved under an
    // archived type keeps its history". That promise is this test. `leaveRequestsFor` joins `leave_type`
    // with no archived predicate and must keep it that way — the balance gate lives in `leaveBalances`
    // alone, and a later "tidy-up" that pushed it down into the shared join would silently erase what
    // people have already taken.
    const emp = await hire();
    const archivedId = await makeType(ARCHIVED, true);
    // THE ACCRUAL IS LOAD-BEARING AND WAS ADDED AFTER THE FIRST NON-VACUITY RUN. Without it the
    // "absent from the balance list" assertion below passes with the fix reverted: an APPROVED request
    // enters none of `leaveBalances`' three tails (the pending select is `status = 'pending'`, and the
    // eligible tail has never carried archived types), so the type was absent for a reason that had
    // nothing to do with this change. A ledger row puts it in the list, which is what makes the two
    // assertions in this test a real pair — history keeps it, the balance list drops it.
    await accrue(emp.employmentId, archivedId, '10.00');
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: archivedId,
      startDate: '2026-03-02',
      endDate: '2026-03-03',
      days: '2.00',
      status: 'approved',
    });

    const history = await leaveRequestsFor(adminCtx(b), emp.employmentId);
    const taken = history.filter((r) => r.leaveType === ARCHIVED);
    expect(taken).toHaveLength(1);
    expect(taken[0].status).toBe('approved');
    expect(Number(taken[0].days)).toBe(2);

    // …while that same type is absent from the list they would choose from next time. Both at once is the
    // whole shape of this item, so both are asserted against ONE employment in ONE test.
    expect((await balanceNames(emp.employmentId)).has(ARCHIVED)).toBe(false);

    // Nothing was deleted or recalculated on either side: archiving hides, it never removes. The request
    // row and the ledger row under the archived type are both still there.
    const requests = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.leaveTypeId, archivedId));
    expect(requests).toHaveLength(1);
    const ledger = await owner.db
      .select({ days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.leaveTypeId, archivedId));
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].days)).toBe(10);
  });
});

describe('ec991c2a — which surface asks for which answer, pinned across both files', () => {
  /**
   * SOURCE SHAPE, AND THE REASON IT HAS TO BE. The defect lives in the CONTRACT between core/read.ts's
   * default and what each screen asks of it, and these four call sites are RSC page/module bodies: running
   * them needs a Next request scope (`cookies()`, `getLocale()`, `getSession()`) that no node test provides,
   * so the only way to pin which flag each one passes is to read the file. That is deliberate here, not
   * laziness — the behavioural arms above are all executed against a real database.
   *
   * This mirrors the identical guard 994a5287 wrote for `includeHidden` in
   * test/leave-balances-all-types.test.ts, and exists for the same reason: two admin screens answering
   * "what is this person entitled to" differently would be worse than either answer on its own.
   */
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('both ADMIN balance surfaces opt in, so they cannot tell different stories', () => {
    expect(read('../app/leave/employee-balances/rows.ts')).toContain('includeArchived: true');
    expect(read('../app/admin/personnel/[employmentId]/page.tsx')).toContain('includeArchived: true');
  });

  it('the employee-facing call sites are EXPLICIT, so the default can never silently change meaning', () => {
    // The item is explicit that an inherited default is how this defect comes back. Both self-service
    // balance reads state the answer they want rather than relying on `leaveBalances`' default.
    expect(read('../app/leave/page.tsx')).toContain('includeArchived: false');
    expect(read('../app/page.tsx')).toContain('includeArchived: false');
    // …and neither of them opts out of the archived gate.
    expect(read('../app/leave/page.tsx')).not.toContain('includeArchived: true');
    expect(read('../app/page.tsx')).not.toContain('includeArchived: true');
  });

  it('the shared-pool summer is the ONE self-service caller that opts out, and says why', () => {
    // core/leave-shared-group.ts sums member types into a single pooled figure and displays no type name.
    // It must keep summing every member or the number on screen stops matching the engine's verdict — the
    // same argument that already makes it the one self-service caller passing `includeHidden`.
    const shared = read('../core/leave-shared-group.ts');
    expect(shared).toContain('includeArchived: true');
    expect(shared).toContain('includeHidden: true');
  });
});
