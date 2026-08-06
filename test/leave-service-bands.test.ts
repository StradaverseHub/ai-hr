/**
 * Leave Entitlement Rules Engine (feedback a0228655) — service-length bands, the band resolver, the
 * per-range entitlement columns (9d8cf621) and the engines that spend them.
 *
 * ── 6e9a126e RELEASE THREE: WHERE THE BANDS LIVE CHANGED; WHAT THEY DO DID NOT ───────────────────────
 * Migration 0405 dropped `leave_policy`, so a band table is no longer a key inside a policy row's JSONB —
 * it is `entitlement_template.service_bands`, assigned to people by an eligibility rule. Every fixture
 * below is repointed onto `seedEntitlement` (test/harness.ts), which makes exactly those two writes, and
 * EVERY ASSERTION ABOUT THE ARITHMETIC IS UNCHANGED: the same 14/16/18 worked example, the same
 * boundary years, the same clamps, the same forfeits, the same balances.
 *
 * Three of the original describe blocks tested the DROPPED LAYER ITSELF rather than the engine, and are
 * retired in place with their reasons — see the RETIRED notes at their former positions. Nothing was
 * loosened to make anything pass.
 *
 * WHERE A RULE COMES FROM, in the world these fixtures now build. 9816a5ad step 2 split configuration in
 * two: the entitlement layer owns DAYS, the leave TYPE owns RULES (earning method, carry cap, carry
 * expiry, rounding, maximum balance). `applyLeaveTypeRules` replaces the WHOLE rule set from the type the
 * moment the type states any one of them. So a fixture that wants a band's own per-range override to be
 * read must leave the type silent, and a fixture that wants the old POLICY-LEVEL rule must put it on the
 * type. Which one each test picks is stated at the test, because it is the difference between exercising
 * `policyFromTemplateBand` and exercising the overlay.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, expireCarriedLeave, openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  applyMaxBalance,
  bandCarryExpiry,
  bandCarryMax,
  bandFor,
  bandMaxBalance,
  // 6e9a126e — the band ceiling, imported rather than restated, so this test moves with the constant.
  isWellFormedBands,
  MAX_SERVICE_BANDS,
  policyFromTemplateBand,
  type AccrualConfig,
  type ServiceBand,
} from '../core/leave-compute';
import { createEntitlementTemplate, updateEntitlementTemplate } from '../core/entitlement-template';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;
const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const hire = (hiredOn: string, gradeId: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Band', primaryEmail: `band_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/**
 * Set rule columns on the ANNUAL leave type — the home of every RULE since 9816a5ad step 2, and therefore
 * where a fixture that used to say "policy-level carry cap / expiry / maximum balance" has to say it now.
 *
 * Written directly rather than through `setLeaveTypeRules` on purpose: that writer refuses the retired
 * rounding methods and normalises several fields, and these fixtures are describing a STORED world for the
 * engines to read, not exercising the writer (which has its own file).
 */
const setTypeRules = (rules: Partial<typeof schema.leaveType.$inferInsert>) =>
  owner.db.update(schema.leaveType).set(rules).where(eq(schema.leaveType.id, b.annualLeaveTypeId));

/** The band table for ANNUAL, assigned to everybody — `seedEntitlement`'s template + eligibility rule. */
const seedBands = (serviceBands: ServiceBand[], p: { validFrom?: string; name?: string } = {}) =>
  seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, serviceBands, ...p });

/** Under-2 = 14, 2-to-under-5 = 16, 5-and-above = 18 (the feedback's own worked example). */
const REQUEST_BANDS: ServiceBand[] = [
  { fromYears: 0, toYears: 2, days: 14 },
  { fromYears: 2, toYears: 5, days: 16 },
  { fromYears: 5, toYears: null, days: 18 },
];

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

// ── Pure resolver unit tests ──────────────────────────────────────────────────────────────────────────

/**
 * `bandDaysFor` — the `bandFor(...)?.days ?? annualDays` wrapper — was DELETED by release three, because
 * `annualDays` was the flat `leave_policy` figure a band sat above and there is no policy row left to fall
 * back to. An entitlement template is bands and nothing else.
 *
 * So every case below is repointed onto `bandFor`, which is the half-open matcher `bandDaysFor` always
 * delegated to. The MATCHING cases keep their exact day figures. The DEFENSIVE cases keep their exact
 * inputs and now assert `null` — "no band resolves" — instead of "falls back to 12/9/20. That is not a
 * weaker assertion: null is the only answer `bandFor` has ever given for a malformed table, and it is
 * strictly more specific than a fallback number, because a fallback number is indistinguishable from a
 * correctly resolved one. What the caller does with null is `composeEntitlement`'s job and is pinned by
 * test/entitlement-no-opinion-guard.ts.
 */
describe('bandFor — half-open boundary matching + defensive fallback', () => {
  const acc = (bands: unknown, annualDays = 12): AccrualConfig => ({ annualDays, serviceBands: bands as ServiceBand[] });
  const days = (bands: unknown, years: number) => bandFor(acc(bands), years)?.days ?? null;

  it('picks the correct band at 0, 2, 5, 6 completed years (half-open: fromYears <= years < toYears)', () => {
    expect(days(REQUEST_BANDS, 0)).toBe(14);
    expect(days(REQUEST_BANDS, 1)).toBe(14);
    expect(days(REQUEST_BANDS, 2)).toBe(16); // boundary: 2 enters the 2-5 band, not the under-2 band
    expect(days(REQUEST_BANDS, 4)).toBe(16);
    expect(days(REQUEST_BANDS, 5)).toBe(18); // boundary: 5 enters the open-ended top band
    expect(days(REQUEST_BANDS, 6)).toBe(18);
    expect(days(REQUEST_BANDS, 50)).toBe(18);
  });

  it('resolves NO band when no serviceBands are configured', () => {
    expect(bandFor(acc(undefined, 20), 10)).toBeNull();
    expect(bandFor({ annualDays: 20 }, 10)).toBeNull();
    expect(bandFor(acc([], 20), 10)).toBeNull();
  });

  it('DEFENSIVE: non-array serviceBands resolves to no band, never throws', () => {
    expect(bandFor(acc('not-an-array', 9), 3)).toBeNull();
    expect(bandFor(acc(42, 9), 3)).toBeNull();
    expect(bandFor(acc({}, 9), 3)).toBeNull();
  });

  it('DEFENSIVE: malformed band rows (strings, negative, non-integer) resolve to no band', () => {
    expect(bandFor(acc([{ fromYears: '0', toYears: 2, days: 10 }], 9), 1)).toBeNull();
    expect(bandFor(acc([{ fromYears: -1, toYears: null, days: 10 }], 9), 1)).toBeNull();
    expect(bandFor(acc([{ fromYears: 0.5, toYears: null, days: 10 }], 9), 1)).toBeNull();
    expect(bandFor(acc([{ fromYears: 0, toYears: null, days: -5 }], 9), 1)).toBeNull();
  });

  it('DEFENSIVE: overlapping bands resolve to no band', () => {
    const overlapping: ServiceBand[] = [
      { fromYears: 0, toYears: 3, days: 10 },
      { fromYears: 2, toYears: null, days: 20 },
    ];
    expect(bandFor(acc(overlapping, 9), 2)).toBeNull();
  });

  it('DEFENSIVE: a gap between bands resolves to no band', () => {
    const gappy: ServiceBand[] = [
      { fromYears: 0, toYears: 2, days: 10 },
      { fromYears: 3, toYears: null, days: 20 },
    ];
    expect(bandFor(acc(gappy, 9), 4)).toBeNull();
  });

  it('DEFENSIVE: first band not starting at 0 resolves to no band', () => {
    const badStart: ServiceBand[] = [{ fromYears: 1, toYears: null, days: 20 }];
    expect(bandFor(acc(badStart, 9), 5)).toBeNull();
  });

  it('DEFENSIVE: a malformed array (last band not open-ended) resolves to no band for ANY service length', () => {
    // A single band with a closed toYears fails isWellFormedBands' "last band must be null" rule, so the
    // WHOLE array is treated as malformed (never partially trusted) — every call resolves to nothing.
    const notOpen: ServiceBand[] = [{ fromYears: 0, toYears: 5, days: 20 }];
    expect(bandFor(acc(notOpen, 9), 1)).toBeNull();
    expect(bandFor(acc(notOpen, 9), 6)).toBeNull();
  });
});

// ── RETIRED · `resolveGradePolicy — band-resolved most-generous pick + back-compat + grade/company
//    tiering` (4 tests) ─────────────────────────────────────────────────────────────────────────────
// `resolveGradePolicy` WAS the `leave_policy` resolver: given every policy row for a type, pick a winner by
// company tier, then grade tier, then most-generous days. Migration 0405 dropped the table and release
// three deleted the function, so there is nothing left for these four to call. They are not repointed
// because the new layer does not decide the same way and it would be dishonest to pretend otherwise:
//   - "most generous wins" is GONE. Two entitlement templates never compete on days; the ELIGIBILITY RULES
//     compete, and the MOST SPECIFIC one wins (orgCriteriaSpecificity / beatsEligibility).
//   - the grade/company tiering these tests pinned survives as a special case of that: a grade-scoped rule
//     used to beat a grade-less one by having a grade, and now beats it by being narrower. Same outcome,
//     decided elsewhere — and it is pinned where it is now decided, in
//     test/entitlement-template-layer.test.ts (`beatsEligibility`, specificity ranking and ties).
// The band-resolution half of what these tests covered — that a band table resolves per service length at
// all — is the `bandFor` block above and the integration blocks below, both of which keep their figures.

// ── RETIRED · `previewEntitlement — scope derivation + belowStatutoryFloor, incl. company-resolves-null
//    short-circuit` (5 tests) ─────────────────────────────────────────────────────────────────────────
// `previewEntitlement` previewed the resolution of `leave_policy` rows for the admin Entitlements screen —
// its `scope: 'group' | 'company' | 'none'` return value is a description of the policy tiering that no
// longer exists, and it was deleted with the layer it previewed. The one property here that outlived it,
// fa3f4ccb's "a configured figure BELOW the statutory minimum resolves to ITSELF and only raises a
// warning", is asserted on the surviving composition by `belowStatutoryFloor` / `composeEntitlement` and,
// end to end, by the 6-day-band hire test further down this file, which still credits 6 against an 8-day
// statutory minimum.

// ── Integration tests ─────────────────────────────────────────────────────────────────────────────────
describe('Leave Entitlement Rules Engine — band validation (write-time)', () => {
  // Repointed from `createLeavePolicy` to `createEntitlementTemplate`. The VALIDATOR IS THE SAME FUNCTION:
  // 6e9a126e moved `validateServiceBands` into core/leave-compute.ts precisely so both writers could share
  // it, and the template writer calls it before its first insert. Every message matched below is therefore
  // matched against the same throw site as before.
  let n = 0;
  const create = (serviceBands: ServiceBand[]) =>
    createEntitlementTemplate(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      name: `Bands ${++n}`,
      serviceBands,
      validFrom: '2026-01-01',
    });

  it('accepts the feedback worked example (0-2/2-5/5+)', async () => {
    const row = await create(REQUEST_BANDS);
    expect(row.serviceBands).toEqual(REQUEST_BANDS);
  });

  it('rejects overlapping bands', async () => {
    await expect(
      create([
        { fromYears: 0, toYears: 3, days: 10 },
        { fromYears: 2, toYears: null, days: 20 },
      ]),
    ).rejects.toThrow(/contiguous/i);
  });

  it('rejects a gap between bands', async () => {
    await expect(
      create([
        { fromYears: 0, toYears: 2, days: 10 },
        { fromYears: 3, toYears: null, days: 20 },
      ]),
    ).rejects.toThrow(/contiguous/i);
  });

  it('rejects a first band not starting at 0', async () => {
    await expect(create([{ fromYears: 1, toYears: null, days: 20 }])).rejects.toThrow(/first band/i);
  });

  it('rejects a last band that is not open-ended', async () => {
    await expect(create([{ fromYears: 0, toYears: 5, days: 20 }])).rejects.toThrow(/open-ended/i);
  });

  it('rejects toYears <= fromYears within a band', async () => {
    await expect(create([{ fromYears: 0, toYears: 0, days: 20 } as ServiceBand])).rejects.toThrow();
  });

  // Feedback 9d8cf621 — the per-range columns are validated at write time (negative caps, half-set expiry,
  // impossible dates) and a valid set round-trips with its extra keys intact.
  it('rejects a negative per-range carry-forward days', async () => {
    await expect(create([{ fromYears: 0, toYears: null, days: 14, carryForwardDays: -1 }])).rejects.toThrow(/carry-forward days/i);
  });

  it('rejects a negative per-range maximum balance days', async () => {
    await expect(create([{ fromYears: 0, toYears: null, days: 14, maxBalanceDays: -5 }])).rejects.toThrow(/maximum balance/i);
  });

  it('rejects a half-set per-range carry-forward expiry (month without day)', async () => {
    await expect(create([{ fromYears: 0, toYears: null, days: 14, carryForwardExpiryMonth: 6 }])).rejects.toThrow(/month and a day/i);
  });

  it('rejects an impossible per-range carry-forward expiry date (31 Feb)', async () => {
    await expect(
      create([{ fromYears: 0, toYears: null, days: 14, carryForwardExpiryMonth: 2, carryForwardExpiryDay: 31 }]),
    ).rejects.toThrow(/real calendar date/i);
  });

  it('accepts and round-trips a band carrying all per-range columns', async () => {
    const bands: ServiceBand[] = [
      { fromYears: 0, toYears: null, days: 14, carryForwardDays: 5, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31, maxBalanceDays: 20 },
    ];
    const row = await create(bands);
    expect(row.serviceBands).toEqual(bands);
  });

  // 6e9a126e RAISED THE CEILING 10 → 20, in BOTH places at once (core/leave-compute's isWellFormedBands
  // and the write-time validator, which now share the one MAX_SERVICE_BANDS constant). The reporter asked
  // for HR-defined service ranges instead of three hardcoded ones; 20 is our number and it only ever
  // widens, so no existing table loses a band. The count is UPDATED here rather than the assertion
  // loosened — a band-count test that stopped naming a number would stop catching the two halves drifting
  // apart, which is the failure that resolves to NO band and therefore a silently wrong day count.
  it(`rejects more than ${MAX_SERVICE_BANDS} bands`, async () => {
    const over = MAX_SERVICE_BANDS + 1;
    const many: ServiceBand[] = [];
    for (let i = 0; i < over; i++) {
      many.push({ fromYears: i, toYears: i === over - 1 ? null : i + 1, days: 10 });
    }
    await expect(create(many)).rejects.toThrow(new RegExp(`${MAX_SERVICE_BANDS} bands`, 'i'));
  });

  it(`accepts exactly ${MAX_SERVICE_BANDS} bands — and the RESOLVER accepts them too`, async () => {
    // The pair, asserted together. If only the validator had moved, this table would persist and then
    // resolve to no band at all: not an error, just the wrong number of days with nothing on screen.
    const bands: ServiceBand[] = [];
    for (let i = 0; i < MAX_SERVICE_BANDS; i++) {
      bands.push({ fromYears: i, toYears: i === MAX_SERVICE_BANDS - 1 ? null : i + 1, days: 10 + i });
    }
    expect(isWellFormedBands(bands)).toBe(true);
    const row = await create(bands);
    expect(row.serviceBands).toHaveLength(MAX_SERVICE_BANDS);
  });
});

describe('Leave Entitlement Rules Engine — editing a band table (preserve / replace / refuse)', () => {
  // The old JSONB tri-state (undefined = preserve, [] = clear, non-empty = replace) applied to
  // `updateLeavePolicy` rebuilding `leave_policy.accrual` wholesale. `updateEntitlementTemplate` keeps the
  // PRESERVE and REPLACE arms verbatim — `p.serviceBands ?? open.serviceBands`, validated when present —
  // and the CLEAR arm is genuinely gone, because `service_bands` is a NOT NULL column on the template and a
  // table with no bands is a table that grants nothing. That is asserted below rather than dropped: an
  // emptied editor is REFUSED by name, which is a stronger guarantee than the old silent clear.
  //
  // Editing is close-then-insert versioning, so the successor's validFrom must be AFTER the running one's.

  it('editing a name-only field (serviceBands undefined) leaves the bands intact', async () => {
    const tpl = await seedBands(REQUEST_BANDS, { validFrom: '2026-01-01' });
    const next = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      name: 'Renamed', // change a flat field only
      validFrom: '2027-01-01',
      // serviceBands omitted entirely ⇒ undefined ⇒ preserve
    });
    expect(next.name).toBe('Renamed');
    expect(next.serviceBands).toEqual(REQUEST_BANDS);
  });

  it('an emptied editor (serviceBands: []) is REFUSED, not silently cleared', async () => {
    const tpl = await seedBands(REQUEST_BANDS, { validFrom: '2026-01-01' });
    await expect(
      updateEntitlementTemplate(adminCtx(b), {
        lineageId: tpl.lineageId,
        serviceBands: [],
        validFrom: '2027-01-01',
      }),
    ).rejects.toThrow(/at least one band/i);
    // …and the running version is untouched by the refusal.
    const [still] = await owner.db
      .select({ serviceBands: schema.entitlementTemplate.serviceBands })
      .from(schema.entitlementTemplate)
      .where(eq(schema.entitlementTemplate.id, tpl.id));
    expect(still.serviceBands).toEqual(REQUEST_BANDS);
  });

  it('a non-empty array replaces the bands after validation', async () => {
    const tpl = await seedBands(REQUEST_BANDS, { validFrom: '2026-01-01' });
    const replacement: ServiceBand[] = [{ fromYears: 0, toYears: null, days: 30 }];
    const next = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: tpl.lineageId,
      serviceBands: replacement,
      validFrom: '2027-01-01',
    });
    expect(next.serviceBands).toEqual(replacement);
    // The replacement is validated on the way in, exactly as a create is.
    await expect(
      updateEntitlementTemplate(adminCtx(b), {
        lineageId: tpl.lineageId,
        serviceBands: [{ fromYears: 0, toYears: 5, days: 20 }], // not open-ended
        validFrom: '2028-01-01',
      }),
    ).rejects.toThrow(/open-ended/i);
  });
});

// ── RETIRED · `Leave Entitlement Rules Engine — SUPERSEDE (one active default per type)` (4 tests) ────
// All four drove `createLeavePolicy` / `updateLeavePolicy` / `deleteLeavePolicy` and asserted on
// `leave_policy` rows: the supersede loop that closed a prior version's validTo and emitted
// `leave-policy.superseded`, the "validFrom must be after the existing version" refusal, the
// scope-collision rule for legacy duplicate defaults, and that a delete leaves prior ledger rows alone.
// The table, the three writers and the event type are all gone.
//
// The property they were really about — a dated configuration is VERSIONED, never overwritten, so a closed
// year still reports on the figures that were in force then — is the entitlement template's close-then-
// insert, which has its own supersede refusal ("a version starting on or after that date already exists"),
// its own `entitlement-template.superseded` event and its own dated readers. It is pinned in
// test/entitlement-template-layer.test.ts and, for the readers, in
// test/entitlement-template-repoint.test.ts. The "editing a band table" block above covers the arm of it
// that this file was carrying.

describe('Leave Entitlement Rules Engine — integration: hire, openLeaveYear, accrueEarnedLeave, sweep', () => {
  it('hire with a banded table: the 0-year band drives the grant', async () => {
    await seedBands(REQUEST_BANDS);
    const emp = await hire('2026-01-01'); // hired 1 Jan ⇒ no pro-ration; 0 years ⇒ 14-day band
    expect(await balance(emp.employmentId)).toBe(14);
  });

  // fa3f4ccb: was "a 6-day band clamps up to the 8-day statutory floor at hire". The floor no longer
  // overrides a configured figure, so the 6-day band is granted as 6. ANNUAL at 0 years is a real MY
  // statutory band (8 days), so this genuinely crosses the minimum rather than passing on a floor of 0.
  it('fa3f4ccb: a 6-day band is granted as 6 at hire, BELOW the 8-day statutory minimum', async () => {
    await seedBands([{ fromYears: 0, toYears: null, days: 6 }]);
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(6); // configured wins; the 8-day minimum only warns
  });

  it('openLeaveYear band upgrade crossing the 2-year boundary (14 -> 16, the request example)', async () => {
    // The old fixture set a policy-level `carryForwardMax: 0`. With the leave type silent, a band that
    // states no `carryForwardDays` resolves through `policyFromTemplateBand` to `carryMax: 0` — the same
    // cap, from the surviving expression, so the forfeit arithmetic below is unchanged.
    await seedBands(REQUEST_BANDS, { validFrom: '2024-01-01' });
    const emp = await hire('2024-01-01'); // 0 years at hire ⇒ 14
    expect(await balance(emp.employmentId)).toBe(14);
    // Open 2026 (employee has exactly 2 completed years of service at 2026-01-01) — an unopened year.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // Balance = hire grant (14) + 2026 grant (16, carry cap 0 forfeits the rest) = 16.
    expect(await balance(emp.employmentId)).toBe(16);
  });

  it('accrueEarnedLeave with a banded earned type accrues at the banded rate', async () => {
    // The EARNING METHOD is a leave-TYPE rule since 9816a5ad step 2, so it is set on the type; the DAYS
    // still come from the band, which is the thing under test and is unchanged at (14/12) × 6.
    await seedBands(REQUEST_BANDS);
    await setTypeRules({ accrualMethod: 'earned_monthly' });
    const emp = await hire('2026-01-01'); // earned ⇒ no lump hire grant
    expect(await balance(emp.employmentId)).toBe(0);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15' }); // 6 months elapsed, 0y service ⇒ 14-day band
    expect(await balance(emp.employmentId)).toBeCloseTo((14 / 12) * 6, 2);
  });

  it('band validation rejections integration-verified via a full reject-then-succeed cycle', async () => {
    await expect(
      createEntitlementTemplate(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        name: 'Bad table',
        serviceBands: [{ fromYears: 0, toYears: 2, days: 10 }], // not open-ended
        validFrom: '2026-01-01',
      }),
    ).rejects.toThrow();
    // A well-formed table succeeds afterwards.
    await expect(
      createEntitlementTemplate(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        name: 'Good table',
        serviceBands: REQUEST_BANDS,
        validFrom: '2026-01-01',
      }),
    ).resolves.toBeDefined();
  });

  it("ONE targeted carry-flip test: sweep two consecutive years across a band boundary follows each year's own days-winner", async () => {
    // A banded ANNUAL table active from day one, with the carry cap + expiry on the LEAVE TYPE (where the
    // old policy-level ones moved). The flip is driven purely by the band boundary itself (14 -> 16 at 2
    // years), proving the sweep resolves per-swept-year service length (serviceYearsAt computed INSIDE the
    // per-year loop) rather than "today's" service length.
    await seedBands(REQUEST_BANDS, { validFrom: '2024-01-01' });
    await setTypeRules({
      carryForwardMax: '20', // generous cap — isolates the band effect from cap-driven forfeits
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
    });
    const emp = await hire('2024-01-01'); // hired under the banded table: 0y at hire ⇒ 14-day grant
    expect(await balance(emp.employmentId)).toBe(14);
    // Open 2025: 1 completed year ⇒ still the under-2 band (14). Balance carries in full (14 <= cap 20).
    await openLeaveYear(adminCtx(b), { year: 2025 });
    expect(await balance(emp.employmentId)).toBe(28); // 14 (hire) + 14 (2025, still under-2 at its own open)
    // Open 2026: 2 completed years ⇒ the 2-5 band (16) — THE BOUNDARY FLIP. This proves each open resolves
    // its own year's service length (not a single "current" one): had 2026 wrongly reused 2025's service
    // length, it would grant 14 again, not 16. The prior 28-day balance exceeds the 20-day cap, so 8 days
    // forfeit at open (28 - 20 = 8, unrelated to the band flip — just the ordinary cap mechanism).
    const r2026 = await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(r2026.forfeits).toBe(1);
    expect(await balance(emp.employmentId)).toBe(36); // 20 (capped carry) + 16 (2026's band-flip grant)
    // Sweep past both years' 31 Mar expiry dates. Each swept year's carry-cap must resolve using THAT
    // year's own service length (not today's, and not each other's) — the sweep must not throw, and the
    // balance can only go down (further forfeits of stale unconsumed carry), never up.
    const before = await balance(emp.employmentId);
    await expect(expireCarriedLeave(adminCtx(b), { today: '2027-04-01' })).resolves.toBeDefined();
    expect(await balance(emp.employmentId)).toBeLessThanOrEqual(before);
  });
});

describe('Leave Entitlement Rules Engine — read-layer wiring (leaveEntitlementBreakdown)', () => {
  it('carryMax/expiry/earned-flag follow the banded winner without changing currentYearEntitlement (ledger-derived)', async () => {
    await seedBands(REQUEST_BANDS);
    await setTypeRules({ carryForwardMax: '3', carryForwardEnabled: true });
    const emp = await hire('2026-01-01');
    const breakdown = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-06-01');
    expect(breakdown).not.toBeNull();
    // currentYearEntitlement is ledger-derived (the hire grant, 14 days at 0y band) — read.ts wiring does
    // not change this number; it changes carryMax/expiry consistency (asserted implicitly by not throwing).
    expect(breakdown!.currentYearEntitlement).toBe(14);
  });
});

// ═══ Feedback 9d8cf621 — per-range entitlement columns actually drive the engine ══════════════════════
// Gap 1: Maximum Balance Days must be ENFORCED (clamp balance at grant / earned accrual / carry-in).
// Gap 2: per-range Carry-Forward Days + Carry-Forward Expiry must be APPLIED (not just persisted).

describe('9d8cf621 pure — per-range resolution + Maximum Balance clamp', () => {
  it('bandFor returns the matching band object incl. its per-range overrides', () => {
    const bands: ServiceBand[] = [
      { fromYears: 0, toYears: 2, days: 14, carryForwardDays: 5, maxBalanceDays: 15 },
      { fromYears: 2, toYears: null, days: 16, carryForwardDays: 8, carryForwardExpiryMonth: 6, carryForwardExpiryDay: 30 },
    ];
    const acc: AccrualConfig = { annualDays: 12, serviceBands: bands };
    expect(bandFor(acc, 1)).toMatchObject({ days: 14, carryForwardDays: 5, maxBalanceDays: 15 });
    expect(bandFor(acc, 3)).toMatchObject({ days: 16, carryForwardDays: 8 });
    expect(bandFor({ annualDays: 12 }, 3)).toBeNull();
  });

  it('bandCarryMax / bandMaxBalance / bandCarryExpiry are defensive (bad values ⇒ null)', () => {
    expect(bandCarryMax({ fromYears: 0, toYears: null, days: 10, carryForwardDays: 7 })).toBe(7);
    expect(bandCarryMax({ fromYears: 0, toYears: null, days: 10, carryForwardDays: -3 })).toBeNull();
    expect(bandCarryMax({ fromYears: 0, toYears: null, days: 10 })).toBeNull();
    expect(bandMaxBalance({ fromYears: 0, toYears: null, days: 10, maxBalanceDays: 0 })).toBe(0);
    expect(bandMaxBalance({ fromYears: 0, toYears: null, days: 10, maxBalanceDays: null })).toBeNull();
    expect(bandCarryExpiry({ fromYears: 0, toYears: null, days: 10, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 })).toEqual({ month: 3, day: 31 });
    expect(bandCarryExpiry({ fromYears: 0, toYears: null, days: 10, carryForwardExpiryMonth: 2, carryForwardExpiryDay: 31 })).toBeNull();
    expect(bandCarryExpiry({ fromYears: 0, toYears: null, days: 10 })).toBeNull();
  });

  it('applyMaxBalance clamps carry-in to the cap and the grant to the remaining room', () => {
    expect(applyMaxBalance(10, 8, null)).toEqual({ carry: 10, grant: 8 }); // no cap ⇒ pass-through
    expect(applyMaxBalance(10, 8, 15)).toEqual({ carry: 10, grant: 5 }); // room = 15-10 = 5
    expect(applyMaxBalance(20, 8, 15)).toEqual({ carry: 15, grant: 0 }); // carry over cap ⇒ clamp, no room
    expect(applyMaxBalance(0, 20, 15)).toEqual({ carry: 0, grant: 15 }); // fresh grant capped
  });

  // ── RETIRED · `hasAnyCarryExpiry sees policy-level OR per-band expiry` ─────────────────────────────
  // `hasAnyCarryExpiry` answered "does this leave_policy row carry a carry-expiry anywhere", and its one
  // caller was `expireCarriedLeave`'s unfiltered `leave_policy` scan. Both are gone: the sweep's
  // back-compat boundary is now `earliestTemplateYear` plus the leave TYPE's own carry-expiry columns.
  // See the Gap 2 sweep test below, which is repointed onto that boundary and keeps its arithmetic.

  it('policyFromTemplateBand surfaces the per-range carry cap, expiry and maximum balance from the band', () => {
    // Repointed from `resolveGradePolicy`, which read the same three per-range keys off the winning band
    // and is deleted with the policy rows it ranked. `policyFromTemplateBand` is the surviving expression:
    // the winning band IS the resolved policy's days + carry + expiry + cap.
    const band: ServiceBand = {
      fromYears: 0,
      toYears: null,
      days: 14,
      carryForwardDays: 9,
      maxBalanceDays: 15,
      carryForwardExpiryMonth: 6,
      carryForwardExpiryDay: 30,
    };
    const pol = policyFromTemplateBand(bandFor({ serviceBands: [band] }, 1));
    expect(pol).not.toBeNull();
    expect(pol!.days).toBe(14);
    expect(pol!.carryMax).toBe(9);
    expect(pol!.maxBalanceDays).toBe(15);
    expect(pol!.carryExpiry).toEqual({ month: 6, day: 30 });
  });

  it('policyFromTemplateBand falls back to the documented defaults when the band states no override', () => {
    // The old fixture's fallback was the POLICY-LEVEL carry cap and expiry sitting beside the bands. There
    // is no policy row to fall back to, so the fallback is now each field's own default — cap 0, no expiry,
    // no maximum balance — which is what `bandCarryMax(...) ?? 0` and its two siblings have always
    // produced for a band that says nothing. Where those defaults are OVERLAID by the leave type's rules is
    // test/leave-type-rules-repoint.test.ts.
    const pol = policyFromTemplateBand(bandFor({ serviceBands: [{ fromYears: 0, toYears: null, days: 14 }] }, 1));
    expect(pol!.days).toBe(14);
    expect(pol!.carryMax).toBe(0);
    expect(pol!.carryExpiry).toBeNull();
    expect(pol!.maxBalanceDays).toBeNull();
  });

  it('policyFromTemplateBand resolves NOTHING when no band matched — absence is not a zero policy', () => {
    // The distinction `noEntitlementOpinion` depends on: no band is "nobody configured anything", which a
    // caller must never spend as a confident 0.
    expect(policyFromTemplateBand(null)).toBeNull();
  });
});

describe('9d8cf621 integration — Maximum Balance Days enforcement (Gap 1)', () => {
  it('clamps the hire grant so the opening balance never exceeds the cap', async () => {
    // Type silent ⇒ the BAND's own maxBalanceDays is the cap that binds.
    await seedBands([{ fromYears: 0, toYears: null, days: 20, maxBalanceDays: 15 }]);
    const emp = await hire('2026-01-01'); // 0y ⇒ band days 20, but cap clamps to 15
    expect(await balance(emp.employmentId)).toBe(15);
  });

  it('clamps carry-in + grant at openLeaveYear so the balance holds at the cap across years', async () => {
    // The old fixture put the generous carry cap at policy level and the maximum balance in the band. Both
    // go in the BAND here, deliberately: putting the carry cap on the leave type would engage the overlay,
    // which replaces the WHOLE rule set from the type and would take the band's maximum balance with it —
    // and the maximum balance is the thing under test. The arithmetic is unchanged.
    await seedBands([{ fromYears: 0, toYears: null, days: 14, carryForwardDays: 20, maxBalanceDays: 15 }], {
      validFrom: '2024-01-01',
    });
    const emp = await hire('2024-01-01'); // 14 (cap 15 not yet reached)
    expect(await balance(emp.employmentId)).toBe(14);
    await openLeaveYear(adminCtx(b), { year: 2025 }); // carry 14 + grant clamped to room(1) = 15
    expect(await balance(emp.employmentId)).toBe(15);
    await openLeaveYear(adminCtx(b), { year: 2026 }); // already at cap ⇒ grant 0, stays 15
    expect(await balance(emp.employmentId)).toBe(15);
  });

  it('clamps earned accrual so retained-carry + earned never exceeds the cap', async () => {
    // THE ONE CASE THAT MUST CONFIGURE THE CAP ON THE TYPE. An earned method is a leave-TYPE rule, and the
    // moment the type states any rule `applyLeaveTypeRules` replaces the whole set — so a band-level
    // maximum balance is unreachable for an earned type by design (9816a5ad step 2, pinned in
    // test/leave-type-rules-repoint.test.ts). The Gap 1 property under test is that the maximum balance
    // clamps the EARNED engine, and the figures are unchanged: 6 months of 14/12 = 7, clamped to 5.
    await seedBands([{ fromYears: 0, toYears: null, days: 14 }]);
    await setTypeRules({ accrualMethod: 'earned_monthly', maxBalanceDays: '5' });
    const emp = await hire('2026-01-01'); // earned ⇒ no lump grant
    expect(await balance(emp.employmentId)).toBe(0);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15' }); // 6mo ⇒ 7 earned, clamped to cap 5
    expect(await balance(emp.employmentId)).toBe(5);
  });
});

describe('9d8cf621 integration — per-range carry-forward days + expiry (Gap 2)', () => {
  it('per-range Carry-Forward Days is the carry cap at openLeaveYear', async () => {
    // The old fixture proved the band's `carryForwardDays: 10` beat a policy-level `carryForwardMax: 0`.
    // There is no policy level left to beat, so what this now pins is that the band's own figure IS the cap
    // the year-open spends — the same limb of `policyFromTemplateBand`, and the identical arithmetic. (The
    // precedence question moved up a layer and inverted: the leave TYPE now beats the band, which is
    // asserted in test/leave-type-rules-repoint.test.ts.)
    await seedBands([{ fromYears: 0, toYears: null, days: 14, carryForwardDays: 10 }], { validFrom: '2024-01-01' });
    const emp = await hire('2024-01-01'); // 14
    expect(await balance(emp.employmentId)).toBe(14);
    const r = await openLeaveYear(adminCtx(b), { year: 2025 });
    // carry = min(14, per-range 10) = 10; forfeit 4; + 2025 grant 14 ⇒ 24.
    expect(r.forfeits).toBe(1);
    expect(await balance(emp.employmentId)).toBe(24);
  });

  it('a banded table carried under a type-level expiry is swept when that expiry date passes', async () => {
    // REPOINTED, AND THE REPOINT IS ITSELF THE FINDING. The original asserted that a PER-RANGE carry expiry
    // alone (no policy-level one) still drove `expireCarriedLeave`. It cannot any more, and not because of
    // anything release three did to the band: the sweep's back-compat gate is
    // `annualTypes.some(typeCarriesExpiry)`, i.e. the LEAVE TYPE's own expiry columns — and once the type
    // states an expiry, `applyLeaveTypeRules` replaces the band's with it. So the per-range expiry limb of
    // `policyFromTemplateBand` is unreachable from the sweep in either direction. That is 9816a5ad step 2's
    // decision ("the type owns the rules") finally becoming total now that leave_policy is gone, not a new
    // defect — the limb is still live for the dated READERS, which is why `bandCarryExpiry` keeps its own
    // unit test above.
    //
    // What survives here, with its arithmetic intact, is the sweep itself over a template-banded carry.
    await seedBands([{ fromYears: 0, toYears: null, days: 14 }], { validFrom: '2024-01-01' });
    await setTypeRules({
      carryForwardMax: '20', // generous carry so the balance carries; the expiry is what is under test
      carryForwardEnabled: true,
      carryForwardExpiryMode: 'date',
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
    });
    const emp = await hire('2024-01-01'); // 14
    await openLeaveYear(adminCtx(b), { year: 2025 }); // carries 14 (into 2025, expiry 2025-03-31) + grant 14 = 28
    expect(await balance(emp.employmentId)).toBe(28);
    const before = await balance(emp.employmentId);
    // Sweep past 2025-03-31. The boundary the sweep may reach back to is `earliestTemplateYear` — the
    // template's own validFrom — so a tenant whose only configuration is a template is still swept.
    const res = await expireCarriedLeave(adminCtx(b), { today: '2026-04-01' });
    expect(res.swept).toBeGreaterThanOrEqual(1);
    expect(await balance(emp.employmentId)).toBeLessThan(before);
  });
});
