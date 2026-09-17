/**
 * 296fc027 Step 2 — the EMPLOYEE replacement-leave request: submit, approve, and the credit that appears
 * only when a line manager says so.
 *
 * WHAT THIS FILE IS REALLY DEFENDING. The feature is a self-service button that mints a leave credit, and
 * every test below is a variation on one question: can the button be used to get something the manager
 * route would have refused? The four controls it must not be able to walk around are the chargeable
 * add-on, the per-company employee-request switch, the eligibility criteria, and — the one that is a legal
 * obligation rather than a product rule — the First Schedule statutory overtime floor.
 *
 * Dates are INJECTED throughout (`today`, `decidedAt`), the convention the rest of the TOIL engine already
 * follows, so an expiry is ASSERTED rather than recomputed by the test using the same arithmetic as the
 * code under test — which would pass for a wrong implementation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setRestDay } from '../core/roster';
import { checkIn, checkOut } from '../core/attendance';
import { accrueToil, resolveExpiry, setToilPolicy, type ToilPolicyInput } from '../core/toil';
import {
  decideReplacementLeaveRequest,
  listReplacementLeaveRequests,
  replacementRequestAvailability,
  submitReplacementLeaveRequest,
  totalsFor,
  ReplacementRequestDisabledError,
  ReplacementRequestNotEligibleError,
} from '../core/replacement-request';
import { ToilAlreadyAccruedError } from '../core/toil';

let b: Base;
let ctx: SessionContext;

const TODAY = '2026-07-20';
const WORKED_A = '2026-07-04';
const WORKED_B = '2026-07-11';
// The manager's decision. Deliberately WELL AFTER both worked dates, so an implementation that anchored
// the expiry on the worked date (or the submission date) produces a visibly different answer rather than
// one that happens to coincide.
const DECIDED_AT = new Date('2026-07-25T03:00:00.000Z');

const uniqEmail = () => `rlr_${Math.random().toString(36).slice(2)}@t.local`;

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

/** Hire on a salary ABOVE the First Schedule ceiling unless a test wants the statutory floor in play. */
async function hire(basic = 8000, departmentId?: string) {
  const e = await hireEmployee(ctx, {
    person: { fullName: 'RL Requester', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  return e.employmentId;
}

const accrualsFor = (employmentId: string) =>
  owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId));

async function replacementBalance(employmentId: string): Promise<number> {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return rows.reduce((s, r) => s + Number(r.days), 0);
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

// ── The totals shown at the bottom of the table ──────────────────────────────────────────────────────
describe('Multi-row totals (296fc027)', () => {
  it('DAY unit sums the declared days across rows', () => {
    const t = totalsFor('day', [
      { workedDate: WORKED_A, days: 1 },
      { workedDate: WORKED_B, days: 0.5 },
    ]);
    expect(t.totalDays).toBe(1.5);
    expect(t.totalHours).toBe(12); // 1.5 × the 8-hour standard day
    expect(t.perLine.map((l) => l.days)).toEqual([1, 0.5]);
  });

  it('HOUR unit totals the From/To spans and converts to days on the standard 8-hour day', () => {
    const t = totalsFor('hour', [
      { workedDate: WORKED_A, fromTime: '09:00', toTime: '17:00' }, // 8h
      { workedDate: WORKED_B, fromTime: '13:00', toTime: '17:30' }, // 4.5h
    ]);
    expect(t.totalHours).toBe(12.5);
    expect(t.totalDays).toBe(1.56); // 12.5 / 8, rounded to 2dp
    expect(t.perLine.map((l) => l.minutes)).toEqual([480, 270]);
  });

  it('refuses a reversed or zero time span rather than crediting nothing', () => {
    // An employee who typed 17:00 → 08:00 made a mistake. Silently banking zero days would leave them
    // believing they had claimed something.
    expect(() => totalsFor('hour', [{ workedDate: WORKED_A, fromTime: '17:00', toTime: '08:00' }])).toThrow(
      /must be later/i,
    );
    expect(() => totalsFor('day', [{ workedDate: WORKED_A, days: 0 }])).toThrow(/greater than zero/i);
  });
});

// ── The expiry anchor: the thing the request is most explicit about ──────────────────────────────────
describe('The credit is granted on APPROVAL, and expires from that date (296fc027)', () => {
  it('submitting grants NOTHING — no accrual, no ledger movement', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    expect(await accrualsFor(employmentId)).toHaveLength(0);
    expect(await replacementBalance(employmentId)).toBe(0);
    const [req] = await listReplacementLeaveRequests(ctx, employmentId);
    expect(req.status).toBe('pending');
  });

  it('approval mints one credit per worked date, expiring from the APPROVAL date not the date worked', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { expiryDays: 90 }));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [
        { workedDate: WORKED_A, days: 1 },
        { workedDate: WORKED_B, days: 1 },
      ],
      today: TODAY,
    });

    const res = await decideReplacementLeaveRequest(ctx, {
      requestId,
      decision: 'approved',
      decidedAt: DECIDED_AT,
    });
    expect(res.granted).toBe(2);
    expect(res.daysCredited).toBe(2);

    const accruals = await accrualsFor(employmentId);
    expect(accruals).toHaveLength(2);
    for (const a of accruals) {
      // THE ASSERTION THE WHOLE STEP EXISTS FOR. Decision 2026-07-25 + 90 days = 2026-10-23. Anchoring on
      // the worked dates would have given 2026-10-02 and 2026-10-09; anchoring on the submission date
      // (2026-07-20) would have given 2026-10-18. All three are different, so this cannot pass by accident.
      expect(a.expiresOn).toBe('2026-10-23');
      expect(a.approvedOn?.toISOString()).toBe(DECIDED_AT.toISOString());
      // The REQUEST date is the employee's own submission — a real request exists on this path, unlike
      // the roster election which has to fall back to the worked day.
      expect(a.requestedOn).toBe(TODAY);
      expect(a.source).toBe('employee_request');
      // Self-declared: no attendance row was consulted. 3fb1a611 (r299) — the day KIND is RESOLVED from the
      // employee's schedule (never guessed) and an ordinary working day is refused; both worked dates are
      // Saturdays, a rest day under the seeded company's working week. The valuation `day_type` stays NULL
      // (r299 fix pass — see test/toil-expiry.test.ts).
      expect(a.dayType).toBeNull();
      expect(a.workedDayKind).toBe('rest_day');
    }
    expect(await replacementBalance(employmentId)).toBe(2);
  });

  it('a MONTHS expiry period is counted in calendar months from the approval too', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { expiryUnit: 'months', expiryMonths: 3 }));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    const res = await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(res.expiresOn).toBe('2026-10-25'); // 2026-07-25 + 3 calendar months
  });

  /**
   * c1b14600 — NOTHING ABOUT THIS WORKFLOW IS HARDCODED, AND THIS IS THE CASE THAT SAYS SO.
   *
   * The reporter asked us to confirm that Replacement Leave in Lieu is driven by the existing
   * Leave Config > Replacement Leave settings rather than by a separate company or expiry list of our
   * own. Every other case in this file flips ONE company's switches and watches the behaviour follow.
   * This one runs TWO companies in the SAME tenant with DIFFERENT settings at the SAME moment, which is
   * the only shape that can tell "reads the company's own policy" apart from "reads a policy".
   *
   * Company A: enabled, employee requests on, expiry 3 MONTHS.
   * Company B: enabled, employee requests OFF, expiry 90 DAYS.
   * One approval date, two different answers, neither of them a constant in our code.
   */
  it('two companies in one tenant follow their OWN Leave Config settings, not a shared default', async () => {
    // A second company alongside the seeded one, with its own department to hire into.
    const [coB] = await owner.db
      .insert(schema.company)
      .values({ tenantId: b.tenantId, legalName: 'Second Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [deptB] = await owner.db
      .insert(schema.department)
      .values({ tenantId: b.tenantId, companyId: coB.id, name: 'Second Ops' })
      .returning({ id: schema.department.id });

    await setToilPolicy(ctx, policy(b.companyId, { expiryUnit: 'months', expiryMonths: 3 }));
    await setToilPolicy(ctx, policy(coB.id, { employeeRequestEnabled: false, expiryUnit: 'days', expiryDays: 90 }));

    const inA = await hire();
    const inB = await hireEmployee(ctx, {
      person: { fullName: 'RL Second Co', primaryEmail: uniqEmail() },
      companyId: coB.id,
      departmentId: deptB.id,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(ctx, {
      employmentId: inB.employmentId,
      basicSalary: 8000,
      monthlyAllowance: 0,
      effectiveFrom: '2024-01-01',
    });

    // 1. THE SELF-SUBMISSION SWITCH is read per company: A may, B may not.
    expect((await replacementRequestAvailability(ctx, inA, TODAY)).allowed).toBe(true);
    const bAvail = await replacementRequestAvailability(ctx, inB.employmentId, TODAY);
    expect(bAvail.allowed).toBe(false);
    // r219 UPDATED THIS ASSERTION, IT DID NOT RETIRE IT (AGENTS rule 18). The property it defends — the
    // self-submission switch is read PER COMPANY, so B's employee is refused where A's is not — is
    // unchanged and is the line above. What changed is the NAME of the refusal: `not_enabled` used to
    // cover both company switches at once, and r219 split it because the screen now says which one to go
    // and turn on. Company B has replacement leave ENABLED and only employee submission off, which is
    // exactly the case the second name exists for.
    expect(bAvail.reason).toBe('employee_requests_off');
    // …and the refusal is the SERVICE's, not the screen's.
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId: inB.employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toBeInstanceOf(Error);

    // 2. THE EXPIRY PERIOD is read per company, and anchored on the APPROVAL date in both.
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId: inA,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    const a = await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(a.expiresOn).toBe('2026-10-25'); // company A: approval 2026-07-25 + 3 MONTHS

    // Company B's own period applied to the same approval date is a different answer — 90 DAYS, not 3
    // months. Asserted through the ONE function allowed to read the three columns together, because that
    // is the thing a future hardcoding would have to go around.
    expect(resolveExpiry('2026-07-25', { expiryUnit: 'days', expiryDays: 90 })).toBe('2026-10-23');
    expect(resolveExpiry('2026-07-25', { expiryUnit: 'months', expiryDays: 90, expiryMonths: 3 })).toBe('2026-10-25');
  });

  it('an HOUR request banks the declared hours as a fraction of the standard day', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId, totalHours } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'hour',
      lines: [
        { workedDate: WORKED_A, fromTime: '09:00', toTime: '13:00' }, // 4h
        { workedDate: WORKED_B, fromTime: '09:00', toTime: '11:00' }, // 2h
      ],
      today: TODAY,
    });
    expect(totalHours).toBe(6);
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });
    const accruals = await accrualsFor(employmentId);
    const credited = accruals.map((a) => Number(a.daysCredited)).sort();
    expect(credited).toEqual([0.25, 0.5]); // 2h and 4h over an 8-hour day
    expect(await replacementBalance(employmentId)).toBe(0.75);
  });

  it('a REJECTED request grants nothing and leaves no accrual behind', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    const res = await decideReplacementLeaveRequest(ctx, { requestId, decision: 'rejected', decidedAt: DECIDED_AT });
    expect(res.granted).toBe(0);
    expect(await accrualsFor(employmentId)).toHaveLength(0);
    expect(await replacementBalance(employmentId)).toBe(0);
    // …and it cannot then be approved: a decided request is decided.
    await expect(decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved' })).rejects.toThrow(
      /already been decided/i,
    );
  });
});

// ── The employee-request switch ──────────────────────────────────────────────────────────────────────
describe('The employee-request switch is enforced SERVER-SIDE (296fc027)', () => {
  it('with the switch OFF the button is not offered AND the submission is refused', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { employeeRequestEnabled: false }));

    // The button: the page branches on exactly this.
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    // r219 UPDATED, NOT RETIRED (AGENTS rule 18): the refusal is unchanged, its NAME is narrower. This
    // policy is `enabled` with only `employeeRequestEnabled` off, and the screen now tells an
    // administrator which of the two switches that is — so the two states cannot share one name.
    expect(avail.reason).toBe('employee_requests_off');

    // …and the POST, which is the control that actually matters — hiding a button stops nobody who can
    // send a form.
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(ReplacementRequestDisabledError);
    expect(await accrualsFor(employmentId)).toHaveLength(0);
  });

  it('with replacement leave itself disabled for the company, the request is refused', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { enabled: false, employeeRequestEnabled: true }));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(ReplacementRequestDisabledError);
  });
});

// ── Eligibility ──────────────────────────────────────────────────────────────────────────────────────
describe('Eligibility criteria gate the request (296fc027)', () => {
  it('an employee OUTSIDE the criteria sees no button and is refused server-side', async () => {
    const inside = await hire(8000, b.deptA);
    const outside = await hire(8000, b.deptB);
    await setToilPolicy(ctx, policy(b.companyId, { requestEligibility: { departmentIds: [b.deptA] } }));

    expect((await replacementRequestAvailability(ctx, inside, TODAY)).allowed).toBe(true);

    const avail = await replacementRequestAvailability(ctx, outside, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('not_eligible');

    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId: outside,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(ReplacementRequestNotEligibleError);
    expect(await accrualsFor(outside)).toHaveLength(0);
  });

  it('a NAMED individual qualifies even when they fail every org criterion', async () => {
    const outside = await hire(8000, b.deptB);
    await setToilPolicy(
      ctx,
      policy(b.companyId, { requestEligibility: { departmentIds: [b.deptA], employmentIds: [outside] } }),
    );
    expect((await replacementRequestAvailability(ctx, outside, TODAY)).allowed).toBe(true);
    const r = await submitReplacementLeaveRequest(ctx, {
      employmentId: outside,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    expect(r.totalDays).toBe(1);
  });

  it('empty criteria admit everyone', async () => {
    const anyone = await hire(8000, b.deptB);
    await setToilPolicy(ctx, policy(b.companyId)); // no requestEligibility at all
    expect((await replacementRequestAvailability(ctx, anyone, TODAY)).allowed).toBe(true);
  });
});

// ── The double-bank guard, which the employee path must not weaken ───────────────────────────────────
describe('A worked date already banked cannot be claimed again (296fc027)', () => {
  it('refuses a request for a date a MANAGER already banked from the roster', async () => {
    const employmentId = await hire(8000);
    await setToilPolicy(ctx, policy(b.companyId));
    // The manager route banks the rest day first, exactly as it does today.
    await setRestDay(ctx, { employmentId, shiftDate: WORKED_A });
    await checkIn(ctx, { employmentId, date: WORKED_A, time: '08:00:00' });
    await checkOut(ctx, { employmentId, date: WORKED_A, time: '17:00:00' });
    await accrueToil(ctx, { employmentId, workedDate: WORKED_A, approvedOn: new Date('2026-07-06T02:00:00.000Z') });
    expect(await accrualsFor(employmentId)).toHaveLength(1);

    // The employee now claims the same day. This is the guard the request says must stay exactly as it is.
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(ToilAlreadyAccruedError);
    expect(await accrualsFor(employmentId)).toHaveLength(1); // still exactly one
  });

  it('refuses a date banked BETWEEN submission and approval, and rolls the whole approval back', async () => {
    // The submit-time check is a courtesy; the accrual-time unique index is the guarantee. A manager can
    // bank one of these days while the request sits pending, and the approval must then fail as a UNIT —
    // a half-granted request would leave the employee unable to tell what they had been given.
    const employmentId = await hire(8000);
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [
        { workedDate: WORKED_A, days: 1 },
        { workedDate: WORKED_B, days: 1 },
      ],
      today: TODAY,
    });

    await setRestDay(ctx, { employmentId, shiftDate: WORKED_B });
    await checkIn(ctx, { employmentId, date: WORKED_B, time: '08:00:00' });
    await checkOut(ctx, { employmentId, date: WORKED_B, time: '17:00:00' });
    await accrueToil(ctx, { employmentId, workedDate: WORKED_B, approvedOn: new Date('2026-07-13T02:00:00.000Z') });

    await expect(
      decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT }),
    ).rejects.toThrow(ToilAlreadyAccruedError);

    // Rolled back as a unit: only the manager's own credit survives, and the request is still pending.
    const accruals = await accrualsFor(employmentId);
    expect(accruals).toHaveLength(1);
    expect(accruals[0].workedDate).toBe(WORKED_B);
    const [req] = await listReplacementLeaveRequests(ctx, employmentId);
    expect(req.status).toBe('pending');
  });

  it('rejects the same worked date twice within ONE request', async () => {
    const employmentId = await hire(8000);
    await setToilPolicy(ctx, policy(b.companyId));
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [
          { workedDate: WORKED_A, days: 1 },
          { workedDate: WORKED_A, days: 1 },
        ],
        today: TODAY,
      }),
    ).rejects.toThrow(/more than once/i);
  });
});

// ── THE STATUTORY FLOOR. The reason a self-service button needed this much care. ─────────────────────
describe('The First Schedule gate is not bypassable from self-service (296fc027)', () => {
  // RM2,000 is comfortably below the RM4,000 overtime protection ceiling, so this employee is legally
  // entitled to overtime CASH rather than banked time.
  const FIRST_SCHEDULE_WAGE = 2000;

  it('refused outright when the company has NOT switched the override on', async () => {
    const employmentId = await hire(FIRST_SCHEDULE_WAGE);
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: false }));

    // No button either — offering a form that cannot be granted is its own defect.
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);

    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
        firstScheduleConsent: true, // even WITH consent: the company override is a separate condition
      }),
    ).rejects.toThrow(ReplacementRequestNotEligibleError);
    expect(await accrualsFor(employmentId)).toHaveLength(0);
  });

  it('refused when the override IS on but the employee has NOT recorded their agreement', async () => {
    const employmentId = await hire(FIRST_SCHEDULE_WAGE);
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: true }));

    // The button IS offered — with the consent checkbox, which is what the flag is for.
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(true);
    expect(avail.requiresFirstScheduleConsent).toBe(true);

    // Submitting without it is refused. (A browser can drop a required checkbox; the server cannot.)
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKED_A, days: 1 }],
        today: TODAY,
        firstScheduleConsent: false,
      }),
    ).rejects.toThrow(ReplacementRequestNotEligibleError);
    expect(await accrualsFor(employmentId)).toHaveLength(0);
  });

  it('permitted with BOTH the override and recorded consent — and the credit carries the floor protection', async () => {
    const employmentId = await hire(FIRST_SCHEDULE_WAGE);
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: true, onExpiry: 'lapse' }));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
      firstScheduleConsent: true,
    });
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });

    const [acc] = await accrualsFor(employmentId);
    expect(acc.firstScheduleConsent).toBe(true);
    // FLOOR PROTECTION: the company policy says 'lapse', but an eligible employee's unused credit must
    // always convert to pay. The frozen expiryAction overrides the policy, and it must do so on this path
    // exactly as it does on the manager's — which is the point of sharing bankToilCreditTx rather than
    // writing a second insert.
    expect(acc.expiryAction).toBe('convert_to_pay');
  });

  it('an employee ABOVE the ceiling needs no consent at all', async () => {
    const employmentId = await hire(8000);
    await setToilPolicy(ctx, policy(b.companyId));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(true);
    expect(avail.requiresFirstScheduleConsent).toBe(false);
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });
    const [acc] = await accrualsFor(employmentId);
    // NULL, not false: consent is moot above the ceiling, and recording `false` would read as "asked and
    // declined" on an audit surface.
    expect(acc.firstScheduleConsent).toBeNull();
  });
});

// ── Input validation the form relies on ──────────────────────────────────────────────────────────────
describe('Request validation (296fc027)', () => {
  it('refuses a future worked date', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: '2026-12-31', days: 1 }],
        today: TODAY,
      }),
    ).rejects.toThrow(/future/i);
  });

  it('refuses a request with no worked dates', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await expect(
      submitReplacementLeaveRequest(ctx, { employmentId, unit: 'day', lines: [], today: TODAY }),
    ).rejects.toThrow(/at least one/i);
  });

  it('stores the totals as submitted and reads them back with their lines', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'hour',
      lines: [
        { workedDate: WORKED_A, fromTime: '09:00', toTime: '17:00' },
        { workedDate: WORKED_B, fromTime: '09:00', toTime: '12:00' },
      ],
      reason: 'Weekend deployment',
      today: TODAY,
    });
    const [req] = await listReplacementLeaveRequests(ctx, employmentId);
    expect(req.unit).toBe('hour');
    expect(req.totalHours).toBe(11);
    expect(req.reason).toBe('Weekend deployment');
    expect(req.dates).toHaveLength(2);
    expect(req.dates[0]).toMatchObject({ workedDate: WORKED_A, fromTime: '09:00:00', toTime: '17:00:00', hours: 8 });
  });
});

// ── The whole point, end to end ──────────────────────────────────────────────────────────────────────
describe('The employee path reaches the same register the manager path writes (296fc027)', () => {
  it('an approved request is visible on the replacement-leave register and the balance', async () => {
    const employmentId = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { requestId } = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKED_A, days: 1 }],
      today: TODAY,
    });
    await decideReplacementLeaveRequest(ctx, { requestId, decision: 'approved', decidedAt: DECIDED_AT });

    // The register row links back to the line that produced it, so "was this line banked?" is answerable
    // without re-deriving it from dates.
    const lines = await owner.db
      .select()
      .from(schema.replacementLeaveRequestDate)
      .where(eq(schema.replacementLeaveRequestDate.requestId, requestId));
    expect(lines[0].accrualId).not.toBeNull();

    const [acc] = await accrualsFor(employmentId);
    expect(acc.id).toBe(lines[0].accrualId);
    expect(acc.status).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1);

    // And the audit trail records the approval as its own event, not only the accrual's.
    const events = await withTenant(ctx, (tx) =>
      tx
        .select({ t: schema.domainEvent.eventType })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.aggregateId, requestId)),
    );
    expect(events.map((e) => e.t).sort()).toEqual([
      'replacement-leave-request.approved',
      'replacement-leave-request.submitted',
    ]);
  });
});
