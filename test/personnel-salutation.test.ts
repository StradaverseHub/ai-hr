/**
 * 8c284478 — Personnel (Admin) Profile: "Salutation" dropdown on Personal Details, positioned BEFORE the
 * Full Name field, backed by the profile_option catalog (new category 'salutation') exactly like religion /
 * race (7d309da7). person.salutation (migration 0300) is nullable free text with the same legacy-value
 * tolerance; the defaults ship the standard titles + Malaysian honorifics, centrally maintainable in
 * System Settings > System Labels > Profile Options.
 *
 * Guards:
 *  (cat-1) 'salutation' is a registered catalog category and its seeded defaults are the approved list
 *          (Mr … Tun), listable in order; only ACTIVE options appear in the picker query.
 *  (svc-1) save/load round-trip WITH a value: updatePerson persists it and employeeDetail projects it;
 *          a save WITHOUT the field (undefined) leaves it unchanged; clearing to null is allowed.
 *  (svc-2) existing-record null safety: a legacy record starts blank and stays blank across an unrelated
 *          profile save.
 *  (svc-3) catalog governance: a NEW off-catalog value is rejected, a deactivated value is rejected as a
 *          NEW pick, but an off-catalog legacy value survives an unchanged re-save (tolerance).
 *  (svc-4) delete in-use guard: a salutation value stored on a person cannot be deleted from the catalog
 *          (CATEGORY_PERSON_COLUMN wiring).
 *  (ui)    drift guard: on the Personal Details form the salutation ProfileOptionSelect sits BEFORE the
 *          fullName input, fed by profileOptions.salutation.
 *  (i18n)  the field label (people.detail.salutation) and the Profile Options category name
 *          (admin.profileOptions.category.salutation) exist in all six locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, updatePerson } from '../core/org';
import { employeeDetail } from '../core/read';
import {
  DEFAULT_PROFILE_OPTIONS,
  PROFILE_OPTION_CATEGORIES,
  ProfileOptionInUseError,
  deleteProfileOption,
  listProfileOptions,
  seedProfileOptions,
  setProfileOptionActive,
} from '../core/profile-options';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/** The approved default list (plan 8c284478) — standard titles + Malaysian honorifics, in seed order. */
const SALUTATION_DEFAULTS = [
  'Mr', 'Mrs', 'Ms', 'Mdm', 'Dr', 'Prof', 'Ir', 'Ts', 'Hj', 'Hjh',
  "Dato'", 'Datin', "Dato' Sri", 'Datuk', 'Tan Sri', 'Puan Sri', 'Tun',
];

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
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

describe('8c284478 — Salutation on Personal Details', () => {
  // ── (cat-1) category registration + defaults ─────────────────────────────
  it('registers the salutation category with the approved defaults; only active options are pickable', async () => {
    expect(PROFILE_OPTION_CATEGORIES).toContain('salutation');
    // The core default set is exactly the approved list, in order (byte-identical with the 0300 seed).
    const defaults = DEFAULT_PROFILE_OPTIONS.filter((d) => d.category === 'salutation');
    expect(defaults.map((d) => d.value)).toEqual(SALUTATION_DEFAULTS);
    expect(defaults.map((d) => d.sortOrder)).toEqual(SALUTATION_DEFAULTS.map((_, i) => i));

    const a = adminCtx(b);
    await seedProfileOptions(a);
    const active = await listProfileOptions(a, 'salutation', { activeOnly: true });
    expect(active.map((r) => r.value)).toEqual(SALUTATION_DEFAULTS);

    // Deactivate 'Tun' → disappears from the picker query but stays manageable in the full list.
    const tun = active.find((r) => r.value === 'Tun')!;
    await setProfileOptionActive(a, { id: tun.id, isActive: false });
    const picker = await listProfileOptions(a, 'salutation', { activeOnly: true });
    expect(picker.map((r) => r.value)).not.toContain('Tun');
    const full = await listProfileOptions(a, 'salutation', { activeOnly: false });
    expect(full.find((r) => r.value === 'Tun')?.isActive).toBe(false);
  });

  // ── (svc-1) save/load round-trip with and without a value ────────────────
  it('round-trips: saves a salutation, leaves it untouched when absent from a save, and clears to null', async () => {
    const a = adminCtx(b);
    await seedProfileOptions(a);
    const E = await hire('Sal Person');

    // WITH a value → persisted and projected by the read model.
    await updatePerson(a, { personId: E.personId, fullName: 'Sal Person', primaryEmail: 'salperson@acme.test', salutation: 'Dr' });
    expect((await employeeDetail(a, E.employmentId))?.salutation).toBe('Dr');

    // WITHOUT the field (undefined = not on this form) → unchanged, not wiped.
    await updatePerson(a, { personId: E.personId, fullName: 'Sal Person', primaryEmail: 'salperson@acme.test', preferredName: 'Sal' });
    expect((await employeeDetail(a, E.employmentId))?.salutation).toBe('Dr');

    // Clearing to null (blank pick) → allowed.
    await updatePerson(a, { personId: E.personId, fullName: 'Sal Person', primaryEmail: 'salperson@acme.test', salutation: null });
    expect((await employeeDetail(a, E.employmentId))?.salutation).toBeNull();
  });

  // ── (svc-2) existing-record null safety ──────────────────────────────────
  it('existing records start blank and stay blank until a salutation is set', async () => {
    const a = adminCtx(b);
    await seedProfileOptions(a);
    const E = await hire('Legacy Blank');
    expect((await employeeDetail(a, E.employmentId))?.salutation).toBeNull();

    // An unrelated profile save must not invent or wipe anything.
    await updatePerson(a, { personId: E.personId, fullName: 'Legacy Blank (edited)', primaryEmail: 'legacyblank@acme.test', firstName: 'Legacy' });
    expect((await employeeDetail(a, E.employmentId))?.salutation).toBeNull();
  });

  // ── (svc-3) catalog governance + legacy tolerance ────────────────────────
  it('rejects a new off-catalog or deactivated salutation, but preserves an unchanged legacy value', async () => {
    const a = adminCtx(b);
    await seedProfileOptions(a);
    const E = await hire('Gov Person');

    // A brand-new value not in the catalog → rejected.
    await expect(
      updatePerson(a, { personId: E.personId, fullName: 'Gov Person', primaryEmail: 'govperson@acme.test', salutation: 'Lord' }),
    ).rejects.toThrow();

    // A deactivated catalog value → rejected as a NEW pick.
    const rows = await listProfileOptions(a, 'salutation', { activeOnly: false });
    const tun = rows.find((r) => r.value === 'Tun')!;
    await setProfileOptionActive(a, { id: tun.id, isActive: false });
    await expect(
      updatePerson(a, { personId: E.personId, fullName: 'Gov Person', primaryEmail: 'govperson@acme.test', salutation: 'Tun' }),
    ).rejects.toThrow();

    // An off-catalog LEGACY value (e.g. imported free text) survives an unchanged re-save (tolerance).
    await owner.db.update(schema.person).set({ salutation: 'Datin Paduka' }).where(eq(schema.person.id, E.personId));
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Gov Person (edited)',
      primaryEmail: 'govperson@acme.test',
      salutation: 'Datin Paduka',
    });
    const [after] = await owner.db.select().from(schema.person).where(eq(schema.person.id, E.personId));
    expect(after.salutation).toBe('Datin Paduka');
  });

  // ── (svc-4) delete in-use guard ──────────────────────────────────────────
  it('blocks deleting a salutation option still stored on a person', async () => {
    const a = adminCtx(b);
    await seedProfileOptions(a);
    const E = await hire('Dato User');
    await updatePerson(a, { personId: E.personId, fullName: 'Dato User', primaryEmail: 'datouser@acme.test', salutation: "Dato'" });

    const rows = await listProfileOptions(a, 'salutation', { activeOnly: false });
    const dato = rows.find((r) => r.value === "Dato'")!;
    await expect(deleteProfileOption(a, dato.id)).rejects.toThrow(ProfileOptionInUseError);

    // An unused option deletes fine (the guard is value-scoped, not category-wide).
    const mrs = rows.find((r) => r.value === 'Mrs')!;
    await deleteProfileOption(a, mrs.id);
    expect((await listProfileOptions(a, 'salutation', { activeOnly: false })).find((r) => r.id === mrs.id)).toBeUndefined();
  });

  // ── (ui) drift guard: position + wiring on the Personal Details form ─────
  it('renders the Salutation dropdown BEFORE Full Name on the Personal Details form, fed by the catalog', () => {
    const PAGE = read('app/admin/personnel/[employmentId]/page.tsx');
    // Anchor the slice on the Personal Details form's action (the page contains many other forms).
    const marker = PAGE.indexOf('action={setPersonAction}');
    expect(marker).toBeGreaterThan(-1);
    const formStart = PAGE.lastIndexOf('<form', marker);
    const formEnd = PAGE.indexOf('</form>', marker);
    expect(formStart).toBeGreaterThan(-1);
    expect(formEnd).toBeGreaterThan(formStart);
    const form = PAGE.slice(formStart, formEnd);

    const sal = form.indexOf('name="salutation"');
    const full = form.indexOf('name="fullName"');
    expect(sal, 'salutation field present on the Personal Details form').toBeGreaterThan(-1);
    expect(full, 'fullName field present on the Personal Details form').toBeGreaterThan(-1);
    // The approved position: Salutation BEFORE Full Name (natural data-entry order).
    expect(sal).toBeLessThan(full);
    // Catalog-backed via ProfileOptionSelect (legacy-value tolerance) with the i18n label.
    expect(form).toContain('options={profileOptions.salutation}');
    expect(form).toContain("t('salutation')");
  });

  // ── (i18n) labels in all six locales ─────────────────────────────────────
  it('has the field label and Profile Options category name in all six locales', () => {
    const get = (obj: Record<string, unknown>, dotted: string): unknown =>
      dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
    for (const loc of LOCALES) {
      const dict = JSON.parse(read(`messages/${loc}.json`)) as Record<string, unknown>;
      expect(get(dict, 'people.detail.salutation'), `people.detail.salutation [${loc}]`).toBeTruthy();
      expect(get(dict, 'admin.profileOptions.category.salutation'), `admin.profileOptions.category.salutation [${loc}]`).toBeTruthy();
    }
  });
});
