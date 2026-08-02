/**
 * Feedback 9816a5ad — "Move Benefit Scheme Entitlement Maintenance into Service Based Entitlements",
 * STEP 2 OF 3: the leave engines read their RULES from `leave_type`, not from `leave_policy.accrual`.
 *
 * Step 1 (migration 0325) added ten rule columns to `leave_type`, backfilled them from the single distinct
 * value each type carried across its policy rows, and left them INERT. This step makes them live. The
 * split it lands on is the reporter's own: "Annual Leave rules are the same for everyone and only the
 * entitlement days differ by grade" — so the LEAVE TYPE owns the rules and Benefit Scheme → Service Based
 * Entitlements owns the DAYS.
 *
 * WHAT THIS FILE PROVES, AND WHY IT IS SEPARATE FROM leave-type-rule-columns.test.ts. That file runs the
 * whole scenario in three worlds and shows the aggregate does not move; it is the safety net. This file
 * moves ONE RULE AT A TIME and pins the DAY VALUE each one produces, because an aggregate that does not
 * move is also what you get when nothing is wired up at all. Every expectation below is a number of days
 * in a ledger, never "the call succeeded".
 *
 * The three groups:
 *   1. THE OVERLAY, pure — `applyLeaveTypeRules` field by field, including the two things it deliberately
 *      does NOT do (fabricate a policy out of nothing; read per-band carry-forward).
 *   2. THE ENGINES — one rule changed on the type, one produced day value asserted, against a baseline
 *      run of the identical policy with the type's columns left NULL.
 *   3. MIGRATION 0334 — the guard that refuses the release when repointing WOULD move a balance. Its
 *      failures are matched through the `.cause` chain on the real Postgres message, never `toThrow()`.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  accrueEarnedLeave,
  applyLeaveTypeRules,
  hasAnyLeaveTypeRule,
  openLeaveYear,
  type LeaveTypeRules,
  type ResolvedPolicy,
} from '../core/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const MIGRATION_0325 = resolve(root, 'db/migrations/0325_leave_type_rule_columns.sql');
const MIGRATION_0334 = resolve(root, 'db/migrations/0334_leave_type_rules_repoint_guard.sql');

let b: Base;

// ── harness ────────────────────────────────────────────────────────────────────────────────────────

/** Re-execute a migration from the ACTUAL file, inside ONE transaction — the way drizzle-kit applies it,
 *  so a raised assertion rolls the whole thing back exactly as it would on deploy. */
async function runMigration(path: string, ...mustContain: string[]): Promise<void> {
  const text = readFileSync(path, 'utf8');
  // Guard against the file being renamed or gutted into something that no longer asserts — either would
  // make every expectation below vacuously green.
  for (const needle of mustContain) expect(text).toContain(needle);
  const stmts = text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  await owner.db.transaction(async (tx) => {
    for (const s of stmts) await tx.execute(sql.raw(s));
  });
}

const runMigration0325 = () =>
  runMigration(MIGRATION_0325, '_r0325_leave_type_rule_source', 'UPDATE "leave_type" lt');
const runMigration0334 = () =>
  runMigration(MIGRATION_0334, '[0334_leave_type_rules_repoint_guard] refusing to repoint');

/** Every message in a thrown error's `.cause` chain. Drizzle wraps the real Postgres error as
 *  "Failed query: …", so a bare `rejects.toThrow()` would pass just as happily on a typo or a missing
 *  table as on the assertion this file is actually testing. */
function causeMessages(err: unknown): string {
  const out: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 10 && e != null; i++) {
    const o = e as { message?: unknown; cause?: unknown };
    if (typeof o.message === 'string') out.push(o.message);
    e = o.cause;
  }
  return out.join(' | ');
}

/** Run 0334 and return the cause-chain message of the failure it is expected to raise. */
async function guardFailure(): Promise<string> {
  try {
    await runMigration0334();
  } catch (err) {
    return causeMessages(err);
  }
  throw new Error('migration 0334 was expected to refuse, but it succeeded');
}

/** Insert a leave_policy row with an EXACT accrual JSONB, bypassing core/admin's write-time validation —
 *  the rows these engines meet in the wild include seeds and hand-written ones. */
async function policy(accrual: Record<string, unknown>, validFrom = '2020-01-01') {
  await owner.db.insert(schema.leavePolicy).values({
    tenantId: b.tenantId,
    leaveTypeId: b.annualLeaveTypeId,
    accrual,
    validFrom,
  });
}

/** Set rule columns on the ANNUAL type directly (i.e. the world AFTER a backfill, or after an admin edit). */
async function setTypeRules(rules: Record<string, unknown>) {
  await owner.db
    .update(schema.leaveType)
    .set(rules)
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
}

/**
 * Hire on 1 Jan 2024, open leave year 2026, accrue to 31 Jul 2026 — and report the balance after each.
 *
 * The hire date is deliberately January so ANNUAL's month pro-ration (12 − (month − 1))/12 is exactly 1
 * and never obscures the rule under test. At the 2026 year-open the employee has 2 completed years, so
 * the EA-1955 floor is 12 (s.60E: 8 under 2y, 12 for 2–5y, 16 over 5y) — every policy below grants at
 * least that, so the floor never silently becomes the winning input.
 */
async function figures(): Promise<{ afterHire: number; afterYearOpen: number; afterAccrual: number }> {
  const hired = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Rules', primaryEmail: `rules_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  const afterHire = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);
  await openLeaveYear(adminCtx(b), { year: 2026 });
  const afterYearOpen = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);
  await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-31' });
  const afterAccrual = await ledgerBalance(hired.employmentId, b.annualLeaveTypeId);
  return { afterHire, afterYearOpen, afterAccrual };
}

/** The same policy run twice: once with the type's rule columns NULL (the pre-consolidation baseline) and
 *  once with `rules` set on the type. Returns both, so every test can state the BEFORE and the AFTER. */
async function baselineAndRepointed(accrual: Record<string, unknown>, rules: Record<string, unknown>) {
  await policy(accrual);
  const baseline = await figures();

  await resetDb();
  b = await seedBase();
  await policy(accrual);
  await setTypeRules(rules);
  const repointed = await figures();
  return { baseline, repointed };
}

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

// ── 1. the overlay, pure ───────────────────────────────────────────────────────────────────────────

describe('applyLeaveTypeRules — the pure overlay', () => {
  const POL: ResolvedPolicy = {
    days: 15,
    carryMax: 5,
    method: 'earned_monthly',
    carryExpiry: { month: 3, day: 31 },
    carryForwardEnabled: true,
    maxBalanceDays: 30,
    roundingMethod: 'up',
  };

  it('never fabricates a policy out of a null one', () => {
    // A null policy means NO policy row matched this employee's scope. Synthesising one from the type's
    // rules would hand a carry cap, a rounding method and an earning method to employees who resolve no
    // policy today — a balance change nothing in this item asked for.
    expect(applyLeaveTypeRules(null, { accrualMethod: 'earned_monthly', carryForwardMax: '9' })).toBeNull();
  });

  it('returns the policy UNCHANGED when the type carries no rules — the back-compat guarantee', () => {
    // 0325's backfill only fires on a type that had policy rows to collapse, and no-ops once the columns
    // are set. A type created (or given its first policy) AFTER 0325 ran therefore has ten NULL columns
    // while its policies carry real rules, and for that type the policy's own rules are still the only
    // correct answer.
    expect(applyLeaveTypeRules(POL, null)).toBe(POL);
    expect(applyLeaveTypeRules(POL, {})).toBe(POL);
    expect(applyLeaveTypeRules(POL, { accrualMethod: null, carryForwardMax: null })).toBe(POL);
  });

  it('does not engage on carryForwardIncludeEarned alone — it is config-only and drives no engine', () => {
    expect(hasAnyLeaveTypeRule({ carryForwardIncludeEarned: true })).toBe(false);
    expect(applyLeaveTypeRules(POL, { carryForwardIncludeEarned: true })).toBe(POL);
    // ...but any behaviour-bearing column does engage.
    expect(hasAnyLeaveTypeRule({ roundingMethod: 'down' })).toBe(true);
  });

  it('replaces every rule from the type, and leaves days alone', () => {
    const out = applyLeaveTypeRules(POL, {
      accrualMethod: 'earned_quarterly',
      carryForwardMax: '7.50', // numeric arrives from postgres as a STRING
      carryForwardEnabled: false,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 6,
      roundingMethod: 'down',
      maxBalanceDays: '12',
    });
    expect(out).toEqual({
      days: 15, // untouched — step 2 moved the rules, not the days
      carryMax: 7.5,
      // 7cd914b1 — the twelfth rule. null because this fixture configures no percentage, and the overlay
      // emits every rule it owns rather than omitting the absent ones (that is what makes it whole-set).
      carryPercent: null,
      method: 'earned_quarterly',
      carryExpiry: { month: 6, day: 31 }, // months mode: day 31 is the sentinel the build sites clamp
      carryForwardEnabled: false,
      maxBalanceDays: 12,
      roundingMethod: 'down',
      // 9f5164d8 (migration 0335) added the ELEVENTH rule column. It is carried on the overlay
      // unconditionally — null here, because this type sets no custom threshold — and read only by the
      // 'nearest_half' branch of applyRounding, so its presence cannot move a 'down' figure. The exhaustive
      // toEqual is deliberately left exhaustive: a new rule column silently appearing on the overlay is
      // exactly what this assertion exists to surface.
      roundingThreshold: null,
    });
  });

  it('falls back to each field default when the type is silent on it', () => {
    // Engaged by one column, silent on the rest — every other rule must read as its documented default,
    // not as the policy's leftover value.
    const out = applyLeaveTypeRules(POL, { accrualMethod: 'earned_monthly' })!;
    expect(out.carryMax).toBe(0); // absent carryForwardMax ⇒ 0
    expect(out.carryExpiry).toBeNull(); // absent expiry ⇒ never expires
    expect(out.carryForwardEnabled).toBeUndefined(); // ⇒ carryEnabled's cap > 0 back-compat rule
    expect(out.maxBalanceDays).toBeNull(); // absent ⇒ no cap
    expect(out.roundingMethod).toBeUndefined(); // absent ⇒ no rounding
  });

  it('sanitises exactly as the pre-consolidation resolver does', () => {
    const out = applyLeaveTypeRules(POL, {
      accrualMethod: '', // empty string is not a method any more than absence is
      roundingMethod: 'nearest', // only 'up' / 'down' are honoured
      carryForwardMax: 'not-a-number',
      maxBalanceDays: '-4',
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonth: 2,
      carryForwardExpiryDay: 31, // 31 Feb — legacy garbage parseCarryExpiry already discards
      carryForwardEnabled: true,
    })!;
    expect(out.method).toBeUndefined();
    expect(out.roundingMethod).toBeUndefined();
    expect(out.carryMax).toBe(0);
    expect(out.maxBalanceDays).toBe(0); // clamped at 0, never negative
    expect(out.carryExpiry).toBeNull();
  });

  it('ignores the per-band carry-forward overrides once the type carries rules (the step-2 decision)', () => {
    // resolveGradePolicy would have surfaced the BAND's carryForwardDays as `carryMax`. Once the bands are
    // days-only, a carry cap that differs per band is exactly the duplication this item removes — so the
    // type's cap wins outright and the band's is not consulted.
    const banded: ResolvedPolicy = { days: 12, carryMax: 9, carryExpiry: { month: 6, day: 30 } };
    const out = applyLeaveTypeRules(banded, { carryForwardMax: '2' })!;
    expect(out.carryMax).toBe(2);
    expect(out.carryExpiry).toBeNull();
  });
});

// ── 2. the engines, one rule at a time ─────────────────────────────────────────────────────────────

describe('the engines resolve each rule from the type — asserted on produced day values', () => {
  const LUMP = { annualDays: 12, method: 'grant_on_hire_prorated', carryForwardMax: 5 };

  it('baseline: with the type silent, the policy still drives every figure', async () => {
    await policy(LUMP);
    // hire       — floor 8 at 0 years, policy 12 ⇒ 12, January joiner so no pro-ration loss.
    // year-open  — 2 completed years ⇒ floor 12, policy 12 ⇒ 12 granted; the 12 already held is carried
    //              at the policy cap of 5 and the remaining 7 forfeited ⇒ 5 + 12 = 17.
    // accrual    — the policy is a lump method, so accrueEarnedLeave does not own this type.
    expect(await figures()).toEqual({ afterHire: 12, afterYearOpen: 17, afterAccrual: 17 });
  });

  it('EARNING METHOD from the type moves the grant off the lump engines onto the accrual sweep', async () => {
    const { baseline, repointed } = await baselineAndRepointed(LUMP, { accrualMethod: 'earned_monthly' });
    expect(baseline).toEqual({ afterHire: 12, afterYearOpen: 17, afterAccrual: 17 });
    // Nothing at hire and nothing at year-open — both defer to accrueEarnedLeave — then 7 elapsed months
    // of 12/12 = 7.00 exactly.
    expect(repointed).toEqual({ afterHire: 0, afterYearOpen: 0, afterAccrual: 7 });
  });

  it('CARRY-FORWARD CAP from the type decides what survives the year-open', async () => {
    const { baseline, repointed } = await baselineAndRepointed(LUMP, {
      accrualMethod: 'grant_on_hire_prorated',
      carryForwardMax: '2',
    });
    expect(baseline.afterYearOpen).toBe(17); // policy cap 5: carried 5 + granted 12
    expect(repointed.afterYearOpen).toBe(14); // type cap 2: carried 2 + granted 12
    expect(repointed.afterHire).toBe(12); // the cap is a year-open rule; the hire grant is untouched
  });

  it('CARRY-FORWARD DISABLED on the type forfeits the whole prior balance', async () => {
    const { repointed } = await baselineAndRepointed(LUMP, {
      accrualMethod: 'grant_on_hire_prorated',
      carryForwardMax: '5',
      carryForwardEnabled: false,
    });
    // The explicit switch beats the positive cap sitting next to it: nothing carries, so the year-open
    // is the new grant alone.
    expect(repointed.afterYearOpen).toBe(12);
  });

  it('ROUNDING from the type tidies the calculated entitlement', async () => {
    const { baseline, repointed } = await baselineAndRepointed(
      { annualDays: 12.4, method: 'grant_on_hire_prorated', carryForwardMax: 5 },
      { accrualMethod: 'grant_on_hire_prorated', roundingMethod: 'up' },
    );
    expect(baseline.afterHire).toBe(12.4); // policy states no rounding ⇒ the raw figure
    expect(repointed.afterHire).toBe(13); // 12.4 lifted to the next whole day
  });

  it('MAXIMUM BALANCE from the type caps a policy that has no service bands at all', async () => {
    // The sharpest case for the relocation. `maxBalanceDays` exists TODAY only inside a service band, so a
    // flat policy has no cap and nothing clamps it. Moved to the type it applies to everyone — which is
    // precisely why migration 0334 refuses to ship this shape without a human deciding. Here the columns
    // are set DIRECTLY (not via the backfill), because this asserts what the ENGINE does with a cap, not
    // what the guard permits.
    const { baseline, repointed } = await baselineAndRepointed(LUMP, {
      accrualMethod: 'grant_on_hire_prorated',
      maxBalanceDays: '10',
    });
    expect(baseline.afterHire).toBe(12); // no bands ⇒ no cap
    expect(repointed.afterHire).toBe(10); // the type's cap clamps the opening grant
  });

  it('PER-BAND carryForwardDays stops being read once the type carries rules (the step-2 decision)', async () => {
    const banded = {
      annualDays: 12,
      method: 'grant_on_hire_prorated',
      carryForwardMax: 5,
      // The per-range override from feedback 9d8cf621: 9 days, beating the policy-level cap of 5.
      serviceBands: [{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 9 }],
    };
    const { baseline, repointed } = await baselineAndRepointed(banded, {
      accrualMethod: 'grant_on_hire_prorated',
      carryForwardMax: '5',
    });
    // Before: the BAND's 9 overrides the policy's 5 ⇒ carried 9 + granted 12.
    expect(baseline.afterYearOpen).toBe(21);
    // After: the band's carry override is not consulted; the type's cap of 5 governs ⇒ 5 + 12.
    expect(repointed.afterYearOpen).toBe(17);
  });
});

// ── 3. migration 0334, the guard ───────────────────────────────────────────────────────────────────

describe('0334 — refuses to repoint when it would move a balance', () => {
  it('passes when every policy row already states what the type says', async () => {
    // The production shape the release is claiming: many identical copies of one rule, one per
    // (company, grade). 0325 collapses them, 0334 confirms the collapse changed nothing.
    const full = { annualDays: 16, method: 'earned_monthly', carryForwardMax: 5, roundingMethod: 'up' };
    await policy(full, '2020-01-01');
    await policy({ ...full, annualDays: 12 }, '2021-01-01');
    await runMigration0325();
    await runMigration0334(); // must not raise
    const [t] = await owner.db
      .select()
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(t.accrualMethod).toBe('earned_monthly'); // and the backfill really did land
  });

  it('is a no-op on a type step 1 never consolidated', async () => {
    // Ten NULL columns ⇒ the engines still read the policy ⇒ there is nothing to disagree about.
    await policy({ annualDays: 16, method: 'earned_monthly' }, '2020-01-01');
    await policy({ annualDays: 12 }, '2021-01-01'); // silent on method — would be a conflict if consolidated
    await runMigration0334(); // must not raise: 0325 was never run, so no column is set
  });

  // THE CASE 0325's ASSERTION CANNOT SEE. count(DISTINCT …) ignores NULLs, so a rule stated by one row and
  // absent from another passes 0325 with one distinct value — but the runtime resolver reads the WINNING
  // ROW ALONE and falls back to the field default, so the silent row's employees would be repriced.
  const silenceCases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['method', { method: 'earned_monthly' }, 'method'],
    ['carryForwardMax', { carryForwardMax: 5 }, 'carryForwardMax'],
    ['roundingMethod', { roundingMethod: 'up' }, 'roundingMethod'],
    ['carryForwardEnabled', { carryForwardEnabled: true }, 'carryForwardEnabled'],
    [
      'the carry-expiry pair',
      { carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 },
      'carryForwardExpiryMonth',
    ],
  ];

  for (const [label, stated, rule] of silenceCases) {
    it(`refuses when one row states ${label} and another is silent on it`, async () => {
      await policy({ annualDays: 16, ...stated }, '2020-01-01');
      await policy({ annualDays: 16 }, '2021-01-01'); // silent
      await runMigration0325(); // collapses cleanly — this is exactly 0325's blind spot

      const msg = await guardFailure();
      expect(msg).toContain('[0334_leave_type_rules_repoint_guard] refusing to repoint');
      expect(msg).toContain(rule);
      expect(msg).toContain('ANNUAL'); // names the offending type so a human can act on it
    });
  }

  it('does NOT fire when silence and the type agree — an absent carryForwardMax really is 0', async () => {
    // carryForwardMax is the one rule with a non-null default. Every row silent, and the type reading 0,
    // is not a disagreement, and a guard that fired here would be a false alarm on a safety check.
    await policy({ annualDays: 16, carryForwardMax: 0 }, '2020-01-01');
    await policy({ annualDays: 12 }, '2021-01-01');
    await runMigration0325();
    await runMigration0334(); // must not raise
  });

  it('refuses when the type gains a maximum balance that a band-less policy never had', async () => {
    await policy(
      { annualDays: 16, serviceBands: [{ fromYears: 0, toYears: null, days: 16, maxBalanceDays: 25 }] },
      '2020-01-01',
    );
    await policy({ annualDays: 12 }, '2021-01-01'); // flat — bandMaxBalance(null) = no cap today
    await runMigration0325();

    const msg = await guardFailure();
    expect(msg).toContain('refusing to repoint');
    expect(msg).toContain('no service bands');
  });

  it('refuses when a band actually uses the per-band carry-forward that step 2 stops reading', async () => {
    // The decision is free only while nobody uses these. If a customer does, the guard makes that visible
    // instead of silently discarding their configuration.
    await policy(
      {
        annualDays: 16,
        method: 'earned_monthly',
        carryForwardMax: 5,
        serviceBands: [{ fromYears: 0, toYears: null, days: 16, carryForwardDays: 9 }],
      },
      '2020-01-01',
    );
    await runMigration0325();

    const msg = await guardFailure();
    expect(msg).toContain('refusing to repoint');
    expect(msg).toContain('carryForwardDays');
  });

  it('refuses when a band carries a per-band carry EXPIRY', async () => {
    await policy(
      {
        annualDays: 16,
        method: 'earned_monthly',
        carryForwardMax: 5,
        serviceBands: [
          { fromYears: 0, toYears: null, days: 16, carryForwardExpiryMonth: 6, carryForwardExpiryDay: 30 },
        ],
      },
      '2020-01-01',
    );
    await runMigration0325();

    const msg = await guardFailure();
    expect(msg).toContain('refusing to repoint');
    expect(msg).toContain('carryForwardExpiry');
  });

  it('leaves the database untouched when it refuses', async () => {
    await policy({ annualDays: 16, method: 'earned_monthly' }, '2020-01-01');
    await policy({ annualDays: 16 }, '2021-01-01');
    await runMigration0325();
    const before = await owner.db
      .select({ n: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
      .from(schema.leaveLedger);

    await guardFailure();

    const after = await owner.db
      .select({ n: sql<string>`count(*)`, total: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
      .from(schema.leaveLedger);
    expect(after).toEqual(before);
  });
});
