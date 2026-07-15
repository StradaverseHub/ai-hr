/**
 * 59047802 — Standardise the Nationality dropdown to the full ISO 3166-1 nationality/demonym set.
 *
 * Covers: the expanded catalog is seeded (count + spot values); it lists alphabetically with 'Other' last;
 * a full-set demonym (e.g. 'French') that used to be off-catalog now validates on save; legacy-value
 * tolerance still preserves an out-of-catalog stored nationality; and the 0209 top-up migration idempotently
 * fills in missing standard values for an existing tenant WITHOUT deleting admin-added rows or disturbing the
 * legacy defaults.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, updatePerson } from '../core/org';
import { listProfileOptions, seedProfileOptions, DEFAULT_PROFILE_OPTIONS } from '../core/profile-options';

const STANDARD_NATIONALITY_COUNT = DEFAULT_PROFILE_OPTIONS.filter((d) => d.category === 'nationality').length;

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

describe('59047802 — full ISO 3166-1 nationality catalog', () => {
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

  it('seeds the full alphabetical set with Other last', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const rows = await listProfileOptions(a, 'nationality');
    const values = rows.map((r) => r.value);

    // Comprehensive: ~197 entries (196 demonyms + Other), well beyond the original 8.
    expect(values.length).toBeGreaterThan(190);
    // Spot values across the alphabet + the retained legacy defaults.
    for (const v of ['Afghan', 'French', 'Japanese', 'Malaysian', 'Singaporean', 'Zimbabwean', 'Other']) {
      expect(values).toContain(v);
    }
    // No duplicates.
    expect(new Set(values).size).toBe(values.length);

    // 'Other' is last; everything before it is in strict alphabetical (localeCompare) order.
    expect(values[values.length - 1]).toBe('Other');
    const body = values.slice(0, -1);
    const sorted = [...body].sort((x, y) => x.localeCompare(y, 'en'));
    expect(body).toEqual(sorted);
  });

  it('a full-set demonym that used to be off-catalog now validates on save', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Frenchie');

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Frenchie',
      primaryEmail: 'frenchie@acme.test',
      nationality: 'French',
    });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.nationality).toBe('French');

    // A value NOT in the standard set is still rejected (validation intact).
    await expect(
      updatePerson(a, {
        personId: E.personId,
        fullName: 'Frenchie',
        primaryEmail: 'frenchie@acme.test',
        nationality: 'Martian',
      }),
    ).rejects.toThrow();
  });

  it('legacy tolerance: an out-of-catalog stored nationality survives an unchanged save', async () => {
    const a = adminCtx(base);
    await seedProfileOptions(a);
    const E = await hire(a, base, 'Legacy Nat');
    // Pre-existing free-text value not in the (now huge) catalog.
    await owner.db.update(schema.person).set({ nationality: 'Freedonian' }).where(eq(schema.person.id, E.personId));

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Legacy Nat (edited)',
      primaryEmail: 'legacynat@acme.test',
      nationality: 'Freedonian', // unchanged legacy value
    });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.nationality).toBe('Freedonian');
  });

  it('0210 top-up: idempotently fills missing standard values, preserving admin rows + legacy defaults', async () => {
    // Simulate a tenant that ran the ORIGINAL 0180 (only the 8 legacy nationalities) plus one admin custom.
    const oldEight = ['Malaysian', 'Singaporean', 'Indonesian', 'Indian', 'Bangladeshi', 'Nepalese', 'Filipino', 'Other'];
    await owner.db.insert(schema.profileOption).values([
      ...oldEight.map((v, i) => ({ tenantId: base.tenantId, category: 'nationality', value: v, label: v, sortOrder: i })),
      { tenantId: base.tenantId, category: 'nationality', value: 'Martian', label: 'Martian (custom)', sortOrder: 99 },
    ]);

    const migration = readFileSync('db/migrations/0210_nationality_full_iso_seed.sql', 'utf8');
    await owner.db.execute(sql.raw(migration));
    await owner.db.execute(sql.raw(migration)); // idempotent re-run

    const rows = await owner.db
      .select()
      .from(schema.profileOption)
      .where(eq(schema.profileOption.tenantId, base.tenantId));
    const nats = rows.filter((r) => r.category === 'nationality');
    const values = nats.map((r) => r.value);

    // Full standard set present + the admin custom row preserved, no duplicates.
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('French');
    expect(values).toContain('Martian');
    // Admin's custom label untouched.
    expect(nats.find((r) => r.value === 'Martian')!.label).toBe('Martian (custom)');
    // A legacy default row keeps its ORIGINAL sort_order / label (DO NOTHING never touched it).
    const my = nats.find((r) => r.value === 'Malaysian')!;
    expect(my.sortOrder).toBe(0);
    expect(my.label).toBe('Malaysian');
    // 197 standard values + 1 custom.
    expect(values.length).toBe(STANDARD_NATIONALITY_COUNT + 1);
  });
});
