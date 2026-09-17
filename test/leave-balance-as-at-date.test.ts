/**
 * Employee Balances: the As-at date is a REAL point in time — feedback 3ddae357.
 *
 * THE DEFECT, precisely. `employeeBalanceRows` threaded `asOf` into ONE of its two reads.
 * `leaveEntitlementBreakdown` was date-aware; `leaveBalances` had no date argument at all and summed the
 * WHOLE ledger. So five columns moved with the date (Entitlement Year, YTD Entitled, Brought Forward,
 * Adjustment, Forfeited BF) and four did not (Taken, Pending Approval, Overutilized and BALANCE) — while
 * the last column printed back the date that had been typed, which is what made the screen look like it
 * had answered.
 *
 * THE FIXTURE IS THE REPORTER'S OWN DATA, reproduced read-only on production (2026-08-13). FARAH's ANNUAL
 * ledger is four rows across three years:
 *     2025-05-01  accrual     +10.67
 *     2026-01-01  adjustment   −0.67   sys:carry_forward_cap
 *     2026-08-01  accrual     +11.00
 *     2026-08-04  adjustment   −1.50   sys:profile_recalc
 * The whole-ledger sum is 19.50, which is exactly the Balance their screenshot showed at every date they
 * tried. The true point-in-time figures are 10.67 at 2025-12-31 and 10.00 at 2026-07-31. Those three
 * numbers are the whole item, so they are asserted literally rather than recomputed from the fixture — a
 * test that re-derives the expected value with the code under test proves only that it is consistent.
 *
 * WHAT ELSE IS GATED HERE, because this is the one item in its batch that changes NUMBERS HR QUOTES TO
 * EMPLOYEES:
 *   - undated `leaveBalances` is byte-identical, so the employee's own /leave page, the dashboard, both
 *     personnel profiles and `subordinateLeaveSummary` are provably untouched;
 *   - dated-at-today equals undated, so today's figures do not move on deploy;
 *   - the export and the screen render the same rows for the same date.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { todayInKualaLumpur } from '../core/leave';
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let emp: string;
let annualId: string;

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

/** FARAH's ANNUAL ledger, verbatim. */
const FARAH_LEDGER = [
  { effectiveOn: '2025-05-01', entryType: 'accrual' as const, days: '10.67', reason: null },
  { effectiveOn: '2026-01-01', entryType: 'adjustment' as const, days: '-0.67', reason: 'sys:carry_forward_cap' },
  { effectiveOn: '2026-08-01', entryType: 'accrual' as const, days: '11.00', reason: null },
  { effectiveOn: '2026-08-04', entryType: 'adjustment' as const, days: '-1.50', reason: 'sys:profile_recalc' },
];

const annualRow = async (asOf?: string) => {
  const rows = await leaveBalances(adminCtx(b), emp, undefined, asOf ? { includeHidden: true, asOf } : { includeHidden: true });
  const row = rows.find((r) => r.leaveTypeId === annualId);
  expect(row, `ANNUAL row missing at asOf=${asOf ?? '(undated)'}`).toBeTruthy();
  return row!;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  annualId = b.annualLeaveTypeId;
  const hired = await hireEmployee(adminCtx(b), {
    person: { fullName: 'FARAH', primaryEmail: `farah_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  emp = hired.employmentId;
  await owner.db.insert(schema.leaveLedger).values(
    FARAH_LEDGER.map((r) => ({ tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId, ...r })),
  );
});
afterAll(async () => {
  await closeAll();
});

describe('3ddae357: leaveBalances answers AS AT a date', () => {
  it('the reporter’s three point-in-time balances: 10.67 / 10.00 / 19.50', async () => {
    // Before the second accrual and after the carry-forward cap has NOT yet posted.
    expect((await annualRow('2025-12-31')).balance).toBe(10.67);
    // The cap has bitten (−0.67); the 2026-08 accrual and the recalc have not posted yet.
    expect((await annualRow('2026-07-31')).balance).toBe(10.0);
    // Everything on record.
    expect((await annualRow('2026-12-31')).balance).toBe(19.5);
    // And the whole-ledger figure the screen used to show at ALL THREE of those dates.
    expect((await annualRow()).balance).toBe(19.5);
  });

  it('an entry dated exactly ON the as-at date is INCLUDED (the boundary is inclusive)', async () => {
    // 2026-08-01 posts +11.00 onto the 10.00 standing at 2026-07-31.
    expect((await annualRow('2026-07-31')).balance).toBe(10.0);
    expect((await annualRow('2026-08-01')).balance).toBe(21.0);
    // …and the −1.50 recalc lands three days later.
    expect((await annualRow('2026-08-03')).balance).toBe(21.0);
    expect((await annualRow('2026-08-04')).balance).toBe(19.5);
  });

  it('a date before the FIRST entry reports zero, not the running total', async () => {
    const row = await annualRow('2025-04-30');
    // The type is still listed (eligible-but-inactive tail) — it simply has nothing on record yet.
    expect(row.balance).toBe(0);
    expect(row.accrued).toBe(0);
    expect(row.taken).toBe(0);
  });

  it('accrued and taken are dated too, not only the balance', async () => {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp,
      leaveTypeId: annualId,
      entryType: 'debit',
      days: '-2.00',
      effectiveOn: '2026-03-10',
    });
    const before = await annualRow('2026-03-09');
    const after = await annualRow('2026-03-11');
    expect(before.taken).toBe(0);
    expect(after.taken).toBe(2);
    // `accrued` counts only accrual rows: 10.67 by 2026-03, and 21.67 once 2026-08-01 posts.
    expect(after.accrued).toBe(10.67);
    expect((await annualRow('2026-08-02')).accrued).toBe(21.67);
  });
});

describe('3ddae357: pending approval is bounded by the leave dates', () => {
  beforeEach(async () => {
    await owner.db.insert(schema.leaveRequest).values([
      // Starts well before the as-at dates below.
      { tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId, startDate: '2026-03-02', endDate: '2026-03-03', days: '2', status: 'pending' },
      // Starts after them.
      { tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId, startDate: '2026-09-01', endDate: '2026-09-02', days: '3', status: 'pending' },
    ]);
  });

  it('counts a pending request that has STARTED by the as-at date, and only that one', async () => {
    expect((await annualRow('2026-02-28')).pending).toBe(0);
    expect((await annualRow('2026-07-31')).pending).toBe(2);
    expect((await annualRow('2026-09-01')).pending).toBe(5);
    // Undated still sees every pending request, whenever it starts.
    expect((await annualRow()).pending).toBe(5);
  });

  it('available (and therefore Overutilized) follows the dated pending figure', async () => {
    // 2026-07-31: balance 10.00 gross, one pending request of 2 days started.
    const mid = await annualRow('2026-07-31');
    expect(mid.balance).toBe(10.0);
    expect(mid.available).toBe(8.0);
    // Before anything is on record, a pending request that has begun overdraws the type.
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId,
      startDate: '2025-01-05', endDate: '2025-01-06', days: '4', status: 'pending',
    });
    const early = await annualRow('2025-01-31');
    expect(early.balance).toBe(0);
    expect(early.available).toBe(-4);
  });
});

describe('3ddae357: NO REGRESSION — every other caller is untouched', () => {
  it('leaveBalances WITHOUT asOf returns exactly what it returned before (the employee’s own page)', async () => {
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId,
      startDate: '2026-09-01', endDate: '2026-09-02', days: '3', status: 'pending',
    });
    const row = await annualRow();
    // Literal figures, not a re-derivation: this is the shape the /leave page, the dashboard, both
    // personnel profiles and subordinateLeaveSummary all read.
    expect(row.accrued).toBe(21.67);
    expect(row.taken).toBe(0);
    expect(row.pending).toBe(3);
    expect(row.balance).toBe(19.5);
    expect(row.available).toBe(16.5);
  });

  it('dated AT TODAY equals undated, row for row — today’s figures do not move on deploy', async () => {
    const today = todayInKualaLumpur();
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId,
      startDate: '2026-03-02', endDate: '2026-03-03', days: '2', status: 'pending',
    });
    const undated = await leaveBalances(adminCtx(b), emp, undefined, { includeHidden: true });
    const dated = await leaveBalances(adminCtx(b), emp, undefined, { includeHidden: true, asOf: today });
    expect(dated).toEqual(undated);
    // Guard the guard: the fixture must actually SPAN dates, or "equal at today" is vacuous.
    expect(FARAH_LEDGER.map((r) => r.effectiveOn.slice(0, 4))).toEqual(['2025', '2026', '2026', '2026']);
    expect(undated.find((r) => r.leaveTypeId === annualId)!.balance).toBe(19.5);
  });
});

describe('3ddae357: the four columns the ticket is about now move with the date', () => {
  beforeEach(async () => {
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId,
      entryType: 'debit', days: '-2.00', effectiveOn: '2026-03-10',
    });
    await owner.db.insert(schema.leaveRequest).values({
      tenantId: b.tenantId, employmentId: emp, leaveTypeId: annualId,
      startDate: '2026-09-01', endDate: '2026-09-02', days: '3', status: 'pending',
    });
  });

  const annualOf = async (asOf: string) => {
    const rows = await employeeBalanceRows(adminCtx(b), emp, asOf, 'en');
    const row = rows.find((r) => r.leaveTypeId === annualId);
    expect(row, `ANNUAL row missing from employeeBalanceRows at ${asOf}`).toBeTruthy();
    return row!;
  };

  it('Taken, Pending Approval, Overutilized and Balance all differ across three dates', async () => {
    const early = await annualOf('2026-02-28');
    const mid = await annualOf('2026-07-31');
    const late = await annualOf('2026-09-30');

    // Balance: the reporter's own three figures, now reaching the screen's row.
    expect([early.balance, mid.balance, late.balance]).toEqual([10.0, 8.0, 17.5]);
    // Taken: the 2026-03-10 debit.
    expect([early.taken, mid.taken, late.taken]).toEqual([0, 2, 2]);
    // Pending: the request starting 2026-09-01.
    expect([early.pending, mid.pending, late.pending]).toEqual([0, 0, 3]);
    // Overutilized stays 0 here (never overdrawn) but is derived from the DATED available, so it is
    // asserted as present-and-numeric rather than left unclaimed.
    expect([early.overutilized, mid.overutilized, late.overutilized]).toEqual([0, 0, 0]);
  });

  it('the five already-dated columns keep working', async () => {
    const mid = await annualOf('2026-07-31');
    // These come from leaveEntitlementBreakdown, which was date-aware before this change and still is.
    // The tenant may have no entitlement configured (the reporter's does not), so the assertion is that
    // the column RESOLVED, not that it holds a particular figure.
    expect(mid.entitlementYear === null || /^\d{4}$/.test(mid.entitlementYear)).toBe(true);
    for (const k of ['ytdEntitled', 'broughtForward', 'adjustment', 'forfeitedBf'] as const) {
      expect(mid[k] === null || typeof mid[k] === 'number', `${k} resolved`).toBe(true);
    }
  });

  it('the SCREEN and the EXPORT produce identical rows for the same as-at date', async () => {
    // Both surfaces render from `employeeBalanceRows` with the same arguments — that sharing IS the
    // guarantee, so it is asserted both at runtime and in the source of the route.
    const asOf = '2026-07-31';
    const screen = await employeeBalanceRows(adminCtx(b), emp, asOf, 'en', { dir: 'asc' });
    const exported = await employeeBalanceRows(adminCtx(b), emp, asOf, 'en', { q: undefined, typeIds: [], dir: 'asc' });
    expect(exported).toEqual(screen);

    const route = read('app/leave/employee-balances/export/route.ts');
    const page = read('app/leave/employee-balances/page.tsx');
    // Same validation and same fallback on both sides, so an export link can never resolve to a
    // different date than the page it was clicked from.
    expect(route).toContain("/^\\d{4}-\\d{2}-\\d{2}$/.test(rawAsOf) ? rawAsOf : todayInKualaLumpur()");
    expect(page).toContain("/^\\d{4}-\\d{2}-\\d{2}$/.test(sp.asOf) ? sp.asOf : todayInKualaLumpur()");
    // The same date reaches the rows AND the Date column in the file.
    expect(route).toContain('employeeBalanceRows(session, selected.employmentId, asOf, locale, {');
    // 31e39d74 UPDATED THIS ASSERTION, IT DID NOT RETIRE IT. The claim — "the Date column is fed the same
    // `asOf` the rows were read at" — is unchanged and still worth pinning. What changed is that the Date
    // column is no longer immediately after Balance: an Entitlement Status column now sits between them
    // (a 0.00 that is merely ungenerated must say so in the file as well as on the screen). The assertion
    // was written as "…balance, then asOf", which pinned the neighbour rather than the claim; it now pins
    // `asOf` as the LAST cell of the row tuple, which is the claim and survives the next column too.
    expect(route).toContain('      asOf,\n    ]),');
  });
});

describe('3ddae357: the page comment no longer claims something false', () => {
  it('the header records which columns move and why, instead of asserting all of them do', () => {
    const page = read('app/leave/employee-balances/page.tsx');
    // The retired claim, verbatim from before this change.
    expect(
      page.includes('Changing the as-at date re-runs the breakdown, so YTD Entitled / Taken / Pending / Adjustment /'),
    ).toBe(false);
    expect(page).toContain('THE AS-AT DATE (3ddae357)');
    expect(page).toContain('THAT WAS FALSE');
  });

  it('rows.ts passes the SAME asOf to both of its reads', () => {
    const rows = read('app/leave/employee-balances/rows.ts');
    // ec991c2a: `includeArchived: true` joined `includeHidden: true` here — this is an ADMIN read and an
    // archived leave type must keep showing the balance standing under it. The decision this guard pins is
    // untouched: the SAME asOf reaches both reads.
    expect(rows).toContain(
      'leaveBalances(ctx, employmentId, locale, { includeHidden: true, includeArchived: true, asOf })',
    );
    // r303 (31492f74): the breakdown read now also asks for HR's per-line working. The decision this guard pins is
    // untouched — the SAME asOf reaches both reads — so the pin is updated to the new call, not loosened.
    expect(rows).toContain('leaveEntitlementBreakdown(ctx, employmentId, b.leaveTypeId, asOf, locale, { derivation: true })');
  });
});
