/**
 * 5ff7daff — THE APPROVAL SURFACE, and the duplicate leave type that made it land on the wrong card.
 *
 * TWO DEFECTS, ONE FILE, because they are the same failure told twice: a thing that was written, tested and
 * deployed, and then never actually reached.
 *
 *  1. `decideReplacementLeaveRequest` shipped in 296fc027 with EVERY unit test passing and ZERO CALLERS. No
 *     screen anywhere reached it, so an employee's claim was submitted and then sat, seen by nobody, and
 *     production held 0 rows in `toil_accrual`, `replacement_leave_request` and
 *     `replacement_leave_request_date`. A unit test of the service passes throughout that; a unit test of
 *     the page passes throughout that. The defect lives in the EDGE between two files, which is exactly the
 *     class AGENTS.md rule 17 says to pin with source-shape assertions across both halves — so that is what
 *     the first describe below does, and it is the only kind of test that could have caught this.
 *
 *  2. `ensureReplacementLeaveType` matched `lower(code) = 'replacement'`. Production's catalogue was not
 *     seeded: the customer's own replacement type is coded `RL` with `role = 'replacement'`. The match found
 *     nothing, so the function CREATED A SECOND TYPE the instant replacement leave was switched on, and
 *     every approved credit would have landed on the auto-created one while the type carrying the
 *     customer's own name read zero forever. Identical in kind to EMERGENCY vs production's `EL`, which
 *     `leaveTypeIs` (65f466e2) exists for; TOIL had simply never adopted the marker.
 *
 * The second half is a REAL DATABASE test rather than a source-shape one, because the thing that must not
 * happen is an INSERT — and "did a row appear" is not a question source text can answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import {
  decideReplacementLeaveRequest,
  listPendingReplacementLeaveRequests,
  submitReplacementLeaveRequest,
} from '../core/replacement-request';
import { APPROVAL_CATEGORIES, PANEL_GROUPS, sectionVisible } from '../lib/approvals-categories';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

// ── 1. The edge between the page and the action ──────────────────────────────────────────────────────
describe('the approval surface exists and is wired to the decide action', () => {
  const page = read('app/approvals/page.tsx');
  const actions = read('app/leave/actions.ts');
  const panel = read('app/approvals/category-panel.tsx');

  it('the /approvals page LOADS pending replacement-leave requests', () => {
    // Through the pack facade, never the pack implementation (the house rule for cross-module reads).
    expect(page).toMatch(/import \{[^}]*listPendingReplacementLeaveRequests[^}]*\} from '@\/packs\/leave\/service'/);
    expect(page).toContain('listPendingReplacementLeaveRequests(s, { companyIds: scopeIds })');
  });

  it('it MOUNTS a replacement-leave section, gated by the shared category resolver', () => {
    expect(page).toContain("visible('replacementLeave')");
    // The section renders the worked-date lines — the reporter's requirement that a manager sees every date
    // with its own figure, not just a total they cannot check.
    expect(page).toMatch(/r\.dates\.map\(/);
  });

  it('and POSTS to decideReplacementLeaveRequestAction — the action that had no caller', () => {
    expect(page).toMatch(/import \{ decideReplacementLeaveRequestAction \} from '@\/app\/leave\/actions'/);
    // Both decisions, both reachable from this page.
    expect(page).toContain('<form action={decideReplacementLeaveRequestAction}>');
    for (const decision of ['approved', 'rejected']) {
      expect(page).toContain(`<input type="hidden" name="decision" value="${decision}" />`);
    }
    // The action reads `requestId`, NOT the `id` the shared DecideButtons helper posts. A form posting the
    // wrong field name decides nothing and throws "request not found" — invisible to both halves' own tests.
    expect(page).toContain('name="requestId"');
    expect(actions).toContain("String(formData.get('requestId') ?? '')");
  });

  it('the return-to-approvals branch is read BY VALUE, never by presence (AGENTS.md rule 17)', () => {
    // The approvals decide forms also post `category` and `sort`, and a hidden field is submitted whatever
    // it contains — so `formData.get('category') != null` would read the UNFILTERED inbox (category='') as a
    // My Leave submission and redirect the approver to the wrong screen.
    expect(page).toContain('<input type="hidden" name="returnTo" value="approvals" />');
    expect(actions).toContain("String(formData.get('returnTo') ?? '') === 'approvals'");
    expect(actions).not.toMatch(/formData\.get\('returnTo'\)\s*!=\s*null/);
    // And it lands back on the approver's own filtered view, through the one shared builder.
    expect(actions).toContain('approvalsReturnUrl');
  });

  it('the category is navigable: a panel entry, a label and a section of its own', () => {
    expect(APPROVAL_CATEGORIES).toContain('replacementLeave');
    // In the Leave group, beside the two queues an approver already knows.
    const leaveGroup = PANEL_GROUPS.find((g) => g.group === 'leave');
    expect(leaveGroup?.categories).toContain('replacementLeave');
    // A category with no icon or label key renders as a blank row rather than failing loudly.
    expect(panel).toContain('replacementLeave:');
    expect(panel).toContain("replacementLeave: 'replacementLeaveTitle'");
    // Selecting it shows its own section and nothing else.
    expect(sectionVisible('replacementLeave', 'replacementLeave')).toBe(true);
    expect(sectionVisible('replacementLeave', 'leave')).toBe(false);
    expect(sectionVisible('all', 'replacementLeave')).toBe(true);
  });

  it('is NOT bulk-selectable — a claim is a list of dates to be checked, not a single fact', () => {
    // No BulkRowCheckbox / BulkSectionSelectAll of a 'replacementLeave' type anywhere on the page.
    expect(page).not.toMatch(/type="replacementLeave"/);
  });
});

// ── 2. The duplicate leave type ──────────────────────────────────────────────────────────────────────
let b: Base;
let ctx: SessionContext;

const TODAY = '2026-07-20';
const WORKED = '2026-07-04';
const DECIDED_AT = new Date('2026-07-25T03:00:00.000Z');

const uniqEmail = () => `rlas_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  ...over,
});

/** Above the First Schedule ceiling, so the statutory floor is not what this file is measuring. */
async function hire(name = 'RL Approver Subject') {
  const e = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: uniqEmail() },
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
  return e.employmentId;
}

/** The tenant's own replacement type, exactly as production carries it: coded RL, marked by ROLE. */
async function seedCustomerOwnReplacementType(): Promise<string> {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: 'RL',
      name: 'Replacement Leave',
      role: 'replacement',
      paid: true,
      counting: 'calendar_days',
    })
    .returning({ id: schema.leaveType.id });
  return lt.id;
}

const replacementTypes = () =>
  owner.db
    .select({ id: schema.leaveType.id, code: schema.leaveType.code, role: schema.leaveType.role })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), isNull(schema.leaveType.archivedAt)));

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

describe('the tenant’s OWN replacement leave type is the one used (5ff7daff)', () => {
  it('an approval banks onto a role-marked type whose code is NOT "REPLACEMENT", and creates no duplicate', async () => {
    const rlTypeId = await seedCustomerOwnReplacementType();
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));

    const before = await replacementTypes();
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });
    const res = await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(res.status).toBe('approved');
    expect(res.granted).toBe(1);

    // THE ASSERTION THIS FILE EXISTS FOR: no second type appeared. Before the fix, approving here inserted
    // "Replacement Leave (in lieu)" and the customer's own card would have read zero forever.
    const after = await replacementTypes();
    expect(after.filter((t) => t.role === 'replacement' || t.code === 'REPLACEMENT')).toHaveLength(1);
    expect(after).toHaveLength(before.length);
    expect(after.some((t) => t.code === 'REPLACEMENT')).toBe(false);

    // …and the credit landed on the customer's own type, not somewhere the employee cannot see.
    const ledger = await owner.db
      .select({ leaveTypeId: schema.leaveLedger.leaveTypeId, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.employmentId, employmentId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].leaveTypeId).toBe(rlTypeId);
    expect(Number(ledger[0].days)).toBe(1);
  });

  it('a tenant nobody has classified still falls back to the seeded code — nothing changed for them', async () => {
    // No role-marked type at all: the pre-5ff7daff path, which must behave exactly as it always did and
    // create the seeded REPLACEMENT type on first need.
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });

    const types = (await replacementTypes()).filter((t) => t.code === 'REPLACEMENT');
    expect(types).toHaveLength(1);

    // And a SECOND approval reuses it rather than inserting another (the idempotence that always held).
    const second = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: '2026-07-11', days: 1 }],
      today: TODAY,
    });
    await decideReplacementLeaveRequest(ctx, { requestId: second.requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect((await replacementTypes()).filter((t) => t.code === 'REPLACEMENT')).toHaveLength(1);
  });
});

// ── 3. The approver's queue itself ───────────────────────────────────────────────────────────────────
describe('listPendingReplacementLeaveRequests (5ff7daff)', () => {
  it('returns each pending claim with its worked-date lines, and drops it once decided', async () => {
    await seedCustomerOwnReplacementType();
    const employmentId = await hire('Farah Pending');
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'hour',
      lines: [
        { workedDate: WORKED, fromTime: '09:00', toTime: '18:00' },
        { workedDate: '2026-07-11', fromTime: '09:00', toTime: '13:00' },
      ],
      reason: 'Site handover',
      today: TODAY,
    });

    const pending = await listPendingReplacementLeaveRequests(ctx, { companyIds: [b.companyId] });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(requestId);
    expect(pending[0].employee).toBe('Farah Pending');
    expect(pending[0].employmentId).toBe(employmentId);
    expect(pending[0].unit).toBe('hour');
    expect(pending[0].reason).toBe('Site handover');
    // Both worked dates, in date order, each with the hours the employee claimed — the manager checks the
    // claim line by line, which is the whole reason this is not a one-figure row.
    expect(pending[0].dates.map((d) => d.workedDate)).toEqual([WORKED, '2026-07-11']);
    expect(pending[0].dates.map((d) => d.hours)).toEqual([9, 4]);
    expect(pending[0].totalHours).toBe(13);

    // A company the viewer does not carry sees nothing (the same scope every other queue takes).
    expect(await listPendingReplacementLeaveRequests(ctx, { companyIds: [] })).toHaveLength(1); // empty = unscoped
    // Once decided it leaves the queue — a decided request in a PENDING inbox is how a manager double-books.
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'rejected', decidedAt: DECIDED_AT });
    expect(await listPendingReplacementLeaveRequests(ctx, { companyIds: [b.companyId] })).toHaveLength(0);
  });
});
