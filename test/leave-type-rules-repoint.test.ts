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
 * The groups:
 *   1. THE OVERLAY, pure — `applyLeaveTypeRules` field by field, including the two things it deliberately
 *      does NOT do (fabricate a policy out of nothing; read per-band carry-forward).
 *   2. THE ENGINES — one rule changed on the type, one produced day value asserted, against a baseline
 *      run of the identical ENTITLEMENT TABLE with the type's columns left NULL.
 *
 * ── 6e9a126e RELEASE THREE ───────────────────────────────────────────────────────────────────────────
 * Group 1 is untouched: it is pure, and `applyLeaveTypeRules` is the surviving overlay.
 *
 * Group 2 is REPOINTED, not rewritten. The DAYS half moved from a `leave_policy` row to an entitlement
 * template + eligibility rule (`seedEntitlement`), and EVERY DAY VALUE BELOW IS THE SAME NUMBER IT WAS:
 * 12/17/17 baseline, 0/0/7 earned, 14 on a type cap of 2, 12 with carry disabled, 13 rounded up, 10
 * clamped, 21 → 17 when the type takes the band's carry cap away. The baseline world is now "the type
 * states nothing, so the BAND's own figures resolve through policyFromTemplateBand" — which produces the
 * identical carrier the old flat policy row did, which is why the numbers did not have to move.
 *
 * Group 3 is RETIRED — see the note where it stood.
 */
import { randomUUID } from 'node:crypto';
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
  type ServiceBand,
} from '../core/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;

// ── harness ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The DAYS half: an entitlement table assigned to everybody, in the shape `seedEntitlement` writes.
 *
 * Takes a BAND rather than the old flat `{ annualDays, method, carryForwardMax }` JSONB, because that is
 * what a template stores — and because the two per-band keys these tests care about (`days` and
 * `carryForwardDays`) are exactly the two the old JSONB carried at policy level. The `method` key is gone
 * from the fixture entirely: an earning method is a leave-TYPE rule and is set with `setTypeRules`, which
 * is the whole subject of this file.
 */
async function entitlementTable(band: ServiceBand, validFrom = '2020-01-01') {
  await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    serviceBands: [band],
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

/**
 * The same entitlement table run twice: once with the type's rule columns NULL (the baseline) and once
 * with `rules` set on the type. Returns both, so every test can state the BEFORE and the AFTER.
 *
 * WHAT THE BASELINE IS NOW. It used to be "the policy row's own JSONB rules drive everything". There is no
 * policy row, so it is "the type states nothing, so the BAND's figures resolve through
 * `policyFromTemplateBand` and every other rule takes its documented default". That produces the identical
 * carrier the old flat policy row produced — days from the band, carry cap from the band's
 * `carryForwardDays` (⇒ 0 when absent, exactly as an absent `carryForwardMax` did), no method ⇒ the lump
 * engines — which is why not one expected figure in this block had to move.
 */
async function baselineAndRepointed(band: ServiceBand, rules: Record<string, unknown>) {
  await entitlementTable(band);
  const baseline = await figures();

  await resetDb();
  b = await seedBase();
  await entitlementTable(band);
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
    // 8fec719e — a BANDS-ONLY type is ruled. Without this disjunct applyLeaveTypeRules falls through to
    // the legacy grade policy and the administrator's table is silently ignored while a stale JSONB rule
    // set comes back: the identical failure 7cd914b1 shipped with carryForwardPercent.
    expect(hasAnyLeaveTypeRule({ roundingBands: [{ from: 0, to: 1, result: 1 }] })).toBe(true);
    // bc36c768 — a DAY-ONLY type is ruled, for the same reason: without the disjunct the overlay falls
    // through to the legacy grade policy and the administrator's chosen credit day is silently ignored.
    expect(hasAnyLeaveTypeRule({ accrualDay: 15 })).toBe(true);
    // bc36c768 — …and the NOT-CONFIGURED marker does NOT engage it, joining carryForwardIncludeEarned in
    // the exclusion for a stronger reason than that one. The 0376 clear-out stamps EVERY non-archived type
    // at once, including the ones 0325 never consolidated — whose real carry / rounding / max-balance
    // configuration is still in leave_policy.accrual. If the marker counted here, all of it would be
    // buried under the type's NULLs on deploy day and an EARNING-METHOD reset would silently wipe carry
    // forward and rounding. This exclusion is load-bearing.
    expect(hasAnyLeaveTypeRule({ accrualUnconfigured: new Date() })).toBe(false);
    expect(applyLeaveTypeRules(POL, { accrualUnconfigured: new Date() })).toBe(POL);
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
      // 8fec719e (migration 0358) added the THIRTEENTH rule column, the custom rounding table. Carried on
      // the overlay unconditionally and null here, because this type has no table — and read only by the
      // 'custom' branch of applyRounding, so its presence cannot move a 'down' figure either.
      roundingBands: null,
      // bc36c768 (migration 0375) added the FOURTEENTH rule column, the monthly credit day. Carried on the
      // overlay unconditionally and null here, because this fixture sets none — and read only by the
      // 'earned_monthly' branch of earnedToDateFor, where null means day 1, so its presence cannot move an
      // 'earned_quarterly' figure. The NOT-CONFIGURED marker (the fifteenth column) is deliberately NOT
      // here: it decides whether a type is granted AT ALL, upstream of what its rules say, and letting it
      // leak into the resolved policy would invite an engine to read it as one more accrual method.
      accrualDay: null,
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
  // The old flat policy `{ annualDays: 12, method: 'grant_on_hire_prorated', carryForwardMax: 5 }`, said as
  // a band: 12 days, carry 5. The method is not here because it is a TYPE rule now, and an absent one is
  // the lump engines — the same behaviour `grant_on_hire_prorated` named explicitly.
  const LUMP: ServiceBand = { fromYears: 0, toYears: null, days: 12, carryForwardDays: 5 };

  it('baseline: with the type silent, the entitlement table still drives every figure', async () => {
    await entitlementTable(LUMP);
    // hire       — floor 8 at 0 years, band 12 ⇒ 12, January joiner so no pro-ration loss.
    // year-open  — 2 completed years ⇒ floor 12, band 12 ⇒ 12 granted; the 12 already held is carried
    //              at the band's cap of 5 and the remaining 7 forfeited ⇒ 5 + 12 = 17.
    // accrual    — no earning method anywhere, so accrueEarnedLeave does not own this type.
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
    expect(baseline.afterYearOpen).toBe(17); // band cap 5: carried 5 + granted 12
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
      { fromYears: 0, toYears: null, days: 12.4, carryForwardDays: 5 },
      { accrualMethod: 'grant_on_hire_prorated', roundingMethod: 'up' },
    );
    expect(baseline.afterHire).toBe(12.4); // nothing states a rounding rule ⇒ the raw figure
    expect(repointed.afterHire).toBe(13); // 12.4 lifted to the next whole day
  });

  it('MAXIMUM BALANCE from the type caps a band that states none of its own', async () => {
    // The sharpest case for the relocation. `maxBalanceDays` is a PER-BAND figure, so a band that states
    // none has no cap and nothing clamps it. Moved to the type it applies to everyone — including every
    // band that never asked for one. (This is the shape migration 0334 refused to ship without a human
    // deciding; the guard itself is retired below with the table it read.)
    const { baseline, repointed } = await baselineAndRepointed(LUMP, {
      accrualMethod: 'grant_on_hire_prorated',
      maxBalanceDays: '10',
    });
    expect(baseline.afterHire).toBe(12); // the band states no cap ⇒ nothing clamps
    expect(repointed.afterHire).toBe(10); // the type's cap clamps the opening grant
  });

  it('PER-BAND carryForwardDays stops being read once the type carries rules (the step-2 decision)', async () => {
    // THE PRECEDENCE TEST, and the one that matters most after the drop: it is now the ONLY thing standing
    // between a band's per-range carry figure and the type's, and both figures are unchanged.
    const banded: ServiceBand = { fromYears: 0, toYears: null, days: 12, carryForwardDays: 9 };
    const { baseline, repointed } = await baselineAndRepointed(banded, {
      accrualMethod: 'grant_on_hire_prorated',
      carryForwardMax: '5',
    });
    // Before: with the type silent, the BAND's own 9 is the cap ⇒ carried 9 + granted 12.
    expect(baseline.afterYearOpen).toBe(21);
    // After: the band's carry figure is not consulted at all; the type's cap of 5 governs ⇒ 5 + 12.
    expect(repointed.afterYearOpen).toBe(17);
  });
});

// ── RETIRED · `3. migration 0334, the guard` (10 tests) and its replay scaffolding ──────────────────
//
// The block re-executed migrations 0325 and 0334 FROM THE ACTUAL FILES against a fully-migrated schema,
// inserting `leave_policy` rows and asserting the guard refused to repoint whenever the collapse WOULD
// have moved somebody's balance: a rule stated by one row and absent from another, a maximum balance a
// band-less policy never had, a band actually using the per-band carry-forward or carry expiry that step 2
// stops reading, and that a refusal leaves the ledger untouched.
//
// Migration 0405 DROPPED `leave_policy`. 0325 backfills FROM that table and 0334 compares AGAINST it (six
// references), so by the time `migrateTestDb()` has run the whole chain neither statement has a table to
// run against — the replay aborts before it can assert anything. Both migrations remain valid IN THE
// CHAIN, where they run in order on a fresh database while `leave_policy` is still alive; what is gone is
// the ability to re-run them afterwards, which is the only thing this block ever did.
//
// This is a real reduction in coverage and it is worth naming precisely: what is no longer tested is the
// SAFETY GUARD ON A ONE-OFF MIGRATION THAT HAS ALREADY RUN EVERYWHERE. It protected the moment of
// consolidation. That moment has passed on every database, and the table it protected has since been
// dropped, so there is no future execution for the guard to fail on. The BEHAVIOUR the guard was
// protecting — that the type's rules and not a policy's drive every engine — is what group 2 above
// asserts directly, in produced day values, and that is the part that still has a future.
