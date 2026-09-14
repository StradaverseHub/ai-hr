/**
 * Items 55865c32 + 357faecf — Identity Information (Personnel → Profile → Personal Details).
 *
 * Item 357faecf re-gates the Identity No (NRIC) card's VISIBILITY on nationality: it renders only while the
 * selected nationality is Malaysian, hiding instantly (no reload) when the nationality changes. Passport
 * Information keeps item 55865c32's behaviour — visible for EVERY employee, issuing country included, with
 * nationality driving only its required flags (derived SERVER-SIDE from the person record on save — never
 * the client):
 *   • Malaysian → NRIC card shown, NRIC mandatory; passport optional but all-or-nothing (trio or nothing);
 *   • non-Malaysian → NRIC card hidden (stored ic_number rows untouched); passport trio mandatory.
 * The server surface is intentionally UNCHANGED from 55865c32: setIcProfileMY stays strict-MyKad and
 * nationality-agnostic — a hidden card simply never posts.
 *
 * Guards:
 *  (ui)     the NRIC form renders inside an isMY visibility fork; the passport form stays UNCONDITIONAL
 *           (the pre-R63 either/or must not return), passport requiredness still toggles by nationality,
 *           the Issuing Country Combobox is wired, and the page/action carry the issuing-country field.
 *  (ui-flip) the fork reads the LIVE nationality from IdentityProvider context (NationalityField pushes
 *           onValueChange), so the NRIC card appears/disappears the moment the nationality changes.
 *  (i18n)   label drift guard — people.detail.icNumber reads "Identity No (NRIC)" (en exact; every locale
 *           carries NRIC), and the identity/passport-section keys exist in all six locales.
 *  (my-1)   Malaysian keeps NRIC and saves a FULL passport alongside it (both documents coexist).
 *  (my-2)   Malaysian passport partial-fill is rejected; all-blank with no row no-ops (no empty row seeded).
 *  (my-3)   Malaysian all-blank save CLEARS an existing passport block (audited before/after).
 *  (nonmy-1) the SERVICE stays nationality-agnostic: a non-Malaysian's valid 12-digit IC still saves
 *           (employee.ic.updated fires) — only the UI hides the field.
 *  (nonmy-2) non-Malaysian blank IC no-ops — no InvalidICError, no row seeded.
 *  (nonmy-3) non-Malaysian passport trio stays mandatory (partial AND all-blank both rejected).
 *  (kept)   a stored NRIC SURVIVES a nationality change to non-Malaysian and later unrelated saves — the
 *           field is hidden, never wiped, and the data is intact if the nationality is corrected back.
 *  (country) issuing country round-trips and appears in the employee.passport.updated before/after payload.
 *  (act)    setPassportAction carries passportIssuingCountry from the form into the pack setter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionContext } from '../db/client';
import { hireEmployee, updatePerson } from '../core/org';
import {
  getStatutoryProfileMY,
  setIcProfileMY,
  setPassportProfileMY,
  PassportRequiredError,
} from '../localization/my/statutory';
import { setPassportAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// requireAdmin() (session) is unavailable in the harness — return the seeded admin ctx.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const PAGE = read('app/admin/personnel/[employmentId]/page.tsx');
const IDENTITY = read('components/personnel-identity.tsx');
const ACTIONS = read('app/admin/personnel/[employmentId]/actions.ts');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Identity sections — NRIC gated by nationality, passport always (55865c32 + 357faecf)', () => {
  it('(ui) the NRIC form renders inside the isMY visibility fork; the passport form stays unconditional', () => {
    // Item 357faecf — the NRIC card is gated: the fork opens BEFORE the IC form and closes BEFORE the
    // passport form, so hiding the NRIC never takes Passport Information with it (the pre-R63 either/or
    // early-return must not return either).
    const forkOpen = IDENTITY.indexOf('{isMY && (');
    const icForm = IDENTITY.indexOf('action={setIcAction}');
    const forkClose = IDENTITY.indexOf('\n      )}', icForm);
    const passportForm = IDENTITY.indexOf('action={setPassportAction}');
    expect(forkOpen).toBeGreaterThan(-1);
    expect(icForm).toBeGreaterThan(forkOpen);
    expect(forkClose).toBeGreaterThan(icForm);
    expect(passportForm).toBeGreaterThan(forkClose);
    expect(IDENTITY.includes('if (isMY)')).toBe(false);
    // The NRIC input is mandatory whenever its card is shown (Malaysians must have an NRIC); the passport
    // trio's requiredness still toggles by nationality (mandatory only for non-Malaysians).
    expect(IDENTITY.includes('required={isMY}')).toBe(false);
    // ITEM a72610af MOVED THE PASSPORT FIELDS, NOT THE RULE. The six of them are now the shared group
    // components/passport-fields.tsx, which the Create New Employee draft renders too — so the
    // nationality-driven requiredness is expressed as a PROP here and applied inside the group. Both
    // halves are asserted, because a group that ignored the prop would drop the rule silently.
    expect(IDENTITY.includes('requiredTrio={!isMY}')).toBe(true);
    const PASSPORT = readFileSync(root + 'components/passport-fields.tsx', 'utf8');
    expect(PASSPORT, 'the group applies requiredTrio to the number/issue/expiry trio only')
      .toContain('const req = props.mode === \'form\' && props.requiredTrio;');
    for (const f of ['passportNumber', 'passportIssueDate', 'passportExpiryDate']) {
      expect(PASSPORT.includes(`box('${f}'`), `${f} is in the required trio`).toBe(true);
    }
    // The Issuing Country picker (searchable Combobox) is part of the passport group.
    expect(PASSPORT.includes("picker('passportIssuingCountry'")).toBe(true);
    expect(PASSPORT.includes('<Combobox')).toBe(true);
    // …and the group posts it under that name in form mode, so the action still reads it.
    expect(PASSPORT.includes('{ name: key }')).toBe(true);
    // Section headings make NRIC vs Passport visibly separate documents.
    expect(IDENTITY.includes("t('identityNricTitle')")).toBe(true);
    expect(IDENTITY.includes("t('passportInfoTitle')")).toBe(true);
  });

  it('(ui-flip) the fork reads the LIVE nationality from context — the card flips the moment nationality changes', () => {
    // NationalityField pushes every selection into IdentityProvider context (no reload)…
    expect(IDENTITY.includes('onValueChange={setNationality}')).toBe(true);
    // …and IdentityFields derives the gate from that live value, so the NRIC card appears/disappears
    // immediately when the Nationality picker changes.
    expect(IDENTITY.includes('const { nationality } = useIdentity()')).toBe(true);
    expect(IDENTITY.includes('const isMY = isMalaysianNationality(nationality)')).toBe(true);
  });

  it('(ui) the page passes the issuing country + the international country options; the action forwards the field', () => {
    expect(PAGE.includes('passportIssuingCountry={statutory?.passportIssuingCountry')).toBe(true);
    expect(PAGE.includes('countryOptions={profileOptions.nationality')).toBe(true);
    expect(ACTIONS.includes("formData.get('passportIssuingCountry')")).toBe(true);
  });

  it('(i18n) label drift guard — "IC number" is renamed to "Identity No (NRIC)" (key unchanged) in every locale', () => {
    const en = JSON.parse(read('messages/en.json'));
    expect(en.people.detail.icNumber).toBe('Identity No (NRIC)');
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`messages/${loc}.json`));
      const label = msg?.people?.detail?.icNumber;
      expect(typeof label, `messages/${loc}.json missing people.detail.icNumber`).toBe('string');
      expect(label.includes('NRIC'), `messages/${loc}.json icNumber should carry the NRIC wording`).toBe(true);
    }
  });

  it('(i18n) the new identity-section keys exist in all six locales', () => {
    const keys = [
      'identityNricTitle',
      'passportInfoTitle',
      'passportIssuingCountry',
      'passportIssuingCountrySearchPlaceholder',
      'passportIssuingCountryNoResults',
    ];
    for (const loc of LOCALES) {
      const msg = JSON.parse(read(`messages/${loc}.json`));
      for (const k of keys) {
        const v = msg?.people?.detail?.[k];
        expect(typeof v, `messages/${loc}.json missing people.detail.${k}`).toBe('string');
        expect(v.length, `messages/${loc}.json people.detail.${k} empty`).toBeGreaterThan(0);
      }
    }
  });
});

describe('Identity sections — service + action behaviour (55865c32, unchanged by 357faecf)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ADMIN = adminCtx(base);
    LAST_REDIRECT = '';
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (a: SessionContext, name: string) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  /** Hire + stamp the person's nationality (the server-side source setPassportProfileMY derives from). */
  const hireWithNationality = async (a: SessionContext, name: string, nationality: string) => {
    const e = await hire(a, name);
    await updatePerson(a, {
      personId: e.personId,
      fullName: name,
      primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test`,
      nationality,
    });
    return e;
  };

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  it('(my-1) a Malaysian employee keeps their NRIC and saves a full passport alongside it', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Local Traveller', 'Malaysian');
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101015030' });
    const { id } = await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'A12345678',
      passportIssueDate: '2025-01-01',
      passportExpiryDate: '2035-12-31',
      passportIssuingCountry: 'Malaysia',
      passportRemark: 'Business travel',
    });
    expect(id).not.toBeNull();
    const row = await getStatutoryProfileMY(a, e.personId);
    // Both identification documents coexist on the same row.
    expect(row?.icNumber).toBe('900101015030');
    expect(row?.passportNumber).toBe('A12345678');
    expect(row?.passportIssuingCountry).toBe('Malaysia');
    expect(row?.passportRemark).toBe('Business travel');
  });

  it('(my-2) a Malaysian partial passport is rejected; an all-blank save with no statutory row no-ops', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Partial Local', 'Malaysian');
    // Any passport field present → the trio must be complete.
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: 'A1' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportRemark: 'note only' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: 'A1', passportIssueDate: '2025-01-01' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    // All-blank + no row: nothing to clear — no error, no empty row seeded.
    const res = await setPassportProfileMY(a, { personId: e.personId });
    expect(res.id).toBeNull();
    expect(await getStatutoryProfileMY(a, e.personId)).toBeNull();
  });

  it('(my-3) a Malaysian all-blank save clears an existing passport block, audited before/after', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Clearing Local', 'Malaysian');
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101015031' });
    const { id } = await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'B1',
      passportIssueDate: '2025-01-01',
      passportExpiryDate: '2035-01-01',
      passportIssuingCountry: 'Malaysia',
    });
    // Clearing outdated passport information = an all-blank save (same admin-gated path).
    await setPassportProfileMY(a, { personId: e.personId });
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportNumber).toBeNull();
    expect(row?.passportIssueDate).toBeNull();
    expect(row?.passportExpiryDate).toBeNull();
    expect(row?.passportIssuingCountry).toBeNull();
    expect(row?.icNumber).toBe('900101015031'); // NRIC untouched by the passport clear
    const payload = await latestEventPayload(base.tenantId, id as string, 'employee.passport.updated');
    expect((payload as Record<string, unknown>).before).toMatchObject({ passportNumber: 'B1', passportIssuingCountry: 'Malaysia' });
    expect((payload as Record<string, unknown>).after).toMatchObject({ passportNumber: null, passportIssuingCountry: null });
  });

  it('(nonmy-1) the service stays nationality-agnostic — a non-Malaysian valid IC still saves (only the UI hides the field)', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Foreign With Ic', 'Singaporean');
    const { id } = await setIcProfileMY(a, { personId: e.personId, icNumber: '880202085032' });
    expect(id).not.toBeNull();
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('880202085032');
    const payload = await latestEventPayload(base.tenantId, id as string, 'employee.ic.updated');
    expect((payload as Record<string, unknown>).after).toMatchObject({ icNumber: '880202085032' });
  });

  it('(nonmy-2) a non-Malaysian blank IC save no-ops — no InvalidICError, no row seeded', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Foreign No Ic', 'Singaporean');
    const res = await setIcProfileMY(a, { personId: e.personId, icNumber: '   ' });
    expect(res.id).toBeNull();
    expect(await getStatutoryProfileMY(a, e.personId)).toBeNull();
  });

  it('(nonmy-3) the passport trio stays mandatory for a non-Malaysian — partial AND all-blank both rejected', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Foreign Strict', 'Singaporean');
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: 'E1', passportIssueDate: '2025-02-01' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    // The Malaysian-only relaxation must NOT leak: all-blank is still an error for a non-Malaysian.
    await expect(setPassportProfileMY(a, { personId: e.personId })).rejects.toBeInstanceOf(PassportRequiredError);
    // Full trio (no optional fields) is accepted.
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'E12345678',
      passportIssueDate: '2025-02-01',
      passportExpiryDate: '2035-02-01',
    });
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportNumber).toBe('E12345678');
    expect(row?.passportIssuingCountry).toBeNull();
  });

  it('(kept) a stored NRIC survives a nationality change to non-Malaysian and later unrelated saves', async () => {
    const a = adminCtx(base);
    // A Malaysian employee with an NRIC on record…
    const e = await hireWithNationality(a, 'Was Malaysian', 'Malaysian');
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101015040' });
    // …whose nationality is then corrected to non-Malaysian. Item 357faecf hides the NRIC field in the UI
    // but the stored row must NOT be deleted or blanked by the change.
    await updatePerson(a, {
      personId: e.personId,
      fullName: 'Was Malaysian',
      primaryEmail: 'was.malaysian@acme.test',
      nationality: 'Singaporean',
    });
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015040');
    // Later unrelated saves (the passport card is still visible and in use) leave the hidden NRIC intact.
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'S9876543',
      passportIssueDate: '2026-01-01',
      passportExpiryDate: '2036-01-01',
      passportIssuingCountry: 'Singapore',
    });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015040');
    expect(row?.passportNumber).toBe('S9876543');
    // If the nationality is ever corrected back, the same NRIC is still there for the reappearing field.
    await updatePerson(a, {
      personId: e.personId,
      fullName: 'Was Malaysian',
      primaryEmail: 'was.malaysian@acme.test',
      nationality: 'Malaysian',
    });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015040');
  });

  it('(country) the issuing country round-trips and appears in the audit before/after payload', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Country Tracker', 'Singaporean');
    const { id } = await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'K1',
      passportIssueDate: '2025-02-01',
      passportExpiryDate: '2035-02-01',
      passportIssuingCountry: 'Singapore',
    });
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportIssuingCountry).toBe('Singapore');
    let payload = await latestEventPayload(base.tenantId, id as string, 'employee.passport.updated');
    expect((payload as Record<string, unknown>).before).toBeNull();
    expect((payload as Record<string, unknown>).after).toMatchObject({ passportIssuingCountry: 'Singapore' });
    // A renewal issued elsewhere: the correction records previous + updated values for the auditor.
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'K2',
      passportIssueDate: '2026-03-01',
      passportExpiryDate: '2036-03-01',
      passportIssuingCountry: 'Australia',
    });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportIssuingCountry).toBe('Australia');
    payload = await latestEventPayload(base.tenantId, id as string, 'employee.passport.updated');
    expect((payload as Record<string, unknown>).before).toMatchObject({ passportIssuingCountry: 'Singapore' });
    expect((payload as Record<string, unknown>).after).toMatchObject({ passportIssuingCountry: 'Australia' });
  });

  it('(act) setPassportAction carries the issuing country from the form into the pack setter', async () => {
    const a = adminCtx(base);
    const e = await hireWithNationality(a, 'Action Country', 'Singaporean');
    ADMIN = a;
    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      passportNumber: 'F77777',
      passportIssueDate: '2025-06-01',
      passportExpiryDate: '2035-05-31',
      passportIssuingCountry: 'Singapore',
      passportRemark: 'via action',
    });
    await expect(setPassportAction(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportNumber).toBe('F77777');
    expect(row?.passportIssuingCountry).toBe('Singapore');
  });
});
