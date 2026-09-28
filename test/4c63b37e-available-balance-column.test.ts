/**
 * 4c63b37e (r355) — AVAILABLE BALANCE AS A COLUMN ON EMPLOYEE BALANCES, AND NOT AS A NEW CALCULATION.
 *
 * The reporter asked for "Available Leave" on HR Admin → Leave Config → Employee Leave Inquiry → Employee
 * Balances, and asked for it to be computed by "the function My Leave uses". The figure was ALREADY on every
 * row (`EmployeeBalanceRow.available`, the `available` `leaveBalances` computes as at the screen's As-at date)
 * and was readable only one Explain popup at a time. So the build is a COLUMN.
 *
 * ═══ THE INSTRUCTION WE DID THE OPPOSITE OF, AND WHAT PINS IT ═══
 *
 * My Leave's `leaveTypeApplySummary` (core/leave.ts) takes NO date — it is undated on purpose so that it
 * agrees with the submit guard `availableLeaveBalance`, which cannot be as-at-anything. Calling it from this
 * screen would have produced a column showing today's figure whatever date HR typed, which is item 3ddae357
 * exactly (five columns moved with the date, four silently did not, and the last column echoed the date back
 * and made the screen look like it was working). `asOf-dated` below is the assertion that says we did not.
 *
 * ═══ NON-VACUITY, WHICH IS THE WHOLE RISK OF A "COLUMN ONLY" ITEM ═══
 *
 * A column sourced from the WRONG place passes any test whose fixture has `Balance − Pending = Available`.
 * Every runtime case here therefore uses a fixture where those two differ: a pooled borrower (Balance 0.00 and
 * Pending Approval 0.00 on the row, while the days sit under Pending Share) and, for the rounding half, a
 * balance whose difference from its pending is not representable in binary floating point.
 *
 * ═══ AND THE SILENT FAILURE MODE OF THE EXPORT ═══
 *
 * lib/report-export.ts does NOT check that the header array and each row tuple are the same length, so a
 * column added to one list only shifts every figure after it under the wrong heading — in a file HR forwards,
 * with no error anywhere. `the export's header list and row tuple agree` below is that check.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { leaveBalances } from '../core/read';
import { decideLeave, requestLeave } from '../core/leave';
import { employeeBalanceRows } from '../app/leave/employee-balances/rows';
import { formatDays } from '../lib/day-format';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** THE CODE, NOT THE COMMENTS. Several of the files below name in prose the very call this item refuses to
 *  make and the very subtraction it refuses to perform; a ratchet a comment can trip is a ratchet nobody
 *  keeps (the rule 2a57a007's own guard states, applied here). */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const AS_OF = '2026-12-31';
let b: Base;

const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; code?: string; balanceSourceTypeId?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code ?? `Q${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Column Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Availability', primaryEmail: `avail_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

const grant = (employmentId: string, leaveTypeId: string, days: number, effectiveOn = '2026-01-01') =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn,
  });

/** A pending request written directly, so its `days` can be an exact numeric this test chooses. */
const pendRow = (employmentId: string, leaveTypeId: string, startDate: string, days: string) =>
  owner.db.insert(schema.leaveRequest).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    startDate,
    endDate: startDate,
    days,
    status: 'pending',
  });

/** Annual-style pool of 16 days with an Emergency-style type borrowing from it — the production shape. */
async function pool16() {
  const pool = await leaveTypeRow({ name: uniq('Col Annual'), code: `CA${randomUUID().slice(0, 4).toUpperCase()}` });
  const borrower = await leaveTypeRow({
    name: uniq('Col Emergency'),
    code: `CE${randomUUID().slice(0, 4).toUpperCase()}`,
    balanceSourceTypeId: pool,
  });
  const { employmentId } = await hire();
  await grant(employmentId, pool, 16);
  return { pool, borrower, employmentId };
}

const pend = (employmentId: string, typeId: string, startDate: string, endDate: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId: typeId, startDate, endDate, today: '2026-05-01' });

async function approve(employmentId: string, typeId: string, startDate: string, endDate: string) {
  const ctx = adminCtx(b);
  const req = await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate, endDate, today: '2026-05-01' });
  await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
}

const screenRows = async (employmentId: string, asOf = AS_OF) => {
  const rows = await employeeBalanceRows(adminCtx(b), employmentId, asOf, 'en');
  return new Map(rows.map((r) => [r.leaveTypeId, r]));
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

// ─── (a) the column exists on both surfaces, in the same place, named from the shared dictionary ──────

describe('4c63b37e · (a) the column is on the screen and in the export, immediately after Balance', () => {
  it('the screen puts the header and the cell at the same index — between Balance and Date', () => {
    const page = read('app/leave/employee-balances/page.tsx');
    const thead = page.slice(page.indexOf('<thead'), page.indexOf('</thead>'));
    const headers = [...thead.matchAll(/<th\b[^>]*>\{([^}]+)\}<\/th>/g)].map((m) => m[1].trim());
    const balance = headers.indexOf("tMe('leaveBalanceTable.colBalance')");
    const available = headers.indexOf('tf(LEAVE_FIGURE_LABEL_KEY.available)');
    const dateCol = headers.indexOf("tInq('colDate')");
    expect(balance, 'the Balance header').toBeGreaterThan(-1);
    expect(available, 'the Available Balance header — named from lib/leave-figure-labels.ts, not privately').toBe(
      balance + 1,
    );
    expect(dateCol, 'and Date still follows it').toBe(available + 1);

    // The BODY cell must sit at the same relative index, or every figure after it renders one heading left.
    const tbody = page.slice(page.indexOf('<tbody'), page.indexOf('</tbody>'));
    const numeric = [...tbody.matchAll(/\{num\(r\.(\w+)\)\}/g)].map((m) => m[1]);
    expect(numeric.indexOf('available'), 'the cell follows the Balance cell').toBe(numeric.indexOf('balance') + 1);
    // The figure is the ROW's own `available` — not a subtraction performed in the view.
    expect(code('app/leave/employee-balances/page.tsx'), 'no arithmetic in the cell').not.toMatch(
      /r\.balance\s*-\s*r\.pending/,
    );
  });

  /**
   * THE SILENT ONE. lib/report-export.ts zips a header array against each row tuple without checking their
   * lengths, so a header added without its cell (or the reverse) publishes every later figure under the wrong
   * heading. This compares the two lists structurally rather than trusting that both were edited.
   */
  it("the export's header list and row tuple agree in length and in the new column's index", () => {
    const route = read('app/leave/employee-balances/export/route.ts');
    /** The top-level entries of one bracketed list, comments stripped, in order. */
    const entries = (block: string) =>
      block
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter((l) => l.endsWith(','))
        .map((l) => l.slice(0, -1));

    const colStart = route.indexOf('columns: [');
    const rowStart = route.indexOf('rows: rows.map((r) => [');
    // Closed on the bracket at the LIST's own indentation, never on the first `],` / `]),` after the start:
    // one cell is `pooledStatusCell(r) ?? tMe(ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]),`, whose own
    // text ends in `]),` and silently truncated this list to 18 of 20 when it was written the lazy way.
    const columns = entries(route.slice(colStart + 'columns: ['.length, route.indexOf('\n    ],', colStart)));
    const cells = entries(route.slice(rowStart + 'rows: rows.map((r) => ['.length, route.indexOf('\n    ]),', rowStart)));

    expect(columns.length, 'a header for every cell').toBe(cells.length);
    const iCol = columns.indexOf('tf(LEAVE_FIGURE_LABEL_KEY.available)');
    const iCell = cells.indexOf('cell(r.available)');
    expect(iCol, 'the export header, from the same dictionary the screen reads').toBeGreaterThan(-1);
    expect(iCell, 'and its cell').toBe(iCol);
    // AFTER BALANCE, which on this side is not "before Date": colEntitlementStatus sits between them here.
    expect(iCol, 'immediately after Balance').toBe(columns.indexOf('tf(LEAVE_FIGURE_LABEL_KEY.balance)') + 1);
    expect(iCell).toBe(cells.indexOf('cell(r.balance)') + 1);
  });

  it('no new read and no new call into the undated My Leave summary', () => {
    const rows = code('app/leave/employee-balances/rows.ts');
    const page = code('app/leave/employee-balances/page.tsx');
    const route = code('app/leave/employee-balances/export/route.ts');
    for (const [name, src] of [
      ['rows.ts', rows],
      ['page.tsx', page],
      ['export/route.ts', route],
    ] as const) {
      expect(src.includes('leaveTypeApplySummary'), `${name} must not call the undated summary`).toBe(false);
    }
    // ONE balances read, still, and still the dated one.
    expect(rows.match(/leaveBalances\(/g) ?? [], 'exactly one leaveBalances call in the row builder').toHaveLength(1);
  });
});

// ─── (b) the figure, on a fixture where the reporter's own subtraction does NOT produce it ────────────

describe('4c63b37e · (b) NON-VACUITY: the column is the pooled figure, not Balance − Pending', () => {
  it("a pooled borrower's row reads Balance 0.00 and Pending 0.00 while the column shows the pool's Available Balance", async () => {
    const { pool, borrower, employmentId } = await pool16();
    await approve(employmentId, borrower, '2026-06-01', '2026-06-01'); // 1 day, debited from the pool
    await pend(employmentId, borrower, '2026-07-01', '2026-07-02'); // 2 days, awaiting approval

    const screen = await screenRows(employmentId);
    const row = screen.get(borrower)!;
    // The three cells the reporter's formula would be read off, on the row the reporter will look at.
    expect([row.balance, row.pending, row.pendingShare], 'the borrower holds nothing of its own').toEqual([0, 0, 2]);
    // The literal formula on those three cells. It is not a real number for anything, which is why we do not
    // implement it: core/read.ts states the rule as "`available` STAYS POOLED FOR EVERY MEMBER".
    expect(row.balance! - row.pending - row.pendingShare!, 'what the literal formula would print').toBe(-2);
    // What the column actually prints: the pool's own Available Balance — 16 granted, 1 taken, 2 pending.
    expect(row.available, "the pool's bookable figure, which is what this person can still apply for").toBe(13);
    expect(formatDays(row.available)).toBe('13.00');
    // And the POOL's own row carries the identical figure, because it is one pool shown twice.
    expect(screen.get(pool)!.available, 'one pool, one Available Balance').toBe(13);
    expect(screen.get(pool)!.balance, 'while Balance stays what THIS code holds').toBe(15);
  });

  it('the figure is the balance read’s own `available`, so the screen and the export cannot differ', async () => {
    const { borrower, employmentId } = await pool16();
    await pend(employmentId, borrower, '2026-07-01', '2026-07-02');

    const balances = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true, asOf: AS_OF });
    const fromRead = new Map(balances.map((r) => [r.leaveTypeId, r.available]));
    for (const [typeId, row] of await screenRows(employmentId)) {
      expect(row.available, `row ${typeId} carries leaveBalances' own figure`).toBe(fromRead.get(typeId));
    }
  });
});

// ─── (c) it answers for the As-at date, which is the whole reason My Leave's function was not called ──

describe('4c63b37e · (c) the new column moves with the As-at date', () => {
  it('three dates, three different Available Balances, on a pooled borrower row', async () => {
    const { borrower, employmentId } = await pool16();
    await approve(employmentId, borrower, '2026-06-01', '2026-06-01');
    await pend(employmentId, borrower, '2026-09-01', '2026-09-02');

    const availableAt = async (asOf: string) => (await screenRows(employmentId, asOf)).get(borrower)!.available;
    // Before the approved day: the whole 16-day grant, nothing spent, nothing pending yet.
    expect(await availableAt('2026-05-31')).toBe(16);
    // After it, before the pending request starts: the debit has landed.
    expect(await availableAt('2026-08-31')).toBe(15);
    // After the pending request starts: it is reserved against the pool.
    expect(await availableAt('2026-09-30')).toBe(13);
  });
});

// ─── (d) the figure is 2dp at the source, which is what lib/day-format.ts requires of its input ───────

describe('4c63b37e · (d) `available` is rounded where it is computed', () => {
  it('a difference that is not representable in binary floating point still arrives as an exact 2dp figure', async () => {
    const typeId = await leaveTypeRow({ name: uniq('Residue Leave') });
    const { employmentId } = await hire();
    await grant(employmentId, typeId, 0.3);
    await pendRow(employmentId, typeId, '2026-06-01', '0.10');

    // The unrounded expression, stated so the assertion below cannot be mistaken for a tautology.
    expect(0.3 - 0.1, 'what `balance - pending` evaluates to in JavaScript').not.toBe(0.2);

    const [row] = (await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true, asOf: AS_OF })).filter(
      (r) => r.leaveTypeId === typeId,
    );
    expect(row.balance).toBe(0.3);
    expect(row.pending).toBe(0.1);
    expect(row.available, 'rounded at the source, as core/leave.ts’s twin already rounds').toBe(0.2);
    expect((await screenRows(employmentId)).get(typeId)!.available, 'and the row the column renders').toBe(0.2);
  });

  it('a pooled member’s available is rounded too, where the pending is a sum over every member', async () => {
    const pool = await leaveTypeRow({ name: uniq('Residue Pool') });
    const borrower = await leaveTypeRow({ name: uniq('Residue Borrower'), balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await grant(employmentId, pool, 0.3);
    await pendRow(employmentId, borrower, '2026-06-01', '0.10');

    const screen = await screenRows(employmentId);
    expect(screen.get(borrower)!.available, 'the borrower reads the pooled figure').toBe(0.2);
    expect(screen.get(pool)!.available, 'and so does the pool').toBe(0.2);
  });
});
