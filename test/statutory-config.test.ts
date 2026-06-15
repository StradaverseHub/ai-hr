/**
 * Editable statutory configuration (ADR-0019) — the equivalence guarantee.
 *
 * The headline safety property: a stored ruleset EQUAL to the verified default must produce
 * byte-identical payroll. The subtle risk is the JSONB round-trip — the PCB top band's
 * `upTo: Infinity` serialises to `null` in jsonb, and any numeric drift would shift a payslip.
 * These tests sweep the calculators across wages/profiles/extras and assert the round-tripped
 * (and the real-postgres-stored) default is calculation-identical to the in-memory constant.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { statutory } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';
import {
  getActiveStatutoryMY,
  listStatutoryRulesetsMY,
  saveStatutoryRulesetMY,
  StatutoryRulesetInvalidError,
  validateStatutoryRuleset,
} from '../localization/my/statutory-config';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// A representative spread: low/mid/high/very-high wages (200k exercises the PCB top band where the
// Infinity→null transformation matters), every PCB category, and bonus/OT/category-2/non-resident.
const WAGES = [800, 1500, 3000, 4000, 5000, 8000, 12000, 50000, 200000];
const PROFILES = [
  { category: 1 as const, children: 0 },
  { category: 2 as const, children: 3 },
  { category: 3 as const, children: 2 },
];
const EXTRAS = [
  { additional: 0, overtime: 0 },
  { additional: 3000, overtime: 600 },
  { additional: 0, overtime: 1200 },
];
const OPTS = [{}, { socsoCategory: 2 as const, eisEligible: false }, { resident: false }];

function sweep(rules: StatutoryRuleset) {
  const out: unknown[] = [];
  for (const w of WAGES)
    for (const p of PROFILES)
      for (const x of EXTRAS)
        for (const o of OPTS) out.push(statutory(w, p, x.additional, x.overtime, { month: 6 }, o, rules));
  return out;
}

describe('ADR-0019 — calculator round-trip equivalence (pure)', () => {
  it('the default really does carry Infinity in the PCB top band', () => {
    expect(DEFAULT_MY_STATUTORY.pcb.bands.at(-1)!.upTo).toBe(Infinity);
  });

  it('JSON serialisation collapses the open-ended top band to null', () => {
    const rt = clone(DEFAULT_MY_STATUTORY);
    expect(rt.pcb.bands.at(-1)!.upTo).toBeNull();
  });

  it('a round-tripped default yields identical payroll across the whole sweep', () => {
    const rt = clone(DEFAULT_MY_STATUTORY);
    expect(sweep(rt)).toEqual(sweep(DEFAULT_MY_STATUTORY));
  });
});

describe('ADR-0019 — validation', () => {
  it('accepts the verified default', () => {
    expect(validateStatutoryRuleset(DEFAULT_MY_STATUTORY)).toEqual([]);
  });

  it('rejects an out-of-range EPF rate', () => {
    const bad = clone(DEFAULT_MY_STATUTORY);
    bad.epf.employeeRate = 1.5;
    expect(validateStatutoryRuleset(bad).length).toBeGreaterThan(0);
  });

  it('rejects a negative threshold and negative relief', () => {
    const bad = clone(DEFAULT_MY_STATUTORY);
    bad.epf.employerThreshold = -1;
    bad.pcb.reliefs.individual = -100;
    expect(validateStatutoryRuleset(bad).length).toBeGreaterThanOrEqual(2);
  });

  it('rejects non-monotonic PCB bands', () => {
    const bad = clone(DEFAULT_MY_STATUTORY);
    bad.pcb.bands = [
      { upTo: 20000, M: 0, R: 0, bCat13: 0, bCat2: 0 },
      { upTo: 5000, M: 0, R: 0.01, bCat13: 0, bCat2: 0 }, // out of order
    ];
    expect(validateStatutoryRuleset(bad).some((e) => /ascend/.test(e))).toBe(true);
  });
});

describe('ADR-0019 — DB-backed loader (real postgres jsonb)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('an empty table resolves to the verified default by reference', async () => {
    const loaded = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-30' }));
    expect(loaded).toBe(DEFAULT_MY_STATUTORY);
  });

  it('a stored default (through real jsonb) is calculation-identical to the constant', async () => {
    await saveStatutoryRulesetMY(adminCtx(base), {
      version: DEFAULT_MY_STATUTORY.version,
      effectiveFrom: '2026-01-01',
      data: clone(DEFAULT_MY_STATUTORY),
    });
    const loaded = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-06-30' }));
    // The round-trip really happened (top band lost Infinity)…
    expect(loaded.pcb.bands.at(-1)!.upTo).toBeNull();
    // …yet payroll is byte-identical to the in-memory default.
    expect(sweep(loaded)).toEqual(sweep(DEFAULT_MY_STATUTORY));
  });

  it('save appends a statutory.config.updated event and lists the version', async () => {
    const { id } = await saveStatutoryRulesetMY(adminCtx(base), {
      version: '2026.2-test',
      effectiveFrom: '2026-07-01',
      data: clone(DEFAULT_MY_STATUTORY),
      notes: 'unit test',
    });
    expect(await eventTypesFor(base.tenantId, id)).toContain('statutory.config.updated');
    const list = await listStatutoryRulesetsMY(adminCtx(base));
    expect(list.map((r) => r.version)).toContain('2026.2-test');
  });

  it('resolves the latest effective row ≤ asOf, else the default', async () => {
    const v1 = clone(DEFAULT_MY_STATUTORY);
    v1.ot.wageCeiling = 4000;
    const v2 = clone(DEFAULT_MY_STATUTORY);
    v2.ot.wageCeiling = 4500;
    await saveStatutoryRulesetMY(adminCtx(base), { version: 't1', effectiveFrom: '2026-01-01', data: v1 });
    await saveStatutoryRulesetMY(adminCtx(base), { version: 't2', effectiveFrom: '2026-06-01', data: v2 });

    const before = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2025-12-01' }));
    expect(before).toBe(DEFAULT_MY_STATUTORY); // nothing effective yet
    const mid = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-03-01' }));
    expect(mid.ot.wageCeiling).toBe(4000);
    const late = await withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf: '2026-07-01' }));
    expect(late.ot.wageCeiling).toBe(4500);
  });

  it('rejects an invalid ruleset before it can be stored', async () => {
    const bad = clone(DEFAULT_MY_STATUTORY);
    bad.epf.employeeRate = 2;
    await expect(
      saveStatutoryRulesetMY(adminCtx(base), { version: 'x', effectiveFrom: '2026-01-01', data: bad }),
    ).rejects.toBeInstanceOf(StatutoryRulesetInvalidError);
  });

  it('blocks a non-admin from writing (RLS)', async () => {
    const employeeCtx = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] };
    await expect(
      saveStatutoryRulesetMY(employeeCtx, {
        version: 'sneaky',
        effectiveFrom: '2026-01-01',
        data: clone(DEFAULT_MY_STATUTORY),
      }),
    ).rejects.toThrow();
  });
});
