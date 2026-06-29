/**
 * Leave-entitlement breakdown — read-only ledger reconstruction over the existing flat leave_ledger.
 *
 * This view RECONSTRUCTS (never tags / mutates) the carry/forfeit components openLeaveYear +
 * expireCarriedLeave already compute (ADR-0038 model: no new schema, no enum value). The suite pins:
 *  - the worked example (carry 5, forfeit 3, fresh entitlement shown separately),
 *  - the closed `effective_on <= asOf` interval (a forfeit ON the expiry date is included),
 *  - as-at-date re-computation (before vs after a debit; before vs after expiry),
 *  - the single reconstruction path (a legacy plain-ledger year == a freshly-opened year),
 *  - carry-only / zero-entitlement, before-hire empty state, future-not-yet-opened (no projection),
 *  - and full RLS over leave_ledger / leave_policy / leave_request (peer sees nothing; subject/mgr/admin do).
 *
 * The pure helper `reconstructCarry` is also unit-tested directly. The existing
 * leave-carry-forward-expiry suite guards that the helper extraction did NOT change any value
 * expireCarriedLeave produces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { createLeavePolicy } from '../core/admin';
import { openLeaveYear, reconstructCarry } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  adminCtx,
  closeAll,
  createAppUser,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment',
  days: number,
  effectiveOn: string,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

const hire = (hiredOn: string, gradeId: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'BD', primaryEmail: `bd_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const annualPolicy = (p: {
  annualDays?: number;
  carryForwardMax?: number;
  expiry?: { month: number; day: number } | null;
  from?: string;
}) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays ?? 12,
    carryForwardMax: p.carryForwardMax ?? 5,
    carryForwardExpiryMonth: p.expiry?.month ?? null,
    carryForwardExpiryDay: p.expiry?.day ?? null,
    validFrom: p.from ?? '2025-01-01',
  });

const bd = (employmentId: string, asOf: string) =>
  leaveEntitlementBreakdown(adminCtx(b), employmentId, b.annualLeaveTypeId, asOf);

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

describe('reconstructCarry (pure helper)', () => {
  it('carries up to the cap, forfeits only what is still in the balance', () => {
    // priorYearEnd 8, cap 5 → carried 5; no debits → unconsumed 5; balance 17 → forfeitable 5.
    expect(reconstructCarry({ priorYearEndBalance: 8, carryMax: 5, debitsInWindow: 0, currentBalance: 17 })).toEqual({
      carried: 5,
      unconsumedCarry: 5,
      forfeitable: 5,
    });
  });
  it('debits in the window reduce the unconsumed carry (weaker rule)', () => {
    expect(reconstructCarry({ priorYearEndBalance: 8, carryMax: 5, debitsInWindow: 3, currentBalance: 14 })).toEqual({
      carried: 5,
      unconsumedCarry: 2,
      forfeitable: 2,
    });
  });
  it('never taxes fresh entitlement when balance is below the unconsumed carry', () => {
    expect(reconstructCarry({ priorYearEndBalance: 5, carryMax: 5, debitsInWindow: 0, currentBalance: 3 })).toEqual({
      carried: 5,
      unconsumedCarry: 5,
      forfeitable: 3,
    });
  });
  it('a negative prior balance carries nothing', () => {
    expect(reconstructCarry({ priorYearEndBalance: -2, carryMax: 5, debitsInWindow: 0, currentBalance: 10 })).toEqual({
      carried: 0,
      unconsumedCarry: 0,
      forfeitable: 0,
    });
  });
});

describe('leaveEntitlementBreakdown — worked example + as-at', () => {
  it('(1) worked example: 2026 year-end 8, cap 5, expiry 03-31 → carriedForward 5, forfeited 3, fresh 2027 separate', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    // Build a 2026 year-end balance of exactly 8 (cap is 5 → 3 forfeited, 5 carried).
    const emp = await hire('2025-01-01'); // 12 granted at hire
    // Adjust 2026 down to an end-of-2026 balance of 8 (post a -4 adjustment in 2026, so 12 - 4 = 8).
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -4, '2026-06-01');
    // Open 2027: carry min(8,5)=5, forfeit 3, +12 fresh → balance 17.
    await openLeaveYear(adminCtx(b), { year: 2027 });

    const r = await bd(emp.employmentId, '2027-02-15'); // before the 2027-03-31 expiry
    expect(r).not.toBeNull();
    expect(r!.carriedForward).toBe(5);
    expect(r!.forfeited).toBe(3); // the cap-excess at 2027 open (8 → 5), realised immediately
    expect(r!.currentYearEntitlement).toBe(12); // the 2027 grant, SEPARATE from the carry
    expect(r!.carryForwardRemaining).toBe(5); // none taken yet, expiry not reached
    expect(r!.carryForwardExpiryDate).toBe('2027-03-31');
    expect(r!.totalAvailable).toBe(17);
  });

  it('(2) as-at before vs after a debit changes carryForwardRemaining', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry 5 (12→5 cap, forfeit 7), +12 → 17
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-02-10');

    const before = await bd(emp.employmentId, '2026-02-09'); // before the debit
    expect(before!.carryForwardRemaining).toBe(5);
    const after = await bd(emp.employmentId, '2026-02-11'); // after the debit
    expect(after!.carryForwardRemaining).toBe(2); // 5 carry − 3 taken in-window
  });
});

describe('leaveEntitlementBreakdown — boundary + expiry', () => {
  it('(3) closed interval: asOf ON the expiry date includes the forfeit row → remaining 0', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // prior 12 → cap-excess forfeit 7 + carry 5 + 12 → 17
    // The expiry sweep posts a -5 forfeit adjustment dated exactly 2026-03-31.
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -5, '2026-03-31');

    const onDate = await bd(emp.employmentId, '2026-03-31'); // closed `<=`: the -5 row IS in scope
    expect(onDate!.carryForwardRemaining).toBe(0); // expiry has passed (date ≤ asOf)
    // forfeited = cap-excess at open (12→5 = 7) + the expiry lapse of the carried 5 = 12.
    expect(onDate!.forfeited).toBe(12);
    expect(onDate!.totalAvailable).toBe(12); // 17 − 5 swept = just the fresh 12
    // The forfeit row appears in the transaction list (the closed-interval inclusion).
    expect(onDate!.transactions.some((tx) => tx.entryType === 'adjustment' && tx.days === -5)).toBe(true);
  });

  it('(4) after the expiry date passes, carryForwardRemaining is 0 and forfeited reflects the lapse', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17, carry 5 unconsumed (cap-excess 7 forfeited at open)

    const after = await bd(emp.employmentId, '2026-04-30'); // past the 03-31 expiry, no sweep row posted
    expect(after!.carryForwardRemaining).toBe(0); // reconstruction: expiry passed
    // Reconstructed forfeit = cap-excess 7 + lapsed carry 5 = 12 (no tag needed; balance still 17 as no sweep ran).
    expect(after!.forfeited).toBe(12);
    expect(after!.totalAvailable).toBe(17);
  });
});

describe('leaveEntitlementBreakdown — single reconstruction path', () => {
  it('(5) a legacy plain-ledger year yields identical figures to a freshly-opened year', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });

    // A: built by the real openLeaveYear cron.
    const empA = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // prior 12 → carry 5 + 12 → 17

    // B: an identical 2026 state hand-built from plain accrual/adjustment rows (the "legacy" shape: no
    // tags, the carry folded into a Jan-1 accrual exactly as openLeaveYear would have posted it).
    const empB = await hire('2025-01-01'); // 12 at hire
    // openLeaveYear would post: −7 forfeit (12→5 cap) + 12 fresh, both dated 2026-01-01.
    await post(empB.employmentId, b.annualLeaveTypeId, 'adjustment', -7, '2026-01-01');
    await post(empB.employmentId, b.annualLeaveTypeId, 'accrual', 12, '2026-01-01');

    const rA = await bd(empA.employmentId, '2026-02-15');
    const rB = await bd(empB.employmentId, '2026-02-15');
    expect(rB!.carriedForward).toBe(rA!.carriedForward);
    expect(rB!.carryForwardRemaining).toBe(rA!.carryForwardRemaining);
    expect(rB!.currentYearEntitlement).toBe(rA!.currentYearEntitlement);
    expect(rB!.totalAvailable).toBe(rA!.totalAvailable);
    expect(rA!.carriedForward).toBe(5);
    expect(rA!.totalAvailable).toBe(17);
  });

  it('(6) zero-entitlement / carry-only year still reports the carry + its expiry', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01'); // 12 at hire
    // Open 2026 normally (carry 5 + 12), then post a -12 adjustment to zero out the fresh 2026 grant so the
    // cycle's net fresh entitlement is 0 but a positive carry of 5 remains.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -12, '2026-01-02');

    const r = await bd(emp.employmentId, '2026-02-15'); // before expiry
    expect(r!.carriedForward).toBe(5); // carry still reported
    expect(r!.carryForwardRemaining).toBe(5);
    expect(r!.carryForwardExpiryDate).toBe('2026-03-31');
    expect(r!.totalAvailable).toBe(5); // 17 − 12 = 5 (the carry survives)
  });
});

describe('leaveEntitlementBreakdown — empty / future states', () => {
  it('(7) as-at before hire / before any ledger row → defined empty/zero breakdown (not an error)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-06-01'); // hire grant dated 2025-06-01

    const r = await bd(emp.employmentId, '2025-01-01'); // before the hire grant
    expect(r).not.toBeNull(); // defined empty state, not an error
    expect(r!.currentYearEntitlement).toBe(0);
    expect(r!.carriedForward).toBe(0);
    expect(r!.totalAvailable).toBe(0);
    expect(r!.transactions).toEqual([]);
  });

  it('(8) as-at a future, not-yet-opened year shows zeros for that year (no projection)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01'); // 12 in 2025; 2026 has NOT been opened

    const r = await bd(emp.employmentId, '2026-08-01'); // a 2026 date, but no 2026 open run happened
    // The 2026 cycle's fresh entitlement is 0 (not projected to 12); the 2025 balance carries via priorBal.
    expect(r!.currentYearEntitlement).toBe(0);
    expect(r!.carriedForward).toBe(5); // min(prior 12, cap 5) — reconstructed, not opened
    expect(r!.totalAvailable).toBe(12); // the un-touched 2025 balance still in the ledger
  });
});

describe('leaveEntitlementBreakdown — RLS over the full table set', () => {
  async function setup() {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const subject = await hire('2025-01-01');
    const manager = await hire('2025-01-01');
    const peer = await hire('2025-01-01');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: subject.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2025-01-01',
    });
    // A pending request (so the leave_request table is also in play for the RLS assertion).
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-02-01',
      endDate: '2026-02-01',
      days: '1.00',
      status: 'pending',
    });

    const uS = await createAppUser(b.tenantId, subject.personId, 'employee');
    const sCtx: SessionContext = { tenantId: b.tenantId, userId: uS, roles: ['employee'], personId: subject.personId };
    const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
    const mCtx: SessionContext = { tenantId: b.tenantId, userId: uM, roles: ['manager'], personId: manager.personId };
    const uP = await createAppUser(b.tenantId, peer.personId, 'employee');
    const pCtx: SessionContext = { tenantId: b.tenantId, userId: uP, roles: ['employee'], personId: peer.personId };
    return { subject, sCtx, mCtx, pCtx };
  }

  it('(9a) subject, manager and admin all see the subject’s breakdown', async () => {
    const { subject, sCtx, mCtx } = await setup();
    const asSubject = await leaveEntitlementBreakdown(sCtx, subject.employmentId, b.annualLeaveTypeId, '2026-02-15');
    const asManager = await leaveEntitlementBreakdown(mCtx, subject.employmentId, b.annualLeaveTypeId, '2026-02-15');
    const asAdmin = await leaveEntitlementBreakdown(adminCtx(b), subject.employmentId, b.annualLeaveTypeId, '2026-02-15');
    expect(asSubject).not.toBeNull();
    expect(asManager).not.toBeNull();
    expect(asAdmin).not.toBeNull();
    expect(asSubject!.totalAvailable).toBe(asAdmin!.totalAvailable);
  });

  it('(9b) a non-manager peer gets NOTHING — no ledger/policy/request rows leak, no error', async () => {
    const { subject, pCtx } = await setup();
    // The employment row itself is hidden from the peer → a defined null (the page renders no panel).
    const asPeer = await leaveEntitlementBreakdown(pCtx, subject.employmentId, b.annualLeaveTypeId, '2026-02-15');
    expect(asPeer).toBeNull();
  });
});

describe('leave.breakdown i18n — real translations, not English passthrough', () => {
  const MESSAGES = path.resolve(__dirname, '../messages');
  const load = (loc: string) => JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8'));
  const en = load('en').leave.breakdown as Record<string, unknown>;
  // The clearly-translatable label keys (skip structural/short tokens like 'apply' that may legitimately
  // coincide). Non-Latin scripts (ta/th/zh) MUST differ byte-for-byte from en; ms/vi share the Latin
  // alphabet so a token may legitimately coincide — we only guard the non-Latin locales here.
  const LABEL_KEYS = [
    'title',
    'currentYearEntitlement',
    'monthlyAccrued',
    'carriedForward',
    'carryForwardRemaining',
    'carryForwardExpiry',
    'forfeited',
    'totalAvailable',
    'transactionsHeading',
  ];
  for (const loc of ['ta', 'th', 'zh'] as const) {
    it(`${loc} translates the breakdown labels (not byte-identical to en)`, () => {
      const dict = load(loc).leave.breakdown as Record<string, unknown>;
      const untranslated = LABEL_KEYS.filter((k) => dict[k] === en[k]);
      expect(untranslated, `[${loc}] English passthrough: ${untranslated.join(', ')}`).toEqual([]);
    });
  }
});
