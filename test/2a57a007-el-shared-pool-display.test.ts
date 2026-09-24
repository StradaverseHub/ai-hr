/**
 * 2a57a007 — EMERGENCY LEAVE, READ AS A SHARE OF THE ANNUAL POOL RATHER THAN AS A DEDUCTION TAKEN TWICE.
 *
 * Emergency Leave has no entitlement of its own; it spends the Annual Leave pool
 * (`leave_type.balance_source_type_id`). 39136455 made that visible with two columns, Share and Pending
 * Share, and modelled the transfer as a SIGNED one — the pool carried −N, the borrower +N. The reporter
 * reads the pool row as a deduction taken twice, and the borrower's row printed the same day under Taken
 * AND under Share. This file pins what changed and, harder, everything that did not.
 *
 * ⚠️ MONEY-ADJACENT, and the invariance half is the load-bearing half. Annual Leave feeds encashment and
 * final pay. NOTHING about the ledger, the balance, `available` or the submit guard moves here; the tests
 * below assert each of those explicitly rather than leaving them to be inferred from a green display test.
 *
 * ⚠️ THE INVARIANT THE MINUS USED TO SERVE IS ABOUT `balance`, NOT ABOUT `share`. core/read.ts states it:
 * "across a pool, sum(balance) equals the pool's own ledger balance". It holds because a borrower's
 * `balance` is 0 and the source keeps its own — not because of the sign on a display column nothing sums.
 * `pool balance is byte-identical to today` below is that invariant, re-asserted after the flip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { decideLeave, requestLeave, InsufficientLeaveBalanceOnSubmitError } from '../core/leave';
import { employeeBalanceRows, type EmployeeBalanceRow } from '../app/leave/employee-balances/rows';
import { explainLeaveSummary } from '../lib/leave-summary-explain';
import { isPoolBorrower, poolBadges } from '../lib/shared-leave-balance';
import { formatDays } from '../lib/day-format';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const AS_OF = '2026-12-31';
let b: Base;

const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; code?: string; balanceSourceTypeId?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      // `code` is NOT NULL and unique per tenant; the seed already owns AL / ML / EL, so these are their own.
      code: opts.code ?? `P${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Pool Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Pooled', primaryEmail: `pool_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

/** The signed ledger total for one (employment, leave type) — the authoritative figure nothing here may move. */
const ledgerTotal = async (employmentId: string, leaveTypeId: string): Promise<number> => {
  const [row] = await owner.db
    .select({ n: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row.n);
};

const grant = (employmentId: string, leaveTypeId: string, days: number) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2026-01-01',
  });

/** Annual Leave of 16 days with Emergency Leave borrowing from it — the production shape, with real codes. */
async function elPool() {
  const pool = await leaveTypeRow({ name: uniq('Pool Annual'), code: `AL${randomUUID().slice(0, 4).toUpperCase()}` });
  const el = await leaveTypeRow({
    name: uniq('Pool Emergency'),
    code: `EL${randomUUID().slice(0, 4).toUpperCase()}`,
    balanceSourceTypeId: pool,
  });
  const { employmentId } = await hire();
  await grant(employmentId, pool, 16);
  return { pool, el, employmentId };
}

const balanceRows = async (employmentId: string) => {
  const rows = await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true, asOf: AS_OF });
  return new Map(rows.map((r) => [r.leaveTypeId, r]));
};

const screenRows = async (employmentId: string) => {
  const rows = await employeeBalanceRows(adminCtx(b), employmentId, AS_OF, 'en');
  return new Map(rows.map((r) => [r.leaveTypeId, r]));
};

/** One approved and one pending application on `typeId`, the shape the reporter's ticket describes. */
async function approve(employmentId: string, typeId: string, startDate: string, endDate: string) {
  const ctx = adminCtx(b);
  const req = await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate, endDate, today: '2026-05-01' });
  await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
}

const pend = (employmentId: string, typeId: string, startDate: string, endDate: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId: typeId, startDate, endDate, today: '2026-05-01' });

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

describe('2a57a007 · (a) both pooled columns are POSITIVE on both rows', () => {
  it('the pool lends days out as a plain number of days, not as a minus', async () => {
    const { pool, el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    await pend(employmentId, el, '2026-07-01', '2026-07-02');

    const byId = await balanceRows(employmentId);
    expect(byId.get(pool)!.share, 'the POOL row must not carry a minus on Share').toBe(1);
    expect(byId.get(pool)!.pendingShare, 'the POOL row must not carry a minus on Pending Share').toBe(2);
    expect(byId.get(el)!.share, 'the borrower carries the same days, positive').toBe(1);
    expect(byId.get(el)!.pendingShare).toBe(2);
    expect(byId.get(pool)!.share, 'both halves read the same magnitude').toBe(byId.get(el)!.share);
  });

  /**
   * ⚠️ `-0` IS A REAL JAVASCRIPT VALUE and `formatDays` prints it as "-0.00". core/read.ts's `|| 0` is what
   * stops a pool that lent nothing out from wearing a minus sign; this is the assertion that pins it, and
   * it is asserted on the FORMATTED string because `expect(-0).toBe(0)` passes under vitest's default.
   */
  it('a pool that lent nothing out prints 0.00, never -0.00', async () => {
    const { pool, employmentId } = await elPool();
    const row = (await balanceRows(employmentId)).get(pool)!;
    expect(formatDays(row.share), 'Share on a pool that lent nothing').toBe('0.00');
    expect(formatDays(row.pendingShare), 'Pending Share on a pool that lent nothing').toBe('0.00');
    expect(Object.is(row.share, -0), 'share must not be negative zero').toBe(false);
    expect(Object.is(row.pendingShare, -0), 'pendingShare must not be negative zero').toBe(false);
  });
});

describe('2a57a007 · (b) the borrower reports its days under Share ONLY', () => {
  it('Taken and Pending Approval read 0.00 on the Employee Balances row while Share carries the days', async () => {
    const { pool, el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    await pend(employmentId, el, '2026-07-01', '2026-07-02');

    const screen = await screenRows(employmentId);
    const borrower = screen.get(el)!;
    expect(borrower.taken, 'the borrower must not print the same day under Taken AND under Share').toBe(0);
    expect(borrower.pending, 'nor under Pending Approval AND under Pending Share').toBe(0);
    expect(borrower.share, 'the days are reported here instead').toBe(1);
    expect(borrower.pendingShare).toBe(2);

    const poolRow = screen.get(pool)!;
    expect(poolRow.taken, 'the POOL row is untouched — its Taken is its own applications').toBe(0);
    expect(poolRow.share, 'and its Share is what it lent out').toBe(1);
    expect(poolRow.pendingShare).toBe(2);
  });

  /**
   * THE LAYER. The zero is a DISPLAY decision taken in app/leave/employee-balances/rows.ts. `leaveBalances`
   * still answers "how many days of Emergency Leave did this person take" honestly — 690d4400 and 39136455
   * deliberately made `taken` the days FILED UNDER THIS CODE and that must not be reverted here.
   */
  it('core/read.ts still reports the borrower’s OWN taken and pending — the kernel is not what changed', async () => {
    const { el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    await pend(employmentId, el, '2026-07-01', '2026-07-02');

    const core = (await balanceRows(employmentId)).get(el)!;
    expect(core.taken, 'takenFiledBy is the honest answer and stays available to every other consumer').toBe(1);
    expect(core.pending, 'and so is the borrower’s own reservation').toBe(2);
  });

  it('a POOL row is not treated as a borrower of itself', async () => {
    const { pool, el, employmentId } = await elPool();
    const byId = await balanceRows(employmentId);
    expect(isPoolBorrower(byId.get(pool)!), 'the pool does not borrow from itself').toBe(false);
    expect(isPoolBorrower(byId.get(el)!), 'the Emergency row does').toBe(true);
  });
});

describe('2a57a007 · (c) and (d) — what did NOT move', () => {
  it('the pool’s Balance is byte-identical to its ledger, and the members still sum to it', async () => {
    const { pool, el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-02');

    const byId = await balanceRows(employmentId);
    const ledger = await ledgerTotal(employmentId, pool);
    expect(ledger, 'the pool’s ledger is where the days actually live').toBe(14);
    expect(byId.get(pool)!.balance, 'the pool’s Balance is its ledger, unchanged by any display decision').toBe(14);
    expect(byId.get(el)!.balance, 'a borrower holds no balance of its own').toBe(0);
    expect(
      byId.get(pool)!.balance + byId.get(el)!.balance,
      'THE INVARIANT: across a pool, sum(balance) equals the pool’s own ledger balance',
    ).toBe(ledger);
    expect(formatDays(byId.get(pool)!.balance), 'and it prints exactly as it printed before').toBe('14.00');
  });

  it('a leave type OUTSIDE any pool is untouched in every column', async () => {
    const outsider = await leaveTypeRow({ name: uniq('Unpooled Medical') });
    const { employmentId } = await hire();
    await grant(employmentId, outsider, 14);
    await approve(employmentId, outsider, '2026-06-01', '2026-06-01');
    await pend(employmentId, outsider, '2026-07-01', '2026-07-01');

    const row = (await balanceRows(employmentId)).get(outsider)!;
    expect(row.balance, 'its own ledger, exactly as before').toBe(13);
    expect(row.taken, 'its own taken, exactly as before').toBe(1);
    expect(row.pending).toBe(1);
    expect(row.share, 'an honest 0.00, not a null').toBe(0);
    expect(row.pendingShare).toBe(0);
    expect(row.sharedBalance, 'and no pool descriptor at all').toBeNull();

    const screen = (await screenRows(employmentId)).get(outsider)!;
    expect(screen.taken, 'the screen row is byte-identical for an unpooled type').toBe(1);
    expect(screen.pending).toBe(1);
    expect(poolBadges(screen.sharedBalance, 'share'), 'and it grows no badge').toEqual([]);
  });
});

describe('2a57a007 · (e) the badge is DATA — one per contributing leave type', () => {
  it('the contribution names the contributing type and carries its own leave CODE', async () => {
    const { pool, el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');

    const poolRow = (await balanceRows(employmentId)).get(pool)!;
    const badges = poolBadges(poolRow.sharedBalance, 'share');
    expect(badges.length, 'one badge for the one type that moved days').toBe(1);
    expect(badges[0]!.leaveTypeId).toBe(el);
    expect(badges[0]!.code, 'the badge label is the leave CODE off the data, never a hardcoded "EL"').toMatch(/^EL/);
    expect(badges[0]!.share, 'and it carries that type’s OWN figure, not the pool’s sum').toBe(1);
  });

  /**
   * A SECOND POOL EXISTS ON PRODUCTION TODAY (CPL → SP), and a pool may have more than one borrower. A
   * single-borrower fixture would let a hardcoded "EL", or a badge built from the pool's total, pass.
   */
  it('a TWO-borrower pool renders one badge per type, each with its own days', async () => {
    const pool = await leaveTypeRow({ name: uniq('Pool Special'), code: `SP${randomUUID().slice(0, 4).toUpperCase()}` });
    const el = await leaveTypeRow({ name: uniq('Pool Emergency'), code: `EL${randomUUID().slice(0, 4).toUpperCase()}`, balanceSourceTypeId: pool });
    const cpl = await leaveTypeRow({ name: uniq('Pool Compassionate'), code: `CPL${randomUUID().slice(0, 3).toUpperCase()}`, balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await grant(employmentId, pool, 20);
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    await approve(employmentId, cpl, '2026-06-10', '2026-06-12');
    await pend(employmentId, cpl, '2026-08-01', '2026-08-02');

    const poolRow = (await balanceRows(employmentId)).get(pool)!;
    expect(poolRow.share, 'the column is the SUM over both borrowers').toBe(4);

    const shareBadges = poolBadges(poolRow.sharedBalance, 'share');
    expect(shareBadges.map((c) => [c.leaveTypeId, c.share]), 'one badge per contributing type, each with its own days').toEqual([
      [el, 1],
      [cpl, 3],
    ]);
    expect(
      shareBadges.reduce((n, c) => n + c.share, 0),
      'and the badges add up to the figure they sit beside',
    ).toBe(poolRow.share);

    // Pending Share: only Compassionate has anything pending, so only Compassionate gets a badge there.
    const pendingBadges = poolBadges(poolRow.sharedBalance, 'pendingShare');
    expect(pendingBadges.map((c) => [c.leaveTypeId, c.pendingShare]), 'a type with nothing pending grows no badge').toEqual([
      [cpl, 2],
    ]);
    expect(poolRow.pendingShare).toBe(2);
  });

  it('the badge belongs to the POOL’s row — a borrower does not badge itself', async () => {
    const { el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    const screen = (await screenRows(employmentId)).get(el)!;
    expect(isPoolBorrower(screen), 'the render guard that suppresses the badge on a borrower row').toBe(true);
  });

  it('the page renders the badge from the data, guards it to the pool row, and never writes a literal code', () => {
    const page = read('app/leave/employee-balances/page.tsx');
    expect(page, 'the badge label comes off the contribution').toContain('{c.code ?? c.leaveType}');
    expect(page, 'and is suppressed on a borrower row').toContain('if (!r.sharedBalance || isPoolBorrower(r)) return null;');
    expect(page, 'the tooltip is a native title, so a plain GET carries it').toContain('title={tMe(`leaveBalanceTable.${tipKey}`, {');
    // The CODE, not the comments: this file's own warnings name "EL" on purpose, and a ratchet that a
    // comment can trip is a ratchet nobody keeps.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/['"`]EL['"`]/.test(code), 'no hardcoded leave code in the badge — it must come off the data').toBe(false);
  });
});

describe('2a57a007 · (f) the export carries the two source columns', () => {
  it('the route adds Share Source and Pending Share Source beside the figures they explain', () => {
    const route = read('app/leave/employee-balances/export/route.ts');
    expect(route, 'the new header, in the screen’s own column order').toContain("tMe('colShareSource')");
    expect(route).toContain("tMe('colPendingShareSource')");
    expect(route, 'and the cell beside each figure').toContain("shareSource(r, 'share')");
    expect(route).toContain("shareSource(r, 'pendingShare')");
  });

  it('the cell names the borrowers on the pool row and the pool on a borrower row', async () => {
    const { pool, el, employmentId } = await elPool();
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    const screen = await screenRows(employmentId);

    // The same expression the route builds its cell from, over the same rows.
    const sourceCell = (r: EmployeeBalanceRow) =>
      !r.sharedBalance
        ? ''
        : isPoolBorrower(r)
          ? r.sharedBalance.sourceLeaveTypeName
          : poolBadges(r.sharedBalance, 'share')
              .map((c) => `${c.code ?? c.leaveType} ${formatDays(c.share)}`)
              .join('; ');

    const poolRow = screen.get(pool)!;
    expect(sourceCell(poolRow), 'the pool row names each borrower and its days').toMatch(/^EL\w{4} 1\.00$/);
    expect(sourceCell(screen.get(el)!), 'the borrower row names the pool its days came from').toBe(poolRow.leaveType);
  });
});

describe('2a57a007 · (g) NOTHING about applying for leave moved', () => {
  it('available is still the pool’s, on both rows, and still nets pending', async () => {
    const { pool, el, employmentId } = await elPool();
    await pend(employmentId, el, '2026-07-01', '2026-07-03');

    const byId = await balanceRows(employmentId);
    expect(byId.get(el)!.available, 'zeroing this would make Emergency Leave unapplyable for everyone').toBe(13);
    expect(byId.get(pool)!.available, 'and the pool sees the borrower’s reservation too').toBe(13);
  });

  it('the submit guard still refuses an over-spend of the pool through the borrowing type', async () => {
    const pool = await leaveTypeRow({ name: uniq('Pool Annual') });
    const el = await leaveTypeRow({ name: uniq('Pool Emergency'), balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await grant(employmentId, pool, 1);
    await expect(
      requestLeave(adminCtx(b), { employmentId, leaveTypeId: el, startDate: '2026-06-01', endDate: '2026-06-03', today: '2026-05-01' }),
      'a 3-day Emergency request against a 1-day pool must still be refused',
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });
});

describe('2a57a007 · the Explain panel lists the breakdown BY LEAVE TYPE', () => {
  it('Taken and Pending Approval each gain a per-type list that adds up to the column beside them', async () => {
    const pool = await leaveTypeRow({ name: uniq('Pool Special') });
    const el = await leaveTypeRow({ name: uniq('Pool Emergency'), balanceSourceTypeId: pool });
    const cpl = await leaveTypeRow({ name: uniq('Pool Compassionate'), balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await grant(employmentId, pool, 20);
    await approve(employmentId, el, '2026-06-01', '2026-06-01');
    await approve(employmentId, cpl, '2026-06-10', '2026-06-12');
    await pend(employmentId, cpl, '2026-08-01', '2026-08-02');

    const poolRow = (await balanceRows(employmentId)).get(pool)!;
    const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, pool, AS_OF, 'en', { derivation: true });
    expect(bd, 'the pool’s own breakdown is what the panel renders').toBeTruthy();

    const steps = explainLeaveSummary(bd!, { available: poolRow.available, sharedBalance: poolRow.sharedBalance });

    const takenKeys = steps.taken.map((s) => s.key);
    expect(takenKeys, 'the Taken line introduces the per-type list').toContain('sharedTakenIntro');
    const takenItems = steps.taken.filter((s) => s.key === 'sharedTakenItem');
    expect(takenItems.length, 'one line per contributing leave type').toBe(2);
    expect(takenItems.map((s) => (s.args!.days as { days: number }).days)).toEqual([1, 3]);
    expect(takenItems.every((s) => s.item === true), 'rendered as a list, not as prose').toBe(true);

    const pendingItems = steps.pendingApproval.filter((s) => s.key === 'sharedPendingItem');
    expect(steps.pendingApproval.map((s) => s.key), 'and the Pending Approval line does the same').toContain('sharedPendingIntro');
    expect(pendingItems.map((s) => (s.args!.days as { days: number }).days)).toEqual([2]);
  });

  it('a pool that lent nothing out emits no heading over an empty list', async () => {
    const { pool, employmentId } = await elPool();
    const poolRow = (await balanceRows(employmentId)).get(pool)!;
    const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, pool, AS_OF, 'en', { derivation: true });
    const steps = explainLeaveSummary(bd!, { available: poolRow.available, sharedBalance: poolRow.sharedBalance });
    expect(steps.taken.map((s) => s.key), 'nothing moved, so nothing is itemised').not.toContain('sharedTakenIntro');
    expect(steps.pendingApproval.map((s) => s.key)).not.toContain('sharedPendingIntro');
  });
});

/**
 * i18n/request.ts DEEP-MERGES each locale over English, so a key missing from ms.json renders the English
 * sentence rather than MISSING_MESSAGE. Presence therefore has to be asserted explicitly, and so does the
 * fact that the six are actually SIX — a copy-paste of the English string into all six files would pass a
 * presence check and ship an untranslated screen.
 */
describe('2a57a007 · six locales, present and distinct', () => {
  const BADGE_KEYS = ['shareBadgeTip', 'pendingShareBadgeTip', 'colShareSource', 'colPendingShareSource'] as const;
  const EXPLAIN_KEYS = ['sharedTakenIntro', 'sharedTakenItem', 'sharedPendingIntro', 'sharedPendingItem'] as const;

  const balTable = (loc: Locale) =>
    (CATALOGUES[loc] as unknown as { me: { leaveBalanceTable: Record<string, unknown> } }).me.leaveBalanceTable;
  const explain = (loc: Locale) =>
    (CATALOGUES[loc] as unknown as { leave: { breakdown: { explain: Record<string, string> } } }).leave.breakdown.explain;

  it.each(LOCALES)('%s carries every new key', (loc) => {
    for (const k of BADGE_KEYS) expect(typeof balTable(loc)[k], `me.leaveBalanceTable.${k} missing in ${loc}`).toBe('string');
    for (const k of EXPLAIN_KEYS) expect(typeof explain(loc)[k], `leave.breakdown.explain.${k} missing in ${loc}`).toBe('string');
  });

  it.each([...BADGE_KEYS])('me.leaveBalanceTable.%s is translated, not copied', (k) => {
    const all = LOCALES.map((l) => String(balTable(l)[k]));
    expect(new Set(all).size, `${k} is identical across locales — it was copied, not translated`).toBe(LOCALES.length);
  });

  it.each(['sharedTakenIntro', 'sharedPendingIntro'] as const)('leave.breakdown.explain.%s is translated, not copied', (k) => {
    const all = LOCALES.map((l) => explain(l)[k]!);
    expect(new Set(all).size, `${k} is identical across locales — it was copied, not translated`).toBe(LOCALES.length);
  });

  it('the badge tooltips carry every placeholder the screen passes them', () => {
    for (const loc of LOCALES) {
      for (const k of ['shareBadgeTip', 'pendingShareBadgeTip'] as const) {
        const s = String(balTable(loc)[k]);
        for (const ph of ['{v}', '{type}', '{pool}', '{cat,']) {
          expect(s.includes(ph), `${loc}: ${k} is missing ${ph}`).toBe(true);
        }
      }
    }
  });

  it('the Share tip no longer promises a minus sign', () => {
    for (const loc of LOCALES) {
      const tip = String((balTable(loc).tip as Record<string, string>).share);
      expect(tip.length, `${loc}: the Share tip must still exist`).toBeGreaterThan(0);
      expect(tip.includes('minus'), `${loc}: the English Share tip still promises a minus`).toBe(false);
    }
    const t = String((balTable('en').tip as Record<string, string>).share);
    expect(t, 'and says the figure is a plain number of days on both halves').toContain('plain number of days');
  });
});
