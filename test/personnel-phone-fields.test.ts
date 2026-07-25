/**
 * Item bf953339 — Contact & Address: Mobile Phone Number rename + Home Phone Number pair.
 *
 * `person.phone` IS the Mobile Phone Number (the rename is label-only — no data movement); migration 0304
 * adds three nullable columns: person.home_phone plus the Correspondence block's OWN pair
 * (correspondence_mobile_phone / correspondence_home_phone), so an employee's correspondence contact can
 * differ from the main one.
 *
 * Covers:
 *  - Save/load round-trip for the three new columns, independent of the existing mobile (person.phone).
 *  - Existing phone data regression: a stored number is untouched by a save of the new fields.
 *  - Carry-through: a sibling save (Personal Details / Emergency Contact shape — the new fields ABSENT
 *    from the payload) never clobbers them — the historical bug class this page guards against.
 *  - Audit: person.updated records the new field NAMES only (PDPA — never a phone value), and the
 *    `via: 'copy-permanent'` provenance marker still works for a copy that includes the phones.
 *  - Copy island: FIELD_SUFFIXES now carries the two phone pairs (mobile-phone / home-phone), and the page
 *    assigns the matching perm-/corr- DOM ids so ticking "Same as Permanent Address" copies address AND
 *    both phone numbers (source-shape assertions — the suite has no DOM runner; comment-stripped so prose
 *    can neither satisfy nor trip them).
 *  - i18n: the people.detail phone label reads "Mobile Phone Number" and homePhone exists in all 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { hireEmployee, updatePerson } from '../core/org';
import { expectNoLeakedValue } from './helpers/leaf-values';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
/** Strip block + line comments so markup-shaped prose in doc comments can't satisfy (or trip) assertions. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const readPerson = (personId: string) =>
  owner.db.select().from(schema.person).where(eq(schema.person.id, personId)).limit(1).then((r) => r[0]);

describe('bf953339 — mobile + home phone pair (DB round-trip)', () => {
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

  it('stores home + correspondence phone pair independently of the mobile (person.phone)', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Phone Person');

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Phone Person',
      primaryEmail: 'phoneperson@acme.test',
      phone: '012-3456789',
      homePhone: '03-12345678',
      correspondenceMobilePhone: '013-9876543',
      correspondenceHomePhone: '04-8765432',
    });

    const p = await readPerson(E.personId);
    expect(p.phone).toBe('012-3456789');
    expect(p.homePhone).toBe('03-12345678');
    expect(p.correspondenceMobilePhone).toBe('013-9876543');
    expect(p.correspondenceHomePhone).toBe('04-8765432');
    // The correspondence pair is genuinely independent of the main pair (per the feedback's example).
    expect(p.correspondenceMobilePhone).not.toBe(p.phone);
    expect(p.correspondenceHomePhone).not.toBe(p.homePhone);
  });

  it('existing phone data regression: a stored mobile number survives a save of the new fields', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Legacy Phone');
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Legacy Phone',
      primaryEmail: 'legacyphone@acme.test',
      phone: '+60123334444',
    });

    // The Contact card re-submits the mobile unchanged while adding the new fields (form carry semantics).
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Legacy Phone',
      primaryEmail: 'legacyphone@acme.test',
      phone: '+60123334444',
      homePhone: '03-5550001',
    });

    const p = await readPerson(E.personId);
    expect(p.phone).toBe('+60123334444'); // untouched — displays under the new Mobile Phone Number label
    expect(p.homePhone).toBe('03-5550001');
    expect(p.correspondenceMobilePhone).toBeNull(); // stays blank until updated
    expect(p.correspondenceHomePhone).toBeNull();
  });

  it('sibling saves (Personal Details / Emergency Contact shape) never clobber the new fields', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Carry Person');
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Carry Person',
      primaryEmail: 'carryperson@acme.test',
      phone: '012-1112222',
      homePhone: '03-9990000',
      correspondenceMobilePhone: '019-8887777',
      correspondenceHomePhone: '05-6665555',
    });

    // Personal Details save: core trio + name parts — the three new fields are ABSENT (undefined =
    // leave unchanged), exactly what setPersonAction submits.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Carry Person',
      primaryEmail: 'carryperson@acme.test',
      phone: '012-1112222', // carried through as a hidden input (core trio is always written)
      firstName: 'Carry',
      lastName: 'Person',
    });
    // Emergency Contact save: core trio + emergency fields only, same absence semantics.
    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Carry Person',
      primaryEmail: 'carryperson@acme.test',
      phone: '012-1112222',
      emergencyContactName: 'Next Of Kin',
      emergencyContactPhone: '011-0001111',
    });

    const p = await readPerson(E.personId);
    expect(p.homePhone).toBe('03-9990000');
    expect(p.correspondenceMobilePhone).toBe('019-8887777');
    expect(p.correspondenceHomePhone).toBe('05-6665555');
    expect(p.phone).toBe('012-1112222');
  });

  it('audits the new field names only (no phone values) and keeps the copy-permanent marker', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Audit Phone');

    await updatePerson(a, {
      personId: E.personId,
      fullName: 'Audit Phone',
      primaryEmail: 'auditphone@acme.test',
      via: 'copy-permanent',
      phone: '012-7770001',
      homePhone: '03-7770002',
      correspondenceMobilePhone: '012-7770001',
      correspondenceHomePhone: '03-7770002',
    });

    const payload = await latestEventPayload(base.tenantId, E.personId, 'person.updated');
    expect(payload).not.toBeNull();
    const fields = (payload!.fields ?? []) as string[];
    expect(fields).toContain('homePhone');
    expect(fields).toContain('correspondenceMobilePhone');
    expect(fields).toContain('correspondenceHomePhone');
    expect(payload!.via).toBe('copy-permanent');
    // PDPA — the audit payload must not contain any of the NEW phone values. (person.phone is the core
    // trio and keeps its existing before/after audit treatment.)
    //
    // By VALUE, not substring. The collision odds for a 7-digit needle inside a UUID are negligible,
    // unlike cp38's 3-digit case — but the substring form is weak for the same reason regardless of
    // length: it catches only the one literal it is handed, so a phone stored under a different value
    // passes. See test/helpers/leaf-values.ts.
    expectNoLeakedValue(payload, '7770002');
  });
});

describe('bf953339 — copy island + form wiring (source shape)', () => {
  const island = stripComments(read('components/same-as-permanent-address.tsx'));
  const page = stripComments(read('app/admin/personnel/[employmentId]/page.tsx'));
  const actions = stripComments(read('app/admin/personnel/[employmentId]/actions.ts'));

  it('FIELD_SUFFIXES carries the two phone pairs so the tick box copies phones with the address', () => {
    expect(island).toMatch(/'mobile-phone'/);
    expect(island).toMatch(/'home-phone'/);
  });

  it('the page assigns the perm-/corr- phone ids the island copies between', () => {
    // Main Contact & Address pair (the perm- side aliases the main inputs; names are NOT perm-prefixed).
    expect(page).toMatch(/id="perm-mobile-phone"[^>]*name="phone"/);
    expect(page).toMatch(/id="perm-home-phone"[^>]*name="homePhone"/);
    // Correspondence block's own pair.
    expect(page).toMatch(/id="corr-mobile-phone"[^>]*name="correspondenceMobilePhone"/);
    expect(page).toMatch(/id="corr-home-phone"[^>]*name="correspondenceHomePhone"/);
    // The correspondence pair renders inside the Correspondence block (after the corr-country select).
    const corrCountryAt = page.indexOf('id="corr-country"');
    const corrMobileAt = page.indexOf('id="corr-mobile-phone"');
    expect(corrCountryAt).toBeGreaterThan(-1);
    expect(corrMobileAt).toBeGreaterThan(corrCountryAt);
  });

  it('setContactAddressAction parses all three new fields (blank → null)', () => {
    expect(actions).toMatch(/homePhone: orNull\(formData\.get\('homePhone'\)\)/);
    expect(actions).toMatch(/correspondenceMobilePhone: orNull\(formData\.get\('correspondenceMobilePhone'\)\)/);
    expect(actions).toMatch(/correspondenceHomePhone: orNull\(formData\.get\('correspondenceHomePhone'\)\)/);
  });

  it('labels: phone reads "Mobile Phone Number" and homePhone exists in all 6 locales', () => {
    for (const locale of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const detail = JSON.parse(read(`messages/${locale}.json`)).people.detail as Record<string, string>;
      expect(detail.phone, `${locale} phone label`).toBeTruthy();
      expect(detail.homePhone, `${locale} homePhone label`).toBeTruthy();
    }
    const en = JSON.parse(read('messages/en.json')).people.detail as Record<string, string>;
    expect(en.phone).toBe('Mobile Phone Number');
    expect(en.homePhone).toBe('Home Phone Number');
  });
});
