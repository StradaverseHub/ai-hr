/**
 * r389 · MY LEAVE — Leave Request, Leave History, Leave Credit History (a6a4aa5f, ba039150, bc3e203d).
 *
 * WHAT THIS FILE DEFENDS, in the order the risk sits:
 *
 *  1. WHOSE ROWS. The history and its export list the SIGNED-IN PERSON's requests only — not a colleague's,
 *     not another company's, not another tenant's — and that holds for viewers whom RLS lets SEE other
 *     people's requests (a line manager, an HR administrator who is also an employee). Those two are the
 *     non-vacuity cases: each is first shown to read other people's rows through RLS, so an empty history
 *     for them can only be the person filter's doing.
 *  2. CANCEL. Only the employee's own, only while pending, once; it leaves the approver's queue. RLS is shown
 *     to ADMIT both a manager's write and an employee's write to a decided row, so the refusals below are the
 *     service's guard and not the policy (CLAUDE.md §8 — a green refusal test may be pinning RLS).
 *  3. EVERY CREDIT STATUS, AS STORED, kernel-driven: available, used (consumed, given back, consumed again),
 *     expired, paid out, reversed — plus pending, rejected and cancelled requests. Usage is Σ toil.consumed −
 *     Σ toil.restored, each application named by its dates and leave type; settlement in days, never money.
 *  4. THE LIST CONTRACT shared by the screen and the file: filters, Clear, newest-first, tab counts over the
 *     filtered set, Credit Status → Approved, the days-left hint at 30 and not 31 (derived from the clock),
 *     and the export holding exactly the screen's filtered rows.
 *  5. THE MENU AND THE MESSAGES: the new row is gated on `toil`; "Leave Overview" reads "Leave Request" in all
 *     six locales and the mobile preview's twin says the same; the retired link key and the "+"-free trigger.
 *  6. THE SUBMIT LANDS ON MY LEAVE, on success and on error.
 *
 * Dates derive from `todayInKualaLumpur()` (CLAUDE.md §8); expiry instants are noon in Kuala Lumpur so no
 * assertion sits on a midnight.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock, revalidateMock, sessionHolder } = vi.hoisted(() => ({
  // Throws like Next's, so an action cannot fall out of its own catch into a second redirect.
  redirectMock: vi.fn((url: string): never => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${url}` });
  }),
  revalidateMock: vi.fn((_path: string) => undefined),
  sessionHolder: { s: null as unknown },
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock, notFound: vi.fn(() => undefined) }));
vi.mock('next/cache', () => ({ revalidatePath: revalidateMock, revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => sessionHolder.s) }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const nodeFs = await import('node:fs');
  const en = JSON.parse(nodeFs.readFileSync('messages/en.json', 'utf8'));
  return {
    getTranslations: async (ns?: string) => createTranslator({ locale: 'en', messages: en, namespace: ns as never }),
    getLocale: async () => 'en',
  };
});

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { adminCancelLeave, decideLeave, requestLeave } from '../core/leave';
import { reverseLeaveCredit, runToilExpiry, setToilPolicy } from '../core/toil';
import {
  cancelOwnReplacementLeaveRequest,
  decideReplacementLeaveRequest,
  listPendingReplacementLeaveRequests,
  ReplacementRequestInvalidError,
  ReplacementRequestNotPendingError,
  submitReplacementLeaveRequest,
} from '../core/replacement-request';
import { listOwnLeaveCreditHistory } from '../core/leave-credit-history';
import {
  APPROVAL_TABS,
  CREDIT_STATUS_OF_ACCRUAL,
  LEAVE_CREDIT_STATUSES,
  applyCreditHistoryFilters,
  creditHistoryYears,
  dmy,
  expiryHintDays,
  parseCreditHistoryQuery,
  tabAfterApply,
  type CreditHistoryFilters,
  type CreditHistoryLine,
} from '../lib/leave-credit-history';
import { todayInKualaLumpur } from '../lib/hr-date';
import { cancelLeaveCreditRequestAction, submitLeaveCreditRequestAction } from '../app/leave/credit/actions';
import { GET as exportGET } from '../app/leave/credit/export/route';
import { leavePack } from '../packs/leave';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const cat = (l: string) => JSON.parse(read(`messages/${l}.json`));

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const d = (n: number) => addDays(TODAY, n);
/** Noon in Kuala Lumpur on `iso` — a decision instant whose KL calendar day is `iso` beyond doubt. */
const noonKL = (iso: string) => new Date(`${iso}T04:00:00Z`);
const nextMonday = (from: string) => {
  let x = from;
  while ((new Date(`${x}T00:00:00Z`).getUTCDay() || 7) !== 1) x = addDays(x, 1);
  return x;
};
const NO_FILTERS: CreditHistoryFilters = { tab: 'all', creditStatus: null, dayType: null, year: null, from: null, to: null };

let b: Base;
let admin: SessionContext;

const POLICY = (companyId: string, over: Record<string, unknown> = {}) => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked' as const,
  expiryDays: 90,
  onExpiry: 'lapse' as const,
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  ...over,
});

async function hire(name: string, base: Base = b, companyId = base.companyId, departmentId = base.deptA) {
  const e = await hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `r389_${randomUUID().slice(0, 8)}@t.local` },
    companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(adminCtx(base), { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return e;
}

async function ctxFor(
  e: { personId: string },
  role: 'employee' | 'manager' | 'hr_admin',
  base: Base = b,
  entitlements: SessionContext['entitlements'] = admin.entitlements,
): Promise<SessionContext> {
  return { tenantId: base.tenantId, userId: await createAppUser(base.tenantId, e.personId, role), personId: e.personId, roles: [role], entitlements };
}

async function managed(name: string, mgrName: string) {
  const emp = await hire(name);
  const mgr = await hire(mgrName);
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: emp.employmentId,
    managerEmploymentId: mgr.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  return { emp, mgr, empCtx: await ctxFor(emp, 'employee'), mgrCtx: await ctxFor(mgr, 'manager') };
}

/** A rest-day claim through the request layer, one line per date. */
async function claim(ctx: SessionContext, employmentId: string, dates: string[], submittedOn = TODAY, base: Base = b) {
  for (const shiftDate of dates) await setRestDay(adminCtx(base), { employmentId, shiftDate });
  const { requestId } = await submitReplacementLeaveRequest(ctx, {
    employmentId,
    unit: 'day',
    lines: dates.map((workedDate) => ({ workedDate, days: 1 })),
    reason: `Fixture claim ${dates.join(',')}`,
    today: submittedOn,
  });
  return requestId;
}

async function replacementTypeId() {
  const [lt] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return lt.id;
}

async function accrualOf(requestId: string) {
  const [l] = await owner.db
    .select({ accrualId: schema.replacementLeaveRequestDate.accrualId })
    .from(schema.replacementLeaveRequestDate)
    .where(eq(schema.replacementLeaveRequestDate.requestId, requestId));
  return l.accrualId!;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    const digest = (e as { digest?: string }).digest;
    if (digest?.startsWith('NEXT_REDIRECT;replace;')) return digest.slice('NEXT_REDIRECT;replace;'.length);
    throw e;
  }
  throw new Error('the action returned without redirecting');
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  redirectMock.mockClear();
  revalidateMock.mockClear();
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  admin = await entitledCtx(b);
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  await setToilPolicy(admin, POLICY(b.companyId));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) WHOSE ROWS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r389 · Leave Credit History lists the signed-in person’s own requests and nobody else’s', () => {
  it('own requests only — not a colleague’s, another company’s or another tenant’s, whoever can see them', async () => {
    const { emp, empCtx, mgr, mgrCtx } = await managed('Aisyah Own', 'Mahmud Manager');
    const r1 = await claim(empCtx, emp.employmentId, [d(-40), d(-38)]);
    const r2 = await claim(empCtx, emp.employmentId, [d(-20)]);
    await decideReplacementLeaveRequest(mgrCtx, { requestId: r1, decision: 'approved' });

    // A colleague in the same company.
    const bala = await hire('Bala Colleague');
    const balaCtx = await ctxFor(bala, 'employee');
    const r3 = await claim(balaCtx, bala.employmentId, [d(-25)]);

    // Another company of the same tenant.
    const [c2] = await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName: 'Second Sdn Bhd' }).returning({ id: schema.company.id });
    const [dept2] = await owner.db.insert(schema.department).values({ tenantId: b.tenantId, companyId: c2.id, name: 'Ops' }).returning({ id: schema.department.id });
    await setToilPolicy(admin, POLICY(c2.id));
    const chen = await hire('Chen Other Company', b, c2.id, dept2.id);
    const chenCtx = await ctxFor(chen, 'employee');
    const r4 = await claim(chenCtx, chen.employmentId, [d(-30)]);

    // Another tenant altogether.
    const b2 = await seedBase();
    await setModule(b2.tenantId, 'toil', 'active');
    const admin2 = await entitledCtx(b2);
    await setToilPolicy(admin2, POLICY(b2.companyId));
    const dina = await hire('Dina Other Tenant', b2);
    const dinaCtx = await ctxFor(dina, 'employee', b2, admin2.entitlements);
    await claim(dinaCtx, dina.employmentId, [d(-12)], TODAY, b2);

    // An HR administrator who is ALSO an employee with a request of her own.
    const hana = await hire('Hana HR');
    const hanaCtx = await ctxFor(hana, 'hr_admin');
    const r6 = await claim(hanaCtx, hana.employmentId, [d(-15)]);

    const mine = await listOwnLeaveCreditHistory(empCtx);
    expect(new Set(mine.map((l) => l.requestId))).toEqual(new Set([r1, r2]));
    expect(mine.map((l) => l.workedDate).sort()).toEqual([d(-40), d(-38), d(-20)].sort());
    expect(mine.every((l) => l.requestRef === l.requestId.replace(/-/g, '').slice(0, 8).toUpperCase())).toBe(true);

    // NON-VACUITY for the two viewers whose history must be their own: each READS other people's requests
    // through RLS, so their empty / own-only history is the person filter, not the policy.
    const seenBy = (ctx: SessionContext) =>
      withTenant(ctx, (tx) => tx.select({ id: schema.replacementLeaveRequest.id }).from(schema.replacementLeaveRequest));
    const hanaSees = (await seenBy(hanaCtx)).map((r) => r.id);
    expect(hanaSees, 'the HR administrator can see colleagues’ requests through RLS').toEqual(expect.arrayContaining([r1, r2, r3, r4, r6]));
    expect((await listOwnLeaveCreditHistory(hanaCtx)).map((l) => l.requestId)).toEqual([r6]);

    const mgrSees = (await seenBy(mgrCtx)).map((r) => r.id);
    expect(mgrSees, 'the manager can see the report’s requests through RLS').toEqual(expect.arrayContaining([r1, r2]));
    expect(await listOwnLeaveCreditHistory(mgrCtx)).toEqual([]);
    void mgr;

    // The colleague, the other company and the other tenant see only their own.
    expect((await listOwnLeaveCreditHistory(balaCtx)).map((l) => l.requestId)).toEqual([r3]);
    expect((await listOwnLeaveCreditHistory(chenCtx)).map((l) => l.requestId)).toEqual([r4]);
    expect((await listOwnLeaveCreditHistory(dinaCtx)).every((l) => ![r1, r2, r3, r4, r6].includes(l.requestId))).toBe(true);

    // Newest date worked first, and the tab counts are the filtered rows, by approval status.
    const { rows, counts } = applyCreditHistoryFilters(mine, NO_FILTERS);
    expect(rows.map((l) => l.workedDate)).toEqual([d(-20), d(-38), d(-40)]);
    expect(counts).toEqual({ all: 3, pending: 1, approved: 2, rejected: 0, cancelled: 0 });
    // Approved lines carry their credit; the pending line has none (expiry and status read "—" on screen).
    expect(mine.filter((l) => l.requestId === r1).every((l) => l.credit?.status === 'available')).toBe(true);
    expect(mine.find((l) => l.requestId === r2)!.credit).toBeNull();
  });

  it('a rehired person keeps the requests of the earlier employment — every employment of the person, no one else’s', async () => {
    const { emp, empCtx, mgrCtx } = await managed('Aisyah Rehired', 'Mahmud Rehire');
    const now = await claim(empCtx, emp.employmentId, [d(-11)]);
    await decideReplacementLeaveRequest(mgrCtx, { requestId: now, decision: 'approved' });
    // The EARLIER employment of the same person (ended before the current one began), with a request it made
    // then. Written directly: the request path rightly refuses a terminated employment, and this case is
    // about what the history READS, not about who may still submit.
    const [old] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: emp.personId, companyId: b.companyId, hiredOn: '2020-01-01', terminatedOn: '2023-06-30', employeeCode: `OLD-${randomUUID().slice(0, 4)}` })
      .returning({ id: schema.employment.id });
    const [oldReq] = await owner.db
      .insert(schema.replacementLeaveRequest)
      .values({ tenantId: b.tenantId, employmentId: old.id, unit: 'day', totalDays: '1.00', submittedOn: '2023-03-02', status: 'rejected', reason: 'From the first employment' })
      .returning({ id: schema.replacementLeaveRequest.id });
    await owner.db
      .insert(schema.replacementLeaveRequestDate)
      .values({ tenantId: b.tenantId, requestId: oldReq.id, subjectEmploymentId: old.id, workedDate: '2023-03-01', days: '1.00', workedDayKind: 'rest_day' });
    // Somebody else's earlier employment is not swept in by the same rule.
    const other = await hire('Bala Other Person');
    const [otherOld] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: other.personId, companyId: b.companyId, hiredOn: '2020-01-01', terminatedOn: '2023-06-30', employeeCode: `OTH-${randomUUID().slice(0, 4)}` })
      .returning({ id: schema.employment.id });
    await owner.db
      .insert(schema.replacementLeaveRequest)
      .values({ tenantId: b.tenantId, employmentId: otherOld.id, unit: 'day', totalDays: '1.00', submittedOn: '2023-03-02', status: 'pending', reason: 'Not Aisyah' });

    const mine = await listOwnLeaveCreditHistory(empCtx);
    expect(new Set(mine.map((l) => l.requestId))).toEqual(new Set([now, oldReq.id]));
    expect(mine.find((l) => l.requestId === oldReq.id)).toMatchObject({ workedDate: '2023-03-01', approvalStatus: 'rejected', dayType: 'rest_day', credit: null });
    // The Year filter offers the earlier employment's year too, so it can be found.
    expect(creditHistoryYears(mine)).toContain(2023);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2) CANCEL
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r389 · Cancel withdraws the employee’s own PENDING request, once, and takes it off the approver’s list', () => {
  it('own + pending only; RLS admits the writes the guard refuses; the queue and the date are released', async () => {
    const { emp, empCtx, mgrCtx } = await managed('Aisyah Cancel', 'Mahmud Approver');
    const rA = await claim(empCtx, emp.employmentId, [d(-3)]);
    const rB = await claim(empCtx, emp.employmentId, [d(-4)]);
    const queue = async () => (await listPendingReplacementLeaveRequests(mgrCtx)).map((r) => r.id);
    expect(await queue()).toEqual(expect.arrayContaining([rA, rB]));

    // ── RLS IS NOT THE CONTROL (verified): the manager may WRITE the report's pending row through the policy…
    const rlsWrite = (ctx: SessionContext, id: string) =>
      withTenant(ctx, (tx) =>
        tx.update(schema.replacementLeaveRequest).set({ updatedAt: new Date() }).where(eq(schema.replacementLeaveRequest.id, id)).returning({ id: schema.replacementLeaveRequest.id }),
      );
    expect(await rlsWrite(mgrCtx, rA), 'replacement_leave_request_rls admits the manager’s UPDATE').toHaveLength(1);
    // …so this refusal is the service's ownership guard, and it does not say whether the id exists.
    await expect(cancelOwnReplacementLeaveRequest(mgrCtx, { requestId: rA })).rejects.toThrow(ReplacementRequestInvalidError);
    await expect(cancelOwnReplacementLeaveRequest(mgrCtx, { requestId: rA })).rejects.toThrow('Leave Credit request not found.');

    // A colleague cannot see it at all (that one IS RLS) and gets the same answer.
    const bala = await hire('Bala Stranger');
    const balaCtx = await ctxFor(bala, 'employee');
    await expect(cancelOwnReplacementLeaveRequest(balaCtx, { requestId: rA })).rejects.toThrow('Leave Credit request not found.');
    await expect(cancelOwnReplacementLeaveRequest(empCtx, { requestId: randomUUID() })).rejects.toThrow('Leave Credit request not found.');
    expect((await owner.db.select().from(schema.replacementLeaveRequest).where(eq(schema.replacementLeaveRequest.id, rA)))[0].status).toBe('pending');

    // The employee cancels: once.
    await expect(cancelOwnReplacementLeaveRequest(empCtx, { requestId: rA })).resolves.toEqual({ requestId: rA, status: 'cancelled' });
    const [row] = await owner.db.select().from(schema.replacementLeaveRequest).where(eq(schema.replacementLeaveRequest.id, rA));
    expect(row.status).toBe('cancelled');
    expect(row.decidedAt, 'a withdrawal is not an approval instant').toBeNull();
    const events = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, rA), eq(schema.domainEvent.eventType, 'replacement-leave-request.cancelled')));
    expect(events).toHaveLength(1);
    expect(events[0].subjectEmploymentId).toBe(emp.employmentId);
    expect(await queue(), 'it left the approver’s list').not.toContain(rA);
    expect(await queue()).toContain(rB);
    await expect(cancelOwnReplacementLeaveRequest(empCtx, { requestId: rA })).rejects.toThrow(ReplacementRequestNotPendingError);

    // A decided request is refused — and RLS would have admitted the employee's write to it.
    await decideReplacementLeaveRequest(mgrCtx, { requestId: rB, decision: 'approved' });
    expect(await rlsWrite(empCtx, rB), 'the policy has no status predicate').toHaveLength(1);
    await expect(cancelOwnReplacementLeaveRequest(empCtx, { requestId: rB })).rejects.toThrow(ReplacementRequestNotPendingError);
    expect((await owner.db.select().from(schema.replacementLeaveRequest).where(eq(schema.replacementLeaveRequest.id, rB)))[0].status).toBe('approved');

    // The history shows the withdrawal with its day, from the event.
    const hist = await listOwnLeaveCreditHistory(empCtx);
    const cancelled = hist.find((l) => l.requestId === rA)!;
    expect(cancelled).toMatchObject({ approvalStatus: 'cancelled', decidedOn: TODAY, credit: null, decisionNote: null });

    // A cancelled request no longer holds its date: the same date can be claimed again.
    await expect(claim(empCtx, emp.employmentId, [d(-3)])).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the Cancel action redirects back to the same view with a toast, or with the translated refusal', async () => {
    const { emp, empCtx, mgrCtx } = await managed('Aisyah Action', 'Mahmud Action');
    const en = cat('en');
    const rP = await claim(empCtx, emp.employmentId, [d(-8)]);
    const rD = await claim(empCtx, emp.employmentId, [d(-9)]);
    await decideReplacementLeaveRequest(mgrCtx, { requestId: rD, decision: 'rejected', note: 'No' });
    sessionHolder.s = empCtx;

    const form = (requestId: string, back: string) => {
      const f = new FormData();
      f.set('requestId', requestId);
      f.set('back', back);
      return f;
    };
    const ok = new URL(await redirectOf(() => cancelLeaveCreditRequestAction(form(rP, 'tab=pending&size=20'))), 'http://x');
    expect(ok.pathname).toBe('/leave/credit');
    expect(ok.searchParams.get('tab')).toBe('pending');
    expect(ok.searchParams.get('size')).toBe('20');
    expect(ok.searchParams.get('toast')).toBe(en.leaveCreditHistory.cancelledToast);
    expect(revalidateMock.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['/leave/credit', '/leave', '/approvals']));

    const refused = new URL(await redirectOf(() => cancelLeaveCreditRequestAction(form(rD, ''))), 'http://x');
    expect(refused.pathname).toBe('/leave/credit');
    expect(refused.searchParams.get('error')).toBe(en.leaveCreditHistory.cancelNotPending);

    // `back` is a query string for this page or nothing — never a way off it.
    const off = await redirectOf(() => cancelLeaveCreditRequestAction(form(rP, '//evil.example/x')));
    expect(off.startsWith('/leave/credit?')).toBe(true);
    expect(off).not.toContain('evil');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (3) + (4) EVERY CREDIT STATUS, KERNEL-DRIVEN, AND THE LIST CONTRACT OVER THEM
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function statusesWorld() {
  const { emp, empCtx, mgrCtx } = await managed('Aisyah Statuses', 'Mahmud Statuses');
  const E = emp.employmentId;
  const RL = await replacementTypeId();

  // A · USED — consumed by a leave application, given back when HR cancelled it, consumed again by another.
  // It is the only active credit while that happens, so FIFO cannot pick a different one.
  const rUsed = await claim(empCtx, E, [d(-50)]);
  await decideReplacementLeaveRequest(mgrCtx, { requestId: rUsed, decision: 'approved' });
  const mon1 = nextMonday(d(14));
  const L1 = await requestLeave(empCtx, { employmentId: E, leaveTypeId: RL, startDate: mon1, endDate: mon1, reason: 'First go', today: TODAY });
  await decideLeave(mgrCtx, { leaveRequestId: L1.leaveRequestId, decision: 'approved' });
  await adminCancelLeave(admin, { leaveRequestId: L1.leaveRequestId, reason: 'Plans changed' });
  const mon2 = addDays(mon1, 7);
  const L2 = await requestLeave(empCtx, { employmentId: E, leaveTypeId: RL, startDate: mon2, endDate: mon2, reason: 'Second go', today: TODAY });
  await decideLeave(mgrCtx, { leaveRequestId: L2.leaveRequestId, decision: 'approved' });

  // B · EXPIRED — approved long enough ago that it lapsed (policy: lapse, frozen at approval).
  const rExp = await claim(empCtx, E, [d(-130)], d(-125));
  await decideReplacementLeaveRequest(mgrCtx, { requestId: rExp, decision: 'approved', decidedAt: noonKL(d(-120)) });
  // C · PAID OUT — approved while the policy said convert_to_pay (frozen onto the credit), then expired.
  await setToilPolicy(admin, POLICY(b.companyId, { onExpiry: 'convert_to_pay' }));
  const rPaid = await claim(empCtx, E, [d(-140)], d(-135));
  await decideReplacementLeaveRequest(mgrCtx, { requestId: rPaid, decision: 'approved', decidedAt: noonKL(d(-121)) });
  await setToilPolicy(admin, POLICY(b.companyId));
  await runToilExpiry(admin, { today: TODAY });

  // D · REVERSED by HR.
  const rRev = await claim(empCtx, E, [d(-10)]);
  await decideReplacementLeaveRequest(mgrCtx, { requestId: rRev, decision: 'approved' });
  await reverseLeaveCredit(admin, { accrualId: await accrualOf(rRev), reason: 'Entered twice', today: TODAY });

  // E · AVAILABLE, expiring in exactly 30 and in exactly 31 days (approval + 90).
  const r30 = await claim(empCtx, E, [d(-65)], d(-61));
  await decideReplacementLeaveRequest(mgrCtx, { requestId: r30, decision: 'approved', decidedAt: noonKL(d(-60)) });
  const r31 = await claim(empCtx, E, [d(-66)], d(-60));
  await decideReplacementLeaveRequest(mgrCtx, { requestId: r31, decision: 'approved', decidedAt: noonKL(d(-59)) });

  // F · PENDING, REJECTED (with the approver's remarks), CANCELLED.
  const rPend = await claim(empCtx, E, [d(-5)]);
  const rRej = await claim(empCtx, E, [d(-6)]);
  await decideReplacementLeaveRequest(mgrCtx, { requestId: rRej, decision: 'rejected', note: 'You were rostered to work that day.' });
  const rCan = await claim(empCtx, E, [d(-7)]);
  await cancelOwnReplacementLeaveRequest(empCtx, { requestId: rCan });

  return { E, RL, empCtx, mgrCtx, L1: L1.leaveRequestId, L2: L2.leaveRequestId, mon2, rUsed, rExp, rPaid, rRev, r30, r31, rPend, rRej, rCan };
}

describe('r389 · every credit status, read as the system stored it', () => {
  it('available, used, expired, paid out and reversed — with usage net of give-backs, and days never money', async () => {
    const w = await statusesWorld();
    const lines = await listOwnLeaveCreditHistory(w.empCtx);
    const by = (id: string) => lines.find((l) => l.requestId === id)!;

    // Credit Status covers EVERY toil_accrual_status value, and this fixture produced every one of them.
    expect(Object.keys(CREDIT_STATUS_OF_ACCRUAL).sort()).toEqual([...schema.toilAccrualStatusEnum.enumValues].sort());
    const raw = await owner.db.select({ status: schema.toilAccrual.status }).from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, w.E));
    expect(new Set(raw.map((r) => r.status))).toEqual(new Set(schema.toilAccrualStatusEnum.enumValues));
    expect(new Set(lines.flatMap((l) => (l.credit ? [l.credit.status] : [])))).toEqual(new Set(LEAVE_CREDIT_STATUSES));

    // USED: Σ consumed (2 days, two applications) − Σ restored (1 day, the cancelled one) = 1 day, and only
    // the application that still holds it is listed, by its dates and leave type.
    const usedAccrual = await accrualOf(w.rUsed);
    const evs = await owner.db.select({ t: schema.domainEvent.eventType }).from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId, usedAccrual));
    expect(evs.filter((e) => e.t === 'toil.consumed'), 'non-vacuity: two consumptions happened').toHaveLength(2);
    expect(evs.filter((e) => e.t === 'toil.restored'), 'non-vacuity: one give-back happened').toHaveLength(1);
    expect(by(w.rUsed).credit).toMatchObject({ status: 'used', daysCredited: 1, used: 1, remaining: 0, settled: null });
    expect(by(w.rUsed).credit!.usage).toEqual([{ leaveRequestId: w.L2, startDate: w.mon2, endDate: w.mon2, leaveTypeId: w.RL, days: 1 }]);

    // EXPIRED: the forfeited days and the day of the sweep.
    expect(by(w.rExp).credit).toMatchObject({ status: 'expired', used: 0, remaining: 0, settled: { kind: 'expired', days: 1, on: TODAY } });
    // PAID OUT: in days. The settlement event DOES carry money — and none of it was read.
    expect(by(w.rPaid).credit).toMatchObject({ status: 'paid_out', remaining: 0, settled: { kind: 'paid_out', days: 1, on: TODAY } });
    const [converted] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, await accrualOf(w.rPaid)), eq(schema.domainEvent.eventType, 'toil.converted')));
    expect(Object.keys(converted.payload as object), 'non-vacuity: the event holds an amount').toContain('amountOwed');
    const serialised = JSON.stringify(lines);
    for (const money of ['amountOwed', 'valuationBasis', 'orpDivisor', 'amount']) expect(serialised).not.toContain(money);

    // REVERSED by HR, on the day it was reversed.
    expect(by(w.rRev).credit).toMatchObject({ status: 'reversed', remaining: 0, reversedOn: TODAY });

    // AVAILABLE, and the days-left hint at 30 but not at 31 — from the stored expiry and today's clock.
    expect(by(w.r30).credit).toMatchObject({ status: 'available', expiresOn: d(30), used: 0, remaining: 1 });
    expect(by(w.r31).credit).toMatchObject({ status: 'available', expiresOn: d(31) });
    expect(expiryHintDays(by(w.r30), TODAY)).toBe(30);
    expect(expiryHintDays(by(w.r31), TODAY)).toBeNull();
    // …and never on a credit that is not Available, however close its date.
    expect(expiryHintDays(by(w.rExp), TODAY)).toBeNull();

    // PENDING / REJECTED / CANCELLED: no credit, so expiry and credit status are "—".
    expect(by(w.rPend)).toMatchObject({ approvalStatus: 'pending', credit: null, decidedOn: null });
    expect(by(w.rRej)).toMatchObject({ approvalStatus: 'rejected', credit: null, decidedOn: TODAY, decisionNote: 'You were rostered to work that day.' });
    expect(by(w.rCan)).toMatchObject({ approvalStatus: 'cancelled', credit: null, decidedOn: TODAY });

    // The attendance snapshot is the stored one: a rest-day claim has no shift end or clock-out to store.
    expect(by(w.rPend)).toMatchObject({ shiftEnd: null, actualClockOut: null });
  });

  it('filters, Clear, newest first, tab counts over the filtered set, Credit Status → Approved', async () => {
    const w = await statusesWorld();
    // One line re-kinded to an off day, so the Day Type filter has two kinds to tell apart.
    await owner.db
      .update(schema.replacementLeaveRequestDate)
      .set({ workedDayKind: 'off_day' })
      .where(eq(schema.replacementLeaveRequestDate.requestId, w.rPend));
    const lines = await listOwnLeaveCreditHistory(w.empCtx);
    expect(lines, 'nine requests, one date each').toHaveLength(9);
    const ids = (rows: CreditHistoryLine[]) => new Set(rows.map((l) => l.requestId));
    const run = (f: Partial<CreditHistoryFilters>) => applyCreditHistoryFilters(lines, { ...NO_FILTERS, ...f });

    // Every tab's count equals the rows that tab shows, for every filter combination tried below.
    const countsAgree = (f: Partial<CreditHistoryFilters>) => {
      const { counts } = run(f);
      for (const tab of APPROVAL_TABS) expect(run({ ...f, tab }).rows.length, `${JSON.stringify(f)} ${tab}`).toBe(counts[tab]);
      expect(counts.pending + counts.approved + counts.rejected + counts.cancelled).toBe(counts.all);
    };

    // Newest date worked first.
    const all = run({}).rows;
    expect(all.map((l) => l.workedDate)).toEqual([...all.map((l) => l.workedDate)].sort().reverse());
    expect(run({}).counts).toEqual({ all: 9, pending: 1, approved: 6, rejected: 1, cancelled: 1 });
    countsAgree({});

    // Credit Status narrows to approved lines with that credit status — and the form sends the Approved tab.
    expect(ids(run({ creditStatus: 'available' }).rows)).toEqual(new Set([w.r30, w.r31]));
    expect(run({ creditStatus: 'available' }).counts).toEqual({ all: 2, pending: 0, approved: 2, rejected: 0, cancelled: 0 });
    for (const s of LEAVE_CREDIT_STATUSES) {
      expect(run({ creditStatus: s }).rows.length, s).toBe(1 + (s === 'available' ? 1 : 0));
      countsAgree({ creditStatus: s });
    }
    expect(tabAfterApply('pending', 'used')).toBe('approved');
    expect(tabAfterApply('rejected', '')).toBe('rejected');
    expect(tabAfterApply('all', null)).toBe('all');

    // Day Type.
    expect(ids(run({ dayType: 'off_day' }).rows)).toEqual(new Set([w.rPend]));
    expect(run({ dayType: 'rest_day' }).rows).toHaveLength(8);
    countsAgree({ dayType: 'off_day' });

    // Year: every year offered holds only its own dates, and the years together hold everything.
    const years = creditHistoryYears(lines);
    expect(years.length).toBeGreaterThan(0);
    expect(years.reduce((n, y) => n + run({ year: y }).rows.length, 0)).toBe(9);
    for (const y of years) expect(run({ year: y }).rows.every((l) => l.workedDate.startsWith(`${y}-`))).toBe(true);

    // Date Worked From / To, inclusive at both ends.
    expect(ids(run({ from: d(-66), to: d(-50) }).rows)).toEqual(new Set([w.r31, w.r30, w.rUsed]));
    countsAgree({ from: d(-66), to: d(-50) });
    expect(run({ from: d(-4), to: d(-1) }).rows).toHaveLength(0);

    // Clear is the bare address: no filter survives the parse of it.
    expect(parseCreditHistoryQuery({}).filters).toEqual(NO_FILTERS);
    // A hand-edited address narrows to nothing it could not have produced.
    expect(parseCreditHistoryQuery({ tab: 'deleted', credit: 'stolen', day: 'sunday', year: 'x', from: '2026-1-1', size: '7', page: '-2' })).toEqual({
      filters: NO_FILTERS,
      page: 0,
      size: 10,
    });
    expect(parseCreditHistoryQuery({ size: '50', page: '2', tab: 'approved', credit: 'paid_out' })).toMatchObject({ size: 50, page: 2, filters: { tab: 'approved', creditStatus: 'paid_out' } });
  });

  it('the export holds exactly the screen’s filtered rows, for the session’s own person, and no money', async () => {
    const w = await statusesWorld();
    const lines = await listOwnLeaveCreditHistory(w.empCtx);
    const csvRows = async (qs: string) => {
      const res = await exportGET(new Request(`http://localhost/leave/credit/export?format=csv&${qs}`));
      expect(res.status, qs).toBe(200);
      const text = (await res.text()).replace(/^﻿/, '');
      const [head, ...body] = text.trim().split(/\r?\n/);
      return { head, body, text };
    };
    sessionHolder.s = w.empCtx;
    for (const qs of ['', 'tab=approved', 'credit=available&tab=approved', `from=${d(-66)}&to=${d(-50)}`, 'tab=pending', 'size=10&page=1']) {
      const { head, body, text } = await csvRows(qs);
      expect(head).toBe('Date Worked,Day Type,Extended Hours,Credit Days,Expiry Date,Applied On,Approval Status,Credit Status');
      const screen = applyCreditHistoryFilters(lines, parseCreditHistoryQuery(Object.fromEntries(new URLSearchParams(qs))).filters).rows;
      expect(body.map((r) => r.split(',')[0]), qs).toEqual(screen.map((l) => dmy(l.workedDate)));
      expect(text).not.toMatch(/RM\s?\d|amountOwed/);
    }
    // Paging is not a filter: a later page of the screen still exports the whole filtered list.
    expect((await csvRows('size=10&page=1')).body).toHaveLength(9);

    // Another person's session exports their own (none), never this employee's.
    sessionHolder.s = w.mgrCtx;
    const res = await exportGET(new Request('http://localhost/leave/credit/export?format=csv'));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (5) THE MENU AND THE MESSAGES
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r389 · the My Leave menu, the renamed row, the retired link and the single plus sign', () => {
  it('the menu reads Leave Request, Leave History, Leave Credit History, and only the third is toil-gated', () => {
    const self = leavePack.navNodes!.find((n) => n.group === 'main')!;
    expect(self.children.map((c) => [c.href, c.labelKey])).toEqual([
      ['/leave', 'leaveOverview'],
      ['/leave/history', 'leaveHistory'],
      ['/leave/credit', 'leaveCreditHistory'],
    ]);
    const sidebar = codeOnly(read('components/sidebar.tsx'));
    expect(sidebar).toContain("c.labelKey === 'leaveCreditHistory'");
    expect(sidebar).not.toContain("c.labelKey === 'leaveHistory'");
    for (const l of LOCALES) {
      const nav = cat(l).nav;
      expect(typeof nav.leaveCreditHistory, l).toBe('string');
      if (l !== 'en') expect(nav.leaveCreditHistory, `${l} is translated`).not.toBe(cat('en').nav.leaveCreditHistory);
    }
  });

  it('nav.leaveOverview reads "Leave Request" in six locales, and the mobile preview’s twin says the same', () => {
    const WAS: Record<string, string> = { en: 'Leave Overview', ms: 'Gambaran Cuti', ta: 'விடுப்பு கண்ணோட்டம்', th: 'ภาพรวมการลา', vi: 'Tổng quan nghỉ phép', zh: '休假概览' };
    const NOW: Record<string, string> = { en: 'Leave Request', ms: 'Permohonan Cuti', ta: 'விடுப்பு கோரிக்கை', th: 'คำขอลา', vi: 'Đơn xin nghỉ phép', zh: '休假申请' };
    for (const l of LOCALES) {
      const m = cat(l);
      expect(m.nav.leaveOverview, l).toBe(NOW[l]);
      expect(m.nav.leaveOverview, `${l} changed`).not.toBe(WAS[l]);
      expect(m.mobilePreview.leave.overview, `${l} mobile preview follows the menu`).toBe(m.nav.leaveOverview);
      // Vietnamese avoids repeating the Request leave button's wording.
      if (l === 'vi') expect(m.nav.leaveOverview).not.toBe(m.leave.requestLeave);
    }
    // The page heading is the section's name and did not move.
    expect(cat('en').leave.myAbsenceTitle).toBe('My Leave');
  });

  it('the trigger draws ONE plus: the icon stays, and no locale’s label starts with "+"', () => {
    const dialog = codeOnly(read('components/leave/replacement-leave-request-dialog.tsx'));
    expect(dialog).toContain('<Plus className="size-4" />');
    expect(dialog).toContain("{t('trigger')}");
    for (const l of LOCALES) {
      const trigger: string = cat(l).replacementRequest.trigger;
      expect(trigger.trim().startsWith('+'), `${l}: "${trigger}"`).toBe(false);
      expect(trigger.length, l).toBeGreaterThan(3);
    }
  });

  it('the old list’s four headings are retired in place in all six, and nothing renders them', () => {
    for (const l of LOCALES) {
      const tbl = cat(l).replacementRequest.table;
      for (const k of ['myRequests', 'noRequests', 'statusHeading', 'submittedOn']) expect(tbl[k], `${l}.${k}`).toMatch(/^\[retired r389 —/);
    }
    for (const f of ['app/leave/credit/page.tsx', 'components/leave/leave-credit-history.tsx', 'components/leave/leave-credit-request-table.tsx'])
      for (const k of ['myRequests', 'noRequests', 'statusHeading', 'submittedOn']) expect(codeOnly(read(f)), `${f} renders ${k}`).not.toContain(`'table.${k}'`);
  });

  it('every leaveCreditHistory key exists in six locales, and all but the pure format string are translated', () => {
    const flat = (o: Record<string, unknown>, p = ''): [string, string][] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));
    const en = new Map(flat(cat('en').leaveCreditHistory));
    expect(en.size).toBeGreaterThan(50);
    // The one value that is the same in every language, by construction: three placeholders and two dots.
    const FORMAT_ONLY = new Set(['drawer.usageLine']);
    for (const l of LOCALES.slice(1)) {
      const other = new Map(flat(cat(l).leaveCreditHistory));
      expect([...other.keys()].sort(), l).toEqual([...en.keys()].sort());
      for (const [k, v] of en) if (!FORMAT_ONLY.has(k)) expect(other.get(k), `${l}:${k} is still English`).not.toBe(v);
    }
    // And every key the page, the island and the export render exists (a MISSING_MESSAGE passes tsc).
    const used = new Set<string>();
    // (The actions file binds `t` to two namespaces in two functions, so its two keys are named instead.)
    for (const f of ['app/leave/credit/page.tsx', 'components/leave/leave-credit-history.tsx', 'app/leave/credit/export/route.ts']) {
      const src = codeOnly(read(f));
      for (const m of src.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
    }
    for (const k of ['cancelNotPending', 'cancelledToast']) used.add(k);
    expect(used.size).toBeGreaterThan(30);
    for (const k of used) expect(en.has(k), `leaveCreditHistory.${k} is rendered but missing`).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (6) THE SUBMIT LANDS ON MY LEAVE
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r389 · a Leave Credit request submitted from the dialog returns to My Leave', () => {
  it('on success with the confirmation, and on error with the reason — never to /leave/credit', async () => {
    await setToilPolicy(
      admin,
      POLICY(b.companyId, { extendedHoursEnabled: true, extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 }),
    );
    const emp = await hire('Aisyah Submit');
    const empCtx = await ctxFor(emp, 'employee');
    const worked = d(-2);
    await setRestDay(adminCtx(b), { employmentId: emp.employmentId, shiftDate: worked });
    sessionHolder.s = empCtx;
    const en = cat('en');
    const form = (reason: string) => {
      const f = new FormData();
      f.append('workedDate', worked);
      f.append('dayType', 'rest_day');
      f.append('claimStart', '09:00');
      f.append('claimEnd', '17:00');
      f.set('reason', reason);
      return f;
    };

    const ok = new URL(await redirectOf(() => submitLeaveCreditRequestAction(form('Covered the stocktake'))), 'http://x');
    expect(ok.pathname).toBe('/leave');
    expect(ok.searchParams.get('toast')).toBe(en.replacementRequest.submittedToast);
    expect(revalidateMock.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['/leave', '/leave/credit']));
    expect((await listOwnLeaveCreditHistory(empCtx)).map((l) => l.workedDate)).toEqual([worked]);

    const bad = new URL(await redirectOf(() => submitLeaveCreditRequestAction(form('   '))), 'http://x');
    expect(bad.pathname).toBe('/leave');
    expect(bad.searchParams.get('error')).toBe(en.replacementRequest.table.reasonRequired);

    // The source agrees: no redirect in the action file names /leave/credit as a landing.
    const actions = codeOnly(read('app/leave/credit/actions.ts'));
    expect(actions).toContain("const SUBMIT_LANDING = '/leave';");
    expect(actions).not.toMatch(/redirect\(`\$\{HISTORY\}\?(toast|error)/);
  });
});
