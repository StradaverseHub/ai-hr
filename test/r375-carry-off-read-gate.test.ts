/**
 * ed6f7a7b (r375) — A LEAVE TYPE WITH CARRY FORWARD OFF SHOWS NOTHING CARRIED, ON EVERY READ SURFACE.
 *
 * THE DEFECT. `resolveCarryAllowance` (core/leave-compute.ts) asks `carryEnabled` before it reaches
 * `carryAllowanceFrom`; the two READ call sites did not. They read `carryMax` / `carryPercent` straight off
 * the winning policy and handed them to `resolveCarryBreakdown`, which is the shared ARITHMETIC and asks no
 * carry-enabled question. So a type configured "carry forward: None" while still holding the maximum the
 * editor deliberately RETAINS printed a brought-forward figure that `openLeaveYear` forfeits in full:
 *
 *   core/read.ts#leaveEntitlementBreakdown  → the employee's own Employee Balances grid and its export,
 *                                             HR's leave inquiry, and the AI assistant's leave answer
 *   core/analytics.ts#carryForwardReport    → the Workforce analytics view and its downloaded file
 *
 * WHY THESE ASSERTIONS AND NOT A NUMBER. The two sides are pinned AGAINST EACH OTHER, not each against a
 * literal, through one invariant that holds in BOTH configurations:
 *
 *     what the screen says carried  +  what the engine forfeited at open  =  max(0, brought forward)
 *
 * The right-hand side is the RAW prior-cycle ledger sum (`broughtForward`) and the middle term is the
 * ACTUAL `CARRY_FORFEIT_REASON_CAP` row `openLeaveYear` wrote (`forfeit = max(0, before − carry)`,
 * core/leave.ts). Neither is reconstructed from the rule under test, so the identity cannot be satisfied by
 * a read path that re-derives the carry differently from the engine — which is precisely the failure that
 * was shipped. The concrete figures are asserted too, as documentation of the worked example.
 *
 * WHAT MUST NOT MOVE, asserted here so a later "simplification" cannot take it quietly:
 *   · `broughtForward` is the RAW signed prior-cycle sum and is CORRECT. It is a different question from
 *     `carriedForward` and it stays non-zero when carry is off — the days WERE in last year's balance; the
 *     forfeit that removed them is a row inside this cycle. Fixing the wrong field was the named trap.
 *   · the six-bucket reconciliation identity (`reconciledBalance`) is sourced from raw rows and still
 *     closes onto `balance`. The gate must not reach it.
 *   · the derivation node still reports the STORED configuration (rule 'off', maxDays 5) — the one place HR
 *     can see a retained maximum while it is dormant. Zeroing the shared locals would have blinded it.
 *   · a type with carry forward ON is byte-identically unaffected.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { CARRY_FORFEIT_REASON_CAP, openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { carryForwardReport } from '../core/analytics';
import { reconciledBalance } from '../components/leave/entitlement-panel-config';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

const CYCLE_START = '2026-01-01';
/** After the configured 31-March expiry, so the expiry-passed branch WOULD have fired had a date been
 *  emitted. A carry-off type must reach the same zero by never having an expiry date at all. */
const AS_OF = '2026-06-30';

const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const hire = (hiredOn: string, name = 'CarryOff') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `cog_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/**
 * Days on the entitlement template's band; every CARRY rule on the leave TYPE's own columns. The type is
 * not a preference here: `applyLeaveTypeRules` reads the carry cap, the enable switch and the expiry offset
 * from the type, and `expireCarriedLeave` gates its whole sweep on the TYPE's expiry — a fixture that put
 * them on the band would assert a clean zero while proving nothing.
 */
const annualPolicy = async (p: {
  carryForwardEnabled: boolean | null;
  carryForwardMax?: number;
  /** A stored percentage. The editor's Percentage mode posts `carryForwardMax=0` alongside it. */
  carryForwardPercent?: number;
}) => {
  await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 12,
    validFrom: '2025-01-01',
  });
  await owner.db
    .update(schema.leaveType)
    .set({
      carryForwardMax: String(p.carryForwardMax ?? 5),
      carryForwardPercent: p.carryForwardPercent == null ? null : String(p.carryForwardPercent),
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      carryForwardEnabled: p.carryForwardEnabled,
    })
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
};

/** The cap forfeit `openLeaveYear` ACTUALLY wrote, as a positive magnitude, read from the tagged row. Not
 *  reconstructed: this is the engine's own answer to "how much did NOT carry". */
const capForfeitPosted = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ sum: sql<string>`coalesce(-sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
        eq(schema.leaveLedger.entryType, 'adjustment'),
        eq(schema.leaveLedger.reason, CARRY_FORFEIT_REASON_CAP),
      ),
    );
  return Number(r?.sum ?? 0);
};

const breakdown = (employmentId: string, asOf = AS_OF) =>
  leaveEntitlementBreakdown(adminCtx(b), employmentId, b.annualLeaveTypeId, asOf, undefined, { derivation: true });

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

describe('ed6f7a7b — carry forward OFF with a retained maximum', () => {
  it('(a) the engine carries nothing AND the breakdown reports nothing carried — the two pinned against each other', async () => {
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    expect(await balance(emp.employmentId)).toBe(12); // hire grant, 2025

    await openLeaveYear(adminCtx(b), { year: 2026 });
    // THE ENGINE'S SIDE. Carry off ⇒ the whole prior 12 forfeits at open, +12 fresh ⇒ 12.
    expect(await balance(emp.employmentId)).toBe(12);
    const forfeitedAtOpen = await capForfeitPosted(emp.employmentId);
    expect(forfeitedAtOpen).toBe(12);

    const bd = await breakdown(emp.employmentId);
    expect(bd).not.toBeNull();
    expect(bd!.cycleStart).toBe(CYCLE_START);

    // THE SCREEN'S SIDE — the three figures the grid, the inquiry, the export and the assistant read.
    expect(bd!.carriedForward).toBe(0);
    expect(bd!.carryForwardRemaining).toBe(0);
    // No expiry DATE either: `carryConfigured` sees the zeroed inputs and emits none, which is right —
    // there is nothing carried for a date to govern. Reached without editing the shared helper.
    expect(bd!.carryForwardExpiryDate).toBeNull();

    // THE INVARIANT, holding across both configurations (see the header).
    expect(bd!.carriedForward + forfeitedAtOpen).toBe(Math.max(0, bd!.broughtForward));
  });

  it('(b) the RAW brought-forward figure and the reconciliation identity are untouched — the named trap', async () => {
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const bd = await breakdown(emp.employmentId);
    // `broughtForward` answers "what was in the balance before this cycle", not "what carried". The days
    // were there; the forfeit that removed them is a row dated INSIDE this cycle. Zeroing this field would
    // have been fixing the correct one.
    expect(bd!.broughtForward).toBe(12);
    expect(bd!.forfeitedThisCycle).toBe(12); // the tagged row, not the reconstruction
    // The six raw buckets still tile the ledger and still close onto the authoritative balance.
    expect(reconciledBalance(bd!)).toBe(bd!.balance);
    expect(bd!.balance).toBe(12);
  });

  it('(c) the derivation node still shows the STORED maximum, so HR can see it is dormant rather than gone', async () => {
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const bd = await breakdown(emp.employmentId);
    expect(bd!.derivation).not.toBeNull();
    expect(bd!.derivation!.carry).toEqual({ rule: 'off', maxDays: 5, percent: null });
  });

  it('(d) a debit dated after the former expiry moves nothing, because there is no expiry window left to bound', async () => {
    // core/read.ts bounds the debits window by `carryForwardExpiryDate`, falling back to `asOf` when it is
    // null. With the carry at 0 the reconstruction returns 0 either way — asserted rather than assumed,
    // because the fallback silently WIDENS the window for every carry-off type.
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-3.00',
      effectiveOn: '2026-05-04', // after 31 March: inside the WIDENED window, outside the configured one
    });

    const bd = await breakdown(emp.employmentId);
    expect(bd!.takenThisCycle).toBe(3); // the debit is really there and really in the cycle
    expect(bd!.carriedForward).toBe(0);
    expect(bd!.carryForwardRemaining).toBe(0);
    expect(bd!.carryForwardExpiryDate).toBeNull();
    expect(reconciledBalance(bd!)).toBe(bd!.balance);
  });

  it('(e) the analytics report and its export read the same decision', async () => {
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const rows = await carryForwardReport(adminCtx(b), undefined, { year: 2026 });
    const row = rows.find((r) => r.employmentId === emp.employmentId);
    expect(row).toBeDefined();
    expect(row!.carried).toBe(0);
    expect(row!.carryForwardExpiryDate).toBeNull();
    // `forfeitedAtOpen` is read from the TAGGED ledger row, so it is the engine's figure and did not move.
    expect(row!.forfeitedAtOpen).toBe(12);
    expect(row!.reasonCodes).toContain('cap');

    // The same invariant, internal to one report row: reconstructed carried + tagged forfeit = prior balance.
    const bd = await breakdown(emp.employmentId);
    expect(row!.carried + row!.forfeitedAtOpen).toBe(Math.max(0, bd!.broughtForward));
    // And the two read surfaces agree with each other, which is the drift this round closes.
    expect(row!.carried).toBe(bd!.carriedForward);
    expect(row!.carryForwardExpiryDate).toBe(bd!.carryForwardExpiryDate);
  });
});

describe('ed6f7a7b — carry forward ON is entirely unaffected, whatever the limit', () => {
  it('(f) both sides move together when the switch is flipped on', async () => {
    await annualPolicy({ carryForwardEnabled: true, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // carry min(12,5)=5, cap-excess 7 forfeited, +12 fresh ⇒ 17.
    expect(await balance(emp.employmentId)).toBe(17);
    const forfeitedAtOpen = await capForfeitPosted(emp.employmentId);
    expect(forfeitedAtOpen).toBe(7);

    const bd = await breakdown(emp.employmentId);
    expect(bd!.carriedForward).toBe(5);
    expect(bd!.carryForwardExpiryDate).toBe('2026-03-31');
    // THE SAME INVARIANT, un-flipped: 5 + 7 = 12.
    expect(bd!.carriedForward + forfeitedAtOpen).toBe(Math.max(0, bd!.broughtForward));
    expect(bd!.derivation!.carry).toEqual({ rule: 'on', maxDays: 5, percent: null });
    expect(reconciledBalance(bd!)).toBe(bd!.balance);

    const rows = await carryForwardReport(adminCtx(b), undefined, { year: 2026 });
    const row = rows.find((r) => r.employmentId === emp.employmentId)!;
    expect(row.carried).toBe(5);
    expect(row.carryForwardExpiryDate).toBe('2026-03-31');
    expect(row.carried + row.forfeitedAtOpen).toBe(Math.max(0, bd!.broughtForward));
  });

  it('(g) the back-compat default still carries: no switch recorded at all, positive cap ⇒ carry on', async () => {
    // `carryForwardEnabled` NULL is "not configured", which `carryEnabled` answers with `carryMax > 0`.
    // The gate must not turn an absent switch into an off switch — that would forfeit every pre-existing
    // tenant's carry silently, which is the failure mode this whole area is prone to.
    await annualPolicy({ carryForwardEnabled: null, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(17);

    const bd = await breakdown(emp.employmentId);
    expect(bd!.carriedForward).toBe(5);
    expect(bd!.carryForwardExpiryDate).toBe('2026-03-31');
    expect(bd!.carriedForward + (await capForfeitPosted(emp.employmentId))).toBe(Math.max(0, bd!.broughtForward));
  });
});

describe('ed6f7a7b — the expiry-date derivation is left alone, including the percentage-only type', () => {
  it('(k) a PERCENTAGE-ONLY type still carries and still gets its expiry date', async () => {
    // The item is explicit that this must not move: `carryConfigured` answers "is carry configured at all"
    // for the expiry DATE, and a percentage-only type has NO cap — so a gate that passed the cap alone, or
    // one placed inside the shared helper, would strip the date and let what it carried never expire. The
    // call-site gate passes the percentage through untouched because `carryEnabled` returns true from the
    // percentage clause before it ever looks at the cap.
    await annualPolicy({ carryForwardEnabled: true, carryForwardMax: 0, carryForwardPercent: 50 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // 50% of the prior 12 carries (no cap to clamp it), 6 forfeits at open, +12 fresh ⇒ 18.
    expect(await balance(emp.employmentId)).toBe(18);
    const forfeitedAtOpen = await capForfeitPosted(emp.employmentId);
    expect(forfeitedAtOpen).toBe(6);

    const bd = await breakdown(emp.employmentId);
    expect(bd!.carriedForward).toBe(6);
    expect(bd!.carryForwardExpiryDate).toBe('2026-03-31'); // the date SURVIVES — the point of this case
    expect(bd!.carriedForward + forfeitedAtOpen).toBe(Math.max(0, bd!.broughtForward));
    expect(bd!.derivation!.carry).toEqual({ rule: 'on', maxDays: 0, percent: 50 });
  });

  it('(l) a stored percentage beats an explicit OFF switch, and both sides agree that it does', async () => {
    // UNREACHABLE FROM THE EDITOR — Percentage mode and None both clear the other's field — but reachable
    // by a hand-written UPDATE or an old dump, which is the case `carryEnabled`'s percentage clause exists
    // for (7cd914b1: without it a "carry 50%, no cap" type would read as carry-OFF and forfeit everything).
    // The two sides must AGREE in this state too, which is the whole property of asking one function.
    await annualPolicy({ carryForwardEnabled: false, carryForwardMax: 0, carryForwardPercent: 50 });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(18); // the engine carried 6

    const bd = await breakdown(emp.employmentId);
    expect(bd!.carriedForward).toBe(6); // …and so does the screen
    expect(bd!.carriedForward + (await capForfeitPosted(emp.employmentId))).toBe(Math.max(0, bd!.broughtForward));
    // The derivation reports carry ON, because it is: the percentage is live configuration, not a dormant
    // leftover. Nothing here is dormant, so the configuration screen's new line has nothing to say.
    expect(bd!.derivation!.carry).toEqual({ rule: 'on', maxDays: 0, percent: 50 });
  });
});

/* ── The configuration screen: the retention is said out loud, and still retained ──────────────────── */

const root = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/**
 * The `mode === 'none'` arm of `CarryPolicyForm`, sliced from source (this repo's `dom` project cannot
 * render the RSC panel, the precedent test/carry-percent-cap-removal.test.ts sets).
 *
 * ⚠️ BOTH MARKERS ARE ASSERTED FOUND WITH `>= 0` AND THE SLICE IS ASSERTED SUBSTANTIAL. `indexOf` returns
 * −1 on a rename, `−1` is TRUTHY, and `slice(-1, n)` is `""` — which is how a guard turns into a no-op that
 * reports green. One in this repo asserted nothing at all for 27 rounds that way.
 */
function noneBranch(): string {
  const src = readSrc('/app/admin/leave-config/types/leave-type-sub-forms.tsx');
  const start = src.indexOf('// None = disabled carry');
  const end = src.indexOf("t('subStep.carryHelp')", start + 1);
  expect(start, 'the None-branch marker comment was renamed or removed').toBeGreaterThanOrEqual(0);
  expect(end, 'the carryHelp end marker was renamed or removed').toBeGreaterThan(start);
  const slice = src.slice(start, end);
  expect(slice.length, 'the sliced None branch is not substantial — the guard would assert nothing').toBeGreaterThan(400);
  return slice;
}

describe('ed6f7a7b — the leave type configuration screen names the dormant figure', () => {
  it('(h) the None branch renders the dormant-maximum line, only when there IS a retained figure', () => {
    const branch = noneBranch();
    expect(branch).toContain("t('subStep.carryNoneDormant'");
    // Gated on the cap: with nothing retained there is nothing dormant, and a line claiming otherwise
    // would be the same untruth in the other direction.
    expect(branch).toMatch(/cap > 0 && \(/);
  });

  it('(i) the retention itself is UNCHANGED — the stored cap is still posted, the percentage still cleared', () => {
    const branch = noneBranch();
    // The maximum is kept ON PURPOSE so switching carry back on restores it. The reporter asked for it to
    // be made visibly inactive, not deleted, and this round only adds the sentence saying so.
    expect(branch).toMatch(/<input type="hidden" name="carryForwardMax" value=\{cap\} \/>/);
    // `carryEnabled` reads a stored percentage as "carry is on", so None must keep clearing it.
    expect(branch).toMatch(/<input type="hidden" name="carryForwardPercent" value="" \/>/);
    // And no live-looking number box comes back into this branch.
    expect(branch).not.toMatch(/type="number"/);
  });

  for (const loc of LOCALES) {
    it(`(j) ${loc}: carryNoneDormant exists, is non-empty and names the retained figure`, () => {
      const cat = JSON.parse(readSrc(`/messages/${loc}.json`));
      const msg: unknown = cat.admin.leave.subStep.carryNoneDormant;
      expect(typeof msg).toBe('string');
      expect((msg as string).length).toBeGreaterThan(0);
      // The point of the line is the NUMBER. A translation that drops the placeholder says nothing useful.
      expect(msg as string).toContain('{days}');
    });
  }
});
