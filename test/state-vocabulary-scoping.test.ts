/**
 * ADR-0077 slice 6 / ADR-0080 D6 — state vocabulary is narrowed to the jurisdiction that owns the row.
 *
 * Two validators judged a state against `countryPacks().flatMap((p) => p.states)` — the union across
 * every REGISTERED pack — and both carried a comment ending "per-company narrowing is a later slice".
 *
 * WITH ONE PACK REGISTERED THE UNION AND THE NARROWING ARE BYTE-IDENTICAL, so a test that only exercises
 * Malaysia cannot tell the fix from the bug. These tests REGISTER A SECOND COUNTRY PACK, which is the
 * only way to make the difference observable before a real second pack ships.
 *
 * The live row that shaped the design: production holds a location named Sepang with `country = 'SG'`,
 * a MY company, and state 'Selangor'. Sepang is in Selangor, Malaysia — a data-entry slip, not a
 * Singapore site. Narrowing by the LOCATION's country would start rejecting it on the next edit;
 * narrowing by the COMPANY's country (which is what the holiday engine resolves against) keeps it valid
 * while still refusing a genuinely foreign state. That case is pinned below by name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, adminCtx, type Base } from './harness';
import { allRegisteredStates, statesForCountries, validateStateFor } from '../core/state-vocabulary';
import { registerPack, packById } from '../packs/registry';
import { packFor } from '../localization/registry';
import { createLocation, updateLocation } from '../core/location';
import { createHolidayGroup } from '../core/admin';

/**
 * IS REGISTERING A PACK HERE SAFE? YES, AND IT IS PROVEN RATHER THAN ASSUMED. `registerPack` mutates a
 * module-level Map, which is the r106 catalog-leak trap in a new coat — there register-time state
 * outlived the tenant wipe. The decisive evidence is that test/pack-registry.test.ts:28 asserts
 * `listPacks('country')` EXACTLY equals ['country-my']; running it in the same invocation as this file
 * passes, so vitest's per-file module isolation really does contain this. If that ever changes, that
 * assertion fails loudly rather than this one silently widening some other file's vocabulary.
 *
 * A second country pack, registered for the life of this file. It borrows the MY pack's shape and
 * replaces only the state vocabulary, so nothing else in the system changes behaviour — the narrowing
 * is the single variable.
 */
const XX_STATES = ['Northshire', 'Westfall'] as const;

beforeAll(() => {
  const my = packFor('MY');
  if (!my) throw new Error('the MY pack must be registered for this test to mean anything');
  registerPack({
    id: 'country-xx',
    kind: 'country',
    country: 'XX',
    pack: { ...my, country: 'XX', states: [...XX_STATES] },
  });
});

describe('the second pack really is registered — otherwise every test below is vacuous', () => {
  it('country-xx resolves and carries its own states', () => {
    expect(packById('country-xx')).toBeTruthy();
    expect(packFor('XX')?.states).toEqual([...XX_STATES]);
  });

  it('the union now spans BOTH packs, which is the behaviour being retired', () => {
    const union = allRegisteredStates();
    expect(union.has('Selangor')).toBe(true);
    expect(union.has('Northshire')).toBe(true);
    // This is precisely the bug: the old validators accepted anything in this set, for any company.
  });
});

describe('statesForCountries narrows to the countries asked for', () => {
  it('MY yields Malaysian states and NOT the other pack’s', () => {
    const my = statesForCountries(['MY']);
    expect(my.has('Selangor')).toBe(true);
    expect(my.has('Northshire')).toBe(false);
  });

  it('XX yields the other pack’s states and NOT Malaysia’s', () => {
    const xx = statesForCountries(['XX']);
    expect(xx.has('Northshire')).toBe(true);
    expect(xx.has('Selangor')).toBe(false);
  });

  it('a multi-country tenant gets the union of ITS countries only', () => {
    const both = statesForCountries(['MY', 'XX']);
    expect(both.has('Selangor')).toBe(true);
    expect(both.has('Northshire')).toBe(true);
    expect(both.size).toBe(statesForCountries(['MY']).size + XX_STATES.length);
  });

  it('a country with NO registered pack contributes nothing — it does not fall back to the union', () => {
    // Falling back is exactly what the union did, and is the behaviour being retired. Asserted against
    // a country that genuinely has no pack, so this cannot pass by the set happening to be empty.
    expect(packFor('ZZ')).toBeUndefined();
    expect(statesForCountries(['ZZ']).size).toBe(0);
    expect(statesForCountries([null, undefined, '']).size).toBe(0);
  });
});

describe('validateStateFor', () => {
  it('accepts a state belonging to the country and returns it trimmed', () => {
    expect(validateStateFor('  Selangor  ', ['MY'])).toBe('Selangor');
  });

  it('treats blank as "no state", not as an invalid state', () => {
    expect(validateStateFor(null, ['MY'])).toBeNull();
    expect(validateStateFor('   ', ['MY'])).toBeNull();
  });

  it('refuses a state from ANOTHER registered country, and names the country it judged against', () => {
    // The message matters: "Unknown state: Selangor" is baffling when Selangor plainly exists. The
    // useful information is which jurisdiction rejected it.
    expect(() => validateStateFor('Northshire', ['MY'])).toThrow(/Northshire/);
    expect(() => validateStateFor('Northshire', ['MY'])).toThrow(/MY/);
  });
});

describe('the old union is gone from both validators', () => {
  it.each([
    ['core/location.ts', 'cleanState'],
    ['core/admin.ts', 'cleanHolidayGroupStates'],
  ])('%s no longer validates against countryPacks().flatMap(states)', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/countryPacks\(\)\.some\(\(p\) => p\.states\.includes/);
    expect(src).not.toMatch(/new Set<string>\(countryPacks\(\)\.flatMap\(\(p\) => p\.states\)\)/);
  });

  it('and neither still claims narrowing is a later slice', () => {
    for (const path of ['core/location.ts', 'core/admin.ts']) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/per-company narrowing is a later slice/);
    }
  });
});

describe('against the real database', () => {
  let b: Base;

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

  const ctx = () => adminCtx(b);

  it('a location on a MY company accepts a Malaysian state', async () => {
    const { id } = await createLocation(ctx(), { companyId: b.companyId, code: 'HQ', name: 'HQ', state: 'Selangor' });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.state).toBe('Selangor');
  });

  it('a location on a MY company REFUSES another country’s state', async () => {
    await expect(
      createLocation(ctx(), { companyId: b.companyId, code: 'X', name: 'X', state: 'Northshire' }),
    ).rejects.toThrow(/Northshire/);
  });

  /**
   * The production row this design protects. Sepang: company MY, location country 'SG', state
   * 'Selangor'. The state is judged against the COMPANY's country, so the row remains valid and
   * editable — narrowing by the location's own country would have rejected it.
   */
  it('keeps the live Sepang row valid: MY company, location country SG, Selangor state', async () => {
    const { id } = await createLocation(ctx(), {
      companyId: b.companyId,
      code: 'SUB5',
      name: 'Sepang',
      country: 'SG',
      state: 'Selangor',
    });
    const [row] = await owner.db.select().from(schema.location).where(eq(schema.location.id, id));
    expect(row.country).toBe('SG');
    expect(row.state).toBe('Selangor');

    // And it survives an EDIT, which is where a location-country narrowing would have bitten.
    await expect(
      updateLocation(ctx(), { locationId: id, code: 'SUB5', name: 'Sepang', country: 'SG', state: 'Selangor' }),
    ).resolves.toBeTruthy();
  });

  it('the location update path narrows too, not just create', async () => {
    const { id } = await createLocation(ctx(), { companyId: b.companyId, code: 'HQ', name: 'HQ', state: 'Selangor' });
    await expect(
      updateLocation(ctx(), { locationId: id, code: 'HQ', name: 'HQ', state: 'Northshire' }),
    ).rejects.toThrow(/Northshire/);
  });

  it('a tenant-level holiday calendar is judged against the countries its COMPANIES operate in', async () => {
    // The seeded tenant has one MY company, so Malaysian states are in and the other pack's are out.
    await expect(
      createHolidayGroup(ctx(), { name: 'Selangor calendar', archetype: 'standard', states: ['Selangor'] }),
    ).resolves.toBeTruthy();

    await expect(
      createHolidayGroup(ctx(), { name: 'Foreign calendar', archetype: 'standard', states: ['Northshire'] }),
    ).rejects.toThrow(/Northshire/);
  });
});
