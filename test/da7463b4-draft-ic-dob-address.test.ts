/**
 * ITEM da7463b4 — THE DRAFT EMPLOYEE SCREEN IS THE EMPLOYEE SCREEN: NRIC → Date of Birth + Age, and the
 * Permanent / Correspondence address pair.
 *
 * THIS IS A DRIFT COMPLAINT, NOT A FEATURE REQUEST, and the distinction decides what these tests are for.
 * Both halves of it already existed somewhere:
 *
 *   · IC → Date of Birth on the ACTIVATED record (`setIcAction`, item 354a500d) and in the BULK IMPORTER
 *     (feedback b9fd8fd5) — and, since item a72610af, on the draft's ACTIVATION path
 *     (`completeEmployeeDraft`) as well. What did NOT exist was the derivation ON SCREEN while the draft
 *     was being filled in, so the Age beside the Date of Birth read "Not Available" for the entire life
 *     of a draft. That is the reporter's sentence.
 *   · Both address blocks as `person` columns since item 3a25f5ee (migration 0213) and bf953339
 *     (migration 0304), written by `updatePerson`. The DRAFT never carried them.
 *
 * So the value of this file is not "the feature works" — it is THE TWO SCREENS AGREE, and they agree
 * because there is ONE definition of each rule rather than two. Every §below pins a shared definition
 * against both of its consumers.
 *
 * ── THE CONFLICT THE TICKET CREATES, AND WHICH WAY IT WAS DECIDED ─────────────────────────────────────
 *
 * The ticket asks that the Date of Birth "updates when the NRIC changes". core/import.ts:1068 records the
 * opposite rule for the same derivation: `dobOnlyIfEmpty` "guarantees an existing DOB is never
 * overwritten". Both cannot hold of one value, so they were separated by WHICH value they guard, and
 * §1 and §6 pin the two halves so neither can quietly absorb the other:
 *
 *   DECIDED — ON SCREEN, WHILE TYPING (this item): the Date of Birth follows a corrected NRIC, as long as
 *   nobody has typed over it. `nextAutofilledDob` refills a field that is empty OR still holds the value
 *   WE derived last time, and refuses one a human has touched. That is what "updates when the NRIC
 *   changes" can mean without ever discarding a statement somebody made about a person, and it is not new
 *   behaviour: it is exactly what components/ic-dob-autofill.tsx has done on the activated record since
 *   354a500d. This item only gave the draft the same rule instead of no rule.
 *
 *   UNCHANGED — ONCE PERSISTED: `dobOnlyIfEmpty` still means what core/import.ts says. A stored Date of
 *   Birth is never overwritten by a later IC edit or import. §6 pins that against the live writer, so a
 *   future reading of "updates when the NRIC changes" cannot be applied to the database by mistake.
 *
 * The divergence is real and deliberate, and it is a divergence in the SUBJECT, not in the rule: one
 * guards a form field being typed, the other guards a column already written.
 *
 * ── AND ONE THING THAT MUST NEVER BECOME A REFUSAL ────────────────────────────────────────────────────
 *
 * Feedback b9fd8fd5: an IC whose first six digits form no real calendar date "derives nothing (null) and
 * is skipped, not failed". §1 and §5 pin that on the screen and on the server: such an NRIC shows a note,
 * fills nothing, and does not stop the draft being saved.
 *
 * The SCREEN behaviours (typing, ticking, disabling) are in the sibling .dom file; this one is the rules,
 * the wiring and the database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { ADDRESS_COPY_PAIRS, ADDRESS_FIELD_SUFFIXES, copyPermanentToCorrespondence } from '../lib/address-blocks';
import { withSameAsPermanent, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { deriveDobFromIcInput, nextAutofilledDob } from '../components/ic-dob-autofill';
import { packFor } from '../localization/registry';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { setPersonComplianceFields } from '../core/profile';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

/** A real MyKad, and the date its first six digits mean. Both screens must reach exactly this. */
const IC_A = '900101011234';
const DOB_A = '1990-01-01';
/** A DIFFERENT real MyKad — "the NRIC changed". */
const IC_B = '850615085678';
const DOB_B = '1985-06-15';
/** Twelve digits whose first six are not a real date (month 13). Derives nothing, refuses nothing. */
const IC_UNREAL = '991301011234';

// ── §1 the rule, once, and the half of the conflict this item decided ─────────────────────────────
describe('§1 da7463b4 — what a typed NRIC means for the Date of Birth', () => {
  it('reaches the SAME date the country pack derives — through the pack, never localization/my', () => {
    // THE COUNTRY-PACK RATCHET (ADR-0080). `deriveDobFromIcInput` resolves `identity.dobFromIC` out of the
    // client-safe pack registry; the server path (`completeEmployeeDraft`, `setIcAction`,
    // `commitEmployeeImport`) resolves `statutory.dobFromIC` out of the full one. Two registries, one
    // jurisdiction rule — asserted equal here so a second copy of the century logic cannot appear on the
    // screen side without this failing.
    const pack = packFor('MY');
    expect(pack, 'the MY country pack must be registered').toBeTruthy();
    for (const ic of [IC_A, IC_B, '050101071234', '000229011234']) {
      expect(deriveDobFromIcInput(ic).dob, `screen ≡ pack for ${ic}`).toBe(pack!.statutory.dobFromIC(ic));
    }
  });

  it('a valid Malaysian NRIC derives a date', () => {
    expect(deriveDobFromIcInput(IC_A)).toEqual({ status: 'derived', dob: DOB_A });
    // Punctuation is what HR actually types; the record's placeholder shows the bare digits.
    expect(deriveDobFromIcInput('900101-01-1234').dob).toBe(DOB_A);
  });

  it('an INCOMPLETE NRIC derives nothing and says nothing', () => {
    // Nothing is filled, and — separately — no note is shown: nagging about an invalid date after the
    // fourth keystroke of a number still being typed is noise, not help.
    for (const partial of ['', '9', '9001', '90010101123']) {
      expect(deriveDobFromIcInput(partial), partial).toEqual({ status: 'incomplete', dob: null });
    }
  });

  it('an UNREAL NRIC derives nothing, is NAMED, and is not a refusal', () => {
    // Feedback b9fd8fd5's rule, restated for the screens: "derives nothing (null) and is skipped, not
    // failed". The function RETURNS — it must never throw, because a throw on a keystroke is a form that
    // cannot be typed into.
    expect(() => deriveDobFromIcInput(IC_UNREAL)).not.toThrow();
    expect(deriveDobFromIcInput(IC_UNREAL)).toEqual({ status: 'unreal', dob: null });
    expect(deriveDobFromIcInput('900431011234'), '31 April').toEqual({ status: 'unreal', dob: null });
  });

  it('THE DECIDED HALF OF THE CONFLICT: on screen, a CHANGED NRIC moves the Date of Birth', () => {
    // The reporter's words, and the reason this item does not simply reuse `dobOnlyIfEmpty` on the screen:
    // an admin who mistypes an NRIC, notices, and corrects it must not be left with the first NRIC's date
    // of birth sitting underneath the corrected number. `null` from `nextAutofilledDob` means "leave it".
    expect(nextAutofilledDob('', DOB_A, null), 'empty field fills').toBe(DOB_A);
    expect(nextAutofilledDob(DOB_A, DOB_B, DOB_A), 'corrected NRIC re-derives').toBe(DOB_B);
  });

  it('THE PART THAT DOES NOT MOVE: a hand-typed Date of Birth is never overwritten', () => {
    // A date somebody typed is a statement about a person; an NRIC is a guess about one. The guess never
    // wins. This is the same guarantee `dobOnlyIfEmpty` gives the COLUMN (§6), applied to the field.
    expect(nextAutofilledDob('1979-12-31', DOB_A, null), 'typed before any autofill').toBeNull();
    expect(nextAutofilledDob('1979-12-31', DOB_B, DOB_A), 'typed over our autofill').toBeNull();
  });
});

// ── §2 one pairing, two renderings ────────────────────────────────────────────────────────────────
describe('§2 da7463b4 — permanent → correspondence is declared once', () => {
  it('the DOM-id island and the draft copy read the same table', () => {
    // components/same-as-permanent-address.tsx used to carry its own private suffix list. If it grows one
    // again this fails: the only list is the one the draft also copies by.
    const island = read('components/same-as-permanent-address.tsx');
    expect(island).toContain("import { ADDRESS_COPY_PAIRS } from '@/lib/address-blocks'");
    expect(island).toContain('ADDRESS_COPY_PAIRS.map((p) => p.idSuffix)');
    // …and the shared block really does render an input per address suffix, under that id.
    const block = read('components/address-fields.tsx');
    for (const suffix of ADDRESS_FIELD_SUFFIXES) {
      expect(block, `address-fields.tsx must render ${suffix}`).toContain(`'${suffix}'`);
    }
    expect(block, 'the ids are `${side}-${suffix}`, which is what the island resolves')
      .toContain('const id = (suffix: string) => `${side}-${suffix}`;');
  });

  it('the two phone pairs have a node on BOTH sides, or the tick copies into nothing', () => {
    // The phones are the half of the pairing that is NOT `permanent*`-prefixed, so they are the half a
    // refactor silently drops. Each of the four ids must exist as a literal somewhere a screen renders.
    const sources = [
      read('app/admin/personnel/[employmentId]/page.tsx'),
      read('components/person-name-fields.tsx'),
      read('components/address-fields.tsx'),
    ].join('\n');
    for (const id of ['perm-mobile-phone', 'perm-home-phone', 'corr-mobile-phone', 'corr-home-phone']) {
      expect(sources, `no element carries id="${id}" — the copy would find nothing`).toContain(id);
    }
  });

  it('every paired key is a person column `updatePerson` actually writes', () => {
    // A pair naming a column no writer touches would copy on screen and vanish on save. `phone` is the
    // one permanent-side key that is NOT in PROFILE_FIELD_KEYS — it is part of the core trio `updatePerson`
    // rewrites on every call — so it is allowed for explicitly rather than by widening the check.
    const org = read('core/org.ts');
    const decl = org.slice(org.indexOf('const PROFILE_FIELD_KEYS'), org.indexOf('];', org.indexOf('const PROFILE_FIELD_KEYS')));
    const keys = new Set([...decl.matchAll(/'(\w+)'/g)].map((m) => m[1]));
    expect(keys.size, 'PROFILE_FIELD_KEYS parsed empty').toBeGreaterThan(20);
    keys.add('phone');
    for (const pair of ADDRESS_COPY_PAIRS) {
      expect(keys.has(pair.permanentKey), `${pair.permanentKey} is not written by updatePerson`).toBe(true);
      expect(keys.has(pair.correspondenceKey), `${pair.correspondenceKey} is not written by updatePerson`).toBe(true);
    }
  });

  it('the copy is total and idempotent — a CLEARED permanent line clears the correspondence one', () => {
    // The alternative ("skip empty permanent values") leaves a stale correspondence line behind after HR
    // clears the permanent one, which is the drift this whole item exists against.
    const once = copyPermanentToCorrespondence({ permanentCity: 'Ipoh', correspondenceCity: 'Johor Bahru' });
    expect(once.correspondenceCity).toBe('Ipoh');
    expect(copyPermanentToCorrespondence(once), 'applying twice differs from once').toEqual(once);
    const cleared = copyPermanentToCorrespondence({ permanentCity: undefined, correspondenceCity: 'Johor Bahru' });
    expect(cleared.correspondenceCity, 'a stale correspondence city survived').toBeUndefined();
  });

  it('the flag is what decides, and it is OFF unless it says yes', () => {
    const diverged = { permanentCity: 'Ipoh', correspondenceCity: 'Johor Bahru' };
    expect(withSameAsPermanent(diverged).correspondenceCity, 'no flag ⇒ untouched').toBe('Johor Bahru');
    expect(withSameAsPermanent({ ...diverged, sameAsPermanent: 'no' }).correspondenceCity).toBe('Johor Bahru');
    expect(withSameAsPermanent({ ...diverged, sameAsPermanent: 'yes' }).correspondenceCity).toBe('Ipoh');
    expect(withSameAsPermanent(undefined), 'an empty draft is not a crash').toEqual({});
  });
});

// ── §3 six locales, asserted rather than inferred from a clean render ──────────────────────────────
describe('§3 da7463b4 — every word this screen borrows exists in all six locales', () => {
  /** THE KEYS THE NEW/CHANGED COMPONENTS RENDER. All of them are `people.detail.*` — the ACTIVATED card's
   *  own keys — because the draft borrows the record's words rather than minting its own. That is why this
   *  item adds NO string: it is the point of the change, not a shortcut around translating. */
  const KEYS = [
    'permanentAddressTitle', 'correspondenceAddressTitle', 'sameAsPermanent',
    'addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'stateLabel', 'country',
    'optionNotSet', 'optionLegacySuffix',
    'icNumber', 'icDobInvalidDate', 'birthDate', 'age', 'ageYears', 'phone', 'homePhone',
  ];
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'];

  it('all six carry every key, and none of them is the English string by accident of deep-merge', () => {
    // i18n/request.ts DEEP-MERGES each locale over English, so a MISSING key renders the English word
    // rather than MISSING_MESSAGE — which means a clean dev-server render log is NOT evidence of
    // translation coverage. Presence is therefore asserted here, on the raw files, before the merge.
    const en = JSON.parse(read('messages/en.json')).people.detail;
    for (const locale of LOCALES) {
      const detail = JSON.parse(read(`messages/${locale}.json`)).people.detail;
      const missing = KEYS.filter((k) => typeof detail?.[k] !== 'string' || detail[k] === '');
      expect(missing, `messages/${locale}.json is missing people.detail keys`).toEqual([]);
    }
    expect(Object.keys(en).length, 'the en catalogue parsed empty').toBeGreaterThan(20);
  });

  it('the draft screen speaks ONE namespace, so check C still covers every key in it', () => {
    // test/i18n-coverage.test.ts check C SILENTLY SKIPS a file using more than one namespace. Reading
    // `people.detail` directly in wizard.tsx would therefore have dropped every `people.wizard.*` key on
    // that screen out of static coverage — a loss with no symptom. The record's words come across inside
    // components that already speak `people.detail` instead.
    const wizard = read('app/admin/personnel/new/wizard.tsx');
    const namespaces = [...wizard.matchAll(/useTranslations\('([^']+)'\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)], 'wizard.tsx must stay single-namespace').toEqual(['people.wizard']);
  });
});

// ── §4 · §5 · §6 the database ─────────────────────────────────────────────────────────────────────
describe('da7463b4 — a draft becomes an employee carrying both addresses', () => {
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

  const draft = (profile: Record<string, string>): EmployeeDraftData => ({
    profile: { fullName: 'Aminah Draft', primaryEmail: `aminah.${Date.now()}@draft.test`, employeeIdMode: 'manual', employeeCode: `D${Date.now()}`, ...profile },
    employment: { companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-03-01' },
    payroll: { basicSalary: '4000' },
  });

  const personOf = async (employmentId: string) => {
    const [emp] = await owner.db.select().from(schema.employment).where(eq(schema.employment.id, employmentId));
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, emp.personId));
    return p;
  };

  it('§4 both address blocks survive draft → activate and are what the Profile tab reads back', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, {
      data: draft({
        permanentAddressLine1: '7 Jalan Tetap',
        permanentPostcode: '43000',
        permanentCity: 'Kajang',
        permanentState: 'Selangor',
        permanentCountry: 'Malaysia',
        correspondenceAddressLine1: 'PO Box 21',
        correspondencePostcode: '50450',
        correspondenceCity: 'Kuala Lumpur',
        correspondenceMobilePhone: '+60 12-000 1111',
        correspondenceHomePhone: '+60 3-9999 8888',
      }),
      currentStep: 1,
    });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const p = await personOf(employmentId);
    expect(p.permanentAddressLine1).toBe('7 Jalan Tetap');
    expect(p.permanentPostcode).toBe('43000');
    expect(p.permanentCity).toBe('Kajang');
    expect(p.permanentState).toBe('Selangor');
    expect(p.permanentCountry).toBe('Malaysia');
    expect(p.correspondenceAddressLine1).toBe('PO Box 21');
    expect(p.correspondencePostcode).toBe('50450');
    expect(p.correspondenceCity).toBe('Kuala Lumpur');
    expect(p.correspondenceMobilePhone).toBe('+60 12-000 1111');
    expect(p.correspondenceHomePhone).toBe('+60 3-9999 8888');
    // They are the SAME columns app/admin/personnel/[employmentId]/page.tsx reads back onto the Profile
    // tab's Contact & Address card — core/read.ts selects them and test/personnel-…-address.test.ts pins
    // that side. Nothing here is a draft-only copy of an address.
    expect(p.permanentAddressLine1).not.toBe(p.correspondenceAddressLine1);
  });

  it('§4b "same as permanent" SURVIVES A LATER EDIT to the permanent address — the whole point of storing it', async () => {
    // THE FAILURE THIS IS AGAINST: a one-shot copy. HR ticks the box, then a day later corrects the
    // permanent address on the still-unactivated draft, and the correspondence address keeps the OLD
    // street — two addresses for one person, created by the convenience that was meant to prevent exactly
    // that. The flag is stored, so the correction follows through to Activate.
    const ctx = adminCtx(b);
    const first = await saveEmployeeDraft(ctx, {
      data: draft({
        sameAsPermanent: 'yes',
        permanentAddressLine1: '1 Jalan Lama',
        permanentCity: 'Klang',
        phone: '+60 11-111 1111',
        homePhone: '+60 3-1111 1111',
        // Deliberately STALE and deliberately different: a build that copied once and stored the result
        // would leave these here, and a build that never copies at all would activate with them.
        correspondenceAddressLine1: '1 Jalan Lama',
        correspondenceCity: 'Klang',
      }),
      currentStep: 1,
    });
    // …the later edit. Only the PERMANENT side is touched, exactly as HR would touch it.
    await saveEmployeeDraft(ctx, {
      id: first.id,
      data: draft({
        sameAsPermanent: 'yes',
        permanentAddressLine1: '2 Jalan Baru',
        permanentCity: 'Shah Alam',
        phone: '+60 11-222 2222',
        homePhone: '+60 3-2222 2222',
        correspondenceAddressLine1: '1 Jalan Lama',
        correspondenceCity: 'Klang',
      }),
      currentStep: 1,
    });
    const { employmentId } = await completeEmployeeDraft(ctx, first.id);
    const p = await personOf(employmentId);
    expect(p.permanentAddressLine1).toBe('2 Jalan Baru');
    expect(p.correspondenceAddressLine1, 'the correspondence address did not follow the correction')
      .toBe('2 Jalan Baru');
    expect(p.correspondenceCity).toBe('Shah Alam');
    // The phones are paired too (bf953339) — the half of the pairing a refactor drops.
    expect(p.correspondenceMobilePhone).toBe('+60 11-222 2222');
    expect(p.correspondenceHomePhone).toBe('+60 3-2222 2222');
  });

  it('§4c UNTICKED, the two blocks stay independent', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, {
      data: draft({
        sameAsPermanent: 'no',
        permanentAddressLine1: '3 Jalan Sendiri',
        correspondenceAddressLine1: 'Locked Bag 9',
      }),
      currentStep: 1,
    });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    const p = await personOf(employmentId);
    expect(p.permanentAddressLine1).toBe('3 Jalan Sendiri');
    expect(p.correspondenceAddressLine1).toBe('Locked Bag 9');
  });

  it('§4d a valid NRIC on the draft still lands a Date of Birth, so Age is never "Not Available"', async () => {
    // The server half of the reporter's first ask. `completeEmployeeDraft` derives through the COMPANY's
    // pack, which is the same call `setIcAction` and `commitEmployeeImport` make.
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: draft({ nationality: 'Malaysian', icNumber: IC_A }), currentStep: 1 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect((await personOf(employmentId)).dateOfBirth).toBe(DOB_A);
  });

  it('§5 an UNREAL NRIC does not block SAVE DRAFT, and derives nothing', async () => {
    // "Skipped, not failed" (feedback b9fd8fd5). A draft that refuses to save until it is correct is not a
    // draft — `saveEmployeeDraft` validates nothing on purpose, and this pins that the new autofill did
    // not quietly introduce a validation into it.
    const ctx = adminCtx(b);
    const saved = await saveEmployeeDraft(ctx, { data: draft({ nationality: 'Malaysian', icNumber: IC_UNREAL }), currentStep: 1 });
    expect(saved.id, 'an unreal NRIC must not stop a draft being saved').toBeTruthy();
    // ACTIVATE is where an invalid IC is refused, and that refusal PRE-DATES this item (an invalid MyKad
    // stored now is a payroll fault later). Named here so the distinction is on the record: the ticket's
    // "must not block the form" is about the form, not about creating a real employee from bad data.
    await expect(completeEmployeeDraft(ctx, saved.id)).rejects.toThrow(/Invalid identity number/);
  });

  it('§6 THE OTHER HALF OF THE CONFLICT, UNCHANGED: `dobOnlyIfEmpty` never overwrites a stored DOB', async () => {
    // core/import.ts:1068's guarantee, pinned against the live writer rather than against a comment. If a
    // future reading of "the DOB updates when the NRIC changes" is ever applied to the COLUMN, this fails
    // — which is the only thing standing between a corrected typo and a silently rewritten date of birth
    // on an employee who has already been hired.
    const ctx = adminCtx(b);
    const hired = await hireEmployee(ctx, {
      person: { fullName: 'Stored Dob', primaryEmail: `storeddob.${Date.now()}@acme.test` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setPersonComplianceFields(ctx, { employmentId: hired.employmentId, dateOfBirth: '1975-05-05' });
    await setPersonComplianceFields(ctx, { employmentId: hired.employmentId, dateOfBirth: DOB_A, dobOnlyIfEmpty: true });
    const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, hired.personId));
    expect(p.dateOfBirth, 'a stored date of birth was overwritten by a derived one').toBe('1975-05-05');
    // …and it DOES fill an empty one, or the guard would be indistinguishable from doing nothing.
    const other = await hireEmployee(ctx, {
      person: { fullName: 'Empty Dob', primaryEmail: `emptydob.${Date.now()}@acme.test` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setPersonComplianceFields(ctx, { employmentId: other.employmentId, dateOfBirth: DOB_B, dobOnlyIfEmpty: true });
    const [q] = await owner.db.select().from(schema.person).where(eq(schema.person.id, other.personId));
    expect(q.dateOfBirth).toBe(DOB_B);
  });
});
