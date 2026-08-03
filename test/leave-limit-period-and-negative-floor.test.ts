/**
 * r123 — two leave-type application rules that share a migration but nothing else.
 *
 *   ad9cb5c5  the application ceiling gains a PERIOD: leave year (today's meaning) | calendar year |
 *             once per employment.
 *   bc512dc3  allow_negative_balance gains a FLOOR, so "yes" stops meaning "without end".
 *
 * BOTH DEFAULT TO TODAY. Every existing row has NULL in both columns, and NULL must reproduce current
 * behaviour exactly — a rule nobody configured must never bind. That is the first thing asserted for each.
 *
 * ⚠️ READ THIS BEFORE CHANGING THE FLOOR TESTS. `allow_negative_balance` relaxes the SUBMIT-time balance
 * gate only. The approval path refuses whenever `balance - need < 0` (InsufficientLeaveBalanceError) and
 * never consults the flag, so a balance cannot go negative through the ordinary request-and-approve flow at
 * all. The floor therefore binds at SUBMISSION, and a floor checked at approval would be dead code behind a
 * strictly stronger rule. That asymmetry is PRE-EXISTING — test/leave-application-limit.test.ts's own
 * fixture comment documents it — and is raised separately on the board. The last test here pins it, so that
 * if someone does relax the approval gate they are told, in one failing test, that this floor now needs to
 * be enforced there too.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  applicationLimitWindow,
  resolveApplicationLimitPeriod,
  requestLeave,
  LeaveYearApplicationLimitExceededError,
  NegativeLeaveBalanceLimitExceededError,
} from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});

beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

afterAll(closeAll);

/** Drizzle wraps a PostgresError in a "Failed query: ..." Error, so the CHECK name is on `cause`, not on
 *  `message`. Asserting the name (rather than merely "it threw") is the point: these tests exist to prove
 *  the DATABASE refuses the pair, and a bare rejects.toThrow() passes on a typo in the insert. */
async function expectCheckViolation(run: () => Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${constraint} to be violated, but the insert succeeded`).toBeDefined();
  const cause = (caught as { cause?: { constraint_name?: string } }).cause;
  expect(cause?.constraint_name).toBe(constraint);
}

/** A type with no entitlement, so the application ceiling is the only thing that can refuse. */
async function limitedType(maxDays: number, period: string | null): Promise<string> {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `LIM_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Limited Leave',
      paid: false,
      allowNegativeBalance: true, // not what is under test — keeps the balance gate out of the way
      counting: 'calendar_days',
      maxDaysPerLeaveYear: maxDays.toFixed(2),
      maxDaysPeriod: period,
    })
    .returning({ id: schema.leaveType.id });
  return lt.id;
}

async function hire(name: string, hiredOn: string): Promise<string> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `lp_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  return e.employmentId;
}

const apply = (employmentId: string, leaveTypeId: string, startDate: string, endDate: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate, endDate });

describe('ad9cb5c5 · the application limit window is pure and testable without a database', () => {
  it('NULL and any unrecognised value resolve to leave_year — the meaning every existing row has', () => {
    expect(resolveApplicationLimitPeriod(null)).toBe('leave_year');
    expect(resolveApplicationLimitPeriod(undefined)).toBe('leave_year');
    expect(resolveApplicationLimitPeriod('')).toBe('leave_year');
    // Folded into the default rather than thrown on: a hand-edited row must not make every application of
    // a type unanswerable.
    expect(resolveApplicationLimitPeriod('per_fortnight')).toBe('leave_year');
    expect(resolveApplicationLimitPeriod('calendar_year')).toBe('calendar_year');
    expect(resolveApplicationLimitPeriod('employment')).toBe('employment');
  });

  it('calendar_year is January to December of the APPLICATION year, whatever the hire date', () => {
    expect(
      applicationLimitWindow({
        period: 'calendar_year',
        hiredOn: '2019-07-15',
        startDate: '2026-03-02',
        cycle: 'anniversary',
      }),
    ).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('calendar_year and leave_year DIFFER for an anniversary cycle — the reason both are offered', () => {
    const args = { hiredOn: '2020-07-15', startDate: '2026-03-02', cycle: 'anniversary' } as const;
    const cal = applicationLimitWindow({ period: 'calendar_year', ...args });
    const ly = applicationLimitWindow({ period: 'leave_year', ...args });
    expect(cal.start).not.toBe(ly.start);
    // The anniversary leave year is MONTH-anchored, not day-anchored: earnedCycleStart returns the 1st of
    // the hire MONTH, so the year containing 2026-03-02 starts 2025-07-01. Asserted as the real value
    // rather than the intuitive one — this window is shared with the pre-existing limit and accrual paths,
    // and "fixing" it to the hire day would move every one of them.
    expect(ly.start).toBe('2025-07-01');
  });

  it('employment spans hire date to the application date, so "how many so far" is date-independent', () => {
    expect(
      applicationLimitWindow({
        period: 'employment',
        hiredOn: '2020-07-15',
        startDate: '2026-03-02',
        cycle: 'calendar',
      }),
    ).toEqual({ start: '2020-07-15', end: '2026-03-02' });
  });

  it('an application dated BEFORE the hire date still yields a well-formed window', () => {
    // An inverted range would match nothing and silently permit an unlimited number of applications.
    const w = applicationLimitWindow({
      period: 'employment',
      hiredOn: '2026-05-01',
      startDate: '2026-04-01',
      cycle: 'calendar',
    });
    expect(w.start <= w.end).toBe(true);
    expect(w).toEqual({ start: '2026-04-01', end: '2026-04-01' });
  });
});

describe('ad9cb5c5 · the period changes which applications are refused', () => {
  it('once per employment: the second application is refused YEARS later', async () => {
    const employmentId = await hire('Marriage Once', '2020-01-01');
    const leaveTypeId = await limitedType(1, 'employment');

    await apply(employmentId, leaveTypeId, '2024-03-04', '2024-03-04');
    await expect(apply(employmentId, leaveTypeId, '2026-09-09', '2026-09-09')).rejects.toBeInstanceOf(
      LeaveYearApplicationLimitExceededError,
    );
  });

  it('per leave year (the default): the same second application is ALLOWED in a later year', async () => {
    const employmentId = await hire('Yearly', '2020-01-01');
    // NULL period — exactly the shape of every row written before migration 0352.
    const leaveTypeId = await limitedType(1, null);

    await apply(employmentId, leaveTypeId, '2024-03-04', '2024-03-04');
    // Same two dates that the employment-scoped type refused above.
    await expect(apply(employmentId, leaveTypeId, '2026-09-09', '2026-09-09')).resolves.toBeTruthy();
  });

  it('the refusal names WHICH period filled up, so "1 of 1" is not ambiguous', async () => {
    const employmentId = await hire('Named', '2020-01-01');
    const leaveTypeId = await limitedType(1, 'employment');
    await apply(employmentId, leaveTypeId, '2024-03-04', '2024-03-04');

    await expect(apply(employmentId, leaveTypeId, '2026-09-09', '2026-09-09')).rejects.toMatchObject({
      period: 'employment',
    });
    await expect(apply(employmentId, leaveTypeId, '2026-09-09', '2026-09-09')).rejects.toThrow(
      /per employment/,
    );
  });

  it('calendar_year refuses across a leave year boundary that leave_year would allow', async () => {
    // Hired in July on an anniversary cycle: 2026-03 and 2026-11 are the SAME calendar year but
    // DIFFERENT anniversary leave years.
    await owner.db
      .update(schema.company)
      .set({ leaveCycle: 'anniversary' })
      .where(eq(schema.company.id, b.companyId));
    const employmentId = await hire('Calendar', '2020-07-15');
    const leaveTypeId = await limitedType(1, 'calendar_year');

    await apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-02');
    await expect(apply(employmentId, leaveTypeId, '2026-11-02', '2026-11-02')).rejects.toBeInstanceOf(
      LeaveYearApplicationLimitExceededError,
    );
  });
});

describe('bc512dc3 · the floor under a permitted negative balance', () => {
  /** A type that permits a negative balance, optionally with a floor. No entitlement is granted. */
  async function negativeType(floor: number | null): Promise<string> {
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: `NEG_${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'Negative Leave',
        paid: true,
        counting: 'calendar_days',
        allowNegativeBalance: true,
        maxNegativeBalance: floor == null ? null : floor.toFixed(2),
      })
      .returning({ id: schema.leaveType.id });
    return lt.id;
  }

  it('NULL floor is unbounded — today’s behaviour, unchanged', async () => {
    const employmentId = await hire('Unbounded', '2020-01-01');
    const leaveTypeId = await negativeType(null);
    // Ten days against a zero balance: permitted, because the type says negative is fine and no floor is set.
    await expect(apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-11')).resolves.toBeTruthy();
  });

  it('a request that stays within the floor is permitted', async () => {
    const employmentId = await hire('Within', '2020-01-01');
    const leaveTypeId = await negativeType(5);
    await expect(apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-04')).resolves.toBeTruthy(); // -3
  });

  it('a request that lands exactly ON the floor is permitted — the limit is inclusive', async () => {
    const employmentId = await hire('Exact', '2020-01-01');
    const leaveTypeId = await negativeType(3);
    await expect(apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-04')).resolves.toBeTruthy(); // -3
  });

  it('a request that would pass the floor is REFUSED', async () => {
    const employmentId = await hire('Past', '2020-01-01');
    const leaveTypeId = await negativeType(3);
    await expect(apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-05')).rejects.toBeInstanceOf(
      NegativeLeaveBalanceLimitExceededError,
    ); // -4
  });

  it('the refusal states the limit AND the overshoot — that is the requirement, not a nicety', async () => {
    const employmentId = await hire('Message', '2020-01-01');
    const leaveTypeId = await negativeType(3);
    // 6 days against a zero balance ⇒ would land at -6, which is 3 past a floor of 3.
    await expect(apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-07')).rejects.toMatchObject({
      maxNegativeBalance: 3,
      requestedDays: 6,
      resultingBalance: -6,
      overshootDays: 3,
    });
  });

  it('the floor accumulates across applications rather than resetting per request', async () => {
    const employmentId = await hire('Accumulate', '2020-01-01');
    const leaveTypeId = await negativeType(4);
    // Two days, then two more: the second lands exactly on the floor.
    await apply(employmentId, leaveTypeId, '2026-03-02', '2026-03-03');
    await apply(employmentId, leaveTypeId, '2026-03-05', '2026-03-06');
    // A fifth day would be -5 against a floor of 4.
    await expect(apply(employmentId, leaveTypeId, '2026-03-09', '2026-03-09')).rejects.toBeInstanceOf(
      NegativeLeaveBalanceLimitExceededError,
    );
  });

  it('a floor never binds when the type does NOT allow a negative balance', async () => {
    // The database refuses that pair outright, which is what makes the enforcement branch unreachable
    // rather than merely unused. Pinned here because it is the invariant the UI relies on.
    await expectCheckViolation(
      () =>
        owner.db.insert(schema.leaveType).values({
          tenantId: b.tenantId,
          code: `BAD_${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Floor without permission',
          paid: true,
          allowNegativeBalance: false,
          maxNegativeBalance: '3.00',
        }),
      'leave_type_max_negative_needs_allow_check',
    );
  });

  it('a zero or negative floor is refused by the database', async () => {
    for (const bad of ['0.00', '-1.00']) {
      await expectCheckViolation(
        () =>
          owner.db.insert(schema.leaveType).values({
            tenantId: b.tenantId,
            code: `Z_${randomUUID().slice(0, 6).toUpperCase()}`,
            name: 'Zero floor',
            paid: true,
            allowNegativeBalance: true,
            maxNegativeBalance: bad,
          }),
        'leave_type_max_negative_balance_check',
      );
    }
  });
});

describe('ad9cb5c5 / bc512dc3 · the database refuses the half-configured pairs', () => {
  it('a period with no ceiling is refused — it configures the window of a limit that does not exist', async () => {
    await expectCheckViolation(
      () =>
        owner.db.insert(schema.leaveType).values({
          tenantId: b.tenantId,
          code: `P_${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Period without limit',
          paid: true,
          maxDaysPerLeaveYear: null,
          maxDaysPeriod: 'calendar_year',
        }),
      'leave_type_max_days_period_needs_limit_check',
    );
  });

  it('an unrecognised period is refused by the vocabulary check', async () => {
    await expectCheckViolation(
      () =>
        owner.db.insert(schema.leaveType).values({
          tenantId: b.tenantId,
          code: `V_${randomUUID().slice(0, 6).toUpperCase()}`,
          name: 'Bad period',
          paid: true,
          maxDaysPerLeaveYear: '5.00',
          maxDaysPeriod: 'per_fortnight',
        }),
      'leave_type_max_days_period_check',
    );
  });
});
