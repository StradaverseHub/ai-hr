/**
 * d58bfa3f — "Prorated Annual Leave Entitlement setting", and what is ACTUALLY wrong behind it.
 *
 * ── THE TICKET ASKED FOR TWO SETTINGS THAT ALREADY EXIST ────────────────────────────────────────────
 * The reporter asked for a proration TRIGGER and a proration FORMULA + ROUNDING RULE. Both are already
 * built: first-year ANNUAL proration is automatic and deliberately not a checkbox
 * (core/leave-generation.ts ~:76 — "still automatic, still one definition, and still not something a
 * checkbox here decides"), and the rounding table shipped in r303 as `rounding_method='custom'` +
 * `rounding_bands`. So building either would have fixed nothing, and this file is the evidence for what
 * WOULD.
 *
 * ── THE REPORTER'S TWO NUMBERS ARE THE TWO SIDES OF A DIVERGENCE OUR OWN CODE DOCUMENTS ─────────────
 * Employee 100814: hired 23 Jul 2026, 16 days/year. They reported seeing **Earned to Date 2.50** and
 * expecting **7.10**. Both figures fall out of the gap `core/leave.ts` ~:9353 already describes:
 *
 *   • the KERNEL (`projectExpectedEntitlement`) tests `a2cFirstYear` BEFORE the earned branch, so it
 *     projects the a2c UP-FRONT part-year figure: 162/365 × 16 = 7.101 → **7.10**, the reporter's expected
 *     number to the decimal;
 *   • the ENGINE (`accrueEarnedLeave`) contains zero a2c handling, so it credits daily slices:
 *     57/365 × 16 = 2.499 → **2.50**, the reporter's observed number to the decimal.
 *
 * That is not a coincidence and it is not a guess: it is arithmetic, and it reproduces here without any
 * access to their database. THE TICKET IS THAT DIVERGENCE, which the code itself calls "a separate item".
 *
 * ── WHAT THIS FILE DOES AND DELIBERATELY DOES NOT DO ────────────────────────────────────────────────
 * It PINS the divergence with the reporter's own figures, so whoever closes it has a red arm that names
 * the case rather than the abstract one in test/leave-earning-method-simplified.test.ts (which compares
 * the kernel to a pure function, not to what the engine actually CREDITS).
 *
 * It does NOT fix it, and that is deliberate on two counts. First, closing it is a DECISION between two
 * behaviours the code names — teach `accrueEarnedLeave` about a2c, or let an a2c first year override the
 * earned method — and that decision changes what "earn daily" means in a hire year for every affected
 * employee. Second, the plan the reporter APPROVED promises in as many words that we confirm the cause on
 * their own record and show them the list of affected employees BEFORE anything is applied. Shipping a
 * silent recalculation here would break a promise already made. Annual leave feeds encashment and final
 * pay; this is the wrong place to be quick.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave } from '../core/leave';
import { setLeaveTypeRules } from '../core/admin';

let b: Base;

const uniqEmail = () => `a2c_${randomUUID().slice(0, 8)}@t.local`;

/** The reporter's employee: hired 23 Jul 2026, on a 16-day ANNUAL entitlement. */
const hireOn = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Eee Lee Yong (fixture)', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const annualBalance = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
      ),
    );
  return Number(r.bal);
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

describe('d58bfa3f · the reporter’s two numbers, reproduced without reading their database', () => {
  /**
   * THE ARITHMETIC, STATED FIRST SO THE FIXTURE CANNOT QUIETLY DRIFT FROM THE TICKET. 23 Jul → 31 Dec 2026
   * inclusive is 162 days, which is the figure the reporter did their own sum with.
   */
  it('23 Jul to 31 Dec 2026 is 162 days, and 162/365 × 16 is the 7.10 the reporter expects', () => {
    const hire = Date.UTC(2026, 6, 23);
    const yearEnd = Date.UTC(2026, 11, 31);
    const days = (yearEnd - hire) / 86_400_000 + 1;
    expect(days, 'the reporter counted 162').toBe(162);
    expect(Math.round(((days / 365) * 16 + Number.EPSILON) * 100) / 100).toBe(7.1);
  });

  it('…and 23 Jul to 17 Sep is the 2.50 they actually see on the screen', () => {
    const hire = Date.UTC(2026, 6, 23);
    const asOf = Date.UTC(2026, 8, 17);
    const elapsed = (asOf - hire) / 86_400_000 + 1;
    expect(elapsed).toBe(57);
    expect(Math.round(((elapsed / 365) * 16 + Number.EPSILON) * 100) / 100).toBe(2.5);
  });

  /**
   * THE DIVERGENCE ITSELF, against the ENGINE rather than a pure function.
   *
   * `accrueEarnedLeave` is what actually writes the ledger the screen reads, and it has no a2c branch. So
   * on the reporter's exact configuration it credits the daily slice — the 2.50 — while the whole point of
   * an a2c first year is that the employee is granted their prorated part-year UP FRONT.
   */
  it('THE DEFECT: with a2c + Daily Accrual in the hire year, the engine credits the daily slice, not the up-front part-year', async () => {
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      validFrom: '2026-01-01',
    });
    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      accrualMethod: 'earned_daily',
    });
    await owner.db
      .update(schema.leaveType)
      .set({ yearCycleOverride: 'a2c' })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));

    const emp = await hireOn('2026-07-23');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-09-17' });

    const credited = await annualBalance(emp.employmentId);

    // The reporter's observed figure, from the engine, on their own configuration.
    expect(credited, "the engine credits the daily slice — the reporter's 2.50").toBeCloseTo(2.5, 1);

    // …and it is NOT the up-front a2c part-year figure an a2c first year is supposed to grant.
    expect(credited, 'the up-front a2c figure is 7.10, and the engine never produces it').not.toBeCloseTo(
      7.1,
      1,
    );
  });

  /**
   * THE CONTROL. Without a2c the same daily configuration is not in dispute at all — the engine and the
   * kernel agree, and nothing about this ticket applies. This is what keeps the test above honest: it is
   * the a2c FIRST YEAR combination that diverges, not Daily Accrual generally.
   */
  it('CONTROL: the same Daily Accrual WITHOUT a2c is not the reporter’s case', async () => {
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      validFrom: '2026-01-01',
    });
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_daily' });

    const emp = await hireOn('2026-07-23');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-09-17' });

    // Same slice, and here it is the RIGHT answer: a plain calendar type earns day by day by design, so
    // there is no second opinion for it to disagree with.
    expect(await annualBalance(emp.employmentId)).toBeCloseTo(2.5, 1);
  });
});

describe('d58bfa3f · what must NOT be built, pinned so a later round does not build it anyway', () => {
  it('proration is already automatic, and is deliberately NOT a checkbox', () => {
    const gen = readSrc('/core/leave-generation.ts');
    expect(gen).toContain('not something a checkbox here decides');
  });

  it('the rounding table the ticket describes already exists (r303)', () => {
    // `rounding_method = 'custom'` + `rounding_bands`, edited on Leave Config › Entitlements. A second
    // rounding mechanism for the same figure is the thing to refuse here.
    expect(readSrc('/db/schema.ts')).toContain("roundingMethod: text('rounding_method')");
    expect(readSrc('/app/admin/leave-config/types/leave-type-sub-forms.tsx')).toContain('roundingBands');
  });

  it('Full Entitlement is the year’s allowance BEFORE proration — it must not be prorated', () => {
    // r279 decided this against the reporter's own rename request and wrote down why. The reporter reads
    // 16.00 there as the bug; it is the column doing exactly its job.
    expect(readSrc('/components/leave/leave-balance-row.ts')).toContain('before proration');
  });
});

function readSrc(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');
  return fs.readFileSync(fileURLToPath(new URL('..', import.meta.url)) + rel, 'utf8');
}
