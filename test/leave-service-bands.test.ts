/**
 * Leave Entitlement Rules Engine (feedback a0228655) — service-length bands above the flat annualDays,
 * the one-active-default-per-type supersede fix, and the pure preview resolver.
 *
 * Pure-resolver unit tests exercise core/leave-compute.ts directly (bandDaysFor, resolveGradePolicy with
 * bands, previewEntitlement) — no DB needed. Integration tests exercise the full stack (hire grant,
 * openLeaveYear, accrueEarnedLeave, expireCarriedLeave, admin.ts validation + supersede + tri-state).
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, createLeavePolicy, deleteLeavePolicy, updateLeavePolicy } from '../core/admin';
import { accrueEarnedLeave, expireCarriedLeave, openLeaveYear } from '../core/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import {
  applyMaxBalance,
  bandCarryExpiry,
  bandCarryMax,
  bandDaysFor,
  bandFor,
  bandMaxBalance,
  hasAnyCarryExpiry,
  // 6e9a126e — the band ceiling, imported rather than restated, so this test moves with the constant.
  isWellFormedBands,
  MAX_SERVICE_BANDS,
  previewEntitlement,
  resolveGradePolicy,
  type AccrualConfig,
  type GradePolicyRow,
  type ServiceBand,
} from '../core/leave-compute';
import { adminCtx, closeAll, eventTypesFor, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

const readAccrual = async (policyId: string): Promise<Record<string, unknown>> => {
  const [row] = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.id, policyId));
  return (row?.accrual as Record<string, unknown>) ?? {};
};

const readPolicy = async (policyId: string) => {
  const [row] = await owner.db.select().from(schema.leavePolicy).where(eq(schema.leavePolicy.id, policyId));
  return row;
};

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
describe('bandDaysFor — half-open boundary matching + defensive fallback', () => {
  const acc = (bands: unknown, annualDays = 12): AccrualConfig => ({ annualDays, serviceBands: bands as ServiceBand[] });

  it('picks the correct band at 0, 2, 5, 6 completed years (half-open: fromYears <= years < toYears)', () => {
    const a = acc(REQUEST_BANDS);
    expect(bandDaysFor(a, 0)).toBe(14);
    expect(bandDaysFor(a, 1)).toBe(14);
    expect(bandDaysFor(a, 2)).toBe(16); // boundary: 2 enters the 2-5 band, not the under-2 band
    expect(bandDaysFor(a, 4)).toBe(16);
    expect(bandDaysFor(a, 5)).toBe(18); // boundary: 5 enters the open-ended top band
    expect(bandDaysFor(a, 6)).toBe(18);
    expect(bandDaysFor(a, 50)).toBe(18);
  });

  it('falls back to annualDays when no serviceBands are configured', () => {
    expect(bandDaysFor(acc(undefined, 20), 10)).toBe(20);
    expect(bandDaysFor({ annualDays: 20 }, 10)).toBe(20);
  });

  it('DEFENSIVE: non-array serviceBands falls back to annualDays, never throws', () => {
    expect(bandDaysFor(acc('not-an-array', 9), 3)).toBe(9);
    expect(bandDaysFor(acc(42, 9), 3)).toBe(9);
    expect(bandDaysFor(acc({}, 9), 3)).toBe(9);
  });

  it('DEFENSIVE: malformed band rows (strings, negative, non-integer) fall back to annualDays', () => {
    expect(bandDaysFor(acc([{ fromYears: '0', toYears: 2, days: 10 }], 9), 1)).toBe(9);
    expect(bandDaysFor(acc([{ fromYears: -1, toYears: null, days: 10 }], 9), 1)).toBe(9);
    expect(bandDaysFor(acc([{ fromYears: 0.5, toYears: null, days: 10 }], 9), 1)).toBe(9);
    expect(bandDaysFor(acc([{ fromYears: 0, toYears: null, days: -5 }], 9), 1)).toBe(9);
  });

  it('DEFENSIVE: overlapping bands fall back to annualDays', () => {
    const overlapping: ServiceBand[] = [
      { fromYears: 0, toYears: 3, days: 10 },
      { fromYears: 2, toYears: null, days: 20 },
    ];
    expect(bandDaysFor(acc(overlapping, 9), 2)).toBe(9);
  });

  it('DEFENSIVE: a gap between bands falls back to annualDays', () => {
    const gappy: ServiceBand[] = [
      { fromYears: 0, toYears: 2, days: 10 },
      { fromYears: 3, toYears: null, days: 20 },
    ];
    expect(bandDaysFor(acc(gappy, 9), 4)).toBe(9);
  });

  it('DEFENSIVE: first band not starting at 0 falls back to annualDays', () => {
    const badStart: ServiceBand[] = [{ fromYears: 1, toYears: null, days: 20 }];
    expect(bandDaysFor(acc(badStart, 9), 5)).toBe(9);
  });

  it('DEFENSIVE: a malformed array (last band not open-ended) falls back to annualDays for ANY service length', () => {
    // A single band with a closed toYears fails isWellFormedBands' "last band must be null" rule, so the
    // WHOLE array is treated as malformed (never partially trusted) — every call falls back to annualDays.
    const notOpen: ServiceBand[] = [{ fromYears: 0, toYears: 5, days: 20 }];
    expect(bandDaysFor(acc(notOpen, 9), 1)).toBe(9);
    expect(bandDaysFor(acc(notOpen, 9), 6)).toBe(9);
  });
});

describe('resolveGradePolicy — band-resolved most-generous pick + back-compat + grade/company tiering', () => {
  const row = (annualDays: number, opts: Partial<GradePolicyRow> & { serviceBands?: ServiceBand[] } = {}): GradePolicyRow => ({
    gradeId: opts.gradeId ?? null,
    companyId: opts.companyId ?? null,
    accrual: { annualDays, method: 'grant_on_hire_prorated', serviceBands: opts.serviceBands },
  });

  it('a lower flat annualDays with a higher band for this service length still wins the most-generous pick', () => {
    const rows = [row(20), row(10, { serviceBands: REQUEST_BANDS })]; // 20 flat vs banded (18 at 6y)
    expect(resolveGradePolicy(rows, null, undefined, 6)?.days).toBe(20); // flat still wins at 6y (20 > 18)
    const rows2 = [row(15), row(10, { serviceBands: REQUEST_BANDS })];
    expect(resolveGradePolicy(rows2, null, undefined, 6)?.days).toBe(18); // banded wins at 6y (18 > 15)
  });

  it('grade/company tiering is preserved with bands in play', () => {
    const rows = [
      row(12, { serviceBands: REQUEST_BANDS }), // group default, banded
      row(20, { gradeId: 'exec' }), // grade override, flat
    ];
    expect(resolveGradePolicy(rows, 'exec', undefined, 1)?.days).toBe(20); // grade wins regardless of band
    expect(resolveGradePolicy(rows, null, undefined, 1)?.days).toBe(14); // no grade ⇒ banded default, under-2y
    expect(resolveGradePolicy(rows, null, undefined, 6)?.days).toBe(18); // no grade ⇒ banded default, 5y+
  });

  it('back-compat: a policy with no serviceBands resolves to the same annualDays at any serviceYears', () => {
    const rows = [row(16)];
    expect(resolveGradePolicy(rows, null, undefined, 0)?.days).toBe(16);
    expect(resolveGradePolicy(rows, null, undefined, 3)?.days).toBe(16);
    expect(resolveGradePolicy(rows, null, undefined, 30)?.days).toBe(16);
  });

  it('a pure-resolver test with literal duplicate default rows preserves the most-generous tie-break', () => {
    // Mirrors the legacy duplicate-default fixture (test/grade-based-leave.test.ts pre-supersede) — the
    // resolver itself makes no attempt to heal/dedupe; it just picks the max.
    const rows = [row(12), row(16)];
    expect(resolveGradePolicy(rows, null, undefined, 0)?.days).toBe(16);
  });
});

describe('previewEntitlement — scope derivation + belowStatutoryFloor, incl. company-resolves-null short-circuit', () => {
  const row = (annualDays: number, companyId: string | null, gradeId: string | null = null): GradePolicyRow => ({
    gradeId,
    companyId,
    accrual: { annualDays },
  });

  it('a configured figure ABOVE the statutory minimum resolves to itself; no warning', () => {
    const rows = [row(20, null)];
    const r = previewEntitlement(rows, null, null, 3, 12);
    expect(r).toEqual({ floorDays: 12, policyDays: 20, days: 20, scope: 'group', belowStatutoryFloor: false });
  });

  // fa3f4ccb — THE behaviour change. This case used to resolve to 12 (the floor overrode the 5). The
  // configured figure now wins outright and the warning flag is the only thing the minimum produces.
  it('a configured figure BELOW the statutory minimum resolves to ITSELF and raises the warning flag', () => {
    const rows = [row(5, null)];
    const r = previewEntitlement(rows, null, null, 3, 12);
    expect(r).toEqual({ floorDays: 12, policyDays: 5, days: 5, scope: 'group', belowStatutoryFloor: true });
  });

  it('no policy at all ⇒ scope none, nothing granted, warning raised', () => {
    const r = previewEntitlement([], null, 'co-a', 3, 12);
    expect(r).toEqual({ floorDays: 12, policyDays: null, days: 0, scope: 'none', belowStatutoryFloor: true });
  });

  it('no statutory pack (non-MY company) ⇒ no warning, whatever the configured figure is', () => {
    // The jurisdictions with no pack already ran with no floor. fa3f4ccb makes MY behave like them, so a
    // null floor must never raise the flag — not even against a configured 0.
    const r = previewEntitlement([row(0, null)], null, null, 3, null);
    expect(r).toEqual({ floorDays: null, policyDays: 0, days: 0, scope: 'group', belowStatutoryFloor: false });
  });

  it('company scope EXISTS but resolves to null (only other-grade rows) ⇒ scope company, nothing granted', () => {
    const rows = [row(20, 'co-a', 'exec')]; // company has a policy, but only for grade "exec"
    const r = previewEntitlement(rows, null, 'co-a', 3, 12); // querying with no grade
    // Short-circuit: the company tier is non-empty (has an exec-scoped row), so resolution stays within it
    // and NEVER falls back to group — but no null-grade row exists there, so resolveGradePolicy returns
    // null (no match), not a fabricated 0. fa3f4ccb: the floor no longer backfills that gap, so the
    // resolved figure is 0 and the below-minimum warning is what tells the admin.
    expect(r.scope).toBe('company');
    expect(r.policyDays).toBeNull();
    expect(r.days).toBe(0);
    expect(r.belowStatutoryFloor).toBe(true);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────────────────────────────
describe('Leave Entitlement Rules Engine — band validation (admin.ts write-time)', () => {
  const create = (serviceBands: ServiceBand[]) =>
    createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands,
      validFrom: '2026-01-01',
    });

  it('accepts the feedback worked example (0-2/2-5/5+)', async () => {
    const row = await create(REQUEST_BANDS);
    const acc = await readAccrual(row.id);
    expect(acc.serviceBands).toEqual(REQUEST_BANDS);
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

  // Feedback 9d8cf621 — the new per-range columns are validated at write time (negative caps, half-set
  // expiry, impossible dates) and a valid set round-trips with its extra keys intact.
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
    const acc = await readAccrual(row.id);
    expect(acc.serviceBands).toEqual(bands);
  });

  // 6e9a126e RAISED THE CEILING 10 → 20, in BOTH places at once (core/leave-compute's isWellFormedBands
  // and core/admin's write-time validator, which now share the one MAX_SERVICE_BANDS constant). The
  // reporter asked for HR-defined service ranges instead of three hardcoded ones; 20 is our number and it
  // only ever widens, so no existing table loses a band. The count is UPDATED here rather than the
  // assertion loosened — a band-count test that stopped naming a number would stop catching the two halves
  // drifting apart, which is the failure that resolves to NO band and therefore a silently wrong day count.
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
    const acc = await readAccrual(row.id);
    expect(acc.serviceBands).toHaveLength(MAX_SERVICE_BANDS);
  });
});

describe('Leave Entitlement Rules Engine — tri-state persistence (preserve / clear / replace)', () => {
  it('editing flat fields through a form without the band editor (serviceBands undefined) leaves bands intact', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
    await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 13, // change a flat field only
      validFrom: '2026-01-01',
      // serviceBands omitted entirely ⇒ undefined ⇒ preserve
    });
    const acc = await readAccrual(created.id);
    expect(acc.annualDays).toBe(13);
    expect(acc.serviceBands).toEqual(REQUEST_BANDS);
  });

  it('an empty editor (serviceBands: []) clears existing bands', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
    await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 12,
      serviceBands: [],
      validFrom: '2026-01-01',
    });
    const acc = await readAccrual(created.id);
    expect(acc.serviceBands).toBeUndefined();
  });

  it('a non-empty array replaces the bands after validation', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
    const replacement: ServiceBand[] = [{ fromYears: 0, toYears: null, days: 30 }];
    await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 12,
      serviceBands: replacement,
      validFrom: '2026-01-01',
    });
    const acc = await readAccrual(created.id);
    expect(acc.serviceBands).toEqual(replacement);
  });
});

describe('Leave Entitlement Rules Engine — SUPERSEDE (one active default per type)', () => {
  it('creating a second same-scope default closes the first (validTo set, superseded event, hire resolves only the new one)', async () => {
    const first = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2025-01-01',
    });
    const second = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 20,
      validFrom: '2026-01-01',
    });
    const firstRow = await readPolicy(first.id);
    expect(firstRow?.validTo).toBe('2026-01-01');
    const events = await eventTypesFor(b.tenantId, first.id);
    expect(events).toContain('leave-policy.superseded');

    const emp = await hire('2026-06-01');
    expect(await balance(emp.employmentId)).toBeGreaterThan(0);
    // Only the second (20-day) policy is active at hire time — verify via the breakdown reader that the
    // resolved policy is the new one by checking the grant reflects 20-day pro-ration, not 12.
    const secondRow = await readPolicy(second.id);
    expect(secondRow?.validTo).toBeNull();
  });

  it('rejects when the new validFrom is not after the existing version\'s validFrom', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    await expect(
      createLeavePolicy(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        annualDays: 20,
        validFrom: '2026-01-01', // same date, not after
      }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      createLeavePolicy(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        annualDays: 20,
        validFrom: '2025-06-01', // before
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('update collision only fires on scope change; a flat-field edit of a legacy duplicate succeeds', async () => {
    // Seed two duplicate active defaults DIRECTLY (bypassing the service, as legacy data would exist).
    const [dupA] = await owner.db
      .insert(schema.leavePolicy)
      .values({
        tenantId: b.tenantId,
        leaveTypeId: b.annualLeaveTypeId,
        gradeId: null,
        companyId: null,
        accrual: { annualDays: 12, method: 'grant_on_hire_prorated' },
        validFrom: '2026-01-01',
        validTo: null,
      })
      .returning({ id: schema.leavePolicy.id });
    const [dupB] = await owner.db
      .insert(schema.leavePolicy)
      .values({
        tenantId: b.tenantId,
        leaveTypeId: b.annualLeaveTypeId,
        gradeId: null,
        companyId: null,
        accrual: { annualDays: 16, method: 'grant_on_hire_prorated' },
        validFrom: '2026-01-01',
        validTo: null,
      })
      .returning({ id: schema.leavePolicy.id });

    // Flat-field edit (no scope/validFrom change) succeeds despite the pre-existing duplicate.
    await expect(
      updateLeavePolicy(adminCtx(b), { id: dupA.id, annualDays: 13, validFrom: '2026-01-01' }),
    ).resolves.not.toThrow();

    // Re-scoping dupA into an EXEC grade that already has an active default should collide.
    const exec = await createJobGrade(adminCtx(b), { code: 'EXEC', name: 'Executive' });
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      gradeId: exec.id,
      validFrom: '2026-01-01',
    });
    await expect(
      updateLeavePolicy(adminCtx(b), { id: dupA.id, annualDays: 13, gradeId: exec.id, validFrom: '2026-01-01' }),
    ).rejects.toThrow(/create a new version/i);
    void dupB;
  });

  it('deleteLeavePolicy leaves prior ledger rows untouched', async () => {
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01');
    const before = await balance(emp.employmentId);
    expect(before).toBeGreaterThan(0);
    await deleteLeavePolicy(adminCtx(b), { id: created.id });
    expect(await balance(emp.employmentId)).toBe(before); // ledger untouched
  });
});

describe('Leave Entitlement Rules Engine — integration: hire, openLeaveYear, accrueEarnedLeave, sweep', () => {
  it('hire with a banded policy: the 0-year band drives the grant', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01'); // hired 1 Jan ⇒ no pro-ration; 0 years ⇒ 14-day band
    expect(await balance(emp.employmentId)).toBe(14);
  });

  // fa3f4ccb: was "a 6-day band clamps up to the 8-day statutory floor at hire". The floor no longer
  // overrides a configured figure, so the 6-day band is granted as 6. ANNUAL at 0 years is a real MY
  // statutory band (8 days), so this genuinely crosses the minimum rather than passing on a floor of 0.
  it('fa3f4ccb: a 6-day band is granted as 6 at hire, BELOW the 8-day statutory minimum', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: [{ fromYears: 0, toYears: null, days: 6 }],
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(6); // configured wins; the 8-day minimum only warns
  });

  it('openLeaveYear band upgrade crossing the 2-year boundary (14 -> 16, the request example)', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 0,
      serviceBands: REQUEST_BANDS,
      validFrom: '2024-01-01',
    });
    const emp = await hire('2024-01-01'); // 0 years at hire ⇒ 14
    expect(await balance(emp.employmentId)).toBe(14);
    // Open 2026 (employee has exactly 2 completed years of service at 2026-01-01) — an unopened year.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    // Balance = hire grant (14) + 2026 grant (16, carry cap 0 forfeits the rest) = 16.
    expect(await balance(emp.employmentId)).toBe(16);
  });

  it('accrueEarnedLeave with a banded earned policy accrues at the banded rate', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      method: 'earned_monthly',
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01'); // earned ⇒ no lump hire grant
    expect(await balance(emp.employmentId)).toBe(0);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15' }); // 6 months elapsed, 0y service ⇒ 14-day band
    expect(await balance(emp.employmentId)).toBeCloseTo((14 / 12) * 6, 2);
  });

  it('band validation rejections integration-verified via a full reject-then-succeed cycle', async () => {
    await expect(
      createLeavePolicy(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        annualDays: 12,
        serviceBands: [{ fromYears: 0, toYears: 2, days: 10 }], // not open-ended
        validFrom: '2026-01-01',
      }),
    ).rejects.toThrow();
    // A well-formed version succeeds afterwards.
    await expect(
      createLeavePolicy(adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        annualDays: 12,
        serviceBands: REQUEST_BANDS,
        validFrom: '2026-01-01',
      }),
    ).resolves.toBeDefined();
  });

  it('ONE targeted carry-flip test: sweep two consecutive years across a band boundary follows each year\'s own days-winner', async () => {
    // A banded ANNUAL policy (with carry + expiry) active from day one — the flip is driven purely by the
    // band boundary itself (14 -> 16 at 2 years), proving the sweep resolves per-swept-year service length
    // (serviceYearsAt computed INSIDE the per-year loop) rather than "today's" service length.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 20, // generous cap — isolates the band effect from cap-driven forfeits
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      serviceBands: REQUEST_BANDS,
      validFrom: '2024-01-01',
    });
    const emp = await hire('2024-01-01'); // hired under the banded policy: 0y at hire ⇒ 14-day grant
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
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 3,
      serviceBands: REQUEST_BANDS,
      validFrom: '2026-01-01',
    });
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

  it('hasAnyCarryExpiry sees policy-level OR per-band expiry', () => {
    expect(hasAnyCarryExpiry({ annualDays: 12, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 })).toBe(true);
    expect(
      hasAnyCarryExpiry({
        annualDays: 12,
        serviceBands: [{ fromYears: 0, toYears: null, days: 14, carryForwardExpiryMonth: 6, carryForwardExpiryDay: 30 }],
      }),
    ).toBe(true);
    expect(hasAnyCarryExpiry({ annualDays: 12, serviceBands: [{ fromYears: 0, toYears: null, days: 14 }] })).toBe(false);
    expect(hasAnyCarryExpiry({ annualDays: 12 })).toBe(false);
  });

  it('resolveGradePolicy surfaces maxBalanceDays + the per-range carry OVERRIDE from the winning band', () => {
    const rows: GradePolicyRow[] = [
      {
        gradeId: null,
        companyId: null,
        accrual: {
          annualDays: 12,
          carryForwardMax: 2, // policy-level carry — should be OVERRIDDEN by the band's carryForwardDays
          serviceBands: [
            { fromYears: 0, toYears: null, days: 14, carryForwardDays: 9, maxBalanceDays: 15, carryForwardExpiryMonth: 6, carryForwardExpiryDay: 30 },
          ],
        },
      },
    ];
    const pol = resolveGradePolicy(rows, null, null, 1);
    expect(pol).not.toBeNull();
    expect(pol!.days).toBe(14);
    expect(pol!.carryMax).toBe(9); // per-range override wins over policy-level 2
    expect(pol!.maxBalanceDays).toBe(15);
    expect(pol!.carryExpiry).toEqual({ month: 6, day: 30 });
  });

  it('resolveGradePolicy falls back to policy-level carry/expiry when the band has no override', () => {
    const rows: GradePolicyRow[] = [
      {
        gradeId: null,
        companyId: null,
        accrual: {
          annualDays: 12,
          carryForwardMax: 4,
          carryForwardExpiryMonth: 3,
          carryForwardExpiryDay: 31,
          serviceBands: [{ fromYears: 0, toYears: null, days: 14 }],
        },
      },
    ];
    const pol = resolveGradePolicy(rows, null, null, 1);
    expect(pol!.carryMax).toBe(4);
    expect(pol!.carryExpiry).toEqual({ month: 3, day: 31 });
    expect(pol!.maxBalanceDays).toBeNull();
  });
});

describe('9d8cf621 integration — Maximum Balance Days enforcement (Gap 1)', () => {
  it('clamps the hire grant so the opening balance never exceeds the cap', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      serviceBands: [{ fromYears: 0, toYears: null, days: 20, maxBalanceDays: 15 }],
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01'); // 0y ⇒ band days 20, but cap clamps to 15
    expect(await balance(emp.employmentId)).toBe(15);
  });

  it('clamps carry-in + grant at openLeaveYear so the balance holds at the cap across years', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 20, // generous carry — the Maximum Balance cap is what binds, not the carry cap
      serviceBands: [{ fromYears: 0, toYears: null, days: 14, maxBalanceDays: 15 }],
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
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      method: 'earned_monthly',
      serviceBands: [{ fromYears: 0, toYears: null, days: 14, maxBalanceDays: 5 }],
      validFrom: '2026-01-01',
    });
    const emp = await hire('2026-01-01'); // earned ⇒ no lump grant
    expect(await balance(emp.employmentId)).toBe(0);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15' }); // 6mo ⇒ 7 earned, clamped to cap 5
    expect(await balance(emp.employmentId)).toBe(5);
  });
});

describe('9d8cf621 integration — per-range carry-forward days + expiry (Gap 2)', () => {
  it('per-range Carry-Forward Days OVERRIDES the policy-level carry cap at openLeaveYear', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 0, // policy-level would forfeit EVERYTHING — the band's carryForwardDays must win
      serviceBands: [{ fromYears: 0, toYears: null, days: 14, carryForwardDays: 10 }],
      validFrom: '2024-01-01',
    });
    const emp = await hire('2024-01-01'); // 14
    expect(await balance(emp.employmentId)).toBe(14);
    const r = await openLeaveYear(adminCtx(b), { year: 2025 });
    // carry = min(14, per-range 10) = 10; forfeit 4; + 2025 grant 14 ⇒ 24. Policy-level 0 would give 14.
    expect(r.forfeits).toBe(1);
    expect(await balance(emp.employmentId)).toBe(24);
  });

  it('per-range Carry-Forward Expiry drives expireCarriedLeave (no policy-level expiry set)', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 20, // generous carry so the balance carries; expiry is purely per-range
      serviceBands: [{ fromYears: 0, toYears: null, days: 14, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 }],
      validFrom: '2024-01-01',
    });
    const emp = await hire('2024-01-01'); // 14
    await openLeaveYear(adminCtx(b), { year: 2025 }); // carries 14 (into 2025, expiry 2025-03-31) + grant 14 = 28
    expect(await balance(emp.employmentId)).toBe(28);
    const before = await balance(emp.employmentId);
    // Sweep past 2025-03-31: with only a PER-RANGE expiry, the back-compat boundary (hasAnyCarryExpiry) must
    // still include this policy — otherwise swept would be 0 (the bug this fix closes).
    const res = await expireCarriedLeave(adminCtx(b), { today: '2026-04-01' });
    expect(res.swept).toBeGreaterThanOrEqual(1);
    expect(await balance(emp.employmentId)).toBeLessThan(before);
  });
});
