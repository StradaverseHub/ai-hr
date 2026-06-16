/**
 * 3-tier merged loader (ADR-0020 §6, Slice 5) — precedence + equivalence. Proves: empty ⇒ code default;
 * a pack equal to DEFAULT (through REAL Postgres jsonb) ⇒ byte-identical payroll; the deterministic total
 * order (effective_from, then issuance, then source rank, then packVersion); and revoked-key exclusion.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../db/client';
import { statutoryPack, statutoryRuleset, statutorySigningKey } from '../db/schema';
import { getActiveStatutoryMY, getActiveStatutoryResolvedMY } from '../localization/my/statutory-config';
import { statutory } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from '../localization/my/statutory-tables';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const clone = (x: StatutoryRuleset): StatutoryRuleset => JSON.parse(JSON.stringify(x));
const withCeiling = (n: number): StatutoryRuleset => {
  const c = clone(DEFAULT_MY_STATUTORY);
  c.ot.wageCeiling = n;
  return c;
};

// Compact payroll sweep for byte-identity. 500k drives projected annual P into the PCB TOP band (upTo
// Infinity → null after jsonb), which is the band the round-trip equivalence must actually exercise.
const WAGES = [1500, 4000, 8000, 200000, 500000];
const sweep = (rules: StatutoryRuleset) =>
  WAGES.map((w) => statutory(w, { category: 1, children: 0 }, 3000, 600, { month: 6 }, {}, rules));

describe('ADR-0020 §6 — 3-tier merged loader', () => {
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

  const insertKey = (keyId = 'k1', status = 'active') =>
    owner.db.insert(statutorySigningKey).values({
      keyId,
      publicKey: 'x',
      status,
      certifiedAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      trustSequence: 1,
    });
  const insertPack = (
    effectiveFrom: string,
    data: StatutoryRuleset,
    opts: { packVersion?: string; keyId?: string; issuedAt: Date },
  ) =>
    owner.db.insert(statutoryPack).values({
      country: 'MY',
      schemaVersion: 1,
      packVersion: opts.packVersion ?? '2026.01.01',
      rulesetVersion: 'pk',
      effectiveFrom,
      data,
      checksum: 'c',
      signedKeyId: opts.keyId ?? 'k1',
      issuedAt: opts.issuedAt,
      validUntil: new Date('2099-01-01T00:00:00Z'),
    });
  const insertOverride = (effectiveFrom: string, data: StatutoryRuleset, createdAt: Date) =>
    owner.db.insert(statutoryRuleset).values({ tenantId: base.tenantId, country: 'MY', version: 'ov', effectiveFrom, data, createdAt });
  const resolve = (asOf: string) => withTenant(adminCtx(base), (tx) => getActiveStatutoryMY(tx, { asOf }));

  it('empty pack + empty override resolves to the code default (by reference)', async () => {
    expect(await resolve('2026-06-30')).toBe(DEFAULT_MY_STATUTORY);
  });

  it('a stored PACK equal to DEFAULT (real jsonb) yields byte-identical payroll', async () => {
    await insertKey();
    await insertPack('2026-01-01', clone(DEFAULT_MY_STATUTORY), { issuedAt: new Date('2026-01-01T00:00:00Z') });
    const loaded = await resolve('2026-06-30');
    expect(loaded.pcb.bands.at(-1)!.upTo).toBeNull(); // round-trip really happened
    expect(sweep(loaded)).toEqual(sweep(DEFAULT_MY_STATUTORY));
  });

  it('a newer-effective pack supersedes an older-effective override', async () => {
    await insertKey();
    await insertOverride('2026-01-01', withCeiling(4001), new Date('2026-01-01T00:00:00Z'));
    await insertPack('2026-06-01', withCeiling(4002), { issuedAt: new Date('2026-05-01T00:00:00Z') });
    expect((await resolve('2026-06-30')).ot.wageCeiling).toBe(4002); // pack (later effective)
    expect((await resolve('2026-03-31')).ot.wageCeiling).toBe(4001); // before pack effective → override
  });

  it('at the SAME effective date, a later-ISSUED pack beats an older override (no silent shadow)', async () => {
    await insertKey();
    await insertOverride('2026-10-01', withCeiling(4001), new Date('2026-09-01T00:00:00Z'));
    await insertPack('2026-10-01', withCeiling(4002), { issuedAt: new Date('2026-09-15T00:00:00Z') });
    expect((await resolve('2026-10-31')).ot.wageCeiling).toBe(4002); // pack issued later wins
  });

  it('at the SAME effective date, a re-issued (later) override beats the pack', async () => {
    await insertKey();
    await insertPack('2026-10-01', withCeiling(4002), { issuedAt: new Date('2026-09-15T00:00:00Z') });
    await insertOverride('2026-10-01', withCeiling(4001), new Date('2026-09-20T00:00:00Z'));
    expect((await resolve('2026-10-31')).ot.wageCeiling).toBe(4001); // override re-issued later wins
  });

  it('two packs at the same effective date resolve to the greater packVersion', async () => {
    await insertKey();
    await insertPack('2026-10-01', withCeiling(4001), { packVersion: '2026.10.01', issuedAt: new Date('2026-09-15T00:00:00Z') });
    await insertPack('2026-10-01', withCeiling(4002), { packVersion: '2026.10.02', issuedAt: new Date('2026-09-15T00:00:00Z') });
    expect((await resolve('2026-10-31')).ot.wageCeiling).toBe(4002); // correction (higher packVersion)
  });

  it('exposes pack provenance (source/packVersion/signedKeyId) for payslip stamping (ADR-0020 §7)', async () => {
    await insertKey('k1');
    await insertPack('2026-01-01', clone(DEFAULT_MY_STATUTORY), { packVersion: '2026.01.01', keyId: 'k1', issuedAt: new Date('2026-01-01T00:00:00Z') });
    const r = await withTenant(adminCtx(base), (tx) => getActiveStatutoryResolvedMY(tx, { asOf: '2026-06-30' }));
    expect(r.source).toBe('pack');
    expect(r.packVersion).toBe('2026.01.01');
    expect(r.signedKeyId).toBe('k1');
  });

  it('a pack signed by a REVOKED key is excluded from resolution', async () => {
    await insertKey('k1', 'revoked');
    await insertPack('2026-01-01', withCeiling(9999), { keyId: 'k1', issuedAt: new Date('2026-01-01T00:00:00Z') });
    expect(await resolve('2026-06-30')).toBe(DEFAULT_MY_STATUTORY); // revoked pack ignored → default
  });
});
